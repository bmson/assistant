import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.owner }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore owner Memory hub page with PostgreSQL offline', () => {
  const installationId = `web-memory-hub-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const ownerId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let page: typeof import('./page.js');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"example-embedding","dimensions":768,"revision":"fixture-v1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
    page = await import('./page.js');

    const now = new Date();
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' }),
      store.doc('contacts', ownerId).set({
        id: ownerId,
        name: 'Owner',
        aliases: [],
        relationship: '',
        trust: 'owner',
      }),
      store.doc('memories', 'usable-owner-fact').set({
        id: 'usable-owner-fact',
        agentId,
        category: 'knowledge',
        subjectContactId: ownerId,
        quarantined: false,
        expiresAt: null,
        createdAt: now,
        content: 'Private owner fact',
        ownerConfirmed: true,
        lastConsolidatedAt: now,
      }),
      store.doc('memories', 'held-owner-fact').set({
        id: 'held-owner-fact',
        agentId,
        category: 'knowledge',
        subjectContactId: ownerId,
        quarantined: true,
        expiresAt: null,
        createdAt: now,
        content: 'Private held fact',
      }),
      store.doc('memories', 'foreign-fact').set({
        id: 'foreign-fact',
        agentId: foreignAgentId,
        category: 'knowledge',
        quarantined: true,
        expiresAt: null,
        createdAt: now,
        content: 'Foreign private fact',
      }),
      store.doc('recallFeedback', 'owner-feedback').set({
        id: 'owner-feedback',
        agentId,
        verdict: 'helpful',
        createdAt: now,
      }),
      store.doc('recallFeedback', 'foreign-feedback').set({
        id: 'foreign-feedback',
        agentId: foreignAgentId,
        verdict: 'not_helpful',
        createdAt: now,
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  const params = { searchParams: Promise.resolve({}) };

  it('admits only the new browse GETs and keeps retired page routes blocked', async () => {
    const { proxy } = await import('../../../proxy.js');
    const request = (path: string, method = 'GET') =>
      new NextRequest(`http://localhost${path}`, { method });
    for (const path of ['/profile', '/profile/knowledge']) {
      for (const method of ['GET', 'HEAD']) expect(proxy(request(path, method)).status).toBe(200);
      for (const method of ['POST', 'DELETE'])
        expect(proxy(request(path, method)).status).toBe(405);
    }
    for (const path of ['/profile/memories', '/profile/about']) {
      for (const method of ['GET', 'HEAD']) expect(proxy(request(path, method)).status).toBe(307);
      expect(proxy(request(path, 'POST')).status).toBe(410);
    }
  });

  it('renders only configured-owner memory and feedback through the page', async () => {
    const element = await page.default(params);
    const html = renderToStaticMarkup(element);
    expect(auth.owner).toHaveBeenCalled();
    expect(html).toContain('What I remember');
    expect(html).toContain('href="/profile/about"');
    expect(html).toContain('Private held fact');
    expect(html).toContain('1 fact about you');
    expect(html).toContain('1/1');
    expect(html).not.toContain('Foreign private fact');
    expect(html).not.toContain('Private owner fact');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('/profile/knowledge');
  });

  it('rejects unauthenticated reads before returning private data', async () => {
    auth.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default(params)).rejects.toThrow('owner authentication required');
  });

  it('fails closed when privacy erasure is active', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(page.default(params)).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });

  it('refuses a mismatched configured owner instead of reading another agent', async () => {
    vi.stubEnv('FIRESTORE_AGENT_ID', foreignAgentId);
    resetConfigForTest();
    try {
      await expect(page.default(params)).rejects.toThrow('one matching configured owner');
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
  });

  it('fails closed if another agent appears in the installation', async () => {
    await store.doc('agents', foreignAgentId).set({ id: foreignAgentId, name: 'Other assistant' });
    try {
      await expect(page.default(params)).rejects.toThrow(
        'Memory hub requires exactly one configured agent',
      );
    } finally {
      await store.doc('agents', foreignAgentId).delete();
    }
  });

  it('preserves the PostgreSQL deep-link redirect', async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'postgres');
    resetConfigForTest();
    const ownerCalls = auth.owner.mock.calls.length;
    try {
      await expect(
        page.default({ searchParams: Promise.resolve({ state: 'review' }) }),
      ).rejects.toThrow('NEXT_REDIRECT');
      expect(auth.owner.mock.calls).toHaveLength(ownerCalls);
    } finally {
      vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
      resetConfigForTest();
    }
  });
});
