import {
  assertLedgerMicros,
  type CostEvidence,
  ledgerUsdToMicros,
  microsToUsd,
  type Records,
  type SmsUsageReconciliationClaim,
  type SmsUsageReconciliationOutcome,
  storedLedgerUsdToMicros,
} from '@assistant/persistence';
import { decodeRecord, type InstallationStore } from './store.js';

const MAX_BATCH = 50;
const LEASE_MS = 5 * 60_000;

function safeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH)
    throw new Error(`SMS usage reconciliation batch must be between 1 and ${MAX_BATCH}`);
  return limit;
}

function adjustMicros(value: unknown, delta: number): number {
  const current = typeof value === 'number' ? value : 0;
  if (!Number.isSafeInteger(current) || current < 0) throw new Error('Invalid SMS ledger counter');
  const adjusted = current + delta;
  if (!Number.isSafeInteger(adjusted) || adjusted < 0)
    throw new Error('SMS usage correction would underflow a ledger counter');
  return adjusted;
}

export async function claimFirestoreSmsUsage(
  store: InstallationStore,
  now: Date,
  limit: number,
): Promise<SmsUsageReconciliationClaim[]> {
  const bounded = safeLimit(limit);
  const due = await store
    .collection('costEvents')
    .where('source', '==', 'twilio_sms')
    .where('evidence.provider', '==', 'twilio')
    .where('evidence.smsUsageReconciliation.status', '==', 'pending')
    .where('evidence.smsUsageReconciliation.nextAttemptAt', '<=', now.toISOString())
    .limit(bounded)
    .get();
  const claims: SmsUsageReconciliationClaim[] = [];
  for (const candidate of due.docs) {
    const claim = await store.db.runTransaction(
      async (tx): Promise<SmsUsageReconciliationClaim | null> => {
        const ref = candidate.ref;
        const current = await tx.get(ref);
        if (!current?.exists) return null;
        const row = decodeRecord<Records['costEvents']>(current.data());
        const state = row.evidence.smsUsageReconciliation;
        const providerMessageId = row.evidence.sms?.providerMessageId;
        if (
          row.source !== 'twilio_sms' ||
          row.evidence.provider !== 'twilio' ||
          state?.status !== 'pending' ||
          !state.nextAttemptAt ||
          Date.parse(state.nextAttemptAt) > now.getTime() ||
          !providerMessageId
        )
          return null;
        const claimToken = randomUUID();
        const attempts = state.attempts + 1;
        const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
        const evidence: CostEvidence = {
          ...row.evidence,
          smsUsageReconciliation: {
            status: 'pending',
            attempts,
            nextAttemptAt: leaseUntil,
            claimToken,
            leaseUntil,
          },
        };
        tx.update(ref, { evidence });
        return {
          eventId: row.id,
          claimToken,
          providerMessageId,
          attempts,
          createdAt: decodeRecord<Date>(row.createdAt),
          taskId: row.taskId,
          reservationId: row.reservationId,
          currentUsd: Number(row.usd),
          currentQuantity: row.quantity === null ? null : Number(row.quantity),
          currentUnitPriceUsd: row.unitPriceUsd === null ? null : Number(row.unitPriceUsd),
          evidence,
        };
      },
    );
    if (claim) claims.push(claim);
  }
  return claims;
}

export async function settleFirestoreSmsUsage(
  store: InstallationStore,
  claim: SmsUsageReconciliationClaim,
  outcome: SmsUsageReconciliationOutcome,
): Promise<boolean> {
  return store.db.runTransaction(async (tx) => {
    const eventRef = store.doc('costEvents', claim.eventId);
    const eventSnapshot = await tx.get(eventRef);
    if (!eventSnapshot?.exists) return false;
    const row = decodeRecord<Records['costEvents']>(eventSnapshot.data());
    const evidence = row.evidence;
    const state = evidence.smsUsageReconciliation;
    if (state?.status !== 'pending' || state.claimToken !== claim.claimToken) return false;

    if (outcome.kind !== 'complete') {
      const nextEvidence: CostEvidence = {
        ...evidence,
        smsUsageReconciliation: {
          status: outcome.kind === 'exhausted' ? 'exhausted' : 'pending',
          attempts: state.attempts,
          ...(outcome.kind === 'retry'
            ? { nextAttemptAt: outcome.nextAttemptAt.toISOString() }
            : {}),
          ...(outcome.error ? { lastError: outcome.error.slice(0, 240) } : {}),
        },
      };
      tx.update(eventRef, { evidence: nextEvidence });
      return true;
    }

    if (!Number.isInteger(outcome.billedSegments) || outcome.billedSegments < 1)
      throw new Error('Twilio usage reported an invalid segment count');
    if (!Number.isFinite(outcome.priceUsd) || outcome.priceUsd < 0)
      throw new Error('Twilio usage reported an invalid price');
    const smsReceipt = evidence.sms;
    if (!smsReceipt) return false;

    const createdAt = decodeRecord<Date>(row.createdAt);
    const taskId = row.taskId;
    const reservationId = row.reservationId;
    const dayRef = store.doc('budgetPeriods', `day:${createdAt.toISOString().slice(0, 10)}`);
    const monthRef = store.doc('budgetPeriods', `month:${createdAt.toISOString().slice(0, 7)}`);
    const taskRef = taskId ? store.doc('tasks', taskId) : null;
    const reservationRef = reservationId ? store.doc('costReservations', reservationId) : null;
    const toolCallId = row.toolCallId;
    const toolCallRef = toolCallId ? store.doc('toolCalls', toolCallId) : null;
    const reads = await tx.getAll(
      dayRef,
      monthRef,
      ...(taskRef ? [taskRef] : []),
      ...(reservationRef ? [reservationRef] : []),
      ...(toolCallRef ? [toolCallRef] : []),
    );
    const [day, month] = reads;
    if (!day?.exists || !month?.exists) throw new Error('SMS usage ledger periods are missing');
    const task = taskRef ? reads[2] : null;
    const reservation = reservationRef ? reads[taskRef ? 3 : 2] : null;
    const toolCall = toolCallRef ? reads[(taskRef ? 3 : 2) + (reservationRef ? 1 : 0)] : null;
    const oldMicros = storedLedgerUsdToMicros(row.usd);
    const newMicros = ledgerUsdToMicros(outcome.priceUsd);
    const delta = newMicros - oldMicros;
    let nextTaskSpendMicros: number | null = null;
    if (taskRef && task?.exists && delta !== 0) {
      nextTaskSpendMicros = storedLedgerUsdToMicros(task.get('spentUsd') ?? '0') + delta;
      if (nextTaskSpendMicros < 0) throw new Error('SMS task spend underflow');
      assertLedgerMicros(nextTaskSpendMicros);
    }
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
    const changes: Record<string, unknown> = {
      evidence: nextEvidence,
      quantity: outcome.billedSegments.toFixed(4),
      unit: 'segment',
      unitPriceUsd: (outcome.priceUsd / outcome.billedSegments).toFixed(8),
      usd: (newMicros / 1_000_000).toFixed(6),
    };
    tx.update(eventRef, changes);
    tx.update(dayRef, { spentMicros: adjustMicros(day.get('spentMicros'), delta) });
    tx.update(monthRef, { spentMicros: adjustMicros(month.get('spentMicros'), delta) });
    if (taskRef && task?.exists && nextTaskSpendMicros !== null) {
      tx.update(taskRef, {
        spentUsd: microsToUsd(nextTaskSpendMicros).toFixed(6),
        updatedAt: store.now(),
      });
    }
    if (reservationRef && reservation?.exists) {
      tx.update(reservationRef, { actualUsd: (newMicros / 1_000_000).toFixed(6) });
    }
    if (toolCallRef && toolCall?.exists && evidence.sms) {
      const result = toolCall.get('result');
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        tx.update(toolCallRef, {
          result: { ...(result as Record<string, unknown>), smsAccounting: nextEvidence.sms },
        });
      }
    }
    return true;
  });
}

import { randomUUID } from 'node:crypto';
