import { randomUUID } from 'node:crypto';
import { listActivityWithRepository } from '@assistant/application/tasks';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore, FirestoreTaskActivityRepository } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ allowed: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile Activity GET with PostgreSQL offline', () => {
  const installationId = `mobile-activity-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let route: typeof import('./route.js');

  const task = (id: string, patch: Record<string, unknown> = {}) => ({
    id,
    agentId,
    type: 'root',
    status: 'running',
    title: id,
    progress: 'Working',
    trust: 'owner',
    spentUsd: '1.25',
    budgetUsdLimit: '5.00',
    updatedAt: new Date('2026-09-22T12:00:00Z'),
    archivedAt: null,
    autonomyGrant: null,
    trigger: { payload: {} },
    ...patch,
  });

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"fixture","dimensions":768,"revision":"1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.allowed.mockResolvedValue(true);
    route = await import('./route.js');
    const now = new Date();
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('tasks', 'approval').set(
        task('approval', {
          status: 'waiting_approval',
          updatedAt: new Date('2026-09-22T15:00:00Z'),
        }),
      ),
      store.doc('tasks', 'stuck').set(
        task('stuck', {
          status: 'waiting_approval',
          updatedAt: new Date('2026-09-22T14:00:00Z'),
        }),
      ),
      store.doc('tasks', 'running').set(
        task('running', {
          autonomyGrant: {
            grantedAt: now.toISOString(),
            grantedVia: 'composer',
            expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
          },
        }),
      ),
      store
        .doc('tasks', 'archived')
        .set(task('archived', { status: 'done', archivedAt: new Date('2026-09-20T12:00:00Z') })),
      store.doc('tasks', 'archived-canary').set(
        task('archived-canary', {
          status: 'done',
          archivedAt: new Date('2026-09-20T12:00:00Z'),
          trigger: { payload: { canary: true } },
        }),
      ),
      store
        .doc('tasks', 'current-canary')
        .set(task('current-canary', { trigger: { payload: { canary: 'true' } } })),
      store.doc('tasks', 'foreign').set(task('foreign', { agentId: foreignAgentId })),
      store
        .doc('approvals', 'pending')
        .set({ id: 'pending', taskId: 'approval', status: 'pending' }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  const get = (query = '') =>
    route.GET(new Request(`http://localhost/api/mobile/v1/activity${query}`));

  it('allows only GET and returns the owner list with SQL ordering and flags', async () => {
    const { proxy } = await import('../../../../../proxy.js');
    expect(proxy(new NextRequest('http://localhost/api/mobile/v1/activity')).status).toBe(200);
    expect(
      proxy(new NextRequest('http://localhost/api/mobile/v1/activity', { method: 'POST' })).status,
    ).toBe(200);
    expect(proxy(new NextRequest('http://localhost/api/mobile/v1/activity/123')).status).toBe(503);
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.archivedCount).toBe(2);
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      'approval',
      'stuck',
      'running',
    ]);
    expect(body.items[0]).toMatchObject({ hasPendingApproval: true, stuckWaiting: false });
    expect(body.items[1]).toMatchObject({ hasPendingApproval: false, stuckWaiting: true });
    expect(body.items[2]).toMatchObject({ hasActiveAutonomy: true });
  });

  it('keeps archived and application filter semantics', async () => {
    const archived = await (await get('?archived=true')).json();
    expect(archived.items.map((item: { id: string }) => item.id)).toEqual(['archived']);
    expect(archived.archivedCount).toBe(2);
    const working = await listActivityWithRepository(
      new FirestoreTaskActivityRepository(store),
      agentId,
      { archived: false, filter: 'working', limit: 2 },
    );
    expect(working.items.map((item) => item.id)).toEqual(['running']);
  });

  it('archives only old terminal owner tasks and is idempotent', async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await Promise.all([
      store.doc('tasks', 'old-done').set(task('old-done', { status: 'done', updatedAt: old })),
      store
        .doc('tasks', 'old-failed')
        .set(task('old-failed', { status: 'failed', updatedAt: old })),
      store
        .doc('tasks', 'old-cancelled')
        .set(task('old-cancelled', { status: 'cancelled', updatedAt: old })),
      store.doc('tasks', 'old-running').set(task('old-running', { updatedAt: old })),
      store.doc('tasks', 'old-archived').set(
        task('old-archived', {
          status: 'done',
          archivedAt: new Date('2026-09-01T12:00:00Z'),
          updatedAt: old,
        }),
      ),
      store
        .doc('tasks', 'old-foreign')
        .set(task('old-foreign', { status: 'done', agentId: foreignAgentId, updatedAt: old })),
      store
        .doc('tasks', 'recent-done')
        .set(task('recent-done', { status: 'done', updatedAt: new Date() })),
    ]);
    const response = await route.POST(
      new Request('http://localhost/api/mobile/v1/activity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'archive-old' }),
      }),
    );
    expect(response.status).toBe(200);
    const archived = await Promise.all(
      ['old-done', 'old-failed', 'old-cancelled'].map(async (id) => ({
        id,
        snapshot: await store.doc('tasks', id).get(),
      })),
    );
    for (const { id, snapshot } of archived) {
      const archivedAt = snapshot.get('archivedAt').toDate();
      expect(archivedAt, id).toBeInstanceOf(Date);
      expect(snapshot.get('updatedAt').toDate().getTime()).toBe(archivedAt.getTime());
    }
    for (const id of ['old-running', 'recent-done', 'old-foreign']) {
      expect((await store.doc('tasks', id).get()).get('archivedAt')).toBeNull();
    }
    const existingArchived = await store.doc('tasks', 'old-archived').get();
    const preArchived = existingArchived.get('archivedAt').toDate();
    const preArchiveUpdatedAt = existingArchived.get('updatedAt').toDate();
    const second = await route.POST(
      new Request('http://localhost/api/mobile/v1/activity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'archive-old' }),
      }),
    );
    expect(second.status).toBe(200);
    const stillArchived = await store.doc('tasks', 'old-archived').get();
    expect(stillArchived.get('archivedAt').toDate()).toEqual(preArchived);
    expect(stillArchived.get('updatedAt').toDate()).toEqual(preArchiveUpdatedAt);
  });

  it('requires auth and keeps unsupported Firestore writes unavailable', async () => {
    auth.allowed.mockResolvedValueOnce(false);
    expect((await get()).status).toBe(401);
    const post = await route.POST(
      new Request('http://localhost/api/mobile/v1/activity', { method: 'POST' }),
    );
    expect(post.status).toBe(400);
    expect(await post.json()).toEqual({ error: 'Request body must be JSON.' });
  });

  it('blocks archive-old while privacy erasure is active', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(
        route.POST(
          new Request('http://localhost/api/mobile/v1/activity', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'archive-old' }),
          }),
        ),
      ).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });

  it('returns bounded durable continuation for more than 400 terminal tasks', async () => {
    const batch = store.db.batch();
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    for (let index = 0; index < 401; index += 1) {
      const id = `bulk-${index.toString().padStart(3, '0')}`;
      batch.set(store.doc('tasks', id), task(id, { status: 'done', updatedAt: old }));
    }
    await batch.commit();

    const firstResponse = await route.POST(
      new Request('http://localhost/api/mobile/v1/activity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'archive-old' }),
      }),
    );
    const first = (await firstResponse.json()) as {
      operationId: string;
      archivedTotal: number;
      complete: boolean;
    };
    expect(firstResponse.status).toBe(200);
    expect(first).toMatchObject({ archivedTotal: 250, complete: false });
    expect(first.operationId).toMatch(/^[0-9a-f-]{36}$/i);
    const remainingAfterFirst = await store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('archivedAt', '==', null)
      .where('status', '==', 'done')
      .get();
    expect(
      remainingAfterFirst.docs.filter((document) => String(document.get('id')).startsWith('bulk-')),
    ).toHaveLength(151);

    const nextResponse = await route.POST(
      new Request('http://localhost/api/mobile/v1/activity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'archive-old', operationId: first.operationId }),
      }),
    );
    await expect(nextResponse.json()).resolves.toMatchObject({
      archivedTotal: 401,
      complete: true,
    });
    const remainingAfterSecond = await store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('archivedAt', '==', null)
      .where('status', '==', 'done')
      .get();
    expect(
      remainingAfterSecond.docs.filter((document) =>
        String(document.get('id')).startsWith('bulk-'),
      ),
    ).toHaveLength(0);
  });

  it('fails closed during erasure and when the configured agent is missing', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(get()).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
    vi.stubEnv('FIRESTORE_AGENT_ID', foreignAgentId);
    resetConfigForTest();
    try {
      await expect(get()).rejects.toThrow('one matching configured agent');
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
  });

  it('fails closed when another agent appears in the installation', async () => {
    await store.doc('agents', foreignAgentId).set({ id: foreignAgentId });
    try {
      await expect(get()).rejects.toThrow('one matching configured agent');
    } finally {
      await store.doc('agents', foreignAgentId).delete();
    }
  });

  it('rejects a read when erasure completes before the final fence check', async () => {
    const originalDoc = store.doc.bind(store);
    let fenceReads = 0;
    const spy = vi.spyOn(store, 'doc').mockImplementation((collection, id) => {
      const ref = originalDoc(collection, id);
      if (collection === 'privacyErasureJobs' && id === agentId) {
        const get = ref.get.bind(ref);
        vi.spyOn(ref, 'get').mockImplementation(async () => {
          fenceReads += 1;
          if (fenceReads === 2)
            await originalDoc('privacyErasureJobs', agentId).set({ agentId, status: 'complete' });
          return get();
        });
      }
      return ref;
    });
    try {
      await expect(
        listActivityWithRepository(new FirestoreTaskActivityRepository(store), agentId, {
          archived: false,
          filter: 'all',
          limit: 50,
        }),
      ).rejects.toThrow('Privacy erasure changed during read');
      expect(fenceReads).toBe(2);
    } finally {
      spy.mockRestore();
      await originalDoc('privacyErasureJobs', agentId).delete();
    }
  });

  it('fails closed on malformed owner task data', async () => {
    await store.doc('tasks', 'malformed').set(task('malformed', { updatedAt: 'not-a-date' }));
    try {
      await expect(get()).rejects.toThrow('Invalid owner activity task');
    } finally {
      await store.doc('tasks', 'malformed').delete();
    }
  });
});
