import { createHash, randomUUID } from 'node:crypto';
import {
  addMicros,
  canonicalEstimatedCostJson,
  type EstimatedCostActor,
  type EstimatedCostDecision,
  type EstimatedCostDecisionResponse,
  type EstimatedCostGrantAttempt,
  type EstimatedCostGrantRenewal,
  type EstimatedCostPreparedQuote,
  type EstimatedCostQuoteResponse,
  type EstimatedCostSourceBinding,
  estimatedCostAllowanceExpiry,
  estimatedCostCardMessageId,
  estimatedCostConnectionId,
  estimatedCostQuoteExpiry,
  estimatedCostQuoteMatches,
  MODEL_ROLE_NAMES,
  matchesEstimatedCostParkedTask,
  parseEstimatedCostQuote,
  parseEstimatedCostReceipt,
  storedLedgerUsdToMicros,
  storedTaskBudgetToMicros,
} from '@assistant/persistence';
import type { DocumentSnapshot } from '@google-cloud/firestore';
import { firestoreEstimatedCostBaseline } from './estimated-cost-baseline.js';
import { firestoreEstimatedCostSourceBinding } from './estimated-cost-binding.js';
import { createWakeIntent } from './outbox.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

const unavailable = {
  ok: false,
  outcome: 'unavailable',
  message: 'The estimate could not be verified.',
} as const;
const conflict = {
  ok: false,
  outcome: 'conflict',
  message: 'The estimate request changed.',
} as const;
function counter(doc: DocumentSnapshot | undefined, field: string): number {
  if (!doc?.exists) return 0; // Existing budget-period convention for an unused period.
  const value: unknown = doc.get(field);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid budget counter');
  return value;
}

/** Re-park exactly the blocked next call; only a later owner decision can fund it. */
export async function parkFirestoreEstimatedCostGrantRenewal(
  store: InstallationStore,
  input: EstimatedCostGrantRenewal,
): Promise<boolean> {
  if (
    input.actor.installationId !== store.installationId ||
    !Number.isSafeInteger(input.candidate.nextAttemptMicros) ||
    input.candidate.nextAttemptMicros <= 0 ||
    !/^[a-f0-9]{64}$/.test(input.candidate.routingDigest) ||
    !/^[a-f0-9]{64}$/.test(input.candidate.requestDigest)
  )
    return false;
  return store.db.runTransaction(async (tx) => {
    const requestRef = store.doc('estimatedCostRequests', input.operationId),
      taskRef = store.doc('tasks', input.taskId),
      grantRef = store.doc('estimatedCostGrants', input.grantId);
    const [request, task, grant, holds, taskHolds] = await tx.getAll(
      requestRef,
      taskRef,
      grantRef,
      store.doc('coordination', 'budget-holds'),
      store.doc('taskBudgetHolds', input.taskId),
    );
    if (
      !request?.exists ||
      !task?.exists ||
      !grant?.exists ||
      !holds?.exists ||
      !taskHolds?.exists ||
      request.get('installationId') !== input.actor.installationId ||
      request.get('ownerId') !== input.actor.ownerId ||
      request.get('taskId') !== input.taskId ||
      request.get('state') !== 'approved' ||
      request.get('bindingDigest') !== input.bindingDigest ||
      grant.get('operationId') !== input.operationId
    )
      return false;
    const taskData = decodeRecord<Record<string, unknown>>(task.data());
    const state =
      taskData.state && typeof taskData.state === 'object' && !Array.isArray(taskData.state)
        ? (taskData.state as Record<string, unknown>)
        : null;
    const marker = state?.estimatedCostApproval as Record<string, unknown> | undefined;
    const expiry = decodeRecord<Date>(grant.get('expiresAt')),
      lockedUntil = taskData.lockedUntil;
    const quote = parseEstimatedCostQuote(decodeRecord(request.get('quote')));
    const fingerprint = request.get('requestFingerprint');
    if (
      !state ||
      !marker ||
      marker.status !== 'approved' ||
      marker.grantId !== input.grantId ||
      marker.bindingDigest !== input.bindingDigest ||
      !quote ||
      quote.quoteId !== grant.get('quoteId') ||
      typeof fingerprint !== 'string' ||
      taskData.status !== 'running' ||
      taskData.leaseToken !== input.leaseToken ||
      !(lockedUntil instanceof Date) ||
      lockedUntil.getTime() <= store.now().getTime() ||
      !(expiry instanceof Date) ||
      !Number.isFinite(expiry.getTime()) ||
      !matchesEstimatedCostParkedTask(
        {
          id: input.taskId,
          agentId: String(taskData.agentId ?? ''),
          type: String(taskData.type ?? ''),
          trust: String(taskData.trust ?? ''),
          status: 'waiting_estimated_cost',
          trigger: taskData.trigger,
        },
        {
          actor: input.actor,
          taskId: input.taskId,
          operationId: input.operationId,
          requestFingerprint: fingerprint,
        },
      )
    )
      return false;
    const escrowId = grant.get('escrowReservationId');
    if (typeof escrowId !== 'string') return false;
    const escrowRef = store.doc('costReservations', escrowId),
      escrow = await tx.get(escrowRef);
    if (
      !escrow.exists ||
      escrow.get('status') !== 'held' ||
      escrow.get('reservationKind') !== 'escrow' ||
      escrow.get('costGrantId') !== input.grantId ||
      escrow.get('taskId') !== input.taskId
    )
      return false;
    const balance = storedLedgerUsdToMicros(escrow.get('estimatedUsd')),
      allowance = grant.get('allowanceMicros'),
      consumed = grant.get('consumedMicros');
    if (
      !Number.isSafeInteger(allowance) ||
      !Number.isSafeInteger(consumed) ||
      consumed < 0 ||
      allowance - consumed !== balance ||
      (expiry.getTime() > store.now().getTime() && balance >= input.candidate.nextAttemptMicros)
    )
      return false;
    const held = counter(holds, 'heldMicros'),
      taskHeld = counter(taskHolds, 'heldMicros');
    if (held < balance || taskHeld < balance) return false;
    const oldBinding = decodeRecord<EstimatedCostSourceBinding>(request.get('sourceBinding'));
    if (
      !oldBinding ||
      !Array.isArray(oldBinding.additionalRoutes) ||
      !Array.isArray(oldBinding.modelRows)
    )
      return false;
    if (input.candidate.critical && !oldBinding.critical) return false;
    const allowed =
      oldBinding.role === input.candidate.role
        ? oldBinding
        : oldBinding.additionalRoutes.find((item) => item.role === input.candidate.role);
    if (
      !allowed ||
      !Array.isArray(allowed.modelRows) ||
      !allowed.modelRows.some((item) => item.id === input.candidate.modelId)
    )
      return false;
    const oldSource = await firestoreEstimatedCostSourceBinding(tx, store, {
      actor: input.actor,
      taskId: input.taskId,
      role: oldBinding.role,
      selectedModelId: oldBinding.selectedModelId,
      routingDigest: oldBinding.routingDigest,
      critical: oldBinding.critical,
      additionalRoles: oldBinding.additionalRoutes.map((item) => item.role),
    });
    if (
      canonicalEstimatedCostJson(oldSource) !== canonicalEstimatedCostJson(oldBinding) ||
      createHash('sha256').update(canonicalEstimatedCostJson(oldBinding)).digest('hex') !==
        input.bindingDigest
    )
      return false;
    const sourceBinding = await firestoreEstimatedCostSourceBinding(tx, store, {
      actor: input.actor,
      taskId: input.taskId,
      role: input.candidate.role,
      selectedModelId: input.candidate.modelId,
      routingDigest: input.candidate.routingDigest,
      critical: input.candidate.critical,
      additionalRoles: MODEL_ROLE_NAMES.filter(
        (role) => role !== input.candidate.role && role !== 'embed',
      ),
    });
    const bindingDigest = createHash('sha256')
      .update(canonicalEstimatedCostJson(sourceBinding))
      .digest('hex');
    const now = store.now();
    if ((lockedUntil as Date).getTime() <= now.getTime()) return false;
    tx.update(escrowRef, { status: 'released', reconciledAt: now });
    tx.set(store.doc('coordination', 'budget-holds'), { heldMicros: held - balance });
    tx.set(store.doc('taskBudgetHolds', input.taskId), { heldMicros: taskHeld - balance });
    tx.update(requestRef, {
      state: 'expired_or_needs_refresh',
      sourceBinding,
      bindingDigest,
      critical: input.candidate.critical,
      renewalCandidate: input.candidate,
      updatedAt: now,
    });
    tx.update(taskRef, {
      status: 'waiting_estimated_cost',
      state: {
        ...state,
        estimatedCostApproval: {
          operationId: input.operationId,
          quoteId: quote.quoteId,
          bindingDigest,
          status: 'pending',
        },
      },
      lockedUntil: null,
      leaseToken: null,
      runAfter: null,
      updatedAt: now,
    });
    return true;
  });
}

/** Persist the single dispatch boundary after revalidating the grant and this
 * attempt's freshly priced role/model. The initial prompt digest is not reused. */
export async function beginFirestoreEstimatedCostGrantAttempt(
  store: InstallationStore,
  input: EstimatedCostGrantAttempt,
): Promise<boolean> {
  if (
    input.actor.installationId !== store.installationId ||
    !/^[a-f0-9]{64}$/.test(input.routingDigest) ||
    !/^[a-f0-9]{64}$/.test(input.requestDigest) ||
    !Number.isSafeInteger(input.nextAttemptMicros) ||
    input.nextAttemptMicros <= 0 ||
    input.metadata.role !== input.role ||
    input.metadata.model !== input.modelId ||
    input.metadata.requestDigest !== input.requestDigest ||
    input.metadata.provider !== estimatedCostConnectionId(input.modelId)
  )
    return false;
  return store.db.runTransaction(async (tx) => {
    const now = store.now();
    const [request, grant, reservation, task, holds, taskHolds, policy, daily, monthly, selected] =
      await tx.getAll(
        store.doc('estimatedCostRequests', input.operationId),
        store.doc('estimatedCostGrants', input.grantId),
        store.doc('costReservations', input.reservationId),
        store.doc('tasks', input.taskId),
        store.doc('coordination', 'budget-holds'),
        store.doc('taskBudgetHolds', input.taskId),
        store.doc('coordination', 'budget-policy'),
        store.doc('budgetPeriods', `day:${now.toISOString().slice(0, 10)}`),
        store.doc('budgetPeriods', `month:${now.toISOString().slice(0, 7)}`),
        store.doc('models', input.modelId),
      );
    if (
      !request?.exists ||
      request.get('installationId') !== input.actor.installationId ||
      request.get('ownerId') !== input.actor.ownerId ||
      request.get('taskId') !== input.taskId ||
      request.get('state') !== 'approved' ||
      !grant?.exists ||
      grant.get('operationId') !== input.operationId ||
      !reservation?.exists ||
      reservation.get('status') !== 'held' ||
      reservation.get('reservationKind') !== 'attempt' ||
      reservation.get('costGrantId') !== input.grantId ||
      reservation.get('taskId') !== input.taskId ||
      storedLedgerUsdToMicros(reservation.get('estimatedUsd')) !== input.nextAttemptMicros ||
      !task?.exists ||
      !holds?.exists ||
      !taskHolds?.exists ||
      !policy?.exists ||
      !selected?.exists ||
      selected.get('enabled') !== true
    )
      return false;
    const quote = parseEstimatedCostQuote(decodeRecord(request.get('quote')));
    const binding = decodeRecord<EstimatedCostSourceBinding>(request.get('sourceBinding'));
    const bindingDigest: unknown = request.get('bindingDigest');
    const fingerprint: unknown = request.get('requestFingerprint');
    const taskData = decodeRecord<Record<string, unknown>>(task.data());
    const state =
      taskData.state && typeof taskData.state === 'object' && !Array.isArray(taskData.state)
        ? (taskData.state as Record<string, unknown>)
        : null;
    const marker = state?.estimatedCostApproval as Record<string, unknown> | undefined;
    const lockedUntil = taskData.lockedUntil;
    const expiresAt = decodeRecord<Date>(grant.get('expiresAt'));
    if (
      !quote ||
      quote.quoteId !== grant.get('quoteId') ||
      typeof bindingDigest !== 'string' ||
      typeof fingerprint !== 'string' ||
      !binding ||
      !Array.isArray(binding.additionalRoutes) ||
      typeof binding.critical !== 'boolean' ||
      request.get('critical') !== binding.critical ||
      createHash('sha256').update(canonicalEstimatedCostJson(binding)).digest('hex') !==
        bindingDigest ||
      !marker ||
      marker.operationId !== input.operationId ||
      marker.quoteId !== quote.quoteId ||
      marker.bindingDigest !== bindingDigest ||
      marker.grantId !== input.grantId ||
      marker.status !== 'approved' ||
      taskData.status !== 'running' ||
      taskData.leaseToken !== input.leaseToken ||
      !(lockedUntil instanceof Date) ||
      lockedUntil.getTime() <= now.getTime() ||
      !(expiresAt instanceof Date) ||
      expiresAt.getTime() <= now.getTime() ||
      !matchesEstimatedCostParkedTask(
        {
          id: String(taskData.id ?? ''),
          agentId: String(taskData.agentId ?? ''),
          type: String(taskData.type ?? ''),
          trust: String(taskData.trust ?? ''),
          status: 'waiting_estimated_cost',
          trigger: taskData.trigger,
        },
        {
          actor: input.actor,
          taskId: input.taskId,
          operationId: input.operationId,
          requestFingerprint: fingerprint,
        },
      )
    )
      return false;
    const allowed =
      binding.role === input.role
        ? binding
        : binding.additionalRoutes.find((route) => route.role === input.role);
    if (
      !allowed ||
      (input.critical && !binding.critical) ||
      !Array.isArray(allowed.modelRows) ||
      !allowed.modelRows.some((model) => model.id === input.modelId)
    )
      return false;
    const firstDispatch = grant.get('firstDispatchRecorded') !== true;
    if (
      firstDispatch &&
      (input.role !== binding.role ||
        input.modelId !== binding.selectedModelId ||
        input.routingDigest !== binding.routingDigest ||
        input.nextAttemptMicros !== quote.nextAttemptMicros)
    )
      return false;
    const source = await firestoreEstimatedCostSourceBinding(tx, store, {
      actor: input.actor,
      taskId: input.taskId,
      role: binding.role,
      selectedModelId: binding.selectedModelId,
      routingDigest: binding.routingDigest,
      critical: binding.critical,
      additionalRoles: binding.additionalRoutes.map((route) => route.role),
    });
    if (canonicalEstimatedCostJson(source) !== canonicalEstimatedCostJson(binding)) return false;
    const escrowId: unknown = grant.get('escrowReservationId');
    if (typeof escrowId !== 'string' || !escrowId) return false;
    const escrow = await tx.get(store.doc('costReservations', escrowId));
    if (
      !escrow.exists ||
      escrow.get('status') !== 'held' ||
      escrow.get('reservationKind') !== 'escrow' ||
      escrow.get('costGrantId') !== input.grantId
    )
      return false;
    const heldMicros = counter(holds, 'heldMicros');
    const taskHeldMicros = counter(taskHolds, 'heldMicros');
    const baseline = await firestoreEstimatedCostBaseline(tx, store, input.actor, heldMicros);
    if (
      !baseline ||
      canonicalEstimatedCostJson(baseline.eligible) !==
        canonicalEstimatedCostJson(decodeRecord(request.get('baseline')))
    )
      return false;
    const factor = (amount: number) => (input.critical ? Math.floor((amount * 11) / 10) : amount);
    const protectedHeld = heldMicros - baseline.eligibleMicros;
    if (
      addMicros(counter(daily, 'spentMicros'), protectedHeld) >
        factor(counter(policy, 'dailyLimitMicros')) ||
      addMicros(counter(monthly, 'spentMicros'), protectedHeld) >
        factor(counter(policy, 'monthlyLimitMicros')) ||
      addMicros(storedLedgerUsdToMicros(taskData.spentUsd), taskHeldMicros) >
        factor(storedTaskBudgetToMicros(taskData.budgetUsdLimit))
    )
      return false;
    const finalNow = store.now();
    if (
      expiresAt.getTime() <= finalNow.getTime() ||
      lockedUntil.getTime() <= finalNow.getTime() ||
      now.toISOString().slice(0, 10) !== finalNow.toISOString().slice(0, 10)
    )
      return false;
    tx.update(store.doc('costReservations', input.reservationId), {
      status: 'dispatching',
      attemptStartedAt: finalNow,
      attemptMetadata: input.metadata,
      attemptRoutingDigest: input.routingDigest,
    });
    if (firstDispatch)
      tx.update(store.doc('estimatedCostGrants', input.grantId), { firstDispatchRecorded: true });
    tx.set(store.doc('coordination', 'budget-holds'), { heldMicros });
    return true;
  });
}

/** Internal transaction primitive. Runtime activation must remain disabled until
 * all writer/drain and dispatch fencing requirements have been established. */
export async function approveFirestoreEstimatedCost(
  store: InstallationStore,
  actor: EstimatedCostActor,
  decision: EstimatedCostDecision,
): Promise<EstimatedCostDecisionResponse> {
  if (decision.decision !== 'approve' || actor.installationId !== store.installationId)
    return unavailable;
  const bodyDigest = createHash('sha256')
    .update(
      JSON.stringify([
        decision.operationId,
        decision.quoteId,
        decision.quoteVersion,
        decision.decisionId,
        decision.decision,
      ]),
    )
    .digest('hex');
  const requestRef = store.doc('estimatedCostRequests', decision.operationId);
  const decisionRef = store.doc('estimatedCostDecisions', decision.decisionId);
  const grantId = randomUUID();
  const escrowId = randomUUID();
  return store.db.runTransaction(async (tx) => {
    const now = store.now();
    const [request, prior] = await tx.getAll(requestRef, decisionRef);
    if (
      !request?.exists ||
      request.get('installationId') !== actor.installationId ||
      request.get('ownerId') !== actor.ownerId
    )
      return {
        ok: false,
        outcome: 'not_found',
        operationId: decision.operationId,
        message: 'Request not found.',
      };
    if (prior?.exists) {
      if (
        prior.get('operationId') !== decision.operationId ||
        prior.get('bodyDigest') !== bodyDigest
      )
        return conflict;
      const receipt = parseEstimatedCostReceipt(decodeRecord(prior.get('receipt')), decision);
      if (!receipt) throw new Error('Invalid stored estimated cost receipt');
      return { ok: true, receipt };
    }
    const quote = parseEstimatedCostQuote(decodeRecord(request.get('quote')));
    const taskId: unknown = request.get('taskId');
    const requestFingerprint: unknown = request.get('requestFingerprint');
    const bindingDigest: unknown = request.get('bindingDigest');
    const sourceBinding: unknown = decodeRecord(request.get('sourceBinding'));
    if (
      !quote ||
      quote.operationId !== decision.operationId ||
      typeof taskId !== 'string' ||
      quote.taskId !== taskId ||
      typeof requestFingerprint !== 'string' ||
      typeof bindingDigest !== 'string' ||
      !sourceBinding ||
      typeof sourceBinding !== 'object' ||
      Array.isArray(sourceBinding)
    )
      return unavailable;
    if (quote.quoteId !== decision.quoteId || quote.quoteVersion !== decision.quoteVersion) {
      const receipt = {
        operationId: decision.operationId,
        decisionId: decision.decisionId,
        quoteId: decision.quoteId,
        status: 'stale' as const,
      };
      tx.create(decisionRef, {
        decisionId: decision.decisionId,
        operationId: decision.operationId,
        bodyDigest,
        receipt,
        createdAt: now,
      });
      return { ok: true, receipt };
    }
    if (request.get('state') !== 'pending') return conflict;
    const stale = () => ({
      operationId: decision.operationId,
      decisionId: decision.decisionId,
      quoteId: decision.quoteId,
      status: 'stale' as const,
    });
    const binding = sourceBinding as EstimatedCostSourceBinding;
    const critical: unknown = request.get('critical');
    if (
      typeof critical !== 'boolean' ||
      binding.critical !== critical ||
      typeof binding.role !== 'string' ||
      typeof binding.selectedModelId !== 'string' ||
      typeof binding.routingDigest !== 'string' ||
      !Array.isArray(binding.additionalRoutes) ||
      binding.additionalRoutes.some((route) => !route || typeof route.role !== 'string') ||
      createHash('sha256').update(canonicalEstimatedCostJson(binding)).digest('hex') !==
        bindingDigest
    )
      return unavailable;
    const taskRef = store.doc('tasks', taskId);
    const task = await tx.get(taskRef);
    if (!task.exists) return unavailable;
    const taskData = decodeRecord<Record<string, unknown>>(task.data());
    if (
      !matchesEstimatedCostParkedTask(
        {
          id: String(taskData.id ?? ''),
          agentId: String(taskData.agentId ?? ''),
          type: String(taskData.type ?? ''),
          trust: String(taskData.trust ?? ''),
          status: String(taskData.status ?? ''),
          trigger: taskData.trigger,
        },
        { actor, taskId, operationId: decision.operationId, requestFingerprint },
      )
    )
      return unavailable;
    const state =
      taskData.state && typeof taskData.state === 'object' && !Array.isArray(taskData.state)
        ? (taskData.state as Record<string, unknown>)
        : null;
    const marker = state?.estimatedCostApproval as Record<string, unknown> | undefined;
    if (
      !state ||
      !marker ||
      marker.operationId !== decision.operationId ||
      marker.quoteId !== quote.quoteId ||
      marker.bindingDigest !== bindingDigest ||
      marker.status !== 'pending'
    )
      return unavailable;
    const source = await firestoreEstimatedCostSourceBinding(tx, store, {
      actor,
      taskId,
      role: binding.role,
      selectedModelId: binding.selectedModelId,
      routingDigest: binding.routingDigest,
      critical,
      additionalRoles: binding.additionalRoutes.map((route) => route.role),
    });
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    const [holds, taskHolds, daily, monthly, policy] = await tx.getAll(
      store.doc('coordination', 'budget-holds'),
      store.doc('taskBudgetHolds', taskId),
      store.doc('budgetPeriods', `day:${day}`),
      store.doc('budgetPeriods', `month:${month}`),
      store.doc('coordination', 'budget-policy'),
    );
    if (!holds?.exists || !taskHolds?.exists || !policy?.exists) return unavailable;
    const heldMicros = counter(holds, 'heldMicros');
    const taskHeldMicros = counter(taskHolds, 'heldMicros');
    const baseline = await firestoreEstimatedCostBaseline(tx, store, actor, heldMicros);
    const frozenQuoteBaseline = decodeRecord(request.get('baseline'));
    const pending = await tx.get(
      store.collection('estimatedCostRequests').where('state', '==', 'pending').limit(501),
    );
    if (!baseline || pending.size >= 501) return unavailable;
    let pendingOtherMicros = 0;
    for (const item of pending.docs) {
      const other = parseEstimatedCostQuote(decodeRecord(item.get('quote')));
      if (
        item.get('installationId') !== actor.installationId ||
        !other ||
        item.get('operationId') !== other.operationId ||
        item.get('taskId') !== other.taskId
      )
        return unavailable;
      if (other.operationId !== decision.operationId && Date.parse(other.expiresAt) > now.getTime())
        pendingOtherMicros = addMicros(pendingOtherMicros, other.allowanceMicros);
    }
    const factor = (amount: number) => (critical ? Math.floor((amount * 11) / 10) : amount);
    const headroom = {
      dailySpentMicros: counter(daily, 'spentMicros'),
      monthlySpentMicros: counter(monthly, 'spentMicros'),
      heldMicros,
      historicalUnknownMicros: baseline.eligibleMicros,
      dailyCeilingMicros: factor(counter(policy, 'dailyLimitMicros')),
      monthlyCeilingMicros: factor(counter(policy, 'monthlyLimitMicros')),
      taskSpentMicros: storedLedgerUsdToMicros(taskData.spentUsd),
      taskHeldMicros,
      taskCeilingMicros: factor(storedTaskBudgetToMicros(taskData.budgetUsdLimit)),
      nextAttemptMicros: quote.nextAttemptMicros,
      pendingOtherMicros,
    };
    const finalNow = store.now();
    const changed =
      Date.parse(quote.expiresAt) <= finalNow.getTime() ||
      day !== finalNow.toISOString().slice(0, 10) ||
      canonicalEstimatedCostJson(source) !== canonicalEstimatedCostJson(binding) ||
      canonicalEstimatedCostJson(baseline.eligible) !==
        canonicalEstimatedCostJson(frozenQuoteBaseline) ||
      !estimatedCostQuoteMatches(quote, headroom, { allowOrdinaryCapacity: true });
    if (changed) {
      const receipt = stale();
      tx.update(requestRef, { state: 'expired_or_needs_refresh', updatedAt: now });
      tx.set(store.doc('coordination', 'budget-holds'), { heldMicros });
      tx.create(decisionRef, {
        decisionId: decision.decisionId,
        operationId: decision.operationId,
        bodyDigest,
        receipt,
        createdAt: now,
      });
      return { ok: true, receipt };
    }
    const generation: unknown = taskData.queueGeneration;
    if (
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      generation >= Number.MAX_SAFE_INTEGER
    )
      return unavailable;
    const expiresAt = estimatedCostAllowanceExpiry(finalNow);
    const receipt = {
      operationId: decision.operationId,
      decisionId: decision.decisionId,
      quoteId: decision.quoteId,
      status: 'approved' as const,
      allowanceMicros: quote.allowanceMicros,
      expiresAt: expiresAt.toISOString(),
    };
    tx.create(store.doc('costReservations', escrowId), {
      id: escrowId,
      taskId,
      source: 'model',
      estimatedUsd: (quote.allowanceMicros / 1_000_000).toFixed(6),
      actualUsd: null,
      status: 'held',
      reservationKind: 'escrow',
      costGrantId: grantId,
      description: 'approved request allowance',
      createdAt: now,
      reconciledAt: null,
    });
    tx.create(store.doc('estimatedCostGrants', grantId), {
      id: grantId,
      operationId: decision.operationId,
      quoteId: quote.quoteId,
      escrowReservationId: escrowId,
      allowanceMicros: quote.allowanceMicros,
      consumedMicros: 0,
      expiresAt,
      createdAt: now,
    });
    tx.update(requestRef, { state: 'approved', updatedAt: now });
    tx.update(taskRef, {
      status: 'pending',
      state: {
        ...state,
        estimatedCostApproval: {
          operationId: decision.operationId,
          quoteId: quote.quoteId,
          bindingDigest,
          grantId,
          status: 'approved',
        },
      },
      queueGeneration: generation + 1,
      runAfter: null,
      lockedUntil: null,
      leaseToken: null,
      attempt: 0,
      updatedAt: now,
    });
    tx.set(store.doc('coordination', 'budget-holds'), {
      heldMicros: addMicros(heldMicros, quote.allowanceMicros),
    });
    tx.set(store.doc('taskBudgetHolds', taskId), {
      heldMicros: addMicros(taskHeldMicros, quote.allowanceMicros),
    });
    tx.create(decisionRef, {
      decisionId: decision.decisionId,
      operationId: decision.operationId,
      bodyDigest,
      receipt,
      createdAt: now,
    });
    createWakeIntent(tx, store, { taskId, generation: generation + 1, availableAt: now });
    return { ok: true, receipt };
  });
}

/** Persist a verified quote and park only its original leased chat task. */
export async function storePreparedFirestoreQuote(
  store: InstallationStore,
  prepared: EstimatedCostPreparedQuote,
): Promise<EstimatedCostQuoteResponse> {
  const { actor, quote } = prepared;
  if (
    actor.installationId !== store.installationId ||
    quote.operationId.length === 0 ||
    quote.taskId !== prepared.taskId ||
    prepared.sourceBinding.critical !== prepared.critical ||
    !prepared.quoteRequestId
  )
    return unavailable;
  const identityDigest = createHash('sha256')
    .update(
      canonicalEstimatedCostJson({
        installationId: actor.installationId,
        ownerId: actor.ownerId,
        operationId: quote.operationId,
        quoteRequestId: prepared.quoteRequestId,
      }),
    )
    .digest('hex');
  const bindingDigest = createHash('sha256')
    .update(canonicalEstimatedCostJson(prepared.sourceBinding))
    .digest('hex');
  if (bindingDigest !== prepared.bindingDigest) return unavailable;
  const requestRef = store.doc('estimatedCostRequests', quote.operationId);
  const journalRef = store.doc('estimatedCostQuoteRequests', prepared.quoteRequestId);
  const taskRef = store.doc('tasks', prepared.taskId);
  return store.db.runTransaction(async (tx) => {
    const now = store.now();
    const [request, journal, task] = await tx.getAll(requestRef, journalRef, taskRef);
    if (journal?.exists) {
      if (
        journal.get('operationId') !== quote.operationId ||
        journal.get('requestDigest') !== identityDigest ||
        !request?.exists ||
        request.get('installationId') !== actor.installationId ||
        request.get('ownerId') !== actor.ownerId
      )
        return conflict;
      const saved = parseEstimatedCostQuote(decodeRecord(request.get('quote')));
      if (
        !saved ||
        saved.quoteId !== journal.get('quoteId') ||
        saved.quoteVersion !== journal.get('quoteVersion') ||
        request.get('state') !== 'pending'
      )
        return conflict;
      return {
        ok: true,
        request: {
          status:
            Date.parse(saved.expiresAt) <= now.getTime() ? 'expired_or_needs_refresh' : 'pending',
          operationId: quote.operationId,
          quote: saved,
        },
        tracking: null,
      };
    }
    if (!task?.exists) return unavailable;
    const taskData = decodeRecord<Record<string, unknown>>(task.data());
    const taskId = String(taskData.id ?? '');
    const trigger = taskData.trigger as { payload?: { text?: unknown } } | undefined;
    if (trigger?.payload?.text !== quote.requestText) return unavailable;
    const expected = {
      actor,
      taskId: prepared.taskId,
      operationId: quote.operationId,
      requestFingerprint: prepared.requestFingerprint,
    };
    const state =
      taskData.state && typeof taskData.state === 'object' && !Array.isArray(taskData.state)
        ? (taskData.state as Record<string, unknown>)
        : null;
    if (
      !state ||
      !matchesEstimatedCostParkedTask(
        {
          id: taskId,
          agentId: String(taskData.agentId ?? ''),
          type: String(taskData.type ?? ''),
          trust: String(taskData.trust ?? ''),
          status: 'waiting_estimated_cost',
          trigger: taskData.trigger,
        },
        expected,
      )
    )
      return unavailable;
    const refresh = Boolean(request?.exists);
    if (refresh) {
      if (
        prepared.leaseToken !== null ||
        request?.get('installationId') !== actor.installationId ||
        request.get('ownerId') !== actor.ownerId ||
        request.get('taskId') !== prepared.taskId ||
        request.get('requestFingerprint') !== prepared.requestFingerprint ||
        !['pending', 'expired_or_needs_refresh'].includes(String(request.get('state'))) ||
        taskData.status !== 'waiting_estimated_cost'
      )
        return conflict;
      const old = parseEstimatedCostQuote(decodeRecord(request.get('quote')));
      if (!old || (old.quoteId === quote.quoteId && old.quoteVersion === quote.quoteVersion))
        return conflict;
    } else {
      const lockedUntil = taskData.lockedUntil;
      if (
        !prepared.leaseToken ||
        taskData.status !== 'running' ||
        taskData.leaseToken !== prepared.leaseToken ||
        !(lockedUntil instanceof Date) ||
        lockedUntil.getTime() <= now.getTime()
      )
        return unavailable;
    }
    const expiry = Date.parse(quote.expiresAt);
    if (
      !Number.isFinite(expiry) ||
      expiry <= now.getTime() ||
      expiry > estimatedCostQuoteExpiry(now).getTime() ||
      parseEstimatedCostQuote(quote) === null
    )
      return unavailable;
    const source = await firestoreEstimatedCostSourceBinding(tx, store, {
      actor,
      taskId: prepared.taskId,
      role: prepared.sourceBinding.role,
      selectedModelId: prepared.sourceBinding.selectedModelId,
      routingDigest: prepared.sourceBinding.routingDigest,
      critical: prepared.critical,
      additionalRoles: prepared.sourceBinding.additionalRoutes.map((route) => route.role),
    });
    if (canonicalEstimatedCostJson(source) !== canonicalEstimatedCostJson(prepared.sourceBinding))
      return unavailable;
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    const [holds, taskHolds, daily, monthly, policy] = await tx.getAll(
      store.doc('coordination', 'budget-holds'),
      store.doc('taskBudgetHolds', prepared.taskId),
      store.doc('budgetPeriods', `day:${day}`),
      store.doc('budgetPeriods', `month:${month}`),
      store.doc('coordination', 'budget-policy'),
    );
    if (!holds?.exists || !taskHolds || !policy?.exists) return unavailable;
    if (
      !daily?.exists &&
      !(
        await tx.get(
          store
            .collection('costEvents')
            .where('createdAt', '>=', new Date(`${day}T00:00:00.000Z`))
            .limit(1),
        )
      ).empty
    )
      return unavailable;
    if (
      !monthly?.exists &&
      !(
        await tx.get(
          store
            .collection('costEvents')
            .where('createdAt', '>=', new Date(`${month}-01T00:00:00.000Z`))
            .limit(1),
        )
      ).empty
    )
      return unavailable;
    const heldMicros = counter(holds, 'heldMicros');
    const baseline = await firestoreEstimatedCostBaseline(tx, store, actor, heldMicros);
    if (
      !baseline ||
      canonicalEstimatedCostJson(baseline.eligible) !==
        canonicalEstimatedCostJson(prepared.baseline)
    )
      return unavailable;
    if (!taskHolds.exists) {
      const existingTaskReservations = await tx.get(
        store.collection('costReservations').where('taskId', '==', prepared.taskId).limit(501),
      );
      if (
        existingTaskReservations.size >= 501 ||
        existingTaskReservations.docs.some((doc) =>
          ['held', 'dispatching', 'unknown'].includes(String(doc.get('status'))),
        )
      )
        return unavailable;
    }
    const pending = await tx.get(
      store.collection('estimatedCostRequests').where('state', '==', 'pending').limit(501),
    );
    if (pending.size >= 501) return unavailable;
    let pendingOtherMicros = 0;
    for (const item of pending.docs) {
      const itemQuote = parseEstimatedCostQuote(decodeRecord(item.get('quote')));
      if (
        item.get('installationId') !== actor.installationId ||
        !itemQuote ||
        item.get('operationId') !== itemQuote.operationId ||
        item.get('taskId') !== itemQuote.taskId
      )
        return unavailable;
      if (
        itemQuote.operationId !== quote.operationId &&
        Date.parse(itemQuote.expiresAt) > now.getTime()
      )
        pendingOtherMicros = addMicros(pendingOtherMicros, itemQuote.allowanceMicros);
    }
    const factor = (amount: number) =>
      prepared.critical ? Math.floor((amount * 11) / 10) : amount;
    const headroom = {
      dailySpentMicros: counter(daily, 'spentMicros'),
      monthlySpentMicros: counter(monthly, 'spentMicros'),
      heldMicros,
      historicalUnknownMicros: baseline.eligibleMicros,
      dailyCeilingMicros: factor(counter(policy, 'dailyLimitMicros')),
      monthlyCeilingMicros: factor(counter(policy, 'monthlyLimitMicros')),
      taskSpentMicros: storedLedgerUsdToMicros(taskData.spentUsd),
      taskHeldMicros: counter(taskHolds, 'heldMicros'),
      taskCeilingMicros: factor(storedTaskBudgetToMicros(taskData.budgetUsdLimit)),
      nextAttemptMicros: quote.nextAttemptMicros,
      pendingOtherMicros,
    };
    if (
      !estimatedCostQuoteMatches(quote, headroom, { allowOrdinaryCapacity: refresh }) ||
      now.toISOString().slice(0, 10) !== store.now().toISOString().slice(0, 10) ||
      expiry <= store.now().getTime() ||
      (!refresh && (taskData.lockedUntil as Date).getTime() <= store.now().getTime())
    )
      return unavailable;
    const conversationId = taskData.conversationId;
    if (typeof conversationId !== 'string' || !conversationId) return unavailable;
    const conversationRef = store.doc('conversations', conversationId);
    const messageId = estimatedCostCardMessageId(
      quote.operationId,
      quote.quoteId,
      quote.quoteVersion,
    );
    const messageRef = store.doc('messages', messageId);
    const [conversation, priorMessage] = await tx.getAll(conversationRef, messageRef);
    if (
      !conversation?.exists ||
      conversation.get('agentId') !== actor.ownerId ||
      priorMessage?.exists
    )
      return unavailable;
    const marker = {
      operationId: quote.operationId,
      quoteId: quote.quoteId,
      bindingDigest: prepared.bindingDigest,
      status: 'pending' as const,
    };
    tx.set(requestRef, {
      operationId: quote.operationId,
      installationId: actor.installationId,
      ownerId: actor.ownerId,
      taskId: prepared.taskId,
      requestFingerprint: prepared.requestFingerprint,
      bindingDigest: prepared.bindingDigest,
      sourceBinding: prepared.sourceBinding,
      critical: prepared.critical,
      state: 'pending',
      quote,
      baseline: prepared.baseline,
      createdAt: refresh ? (request?.get('createdAt') ?? now) : now,
      updatedAt: now,
    });
    tx.create(journalRef, {
      quoteRequestId: prepared.quoteRequestId,
      operationId: quote.operationId,
      requestDigest: identityDigest,
      quoteId: quote.quoteId,
      quoteVersion: quote.quoteVersion,
      createdAt: now,
    });
    if (!taskHolds.exists)
      tx.create(store.doc('taskBudgetHolds', prepared.taskId), { heldMicros: 0 });
    if (!daily?.exists) tx.create(store.doc('budgetPeriods', `day:${day}`), { spentMicros: 0 });
    if (!monthly?.exists)
      tx.create(store.doc('budgetPeriods', `month:${month}`), { spentMicros: 0 });
    tx.create(
      messageRef,
      encodeRecord({
        id: messageId,
        conversationId,
        taskId: prepared.taskId,
        role: 'assistant',
        origin: 'assistant',
        text: 'Review the estimated cost for this request.',
        parts: [quote],
        channelMessageId: null,
        clientId: null,
        clientDeliveredAt: null,
        clientDeliveredBy: null,
        embedding: null,
        embeddingSpaceKey: null,
        hiddenAt: null,
        appendSequence: '00000000000000000000',
        createdAt: now,
      }),
    );
    tx.update(conversationRef, { updatedAt: now });
    tx.update(taskRef, {
      status: 'waiting_estimated_cost',
      state: { ...state, estimatedCostApproval: marker },
      runAfter: null,
      lockedUntil: null,
      leaseToken: null,
      updatedAt: now,
    });
    // All pending quote writers contend on the ledger fence without adding a hold.
    tx.set(store.doc('coordination', 'budget-holds'), { heldMicros });
    return {
      ok: true,
      request: { status: 'pending', operationId: quote.operationId, quote },
      tracking: null,
    };
  });
}
