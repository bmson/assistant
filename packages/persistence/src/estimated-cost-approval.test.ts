import { describe, expect, it } from 'vitest';
import {
  type EstimatedCostHeadroom,
  estimatedCostAllowance,
  estimatedCostAllowanceExpiry,
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
  it('limits an approved allowance to 30 minutes and the next UTC day', () => {
    expect(estimatedCostAllowanceExpiry(new Date('2026-11-15T12:00:00Z')).toISOString()).toBe(
      '2026-11-15T12:30:00.000Z',
    );
    expect(estimatedCostAllowanceExpiry(new Date('2026-11-30T23:50:00Z')).toISOString()).toBe(
      '2026-12-01T00:00:00.000Z',
    );
    expect(() => estimatedCostAllowanceExpiry(new Date('invalid'))).toThrow();
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
