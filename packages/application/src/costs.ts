import { getAgent } from '@assistant/core/chat';
import { type CostTotals, costTotals } from '@assistant/core/cost';
import { budgets, costEvents, costReservations, type Db, modelCalls, tasks } from '@assistant/db';
import {
  addMicros,
  type BudgetCapsRepository,
  type CostBasis,
  type CostEvidence,
  type CostEvidenceTotal,
  costBasis,
  microsToUsd,
  normalizeBudgetCaps,
  usdDecimalToMicros,
} from '@assistant/persistence';
import { and, count, desc, eq, gte, lt, sql, sum } from 'drizzle-orm';

export interface ModelCostEvidenceTotal {
  provider: string | null;
  model: string | null;
  basis: CostBasis;
  usd: string;
  count: number;
}

export interface CostsDashboard {
  byEvidence: CostEvidenceTotal[];
  byModelEvidence: ModelCostEvidenceTotal[];
  dispatchingAttempts: UnknownCostAttemptSummary;
  unknownAttempts: UnknownCostAttemptSummary;
  timezone: string;
  totals: CostTotals;
  bySource: Array<{ source: string; usd: string | null; count: number }>;
  byModel: Array<{ model: string; usd: string | null; count: number }>;
  topTasks: Array<{
    taskId: string | null;
    usd: string | null;
    type: string;
    progress: string;
  }>;
  held: Array<{ id: string; source: string; description: string; estimatedUsd: string }>;
  recent: Array<{
    id: string;
    createdAt: Date;
    source: string;
    description: string;
    usd: string;
    evidence: CostEvidence;
  }>;
  parkedTasks: number;
  taskDefaultLimit: string | null;
}

/** Outstanding unknown-outcome reservations are exposure estimates, not spend. */
export interface UnknownCostAttemptSummary {
  /** Exact when countComplete; a lower bound when false. */
  count: number;
  countComplete: boolean;
  /** Sum of retained reservation estimates, only when estimateComplete. */
  estimatedUsd: string | null;
  estimateComplete: boolean;
}

function evidenceDimension(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function compareEvidenceDimension(left: string | null, right: string | null): number {
  const a = left ?? '';
  const b = right ?? '';
  return a < b ? -1 : a > b ? 1 : 0;
}

function safeCount(value: number | string): number {
  const parsed = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('Invalid PostgreSQL model evidence count');
  return parsed;
}

function modelEvidenceRows(
  rows: Array<{
    provider: string | null;
    model: string | null;
    basis: string | null;
    usd: string | null;
    count: number | string;
  }>,
): ModelCostEvidenceTotal[] {
  const groups = new Map<string, ModelCostEvidenceTotal & { micros: number }>();
  for (const row of rows) {
    const provider = evidenceDimension(row.provider);
    const model = evidenceDimension(row.model);
    const basis = costBasis({ basis: row.basis } as CostEvidence);
    const key = JSON.stringify([provider, model, basis]);
    const group = groups.get(key) ?? { provider, model, basis, usd: '', count: 0, micros: 0 };
    group.micros = addMicros(group.micros, usdDecimalToMicros(row.usd ?? '0'));
    group.count += safeCount(row.count);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => {
      if (a.micros !== b.micros) return a.micros > b.micros ? -1 : 1;
      const providerOrder = compareEvidenceDimension(a.provider, b.provider);
      if (providerOrder !== 0) return providerOrder;
      const modelOrder = compareEvidenceDimension(a.model, b.model);
      return modelOrder || (a.basis < b.basis ? -1 : a.basis > b.basis ? 1 : 0);
    })
    .map(({ micros, ...row }) => ({ ...row, usd: microsToUsd(micros).toFixed(6) }));
}

/** Load the cost-governance dashboard as a stable presentation contract. */
export async function getCostsDashboard(db: Db, modelEvidenceAt?: Date): Promise<CostsDashboard> {
  const agent = await getAgent(db);
  const monthStart = sql`date_trunc('month', now())`;
  const modelEvidenceClock = modelEvidenceAt
    ? sql`${modelEvidenceAt.toISOString()}::timestamptz`
    : sql`now()`;
  const modelUtcMonth = sql`date_trunc('month', timezone('UTC', ${modelEvidenceClock}))`;
  const modelMonthStart = sql`${modelUtcMonth} AT TIME ZONE 'UTC'`;
  const modelMonthEnd = sql`(${modelUtcMonth} + interval '1 month') AT TIME ZONE 'UTC'`;
  const [totals, bySource, byModel, topTasks, held, recent, [parkedCount], [taskDefault]] =
    await Promise.all([
      costTotals(db),
      db
        .select({
          source: costEvents.source,
          usd: sum(costEvents.usd),
          count: sql<number>`count(*)`,
        })
        .from(costEvents)
        .where(gte(costEvents.createdAt, monthStart))
        .groupBy(costEvents.source)
        .orderBy(desc(sum(costEvents.usd))),
      db
        .select({
          model: modelCalls.model,
          usd: sum(modelCalls.costUsd),
          count: sql<number>`count(*)`,
        })
        .from(modelCalls)
        .where(gte(modelCalls.createdAt, monthStart))
        .groupBy(modelCalls.model)
        .orderBy(desc(sum(modelCalls.costUsd))),
      db
        .select({
          taskId: costEvents.taskId,
          usd: sum(costEvents.usd),
          type: tasks.type,
          progress: tasks.progress,
        })
        .from(costEvents)
        .innerJoin(tasks, eq(tasks.id, costEvents.taskId))
        .where(gte(costEvents.createdAt, monthStart))
        .groupBy(costEvents.taskId, tasks.type, tasks.progress)
        .orderBy(desc(sum(costEvents.usd)))
        .limit(10),
      db
        .select({
          id: costReservations.id,
          source: costReservations.source,
          description: costReservations.description,
          estimatedUsd: costReservations.estimatedUsd,
        })
        .from(costReservations)
        .where(eq(costReservations.status, 'held'))
        .orderBy(desc(costReservations.createdAt)),
      db
        .select({
          id: costEvents.id,
          createdAt: costEvents.createdAt,
          source: costEvents.source,
          description: costEvents.description,
          usd: costEvents.usd,
          evidence: costEvents.evidence,
        })
        .from(costEvents)
        .orderBy(desc(costEvents.createdAt))
        .limit(15),
      db
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(eq(tasks.status, 'waiting_budget')),
      db
        .select({ limitUsd: budgets.limitUsd })
        .from(budgets)
        .where(eq(budgets.scope, 'task_default')),
    ]);

  const providerExpression = sql<
    string | null
  >`case when jsonb_typeof(${costEvents.evidence}->'provider') = 'string' then nullif(btrim(${costEvents.evidence}->>'provider'), '') else null end`;
  const modelExpression = sql<
    string | null
  >`case when jsonb_typeof(${costEvents.evidence}->'model') = 'string' then nullif(btrim(${costEvents.evidence}->>'model'), '') else null end`;
  const basisExpression = sql<
    string | null
  >`case when jsonb_typeof(${costEvents.evidence}->'basis') = 'string' then ${costEvents.evidence}->>'basis' else null end`;
  const [evidenceRows, modelEvidenceRawRows, [dispatchingReservations], [unknownReservations]] =
    await Promise.all([
      db
        .select({
          basis: sql<string>`${costEvents.evidence}->>'basis'`,
          usd: sum(costEvents.usd),
          count: sql<number>`count(*)`,
        })
        .from(costEvents)
        .where(gte(costEvents.createdAt, monthStart))
        .groupBy(sql`${costEvents.evidence}->>'basis'`),
      db
        .select({
          provider: providerExpression,
          model: modelExpression,
          basis: basisExpression,
          usd: sum(costEvents.usd),
          // postgres-js returns int8 as a decimal string unless explicitly configured otherwise.
          count: sql<string>`count(*)`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.source, 'model'),
            gte(costEvents.createdAt, modelMonthStart),
            lt(costEvents.createdAt, modelMonthEnd),
          ),
        )
        .groupBy(providerExpression, modelExpression, basisExpression),
      db
        .select({ count: count(), estimatedUsd: sum(costReservations.estimatedUsd) })
        .from(costReservations)
        .where(eq(costReservations.status, 'dispatching')),
      db
        .select({ count: count(), estimatedUsd: sum(costReservations.estimatedUsd) })
        .from(costReservations)
        .where(eq(costReservations.status, 'unknown')),
    ]);

  return {
    byEvidence: evidenceRows.map((row) => ({
      basis: costBasis({ basis: row.basis } as CostEvidence),
      usd: row.usd ?? '0',
      count: Number(row.count),
    })),
    byModelEvidence: modelEvidenceRows(modelEvidenceRawRows),
    dispatchingAttempts: {
      count: Number(dispatchingReservations?.count ?? 0),
      countComplete: true,
      estimatedUsd: dispatchingReservations?.estimatedUsd ?? '0.000000',
      estimateComplete: true,
    },
    unknownAttempts: {
      count: Number(unknownReservations?.count ?? 0),
      countComplete: true,
      estimatedUsd: unknownReservations?.estimatedUsd ?? '0.000000',
      estimateComplete: true,
    },
    timezone: agent.timezone,
    totals,
    bySource,
    byModel,
    topTasks,
    held,
    recent,
    parkedTasks: Number(parkedCount?.count ?? 0),
    taskDefaultLimit: taskDefault?.limitUsd ?? null,
  };
}

export { type BudgetCaps, normalizeBudgetCaps } from '@assistant/persistence';

export function updateBudgetCapsWithRepository(
  repository: BudgetCapsRepository,
  agentId: string,
  values: Partial<Record<'task_default' | 'daily' | 'monthly', string>>,
): Promise<void> {
  const normalized = normalizeBudgetCaps(values);
  if (normalized.error) throw new Error(normalized.error);
  return repository.update(agentId, normalized.caps ?? {});
}

export async function updateBudgetCaps(
  db: Db,
  values: Partial<Record<'task_default' | 'daily' | 'monthly', string>>,
): Promise<void> {
  const normalized = normalizeBudgetCaps(values);
  if (normalized.error) throw new Error(normalized.error);
  await db.transaction(async (tx) => {
    for (const [scope, limitUsd] of Object.entries(normalized.caps ?? {})) {
      await tx
        .update(budgets)
        .set({ limitUsd, updatedAt: sql`now()` })
        .where(eq(budgets.scope, scope));
    }
  });
}
