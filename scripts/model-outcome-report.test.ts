import { describe, expect, it } from 'vitest';
import {
  buildModelOutcomeReport,
  modelOutcomeFixtureSchema,
  modelOutcomeReportDigest,
  SYNTHETIC_MODEL_OUTCOME_FIXTURE,
} from './model-outcome-report.js';

function fixture(overrides: Record<string, unknown> = {}) {
  return structuredClone({ ...SYNTHETIC_MODEL_OUTCOME_FIXTURE, ...overrides });
}

describe('synthetic model outcome report', () => {
  it('deduplicates an identical stable call receipt and keeps retries visible', () => {
    const report = buildModelOutcomeReport(SYNTHETIC_MODEL_OUTCOME_FIXTURE);
    expect(report.scope).toBe('synthetic_fixture_only');
    expect(report.outcomeSource).toBe('fixture_declared');
    expect(report.occurrenceDurationMs).toBe(2400);
    expect(report.attempts.map((attempt) => attempt.durationMs)).toEqual([800, 1500]);
    expect(report.uniqueAttemptCount).toBe(2);
    expect(report.duplicateReceiptCount).toBe(1);
    expect(report.retryCount).toBe(1);
    expect(report.failedAttemptCount).toBe(1);
    expect(report.amountsByCurrency).toEqual([
      {
        currency: 'USD',
        knownAmount: '0.0042',
        attemptCount: 2,
        byBasis: { provider_reported: '0.003', token_rate: '0.0012' },
      },
    ]);
    expect(report.modelCostPerSuccessfulOutcome).toEqual({
      eligible: true,
      amount: '0.0042',
      currency: 'USD',
    });
  });

  it('rejects conflicting duplicate receipts instead of silently selecting one', () => {
    const source = fixture();
    const attempts = source.attempts as Array<Record<string, unknown>>;
    attempts[2] = {
      ...attempts[2],
      cost: { known: true, basis: 'provider_reported', amount: '0.009', currency: 'USD' },
    };
    expect(() => buildModelOutcomeReport(source)).toThrow('Conflicting receipt rows');
  });

  it('keeps the supported currency total and preserves an unsupported raw currency', () => {
    const source = fixture({
      attempts: [
        {
          callId: 'call:usd',
          model: 'fixture-model',
          provider: 'fixture-provider',
          role: 'draft',
          status: 'passed',
          startedAt: '2026-11-03T10:00:00.000Z',
          finishedAt: '2026-11-03T10:00:01.000Z',
          cost: { known: true, basis: 'provider_reported', amount: '0.01', currency: 'USD' },
        },
        {
          callId: 'call:eur',
          model: 'fixture-model',
          provider: 'fixture-provider',
          role: 'draft',
          status: 'passed',
          startedAt: '2026-11-03T10:00:01.100Z',
          finishedAt: '2026-11-03T10:00:02.000Z',
          cost: { known: true, basis: 'token_rate', amount: '0.02', currency: 'EUR' },
        },
      ],
    });
    const report = buildModelOutcomeReport(source);
    expect(report.amountsByCurrency.map((row) => [row.currency, row.knownAmount])).toEqual([
      ['USD', '0.01'],
    ]);
    expect(report.attempts.map((attempt) => attempt.currency)).toEqual(['USD', 'EUR']);
    expect(report.unsupportedCurrencyCount).toBe(1);
    expect(report.unsupportedCurrencies).toEqual(['EUR']);
    expect(report.modelCostPerSuccessfulOutcome).toEqual({
      eligible: false,
      reason: 'unsupported_currency',
      amount: null,
      currency: null,
    });
  });

  it('preserves an unrecognized currency code but never treats its amount as supported', () => {
    const source = fixture({
      attempts: SYNTHETIC_MODEL_OUTCOME_FIXTURE.attempts.map((attempt) => ({
        ...attempt,
        cost: { ...attempt.cost, currency: 'ZZZ' },
      })),
    });
    const report = buildModelOutcomeReport(source);
    expect(report.attempts.every((attempt) => attempt.currency === 'ZZZ')).toBe(true);
    expect(report.amountsByCurrency).toEqual([]);
    expect(report.unsupportedCurrencyCount).toBe(2);
    expect(report.unsupportedCurrencies).toEqual(['ZZZ']);
    expect(report.modelCostPerSuccessfulOutcome).toEqual({
      eligible: false,
      reason: 'unsupported_currency',
      amount: null,
      currency: null,
    });
  });

  it('rejects a missing raw currency and keeps malformed currency strings ineligible', () => {
    const withNullCurrency = fixture();
    const nullAttempts = withNullCurrency.attempts as Array<Record<string, unknown>>;
    nullAttempts[0] = {
      ...nullAttempts[0],
      cost: { known: true, basis: 'provider_reported', amount: '0.01', currency: null },
    };
    expect(modelOutcomeFixtureSchema.safeParse(withNullCurrency).success).toBe(false);

    const withMalformedCurrency = fixture({
      attempts: [
        {
          callId: 'call:malformed-currency',
          model: 'fixture-model',
          provider: 'fixture-provider',
          role: 'plan',
          status: 'passed',
          startedAt: '2026-11-03T10:00:00.000Z',
          finishedAt: '2026-11-03T10:00:01.000Z',
          cost: { known: true, basis: 'provider_reported', amount: '0.01', currency: 'usd' },
        },
      ],
    });
    const report = buildModelOutcomeReport(withMalformedCurrency);
    expect(report.attempts[0]?.currency).toBe('usd');
    expect(report.amountsByCurrency).toEqual([]);
    expect(report.unsupportedCurrencies).toEqual(['usd']);
    expect(report.modelCostPerSuccessfulOutcome).toMatchObject({
      eligible: false,
      reason: 'unsupported_currency',
    });
  });

  it('keeps unknown cost unknown and makes cost per success ineligible', () => {
    const source = fixture({
      outcome: 'passed',
      attempts: [
        {
          callId: 'call:unknown',
          model: 'fixture-model',
          provider: 'fixture-provider',
          role: 'plan',
          status: 'passed',
          startedAt: '2026-11-03T10:00:00.000Z',
          finishedAt: '2026-11-03T10:00:01.000Z',
          cost: { known: false, basis: 'unknown', amount: null, currency: null },
        },
      ],
    });
    const report = buildModelOutcomeReport(source);
    expect(report.unknownCostCount).toBe(1);
    expect(report.amountsByCurrency).toEqual([]);
    expect(report.modelCostPerSuccessfulOutcome).toEqual({
      eligible: false,
      reason: 'unknown_cost',
      amount: null,
      currency: null,
    });
  });

  it('never labels an unsuccessful outcome as a successful cheap outcome', () => {
    const report = buildModelOutcomeReport(fixture({ outcome: 'behavior_failure' }));
    expect(report.modelCostPerSuccessfulOutcome).toEqual({
      eligible: false,
      reason: 'outcome_not_passed',
      amount: null,
      currency: null,
    });
  });

  it('marks partial coverage ineligible even when all observed attempts cost nothing', () => {
    const source = fixture({
      outcome: 'passed',
      coverage: { state: 'partial', missingFacts: ['terminal attempt receipt'] },
      attempts: [
        {
          callId: 'call:reported-zero',
          model: 'fixture-model',
          provider: 'fixture-provider',
          role: 'draft',
          status: 'passed',
          startedAt: '2026-11-03T10:00:00.000Z',
          finishedAt: '2026-11-03T10:00:01.000Z',
          cost: { known: true, basis: 'provider_reported', amount: '0', currency: 'USD' },
        },
      ],
    });
    const report = buildModelOutcomeReport(source);
    expect(report.amountsByCurrency[0]?.knownAmount).toBe('0');
    expect(report.modelCostPerSuccessfulOutcome).toEqual({
      eligible: false,
      reason: 'coverage_partial',
      amount: null,
      currency: null,
    });
  });

  it('requires explicit outcome facts and rejects content fields', () => {
    const withContent = { ...fixture(), prompt: 'private prompt text' };
    expect(modelOutcomeFixtureSchema.safeParse(withContent).success).toBe(false);
  });

  it('rejects provider invoice rows so they cannot overlap ledger receipts', () => {
    const source = fixture({ source: 'provider_billing_feed' });
    expect(modelOutcomeFixtureSchema.safeParse(source).success).toBe(false);
  });

  it('requires retry parents and complete-coverage claims to be internally consistent', () => {
    const orphan = fixture({
      attempts: [
        {
          callId: 'call:retry',
          retryOfCallId: 'call:missing',
          model: 'fixture-model',
          provider: 'fixture-provider',
          role: 'plan',
          status: 'passed',
          startedAt: '2026-11-03T10:00:00.000Z',
          finishedAt: '2026-11-03T10:00:01.000Z',
          cost: { known: true, basis: 'token_rate', amount: '0.1', currency: 'USD' },
        },
      ],
    });
    expect(() => buildModelOutcomeReport(orphan)).toThrow('Retry parent is absent');
    const falseSuccess = fixture({
      outcome: 'passed',
      attempts: [
        {
          callId: 'call:failed-only',
          model: 'fixture-model',
          provider: 'fixture-provider',
          role: 'plan',
          status: 'behavior_failure',
          startedAt: '2026-11-03T10:00:00.000Z',
          finishedAt: '2026-11-03T10:00:01.000Z',
          cost: { known: true, basis: 'token_rate', amount: '0.1', currency: 'USD' },
        },
      ],
    });
    expect(modelOutcomeFixtureSchema.safeParse(falseSuccess).success).toBe(false);
    expect(
      modelOutcomeFixtureSchema.safeParse({
        ...fixture(),
        coverage: { state: 'complete', missingFacts: ['terminal receipt'] },
      }).success,
    ).toBe(false);
  });

  it('rejects cyclic retry lineage even when zero-duration attempts share a timestamp', () => {
    const sameTime = '2026-11-03T10:00:00.000Z';
    const cycle = fixture({
      outcome: 'request_failure',
      attempts: [
        {
          callId: 'call:a',
          retryOfCallId: 'call:b',
          model: 'fixture-model',
          provider: 'fixture-provider',
          role: 'plan',
          status: 'request_failure',
          startedAt: sameTime,
          finishedAt: sameTime,
          cost: { known: true, basis: 'token_rate', amount: '0.01', currency: 'USD' },
        },
        {
          callId: 'call:b',
          retryOfCallId: 'call:a',
          model: 'fixture-model',
          provider: 'fixture-provider',
          role: 'plan',
          status: 'request_failure',
          startedAt: sameTime,
          finishedAt: sameTime,
          cost: { known: true, basis: 'token_rate', amount: '0.01', currency: 'USD' },
        },
      ],
    });
    expect(() => buildModelOutcomeReport(cycle)).toThrow('Retry lineage contains a cycle');
  });

  it('separates failed, interrupted, and not-run attempts', () => {
    const at = '2026-11-03T10:00:00.000Z';
    const report = buildModelOutcomeReport(
      fixture({
        outcome: 'request_failure',
        attempts: (['request_failure', 'budget_interrupted', 'not_run'] as const).map(
          (status, index) => ({
            callId: `call:status-${index}`,
            model: 'fixture-model',
            provider: 'fixture-provider',
            role: 'plan',
            status,
            startedAt: at,
            finishedAt: status === 'not_run' ? null : at,
            cost:
              status === 'not_run'
                ? { known: false, basis: 'unknown', amount: null, currency: null }
                : { known: true, basis: 'provider_reported', amount: '0.01', currency: 'USD' },
          }),
        ),
      }),
    );
    expect(report.failedAttemptCount).toBe(1);
    expect(report.interruptedAttemptCount).toBe(1);
    expect(report.notRunAttemptCount).toBe(1);
  });

  it('withholds success cost when the occurrence has no terminal timestamp', () => {
    const report = buildModelOutcomeReport(fixture({ finishedAt: null }));
    expect(report.occurrenceTerminal).toBe(false);
    expect(report.modelCostPerSuccessfulOutcome).toEqual({
      eligible: false,
      reason: 'occurrence_not_terminal',
      amount: null,
      currency: null,
    });
  });

  it('rejects attempts that begin before or after their occurrence or finish beyond it', () => {
    const beforeOccurrence = fixture({
      startedAt: '2026-11-04T10:00:00.000Z',
      finishedAt: '2026-11-04T10:00:02.400Z',
    });
    expect(() => buildModelOutcomeReport(beforeOccurrence)).toThrow(
      'Attempt starts before its occurrence',
    );

    const startsAfterOccurrence = fixture({
      finishedAt: '2026-11-03T10:00:00.000Z',
      attempts: [
        {
          callId: 'call:late-start',
          model: 'fixture-model',
          provider: 'fixture-provider',
          role: 'plan',
          status: 'passed',
          startedAt: '2026-11-03T10:00:00.001Z',
          finishedAt: '2026-11-03T10:00:00.001Z',
          cost: { known: true, basis: 'provider_reported', amount: '0.01', currency: 'USD' },
        },
      ],
    });
    expect(() => buildModelOutcomeReport(startsAfterOccurrence)).toThrow(
      'Attempt starts after its occurrence finished',
    );

    const finishesAfterOccurrence = fixture({
      attempts: [
        {
          callId: 'call:late-finish',
          model: 'fixture-model',
          provider: 'fixture-provider',
          role: 'plan',
          status: 'passed',
          startedAt: '2026-11-03T10:00:02.000Z',
          finishedAt: '2026-11-03T10:00:02.401Z',
          cost: { known: true, basis: 'provider_reported', amount: '0.01', currency: 'USD' },
        },
      ],
    });
    expect(() => buildModelOutcomeReport(finishesAfterOccurrence)).toThrow(
      'Attempt finishes after its occurrence',
    );
  });

  it('accepts inclusive occurrence boundaries and overlapping parallel attempts', () => {
    const source = fixture({
      attempts: ['call:parallel-a', 'call:parallel-b'].map((callId) => ({
        callId,
        model: 'fixture-model',
        provider: 'fixture-provider',
        role: 'plan',
        status: 'passed',
        startedAt: '2026-11-03T10:00:00.000Z',
        finishedAt: '2026-11-03T10:00:02.400Z',
        cost: { known: true, basis: 'provider_reported', amount: '0.01', currency: 'USD' },
      })),
    });
    const report = buildModelOutcomeReport(source);
    expect(report.modelCostPerSuccessfulOutcome).toEqual({
      eligible: true,
      amount: '0.02',
      currency: 'USD',
    });
  });

  it('withholds success cost while an executed attempt has no terminal timestamp', () => {
    const source = fixture({
      attempts: [
        {
          callId: 'call:open',
          model: 'fixture-model',
          provider: 'fixture-provider',
          role: 'plan',
          status: 'passed',
          startedAt: '2026-11-03T10:00:00.000Z',
          finishedAt: null,
          cost: { known: true, basis: 'provider_reported', amount: '0.01', currency: 'USD' },
        },
      ],
    });
    const report = buildModelOutcomeReport(source);
    expect(report.attemptsTerminal).toBe(false);
    expect(report.modelCostPerSuccessfulOutcome).toEqual({
      eligible: false,
      reason: 'attempts_not_terminal',
      amount: null,
      currency: null,
    });
  });

  it('produces a stable digest for an unchanged synthetic report', () => {
    const report = buildModelOutcomeReport(SYNTHETIC_MODEL_OUTCOME_FIXTURE);
    expect(modelOutcomeReportDigest(report)).toBe(
      modelOutcomeReportDigest(buildModelOutcomeReport(SYNTHETIC_MODEL_OUTCOME_FIXTURE)),
    );
  });
});
