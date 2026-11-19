import { createHash, randomUUID } from 'node:crypto';
import {
  addLedgerMicros,
  addMicros,
  assertUnknownModelSettlementTtl,
  type CostEventInput,
  type CostProviderReceipt,
  type CostRepository,
  type CostReservationSweep,
  type CostTotals,
  canCorrectModelAttemptEstimate,
  type EstimatedCostActor,
  type EstimatedCostApprovalRepository,
  type EstimatedCostBudgetTracking,
  type EstimatedCostDecision,
  type EstimatedCostDecisionReceipt,
  type EstimatedCostDecisionResponse,
  type EstimatedCostGrantDraw,
  type EstimatedCostGrantDrawResult,
  type EstimatedCostRequestProjection,
  ledgerUsdToMicros,
  MAX_LEDGER_USD_MICROS,
  matchesEstimatedCostParkedTask,
  microsToUsd,
  modelAttemptEstimateKey,
  modelAttemptSampleOutcome,
  nextUtcDailyReset,
  nextUtcMonthlyReset,
  parseEstimatedCostQuote,
  parseEstimatedCostReceipt,
  projectEstimatedCostRequest,
  type Records,
  type ReservationActual,
  type ReserveCostInput,
  type ReserveOutcome,
  staleModelAttemptEstimate,
  storedLedgerUsdToMicros,
  storedTaskBudgetToMicros,
  usdToMicros,
} from '@assistant/persistence';
import {
  type DocumentSnapshot,
  FieldPath,
  type QueryDocumentSnapshot,
  Timestamp,
  type Transaction,
} from '@google-cloud/firestore';
import { withEmulatorTransactionRetry } from './emulator-transaction.js';
import { firestoreEstimatedCostBaseline } from './estimated-cost-baseline.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/** Missing period counters are acceptable only when no cost event supports a charge. */
export async function hasCostEventAccountedSince(
  tx: Transaction,
  store: InstallationStore,
  periodStart: Date,
): Promise<boolean> {
  const limit = 100;
  const events = await tx.get(
    store
      .collection('costEvents')
      .where('createdAt', '>=', periodStart)
      .select('accountedAt')
      .limit(limit),
  );
  return (
    events.size === limit ||
    events.docs.some((event) => {
      const stamp = decodeRecord<Date | null | undefined>(event.get('accountedAt'));
      return !(stamp instanceof Date && stamp < periodStart);
    })
  );
}

interface Policy {
  dailyLimitMicros: number;
  monthlyLimitMicros: number;
  softPct: number;
}

function integer(snapshot: DocumentSnapshot, field: string): number {
  const value: unknown = snapshot.get(field) ?? 0;
  if (typeof value !== 'number') throw new Error(`Invalid ledger counter ${field}`);
  microsToUsd(value);
  return value;
}

function policy(snapshot: DocumentSnapshot): Policy {
  if (!snapshot.exists) throw new Error('Budget policy has not been initialized');
  const data = snapshot.data() as Policy;
  microsToUsd(data.dailyLimitMicros);
  microsToUsd(data.monthlyLimitMicros);
  if (!Number.isInteger(data.softPct) || data.softPct < 0 || data.softPct > 100) {
    throw new Error('Invalid budget policy');
  }
  return data;
}

function fingerprint(input: ReserveCostInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.source,
        usdToMicros(input.estimatedUsd),
        input.taskId ?? null,
        input.description ?? '',
      ]),
    )
    .digest('hex');
}

function costEventId(key: string): ReturnType<typeof randomUUID> {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20)}`;
}

/** Counters, hold transitions, ledger events, and per-task spend commit together. */
export class FirestoreCostRepository implements CostRepository {
  readonly kind = 'cost-repository' as const;

  constructor(private readonly store: InstallationStore) {}

  /** Compatible-off reads and declines; no new quote or approval is created. */
  estimatedCostApprovalRepository(
    options: { mutationsEnabled?: () => boolean } = {},
  ): EstimatedCostApprovalRepository {
    const unavailable = {
      ok: false,
      outcome: 'unavailable',
      message: 'Estimated cost approval is unavailable.',
    } as const;
    const enabled = () => {
      try {
        return options.mutationsEnabled?.() === true;
      } catch {
        return false;
      }
    };
    return {
      getOverview: async (actor) => {
        const view = await this.readEstimatedCostSnapshot(actor);
        return view
          ? { ok: true, requests: view.requests, tracking: view.tracking }
          : {
              ok: false,
              outcome: 'unavailable',
              message: 'Estimated cost approval is unavailable.',
            };
      },
      getQuote: async (actor, operationId) => {
        const view = await this.readEstimatedCostView(actor, operationId);
        return view
          ? { ok: true, ...view }
          : { ok: false, outcome: 'not_found', operationId, message: 'Request not found.' };
      },
      storePreparedQuote: async (prepared) => {
        if (!enabled()) return unavailable;
        const { storePreparedFirestoreQuote } = await import(
          './estimated-cost-approval-transactions.js'
        );
        return storePreparedFirestoreQuote(this.store, prepared);
      },
      decide: async (actor, decision) => {
        if (decision.decision === 'decline')
          return this.declineEstimatedCostRequest(actor, decision);
        if (!enabled()) return unavailable;
        const { approveFirestoreEstimatedCost } = await import(
          './estimated-cost-approval-transactions.js'
        );
        return approveFirestoreEstimatedCost(this.store, actor, decision);
      },
      getDecisionReceipt: async (actor, identity) => {
        const receipt = await this.readEstimatedCostDecision(actor, identity);
        return receipt
          ? { ok: true, receipt }
          : {
              ok: false,
              outcome: 'not_found',
              ...identity,
              message: 'Decision receipt not found.',
            };
      },
    };
  }

  private async declineEstimatedCostRequest(
    actor: EstimatedCostActor,
    decision: EstimatedCostDecision,
  ): Promise<EstimatedCostDecisionResponse> {
    if (actor.installationId !== this.store.installationId)
      return {
        ok: false,
        outcome: 'not_found',
        operationId: decision.operationId,
        message: 'Request not found.',
      };
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
    const requestRef = this.store.doc('estimatedCostRequests', decision.operationId);
    const decisionRef = this.store.doc('estimatedCostDecisions', decision.decisionId);
    return this.store.db.runTransaction(async (tx) => {
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
          return {
            ok: false,
            outcome: 'conflict',
            operationId: decision.operationId,
            decisionId: decision.decisionId,
            message: 'Decision identity already used.',
          };
        const receipt = parseEstimatedCostReceipt(decodeRecord(prior.get('receipt')), decision);
        if (!receipt) throw new Error('Invalid stored estimated cost receipt');
        return { ok: true, receipt };
      }
      const quote = parseEstimatedCostQuote(decodeRecord(request.get('quote')));
      const taskId: unknown = request.get('taskId');
      const fingerprint: unknown = request.get('requestFingerprint');
      if (
        !quote ||
        typeof taskId !== 'string' ||
        typeof fingerprint !== 'string' ||
        quote.operationId !== decision.operationId ||
        quote.taskId !== taskId
      )
        throw new Error('Invalid stored estimated cost request');
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
          createdAt: this.store.now(),
        });
        return { ok: true, receipt };
      }
      if (!['pending', 'expired_or_needs_refresh'].includes(String(request.get('state'))))
        return {
          ok: false,
          outcome: 'conflict',
          operationId: decision.operationId,
          decisionId: decision.decisionId,
          message: 'Request is already resolved.',
        };
      const taskRef = this.store.doc('tasks', taskId);
      const snapshot = await tx.get(taskRef);
      const task = snapshot.exists ? decodeRecord<Records['tasks']>(snapshot.data()) : null;
      if (
        !task ||
        !matchesEstimatedCostParkedTask(task, {
          actor,
          taskId,
          operationId: decision.operationId,
          requestFingerprint: fingerprint,
        })
      )
        return {
          ok: false,
          outcome: 'unavailable',
          operationId: decision.operationId,
          decisionId: decision.decisionId,
          message: 'Request could not be closed.',
        };
      const holdsRef = this.store.doc('coordination', 'budget-holds');
      const holds = await tx.get(holdsRef);
      if (!holds.exists || typeof holds.get('heldMicros') !== 'number')
        return {
          ok: false,
          outcome: 'unavailable',
          operationId: decision.operationId,
          decisionId: decision.decisionId,
          message: 'Request could not be closed.',
        };
      const heldMicros = integer(holds, 'heldMicros');
      const receipt = {
        operationId: decision.operationId,
        decisionId: decision.decisionId,
        quoteId: decision.quoteId,
        status: 'declined' as const,
      };
      const now = this.store.now();
      tx.update(taskRef, {
        status: 'cancelled',
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        updatedAt: now,
      });
      tx.update(requestRef, { state: 'declined', updatedAt: now });
      tx.set(holdsRef, { heldMicros });
      tx.create(decisionRef, {
        decisionId: decision.decisionId,
        operationId: decision.operationId,
        bodyDigest,
        receipt,
        createdAt: now,
      });
      return { ok: true, receipt };
    });
  }

  /** Current request lifecycle; this does not confirm a particular device decision. */
  async readEstimatedCostRequest(
    actor: EstimatedCostActor,
    operationId: string,
  ): Promise<EstimatedCostRequestProjection | null> {
    return (await this.readEstimatedCostView(actor, operationId))?.request ?? null;
  }

  /** Request and current totals are read in one transaction. */
  async readEstimatedCostView(actor: EstimatedCostActor, operationId: string) {
    const view = await this.readEstimatedCostSnapshot(actor, operationId);
    return view?.request ? { request: view.request, tracking: view.tracking } : null;
  }

  private async readEstimatedCostSnapshot(
    actor: EstimatedCostActor,
    operationId?: string,
  ): Promise<{
    request?: EstimatedCostRequestProjection;
    requests: EstimatedCostRequestProjection[] | null;
    tracking: EstimatedCostBudgetTracking;
  } | null> {
    if (actor.installationId !== this.store.installationId) return null;
    return this.store.db.runTransaction(
      async (tx) => {
        const now = this.store.now().getTime();
        if (!Number.isFinite(now)) throw new Error('Invalid store clock');
        let projection: EstimatedCostRequestProjection | undefined;
        if (operationId !== undefined) {
          const request = await tx.get(this.store.doc('estimatedCostRequests', operationId));
          if (
            !request.exists ||
            request.get('installationId') !== actor.installationId ||
            request.get('ownerId') !== actor.ownerId
          )
            return null;
          const quote = parseEstimatedCostQuote(decodeRecord(request.get('quote')));
          const taskId: unknown = request.get('taskId');
          const state: unknown = request.get('state');
          if (!quote || typeof taskId !== 'string' || typeof state !== 'string')
            throw new Error('Invalid stored estimated cost request');
          let selected: { quoteId: string; expiresAt: string; expired: boolean } | undefined;
          if (state === 'approved') {
            const grants = await tx.get(
              this.store
                .collection('estimatedCostGrants')
                .where('operationId', '==', operationId)
                .limit(501),
            );
            if (grants.size >= 501) throw new Error('Incomplete estimated cost grants');
            const matching = grants.docs.filter((doc) => doc.get('quoteId') === quote.quoteId);
            if (matching.length !== 1 || !matching[0])
              throw new Error('Invalid stored estimated cost grant');
            const expiry = decodeRecord<Date>(matching[0].get('expiresAt'));
            if (!(expiry instanceof Date) || !Number.isFinite(expiry.getTime()))
              throw new Error('Invalid stored estimated cost grant expiry');
            selected = {
              quoteId: quote.quoteId,
              expiresAt: expiry.toISOString(),
              expired: expiry.getTime() <= now,
            };
          }
          projection = projectEstimatedCostRequest({
            operationId,
            taskId,
            state,
            quote,
            quoteExpired: Date.parse(quote.expiresAt) <= now,
            ...(selected ? { grant: selected } : {}),
          });
        }
        const refs = this.refs(new Date(now));
        const [holds, daily, monthly] = await tx.getAll(refs.holds, refs.daily, refs.monthly);
        const pending = await tx.get(
          this.store.collection('estimatedCostRequests').where('state', '==', 'pending').limit(501),
        );
        const unknown = await tx.get(
          this.store.collection('costReservations').where('status', '==', 'unknown').limit(1),
        );
        const baseline = await tx.get(
          this.store.doc('estimatedCostBaselines', actor.installationId),
        );
        if (
          new Date(now).toISOString().slice(0, 10) !== this.store.now().toISOString().slice(0, 10)
        )
          throw new Error('Budget period changed during read');
        const counter = (doc: DocumentSnapshot | undefined, field: string): number | null => {
          if (!doc?.exists || typeof doc.get(field) !== 'number') return null;
          const value = doc.get(field) as number;
          return Number.isSafeInteger(value) && value >= 0 ? value : null;
        };
        const dailyMicros = counter(daily, 'spentMicros');
        const monthlyMicros = counter(monthly, 'spentMicros');
        const heldMicros = counter(holds, 'heldMicros');
        let pendingMicros: number | null = pending.size >= 501 ? null : 0;
        let requests: EstimatedCostRequestProjection[] | null = pendingMicros === null ? null : [];
        if (pendingMicros !== null)
          for (const row of pending.docs) {
            const pendingQuote = parseEstimatedCostQuote(decodeRecord(row.get('quote')));
            if (
              row.get('installationId') !== actor.installationId ||
              typeof row.get('ownerId') !== 'string' ||
              !row.get('ownerId') ||
              !pendingQuote ||
              row.get('operationId') !== pendingQuote.operationId ||
              row.get('taskId') !== pendingQuote.taskId
            ) {
              pendingMicros = null;
              requests = null;
              break;
            }
            const expired = Date.parse(pendingQuote.expiresAt) <= now;
            if (!expired) pendingMicros = addMicros(pendingMicros, pendingQuote.allowanceMicros);
            if (row.get('ownerId') === actor.ownerId)
              requests?.push(
                projectEstimatedCostRequest({
                  operationId: pendingQuote.operationId,
                  taskId: pendingQuote.taskId,
                  state: 'pending',
                  quote: pendingQuote,
                  quoteExpired: expired,
                }),
              );
          }
        if (operationId === undefined && requests !== null) {
          const expired = await tx.get(
            this.store
              .collection('estimatedCostRequests')
              .where('state', '==', 'expired_or_needs_refresh')
              .limit(501),
          );
          if (expired.size >= 501) requests = null;
          else
            for (const row of expired.docs) {
              const quote = parseEstimatedCostQuote(decodeRecord(row.get('quote')));
              if (
                row.get('installationId') !== actor.installationId ||
                typeof row.get('ownerId') !== 'string' ||
                !row.get('ownerId') ||
                !quote ||
                row.get('operationId') !== quote.operationId ||
                row.get('taskId') !== quote.taskId
              ) {
                requests = null;
                break;
              }
              if (row.get('ownerId') === actor.ownerId)
                requests.push(
                  projectEstimatedCostRequest({
                    operationId: quote.operationId,
                    taskId: quote.taskId,
                    state: 'expired_or_needs_refresh',
                    quote,
                    quoteExpired: true,
                  }),
                );
            }
        }
        // A positive aggregate without a complete provenance inventory cannot prove
        // that an omitted/malformed reservation is not an unknown liability.
        let historicalUnknownMicros: number | null = unknown.empty && heldMicros === 0 ? 0 : null;
        if (baseline.exists) {
          const verified =
            heldMicros === null
              ? null
              : await firestoreEstimatedCostBaseline(tx, this.store, actor, heldMicros);
          historicalUnknownMicros = verified?.eligibleMicros ?? null;
        }
        const tracking: EstimatedCostBudgetTracking = {
          observedAt: new Date(now).toISOString(),
          complete:
            dailyMicros !== null &&
            monthlyMicros !== null &&
            heldMicros !== null &&
            pendingMicros !== null &&
            historicalUnknownMicros !== null,
          recordedDailyMicros: dailyMicros,
          recordedMonthlyMicros: monthlyMicros,
          totalHeldMicros: heldMicros,
          historicalUnknownMicros,
          pendingApprovalMicros: pendingMicros,
          dailyPlannedExposureMicros:
            dailyMicros === null || heldMicros === null || pendingMicros === null
              ? null
              : addMicros(dailyMicros, heldMicros, pendingMicros),
          monthlyPlannedExposureMicros:
            monthlyMicros === null || heldMicros === null || pendingMicros === null
              ? null
              : addMicros(monthlyMicros, heldMicros, pendingMicros),
        };
        return { ...(projection ? { request: projection } : {}), requests, tracking };
      },
      { readOnly: true },
    );
  }

  /** Canonical receipt read for the exact operation and decision, scoped to the owner. */
  async readEstimatedCostDecision(
    actor: EstimatedCostActor,
    identity: { operationId: string; decisionId: string },
  ): Promise<EstimatedCostDecisionReceipt | null> {
    if (actor.installationId !== this.store.installationId) return null;
    return this.store.db.runTransaction(
      async (tx) => {
        const [request, decision] = await tx.getAll(
          this.store.doc('estimatedCostRequests', identity.operationId),
          this.store.doc('estimatedCostDecisions', identity.decisionId),
        );
        if (
          !request?.exists ||
          request.get('installationId') !== actor.installationId ||
          request.get('ownerId') !== actor.ownerId ||
          !decision?.exists ||
          decision.get('operationId') !== identity.operationId
        )
          return null;
        const receipt = parseEstimatedCostReceipt(decodeRecord(decision.get('receipt')), identity);
        if (!receipt) throw new Error('Invalid stored estimated cost receipt');
        return receipt;
      },
      { readOnly: true },
    );
  }

  /** Atomically move pre-reserved capacity from escrow to one attempt. */
  async drawEstimatedCostGrant(
    input: EstimatedCostGrantDraw,
  ): Promise<EstimatedCostGrantDrawResult> {
    if (input.actor.installationId !== this.store.installationId)
      return { ok: false, reason: 'unavailable' };
    if (!Number.isSafeInteger(input.estimatedMicros) || input.estimatedMicros <= 0)
      throw new Error('Invalid grant draw amount');
    const requestRef = this.store.doc('estimatedCostRequests', input.operationId);
    const grantRef = this.store.doc('estimatedCostGrants', input.grantId);
    const attemptRef = this.store.doc('costReservations', input.attemptId);
    return this.store.db.runTransaction(async (tx) => {
      const [request, grant, existing] = await tx.getAll(requestRef, grantRef, attemptRef);
      if (
        !request?.exists ||
        request.get('installationId') !== input.actor.installationId ||
        request.get('ownerId') !== input.actor.ownerId ||
        request.get('taskId') !== input.taskId ||
        request.get('bindingDigest') !== input.bindingDigest ||
        request.get('state') !== 'approved' ||
        !grant?.exists ||
        grant.get('operationId') !== input.operationId
      )
        return { ok: false, reason: 'unavailable' };
      const storedQuote: unknown = request.get('quote');
      if (
        !storedQuote ||
        typeof storedQuote !== 'object' ||
        Array.isArray(storedQuote) ||
        (storedQuote as { quoteId?: unknown }).quoteId !== grant.get('quoteId')
      )
        return { ok: false, reason: 'unavailable' };
      const expiry = decodeRecord<Date>(grant.get('expiresAt'));
      if (!(expiry instanceof Date) || !Number.isFinite(expiry.getTime()))
        throw new Error('Invalid grant expiry');
      if (expiry.getTime() <= this.store.now().getTime()) return { ok: false, reason: 'expired' };
      const decimal = microsToUsd(input.estimatedMicros).toFixed(6);
      if (existing?.exists) {
        if (
          existing.get('reservationKind') !== 'attempt' ||
          existing.get('costGrantId') !== input.grantId ||
          existing.get('taskId') !== input.taskId ||
          existing.get('source') !== input.source ||
          existing.get('estimatedUsd') !== decimal ||
          existing.get('description') !== input.description
        )
          throw new Error('Grant attempt ID reused for different work');
        return existing.get('status') === 'held'
          ? { ok: true, reservationId: input.attemptId }
          : { ok: false, reason: 'closed' };
      }
      const escrowId = grant.get('escrowReservationId');
      if (typeof escrowId !== 'string' || !escrowId)
        throw new Error('Invalid grant escrow identity');
      const escrowRef = this.store.doc('costReservations', escrowId);
      const refs = this.refs(this.store.now(), input.taskId);
      if (!refs.taskHolds) throw new Error('Missing task hold reference');
      const [escrow, holds, taskHolds] = await tx.getAll(escrowRef, refs.holds, refs.taskHolds);
      if (
        !escrow?.exists ||
        escrow.get('status') !== 'held' ||
        escrow.get('reservationKind') !== 'escrow' ||
        escrow.get('costGrantId') !== input.grantId ||
        escrow.get('taskId') !== input.taskId
      )
        return { ok: false, reason: 'unavailable' };
      if (!holds?.exists || !taskHolds?.exists) throw new Error('Missing grant hold counters');
      const balance = storedLedgerUsdToMicros(escrow.get('estimatedUsd'));
      const allowance: unknown = grant.get('allowanceMicros');
      const consumed: unknown = grant.get('consumedMicros');
      if (
        typeof allowance !== 'number' ||
        typeof consumed !== 'number' ||
        !Number.isSafeInteger(allowance) ||
        !Number.isSafeInteger(consumed) ||
        consumed < 0 ||
        consumed > allowance ||
        balance !== allowance - consumed ||
        integer(holds, 'heldMicros') < balance ||
        integer(taskHolds, 'heldMicros') < balance
      )
        throw new Error('Invalid grant escrow balance');
      if (input.estimatedMicros > balance) return { ok: false, reason: 'exhausted' };
      if (expiry.getTime() <= this.store.now().getTime()) return { ok: false, reason: 'expired' };
      tx.update(escrowRef, {
        estimatedUsd: microsToUsd(balance - input.estimatedMicros).toFixed(6),
      });
      tx.update(grantRef, { consumedMicros: consumed + input.estimatedMicros });
      tx.create(attemptRef, {
        id: input.attemptId,
        taskId: input.taskId,
        source: input.source,
        estimatedUsd: decimal,
        actualUsd: null,
        status: 'held',
        reservationKind: 'attempt',
        costGrantId: input.grantId,
        description: input.description,
        fingerprint: fingerprint({
          source: input.source,
          estimatedUsd: microsToUsd(input.estimatedMicros),
          taskId: input.taskId,
          description: input.description,
        }),
        createdAt: this.store.now(),
        reconciledAt: null,
      });
      return { ok: true, reservationId: input.attemptId };
    });
  }

  /** Release only an expired grant's unused escrow; dispatched and unknown children remain held. */
  async expireEstimatedCostGrant(grantId: string): Promise<boolean> {
    const grantRef = this.store.doc('estimatedCostGrants', grantId);
    return this.store.db.runTransaction(async (tx) => {
      const grant = await tx.get(grantRef);
      if (!grant.exists) return false;
      const expiry = decodeRecord<Date>(grant.get('expiresAt'));
      if (!(expiry instanceof Date) || !Number.isFinite(expiry.getTime()))
        throw new Error('Invalid grant expiry');
      if (expiry.getTime() > this.store.now().getTime()) return false;
      const escrowId = grant.get('escrowReservationId');
      if (typeof escrowId !== 'string' || !escrowId)
        throw new Error('Invalid grant escrow identity');
      const escrowRef = this.store.doc('costReservations', escrowId);
      const escrow = await tx.get(escrowRef);
      if (!escrow.exists || escrow.get('status') === 'released') return false;
      if (
        escrow.get('status') !== 'held' ||
        escrow.get('reservationKind') !== 'escrow' ||
        escrow.get('costGrantId') !== grantId
      )
        throw new Error('Invalid grant escrow');
      const taskId = escrow.get('taskId');
      if (typeof taskId !== 'string' || !taskId) throw new Error('Invalid grant task');
      const refs = this.refs(this.store.now(), taskId);
      if (!refs.taskHolds) throw new Error('Missing task hold reference');
      const [holds, taskHolds] = await tx.getAll(refs.holds, refs.taskHolds);
      if (!holds?.exists || !taskHolds?.exists) throw new Error('Missing grant hold counters');
      const held = integer(holds, 'heldMicros');
      const taskHeld = integer(taskHolds, 'heldMicros');
      const balance = storedLedgerUsdToMicros(escrow.get('estimatedUsd'));
      const allowance: unknown = grant.get('allowanceMicros');
      const consumed: unknown = grant.get('consumedMicros');
      if (
        typeof allowance !== 'number' ||
        typeof consumed !== 'number' ||
        !Number.isSafeInteger(allowance) ||
        !Number.isSafeInteger(consumed) ||
        consumed < 0 ||
        consumed > allowance ||
        balance !== allowance - consumed ||
        held < balance ||
        taskHeld < balance
      )
        throw new Error('Invalid grant escrow balance');
      tx.update(escrowRef, { status: 'released', reconciledAt: this.store.now() });
      tx.set(refs.holds, { heldMicros: held - balance });
      tx.set(refs.taskHolds, { heldMicros: taskHeld - balance });
      return true;
    });
  }

  async getRate(key: string) {
    const snapshot = await this.store.doc('rateTable', key).get();
    if (!snapshot.exists) return null;
    const unitPriceUsd = Number(snapshot.get('unitPriceUsd'));
    if (!Number.isFinite(unitPriceUsd) || unitPriceUsd < 0) throw new Error('Invalid cost rate');
    return { unit: String(snapshot.get('unit')), unitPriceUsd };
  }

  private refs(now: Date, taskId?: string | null) {
    return {
      policy: this.store.doc('coordination', 'budget-policy'),
      holds: this.store.doc('coordination', 'budget-holds'),
      daily: this.store.doc('budgetPeriods', `day:${now.toISOString().slice(0, 10)}`),
      monthly: this.store.doc('budgetPeriods', `month:${now.toISOString().slice(0, 7)}`),
      ...(taskId
        ? {
            task: this.store.doc('tasks', taskId),
            taskHolds: this.store.doc('taskBudgetHolds', taskId),
          }
        : {}),
    };
  }

  private async periodHolds(tx: Transaction, now: Date, held: number) {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    if (held === 0) return { dailyHeld: 0, monthlyHeld: 0 };

    // Reuse the stale-dispatch index. The global hold document is the write
    // fence even while the amount stays unchanged during an unknown transition.
    const oldAttempts = await tx.get(
      this.store
        .collection('costReservations')
        .where('status', '==', 'unknown')
        .where('attemptStartedAt', '<', dayStart)
        .orderBy('attemptStartedAt')
        .select(
          'status',
          'source',
          'reservationKind',
          'costGrantId',
          'attemptStartedAt',
          'createdAt',
          'estimatedUsd',
        )
        .limit(500),
    );

    let dailyRelief = 0;
    let monthlyRelief = 0;
    for (const reservation of oldAttempts.docs) {
      const startedAt = this.accountableUnknownAttempt(reservation, now);
      if (!startedAt) continue;
      const estimate = storedLedgerUsdToMicros(reservation.get('estimatedUsd'));
      dailyRelief = addMicros(dailyRelief, estimate);
      if (startedAt < monthStart) monthlyRelief = addMicros(monthlyRelief, estimate);
    }
    if (dailyRelief > held) throw new Error('Unknown attempts exceed total budget hold');
    return { dailyHeld: held - dailyRelief, monthlyHeld: held - monthlyRelief };
  }

  private accountableUnknownAttempt(reservation: DocumentSnapshot, now: Date): Date | undefined {
    const kind = reservation.get('reservationKind');
    if (
      reservation.get('status') !== 'unknown' ||
      reservation.get('source') !== 'model' ||
      (kind !== undefined && kind !== 'attempt') ||
      reservation.get('costGrantId') != null
    )
      return;
    const startedAt = decodeRecord<Date>(reservation.get('attemptStartedAt'));
    const createdAt = decodeRecord<Date>(reservation.get('createdAt'));
    if (
      startedAt instanceof Date &&
      createdAt instanceof Date &&
      startedAt >= createdAt &&
      startedAt <= now
    )
      return startedAt;
  }

  async totals(): Promise<CostTotals> {
    return this.store.db.runTransaction(
      async (tx) => {
        const now = this.store.now();
        const refs = this.refs(now);
        const [p, holds, daily, monthly] = await tx.getAll(
          refs.policy,
          refs.holds,
          refs.daily,
          refs.monthly,
        );
        if (!p || !holds || !daily || !monthly) throw new Error('Incomplete budget snapshot');
        const limits = policy(p);
        const held = integer(holds, 'heldMicros');
        const { dailyHeld, monthlyHeld } = await this.periodHolds(tx, now, held);
        return {
          dailySpentUsd: microsToUsd(integer(daily, 'spentMicros')),
          monthlySpentUsd: microsToUsd(integer(monthly, 'spentMicros')),
          heldUsd: microsToUsd(held),
          dailyHeldUsd: microsToUsd(dailyHeld),
          monthlyHeldUsd: microsToUsd(monthlyHeld),
          dailyLimitUsd: microsToUsd(limits.dailyLimitMicros),
          monthlyLimitUsd: microsToUsd(limits.monthlyLimitMicros),
          softPct: limits.softPct,
        };
      },
      { readOnly: true },
    );
  }

  async reserve(input: ReserveCostInput): Promise<ReserveOutcome> {
    const amount = ledgerUsdToMicros(input.estimatedUsd);
    if (amount <= 0) throw new Error('Cost estimate must be at least one microdollar');
    const id = input.operationId ?? randomUUID();
    const ref = this.store.doc('costReservations', id);
    const signature = fingerprint(input);
    return this.store.db.runTransaction(async (tx): Promise<ReserveOutcome> => {
      const now = this.store.now();
      const refs = this.refs(now, input.taskId);
      const [existing, p, holds, daily, monthly] = await tx.getAll(
        ref,
        refs.policy,
        refs.holds,
        refs.daily,
        refs.monthly,
      );
      if (!existing || !p || !holds || !daily || !monthly)
        throw new Error('Incomplete budget snapshot');
      if (existing.exists) {
        if (existing.get('fingerprint') !== signature)
          throw new Error('Reservation ID reused for different work');
        if (existing.get('status') === 'held') return { ok: true, reservationId: id };
        return {
          ok: false,
          reason: 'reservation already closed; do not repeat provider work',
          resumeAt: nextUtcDailyReset(now),
        };
      }
      const limits = policy(p);
      const held = integer(holds, 'heldMicros');
      const factor = input.critical ? 1.1 : 1;
      const dailySpent = integer(daily, 'spentMicros');
      const monthlySpent = integer(monthly, 'spentMicros');
      const dailyCap = Math.floor(limits.dailyLimitMicros * factor);
      const monthlyCap = Math.floor(limits.monthlyLimitMicros * factor);
      const needsPeriodHolds =
        addMicros(dailySpent, held, amount) > dailyCap ||
        addMicros(monthlySpent, held, amount) > monthlyCap;
      const { dailyHeld, monthlyHeld } = needsPeriodHolds
        ? await this.periodHolds(tx, now, held)
        : { dailyHeld: held, monthlyHeld: held };
      for (const [name, spent, periodHeld, cap, reset] of [
        ['monthly', monthlySpent, monthlyHeld, monthlyCap, nextUtcMonthlyReset(now)],
        ['daily', dailySpent, dailyHeld, dailyCap, nextUtcDailyReset(now)],
      ] as const) {
        if (addMicros(spent, periodHeld, amount) > cap) {
          return {
            ok: false,
            reason: `${name} budget cannot cover this reservation`,
            budget: { scope: name, nextAttemptMicros: amount },
            resumeAt: reset,
          };
        }
      }
      let taskHeld = 0;
      if (refs.task && refs.taskHolds) {
        const [task, taskHolds] = await tx.getAll(refs.task, refs.taskHolds);
        if (!task?.exists || !taskHolds) throw new Error('Reservation task does not exist');
        taskHeld = integer(taskHolds, 'heldMicros');
        const spent = storedLedgerUsdToMicros(task.get('spentUsd') ?? '0');
        const limit = storedTaskBudgetToMicros(task.get('budgetUsdLimit'));
        if (taskHeld > MAX_LEDGER_USD_MICROS - spent - amount) {
          return {
            ok: false,
            reason: 'task ledger storage capacity cannot cover this reservation',
            resumeAt: nextUtcDailyReset(now),
          };
        }
        if (addMicros(spent, taskHeld, amount) > Math.floor(limit * factor)) {
          return {
            ok: false,
            reason: 'task budget cannot cover this reservation',
            budget: { scope: 'task', nextAttemptMicros: amount },
            resumeAt: nextUtcDailyReset(now),
          };
        }
      }
      tx.set(refs.holds, { heldMicros: addMicros(held, amount) });
      if (refs.taskHolds) tx.set(refs.taskHolds, { heldMicros: addMicros(taskHeld, amount) });
      tx.create(ref, {
        id,
        taskId: input.taskId ?? null,
        source: input.source,
        estimatedUsd: microsToUsd(amount).toFixed(6),
        actualUsd: null,
        status: 'held',
        description: input.description ?? '',
        fingerprint: signature,
        createdAt: now,
        reconciledAt: null,
      });
      return { ok: true, reservationId: id };
    });
  }

  async beginEstimatedCostGrantAttempt(
    input: import('@assistant/persistence').EstimatedCostGrantAttempt,
  ): Promise<boolean> {
    const { beginFirestoreEstimatedCostGrantAttempt } = await import(
      './estimated-cost-approval-transactions.js'
    );
    return beginFirestoreEstimatedCostGrantAttempt(this.store, input);
  }

  async parkEstimatedCostGrantRenewal(
    input: import('@assistant/persistence').EstimatedCostGrantRenewal,
  ): Promise<boolean> {
    const { parkFirestoreEstimatedCostGrantRenewal } = await import(
      './estimated-cost-approval-transactions.js'
    );
    return parkFirestoreEstimatedCostGrantRenewal(this.store, input);
  }

  async beginAttempt(
    reservationId: string,
    metadata: import('@assistant/persistence').CostAttemptMetadata,
  ): Promise<boolean> {
    const ref = this.store.doc('costReservations', reservationId);
    return this.store.db.runTransaction(async (tx) => {
      const reservation = await tx.get(ref);
      if (!reservation.exists || reservation.get('status') !== 'held') return false;
      const kind = reservation.get('reservationKind');
      if ((kind !== undefined && kind !== 'attempt') || reservation.get('costGrantId') != null)
        return false;
      tx.update(ref, {
        status: 'dispatching',
        attemptStartedAt: this.store.now(),
        attemptMetadata: metadata,
      });
      return true;
    });
  }

  async markAttemptUnknown(
    reservationId: string,
    reason: string,
    providerReceipt?: CostProviderReceipt,
  ): Promise<void> {
    const ref = this.store.doc('costReservations', reservationId);
    await withEmulatorTransactionRetry(() =>
      this.store.db.runTransaction(async (tx) => {
        const reservation = await tx.get(ref);
        if (
          !reservation.exists ||
          (reservation.get('reservationKind') !== undefined &&
            reservation.get('reservationKind') !== 'attempt') ||
          !['dispatching', 'unknown'].includes(String(reservation.get('status')))
        )
          return;
        const holdsRef = this.store.doc('coordination', 'budget-holds');
        const holds = await tx.get(holdsRef);
        if (
          !holds.exists ||
          integer(holds, 'heldMicros') < storedLedgerUsdToMicros(reservation.get('estimatedUsd'))
        )
          throw new Error('Missing budget hold for unknown attempt');
        tx.set(holdsRef, { heldMicros: integer(holds, 'heldMicros') });
        tx.update(ref, {
          status: 'unknown',
          unknownReason: reason.slice(0, 500),
          ...(providerReceipt
            ? {
                attemptMetadata: {
                  ...((reservation.get('attemptMetadata') as object) ?? {}),
                  ...providerReceipt,
                },
              }
            : {}),
        });
      }),
    );
  }

  /** Update the original period and receipt together, with no second ledger event. */
  private async correctModelAttemptEstimate(
    tx: Transaction,
    reservation: DocumentSnapshot,
    reservationId: string,
    actual: ReservationActual,
  ): Promise<boolean> {
    const kind = reservation.get('reservationKind');
    if (
      reservation.get('source') !== 'model' ||
      (kind !== undefined && kind !== 'attempt') ||
      reservation.get('costGrantId') != null ||
      !canCorrectModelAttemptEstimate(actual.evidence)
    )
      return false;
    const key = modelAttemptEstimateKey(reservationId);
    const eventRef = this.store.doc('costEvents', costEventId(key));
    const event = await tx.get(eventRef);
    if (
      !event.exists ||
      event.get('reservationId') !== reservationId ||
      event.get('idempotencyKey') !== key ||
      event.get('evidence.modelAttemptEstimate') !== 'usage_missing_after_ttl'
    )
      return false;
    const prior = storedLedgerUsdToMicros(event.get('usd'));
    if (
      reservation.get('actualUsd') != null ||
      prior !== storedLedgerUsdToMicros(reservation.get('estimatedUsd'))
    )
      throw new Error('Model estimate does not match its reservation');
    const amount = ledgerUsdToMicros(actual.usd);
    const usd = microsToUsd(amount).toFixed(6);
    const accountedAt = decodeRecord<Date>(event.get('accountedAt') ?? event.get('createdAt'));
    if (!(accountedAt instanceof Date) || !Number.isFinite(accountedAt.getTime()))
      throw new Error('Invalid model estimate settlement period');
    const refs = this.refs(accountedAt, reservation.get('taskId'));
    const [holds, daily, monthly] = await tx.getAll(refs.holds, refs.daily, refs.monthly);
    if (!holds?.exists || !daily?.exists || !monthly?.exists)
      throw new Error('Missing model estimate counters');
    const task = refs.task ? await tx.get(refs.task) : null;
    if (task && !task.exists) throw new Error('Ledger task does not exist');
    const dailySpent = addMicros(integer(daily, 'spentMicros') - prior, amount);
    const monthlySpent = addMicros(integer(monthly, 'spentMicros') - prior, amount);
    const taskSpend = task
      ? addLedgerMicros(storedLedgerUsdToMicros(task.get('spentUsd')) - prior, amount)
      : null;
    tx.set(refs.holds, { heldMicros: integer(holds, 'heldMicros') });
    tx.set(refs.daily, { spentMicros: dailySpent });
    tx.set(refs.monthly, { spentMicros: monthlySpent });
    if (task && taskSpend !== null)
      tx.update(task.ref, {
        spentUsd: microsToUsd(taskSpend).toFixed(6),
        updatedAt: this.store.now(),
      });
    tx.update(reservation.ref, { actualUsd: usd });
    tx.update(
      eventRef,
      encodeRecord({
        usd,
        evidence: actual.evidence,
        quantity: actual.quantity?.toFixed(4) ?? null,
        unit: actual.unit ?? null,
        unitPriceUsd: actual.unitPriceUsd?.toFixed(8) ?? null,
        toolCallId: actual.toolCallId ?? null,
        description: actual.description ?? reservation.get('description') ?? '',
      }),
    );
    return true;
  }

  private async settle(
    tx: Transaction,
    reservationId: string | null,
    actual: ReservationActual | null,
    direct?: CostEventInput,
    eventId = randomUUID(),
    staleBefore?: Date,
    estimateBefore?: Date,
  ): Promise<boolean> {
    const now = this.store.now();
    const reservationRef = reservationId ? this.store.doc('costReservations', reservationId) : null;
    const reservation = reservationRef ? await tx.get(reservationRef) : null;
    const reservationStatus = reservation?.get('status');
    const reservationKind = reservation?.get('reservationKind');
    if (
      reservation &&
      reservationId &&
      reservationStatus === 'reconciled' &&
      actual &&
      !estimateBefore
    )
      return this.correctModelAttemptEstimate(tx, reservation, reservationId, actual);
    const estimateKey =
      reservationId && estimateBefore ? modelAttemptEstimateKey(reservationId) : null;
    if (estimateBefore && reservation && estimateKey) {
      const startedAt = this.accountableUnknownAttempt(reservation, now);
      const evidence = staleModelAttemptEstimate(reservation.get('attemptMetadata'));
      if (!startedAt || startedAt > estimateBefore || !evidence) return false;
      actual = {
        usd: microsToUsd(storedLedgerUsdToMicros(reservation.get('estimatedUsd'))),
        evidence,
      };
      eventId = costEventId(estimateKey);
    }
    if (
      reservationRef &&
      (!reservation?.exists ||
        (reservationKind !== undefined && reservationKind !== 'attempt') ||
        (actual === null
          ? reservationStatus !== 'held'
          : !['held', 'dispatching', 'unknown'].includes(String(reservationStatus))))
    )
      return false;
    if (staleBefore && reservation) {
      const created = decodeRecord<Date>(reservation.get('createdAt'));
      if (!(created instanceof Date) || created >= staleBefore) return false;
    }
    const taskId: string | null = reservation?.get('taskId') ?? direct?.taskId ?? null;
    const accountedAt =
      actual && reservation && !estimateKey
        ? (this.accountableUnknownAttempt(reservation, now) ?? now)
        : now;
    const refs = this.refs(accountedAt, taskId);
    // Reservation status and event creation commit together, so the status guard
    // provides deduplication while the event retains its public UUID as its document ID.
    const eventRef = this.store.doc('costEvents', eventId);
    const [holds, daily, monthly, event] = await tx.getAll(
      refs.holds,
      refs.daily,
      refs.monthly,
      eventRef,
    );
    if (!holds || !daily || !monthly || !event) throw new Error('Incomplete ledger snapshot');
    if (event.exists) {
      if (direct?.idempotencyKey && event.get('idempotencyKey') === direct.idempotencyKey)
        return false;
      throw new Error('Ledger event already exists without a settled reservation');
    }
    const writesEvent = actual !== null || direct !== undefined;
    const amount = ledgerUsdToMicros(actual?.usd ?? direct?.usd ?? 0);
    const estimated = reservation ? storedLedgerUsdToMicros(reservation.get('estimatedUsd')) : 0;
    const held = integer(holds, 'heldMicros');
    if (held < estimated) throw new Error('Budget hold underflow');
    const shouldAddTaskSpend = writesEvent && Boolean(reservation || direct?.addToTaskSpend);
    let taskHeld = 0;
    let taskSpent = 0;
    if (refs.task && refs.taskHolds) {
      const [task, taskHolds] = await tx.getAll(refs.task, refs.taskHolds);
      if (!taskHolds || (!task?.exists && shouldAddTaskSpend))
        throw new Error('Ledger task does not exist');
      taskHeld = integer(taskHolds, 'heldMicros');
      taskSpent = storedLedgerUsdToMicros(task?.get('spentUsd') ?? '0');
      if (taskHeld < estimated) throw new Error('Task hold underflow');
    }
    let poolExtra = 0;
    let poolUpdate:
      | {
          grantRef: ReturnType<InstallationStore['doc']>;
          escrowRef: ReturnType<InstallationStore['doc']>;
          balance: number;
          consumed: number;
        }
      | undefined;
    const grantId: unknown = reservation?.get('costGrantId');
    if (actual !== null && grantId != null) {
      if (typeof grantId !== 'string' || !grantId || reservationKind !== 'attempt')
        throw new Error('Invalid grant provenance');
      const grantRef = this.store.doc('estimatedCostGrants', grantId);
      const grant = await tx.get(grantRef);
      if (!grant.exists) throw new Error('Missing grant for settlement');
      const escrowId: unknown = grant.get('escrowReservationId');
      if (typeof escrowId !== 'string' || !escrowId)
        throw new Error('Invalid grant escrow identity');
      const escrowRef = this.store.doc('costReservations', escrowId);
      const escrow = await tx.get(escrowRef);
      if (
        !escrow.exists ||
        escrow.get('reservationKind') !== 'escrow' ||
        escrow.get('costGrantId') !== grantId ||
        escrow.get('taskId') !== taskId ||
        !['held', 'released'].includes(String(escrow.get('status')))
      )
        throw new Error('Invalid grant escrow');
      if (escrow.get('status') === 'held') {
        const balance = storedLedgerUsdToMicros(escrow.get('estimatedUsd'));
        const allowance: unknown = grant.get('allowanceMicros');
        const consumed: unknown = grant.get('consumedMicros');
        if (
          typeof allowance !== 'number' ||
          typeof consumed !== 'number' ||
          !Number.isSafeInteger(allowance) ||
          !Number.isSafeInteger(consumed) ||
          consumed < 0 ||
          consumed > allowance ||
          balance !== allowance - consumed
        )
          throw new Error('Invalid grant escrow balance');
        poolExtra = Math.min(balance, Math.max(0, amount - estimated));
        if (held < estimated + poolExtra || taskHeld < estimated + poolExtra)
          throw new Error('Grant hold underflow');
        poolUpdate = { grantRef, escrowRef, balance, consumed };
      }
    }
    // All reads are complete before any writes: Firestore may rerun this callback.
    if (poolUpdate && poolExtra > 0) {
      tx.update(poolUpdate.escrowRef, {
        estimatedUsd: microsToUsd(poolUpdate.balance - poolExtra).toFixed(6),
      });
      tx.update(poolUpdate.grantRef, { consumedMicros: poolUpdate.consumed + poolExtra });
    }
    if (reservationRef) {
      tx.update(reservationRef, {
        status: writesEvent ? 'reconciled' : 'released',
        actualUsd: writesEvent && !estimateKey ? microsToUsd(amount).toFixed(6) : null,
        reconciledAt: now,
      });
      tx.set(refs.holds, { heldMicros: held - estimated - poolExtra });
      if (refs.taskHolds) tx.set(refs.taskHolds, { heldMicros: taskHeld - estimated - poolExtra });
    } else {
      // Direct spend and reservations contend on this same document.
      tx.set(refs.holds, { heldMicros: held });
    }
    if (writesEvent) {
      tx.set(refs.daily, { spentMicros: addMicros(integer(daily, 'spentMicros'), amount) });
      tx.set(refs.monthly, { spentMicros: addMicros(integer(monthly, 'spentMicros'), amount) });
      if (shouldAddTaskSpend && refs.task) {
        tx.update(refs.task, {
          spentUsd: microsToUsd(addLedgerMicros(taskSpent, amount)).toFixed(6),
          updatedAt: now,
        });
      }
      const details = actual ?? direct;
      tx.create(
        eventRef,
        encodeRecord({
          id: eventId,
          evidence: details?.evidence ?? { basis: 'unknown' },
          source: reservation?.get('source') ?? direct?.source,
          taskId,
          toolCallId: details?.toolCallId ?? null,
          reservationId,
          usd: microsToUsd(amount).toFixed(6),
          quantity: details?.quantity?.toFixed(4) ?? null,
          unit: details?.unit ?? null,
          unitPriceUsd: details?.unitPriceUsd?.toFixed(8) ?? null,
          description: details?.description ?? reservation?.get('description') ?? '',
          ...((estimateKey ?? direct?.idempotencyKey)
            ? { idempotencyKey: estimateKey ?? direct?.idempotencyKey }
            : {}),
          createdAt: now,
          ...(accountedAt !== now ? { accountedAt } : {}),
        }),
      );
    }
    return true;
  }

  async record(input: CostEventInput): Promise<void> {
    if (input.reservationId) throw new Error('Use reconcile to settle a reservation');
    const id = input.idempotencyKey ? costEventId(input.idempotencyKey) : randomUUID();
    await this.store.db.runTransaction((tx) => this.settle(tx, null, null, input, id));
  }

  async reconcile(reservationId: string, actual: ReservationActual): Promise<void> {
    ledgerUsdToMicros(actual.usd);
    const id = randomUUID();
    // Guarded by the reservation's held status, so a retry after a commit is a no-op.
    await withEmulatorTransactionRetry(() =>
      this.store.db.runTransaction((tx) => this.settle(tx, reservationId, actual, undefined, id)),
    );
  }

  async release(reservationId: string): Promise<void> {
    await withEmulatorTransactionRetry(() =>
      this.store.db.runTransaction((tx) => this.settle(tx, reservationId, null)),
    );
  }

  async releaseStale(
    olderThanMinutes = 120,
    batch = 500,
    unknownModelTtlMinutes = 30,
  ): Promise<CostReservationSweep> {
    if (
      !Number.isFinite(olderThanMinutes) ||
      olderThanMinutes <= 0 ||
      !Number.isInteger(batch) ||
      batch < 1 ||
      batch > 500
    ) {
      throw new Error('Invalid reservation cleanup bounds');
    }
    assertUnknownModelSettlementTtl(unknownModelTtlMinutes);
    const now = this.store.now();
    const estimateBefore = new Date(now.getTime() - unknownModelTtlMinutes * 60_000);
    const unknown = this.store
      .collection('costReservations')
      .where('status', '==', 'unknown')
      .where('attemptStartedAt', '<=', estimateBefore)
      .orderBy('attemptStartedAt')
      .orderBy(FieldPath.documentId())
      .select(
        'id',
        'status',
        'source',
        'reservationKind',
        'costGrantId',
        'createdAt',
        'attemptStartedAt',
        'attemptMetadata',
        'unknownReason',
      );
    const samples: { provider?: string; model?: string; outcome: string; ageMinutes: number }[] =
      [];
    let settledAtEstimate = 0;
    let cursor: QueryDocumentSnapshot | undefined;
    // Preserve progress across ticks even when protected attempts fill every page.
    const name = 'unknown-model-estimate-scan';
    const checkpoint = this.store.doc('maintenanceCursors', name);
    const previous = await checkpoint.get();
    const saved = previous.get('cursor') as string | undefined;
    const position: [number, number, string] | undefined = saved ? JSON.parse(saved) : undefined;
    let next: string | null = null;
    for (let pages = 0; pages < 4 && settledAtEstimate < batch; pages++) {
      const query = cursor
        ? unknown.startAfter(cursor)
        : position
          ? unknown.startAfter(new Timestamp(position[0], position[1]), position[2])
          : unknown;
      const page = await query.limit(batch).get();
      for (const doc of page.docs) {
        cursor = doc;
        const id: unknown = doc.get('id');
        if (typeof id !== 'string' || !id || doc.id !== documentKey(id)) continue;
        const startedAt = this.accountableUnknownAttempt(doc, now);
        const estimate = staleModelAttemptEstimate(doc.get('attemptMetadata'));
        if (!startedAt || !estimate) continue;
        if (
          await withEmulatorTransactionRetry(() =>
            this.store.db.runTransaction((tx) =>
              this.settle(tx, id, null, undefined, undefined, undefined, estimateBefore),
            ),
          )
        ) {
          settledAtEstimate++;
          if (samples.length < 5)
            samples.push({
              provider: estimate.provider,
              model: estimate.model,
              outcome: modelAttemptSampleOutcome(doc.get('unknownReason')),
              ageMinutes: Math.floor((now.getTime() - startedAt.getTime()) / 60_000),
            });
          if (settledAtEstimate >= batch) break;
        }
      }
      if (!page.size || !cursor || (page.size < batch && cursor.id === page.docs.at(-1)?.id)) {
        next = null;
        break;
      }
      const stamp = cursor.get('attemptStartedAt') as Timestamp;
      next = JSON.stringify([stamp.seconds, stamp.nanoseconds, cursor.id]);
    }
    if ((saved ?? null) !== next) {
      await this.store.db.runTransaction(async (tx) => {
        const current = await tx.get(checkpoint);
        if (current.get('cursor') !== saved) return;
        tx.set(checkpoint, { name, cursor: next, updatedAt: now });
      });
    }
    if (settledAtEstimate)
      console.info('Settled unknown model attempts at their internal estimates', {
        settledAtEstimate,
        samples,
      });
    const cutoff = new Date(this.store.now().getTime() - olderThanMinutes * 60_000);
    const stale = await this.store
      .collection('costReservations')
      .where('status', '==', 'held')
      .where('createdAt', '<', cutoff)
      .orderBy('createdAt')
      .limit(batch)
      .get();
    let released = 0;
    for (const doc of stale.docs) {
      const pendingCalls = await this.store
        .collection('callSessions')
        .where('reservationId', '==', doc.get('id'))
        .limit(10)
        .get();
      if (
        pendingCalls.docs.some((call) => {
          const delivery = call.get('finishDelivery') as { costs?: { done?: unknown } } | undefined;
          return delivery?.costs?.done === false;
        })
      )
        continue;
      if (
        await withEmulatorTransactionRetry(() =>
          this.store.db.runTransaction((tx) =>
            this.settle(tx, doc.get('id'), null, undefined, undefined, cutoff),
          ),
        )
      )
        released++;
    }
    const staleDispatches = await this.store
      .collection('costReservations')
      .where('status', '==', 'dispatching')
      .where('attemptStartedAt', '<', cutoff)
      .orderBy('attemptStartedAt')
      .limit(batch)
      .get();
    let markedUnknown = 0;
    for (const doc of staleDispatches.docs) {
      const id = String(doc.get('id') ?? doc.id);
      const ref = this.store.doc('costReservations', id);
      const transitioned = await withEmulatorTransactionRetry(() =>
        this.store.db.runTransaction(async (tx) => {
          const current = await tx.get(ref);
          if (
            !current.exists ||
            current.get('status') !== 'dispatching' ||
            (current.get('reservationKind') !== undefined &&
              current.get('reservationKind') !== 'attempt')
          )
            return false;
          const holdsRef = this.store.doc('coordination', 'budget-holds');
          const holds = await tx.get(holdsRef);
          if (
            !holds.exists ||
            integer(holds, 'heldMicros') < storedLedgerUsdToMicros(current.get('estimatedUsd'))
          )
            throw new Error('Missing budget hold for unknown attempt');
          tx.set(holdsRef, { heldMicros: integer(holds, 'heldMicros') });
          tx.update(ref, {
            status: 'unknown',
            unknownReason: 'provider dispatch exceeded reconciliation window',
          });
          return true;
        }),
      );
      if (transitioned) markedUnknown++;
    }
    return { released, markedUnknown, ...(settledAtEstimate ? { settledAtEstimate } : {}) };
  }
}

export function createFirestoreEstimatedCostApprovalRepository(
  store: InstallationStore,
  options: { mutationsEnabled?: () => boolean } = {},
): EstimatedCostApprovalRepository {
  return new FirestoreCostRepository(store).estimatedCostApprovalRepository(options);
}
