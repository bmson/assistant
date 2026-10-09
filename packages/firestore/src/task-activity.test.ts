import { randomUUID } from 'node:crypto';
import {
  chatAdmissionCancellationTrigger,
  chatAdmissionExternalEventId,
} from '@assistant/persistence';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from './store.js';
import { FirestoreTaskActivityRepository } from './task-activity.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore Activity list', () => {
  let store: InstallationStore;
  const agentId = 'owner';

  afterEach(async () => {
    await disposeStore(store);
  });

  async function seedTask(
    n: number,
    over: Partial<{
      status: string;
      updatedAt: Date;
      archivedAt: Date | null;
      canary: boolean;
      agentId: string;
    }> = {},
  ) {
    const id = `task-${String(n).padStart(4, '0')}`;
    await store.doc('tasks', id).set({
      id,
      agentId: over.agentId ?? agentId,
      type: 'chat_turn',
      status: over.status ?? 'done',
      title: `Task ${n}`,
      progress: '',
      trust: 'owner',
      spentUsd: '0',
      budgetUsdLimit: '1',
      updatedAt: over.updatedAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
      archivedAt: over.archivedAt ?? null,
      autonomyGrant: null,
      trigger: { source: 'chat', payload: over.canary ? { canary: true } : {} },
    });
    return id;
  }

  async function seedCancellationMarker(n: number, updatedAt: Date) {
    const id = `marker-${String(n).padStart(4, '0')}`;
    const conversationId = 'marker-conversation';
    const clientOperationId = randomUUID();
    await store.doc('tasks', id).set({
      id,
      agentId,
      conversationId,
      externalEventId: chatAdmissionExternalEventId({ agentId, conversationId, clientOperationId }),
      type: 'chat_turn',
      status: 'cancelled',
      title: null,
      progress: '',
      trust: 'owner',
      spentUsd: '0.000000',
      budgetUsdLimit: '0.5000',
      updatedAt,
      archivedAt: null,
      autonomyGrant: null,
      trigger: chatAdmissionCancellationTrigger({ agentId, conversationId, clientOperationId }),
    });
    return id;
  }

  async function seedAgent() {
    store = emulatorStore();
    await store.doc('agents', agentId).set({ id: agentId, name: 'Owner' });
  }

  const list = (input: { archived?: boolean; statuses?: string[]; limit?: number } = {}) =>
    new FirestoreTaskActivityRepository(store).list(agentId, {
      archived: input.archived ?? false,
      ...(input.statuses ? { statuses: input.statuses } : {}),
      limit: input.limit ?? 50,
    });

  it('returns the newest tasks across page boundaries without reading the rest', async () => {
    await seedAgent();
    // 250 tasks: more than two pages of 100, so the newest fifty and the cut
    // between pages are both exercised.
    for (let n = 1; n <= 250; n += 1) await seedTask(n);
    const result = await list();
    expect(result.tasks).toHaveLength(50);
    expect(result.tasks.map((task) => task.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `task-${String(250 - index).padStart(4, '0')}`),
    );
    expect(result.archivedCount).toBe(0);
  });

  it('skips cancellation markers across page boundaries before applying the list limit', async () => {
    await seedAgent();
    const ordinary = await seedTask(1, { updatedAt: new Date('2026-01-01T00:00:00Z') });
    const markerTime = new Date('2026-02-01T00:00:00Z');
    let newestMarker = '';
    for (let n = 1; n <= 101; n += 1) newestMarker = await seedCancellationMarker(n, markerTime);
    const result = await list({ limit: 1 });
    expect(result.tasks.map((task) => task.id)).toEqual([ordinary]);
    expect(result.tasks.some((task) => task.id === newestMarker)).toBe(false);
    await expect(
      new FirestoreTaskActivityRepository(store).getDetail(agentId, newestMarker, { pageSize: 1 }),
    ).resolves.toBeNull();
  });

  it('skips archived and canary tasks, and counts the archived ones', async () => {
    await seedAgent();
    for (let n = 1; n <= 10; n += 1) await seedTask(n);
    // Newer than everything, but not for this list.
    await seedTask(11, {
      archivedAt: new Date('2026-02-01T00:00:00Z'),
      updatedAt: new Date('2026-02-01T00:00:00Z'),
    });
    await seedTask(12, { canary: true, updatedAt: new Date('2026-02-02T00:00:00Z') });
    await seedTask(13, { agentId: 'someone-else', updatedAt: new Date('2026-02-03T00:00:00Z') });
    const live = await list({ limit: 5 });
    expect(live.tasks.map((task) => task.id)).toEqual([
      'task-0010',
      'task-0009',
      'task-0008',
      'task-0007',
      'task-0006',
    ]);
    // Archived tasks are counted from the whole collection, not from the page read.
    expect(live.archivedCount).toBe(1);
    const archived = await list({ archived: true });
    expect(archived.tasks.map((task) => task.id)).toEqual(['task-0011']);
  });

  it('breaks a tie between tasks stamped with the same instant by id, as a full read would', async () => {
    await seedAgent();
    const stamped = new Date('2026-03-01T00:00:00Z');
    // 120 tasks archived in one sweep share one timestamp; a limit of 50 lands
    // in the middle of the tie and must still take the lowest ids.
    for (let n = 1; n <= 120; n += 1)
      await seedTask(n, { archivedAt: stamped, updatedAt: stamped });
    const result = await list({ archived: true, limit: 50 });
    expect(result.tasks.map((task) => task.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `task-${String(index + 1).padStart(4, '0')}`),
    );
    expect(result.archivedCount).toBe(120);
  });

  it('finds a rare status by its own index instead of walking past everything else', async () => {
    await seedAgent();
    for (let n = 1; n <= 150; n += 1) await seedTask(n);
    await seedTask(151, { status: 'needs_attention', updatedAt: new Date('2025-01-01T00:00:00Z') });
    await seedTask(152, { status: 'failed', updatedAt: new Date('2025-06-01T00:00:00Z') });
    const result = await list({ statuses: ['needs_attention', 'failed'] });
    expect(result.tasks.map((task) => task.id)).toEqual(['task-0152', 'task-0151']);
  });

  it('flags only the waiting tasks that still have a pending approval', async () => {
    await seedAgent();
    const waiting = await seedTask(1, { status: 'waiting_approval' });
    const settled = await seedTask(2, { status: 'waiting_approval' });
    await store.doc('approvals', 'a-1').set({ id: 'a-1', taskId: waiting, status: 'pending' });
    await store.doc('approvals', 'a-2').set({ id: 'a-2', taskId: settled, status: 'approved' });
    const result = await list();
    expect(result.pendingApprovalTaskIds).toEqual([waiting]);
  });
});
