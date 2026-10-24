import {
  approvalPolicyFingerprint,
  type PhoneCalendarSnapshotInput,
  readPhoneCalendars,
} from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreApprovalPolicyRepository } from './approval-policies.js';
import { FirestoreApprovalRepository } from './approvals.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';
import { FirestoreToolExecutionRepository } from './tool-execution.js';

type TxCallback = (transaction: object) => Promise<unknown>;
type TxRunner = (callback: TxCallback, options?: unknown) => Promise<unknown>;

function transactionBarrier(
  source: InstallationStore,
  ownerId: string,
  input: {
    holdAfter: 'owner-update' | 'tool-call-create';
    reached: () => void;
    release: Promise<void>;
    ownerRead?: () => void;
  },
): InstallationStore {
  const ownerPath = source.doc('agents', ownerId).path;
  const delayedDb = new Proxy(source.db, {
    get(target, property) {
      if (property !== 'runTransaction') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const run = target.runTransaction.bind(target) as unknown as TxRunner;
      return (callback: TxCallback, options?: unknown) =>
        run(async (rawTransaction) => {
          let wroteOwner = false;
          let createdToolCall = false;
          const transaction = new Proxy(rawTransaction, {
            get(txTarget, txProperty) {
              const value = Reflect.get(txTarget, txProperty, txTarget);
              if (txProperty === 'get' && typeof value === 'function') {
                const get = value.bind(txTarget) as (...args: unknown[]) => Promise<unknown>;
                return async (...args: unknown[]) => {
                  const ref = args[0] as { path?: unknown } | undefined;
                  if (ref?.path === ownerPath) input.ownerRead?.();
                  return get(...args);
                };
              }
              if (txProperty === 'update' && typeof value === 'function') {
                const update = value.bind(txTarget) as (...args: unknown[]) => unknown;
                return (...args: unknown[]) => {
                  const ref = args[0] as { path?: unknown } | undefined;
                  const result = update(...args);
                  if (ref?.path === ownerPath) wroteOwner = true;
                  return result;
                };
              }
              if (txProperty === 'create' && typeof value === 'function') {
                const create = value.bind(txTarget) as (...args: unknown[]) => unknown;
                return (...args: unknown[]) => {
                  const ref = args[0] as { path?: unknown } | undefined;
                  const result = create(...args);
                  if (typeof ref?.path === 'string' && /\/toolCalls\//.test(ref.path))
                    createdToolCall = true;
                  return result;
                };
              }
              return typeof value === 'function' ? value.bind(txTarget) : value;
            },
          });
          const result = await callback(transaction);
          const shouldHold = input.holdAfter === 'owner-update' ? wroteOwner : createdToolCall;
          if (shouldHold) {
            input.reached();
            await input.release;
          }
          return result;
        }, options);
    },
  }) as InstallationStore['db'];
  return new Proxy(source, {
    get(target, property) {
      if (property === 'db') return delayedDb;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as InstallationStore;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitBounded(promise: Promise<void>, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore tool execution repository', () => {
  let store: InstallationStore;
  let repository: FirestoreToolExecutionRepository;

  beforeEach(async () => {
    store = emulatorStore(() => new Date('2026-09-12T12:00:00Z'));
    repository = new FirestoreToolExecutionRepository(store);
    await store.doc('agents', 'owner').set({ id: 'owner' });
    await store.doc('tasks', 'task').set({
      id: 'task',
      agentId: 'owner',
      type: 'chat_turn',
      status: 'waiting_approval',
      trust: 'owner',
    });
    await store.doc('toolCalls', 'tool').set({
      id: 'tool',
      taskId: 'task',
      toolName: 'test.approved',
      status: 'approved',
      approvalId: 'approval',
      args: { original: true },
      decision: { modelToolCallId: 'model-call-1' },
    });
    await store.doc('approvals', 'approval').set({
      id: 'approval',
      taskId: 'task',
      toolCallId: 'tool',
      status: 'approved',
      resolutionPayload: { edited: true },
    });
  });

  afterEach(async () => disposeStore(store));

  it('claims once, rejects foreign links, and fences stale terminal writes', async () => {
    await expect(repository.load('other-owner', 'task', 'tool')).resolves.toBeNull();
    await expect(repository.load('owner', 'other-task', 'tool')).resolves.toBeNull();
    await expect(
      repository.findByModelToolCallId('other-owner', 'task', 'model-call-1'),
    ).resolves.toBeNull();
    await expect(
      repository.findByModelToolCallId('owner', 'task', 'model-call-1'),
    ).resolves.toMatchObject({
      toolCall: { id: 'tool', decision: { modelToolCallId: 'model-call-1' } },
      approval: { id: 'approval', status: 'approved' },
    });
    await expect(repository.load('owner', 'task', 'tool')).resolves.toMatchObject({
      toolCall: { status: 'approved' },
      approval: { status: 'approved' },
    });

    const input = {
      agentId: 'owner',
      taskId: 'task',
      toolCallId: 'tool',
      args: { edited: true },
      decision: { reservationId: 'reservation-1', modelToolCallId: 'model-call-1' },
      expectedPolicyFingerprint: approvalPolicyFingerprint([]),
      expectedTaskTrust: 'owner',
    };
    await expect(repository.claim({ ...input, expectedTaskStatus: 'running' })).resolves.toBeNull();
    await store.doc('tasks', 'task').update({ status: 'running' });
    const fenced = { ...input, expectedTaskStatus: 'running' };
    const claims = await Promise.all([repository.claim(fenced), repository.claim(fenced)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(repository.claim(fenced)).resolves.toBeNull();
    await expect(repository.load('owner', 'task', 'tool')).resolves.toMatchObject({
      toolCall: { status: 'executing', args: { edited: true } },
    });

    const progress = {
      provider: 'google' as const,
      kind: 'document' as const,
      objectId: 'created-doc',
      stage: 'created' as const,
      payloadDigest: 'a'.repeat(64),
    };
    const progressInput = { agentId: 'owner', taskId: 'task', toolCallId: 'tool', progress };
    expect(
      await repository.checkpointExternalEffect?.({ ...progressInput, agentId: 'foreign-owner' }),
    ).toBe(false);
    expect(await repository.checkpointExternalEffect?.(progressInput)).toBe(true);
    expect(await repository.checkpointExternalEffect?.(progressInput)).toBe(true);
    await expect(
      repository.checkpointExternalEffect?.({
        ...progressInput,
        progress: { ...progress, objectId: 'different-doc' },
      }),
    ).rejects.toThrow('identity');
    await expect(
      repository.checkpointExternalEffect?.({
        ...progressInput,
        progress: { ...progress, payloadDigest: 'b'.repeat(64) },
      }),
    ).rejects.toThrow('approved bytes');
    expect(
      await repository.checkpointExternalEffect?.({
        ...progressInput,
        progress: { ...progress, stage: 'filled' },
      }),
    ).toBe(true);
    expect((await repository.load('owner', 'task', 'tool'))?.toolCall.decision).toMatchObject({
      externalEffect: { ...progress, stage: 'filled' },
    });

    await expect(
      repository.outcome({
        agentId: 'owner',
        taskId: 'task',
        toolCallId: 'tool',
        status: 'succeeded',
        result: { deliveryStatus: 'unknown', retrySuppressed: true },
      }),
    ).resolves.toBe(true);
    await expect(
      repository.outcome({
        agentId: 'owner',
        taskId: 'task',
        toolCallId: 'tool',
        status: 'failed',
        error: 'stale executor failure',
      }),
    ).resolves.toBe(false);
    await expect(repository.load('owner', 'task', 'tool')).resolves.toMatchObject({
      toolCall: {
        status: 'succeeded',
        result: { deliveryStatus: 'unknown', retrySuppressed: true },
      },
    });
  });

  it('rejects stale autonomous policy snapshots and starts once against unchanged owner/tool scope', async () => {
    await store.doc('tasks', 'task').update({ status: 'running' });
    const enabledPolicy = {
      id: 'autonomous-policy',
      agentId: 'owner',
      toolName: 'test.autonomous',
      templateKey: 'test.allow',
      match: {},
      effect: 'allow' as const,
      enabled: true,
      version: 1,
      createdVia: 'settings' as const,
      createdAt: store.now(),
      updatedAt: store.now(),
    };
    await store.doc('approvalPolicies', enabledPolicy.id).set(enabledPolicy);
    const enabledFingerprint = approvalPolicyFingerprint([enabledPolicy]);
    const startInput = {
      agentId: 'owner',
      taskId: 'task',
      step: 2,
      toolName: 'test.autonomous',
      args: { value: 'bounded' },
      idempotencyKey: null,
      decision: { modelToolCallId: 'model-autonomous-start-1' },
    };

    await store.doc('approvalPolicies', enabledPolicy.id).update({ enabled: false });
    await expect(
      repository.start({ ...startInput, expectedPolicyFingerprint: enabledFingerprint }),
    ).resolves.toBeNull();
    const disabledPolicy = { ...enabledPolicy, enabled: false };
    await store.doc('approvalPolicies', enabledPolicy.id).delete();
    await expect(
      repository.start({
        ...startInput,
        expectedPolicyFingerprint: approvalPolicyFingerprint([disabledPolicy]),
      }),
    ).resolves.toBeNull();

    const unrelatedPolicy = { ...enabledPolicy, id: 'unrelated-policy', toolName: 'test.other' };
    await store.doc('approvalPolicies', unrelatedPolicy.id).set(unrelatedPolicy);
    await expect(
      repository.start({
        ...startInput,
        expectedPolicyFingerprint: approvalPolicyFingerprint([unrelatedPolicy]),
      }),
    ).resolves.toBeNull();

    const currentScopeInput = {
      ...startInput,
      expectedPolicyFingerprint: approvalPolicyFingerprint([]),
    };
    const starts = await Promise.all([
      repository.start(currentScopeInput),
      repository.start(currentScopeInput),
    ]);
    expect(starts.filter(Boolean)).toHaveLength(1);
    const winner = starts.find((row) => row !== null);
    expect(winner).toMatchObject({ status: 'executing', toolName: 'test.autonomous' });
    if (!winner) throw new Error('autonomous start did not persist');
    await expect(repository.start(currentScopeInput)).resolves.toBeNull();
    const calls = await store.collection('toolCalls').where('taskId', '==', 'task').get();
    expect(calls.size).toBe(2); // original approved fixture plus one autonomous start
  });

  it('serializes a concurrent disable before start and preserves a start that commits first', async () => {
    await store.doc('tasks', 'task').update({ status: 'running' });
    const policyId = 'race-policy';
    const policy = {
      id: policyId,
      agentId: 'owner',
      toolName: 'test.autonomous-race',
      templateKey: 'calendar.self_only_events',
      match: {},
      effect: 'allow' as const,
      enabled: true,
      version: 1,
      createdVia: 'settings' as const,
      createdAt: store.now(),
      updatedAt: store.now(),
    };
    await store.doc('approvalPolicies', policyId).set(policy);
    const fingerprint = approvalPolicyFingerprint([policy]);
    const input = {
      agentId: 'owner',
      taskId: 'task',
      step: 2,
      toolName: policy.toolName,
      args: { value: 'race' },
      idempotencyKey: null,
      decision: { modelToolCallId: 'policy-race-start' },
      expectedPolicyFingerprint: fingerprint,
    };

    // First ordering: the real policy mutation has acquired the shared owner
    // transaction and queued its writes. The start reads that same owner while
    // the mutation is held; after release it must retry against the disabled
    // row and refuse the stale enabled-policy digest.
    const mutationReached = deferred();
    const releaseMutation = deferred();
    const mutationStore = transactionBarrier(store, 'owner', {
      holdAfter: 'owner-update',
      reached: mutationReached.resolve,
      release: releaseMutation.promise,
    });
    const ownerRead = deferred();
    const startStore = transactionBarrier(store, 'owner', {
      holdAfter: 'tool-call-create',
      reached: () => {},
      release: Promise.resolve(),
      ownerRead: ownerRead.resolve,
    });
    const disable = new FirestoreApprovalPolicyRepository(mutationStore).setEnabled(
      'owner',
      policyId,
      false,
    );
    let staleStart: ReturnType<FirestoreToolExecutionRepository['start']> | undefined;
    try {
      await waitBounded(mutationReached.promise, 'policy disable owner update');
      staleStart = new FirestoreToolExecutionRepository(startStore).start(input);
      await waitBounded(ownerRead.promise, 'start owner-fence transaction read');
      releaseMutation.resolve();
      expect(await disable).toBe(true);
      await expect(staleStart).resolves.toBeNull();
      const calls = await store.collection('toolCalls').where('taskId', '==', 'task').get();
      expect(calls.docs.filter((row) => row.get('toolName') === policy.toolName)).toHaveLength(0);
    } finally {
      releaseMutation.resolve();
      await Promise.allSettled([disable, staleStart]);
    }

    // Reverse ordering: hold the actual start transaction after it has queued
    // its tool-call write. A real disable then contends on the shared owner
    // document. Releasing the start commits it first; the subsequent disable
    // cannot retroactively revoke that durable claim.
    await store.doc('approvalPolicies', policyId).update({ enabled: true });
    const enabledPolicy = { ...policy, updatedAt: store.now() };
    const startReached = deferred();
    const releaseStart = deferred();
    const heldStartStore = transactionBarrier(store, 'owner', {
      holdAfter: 'tool-call-create',
      reached: startReached.resolve,
      release: releaseStart.promise,
    });
    const mutationOwnerRead = deferred();
    const delayedMutationStore = transactionBarrier(store, 'owner', {
      holdAfter: 'owner-update',
      reached: () => {},
      release: Promise.resolve(),
      ownerRead: mutationOwnerRead.resolve,
    });
    const committedStart = new FirestoreToolExecutionRepository(heldStartStore).start({
      ...input,
      decision: { modelToolCallId: 'policy-race-start-wins' },
      expectedPolicyFingerprint: approvalPolicyFingerprint([enabledPolicy]),
    });
    let laterDisable: Promise<boolean> | undefined;
    try {
      await waitBounded(startReached.promise, 'start transaction tool-call write');
      laterDisable = new FirestoreApprovalPolicyRepository(delayedMutationStore).setEnabled(
        'owner',
        policyId,
        false,
      );
      await waitBounded(mutationOwnerRead.promise, 'later policy mutation owner-fence read');
      releaseStart.resolve();
      const startedRow = await committedStart;
      expect(startedRow).toMatchObject({ status: 'executing', toolName: policy.toolName });
      expect(await laterDisable).toBe(true);
      const currentPolicy = await new FirestoreApprovalPolicyRepository(store).list('owner', {
        toolName: policy.toolName,
      });
      expect(currentPolicy).toMatchObject([{ enabled: false }]);
      const persisted = await store.collection('toolCalls').where('taskId', '==', 'task').get();
      expect(persisted.docs.filter((row) => row.get('toolName') === policy.toolName)).toHaveLength(
        1,
      );
    } finally {
      releaseStart.resolve();
      await Promise.allSettled([committedStart, laterDisable]);
    }
  });

  it('serializes a real policy deletion before start and preserves a start that commits first', async () => {
    await store.doc('tasks', 'task').update({ status: 'running' });
    const policyId = 'delete-race-policy';
    const policy = {
      id: policyId,
      agentId: 'owner',
      toolName: 'test.autonomous-delete-race',
      templateKey: 'calendar.self_only_events',
      match: {},
      effect: 'allow' as const,
      enabled: true,
      version: 1,
      createdVia: 'settings' as const,
      createdAt: store.now(),
      updatedAt: store.now(),
    };
    await store.doc('approvalPolicies', policyId).set(policy);
    const fingerprint = approvalPolicyFingerprint([policy]);
    const input = {
      agentId: 'owner',
      taskId: 'task',
      step: 2,
      toolName: policy.toolName,
      args: { value: 'delete-race' },
      idempotencyKey: null,
      decision: { modelToolCallId: 'policy-delete-race-start' },
      expectedPolicyFingerprint: fingerprint,
    };

    const deleteReached = deferred();
    const releaseDelete = deferred();
    const deleteStore = transactionBarrier(store, 'owner', {
      holdAfter: 'owner-update',
      reached: deleteReached.resolve,
      release: releaseDelete.promise,
    });
    const ownerRead = deferred();
    const startStore = transactionBarrier(store, 'owner', {
      holdAfter: 'tool-call-create',
      reached: () => {},
      release: Promise.resolve(),
      ownerRead: ownerRead.resolve,
    });
    const deletion = new FirestoreApprovalPolicyRepository(deleteStore).delete('owner', policyId);
    let staleStart: ReturnType<FirestoreToolExecutionRepository['start']> | undefined;
    try {
      await waitBounded(deleteReached.promise, 'policy delete owner update');
      staleStart = new FirestoreToolExecutionRepository(startStore).start(input);
      await waitBounded(ownerRead.promise, 'delete-first start owner-fence read');
      releaseDelete.resolve();
      expect(await deletion).toBe(true);
      await expect(staleStart).resolves.toBeNull();
      const calls = await store.collection('toolCalls').where('taskId', '==', 'task').get();
      expect(calls.docs.filter((row) => row.get('toolName') === policy.toolName)).toHaveLength(0);
      expect(
        await new FirestoreApprovalPolicyRepository(store).list('owner', {
          toolName: policy.toolName,
        }),
      ).toHaveLength(0);
    } finally {
      releaseDelete.resolve();
      await Promise.allSettled([deletion, staleStart]);
    }

    await store.doc('approvalPolicies', policyId).set({ ...policy, updatedAt: store.now() });
    const [restoredPolicy] = await new FirestoreApprovalPolicyRepository(store).list('owner', {
      toolName: policy.toolName,
    });
    if (!restoredPolicy) throw new Error('policy disappeared before start-first delete');
    const reenabledFingerprint = approvalPolicyFingerprint([restoredPolicy]);
    const startReached = deferred();
    const releaseStart = deferred();
    const heldStartStore = transactionBarrier(store, 'owner', {
      holdAfter: 'tool-call-create',
      reached: startReached.resolve,
      release: releaseStart.promise,
    });
    const deleteOwnerRead = deferred();
    const delayedDeleteStore = transactionBarrier(store, 'owner', {
      holdAfter: 'owner-update',
      reached: () => {},
      release: Promise.resolve(),
      ownerRead: deleteOwnerRead.resolve,
    });
    const committedStart = new FirestoreToolExecutionRepository(heldStartStore).start({
      ...input,
      decision: { modelToolCallId: 'policy-delete-start-wins' },
      expectedPolicyFingerprint: reenabledFingerprint,
    });
    let laterDelete: Promise<boolean> | undefined;
    try {
      await waitBounded(startReached.promise, 'start-first tool-call write');
      laterDelete = new FirestoreApprovalPolicyRepository(delayedDeleteStore).delete(
        'owner',
        policyId,
      );
      await waitBounded(deleteOwnerRead.promise, 'later delete owner-fence read');
      releaseStart.resolve();
      const startedRow = await committedStart;
      expect(startedRow).toMatchObject({ status: 'executing', toolName: policy.toolName });
      expect(await laterDelete).toBe(true);
      expect(
        await new FirestoreApprovalPolicyRepository(store).list('owner', {
          toolName: policy.toolName,
        }),
      ).toHaveLength(0);
      const persisted = await store.collection('toolCalls').where('taskId', '==', 'task').get();
      expect(persisted.docs.filter((row) => row.get('toolName') === policy.toolName)).toHaveLength(
        1,
      );
    } finally {
      releaseStart.resolve();
      await Promise.allSettled([committedStart, laterDelete]);
    }
  });

  it('rejects an empty policy snapshot when a real approval resolution inserts a policy first', async () => {
    const taskId = 'policy-insert-race-task';
    const toolId = 'policy-insert-race-tool';
    const approvalId = 'policy-insert-race-approval';
    const toolName = 'test.insert-race';
    await store.doc('tasks', taskId).set({
      id: taskId,
      agentId: 'owner',
      type: 'chat_turn',
      status: 'waiting_approval',
      trust: 'owner',
      queueGeneration: 0,
    });
    await store.doc('toolCalls', toolId).set({
      id: toolId,
      taskId,
      toolName,
      status: 'pending',
    });
    await store.doc('approvals', approvalId).set({
      id: approvalId,
      taskId,
      toolCallId: toolId,
      shortCode: 'RACE1',
      status: 'pending',
      expiresAt: new Date(store.now().getTime() + 60_000),
    });

    const insertReached = deferred();
    const releaseInsert = deferred();
    const resolverStore = transactionBarrier(store, 'owner', {
      holdAfter: 'owner-update',
      reached: insertReached.resolve,
      release: releaseInsert.promise,
    });
    const ownerRead = deferred();
    const startStore = transactionBarrier(store, 'owner', {
      holdAfter: 'tool-call-create',
      reached: () => {},
      release: Promise.resolve(),
      ownerRead: ownerRead.resolve,
    });
    const policy = {
      agentId: 'owner',
      toolName,
      templateKey: 'calendar.self_only_events',
      match: {},
      effect: 'allow' as const,
    };
    const resolution = new FirestoreApprovalRepository(resolverStore).resolve({
      approvalId,
      decision: 'approved',
      via: 'web',
      policy,
    });
    let start: ReturnType<FirestoreToolExecutionRepository['start']> | undefined;
    try {
      await waitBounded(insertReached.promise, 'approval policy insert owner update');
      start = new FirestoreToolExecutionRepository(startStore).start({
        agentId: 'owner',
        taskId,
        step: 2,
        toolName,
        args: { value: 'empty-snapshot' },
        idempotencyKey: null,
        decision: { modelToolCallId: 'policy-insert-race-start' },
        expectedPolicyFingerprint: approvalPolicyFingerprint([]),
      });
      await waitBounded(ownerRead.promise, 'empty-snapshot start owner-fence transaction read');
      releaseInsert.resolve();
      await expect(resolution).resolves.toMatchObject({ ok: true });
      await expect(start).resolves.toBeNull();
      const calls = await store.collection('toolCalls').where('taskId', '==', taskId).get();
      expect(calls.docs.filter((row) => row.get('toolName') === toolName)).toHaveLength(1);
      expect(calls.docs.find((row) => row.id === toolId)?.get('status')).toBe('approved');
    } finally {
      releaseInsert.resolve();
      await Promise.allSettled([resolution, start]);
    }
  });

  it('atomically persists sharing consent and event data and fences stale device writes after revoke', async () => {
    const ownerId = 'owner';
    const publisherId = 'device-publisher';
    const now = store.now();
    const enabled = await repository.phoneCalendarSharing?.apply(
      ownerId,
      {
        command: 'enable',
        publisherId,
        expectedGeneration: 0,
        mutationId: 'enable-1',
        consentVersion: 1,
        calendars: [{ id: 'work', name: 'Work', purpose: 'commitments' }],
      },
      now,
    );
    expect(enabled).toMatchObject({ ok: true, state: { generation: 1, enabled: true } });

    const snapshot: PhoneCalendarSnapshotInput = {
      capturedAt: now.toISOString(),
      selectionRevision: 1,
      complete: true,
      truncated: false,
      timeMin: new Date(now.getTime() - 86_400_000).toISOString(),
      timeMax: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      timeZone: 'UTC',
      calendars: [{ id: 'work', name: 'Work', purpose: 'commitments' }],
      sourceAvailability: [{ calendarId: 'work', status: 'available', complete: true }],
      events: [],
    };
    const applied = await repository.phoneCalendarSharing?.apply(
      ownerId,
      { command: 'snapshot', publisherId, expectedGeneration: 1, snapshot },
      now,
    );
    expect(applied).toMatchObject({ ok: true, state: { generation: 1 } });
    expect(await readPhoneCalendars(repository, ownerId)).toMatchObject({
      capturedAt: now.toISOString(),
      calendars: [{ id: 'work', purpose: 'commitments' }],
    });
    expect(await repository.phoneCalendarSharing?.readSnapshot?.(ownerId, now)).toMatchObject({
      state: { enabled: true, generation: 1 },
      snapshot: { selectionRevision: 1, calendars: [{ id: 'work', purpose: 'commitments' }] },
    });

    const revoked = await repository.phoneCalendarSharing?.apply(
      ownerId,
      { command: 'revoke', publisherId, expectedGeneration: 1 },
      now,
    );
    expect(revoked).toMatchObject({ ok: true, state: { generation: 2, enabled: false } });
    const lateSnapshot = await repository.phoneCalendarSharing?.apply(
      ownerId,
      { command: 'snapshot', publisherId, expectedGeneration: 1, snapshot },
      now,
    );
    expect(lateSnapshot).toMatchObject({ ok: false, error: 'stale_generation' });

    const restarted = new FirestoreToolExecutionRepository(store);
    expect(await restarted.phoneCalendarSharing.get(ownerId)).toMatchObject({
      generation: 2,
      enabled: false,
    });
    expect(await readPhoneCalendars(restarted, ownerId)).toBeNull();
    expect(await restarted.phoneCalendarSharing.readSnapshot?.(ownerId, now)).toMatchObject({
      state: { enabled: false, generation: 2 },
      snapshot: null,
    });

    const pendingOwner = 'owner-pending';
    const pendingEnable = await repository.phoneCalendarSharing?.apply(
      pendingOwner,
      {
        command: 'enable',
        publisherId,
        expectedGeneration: 0,
        mutationId: 'pending-enable',
        consentVersion: 1,
        calendars: [{ id: 'work', name: 'Work', purpose: 'commitments' }],
      },
      now,
    );
    expect(pendingEnable?.ok).toBe(true);
    const cancellation = await repository.phoneCalendarSharing?.apply(
      pendingOwner,
      {
        command: 'revoke',
        publisherId,
        expectedGeneration: 0,
        cancelPendingMutationId: 'pending-enable',
      },
      now,
    );
    expect(cancellation).toMatchObject({
      ok: true,
      state: { generation: 2, enabled: false },
    });
  });

  it('guards sharing state and snapshot reads against an active privacy erasure', async () => {
    await store.doc('privacyErasureJobs', 'owner').set({
      agentId: 'owner',
      generation: 'active-generation',
      status: 'active',
    });
    await expect(repository.phoneCalendarSharing?.get('owner')).rejects.toThrow(/privacy erasure/i);
    await expect(repository.phoneCalendarSharing?.readSnapshot?.('owner')).rejects.toThrow(
      /privacy erasure/i,
    );
    await expect(readPhoneCalendars(repository, 'owner')).rejects.toThrow(/privacy erasure/i);
    await store.doc('privacyErasureJobs', 'owner').delete();
  });

  it('returns a coherent snapshot during a concurrent selection scheduling smoke test', async () => {
    const ownerId = 'owner';
    const publisherId = 'device-publisher';
    const now = store.now();
    const work = [{ id: 'work', name: 'Work', purpose: 'commitments' as const }];
    await repository.phoneCalendarSharing?.apply(
      ownerId,
      {
        command: 'enable',
        publisherId,
        expectedGeneration: 0,
        mutationId: 'select-race-enable',
        consentVersion: 1,
        calendars: work,
      },
      now,
    );
    const snapshot: PhoneCalendarSnapshotInput = {
      capturedAt: now.toISOString(),
      selectionRevision: 1,
      complete: true,
      truncated: false,
      timeMin: new Date(now.getTime() - 86_400_000).toISOString(),
      timeMax: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      timeZone: 'UTC',
      calendars: work,
      sourceAvailability: [{ calendarId: 'work', status: 'available', complete: true }],
      events: [],
    };
    await repository.phoneCalendarSharing?.apply(
      ownerId,
      { command: 'snapshot', publisherId, expectedGeneration: 1, snapshot },
      now,
    );

    // Promise.all exercises contention; either transaction may linearize first.
    const [changed, observed] = await Promise.all([
      repository.phoneCalendarSharing?.apply(
        ownerId,
        {
          command: 'select',
          publisherId,
          expectedGeneration: 1,
          mutationId: 'select-race-2',
          consentVersion: 1,
          calendars: [{ id: 'family', name: 'Family', purpose: 'unspecified' }],
        },
        now,
      ),
      repository.phoneCalendarSharing?.readSnapshot?.(ownerId, now),
    ]);
    expect(changed).toMatchObject({ ok: true, state: { generation: 2 } });
    expect([1, 2]).toContain(observed?.state?.generation);
    if (observed?.state?.generation === 1) {
      expect(observed.snapshot).toMatchObject({ selectionRevision: 1, calendars: work });
    } else {
      expect(observed?.snapshot).toBeNull();
      expect(observed?.state?.calendars).toEqual([
        { id: 'family', name: 'Family', purpose: 'unspecified' },
      ]);
    }
    expect(await repository.phoneCalendarSharing?.readSnapshot?.(ownerId, now)).toMatchObject({
      state: { generation: 2 },
      snapshot: null,
    });

    const family = [{ id: 'family', name: 'Family', purpose: 'unspecified' as const }];
    const familySnapshot: PhoneCalendarSnapshotInput = {
      ...snapshot,
      selectionRevision: 2,
      calendars: family,
      sourceAvailability: [{ calendarId: 'family', status: 'available', complete: true }],
    };
    await repository.phoneCalendarSharing?.apply(
      ownerId,
      { command: 'snapshot', publisherId, expectedGeneration: 2, snapshot: familySnapshot },
      now,
    );
    const [revoked, revokeRead] = await Promise.all([
      repository.phoneCalendarSharing?.apply(
        ownerId,
        { command: 'revoke', publisherId, expectedGeneration: 2 },
        now,
      ),
      repository.phoneCalendarSharing?.readSnapshot?.(ownerId, now),
    ]);
    expect(revoked).toMatchObject({ ok: true, state: { generation: 3, enabled: false } });
    expect([2, 3]).toContain(revokeRead?.state?.generation);
    if (revokeRead?.state?.generation === 2) {
      expect(revokeRead.snapshot).toMatchObject({ selectionRevision: 2, calendars: family });
    } else {
      expect(revokeRead?.snapshot).toBeNull();
    }
    expect(await repository.phoneCalendarSharing?.readSnapshot?.(ownerId, now)).toMatchObject({
      state: { generation: 3, enabled: false },
      snapshot: null,
    });
  });

  it('fails closed when the approval link belongs to another call', async () => {
    await store.doc('approvals', 'approval').update({ toolCallId: 'other-tool' });
    await expect(repository.load('owner', 'task', 'tool')).resolves.toBeNull();
    await expect(
      repository.claim({
        agentId: 'owner',
        taskId: 'task',
        toolCallId: 'tool',
        args: {},
        decision: {},
        expectedPolicyFingerprint: approvalPolicyFingerprint([]),
        expectedTaskTrust: 'owner',
      }),
    ).resolves.toBeNull();
  });

  it('does not claim an approved call after task cancellation has committed', async () => {
    await store.doc('tasks', 'task').update({ status: 'cancelled' });
    const result = await repository.claim({
      agentId: 'owner',
      taskId: 'task',
      toolCallId: 'tool',
      args: { edited: true },
      decision: { reservationId: 'reservation-1', modelToolCallId: 'model-call-1' },
      expectedPolicyFingerprint: approvalPolicyFingerprint([]),
      expectedTaskTrust: 'owner',
      expectedTaskStatus: 'running',
    });
    expect(result).toBeNull();
    await expect(repository.load('owner', 'task', 'tool')).resolves.toMatchObject({
      task: { status: 'cancelled' },
      toolCall: { status: 'approved', decision: { modelToolCallId: 'model-call-1' } },
      approval: { status: 'approved' },
    });
  });

  it('does not let a losing claim change the committed executing winner', async () => {
    await store.doc('tasks', 'task').update({ status: 'running' });
    const input = {
      agentId: 'owner',
      taskId: 'task',
      toolCallId: 'tool',
      args: { edited: true },
      decision: { reservationId: 'reservation-winner', modelToolCallId: 'model-call-1' },
      expectedPolicyFingerprint: approvalPolicyFingerprint([]),
      expectedTaskTrust: 'owner',
      expectedTaskStatus: 'running',
    };
    const first = await repository.claim(input);
    expect(first).toMatchObject({ toolCall: { status: 'executing' } });
    await expect(repository.claim(input)).resolves.toBeNull();
    await expect(repository.load('owner', 'task', 'tool')).resolves.toMatchObject({
      task: { status: 'running' },
      toolCall: {
        status: 'executing',
        decision: { reservationId: 'reservation-winner', modelToolCallId: 'model-call-1' },
      },
    });
  });

  it('writes a stale-authority receipt before returning a disabled-policy digest mismatch', async () => {
    await store.doc('tasks', 'task').update({ status: 'running' });
    const now = new Date('2026-09-12T12:00:00Z');
    const disabledPolicy = {
      id: 'disabled-policy',
      agentId: 'owner',
      toolName: 'test.approved',
      templateKey: 'unknown-but-preserved',
      match: {},
      effect: 'deny' as const,
      enabled: false,
      version: 1,
      createdVia: 'owner' as const,
      createdAt: now,
      updatedAt: now,
    };
    await store.doc('approvalPolicies', disabledPolicy.id).set(disabledPolicy);
    const input = {
      agentId: 'owner',
      taskId: 'task',
      toolCallId: 'tool',
      args: { edited: true },
      decision: {
        reservationId: 'reservation-1',
        modelToolCallId: 'model-call-1',
        policyFingerprint: 'private-policy-snapshot',
        mcpBinding: { credential: 'never-copy' },
      },
      expectedTaskStatus: 'running',
      expectedTaskTrust: 'owner',
    };

    await expect(
      repository.claim({ ...input, expectedPolicyFingerprint: approvalPolicyFingerprint([]) }),
    ).resolves.toEqual({
      type: 'stale_authorization',
      error: 'approval authority changed before execution; request fresh approval',
    });
    await expect(repository.load('owner', 'task', 'tool')).resolves.toMatchObject({
      toolCall: {
        status: 'failed',
        decision: { reservationId: 'reservation-1', modelToolCallId: 'model-call-1' },
        error: 'approval authority changed before execution; request fresh approval',
      },
      approval: { status: 'approved' },
    });
  });

  it('binds the claim digest to disabled policies as well as enabled policies', async () => {
    await store.doc('tasks', 'task').update({ status: 'running' });
    const now = new Date('2026-09-12T12:00:00Z');
    const disabledPolicy = {
      id: 'disabled-policy',
      agentId: 'owner',
      toolName: 'test.approved',
      templateKey: 'unknown-but-preserved',
      match: {},
      effect: 'deny' as const,
      enabled: false,
      version: 1,
      createdVia: 'owner' as const,
      createdAt: now,
      updatedAt: now,
    };
    await store.doc('approvalPolicies', disabledPolicy.id).set(disabledPolicy);
    await expect(
      repository.claim({
        agentId: 'owner',
        taskId: 'task',
        toolCallId: 'tool',
        args: { edited: true },
        decision: { reservationId: 'reservation-1' },
        expectedTaskStatus: 'running',
        expectedTaskTrust: 'owner',
        expectedPolicyFingerprint: approvalPolicyFingerprint([disabledPolicy]),
      }),
    ).resolves.toMatchObject({ toolCall: { status: 'executing' } });
  });
  it('selects the latest owner context before the time boundary despite newer unrelated messages', async () => {
    await store
      .doc('conversations', 'chat')
      .set({ id: 'chat', agentId: 'owner', channel: 'chat', trust: 'owner' });
    const start = Date.parse('2026-09-12T00:00:00Z');
    const rows = [
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `owner-${index}`,
        role: 'user',
        origin: 'owner',
        text: `query-${index}`,
        createdAt: new Date(start + index * 1000),
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `assistant-${index}`,
        role: 'assistant',
        origin: 'owner',
        text: 'irrelevant',
        createdAt: new Date(start + 7000 + index * 1000),
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `future-${index}`,
        role: 'user',
        origin: 'owner',
        text: 'future',
        createdAt: new Date(start + 20000 + index * 1000),
      })),
    ];
    const batch = store.db.batch();
    for (const row of rows)
      batch.create(store.doc('messages', row.id), { ...row, conversationId: 'chat' });
    await batch.commit();
    expect(await repository.ownerMessageHistory('owner', 'chat', new Date(start + 15000))).toEqual([
      'query-2',
      'query-3',
      'query-4',
      'query-5',
    ]);
    expect(
      await repository.ownerMessageHistory('foreign', 'chat', new Date(start + 15000)),
    ).toEqual([]);
  });

  it('refuses incomplete authorization evidence and dangling idempotency records', async () => {
    const batch = store.db.batch();
    for (let index = 0; index < 201; index++) {
      const id = `evidence-${index}`;
      batch.create(store.doc('toolCalls', id), {
        id,
        taskId: 'task',
        toolName: 'web.search',
        status: 'succeeded',
        result: {},
      });
    }
    batch.create(store.doc('toolCallIdempotency', 'dangling'), { toolCallId: 'missing' });
    await batch.commit();
    await expect(repository.goalWorkEvidence('owner', 'task')).rejects.toThrow('exceeded bound');
    await expect(repository.searchResults('task')).rejects.toThrow('exceeded bound');
    await expect(repository.findIdempotent('owner', 'task', 'dangling')).rejects.toThrow(
      'Dangling',
    );
  });

  it('does not return another owner or task idempotent result', async () => {
    await store.doc('toolCallIdempotency', 'key').create({ toolCallId: 'tool' });
    expect(await repository.findIdempotent('owner', 'task', 'key')).toMatchObject({ id: 'tool' });
    expect(await repository.findIdempotent('foreign', 'task', 'key')).toBeNull();
    expect(await repository.findIdempotent('owner', 'other-task', 'key')).toBeNull();
  });
});
