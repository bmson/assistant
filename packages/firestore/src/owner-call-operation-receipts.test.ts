import { createHash } from 'node:crypto';
import {
  phoneCallOwnerActionGrantScopeFingerprint,
  phoneCallOwnerNumberGrantScopeFingerprint,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { createWakeIntent, wakeIntentId } from './outbox.js';
import {
  admitOwnerCallGrantOperationInTransaction,
  closeOwnerCallGrantOperationInTransaction,
  commitOwnerCallGrantOperationInTransaction,
  discoverOwnerCallGrantOperation,
  OwnerCallOperationCommitAbort,
  prepareOwnerCallGrantCommitInTransaction,
  readOwnerCallGrantOperationStatus,
  registerOwnerCallGrantOperationInTransaction,
} from './owner-call-operation-receipts.js';
import { documentKey } from './store.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const approvalId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const toolCallId = '44444444-4444-4444-8444-444444444444';
const grantId = '55555555-5555-4555-8555-555555555555';
const policyId = '77777777-7777-4777-8777-777777777777';
const fingerprint = 'a'.repeat(64);
const scopeFingerprint = 'b'.repeat(64);
const now = new Date('2026-10-26T12:00:00.000Z');

function fixture() {
  const rows = new Map<string, unknown>();
  const writes: Array<{ kind: string; id: string; value: unknown }> = [];
  const readCounts: number[] = [];
  let clock = now;
  const store: any = {
    doc(collection: string, id: string) {
      return { collection, id: documentKey(id), path: `${collection}/${documentKey(id)}` };
    },
    now: () => clock,
    setNow(value: Date) {
      clock = value;
    },
    db: {
      async runTransaction<T>(body: (tx: any) => Promise<T>) {
        const staged = new Map<string, unknown>();
        let readCount = 0;
        const pendingWrites: Array<{ kind: string; id: string; value: unknown }> = [];
        const tx = {
          async get(ref: { path: string; id: string }) {
            readCount += 1;
            const data = staged.has(ref.path) ? staged.get(ref.path) : rows.get(ref.path);
            return { id: ref.id, exists: data !== undefined, data: () => data };
          },
          async getAll(...refs: Array<{ path: string; id: string }>) {
            return Promise.all(refs.map((ref) => tx.get(ref)));
          },
          create(ref: { path: string; id: string }, value: unknown) {
            pendingWrites.push({ kind: 'create', id: ref.path, value });
            staged.set(ref.path, value);
          },
          update(ref: { path: string; id: string }, value: unknown) {
            pendingWrites.push({ kind: 'update', id: ref.path, value });
            staged.set(ref.path, {
              ...((staged.has(ref.path) ? staged.get(ref.path) : rows.get(ref.path)) as object),
              ...(value as object),
            });
          },
        };
        const result = await body(tx);
        readCounts.push(readCount);
        for (const [path, value] of staged) rows.set(path, value);
        writes.push(...pendingWrites);
        return result;
      },
    },
  };
  return { rows, writes, readCounts, store };
}

describe('Firestore owner-call operation storage', () => {
  it('discovers an absent slot as empty but treats a dangling current pointer as unavailable', async () => {
    const absent = fixture();
    expect(await discoverOwnerCallGrantOperation(absent.store, ownerId, approvalId)).toEqual({
      kind: 'empty',
      generation: 0,
    });

    const dangling = fixture();
    const slotId = createHash('sha256')
      .update(JSON.stringify(['owner-call-grant-slot-v1', ownerId, approvalId]), 'utf8')
      .digest('hex');
    const slotRef = dangling.store.doc('ownerCallGrantOperationSlots', slotId);
    dangling.rows.set(slotRef.path, {
      purpose: 'owner-call-grant-operation.v1',
      schemaVersion: 1,
      ownerId,
      approvalId,
      generation: 1,
      currentGrantId: grantId,
      updatedAt: now,
    });
    expect(await discoverOwnerCallGrantOperation(dangling.store, ownerId, approvalId)).toEqual({
      kind: 'unavailable',
    });
    expect(dangling.writes).toHaveLength(0);
  });

  it('does not register when current review fences fail and writes nothing', async () => {
    const f = fixture();
    const tx = { get: vi.fn(), create: vi.fn(), update: vi.fn() } as never;
    const result = await registerOwnerCallGrantOperationInTransaction(
      tx as never,
      f.store,
      {
        grantId,
        ownerId,
        approvalId,
        taskId,
        toolCallId,
        expectedGeneration: 0,
        requestFingerprint: fingerprint,
        grantScopeFingerprint: scopeFingerprint,
        reviewExpiresAt: new Date(now.getTime() + 60_000),
        grantExpiresAt: new Date(now.getTime() + 86_400_000),
      },
      async () => false,
    );
    expect(result.kind).toBe('conflict');
    expect((tx as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
    expect((tx as { update: ReturnType<typeof vi.fn> }).update).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(0);
  });

  it('rejects a second client at a stale slot generation', async () => {
    const f = fixture();
    const first = {
      grantId,
      ownerId,
      approvalId,
      taskId,
      toolCallId,
      expectedGeneration: 0,
      requestFingerprint: fingerprint,
      grantScopeFingerprint: scopeFingerprint,
      reviewExpiresAt: new Date(now.getTime() + 60_000),
      grantExpiresAt: new Date(now.getTime() + 86_400_000),
    };
    const register = async (input: typeof first) =>
      f.store.db.runTransaction((tx: any) =>
        registerOwnerCallGrantOperationInTransaction(tx, f.store, input, async () => true),
      );
    expect((await register(first)).kind).toBe('registered');
    expect(
      (await register({ ...first, grantId: '66666666-6666-4666-8666-666666666666' })).kind,
    ).toBe('conflict');
    expect(f.writes.filter((write) => write.kind === 'create')).toHaveLength(2);
  });

  it('requires current exact slot identity and valid fences before admit', async () => {
    const f = fixture();
    const first = {
      grantId,
      ownerId,
      approvalId,
      taskId,
      toolCallId,
      expectedGeneration: 0,
      requestFingerprint: fingerprint,
      grantScopeFingerprint: scopeFingerprint,
      reviewExpiresAt: new Date(now.getTime() + 60_000),
      grantExpiresAt: new Date(now.getTime() + 86_400_000),
    };
    await f.store.db.runTransaction((tx: any) =>
      registerOwnerCallGrantOperationInTransaction(tx, f.store, first, async () => true),
    );
    const result = await f.store.db.runTransaction((tx: any) =>
      admitOwnerCallGrantOperationInTransaction(
        tx as never,
        f.store,
        {
          ownerId,
          approvalId,
          grantId,
          taskId,
          toolCallId,
          requestFingerprint: fingerprint,
          grantScopeFingerprint: scopeFingerprint,
        },
        async () => false,
      ),
    );
    expect(result.kind).toBe('conflict');
    const accepted = await f.store.db.runTransaction((tx: any) =>
      admitOwnerCallGrantOperationInTransaction(
        tx as never,
        f.store,
        {
          ownerId,
          approvalId,
          grantId,
          taskId,
          toolCallId,
          requestFingerprint: fingerprint,
          grantScopeFingerprint: scopeFingerprint,
        },
        async () => true,
      ),
    );
    expect(accepted.kind).toBe('admitted');
  });

  it('keeps a held admitted operation as the cross-client slot barrier', async () => {
    const f = fixture();
    const first = {
      grantId,
      ownerId,
      approvalId,
      taskId,
      toolCallId,
      expectedGeneration: 0,
      requestFingerprint: fingerprint,
      grantScopeFingerprint: scopeFingerprint,
      reviewExpiresAt: new Date(now.getTime() + 60_000),
      grantExpiresAt: new Date(now.getTime() + 86_400_000),
    };
    await f.store.db.runTransaction((tx: any) =>
      registerOwnerCallGrantOperationInTransaction(tx, f.store, first, async () => true),
    );
    await f.store.db.runTransaction((tx: any) =>
      admitOwnerCallGrantOperationInTransaction(
        tx as never,
        f.store,
        {
          ownerId,
          approvalId,
          grantId,
          taskId,
          toolCallId,
          requestFingerprint: fingerprint,
          grantScopeFingerprint: scopeFingerprint,
        },
        async () => true,
      ),
    );
    const writesBefore = f.writes.length;
    const replacement = await f.store.db.runTransaction((tx: any) =>
      registerOwnerCallGrantOperationInTransaction(
        tx,
        f.store,
        { ...first, grantId: '66666666-6666-4666-8666-666666666666', expectedGeneration: 1 },
        async () => true,
      ),
    );
    expect(replacement.kind).toBe('busy');
    expect(f.writes).toHaveLength(writesBefore);
  });

  it('lets explicit close win against a later finalization plan without changing approval state', async () => {
    const f = fixture();
    const first = {
      grantId,
      ownerId,
      approvalId,
      taskId,
      toolCallId,
      expectedGeneration: 0,
      requestFingerprint: fingerprint,
      grantScopeFingerprint: scopeFingerprint,
      reviewExpiresAt: new Date(now.getTime() + 60_000),
      grantExpiresAt: new Date(now.getTime() + 86_400_000),
    };
    await f.store.db.runTransaction((tx: any) =>
      registerOwnerCallGrantOperationInTransaction(tx, f.store, first, async () => true),
    );
    await f.store.db.runTransaction((tx: any) =>
      admitOwnerCallGrantOperationInTransaction(
        tx as never,
        f.store,
        {
          ownerId,
          approvalId,
          grantId,
          taskId,
          toolCallId,
          requestFingerprint: fingerprint,
          grantScopeFingerprint: scopeFingerprint,
        },
        async () => true,
      ),
    );
    const closed = await f.store.db.runTransaction((tx: any) =>
      closeOwnerCallGrantOperationInTransaction(
        tx as never,
        f.store,
        {
          ownerId,
          approvalId,
          grantId,
          slotGeneration: 1,
          taskId,
          toolCallId,
          requestFingerprint: fingerprint,
          grantScopeFingerprint: scopeFingerprint,
        },
        async () => true,
      ),
    );
    expect(closed).toBe('closed_no_effect');
    const plan = await f.store.db.runTransaction((tx: any) =>
      prepareOwnerCallGrantCommitInTransaction(tx as never, f.store, {
        ownerId,
        approvalId,
        grantId,
        taskId,
        toolCallId,
        requestFingerprint: fingerprint,
        grantScopeFingerprint: scopeFingerprint,
      }),
    );
    expect(plan).toBeNull();
    expect(
      f.writes.some(
        (write) => write.kind === 'update' && write.id.startsWith('ownerCallGrantOperations/'),
      ),
    ).toBe(true);
    expect(
      f.writes.some((write) =>
        /^(approvals|toolCalls|approvalPolicies|tasks|outbox)\//.test(write.id),
      ),
    ).toBe(false);
  });

  it('does not admit at the original review expiry boundary', async () => {
    const f = fixture();
    const first = {
      grantId,
      ownerId,
      approvalId,
      taskId,
      toolCallId,
      expectedGeneration: 0,
      requestFingerprint: fingerprint,
      grantScopeFingerprint: scopeFingerprint,
      reviewExpiresAt: new Date(now.getTime() + 60_000),
      grantExpiresAt: new Date(now.getTime() + 86_400_000),
    };
    await f.store.db.runTransaction((tx: any) =>
      registerOwnerCallGrantOperationInTransaction(tx, f.store, first, async () => true),
    );
    const writesBefore = f.writes.length;
    f.store.setNow(first.reviewExpiresAt);
    const result = await f.store.db.runTransaction((tx: any) =>
      admitOwnerCallGrantOperationInTransaction(
        tx as never,
        f.store,
        {
          ownerId,
          approvalId,
          grantId,
          taskId,
          toolCallId,
          requestFingerprint: fingerprint,
          grantScopeFingerprint: scopeFingerprint,
        },
        async () => true,
      ),
    );
    expect(result.kind).toBe('conflict');
    expect(f.writes).toHaveLength(writesBefore);
  });

  it('records the exact task wake generation in the same transaction as caller approval, policy, and outbox writes', async () => {
    const f = fixture();
    const first = {
      grantId,
      ownerId,
      approvalId,
      taskId,
      toolCallId,
      expectedGeneration: 0,
      requestFingerprint: fingerprint,
      grantScopeFingerprint: scopeFingerprint,
      reviewExpiresAt: new Date(now.getTime() + 60_000),
      grantExpiresAt: new Date(now.getTime() + 86_400_000),
    };
    await f.store.db.runTransaction((tx: any) =>
      registerOwnerCallGrantOperationInTransaction(tx, f.store, first, async () => true),
    );
    await f.store.db.runTransaction((tx: any) =>
      admitOwnerCallGrantOperationInTransaction(
        tx as never,
        f.store,
        {
          ownerId,
          approvalId,
          grantId,
          taskId,
          toolCallId,
          requestFingerprint: fingerprint,
          grantScopeFingerprint: scopeFingerprint,
        },
        async () => true,
      ),
    );
    const generation = 9;
    const committed = await f.store.db.runTransaction(async (tx: any) => {
      const plan = await prepareOwnerCallGrantCommitInTransaction(tx as never, f.store, {
        ownerId,
        approvalId,
        grantId,
        taskId,
        toolCallId,
        requestFingerprint: fingerprint,
        grantScopeFingerprint: scopeFingerprint,
      });
      if (!plan) throw new Error('expected admitted operation');
      // These stand in for the writes already owned by FirestoreApprovalRepository.resolve().
      tx.update(f.store.doc('approvals', approvalId), { status: 'approved' });
      tx.update(f.store.doc('toolCalls', toolCallId), { status: 'approved' });
      tx.create(f.store.doc('approvalPolicies', policyId), {
        id: policyId,
        agentId: ownerId,
        enabled: true,
      });
      tx.update(f.store.doc('tasks', taskId), { status: 'pending', queueGeneration: generation });
      createWakeIntent(tx, f.store, { taskId, generation, availableAt: now });
      return commitOwnerCallGrantOperationInTransaction(tx as never, f.store, plan, {
        policyId,
        wakeGeneration: generation,
        grantScopeFingerprint: scopeFingerprint,
      });
    });
    expect(committed?.phase).toBe('committed');
    expect(committed?.wakeGeneration).toBe(generation);
    expect(f.rows.get(`outbox/${documentKey(wakeIntentId(taskId, generation))}`)).toMatchObject({
      taskId,
      generation,
    });
    expect(
      f.writes.some(
        (write) => write.id === `outbox/${documentKey(wakeIntentId(taskId, generation))}`,
      ),
    ).toBe(true);
  });

  it('aborts the caller transaction if metadata commit validation fails after caller writes were staged', async () => {
    const f = fixture();
    const first = {
      grantId,
      ownerId,
      approvalId,
      taskId,
      toolCallId,
      expectedGeneration: 0,
      requestFingerprint: fingerprint,
      grantScopeFingerprint: scopeFingerprint,
      reviewExpiresAt: new Date(now.getTime() + 60_000),
      grantExpiresAt: new Date(now.getTime() + 86_400_000),
    };
    await f.store.db.runTransaction((tx: any) =>
      registerOwnerCallGrantOperationInTransaction(tx, f.store, first, async () => true),
    );
    await f.store.db.runTransaction((tx: any) =>
      admitOwnerCallGrantOperationInTransaction(
        tx as never,
        f.store,
        {
          ownerId,
          approvalId,
          grantId,
          taskId,
          toolCallId,
          requestFingerprint: fingerprint,
          grantScopeFingerprint: scopeFingerprint,
        },
        async () => true,
      ),
    );
    const writesBefore = f.writes.length;
    await expect(
      f.store.db.runTransaction(async (tx: any) => {
        const plan = await prepareOwnerCallGrantCommitInTransaction(tx as never, f.store, {
          ownerId,
          approvalId,
          grantId,
          taskId,
          toolCallId,
          requestFingerprint: fingerprint,
          grantScopeFingerprint: scopeFingerprint,
        });
        tx.update(f.store.doc('approvals', approvalId), { status: 'approved' });
        tx.update(f.store.doc('toolCalls', toolCallId), { status: 'approved' });
        tx.create(f.store.doc('approvalPolicies', policyId), {
          id: policyId,
          agentId: ownerId,
          enabled: true,
        });
        tx.update(f.store.doc('tasks', taskId), { status: 'pending', queueGeneration: 9 });
        createWakeIntent(tx, f.store, { taskId, generation: 9, availableAt: now });
        return commitOwnerCallGrantOperationInTransaction(tx as never, f.store, plan, {
          policyId: 'not-a-uuid',
          wakeGeneration: 9,
          grantScopeFingerprint: scopeFingerprint,
        });
      }),
    ).rejects.toBeInstanceOf(OwnerCallOperationCommitAbort);
    expect(f.writes).toHaveLength(writesBefore);
    expect(f.rows.has(`approvals/${documentKey(approvalId)}`)).toBe(false);
    expect(f.rows.has(`outbox/${documentKey(wakeIntentId(taskId, 9))}`)).toBe(false);
  });

  it('finds an exact historical operation after slot advance and reports enabled, expired, and changed policy state', async () => {
    const f = fixture();
    const expiry = new Date(now.getTime() + 60 * 60_000);
    const match = {
      schemaVersion: 1,
      grantId,
      recipientE164: '+14155550123',
      maxMinutes: 5,
      expiresAt: expiry.toISOString(),
    };
    const actualScope = phoneCallOwnerNumberGrantScopeFingerprint(match);
    expect(actualScope).toMatch(/^[a-f0-9]{64}$/);
    for (const [collection, id, row] of [
      ['approvals', approvalId, { id: approvalId, taskId, toolCallId, status: 'pending' }],
      ['tasks', taskId, { id: taskId, agentId: ownerId, status: 'waiting_approval' }],
      [
        'toolCalls',
        toolCallId,
        { id: toolCallId, taskId, toolName: 'phone.call', status: 'awaiting_approval' },
      ],
    ] as const)
      f.rows.set(`${collection}/${documentKey(id)}`, row);
    const first = {
      grantId,
      ownerId,
      approvalId,
      taskId,
      toolCallId,
      expectedGeneration: 0,
      requestFingerprint: fingerprint,
      grantScopeFingerprint: actualScope!,
      reviewExpiresAt: new Date(now.getTime() + 30_000),
      grantExpiresAt: expiry,
    };
    await f.store.db.runTransaction((tx: any) =>
      registerOwnerCallGrantOperationInTransaction(tx, f.store, first, async () => true),
    );
    await f.store.db.runTransaction((tx: any) =>
      admitOwnerCallGrantOperationInTransaction(
        tx as never,
        f.store,
        {
          ownerId,
          approvalId,
          grantId,
          taskId,
          toolCallId,
          requestFingerprint: fingerprint,
          grantScopeFingerprint: actualScope!,
        },
        async () => true,
      ),
    );
    await f.store.db.runTransaction(async (tx: any) => {
      const plan = await prepareOwnerCallGrantCommitInTransaction(tx as never, f.store, {
        ownerId,
        approvalId,
        grantId,
        taskId,
        toolCallId,
        requestFingerprint: fingerprint,
        grantScopeFingerprint: actualScope!,
      });
      if (!plan) throw new Error('expected admitted operation');
      tx.update(f.store.doc('approvals', approvalId), { status: 'approved' });
      tx.update(f.store.doc('toolCalls', toolCallId), { status: 'approved' });
      tx.create(f.store.doc('approvalPolicies', policyId), {
        id: policyId,
        agentId: ownerId,
        toolName: 'phone.call',
        templateKey: 'phone.call.to_owner_number.v1',
        effect: 'allow',
        enabled: true,
        match,
      });
      tx.update(f.store.doc('tasks', taskId), { status: 'pending', queueGeneration: 9 });
      createWakeIntent(tx, f.store, { taskId, generation: 9, availableAt: now });
      commitOwnerCallGrantOperationInTransaction(tx as never, f.store, plan, {
        policyId,
        wakeGeneration: 9,
        grantScopeFingerprint: actualScope!,
      });
    });
    const secondId = '66666666-6666-4666-8666-666666666666';
    await f.store.db.runTransaction((tx: any) =>
      registerOwnerCallGrantOperationInTransaction(
        tx,
        f.store,
        {
          ...first,
          grantId: secondId,
          expectedGeneration: 1,
          reviewExpiresAt: new Date(now.getTime() + 90_000),
          grantExpiresAt: new Date(now.getTime() + 2 * 60 * 60_000),
        },
        async () => true,
      ),
    );
    const current = await readOwnerCallGrantOperationStatus(f.store, {
      ownerId,
      approvalId,
      grantId: secondId,
    });
    expect(current).toMatchObject({
      kind: 'status',
      relation: 'current',
      operation: { grantId: secondId },
    });
    const historical = await readOwnerCallGrantOperationStatus(f.store, {
      ownerId,
      approvalId,
      grantId,
    });
    expect(historical).toMatchObject({
      kind: 'status',
      relation: 'historical',
      operation: { grantId },
      policyAvailability: 'enabled',
    });
    expect(f.readCounts.at(-1)).toBeLessThanOrEqual(6);
    f.store.setNow(new Date(now.getTime() + 2 * 60 * 60_000));
    const expired = await readOwnerCallGrantOperationStatus(f.store, {
      ownerId,
      approvalId,
      grantId,
    });
    expect(expired).toMatchObject({
      kind: 'status',
      relation: 'historical',
      policyAvailability: 'expired',
    });
    f.rows.set(`approvalPolicies/${documentKey(policyId)}`, {
      ...(f.rows.get(`approvalPolicies/${documentKey(policyId)}`) as object),
      match: { ...match, recipientE164: '+14155550124' },
    });
    const changed = await readOwnerCallGrantOperationStatus(f.store, {
      ownerId,
      approvalId,
      grantId,
    });
    expect(changed).toMatchObject({
      kind: 'status',
      relation: 'historical',
      policyAvailability: 'changed',
    });
  });

  it('reads status without writes and returns unavailable for a dangling pointer', async () => {
    const f = fixture();
    for (const [collection, id, row] of [
      ['approvals', approvalId, { id: approvalId, taskId, toolCallId, status: 'pending' }],
      ['tasks', taskId, { id: taskId, agentId: ownerId }],
      ['toolCalls', toolCallId, { id: toolCallId, taskId }],
    ] as const)
      f.rows.set(`${collection}/${documentKey(id)}`, row);
    const slotKey = createHash('sha256')
      .update(JSON.stringify(['owner-call-grant-slot-v1', ownerId, approvalId]))
      .digest('hex');
    f.rows.set(`ownerCallGrantOperationSlots/${documentKey(slotKey)}`, {
      purpose: 'owner-call-grant-operation.v1',
      schemaVersion: 1,
      ownerId,
      approvalId,
      generation: 1,
      currentGrantId: grantId,
      updatedAt: now,
    });
    const status = await readOwnerCallGrantOperationStatus(f.store, {
      ownerId,
      approvalId,
      grantId,
    });
    expect(status.kind).toBe('unavailable');
    expect(f.writes).toHaveLength(0);
  });

  it('recognizes only the exact current v2 action grant scope in historical status', async () => {
    const f = fixture();
    const expiry = new Date(now.getTime() + 60 * 60_000);
    const match = {
      schemaVersion: 2,
      grantId,
      action: 'phone.call',
      recipientE164: '+14155550123',
      maxMinutes: 5,
      maxCallsPerHour: 2,
      maxCallsPerDay: 4,
      maxCostUsdMicrosPerCall: 100_000,
      maxCostUsdMicrosPerDay: 300_000,
      expiresAt: expiry.toISOString(),
    };
    const actualScope = phoneCallOwnerActionGrantScopeFingerprint(match);
    expect(actualScope).toMatch(/^[a-f0-9]{64}$/);
    for (const [collection, id, row] of [
      ['approvals', approvalId, { id: approvalId, taskId, toolCallId, status: 'pending' }],
      ['tasks', taskId, { id: taskId, agentId: ownerId, status: 'waiting_approval' }],
      [
        'toolCalls',
        toolCallId,
        { id: toolCallId, taskId, toolName: 'phone.call', status: 'awaiting_approval' },
      ],
    ] as const)
      f.rows.set(`${collection}/${documentKey(id)}`, row);
    const first = {
      grantId,
      ownerId,
      approvalId,
      taskId,
      toolCallId,
      expectedGeneration: 0,
      requestFingerprint: fingerprint,
      grantScopeFingerprint: actualScope!,
      reviewExpiresAt: new Date(now.getTime() + 30_000),
      grantExpiresAt: expiry,
    };
    await f.store.db.runTransaction((tx: any) =>
      registerOwnerCallGrantOperationInTransaction(tx, f.store, first, async () => true),
    );
    await f.store.db.runTransaction((tx: any) =>
      admitOwnerCallGrantOperationInTransaction(
        tx as never,
        f.store,
        {
          ownerId,
          approvalId,
          grantId,
          taskId,
          toolCallId,
          requestFingerprint: fingerprint,
          grantScopeFingerprint: actualScope!,
        },
        async () => true,
      ),
    );
    await f.store.db.runTransaction(async (tx: any) => {
      const plan = await prepareOwnerCallGrantCommitInTransaction(tx as never, f.store, {
        ownerId,
        approvalId,
        grantId,
        taskId,
        toolCallId,
        requestFingerprint: fingerprint,
        grantScopeFingerprint: actualScope!,
      });
      if (!plan) throw new Error('expected admitted operation');
      tx.update(f.store.doc('approvals', approvalId), { status: 'approved' });
      tx.update(f.store.doc('toolCalls', toolCallId), { status: 'approved' });
      tx.create(f.store.doc('approvalPolicies', policyId), {
        id: policyId,
        agentId: ownerId,
        toolName: 'phone.call',
        templateKey: 'phone.call.owner_action.v2',
        effect: 'allow',
        enabled: true,
        match,
      });
      tx.update(f.store.doc('tasks', taskId), { status: 'pending', queueGeneration: 9 });
      createWakeIntent(tx, f.store, { taskId, generation: 9, availableAt: now });
      commitOwnerCallGrantOperationInTransaction(tx as never, f.store, plan, {
        policyId,
        wakeGeneration: 9,
        grantScopeFingerprint: actualScope!,
      });
    });
    expect(
      await readOwnerCallGrantOperationStatus(f.store, { ownerId, approvalId, grantId }),
    ).toMatchObject({ kind: 'status', relation: 'current', policyAvailability: 'enabled' });
    f.rows.set(`approvalPolicies/${documentKey(policyId)}`, {
      ...(f.rows.get(`approvalPolicies/${documentKey(policyId)}`) as object),
      match: { ...match, maxCallsPerHour: 3 },
    });
    expect(
      await readOwnerCallGrantOperationStatus(f.store, { ownerId, approvalId, grantId }),
    ).toMatchObject({ kind: 'status', relation: 'current', policyAvailability: 'changed' });
  });
});
