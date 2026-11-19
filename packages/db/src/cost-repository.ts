import { createHash } from 'node:crypto';
import {
  addLedgerMicros,
  addMicros,
  assertLedgerMicros,
  assertUnknownModelSettlementTtl,
  type CostProviderReceipt,
  type CostRepository,
  type CostReservationSweep,
  type CostTotals,
  type CurrentBaselineReservation,
  canCorrectModelAttemptEstimate,
  canonicalEstimatedCostJson,
  currentHistoricalUnknownMicros,
  DEFAULT_RATES,
  type EstimatedCostActor,
  type EstimatedCostApprovalRepository,
  type EstimatedCostBudgetTracking,
  type EstimatedCostDecision,
  type EstimatedCostDecisionReceipt,
  type EstimatedCostDecisionResponse,
  type EstimatedCostGrantAttempt,
  type EstimatedCostGrantDraw,
  type EstimatedCostGrantDrawResult,
  type EstimatedCostGrantRenewal,
  type EstimatedCostRequestProjection,
  type EstimatedCostSourceBinding,
  estimatedCostConnectionId,
  ledgerUsdToMicros,
  MAX_LEDGER_USD_MICROS,
  MODEL_ROLE_NAMES,
  matchesEstimatedCostParkedTask,
  microsToUsd,
  modelAttemptEstimateKey,
  modelAttemptSampleOutcome,
  nextDailyReset,
  nextMonthlyReset,
  parseEstimatedCostQuote,
  parseEstimatedCostReceipt,
  parseHistoricalUnknownBaseline,
  projectEstimatedCostRequest,
  type ReservationActual,
  staleModelAttemptEstimate,
  storedLedgerUsdToMicros,
  storedTaskBudgetToMicros,
  storedUsdToMicros,
} from '@assistant/persistence';
import { and, eq, gte, inArray, sql, sum } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  budgets,
  costEvents,
  costReservations,
  estimatedCostBaselines,
  estimatedCostDecisions,
  estimatedCostGrants,
  estimatedCostRequests,
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

/** Current request lifecycle, independently scoped from any particular decision receipt. */
export async function readEstimatedCostRequest(
  db: Db,
  actor: EstimatedCostActor,
  operationId: string,
): Promise<EstimatedCostRequestProjection | null> {
  return (await readEstimatedCostView(db, actor, operationId))?.request ?? null;
}

/** Request and live accounting share a repeatable-read snapshot. */
export async function readEstimatedCostView(
  db: Db,
  actor: EstimatedCostActor,
  operationId: string,
) {
  const view = await readEstimatedCostSnapshot(db, actor, operationId);
  return view?.request ? { request: view.request, tracking: view.tracking } : null;
}

async function readEstimatedCostSnapshot(
  db: Db,
  actor: EstimatedCostActor,
  operationId?: string,
): Promise<{
  request?: EstimatedCostRequestProjection;
  requests: EstimatedCostRequestProjection[] | null;
  tracking: EstimatedCostBudgetTracking;
} | null> {
  return db.transaction(
    async (tx) => {
      const [clock] = await tx.execute<{ observed: string }>(
        sql`select transaction_timestamp()::text as observed`,
      );
      const now = new Date(clock?.observed ?? '');
      if (!Number.isFinite(now.getTime())) throw new Error('Invalid database clock');
      let projection: EstimatedCostRequestProjection | undefined;
      if (operationId !== undefined) {
        const [request] = await tx
          .select()
          .from(estimatedCostRequests)
          .where(
            and(
              eq(estimatedCostRequests.operationId, operationId),
              eq(estimatedCostRequests.installationId, actor.installationId),
              eq(estimatedCostRequests.ownerId, actor.ownerId),
            ),
          );
        if (!request) return null;
        const quote = parseEstimatedCostQuote(request.quote);
        if (!quote) throw new Error('Invalid stored estimated cost quote');
        let selected: { quoteId: string; expiresAt: string; expired: boolean } | undefined;
        if (request.state === 'approved') {
          const grants = await tx
            .select()
            .from(estimatedCostGrants)
            .where(
              and(
                eq(estimatedCostGrants.operationId, operationId),
                eq(estimatedCostGrants.quoteId, quote.quoteId),
              ),
            )
            .limit(2);
          if (grants.length !== 1 || !grants[0])
            throw new Error('Invalid stored estimated cost grant');
          const grant = grants[0];
          if (!(grant.expiresAt instanceof Date) || !Number.isFinite(grant.expiresAt.getTime()))
            throw new Error('Invalid stored estimated cost grant expiry');
          selected = {
            quoteId: grant.quoteId,
            expiresAt: grant.expiresAt.toISOString(),
            expired: grant.expiresAt.getTime() <= now.getTime(),
          };
        }
        projection = projectEstimatedCostRequest({
          operationId,
          taskId: request.taskId,
          state: request.state,
          quote,
          quoteExpired: Date.parse(quote.expiresAt) <= now.getTime(),
          ...(selected ? { grant: selected } : {}),
        });
      }
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const [[daily], [monthly], [held], unknown, baselineRows, pending] = await Promise.all([
        tx
          .select({ total: sum(costEvents.usd) })
          .from(costEvents)
          .where(costEventAccountedSince(day)),
        tx
          .select({ total: sum(costEvents.usd) })
          .from(costEvents)
          .where(costEventAccountedSince(month)),
        tx
          .select({ total: sum(costReservations.estimatedUsd) })
          .from(costReservations)
          .where(inArray(costReservations.status, ['held', 'dispatching', 'unknown'])),
        tx
          .select({ id: costReservations.id })
          .from(costReservations)
          .where(eq(costReservations.status, 'unknown'))
          .limit(1),
        tx
          .select()
          .from(estimatedCostBaselines)
          .where(eq(estimatedCostBaselines.installationId, actor.installationId))
          .limit(1),
        tx
          .select({
            operationId: estimatedCostRequests.operationId,
            ownerId: estimatedCostRequests.ownerId,
            taskId: estimatedCostRequests.taskId,
            quote: estimatedCostRequests.quote,
          })
          .from(estimatedCostRequests)
          .where(
            and(
              eq(estimatedCostRequests.installationId, actor.installationId),
              eq(estimatedCostRequests.state, 'pending'),
            ),
          )
          .limit(501),
      ]);
      const dailyMicros = storedUsdToMicros(daily?.total ?? '0');
      const monthlyMicros = storedUsdToMicros(monthly?.total ?? '0');
      const heldMicros = storedUsdToMicros(held?.total ?? '0');
      let pendingMicros: number | null = pending.length >= 501 ? null : 0;
      let requests: EstimatedCostRequestProjection[] | null = pendingMicros === null ? null : [];
      if (pendingMicros !== null)
        for (const row of pending) {
          const pendingQuote = parseEstimatedCostQuote(row.quote);
          if (
            !pendingQuote ||
            typeof row.ownerId !== 'string' ||
            !row.ownerId ||
            pendingQuote.operationId !== row.operationId ||
            pendingQuote.taskId !== row.taskId
          ) {
            pendingMicros = null;
            requests = null;
            break;
          }
          const expired = Date.parse(pendingQuote.expiresAt) <= now.getTime();
          if (!expired) pendingMicros = addMicros(pendingMicros, pendingQuote.allowanceMicros);
          if (row.ownerId === actor.ownerId)
            requests?.push(
              projectEstimatedCostRequest({
                operationId: row.operationId,
                taskId: row.taskId,
                state: 'pending',
                quote: pendingQuote,
                quoteExpired: expired,
              }),
            );
        }
      if (operationId === undefined && requests !== null) {
        const expired = await tx
          .select({
            operationId: estimatedCostRequests.operationId,
            ownerId: estimatedCostRequests.ownerId,
            taskId: estimatedCostRequests.taskId,
            quote: estimatedCostRequests.quote,
          })
          .from(estimatedCostRequests)
          .where(
            and(
              eq(estimatedCostRequests.installationId, actor.installationId),
              eq(estimatedCostRequests.state, 'expired_or_needs_refresh'),
            ),
          )
          .limit(501);
        if (expired.length >= 501) requests = null;
        else
          for (const row of expired) {
            const quote = parseEstimatedCostQuote(row.quote);
            if (
              !quote ||
              typeof row.ownerId !== 'string' ||
              !row.ownerId ||
              row.operationId !== quote.operationId ||
              row.taskId !== quote.taskId
            ) {
              requests = null;
              break;
            }
            if (row.ownerId === actor.ownerId)
              requests.push(
                projectEstimatedCostRequest({
                  operationId: row.operationId,
                  taskId: row.taskId,
                  state: 'expired_or_needs_refresh',
                  quote,
                  quoteExpired: true,
                }),
              );
          }
      }
      let historicalUnknownMicros: number | null = unknown.length === 0 ? 0 : null;
      const baseline = baselineRows[0];
      if (baseline) {
        historicalUnknownMicros = null;
        const frozen = parseHistoricalUnknownBaseline(baseline.rows);
        if (
          baseline.ownerId === actor.ownerId &&
          frozen &&
          createHash('sha256').update(JSON.stringify(frozen)).digest('hex') === baseline.digest
        ) {
          const rows = frozen.length
            ? await tx
                .select()
                .from(costReservations)
                .where(
                  inArray(
                    costReservations.id,
                    frozen.map((entry) => entry.reservationId),
                  ),
                )
            : [];
          try {
            const current: CurrentBaselineReservation[] = rows.map((row) => ({
              reservationId: row.id,
              estimatedMicros: storedLedgerUsdToMicros(row.estimatedUsd),
              status: row.status,
              provenance:
                row.reservationKind === 'attempt' && row.costGrantId === null
                  ? 'proven-historical-unapproved'
                  : 'unrecognized',
            }));
            const subtotal = currentHistoricalUnknownMicros(frozen, current);
            if (subtotal !== null && subtotal <= heldMicros) historicalUnknownMicros = subtotal;
          } catch {
            historicalUnknownMicros = null;
          }
        }
      }
      const tracking: EstimatedCostBudgetTracking = {
        observedAt: now.toISOString(),
        complete: pendingMicros !== null && historicalUnknownMicros !== null,
        recordedDailyMicros: dailyMicros,
        recordedMonthlyMicros: monthlyMicros,
        totalHeldMicros: heldMicros,
        historicalUnknownMicros,
        pendingApprovalMicros: pendingMicros,
        dailyPlannedExposureMicros:
          pendingMicros === null ? null : addMicros(dailyMicros, heldMicros, pendingMicros),
        monthlyPlannedExposureMicros:
          pendingMicros === null ? null : addMicros(monthlyMicros, heldMicros, pendingMicros),
      };
      return { ...(projection ? { request: projection } : {}), requests, tracking };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** Canonical receipt read for the exact operation and decision, scoped to the owner. */
export async function readEstimatedCostDecision(
  db: Db,
  actor: EstimatedCostActor,
  identity: { operationId: string; decisionId: string },
): Promise<EstimatedCostDecisionReceipt | null> {
  const [row] = await db
    .select({ receipt: estimatedCostDecisions.receipt })
    .from(estimatedCostDecisions)
    .innerJoin(
      estimatedCostRequests,
      eq(estimatedCostRequests.operationId, estimatedCostDecisions.operationId),
    )
    .where(
      and(
        eq(estimatedCostDecisions.decisionId, identity.decisionId),
        eq(estimatedCostDecisions.operationId, identity.operationId),
        eq(estimatedCostRequests.installationId, actor.installationId),
        eq(estimatedCostRequests.ownerId, actor.ownerId),
      ),
    );
  if (!row) return null;
  const receipt = parseEstimatedCostReceipt(row.receipt, identity);
  if (!receipt) throw new Error('Invalid stored estimated cost receipt');
  return receipt;
}

/** Compatible-off reads and declines; approval and new quotes remain disabled. */
export function createPostgresEstimatedCostApprovalRepository(
  db: Db,
  options: {
    mutationsEnabled?: () => boolean;
    providerSource?: import('@assistant/persistence').EstimatedCostRuntimeProviderSource;
  } = {},
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
    async getOverview(actor) {
      const view = await readEstimatedCostSnapshot(db, actor);
      return view ? { ok: true, requests: view.requests, tracking: view.tracking } : unavailable;
    },
    async getQuote(actor, operationId) {
      const view = await readEstimatedCostView(db, actor, operationId);
      return view
        ? { ok: true, ...view }
        : { ok: false, outcome: 'not_found', operationId, message: 'Request not found.' };
    },
    async storePreparedQuote(prepared) {
      if (!enabled()) return unavailable;
      const { storePreparedPostgresQuote } = await import(
        './estimated-cost-approval-transactions.js'
      );
      return storePreparedPostgresQuote(db, prepared, options.providerSource);
    },
    async decide(actor, decision) {
      if (decision.decision === 'approve') {
        if (!enabled()) return unavailable;
        const { approvePostgresEstimatedCost } = await import(
          './estimated-cost-approval-transactions.js'
        );
        return approvePostgresEstimatedCost(db, actor, decision, options.providerSource);
      }
      return declinePostgresEstimatedCostRequest(db, actor, decision);
    },
    async getDecisionReceipt(actor, identity) {
      const receipt = await readEstimatedCostDecision(db, actor, identity);
      return receipt
        ? { ok: true, receipt }
        : { ok: false, outcome: 'not_found', ...identity, message: 'Decision receipt not found.' };
    },
  };
}

async function declinePostgresEstimatedCostRequest(
  db: Db,
  actor: EstimatedCostActor,
  decision: EstimatedCostDecision,
): Promise<EstimatedCostDecisionResponse> {
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
  return db.transaction(async (tx) => {
    await lockCostLedger(tx as unknown as Db);
    const [request] = await tx
      .select()
      .from(estimatedCostRequests)
      .where(
        and(
          eq(estimatedCostRequests.operationId, decision.operationId),
          eq(estimatedCostRequests.installationId, actor.installationId),
          eq(estimatedCostRequests.ownerId, actor.ownerId),
        ),
      )
      .for('update');
    if (!request)
      return {
        ok: false,
        outcome: 'not_found',
        operationId: decision.operationId,
        message: 'Request not found.',
      };
    const [prior] = await tx
      .select()
      .from(estimatedCostDecisions)
      .where(eq(estimatedCostDecisions.decisionId, decision.decisionId));
    if (prior) {
      if (prior.operationId !== decision.operationId || prior.bodyDigest !== bodyDigest)
        return {
          ok: false,
          outcome: 'conflict',
          operationId: decision.operationId,
          decisionId: decision.decisionId,
          message: 'Decision identity already used.',
        };
      const receipt = parseEstimatedCostReceipt(prior.receipt, decision);
      if (!receipt) throw new Error('Invalid stored estimated cost receipt');
      return { ok: true, receipt };
    }
    const quote = parseEstimatedCostQuote(request.quote);
    if (!quote || quote.operationId !== decision.operationId || quote.taskId !== request.taskId)
      throw new Error('Invalid stored estimated cost quote');
    if (quote.quoteId !== decision.quoteId || quote.quoteVersion !== decision.quoteVersion) {
      const receipt = {
        operationId: decision.operationId,
        decisionId: decision.decisionId,
        quoteId: decision.quoteId,
        status: 'stale' as const,
      };
      await tx.insert(estimatedCostDecisions).values({
        decisionId: decision.decisionId,
        operationId: decision.operationId,
        bodyDigest,
        receipt,
      });
      return { ok: true, receipt };
    }
    if (!['pending', 'expired_or_needs_refresh'].includes(request.state))
      return {
        ok: false,
        outcome: 'conflict',
        operationId: decision.operationId,
        decisionId: decision.decisionId,
        message: 'Request is already resolved.',
      };
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, request.taskId)).for('update');
    if (
      !task ||
      !matchesEstimatedCostParkedTask(task, {
        actor,
        taskId: request.taskId,
        operationId: decision.operationId,
        requestFingerprint: request.requestFingerprint,
      })
    )
      return {
        ok: false,
        outcome: 'unavailable',
        operationId: decision.operationId,
        decisionId: decision.decisionId,
        message: 'Request could not be closed.',
      };
    const receipt = {
      operationId: decision.operationId,
      decisionId: decision.decisionId,
      quoteId: decision.quoteId,
      status: 'declined' as const,
    };
    await tx
      .update(tasks)
      .set({
        status: 'cancelled',
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        updatedAt: sql`now()`,
      })
      .where(eq(tasks.id, task.id));
    await tx
      .update(estimatedCostRequests)
      .set({ state: 'declined', updatedAt: sql`now()` })
      .where(eq(estimatedCostRequests.operationId, decision.operationId));
    await tx.insert(estimatedCostDecisions).values({
      decisionId: decision.decisionId,
      operationId: decision.operationId,
      bodyDigest,
      receipt,
    });
    return { ok: true, receipt };
  });
}

/** Move a grant allocation into one attempt without changing total held capacity. */
export async function drawEstimatedCostGrant(
  db: Db,
  input: EstimatedCostGrantDraw,
): Promise<EstimatedCostGrantDrawResult> {
  if (!Number.isSafeInteger(input.estimatedMicros) || input.estimatedMicros <= 0)
    throw new Error('Invalid grant draw amount');
  return db.transaction(async (tx) => {
    await lockCostLedger(tx as unknown as Db);
    const [request] = await tx
      .select()
      .from(estimatedCostRequests)
      .where(eq(estimatedCostRequests.operationId, input.operationId));
    const [grant] = await tx
      .select()
      .from(estimatedCostGrants)
      .where(eq(estimatedCostGrants.id, input.grantId));
    if (
      !request ||
      request.installationId !== input.actor.installationId ||
      request.ownerId !== input.actor.ownerId ||
      request.taskId !== input.taskId ||
      request.bindingDigest !== input.bindingDigest ||
      request.state !== 'approved' ||
      !grant ||
      grant.operationId !== input.operationId
    )
      return { ok: false, reason: 'unavailable' };
    const storedQuote = request.quote as { quoteId?: unknown } | null;
    if (!storedQuote || typeof storedQuote !== 'object' || storedQuote.quoteId !== grant.quoteId)
      return { ok: false, reason: 'unavailable' };
    const [clock] = await tx.execute<{ valid: boolean }>(
      sql`select expires_at > clock_timestamp() as valid from estimated_cost_grants where id = ${input.grantId}`,
    );
    if (clock?.valid !== true) return { ok: false, reason: 'expired' };
    const [existing] = await tx
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, input.attemptId));
    const decimal = microsToUsd(input.estimatedMicros).toFixed(6);
    if (existing) {
      if (
        existing.reservationKind !== 'attempt' ||
        existing.costGrantId !== input.grantId ||
        existing.taskId !== input.taskId ||
        existing.source !== input.source ||
        existing.estimatedUsd !== decimal ||
        existing.description !== input.description
      )
        throw new Error('Grant attempt ID reused for different work');
      return existing.status === 'held'
        ? { ok: true, reservationId: existing.id }
        : { ok: false, reason: 'closed' };
    }
    const [escrow] = await tx
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, grant.escrowReservationId));
    if (
      escrow?.status !== 'held' ||
      escrow.reservationKind !== 'escrow' ||
      escrow.costGrantId !== grant.id ||
      escrow.taskId !== input.taskId
    )
      return { ok: false, reason: 'unavailable' };
    const balance = storedLedgerUsdToMicros(escrow.estimatedUsd);
    if (
      !Number.isSafeInteger(grant.allowanceMicros) ||
      !Number.isSafeInteger(grant.consumedMicros) ||
      grant.consumedMicros < 0 ||
      grant.consumedMicros > grant.allowanceMicros ||
      balance !== grant.allowanceMicros - grant.consumedMicros
    )
      throw new Error('Invalid grant escrow balance');
    if (input.estimatedMicros > balance) return { ok: false, reason: 'exhausted' };
    await tx
      .update(costReservations)
      .set({ estimatedUsd: microsToUsd(balance - input.estimatedMicros).toFixed(6) })
      .where(eq(costReservations.id, escrow.id));
    await tx
      .update(estimatedCostGrants)
      .set({ consumedMicros: grant.consumedMicros + input.estimatedMicros })
      .where(eq(estimatedCostGrants.id, grant.id));
    await tx.insert(costReservations).values({
      id: input.attemptId,
      taskId: input.taskId,
      source: input.source,
      estimatedUsd: decimal,
      reservationKind: 'attempt',
      costGrantId: grant.id,
      description: input.description,
    });
    return { ok: true, reservationId: input.attemptId };
  });
}

/** Release only an expired grant's unused escrow. Child reservations are untouched. */
export async function expireEstimatedCostGrant(db: Db, grantId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockCostLedger(tx as unknown as Db);
    const [grant] = await tx
      .select()
      .from(estimatedCostGrants)
      .where(eq(estimatedCostGrants.id, grantId));
    if (!grant) return false;
    const [clock] = await tx.execute<{ expired: boolean }>(
      sql`select expires_at <= clock_timestamp() as expired from estimated_cost_grants where id = ${grantId}`,
    );
    if (clock?.expired !== true) return false;
    const [escrow] = await tx
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, grant.escrowReservationId));
    if (!escrow || escrow.status === 'released') return false;
    if (
      escrow.status !== 'held' ||
      escrow.reservationKind !== 'escrow' ||
      escrow.costGrantId !== grantId
    )
      throw new Error('Invalid grant escrow');
    const balance = storedLedgerUsdToMicros(escrow.estimatedUsd);
    if (
      !Number.isSafeInteger(grant.allowanceMicros) ||
      !Number.isSafeInteger(grant.consumedMicros) ||
      grant.consumedMicros < 0 ||
      grant.consumedMicros > grant.allowanceMicros ||
      balance !== grant.allowanceMicros - grant.consumedMicros
    )
      throw new Error('Invalid grant escrow balance');
    await tx
      .update(costReservations)
      .set({ status: 'released', reconciledAt: sql`now()` })
      .where(eq(costReservations.id, escrow.id));
    return true;
  });
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
/** Shared by the dedicated estimated-cost transaction module. */
export async function lockCostLedger(db: Db): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext('assistant:cost-reservations'))`);
}

async function writeCostEvent(db: Db, input: CostEventInput, accountedAt?: Date): Promise<boolean> {
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
    accountedAt,
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

export type { CostTotals } from '@assistant/persistence';

/** A late charge may be booked to the period where its provider attempt began. */
export function costEventAccountedSince(since: Date) {
  return and(
    gte(costEvents.createdAt, since),
    sql`coalesce(${costEvents.accountedAt}, ${costEvents.createdAt}) >= ${since.toISOString()}::timestamptz`,
  );
}

/** A single snapshot keeps the hold and its replacement spend on the same side of settlement. */
export async function costTotals(db: Db): Promise<CostTotals> {
  const dayStart = sql`date_trunc('day', now(), 'UTC')`;
  const monthStart = sql`date_trunc('month', now(), 'UTC')`;
  const attributable = sql`
    ${costReservations.status} = 'unknown' and ${costReservations.source} = 'model'
    and ${costReservations.reservationKind} = 'attempt'
    and ${costReservations.costGrantId} is null
    and ${costReservations.attemptStartedAt} >= ${costReservations.createdAt}
  `;
  const [limits, [accounting]] = await Promise.all([
    db.select().from(budgets),
    db.execute<{
      daily_spent: string;
      monthly_spent: string;
      held: string;
      daily_held: string;
      monthly_held: string;
    }>(sql`
      select * from (
        select
          coalesce(sum(${costEvents.usd}) filter (where coalesce(${costEvents.accountedAt}, ${costEvents.createdAt}) >= ${dayStart}), 0) as daily_spent,
          coalesce(sum(${costEvents.usd}), 0) as monthly_spent
        from ${costEvents}
        where ${costEvents.createdAt} >= ${monthStart}
          and coalesce(${costEvents.accountedAt}, ${costEvents.createdAt}) >= ${monthStart}
      ) spend cross join (
        select
          coalesce(sum(${costReservations.estimatedUsd}), 0) as held,
          coalesce(sum(${costReservations.estimatedUsd}) filter (
            where (${attributable} and ${costReservations.attemptStartedAt} < ${dayStart}) is not true
          ), 0) as daily_held,
          coalesce(sum(${costReservations.estimatedUsd}) filter (
            where (${attributable} and ${costReservations.attemptStartedAt} < ${monthStart}) is not true
          ), 0) as monthly_held
        from ${costReservations}
        where ${costReservations.status} in ('held', 'dispatching', 'unknown')
      ) holds
    `),
  ]);
  if (!accounting) throw new Error('Incomplete cost snapshot');
  const limitFor = (scope: string) =>
    Number(limits.find((b) => b.scope === scope)?.limitUsd ?? Number.POSITIVE_INFINITY);

  return {
    dailySpentUsd: Number(accounting.daily_spent),
    monthlySpentUsd: Number(accounting.monthly_spent),
    heldUsd: Number(accounting.held),
    dailyHeldUsd: Number(accounting.daily_held),
    monthlyHeldUsd: Number(accounting.monthly_held),
    dailyLimitUsd: limitFor('daily'),
    monthlyLimitUsd: limitFor('monthly'),
    softPct: limits.find((b) => b.scope === 'daily')?.softPct ?? 80,
  };
}

export type ReserveOutcome =
  | { ok: true; reservationId: string }
  | {
      ok: false;
      reason: string;
      resumeAt: Date;
      budget?: { scope: 'daily' | 'monthly' | 'task'; nextAttemptMicros: number };
    };

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
    const monthlyHeld = totals.monthlyHeldUsd ?? totals.heldUsd;
    const dailyHeld = totals.dailyHeldUsd ?? totals.heldUsd;
    const globalLimitFactor = input.critical ? 1.1 : 1;
    const monthlyCeiling = totals.monthlyLimitUsd * globalLimitFactor;
    const dailyCeiling = totals.dailyLimitUsd * globalLimitFactor;

    if (totals.monthlySpentUsd + monthlyHeld + estimateUsd > monthlyCeiling) {
      return {
        ok: false,
        reason: `monthly budget cannot cover this (spent $${totals.monthlySpentUsd.toFixed(2)} + held $${monthlyHeld.toFixed(2)} + est $${estimateUsd.toFixed(2)} > cap $${monthlyCeiling.toFixed(2)}${input.critical ? ' including owner-reply carve-out' : ''})`,
        budget: { scope: 'monthly', nextAttemptMicros: estimateMicros },
        resumeAt: nextMonthlyReset(),
      } as const;
    }
    if (totals.dailySpentUsd + dailyHeld + estimateUsd > dailyCeiling) {
      return {
        ok: false,
        reason: `daily budget cannot cover this (spent $${totals.dailySpentUsd.toFixed(2)} + held $${dailyHeld.toFixed(2)} + est $${estimateUsd.toFixed(2)} > cap $${dailyCeiling.toFixed(2)}${input.critical ? ' including owner-reply carve-out' : ''})`,
        budget: { scope: 'daily', nextAttemptMicros: estimateMicros },
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
          budget: { scope: 'task', nextAttemptMicros: estimateMicros },
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

/** Re-park a blocked call and release only the old grant's unspent escrow. */
export async function parkPostgresEstimatedCostGrantRenewal(
  db: Db,
  input: EstimatedCostGrantRenewal,
  providerSource?: import('@assistant/persistence').EstimatedCostRuntimeProviderSource,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(input.candidate.nextAttemptMicros) ||
    input.candidate.nextAttemptMicros <= 0 ||
    !/^[a-f0-9]{64}$/.test(input.candidate.routingDigest) ||
    !/^[a-f0-9]{64}$/.test(input.candidate.requestDigest)
  )
    return false;
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [initial] = await tx
      .select()
      .from(estimatedCostRequests)
      .where(eq(estimatedCostRequests.operationId, input.operationId));
    if (
      !initial ||
      initial.ownerId !== input.actor.ownerId ||
      initial.installationId !== input.actor.installationId ||
      initial.taskId !== input.taskId ||
      initial.state !== 'approved' ||
      initial.bindingDigest !== input.bindingDigest
    )
      return false;
    const old = initial.sourceBinding as EstimatedCostSourceBinding;
    if (!old || !Array.isArray(old.additionalRoutes) || (input.candidate.critical && !old.critical))
      return false;
    const allowed =
      old.role === input.candidate.role
        ? old
        : old.additionalRoutes.find((item) => item.role === input.candidate.role);
    if (
      !allowed ||
      !Array.isArray(allowed.modelRows) ||
      !allowed.modelRows.some((item) => item.id === input.candidate.modelId)
    )
      return false;
    const { capturePostgresEstimatedCostSourceBinding } = await import(
      './estimated-cost-approval-transactions.js'
    );
    const oldSource = await capturePostgresEstimatedCostSourceBinding(tx, {
      actor: input.actor,
      taskId: input.taskId,
      role: old.role,
      selectedModelId: old.selectedModelId,
      routingDigest: old.routingDigest,
      critical: old.critical,
      additionalRoles: old.additionalRoutes.map((item) => item.role),
      providerSource,
    });
    if (
      canonicalEstimatedCostJson(old) !== canonicalEstimatedCostJson(oldSource) ||
      createHash('sha256').update(canonicalEstimatedCostJson(old)).digest('hex') !==
        input.bindingDigest
    )
      return false;
    const [request] = await tx
      .select()
      .from(estimatedCostRequests)
      .where(eq(estimatedCostRequests.operationId, input.operationId))
      .for('update');
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).for('update');
    const [grant] = await tx
      .select()
      .from(estimatedCostGrants)
      .where(eq(estimatedCostGrants.id, input.grantId))
      .for('update');
    const quote = parseEstimatedCostQuote(request?.quote);
    const state =
      task?.state && typeof task.state === 'object' && !Array.isArray(task.state)
        ? (task.state as Record<string, unknown>)
        : null;
    const marker = state?.estimatedCostApproval as Record<string, unknown> | undefined;
    if (
      !request ||
      request.state !== 'approved' ||
      request.bindingDigest !== input.bindingDigest ||
      !task ||
      !state ||
      task.status !== 'running' ||
      task.leaseToken !== input.leaseToken ||
      !task.lockedUntil ||
      !marker ||
      marker.status !== 'approved' ||
      marker.grantId !== input.grantId ||
      marker.bindingDigest !== input.bindingDigest ||
      !grant ||
      grant.operationId !== input.operationId ||
      !quote ||
      quote.quoteId !== grant.quoteId ||
      !matchesEstimatedCostParkedTask(
        { ...task, status: 'waiting_estimated_cost' },
        {
          actor: input.actor,
          taskId: input.taskId,
          operationId: input.operationId,
          requestFingerprint: request.requestFingerprint,
        },
      )
    )
      return false;
    const [escrow] = await tx
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, grant.escrowReservationId))
      .for('update');
    if (
      !escrow ||
      escrow.status !== 'held' ||
      escrow.reservationKind !== 'escrow' ||
      escrow.costGrantId !== grant.id ||
      escrow.taskId !== task.id
    )
      return false;
    const balance = storedLedgerUsdToMicros(escrow.estimatedUsd);
    if (
      !Number.isSafeInteger(grant.allowanceMicros) ||
      !Number.isSafeInteger(grant.consumedMicros) ||
      grant.consumedMicros < 0 ||
      grant.allowanceMicros - grant.consumedMicros !== balance
    )
      return false;
    const [clock] = await tx.execute<{ leaseValid: boolean; expired: boolean }>(
      sql`select ${task.lockedUntil.toISOString()}::timestamptz > clock_timestamp() as "leaseValid", ${grant.expiresAt.toISOString()}::timestamptz <= clock_timestamp() as expired`,
    );
    if (
      clock?.leaseValid !== true ||
      (!clock.expired && balance >= input.candidate.nextAttemptMicros)
    )
      return false;
    const source = await capturePostgresEstimatedCostSourceBinding(tx, {
      actor: input.actor,
      taskId: input.taskId,
      role: input.candidate.role,
      selectedModelId: input.candidate.modelId,
      routingDigest: input.candidate.routingDigest,
      critical: input.candidate.critical,
      additionalRoles: MODEL_ROLE_NAMES.filter(
        (role) => role !== input.candidate.role && role !== 'embed',
      ),
      providerSource,
    });
    const bindingDigest = createHash('sha256')
      .update(canonicalEstimatedCostJson(source))
      .digest('hex');
    const [final] = await tx.execute<{ valid: boolean }>(
      sql`select ${task.lockedUntil.toISOString()}::timestamptz > clock_timestamp() as valid`,
    );
    if (final?.valid !== true) return false;
    await tx
      .update(costReservations)
      .set({ status: 'released', reconciledAt: sql`clock_timestamp()` })
      .where(eq(costReservations.id, escrow.id));
    await tx
      .update(estimatedCostRequests)
      .set({
        state: 'expired_or_needs_refresh',
        sourceBinding: source,
        bindingDigest,
        quote: { ...quote, renewalCandidate: input.candidate },
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(estimatedCostRequests.operationId, input.operationId));
    await tx
      .update(tasks)
      .set({
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
        leaseToken: null,
        lockedUntil: null,
        runAfter: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(tasks.id, task.id));
    return true;
  });
}

/** One grant-backed dispatch; all authority and source checks precede the transition. */
export async function beginPostgresEstimatedCostGrantAttempt(
  db: Db,
  input: EstimatedCostGrantAttempt,
  providerSource?: import('@assistant/persistence').EstimatedCostRuntimeProviderSource,
): Promise<boolean> {
  if (
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
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [initial] = await tx
      .select()
      .from(estimatedCostRequests)
      .where(
        and(
          eq(estimatedCostRequests.operationId, input.operationId),
          eq(estimatedCostRequests.installationId, input.actor.installationId),
          eq(estimatedCostRequests.ownerId, input.actor.ownerId),
        ),
      );
    if (!initial) return false;
    const binding = initial.sourceBinding as EstimatedCostSourceBinding;
    if (
      !binding ||
      !Array.isArray(binding.additionalRoutes) ||
      typeof binding.critical !== 'boolean'
    )
      return false;
    const { capturePostgresEstimatedCostSourceBinding } = await import(
      './estimated-cost-approval-transactions.js'
    );
    const source = await capturePostgresEstimatedCostSourceBinding(tx, {
      actor: input.actor,
      taskId: input.taskId,
      role: binding.role,
      selectedModelId: binding.selectedModelId,
      routingDigest: binding.routingDigest,
      critical: binding.critical,
      additionalRoles: binding.additionalRoutes.map((entry) => entry.role),
      providerSource,
    });
    if (
      canonicalEstimatedCostJson(source) !== canonicalEstimatedCostJson(binding) ||
      createHash('sha256').update(canonicalEstimatedCostJson(binding)).digest('hex') !==
        initial.bindingDigest
    )
      return false;
    const [request] = await tx
      .select()
      .from(estimatedCostRequests)
      .where(eq(estimatedCostRequests.operationId, input.operationId))
      .for('update');
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).for('update');
    const [grant] = await tx
      .select()
      .from(estimatedCostGrants)
      .where(eq(estimatedCostGrants.id, input.grantId))
      .for('update');
    const [reservation] = await tx
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, input.reservationId))
      .for('update');
    if (
      !request ||
      request.installationId !== input.actor.installationId ||
      request.ownerId !== input.actor.ownerId ||
      request.taskId !== input.taskId ||
      request.state !== 'approved' ||
      request.bindingDigest !== initial.bindingDigest ||
      canonicalEstimatedCostJson(request.sourceBinding) !== canonicalEstimatedCostJson(binding) ||
      !task ||
      task.status !== 'running' ||
      task.leaseToken !== input.leaseToken ||
      !task.lockedUntil ||
      !grant ||
      grant.operationId !== input.operationId ||
      !reservation ||
      reservation.status !== 'held' ||
      reservation.reservationKind !== 'attempt' ||
      reservation.costGrantId !== input.grantId ||
      reservation.taskId !== input.taskId ||
      storedLedgerUsdToMicros(reservation.estimatedUsd) !== input.nextAttemptMicros
    )
      return false;
    const quote = parseEstimatedCostQuote(request.quote);
    const state =
      task.state && typeof task.state === 'object' && !Array.isArray(task.state)
        ? (task.state as Record<string, unknown>)
        : null;
    const marker = state?.estimatedCostApproval as Record<string, unknown> | undefined;
    if (
      !quote ||
      grant.quoteId !== quote.quoteId ||
      !marker ||
      marker.operationId !== input.operationId ||
      marker.quoteId !== quote.quoteId ||
      marker.bindingDigest !== request.bindingDigest ||
      marker.grantId !== grant.id ||
      marker.status !== 'approved' ||
      !matchesEstimatedCostParkedTask(
        { ...task, status: 'waiting_estimated_cost' },
        {
          actor: input.actor,
          taskId: input.taskId,
          operationId: input.operationId,
          requestFingerprint: request.requestFingerprint,
        },
      )
    )
      return false;
    const allowed =
      binding.role === input.role
        ? binding
        : binding.additionalRoutes.find((entry) => entry.role === input.role);
    if (
      !allowed ||
      (input.critical && !binding.critical) ||
      !allowed.modelRows.some((entry) => entry.id === input.modelId)
    )
      return false;
    const [priorDispatch] = await tx
      .select({ id: costReservations.id })
      .from(costReservations)
      .where(
        and(
          eq(costReservations.costGrantId, grant.id),
          sql`${costReservations.attemptStartedAt} IS NOT NULL`,
        ),
      )
      .limit(1);
    const firstDispatch = !priorDispatch;
    if (
      firstDispatch &&
      (input.role !== binding.role ||
        input.modelId !== binding.selectedModelId ||
        input.routingDigest !== binding.routingDigest ||
        input.nextAttemptMicros !== quote.nextAttemptMicros)
    )
      return false;
    const [escrow] = await tx
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, grant.escrowReservationId))
      .for('update');
    if (
      !escrow ||
      escrow.status !== 'held' ||
      escrow.reservationKind !== 'escrow' ||
      escrow.costGrantId !== grant.id ||
      escrow.taskId !== task.id
    )
      return false;
    const [frozen] = await tx
      .select()
      .from(estimatedCostBaselines)
      .where(eq(estimatedCostBaselines.installationId, input.actor.installationId))
      .for('share');
    const rows = parseHistoricalUnknownBaseline(frozen?.rows);
    if (
      !frozen ||
      frozen.ownerId !== input.actor.ownerId ||
      !rows ||
      createHash('sha256').update(JSON.stringify(rows)).digest('hex') !== frozen.digest
    )
      return false;
    const currentRows = rows.length
      ? await tx
          .select()
          .from(costReservations)
          .where(
            inArray(
              costReservations.id,
              rows.map((entry) => entry.reservationId),
            ),
          )
          .for('share')
      : [];
    const current: CurrentBaselineReservation[] = currentRows.map((row) => ({
      reservationId: row.id,
      estimatedMicros: storedLedgerUsdToMicros(row.estimatedUsd),
      status: row.status,
      provenance:
        row.reservationKind === 'attempt' &&
        row.costGrantId === null &&
        row.createdAt <= frozen.createdAt
          ? 'proven-historical-unapproved'
          : 'unrecognized',
    }));
    const unknown = currentHistoricalUnknownMicros(rows, current);
    if (unknown === null) return false;
    const unknownIds = new Set(
      current.filter((row) => row.status === 'unknown').map((row) => row.reservationId),
    );
    if (
      canonicalEstimatedCostJson(rows.filter((row) => unknownIds.has(row.reservationId))) !==
      canonicalEstimatedCostJson(request.baseline)
    )
      return false;
    const [clock] = await tx.execute<{ valid: boolean; day: string; month: string }>(
      sql`select ${grant.expiresAt.toISOString()}::timestamptz > clock_timestamp() and ${task.lockedUntil.toISOString()}::timestamptz > clock_timestamp() as valid, to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD') as day, to_char(clock_timestamp() at time zone 'UTC','YYYY-MM') as month`,
    );
    if (clock?.valid !== true) return false;
    const day = new Date(`${clock.day}T00:00:00.000Z`),
      month = new Date(`${clock.month}-01T00:00:00.000Z`);
    const [policies, [daily], [monthly], [held], [taskHeld]] = await Promise.all([
      tx
        .select()
        .from(budgets)
        .where(inArray(budgets.scope, ['daily', 'monthly']))
        .for('share'),
      tx
        .select({ total: sum(costEvents.usd) })
        .from(costEvents)
        .where(costEventAccountedSince(day)),
      tx
        .select({ total: sum(costEvents.usd) })
        .from(costEvents)
        .where(costEventAccountedSince(month)),
      tx
        .select({ total: sum(costReservations.estimatedUsd) })
        .from(costReservations)
        .where(inArray(costReservations.status, ['held', 'dispatching', 'unknown'])),
      tx
        .select({ total: sum(costReservations.estimatedUsd) })
        .from(costReservations)
        .where(
          and(
            eq(costReservations.taskId, task.id),
            inArray(costReservations.status, ['held', 'dispatching', 'unknown']),
          ),
        ),
    ]);
    const dailyPolicy = policies.find((row) => row.scope === 'daily'),
      monthlyPolicy = policies.find((row) => row.scope === 'monthly');
    if (!dailyPolicy || !monthlyPolicy) return false;
    const heldMicros = storedUsdToMicros(held?.total ?? '0');
    if (unknown > heldMicros) return false;
    const ceiling = (value: unknown) => {
      const amount = storedUsdToMicros(value);
      return input.critical ? Number((BigInt(amount) * 11n) / 10n) : amount;
    };
    if (
      addMicros(storedUsdToMicros(daily?.total ?? '0'), heldMicros - unknown) >
        ceiling(dailyPolicy.limitUsd) ||
      addMicros(storedUsdToMicros(monthly?.total ?? '0'), heldMicros - unknown) >
        ceiling(monthlyPolicy.limitUsd) ||
      addMicros(storedUsdToMicros(task.spentUsd), storedUsdToMicros(taskHeld?.total ?? '0')) >
        ceiling(task.budgetUsdLimit)
    )
      return false;
    const [final] = await tx.execute<{ valid: boolean }>(
      sql`select ${grant.expiresAt.toISOString()}::timestamptz > clock_timestamp() and ${task.lockedUntil.toISOString()}::timestamptz > clock_timestamp() and to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD') = ${clock.day} as valid`,
    );
    if (final?.valid !== true) return false;
    const [updated] = await tx
      .update(costReservations)
      .set({
        status: 'dispatching',
        attemptStartedAt: sql`clock_timestamp()`,
        attemptMetadata: input.metadata,
      })
      .where(
        and(
          eq(costReservations.id, reservation.id),
          eq(costReservations.status, 'held'),
          eq(costReservations.costGrantId, grant.id),
        ),
      )
      .returning({ id: costReservations.id });
    return Boolean(updated);
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
    .where(
      and(
        eq(costReservations.id, reservationId),
        eq(costReservations.status, 'held'),
        eq(costReservations.reservationKind, 'attempt'),
        sql`${costReservations.costGrantId} IS NULL`,
      ),
    )
    .returning({ id: costReservations.id });
  return Boolean(row);
}

/** Preserve the estimated hold as an unknown liability until actual usage arrives. */
export async function markCostAttemptUnknown(
  db: Db,
  reservationId: string,
  reason: string,
  providerReceipt?: CostProviderReceipt,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCostLedger(tx as unknown as Db);
    await tx
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
          eq(costReservations.reservationKind, 'attempt'),
          inArray(costReservations.status, ['dispatching', 'unknown']),
        ),
      );
  });
}

/** Replace the one estimate in place, so caps keep the original settlement period. */
async function correctModelAttemptEstimate(
  db: Db,
  reservation: typeof costReservations.$inferSelect,
  actual: ReservationActual,
): Promise<void> {
  if (
    reservation.source !== 'model' ||
    reservation.reservationKind !== 'attempt' ||
    reservation.costGrantId != null ||
    !canCorrectModelAttemptEstimate(actual.evidence)
  )
    return;
  const [event] = await db
    .select()
    .from(costEvents)
    .where(eq(costEvents.idempotencyKey, modelAttemptEstimateKey(reservation.id)))
    .for('update');
  if (
    !event ||
    event.reservationId !== reservation.id ||
    event.evidence.modelAttemptEstimate !== 'usage_missing_after_ttl'
  )
    return;
  const prior = storedLedgerUsdToMicros(event.usd);
  if (reservation.actualUsd !== null || prior !== storedLedgerUsdToMicros(reservation.estimatedUsd))
    throw new Error('Model estimate does not match its reservation');
  const amount = ledgerUsdToMicros(actual.usd);
  const usd = microsToUsd(amount).toFixed(6);
  if (reservation.taskId) {
    const [task] = await db
      .select({ spentUsd: tasks.spentUsd })
      .from(tasks)
      .where(eq(tasks.id, reservation.taskId))
      .for('update');
    if (!task) throw new Error('Ledger task does not exist');
    const priorTaskSpend = storedLedgerUsdToMicros(task.spentUsd);
    if (priorTaskSpend < prior) throw new Error('Model estimate exceeds task spend');
    const spent = assertLedgerMicros(priorTaskSpend - prior + amount);
    await db
      .update(tasks)
      .set({ spentUsd: microsToUsd(spent).toFixed(6), updatedAt: sql`now()` })
      .where(eq(tasks.id, reservation.taskId));
  }
  await db
    .update(costReservations)
    .set({ actualUsd: usd })
    .where(eq(costReservations.id, reservation.id));
  await db
    .update(costEvents)
    .set({
      usd,
      evidence: actual.evidence,
      quantity: actual.quantity?.toFixed(4) ?? null,
      unit: actual.unit ?? null,
      unitPriceUsd: actual.unitPriceUsd?.toFixed(8) ?? null,
      toolCallId: actual.toolCallId ?? null,
      description: actual.description ?? reservation.description,
    })
    .where(eq(costEvents.id, event.id));
}

/** Reconcile a held reservation to actuals: release the hold, write the ledger row. */
export async function reconcileReservation(
  db: Db,
  reservationId: string,
  actual: ReservationActual,
): Promise<void> {
  const actualMicros = ledgerUsdToMicros(actual.usd);
  const actualUsd = microsToUsd(actualMicros);
  const actualDecimal = actualUsd.toFixed(6);
  await db.transaction(async (tx) => {
    await lockCostLedger(tx as unknown as Db);
    const [current] = await tx
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, reservationId));
    if (current?.status === 'reconciled') {
      await correctModelAttemptEstimate(tx as unknown as Db, current, actual);
      return;
    }
    if (
      current?.costGrantId &&
      current.reservationKind === 'attempt' &&
      ['held', 'dispatching', 'unknown'].includes(current.status)
    ) {
      const [grant] = await tx
        .select()
        .from(estimatedCostGrants)
        .where(eq(estimatedCostGrants.id, current.costGrantId));
      if (!grant) throw new Error('Missing grant for settlement');
      const [escrow] = await tx
        .select()
        .from(costReservations)
        .where(eq(costReservations.id, grant.escrowReservationId));
      if (
        escrow?.reservationKind !== 'escrow' ||
        escrow.costGrantId !== grant.id ||
        escrow.taskId !== current.taskId ||
        !['held', 'released'].includes(escrow.status)
      )
        throw new Error('Invalid grant escrow');
      if (escrow.status === 'held') {
        const balance = storedLedgerUsdToMicros(escrow.estimatedUsd);
        if (
          !Number.isSafeInteger(grant.allowanceMicros) ||
          !Number.isSafeInteger(grant.consumedMicros) ||
          grant.consumedMicros < 0 ||
          grant.consumedMicros > grant.allowanceMicros ||
          balance !== grant.allowanceMicros - grant.consumedMicros
        )
          throw new Error('Invalid grant escrow balance');
        const extra = Math.min(
          balance,
          Math.max(0, actualMicros - storedLedgerUsdToMicros(current.estimatedUsd)),
        );
        if (extra > 0) {
          await tx
            .update(costReservations)
            .set({ estimatedUsd: microsToUsd(balance - extra).toFixed(6) })
            .where(eq(costReservations.id, escrow.id));
          await tx
            .update(estimatedCostGrants)
            .set({ consumedMicros: grant.consumedMicros + extra })
            .where(eq(estimatedCostGrants.id, grant.id));
        }
      }
    }
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
          eq(costReservations.reservationKind, 'attempt'),
          inArray(costReservations.status, ['held', 'dispatching', 'unknown']),
        ),
      )
      .returning();
    if (!reservation) return; // another reconciler/releaser already won

    const accountedAt =
      current?.status === 'unknown' &&
      current.source === 'model' &&
      current.reservationKind === 'attempt' &&
      current.costGrantId == null &&
      current.attemptStartedAt &&
      current.attemptStartedAt >= current.createdAt &&
      current.attemptStartedAt <= new Date()
        ? current.attemptStartedAt
        : undefined;
    await writeCostEvent(
      tx as unknown as Db,
      {
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
      },
      accountedAt,
    );
  });
}

/** Drop a hold without a ledger entry (the action never ran). */
export async function releaseReservation(db: Db, reservationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCostLedger(tx as unknown as Db);
    await tx
      .update(costReservations)
      .set({ status: 'released', reconciledAt: sql`now()` })
      .where(
        and(
          eq(costReservations.id, reservationId),
          eq(costReservations.status, 'held'),
          eq(costReservations.reservationKind, 'attempt'),
        ),
      );
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
  const report = await db.transaction(async (tx) => {
    await lockCostLedger(tx as unknown as Db);
    const candidates = await tx
      .select()
      .from(costReservations)
      .where(
        and(
          eq(costReservations.status, 'unknown'),
          eq(costReservations.source, 'model'),
          eq(costReservations.reservationKind, 'attempt'),
          sql`${costReservations.costGrantId} IS NULL`,
          sql`${costReservations.attemptStartedAt} >= ${costReservations.createdAt}`,
          sql`${costReservations.attemptStartedAt} <= now() - (${unknownModelTtlMinutes} * interval '1 minute')`,
          sql`jsonb_typeof(${costReservations.attemptMetadata}->'provider') = 'string' and length(btrim(${costReservations.attemptMetadata}->>'provider')) > 0`,
          sql`jsonb_typeof(${costReservations.attemptMetadata}->'model') = 'string' and length(btrim(${costReservations.attemptMetadata}->>'model')) > 0`,
        ),
      )
      .orderBy(costReservations.attemptStartedAt, costReservations.id)
      .limit(batch);
    const samples: { provider?: string; model?: string; outcome: string; ageMinutes: number }[] =
      [];
    let settledAtEstimate = 0;
    for (const candidate of candidates) {
      const evidence = staleModelAttemptEstimate(candidate.attemptMetadata);
      if (!evidence || !candidate.attemptStartedAt) continue;
      const [settled] = await tx
        .update(costReservations)
        .set({ status: 'reconciled', actualUsd: null, reconciledAt: sql`now()` })
        .where(and(eq(costReservations.id, candidate.id), eq(costReservations.status, 'unknown')))
        .returning({ reconciledAt: costReservations.reconciledAt });
      if (!settled?.reconciledAt) continue;
      const inserted = await writeCostEvent(
        tx as unknown as Db,
        {
          evidence,
          source: 'model',
          usd: microsToUsd(storedLedgerUsdToMicros(candidate.estimatedUsd)),
          taskId: candidate.taskId,
          description: candidate.description,
          reservationId: candidate.id,
          idempotencyKey: modelAttemptEstimateKey(candidate.id),
          addToTaskSpend: true,
        },
        settled.reconciledAt,
      );
      if (!inserted) throw new Error('Model attempt already has an estimate receipt');
      settledAtEstimate++;
      if (samples.length < 5)
        samples.push({
          provider: evidence.provider,
          model: evidence.model,
          outcome: modelAttemptSampleOutcome(candidate.unknownReason),
          ageMinutes: Math.floor(
            (settled.reconciledAt.getTime() - candidate.attemptStartedAt.getTime()) / 60_000,
          ),
        });
    }
    const stale = tx
      .select({ id: costReservations.id })
      .from(costReservations)
      .where(
        and(
          eq(costReservations.status, 'held'),
          eq(costReservations.reservationKind, 'attempt'),
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
      // A provider dispatch may have changed a selected row while this UPDATE
      // waited for its row lock; recheck its state on the locked row.
      .where(
        and(
          inArray(costReservations.id, stale),
          eq(costReservations.status, 'held'),
          eq(costReservations.reservationKind, 'attempt'),
        ),
      )
      .returning({ id: costReservations.id });
    const staleDispatches = await tx
      .select({ id: costReservations.id })
      .from(costReservations)
      .where(
        and(
          eq(costReservations.status, 'dispatching'),
          eq(costReservations.reservationKind, 'attempt'),
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
            and(
              eq(costReservations.status, 'dispatching'),
              eq(costReservations.reservationKind, 'attempt'),
              inArray(
                costReservations.id,
                staleDispatches.map((row) => row.id),
              ),
            ),
          )
          .returning({ id: costReservations.id })
      : [];
    return { released: released.length, markedUnknown: unknown.length, settledAtEstimate, samples };
  });
  const { settledAtEstimate, samples, ...cleanup } = report;
  if (settledAtEstimate) {
    console.info('Settled unknown model attempts at their internal estimates', {
      settledAtEstimate,
      samples,
    });
    return { ...cleanup, settledAtEstimate };
  }
  return cleanup;
}

/** SQL implementation of the atomic cost port; callers never receive a transaction handle. */
export function createPostgresCostRepository(
  db: Db,
  options: {
    providerSource?: import('@assistant/persistence').EstimatedCostRuntimeProviderSource;
  } = {},
): CostRepository {
  return {
    kind: 'cost-repository',
    getRate: async (key) => {
      const [row] = await db.select().from(rateTable).where(eq(rateTable.key, key));
      return row ? { unit: row.unit, unitPriceUsd: Number(row.unitPriceUsd) } : null;
    },
    totals: () => costTotals(db),
    reserve: (input) => reserveCost(db, input),
    beginAttempt: (id, metadata) => beginCostAttempt(db, id, metadata),
    drawEstimatedCostGrant: (input) => drawEstimatedCostGrant(db, input),
    beginEstimatedCostGrantAttempt: (input) =>
      beginPostgresEstimatedCostGrantAttempt(db, input, options.providerSource),
    parkEstimatedCostGrantRenewal: (input) =>
      parkPostgresEstimatedCostGrantRenewal(db, input, options.providerSource),
    markAttemptUnknown: (id, reason, receipt) => markCostAttemptUnknown(db, id, reason, receipt),
    record: (input) => recordCostEvent(db, input),
    reconcile: (id, actual) => reconcileReservation(db, id, actual),
    release: (id) => releaseReservation(db, id),
    releaseStale: (age, batch, ttl) => releaseStaleReservations(db, age, batch, ttl),
  };
}
