import { createHash, randomUUID } from 'node:crypto';
import {
  addMicros,
  canonicalEstimatedCostJson,
  type EstimatedCostActor,
  type EstimatedCostPreparationResult,
  type EstimatedCostPreparedQuote,
  type EstimatedCostQuotePreparer,
  type EstimatedCostQuoteRequest,
  type EstimatedCostSourceBinding,
  type EstimatedCostTurnParkInput,
  type EstimatedCostTurnParking,
  estimatedCostAllowance,
  estimatedCostQuoteExpiry,
  MODEL_ROLE_NAMES,
  matchesEstimatedCostParkedTask,
  parseEstimatedCostQuote,
  storedLedgerUsdToMicros,
  storedTaskBudgetToMicros,
} from '@assistant/persistence';
import type { DocumentSnapshot } from '@google-cloud/firestore';
import { hasCostEventAccountedSince } from './costs.js';
import { storePreparedFirestoreQuote } from './estimated-cost-approval-transactions.js';
import { firestoreEstimatedCostBaseline } from './estimated-cost-baseline.js';
import { firestoreEstimatedCostSourceBinding } from './estimated-cost-binding.js';
import { decodeRecord, type InstallationStore } from './store.js';

const unavailable = {
  ok: false,
  outcome: 'unavailable',
  message: 'The estimate could not be verified.',
} as const;
function counter(doc: DocumentSnapshot | undefined, field: string): number {
  if (!doc?.exists) return 0;
  const value: unknown = doc.get(field);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid budget counter');
  return value;
}
type Initial = { kind: 'initial'; input: EstimatedCostTurnParkInput };
type Refresh = { kind: 'refresh'; actor: EstimatedCostActor; request: EstimatedCostQuoteRequest };

/** Internal read-only preparation; storage rechecks every value before writing. */
async function prepare(
  store: InstallationStore,
  input: Initial | Refresh,
): Promise<EstimatedCostPreparationResult> {
  const actor = input.kind === 'initial' ? input.input.actor : input.actor;
  const operationId =
    input.kind === 'initial' ? input.input.operationId : input.request.operationId;
  const quoteRequestId =
    input.kind === 'initial' ? input.input.quoteRequestId : input.request.quoteRequestId;
  if (actor.installationId !== store.installationId || !operationId || !quoteRequestId)
    return unavailable;
  return store.db.runTransaction(
    async (tx) => {
      const now = store.now();
      const request = await tx.get(store.doc('estimatedCostRequests', operationId));
      if (input.kind === 'initial' && request.exists) return unavailable;
      if (
        input.kind === 'refresh' &&
        (!request.exists ||
          request.get('installationId') !== actor.installationId ||
          request.get('ownerId') !== actor.ownerId ||
          !['pending', 'expired_or_needs_refresh'].includes(String(request.get('state'))))
      )
        return unavailable;
      const taskId: unknown = input.kind === 'initial' ? input.input.taskId : request.get('taskId');
      const requestFingerprint: unknown =
        input.kind === 'initial'
          ? input.input.requestFingerprint
          : request.get('requestFingerprint');
      if (
        typeof taskId !== 'string' ||
        !taskId ||
        typeof requestFingerprint !== 'string' ||
        !requestFingerprint
      )
        return unavailable;
      const task = await tx.get(store.doc('tasks', taskId));
      if (!task.exists) return unavailable;
      const taskData = decodeRecord<Record<string, unknown>>(task.data());
      const trigger = taskData.trigger as { payload?: { text?: unknown } } | undefined;
      const requestText = trigger?.payload?.text;
      if (
        typeof requestText !== 'string' ||
        !requestText ||
        !matchesEstimatedCostParkedTask(
          {
            id: String(taskData.id ?? ''),
            agentId: String(taskData.agentId ?? ''),
            type: String(taskData.type ?? ''),
            trust: String(taskData.trust ?? ''),
            status: 'waiting_estimated_cost',
            trigger: taskData.trigger,
          },
          { actor, taskId, operationId, requestFingerprint },
        )
      )
        return unavailable;
      if (input.kind === 'initial') {
        const lockedUntil = taskData.lockedUntil;
        if (
          taskData.status !== 'running' ||
          taskData.conversationId !== input.input.conversationId ||
          taskData.leaseToken !== input.input.leaseToken ||
          !(lockedUntil instanceof Date) ||
          lockedUntil.getTime() <= now.getTime()
        )
          return unavailable;
      } else if (taskData.status !== 'waiting_estimated_cost') return unavailable;
      const savedQuote =
        input.kind === 'refresh'
          ? parseEstimatedCostQuote(decodeRecord(request.get('quote')))
          : null;
      const oldBinding =
        input.kind === 'refresh'
          ? decodeRecord<EstimatedCostSourceBinding>(request.get('sourceBinding'))
          : null;
      if (
        input.kind === 'refresh' &&
        (!savedQuote ||
          savedQuote.operationId !== operationId ||
          savedQuote.taskId !== taskId ||
          !oldBinding ||
          !Array.isArray(oldBinding.additionalRoutes))
      )
        return unavailable;
      const role = input.kind === 'initial' ? input.input.candidate.role : oldBinding?.role;
      const modelId =
        input.kind === 'initial' ? input.input.candidate.modelId : oldBinding?.selectedModelId;
      const routingDigest =
        input.kind === 'initial' ? input.input.candidate.routingDigest : oldBinding?.routingDigest;
      const critical =
        input.kind === 'initial' ? input.input.candidate.critical : oldBinding?.critical;
      const nextAttemptMicros =
        input.kind === 'initial'
          ? input.input.candidate.nextAttemptMicros
          : (decodeRecord<{ nextAttemptMicros?: number } | null>(request.get('renewalCandidate'))
              ?.nextAttemptMicros ?? savedQuote?.nextAttemptMicros);
      if (
        typeof role !== 'string' ||
        typeof modelId !== 'string' ||
        typeof routingDigest !== 'string' ||
        typeof critical !== 'boolean' ||
        typeof nextAttemptMicros !== 'number' ||
        !Number.isSafeInteger(nextAttemptMicros) ||
        nextAttemptMicros <= 0
      )
        return unavailable;
      const additionalRoles =
        input.kind === 'initial'
          ? MODEL_ROLE_NAMES.filter((name) => name !== role && name !== 'embed')
          : (oldBinding?.additionalRoutes.map((entry) => entry.role) ?? []);
      const sourceBinding = await firestoreEstimatedCostSourceBinding(tx, store, {
        actor,
        taskId,
        role,
        selectedModelId: modelId,
        routingDigest,
        critical,
        additionalRoles: [...additionalRoles],
      });
      if (
        oldBinding &&
        canonicalEstimatedCostJson(oldBinding) !== canonicalEstimatedCostJson(sourceBinding)
      )
        return unavailable;
      const day = now.toISOString().slice(0, 10),
        month = now.toISOString().slice(0, 7);
      const [holds, taskHolds, daily, monthly, policy] = await tx.getAll(
        store.doc('coordination', 'budget-holds'),
        store.doc('taskBudgetHolds', taskId),
        store.doc('budgetPeriods', `day:${day}`),
        store.doc('budgetPeriods', `month:${month}`),
        store.doc('coordination', 'budget-policy'),
      );
      if (!holds?.exists || !taskHolds || !policy?.exists) return unavailable;
      if (
        !daily?.exists &&
        (await hasCostEventAccountedSince(tx, store, new Date(`${day}T00:00:00.000Z`)))
      )
        return unavailable;
      if (
        !monthly?.exists &&
        (await hasCostEventAccountedSince(tx, store, new Date(`${month}-01T00:00:00.000Z`)))
      )
        return unavailable;
      if (!taskHolds.exists) {
        const rows = await tx.get(
          store.collection('costReservations').where('taskId', '==', taskId).limit(501),
        );
        if (
          rows.size >= 501 ||
          rows.docs.some((doc) =>
            ['held', 'dispatching', 'unknown'].includes(String(doc.get('status'))),
          )
        )
          return unavailable;
      }
      const heldMicros = counter(holds, 'heldMicros');
      const baseline = await firestoreEstimatedCostBaseline(tx, store, actor, heldMicros);
      if (!baseline) return unavailable;
      const pending = await tx.get(
        store.collection('estimatedCostRequests').where('state', '==', 'pending').limit(501),
      );
      if (pending.size >= 501) return unavailable;
      let pendingOtherMicros = 0;
      for (const row of pending.docs) {
        const item = parseEstimatedCostQuote(decodeRecord(row.get('quote')));
        if (
          !item ||
          row.get('installationId') !== actor.installationId ||
          row.get('operationId') !== item.operationId ||
          row.get('taskId') !== item.taskId
        )
          return unavailable;
        if (item.operationId !== operationId && Date.parse(item.expiresAt) > now.getTime())
          pendingOtherMicros = addMicros(pendingOtherMicros, item.allowanceMicros);
      }
      const factor = (value: number) => (critical ? Math.floor((value * 11) / 10) : value);
      const dailyMicros = counter(daily, 'spentMicros'),
        monthlyMicros = counter(monthly, 'spentMicros');
      const dailyCeilingMicros = factor(counter(policy, 'dailyLimitMicros')),
        monthlyCeilingMicros = factor(counter(policy, 'monthlyLimitMicros'));
      const headroom = {
        dailySpentMicros: dailyMicros,
        monthlySpentMicros: monthlyMicros,
        heldMicros,
        historicalUnknownMicros: baseline.eligibleMicros,
        dailyCeilingMicros,
        monthlyCeilingMicros,
        taskSpentMicros: storedLedgerUsdToMicros(taskData.spentUsd),
        taskHeldMicros: counter(taskHolds, 'heldMicros'),
        taskCeilingMicros: factor(storedTaskBudgetToMicros(taskData.budgetUsdLimit)),
        nextAttemptMicros,
      };
      const allowance = estimatedCostAllowance(headroom);
      if (!allowance.canApprove) return unavailable;
      const pendingApprovalMicros = addMicros(pendingOtherMicros, allowance.allowanceMicros);
      const quote = {
        type: 'estimated-cost-approval' as const,
        operationId,
        taskId,
        requestText,
        quoteId: randomUUID(),
        quoteVersion: randomUUID(),
        expiresAt: estimatedCostQuoteExpiry(now).toISOString(),
        nextAttemptMicros,
        allowanceMicros: allowance.allowanceMicros,
        recordedDailyMicros: dailyMicros,
        recordedMonthlyMicros: monthlyMicros,
        totalHeldMicros: heldMicros,
        eligibleHistoricalUnknownMicros: baseline.eligibleMicros,
        pendingApprovalMicros,
        dailyCeilingMicros,
        monthlyCeilingMicros,
        dailyProjectedGrossMicros: addMicros(dailyMicros, heldMicros, pendingApprovalMicros),
        monthlyProjectedGrossMicros: addMicros(monthlyMicros, heldMicros, pendingApprovalMicros),
        complete: true,
        canApprove: true,
      };
      return {
        ok: true,
        prepared: {
          actor,
          quoteRequestId,
          taskId,
          leaseToken: input.kind === 'initial' ? input.input.leaseToken : null,
          requestFingerprint,
          bindingDigest: createHash('sha256')
            .update(canonicalEstimatedCostJson(sourceBinding))
            .digest('hex'),
          sourceBinding,
          critical,
          quote,
          baseline: baseline.eligible,
        } satisfies EstimatedCostPreparedQuote,
      };
    },
    { readOnly: true },
  );
}

/** Must be composed behind the still-disabled rollout capability. */
export function createFirestoreEstimatedCostQuotePreparer(
  store: InstallationStore,
  options: { mutationsEnabled?: () => boolean } = {},
): EstimatedCostQuotePreparer {
  return {
    async prepare(actor, request) {
      try {
        if (options.mutationsEnabled?.() !== true) return unavailable;
      } catch {
        return unavailable;
      }
      return prepare(store, { kind: 'refresh', actor, request });
    },
  };
}

/** The hook's caller must not install it until the rollout capability is proven. */
export function createFirestoreEstimatedCostTurnParking(
  store: InstallationStore,
  options: { mutationsEnabled?: () => boolean } = {},
): EstimatedCostTurnParking {
  return {
    async park(input) {
      try {
        if (options.mutationsEnabled?.() !== true) return unavailable;
      } catch {
        return unavailable;
      }
      const prepared = await prepare(store, { kind: 'initial', input });
      if (!prepared.ok) return prepared;
      const stored = await storePreparedFirestoreQuote(store, prepared.prepared);
      if (!stored.ok) return stored;
      if (stored.request.status !== 'pending') return unavailable;
      return {
        ok: true,
        status: 'pending',
        operationId: input.operationId,
        taskId: input.taskId,
        quoteId: stored.request.quote.quoteId,
        quoteVersion: stored.request.quote.quoteVersion,
      };
    },
  };
}
