import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreApprovalRepository } from './approvals.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

type TransactionCallback = (transaction: object) => Promise<unknown>;
type TransactionRunner = (callback: TransactionCallback, options?: unknown) => Promise<unknown>;

function advanceClockAfterTransactionalGetAll(
  store: InstallationStore,
  advanceClock: () => void,
): InstallationStore {
  const delayedDb = new Proxy(store.db, {
    get(target, property) {
      if (property !== 'runTransaction') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const run = target.runTransaction.bind(target) as unknown as TransactionRunner;
      return (callback: TransactionCallback, options?: unknown) =>
        run(async (transaction) => {
          const delayedTransaction = new Proxy(transaction, {
            get(transactionTarget, transactionProperty) {
              const value = Reflect.get(transactionTarget, transactionProperty, transactionTarget);
              if (transactionProperty === 'getAll' && typeof value === 'function') {
                const getAll = value.bind(transactionTarget) as (
                  ...args: unknown[]
                ) => Promise<unknown>;
                return async (...references: unknown[]) => {
                  const snapshots = await getAll(...references);
                  advanceClock();
                  return snapshots;
                };
              }
              return typeof value === 'function' ? value.bind(transactionTarget) : value;
            },
          });
          return callback(delayedTransaction);
        }, options);
    },
  }) as InstallationStore['db'];
  return new Proxy(store, {
    get(target, property) {
      if (property === 'db') return delayedDb;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as InstallationStore;
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore approval command', () => {
  let store: InstallationStore, approvals: FirestoreApprovalRepository;
  let currentTime: Date;
  beforeEach(async () => {
    currentTime = new Date('2026-09-12T12:00:00.000Z');
    store = emulatorStore(() => new Date(currentTime));
    approvals = new FirestoreApprovalRepository(store);
    await store.doc('agents', 'agent').set({ id: 'agent' });
    await store
      .doc('tasks', 'task')
      .set({ id: 'task', agentId: 'agent', status: 'waiting_approval', queueGeneration: 0 });
    await store
      .doc('toolCalls', 'tool')
      .set({ id: 'tool', taskId: 'task', toolName: 'email.send', status: 'pending' });
    await store.doc('approvals', 'approval').set({
      id: 'approval',
      taskId: 'task',
      toolCallId: 'tool',
      shortCode: 'A7',
      status: 'pending',
      expiresAt: new Date(store.now().getTime() + 60_000),
    });
  });
  afterEach(async () => {
    await disposeStore(store);
  });
  it('resolves a racing decision exactly once with the checkpoint wake and durable outbox', async () => {
    const results = await Promise.all([
      approvals.resolve({ approvalId: 'approval', decision: 'approved', via: 'web' }),
      approvals.resolve({ shortCode: 'A7', decision: 'denied', via: 'sms' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const status = (await store.doc('approvals', 'approval').get()).get('status');
    expect((await store.doc('toolCalls', 'tool').get()).get('status')).toBe(status);
    expect((await store.doc('tasks', 'task').get()).get('queueGeneration')).toBe(1);
    expect((await store.collection('outbox').get()).size).toBe(1);
  });
  it('a late approval does not resurrect a cancelled task', async () => {
    await store.doc('tasks', 'task').update({ status: 'cancelled' });
    expect(
      (await approvals.resolve({ approvalId: 'approval', decision: 'approved', via: 'web' })).ok,
    ).toBe(true);
    expect((await store.doc('tasks', 'task').get()).get('status')).toBe('cancelled');
    expect((await store.collection('outbox').get()).size).toBe(0);
  });
  it('does not resolve a pending approval after its answer deadline', async () => {
    await store.doc('approvals', 'approval').update({
      expiresAt: new Date(store.now().getTime() - 1),
    });
    expect(
      (await approvals.resolve({ approvalId: 'approval', decision: 'approved', via: 'web' })).ok,
    ).toBe(false);
    expect((await store.doc('approvals', 'approval').get()).get('status')).toBe('pending');
    expect((await store.doc('toolCalls', 'tool').get()).get('status')).toBe('pending');
    expect((await store.doc('tasks', 'task').get()).get('queueGeneration')).toBe(0);
  });
  it('resolves only strictly before the answer deadline without relying on the expiry sweep', async () => {
    const now = store.now();
    for (const scenario of [
      { label: 'before', expiresAt: new Date(now.getTime() + 1), expected: true },
      { label: 'at', expiresAt: now, expected: false },
      { label: 'after', expiresAt: new Date(now.getTime() - 1), expected: false },
    ]) {
      const suffix = scenario.label;
      const taskId = `task-${suffix}`;
      const toolCallId = `tool-${suffix}`;
      const approvalId = `approval-${suffix}`;
      await store.doc('tasks', taskId).set({
        id: taskId,
        agentId: 'agent',
        status: 'waiting_approval',
        queueGeneration: 0,
      });
      await store.doc('toolCalls', toolCallId).set({
        id: toolCallId,
        taskId,
        toolName: 'email.send',
        status: 'pending',
      });
      await store.doc('approvals', approvalId).set({
        id: approvalId,
        taskId,
        toolCallId,
        shortCode: `B-${suffix}`,
        status: 'pending',
        expiresAt: scenario.expiresAt,
      });
      const result = await approvals.resolve({
        approvalId,
        decision: 'approved',
        via: 'web',
      });
      expect(result.ok, scenario.label).toBe(scenario.expected);
      expect((await store.doc('approvals', approvalId).get()).get('status'), scenario.label).toBe(
        scenario.expected ? 'approved' : 'pending',
      );
      expect((await store.doc('tasks', taskId).get()).get('queueGeneration'), scenario.label).toBe(
        scenario.expected ? 1 : 0,
      );
    }
  });

  it('rejects a pending answer when its deadline passes during transactional reads', async () => {
    const expiresAt = new Date(currentTime.getTime() + 1);
    await store.doc('approvals', 'approval').update({ expiresAt });
    const delayedRepository = new FirestoreApprovalRepository(
      advanceClockAfterTransactionalGetAll(store, () => {
        currentTime = new Date(expiresAt.getTime() + 1);
      }),
    );

    expect(
      (
        await delayedRepository.resolve({
          approvalId: 'approval',
          decision: 'approved',
          via: 'web',
        })
      ).ok,
    ).toBe(false);
    expect((await store.doc('approvals', 'approval').get()).get('status')).toBe('pending');
    expect((await store.doc('toolCalls', 'tool').get()).get('status')).toBe('pending');
    expect((await store.doc('tasks', 'task').get()).get('queueGeneration')).toBe(0);
  });

  it('does not resolve or wake an approval while privacy erasure is active', async () => {
    await store.doc('privacyErasureJobs', 'agent').set({
      agentId: 'agent',
      generation: 'erase-generation',
      status: 'active',
    });
    await expect(
      approvals.resolve({ approvalId: 'approval', decision: 'approved', via: 'web' }),
    ).rejects.toThrow('Privacy erasure is in progress');
    expect((await store.doc('approvals', 'approval').get()).get('status')).toBe('pending');
    expect((await store.doc('tasks', 'task').get()).get('queueGeneration')).toBe(0);
    expect((await store.collection('outbox').get()).size).toBe(0);
  });
  it('persists edited args and an owner/tool-scoped policy together, rejecting mismatches atomically', async () => {
    const input = {
      approvalId: 'approval',
      decision: 'approved' as const,
      via: 'web' as const,
      editedPayload: { body: 'edited' },
      policy: {
        agentId: 'agent',
        toolName: 'email.send',
        templateKey: 'recipient',
        match: { to: 'a@example.com' },
        effect: 'allow' as const,
      },
    };
    await expect(
      approvals.resolve({ ...input, policy: { ...input.policy, agentId: 'other' } }),
    ).rejects.toThrow('task owner');
    expect((await store.doc('approvals', 'approval').get()).get('status')).toBe('pending');
    expect((await approvals.resolve(input)).ok).toBe(true);
    expect((await store.doc('approvals', 'approval').get()).get('resolutionPayload')).toEqual({
      body: 'edited',
    });
    expect((await store.collection('approvalPolicies').get()).size).toBe(1);
  });
  it('ambiguous short codes do not resolve multiple requests', async () => {
    await store.doc('approvals', 'other').set({ id: 'other', shortCode: 'A7', status: 'pending' });
    expect(
      (await approvals.resolve({ shortCode: 'A7', decision: 'approved', via: 'sms' })).ok,
    ).toBe(false);
    expect((await store.doc('approvals', 'approval').get()).get('status')).toBe('pending');
  });
});
