import { getAgent } from '@assistant/core/chat';
import { type CostTotals, costTotals } from '@assistant/core/cost';
import { budgets, costEvents, costReservations, type Db, modelCalls, tasks } from '@assistant/db';
import {
  type BudgetCapsRepository,
  type CostEvidence,
  type CostEvidenceTotal,
  costBasis,
  normalizeBudgetCaps,
} from '@assistant/persistence';
import { desc, eq, gte, sql, sum } from 'drizzle-orm';

export interface CostsDashboard {
  byEvidence: CostEvidenceTotal[];
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

/** Load the cost-governance dashboard as a stable presentation contract. */
export async function getCostsDashboard(db: Db): Promise<CostsDashboard> {
  const agent = await getAgent(db);
  const monthStart = sql`date_trunc('month', now())`;
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

  const evidenceRows = await db
    .select({
      basis: sql<string>`${costEvents.evidence}->>'basis'`,
      usd: sum(costEvents.usd),
      count: sql<number>`count(*)`,
    })
    .from(costEvents)
    .where(gte(costEvents.createdAt, monthStart))
    .groupBy(sql`${costEvents.evidence}->>'basis'`);

  return {
    byEvidence: evidenceRows.map((row) => ({
      basis: costBasis({ basis: row.basis } as CostEvidence),
      usd: row.usd ?? '0',
      count: Number(row.count),
    })),
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
