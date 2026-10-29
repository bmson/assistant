import { describe, expect, it } from 'vitest';
import {
  compareExactTimestamps,
  ExactTimestamp,
  isValidExactTimestamp,
  offsetExactTimestamp,
  parseExactTimestamp,
} from './exact-timestamp.js';

describe('exact checkpoint timestamp', () => {
  it('preserves microseconds and nanoseconds through JSON recovery', () => {
    for (const exact of [
      '2024-02-29T00:00:00.000001Z',
      '2026-10-07T12:00:00.123456789Z',
      '1969-12-31T23:59:59.999999999Z',
    ]) {
      const parsed = parseExactTimestamp(JSON.parse(JSON.stringify({ exact })).exact);
      expect(parsed.exact).toBe(exact);
      expect(parsed.nanoseconds).toBe(Number(exact.split('.')[1]?.slice(0, -1).padEnd(9, '0')));
      expect(Number.isInteger(parsed.seconds)).toBe(true);
    }
  });
  it('orders exact instants and offsets across the epoch without rounding', () => {
    const beforeEpoch = new ExactTimestamp(-1n, 999_999_999);
    expect(compareExactTimestamps(beforeEpoch, new Date(0))).toBe(-1);
    const shifted = offsetExactTimestamp(beforeEpoch, 1);
    expect(shifted.seconds).toBe(0n);
    expect(shifted.nanoseconds).toBe(999_999);
    expect(compareExactTimestamps(shifted, new ExactTimestamp(0n, 999_999))).toBe(0);
    expect(
      compareExactTimestamps(
        new ExactTimestamp(0n, 123_456_000),
        new ExactTimestamp(0n, 123_457_000),
      ),
    ).toBe(-1);
    const mutated = new ExactTimestamp(0n, 123_456_000);
    mutated.setTime(124);
    expect(isValidExactTimestamp(mutated)).toBe(false);
  });
  it('seals exact metadata against same-millisecond mutation while allowing subclass fields', () => {
    class StorageTimestamp extends ExactTimestamp {
      readonly storageText = '2026-10-20T12:00:00.123456Z';
    }
    const value = new StorageTimestamp(1_792_497_600n, 123_456_000);
    expect(Reflect.set(value, 'nanoseconds', 123_999_999)).toBe(false);
    expect(Reflect.set(value, 'seconds', value.seconds + 1n)).toBe(false);
    expect(() => Object.defineProperty(value, 'nanoseconds', { value: 123_999_999 })).toThrow();
    expect(value.nanoseconds).toBe(123_456_000);
    expect(isValidExactTimestamp(value)).toBe(true);
    expect(compareExactTimestamps(value, new ExactTimestamp(value.seconds, 123_457_000))).toBe(-1);
    expect(value.storageText).toBe('2026-10-20T12:00:00.123456Z');
    value.setTime(value.getTime() + 1);
    expect(isValidExactTimestamp(value)).toBe(false);
  });
  it('rejects normalized impossible dates, excessive precision, offsets and malformed clocks', () => {
    for (const value of [
      '2026-02-29T12:00:00.123456Z',
      '2024-02-30T12:00:00.123Z',
      '2026-10-07T24:00:00.000Z',
      '2026-10-07T12:00:00.1234567890Z',
      '2026-10-07T12:00:00.123+00:00',
      '2026-10-07T12:00:60.123Z',
    ])
      expect(() => parseExactTimestamp(value)).toThrow();
  });
});
