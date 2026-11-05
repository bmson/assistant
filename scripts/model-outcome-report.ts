import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { COST_BASIS_LABELS, type CostBasis } from '@assistant/persistence';
import { z } from 'zod';
import type { EvaluationStatus } from './model-evaluation.js';

const evaluationStatuses = [
  'passed',
  'behavior_failure',
  'compatibility_failure',
  'request_failure',
  'budget_interrupted',
  'not_run',
] as const satisfies readonly EvaluationStatus[];

const costBases = Object.keys(COST_BASIS_LABELS) as [CostBasis, ...CostBasis[]];
// Existing cost totals expose USD only (`CostEvidenceTotal.usd` / ledgerUsdToMicros).
const supportedCurrencies = ['USD'] as const;
type SupportedCurrency = (typeof supportedCurrencies)[number];
const supportedCurrencySet = new Set<string>(supportedCurrencies);

const amountSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/,
    'Amount must be a nonnegative decimal with at most 8 places',
  );

const costSchema = z.discriminatedUnion('known', [
  z
    .object({
      known: z.literal(true),
      basis: z.enum(costBases),
      amount: amountSchema,
      currency: z.string().min(1).max(16),
    })
    .strict()
    .superRefine((cost, ctx) => {
      if (cost.basis === 'unknown') {
        ctx.addIssue({
          code: 'custom',
          path: ['basis'],
          message: 'Known amount cannot use unknown evidence',
        });
      }
    }),
  z
    .object({
      known: z.literal(false),
      basis: z.literal('unknown'),
      amount: z.null(),
      currency: z.null(),
    })
    .strict(),
]);

const attemptSchema = z
  .object({
    callId: z.string().min(1),
    retryOfCallId: z.string().min(1).optional(),
    model: z.string().min(1),
    provider: z.string().min(1),
    role: z.string().min(1),
    status: z.enum(evaluationStatuses),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }).nullable(),
    cost: costSchema,
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.retryOfCallId === attempt.callId) {
      ctx.addIssue({
        code: 'custom',
        path: ['retryOfCallId'],
        message: 'An attempt cannot retry itself',
      });
    }
    if (attempt.finishedAt && Date.parse(attempt.finishedAt) < Date.parse(attempt.startedAt)) {
      ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'Finish precedes start' });
    }
  });

export const modelOutcomeFixtureSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('synthetic_model_outcome_fixture'),
    source: z.enum(['assistant_ledger', 'offline_evaluation']),
    fixtureId: z.string().regex(/^fixture:[a-z0-9-]+$/),
    occurrenceId: z.string().regex(/^occurrence:[a-z0-9-]+$/),
    outcome: z.enum(evaluationStatuses),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }).nullable(),
    coverage: z
      .object({
        state: z.enum(['complete', 'partial']),
        missingFacts: z.array(z.string().min(1)),
      })
      .strict(),
    attempts: z.array(attemptSchema),
  })
  .strict()
  .superRefine((fixture, ctx) => {
    if (fixture.finishedAt && Date.parse(fixture.finishedAt) < Date.parse(fixture.startedAt)) {
      ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'Finish precedes start' });
    }
    if (fixture.coverage.state === 'complete' && fixture.coverage.missingFacts.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['coverage'],
        message: 'Complete coverage cannot list missing facts',
      });
    }
    if (fixture.coverage.state === 'partial' && fixture.coverage.missingFacts.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['coverage'],
        message: 'Partial coverage must name a missing fact',
      });
    }
    if (
      fixture.outcome === 'passed' &&
      !fixture.attempts.some((attempt) => attempt.status === 'passed')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['attempts'],
        message: 'Passed outcome requires a passing attempt fact',
      });
    }
    const occurrenceStart = Date.parse(fixture.startedAt);
    const occurrenceFinish = fixture.finishedAt === null ? null : Date.parse(fixture.finishedAt);
    for (const [index, attempt] of fixture.attempts.entries()) {
      const attemptStart = Date.parse(attempt.startedAt);
      const attemptFinish = attempt.finishedAt === null ? null : Date.parse(attempt.finishedAt);
      if (attemptStart < occurrenceStart) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempts', index, 'startedAt'],
          message: 'Attempt starts before its occurrence',
        });
      }
      if (occurrenceFinish !== null && attemptStart > occurrenceFinish) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempts', index, 'startedAt'],
          message: 'Attempt starts after its occurrence finished',
        });
      }
      if (attemptFinish !== null && occurrenceFinish !== null && attemptFinish > occurrenceFinish) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempts', index, 'finishedAt'],
          message: 'Attempt finishes after its occurrence',
        });
      }
    }
  });

export type ModelOutcomeFixture = z.infer<typeof modelOutcomeFixtureSchema>;

export interface ModelOutcomeReport {
  kind: 'synthetic_model_outcome_report';
  scope: 'synthetic_fixture_only';
  outcomeSource: 'fixture_declared';
  fixtureId: string;
  occurrenceId: string;
  source: ModelOutcomeFixture['source'];
  outcome: EvaluationStatus;
  occurrenceDurationMs: number | null;
  occurrenceTerminal: boolean;
  attemptsTerminal: boolean;
  coverage: ModelOutcomeFixture['coverage'];
  attempts: Array<{
    callId: string;
    retryOfCallId: string | null;
    model: string;
    provider: string;
    role: string;
    status: EvaluationStatus;
    durationMs: number | null;
    costBasis: CostBasis;
    amount: string | null;
    currency: string | null;
  }>;
  uniqueAttemptCount: number;
  duplicateReceiptCount: number;
  retryCount: number;
  failedAttemptCount: number;
  interruptedAttemptCount: number;
  notRunAttemptCount: number;
  unknownCostCount: number;
  unsupportedCurrencyCount: number;
  unsupportedCurrencies: string[];
  amountsByCurrency: Array<{
    currency: string;
    knownAmount: string;
    attemptCount: number;
    byBasis: Partial<Record<CostBasis, string>>;
  }>;
  modelCostPerSuccessfulOutcome:
    | { eligible: true; amount: string; currency: string }
    | {
        eligible: false;
        reason:
          | 'outcome_not_passed'
          | 'coverage_partial'
          | 'occurrence_not_terminal'
          | 'attempts_not_terminal'
          | 'unknown_cost'
          | 'unsupported_currency'
          | 'no_cost';
        amount: null;
        currency: null;
      };
}

const DECIMAL_SCALE = 100_000_000n;

function toUnits(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * DECIMAL_SCALE + BigInt(fraction.padEnd(8, '0'));
}

function fromUnits(value: bigint): string {
  const whole = value / DECIMAL_SCALE;
  const fraction = (value % DECIMAL_SCALE).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Validate a fixture and report only its declared synthetic attempt evidence. */
export function buildModelOutcomeReport(input: unknown): ModelOutcomeReport {
  const fixture = modelOutcomeFixtureSchema.parse(input);
  const unique = new Map<string, ModelOutcomeFixture['attempts'][number]>();
  let duplicateReceiptCount = 0;
  for (const attempt of fixture.attempts) {
    const existing = unique.get(attempt.callId);
    if (!existing) {
      unique.set(attempt.callId, attempt);
      continue;
    }
    if (canonicalJson(existing) !== canonicalJson(attempt)) {
      throw new Error(`Conflicting receipt rows for call ${attempt.callId}`);
    }
    duplicateReceiptCount += 1;
  }

  const attempts = [...unique.values()];
  const byCallId = new Map(attempts.map((attempt) => [attempt.callId, attempt]));
  for (const attempt of attempts) {
    const lineage = new Set([attempt.callId]);
    let current = attempt;
    while (current.retryOfCallId) {
      const parent = byCallId.get(current.retryOfCallId);
      if (!parent) throw new Error(`Retry parent is absent for call ${current.callId}`);
      if (lineage.has(parent.callId)) {
        throw new Error(`Retry lineage contains a cycle at call ${parent.callId}`);
      }
      lineage.add(parent.callId);
      if (!parent.finishedAt || Date.parse(parent.finishedAt) > Date.parse(current.startedAt)) {
        throw new Error(`Retry parent is not terminal before call ${current.callId}`);
      }
      current = parent;
    }
  }

  const currencies = new Map<
    SupportedCurrency,
    { amount: bigint; attemptCount: number; byBasis: Map<CostBasis, bigint> }
  >();
  let unknownCostCount = 0;
  let unsupportedCurrencyCount = 0;
  const unsupportedCurrencies = new Set<string>();
  for (const attempt of attempts) {
    if (!attempt.cost.known) {
      unknownCostCount += 1;
      continue;
    }
    if (!supportedCurrencySet.has(attempt.cost.currency)) {
      unsupportedCurrencyCount += 1;
      unsupportedCurrencies.add(attempt.cost.currency);
      continue;
    }
    const currency = attempt.cost.currency as SupportedCurrency;
    const row = currencies.get(currency) ?? {
      amount: 0n,
      attemptCount: 0,
      byBasis: new Map<CostBasis, bigint>(),
    };
    const amount = toUnits(attempt.cost.amount);
    row.amount += amount;
    row.attemptCount += 1;
    row.byBasis.set(attempt.cost.basis, (row.byBasis.get(attempt.cost.basis) ?? 0n) + amount);
    currencies.set(currency, row);
  }

  let modelCostPerSuccessfulOutcome: ModelOutcomeReport['modelCostPerSuccessfulOutcome'];
  if (fixture.outcome !== 'passed') {
    modelCostPerSuccessfulOutcome = {
      eligible: false,
      reason: 'outcome_not_passed',
      amount: null,
      currency: null,
    };
  } else if (fixture.coverage.state !== 'complete') {
    modelCostPerSuccessfulOutcome = {
      eligible: false,
      reason: 'coverage_partial',
      amount: null,
      currency: null,
    };
  } else if (!fixture.finishedAt) {
    modelCostPerSuccessfulOutcome = {
      eligible: false,
      reason: 'occurrence_not_terminal',
      amount: null,
      currency: null,
    };
  } else if (attempts.some((attempt) => attempt.status !== 'not_run' && !attempt.finishedAt)) {
    modelCostPerSuccessfulOutcome = {
      eligible: false,
      reason: 'attempts_not_terminal',
      amount: null,
      currency: null,
    };
  } else if (unknownCostCount > 0) {
    modelCostPerSuccessfulOutcome = {
      eligible: false,
      reason: 'unknown_cost',
      amount: null,
      currency: null,
    };
  } else if (unsupportedCurrencyCount > 0) {
    modelCostPerSuccessfulOutcome = {
      eligible: false,
      reason: 'unsupported_currency',
      amount: null,
      currency: null,
    };
  } else if (currencies.size === 0) {
    modelCostPerSuccessfulOutcome = {
      eligible: false,
      reason: 'no_cost',
      amount: null,
      currency: null,
    };
  } else {
    const [currency, row] = [...currencies.entries()][0] as [
      string,
      typeof currencies extends Map<string, infer V> ? V : never,
    ];
    modelCostPerSuccessfulOutcome = { eligible: true, amount: fromUnits(row.amount), currency };
  }

  const finishedAt = fixture.finishedAt ? Date.parse(fixture.finishedAt) : null;
  const startedAt = Date.parse(fixture.startedAt);
  return {
    kind: 'synthetic_model_outcome_report',
    scope: 'synthetic_fixture_only',
    outcomeSource: 'fixture_declared',
    fixtureId: fixture.fixtureId,
    occurrenceId: fixture.occurrenceId,
    source: fixture.source,
    outcome: fixture.outcome,
    occurrenceDurationMs: finishedAt === null ? null : finishedAt - startedAt,
    occurrenceTerminal: finishedAt !== null,
    attemptsTerminal: attempts.every(
      (attempt) => attempt.status === 'not_run' || attempt.finishedAt !== null,
    ),
    coverage: fixture.coverage,
    attempts: attempts.map((attempt) => ({
      callId: attempt.callId,
      retryOfCallId: attempt.retryOfCallId ?? null,
      model: attempt.model,
      provider: attempt.provider,
      role: attempt.role,
      status: attempt.status,
      durationMs: attempt.finishedAt
        ? Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt)
        : null,
      costBasis: attempt.cost.basis,
      amount: attempt.cost.known ? attempt.cost.amount : null,
      currency: attempt.cost.known ? attempt.cost.currency : null,
    })),
    uniqueAttemptCount: attempts.length,
    duplicateReceiptCount,
    retryCount: attempts.filter((attempt) => attempt.retryOfCallId !== undefined).length,
    failedAttemptCount: attempts.filter((attempt) =>
      ['behavior_failure', 'compatibility_failure', 'request_failure'].includes(attempt.status),
    ).length,
    interruptedAttemptCount: attempts.filter((attempt) => attempt.status === 'budget_interrupted')
      .length,
    notRunAttemptCount: attempts.filter((attempt) => attempt.status === 'not_run').length,
    unknownCostCount,
    unsupportedCurrencyCount,
    unsupportedCurrencies: [...unsupportedCurrencies].sort((a, b) => a.localeCompare(b)),
    amountsByCurrency: [...currencies.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, row]) => ({
        currency,
        knownAmount: fromUnits(row.amount),
        attemptCount: row.attemptCount,
        byBasis: Object.fromEntries(
          [...row.byBasis.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([basis, amount]) => [basis, fromUnits(amount)]),
        ) as Partial<Record<CostBasis, string>>,
      })),
    modelCostPerSuccessfulOutcome,
  };
}

/** Stable digest is useful for reviewing a synthetic report without content data. */
export function modelOutcomeReportDigest(report: ModelOutcomeReport): string {
  return createHash('sha256').update(canonicalJson(report)).digest('hex');
}

export const SYNTHETIC_MODEL_OUTCOME_FIXTURE: ModelOutcomeFixture = {
  version: 1,
  kind: 'synthetic_model_outcome_fixture',
  source: 'offline_evaluation',
  fixtureId: 'fixture:retry-with-receipt-duplicate',
  occurrenceId: 'occurrence:synthetic-calendar-plan-01',
  outcome: 'passed',
  startedAt: '2026-11-03T10:00:00.000Z',
  finishedAt: '2026-11-03T10:00:02.400Z',
  coverage: { state: 'complete', missingFacts: [] },
  attempts: [
    {
      callId: 'call:plan-1',
      model: 'fixture-model-a',
      provider: 'fixture-provider',
      role: 'plan',
      status: 'request_failure',
      startedAt: '2026-11-03T10:00:00.000Z',
      finishedAt: '2026-11-03T10:00:00.800Z',
      cost: { known: true, basis: 'token_rate', amount: '0.0012', currency: 'USD' },
    },
    {
      callId: 'call:plan-2',
      retryOfCallId: 'call:plan-1',
      model: 'fixture-model-a',
      provider: 'fixture-provider',
      role: 'plan',
      status: 'passed',
      startedAt: '2026-11-03T10:00:00.900Z',
      finishedAt: '2026-11-03T10:00:02.400Z',
      cost: { known: true, basis: 'provider_reported', amount: '0.003', currency: 'USD' },
    },
    {
      callId: 'call:plan-2',
      retryOfCallId: 'call:plan-1',
      model: 'fixture-model-a',
      provider: 'fixture-provider',
      role: 'plan',
      status: 'passed',
      startedAt: '2026-11-03T10:00:00.900Z',
      finishedAt: '2026-11-03T10:00:02.400Z',
      cost: { known: true, basis: 'provider_reported', amount: '0.003', currency: 'USD' },
    },
  ],
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = buildModelOutcomeReport(SYNTHETIC_MODEL_OUTCOME_FIXTURE);
  console.log(JSON.stringify({ ...report, digest: modelOutcomeReportDigest(report) }, null, 2));
}
