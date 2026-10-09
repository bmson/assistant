import { describe, expect, it } from 'vitest';
import { formatDateInputValue } from './card-form-value-caption.js';

describe('formatDateInputValue', () => {
  it('formats the selected ISO civil date using the browser locale without shifting the day', () => {
    expect(formatDateInputValue('2026-10-12', 'en-US')).toBe('10/12/2026');
    expect(formatDateInputValue('2026-10-12', 'en-GB')).toBe('12/10/2026');
  });

  it.each(['', '2026-02-30', '2026/10/12', '2026-1-2', '0000-01-01', '10000-01-01'])(
    'does not invent a display date for invalid value %s',
    (value) => {
      expect(formatDateInputValue(value, 'en-US')).toBeNull();
    },
  );

  it('preserves valid early years instead of applying JavaScript Date.UTC 1900 remapping', () => {
    expect(formatDateInputValue('0001-01-02', 'en-US')).not.toBeNull();
    expect(formatDateInputValue('0099-12-31', 'en-US')).not.toBeNull();
  });

  it('accepts leap day only in leap years', () => {
    expect(formatDateInputValue('2000-02-29', 'en-US')).not.toBeNull();
    expect(formatDateInputValue('1900-02-29', 'en-US')).toBeNull();
  });
});
