import { describe, expect, it } from 'vitest';
import {
  classifyEvaluationResult,
  comparePairedReasoningRuns,
  EvaluationLedger,
  type EvaluationStatus,
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
        'Run repetitions must be a positive integer',
      ],
      [
        (run: PairedReasoningRun) => (run.repeats = 1.5),
        'Run repetitions must be a positive integer',
      ],
    ] as const) {
      const { defaultRun, disabledRun } = pairedFixture();
      mutate(disabledRun);
      expect(comparePairedReasoningRuns(defaultRun, disabledRun).blockers).toContain(blocker);
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
