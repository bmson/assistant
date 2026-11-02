/** Separate manifest-only probe; does not broaden the two-member creation-artifact reader. */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
export const QUALIFICATION_MANIFEST = {
  runId: 40403696377,
  attempt: 1,
  source: '0c9a7ad7fc9c62b7ff166fe85bd023013ee88d43',
  id: 12690736934,
  name: 'release-manifest-0c9a7ad7fc9c62b7ff166fe85bd023013ee88d43',
  bytes: 837,
  archiveSha256: '2d4ea8eb94aafc85d1ae2f07c2009378eea7178e61c7dfd57f4e553c14c05d61',
  member: 'assistant-release-0c9a7ad7fc9c62b7ff166fe85bd023013ee88d43.json',
  payloadSha256: '88111506b65187b3b24e40e910251420184168ffff7d4fbfe0d2aeb4cc4bf23c',
} as const;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024,
  MAX_MANIFEST_BYTES = 256 * 1024;
function fail(): never {
  throw new Error('Qualification manifest held');
}
export const qualificationSha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
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
  if (end > bytes.length) return fail();
  for (let at = start; at < end; ) {
    if (at + 4 > end) return fail();
    const id = bytes.readUInt16LE(at);
    const size = bytes.readUInt16LE(at + 2);
    at += 4 + size;
    if (at > end || id === 0x0001) return fail();
  }
}
function findEndRecord(bytes: Buffer): number {
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= floor; at--) {
    if (bytes.readUInt32LE(at) !== 0x06054b50) continue;
    if (at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) return at;
  }
  return fail();
}
/**
 * Read one bounded regular ZIP member without writing/extracting paths. The receipt is accepted
 * only when its exact bytes are found in the digest-verified archive. This intentionally supports
 * exactly one non-ZIP64 entry and stored/deflate compression; unsupported ZIP variants fail closed.
 */
export function decodeQualificationManifestZip(archive: Uint8Array): Buffer {
  if (archive.byteLength < 22 || archive.byteLength > MAX_ARCHIVE_BYTES) return fail();
  const bytes = Buffer.from(archive);
  const eocd = findEndRecord(bytes);
  if (
    bytes.readUInt16LE(eocd + 4) !== 0 ||
    bytes.readUInt16LE(eocd + 6) !== 0 ||
    bytes.readUInt16LE(eocd + 8) !== 1 ||
    bytes.readUInt16LE(eocd + 10) !== 1
  )
    return fail();
  const directoryBytes = bytes.readUInt32LE(eocd + 12);
  const directoryAt = bytes.readUInt32LE(eocd + 16);
  if (directoryAt + directoryBytes !== eocd || directoryBytes < 46) return fail();

  const entries: Array<{ name: string; start: number; end: number; bytes: Buffer }> = [];
  const members = new Map<string, Buffer>();
  let central = directoryAt;
  for (let index = 0; index < 1; index++) {
    if (central + 46 > eocd || bytes.readUInt32LE(central) !== 0x02014b50) return fail();
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
      return fail();
    const mode = externalAttributes >>> 16;
    const fileType = mode & 0o170000;
    if ((fileType !== 0 && fileType !== 0o100000) || (externalAttributes & 0x10) !== 0)
      return fail();
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(central + 46, central + 46 + nameLength),
      );
    } catch {
      return fail();
    }
    if (name !== QUALIFICATION_MANIFEST.member || members.has(name)) return fail();
    rejectZip64Extra(bytes, central + 46 + nameLength, extraLength);

    if (localAt + 30 > directoryAt || bytes.readUInt32LE(localAt) !== 0x04034b50) return fail();
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
      return fail();
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
      return fail();
    let dataEndWithDescriptor = dataEnd;
    if (hasDescriptor) {
      if (bytes.readUInt32LE(dataEndWithDescriptor) === 0x08074b50) dataEndWithDescriptor += 4;
      if (
        dataEndWithDescriptor + 12 > directoryAt ||
        bytes.readUInt32LE(dataEndWithDescriptor) !== expectedCrc ||
        bytes.readUInt32LE(dataEndWithDescriptor + 4) !== compressedSize ||
        bytes.readUInt32LE(dataEndWithDescriptor + 8) !== uncompressedSize
      )
        return fail();
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
      return fail();
    }
    if (output.length !== uncompressedSize || crc32(output) !== expectedCrc) return fail();
    members.set(name, output);
    entries.push({ name, start: localAt, end: dataEndWithDescriptor, bytes: output });
    central = nextCentral;
  }
  if (central !== eocd || members.size !== 1 || !members.has(QUALIFICATION_MANIFEST.member))
    return fail();
  if (entries[0]?.start !== 0 || entries[0]?.end !== directoryAt) return fail();
  const output = members.get(QUALIFICATION_MANIFEST.member);
  if (!output) return fail();
  return output;
}

export function verifyQualificationManifest(archive: Uint8Array) {
  try {
    if (
      archive.byteLength !== QUALIFICATION_MANIFEST.bytes ||
      qualificationSha256(archive) !== QUALIFICATION_MANIFEST.archiveSha256
    )
      return fail();
    const member = decodeQualificationManifestZip(archive);
    if (qualificationSha256(member) !== QUALIFICATION_MANIFEST.payloadSha256) return fail();
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(member));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as { release?: unknown }).release !== QUALIFICATION_MANIFEST.source
    )
      return fail();
    return {
      artifactId: QUALIFICATION_MANIFEST.id,
      archiveSha256: QUALIFICATION_MANIFEST.archiveSha256,
      payloadSha256: QUALIFICATION_MANIFEST.payloadSha256,
      creationProofQualified: false as const,
      coldContinuationAuthorized: false as const,
    };
  } catch {
    return fail();
  }
}
