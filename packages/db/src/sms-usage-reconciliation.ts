import { randomUUID } from 'node:crypto';
import {
  assertLedgerMicros,
  type CostEvidence,
  ledgerUsdToMicros,
  type SmsUsageReconciliationClaim,
  type SmsUsageReconciliationOutcome,
  storedLedgerUsdToMicros,
} from '@assistant/persistence';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { costEvents, costReservations, tasks, toolCalls } from './schema.js';

const MAX_BATCH = 50;
const LEASE_MS = 5 * 60_000;

function safeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH)
    throw new Error(`SMS usage reconciliation batch must be between 1 and ${MAX_BATCH}`);
  return limit;
}

async function lockCostLedger(db: Db): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext('assistant:cost-reservations'))`);
}

export async function claimPostgresSmsUsage(
  db: Db,
  now: Date,
  limit: number,
): Promise<SmsUsageReconciliationClaim[]> {
  const bounded = safeLimit(limit);
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.source, 'twilio_sms'),
          sql`${costEvents.evidence}->>'provider' = 'twilio'`,
          sql`${costEvents.evidence}->'smsUsageReconciliation'->>'status' = 'pending'`,
          sql`coalesce((${costEvents.evidence}->'smsUsageReconciliation'->>'nextAttemptAt')::timestamptz, 'epoch'::timestamptz) <= ${now.toISOString()}::timestamptz`,
          sql`${costEvents.evidence}->'sms'->>'providerMessageId' IS NOT NULL`,
        ),
      )
      .orderBy(asc(costEvents.createdAt))
      .limit(bounded)
      .for('update', { skipLocked: true });
    const claims: SmsUsageReconciliationClaim[] = [];
    for (const row of rows) {
      const evidence = row.evidence as CostEvidence;
      const state = evidence.smsUsageReconciliation;
      const providerMessageId = evidence.sms?.providerMessageId;
      if (state?.status !== 'pending' || !providerMessageId) continue;
      const claimToken = randomUUID();
      const attempts = state.attempts + 1;
      const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
      const nextEvidence: CostEvidence = {
        ...evidence,
        smsUsageReconciliation: {
          status: 'pending',
          attempts,
          nextAttemptAt: leaseUntil,
          claimToken,
          leaseUntil,
        },
      };
      await tx.update(costEvents).set({ evidence: nextEvidence }).where(eq(costEvents.id, row.id));
      claims.push({
        eventId: row.id,
        claimToken,
        providerMessageId,
        attempts,
        createdAt: row.createdAt,
        taskId: row.taskId,
        reservationId: row.reservationId,
        currentUsd: Number(row.usd),
        currentQuantity: row.quantity === null ? null : Number(row.quantity),
        currentUnitPriceUsd: row.unitPriceUsd === null ? null : Number(row.unitPriceUsd),
        evidence: nextEvidence,
      });
    }
    return claims;
  });
}

export async function settlePostgresSmsUsage(
  db: Db,
  claim: SmsUsageReconciliationClaim,
  outcome: SmsUsageReconciliationOutcome,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockCostLedger(tx as unknown as Db);
    const [row] = await tx
      .select()
      .from(costEvents)
      .where(eq(costEvents.id, claim.eventId))
      .for('update');
    if (!row) return false;
    const evidence = row.evidence as CostEvidence;
    const state = evidence.smsUsageReconciliation;
    if (state?.status !== 'pending' || state.claimToken !== claim.claimToken) return false;

    if (outcome.kind !== 'complete') {
      const exhausted = outcome.kind === 'exhausted';
      const nextEvidence: CostEvidence = {
        ...evidence,
        smsUsageReconciliation: {
          status: exhausted ? 'exhausted' : 'pending',
          attempts: state.attempts,
          ...(exhausted ? {} : { nextAttemptAt: outcome.nextAttemptAt.toISOString() }),
          ...(outcome.error ? { lastError: outcome.error.slice(0, 240) } : {}),
        },
      };
      await tx.update(costEvents).set({ evidence: nextEvidence }).where(eq(costEvents.id, row.id));
      return true;
    }

    if (!Number.isInteger(outcome.billedSegments) || outcome.billedSegments < 1)
      throw new Error('Twilio usage reported an invalid segment count');
    if (!Number.isFinite(outcome.priceUsd) || outcome.priceUsd < 0)
      throw new Error('Twilio usage reported an invalid price');
    const smsReceipt = evidence.sms;
    if (!smsReceipt) return false;

    const oldMicros = storedLedgerUsdToMicros(row.usd);
    const newMicros = ledgerUsdToMicros(outcome.priceUsd);
    const deltaMicros = newMicros - oldMicros;
    const newUsd = newMicros / 1_000_000;
    const deltaUsd = deltaMicros / 1_000_000;
    if (row.taskId && deltaMicros !== 0) {
      const [task] = await tx
        .select({ spentUsd: tasks.spentUsd })
        .from(tasks)
        .where(eq(tasks.id, row.taskId));
      if (task) assertLedgerMicros(storedLedgerUsdToMicros(task.spentUsd) + deltaMicros);
    }
    const unitPriceUsd = outcome.priceUsd / outcome.billedSegments;
    const nextEvidence: CostEvidence = {
      ...evidence,
      basis: 'provider_reported',
      sms: {
        ...smsReceipt,
        billedSegments: outcome.billedSegments,
        providerPriceUsd: outcome.priceUsd,
      },
      smsUsageReconciliation: { status: 'complete', attempts: state.attempts },
    };
    await tx
      .update(costEvents)
      .set({
        evidence: nextEvidence,
        quantity: outcome.billedSegments.toFixed(4),
        unit: 'segment',
        unitPriceUsd: unitPriceUsd.toFixed(8),
        usd: newUsd.toFixed(6),
      })
      .where(eq(costEvents.id, row.id));
    if (row.reservationId) {
      await tx
        .update(costReservations)
        .set({ actualUsd: newUsd.toFixed(6) })
        .where(eq(costReservations.id, row.reservationId));
    }
    if (row.toolCallId && evidence.sms) {
      await tx
        .update(toolCalls)
        .set({
          result: sql`jsonb_set(coalesce(${toolCalls.result}, '{}'::jsonb), '{smsAccounting}', ${JSON.stringify(nextEvidence.sms)}::jsonb, true)`,
        })
        .where(eq(toolCalls.id, row.toolCallId));
    }
    if (row.taskId && deltaUsd !== 0) {
      await tx
        .update(tasks)
        .set({
          spentUsd: sql`${tasks.spentUsd} + ${deltaUsd.toFixed(6)}::numeric`,
          updatedAt: sql`now()`,
        })
        .where(eq(tasks.id, row.taskId));
    }
    return true;
  });
}
