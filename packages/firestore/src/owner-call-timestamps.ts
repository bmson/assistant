import { ExactTimestamp, isValidExactTimestamp } from '@assistant/persistence';
import { Timestamp } from '@google-cloud/firestore';
import { decodeRecord, encodeRecord } from './store.js';

// Restricted to owner-call receipt/usage records; generic store decoding stays unchanged.
function mapTimestamps(value: unknown, encode: boolean): unknown {
  if (encode && value instanceof ExactTimestamp) {
    if (!isValidExactTimestamp(value)) throw new Error('Invalid owner-call timestamp');
    return new Timestamp(Number(value.seconds), value.nanoseconds);
  }
  if (!encode && value instanceof Timestamp)
    return new ExactTimestamp(BigInt(value.seconds), value.nanoseconds);
  if (Array.isArray(value)) return value.map((field) => mapTimestamps(field, encode));
  if (
    value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, mapTimestamps(field, encode)]),
    );
  return value;
}

export function decodeOwnerCallRecord<T>(value: unknown): T {
  return decodeRecord<T>(mapTimestamps(value, false));
}

export function encodeOwnerCallRecord(value: object): Record<string, unknown> {
  return encodeRecord(mapTimestamps(value, true) as Record<string, unknown>);
}
