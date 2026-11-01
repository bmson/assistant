/** Pure resolver for a protected Cloud Run web-tag creation artifact. */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import {
  immutableWebRevision,
  type OwnedWebTagProof,
  tagHash,
  WEB_SERVICE,
} from './owner-web-tag-retirement.js';

export const DEPLOY_REPOSITORY = 'bmson/assistant';
export const DEPLOY_WORKFLOW_PATH = '.github/workflows/deploy.yml';
export const CREATION_ARTIFACT_MEMBER = 'owner-web-tag-creation.json';
export const RELEASE_MANIFEST_MEMBER = 'release-manifest.json';
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

type ObjectValue = Record<string, unknown>;
function fail(message = 'Invalid protected creation evidence'): never {
  throw new Error(message);
}
function object(value: unknown, keys: readonly string[]): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const record = value as ObjectValue;
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) return fail();
  return record;
}
function objectWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const record = value as ObjectValue;
  const keys = Object.keys(record);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    return fail();
  return record;
}
function string(value: unknown, pattern: RegExp): string {
  return typeof value === 'string' && pattern.test(value) ? value : fail();
}
function positiveInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fail();
}
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function parseJson(bytes: Uint8Array, limit: number): unknown {
  if (bytes.byteLength < 1 || bytes.byteLength > limit)
    return fail('Protected artifact input exceeds its bound');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail();
  }
}

/** Exact projection of the authenticated GitHub run metadata consumed by this pure resolver. */
/**
 * Exact projection from the protected GitHub Actions run API. Callers must obtain this and artifact
 * metadata from the authenticated GitHub API; this pure module validates bindings, not API origin.
 */
export interface DeployRunMetadata {
  repository: string;
  headRepository: string;
  workflowPath: string;
  headBranch: string;
  event: string;
  runId: number;
  runAttempt: number;
  headSha: string;
  status: string;
  conclusion: string | null;
}
export interface CreationArtifactMetadata {
  name: string;
  digest: string;
  sizeInBytes: number;
  expired: boolean;
  workflowRun: { id: number; headSha: string };
}
export interface WebTagCreationProof extends OwnedWebTagProof {
  legacyBarrierCompleted: boolean;
  nativeTagObserved: boolean;
}
export type NativeWebTagLookup =
  | {
      status: 'present';
      service: string;
      type: string;
      tag: string;
      revision: string;
      uri: string;
      percent?: number;
    }
  | { status: 'absent'; service: string; tag: string };

/** Verify GitHub's SHA-256 digest and size against the exact downloaded ZIP bytes. */
export function verifyCreationArtifactArchiveDigest(
  metadata: Pick<CreationArtifactMetadata, 'digest' | 'sizeInBytes'>,
  archiveBytes: Uint8Array,
): string {
  const artifact = object(metadata, ['digest', 'sizeInBytes']);
  const digest = string(artifact.digest, /^sha256:[a-f0-9]{64}$/);
  if (
    !Number.isSafeInteger(artifact.sizeInBytes) ||
    artifact.sizeInBytes !== archiveBytes.byteLength ||
    archiveBytes.byteLength < 1 ||
    archiveBytes.byteLength > MAX_ARCHIVE_BYTES ||
    digest !== `sha256:${sha256(archiveBytes)}`
  )
    return fail('Artifact archive digest or size mismatch');
  return digest.slice('sha256:'.length);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function rejectZip64Extra(bytes: Buffer, start: number, length: number) {
  const end = start + length;
  if (end > bytes.length) return fail('Artifact ZIP extra data is truncated');
  for (let at = start; at < end; ) {
    if (at + 4 > end) return fail('Artifact ZIP extra data is invalid');
    const id = bytes.readUInt16LE(at);
    const size = bytes.readUInt16LE(at + 2);
    at += 4 + size;
    if (at > end || id === 0x0001)
      return fail('Artifact ZIP64 or malformed extra data is unsupported');
  }
}
function findEndRecord(bytes: Buffer): number {
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= floor; at--) {
    if (bytes.readUInt32LE(at) !== 0x06054b50) continue;
    if (at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) return at;
  }
  return fail('Artifact ZIP end record is invalid');
}
/**
 * Read one bounded regular ZIP member without writing/extracting paths. The receipt is accepted
 * only when its exact bytes are found in the digest-verified archive. This intentionally supports
 * exactly two non-ZIP64 entries and stored/deflate compression; unsupported ZIP variants fail closed.
 */
function creationMembersFromZip(archive: Uint8Array): Map<string, Buffer> {
  if (archive.byteLength < 22 || archive.byteLength > MAX_ARCHIVE_BYTES)
    return fail('Artifact ZIP exceeds its fixed bound');
  const bytes = Buffer.from(archive);
  const eocd = findEndRecord(bytes);
  if (
    bytes.readUInt16LE(eocd + 4) !== 0 ||
    bytes.readUInt16LE(eocd + 6) !== 0 ||
    bytes.readUInt16LE(eocd + 8) !== 2 ||
    bytes.readUInt16LE(eocd + 10) !== 2
  )
    return fail('Artifact ZIP must contain one entry on one disk');
  const directoryBytes = bytes.readUInt32LE(eocd + 12);
  const directoryAt = bytes.readUInt32LE(eocd + 16);
  if (directoryAt + directoryBytes !== eocd || directoryBytes < 46)
    return fail('Artifact ZIP central directory is invalid');

  const entries: Array<{ name: string; start: number; end: number; bytes: Buffer }> = [];
  const members = new Map<string, Buffer>();
  let central = directoryAt;
  for (let index = 0; index < 2; index++) {
    if (central + 46 > eocd || bytes.readUInt32LE(central) !== 0x02014b50)
      return fail('Artifact ZIP entry is invalid');
    const flags = bytes.readUInt16LE(central + 8);
    const method = bytes.readUInt16LE(central + 10);
    const expectedCrc = bytes.readUInt32LE(central + 16);
    const compressedSize = bytes.readUInt32LE(central + 20);
    const uncompressedSize = bytes.readUInt32LE(central + 24);
    const nameLength = bytes.readUInt16LE(central + 28);
    const extraLength = bytes.readUInt16LE(central + 30);
    const commentLength = bytes.readUInt16LE(central + 32);
    const disk = bytes.readUInt16LE(central + 34);
    const externalAttributes = bytes.readUInt32LE(central + 38);
    const localAt = bytes.readUInt32LE(central + 42);
    const nextCentral = central + 46 + nameLength + extraLength + commentLength;
    if (
      nextCentral > eocd ||
      disk !== 0 ||
      (flags & ~0x0808) !== 0 ||
      (method !== 0 && method !== 8) ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      compressedSize > MAX_ARCHIVE_BYTES ||
      uncompressedSize < 1 ||
      uncompressedSize > MAX_MANIFEST_BYTES
    )
      return fail('Artifact ZIP entry uses unsupported features or exceeds its bound');
    const mode = externalAttributes >>> 16;
    const fileType = mode & 0o170000;
    if ((fileType !== 0 && fileType !== 0o100000) || (externalAttributes & 0x10) !== 0)
      return fail('Artifact ZIP member is not a regular file');
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(central + 46, central + 46 + nameLength),
      );
    } catch {
      return fail('Artifact ZIP filename is invalid');
    }
    if (![CREATION_ARTIFACT_MEMBER, RELEASE_MANIFEST_MEMBER].includes(name) || members.has(name))
      return fail('Artifact ZIP member set is invalid');
    rejectZip64Extra(bytes, central + 46 + nameLength, extraLength);

    if (localAt + 30 > directoryAt || bytes.readUInt32LE(localAt) !== 0x04034b50)
      return fail('Artifact ZIP local header is invalid');
    const localFlags = bytes.readUInt16LE(localAt + 6);
    const localMethod = bytes.readUInt16LE(localAt + 8);
    const localCrc = bytes.readUInt32LE(localAt + 14);
    const localCompressedSize = bytes.readUInt32LE(localAt + 18);
    const localUncompressedSize = bytes.readUInt32LE(localAt + 22);
    const localNameLength = bytes.readUInt16LE(localAt + 26);
    const localExtraLength = bytes.readUInt16LE(localAt + 28);
    rejectZip64Extra(bytes, localAt + 30 + localNameLength, localExtraLength);
    const dataAt = localAt + 30 + localNameLength + localExtraLength;
    const dataEnd = dataAt + compressedSize;
    if (
      localFlags !== flags ||
      localMethod !== method ||
      localNameLength !== nameLength ||
      dataAt > directoryAt ||
      dataEnd > directoryAt ||
      !bytes
        .subarray(localAt + 30, localAt + 30 + localNameLength)
        .equals(bytes.subarray(central + 46, central + 46 + nameLength))
    )
      return fail('Artifact ZIP local entry does not match its directory');
    const hasDescriptor = (flags & 0x0008) !== 0;
    if (
      hasDescriptor
        ? (localCrc !== 0 && localCrc !== expectedCrc) ||
          (localCompressedSize !== 0 && localCompressedSize !== compressedSize) ||
          (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize)
        : localCrc !== expectedCrc ||
          localCompressedSize !== compressedSize ||
          localUncompressedSize !== uncompressedSize
    )
      return fail('Artifact ZIP local sizes do not match');
    let dataEndWithDescriptor = dataEnd;
    if (hasDescriptor) {
      if (bytes.readUInt32LE(dataEndWithDescriptor) === 0x08074b50) dataEndWithDescriptor += 4;
      if (
        dataEndWithDescriptor + 12 > directoryAt ||
        bytes.readUInt32LE(dataEndWithDescriptor) !== expectedCrc ||
        bytes.readUInt32LE(dataEndWithDescriptor + 4) !== compressedSize ||
        bytes.readUInt32LE(dataEndWithDescriptor + 8) !== uncompressedSize
      )
        return fail('Artifact ZIP data descriptor is invalid');
      dataEndWithDescriptor += 12;
    }
    let output: Buffer;
    try {
      const compressed = bytes.subarray(dataAt, dataEnd);
      output =
        method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: MAX_MANIFEST_BYTES });
    } catch {
      return fail('Artifact ZIP member could not be decoded');
    }
    if (output.length !== uncompressedSize || crc32(output) !== expectedCrc)
      return fail('Artifact ZIP member checksum is invalid');
    members.set(name, output);
    entries.push({ name, start: localAt, end: dataEndWithDescriptor, bytes: output });
    central = nextCentral;
  }
  if (
    central !== eocd ||
    members.size !== 2 ||
    !members.has(CREATION_ARTIFACT_MEMBER) ||
    !members.has(RELEASE_MANIFEST_MEMBER)
  )
    return fail('Artifact ZIP must contain exactly the receipt and release manifest');
  entries.sort((a, b) => a.start - b.start);
  if (
    entries[0]?.start !== 0 ||
    entries[0]?.end !== entries[1]?.start ||
    entries[1]?.end !== directoryAt
  )
    return fail('Artifact ZIP has unaccounted data');
  return members;
}
/** Extract only the two fixed files from the bounded archive; never writes paths to disk. */
export function extractCreationArchive(archiveBytes: Uint8Array): {
  receiptBytes: Buffer;
  releaseManifestBytes: Buffer;
} {
  const members = creationMembersFromZip(archiveBytes);
  const receiptBytes = members.get(CREATION_ARTIFACT_MEMBER);
  const releaseManifestBytes = members.get(RELEASE_MANIFEST_MEMBER);
  if (!receiptBytes || !releaseManifestBytes) return fail('Creation archive members are missing');
  return { receiptBytes, releaseManifestBytes };
}

function parseRunMetadata(raw: unknown): DeployRunMetadata {
  const run = object(raw, [
    'repository',
    'headRepository',
    'workflowPath',
    'headBranch',
    'event',
    'runId',
    'runAttempt',
    'headSha',
    'status',
    'conclusion',
  ]);
  if (
    run.repository !== DEPLOY_REPOSITORY ||
    run.headRepository !== DEPLOY_REPOSITORY ||
    run.workflowPath !== DEPLOY_WORKFLOW_PATH ||
    run.headBranch !== 'main' ||
    run.status !== 'completed' ||
    ![
      'success',
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'neutral',
      'skipped',
      'stale',
    ].includes(String(run.conclusion)) ||
    !['workflow_run', 'workflow_dispatch'].includes(String(run.event))
  )
    return fail('Creation run is not the protected main deploy workflow');
  return {
    repository: DEPLOY_REPOSITORY,
    headRepository: DEPLOY_REPOSITORY,
    workflowPath: DEPLOY_WORKFLOW_PATH,
    headBranch: 'main',
    event: run.event as string,
    runId: positiveInteger(run.runId),
    runAttempt: positiveInteger(run.runAttempt),
    headSha: string(run.headSha, /^[a-f0-9]{40}$/),
    status: 'completed',
    conclusion: run.conclusion as string,
  };
}
export function creationArtifactName(source: string, runId: number, runAttempt: number) {
  const sha = string(source, /^[a-f0-9]{40}$/);
  const id = positiveInteger(runId);
  const attempt = positiveInteger(runAttempt);
  if (`${id}-${attempt}`.length > 21) return fail('Run identity exceeds the Cloud Run tag bound');
  return `owner-web-tag-creation-${sha}-${id}-${attempt}`;
}

export interface WebTagCreationRecord {
  kind: 'candidate' | 'resume';
  revision: string;
  image: string;
  writesPaused: boolean;
  uriSha256: string;
  legacyBarrierCompleted: boolean;
}
export interface WebTagCreationReceipt {
  format: 1;
  runId: number;
  runAttempt: number;
  source: string;
  manifestSha256: string;
  records: WebTagCreationRecord[];
}
function parseReceipt(bytes: Uint8Array): WebTagCreationReceipt {
  const receipt = object(parseJson(bytes, MAX_RECEIPT_BYTES), [
    'format',
    'runId',
    'runAttempt',
    'source',
    'manifestSha256',
    'records',
  ]);
  if (
    receipt.format !== 1 ||
    !Array.isArray(receipt.records) ||
    receipt.records.length < 1 ||
    receipt.records.length > 2
  )
    return fail('Creation receipt state is invalid');
  const kinds = new Set<string>();
  const records = receipt.records.map((raw) => {
    const record = object(raw, [
      'kind',
      'revision',
      'image',
      'writesPaused',
      'uriSha256',
      'legacyBarrierCompleted',
    ]);
    if (
      !['candidate', 'resume'].includes(String(record.kind)) ||
      kinds.has(String(record.kind)) ||
      typeof record.writesPaused !== 'boolean' ||
      typeof record.legacyBarrierCompleted !== 'boolean' ||
      (record.kind === 'candidate' &&
        (record.legacyBarrierCompleted !== false || record.writesPaused !== true)) ||
      (record.kind === 'resume' &&
        (record.legacyBarrierCompleted !== true || record.writesPaused !== false))
    )
      return fail('Creation receipt record is invalid');
    kinds.add(String(record.kind));
    return {
      kind: record.kind as WebTagCreationRecord['kind'],
      revision: string(record.revision, /^assistant-web-[a-z0-9-]{1,63}$/),
      image: string(
        record.image,
        /^us-west1-docker\.pkg\.dev\/bmson-assistant\/assistant\/web@sha256:[a-f0-9]{64}$/,
      ),
      writesPaused: record.writesPaused,
      uriSha256: string(record.uriSha256, /^[a-f0-9]{64}$/),
      legacyBarrierCompleted: record.legacyBarrierCompleted,
    };
  });
  if (!kinds.has('candidate')) return fail('Creation receipt candidate record is missing');
  return {
    format: 1,
    runId: positiveInteger(receipt.runId),
    runAttempt: positiveInteger(receipt.runAttempt),
    source: string(receipt.source, /^[a-f0-9]{40}$/),
    manifestSha256: string(receipt.manifestSha256, /^[a-f0-9]{64}$/),
    records,
  };
}

interface WebManifest {
  manifestDigest: string;
  release: string;
  image: string;
  digest: string;
}
function parseWebManifest(bytes: Uint8Array): WebManifest {
  const manifest = object(parseJson(bytes, MAX_MANIFEST_BYTES), [
    'format',
    'release',
    'selected',
    'storageDriver',
    'schemaVersion',
    'components',
    'manifestDigest',
  ]);
  if (
    manifest.format !== 1 ||
    !Array.isArray(manifest.selected) ||
    !manifest.selected.includes('web') ||
    manifest.selected.some(
      (name) => !['agent', 'web', 'browser', 'code', 'processor'].includes(String(name)),
    ) ||
    new Set(manifest.selected).size !== manifest.selected.length ||
    !['postgres', 'firestore'].includes(String(manifest.storageDriver)) ||
    !Number.isSafeInteger(manifest.schemaVersion)
  )
    return fail('Release manifest is invalid');
  const components = object(manifest.components, manifest.selected as string[]);
  for (const name of manifest.selected as string[]) {
    const component = object(components[name], [
      'image',
      'digest',
      'apiContract',
      'peerApi',
      'schema',
    ]);
    const imageRoot = `us-west1-docker.pkg.dev/bmson-assistant/assistant/${name}@`;
    const image = string(
      component.image,
      /^us-west1-docker\.pkg\.dev\/bmson-assistant\/assistant\/[a-z]+@sha256:[a-f0-9]{64}$/,
    );
    const digest = string(component.digest, /^sha256:[a-f0-9]{64}$/);
    if (image !== `${imageRoot}${digest}` || !Number.isSafeInteger(component.apiContract))
      return fail('Release component identity is invalid');
    const peer = object(component.peerApi, ['min', 'max']);
    if (
      !Number.isSafeInteger(peer.min) ||
      !Number.isSafeInteger(peer.max) ||
      (peer.min as number) < 0 ||
      (peer.max as number) < (peer.min as number)
    )
      return fail('Release component API contract is invalid');
    const schema = object(component.schema, ['postgres', 'firestore']);
    for (const driver of ['postgres', 'firestore'] as const) {
      const range = object(schema[driver], ['min', 'max']);
      if (
        !Number.isSafeInteger(range.min) ||
        !Number.isSafeInteger(range.max) ||
        (range.min as number) < 0 ||
        (range.max as number) < (range.min as number)
      )
        return fail('Release component schema range is invalid');
    }
    const range = schema[String(manifest.storageDriver)] as ObjectValue;
    if (
      (manifest.schemaVersion as number) < (range.min as number) ||
      (manifest.schemaVersion as number) > (range.max as number)
    )
      return fail('Release manifest schema is outside the component range');
  }
  const web = object(components.web, ['image', 'digest', 'apiContract', 'peerApi', 'schema']);
  const image = string(
    web.image,
    /^us-west1-docker\.pkg\.dev\/bmson-assistant\/assistant\/web@sha256:[a-f0-9]{64}$/,
  );
  const digest = string(web.digest, /^sha256:[a-f0-9]{64}$/);
  if (image !== `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@${digest}`)
    return fail('Web manifest image does not match its digest');
  const manifestDigest = string(manifest.manifestDigest, /^[a-f0-9]{64}$/);
  const unsigned = { ...manifest };
  delete unsigned.manifestDigest;
  if (sha256(JSON.stringify(unsigned)) !== manifestDigest)
    return fail('Release manifest digest mismatch');
  return {
    manifestDigest,
    release: string(manifest.release, /^[a-f0-9]{40}$/),
    image,
    digest,
  };
}

/** Resolve ownership only when receipt bytes are an exact member of the digest-bound ZIP. */
export function resolveProtectedOwnedWebTag(input: {
  runMetadata: unknown;
  artifactMetadata: unknown;
  archiveBytes: Uint8Array;
  receiptBytes: Uint8Array;
  releaseManifestBytes: Uint8Array;
  nativeWebRevision: unknown;
  expectedKind?: WebTagCreationRecord['kind'];
  serviceTagObservation: unknown;
}): WebTagCreationProof {
  const run = parseRunMetadata(input.runMetadata);
  const artifact = object(input.artifactMetadata, [
    'name',
    'digest',
    'sizeInBytes',
    'expired',
    'workflowRun',
  ]);
  const artifactWorkflow = object(artifact.workflowRun, ['id', 'headSha']);
  const archiveDigest = verifyCreationArtifactArchiveDigest(
    {
      digest: artifact.digest as string,
      sizeInBytes: artifact.sizeInBytes as number,
    },
    input.archiveBytes,
  );
  if (
    artifact.expired !== false ||
    artifactWorkflow.id !== run.runId ||
    artifactWorkflow.headSha !== run.headSha
  )
    return fail('Creation artifact is not bound to the exact deploy run');
  const { receiptBytes: member, releaseManifestBytes: manifestMember } = extractCreationArchive(
    input.archiveBytes,
  );
  if (!Buffer.from(input.receiptBytes).equals(member))
    return fail('Creation receipt bytes are not the exact artifact member');
  if (!Buffer.from(input.releaseManifestBytes).equals(manifestMember))
    return fail('Release manifest bytes are not the exact artifact member');
  const receipt = parseReceipt(member);
  const manifest = parseWebManifest(manifestMember);
  if (
    receipt.runId !== run.runId ||
    receipt.runAttempt !== run.runAttempt ||
    receipt.source !== run.headSha ||
    receipt.source !== manifest.release ||
    receipt.manifestSha256 !== sha256(manifestMember) ||
    artifact.name !== creationArtifactName(receipt.source, receipt.runId, receipt.runAttempt)
  )
    return fail('Creation receipt does not match its run and release manifest');
  if (
    !input.serviceTagObservation ||
    typeof input.serviceTagObservation !== 'object' ||
    Array.isArray(input.serviceTagObservation)
  )
    return fail('Native tag lookup is invalid');
  const lookupRaw = input.serviceTagObservation as ObjectValue;
  const lookup =
    lookupRaw.status === 'present'
      ? objectWithOptional(
          lookupRaw,
          ['status', 'service', 'type', 'tag', 'revision', 'uri'],
          ['percent'],
        )
      : object(lookupRaw, ['status', 'service', 'tag']);
  if (lookup.service !== WEB_SERVICE || !['present', 'absent'].includes(String(lookup.status)))
    return fail('Native tag lookup is invalid');
  let kind = input.expectedKind;
  if (lookup.status === 'present') {
    const prefix =
      typeof lookup.tag === 'string' ? /^(candidate|resume)-/.exec(lookup.tag)?.[1] : undefined;
    if (!prefix) return fail('Native observed tag kind is invalid');
    kind = prefix as WebTagCreationRecord['kind'];
  }
  if (!kind || !['candidate', 'resume'].includes(kind)) return fail('Creation tag kind is missing');
  if (input.expectedKind !== undefined && input.expectedKind !== kind)
    return fail('Requested creation tag kind does not match the native observation');
  const record = receipt.records.find((entry) => entry.kind === kind);
  if (!record) return fail('Creation receipt lacks the observed tag record');
  const tag = `${kind}-${receipt.runId}-${receipt.runAttempt}`;
  if (lookup.tag !== tag) return fail('Native lookup tag does not match its protected run');
  const observedPercent = lookup.percent === undefined ? 0 : lookup.percent;
  if (
    record.image !== manifest.image ||
    (lookup.status === 'present' &&
      (lookup.type !== 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION' ||
        lookup.revision !== record.revision ||
        typeof lookup.uri !== 'string' ||
        !/^https:\/\/[^\s]{1,512}$/.test(lookup.uri) ||
        (observedPercent !== 0 && observedPercent !== 100) ||
        tagHash(lookup.uri) !== record.uriSha256)) ||
    (lookup.status === 'absent' && input.expectedKind !== kind)
  )
    return fail('Native Cloud Run tag observation does not match the creation receipt');
  immutableWebRevision(input.nativeWebRevision, record.revision, record.image, record.writesPaused);
  return {
    tag,
    revision: record.revision,
    image: record.image,
    source: receipt.source,
    uriSha256: record.uriSha256,
    provenanceSha256: archiveDigest,
    writesPaused: record.writesPaused,
    legacyBarrierCompleted: record.legacyBarrierCompleted,
    nativeTagObserved: lookup.status === 'present',
  };
}
