import {
  approvalPolicyFingerprint,
  type PhoneCalendarSnapshotInput,
  readPhoneCalendars,
} from '@assistant/persistence';
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
