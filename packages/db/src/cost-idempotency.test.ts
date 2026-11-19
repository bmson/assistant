import { createHash, randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import {
  createPostgresCostRepository,
  createPostgresEstimatedCostApprovalRepository,
  drawEstimatedCostGrant,
  expireEstimatedCostGrant,
  readEstimatedCostDecision,
  readEstimatedCostRequest,
  readEstimatedCostView,
  recordCostEvent,
} from './cost-repository.js';
import {
  agents,
  costEvents,
  costReservations,
  estimatedCostBaselines,
  estimatedCostDecisions,
  estimatedCostGrants,
  estimatedCostRequests,
  tasks,
} from './schema.js';
import { assertAllocatedTestTarget } from './test-target.js';

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL;
  assertAllocatedTestTarget({
    databaseUrl: url,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    kind: 'standard',
  });
  if (!url) throw new Error('Missing allocated test database URL');
  return url;
})();

describe('PostgreSQL idempotent cost events', () => {
  let db: Db;
  let agentId: string;
  let taskId: string;
  let reservationIds: string[];

  beforeEach(async () => {
    db = createDb(DATABASE_URL);
    agentId = randomUUID();
    taskId = randomUUID();
    reservationIds = [];
    await db.insert(agents).values({
      id: agentId,
      name: 'cost-idempotency-test',
      email: `${agentId}@cost-idempotency.invalid`,
      workspacePrefix: `cost-idempotency/${agentId}`,
    });
    await db.insert(tasks).values({ id: taskId, agentId, type: 'chat_turn', trust: 'owner' });
  });

  afterEach(async () => {
    try {
      await db.delete(costEvents).where(eq(costEvents.taskId, taskId));
      if (reservationIds.length) {
        await db.delete(costEvents).where(inArray(costEvents.reservationId, reservationIds));
        await db.delete(costReservations).where(inArray(costReservations.id, reservationIds));
      }
      await db.delete(costReservations).where(eq(costReservations.taskId, taskId));
      await db.delete(tasks).where(eq(tasks.id, taskId));
      await db.delete(agents).where(eq(agents.id, agentId));
    } finally {
      await db.$client.end();
    }
  });

  it('returns structured ceiling information for a denied reservation', async () => {
    const outcome = await createPostgresCostRepository(db).reserve({
      source: 'model',
      estimatedUsd: 4.000001,
    });
    expect(outcome).toMatchObject({
      ok: false,
      budget: { scope: 'daily', nextAttemptMicros: 4_000_001 },
    });
  });

  it('never dispatches, reconciles, or cleans up an escrow as an ordinary reservation', async () => {
    const costs = createPostgresCostRepository(db);
    const reservation = await costs.reserve({ source: 'model', estimatedUsd: 0.2, taskId });
    if (!reservation.ok) throw new Error('Fixture failed to reserve');
    reservationIds.push(reservation.reservationId);
    await db
      .update(costReservations)
      .set({ reservationKind: 'escrow', createdAt: new Date(Date.now() - 180 * 60_000) })
      .where(eq(costReservations.id, reservation.reservationId));
    expect(
      await costs.beginAttempt(reservation.reservationId, {
        provider: 'test',
        model: 'test',
        role: 'chat',
        requestDigest: 'a'.repeat(64),
        inputTokenEstimate: 1,
        outputTokenLimit: 1,
        reasoning: 'disabled',
      }),
    ).toBe(false);
    await costs.release(reservation.reservationId);
    await costs.reconcile(reservation.reservationId, { usd: 0.1 });
    await costs.releaseStale(120, 500);
    const [row] = await db
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, reservation.reservationId));
    expect(row).toMatchObject({
      status: 'held',
      reservationKind: 'escrow',
      estimatedUsd: '0.200000',
    });
  });

  it('atomically transfers escrow to one attempt under concurrent draws', async () => {
    const costs = createPostgresCostRepository(db);
    const reservation = await costs.reserve({ source: 'model', estimatedUsd: 0.2, taskId });
    if (!reservation.ok) throw new Error('Fixture failed to reserve');
    reservationIds.push(reservation.reservationId);
    const grantId = randomUUID();
    const operationId = randomUUID();
    const quote = {
      type: 'estimated-cost-approval',
      operationId,
      taskId,
      requestText: 'request',
      quoteId: 'quote',
      quoteVersion: 'v1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nextAttemptMicros: 100_000,
      allowanceMicros: 200_000,
      recordedDailyMicros: 0,
      recordedMonthlyMicros: 0,
      totalHeldMicros: 500_000,
      eligibleHistoricalUnknownMicros: 400_000,
      pendingApprovalMicros: 200_000,
      dailyCeilingMicros: 1_000_000,
      monthlyCeilingMicros: 2_000_000,
      dailyProjectedGrossMicros: 700_000,
      monthlyProjectedGrossMicros: 700_000,
      complete: true,
      canApprove: true,
    };
    await db
      .update(costReservations)
      .set({ reservationKind: 'escrow', costGrantId: grantId })
      .where(eq(costReservations.id, reservation.reservationId));
    await db.insert(estimatedCostRequests).values({
      operationId,
      installationId: 'install',
      ownerId: 'owner',
      taskId,
      requestFingerprint: 'request',
      bindingDigest: 'binding',
      sourceBinding: {},
      state: 'approved',
      quote,
      baseline: {},
    });
    await db.insert(estimatedCostGrants).values({
      id: grantId,
      operationId,
      quoteId: 'quote',
      escrowReservationId: reservation.reservationId,
      allowanceMicros: 200_000,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const receipt = {
      operationId,
      decisionId: 'decision',
      quoteId: 'quote',
      status: 'approved',
      allowanceMicros: 200_000,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await db
      .insert(estimatedCostDecisions)
      .values({ decisionId: 'decision', operationId, bodyDigest: 'body', receipt });
    const input = {
      actor: { installationId: 'install', ownerId: 'owner' },
      operationId,
      grantId,
      bindingDigest: 'binding',
      taskId,
      source: 'model' as const,
      estimatedMicros: 120_000,
      description: 'attempt',
    };
    const firstId = randomUUID();
    const secondId = randomUUID();
    const pendingOperationId = randomUUID();
    await db.insert(estimatedCostRequests).values({
      operationId: pendingOperationId,
      installationId: 'install',
      ownerId: 'owner',
      taskId,
      requestFingerprint: 'other-request',
      bindingDigest: 'other-binding',
      sourceBinding: {},
      state: 'pending',
      quote: { ...quote, operationId: pendingOperationId, quoteId: 'other-quote' },
      baseline: {},
    });
    reservationIds.push(firstId, secondId);
    try {
      const overview = () =>
        createPostgresEstimatedCostApprovalRepository(db).getOverview?.(input.actor);
      expect(await overview()).toMatchObject({
        ok: true,
        requests: [
          {
            status: 'pending',
            operationId: pendingOperationId,
            quote: { taskId, quoteId: 'other-quote' },
          },
        ],
        tracking: { pendingApprovalMicros: 200_000, totalHeldMicros: 200_000 },
      });
      expect(
        await createPostgresEstimatedCostApprovalRepository(db).getOverview?.({
          ...input.actor,
          ownerId: 'other',
        }),
      ).toMatchObject({ ok: true, requests: [] });
      expect(
        await createPostgresEstimatedCostApprovalRepository(db).getOverview?.({
          ...input.actor,
          installationId: 'other',
        }),
      ).toMatchObject({ ok: true, requests: [] });
      await db
        .update(estimatedCostRequests)
        .set({ quote: { invalid: true } })
        .where(eq(estimatedCostRequests.operationId, pendingOperationId));
      expect(await overview()).toMatchObject({
        ok: true,
        requests: null,
        tracking: { pendingApprovalMicros: null, complete: false },
      });
      await db
        .update(estimatedCostRequests)
        .set({
          quote: {
            ...quote,
            operationId: pendingOperationId,
            quoteId: 'other-quote',
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          },
        })
        .where(eq(estimatedCostRequests.operationId, pendingOperationId));
      expect(await overview()).toMatchObject({
        ok: true,
        requests: [{ status: 'expired_or_needs_refresh', operationId: pendingOperationId }],
        tracking: { pendingApprovalMicros: 0 },
      });
      await db
        .update(estimatedCostRequests)
        .set({ state: 'expired_or_needs_refresh' })
        .where(eq(estimatedCostRequests.operationId, pendingOperationId));
      expect(await overview()).toMatchObject({
        ok: true,
        requests: [{ status: 'expired_or_needs_refresh', operationId: pendingOperationId }],
        tracking: { pendingApprovalMicros: 0 },
      });
      await db
        .update(estimatedCostRequests)
        .set({
          state: 'pending',
          quote: { ...quote, operationId: pendingOperationId, quoteId: 'other-quote' },
        })
        .where(eq(estimatedCostRequests.operationId, pendingOperationId));
      await db
        .update(estimatedCostRequests)
        .set({ quote: { quoteId: 'other' } })
        .where(eq(estimatedCostRequests.operationId, operationId));
      expect(await drawEstimatedCostGrant(db, { ...input, attemptId: firstId })).toEqual({
        ok: false,
        reason: 'unavailable',
      });
      await db
        .update(estimatedCostRequests)
        .set({ quote })
        .where(eq(estimatedCostRequests.operationId, operationId));
      expect(await readEstimatedCostRequest(db, input.actor, operationId)).toMatchObject({
        status: 'approved',
        operationId,
        quote,
      });
      expect((await readEstimatedCostView(db, input.actor, operationId))?.tracking).toMatchObject({
        totalHeldMicros: 200_000,
        pendingApprovalMicros: 200_000,
        dailyPlannedExposureMicros: 400_000,
      });
      await costs.record({ source: 'model', usd: 0.01, taskId });
      expect((await readEstimatedCostView(db, input.actor, operationId))?.tracking).toMatchObject({
        recordedDailyMicros: 10_000,
        totalHeldMicros: 200_000,
        pendingApprovalMicros: 200_000,
        dailyPlannedExposureMicros: 410_000,
      });
      await db
        .update(estimatedCostRequests)
        .set({ state: 'declined' })
        .where(eq(estimatedCostRequests.operationId, pendingOperationId));
      expect(await overview()).toMatchObject({
        ok: true,
        requests: [],
        tracking: { pendingApprovalMicros: 0, totalHeldMicros: 200_000 },
      });
      expect((await readEstimatedCostView(db, input.actor, operationId))?.tracking).toMatchObject({
        pendingApprovalMicros: 0,
        dailyPlannedExposureMicros: 210_000,
      });
      expect(
        await readEstimatedCostRequest(db, { ...input.actor, ownerId: 'other' }, operationId),
      ).toBeNull();
      expect(
        await readEstimatedCostDecision(db, input.actor, { operationId, decisionId: 'decision' }),
      ).toEqual(receipt);
      expect(
        await readEstimatedCostDecision(
          db,
          { ...input.actor, ownerId: 'other' },
          { operationId, decisionId: 'decision' },
        ),
      ).toBeNull();
      expect(
        await readEstimatedCostDecision(db, input.actor, { operationId, decisionId: 'other' }),
      ).toBeNull();
      await db
        .update(estimatedCostDecisions)
        .set({ receipt: { ...receipt, operationId: 'other' } })
        .where(eq(estimatedCostDecisions.decisionId, 'decision'));
      await expect(
        readEstimatedCostDecision(db, input.actor, { operationId, decisionId: 'decision' }),
      ).rejects.toThrow('Invalid stored');
      await db
        .update(estimatedCostDecisions)
        .set({ receipt })
        .where(eq(estimatedCostDecisions.decisionId, 'decision'));
      const before = await costs.totals();
      const outcomes = await Promise.all([
        drawEstimatedCostGrant(db, { ...input, attemptId: firstId }),
        drawEstimatedCostGrant(db, { ...input, attemptId: secondId }),
      ]);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
        { ok: false, reason: 'exhausted' },
      ]);
      const success = outcomes.find((outcome) => outcome.ok);
      if (!success?.ok) throw new Error('Expected successful draw');
      expect(
        await drawEstimatedCostGrant(db, { ...input, attemptId: success.reservationId }),
      ).toEqual(success);
      expect((await costs.totals()).heldUsd).toBe(before.heldUsd);
      const [grant] = await db
        .select()
        .from(estimatedCostGrants)
        .where(eq(estimatedCostGrants.id, grantId));
      expect(grant?.consumedMicros).toBe(120_000);
      await expect(
        drawEstimatedCostGrant(db, {
          ...input,
          attemptId: success.reservationId,
          estimatedMicros: 1,
        }),
      ).rejects.toThrow('reused');
      expect(
        await drawEstimatedCostGrant(db, {
          ...input,
          actor: { ...input.actor, ownerId: 'other' },
          attemptId: randomUUID(),
        }),
      ).toEqual({ ok: false, reason: 'unavailable' });
      await costs.reconcile(success.reservationId, { usd: 0.15 });
      const [adjusted] = await db
        .select()
        .from(estimatedCostGrants)
        .where(eq(estimatedCostGrants.id, grantId));
      expect(adjusted?.consumedMicros).toBe(150_000);
      expect((await costs.totals()).heldUsd).toBeCloseTo(before.heldUsd - 0.15);
      const lowId = randomUUID();
      reservationIds.push(lowId);
      expect(
        await drawEstimatedCostGrant(db, {
          ...input,
          estimatedMicros: 30_000,
          attemptId: lowId,
        }),
      ).toEqual({ ok: true, reservationId: lowId });
      await costs.reconcile(lowId, { usd: 0.01 });
      const [afterLow] = await db
        .select()
        .from(estimatedCostGrants)
        .where(eq(estimatedCostGrants.id, grantId));
      expect(afterLow?.consumedMicros).toBe(180_000);
      const unknownId = randomUUID();
      reservationIds.push(unknownId);
      expect(
        await drawEstimatedCostGrant(db, {
          ...input,
          estimatedMicros: 10_000,
          attemptId: unknownId,
        }),
      ).toEqual({ ok: true, reservationId: unknownId });
      await db
        .update(estimatedCostGrants)
        .set({ expiresAt: new Date(Date.now() + 300) })
        .where(eq(estimatedCostGrants.id, grantId));
      let unlock!: () => void;
      let locked!: () => void;
      const lockReady = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const releaseLock = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const blocker = db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext('assistant:cost-reservations'))`,
        );
        locked();
        await releaseLock;
      });
      await lockReady;
      const delayed = drawEstimatedCostGrant(db, { ...input, attemptId: success.reservationId });
      try {
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          const rows = await db.execute(
            sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%pg_advisory_xact_lock%'`,
          );
          if (rows.length) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 350));
      } finally {
        unlock();
        await blocker;
      }
      expect(await delayed).toEqual({ ok: false, reason: 'expired' });
      expect(await readEstimatedCostRequest(db, input.actor, operationId)).toMatchObject({
        status: 'expired_or_needs_refresh',
      });
      await db
        .update(costReservations)
        .set({ status: 'unknown' })
        .where(eq(costReservations.id, unknownId));
      expect(await expireEstimatedCostGrant(db, grantId)).toBe(true);
      expect(await expireEstimatedCostGrant(db, grantId)).toBe(false);
      const [child] = await db
        .select()
        .from(costReservations)
        .where(eq(costReservations.id, unknownId));
      expect(child?.status).toBe('unknown');
      expect((await costs.totals()).heldUsd).toBeCloseTo(before.heldUsd - 0.19);
      const old = await costs.reserve({ source: 'model', estimatedUsd: 0.1 });
      if (!old.ok) throw new Error('Expected historical hold');
      reservationIds.push(old.reservationId);
      await db
        .update(costReservations)
        .set({ status: 'unknown' })
        .where(eq(costReservations.id, old.reservationId));
      const frozen = [{ reservationId: old.reservationId, estimatedMicros: 100_000 }];
      await db.insert(estimatedCostBaselines).values({
        installationId: 'install',
        ownerId: 'owner',
        rows: frozen,
        digest: createHash('sha256').update(JSON.stringify(frozen)).digest('hex'),
      });
      expect((await readEstimatedCostView(db, input.actor, operationId))?.tracking).toMatchObject({
        historicalUnknownMicros: 100_000,
        totalHeldMicros: 110_000,
      });
      await costs.reconcile(old.reservationId, { usd: 0.05 });
      expect((await readEstimatedCostView(db, input.actor, operationId))?.tracking).toMatchObject({
        historicalUnknownMicros: 0,
        totalHeldMicros: 10_000,
      });
      const invalid = [{ reservationId: unknownId, estimatedMicros: 10_000 }];
      await db
        .update(estimatedCostBaselines)
        .set({
          rows: invalid,
          digest: createHash('sha256').update(JSON.stringify(invalid)).digest('hex'),
        })
        .where(eq(estimatedCostBaselines.installationId, 'install'));
      expect(
        (await readEstimatedCostView(db, input.actor, operationId))?.tracking
          .historicalUnknownMicros,
      ).toBeNull();
    } finally {
      await db
        .delete(estimatedCostBaselines)
        .where(eq(estimatedCostBaselines.installationId, 'install'));
      await db
        .delete(estimatedCostRequests)
        .where(eq(estimatedCostRequests.operationId, pendingOperationId));
      await db
        .delete(estimatedCostDecisions)
        .where(eq(estimatedCostDecisions.decisionId, 'decision'));
      await db.delete(estimatedCostGrants).where(eq(estimatedCostGrants.id, grantId));
      await db
        .delete(estimatedCostRequests)
        .where(eq(estimatedCostRequests.operationId, operationId));
    }
  });

  it('closes only the selected expired parked request and replays the exact decline receipt', async () => {
    const operationId = randomUUID();
    const otherTaskId = randomUUID();
    const fingerprint = 'request-fingerprint';
    const quote = {
      type: 'estimated-cost-approval',
      operationId,
      taskId,
      requestText: 'request',
      quoteId: 'quote',
      quoteVersion: 'v1',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      nextAttemptMicros: 100_000,
      allowanceMicros: 200_000,
      recordedDailyMicros: 0,
      recordedMonthlyMicros: 0,
      totalHeldMicros: 500_000,
      eligibleHistoricalUnknownMicros: 400_000,
      pendingApprovalMicros: 200_000,
      dailyCeilingMicros: 1_000_000,
      monthlyCeilingMicros: 2_000_000,
      dailyProjectedGrossMicros: 700_000,
      monthlyProjectedGrossMicros: 700_000,
      complete: true,
      canApprove: true,
    };
    const trigger = {
      payload: {
        chatAdmission: {
          protocol: 'owner-chat-v1',
          clientOperationId: operationId,
          requestHash: fingerprint,
        },
      },
    };
    await db
      .update(tasks)
      .set({ status: 'waiting_estimated_cost', trigger })
      .where(eq(tasks.id, taskId));
    await db
      .insert(tasks)
      .values({ id: otherTaskId, agentId, type: 'chat_turn', trust: 'owner', status: 'pending' });
    await db.insert(estimatedCostRequests).values({
      operationId,
      installationId: 'install',
      ownerId: agentId,
      taskId,
      requestFingerprint: fingerprint,
      bindingDigest: 'binding',
      sourceBinding: {},
      state: 'pending',
      quote,
      baseline: [],
    });
    const repo = createPostgresEstimatedCostApprovalRepository(db);
    const actor = { installationId: 'install', ownerId: agentId };
    const decision = {
      operationId,
      quoteId: 'quote',
      quoteVersion: 'v1',
      decisionId: 'decline-one',
      decision: 'decline' as const,
    };
    try {
      expect(await repo.decide(actor, { ...decision, decision: 'approve' })).toMatchObject({
        ok: false,
        outcome: 'unavailable',
      });
      expect(await repo.decide({ ...actor, ownerId: 'other' }, decision)).toMatchObject({
        ok: false,
        outcome: 'not_found',
      });
      const stale = await repo.decide(actor, {
        ...decision,
        decisionId: 'stale',
        quoteVersion: 'old',
      });
      expect(stale).toMatchObject({ ok: true, receipt: { status: 'stale' } });
      const results = await Promise.all([
        repo.decide(actor, decision),
        repo.decide(actor, { ...decision, decisionId: 'decline-two' }),
      ]);
      const winner = results.find((result) => result.ok && result.receipt.status === 'declined');
      expect(winner?.ok).toBe(true);
      expect(results.filter((result) => !result.ok)).toHaveLength(1);
      if (!winner?.ok) throw new Error('Expected decline receipt');
      const replay = { ...decision, decisionId: winner.receipt.decisionId };
      expect(await repo.decide(actor, replay)).toEqual(winner);
      expect(
        await repo.getDecisionReceipt(actor, { operationId, decisionId: replay.decisionId }),
      ).toEqual(winner);
      expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe(
        'cancelled',
      );
      expect((await db.select().from(tasks).where(eq(tasks.id, otherTaskId)))[0]?.status).toBe(
        'pending',
      );
      expect(
        await db.select().from(costReservations).where(eq(costReservations.taskId, taskId)),
      ).toHaveLength(0);
    } finally {
      await db
        .delete(estimatedCostDecisions)
        .where(eq(estimatedCostDecisions.operationId, operationId));
      await db
        .delete(estimatedCostRequests)
        .where(eq(estimatedCostRequests.operationId, operationId));
      await db.delete(tasks).where(eq(tasks.id, otherTaskId));
    }
  });

  it('does not release a hold whose provider dispatch commits while stale cleanup waits', async () => {
    const costs = createPostgresCostRepository(db);
    const reservation = await costs.reserve({ source: 'model', estimatedUsd: 0.2, taskId });
    if (!reservation.ok) throw new Error('Fixture failed to reserve');
    reservationIds.push(reservation.reservationId);
    await db
      .update(costReservations)
      .set({ createdAt: new Date(Date.now() - 121 * 60_000) })
      .where(eq(costReservations.id, reservation.reservationId));

    let unlock!: () => void;
    let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const releaseLock = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const dispatch = db.transaction(async (tx) => {
      await tx
        .update(costReservations)
        .set({ status: 'dispatching', attemptStartedAt: new Date() })
        .where(eq(costReservations.id, reservation.reservationId));
      locked();
      await releaseLock;
    });
    await lockReady;
    const cleanup = costs.releaseStale(120, 500);
    try {
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const rows = await db.execute(
          sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%update%cost_reservations%'`,
        );
        if (rows.length) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
    } finally {
      unlock();
      await dispatch;
    }
    await cleanup;
    const [after] = await db
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, reservation.reservationId));
    expect(after?.status).toBe('dispatching');
    await costs.reconcile(reservation.reservationId, { usd: 0.1 });
    const events = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.reservationId, reservation.reservationId));
    expect(events).toHaveLength(1);
    expect(events[0]?.usd).toBe('0.100000');
  });

  it('serializes an unknown transition with the cost ledger fence', async () => {
    const costs = createPostgresCostRepository(db);
    const reservation = await costs.reserve({ source: 'model', estimatedUsd: 0.2, taskId });
    if (!reservation.ok) throw new Error('Fixture failed to reserve');
    reservationIds.push(reservation.reservationId);
    await db
      .update(costReservations)
      .set({ status: 'dispatching', attemptStartedAt: new Date() })
      .where(eq(costReservations.id, reservation.reservationId));
    let unlock!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('assistant:cost-reservations'))`);
      locked();
      await release;
    });
    await ready;
    const transition = costs.markAttemptUnknown(reservation.reservationId, 'uncertain');
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const rows = await db.execute(
          sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%pg_advisory_xact_lock%'`,
        );
        if (rows.length) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      unlock();
      await blocker;
    }
    await transition;
    expect(
      (
        await db
          .select()
          .from(costReservations)
          .where(eq(costReservations.id, reservation.reservationId))
      )[0]?.status,
    ).toBe('unknown');
  });

  it('records one ledger event and one task-spend increment after replay', async () => {
    const input = {
      source: 'model' as const,
      usd: 0.125,
      taskId,
      description: 'phone live model',
      idempotencyKey: `call:${randomUUID()}:model`,
      addToTaskSpend: true,
    };
    await recordCostEvent(db, input);
    await recordCostEvent(db, input);

    expect(await db.select().from(costEvents).where(eq(costEvents.taskId, taskId))).toHaveLength(1);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(Number(task?.spentUsd)).toBeCloseTo(0.125, 6);
  });

  it('persists half-micro event inputs using the shared rounded ledger value', async () => {
    await recordCostEvent(db, {
      source: 'model',
      usd: 0.0000005,
      taskId,
      idempotencyKey: `half-micro:${randomUUID()}`,
      addToTaskSpend: true,
    });
    const [row] = await db.select().from(costEvents).where(eq(costEvents.taskId, taskId));
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row?.usd).toBe('0.000001');
    expect(task?.spentUsd).toBe('0.000001');
    const repository = createPostgresCostRepository(db);
    const reserved = await repository.reserve({
      source: 'model',
      estimatedUsd: 0.0000005,
      operationId: `half-reserve:${randomUUID()}`,
    });
    if (!reserved.ok) throw new Error('Fixture failed to reserve one rounded microdollar');
    reservationIds.push(reserved.reservationId);
    const [hold] = await db
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, reserved.reservationId));
    expect(hold?.estimatedUsd).toBe('0.000001');
    await repository.reconcile(reserved.reservationId, { usd: 0.0000005 });
    const [settled] = await db
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, reserved.reservationId));
    expect(settled?.actualUsd).toBe('0.000001');
  });

  it('separates task storage capacity from the bounded critical task carve-out', async () => {
    const repository = createPostgresCostRepository(db);
    await db
      .update(tasks)
      .set({ budgetUsdLimit: '9999.9999', spentUsd: '9999.999999' })
      .where(eq(tasks.id, taskId));
    const capacity = await repository.reserve({
      source: 'model',
      estimatedUsd: 0.000001,
      taskId,
      critical: true,
      operationId: `capacity:${randomUUID()}`,
    });
    expect(capacity).toMatchObject({
      ok: false,
      reason: 'task ledger storage capacity cannot cover this reservation',
    });
    expect(
      await db.select().from(costReservations).where(eq(costReservations.taskId, taskId)),
    ).toHaveLength(0);

    await db
      .update(tasks)
      .set({ budgetUsdLimit: '0.1000', spentUsd: '0.000000' })
      .where(eq(tasks.id, taskId));
    const allowed = await repository.reserve({
      source: 'model',
      estimatedUsd: 0.105,
      taskId,
      critical: true,
      operationId: `critical:${randomUUID()}`,
    });
    if (!allowed.ok) throw new Error('Fixture failed to use the bounded critical carve-out');
    reservationIds.push(allowed.reservationId);
    const denied = await repository.reserve({
      source: 'model',
      estimatedUsd: 0.006,
      taskId,
      critical: true,
      operationId: `critical-over:${randomUUID()}`,
    });
    expect(denied.ok).toBe(false);
    expect(
      await db.select().from(costReservations).where(eq(costReservations.taskId, taskId)),
    ).toHaveLength(1);
  });

  it('round-trips the numeric(10,6) maximum, accepts replay at the ceiling, and rolls back overflow', async () => {
    const [spendBeforeInvalidDirect] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    await expect(
      recordCostEvent(db, {
        source: 'model',
        usd: 10_000,
        taskId,
        idempotencyKey: `direct-overflow:${randomUUID()}`,
        addToTaskSpend: true,
      }),
    ).rejects.toThrow('numeric(10,6)');
    expect(await db.select().from(costEvents).where(eq(costEvents.taskId, taskId))).toEqual([]);
    const [spendAfterInvalidDirect] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(spendAfterInvalidDirect?.spentUsd).toBe(spendBeforeInvalidDirect?.spentUsd);

    const key = `boundary:${randomUUID()}`;
    const maxInput = {
      source: 'model' as const,
      usd: 9_999.999999,
      taskId,
      idempotencyKey: key,
      addToTaskSpend: true,
    };
    await recordCostEvent(db, maxInput);
    // A duplicate at the task ceiling remains a no-op after the spend preflight.
    await recordCostEvent(db, maxInput);
    const [maxRow] = await db.select().from(costEvents).where(eq(costEvents.idempotencyKey, key));
    expect(maxRow?.usd).toBe('9999.999999');

    const repository = createPostgresCostRepository(db);
    await db.update(tasks).set({ spentUsd: '9999.999998' }).where(eq(tasks.id, taskId));
    const before = await db.select().from(costEvents).where(eq(costEvents.taskId, taskId));
    await expect(
      recordCostEvent(db, {
        source: 'model',
        usd: 0.000002,
        taskId,
        idempotencyKey: `overflow:${randomUUID()}`,
        addToTaskSpend: true,
      }),
    ).rejects.toThrow('numeric(10,6)');
    const after = await db.select().from(costEvents).where(eq(costEvents.taskId, taskId));
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(after).toHaveLength(before.length);
    expect(task?.spentUsd).toBe('9999.999998');
    await expect(repository.reserve({ source: 'model', estimatedUsd: 10_000 })).rejects.toThrow(
      'numeric(10,6)',
    );
  });

  it('expires open holds and keeps unknown model holds in their original budget periods', async () => {
    const repository = createPostgresCostRepository(db);
    const orphan = await repository.reserve({ source: 'model', estimatedUsd: 0.01, taskId });
    const late = await repository.reserve({ source: 'model', estimatedUsd: 0.21, taskId });
    if (!orphan.ok || !late.ok) throw new Error('Fixture failed to reserve');
    const next = { source: 'model' as const, estimatedUsd: 3.8 };
    expect(await repository.reserve(next)).toMatchObject({
      ok: false,
      budget: { scope: 'daily' },
    });
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const priorMonth = new Date(
      Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth() - 1, 15),
    );
    await db
      .update(costReservations)
      .set({ createdAt: priorMonth })
      .where(eq(costReservations.id, orphan.reservationId));
    await db
      .update(costReservations)
      .set({ status: 'dispatching', createdAt: priorMonth, attemptStartedAt: priorMonth })
      .where(eq(costReservations.id, late.reservationId));
    const before = await repository.totals();
    expect(before).toMatchObject({ heldUsd: 0.22, dailyHeldUsd: 0.22, monthlyHeldUsd: 0.22 });
    expect(await repository.releaseStale()).toEqual({ released: 1, markedUnknown: 1 });
    expect(await repository.releaseStale()).toEqual({ released: 0, markedUnknown: 0 });
    expect(await repository.totals()).toMatchObject({
      heldUsd: 0.21,
      dailyHeldUsd: 0,
      monthlyHeldUsd: 0,
      dailySpentUsd: before.dailySpentUsd,
      monthlySpentUsd: before.monthlySpentUsd,
    });
    const accepted = await repository.reserve(next);
    expect(accepted).toMatchObject({ ok: true });
    if (accepted.ok) reservationIds.push(accepted.reservationId);
    await db.update(tasks).set({ budgetUsdLimit: '0.25' }).where(eq(tasks.id, taskId));
    expect(await repository.reserve({ ...next, estimatedUsd: 0.1, taskId })).toMatchObject({
      ok: false,
      budget: { scope: 'task' },
    });
    const actual = {
      usd: 0.15,
      evidence: { basis: 'provider_reported' as const, requestId: 'late-fixture' },
    };
    await Promise.all([
      repository.reconcile(late.reservationId, actual),
      repository.reconcile(late.reservationId, actual),
    ]);
    const events = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.reservationId, late.reservationId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      usd: '0.150000',
      accountedAt: priorMonth,
      evidence: actual.evidence,
    });
    expect(events[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(dayStart.getTime());
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task?.spentUsd).toBe('0.150000');
    expect(await repository.totals()).toMatchObject({
      heldUsd: 3.8,
      dailyHeldUsd: 3.8,
      monthlyHeldUsd: 3.8,
      dailySpentUsd: before.dailySpentUsd,
      monthlySpentUsd: before.monthlySpentUsd,
    });
  });

  it('keeps a dispatched unknown attempt held and reconciles a late actual exactly once', async () => {
    const repository = createPostgresCostRepository(db);
    const reservation = await repository.reserve({ source: 'model', estimatedUsd: 0.2, taskId });
    if (!reservation.ok) throw new Error('Fixture failed to reserve');
    const attempt = {
      provider: 'openrouter',
      model: 'fixture/model',
      role: 'draft',
      requestDigest: 'c'.repeat(64),
      inputTokenEstimate: 400,
      outputTokenLimit: 200,
      reasoning: 'enabled' as const,
    };
    expect(await repository.beginAttempt(reservation.reservationId, attempt)).toBe(true);
    expect(await repository.beginAttempt(reservation.reservationId, attempt)).toBe(false);
    await repository.markAttemptUnknown(reservation.reservationId, 'injected timeout', {
      requestId: 'generation-late',
      endpoint: 'fixture-upstream',
    });
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, taskId));
    const [reservationBeforeInvalid] = await db
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, reservation.reservationId));
    const eventsBeforeInvalid = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.reservationId, reservation.reservationId));
    const [taskBeforeInvalid] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const totalsBeforeInvalid = await repository.totals();
    await expect(repository.reconcile(reservation.reservationId, { usd: 10_000 })).rejects.toThrow(
      'numeric(10,6)',
    );
    expect(
      await db
        .select()
        .from(costReservations)
        .where(eq(costReservations.id, reservation.reservationId)),
    ).toEqual([reservationBeforeInvalid]);
    expect(
      await db
        .select()
        .from(costEvents)
        .where(eq(costEvents.reservationId, reservation.reservationId)),
    ).toEqual(eventsBeforeInvalid);
    const [taskAfterInvalid] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(taskAfterInvalid?.spentUsd).toBe(taskBeforeInvalid?.spentUsd);
    expect(await repository.totals()).toEqual(totalsBeforeInvalid);
    expect((await repository.totals()).heldUsd).toBe(0.2);
    const actual = {
      usd: 0.075,
      evidence: {
        basis: 'provider_reported' as const,
        provider: 'openrouter',
        requestId: 'generation-late',
      },
    };
    await repository.reconcile(reservation.reservationId, actual);
    await repository.reconcile(reservation.reservationId, actual);
    expect((await repository.totals()).heldUsd).toBe(0);
    expect(
      await db
        .select()
        .from(costEvents)
        .where(eq(costEvents.reservationId, reservation.reservationId)),
    ).toHaveLength(1);
    const [row] = await db
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, reservation.reservationId));
    expect(row).toMatchObject({ status: 'reconciled', actualUsd: '0.075000' });
  });
});
