import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreCostRepository } from './costs.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore, seedBudget } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore atomic cost ledger', () => {
  let store: InstallationStore;
  let costs: FirestoreCostRepository;
  let now: Date;
  beforeEach(async () => {
    now = new Date('2026-09-30T23:59:00Z');
    store = emulatorStore(() => now);
    costs = new FirestoreCostRepository(store);
    await seedBudget(store);
  });
  afterEach(async () => {
    await disposeStore(store);
  });

  it('serializes competing reservations and never over-reserves the daily cap', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => costs.reserve({ source: 'model', estimatedUsd: 0.3 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect((await costs.totals()).heldUsd).toBe(0.9);
  }, 30_000);

  it('persists half-micro event and reservation values using the shared rounded ledger value', async () => {
    const eventKey = `half-micro:${randomUUID()}`;
    await costs.record({ source: 'model', usd: 0.0000005, idempotencyKey: eventKey });
    const event = await store
      .collection('costEvents')
      .where('idempotencyKey', '==', eventKey)
      .get();
    expect(event.docs[0]?.get('usd')).toBe('0.000001');
    const reserved = await costs.reserve({
      source: 'model',
      estimatedUsd: 0.0000005,
      operationId: `half-reserve:${randomUUID()}`,
    });
    if (!reserved.ok) throw new Error('Fixture failed to reserve one rounded microdollar');
    expect(
      (await store.doc('costReservations', reserved.reservationId).get()).get('estimatedUsd'),
    ).toBe('0.000001');
    await costs.reconcile(reserved.reservationId, { usd: 0.0000005 });
    expect(
      (await store.doc('costReservations', reserved.reservationId).get()).get('actualUsd'),
    ).toBe('0.000001');
  });

  it('uses the shared numeric(10,6) boundary and rejects task-spend overflow atomically', async () => {
    const key = `boundary:${randomUUID()}`;
    await store.doc('tasks', 'idempotent-max-task').set({
      id: 'idempotent-max-task',
      spentUsd: '0',
      budgetUsdLimit: '9999.9999',
    });
    await store.doc('taskBudgetHolds', 'idempotent-max-task').set({ heldMicros: 0 });

    await store.doc('tasks', 'capacity-task').set({
      id: 'capacity-task',
      spentUsd: '9999.999999',
      budgetUsdLimit: '9999.9999',
    });
    await store.doc('taskBudgetHolds', 'capacity-task').set({ heldMicros: 0 });
    const capacity = await costs.reserve({
      source: 'model',
      estimatedUsd: 0.000001,
      taskId: 'capacity-task',
      critical: true,
      operationId: `capacity:${randomUUID()}`,
    });
    expect(capacity).toMatchObject({
      ok: false,
      reason: 'task ledger storage capacity cannot cover this reservation',
    });
    expect(
      await store.collection('costReservations').where('taskId', '==', 'capacity-task').get(),
    ).toMatchObject({ empty: true });
    const maxTaskInput = {
      source: 'model' as const,
      usd: 9_999.999999,
      taskId: 'idempotent-max-task',
      idempotencyKey: key,
      addToTaskSpend: true,
    };
    await costs.record(maxTaskInput);
    await costs.record(maxTaskInput);
    expect((await store.doc('tasks', 'idempotent-max-task').get()).get('spentUsd')).toBe(
      '9999.999999',
    );
    const maxRows = await store.collection('costEvents').where('idempotencyKey', '==', key).get();
    expect(maxRows.docs).toHaveLength(1);
    expect(maxRows.docs[0]?.get('usd')).toBe('9999.999999');

    await expect(costs.record({ source: 'model', usd: 10_000 })).rejects.toThrow('numeric(10,6)');
    await expect(costs.reserve({ source: 'model', estimatedUsd: 10_000 })).rejects.toThrow(
      'numeric(10,6)',
    );
    await store.doc('tasks', 'overflow-task').set({
      id: 'overflow-task',
      spentUsd: '9999.999998',
      budgetUsdLimit: '9999.9999',
    });
    await store.doc('taskBudgetHolds', 'overflow-task').set({ heldMicros: 0 });
    const priorEvents = await store
      .collection('costEvents')
      .where('taskId', '==', 'overflow-task')
      .get();
    await expect(
      costs.record({
        source: 'model',
        usd: 0.000002,
        taskId: 'overflow-task',
        idempotencyKey: `overflow:${randomUUID()}`,
        addToTaskSpend: true,
      }),
    ).rejects.toThrow('numeric(10,6)');
    const afterEvents = await store
      .collection('costEvents')
      .where('taskId', '==', 'overflow-task')
      .get();
    expect(afterEvents.size).toBe(priorEvents.size);
    expect((await store.doc('tasks', 'overflow-task').get()).get('spentUsd')).toBe('9999.999998');
  });

  it('deduplicates reservation retries and rejects conflicting reuse', async () => {
    const input = { source: 'model' as const, estimatedUsd: 0.1, operationId: 'call/one' };
    const results = await Promise.all([costs.reserve(input), costs.reserve(input)]);
    expect(results[0]).toEqual(results[1]);
    expect((await costs.totals()).heldUsd).toBe(0.1);
    await expect(costs.reserve({ ...input, estimatedUsd: 0.2 })).rejects.toThrow('different work');
    await costs.reconcile('call/one', { usd: 0.08 });
    expect((await costs.reserve(input)).ok).toBe(false);
  });

  it('settles once and commits the task spend with the global ledger', async () => {
    await store.doc('tasks', 'task').set({ id: 'task', spentUsd: '0', budgetUsdLimit: '0.2' });
    const reserved = await costs.reserve({ source: 'model', estimatedUsd: 0.1, taskId: 'task' });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) throw new Error('Fixture failed to reserve');
    await Promise.all([
      costs.reconcile(reserved.reservationId, {
        usd: 0.07,
        evidence: { basis: 'provider_reported', provider: 'openrouter', requestId: 'gen-1' },
      }),
      costs.reconcile(reserved.reservationId, {
        usd: 0.07,
        evidence: { basis: 'provider_reported', provider: 'openrouter', requestId: 'gen-1' },
      }),
    ]);
    expect(await costs.totals()).toMatchObject({
      heldUsd: 0,
      dailySpentUsd: 0.07,
      monthlySpentUsd: 0.07,
    });
    expect((await store.doc('tasks', 'task').get()).get('spentUsd')).toBe('0.070000');
    expect((await store.collection('costEvents').get()).size).toBe(1);
    expect((await store.collection('costEvents').get()).docs[0]?.get('evidence')).toEqual({
      basis: 'provider_reported',
      provider: 'openrouter',
      requestId: 'gen-1',
    });
  });

  it('counts outstanding holds across day/month rollover and settles into the current period', async () => {
    const reserved = await costs.reserve({ source: 'model', estimatedUsd: 0.9 });
    if (!reserved.ok) throw new Error('Fixture failed to reserve');
    now = new Date('2026-10-01T00:01:00Z');
    expect((await costs.reserve({ source: 'model', estimatedUsd: 0.2 })).ok).toBe(false);
    await costs.reconcile(reserved.reservationId, { usd: 0.8 });
    expect(await costs.totals()).toMatchObject({
      heldUsd: 0,
      dailySpentUsd: 0.8,
      monthlySpentUsd: 0.8,
    });
  });

  it('enforces a task cap and bounds the critical-reply allowance', async () => {
    await store.doc('tasks', 'task').set({ spentUsd: '0', budgetUsdLimit: '0.1' });
    expect((await costs.reserve({ source: 'model', estimatedUsd: 0.105, taskId: 'task' })).ok).toBe(
      false,
    );
    expect(
      (
        await costs.reserve({
          source: 'model',
          estimatedUsd: 0.105,
          taskId: 'task',
          critical: true,
        })
      ).ok,
    ).toBe(true);
    expect(
      (await costs.reserve({ source: 'model', estimatedUsd: 0.01, taskId: 'task', critical: true }))
        .ok,
    ).toBe(false);
  });
  it('rejects malformed persisted task caps before creating a reservation', async () => {
    for (const value of ['', '0x10', '1e2', '0.0000001', null]) {
      await store.doc('tasks', 'invalid-cap').set({ spentUsd: '0.000000', budgetUsdLimit: value });
      await expect(
        costs.reserve({ source: 'model', estimatedUsd: 0.1, taskId: 'invalid-cap' }),
      ).rejects.toThrow();
    }
    expect((await costs.totals()).heldUsd).toBe(0);
    expect((await store.collection('costReservations').get()).size).toBe(0);
  });

  it('release and settlement races converge without leaking or double-subtracting holds', async () => {
    const reserved = await costs.reserve({ source: 'embedding', estimatedUsd: 0.2 });
    if (!reserved.ok) throw new Error('Fixture failed to reserve');
    await Promise.all([
      costs.release(reserved.reservationId),
      costs.reconcile(reserved.reservationId, { usd: 0.15 }),
    ]);
    const totals = await costs.totals();
    expect(totals.heldUsd).toBe(0);
    expect([0, 0.15]).toContain(totals.dailySpentUsd);
  });

  it('cleans stale holds once and excludes a recently created hold', async () => {
    await costs.reserve({ source: 'model', estimatedUsd: 0.2 });
    now = new Date(now.getTime() + 121 * 60_000);
    await costs.reserve({ source: 'model', estimatedUsd: 0.1 });
    expect(await costs.releaseStale()).toBe(1);
    expect(await costs.releaseStale()).toBe(0);
    expect((await costs.totals()).heldUsd).toBe(0.1);
  });

  it('retains dispatched unknown usage as a hold and accepts one late actual after timeout', async () => {
    await store
      .doc('tasks', 'terminal-task')
      .set({ id: 'terminal-task', spentUsd: '0', budgetUsdLimit: '1', status: 'done' });
    await store.doc('taskBudgetHolds', 'terminal-task').set({ heldMicros: 0 });
    const reserved = await costs.reserve({
      source: 'model',
      estimatedUsd: 0.4,
      taskId: 'terminal-task',
    });
    if (!reserved.ok) throw new Error('Fixture failed to reserve');
    const metadata = {
      provider: 'openrouter',
      model: 'fixture/model',
      role: 'draft',
      requestDigest: 'a'.repeat(64),
      inputTokenEstimate: 800,
      outputTokenLimit: 400,
      reasoning: 'enabled' as const,
    };
    expect(await costs.beginAttempt(reserved.reservationId, metadata)).toBe(true);
    expect(await costs.beginAttempt(reserved.reservationId, metadata)).toBe(false);
    await costs.markAttemptUnknown(reserved.reservationId, 'injected timeout', {
      requestId: 'generation-late',
    });
    now = new Date(now.getTime() + 121 * 60_000);
    expect(await costs.releaseStale()).toBe(0);
    expect((await costs.totals()).heldUsd).toBe(0.4);
    const reservationRef = store.doc('costReservations', reserved.reservationId);
    const taskRef = store.doc('tasks', 'terminal-task');
    const taskHoldsRef = store.doc('taskBudgetHolds', 'terminal-task');
    const reservationBeforeInvalid = (await reservationRef.get()).data();
    const taskBeforeInvalid = (await taskRef.get()).data();
    const taskHoldsBeforeInvalid = (await taskHoldsRef.get()).data();
    const eventsBeforeInvalid = await store
      .collection('costEvents')
      .where('reservationId', '==', reserved.reservationId)
      .get();
    const periodsBeforeInvalid = await store.collection('budgetPeriods').get();
    const totalsBeforeInvalid = await costs.totals();
    await expect(costs.reconcile(reserved.reservationId, { usd: 10_000 })).rejects.toThrow(
      'numeric(10,6)',
    );
    expect((await reservationRef.get()).data()).toEqual(reservationBeforeInvalid);
    expect((await taskRef.get()).data()).toEqual(taskBeforeInvalid);
    expect((await taskHoldsRef.get()).data()).toEqual(taskHoldsBeforeInvalid);
    const eventsAfterInvalid = await store
      .collection('costEvents')
      .where('reservationId', '==', reserved.reservationId)
      .get();
    expect(eventsAfterInvalid.docs.map((doc) => doc.data())).toEqual(
      eventsBeforeInvalid.docs.map((doc) => doc.data()),
    );
    const periodsAfterInvalid = await store.collection('budgetPeriods').get();
    expect(
      periodsAfterInvalid.docs
        .map((doc) => ({ id: doc.id, data: doc.data() }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(
      periodsBeforeInvalid.docs
        .map((doc) => ({ id: doc.id, data: doc.data() }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(await costs.totals()).toEqual(totalsBeforeInvalid);
    await costs.reconcile(reserved.reservationId, {
      usd: 0.17,
      evidence: {
        basis: 'provider_reported',
        provider: 'openrouter',
        requestId: 'generation-late',
      },
    });
    await costs.reconcile(reserved.reservationId, { usd: 0.17 });
    expect((await costs.totals()).heldUsd).toBe(0);
    expect((await costs.totals()).dailySpentUsd).toBe(0.17);
    expect((await store.collection('costEvents').get()).size).toBe(1);
    expect(
      (await store.doc('costReservations', reserved.reservationId).get()).get('attemptMetadata'),
    ).toMatchObject({
      requestId: 'generation-late',
    });
  });

  it('moves a stale dispatch into unknown instead of releasing its estimate', async () => {
    const reserved = await costs.reserve({ source: 'model', estimatedUsd: 0.25 });
    if (!reserved.ok) throw new Error('Fixture failed to reserve');
    await costs.beginAttempt(reserved.reservationId, {
      provider: 'openrouter',
      model: 'fixture/model',
      role: 'draft',
      requestDigest: 'b'.repeat(64),
      inputTokenEstimate: 100,
      outputTokenLimit: 100,
      reasoning: 'unknown',
    });
    now = new Date(now.getTime() + 121 * 60_000);
    expect(await costs.releaseStale()).toBe(1);
    expect((await store.doc('costReservations', reserved.reservationId).get()).get('status')).toBe(
      'unknown',
    );
    expect((await costs.totals()).heldUsd).toBe(0.25);
  });

  it('fails closed without budget configuration and rejects invalid values', async () => {
    await store.doc('coordination', 'budget-policy').delete();
    await expect(costs.reserve({ source: 'model', estimatedUsd: 0.1 })).rejects.toThrow(
      'not been initialized',
    );
    await expect(costs.reserve({ source: 'model', estimatedUsd: NaN })).rejects.toThrow();
    await expect(costs.reserve({ source: 'model', estimatedUsd: 0.0000001 })).rejects.toThrow();
  });
});
