import {
  type BudgetCaps,
  type BudgetRetry,
  budgetWakeScheduleId,
  budgetWakeScheduleIsCurrent,
  canWakeForBudget,
  readBudgetRetry,
  readBudgetWakeCursor,
  storedLedgerUsdToMicros,
  storedTaskBudgetToMicros,
  storedUsdToMicros,
  type TaskWake,
} from '@assistant/persistence';
import { and, asc, eq, getTableColumns, gt, inArray, isNull, or, sql, sum } from 'drizzle-orm';
import type { Db } from './client.js';
import { costTotals, lockCostLedger } from './cost-repository.js';
import { assertPostgresInstallationOwner } from './installation-owner.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import {
  approvals,
  budgets,
  costReservations,
  maintenanceCursors,
  schedules,
  tasks,
} from './schema.js';

const cursorPrefix = 'budget-cap-wake:';
export async function resumePostgresBudgetWakes(db: Db): Promise<TaskWake[]> {
  const owner = await assertPostgresInstallationOwner(db);
  const [cursor] = await db
    .select({ name: maintenanceCursors.name })
    .from(maintenanceCursors)
    .where(eq(maintenanceCursors.name, cursorPrefix + owner));
  return cursor ? updatePostgresBudgetCaps(db, {}) : [];
}

export function updatePostgresBudgetCaps(db: Db, values: BudgetCaps): Promise<TaskWake[]> {
  return db.transaction(async (tx) => {
    const store = tx as unknown as Db;
    const owner = await assertPostgresInstallationOwner(store);
    await lockPostgresPrivacyObservationFence(tx, owner);
    await lockCostLedger(store);
    const prior = await costTotals(store);
    const cursorName = cursorPrefix + owner;
    const [cursor] = await tx
      .select()
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, cursorName))
      .for('update');
    for (const [scope, limitUsd] of Object.entries(values)) {
      await tx
        .update(budgets)
        .set({ limitUsd, updatedAt: sql`now()` })
        .where(eq(budgets.scope, scope));
    }

    const dailyCap = values.daily === undefined ? prior.dailyLimitUsd : Number(values.daily);
    const monthlyCap =
      values.monthly === undefined ? prior.monthlyLimitUsd : Number(values.monthly);
    const raised: BudgetRetry['scope'][] = [];
    if (dailyCap > prior.dailyLimitUsd) raised.push('daily');
    if (monthlyCap > prior.monthlyLimitUsd) raised.push('monthly');
    const previousCursor = readBudgetWakeCursor(cursor?.cursor);
    const scopes = new Set([...raised, ...(previousCursor?.scopes ?? [])]);
    if (!scopes.size) {
      if (cursor)
        await tx.delete(maintenanceCursors).where(eq(maintenanceCursors.name, cursorName));
      return [];
    }
    const after = raised.length ? undefined : previousCursor?.after;
    const rows = await tx
      .select({ ...getTableColumns(tasks), cursorTime: sql<string>`${tasks.updatedAt}::text` })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, owner),
          eq(tasks.status, 'waiting_budget'),
          gt(tasks.runAfter, sql`now()`),
          isNull(tasks.archivedAt),
          after
            ? sql`(${tasks.updatedAt}, ${tasks.id}::text) > (${after.updatedAt}::timestamptz, ${after.id})`
            : undefined,
        ),
      )
      .orderBy(asc(tasks.updatedAt), asc(tasks.id))
      .limit(101);
    const page = rows.slice(0, 100);
    const last = page.at(-1);
    if (rows.length > 100 && last) {
      const cursor = JSON.stringify({
        scopes: [...scopes],
        after: { updatedAt: last.cursorTime, id: last.id },
      });
      await tx
        .insert(maintenanceCursors)
        .values({ name: cursorName, cursor })
        .onConflictDoUpdate({
          target: maintenanceCursors.name,
          set: { cursor, updatedAt: sql`now()` },
        });
    } else if (cursor) {
      await tx.delete(maintenanceCursors).where(eq(maintenanceCursors.name, cursorName));
    }
    const eligible: TaskWake[] = [];
    const limitMicros = (usd: number) =>
      Number.isFinite(usd) ? storedUsdToMicros(usd) : Number.MAX_SAFE_INTEGER;
    for (const row of page) {
      const retry = readBudgetRetry(row.state);
      if (!retry || !scopes.has(retry.scope)) continue;
      const [[taskHeld], pending] = await Promise.all([
        tx
          .select({ usd: sum(costReservations.estimatedUsd) })
          .from(costReservations)
          .where(
            and(
              eq(costReservations.taskId, row.id),
              inArray(costReservations.status, ['held', 'dispatching', 'unknown']),
            ),
          ),
        tx
          .select({ id: approvals.id })
          .from(approvals)
          .where(and(eq(approvals.taskId, row.id), eq(approvals.status, 'pending')))
          .limit(1),
      ]);
      if (pending.length) continue;
      const scheduleId = budgetWakeScheduleId(row.trigger);
      if (scheduleId) {
        const [schedule] = await tx
          .select()
          .from(schedules)
          .where(and(sql`${schedules.id}::text = ${scheduleId}`, eq(schedules.agentId, owner)))
          .for('share');
        if (!schedule || !budgetWakeScheduleIsCurrent(schedule)) continue;
      }
      if (
        canWakeForBudget(retry, {
          dailyCap: limitMicros(dailyCap),
          monthlyCap: limitMicros(monthlyCap),
          dailySpent: storedUsdToMicros(prior.dailySpentUsd),
          monthlySpent: storedUsdToMicros(prior.monthlySpentUsd),
          dailyHeld: storedUsdToMicros(prior.dailyHeldUsd ?? prior.heldUsd),
          monthlyHeld: storedUsdToMicros(prior.monthlyHeldUsd ?? prior.heldUsd),
          taskSpent: storedLedgerUsdToMicros(row.spentUsd),
          taskHeld: storedUsdToMicros(taskHeld?.usd ?? '0'),
          taskCap: storedTaskBudgetToMicros(row.budgetUsdLimit),
        })
      )
        eligible.push({ id: row.id, queueGeneration: row.queueGeneration });
    }
    if (!eligible.length) return [];
    return tx
      .update(tasks)
      .set({
        status: 'pending',
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        queueGeneration: sql`${tasks.queueGeneration} + 1`,
        attempt: 0,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(tasks.agentId, owner),
          eq(tasks.status, 'waiting_budget'),
          gt(tasks.runAfter, sql`now()`),
          isNull(tasks.archivedAt),
          or(
            ...eligible.map(({ id, queueGeneration }) =>
              and(eq(tasks.id, id), eq(tasks.queueGeneration, queueGeneration)),
            ),
          ),
        ),
      )
      .returning({ id: tasks.id, queueGeneration: tasks.queueGeneration });
  });
}
