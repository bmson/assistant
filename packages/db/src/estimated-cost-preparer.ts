import { createHash, randomUUID } from 'node:crypto';
import {
  addMicros,
  canonicalEstimatedCostJson,
  currentHistoricalUnknownMicros,
  estimatedCostAllowance,
  estimatedCostQuoteExpiry,
  type CurrentBaselineReservation,
  type EstimatedCostActor,
  type EstimatedCostPreparedQuote,
  type EstimatedCostPreparationResult,
  type EstimatedCostQuotePreparer,
  type EstimatedCostQuoteRequest,
  type EstimatedCostSourceBinding,
  type EstimatedCostTurnParkInput,
  type EstimatedCostTurnParking,
  matchesEstimatedCostParkedTask,
  MODEL_ROLE_NAMES,
  parseEstimatedCostQuote,
  parseHistoricalUnknownBaseline,
  storedLedgerUsdToMicros,
  storedUsdToMicros,
} from '@assistant/persistence';
import { and, eq, gte, inArray, sql, sum } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  capturePostgresEstimatedCostSourceBinding,
  storePreparedPostgresQuote,
} from './estimated-cost-approval-transactions.js';
import {
  budgets,
  costEvents,
  costReservations,
  estimatedCostBaselines,
  estimatedCostRequests,
  tasks,
} from './schema.js';

const unavailable = {
  ok: false,
  outcome: 'unavailable',
  message: 'The estimate could not be verified.',
} as const;
type Initial = { kind: 'initial'; input: EstimatedCostTurnParkInput };
type Refresh = { kind: 'refresh'; actor: EstimatedCostActor; request: EstimatedCostQuoteRequest };

/** Read-only preparation; the storage transaction rechecks all authority and amounts. */
async function prepare(
  db: Db,
  input: Initial | Refresh,
  providerSource?: import('@assistant/persistence').EstimatedCostRuntimeProviderSource,
): Promise<EstimatedCostPreparationResult> {
  const actor = input.kind === 'initial' ? input.input.actor : input.actor;
  const operationId =
    input.kind === 'initial' ? input.input.operationId : input.request.operationId;
  const quoteRequestId =
    input.kind === 'initial' ? input.input.quoteRequestId : input.request.quoteRequestId;
  if (!actor.installationId || !actor.ownerId || !operationId || !quoteRequestId)
    return unavailable;
  const [existing] = await db
    .select()
    .from(estimatedCostRequests)
    .where(
      and(
        eq(estimatedCostRequests.operationId, operationId),
        eq(estimatedCostRequests.installationId, actor.installationId),
        eq(estimatedCostRequests.ownerId, actor.ownerId),
      ),
    );
  if (input.kind === 'initial' && existing) return unavailable;
  if (
    input.kind === 'refresh' &&
    (!existing || !['pending', 'expired_or_needs_refresh'].includes(existing.state))
  )
    return unavailable;
  const taskId = input.kind === 'initial' ? input.input.taskId : existing?.taskId;
  const requestFingerprint =
    input.kind === 'initial' ? input.input.requestFingerprint : existing?.requestFingerprint;
  const savedQuote = input.kind === 'refresh' ? parseEstimatedCostQuote(existing?.quote) : null;
  const oldBinding =
    input.kind === 'refresh'
      ? (existing?.sourceBinding as EstimatedCostSourceBinding | undefined)
      : undefined;
  if (
    !taskId ||
    !requestFingerprint ||
    (input.kind === 'refresh' &&
      (!savedQuote || !oldBinding || !Array.isArray(oldBinding.additionalRoutes)))
  )
    return unavailable;
  const role = input.kind === 'initial' ? input.input.candidate.role : oldBinding?.role;
  const modelId =
    input.kind === 'initial' ? input.input.candidate.modelId : oldBinding?.selectedModelId;
  const routingDigest =
    input.kind === 'initial' ? input.input.candidate.routingDigest : oldBinding?.routingDigest;
  const critical = input.kind === 'initial' ? input.input.candidate.critical : oldBinding?.critical;
  const nextAttemptMicros =
    input.kind === 'initial'
      ? input.input.candidate.nextAttemptMicros
      : savedQuote?.nextAttemptMicros;
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
  const sourceBinding = await capturePostgresEstimatedCostSourceBinding(db, {
    actor,
    taskId,
    role,
    selectedModelId: modelId,
    routingDigest,
    critical,
    additionalRoles: [...additionalRoles],
    providerSource,
  });
  if (
    oldBinding &&
    canonicalEstimatedCostJson(oldBinding) !== canonicalEstimatedCostJson(sourceBinding)
  )
    return unavailable;
  return db.transaction(
    async (tx) => {
      const [clock] = await tx.execute<{ observed: string }>(
        sql`select transaction_timestamp()::text as observed`,
      );
      const now = new Date(clock?.observed ?? '');
      if (!Number.isFinite(now.getTime())) throw new Error('Invalid database clock');
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
      if (
        !task ||
        !matchesEstimatedCostParkedTask(
          { ...task, status: 'waiting_estimated_cost' },
          { actor, taskId, operationId, requestFingerprint },
        )
      )
        return unavailable;
      const trigger = task.trigger as { payload?: { text?: unknown } } | null;
      const requestText = trigger?.payload?.text;
      if (typeof requestText !== 'string' || !requestText) return unavailable;
      if (input.kind === 'initial') {
        if (
          task.status !== 'running' ||
          task.conversationId !== input.input.conversationId ||
          task.leaseToken !== input.input.leaseToken ||
          !task.lockedUntil ||
          task.lockedUntil.getTime() <= now.getTime()
        )
          return unavailable;
      } else if (task.status !== 'waiting_estimated_cost') return unavailable;
      const [frozen] = await tx
        .select()
        .from(estimatedCostBaselines)
        .where(eq(estimatedCostBaselines.installationId, actor.installationId));
      const rows = parseHistoricalUnknownBaseline(frozen?.rows);
      if (
        !frozen ||
        frozen.ownerId !== actor.ownerId ||
        !rows ||
        createHash('sha256').update(JSON.stringify(rows)).digest('hex') !== frozen.digest
      )
        return unavailable;
      const currentRows = rows.length
        ? await tx
            .select()
            .from(costReservations)
            .where(
              inArray(
                costReservations.id,
                rows.map((row) => row.reservationId),
              ),
            )
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
      const historicalUnknownMicros = currentHistoricalUnknownMicros(rows, current);
      if (historicalUnknownMicros === null) return unavailable;
      const unknownIds = new Set(
        current.filter((row) => row.status === 'unknown').map((row) => row.reservationId),
      );
      const baseline = rows.filter((row) => unknownIds.has(row.reservationId));
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const [policyRows, [daily], [monthly], [held], [taskHeld], pending] = await Promise.all([
        tx
          .select()
          .from(budgets)
          .where(inArray(budgets.scope, ['daily', 'monthly'])),
        tx
          .select({ total: sum(costEvents.usd) })
          .from(costEvents)
          .where(gte(costEvents.createdAt, day)),
        tx
          .select({ total: sum(costEvents.usd) })
          .from(costEvents)
          .where(gte(costEvents.createdAt, month)),
        tx
          .select({ total: sum(costReservations.estimatedUsd) })
          .from(costReservations)
          .where(inArray(costReservations.status, ['held', 'dispatching', 'unknown'])),
        tx
          .select({ total: sum(costReservations.estimatedUsd) })
          .from(costReservations)
          .where(
            and(
              eq(costReservations.taskId, taskId),
              inArray(costReservations.status, ['held', 'dispatching', 'unknown']),
            ),
          ),
        tx
          .select({
            operationId: estimatedCostRequests.operationId,
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
      if (pending.length >= 501) return unavailable;
      let pendingOtherMicros = 0;
      for (const row of pending) {
        const quote = parseEstimatedCostQuote(row.quote);
        if (!quote || quote.operationId !== row.operationId || quote.taskId !== row.taskId)
          return unavailable;
        if (quote.operationId !== operationId && Date.parse(quote.expiresAt) > now.getTime())
          pendingOtherMicros = addMicros(pendingOtherMicros, quote.allowanceMicros);
      }
      const dailyPolicy = policyRows.find((row) => row.scope === 'daily'),
        monthlyPolicy = policyRows.find((row) => row.scope === 'monthly');
      if (!dailyPolicy || !monthlyPolicy) return unavailable;
      const ceiling = (value: unknown) => {
        const amount = storedUsdToMicros(value);
        return critical ? Number((BigInt(amount) * 11n) / 10n) : amount;
      };
      const dailyMicros = storedUsdToMicros(daily?.total ?? '0'),
        monthlyMicros = storedUsdToMicros(monthly?.total ?? '0'),
        heldMicros = storedUsdToMicros(held?.total ?? '0');
      const dailyCeilingMicros = ceiling(dailyPolicy.limitUsd),
        monthlyCeilingMicros = ceiling(monthlyPolicy.limitUsd);
      const allowance = estimatedCostAllowance({
        dailySpentMicros: dailyMicros,
        monthlySpentMicros: monthlyMicros,
        heldMicros,
        historicalUnknownMicros,
        dailyCeilingMicros,
        monthlyCeilingMicros,
        taskSpentMicros: storedLedgerUsdToMicros(task.spentUsd),
        taskHeldMicros: storedUsdToMicros(taskHeld?.total ?? '0'),
        taskCeilingMicros: ceiling(task.budgetUsdLimit),
        nextAttemptMicros,
      });
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
        eligibleHistoricalUnknownMicros: historicalUnknownMicros,
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
          baseline,
        } satisfies EstimatedCostPreparedQuote,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

const enabled = (options: { mutationsEnabled?: () => boolean }) => {
  try {
    return options.mutationsEnabled?.() === true;
  } catch {
    return false;
  }
};
export function createPostgresEstimatedCostQuotePreparer(
  db: Db,
  options: {
    mutationsEnabled?: () => boolean;
    providerSource?: import('@assistant/persistence').EstimatedCostRuntimeProviderSource;
  } = {},
): EstimatedCostQuotePreparer {
  return {
    async prepare(actor, request) {
      return enabled(options)
        ? prepare(db, { kind: 'refresh', actor, request }, options.providerSource)
        : unavailable;
    },
  };
}
export function createPostgresEstimatedCostTurnParking(
  db: Db,
  options: {
    mutationsEnabled?: () => boolean;
    providerSource?: import('@assistant/persistence').EstimatedCostRuntimeProviderSource;
  } = {},
): EstimatedCostTurnParking {
  return {
    async park(input) {
      if (!enabled(options)) return unavailable;
      const prepared = await prepare(db, { kind: 'initial', input }, options.providerSource);
      if (!prepared.ok) return prepared;
      const result = await storePreparedPostgresQuote(
        db,
        prepared.prepared,
        options.providerSource,
      );
      if (!result.ok) return result;
      if (result.request.status !== 'pending') return unavailable;
      return {
        ok: true,
        status: 'pending',
        operationId: input.operationId,
        taskId: input.taskId,
        quoteId: result.request.quote.quoteId,
        quoteVersion: result.request.quote.quoteVersion,
      };
    },
  };
}
