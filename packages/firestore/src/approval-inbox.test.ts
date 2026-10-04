import { randomUUID } from 'node:crypto';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { afterEach, describe, expect, it } from 'vitest';
import { FirestoreApprovalRepository } from './approvals.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore approval inbox', () => {
  let store: InstallationStore;
  let repository: FirestoreApprovalRepository;
  const now = new Date('2026-09-12T12:00:00.000Z');
  const owner = 'owner';

  afterEach(async () => {
    await disposeStore(store);
  });

  async function seed(input: {
    agentId?: string;
    status: 'pending' | 'approved' | 'denied' | 'expired';
    requestedAt: Date;
    expiresAt: Date;
    resolvedAt?: Date | null;
    resolutionPayload?: unknown;
    toolTaskMismatch?: boolean;
    missingTask?: boolean;
    missingTool?: boolean;
    malformedReference?: 'emptyTask' | 'oversizedTool';
  }) {
    const taskId = randomUUID();
    const toolCallId = randomUUID();
    const approvalId = randomUUID();
    await store.doc('tasks', taskId).set({
      id: taskId,
      agentId: input.agentId ?? owner,
      type: 'chat_turn',
      trust: 'owner',
      status: 'waiting_approval',
    });
    const toolTaskId = input.toolTaskMismatch ? randomUUID() : taskId;
    if (toolTaskId !== taskId) {
      await store.doc('tasks', toolTaskId).set({
        id: toolTaskId,
        agentId: owner,
        type: 'chat_turn',
        trust: 'owner',
        status: 'waiting_approval',
      });
    }
    await store.doc('toolCalls', toolCallId).set({
      id: toolCallId,
      taskId: toolTaskId,
      toolName: 'gmail.send',
      status: input.status === 'pending' ? 'awaiting_approval' : 'approved',
      decision: { riskTier: 'high' },
    });
    await store.doc('approvals', approvalId).set({
      id: approvalId,
      taskId,
      toolCallId,
      shortCode: `A${approvalId.slice(0, 8)}`,
      summary: `approval ${approvalId}`,
      payload: { secret: 'must stay out of history' },
      resolutionPayload: input.resolutionPayload ?? null,
      status: input.status,
      requestedAt: input.requestedAt,
      resolvedAt: input.resolvedAt ?? null,
      resolvedVia: input.status === 'pending' ? null : 'web',
      expiresAt: input.expiresAt,
      notifiedChannels: [],
      createdPolicyId: null,
    });
    if (input.malformedReference === 'emptyTask') {
      await store.doc('approvals', approvalId).update({ taskId: '' });
    }
    if (input.malformedReference === 'oversizedTool') {
      await store.doc('approvals', approvalId).update({ toolCallId: 'x'.repeat(1001) });
    }
    if (input.missingTask) await store.doc('tasks', taskId).delete();
    if (input.missingTool) await store.doc('toolCalls', toolCallId).delete();
    return approvalId;
  }

  it('continues through foreign rows and merges expired, epoch, and edited history', async () => {
    store = emulatorStore(() => now);
    repository = new FirestoreApprovalRepository(store);
    for (let i = 0; i < 101; i++) {
      await seed({
        agentId: 'foreign',
        status: 'pending',
        requestedAt: new Date('2026-09-01T00:00:00.000Z'),
        expiresAt: new Date('2026-09-13T00:00:00.000Z'),
      });
    }
    await store.doc('approvals', 'malformed-document').set({
      id: 'different-id',
      taskId: randomUUID(),
      toolCallId: randomUUID(),
      status: 'pending',
      requestedAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date('2026-09-13T00:00:00.000Z'),
    });
    await seed({
      status: 'pending',
      requestedAt: new Date('2026-09-01T00:00:01.000Z'),
      expiresAt: new Date('2026-09-13T00:00:00.000Z'),
      missingTask: true,
    });
    await seed({
      status: 'pending',
      requestedAt: new Date('2026-09-01T00:00:02.000Z'),
      expiresAt: new Date('2026-09-13T00:00:00.000Z'),
      missingTool: true,
    });
    await seed({
      status: 'pending',
      requestedAt: new Date('2026-09-01T00:00:02.500Z'),
      expiresAt: new Date('2026-09-13T00:00:00.000Z'),
      malformedReference: 'emptyTask',
    });
    await seed({
      status: 'pending',
      requestedAt: new Date('2026-09-01T00:00:02.750Z'),
      expiresAt: new Date('2026-09-13T00:00:00.000Z'),
      malformedReference: 'oversizedTool',
    });
    await seed({
      status: 'pending',
      requestedAt: new Date('2026-09-01T00:00:03.000Z'),
      expiresAt: new Date('2026-09-13T00:00:00.000Z'),
      toolTaskMismatch: true,
    });
    const pendingId = await seed({
      status: 'pending',
      requestedAt: new Date('2026-09-12T11:00:00.000Z'),
      expiresAt: new Date('2026-09-13T00:00:00.000Z'),
    });
    const boundaryId = await seed({
      status: 'pending',
      requestedAt: new Date('2026-09-12T09:00:00.000Z'),
      expiresAt: now,
    });
    const expiredId = await seed({
      status: 'pending',
      requestedAt: new Date('2026-09-10T00:00:00.000Z'),
      expiresAt: new Date('2026-09-12T10:00:00.000Z'),
    });
    const epochId = await seed({
      status: 'approved',
      requestedAt: new Date('1969-12-31T23:00:00.000Z'),
      expiresAt: new Date('1970-01-01T00:00:00.000Z'),
      resolvedAt: new Date(0),
    });
    const editedId = await seed({
      status: 'denied',
      requestedAt: new Date('2026-09-11T00:00:00.000Z'),
      expiresAt: new Date('2026-09-13T00:00:00.000Z'),
      resolvedAt: new Date('2026-09-12T11:30:00.000Z'),
      resolutionPayload: { changed: true },
    });
    const tieA = await seed({
      status: 'approved',
      requestedAt: new Date('2026-09-11T10:00:00.000Z'),
      expiresAt: new Date('2026-09-13T00:00:00.000Z'),
      resolvedAt: new Date('2026-09-12T11:00:00.000Z'),
    });
    const tieB = await seed({
      status: 'approved',
      requestedAt: new Date('2026-09-11T09:00:00.000Z'),
      expiresAt: new Date('2026-09-13T00:00:00.000Z'),
      resolvedAt: new Date('2026-09-12T11:00:00.000Z'),
    });

    await expect(repository.listInbox(owner, { now, recentLimit: 0 })).rejects.toThrow(
      'Invalid approval inbox limit',
    );
    const inbox = await repository.listInbox(owner, { now, recentLimit: 6 });
    expect(inbox.pending.map(({ approval }) => approval.id)).toEqual([pendingId]);
    expect(inbox.resolved.map(({ approval }) => approval.id)).toEqual([
      boundaryId,
      editedId,
      tieA > tieB ? tieA : tieB,
      tieA > tieB ? tieB : tieA,
      expiredId,
      epochId,
    ]);
    expect(inbox.resolved.find(({ approval }) => approval.id === boundaryId)?.approval.status).toBe(
      'pending',
    );
    expect(inbox.resolved.find(({ approval }) => approval.id === editedId)?.approval.edited).toBe(
      true,
    );
    expect(inbox.resolved[0]?.approval).not.toHaveProperty('payload');
    expect(inbox.resolved[0]?.approval).not.toHaveProperty('resolutionPayload');

    for (let i = 0; i < 51; i++) {
      await seed({
        status: 'pending',
        requestedAt: new Date(
          `2026-09-12T11:${String(2 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        ),
        expiresAt: new Date('2026-09-13T00:00:00.000Z'),
      });
    }
    const capped = await repository.listInbox(owner, { now });
    expect(capped.pending).toHaveLength(50);
    expect(capped.pending[0]?.approval.id).toBe(pendingId);
  });
});

describe('Firestore approval inbox scan guard', () => {
  it('fails explicitly after the bounded malformed-candidate scan', async () => {
    const now = new Date('2026-09-12T12:00:00.000Z');
    const owner = 'owner';
    let pages = 0;
    const query = {
      where() {
        return query;
      },
      orderBy() {
        return query;
      },
      startAfter() {
        return query;
      },
      limit() {
        return query;
      },
      async get() {
        pages += 1;
        const docs = Array.from({ length: 100 }, (_, index) => ({
          ref: { id: `malformed-${pages}-${index}` },
          data: () => ({
            id: '11111111-1111-4111-8111-111111111111',
            status: 'pending',
            requestedAt: new Date('2026-09-01T00:00:00.000Z'),
            expiresAt: new Date('2026-09-13T00:00:00.000Z'),
          }),
        })) as unknown as QueryDocumentSnapshot[];
        return { size: docs.length, docs };
      },
    };
    const fakeStore = {
      collection: () => query,
      now: () => now,
    } as unknown as InstallationStore;
    const repository = new FirestoreApprovalRepository(fakeStore);

    await expect(repository.listInbox(owner, { now })).rejects.toThrow(
      'Approval inbox pending scan exceeded its safety bound',
    );
    // The four inbox reads start together and share this fake query, so the
    // count is the pending scan's ten pages plus whatever the others read
    // before it failed: bounded, not exact.
    expect(pages).toBeGreaterThanOrEqual(10);
    expect(pages).toBeLessThanOrEqual(40);
  });
});
