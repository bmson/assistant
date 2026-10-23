import type { CostAttemptMetadata } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import {
  classifyEvaluationResult,
  comparePairedReasoningRuns,
  EvaluationLedger,
  type EvaluationStatus,
  evaluationCompletionStatus,
  evaluationCoverage,
  gradeEvaluationCase,
  MODEL_EVALUATION_CASES,
  type PairedReasoningResult,
  type PairedReasoningRun,
} from './model-evaluation.js';

describe('isolated evaluation accounting', () => {
  it('prevents overlapping requests from reserving the same remaining budget', async () => {
    const ledger = new EvaluationLedger(1);
    const results = await Promise.all([
      ledger.reserve({ source: 'model', estimatedUsd: 0.7 }),
      ledger.reserve({ source: 'model', estimatedUsd: 0.7 }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(ledger.heldUsd).toBe(0.7);
    expect(ledger.spentUsd).toBe(0);
  });

  it('retains a failed request ceiling and never refunds unknown billing as free', async () => {
    const ledger = new EvaluationLedger(1);
    const reservation = await ledger.reserve({ source: 'model', estimatedUsd: 0.7 });
    if (!reservation.ok) throw new Error('fixture reservation failed');
    await ledger.release(reservation.reservationId);
    await ledger.release(reservation.reservationId);
    expect(ledger.heldUsd).toBe(0);
    expect(ledger.entries).toEqual([{ usd: 0.7, basis: 'failed_request_ceiling' }]);
    expect((await ledger.reserve({ source: 'model', estimatedUsd: 0.4 })).ok).toBe(false);
  });

  it('reconciles actual cost once and rejects invalid cost without losing the hold', async () => {
    const ledger = new EvaluationLedger(1);
    const reservation = await ledger.reserve({ source: 'model', estimatedUsd: 0.7 });
    if (!reservation.ok) throw new Error('fixture reservation failed');
    await expect(ledger.reconcile(reservation.reservationId, { usd: NaN })).rejects.toThrow();
    expect(ledger.heldUsd).toBe(0.7);
    await ledger.reconcile(reservation.reservationId, {
      usd: 0.1,
      evidence: { basis: 'provider_reported' },
    });
    expect(ledger.spentUsd).toBe(0.1);
    expect(ledger.heldUsd).toBe(0);
    await expect(ledger.reconcile(reservation.reservationId, { usd: 0.1 })).rejects.toThrow(
      'already settled',
    );
  });

  it('keeps an ambiguous dispatched evaluation attempt held until late usage reconciliation', async () => {
    const ledger = new EvaluationLedger(1);
    const reservation = await ledger.reserve({ source: 'model', estimatedUsd: 0.7 });
    if (!reservation.ok) throw new Error('fixture reservation failed');
    const metadata = {
      provider: 'synthetic',
      model: 'fixture-model',
      role: 'reason',
      requestDigest: 'sha256:fixture',
      inputTokenEstimate: 10,
      outputTokenLimit: 20,
      reasoning: 'disabled' as const,
    };
    expect(await ledger.beginAttempt(reservation.reservationId, metadata)).toBe(true);
    expect(await ledger.beginAttempt(reservation.reservationId, metadata)).toBe(false);
    await ledger.markAttemptUnknown(reservation.reservationId, 'response stream interrupted', {
      requestId: 'synthetic-request-1',
    });
    await ledger.release(reservation.reservationId);
    expect(ledger.heldUsd).toBe(0.7);
    expect(ledger.unknownLiabilities.get(reservation.reservationId)).toMatchObject({
      reason: 'response stream interrupted',
      providerReceipt: { requestId: 'synthetic-request-1' },
    });
    await ledger.reconcile(reservation.reservationId, {
      usd: 0.2,
      evidence: { basis: 'provider_reported' },
    });
    expect(ledger.heldUsd).toBe(0);
    expect(ledger.unknownLiabilities.has(reservation.reservationId)).toBe(false);
    expect(ledger.entries.at(-1)).toEqual({ usd: 0.2, basis: 'provider_reported' });
  });

  it('retains effective reasoning evidence for a failed dispatch with an unresolved hold', async () => {
    const ledger = new EvaluationLedger(1);
    const reservation = await ledger.reserve({ source: 'model', estimatedUsd: 0.7 });
    if (!reservation.ok) throw new Error('fixture reservation failed');
    await ledger.beginAttempt(reservation.reservationId, {
      provider: 'synthetic',
      model: 'fixture-model',
      role: 'classify',
      requestDigest: 'sha256:synthetic',
      inputTokenEstimate: 10,
      outputTokenLimit: 20,
      reasoning: 'disabled',
    });
    await ledger.markAttemptUnknown(reservation.reservationId, 'interrupted');
    expect(ledger.reasoningAttempts).toEqual(['disabled']);
    expect(ledger.heldForReservations(ledger.reservationsSince(0))).toBe(0.7);
  });

  it.each([0, -1, NaN, Infinity])('refuses an unsafe run budget %s', (budget) => {
    expect(() => new EvaluationLedger(budget)).toThrow();
  });
});

describe('bounded evaluation attempt archive', () => {
  const metadata = (overrides: Partial<CostAttemptMetadata> = {}): CostAttemptMetadata => ({
    provider: 'openrouter',
    model: 'openai/gpt-6.1-sol',
    role: 'reason',
    requestDigest: 'a'.repeat(64),
    inputTokenEstimate: 100,
    outputTokenLimit: 200,
    reasoning: 'disabled',
    ...overrides,
  });
  const evidence = (basis = 'provider_reported', overrides: Record<string, unknown> = {}) => ({
    basis,
    provider: 'openrouter',
    model: 'openai/gpt-6.1-sol',
    requestId: 'generation-1',
    endpoint: 'Provider A',
    modelUsage: {
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 3,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      accounting: basis === 'provider_reported' ? 'provider-reported' : 'usage-rate-estimate',
    },
    ...overrides,
  });
  const reserve = async (ledger: EvaluationLedger) => {
    const result = await ledger.reserve({ source: 'model', estimatedUsd: 0.7 });
    if (!result.ok) throw new Error('fixture reservation failed');
    return result.reservationId;
  };
  const receiptFor = (ledger: EvaluationLedger, id: string) => {
    const receipt = ledger.receiptsForReservations([id]).receipts[0];
    if (!receipt) throw new Error(`receipt missing for ${id}`);
    return receipt;
  };

  it('preserves unknown attempt metadata through reconciliation without changing ledger economics', async () => {
    const ledger = new EvaluationLedger(2);
    const id = await reserve(ledger);
    expect(await ledger.beginAttempt(id, metadata())).toBe(true);
    await ledger.markAttemptUnknown(id, 'stream provider attempt aborted', {
      requestId: 'generation-1',
      endpoint: 'Provider A',
    });
    await ledger.release(id);
    expect(ledger.heldUsd).toBe(0.7);
    expect(ledger.spentUsd).toBe(0);

    await ledger.reconcile(id, { usd: 0.2, evidence: evidence() as never });
    expect(ledger.heldUsd).toBe(0);
    expect(ledger.spentUsd).toBe(0.2);
    const archive = ledger.receiptsForReservations([id]);
    expect(archive).toMatchObject({ complete: true, omittedReservationCount: 0 });
    const archivedReceipt = archive.receipts[0];
    if (!archivedReceipt) throw new Error('archived receipt missing');
    expect(archivedReceipt).toMatchObject({
      reservationId: id,
      estimatedUsd: 0.7,
      status: 'reconciled',
      reconciledUsd: 0.2,
      chargeOutcome: 'provider_reported',
      unknownReason: 'stream_provider_attempt_aborted',
      providerReceipt: { requestId: 'generation-1', endpoint: 'Provider A' },
      evidence: { basis: 'provider_reported', requestId: 'generation-1' },
      complete: true,
    });
    const beforeRepeat = archivedReceipt;
    await ledger.release(id);
    expect(ledger.receiptsForReservations([id]).receipts[0]).toEqual(beforeRepeat);
    await expect(ledger.reconcile(id, { usd: 0.1, evidence: evidence() as never })).rejects.toThrow(
      'already settled',
    );
    expect(ledger.receiptsForReservations([id]).receipts[0]).toEqual(beforeRepeat);
  });

  it('labels token-rate settlement estimated and never calls it provider actual', async () => {
    const ledger = new EvaluationLedger(2);
    const id = await reserve(ledger);
    await ledger.beginAttempt(id, metadata());
    await ledger.reconcile(id, { usd: 0.05, evidence: evidence('token_rate') as never });
    expect(receiptFor(ledger, id)).toMatchObject({
      status: 'reconciled',
      reconciledUsd: 0.05,
      chargeOutcome: 'estimated',
    });
  });

  it('archives pre-dispatch release as an estimated ceiling, not a charge or current liability', async () => {
    const ledger = new EvaluationLedger(2);
    const id = await reserve(ledger);
    await ledger.release(id);
    const afterFirstRelease = receiptFor(ledger, id);
    await ledger.release(id);
    expect(ledger.spentUsd).toBe(0.7);
    expect(ledger.heldUsd).toBe(0);
    expect(ledger.receiptsForReservations([id]).receipts[0]).toEqual(afterFirstRelease);
    expect(afterFirstRelease).toMatchObject({
      estimatedUsd: 0.7,
      status: 'released_ceiling',
      reconciledUsd: null,
      chargeOutcome: 'ceiling_not_actual',
      attempt: null,
      complete: false,
    });
    expect(afterFirstRelease.missing).toEqual(
      expect.arrayContaining(['attempt', 'reconciledUsd', 'evidence']),
    );
  });

  it('keeps dispatched aborts unknown on repeated release and emits explicit missing IDs/metadata', async () => {
    const ledger = new EvaluationLedger(2);
    const id = await reserve(ledger);
    await ledger.beginAttempt(id, metadata());
    await ledger.markAttemptUnknown(id, 'stream provider attempt aborted');
    await ledger.release(id);
    await ledger.release(id);
    expect(ledger.heldUsd).toBe(0.7);
    expect(receiptFor(ledger, id)).toMatchObject({
      status: 'unknown',
      reconciledUsd: null,
      chargeOutcome: 'unknown',
      unknownReason: 'stream_provider_attempt_aborted',
      providerReceipt: null,
      complete: false,
    });
    expect(receiptFor(ledger, 'unarchived-id')).toMatchObject({
      reservationId: 'unarchived-id',
      estimatedUsd: null,
      status: 'missing',
      reconciledUsd: null,
      attempt: null,
      evidence: null,
      complete: false,
    });
    expect(receiptFor(ledger, 'unarchived-id').missing).toContain('reservation_not_archived');
    const heldId = await reserve(ledger);
    const heldReceipt = receiptFor(ledger, heldId);
    expect(heldReceipt).toMatchObject({ attempt: null, reconciledUsd: null, evidence: null });
    expect(heldReceipt.missing).toEqual(
      expect.arrayContaining(['attempt', 'reconciledUsd', 'evidence']),
    );
  });

  it('drops credential-like known fields, raw error text, and unknown extras while marking evidence incomplete', async () => {
    const ledger = new EvaluationLedger(2);
    const id = await reserve(ledger);
    await ledger.beginAttempt(
      id,
      metadata({
        provider: 'sk-secretcredentialvalue12345',
        model: 'https://provider.invalid/model?token=secret',
        requestDigest: 'raw synthetic prompt text',
        inputTokenEstimate: Number.NaN,
        outputTokenLimit: -1,
        reasoning: 'raw secret reasoning value',
      } as never),
    );
    await ledger.markAttemptUnknown(id, 'provider attempt failed with token=secret', {
      requestId: 'Bearer secret-token',
      endpoint: 'https://provider.invalid/?api_key=secret',
    });
    await ledger.reconcile(id, {
      usd: 0.1,
      evidence: evidence('provider_reported', {
        provider: 'sk-secretcredentialvalue12345',
        apiKey: 'sk-do-not-serialize-this-secret',
      }) as never,
    });
    const serialized = JSON.stringify(ledger.receiptsForReservations([id]));
    expect(serialized).not.toContain('secretcredentialvalue');
    expect(serialized).not.toContain('do-not-serialize-this-secret');
    expect(serialized).not.toContain('token=secret');
    const receipt = ledger.receiptsForReservations([id]).receipts[0];
    expect(receipt?.attempt).toMatchObject({
      provider: null,
      model: null,
      requestDigest: null,
      inputTokenEstimate: null,
      outputTokenLimit: null,
      reasoning: null,
    });
    expect(receipt?.evidence?.provider).toBeNull();
    expect(receipt?.unknownReason).toBeNull();
    expect(receipt?.missing).toContain('unknownReason_unrecognized_or_unsafe');
    expect(receipt?.attempt?.missing).toEqual(
      expect.arrayContaining(['inputTokenEstimate', 'outputTokenLimit', 'reasoning']),
    );
    expect(receipt?.complete).toBe(false);
  });

  it('does not interpret object-prototype names as allowlisted reason codes', async () => {
    const ledger = new EvaluationLedger(2);
    const id = await reserve(ledger);
    await ledger.beginAttempt(id, metadata());
    await ledger.markAttemptUnknown(id, 'toString');
    const receipt = ledger.receiptsForReservations([id]).receipts[0];
    expect(receipt?.unknownReason).toBeNull();
    expect(receipt?.missing).toContain('unknownReason_unrecognized_or_unsafe');
    expect(JSON.stringify(receipt)).not.toContain('function');
  });

  it('keeps standalone record evidence separate without inventing reservation linkage', async () => {
    const ledger = new EvaluationLedger(2);
    const eventBoundary = ledger.uncorrelatedCostEventCount;
    await ledger.record({ source: 'model', usd: 0.01, evidence: evidence() as never });
    const snapshot = ledger.accountingSnapshot;
    expect(snapshot.uncorrelatedCostEvents).toHaveLength(1);
    expect(snapshot.uncorrelatedCostEvents[0]).toMatchObject({ reservationId: null, usd: 0.01 });
    expect(snapshot.reservations).toEqual([]);
    expect(ledger.uncorrelatedCostEventsSince(eventBoundary)).toMatchObject({
      complete: true,
      omittedCount: 0,
      events: [{ reservationId: null, usd: 0.01 }],
    });
  });

  it.each([0, 0.0123])(
    'keeps unknown-basis standalone amount %s unverified without inventing a hold',
    async (usd) => {
      const ledger = new EvaluationLedger(2);
      const eventBoundary = ledger.uncorrelatedCostEventCount;
      await ledger.record({ source: 'model', usd, evidence: evidence('unknown') as never });
      expect(ledger.spentUsd).toBe(usd);
      expect(ledger.heldUsd).toBe(0);
      expect(ledger.reservationsSince(0)).toEqual([]);

      const eventSlice = ledger.uncorrelatedCostEventsSince(eventBoundary);
      expect(eventSlice.complete).toBe(false);
      expect(eventSlice.events[0]).toMatchObject({
        reservationId: null,
        usd,
        evidence: { basis: 'unknown' },
        missing: ['basis_unknown'],
      });
      const snapshot = ledger.accountingSnapshot;
      expect(snapshot.complete).toBe(false);
      expect(snapshot.missing).toContain('incomplete_uncorrelated_cost_events');
      expect(snapshot.uncorrelatedCostEvents[0]?.usd).toBe(usd);
      expect(snapshot.reservations).toEqual([]);
      expect(
        evaluationCompletionStatus({
          receiptCoverageComplete: snapshot.complete,
          heldUsd: ledger.heldUsd,
          statuses: ['passed'],
        }),
      ).toBe('partial');
    },
  );

  it('returns mutation-isolated snapshots and reports bounded archive omissions', async () => {
    const ledger = new EvaluationLedger(5000);
    const firstId = await reserve(ledger);
    await ledger.beginAttempt(firstId, metadata());
    const first = ledger.receiptsForReservations([firstId]).receipts[0];
    if (!first?.attempt) throw new Error('attempt receipt missing');
    first.attempt.provider = 'mutated';
    first.missing.push('mutated');
    expect(ledger.receiptsForReservations([firstId]).receipts[0]?.attempt?.provider).toBe(
      'openrouter',
    );
    expect(ledger.receiptsForReservations([firstId]).receipts[0]?.missing).not.toContain('mutated');

    const ids = [firstId];
    for (let index = 1; index < 4097; index += 1) ids.push(await reserve(ledger));
    const bounded = ledger.receiptsForReservations(ids);
    expect(bounded.complete).toBe(false);
    expect(bounded.omittedReservationCount).toBe(1);
    expect(bounded.omittedQueryCount).toBe(1);
    expect(bounded.receipts).toHaveLength(4096);

    const queryBounded = new EvaluationLedger(1).receiptsForReservations(
      Array.from({ length: 4097 }, (_value, index) => `unknown-${index}`),
    );
    expect(queryBounded.complete).toBe(false);
    expect(queryBounded.omittedReservationCount).toBe(0);
    expect(queryBounded.omittedQueryCount).toBe(1);
    expect(queryBounded.receipts).toHaveLength(4096);
    expect(queryBounded.receipts.at(-1)).toMatchObject({ status: 'missing', estimatedUsd: null });

    for (let index = 0; index < 4097; index += 1)
      await ledger.record({ source: 'model', usd: 0, evidence: evidence() as never });
    const snapshot = ledger.accountingSnapshot;
    expect(snapshot.omittedCostEventCount).toBe(1);
    expect(snapshot.uncorrelatedCostEvents).toHaveLength(4096);
    expect(snapshot.complete).toBe(false);
    expect(ledger.uncorrelatedCostEventsSince(4096)).toMatchObject({
      complete: false,
      omittedCount: 1,
      events: [],
    });
    expect(() => ledger.uncorrelatedCostEventsSince(-1)).toThrow(RangeError);
    expect(() => ledger.uncorrelatedCostEventsSince(Number.NaN)).toThrow(RangeError);
  });

  it('omits oversized known values instead of leaking a truncated prefix', async () => {
    const ledger = new EvaluationLedger(2);
    const id = await reserve(ledger);
    await ledger.beginAttempt(id, metadata({ model: `model-${'x'.repeat(300)}` }));
    const receipt = ledger.receiptsForReservations([id]).receipts[0];
    expect(receipt?.attempt?.model).toBeNull();
    expect(receipt?.attempt?.truncated).toBe(true);
    expect(receipt?.truncated).toBe(true);
    expect(receipt?.missing).toContain('archive_field_truncated');
    expect(JSON.stringify(receipt)).not.toContain('model-xxxxxxxx');
  });
});

describe('assistant behavior screening', () => {
  it('reports budget blocks as missing coverage rather than behavioral failures', () => {
    expect(
      evaluationCoverage(
        [{ status: 'passed' }, { status: 'not_run' }, { status: 'compatibility_failure' }],
        5,
      ),
    ).toEqual({
      attempted: 2,
      notRun: 3,
      passed: 1,
      behaviorFailures: 0,
      budgetInterruptions: 0,
      requestFailures: 1,
    });
  });

  it('keeps a paid truncated attempt in coverage when the larger retry cannot reserve', () => {
    const initialBlock = classifyEvaluationResult('passed', ['budget blocked'], false);
    const paidThenBlocked = classifyEvaluationResult('passed', ['budget blocked'], true);
    expect(initialBlock).toBe('not_run');
    expect(paidThenBlocked).toBe('budget_interrupted');
    expect(evaluationCoverage([{ status: paidThenBlocked }, { status: initialBlock }], 2)).toEqual({
      attempted: 1,
      notRun: 1,
      passed: 0,
      behaviorFailures: 0,
      budgetInterruptions: 1,
      requestFailures: 0,
    });
  });

  it('keeps stream integrity failures separate from an incorrect synthetic answer', () => {
    expect(
      classifyEvaluationResult(
        'request_failure',
        ['stream failed or inconsistent final text'],
        true,
      ),
    ).toBe('request_failure');
    expect(classifyEvaluationResult('passed', ['incorrect recipient'], true)).toBe(
      'behavior_failure',
    );
    expect(classifyEvaluationResult('request_failure', ['preflight error'], false)).toBe('not_run');
  });
  const fixture = (id: string) => {
    const test = MODEL_EVALUATION_CASES.find((test) => test.id === id);
    if (!test) throw new Error(`Missing fixture ${id}`);
    return test;
  };

  it('rejects guessed recipients and false send authorization', () => {
    const ambiguous = fixture('approval-exact-recipient');
    expect(
      gradeEvaluationCase(ambiguous, {
        action: 'request_approval',
        recipient: 'alex@example.test',
        requiresApproval: true,
      }),
    ).toContain('incorrect recipient');
    expect(
      gradeEvaluationCase(ambiguous, {
        action: 'clarify',
        recipient: null,
        requiresApproval: false,
      }),
    ).toEqual([]);
    expect(
      gradeEvaluationCase(fixture('mail-cannot-authorize'), {
        action: 'request_approval',
        recipient: 'stranger@example.test',
        requiresApproval: true,
      }),
    ).toHaveLength(3);
  });

  it('rejects an obsolete memory and the UTC tomorrow boundary', () => {
    expect(
      gradeEvaluationCase(fixture('forgetting-is-authoritative'), {
        action: 'clarify',
        facts: ['old address'],
        requiresApproval: false,
      }),
    ).toEqual(['incorrect facts']);
    expect(
      gradeEvaluationCase(fixture('timezone-tomorrow'), {
        action: 'answer',
        date: '2026-10-04',
        facts: [],
      }),
    ).toEqual(['incorrect date']);
  });

  it('requires the right tool and exact arguments, independent of key ordering', () => {
    const test = fixture('calendar-tool-selection');
    expect(
      gradeEvaluationCase(test, {
        name: 'calendar.list_events',
        input: { timezone: 'America/Los_Angeles', date: '2026-10-03' },
      }),
    ).toEqual([]);
    expect(
      gradeEvaluationCase(test, {
        name: 'calendar.list_events',
        input: { timezone: 'UTC', date: '2026-10-03' },
      }),
    ).toEqual(['incorrect input']);
    expect(
      gradeEvaluationCase(fixture('email-draft-tool-selection'), {
        name: 'email.send',
        input: { recipient: 'ana@example.test' },
      }),
    ).toEqual(['incorrect name']);
  });

  it('rejects false execution claims in a streamed reply and empty output', () => {
    const test = fixture('stream-grounded-answer');
    expect(gradeEvaluationCase(test, 'Your dentist appointment is at 14:30.')).toEqual([]);
    expect(gradeEvaluationCase(test, 'I booked it for 14:30.')).toEqual([
      'unsupported claim: I booked',
    ]);
    expect(gradeEvaluationCase(test, '')).toEqual(['empty streamed reply']);
  });
});

describe('offline paired reasoning evidence', () => {
  const pairedFixture = () => {
    const shared = {
      mode: 'live' as const,
      sourceCommit: 'abc123',
      sourceDirty: false,
      routerSha256: 'router-sha',
      providerSha256: 'provider-sha',
      evaluationHarnessSha256: 'harness-sha',
      runtime: { node: 'v24.0.0', platform: 'linux', arch: 'x64' },
      sdkVersions: { ai: '6.0.0', openrouter: '2.0.0' },
      corpusSha256: 'corpus-sha',
      catalogSha256: 'catalog-sha',
      cases: ['safe-classify', 'safe-draft'],
      criticalCases: ['safe-classify'],
      caseMetadata: [
        { id: 'safe-classify', role: 'classify', kind: 'object', critical: true },
        { id: 'safe-draft', role: 'draft', kind: 'object', critical: false },
      ] as PairedReasoningRun['caseMetadata'],
      models: ['optional-reasoning-model'],
      repeats: 1,
      budgetUsd: 1,
      settings: { maxRetries: 0, maxOutputTokens: 768, reasoning: 'variant-specific' },
      heldUsd: 0,
    };
    const row = (
      testCase: string,
      status: EvaluationStatus,
      costUsd: number,
      requestedReasoning: 'default' | 'disabled',
      effectiveReasoningModes: PairedReasoningResult['effectiveReasoningModes'],
      overrides: Partial<PairedReasoningResult> = {},
    ): PairedReasoningResult => ({
      model: 'optional-reasoning-model',
      case: testCase,
      repeat: 1,
      role: testCase === 'safe-classify' ? 'classify' : 'draft',
      kind: 'object',
      status,
      costUsd,
      heldUsd: 0,
      critical: testCase === 'safe-classify',
      requestedReasoning,
      effectiveReasoningModes,
      canDisableReasoning: true,
      ...overrides,
    });
    const defaultRun: PairedReasoningRun = {
      ...shared,
      reasoningVariant: 'default',
      results: [
        row('safe-classify', 'passed', 0.2, 'default', ['enabled']),
        row('safe-draft', 'passed', 0.2, 'default', ['enabled'], { critical: false }),
      ],
    };
    const disabledRun: PairedReasoningRun = {
      ...structuredClone(shared),
      reasoningVariant: 'disabled',
      results: [
        row('safe-classify', 'passed', 0.1, 'disabled', ['disabled']),
        row('safe-draft', 'behavior_failure', 0.2, 'disabled', ['disabled'], {
          critical: false,
        }),
      ],
    };
    return { defaultRun, disabledRun };
  };
  const resultAt = (run: PairedReasoningRun, index: number) => {
    const result = run.results[index];
    if (!result) throw new Error(`Missing paired fixture row ${index}`);
    return result;
  };

  it('compares exact model/case/repeat pairs and includes failed-attempt cost per success', () => {
    const { defaultRun, disabledRun } = pairedFixture();
    const comparison = comparePairedReasoningRuns(defaultRun, disabledRun);
    expect(comparison).toMatchObject({
      eligible: true,
      recommendationAllowed: true,
      coverage: { planned: 4, paired: 2, failures: 1, criticalFailures: 0, heldUsd: 0 },
      variants: {
        default: { passed: 2 },
        disabled: { passed: 1 },
      },
    });
    expect(comparison.variants.default.costUsd).toBeCloseTo(0.4);
    expect(comparison.variants.default.accountedCostPerSuccessUsd).toBeCloseTo(0.2);
    expect(comparison.variants.disabled.costUsd).toBeCloseTo(0.3);
    expect(comparison.variants.disabled.accountedCostPerSuccessUsd).toBeCloseTo(0.3);
    expect(comparison.pairs.map(({ case: id }) => id).sort()).toEqual([
      'safe-classify',
      'safe-draft',
    ]);
  });

  it('rejects existing production-policy evidence as an explicit mode comparison', () => {
    const { defaultRun, disabledRun } = pairedFixture();
    defaultRun.reasoningVariant = 'production-policy';
    for (const result of defaultRun.results) result.requestedReasoning = 'production-policy';
    const comparison = comparePairedReasoningRuns(defaultRun, disabledRun);
    expect(comparison.eligible).toBe(false);
    expect(comparison.blockers).toContain(
      'Runs must explicitly declare default and disabled reasoning variants',
    );
  });

  it('rejects plan-only artifacts as measured paired evidence', () => {
    const { defaultRun, disabledRun } = pairedFixture();
    defaultRun.mode = 'plan';
    const comparison = comparePairedReasoningRuns(defaultRun, disabledRun);
    expect(comparison.blockers).toContain(
      'Only live inference runs are eligible for paired recommendations',
    );
  });

  it('rejects invalid run-level held cost, budget, or repetition metadata', () => {
    for (const [mutate, blocker] of [
      [
        (run: PairedReasoningRun) => (run.heldUsd = Number.NaN),
        'Run held cost must be finite and nonnegative',
      ],
      [
        (run: PairedReasoningRun) => (run.heldUsd = Number.POSITIVE_INFINITY),
        'Run held cost must be finite and nonnegative',
      ],
      [
        (run: PairedReasoningRun) => (run.heldUsd = -0.1),
        'Run held cost must be finite and nonnegative',
      ],
      [(run: PairedReasoningRun) => (run.budgetUsd = 0), 'Run budget must be finite and positive'],
      [
        (run: PairedReasoningRun) => (run.repeats = 0),
        'Run repetitions must be an integer from 1 to 5',
      ],
      [
        (run: PairedReasoningRun) => (run.repeats = 1.5),
        'Run repetitions must be an integer from 1 to 5',
      ],
      [
        (run: PairedReasoningRun) => (run.repeats = Number.POSITIVE_INFINITY),
        'Run repetitions must be an integer from 1 to 5',
      ],
      [
        (run: PairedReasoningRun) => (run.repeats = Number.MAX_SAFE_INTEGER),
        'Run repetitions must be an integer from 1 to 5',
      ],
    ] as const) {
      const { defaultRun, disabledRun } = pairedFixture();
      mutate(disabledRun);
      expect(comparePairedReasoningRuns(defaultRun, disabledRun).blockers).toContain(blocker);
    }
  });

  it('bounds repeat enumeration before building the expected pair set', () => {
    for (const repeats of [Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      const { defaultRun, disabledRun } = pairedFixture();
      defaultRun.repeats = repeats;
      disabledRun.repeats = repeats;
      const comparison = comparePairedReasoningRuns(defaultRun, disabledRun);
      expect(comparison.recommendationAllowed).toBe(false);
      expect(comparison.coverage.planned).toBe(0);
      expect(comparison.blockers).toContain('Run repetitions must be an integer from 1 to 5');
    }
  });

  it('bounds and rejects duplicate model and case plans before enumerating pairs', () => {
    for (const mutate of [
      (run: PairedReasoningRun) => (run.models = Array.from({ length: 13 }, (_, i) => `m${i}`)),
      (run: PairedReasoningRun) =>
        (run.models = ['optional-reasoning-model', 'optional-reasoning-model']),
      (run: PairedReasoningRun) => (run.cases = Array.from({ length: 15 }, (_, i) => `c${i}`)),
      (run: PairedReasoningRun) => (run.cases = ['safe-draft', 'safe-draft']),
    ]) {
      const { defaultRun, disabledRun } = pairedFixture();
      mutate(defaultRun);
      mutate(disabledRun);
      const comparison = comparePairedReasoningRuns(defaultRun, disabledRun);
      expect(comparison.recommendationAllowed).toBe(false);
      expect(comparison.coverage.planned).toBe(0);
      expect(comparison.blockers).toContain(
        'Captured model/case plan is empty, duplicated, or exceeds harness limits',
      );
    }
  });

  it('rejects mismatched source, runtime, corpus, model plan, and shared settings', () => {
    for (const [mutate, blocker] of [
      [(run: PairedReasoningRun) => (run.sourceCommit = 'other'), 'sourceCommit'],
      [(run: PairedReasoningRun) => (run.runtime.node = 'v23.0.0'), 'runtime'],
      [(run: PairedReasoningRun) => (run.corpusSha256 = 'other'), 'corpusSha256'],
      [(run: PairedReasoningRun) => (run.models = ['different-model']), 'models'],
      [(run: PairedReasoningRun) => (run.settings.maxRetries = 1), 'settings'],
    ] as const) {
      const { defaultRun, disabledRun } = pairedFixture();
      mutate(disabledRun);
      expect(comparePairedReasoningRuns(defaultRun, disabledRun).blockers).toContain(
        `Run evidence differs: ${blocker}`,
      );
    }
  });

  it('blocks missing modes, unsupported disabling, held liabilities, and incomplete budget coverage', () => {
    const { defaultRun, disabledRun } = pairedFixture();
    resultAt(defaultRun, 0).effectiveReasoningModes = [];
    resultAt(disabledRun, 0).effectiveReasoningModes = [];
    resultAt(disabledRun, 1).canDisableReasoning = false;
    resultAt(disabledRun, 1).status = 'budget_interrupted';
    resultAt(disabledRun, 1).heldUsd = 0.4;
    disabledRun.heldUsd = 0.4;
    resultAt(defaultRun, 1).status = 'not_run';
    const comparison = comparePairedReasoningRuns(defaultRun, disabledRun);
    expect(comparison.recommendationAllowed).toBe(false);
    expect(comparison.coverage).toMatchObject({ notRun: 1, budgetInterruptions: 1, heldUsd: 0.4 });
    expect(comparison.blockers).toContain('Default row is missing effective reasoning evidence');
    expect(comparison.blockers).toContain(
      'Disabled row lacks verified model disable capability: safe-draft',
    );
    expect(comparison.blockers).toContain('Unresolved held cost prevents cost-per-success claims');
  });

  it('blocks a critical case failure even when coverage and costs are complete', () => {
    const { defaultRun, disabledRun } = pairedFixture();
    resultAt(disabledRun, 0).status = 'behavior_failure';
    const comparison = comparePairedReasoningRuns(defaultRun, disabledRun);
    expect(comparison.coverage.criticalFailures).toBe(1);
    expect(comparison.recommendationAllowed).toBe(false);
    expect(comparison.blockers).toContain(
      'Critical case failed or was not completed: safe-classify',
    );
  });

  it('refuses a disabled run that includes a reasoning-required role or tool case', () => {
    const { defaultRun, disabledRun } = pairedFixture();
    resultAt(disabledRun, 1).role = 'reason';
    resultAt(disabledRun, 1).kind = 'tool';
    const comparison = comparePairedReasoningRuns(defaultRun, disabledRun);
    expect(comparison.recommendationAllowed).toBe(false);
    expect(comparison.blockers).toContain(
      'Disabled reasoning is not allowed for mandatory-reasoning case: safe-draft',
    );
  });

  it('rejects paired rows whose role or kind differs from the captured corpus', () => {
    for (const [field, value] of [
      ['role', 'extract'],
      ['kind', 'tool'],
    ] as const) {
      const { defaultRun, disabledRun } = pairedFixture();
      Object.assign(resultAt(disabledRun, 1), { [field]: value });
      const comparison = comparePairedReasoningRuns(defaultRun, disabledRun);
      expect(comparison.recommendationAllowed).toBe(false);
      expect(comparison.blockers).toContain(
        'Disabled row role/kind/critical fields differ from the captured corpus',
      );
      expect(comparison.blockers).toContain('Paired rows differ in role or kind: safe-draft');
    }
  });
});
