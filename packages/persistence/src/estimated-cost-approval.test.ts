import { describe, expect, it } from 'vitest';
import {
  type EstimatedCostHeadroom,
  estimatedCostAllowance,
  estimatedCostAllowanceExpiry,
  verifiedHistoricalUnknownMicros,
} from './estimated-cost-approval.js';

const snapshot: EstimatedCostHeadroom = {
  dailySpentMicros: 200,
  monthlySpentMicros: 500,
  heldMicros: 700,
  historicalUnknownMicros: 600,
  dailyCeilingMicros: 1000,
  monthlyCeilingMicros: 2000,
  taskSpentMicros: 100,
  taskHeldMicros: 50,
  taskCeilingMicros: 600,
  nextAttemptMicros: 300,
};

describe('estimated cost allowance', () => {
  it('accepts only the exact complete, proven historical unknown baseline', () => {
    const row = { reservationId: 'old', estimatedMicros: 10 };
    const baseline = [row];
    const canonical = {
      ...row,
      status: 'unknown',
      provenance: 'proven-historical-unapproved' as const,
    };
    const current = [canonical];
    expect(verifiedHistoricalUnknownMicros(baseline, current, true)).toBe(10);
    expect(() => verifiedHistoricalUnknownMicros(baseline, current, false)).toThrow();
    expect(() => verifiedHistoricalUnknownMicros(baseline, [], true)).toThrow();
    expect(() =>
      verifiedHistoricalUnknownMicros(
        baseline,
        [{ ...canonical, provenance: 'grant-linked' }],
        true,
      ),
    ).toThrow();
    expect(() =>
      verifiedHistoricalUnknownMicros(baseline, [{ ...canonical, estimatedMicros: 11 }], true),
    ).toThrow();
    expect(() =>
      verifiedHistoricalUnknownMicros(baseline, [{ ...canonical, status: 'reconciled' }], true),
    ).toThrow();
  });
  it('limits an approved allowance to 30 minutes and the next UTC day', () => {
    expect(estimatedCostAllowanceExpiry(new Date('2026-11-15T12:00:00Z')).toISOString()).toBe(
      '2026-11-15T12:30:00.000Z',
    );
    expect(estimatedCostAllowanceExpiry(new Date('2026-11-30T23:50:00Z')).toISOString()).toBe(
      '2026-12-01T00:00:00.000Z',
    );
    expect(() => estimatedCostAllowanceExpiry(new Date('invalid'))).toThrow();
  });
  it('does not reuse baseline credit after settlement or removal', () => {
    const baseline = [{ reservationId: 'historical', estimatedMicros: 600 }];
    const original = {
      ...baseline[0],
      reservationId: 'historical',
      estimatedMicros: 600,
      status: 'unknown',
      provenance: 'proven-historical-unapproved' as const,
    };
    expect(
      estimatedCostAllowance({
        ...snapshot,
        historicalUnknownMicros: verifiedHistoricalUnknownMicros(baseline, [original], true),
      }).canApprove,
    ).toBe(true);
    expect(() =>
      verifiedHistoricalUnknownMicros(baseline, [{ ...original, status: 'reconciled' }], true),
    ).toThrow();
    expect(() => verifiedHistoricalUnknownMicros(baseline, [], true)).toThrow();
    expect(() =>
      estimatedCostAllowance({ ...snapshot, heldMicros: 100, historicalUnknownMicros: 600 }),
    ).toThrow();
    expect(
      estimatedCostAllowance({
        ...snapshot,
        heldMicros: 100,
        historicalUnknownMicros: 0,
        dailySpentMicros: 800,
      }).canApprove,
    ).toBe(false);
  });
  it('excludes only proven historical pressure from global headroom and protects the task cap', () => {
    expect(estimatedCostAllowance(snapshot)).toEqual({ allowanceMicros: 450, canApprove: true });
    expect(estimatedCostAllowance({ ...snapshot, historicalUnknownMicros: 0 })).toEqual({
      allowanceMicros: 100,
      canApprove: false,
    });
    expect(estimatedCostAllowance({ ...snapshot, taskHeldMicros: 400 })).toEqual({
      allowanceMicros: 100,
      canApprove: false,
    });
  });

  it('rejects inconsistent or unrepresentable amounts', () => {
    for (const change of [
      { historicalUnknownMicros: 701 },
      { nextAttemptMicros: 0 },
      { heldMicros: Number.NaN },
      { taskSpentMicros: -1 },
      { monthlyCeilingMicros: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(() => estimatedCostAllowance({ ...snapshot, ...change })).toThrow();
  });

  it('returns no headroom when recorded spend exceeds a ceiling', () => {
    expect(estimatedCostAllowance({ ...snapshot, dailySpentMicros: 1001 })).toEqual({
      allowanceMicros: 0,
      canApprove: false,
    });
  });
});
