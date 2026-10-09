import { approvalPolicyFingerprint } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';
import { FirestoreToolExecutionRepository } from './tool-execution.js';

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
