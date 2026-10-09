import { describe, expect, it } from 'vitest';
import { parseGoalInput, parseGoalTargetDate } from './goal-input.js';

const input = (targetDate: unknown) => ({ title: 'Goal', targetDate });

describe('parseGoalInput target dates', () => {
  it('accepts leap days only in leap years and preserves date-only UTC midnight', () => {
    expect(parseGoalInput(input('2024-02-29'))).toMatchObject({
      targetDate: new Date('2024-02-29T00:00:00.000Z'),
    });
    expect(parseGoalInput(input('2000-02-29'))).toMatchObject({
      targetDate: new Date('2000-02-29T00:00:00.000Z'),
    });
  });

  it.each(['2023-02-29', '2024-02-30', '2024-04-31', '2024-00-01', '2024-13-01', '0999-12-31'])(
    'rejects nonexistent or out-of-range date %s',
    (date) => {
      expect(parseGoalInput(input(date))).toMatchObject({ error: 'Target date is not valid.' });
    },
  );

  it('keeps empty and null dates empty and rejects malformed strings', () => {
    expect(parseGoalInput(input(null))).toMatchObject({ targetDate: null });
    expect(parseGoalInput(input(''))).toMatchObject({ targetDate: null });
    expect(parseGoalInput(input('2024-2-03'))).toMatchObject({
      error: 'Target date must be YYYY-MM-DD.',
    });
  });
});

describe('goal form date-only parser shared by form and API entry points', () => {
  it.each(['2023-02-29', '2024-02-30', '2024-04-31', '0000-01-01', '0999-12-31'])(
    'rejects normalized or out-of-domain date %s',
    (date) => {
      expect(parseGoalTargetDate(date)).toMatchObject({ ok: false });
    },
  );

  it('keeps the date-only value at UTC midnight at both supported year bounds', () => {
    expect(parseGoalTargetDate('1000-01-01')).toEqual({
      ok: true,
      value: new Date('1000-01-01T00:00:00.000Z'),
    });
    expect(parseGoalTargetDate('9999-12-31')).toEqual({
      ok: true,
      value: new Date('9999-12-31T00:00:00.000Z'),
    });
  });
});
