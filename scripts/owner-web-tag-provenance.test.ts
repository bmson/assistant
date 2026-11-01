import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CREATION_ARTIFACT_MEMBER,
  creationArtifactName,
  extractCreationArchive,
  RELEASE_MANIFEST_MEMBER,
  resolveProtectedOwnedWebTag,
  verifyCreationArtifactArchiveDigest,
} from './owner-web-tag-provenance.js';
import { tagHash, WEB_SERVICE } from './owner-web-tag-retirement.js';

const hex = (character: string) => character.repeat(64);
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const source = 'a'.repeat(40);
const deployHead = source;
const imageDigest = `sha256:${hex('c')}`;
const image = `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@${imageDigest}`;
const runMetadata = {
  repository: 'bmson/assistant',
  headRepository: 'bmson/assistant',
  workflowPath: '.github/workflows/deploy.yml',
  headBranch: 'main',
  event: 'workflow_dispatch',
  runId: 123456789,
  runAttempt: 2,
  headSha: deployHead,
  status: 'completed',
  conclusion: 'success',
};
const uri = 'https://resume-123456789-2---assistant-web-3gimfiaifa-uw.a.run.app';

function releaseManifest() {
  const manifest = {
    format: 1,
    release: source,
    selected: ['web'],
    storageDriver: 'postgres',
    schemaVersion: 132,
    components: {
      web: {
        image,
        digest: imageDigest,
        apiContract: 1,
        peerApi: { min: 1, max: 1 },
        schema: {
          postgres: { min: 132, max: 133 },
          firestore: { min: 1, max: 133 },
        },
      },
    },
  };
  return {
    ...manifest,
    manifestDigest: sha256(JSON.stringify(manifest)),
  };
}
function zipFiles(files: Array<[string, Uint8Array]>) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const filename = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + filename.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    filename.copy(local, 30);
    data.copy(local, 30 + filename.length);
    localParts.push(local);

    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    filename.copy(central, 46);
    centralParts.push(central);
    offset += local.length;
  }
  const localBytes = Buffer.concat(localParts);
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function fixture(kind: 'candidate' | 'resume' = 'resume') {
  const tag = `${kind}-${runMetadata.runId}-${runMetadata.runAttempt}`;
  const manifest = releaseManifest();
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const candidateURI = `https://candidate-${runMetadata.runId}-${runMetadata.runAttempt}---assistant-web-3gimfiaifa-uw.a.run.app`;
  const receipt = {
    format: 1,
    runId: runMetadata.runId,
    runAttempt: runMetadata.runAttempt,
    source,
    manifestSha256: sha256(manifestBytes),
    records: [
      {
        kind: 'candidate',
        revision: 'assistant-web-01098-old',
        image,
        writesPaused: true,
        uriSha256: tagHash(candidateURI),
        legacyBarrierCompleted: false,
      },
      {
        kind: 'resume',
        revision: 'assistant-web-01099-new',
        image,
        writesPaused: false,
        uriSha256: tagHash(uri),
        legacyBarrierCompleted: true,
      },
    ],
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  const archiveBytes = zipFiles([
    [CREATION_ARTIFACT_MEMBER, receiptBytes],
    [RELEASE_MANIFEST_MEMBER, manifestBytes],
  ]);
  const artifactMetadata = {
    name: creationArtifactName(source, runMetadata.runId, runMetadata.runAttempt),
    digest: `sha256:${sha256(archiveBytes)}`,
    sizeInBytes: archiveBytes.length,
    expired: false,
    workflowRun: { id: runMetadata.runId, headSha: deployHead },
  };
  const selectedRecord = receipt.records.find((record) => record.kind === kind);
  if (!selectedRecord) throw new Error('Missing selected record');
  const selectedUri = kind === 'candidate' ? candidateURI : uri;
  const nativeWebRevision = {
    name: `${WEB_SERVICE}/revisions/${selectedRecord.revision}`,
    timeout: '300s',
    serviceAccount: 'assistant-web@bmson-assistant.iam.gserviceaccount.com',
    containers: [
      {
        image,
        env: [
          { name: 'ASSISTANT_RELEASE_WRITES_PAUSED', value: String(selectedRecord.writesPaused) },
          { name: 'PRIVATE', value: 'never retained in proof' },
        ],
      },
    ],
  };
  const serviceTagObservation = {
    status: 'present',
    service: WEB_SERVICE,
    type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
    tag,
    revision: selectedRecord.revision,
    uri: selectedUri,
    percent: 0,
  };
  const input = {
    runMetadata,
    artifactMetadata,
    archiveBytes,
    receiptBytes,
    releaseManifestBytes: manifestBytes,
    nativeWebRevision,
    serviceTagObservation,
  };
  return {
    input,
    receipt,
    archiveBytes,
    manifest,
    manifestBytes,
    receiptBytes,
    nativeWebRevision,
    serviceTagObservation,
    selectedRecord,
    candidateURI,
    selectedUri,
  };
}

describe('protected web-tag creation provenance resolver', () => {
  it('binds a resume tag to its protected run artifact, manifest, immutable revision and exact URI', () => {
    const f = fixture();
    expect(resolveProtectedOwnedWebTag(f.input)).toEqual({
      tag: `resume-${runMetadata.runId}-${runMetadata.runAttempt}`,
      revision: f.selectedRecord.revision,
      image,
      source,
      uriSha256: tagHash(uri),
      provenanceSha256: sha256(f.archiveBytes),
      writesPaused: false,
      legacyBarrierCompleted: true,
      nativeTagObserved: true,
    });
  });

  it('proves ownership from a completed failed run without implying activation', () => {
    const f = fixture();
    const proof = resolveProtectedOwnedWebTag({
      ...f.input,
      runMetadata: { ...f.input.runMetadata, conclusion: 'failure' },
    });
    expect(proof).toMatchObject({
      tag: `resume-${runMetadata.runId}-${runMetadata.runAttempt}`,
      writesPaused: false,
      legacyBarrierCompleted: true,
      nativeTagObserved: true,
    });
  });

  it('accepts candidate provenance only before the legacy barrier and matches native paused state', () => {
    const f = fixture('candidate');
    expect(resolveProtectedOwnedWebTag(f.input)).toMatchObject({
      tag: `candidate-${runMetadata.runId}-${runMetadata.runAttempt}`,
      writesPaused: true,
      legacyBarrierCompleted: false,
      nativeTagObserved: true,
    });
  });

  it('resolves a canonical tag confirmed absent without claiming a live URI observation', () => {
    const f = fixture('candidate');
    expect(
      resolveProtectedOwnedWebTag({
        ...f.input,
        expectedKind: 'candidate',
        serviceTagObservation: {
          status: 'absent',
          service: WEB_SERVICE,
          tag: `candidate-${runMetadata.runId}-${runMetadata.runAttempt}`,
        },
      }),
    ).toMatchObject({
      nativeTagObserved: false,
      uriSha256: tagHash(f.candidateURI),
      legacyBarrierCompleted: false,
    });
  });

  it('exports only the two validated fixed archive members', () => {
    const f = fixture();
    expect(extractCreationArchive(f.archiveBytes)).toEqual({
      receiptBytes: f.receiptBytes,
      releaseManifestBytes: f.manifestBytes,
    });
  });

  it('rejects caller-supplied receipt bytes that are not the exact ZIP member', () => {
    const f = fixture();
    expect(() =>
      resolveProtectedOwnedWebTag({ ...f.input, receiptBytes: Buffer.from('{}') }),
    ).toThrow('not the exact artifact member');
  });

  it.each([
    [
      'archive digest',
      (f: ReturnType<typeof fixture>) => ({
        ...f.input,
        artifactMetadata: { ...f.input.artifactMetadata, digest: `sha256:${hex('d')}` },
      }),
    ],
    [
      'archive size',
      (f: ReturnType<typeof fixture>) => ({
        ...f.input,
        artifactMetadata: { ...f.input.artifactMetadata, sizeInBytes: 1 },
      }),
    ],
    [
      'artifact name',
      (f: ReturnType<typeof fixture>) => ({
        ...f.input,
        artifactMetadata: { ...f.input.artifactMetadata, name: 'owner-web-tag-creation-1-1' },
      }),
    ],
    [
      'artifact run ID',
      (f: ReturnType<typeof fixture>) => ({
        ...f.input,
        artifactMetadata: {
          ...f.input.artifactMetadata,
          workflowRun: { ...f.input.artifactMetadata.workflowRun, id: 999 },
        },
      }),
    ],
    [
      'artifact head SHA',
      (f: ReturnType<typeof fixture>) => ({
        ...f.input,
        artifactMetadata: {
          ...f.input.artifactMetadata,
          workflowRun: { ...f.input.artifactMetadata.workflowRun, headSha: 'd'.repeat(40) },
        },
      }),
    ],
    [
      'run and artifact head SHA do not bind receipt source',
      (f: ReturnType<typeof fixture>) => ({
        ...f.input,
        runMetadata: { ...f.input.runMetadata, headSha: 'd'.repeat(40) },
        artifactMetadata: {
          ...f.input.artifactMetadata,
          workflowRun: { ...f.input.artifactMetadata.workflowRun, headSha: 'd'.repeat(40) },
        },
      }),
    ],
    [
      'run repository',
      (f: ReturnType<typeof fixture>) => ({
        ...f.input,
        runMetadata: { ...f.input.runMetadata, repository: 'fork/assistant' },
      }),
    ],
    [
      'run workflow',
      (f: ReturnType<typeof fixture>) => ({
        ...f.input,
        runMetadata: { ...f.input.runMetadata, workflowPath: '.github/workflows/other.yml' },
      }),
    ],
    [
      'run branch',
      (f: ReturnType<typeof fixture>) => ({
        ...f.input,
        runMetadata: { ...f.input.runMetadata, headBranch: 'feature' },
      }),
    ],
    [
      'run attempt',
      (f: ReturnType<typeof fixture>) => ({
        ...f.input,
        runMetadata: { ...f.input.runMetadata, runAttempt: 3 },
      }),
    ],
    [
      'unknown run field',
      (f: ReturnType<typeof fixture>) => ({
        ...f.input,
        runMetadata: { ...f.input.runMetadata, actor: 'unexpected' },
      }),
    ],
    [
      'unknown artifact field',
      (f: ReturnType<typeof fixture>) => ({
        ...f.input,
        artifactMetadata: { ...f.input.artifactMetadata, url: 'unexpected' },
      }),
    ],
  ])('rejects mismatched %s', (_name, change) => {
    const f = fixture();
    expect(() => resolveProtectedOwnedWebTag(change(f))).toThrow();
  });

  it.each([
    ['wrong receipt source', { source: 'e'.repeat(40) }],
    ['wrong run ID', { runId: 1 }],
    ['wrong run attempt', { runAttempt: 1 }],
    [
      'wrong image',
      { image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${hex('d')}` },
    ],
    ['wrong manifest pin', { manifestSha256: hex('d') }],
    ['candidate claims barrier', { recordKind: 'candidate', legacyBarrierCompleted: true }],
    ['resume lacks barrier', { recordKind: 'resume', legacyBarrierCompleted: false }],
    ['unknown receipt key', { unexpected: true }],
  ])('rejects %s in a protected receipt', (_name, patch) => {
    const f = fixture();
    const { recordKind, ...recordPatch } = patch as Record<string, unknown>;
    const altered = recordKind
      ? {
          ...f.receipt,
          records: f.receipt.records.map((record) =>
            record.kind === recordKind ? { ...record, ...recordPatch } : record,
          ),
        }
      : { ...f.receipt, ...recordPatch };
    const receiptBytes = Buffer.from(JSON.stringify(altered));
    const archiveBytes = zipFiles([
      [CREATION_ARTIFACT_MEMBER, receiptBytes],
      [RELEASE_MANIFEST_MEMBER, f.manifestBytes],
    ]);
    const artifactMetadata = {
      ...f.input.artifactMetadata,
      digest: `sha256:${sha256(archiveBytes)}`,
      sizeInBytes: archiveBytes.length,
    };
    expect(() =>
      resolveProtectedOwnedWebTag({
        ...f.input,
        receiptBytes,
        archiveBytes,
        artifactMetadata,
      }),
    ).toThrow();
  });

  it('rejects manifest digest mismatch, unknown manifest keys and nonmatching native image or pause', () => {
    const f = fixture();
    const resolveWithManifest = (manifestValue: unknown) => {
      const releaseManifestBytes = Buffer.from(JSON.stringify(manifestValue));
      const archiveBytes = zipFiles([
        [CREATION_ARTIFACT_MEMBER, f.receiptBytes],
        [RELEASE_MANIFEST_MEMBER, releaseManifestBytes],
      ]);
      return resolveProtectedOwnedWebTag({
        ...f.input,
        releaseManifestBytes,
        archiveBytes,
        artifactMetadata: {
          ...f.input.artifactMetadata,
          digest: `sha256:${sha256(archiveBytes)}`,
          sizeInBytes: archiveBytes.length,
        },
      });
    };
    expect(() => resolveWithManifest({ ...f.manifest, release: 'f'.repeat(40) })).toThrow(
      'Release manifest digest mismatch',
    );
    expect(() => resolveWithManifest({ ...f.manifest, unexpected: true })).toThrow();
    const wrongNative = structuredClone(f.nativeWebRevision);
    const wrongNativeContainer = wrongNative.containers[0];
    if (!wrongNativeContainer) throw new Error('Missing fixture container');
    wrongNativeContainer.image = `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${hex('e')}`;
    expect(() =>
      resolveProtectedOwnedWebTag({ ...f.input, nativeWebRevision: wrongNative }),
    ).toThrow();
    const wrongPause = structuredClone(f.nativeWebRevision);
    const pauseEnv = wrongPause.containers[0]?.env[0];
    if (!pauseEnv) throw new Error('Missing pause environment fixture');
    pauseEnv.value = 'true';
    expect(() =>
      resolveProtectedOwnedWebTag({ ...f.input, nativeWebRevision: wrongPause }),
    ).toThrow();
  });

  it('requires the exact observed native service, tag, revision, URI hash and valid allocation', () => {
    const f = fixture();
    for (const change of [
      { service: 'projects/other/locations/us-west1/services/assistant-web' },
      { tag: 'candidate-123456789-2' },
      { revision: 'assistant-web-other' },
      { uri: 'https://foreign.example' },
      { percent: 50 },
      { unknown: true },
    ])
      expect(() =>
        resolveProtectedOwnedWebTag({
          ...f.input,
          serviceTagObservation: { ...f.serviceTagObservation, ...change },
        }),
      ).toThrow();
  });

  it('checks archive SHA-256 against the exact bytes', () => {
    const f = fixture();
    expect(
      verifyCreationArtifactArchiveDigest(
        { digest: `sha256:${sha256(f.archiveBytes)}`, sizeInBytes: f.archiveBytes.length },
        f.archiveBytes,
      ),
    ).toBe(sha256(f.archiveBytes));
    expect(() =>
      verifyCreationArtifactArchiveDigest(
        { digest: `sha256:${hex('e')}`, sizeInBytes: f.archiveBytes.length },
        f.archiveBytes,
      ),
    ).toThrow('Artifact archive digest or size mismatch');
  });

  it('rejects ZIPs without the one exact regular receipt member', () => {
    const f = fixture();
    const wrongName = zipFiles([
      ['other.json', f.input.receiptBytes],
      [RELEASE_MANIFEST_MEMBER, f.manifestBytes],
    ]);
    expect(() =>
      resolveProtectedOwnedWebTag({
        ...f.input,
        archiveBytes: wrongName,
        artifactMetadata: {
          ...f.input.artifactMetadata,
          digest: `sha256:${sha256(wrongName)}`,
          sizeInBytes: wrongName.length,
        },
      }),
    ).toThrow('Artifact ZIP member set is invalid');
    const corrupted = Buffer.from(f.archiveBytes);
    corrupted[35] = (corrupted[35] ?? 0) ^ 1;
    expect(() =>
      resolveProtectedOwnedWebTag({
        ...f.input,
        archiveBytes: corrupted,
        artifactMetadata: {
          ...f.input.artifactMetadata,
          digest: `sha256:${sha256(corrupted)}`,
          sizeInBytes: corrupted.length,
        },
      }),
    ).toThrow();
  });
});
