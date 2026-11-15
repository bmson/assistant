import type {
  EstimatedCostApprovalRepository,
  EstimatedCostPreparedQuote,
  EstimatedCostQuotePreparer,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import {
  createEstimatedCostApprovalService,
  createUnavailableEstimatedCostApprovalService,
} from './estimated-cost-approval.js';

const actor = { installationId: 'installation-a', ownerId: 'owner-a' };
const request = { operationId: 'operation-a', quoteRequestId: 'refresh-a' };
const decision = {
  operationId: 'operation-a',
  quoteId: 'quote-a',
  quoteVersion: 'v1',
  decisionId: 'decision-a',
  decision: 'approve' as const,
};
function prepared(): EstimatedCostPreparedQuote {
  return {
    actor,
    quoteRequestId: request.quoteRequestId,
    taskId: 'task-a',
    leaseToken: null,
    requestFingerprint: 'fingerprint',
    bindingDigest: 'binding',
    critical: true,
    baseline: [{ reservationId: 'historical-a', estimatedMicros: 5_760_000 }],
    quote: {
      type: 'estimated-cost-approval',
      operationId: request.operationId,
      taskId: 'task-a',
      requestText: 'Synthetic original request',
      quoteId: 'quote-a',
      quoteVersion: 'v1',
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
    },
  };
}
function setup() {
  const notFound = { ok: false as const, outcome: 'not_found' as const, message: 'Not found' };
  const repository: EstimatedCostApprovalRepository = {
    getQuote: vi.fn(async () => notFound),
    storePreparedQuote: vi.fn(async () => notFound),
    decide: vi.fn(async () => notFound),
    getDecisionReceipt: vi.fn(async () => notFound),
  };
  const preparer: EstimatedCostQuotePreparer = {
    prepare: vi.fn<EstimatedCostQuotePreparer['prepare']>(async () => ({
      ok: true,
      prepared: prepared(),
    })),
  };
  return { repository, preparer };
}

describe('estimated cost application orchestration', () => {
  it('defaults OFF without preparing or storing a quote or approving an allowance', async () => {
    const deps = setup();
    const service = createEstimatedCostApprovalService(deps);
    expect(await service.requestQuote(actor, request)).toMatchObject({
      ok: false,
      outcome: 'unavailable',
    });
    expect(await service.decide(actor, decision)).toMatchObject({
      ok: false,
      outcome: 'unavailable',
      decisionId: decision.decisionId,
    });
    expect(deps.preparer.prepare).not.toHaveBeenCalled();
    expect(deps.repository.storePreparedQuote).not.toHaveBeenCalled();
    expect(deps.repository.decide).not.toHaveBeenCalled();
  });
  it('keeps canonical readback, exact receipt recovery and decline available in compatible OFF mode', async () => {
    const deps = setup();
    const service = createEstimatedCostApprovalService(deps);
    await service.getQuote(actor, request.operationId);
    await service.getDecisionReceipt(actor, {
      operationId: decision.operationId,
      decisionId: decision.decisionId,
    });
    await service.decide(actor, { ...decision, decision: 'decline' });
    expect(deps.repository.getQuote).toHaveBeenCalledWith(actor, request.operationId);
    expect(deps.repository.getDecisionReceipt).toHaveBeenCalledWith(actor, {
      operationId: decision.operationId,
      decisionId: decision.decisionId,
    });
    expect(deps.repository.decide).toHaveBeenCalledWith(actor, {
      ...decision,
      decision: 'decline',
    });
    expect(deps.preparer.prepare).not.toHaveBeenCalled();
    expect(deps.repository.storePreparedQuote).not.toHaveBeenCalled();
  });
  it('passes only the trusted prepared candidate to the authoritative transaction', async () => {
    const deps = setup();
    const service = createEstimatedCostApprovalService({ ...deps, enabled: () => true });
    await service.requestQuote(actor, request);
    expect(deps.preparer.prepare).toHaveBeenCalledWith(actor, request);
    expect(deps.repository.storePreparedQuote).toHaveBeenCalledWith(prepared());
    expect(deps.repository.decide).not.toHaveBeenCalled();
  });
  it('rejects a mismatched owner, installation, original request, task, or quote-refresh intent before storage', async () => {
    const valid = prepared();
    const invalid = [
      { ...valid, actor: { ...actor, ownerId: 'other' } },
      { ...valid, actor: { ...actor, installationId: 'other' } },
      { ...valid, quoteRequestId: 'other' },
      { ...valid, taskId: 'other' },
      { ...valid, quote: { ...valid.quote, operationId: 'other' } },
      { ...valid, quote: { ...valid.quote, allowanceMicros: Number.MAX_SAFE_INTEGER + 1 } },
      { ...valid, baseline: [...valid.baseline, ...valid.baseline] },
    ];
    for (const candidate of invalid) {
      const deps = setup();
      vi.mocked(deps.preparer.prepare).mockResolvedValue({ ok: true, prepared: candidate });
      const result = await createEstimatedCostApprovalService({
        ...deps,
        enabled: () => true,
      }).requestQuote(actor, request);
      expect(result).toMatchObject({ ok: false, outcome: 'unavailable' });
      expect(deps.repository.storePreparedQuote).not.toHaveBeenCalled();
    }
  });
  it('honors a capability revoked while preparation was in flight', async () => {
    const deps = setup();
    let enabled = true;
    vi.mocked(deps.preparer.prepare).mockImplementation(async () => {
      enabled = false;
      return { ok: true, prepared: prepared() };
    });
    expect(
      await createEstimatedCostApprovalService({ ...deps, enabled: () => enabled }).requestQuote(
        actor,
        request,
      ),
    ).toMatchObject({ ok: false, outcome: 'unavailable' });
    expect(deps.repository.storePreparedQuote).not.toHaveBeenCalled();
  });
  it('does not make a new decision or reprepare after an uncertain commit response', async () => {
    const deps = setup();
    vi.mocked(deps.repository.decide).mockRejectedValue(new Error('Committed response lost'));
    const service = createEstimatedCostApprovalService({ ...deps, enabled: () => true });
    expect(await service.decide(actor, decision)).toEqual(
      expect.objectContaining({
        ok: false,
        outcome: 'unconfirmed',
        operationId: decision.operationId,
        decisionId: decision.decisionId,
      }),
    );
    await service.getDecisionReceipt(actor, {
      operationId: decision.operationId,
      decisionId: decision.decisionId,
    });
    expect(deps.repository.decide).toHaveBeenCalledTimes(1);
    expect(deps.preparer.prepare).not.toHaveBeenCalled();
  });
  it('passes the exact explicit choice and lets the transaction own stale or conflicting decisions', async () => {
    const deps = setup();
    const result = {
      ok: true as const,
      receipt: {
        operationId: decision.operationId,
        decisionId: decision.decisionId,
        quoteId: decision.quoteId,
        status: 'stale' as const,
      },
    };
    vi.mocked(deps.repository.decide).mockResolvedValue(result);
    expect(
      await createEstimatedCostApprovalService({ ...deps, enabled: () => true }).decide(
        actor,
        decision,
      ),
    ).toEqual(result);
    expect(deps.repository.decide).toHaveBeenCalledWith(actor, decision);
  });
  it('rejects malformed request identities without calling preparation or persistence', async () => {
    const deps = setup();
    const service = createEstimatedCostApprovalService({ ...deps, enabled: () => true });
    expect(await service.requestQuote(actor, { ...request, quoteRequestId: '' })).toMatchObject({
      outcome: 'invalid',
    });
    expect(await service.decide(actor, { ...decision, decisionId: '' })).toMatchObject({
      outcome: 'invalid',
    });
    expect(await service.getQuote({ ...actor, ownerId: '' }, request.operationId)).toMatchObject({
      outcome: 'invalid',
    });
    expect(deps.preparer.prepare).not.toHaveBeenCalled();
    expect(deps.repository.decide).not.toHaveBeenCalled();
    expect(deps.repository.getQuote).not.toHaveBeenCalled();
  });
});

it('fails closed for quotes, decisions, and decision readback', async () => {
  const service = createUnavailableEstimatedCostApprovalService();
  const actor = { ownerId: 'owner', installationId: 'installation' };
  const identity = { operationId: 'operation', decisionId: 'decision' };
  const outcomes = await Promise.all([
    service.getQuote(actor, identity.operationId),
    service.requestQuote(actor, {
      operationId: identity.operationId,
      quoteRequestId: 'quote-request',
    }),
    service.decide(actor, {
      ...identity,
      quoteId: 'quote',
      quoteVersion: '1',
      decision: 'approve',
    }),
    service.getDecisionReceipt(actor, identity),
  ]);
  expect(outcomes).toHaveLength(4);
  for (const outcome of outcomes)
    expect(outcome).toMatchObject({ ok: false, outcome: 'unavailable' });
});
