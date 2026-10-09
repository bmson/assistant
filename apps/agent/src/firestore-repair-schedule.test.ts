import { randomUUID } from 'node:crypto';
import { runDueSchedules } from '@assistant/core/workflow/schedules';
import { runRepairCycle } from '@assistant/core/workflow/self-repair';
import {
  FirestoreScheduleRepository,
  FirestoreSelfRepairRepository,
  type InstallationStore,
} from '@assistant/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { ensureRepairSchedule } from './repair-schedule.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('repair schedule provisioning', () => {
  let store: InstallationStore;
  const agentId = randomUUID();
  beforeEach(async () => {
    store = emulatorStore();
    await store.doc('agents', agentId).set({ id: agentId });
  });
  afterEach(async () => disposeStore(store));
  it('creates one schedule under concurrent sweeps and preserves owner disablement', async () => {
    await Promise.all([ensureRepairSchedule(store, agentId), ensureRepairSchedule(store, agentId)]);
    const rows = await store.collection('schedules').where('agentId', '==', agentId).get();
    expect(rows.size).toBe(1);
    const row = rows.docs[0];
    if (!row) throw new Error('Missing repair schedule');
    expect(row.get('taskTemplate.job')).toBe('self.repair');
    await row.ref.update({ enabled: false });
    await ensureRepairSchedule(store, agentId);
    expect((await row.ref.get()).get('enabled')).toBe(false);
  }, 30_000);
  it('wakes new reports and retries atomically, and preserves a disabled schedule', async () => {
    await ensureRepairSchedule(store, agentId);
    const row = (await store.collection('schedules').where('agentId', '==', agentId).get()).docs[0];
    if (!row) throw new Error('Missing schedule');
    const later = new Date(Date.now() + 3600000);
    await row.ref.update({ nextRunAt: later });
    const repairs = new FirestoreSelfRepairRepository(store, agentId);
    const report = {
      fingerprint: 'wake',
      source: 'feedback' as const,
      title: 'Synthetic failure',
      summary: 'Expected a working flow',
    };
    const issue = await repairs.report(agentId, report);
    expect((await row.ref.get()).get('nextRunAt').toMillis()).toBeLessThan(later.getTime());
    const fired = await runDueSchedules(
      new FirestoreScheduleRepository(store),
      'America/Los_Angeles',
      { isJobEnabled: () => true },
    );
    expect(fired).toHaveLength(1);
    const firing = fired[0];
    if (!firing) throw new Error('Missing firing');
    const task = await store.doc('tasks', firing.taskId).get();
    expect(task.get('trigger.payload.job')).toBe('self.repair');
    const wakes = await store.collection('outbox').where('taskId', '==', firing.taskId).get();
    expect(wakes.size).toBe(1);
    const blocked = await repairs.update(issue, 'blocked', {}, new Date());
    await row.ref.update({ nextRunAt: later });
    if (!blocked) throw new Error('Missing blocked issue');
    await repairs.update(blocked, 'reported', {}, new Date());
    expect((await row.ref.get()).get('nextRunAt').toMillis()).toBeLessThan(later.getTime());
    await row.ref.update({ enabled: false, nextRunAt: later });
    await repairs.report(agentId, { ...report, fingerprint: 'disabled' });
    expect((await row.ref.get()).get('nextRunAt').toMillis()).toBe(later.getTime());
  });
  it('sets a bounded transient retry wake to its persisted eligibility time', async () => {
    await ensureRepairSchedule(store, agentId);
    const schedule = (await store.collection('schedules').where('agentId', '==', agentId).get())
      .docs[0];
    if (!schedule) throw new Error('Missing schedule');
    const repairs = new FirestoreSelfRepairRepository(store, agentId);
    const issue = await repairs.report(agentId, {
      fingerprint: 'transient-retry',
      source: 'failure',
      title: 'Synthetic provider outage',
      summary: 'Bounded retry fixture',
    });
    const eligibleAt = new Date(Date.now() + 120_000);
    await repairs.update(
      issue,
      'reported',
      {
        preDispatchRetryCount: 1,
        nextEligibleAt: eligibleAt.toISOString(),
        lastError: 'Temporary provider outage',
      },
      new Date(),
    );
    expect((await schedule.ref.get()).get('nextRunAt').toMillis()).toBe(eligibleAt.getTime());
    expect(await repairs.claim(agentId, new Date(), 2)).toBeNull();
    expect((await new FirestoreSelfRepairRepository(store, agentId).list(agentId))[0]?.status).toBe(
      'reported',
    );
  });
  it('recovers a pre-dispatch provider outage from persisted state with a fresh repository', async () => {
    await ensureRepairSchedule(store, agentId);
    const repairs = new FirestoreSelfRepairRepository(store, agentId);
    const issue = await repairs.report(agentId, {
      fingerprint: 'composed-transient-recovery',
      source: 'failure',
      title: 'Synthetic model outage',
      summary: 'Recover before any coding dispatch',
    });
    const taskA = randomUUID();
    const taskB = randomUUID();
    await store.doc('tasks', taskA).set({ id: taskA, agentId });
    await store.doc('tasks', taskB).set({ id: taskB, agentId });
    const object = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('temporary upstream outage'), {
          name: 'AI_APICallError',
          statusCode: 503,
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        modelId: 'test/offline',
        degraded: false,
        object: {
          category: 'bug',
          diagnosis: 'The synthetic issue is reproducible',
          targetPaths: ['packages/core/src/chat.ts'],
          reproduction: 'Run the deterministic example',
          acceptance: 'The example should complete once',
        },
      });
    const dispatch = vi.fn(async () => {});
    const deps = (repository: FirestoreSelfRepairRepository) => ({
      repository,
      audit: { task: vi.fn(async () => null), read: vi.fn(async () => []) },
      router: { object, route: vi.fn() } as never,
      worker: {
        dispatch,
        inspect: vi.fn(async () => null),
        deployed: vi.fn(async () => false),
      },
      enabled: true,
      allowExecutor: false,
      dailyLimit: 2,
      notify: vi.fn(async () => {}),
    });
    const at = store.now();
    expect(await runRepairCycle(deps(repairs), agentId, taskA, at)).toBe(0);
    const transient = (await new FirestoreSelfRepairRepository(store, agentId).list(agentId)).find(
      (row) => row.id === issue.id,
    );
    expect(transient).toMatchObject({
      status: 'reported',
      data: {
        preDispatchRetryCount: 1,
        investigationTaskIds: [taskA],
        routerAttempts: [expect.objectContaining({ classification: 'transient' })],
      },
    });
    expect(dispatch).not.toHaveBeenCalled();
    const eligibleAt = new Date(transient?.data.nextEligibleAt ?? '');
    expect(eligibleAt.getTime()).toBe(at.getTime() + 60_000);
    expect(
      await runRepairCycle(
        deps(new FirestoreSelfRepairRepository(store, agentId)),
        agentId,
        taskB,
        at,
      ),
    ).toBe(0);
    expect(object).toHaveBeenCalledOnce();
    expect(
      await runRepairCycle(
        deps(new FirestoreSelfRepairRepository(store, agentId)),
        agentId,
        taskB,
        eligibleAt,
      ),
    ).toBe(1);
    const recovered = (await new FirestoreSelfRepairRepository(store, agentId).list(agentId)).find(
      (row) => row.id === issue.id,
    );
    expect(recovered).toMatchObject({
      status: 'fixing',
      data: { investigationTaskIds: [taskA, taskB], preDispatchRetryCount: 1 },
    });
    expect(object).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it('recovers waiting work immediately after the rolling allowance returns', async () => {
    await ensureRepairSchedule(store, agentId);
    const schedule = (await store.collection('schedules').where('agentId', '==', agentId).get())
      .docs[0];
    if (!schedule) throw new Error('Missing schedule');
    const repairs = new FirestoreSelfRepairRepository(store, agentId);
    const report = {
      fingerprint: 'used',
      source: 'feedback' as const,
      title: 'Synthetic failure',
      summary: 'Expected a working flow',
    };
    const issue = await repairs.report(agentId, report);
    const dispatched = await repairs.update(issue, 'fixing', {}, new Date());
    if (!dispatched) throw new Error('Missing dispatch');
    await repairs.update(dispatched, 'failed', {}, new Date());
    await repairs.report(agentId, { ...report, fingerprint: 'waiting' });
    const later = new Date(Date.now() + 3600000);
    await schedule.ref.update({ nextRunAt: later });
    await ensureRepairSchedule(store, agentId, 1);
    expect((await schedule.ref.get()).get('nextRunAt').toMillis()).toBeGreaterThan(later.getTime());
    const saved = await store.doc('selfRepairIssues', issue.id).get();
    const data = saved.get('data');
    data.history.find((event: { status: string }) => event.status === 'fixing').at = new Date(
      Date.now() - 86400001,
    ).toISOString();
    await saved.ref.update({ data });
    await ensureRepairSchedule(store, agentId, 1);
    expect((await schedule.ref.get()).get('nextRunAt').toMillis()).toBeLessThan(later.getTime());
    expect((await repairs.claim(agentId, new Date(), 1))?.fingerprint).toBe('waiting');
  });
  it('refuses missing owners and active erasure fences', async () => {
    await expect(ensureRepairSchedule(store, randomUUID())).rejects.toThrow('owner is missing');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(ensureRepairSchedule(store, agentId)).rejects.toThrow('Privacy erasure');
  });
  it.each(['fixing', 'testing', 'pr_open', 'merged'] as const)(
    'reconciles %s on the next minute check even with no daily allowance',
    async (status) => {
      await ensureRepairSchedule(store, agentId);
      const schedule = (await store.collection('schedules').where('agentId', '==', agentId).get())
        .docs[0];
      if (!schedule) throw new Error('Missing schedule');
      const repairs = new FirestoreSelfRepairRepository(store, agentId);
      const issue = await repairs.report(agentId, {
        fingerprint: 'active',
        source: 'feedback',
        title: 'Synthetic work',
        summary: 'Expected behavior',
      });
      await repairs.update(issue, status, {}, new Date());
      const later = new Date(Date.now() + 3600000);
      await schedule.ref.update({ nextRunAt: later });
      await ensureRepairSchedule(store, agentId, 0);
      expect((await schedule.ref.get()).get('nextRunAt').toMillis()).toBeLessThan(later.getTime());
      expect(await repairs.claim(agentId, new Date(), 0)).toBeNull();
    },
  );
});
