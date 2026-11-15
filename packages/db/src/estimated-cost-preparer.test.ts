import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalEstimatedCostJson,
  type EstimatedCostPreparedQuote,
  type EstimatedCostSourceBinding,
  MODEL_ROLE_NAMES,
} from '@assistant/persistence';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import {
  beginPostgresEstimatedCostGrantAttempt,
  createPostgresCostRepository,
  drawEstimatedCostGrant,
  lockCostLedger,
  parkPostgresEstimatedCostGrantRenewal,
  readEstimatedCostView,
} from './cost-repository.js';
import {
  approvePostgresEstimatedCost,
  capturePostgresEstimatedCostSourceBinding,
  storePreparedPostgresQuote,
} from './estimated-cost-approval-transactions.js';
import {
  createPostgresEstimatedCostQuotePreparer,
  createPostgresEstimatedCostTurnParking,
} from './estimated-cost-preparer.js';
import { createPostgresModelConnectionRepository } from './model-connection-repository.js';
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

  it('recomputes a parked quote after B spends and refuses changed source prices', async () => {
    expect((await storePreparedPostgresQuote(db, prepared)).ok).toBe(true);
    const costs = createPostgresCostRepository(db);
    const other = await costs.reserve({ source: 'model', estimatedUsd: 0.01, taskId: otherTaskId });
    if (!other.ok) throw new Error('Independent request was blocked');
    await costs.reconcile(other.reservationId, { usd: 0.01 });
    const prepare = createPostgresEstimatedCostQuotePreparer(db, { mutationsEnabled: () => true });
    const result = await prepare.prepare(prepared.actor, {
      operationId,
      quoteRequestId: randomUUID(),
    });
    expect(result).toMatchObject({
      ok: true,
      prepared: { quote: { recordedDailyMicros: 280_000, totalHeldMicros: 5_500_000 } },
    });
    if (!result.ok) throw new Error('Expected a refreshed quote');
    expect((await storePreparedPostgresQuote(db, result.prepared)).ok).toBe(true);
    await db.update(models).set({ promptCostPerMTok: '3.0000' }).where(eq(models.id, modelId));
    expect(
      await prepare.prepare(prepared.actor, { operationId, quoteRequestId: randomUUID() }),
    ).toMatchObject({ ok: false, outcome: 'unavailable' });
  });
  it('dispatches two configured critical roles once under one grant', async () => {
    const [oldPlan] = await db.select().from(modelRoles).where(eq(modelRoles.role, 'plan'));
    try {
      await db.update(budgets).set({ limitUsd: '5.00' }).where(eq(budgets.scope, 'daily'));
      await db
        .insert(modelRoles)
        .values({ role: 'plan', primaryModel: modelId, fallbackModel: modelId, params: {} })
        .onConflictDoUpdate({
          target: modelRoles.role,
          set: { primaryModel: modelId, fallbackModel: modelId, params: {} },
        });
      const binding = await capturePostgresEstimatedCostSourceBinding(db, {
        actor: prepared.actor,
        taskId,
        role: 'draft',
        selectedModelId: modelId,
        routingDigest: 'a'.repeat(64),
        critical: true,
        additionalRoles: ['plan'],
      });
      prepared = {
        ...prepared,
        critical: true,
        sourceBinding: binding,
        bindingDigest: hash(binding),
        quote: {
          ...prepared.quote,
          allowanceMicros: 550_000,
          pendingApprovalMicros: 550_000,
          dailyCeilingMicros: 5_500_000,
          monthlyCeilingMicros: 55_000_000,
          dailyProjectedGrossMicros: 6_320_000,
          monthlyProjectedGrossMicros: 6_320_000,
        },
      };
      expect((await storePreparedPostgresQuote(db, prepared)).ok).toBe(true);
      expect(await approvePostgresEstimatedCost(db, prepared.actor, decision())).toMatchObject({
        ok: true,
        receipt: { status: 'approved' },
      });
      const [grant] = await db
        .select()
        .from(estimatedCostGrants)
        .where(eq(estimatedCostGrants.operationId, operationId));
      if (!grant) throw new Error('Missing grant');
      const leaseToken = randomUUID();
      await db
        .update(tasks)
        .set({ status: 'running', leaseToken, lockedUntil: new Date(Date.now() + 60_000) })
        .where(eq(tasks.id, taskId));
      const common = {
        actor: prepared.actor,
        operationId,
        taskId,
        grantId: grant.id,
        bindingDigest: prepared.bindingDigest,
        source: 'model' as const,
      };
      const attempt = async (role: string, amount: number, digest: string) => {
        const reservationId = randomUUID();
        expect(
          await drawEstimatedCostGrant(db, {
            ...common,
            attemptId: reservationId,
            estimatedMicros: amount,
            description: role,
          }),
        ).toMatchObject({ ok: true });
        const input = {
          actor: prepared.actor,
          operationId,
          taskId,
          grantId: grant.id,
          reservationId,
          leaseToken,
          role,
          critical: true,
          modelId,
          nextAttemptMicros: amount,
          routingDigest: digest.repeat(64),
          requestDigest: digest.repeat(64),
          metadata: {
            provider: 'openrouter',
            model: modelId,
            role,
            requestDigest: digest.repeat(64),
            inputTokenEstimate: 1,
            outputTokenLimit: 1,
            reasoning: 'disabled' as const,
          },
        };
        if (role === 'draft')
          expect(
            await beginPostgresEstimatedCostGrantAttempt(db, {
              ...input,
              routingDigest: 'f'.repeat(64),
            }),
          ).toBe(false);
        expect(await beginPostgresEstimatedCostGrantAttempt(db, input)).toBe(true);
        expect(await beginPostgresEstimatedCostGrantAttempt(db, input)).toBe(false);
      };
      await attempt('draft', 300_000, 'a');
      await attempt('plan', 100_000, 'c');
    } finally {
      if (oldPlan) await db.update(modelRoles).set(oldPlan).where(eq(modelRoles.role, 'plan'));
      else await db.delete(modelRoles).where(eq(modelRoles.role, 'plan'));
    }
  });
  it('prepares and durably parks the first exact candidate without a reservation', async () => {
    const names = MODEL_ROLE_NAMES.filter((role) => role !== 'embed');
    const previous = await db.select().from(modelRoles).where(inArray(modelRoles.role, names));
    try {
      for (const role of names)
        await db
          .insert(modelRoles)
          .values({ role, primaryModel: modelId, fallbackModel: modelId, params: {} })
          .onConflictDoUpdate({
            target: modelRoles.role,
            set: { primaryModel: modelId, fallbackModel: modelId, params: {} },
          });
      const parking = createPostgresEstimatedCostTurnParking(db, { mutationsEnabled: () => true });
      const result = await parking.park({
        actor: prepared.actor,
        conversationId,
        operationId,
        taskId,
        leaseToken: prepared.leaseToken!,
        requestFingerprint: fingerprint,
        quoteRequestId: randomUUID(),
        candidate: {
          role: 'draft',
          critical: false,
          modelId,
          nextAttemptMicros: 300_000,
          routingDigest: 'a'.repeat(64),
          requestDigest: 'b'.repeat(64),
        },
      });
      expect(result).toMatchObject({ ok: true, status: 'pending', operationId, taskId });
      expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe(
        'waiting_estimated_cost',
      );
      expect(
        await db.select().from(costReservations).where(eq(costReservations.taskId, taskId)),
      ).toHaveLength(0);
      expect(await db.select().from(messages).where(eq(messages.taskId, taskId))).toHaveLength(1);
    } finally {
      for (const role of names) {
        const original = previous.find((row) => row.role === role);
        if (original) await db.update(modelRoles).set(original).where(eq(modelRoles.role, role));
        else await db.delete(modelRoles).where(eq(modelRoles.role, role));
      }
    }
  });

  it('requires the same pinned environment witness at park, approval and dispatch', async () => {
    await db.delete(modelConnections).where(eq(modelConnections.id, 'openrouter'));
    const source = {
      provider: 'openrouter' as const,
      endpoint: 'https://openrouter.ai/api/v1' as const,
      installationId: ownerId,
      projectId: 'test-project',
      secretVersion: 'projects/test-project/secrets/provider/versions/31',
      sourceRelease: 'a'.repeat(40),
    };
    const binding = await capturePostgresEstimatedCostSourceBinding(db, {
      actor: prepared.actor,
      taskId,
      role: 'draft',
      selectedModelId: modelId,
      routingDigest: 'a'.repeat(64),
      critical: false,
      additionalRoles: [],
      providerSource: source,
    });
    prepared = { ...prepared, sourceBinding: binding, bindingDigest: hash(binding) };
    expect((await storePreparedPostgresQuote(db, prepared)).ok).toBe(false);
    expect((await storePreparedPostgresQuote(db, prepared, source)).ok).toBe(true);
    const changed = { ...source, secretVersion: source.secretVersion.replace('/31', '/32') };
    expect(
      await approvePostgresEstimatedCost(db, prepared.actor, decision(), changed),
    ).toMatchObject({ ok: true, receipt: { status: 'stale' } });
    expect(
      await approvePostgresEstimatedCost(db, prepared.actor, decision(), source),
    ).toMatchObject({ ok: true, receipt: { status: 'approved' } });
    const [grant] = await db
      .select()
      .from(estimatedCostGrants)
      .where(eq(estimatedCostGrants.operationId, operationId));
    if (!grant) throw new Error('Missing grant');
    const leaseToken = randomUUID(),
      reservationId = randomUUID();
    await db
      .update(tasks)
      .set({ status: 'running', leaseToken, lockedUntil: new Date(Date.now() + 60_000) })
      .where(eq(tasks.id, taskId));
    expect(
      await drawEstimatedCostGrant(db, {
        actor: prepared.actor,
        operationId,
        taskId,
        grantId: grant.id,
        bindingDigest: prepared.bindingDigest,
        attemptId: reservationId,
        source: 'model',
        estimatedMicros: 300_000,
        description: 'draft',
      }),
    ).toMatchObject({ ok: true });
    const input = {
      actor: prepared.actor,
      operationId,
      taskId,
      grantId: grant.id,
      reservationId,
      leaseToken,
      role: 'draft',
      critical: false,
      modelId,
      nextAttemptMicros: 300_000,
      routingDigest: 'a'.repeat(64),
      requestDigest: 'b'.repeat(64),
      metadata: {
        provider: 'openrouter',
        model: modelId,
        role: 'draft',
        requestDigest: 'b'.repeat(64),
        inputTokenEstimate: 1,
        outputTokenLimit: 1,
        reasoning: 'disabled' as const,
      },
    };
    expect(await beginPostgresEstimatedCostGrantAttempt(db, input, changed)).toBe(false);
    expect(await beginPostgresEstimatedCostGrantAttempt(db, input, source)).toBe(true);
  });

  it('serializes a new connection with the source and ledger fence', async () => {
    await db.delete(modelConnections).where(eq(modelConnections.id, 'openrouter'));
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = db.transaction(async (tx) => {
      await lockCostLedger(tx as unknown as Db);
      locked();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    const upsert = createPostgresModelConnectionRepository(db).upsert({
      id: 'openrouter',
      kind: 'openrouter',
      label: 'Synthetic',
      enabled: true,
      baseUrl: null,
      vertexProject: null,
      vertexLocation: null,
      apiKeyEncrypted: 'synthetic',
    });
    try {
      const early = await Promise.race([
        upsert.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 60)),
      ]);
      expect(early).toBe(false);
    } finally {
      release();
      await blocker;
    }
    expect((await upsert).id).toBe('openrouter');
  });

  it.each(['expired', 'exhausted'] as const)(
    're-parks an %s grant and requires a fresh decision',
    async (condition) => {
      const names = MODEL_ROLE_NAMES.filter((role) => role !== 'embed');
      const previous = await db.select().from(modelRoles).where(inArray(modelRoles.role, names));
      try {
        for (const role of names)
          await db
            .insert(modelRoles)
            .values({ role, primaryModel: modelId, fallbackModel: modelId, params: {} })
            .onConflictDoUpdate({
              target: modelRoles.role,
              set: { primaryModel: modelId, fallbackModel: modelId, params: {} },
            });
        expect((await storePreparedPostgresQuote(db, prepared)).ok).toBe(true);
        expect(await approvePostgresEstimatedCost(db, prepared.actor, decision())).toMatchObject({
          ok: true,
          receipt: { status: 'approved' },
        });
        const [grant] = await db
          .select()
          .from(estimatedCostGrants)
          .where(eq(estimatedCostGrants.operationId, operationId));
        if (!grant) throw new Error('Missing grant');
        const leaseToken = randomUUID();
        await db
          .update(tasks)
          .set({ status: 'running', leaseToken, lockedUntil: new Date(Date.now() + 60_000) })
          .where(eq(tasks.id, taskId));
        let uncertainAttemptId: string | undefined;
        if (condition === 'expired') {
          uncertainAttemptId = randomUUID();
          expect(
            await drawEstimatedCostGrant(db, {
              actor: prepared.actor,
              operationId,
              taskId,
              grantId: grant.id,
              bindingDigest: prepared.bindingDigest,
              attemptId: uncertainAttemptId,
              source: 'model',
              estimatedMicros: 1,
              description: 'synthetic uncertain dispatch',
            }),
          ).toMatchObject({ ok: true });
          await db
            .update(costReservations)
            .set({ status: 'dispatching' })
            .where(eq(costReservations.id, uncertainAttemptId));
          await createPostgresCostRepository(db).markAttemptUnknown(
            uncertainAttemptId,
            'synthetic uncertain outcome',
          );
          await db
            .update(estimatedCostGrants)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(estimatedCostGrants.id, grant.id));
        }
        if (condition === 'exhausted') {
          const attemptId = randomUUID();
          expect(
            await drawEstimatedCostGrant(db, {
              actor: prepared.actor,
              operationId,
              taskId,
              grantId: grant.id,
              bindingDigest: prepared.bindingDigest,
              attemptId,
              source: 'model',
              estimatedMicros: 500_000,
              description: 'synthetic spent grant',
            }),
          ).toMatchObject({ ok: true });
          await db
            .update(costReservations)
            .set({ status: 'dispatching' })
            .where(eq(costReservations.id, attemptId));
          await createPostgresCostRepository(db).reconcile(attemptId, { usd: 0.00001 });
        }
        const candidate = {
          role: 'draft',
          critical: false,
          modelId,
          nextAttemptMicros: 300_000,
          routingDigest: 'c'.repeat(64),
          requestDigest: 'd'.repeat(64),
        };
        expect(
          await parkPostgresEstimatedCostGrantRenewal(db, {
            actor: prepared.actor,
            operationId,
            taskId,
            grantId: grant.id,
            bindingDigest: prepared.bindingDigest,
            leaseToken,
            candidate,
          }),
        ).toBe(true);
        expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe(
          'waiting_estimated_cost',
        );
        expect(
          (await db.select().from(costReservations).where(eq(costReservations.id, historicalId)))[0]
            ?.status,
        ).toBe('unknown');
        if (uncertainAttemptId)
          expect(
            (
              await db
                .select()
                .from(costReservations)
                .where(eq(costReservations.id, uncertainAttemptId))
            )[0]?.status,
          ).toBe('unknown');
        expect(
          (
            await db
              .select()
              .from(costReservations)
              .where(eq(costReservations.id, grant.escrowReservationId))
          )[0]?.status,
        ).toBe('released');
        const fresh = await createPostgresEstimatedCostQuotePreparer(db, {
          mutationsEnabled: () => true,
        }).prepare(prepared.actor, { operationId, quoteRequestId: randomUUID() });
        if (!fresh.ok) throw new Error('Renewal unavailable');
        expect((await storePreparedPostgresQuote(db, fresh.prepared)).ok).toBe(true);
        expect(
          await approvePostgresEstimatedCost(db, prepared.actor, {
            operationId,
            quoteId: fresh.prepared.quote.quoteId,
            quoteVersion: fresh.prepared.quote.quoteVersion,
            decisionId: randomUUID(),
            decision: 'approve',
          }),
        ).toMatchObject({ ok: true, receipt: { status: 'approved' } });
      } finally {
        for (const role of names) {
          const original = previous.find((row) => row.role === role);
          if (original) await db.update(modelRoles).set(original).where(eq(modelRoles.role, role));
          else await db.delete(modelRoles).where(eq(modelRoles.role, role));
        }
      }
    },
  );
});
