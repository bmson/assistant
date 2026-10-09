import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.owner }));

const workspace = {
  listPage: vi.fn(async () => ({
    items: [{ name: 'ready.txt', dir: false }],
    hasMore: false,
    nextCursor: null,
    consistency: 'process-snapshot' as const,
  })),
};
vi.mock('@/lib/server', () => ({
  getApplication: () => {
    throw new Error('PostgreSQL application must not be created');
  },
  getWorkspace: () => workspace,
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore owner import page with PostgreSQL offline', () => {
  const installationId = `web-import-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let page: typeof import('./page.js');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
    page = await import('./page.js');

    const now = new Date();
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('importSources', 'source-one').set({
        id: 'source-one',
        agentId,
        source: 'Old notes',
        workspacePath: 'import/old-notes.txt',
        kind: 'text',
        status: 'done',
        taskId: null,
        itemsTotal: 2,
        itemsProcessed: 2,
        memoriesSaved: 1,
        memoriesQuarantined: 1,
        error: null,
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('memories', 'held-one').set({
        id: 'held-one',
        agentId,
        quarantined: true,
        source: 'Old notes',
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('renders import history, local workspace files, and their actions', async () => {
    const { proxy } = await import('../../proxy.js');
    expect(proxy(new NextRequest('http://localhost/import')).status).toBe(307);
    expect(proxy(new NextRequest('http://localhost/import', { method: 'POST' })).status).toBe(410);
    expect(
      proxy(new NextRequest('http://localhost/api/import/upload', { method: 'POST' })).status,
    ).toBe(200);
    const html = renderToStaticMarkup(await page.default());
    expect(html).toContain('Old notes');
    expect(html).toContain('ready.txt');
    expect(workspace.listPage).toHaveBeenCalledWith('import', { cursor: null, limit: 50 });
    expect(html).toContain('1 need review');
    expect(html).toContain('action="/api/import/upload"');
    expect(html).toContain('Approve all');
  });

  it('requires owner authentication', async () => {
    auth.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default()).rejects.toThrow('owner authentication required');
  });

  it('fails closed during privacy erasure', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(page.default()).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });

  it('refuses multiple agents in the installation', async () => {
    await store.doc('agents', foreignAgentId).set({ id: foreignAgentId });
    try {
      await expect(page.default()).rejects.toThrow('one matching configured owner');
    } finally {
      await store.doc('agents', foreignAgentId).delete();
    }
  });
});
