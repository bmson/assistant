import { describe, expect, it } from 'vitest';
import { parseExactTimestamp } from './exact-timestamp.js';

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
