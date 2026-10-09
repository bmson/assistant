import { createHash } from 'node:crypto';
import {
  addLedgerMicros,
  type CostRepository,
  DEFAULT_RATES,
  ledgerUsdToMicros,
  MAX_LEDGER_USD_MICROS,
  microsToUsd,
  nextDailyReset,
  nextMonthlyReset,
  storedLedgerUsdToMicros,
  storedTaskBudgetToMicros,
} from '@assistant/persistence';
import { and, eq, gte, inArray, sql, sum } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  budgets,
  costEvents,
  costReservations,
  rateTable,
  type SpendSource,
  tasks,
} from './schema.js';

export async function getRate(
  db: Db,
  key: string,
): Promise<{ unit: string; unitPriceUsd: number }> {
  const [row] = await db.select().from(rateTable).where(eq(rateTable.key, key));
  if (row) return { unit: row.unit, unitPriceUsd: Number(row.unitPriceUsd) };
  const fallback = DEFAULT_RATES[key];
  if (!fallback) throw new Error(`no rate for key: ${key}`);
  return fallback;
}

export interface CostEventInput {
  evidence?: import('@assistant/persistence').CostEvidence;
  source: SpendSource;
  usd: number;
  taskId?: string | null;
  toolCallId?: string | null;
  quantity?: number;
  unit?: string;
  unitPriceUsd?: number;
  description?: string;
  reservationId?: string;
  idempotencyKey?: string;
  /** Also add usd to tasks.spent_usd (skip when the caller meters that itself). */
  addToTaskSpend?: boolean;
}

/**
 * Every mutation that moves money into or out of the held/spent totals takes
 * this transaction-scoped lock. Without it, a reservation check could read
 * spend before a reconciliation commits and held reservations afterward,
 * briefly counting the same provider call as neither held nor spent.
 */
async function lockCostLedger(db: Db): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext('assistant:cost-reservations'))`);
}

async function writeCostEvent(db: Db, input: CostEventInput): Promise<boolean> {
  const amountMicros = ledgerUsdToMicros(input.usd);
  const amountUsd = microsToUsd(amountMicros);
  const amountDecimal = amountUsd.toFixed(6);
  const values = {
    evidence: input.evidence ?? { basis: 'unknown' },
    source: input.source,
    taskId: input.taskId ?? undefined,
    toolCallId: input.toolCallId ?? undefined,
    quantity: input.quantity !== undefined ? input.quantity.toFixed(4) : undefined,
    unit: input.unit,
    unitPriceUsd: input.unitPriceUsd !== undefined ? input.unitPriceUsd.toFixed(8) : undefined,
    usd: amountDecimal,
    description: input.description ?? '',
    reservationId: input.reservationId,
    idempotencyKey: input.idempotencyKey,
  };
  const inserted = input.idempotencyKey
    ? await db
        .insert(costEvents)
        .values(values)
        .onConflictDoNothing({
          target: costEvents.idempotencyKey,
          where: sql`${costEvents.idempotencyKey} IS NOT NULL`,
        })
        .returning({ id: costEvents.id })
    : await db.insert(costEvents).values(values).returning({ id: costEvents.id });
  if (input.idempotencyKey && inserted.length === 0) {
    const [existing] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (
      !existing ||
      existing.source !== input.source ||
      existing.taskId !== (input.taskId ?? null) ||
      Number(existing.usd).toFixed(6) !== amountDecimal ||
      existing.description !== (input.description ?? '') ||
      existing.unit !== (input.unit ?? null) ||
      Number(existing.quantity ?? 0).toFixed(4) !== (input.quantity ?? 0).toFixed(4) ||
      Number(existing.unitPriceUsd ?? 0).toFixed(8) !== (input.unitPriceUsd ?? 0).toFixed(8)
    )
      throw new Error('Cost event idempotency key was reused for different content');
  }
  if (inserted.length && input.addToTaskSpend && input.taskId && amountMicros > 0) {
    const [task] = await db
      .select({ spentUsd: tasks.spentUsd })
      .from(tasks)
      .where(eq(tasks.id, input.taskId));
    if (task) addLedgerMicros(storedLedgerUsdToMicros(task.spentUsd), amountMicros);
    await db
      .update(tasks)
      .set({ spentUsd: sql`${tasks.spentUsd} + ${amountDecimal}`, updatedAt: sql`now()` })
      .where(eq(tasks.id, input.taskId));
  }
  return inserted.length > 0;
}

/** Write the global ledger and per-task counter as one atomic operation. */
export async function recordCostEvent(db: Db, input: CostEventInput): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCostLedger(tx as unknown as Db);
    await writeCostEvent(tx as unknown as Db, input);
  });
}

export interface CostTotals {
  dailySpentUsd: number;
  monthlySpentUsd: number;
  /** Estimated USD currently held by unreconciled reservations. */
  heldUsd: number;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
  softPct: number;
}

/** Spend + holds vs caps — the shared snapshot for the router guard, reservations, and the dashboard. */
export async function costTotals(db: Db): Promise<CostTotals> {
  const [limits, [daily], [monthly], [held]] = await Promise.all([
    db.select().from(budgets),
    db
      .select({ total: sum(costEvents.usd) })
      .from(costEvents)
      .where(gte(costEvents.createdAt, sql`date_trunc('day', now())`)),
    db
      .select({ total: sum(costEvents.usd) })
      .from(costEvents)
      .where(gte(costEvents.createdAt, sql`date_trunc('month', now())`)),
    db
      .select({ total: sum(costReservations.estimatedUsd) })
      .from(costReservations)
      .where(inArray(costReservations.status, ['held', 'dispatching', 'unknown'])),
  ]);
  const limitFor = (scope: string) =>
    Number(limits.find((b) => b.scope === scope)?.limitUsd ?? Number.POSITIVE_INFINITY);

  return {
    dailySpentUsd: Number(daily?.total ?? 0),
    monthlySpentUsd: Number(monthly?.total ?? 0),
    heldUsd: Number(held?.total ?? 0),
    dailyLimitUsd: limitFor('daily'),
    monthlyLimitUsd: limitFor('monthly'),
    softPct: limits.find((b) => b.scope === 'daily')?.softPct ?? 80,
  };
}

export type ReserveOutcome =
  | { ok: true; reservationId: string }
  | { ok: false; reason: string; resumeAt: Date };

/**
 * Pre-flight reservation against the ceiling hierarchy (monthly > daily >
 * task). Insufficient remaining budget anywhere → not ok, with the period
 * reset time the caller should park until.
 */
export async function reserveCost(
  db: Db,
  input: {
    source: SpendSource;
    estimatedUsd: number;
    taskId?: string;
    description?: string;
    /** Owner reply model calls may use the bounded 10% global carve-out. */
    critical?: boolean;
    operationId?: string;
  },
): Promise<ReserveOutcome> {
  const estimateMicros = ledgerUsdToMicros(input.estimatedUsd);
  const estimateUsd = microsToUsd(estimateMicros);
  const estimateDecimal = estimateUsd.toFixed(6);
  if (estimateMicros <= 0) {
    throw new Error('cost reservation estimate must be a positive finite number');
  }

  // All reservations share one transaction-scoped advisory lock. This turns
  // the previous check-then-insert race into a serializable budget decision
  // without holding row locks across provider/network calls.
  return db.transaction(async (tx) => {
    await lockCostLedger(tx as unknown as Db);
    const stableHex = input.operationId
      ? createHash('sha256').update(input.operationId).digest('hex').slice(0, 32)
      : undefined;
    const stableId = stableHex
      ? `${stableHex.slice(0, 8)}-${stableHex.slice(8, 12)}-${stableHex.slice(12, 16)}-${stableHex.slice(16, 20)}-${stableHex.slice(20)}`
      : undefined;
    if (stableId) {
      const [existing] = await tx
        .select()
        .from(costReservations)
        .where(eq(costReservations.id, stableId));
      if (existing) {
        if (
          existing.source !== input.source ||
          existing.estimatedUsd !== estimateDecimal ||
          existing.taskId !== (input.taskId ?? null) ||
          existing.description !== (input.description ?? '')
        ) {
          throw new Error('Reservation ID reused for different work');
        }
        return existing.status === 'held'
          ? ({ ok: true, reservationId: existing.id } as const)
          : ({
              ok: false,
              reason: 'reservation already closed; do not repeat provider work',
              resumeAt: nextDailyReset(),
            } as const);
      }
    }
    const totals = await costTotals(tx as unknown as Db);
    const committed = totals.heldUsd + estimateUsd;
    const globalLimitFactor = input.critical ? 1.1 : 1;
    const monthlyCeiling = totals.monthlyLimitUsd * globalLimitFactor;
    const dailyCeiling = totals.dailyLimitUsd * globalLimitFactor;

    if (totals.monthlySpentUsd + committed > monthlyCeiling) {
      return {
        ok: false,
        reason: `monthly budget cannot cover this (spent $${totals.monthlySpentUsd.toFixed(2)} + held $${totals.heldUsd.toFixed(2)} + est $${estimateUsd.toFixed(2)} > cap $${monthlyCeiling.toFixed(2)}${input.critical ? ' including owner-reply carve-out' : ''})`,
        resumeAt: nextMonthlyReset(),
      } as const;
    }
    if (totals.dailySpentUsd + committed > dailyCeiling) {
      return {
        ok: false,
        reason: `daily budget cannot cover this (spent $${totals.dailySpentUsd.toFixed(2)} + held $${totals.heldUsd.toFixed(2)} + est $${estimateUsd.toFixed(2)} > cap $${dailyCeiling.toFixed(2)}${input.critical ? ' including owner-reply carve-out' : ''})`,
        resumeAt: nextDailyReset(),
      } as const;
    }
    if (input.taskId) {
      const [[task], [taskHeld]] = await Promise.all([
        tx
          .select({ limit: tasks.budgetUsdLimit, spent: tasks.spentUsd })
          .from(tasks)
          .where(eq(tasks.id, input.taskId)),
        tx
          .select({ total: sum(costReservations.estimatedUsd) })
          .from(costReservations)
          .where(
            and(
              eq(costReservations.taskId, input.taskId),
              inArray(costReservations.status, ['held', 'dispatching', 'unknown']),
            ),
          ),
      ]);
      const heldForTask = Number(taskHeld?.total ?? 0);
      const taskSpendMicros = storedLedgerUsdToMicros(task?.spent ?? '0');
      const taskHeldMicros = storedLedgerUsdToMicros(taskHeld?.total ?? '0');
      if (taskSpendMicros + taskHeldMicros + estimateMicros > MAX_LEDGER_USD_MICROS) {
        return {
          ok: false,
          reason: 'task ledger storage capacity cannot cover this reservation',
          resumeAt: nextDailyReset(),
        } as const;
      }
      // Critical owner replies (final chat/SMS/email delivery) get the same
      // bounded carve-out on the per-task cap as on the global caps — otherwise
      // a task that finished just under its own budget could block delivering
      // the answer it already produced, and the task would wrongly dead-letter.
      const taskCeiling = Number(task?.limit ?? 0) * globalLimitFactor;
      if (
        task &&
        taskSpendMicros + taskHeldMicros + estimateMicros >
          Math.floor(storedTaskBudgetToMicros(task.limit ?? '0') * globalLimitFactor)
      ) {
        return {
          ok: false,
          reason: `task budget cannot cover this (spent $${Number(task.spent).toFixed(4)} + held $${heldForTask.toFixed(4)} + est $${estimateUsd.toFixed(4)} > cap $${taskCeiling.toFixed(4)}${input.critical ? ' including owner-reply carve-out' : ''})`,
          resumeAt: nextDailyReset(),
        } as const;
      }
    }

    const [row] = await tx
      .insert(costReservations)
      .values({
        taskId: input.taskId,
        source: input.source,
        ...(stableId ? { id: stableId } : {}),
        estimatedUsd: estimateDecimal,
        description: input.description ?? '',
      })
      .returning({ id: costReservations.id });
    if (!row) throw new Error('reservation insert failed');
    return { ok: true, reservationId: row.id } as const;
  });
}

/** Persist the dispatch boundary before provider network work begins. */
export async function beginCostAttempt(
  db: Db,
  reservationId: string,
  metadata: import('@assistant/persistence').CostAttemptMetadata,
): Promise<boolean> {
  const [row] = await db
    .update(costReservations)
    .set({ status: 'dispatching', attemptStartedAt: sql`now()`, attemptMetadata: metadata })
    .where(and(eq(costReservations.id, reservationId), eq(costReservations.status, 'held')))
    .returning({ id: costReservations.id });
  return Boolean(row);
}

/** Preserve the estimated hold as an unknown liability until actual usage arrives. */
export async function markCostAttemptUnknown(
  db: Db,
  reservationId: string,
  reason: string,
  providerReceipt?: { requestId?: string; endpoint?: string },
): Promise<void> {
  await db
    .update(costReservations)
    .set({
      status: 'unknown',
      unknownReason: reason.slice(0, 500),
      ...(providerReceipt
        ? {
            attemptMetadata: sql`coalesce(${costReservations.attemptMetadata}, '{}'::jsonb) || ${JSON.stringify(providerReceipt)}::jsonb`,
          }
        : {}),
    })
    .where(
      and(
        eq(costReservations.id, reservationId),
        inArray(costReservations.status, ['dispatching', 'unknown']),
      ),
    );
}

/** Reconcile a held reservation to actuals: release the hold, write the ledger row. */
export async function reconcileReservation(
  db: Db,
  reservationId: string,
  actual: {
    evidence?: import('@assistant/persistence').CostEvidence;
    usd: number;
    quantity?: number;
    unit?: string;
    unitPriceUsd?: number;
    toolCallId?: string;
    description?: string;
  },
): Promise<void> {
  const actualMicros = ledgerUsdToMicros(actual.usd);
  const actualUsd = microsToUsd(actualMicros);
  const actualDecimal = actualUsd.toFixed(6);
  await db.transaction(async (tx) => {
    await lockCostLedger(tx as unknown as Db);
    const [reservation] = await tx
      .update(costReservations)
      .set({
        status: 'reconciled',
        actualUsd: actualDecimal,
        reconciledAt: sql`now()`,
      })
      .where(
        and(
          eq(costReservations.id, reservationId),
          inArray(costReservations.status, ['held', 'dispatching', 'unknown']),
        ),
      )
      .returning();
    if (!reservation) return; // another reconciler/releaser already won

    await writeCostEvent(tx as unknown as Db, {
      evidence: actual.evidence,
      source: reservation.source as SpendSource,
      usd: actualUsd,
      taskId: reservation.taskId,
      toolCallId: actual.toolCallId,
      quantity: actual.quantity,
      unit: actual.unit,
      unitPriceUsd: actual.unitPriceUsd,
      description: actual.description ?? reservation.description,
      reservationId,
      addToTaskSpend: true,
    });
  });
}

/** Drop a hold without a ledger entry (the action never ran). */
export async function releaseReservation(db: Db, reservationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCostLedger(tx as unknown as Db);
    await tx
      .update(costReservations)
      .set({ status: 'released', reconciledAt: sql`now()` })
      .where(and(eq(costReservations.id, reservationId), eq(costReservations.status, 'held')));
  });
}

/**
 * Crash backstop for reservations whose process disappeared before it could
 * reconcile/release them. The normal browser/model deadlines are <=15 minutes;
 * two hours leaves ample room for provider callbacks without letting one dead
 * hold disable the assistant indefinitely.
 */
export async function releaseStaleReservations(
  db: Db,
  olderThanMinutes = 120,
  batch = 500,
): Promise<number> {
  return db.transaction(async (tx) => {
    await lockCostLedger(tx as unknown as Db);
    const stale = tx
      .select({ id: costReservations.id })
      .from(costReservations)
      .where(
        and(
          eq(costReservations.status, 'held'),
          sql`${costReservations.createdAt} < now() - (${olderThanMinutes} * interval '1 minute')`,
          sql`NOT EXISTS (
            SELECT 1 FROM call_sessions
            WHERE call_sessions.reservation_id = ${costReservations.id}::text
              AND call_sessions.finish_delivery->'costs'->>'done' = 'false'
          )`,
        ),
      )
      .orderBy(costReservations.createdAt)
      .limit(batch);
    const released = await tx
      .update(costReservations)
      .set({ status: 'released', reconciledAt: sql`now()` })
      .where(inArray(costReservations.id, stale))
      .returning({ id: costReservations.id });
    const staleDispatches = await tx
      .select({ id: costReservations.id })
      .from(costReservations)
      .where(
        and(
          eq(costReservations.status, 'dispatching'),
          sql`${costReservations.attemptStartedAt} < now() - (${olderThanMinutes} * interval '1 minute')`,
        ),
      )
      .orderBy(costReservations.attemptStartedAt)
      .limit(batch);
    const unknown = staleDispatches.length
      ? await tx
          .update(costReservations)
          .set({
            status: 'unknown',
            unknownReason: 'provider dispatch exceeded reconciliation window',
          })
          .where(
            inArray(
              costReservations.id,
              staleDispatches.map((row) => row.id),
            ),
          )
          .returning({ id: costReservations.id })
      : [];
    return released.length + unknown.length;
  });
}

/** SQL implementation of the atomic cost port; callers never receive a transaction handle. */
export function createPostgresCostRepository(db: Db): CostRepository {
  return {
    kind: 'cost-repository',
    getRate: async (key) => {
      const [row] = await db.select().from(rateTable).where(eq(rateTable.key, key));
      return row ? { unit: row.unit, unitPriceUsd: Number(row.unitPriceUsd) } : null;
    },
    totals: () => costTotals(db),
    reserve: (input) => reserveCost(db, input),
    beginAttempt: (id, metadata) => beginCostAttempt(db, id, metadata),
    markAttemptUnknown: (id, reason, receipt) => markCostAttemptUnknown(db, id, reason, receipt),
    record: (input) => recordCostEvent(db, input),
    reconcile: (id, actual) => reconcileReservation(db, id, actual),
    release: (id) => releaseReservation(db, id),
    releaseStale: (age, batch) => releaseStaleReservations(db, age, batch),
  };
}
