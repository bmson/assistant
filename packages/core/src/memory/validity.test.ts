import { describe, expect, it } from 'vitest';
import { isCurrentAt, statedPeriodEnd, validitySuffix } from './validity.js';

/**
 * The rule that decides whether a stored fact is allowed to speak for now.
 * Pure, so the partial-precision cases the graph actually stores can be
 * checked without a database.
 */

const now = new Date('2026-09-17T12:00:00Z');

describe('statedPeriodEnd', () => {
  it('reads a bare year as the whole of that year', () => {
    expect(statedPeriodEnd('2019')?.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('reads a year-month as the whole of that month', () => {
    expect(statedPeriodEnd('2019-03')?.toISOString()).toBe('2019-04-01T00:00:00.000Z');
  });

  it('rolls a December year-month into the next January', () => {
    expect(statedPeriodEnd('2019-12')?.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('reads a full date as through the end of that day', () => {
    expect(statedPeriodEnd('2019-03-15')?.toISOString()).toBe('2019-03-16T00:00:00.000Z');
  });

  it('rolls a month-end date into the next month', () => {
    expect(statedPeriodEnd('2019-03-31')?.toISOString()).toBe('2019-04-01T00:00:00.000Z');
  });

  it('passes a Date through, as memories store it', () => {
    const exact = new Date('2023-06-01T09:30:00Z');
    expect(statedPeriodEnd(exact)).toBe(exact);
  });

  it('has no end for an absent or empty value', () => {
    expect(statedPeriodEnd(null)).toBeNull();
    expect(statedPeriodEnd(undefined)).toBeNull();
    expect(statedPeriodEnd('   ')).toBeNull();
  });

  it('has no end for wording it cannot read', () => {
    expect(statedPeriodEnd('sometime in the spring')).toBeNull();
  });
});

describe('isCurrentAt', () => {
  it('treats an open-ended fact as current', () => {
    expect(isCurrentAt(null, now)).toBe(true);
  });

  it('treats a period that has passed as not current', () => {
    expect(isCurrentAt('2023', now)).toBe(false);
    expect(isCurrentAt(new Date('2023-06-01T00:00:00Z'), now)).toBe(false);
  });

  it('treats a period still running as current', () => {
    expect(isCurrentAt('2027', now)).toBe(true);
  });

  it('keeps a fact current through the last day of its stated year', () => {
    // The case the period-end rule exists for: on any day in 2026, a fact
    // stated as valid until "2026" is still true.
    expect(isCurrentAt('2026', now)).toBe(true);
  });

  it('keeps a fact current through the last day of its stated month', () => {
    expect(isCurrentAt('2026-09', now)).toBe(true);
    expect(isCurrentAt('2026-08', now)).toBe(false);
  });

  it('treats wording it cannot read as current', () => {
    // Failing the other way would retire a true fact on a guess.
    expect(isCurrentAt('last spring', now)).toBe(true);
  });
});

describe('validitySuffix', () => {
  const span = (from: string | null, until: string | null) =>
    validitySuffix(
      { validFrom: from ? new Date(from) : null, validUntil: until ? new Date(until) : null },
      now,
    );

  it('says nothing when nothing is known', () => {
    expect(span(null, null)).toBe('');
  });

  it('marks a lapsed fact as past', () => {
    expect(span('2019-01-01', '2023-06-01')).toBe(' (past: 2019-01-01–2023-06-01)');
  });

  it('marks a lapsed fact as past even with no start date', () => {
    // The shape that previously rendered no marking at all and read as current.
    expect(span(null, '2023-06-01')).toBe(' (past: until 2023-06-01)');
  });

  it('reads an open-ended current fact as ongoing', () => {
    expect(span('2024-03-01', null)).toBe(' (since 2024-03-01)');
  });

  it('keeps a known future end on a current fact', () => {
    expect(span('2024-03-01', '2027-01-01')).toBe(' (since 2024-03-01, until 2027-01-01)');
  });

  it('keeps a future end with no start', () => {
    expect(span(null, '2027-01-01')).toBe(' (until 2027-01-01)');
  });
});

describe('future validity', () => {
  it('does not present a future-starting fact as current', () => {
    const at = new Date('2026-10-07Z');
    const from = new Date('2099-01-01Z');
    expect(isCurrentAt(null, at, from)).toBe(false);
    expect(validitySuffix({ validFrom: from, validUntil: null }, at)).toBe(
      ' (future: from 2099-01-01)',
    );
  });
});
