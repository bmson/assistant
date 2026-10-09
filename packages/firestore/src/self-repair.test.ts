import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreSelfRepairRepository } from './self-repair.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore repair ledger', () => {
  let store: InstallationStore;
  const agentId = randomUUID();
  let repository: FirestoreSelfRepairRepository;
  beforeEach(async () => {
    store = emulatorStore();
    repository = new FirestoreSelfRepairRepository(store, agentId);
    await store.doc('agents', agentId).set({ id: agentId });
  });
  afterEach(async () => disposeStore(store));
  const input = {
    fingerprint: 'same',
    source: 'feedback' as const,
    title: 'Synthetic failure',
    summary: 'Reproduce it',
  };
  it('deduplicates concurrent reports and serializes owner claims', async () => {
    const [a, b] = await Promise.all([
      repository.report(agentId, input),
      repository.report(agentId, input),
    ]);
    expect(a.id).toBe(b.id);
    await repository.report(agentId, { ...input, fingerprint: 'two' });
    const now = new Date();
    const claims = await Promise.all([
      repository.claim(agentId, now, 2),
      repository.claim(agentId, now, 2),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    const next = await repository.update(
      claim,
      'fixing',
      {
        dispatchedAt: now.toISOString(),
        workerProvider: 'openai_hosted',
        hostedSessionId: 'sess_saved',
        hostedTurnId: 'turn_saved',
        hostedCleanupPending: true,
      },
      now,
    );
    expect(next).not.toBeNull();
    expect((await repository.list(agentId)).find((row) => row.id === claim.id)?.data).toMatchObject(
      {
        workerProvider: 'openai_hosted',
        hostedSessionId: 'sess_saved',
        hostedTurnId: 'turn_saved',
        hostedCleanupPending: true,
      },
    );
    expect(await repository.update(claim, 'failed', {}, now)).toBeNull();
    await repository.update(next!, 'failed', {}, now);
    expect(
      (await repository.list(agentId)).find((record) => record.id === claim.id)?.data.outcome,
    ).toMatchObject({ status: 'failed', stage: 'coding_dispatch' });
    expect(await repository.claim(agentId, now, 1)).toBeNull();
  });
  it('claims a new report before an older retried report', async () => {
    const first = await repository.report(agentId, { ...input, fingerprint: 'first' });
    const newer = await repository.report(agentId, { ...input, fingerprint: 'newer' });
    const blocked = await repository.update(first, 'blocked', {}, new Date());
    if (!blocked) throw new Error('Fixture update failed');
    await repository.update(blocked, 'reported', {}, new Date(Date.now() + 1000));
    expect((await repository.claim(agentId, new Date(Date.now() + 2000), 2))?.id).toBe(newer.id);
  });
  it('resumes an eligible retry after repository recreation and reports durable usage conservatively', async () => {
    const issue = await repository.report(agentId, { ...input, fingerprint: 'retry' });
    const eligibleAt = new Date(Date.now() + 60_000);
    const queued = await repository.update(
      issue,
      'reported',
      { nextEligibleAt: eligibleAt.toISOString(), preDispatchRetryCount: 1 },
      new Date(),
    );
    if (!queued) throw new Error('Missing queued retry');
    const afterRestart = new FirestoreSelfRepairRepository(store, agentId);
    expect(await afterRestart.claim(agentId, new Date(), 2)).toBeNull();
    const taskId = randomUUID();
    await store.doc('tasks', taskId).set({ id: taskId, agentId });
    const claimed = await new FirestoreSelfRepairRepository(store, agentId).claim(
      agentId,
      eligibleAt,
      2,
      taskId,
    );
    if (!claimed) throw new Error('Retry claim was not restored');
    expect(claimed).toMatchObject({
      id: issue.id,
      status: 'investigating',
      data: { investigationTaskIds: [taskId], investigationStartedAt: eligibleAt.toISOString() },
    });
    await store.doc('modelCalls', randomUUID()).set({
      id: randomUUID(),
      agentId,
      taskId,
      createdAt: eligibleAt,
      costUsd: '0.012345',
    });
    await store.doc('costReservations', randomUUID()).set({
      agentId,
      taskId,
      status: 'unknown',
    });
    const accounting = await afterRestart.modelAccounting(
      agentId,
      claimed.data.investigationTaskIds ?? [],
      eligibleAt,
    );
    expect(accounting).toEqual({
      observedModelCalls: 1,
      knownCostUsd: '0.012345',
      unresolvedReservations: 1,
      complete: false,
    });
  });
  it('consumes a manual allowance once while preserving concurrent active-work exclusion', async () => {
    const issue = await repository.report(agentId, input);
    await repository.update(
      issue,
      'reported',
      { manualRunRequestedAt: new Date().toISOString() },
      new Date(),
    );
    const claims = await Promise.all([
      repository.claim(agentId, new Date(), 0),
      repository.claim(agentId, new Date(), 0),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed = claims.find(Boolean);
    if (!claimed) throw new Error('Missing manual claim');
    expect(claimed.data.manualRunRequestedAt).toBeUndefined();
    expect(claimed.data.manualRunStartedAt).toEqual(expect.any(String));
    await repository.update(claimed, 'failed', {}, new Date());
    const failed = (await repository.list(agentId))[0];
    if (!failed) throw new Error('Missing failed issue');
    await repository.update(failed, 'reported', {}, new Date());
    expect(await repository.claim(agentId, new Date(), 0)).toBeNull();
  });
  it('refuses foreign evidence, owner scope changes, and erasure writes', async () => {
    const task = randomUUID();
    await store.doc('tasks', task).set({ id: task, agentId: 'other' });
    await expect(repository.report(agentId, { ...input, sourceTaskId: task })).rejects.toThrow(
      'outside the owner',
    );
    await expect(repository.report('other', input)).rejects.toThrow('outside the configured owner');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'running' });
    await expect(repository.report(agentId, input)).rejects.toThrow();
    await expect(repository.list(agentId)).rejects.toThrow('Privacy erasure');
    await expect(repository.failures(agentId, new Date(0))).rejects.toThrow('Privacy erasure');
  });
});
