import { createHash, randomUUID } from 'node:crypto';
import {
  addMicros,
  canonicalEstimatedCostJson,
  currentHistoricalUnknownMicros,
  ESTIMATED_COST_QUOTE_LIFETIME_MS,
  type EstimatedCostActor,
  type EstimatedCostBudgetTracking,
  type EstimatedCostDecision,
  type EstimatedCostDecisionResponse,
  type EstimatedCostPreparedQuote,
  type EstimatedCostQuote,
  type EstimatedCostQuoteCheck,
  type EstimatedCostQuoteResponse,
  type EstimatedCostSourceBinding,
  estimatedCostAllowanceExpiry,
  estimatedCostCardMessageId,
  estimatedCostConnectionId,
  estimatedCostQuoteMatches,
  type HistoricalUnknownBaselineRow,
  MAX_LEDGER_USD_MICROS,
  matchesEstimatedCostParkedTask,
  parseEstimatedCostQuote,
  parseEstimatedCostReceipt,
  parseHistoricalUnknownBaseline,
  storedUsdToMicros,
} from '@assistant/persistence';
import { and, eq, gte, inArray, sql, sum } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockCostLedger, readEstimatedCostView } from './cost-repository.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import {
  budgets,
  conversations,
  costEvents,
  costReservations,
  estimatedCostBaselines,
  estimatedCostDecisions,
  estimatedCostGrants,
  estimatedCostQuoteRequests,
  estimatedCostRequests,
  messages,
  tasks,
} from './schema.js';

type Task = typeof tasks.$inferSelect;
type StoredRequest = typeof estimatedCostRequests.$inferSelect;
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalEstimatedCostJson(value)).digest('hex');
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const activeStatuses = ['held', 'dispatching', 'unknown'];

/** Capture trusted source witnesses without a provider request. An existing
 * transaction uses a savepoint; an ordinary Db gets one complete transaction. */
export async function capturePostgresEstimatedCostSourceBinding(
  db: Db,
  input: {
    actor: EstimatedCostActor;
    taskId: string;
    role: string;
    selectedModelId: string;
    routingDigest: string;
    critical: boolean;
    additionalRoles: string[];
  },
): Promise<EstimatedCostSourceBinding> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.execute(sql`set local time zone 'UTC'`);
    const privacyGeneration = await lockPostgresPrivacyObservationFence(tx, input.actor.ownerId);
    await lockCostLedger(tx);
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).for('share');
    if (
      !task ||
      task.agentId !== input.actor.ownerId ||
      task.trust !== 'owner' ||
      task.type !== 'chat_turn' ||
      !['running', 'waiting_estimated_cost'].includes(task.status) ||
      !id(input.role) ||
      !/^[0-9a-f]{64}$/.test(input.routingDigest) ||
      !Array.isArray(input.additionalRoles) ||
      input.additionalRoles.length > 16
    )
      throw new Error('Request source is unavailable');
    const route = async (roleName: string, selected?: string) => {
      if (!id(roleName)) throw new Error('Invalid source role');
      const [role] = await tx.execute<{ row: Record<string, unknown> }>(
        sql`select row_to_json(r) as row from model_roles r where role=${roleName} for share`,
      );
      if (
        !role?.row ||
        typeof role.row.primary_model !== 'string' ||
        typeof role.row.fallback_model !== 'string'
      )
        throw new Error('Source role is unavailable');
      const ids = [
        ...new Set([
          role.row.primary_model,
          role.row.fallback_model,
          ...(selected ? [selected] : []),
        ]),
      ].sort();
      const modelRows = await tx.execute<{ row: Record<string, unknown> }>(
        sql`select row_to_json(m) as row from models m where id in (${sql.join(
          ids.map((value) => sql`${value}`),
          sql`, `,
        )}) order by id for share`,
      );
      if (modelRows.length !== ids.length) throw new Error('Source model is unavailable');
      const connections = [...new Set(ids.map(estimatedCostConnectionId))].sort();
      const connectionRows = await tx.execute<{ row: Record<string, unknown> }>(
        sql`select row_to_json(c) as row from model_connections c where id in (${sql.join(
          connections.map((value) => sql`${value}`),
          sql`, `,
        )}) order by id for share`,
      );
      if (connectionRows.length !== connections.length)
        throw new Error('Configured source connection is unavailable');
      return {
        role: roleName,
        roleRowDigest: hash(role.row),
        modelRows: modelRows
          .map((value) => ({ id: String(value.row.id), digest: hash(value.row) }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        connectionRows: connectionRows
          .map((value) => ({ id: String(value.row.id), digest: hash(value.row) }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      };
    };
    const main = await route(input.role, input.selectedModelId);
    const additionalRoutes: EstimatedCostSourceBinding['additionalRoutes'] = [];
    for (const role of [...new Set(input.additionalRoles)]
      .filter((value) => value !== input.role)
      .sort())
      additionalRoutes.push(await route(role));
    const policies = await tx.execute<{ row: Record<string, unknown> }>(
      sql`select row_to_json(b) as row from budgets b where scope in ('daily','monthly') order by scope for share`,
    );
    if (policies.length !== 2) throw new Error('Current budget policy is unavailable');
    const source: EstimatedCostSourceBinding = {
      ...main,
      critical: input.critical,
      selectedModelId: input.selectedModelId,
      routingDigest: input.routingDigest,
      additionalRoutes,
      budgetRows: policies.map((value) => ({
        scope: value.row.scope as 'daily' | 'monthly',
        digest: hash(value.row),
      })),
      privacyGeneration,
    };
    if (!(await verifySource(tx, input.actor, source, hash(source), privacyGeneration)))
      throw new Error('Current source binding cannot be proven');
    return source;
  });
}

async function clock(tx: Db): Promise<Date> {
  const [row] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  const now = new Date(row?.now ?? '');
  if (!Number.isFinite(now.getTime())) throw new Error('Database clock unavailable');
  return now;
}

/** No raw source row, especially connection credentials, leaves this module. */
async function verifySource(
  tx: Db,
  actor: EstimatedCostActor,
  binding: EstimatedCostSourceBinding,
  digest: string,
  privacy: string | null,
): Promise<boolean> {
  if (
    !plain(binding) ||
    hash(binding) !== digest ||
    binding.privacyGeneration !== privacy ||
    typeof binding.critical !== 'boolean' ||
    !id(binding.role) ||
    typeof binding.selectedModelId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(binding.routingDigest) ||
    !Array.isArray(binding.modelRows) ||
    !Array.isArray(binding.connectionRows) ||
    !Array.isArray(binding.budgetRows) ||
    !Array.isArray(binding.additionalRoutes) ||
    binding.additionalRoutes.length > 16
  )
    return false;
  const [role] = await tx.execute<{ row: Record<string, unknown> }>(
    sql`select row_to_json(r) as row from model_roles r where role = ${binding.role} for share`,
  );
  if (!role?.row || hash(role.row) !== binding.roleRowDigest) return false;
  const modelIds = [
    ...new Set([binding.selectedModelId, role.row.primary_model, role.row.fallback_model]),
  ].sort();
  if (
    modelIds.some((value) => typeof value !== 'string' || !value) ||
    binding.modelRows.length !== modelIds.length
  )
    return false;
  const modelRows = await tx.execute<{ row: Record<string, unknown> }>(
    sql`select row_to_json(m) as row from models m where id in ${sql`(${sql.join(
      modelIds.map((value) => sql`${value}`),
      sql`, `,
    )})`} order by id for share`,
  );
  if (modelRows.length !== modelIds.length) return false;
  const modelProofs = new Map(binding.modelRows.map((row) => [row.id, row.digest]));
  if (modelProofs.size !== modelIds.length) return false;
  for (const model of modelRows) {
    if (
      model.row?.enabled !== true ||
      typeof model.row.id !== 'string' ||
      !modelIds.includes(model.row.id) ||
      modelProofs.get(model.row.id) !== hash(model.row) ||
      model.row.prompt_cost_per_mtok === null ||
      model.row.completion_cost_per_mtok === null
    )
      return false;
    storedUsdToMicros(model.row.prompt_cost_per_mtok);
    storedUsdToMicros(model.row.completion_cost_per_mtok);
  }
  const connectionIds = [...new Set((modelIds as string[]).map(estimatedCostConnectionId))].sort();
  if (binding.connectionRows.length !== connectionIds.length) return false;
  const connections = await tx.execute<{ row: Record<string, unknown> }>(
    sql`select row_to_json(c) as row from model_connections c where id in ${sql`(${sql.join(
      connectionIds.map((value) => sql`${value}`),
      sql`, `,
    )})`} order by id for share`,
  );
  if (connections.length !== connectionIds.length) return false;
  const connectionProofs = new Map(binding.connectionRows.map((row) => [row.id, row.digest]));
  if (connectionProofs.size !== connectionIds.length) return false;
  for (const connection of connections) {
    if (
      connection.row?.enabled !== true ||
      typeof connection.row.id !== 'string' ||
      !connectionIds.includes(connection.row.id) ||
      connectionProofs.get(connection.row.id) !== hash(connection.row)
    )
      return false;
    if (
      connection.row.kind !== 'vertex' &&
      (typeof connection.row.api_key_encrypted !== 'string' || !connection.row.api_key_encrypted)
    )
      return false;
  }
  const policies = await tx.execute<{ row: Record<string, unknown> }>(
    sql`select row_to_json(b) as row from budgets b where scope in ('daily','monthly') order by scope for share`,
  );
  if (policies.length !== 2 || binding.budgetRows.length !== 2) return false;
  for (const [index, policy] of policies.entries()) {
    if (
      !policy.row ||
      binding.budgetRows[index]?.scope !== policy.row.scope ||
      binding.budgetRows[index]?.digest !== hash(policy.row)
    )
      return false;
  }
  const roles = new Set([binding.role]);
  for (const additional of binding.additionalRoutes) {
    if (
      !plain(additional) ||
      !id(additional.role) ||
      roles.has(additional.role) ||
      !Array.isArray(additional.modelRows) ||
      !Array.isArray(additional.connectionRows)
    )
      return false;
    roles.add(additional.role);
    const other: EstimatedCostSourceBinding = {
      ...binding,
      ...additional,
      selectedModelId: additional.modelRows[0]?.id ?? '',
      additionalRoutes: [],
    };
    if (!(await verifySource(tx, actor, other, hash(other), privacy))) return false;
  }
  return actor.ownerId.length > 0;
}

/** Only pre-activation frozen IDs are eligible. Newly unknown work stays protected. */
async function baseline(
  tx: Db,
  actor: EstimatedCostActor,
  proposed: unknown,
): Promise<{ rows: HistoricalUnknownBaselineRow[]; micros: number } | null> {
  const [frozen] = await tx
    .select()
    .from(estimatedCostBaselines)
    .where(eq(estimatedCostBaselines.installationId, actor.installationId))
    .for('share');
  const expected = parseHistoricalUnknownBaseline(proposed);
  const all = parseHistoricalUnknownBaseline(frozen?.rows);
  if (
    !frozen ||
    frozen.ownerId !== actor.ownerId ||
    !expected ||
    !all ||
    all.length === 0 ||
    createHash('sha256').update(JSON.stringify(all)).digest('hex') !== frozen.digest
  )
    return null;
  const current = await tx
    .select()
    .from(costReservations)
    .where(
      inArray(
        costReservations.id,
        all.map((row) => row.reservationId),
      ),
    )
    .for('share');
  if (current.length !== all.length) return null;
  const classified = current.map((row) => ({
    reservationId: row.id,
    estimatedMicros: storedUsdToMicros(row.estimatedUsd),
    status: row.status,
    provenance:
      row.reservationKind === 'attempt' &&
      row.costGrantId === null &&
      row.createdAt <= frozen.createdAt
        ? ('proven-historical-unapproved' as const)
        : ('unrecognized' as const),
  }));
  const micros = currentHistoricalUnknownMicros(all, classified);
  if (micros === null) return null;
  const eligible = classified
    .filter((row) => row.status === 'unknown')
    .map((row) => ({ reservationId: row.reservationId, estimatedMicros: row.estimatedMicros }))
    .sort((a, b) => a.reservationId.localeCompare(b.reservationId));
  if (JSON.stringify(eligible) !== JSON.stringify(expected)) return null;
  return { rows: expected, micros };
}

function ceiling(amount: unknown, critical: boolean): number {
  const micros = storedUsdToMicros(amount);
  const result = critical ? Number((BigInt(micros) * 11n) / 10n) : micros;
  if (!Number.isSafeInteger(result)) throw new Error('Invalid budget ceiling');
  return result;
}

async function snapshot(
  tx: Db,
  actor: EstimatedCostActor,
  task: Task,
  quote: EstimatedCostQuote,
  historicalUnknownMicros: number,
  critical: boolean,
  now: Date,
): Promise<{ check: EstimatedCostQuoteCheck; tracking: EstimatedCostBudgetTracking }> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [policies, [daily], [monthly], [held], [taskHeld], pending] = await Promise.all([
    tx
      .select()
      .from(budgets)
      .where(inArray(budgets.scope, ['daily', 'monthly']))
      .for('share'),
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
      .where(inArray(costReservations.status, activeStatuses)),
    tx
      .select({ total: sum(costReservations.estimatedUsd) })
      .from(costReservations)
      .where(
        and(eq(costReservations.taskId, task.id), inArray(costReservations.status, activeStatuses)),
      ),
    tx
      .select()
      .from(estimatedCostRequests)
      .where(
        and(
          eq(estimatedCostRequests.installationId, actor.installationId),
          eq(estimatedCostRequests.ownerId, actor.ownerId),
          eq(estimatedCostRequests.state, 'pending'),
        ),
      )
      .limit(501),
  ]);
  if (pending.length > 500) throw new Error('Incomplete pending request read');
  const dailyPolicy = policies.find((row) => row.scope === 'daily');
  const monthlyPolicy = policies.find((row) => row.scope === 'monthly');
  if (!dailyPolicy || !monthlyPolicy) throw new Error('Missing cost policy');
  let pendingOtherMicros = 0;
  for (const request of pending) {
    const current = parseEstimatedCostQuote(request.quote);
    if (
      !current ||
      current.operationId !== request.operationId ||
      current.taskId !== request.taskId
    )
      throw new Error('Invalid pending estimate');
    if (request.operationId !== quote.operationId && Date.parse(current.expiresAt) > now.getTime())
      pendingOtherMicros = addMicros(pendingOtherMicros, current.allowanceMicros);
  }
  const check: EstimatedCostQuoteCheck = {
    dailySpentMicros: storedUsdToMicros(daily?.total ?? '0'),
    monthlySpentMicros: storedUsdToMicros(monthly?.total ?? '0'),
    heldMicros: storedUsdToMicros(held?.total ?? '0'),
    historicalUnknownMicros,
    dailyCeilingMicros: ceiling(dailyPolicy.limitUsd, critical),
    monthlyCeilingMicros: ceiling(monthlyPolicy.limitUsd, critical),
    taskSpentMicros: storedUsdToMicros(task.spentUsd),
    taskHeldMicros: storedUsdToMicros(taskHeld?.total ?? '0'),
    taskCeilingMicros: ceiling(task.budgetUsdLimit, critical),
    nextAttemptMicros: quote.nextAttemptMicros,
    pendingOtherMicros,
  };
  const pendingMicros = addMicros(pendingOtherMicros, quote.allowanceMicros);
  const tracking: EstimatedCostBudgetTracking = {
    observedAt: now.toISOString(),
    complete: true,
    recordedDailyMicros: check.dailySpentMicros,
    recordedMonthlyMicros: check.monthlySpentMicros,
    totalHeldMicros: check.heldMicros,
    historicalUnknownMicros,
    pendingApprovalMicros: pendingMicros,
    dailyPlannedExposureMicros: addMicros(check.dailySpentMicros, check.heldMicros, pendingMicros),
    monthlyPlannedExposureMicros: addMicros(
      check.monthlySpentMicros,
      check.heldMicros,
      pendingMicros,
    ),
  };
  return { check, tracking };
}

function admitted(
  task: Task,
  actor: EstimatedCostActor,
  operationId: string,
  fingerprint: string,
): boolean {
  if (
    task.agentId !== actor.ownerId ||
    task.type !== 'chat_turn' ||
    task.trust !== 'owner' ||
    !plain(task.trigger) ||
    !plain(task.trigger.payload) ||
    !plain(task.trigger.payload.chatAdmission)
  )
    return false;
  const admission = task.trigger.payload.chatAdmission;
  return (
    admission.protocol === 'owner-chat-v1' &&
    admission.clientOperationId === operationId &&
    admission.requestHash === fingerprint
  );
}

function marker(
  task: Task,
  operationId: string,
  quote: EstimatedCostQuote,
  bindingDigest: string,
  grantId?: string,
): Record<string, unknown> {
  if (!plain(task.state)) throw new Error('Invalid original request checkpoint');
  return {
    ...task.state,
    estimatedCostApproval: {
      operationId,
      quoteId: quote.quoteId,
      bindingDigest,
      status: grantId ? 'approved' : 'pending',
      ...(grantId ? { grantId } : {}),
    },
  };
}

const unavailable = (operationId: string, decisionId?: string) => ({
  ok: false as const,
  outcome: 'unavailable' as const,
  operationId,
  ...(decisionId ? { decisionId } : {}),
  message: 'The current request estimate could not be verified.',
});
const conflict = (operationId: string, decisionId?: string) => ({
  ok: false as const,
  outcome: 'conflict' as const,
  operationId,
  ...(decisionId ? { decisionId } : {}),
  message: 'This request or decision has changed. Review its current state.',
});
function validQuoteTime(quote: EstimatedCostQuote, now: Date): boolean {
  const expiry = Date.parse(quote.expiresAt);
  const dayEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return (
    expiry > now.getTime() &&
    expiry <= Math.min(dayEnd, now.getTime() + ESTIMATED_COST_QUOTE_LIFETIME_MS)
  );
}
function sameOwner(request: StoredRequest, actor: EstimatedCostActor): boolean {
  return request.ownerId === actor.ownerId && request.installationId === actor.installationId;
}

/** Atomic initial park or explicit refresh. Pending permission never inserts a hold. */
export async function storePreparedPostgresQuote(
  db: Db,
  prepared: EstimatedCostPreparedQuote,
): Promise<EstimatedCostQuoteResponse> {
  const quote = parseEstimatedCostQuote(prepared.quote);
  const actor = prepared.actor;
  if (
    !quote ||
    !id(quote.operationId) ||
    !id(prepared.quoteRequestId) ||
    quote.taskId !== prepared.taskId ||
    prepared.sourceBinding?.critical !== prepared.critical
  )
    return unavailable(quote?.operationId ?? '');
  const requestDigest = hash({
    installationId: actor.installationId,
    ownerId: actor.ownerId,
    operationId: quote.operationId,
    quoteRequestId: prepared.quoteRequestId,
  });
  const outcome = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.execute(sql`set local time zone 'UTC'`);
    const privacy = await lockPostgresPrivacyObservationFence(tx, actor.ownerId);
    await lockCostLedger(tx);
    const [existing] = await tx
      .select()
      .from(estimatedCostRequests)
      .where(eq(estimatedCostRequests.operationId, quote.operationId))
      .for('update');
    if (
      existing &&
      (!sameOwner(existing, actor) ||
        existing.taskId !== prepared.taskId ||
        existing.requestFingerprint !== prepared.requestFingerprint)
    )
      return conflict(quote.operationId);
    const [prior] = await tx
      .select()
      .from(estimatedCostQuoteRequests)
      .where(eq(estimatedCostQuoteRequests.quoteRequestId, prepared.quoteRequestId))
      .for('update');
    if (prior) {
      const stored = parseEstimatedCostQuote(existing?.quote);
      if (
        !existing ||
        prior.operationId !== quote.operationId ||
        prior.requestDigest !== requestDigest ||
        !stored ||
        prior.quoteId !== stored.quoteId ||
        prior.quoteVersion !== stored.quoteVersion
      )
        return conflict(quote.operationId);
      return { replay: true as const, quoteId: stored.quoteId, quoteVersion: stored.quoteVersion };
    }
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, prepared.taskId)).for('update');
    if (
      !task ||
      !admitted(task, actor, quote.operationId, prepared.requestFingerprint) ||
      !plain(task.trigger) ||
      !plain(task.trigger.payload) ||
      task.trigger.payload.text !== quote.requestText
    )
      return unavailable(quote.operationId);
    const now = await clock(tx);
    if (!validQuoteTime(quote, now)) return unavailable(quote.operationId);
    if (prepared.leaseToken === null) {
      if (
        !existing ||
        !['pending', 'expired_or_needs_refresh'].includes(existing.state) ||
        !matchesEstimatedCostParkedTask(task, {
          actor,
          taskId: task.id,
          operationId: quote.operationId,
          requestFingerprint: prepared.requestFingerprint,
        })
      )
        return conflict(quote.operationId);
    } else if (
      existing ||
      task.status !== 'running' ||
      task.leaseToken !== prepared.leaseToken ||
      !task.lockedUntil ||
      task.lockedUntil <= now
    )
      return conflict(quote.operationId);
    if (!(await verifySource(tx, actor, prepared.sourceBinding, prepared.bindingDigest, privacy)))
      return unavailable(quote.operationId);
    const frozen = await baseline(tx, actor, prepared.baseline);
    if (!frozen) return unavailable(quote.operationId);
    const current = await snapshot(tx, actor, task, quote, frozen.micros, prepared.critical, now);
    if (
      !estimatedCostQuoteMatches(quote, current.check, {
        allowOrdinaryCapacity: prepared.leaseToken === null,
      })
    )
      return unavailable(quote.operationId);
    if (!task.conversationId) return unavailable(quote.operationId);
    const [conversation] = await tx
      .select({ owner: conversations.agentId })
      .from(conversations)
      .where(eq(conversations.id, task.conversationId))
      .for('update');
    if (conversation?.owner !== actor.ownerId) return unavailable(quote.operationId);
    const messageId = estimatedCostCardMessageId(
      quote.operationId,
      quote.quoteId,
      quote.quoteVersion,
    );
    const [priorMessage] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, messageId));
    if (priorMessage) return conflict(quote.operationId);
    const commitTime = await clock(tx);
    if (
      !validQuoteTime(quote, commitTime) ||
      commitTime.getUTCDate() !== now.getUTCDate() ||
      (prepared.leaseToken !== null && (!task.lockedUntil || task.lockedUntil <= commitTime))
    )
      return unavailable(quote.operationId);
    const values = {
      installationId: actor.installationId,
      ownerId: actor.ownerId,
      taskId: task.id,
      requestFingerprint: prepared.requestFingerprint,
      bindingDigest: prepared.bindingDigest,
      sourceBinding: prepared.sourceBinding,
      state: 'pending',
      quote,
      baseline: frozen.rows,
      updatedAt: commitTime,
    };
    if (existing)
      await tx
        .update(estimatedCostRequests)
        .set(values)
        .where(eq(estimatedCostRequests.operationId, quote.operationId));
    else
      await tx.insert(estimatedCostRequests).values({ operationId: quote.operationId, ...values });
    await tx
      .update(tasks)
      .set({
        status: 'waiting_estimated_cost',
        state: marker(task, quote.operationId, quote, prepared.bindingDigest),
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        attentionNotifiedAt: null,
        updatedAt: commitTime,
      })
      .where(eq(tasks.id, task.id));
    await tx.insert(estimatedCostQuoteRequests).values({
      quoteRequestId: prepared.quoteRequestId,
      operationId: quote.operationId,
      requestDigest,
      quoteId: quote.quoteId,
      quoteVersion: quote.quoteVersion,
    });
    await tx.insert(messages).values({
      id: messageId,
      conversationId: task.conversationId,
      taskId: task.id,
      role: 'assistant',
      origin: 'assistant',
      text: 'Review the estimated cost for this request.',
      parts: [quote],
    });
    await tx
      .update(conversations)
      .set({ updatedAt: commitTime })
      .where(eq(conversations.id, task.conversationId));
    return { replay: true as const, quoteId: quote.quoteId, quoteVersion: quote.quoteVersion };
  });
  if (!('replay' in outcome)) return outcome;
  // Read after the committed park. A failed read is recoverable by the same refresh ID.
  const view = await readEstimatedCostView(db, actor, quote.operationId);
  if (
    !view ||
    view.request.quote?.quoteId !== outcome.quoteId ||
    view.request.quote?.quoteVersion !== outcome.quoteVersion
  )
    return conflict(quote.operationId);
  return { ok: true, ...view };
}

/** One explicit decision atomically acquires escrow and wakes only its original task. */
export async function approvePostgresEstimatedCost(
  db: Db,
  actor: EstimatedCostActor,
  decision: EstimatedCostDecision,
): Promise<EstimatedCostDecisionResponse> {
  if (
    decision.decision !== 'approve' ||
    ![decision.operationId, decision.quoteId, decision.quoteVersion, decision.decisionId].every(id)
  )
    return conflict(decision.operationId, decision.decisionId);
  // Same byte-level decision hash as the compatible-off decline path.
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
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.execute(sql`set local time zone 'UTC'`);
    const privacy = await lockPostgresPrivacyObservationFence(tx, actor.ownerId);
    await lockCostLedger(tx);
    const [request] = await tx
      .select()
      .from(estimatedCostRequests)
      .where(eq(estimatedCostRequests.operationId, decision.operationId))
      .for('update');
    if (!request || !sameOwner(request, actor))
      return {
        ok: false,
        outcome: 'not_found',
        operationId: decision.operationId,
        message: 'Request not found.',
      };
    const [prior] = await tx
      .select()
      .from(estimatedCostDecisions)
      .where(eq(estimatedCostDecisions.decisionId, decision.decisionId))
      .for('update');
    if (prior) {
      if (prior.operationId !== decision.operationId || prior.bodyDigest !== bodyDigest)
        return conflict(decision.operationId, decision.decisionId);
      const receipt = parseEstimatedCostReceipt(prior.receipt, decision);
      if (!receipt) throw new Error('Invalid stored decision receipt');
      return { ok: true, receipt };
    }
    const stale = async (): Promise<EstimatedCostDecisionResponse> => {
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
    };
    const quote = parseEstimatedCostQuote(request.quote);
    if (!quote || quote.taskId !== request.taskId || quote.operationId !== decision.operationId)
      return unavailable(decision.operationId, decision.decisionId);
    if (
      quote.quoteId !== decision.quoteId ||
      quote.quoteVersion !== decision.quoteVersion ||
      request.state !== 'pending'
    )
      return stale();
    const binding = request.sourceBinding as EstimatedCostSourceBinding;
    if (!plain(binding) || typeof binding.critical !== 'boolean')
      return unavailable(decision.operationId, decision.decisionId);
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, request.taskId)).for('update');
    if (
      !task ||
      !matchesEstimatedCostParkedTask(task, {
        actor,
        taskId: task.id,
        operationId: decision.operationId,
        requestFingerprint: request.requestFingerprint,
      }) ||
      !plain(task.trigger) ||
      !plain(task.trigger.payload) ||
      task.trigger.payload.text !== quote.requestText
    )
      return unavailable(decision.operationId, decision.decisionId);
    const now = await clock(tx);
    if (!validQuoteTime(quote, now)) return stale();
    if (!(await verifySource(tx, actor, binding, request.bindingDigest, privacy))) return stale();
    const frozen = await baseline(tx, actor, request.baseline);
    if (!frozen) return stale();
    const current = await snapshot(tx, actor, task, quote, frozen.micros, binding.critical, now);
    if (
      !estimatedCostQuoteMatches(quote, current.check, { allowOrdinaryCapacity: true }) ||
      quote.allowanceMicros > MAX_LEDGER_USD_MICROS ||
      addMicros(
        current.check.taskSpentMicros,
        current.check.taskHeldMicros,
        quote.allowanceMicros,
      ) > MAX_LEDGER_USD_MICROS
    )
      return stale();
    const commitTime = await clock(tx);
    if (!validQuoteTime(quote, commitTime) || commitTime.getUTCDate() !== now.getUTCDate())
      return stale();
    const grantId = randomUUID();
    const escrowId = randomUUID();
    const expiresAt = estimatedCostAllowanceExpiry(commitTime);
    const receipt = {
      operationId: decision.operationId,
      decisionId: decision.decisionId,
      quoteId: quote.quoteId,
      status: 'approved' as const,
      allowanceMicros: quote.allowanceMicros,
      expiresAt: expiresAt.toISOString(),
    };
    await tx.insert(costReservations).values({
      id: escrowId,
      taskId: task.id,
      source: 'model',
      estimatedUsd: (quote.allowanceMicros / 1_000_000).toFixed(6),
      status: 'held',
      reservationKind: 'escrow',
      costGrantId: grantId,
      description: 'Owner-approved allowance for one original request',
    });
    await tx.insert(estimatedCostGrants).values({
      id: grantId,
      operationId: decision.operationId,
      quoteId: quote.quoteId,
      escrowReservationId: escrowId,
      allowanceMicros: quote.allowanceMicros,
      expiresAt,
    });
    await tx
      .update(estimatedCostRequests)
      .set({ state: 'approved', updatedAt: commitTime })
      .where(eq(estimatedCostRequests.operationId, decision.operationId));
    await tx
      .update(tasks)
      .set({
        status: 'pending',
        state: marker(task, decision.operationId, quote, request.bindingDigest, grantId),
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        queueGeneration: sql`${tasks.queueGeneration}+1`,
        attempt: 0,
        attentionNotifiedAt: null,
        updatedAt: commitTime,
      })
      .where(eq(tasks.id, task.id));
    await tx.insert(estimatedCostDecisions).values({
      decisionId: decision.decisionId,
      operationId: decision.operationId,
      bodyDigest,
      receipt,
    });
    return { ok: true, receipt };
  });
}
