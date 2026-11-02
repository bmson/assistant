import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decodeQualificationManifestZip,
  QUALIFICATION_MANIFEST as PIN,
  verifyQualificationManifest,
} from './owner-web-release-qualification-manifest.js';

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Synthetic decoder fixtures only. These cannot pass the production digest pins.
function zip(
  name = PIN.member as string,
  method = 0,
  payload = Buffer.from('{"release":"synthetic"}'),
) {
  const filename = Buffer.from(name),
    data = method === 8 ? deflateRawSync(payload) : payload,
    crc = crc32(payload);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}
describe('offline separate manifest-only ZIP decoder', () => {
  it.each([0, 8])('decodes the one exact member with method %s', (method) => {
    expect(decodeQualificationManifestZip(zip(PIN.member, method)).toString()).toBe(
      '{"release":"synthetic"}',
    );
  });
  it.each([
    '../release.json',
    'release-manifest.json',
    'owner-web-tag-creation.json',
    `${PIN.member}/`,
  ])('rejects foreign/path member %s', (name) => {
    expect(() => decodeQualificationManifestZip(zip(name))).toThrow();
  });
  it('refuses malformed, truncated, extra-member counts, encrypted and CRC-corrupt archives', () => {
    const valid = zip();
    const corruptions = [
      Buffer.alloc(0),
      valid.subarray(0, -1),
      Buffer.concat([Buffer.from('prefix'), valid]),
      Buffer.concat([valid, Buffer.from('suffix')]),
    ];
    for (const [offset, value] of [
      [valid.length - 22 + 10, 2],
      [6, 1],
      [14, 0],
    ]) {
      const b = Buffer.from(valid);
      b.writeUInt16LE(value as number, offset as number);
      corruptions.push(b);
    }
    for (const b of corruptions) expect(() => decodeQualificationManifestZip(b)).toThrow();
  });
  it('bounds decompression and rejects symlinks', () => {
    expect(() =>
      decodeQualificationManifestZip(zip(PIN.member, 8, Buffer.alloc(256 * 1024 + 1, 65))),
    ).toThrow();
    const b = zip(),
      central = b.readUInt32LE(b.length - 6);
    b.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    expect(() => decodeQualificationManifestZip(b)).toThrow();
  });
  it('never turns a valid synthetic archive into pinned provenance', () => {
    expect(() => verifyQualificationManifest(zip())).toThrow('Qualification manifest held');
    expect(() => verifyQualificationManifest(Buffer.alloc(PIN.bytes))).toThrow(
      'Qualification manifest held',
    );
  });
});
