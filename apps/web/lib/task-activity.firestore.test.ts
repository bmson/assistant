import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { Timestamp } from '@google-cloud/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const emulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(host);

describe.skipIf(!emulator)('web task Activity in Firestore mode with PostgreSQL offline', () => {
  const installationId = `web-task-activity-${randomUUID()}`;
  const agentId = randomUUID();
  const taskId = randomUUID();
  const oldTaskId = randomUUID();
  const foreignTaskId = randomUUID();
  const store = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId,
    databaseId: '(default)',
  });
  let activity: typeof import('./task-activity.js');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', '(default)');
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    activity = await import('./task-activity.js');
    const now = new Date('2026-09-20T12:00:00Z');
    const task = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      agentId,
      type: 'root',
      status: 'done',
      title: 'Completed task',
      trust: 'owner',
      spentUsd: '0.25',
      budgetUsdLimit: '2.00',
      updatedAt: now,
      deadline: null,
      nextAction: '',
      progress: 'Finished safely.',
      progressPercent: 100,
      plan: { summary: 'A bounded plan' },
      state: { requestChecklist: { items: [] } },
      archivedAt: null,
      autonomyGrant: null,
      trigger: { payload: {} },
      ...overrides,
    });
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, timezone: 'America/Los_Angeles' }),
      store.doc('tasks', taskId).set(task(taskId)),
      store
        .doc('tasks', oldTaskId)
        .set(task(oldTaskId, { updatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })),
      store.doc('tasks', foreignTaskId).set(task(foreignTaskId, { agentId: randomUUID() })),
      store.doc('toolCalls', 'activity-tool').set({
        id: 'activity-tool',
        taskId,
        createdAt: new Date('2026-09-20T12:04:00Z'),
        finishedAt: new Date('2026-09-20T12:04:01Z'),
        toolName: 'calendar.list_events',
        step: 1,
        status: 'succeeded',
        decision: { riskTier: 'low', policyId: 'safe-read' },
        args: { range: 'today' },
        result: { events: [{ title: 'Meeting' }] },
        error: null,
      }),
      store.doc('modelCalls', 'activity-model').set({
        id: 'activity-model',
        taskId,
        createdAt: new Date('2026-09-20T12:03:00Z'),
        role: 'planner',
        model: 'vertex/test-model',
        costUsd: '0.01',
        latencyMs: 25,
      }),
      store.doc('approvals', 'activity-approval').set({
        id: 'activity-approval',
        taskId,
        requestedAt: new Date('2026-09-20T12:02:00Z'),
        status: 'approved',
        summary: 'Read calendar',
        shortCode: 'ABCD',
        resolvedVia: 'web',
        resolvedAt: new Date('2026-09-20T12:02:30Z'),
      }),
      store.doc('messages', 'activity-message').set({
        id: 'activity-message',
        taskId,
        createdAt: new Date('2026-09-20T12:01:00Z'),
        role: 'assistant',
        text: 'Task finished.',
      }),
      store.doc('files', 'activity-file').set({
        id: 'activity-file',
        taskId,
        createdAt: new Date('2026-09-20T12:05:00Z'),
        workspacePath: 'documents/summary.pdf',
        bytes: 512,
      }),
    ]);
  });

  afterAll(async () => {
    const { getFirestoreInstallationStore } = await import('./server.js');
    const cachedStore = getFirestoreInstallationStore();
    await cachedStore.db.recursiveDelete(cachedStore.root);
    await cachedStore.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('lists and opens owner-scoped Activity detail without touching PostgreSQL', async () => {
    const { getDb } = await import('./server.js');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');

    const current = await activity.listTaskActivity({ archived: false, filter: 'all' });
    expect(current.items.map((item) => item.id)).toContain(taskId);
    const detail = await activity.getTaskActivityDetail(taskId);
    expect(detail).toMatchObject({
      timezone: 'America/Los_Angeles',
      task: { id: taskId, title: 'Completed task', plan: { truncated: false } },
      toolCalls: [{ id: 'activity-tool', riskTier: 'low', policyId: 'safe-read' }],
      modelCalls: [{ id: 'activity-model', model: 'vertex/test-model' }],
      approvals: [{ id: 'activity-approval', status: 'approved' }],
      messages: [{ id: 'activity-message', text: 'Task finished.' }],
      files: [{ id: 'activity-file', workspacePath: 'documents/summary.pdf' }],
      actions: [{ id: 'activity-tool', completed: true }],
    });
    expect(await activity.getTaskActivityDetail(foreignTaskId)).toBeNull();
  });

  it('pages equal-time and nanosecond audit entries without loss or repeats', async () => {
    const id = randomUUID();
    const baseline = (await store.doc('tasks', taskId).get()).data();
    await store.doc('tasks', id).set({ ...baseline, id });
    await Promise.all(
      Array.from({ length: 121 }, (_, index) => {
        const key = `timeline-${String(index).padStart(3, '0')}`;
        return store.doc('toolCalls', key).set({
          id: key,
          taskId: id,
          createdAt: new Timestamp(1_790_000_000, index < 101 ? 0 : index),
          finishedAt: null,
          toolName: 'web.fetch',
          step: index,
          status: 'succeeded',
          decision: {},
          args: {},
          result: { ok: true },
          error: null,
        });
      }),
    );
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      const page = await activity.getTaskActivityDetail(id, { pageSize: 25, cursor });
      if (!page) throw new Error('Missing timeline page');
      expect(page.toolCalls.length).toBeLessThanOrEqual(25);
      for (const row of page.toolCalls) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      if (!page.hasMoreTimeline) break;
      if (!page.nextTimelineCursor) throw new Error('Missing timeline cursor');
      cursor = page.nextTimelineCursor;
    }
    expect(seen.size).toBe(121);
  });

  it('allows only the Activity pages and Server Action methods through the Firestore proxy', async () => {
    const { proxy } = await import('../proxy.js');
    const status = (path: string, method = 'GET') =>
      proxy(new NextRequest(`http://localhost${path}`, { method })).status;
    expect(status('/tasks')).toBe(307);
    expect(status('/tasks', 'POST')).toBe(410);
    expect(status(`/tasks/${taskId}`)).toBe(307);
    expect(status(`/tasks/${taskId}`, 'POST')).toBe(410);
    expect(status(`/tasks/${taskId}`, 'DELETE')).toBe(410);
    expect(status('/tasks/not-a-uuid')).toBe(307);
    expect(status(`/tasks/${taskId}/nested`)).toBe(307);
  });

  it('archives, lists, restores, and bulk-archives through the owner activity commands', async () => {
    await activity.archiveTaskActivity(taskId);
    expect(
      (await activity.listTaskActivity({ archived: false, filter: 'all' })).items.some(
        (item) => item.id === taskId,
      ),
    ).toBe(false);
    expect(
      (await activity.listTaskActivity({ archived: true, filter: 'all' })).items.some(
        (item) => item.id === taskId,
      ),
    ).toBe(true);
    await activity.restoreTaskActivity(taskId);
    expect((await activity.getTaskActivityDetail(taskId))?.task.archivedAt).toBeNull();
    await activity.archiveOldTaskActivity();
    const archivedAt = (await store.doc('tasks', oldTaskId).get()).get('archivedAt');
    expect(archivedAt).toHaveProperty('toDate');
    expect(archivedAt.toDate()).toBeInstanceOf(Date);
  });
});
