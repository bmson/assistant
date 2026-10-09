import { createHash } from 'node:crypto';

/** Stable UUID-shaped IDs for Firestore rows exposed through UUID-only APIs. */
export function deterministicUuid(...parts: string[]): string {
  const bytes = createHash('sha256').update(parts.join('\0')).digest().subarray(0, 16);
  // UUIDv8 is appropriate here: the identifier uses a private SHA-256
  // namespace derivation rather than the UUIDv5 SHA-1 algorithm.
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
