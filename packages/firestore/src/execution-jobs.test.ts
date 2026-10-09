import type { TaskLease } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreExecutionJobRepository } from './execution-jobs.js';
import { decodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const HASH = 'b'.repeat(64);
const SENTINEL = {
  pending: 'document_job_pending',
  callbackToken: HASH,
  timeoutAt: '2026-09-12T12:05:00.000Z',
  executionName: 'documents/task/job',
};

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore execution job repository', () => {
  let now: Date;
  let store: InstallationStore;
  let repository: FirestoreExecutionJobRepository;

  beforeEach(() => {
    now = new Date('2026-09-12T12:00:00.000Z');
    store = emulatorStore(() => now);
    repository = new FirestoreExecutionJobRepository(store);
  });

  afterEach(async () => disposeStore(store));

  function callbackInput(taskId: string, payloadDigest = 'c'.repeat(64)) {
    return {
      taskId,
      result: { ok: true, output: 'callback result' },
      files: [{ workspacePath: 'callback.txt', mime: 'text/plain' }],
      idempotencyKey: `job-callback:${taskId}`,
      tokenHash: 'a'.repeat(64),
      payloadDigest,
    };
  }

  function acceptToolCall(toolCallId: string) {
    return (task: Record<string, unknown> | null) =>
      task
        ? { accept: true as const, toolCallId }
        : { accept: false as const, status: 404 as const, error: 'missing task' };
  }

  async function seed(
    input: { taskId?: string; toolId?: string; token?: string; result?: unknown } = {},
  ) {
    const taskId = input.taskId ?? 'task';
    const toolId = input.toolId ?? 'tool';
    const token = input.token ?? 'lease-token';
    await store.doc('tasks', taskId).set({
      id: taskId,
      agentId: 'owner',
      type: 'chat_turn',
      trust: 'owner',
      status: 'running',
      state: { before: true },
      attempt: 3,
      reclaimCount: 2,
      leaseToken: token,
      lockedUntil: new Date(now.getTime() + 10 * 60_000),
    });
    await store.doc('toolCalls', toolId).set({
      id: toolId,
      taskId,
      step: 1,
      toolName: 'document.process',
      risk: 'autonomous',
      status: 'executing',
      args: {},
      result: input.result ?? null,
      startedAt: new Date('2026-09-12T11:59:00.000Z'),
      decision: { reservationId: `reservation-${toolId}` },
      createdAt: new Date('2026-09-12T11:58:00.000Z'),
      error: null,
      approvalId: null,
      idempotencyKey: null,
      finishedAt: null,
    });
    return {
      taskId,
      toolId,
      lease: {
        id: taskId,
        agentId: 'owner',
        status: 'running',
        leaseToken: token,
        lockedUntil: new Date(now.getTime() + 10 * 60_000),
      } as TaskLease,
    };
  }

  it('atomically stages and clears the complete hashed sentinel and checkpoint', async () => {
    const { taskId, toolId, lease } = await seed();
    await repository.stage(
      { taskId, toolCallId: toolId, pending: SENTINEL, checkpointState: { pendingJob: 'staged' } },
      lease,
    );
    let task = decodeRecord<Record<string, unknown>>(
      (await store.doc('tasks', taskId).get()).data(),
    );
    let tool = decodeRecord<Record<string, unknown>>(
      (await store.doc('toolCalls', toolId).get()).data(),
    );
    expect(tool.result).toEqual(SENTINEL);
    expect(task).toMatchObject({
      state: { pendingJob: 'staged' },
      attempt: 0,
      reclaimCount: 0,
      updatedAt: now,
    });

    await repository.clear(
      { taskId, toolCallId: toolId, pending: SENTINEL, checkpointState: { pendingJob: null } },
      lease,
    );
    task = decodeRecord<Record<string, unknown>>((await store.doc('tasks', taskId).get()).data());
    tool = decodeRecord<Record<string, unknown>>(
      (await store.doc('toolCalls', toolId).get()).data(),
    );
    expect(tool.result).toBeNull();
    expect(task.state).toEqual({ pendingJob: null });
  });

  it('fences expired and reclaimed leases with no partial write', async () => {
    const seeded = await seed();
    now = new Date('2026-09-12T12:11:00.000Z');
    await expect(
      repository.stage(
        {
          taskId: seeded.taskId,
          toolCallId: seeded.toolId,
          pending: SENTINEL,
          checkpointState: { stale: true },
        },
        seeded.lease,
      ),
    ).rejects.toThrow('task lease lost');
    await store.doc('tasks', seeded.taskId).update({
      leaseToken: 'replacement-token',
      lockedUntil: new Date(now.getTime() + 10 * 60_000),
    });
    await expect(
      repository.stage(
        {
          taskId: seeded.taskId,
          toolCallId: seeded.toolId,
          pending: SENTINEL,
          checkpointState: { stale: true },
        },
        seeded.lease,
      ),
    ).rejects.toThrow('task lease lost');
    const toolBeforeReclaim = decodeRecord<Record<string, unknown>>(
      (await store.doc('toolCalls', seeded.toolId).get()).data(),
    );
    expect(toolBeforeReclaim.result).toBeNull();

    const freshLease = {
      ...seeded.lease,
      leaseToken: 'replacement-token',
      lockedUntil: new Date(now.getTime() + 10 * 60_000),
    };
    await repository.stage(
      {
        taskId: seeded.taskId,
        toolCallId: seeded.toolId,
        pending: SENTINEL,
        checkpointState: { reclaimed: true },
      },
      freshLease,
    );
    await store.doc('tasks', seeded.taskId).update({ leaseToken: 'second-replacement-token' });
    await expect(
      repository.settle(
        { taskId: seeded.taskId, toolCallId: seeded.toolId, timeoutAt: new Date(0) },
        freshLease,
      ),
    ).resolves.toEqual({ kind: 'stale' });
    await expect(
      repository.loadToolCall('owner', seeded.taskId, seeded.toolId),
    ).resolves.toMatchObject({ result: SENTINEL });
  });

  it('rejects empty-token and cross-agent/task access', async () => {
    const owned = await seed();
    await seed({ taskId: 'foreign-task', toolId: 'foreign-tool', token: 'foreign-token' });
    await store.doc('approvals', 'approval').set({
      id: 'approval',
      taskId: owned.taskId,
      toolCallId: owned.toolId,
      status: 'approved',
      requestedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });

    await expect(
      repository.loadToolCall('other-owner', owned.taskId, owned.toolId),
    ).resolves.toBeNull();
    await expect(
      repository.loadToolCall('owner', 'foreign-task', owned.toolId),
    ).resolves.toBeNull();
    await expect(
      repository.stage(
        {
          taskId: owned.taskId,
          toolCallId: 'foreign-tool',
          pending: SENTINEL,
          checkpointState: { foreignWrite: true },
        },
        owned.lease,
      ),
    ).rejects.toThrow('cannot be staged');
    await expect(
      repository.loadToolCall('owner', 'foreign-task', 'foreign-tool'),
    ).resolves.toMatchObject({ result: null });
    await expect(
      repository.listPendingApprovals('owner', owned.taskId, ['approval']),
    ).resolves.toEqual([expect.objectContaining({ id: 'approval', status: 'approved' })]);
    await expect(
      repository.listPendingApprovals('owner', 'foreign-task', ['approval']),
    ).resolves.toEqual([]);
    await expect(
      repository.stage(
        { taskId: owned.taskId, toolCallId: owned.toolId, pending: SENTINEL, checkpointState: {} },
        { ...owned.lease, leaseToken: '' },
      ),
    ).rejects.toThrow('task lease lost');
  });

  it('lets the callback result win timeout and decodes cost metadata timestamps', async () => {
    const seeded = await seed({ result: SENTINEL });
    const finishedAt = new Date('2026-09-12T12:00:30.000Z');
    await store.doc('toolCalls', seeded.toolId).update({
      status: 'succeeded',
      result: { ok: true, output: 'callback result' },
      finishedAt,
    });
    now = new Date('2026-09-12T12:06:00.000Z');

    const settled = await repository.settle(
      { taskId: seeded.taskId, toolCallId: seeded.toolId, timeoutAt: new Date(0) },
      seeded.lease,
    );
    expect(settled).toEqual({
      kind: 'result',
      id: seeded.toolId,
      result: { ok: true, output: 'callback result' },
      startedAt: new Date('2026-09-12T11:59:00.000Z'),
      decision: { reservationId: `reservation-${seeded.toolId}` },
    });
    expect(
      (await repository.loadToolCall('owner', seeded.taskId, seeded.toolId))?.finishedAt,
    ).toEqual(finishedAt);
  });

  it('does not let clear or a repeated stage overwrite a callback result', async () => {
    const seeded = await seed({ result: SENTINEL });
    const callbackResult = { ok: true, output: 'arrived before launch cleanup' };
    await store.doc('toolCalls', seeded.toolId).update({ result: callbackResult });
    const input = {
      taskId: seeded.taskId,
      toolCallId: seeded.toolId,
      pending: SENTINEL,
      checkpointState: { mustNotPersist: true },
    };

    await expect(repository.clear(input, seeded.lease)).rejects.toThrow('cannot be cleared');
    await expect(repository.stage(input, seeded.lease)).rejects.toThrow('cannot be staged');
    await expect(
      repository.loadToolCall('owner', seeded.taskId, seeded.toolId),
    ).resolves.toMatchObject({
      result: callbackResult,
    });
    const task = decodeRecord<Record<string, unknown>>(
      (await store.doc('tasks', seeded.taskId).get()).data(),
    );
    expect(task.state).toEqual({ before: true });
  });

  it('records one callback receipt and rejects conflicting replay content', async () => {
    const seeded = await seed({ result: SENTINEL });
    await store.doc('tasks', seeded.taskId).update({ queueGeneration: 0 });
    const input = callbackInput(seeded.taskId);
    const first = await repository.recordCallback(input, acceptToolCall(seeded.toolId));
    expect(first).toMatchObject({ ok: true, taskId: seeded.taskId, queueGeneration: 1 });

    const replay = await repository.recordCallback(input, () => {
      throw new Error('a callback receipt must replay before consumed-state validation');
    });
    expect(replay).toMatchObject({ ok: true, replayed: true, queueGeneration: 1 });
    const conflict = await repository.recordCallback(
      callbackInput(seeded.taskId, 'd'.repeat(64)),
      acceptToolCall(seeded.toolId),
    );
    expect(conflict).toMatchObject({ ok: false, status: 409 });

    const tool = decodeRecord<Record<string, unknown>>(
      (await store.doc('toolCalls', seeded.toolId).get()).data(),
    );
    expect(tool.result).toEqual(input.result);
    expect((await store.collection('files').where('taskId', '==', seeded.taskId).get()).size).toBe(
      1,
    );
    expect(
      (
        await store
          .collection('executionJobCallbackReceipts')
          .where('taskId', '==', seeded.taskId)
          .get()
      ).size,
    ).toBe(1);
  });

  it('rejects a late callback for a terminal task without changing its result or files', async () => {
    const seeded = await seed({ result: SENTINEL });
    await store.doc('tasks', seeded.taskId).update({ queueGeneration: 0 });
    const timeoutResult = { ok: false, error: 'timed out' };
    await store.doc('tasks', seeded.taskId).update({ status: 'needs_attention' });
    await store.doc('toolCalls', seeded.toolId).update({
      status: 'failed',
      result: timeoutResult,
    });

    const outcome = await repository.recordCallback(
      callbackInput(seeded.taskId),
      acceptToolCall(seeded.toolId),
    );

    expect(outcome).toMatchObject({ ok: false, status: 409 });
    const task = decodeRecord<Record<string, unknown>>(
      (await store.doc('tasks', seeded.taskId).get()).data(),
    );
    const tool = decodeRecord<Record<string, unknown>>(
      (await store.doc('toolCalls', seeded.toolId).get()).data(),
    );
    expect(task.status).toBe('needs_attention');
    expect(tool).toMatchObject({ status: 'failed', result: timeoutResult });
    expect((await store.collection('files').where('taskId', '==', seeded.taskId).get()).size).toBe(
      0,
    );
    expect(
      (
        await store
          .collection('executionJobCallbackReceipts')
          .where('taskId', '==', seeded.taskId)
          .get()
      ).size,
    ).toBe(0);
  });

  it('uses the store clock to distinguish pending from timed out and returns reservation metadata', async () => {
    const seeded = await seed({ result: SENTINEL });
    // Dispatch records a successful launch as succeeded while retaining the
    // sentinel until the callback replaces it with the terminal result.
    await store.doc('toolCalls', seeded.toolId).update({ status: 'succeeded' });
    await expect(
      repository.settle(
        {
          taskId: seeded.taskId,
          toolCallId: seeded.toolId,
          timeoutAt: new Date('2026-09-12T12:05:00.000Z'),
        },
        seeded.lease,
      ),
    ).resolves.toEqual({ kind: 'still_pending' });
    now = new Date('2026-09-12T12:06:00.000Z');
    const settled = await repository.settle(
      {
        taskId: seeded.taskId,
        toolCallId: seeded.toolId,
        timeoutAt: new Date('2026-09-12T12:05:00.000Z'),
      },
      seeded.lease,
    );
    expect(settled).toMatchObject({
      kind: 'timeout',
      id: seeded.toolId,
      startedAt: new Date('2026-09-12T11:59:00.000Z'),
      decision: { reservationId: `reservation-${seeded.toolId}` },
      failure: { ok: false },
    });
    const tool = await repository.loadToolCall('owner', seeded.taskId, seeded.toolId);
    expect(tool).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('timed out'),
      finishedAt: now,
    });
  });
});
