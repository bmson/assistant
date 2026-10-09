import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresCostRepository, recordCostEvent } from './cost-repository.js';
import { agents, costEvents, costReservations, tasks } from './schema.js';
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
