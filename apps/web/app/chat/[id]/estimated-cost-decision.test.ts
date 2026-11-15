import type {
  EstimatedCostDecision,
  EstimatedCostDecisionReceipt,
  EstimatedCostQuote,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import {
  clearCostDecisionAfterReceipt,
  costQuoteRefreshId,
  formatCostMicros,
  isReceiptForCostDecision,
  isReviewableCostQuote,
  readCostDecision,
  retainCostDecision,
} from './estimated-cost-decision';

const scope = { session: 'owner-session-a', operationId: 'request-a' };
const decision: EstimatedCostDecision = {
  operationId: scope.operationId,
  quoteId: 'quote-a',
  quoteVersion: 'revision-a',
  decisionId: 'decision-a',
  decision: 'approve',
};
const receipt: EstimatedCostDecisionReceipt = {
  operationId: scope.operationId,
  quoteId: decision.quoteId,
  decisionId: decision.decisionId,
  status: 'approved',
  allowanceMicros: 200_000,
  expiresAt: '2026-11-15T12:30:00Z',
};

function storage() {
  const rows = new Map<string, string>();
  return {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
    removeItem: (key: string) => {
      rows.delete(key);
    },
    rows,
  };
}

function quote(): EstimatedCostQuote {
  return {
    type: 'estimated-cost-approval',
    operationId: scope.operationId,
    taskId: 'task-a',
    requestText: 'Compare two weekend plans',
    quoteId: 'quote-a',
    quoteVersion: 'revision-a',
    expiresAt: '2026-11-15T12:10:00Z',
    nextAttemptMicros: 17_500,
    allowanceMicros: 200_000,
    recordedDailyMicros: 270_000,
    recordedMonthlyMicros: 2_710_000,
    totalHeldMicros: 5_760_000,
    eligibleHistoricalUnknownMicros: 5_760_000,
    pendingApprovalMicros: 200_000,
    dailyCeilingMicros: 6_000_000,
    monthlyCeilingMicros: 50_000_000,
    dailyProjectedGrossMicros: 6_230_000,
    monthlyProjectedGrossMicros: 8_670_000,
    complete: true,
    canApprove: true,
  };
}

describe('estimated-cost decision recovery', () => {
  it('retains the exact intent across a reload without changing or replaying it', () => {
    const journal = storage();
    retainCostDecision(journal, scope, decision);
    expect(readCostDecision(journal, scope)).toEqual(decision);
    expect(() =>
      retainCostDecision(journal, scope, { ...decision, decisionId: 'decision-b' }),
    ).toThrow('previous decision');
    expect(readCostDecision(journal, scope)).toEqual(decision);
  });

  it('partitions a parked request from another request and a different signed-in session', () => {
    const journal = storage();
    retainCostDecision(journal, scope, decision);
    expect(readCostDecision(journal, { ...scope, operationId: 'request-b' })).toBeNull();
    expect(readCostDecision(journal, { ...scope, session: 'owner-session-b' })).toBeNull();
  });

  it('keeps the unresolved intent when a different operation or device returns a receipt', () => {
    const journal = storage();
    retainCostDecision(journal, scope, decision);
    for (const other of [
      { ...receipt, decisionId: 'other-device' },
      { ...receipt, operationId: 'request-b' },
      { ...receipt, quoteId: 'requote-a' },
    ])
      expect(clearCostDecisionAfterReceipt(journal, scope, decision, other)).toBe(false);
    expect(readCostDecision(journal, scope)).toEqual(decision);
  });

  it('only clears after the same canonical decision outcome', () => {
    const journal = storage();
    retainCostDecision(journal, scope, decision);
    expect(clearCostDecisionAfterReceipt(journal, scope, decision, receipt)).toBe(true);
    expect(readCostDecision(journal, scope)).toBeNull();
  });

  it('does not mistake a denial or malformed amount for an approval receipt', () => {
    expect(isReceiptForCostDecision({ ...receipt, status: 'declined' }, decision)).toBe(false);
    expect(isReceiptForCostDecision({ ...receipt, allowanceMicros: Number.NaN }, decision)).toBe(
      false,
    );
    expect(isReceiptForCostDecision({ ...receipt, allowanceMicros: -1 }, decision)).toBe(false);
    expect(isReceiptForCostDecision({ ...receipt, expiresAt: 'invalid' }, decision)).toBe(false);
  });

  it('fails closed when recovery storage is corrupt or cannot retain the intent', () => {
    const journal = storage();
    retainCostDecision(journal, scope, decision);
    for (const key of journal.rows.keys()) journal.rows.set(key, '{invalid');
    expect(() => readCostDecision(journal, scope)).toThrow('could not be recovered');
    expect(() =>
      retainCostDecision(
        { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        scope,
        decision,
      ),
    ).toThrow('saved for recovery');
  });
});

describe('estimated-cost review values', () => {
  it('binds refresh retries to the same request and quote across reloads', async () => {
    const first = await costQuoteRefreshId(quote());
    expect(await costQuoteRefreshId(quote())).toBe(first);
    expect(await costQuoteRefreshId({ ...quote(), quoteId: 'next-quote' })).not.toBe(first);
    expect(await costQuoteRefreshId({ ...quote(), operationId: 'request-b' })).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('never rounds a small allowance to zero or hides a fractional decision amount', () => {
    expect(formatCostMicros(1)).toBe('$0.000001');
    expect(formatCostMicros(17_500)).toBe('$0.0175');
    expect(formatCostMicros(6_000_000)).toBe('$6.00');
    expect(formatCostMicros(5_759_522)).toBe('$5.759522');
    expect(() => formatCostMicros(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it('rejects expired, incomplete or malformed quotes before the UI offers a decision', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    expect(isReviewableCostQuote(quote(), now)).toBe(true);
    expect(isReviewableCostQuote({ ...quote(), complete: false }, now)).toBe(false);
    expect(
      isReviewableCostQuote({ ...quote(), allowanceMicros: Number.POSITIVE_INFINITY }, now),
    ).toBe(false);
    expect(isReviewableCostQuote({ ...quote(), expiresAt: '2026-11-15T11:59:00Z' }, now)).toBe(
      false,
    );
  });
});
