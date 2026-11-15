import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalEstimatedCostJson,
  type EstimatedCostPreparedQuote,
  type EstimatedCostSourceBinding,
} from '@assistant/persistence';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import {
  createPostgresCostRepository,
  lockCostLedger,
  readEstimatedCostView,
} from './cost-repository.js';
import {
  approvePostgresEstimatedCost,
  capturePostgresEstimatedCostSourceBinding,
  storePreparedPostgresQuote,
} from './estimated-cost-approval-transactions.js';
import {
  agents,
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
  modelConnections,
  modelRoles,
  models,
  tasks,
} from './schema.js';
import { assertAllocatedTestTarget } from './test-target.js';

const url = process.env.DATABASE_URL;
assertAllocatedTestTarget({
  databaseUrl: url,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: 'standard',
});
if (!url) throw new Error('Missing allocated test database');
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalEstimatedCostJson(value)).digest('hex');

describe('PostgreSQL independently parked spending permission', () => {
  let db: Db;
  let ownerId: string,
    conversationId: string,
    taskId: string,
    historyTaskId: string,
    otherTaskId: string,
    operationId: string,
    modelId: string,
    historicalId: string;
  let prepared: EstimatedCostPreparedQuote;
  let previousRole: typeof modelRoles.$inferSelect | undefined;
  let previousConnection: typeof modelConnections.$inferSelect | undefined;
  let previousBudgets: (typeof budgets.$inferSelect)[];
  const text = 'Plan the family weekend';
  const fingerprint = 'f'.repeat(64);

  beforeEach(async () => {
    db = createDb(url);
    ownerId = randomUUID();
    conversationId = randomUUID();
    taskId = randomUUID();
    historyTaskId = randomUUID();
    otherTaskId = randomUUID();
    operationId = randomUUID();
    historicalId = randomUUID();
    modelId = `test/estimated-${randomUUID()}`;
    [previousRole] = await db.select().from(modelRoles).where(eq(modelRoles.role, 'draft'));
    [previousConnection] = await db
      .select()
      .from(modelConnections)
      .where(eq(modelConnections.id, 'openrouter'));
    previousBudgets = await db
      .select()
      .from(budgets)
      .where(inArray(budgets.scope, ['daily', 'monthly']));
    await db.insert(agents).values({
      id: ownerId,
      name: 'estimated-cost-test',
      email: `${ownerId}@estimated.invalid`,
      workspacePrefix: `test/${ownerId}`,
    });
    await db
      .insert(conversations)
      .values({ id: conversationId, agentId: ownerId, channel: 'chat', trust: 'owner' });
    await db.insert(models).values({
      id: modelId,
      label: 'Synthetic model',
      enabled: true,
      promptCostPerMTok: '1.0000',
      completionCostPerMTok: '2.0000',
    });
    await db
      .insert(modelRoles)
      .values({ role: 'draft', primaryModel: modelId, fallbackModel: modelId, params: {} })
      .onConflictDoUpdate({
        target: modelRoles.role,
        set: { primaryModel: modelId, fallbackModel: modelId, params: {} },
      });
    await db
      .insert(modelConnections)
      .values({
        id: 'openrouter',
        kind: 'openrouter',
        label: 'Synthetic provider',
        enabled: true,
        apiKeyEncrypted: 'opaque-synthetic-test-value',
      })
      .onConflictDoUpdate({
        target: modelConnections.id,
        set: { enabled: true, kind: 'openrouter', apiKeyEncrypted: 'opaque-synthetic-test-value' },
      });
    for (const [scope, limitUsd] of [
      ['daily', '6.00'],
      ['monthly', '50.00'],
    ] as const)
      await db
        .insert(budgets)
        .values({ scope, limitUsd })
        .onConflictDoUpdate({ target: budgets.scope, set: { limitUsd } });
    const trigger = {
      source: 'chat',
      agentId: ownerId,
      conversationId,
      trust: 'owner',
      payload: {
        text,
        chatAdmission: {
          protocol: 'owner-chat-v1',
          clientOperationId: operationId,
          requestHash: fingerprint,
        },
      },
    };
    const leaseToken = randomUUID();
    await db.insert(tasks).values([
      {
        id: taskId,
        agentId: ownerId,
        conversationId,
        type: 'chat_turn',
        trust: 'owner',
        status: 'running',
        leaseToken,
        lockedUntil: new Date(Date.now() + 120_000),
        trigger,
        state: { draft: 'Original A checkpoint' },
      },
      { id: historyTaskId, agentId: ownerId, type: 'adhoc', trust: 'owner', status: 'done' },
      {
        id: otherTaskId,
        agentId: ownerId,
        conversationId,
        type: 'chat_turn',
        trust: 'owner',
        status: 'running',
        state: { draft: 'Newer B draft' },
      },
    ]);
    await db.insert(costEvents).values({
      taskId: historyTaskId,
      source: 'model',
      usd: '0.270000',
      description: 'Synthetic recorded usage',
    });
    await db.insert(costReservations).values({
      id: historicalId,
      taskId: historyTaskId,
      source: 'model',
      estimatedUsd: '5.500000',
      status: 'unknown',
      createdAt: new Date(Date.now() - 3_600_000),
    });
    const frozen = [{ reservationId: historicalId, estimatedMicros: 5_500_000 }];
    await db.insert(estimatedCostBaselines).values({
      installationId: ownerId,
      ownerId,
      digest: createHash('sha256').update(JSON.stringify(frozen)).digest('hex'),
      rows: frozen,
    });
    const binding = await sourceBinding();
    const [time] = await db.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
    const now = new Date(time?.now ?? '');
    prepared = {
      actor: { installationId: ownerId, ownerId },
      quoteRequestId: randomUUID(),
      taskId,
      leaseToken,
      requestFingerprint: fingerprint,
      bindingDigest: hash(binding),
      sourceBinding: binding,
      critical: false,
      baseline: frozen,
      quote: {
        type: 'estimated-cost-approval',
        operationId,
        taskId,
        requestText: text,
        quoteId: randomUUID(),
        quoteVersion: randomUUID(),
        expiresAt: new Date(
          Math.min(
            now.getTime() + 60_000,
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
          ),
        ).toISOString(),
        nextAttemptMicros: 300_000,
        allowanceMicros: 500_000,
        recordedDailyMicros: 270_000,
        recordedMonthlyMicros: 270_000,
        totalHeldMicros: 5_500_000,
        eligibleHistoricalUnknownMicros: 5_500_000,
        pendingApprovalMicros: 500_000,
        dailyCeilingMicros: 6_000_000,
        monthlyCeilingMicros: 50_000_000,
        dailyProjectedGrossMicros: 6_270_000,
        monthlyProjectedGrossMicros: 6_270_000,
        complete: true,
        canApprove: true,
      },
    };
  });

  afterEach(async () => {
    try {
      await db
        .delete(estimatedCostQuoteRequests)
        .where(eq(estimatedCostQuoteRequests.operationId, operationId));
      await db
        .delete(estimatedCostDecisions)
        .where(eq(estimatedCostDecisions.operationId, operationId));
      await db.delete(estimatedCostGrants).where(eq(estimatedCostGrants.operationId, operationId));
      await db
        .delete(estimatedCostRequests)
        .where(eq(estimatedCostRequests.operationId, operationId));
      await db
        .delete(estimatedCostBaselines)
        .where(eq(estimatedCostBaselines.installationId, ownerId));
      await db
        .delete(costEvents)
        .where(inArray(costEvents.taskId, [taskId, historyTaskId, otherTaskId]));
      await db
        .delete(costReservations)
        .where(inArray(costReservations.taskId, [taskId, historyTaskId, otherTaskId]));
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
      await db.delete(tasks).where(eq(tasks.agentId, ownerId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
      await db.delete(agents).where(eq(agents.id, ownerId));
      if (previousRole)
        await db.update(modelRoles).set(previousRole).where(eq(modelRoles.role, 'draft'));
      else await db.delete(modelRoles).where(eq(modelRoles.role, 'draft'));
      await db.delete(models).where(eq(models.id, modelId));
      if (previousConnection)
        await db
          .update(modelConnections)
          .set(previousConnection)
          .where(eq(modelConnections.id, 'openrouter'));
      else await db.delete(modelConnections).where(eq(modelConnections.id, 'openrouter'));
      for (const scope of ['daily', 'monthly']) {
        const old = previousBudgets.find((row) => row.scope === scope);
        if (old) await db.update(budgets).set(old).where(eq(budgets.scope, scope));
        else await db.delete(budgets).where(eq(budgets.scope, scope));
      }
    } finally {
      await db.$client.end();
    }
  });

  async function sourceBinding(): Promise<EstimatedCostSourceBinding> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local time zone 'UTC'`);
      const [role] = await tx.execute<{ row: Record<string, unknown> }>(
        sql`select row_to_json(r) as row from model_roles r where role='draft'`,
      );
      const [model] = await tx.execute<{ row: Record<string, unknown> }>(
        sql`select row_to_json(m) as row from models m where id=${modelId}`,
      );
      const [connection] = await tx.execute<{ row: Record<string, unknown> }>(
        sql`select row_to_json(c) as row from model_connections c where id='openrouter'`,
      );
      const policy = await tx.execute<{ row: Record<string, unknown> }>(
        sql`select row_to_json(b) as row from budgets b where scope in ('daily','monthly') order by scope`,
      );
      if (!role || !model || !connection) throw new Error('Missing synthetic source fixture');
      return {
        role: 'draft',
        critical: false,
        selectedModelId: modelId,
        routingDigest: 'a'.repeat(64),
        roleRowDigest: hash(role.row),
        modelRows: [{ id: modelId, digest: hash(model.row) }],
        connectionRows: [{ id: 'openrouter', digest: hash(connection.row) }],
        additionalRoutes: [],
        budgetRows: policy.map((value) => ({
          scope: value.row.scope as 'daily' | 'monthly',
          digest: hash(value.row),
        })),
        privacyGeneration: null,
      };
    });
  }
  function decision(decisionId = randomUUID()) {
    return {
      operationId,
      quoteId: prepared.quote.quoteId,
      quoteVersion: prepared.quote.quoteVersion,
      decisionId,
      decision: 'approve' as const,
    };
  }

  it('parks A without a hold so B reserves and completes, then atomically approves only refreshed A', async () => {
    expect((await storePreparedPostgresQuote(db, prepared)).ok).toBe(true);
    const [a] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(a).toMatchObject({
      status: 'waiting_estimated_cost',
      leaseToken: null,
      lockedUntil: null,
      state: { draft: 'Original A checkpoint', estimatedCostApproval: { status: 'pending' } },
    });
    expect((await db.select().from(costReservations)).length).toBe(1);
    const cards = await db.select().from(messages).where(eq(messages.taskId, taskId));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.parts).toEqual([prepared.quote]);
    expect(cards[0]?.appendSequence).not.toBe('00000000000000000000');
    const costs = createPostgresCostRepository(db);
    const b = await costs.reserve({ source: 'model', estimatedUsd: 0.01, taskId: otherTaskId });
    expect(b.ok).toBe(true);
    if (!b.ok) throw new Error('B incorrectly blocked');
    await costs.reconcile(b.reservationId, { usd: 0.01 });
    expect(await approvePostgresEstimatedCost(db, prepared.actor, decision())).toMatchObject({
      ok: true,
      receipt: { status: 'stale' },
    });
    const quote = {
      ...prepared.quote,
      quoteId: randomUUID(),
      quoteVersion: randomUUID(),
      recordedDailyMicros: 280_000,
      recordedMonthlyMicros: 280_000,
      dailyProjectedGrossMicros: 6_280_000,
      monthlyProjectedGrossMicros: 6_280_000,
    };
    prepared = { ...prepared, quoteRequestId: randomUUID(), leaseToken: null, quote };
    expect((await storePreparedPostgresQuote(db, prepared)).ok).toBe(true);
    const result = await approvePostgresEstimatedCost(db, prepared.actor, decision());
    expect(result).toMatchObject({
      ok: true,
      receipt: { status: 'approved', allowanceMicros: 500_000 },
    });
    const view = await readEstimatedCostView(db, prepared.actor, operationId);
    expect(view?.tracking).toMatchObject({
      recordedDailyMicros: 280_000,
      totalHeldMicros: 6_000_000,
      pendingApprovalMicros: 0,
      dailyPlannedExposureMicros: 6_280_000,
    });
    const [bAfter] = await db.select().from(tasks).where(eq(tasks.id, otherTaskId));
    expect(bAfter?.state).toEqual({ draft: 'Newer B draft' });
    const [original] = await db
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, historicalId));
    expect(original).toMatchObject({ status: 'unknown', estimatedUsd: '5.500000' });
  });

  it('deduplicates refresh retries and rejects replay of an older replaced quote', async () => {
    expect((await storePreparedPostgresQuote(db, prepared)).ok).toBe(true);
    expect(
      (
        await storePreparedPostgresQuote(db, {
          ...prepared,
          quote: { ...prepared.quote, quoteId: randomUUID() },
        })
      ).ok,
    ).toBe(true);
    expect((await db.select().from(estimatedCostQuoteRequests)).length).toBe(1);
    expect((await db.select().from(messages).where(eq(messages.taskId, taskId))).length).toBe(1);
    const old = prepared;
    prepared = {
      ...prepared,
      leaseToken: null,
      quoteRequestId: randomUUID(),
      quote: { ...prepared.quote, quoteId: randomUUID(), quoteVersion: randomUUID() },
    };
    expect((await storePreparedPostgresQuote(db, prepared)).ok).toBe(true);
    expect(await storePreparedPostgresQuote(db, old)).toMatchObject({
      ok: false,
      outcome: 'conflict',
    });
    expect((await db.select().from(costReservations)).length).toBe(1);
  });

  it('allocates one escrow under concurrent duplicate and conflicting approvals', async () => {
    expect((await storePreparedPostgresQuote(db, prepared)).ok).toBe(true);
    const same = decision();
    const replies = await Promise.all([
      approvePostgresEstimatedCost(db, prepared.actor, same),
      approvePostgresEstimatedCost(db, prepared.actor, same),
    ]);
    expect(replies[0]).toEqual(replies[1]);
    expect(replies[0]).toMatchObject({ ok: true, receipt: { status: 'approved' } });
    expect((await db.select().from(estimatedCostGrants)).length).toBe(1);
    expect(
      (
        await db
          .select()
          .from(costReservations)
          .where(eq(costReservations.reservationKind, 'escrow'))
      ).length,
    ).toBe(1);
    expect(
      await approvePostgresEstimatedCost(db, prepared.actor, { ...same, quoteVersion: 'changed' }),
    ).toMatchObject({ ok: false, outcome: 'conflict' });
    expect(await approvePostgresEstimatedCost(db, prepared.actor, decision())).toMatchObject({
      ok: true,
      receipt: { status: 'stale' },
    });
  });

  it('rejects changed pricing even when its update timestamp does not change', async () => {
    expect((await storePreparedPostgresQuote(db, prepared)).ok).toBe(true);
    await db.update(models).set({ promptCostPerMTok: '3.0000' }).where(eq(models.id, modelId));
    expect(await approvePostgresEstimatedCost(db, prepared.actor, decision())).toMatchObject({
      ok: true,
      receipt: { status: 'stale' },
    });
    expect((await db.select().from(estimatedCostGrants)).length).toBe(0);
  });

  it('does not discount a baseline row after its outcome or amount changes', async () => {
    expect((await storePreparedPostgresQuote(db, prepared)).ok).toBe(true);
    await db
      .update(costReservations)
      .set({ status: 'released' })
      .where(eq(costReservations.id, historicalId));
    expect(await approvePostgresEstimatedCost(db, prepared.actor, decision())).toMatchObject({
      ok: true,
      receipt: { status: 'stale' },
    });
    expect((await db.select().from(estimatedCostGrants)).length).toBe(0);
  });

  it('lets the same parked request receive an ordinary-capacity quote after historical pressure clears', async () => {
    expect((await storePreparedPostgresQuote(db, prepared)).ok).toBe(true);
    await db
      .update(costReservations)
      .set({ status: 'released' })
      .where(eq(costReservations.id, historicalId));
    prepared = {
      ...prepared,
      quoteRequestId: randomUUID(),
      leaseToken: null,
      baseline: [],
      quote: {
        ...prepared.quote,
        quoteId: randomUUID(),
        quoteVersion: randomUUID(),
        totalHeldMicros: 0,
        eligibleHistoricalUnknownMicros: 0,
        dailyProjectedGrossMicros: 770_000,
        monthlyProjectedGrossMicros: 770_000,
      },
    };
    expect((await storePreparedPostgresQuote(db, prepared)).ok).toBe(true);
    expect(await approvePostgresEstimatedCost(db, prepared.actor, decision())).toMatchObject({
      ok: true,
      receipt: { status: 'approved', allowanceMicros: 500_000 },
    });
    const [old] = await db
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, historicalId));
    expect(old?.status).toBe('released');
  });

  it('captures source hashes in UTC without spending and rejects environment-only connection credentials', async () => {
    const source = await capturePostgresEstimatedCostSourceBinding(db, {
      actor: prepared.actor,
      taskId,
      role: 'draft',
      selectedModelId: modelId,
      routingDigest: 'a'.repeat(64),
      critical: false,
      additionalRoles: [],
    });
    expect(source).toEqual(prepared.sourceBinding);
    expect((await db.select().from(costReservations)).length).toBe(1);
    expect((await db.select().from(estimatedCostRequests)).length).toBe(0);
    await db
      .update(modelConnections)
      .set({ apiKeyEncrypted: null })
      .where(eq(modelConnections.id, 'openrouter'));
    await expect(
      capturePostgresEstimatedCostSourceBinding(db, {
        actor: prepared.actor,
        taskId,
        role: 'draft',
        selectedModelId: modelId,
        routingDigest: 'a'.repeat(64),
        critical: false,
        additionalRoles: [],
      }),
    ).rejects.toThrow('source binding cannot be proven');
  });

  it('requires the exact active lease, original request, configured source and frozen baseline before parking', async () => {
    for (const altered of [
      { ...prepared, leaseToken: randomUUID() },
      { ...prepared, requestFingerprint: 'other' },
      { ...prepared, quote: { ...prepared.quote, requestText: 'A different request' } },
      { ...prepared, bindingDigest: '0'.repeat(64) },
      { ...prepared, baseline: [] },
    ]) {
      expect((await storePreparedPostgresQuote(db, altered)).ok).toBe(false);
    }
    expect((await db.select().from(estimatedCostRequests)).length).toBe(0);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task?.status).toBe('running');
  });

  it('rolls back the quote, journal and park if the durable review card cannot be saved', async () => {
    await db.execute(
      sql`create function estimated_cost_test_fail_card() returns trigger language plpgsql as $$ begin raise exception 'synthetic card failure'; end; $$`,
    );
    await db.execute(
      sql`create trigger estimated_cost_test_fail_card before insert on messages for each row execute function estimated_cost_test_fail_card()`,
    );
    try {
      await expect(storePreparedPostgresQuote(db, prepared)).rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger estimated_cost_test_fail_card on messages`);
      await db.execute(sql`drop function estimated_cost_test_fail_card()`);
    }
    expect((await db.select().from(estimatedCostRequests)).length).toBe(0);
    expect((await db.select().from(estimatedCostQuoteRequests)).length).toBe(0);
    expect((await db.select().from(messages).where(eq(messages.taskId, taskId))).length).toBe(0);
    expect((await db.select().from(costReservations)).length).toBe(1);
    const [a] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(a).toMatchObject({
      status: 'running',
      leaseToken: prepared.leaseToken,
      state: { draft: 'Original A checkpoint' },
    });
  });

  it('checks real database expiry after waiting for the shared ledger lock', async () => {
    prepared.quote.expiresAt = new Date(Date.now() + 300).toISOString();
    expect((await storePreparedPostgresQuote(db, prepared)).ok).toBe(true);
    let unlock!: () => void;
    let announce!: () => void;
    const held = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const blocker = db.transaction(async (tx) => {
      await lockCostLedger(tx as unknown as Db);
      announce();
      await new Promise<void>((resolve) => {
        unlock = resolve;
      });
    });
    await held;
    const approval = approvePostgresEstimatedCost(db, prepared.actor, decision());
    await new Promise((resolve) => setTimeout(resolve, 350));
    unlock();
    await blocker;
    expect(await approval).toMatchObject({ ok: true, receipt: { status: 'stale' } });
    expect((await db.select().from(estimatedCostGrants)).length).toBe(0);
  });
});
