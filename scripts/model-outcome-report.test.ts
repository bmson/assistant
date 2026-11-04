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
    expect(report.uniqueCallCount).toBe(2);
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

  it('keeps known currencies separate and refuses a combined successful-outcome cost', () => {
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
      ['EUR', '0.02'],
      ['USD', '0.01'],
    ]);
    expect(report.modelCostPerSuccessfulOutcome).toEqual({
      eligible: false,
      reason: 'mixed_currencies',
      amount: null,
      currency: null,
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

  it('produces a stable digest for an unchanged synthetic report', () => {
    const report = buildModelOutcomeReport(SYNTHETIC_MODEL_OUTCOME_FIXTURE);
    expect(modelOutcomeReportDigest(report)).toBe(
      modelOutcomeReportDigest(buildModelOutcomeReport(SYNTHETIC_MODEL_OUTCOME_FIXTURE)),
    );
  });
});
