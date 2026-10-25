import { randomUUID } from 'node:crypto';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/application/knowledge-graph';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ owner: vi.fn(), db: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: mocks.owner }));
vi.mock('@/lib/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server')>()),
  getDb: mocks.db,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), unstable_cache: (run: unknown) => run }));
// The client controls call useRouter, which needs a mounted App Router.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore people directory with PostgreSQL offline', () => {
  const installationId = `web-people-${randomUUID()}`;
  const foreignInstallationId = `web-people-foreign-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const ownerId = randomUUID();
  const annaId = randomUUID();
  const maxId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const foreignStore = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId: foreignInstallationId,
  });
  const now = new Date();
  const birthday = new Date(now.getTime() + 5 * 24 * 3600 * 1000);
  let page: typeof import('./page.js');

  function person(id: string, name: string, relationship: string, trust: string) {
    return store.doc('contacts', id).set({
      id,
      agentId,
      name,
      relationship,
      trust,
      aliases: [],
      emails: [],
      phones: [],
      notes: '',
      createdAt: new Date('2026-09-01T00:00:00Z'),
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    });
  }

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', '(default)');
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"example-embedding","dimensions":768,"revision":"fixture-v1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('VERTEX_PROJECT', 'demo-assistant-test');
    vi.stubEnv('VERTEX_LOCATION', 'us-central1');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    mocks.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
    mocks.db.mockImplementation(() => {
      throw new Error('PostgreSQL is unreachable');
    });
    page = await import('./page.js');
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, name: 'Assistant', timezone: 'UTC' }),
      person(ownerId, 'Private owner', '', 'owner'),
      person(annaId, 'Anna Example', 'daughter', 'confirmed'),
      person(maxId, 'Max Example', 'colleague', 'unknown'),
      store.doc('memories', 'anna-fact').set({
        id: 'anna-fact',
        agentId,
        subjectContactId: annaId,
        category: 'knowledge',
        quarantined: false,
        expiresAt: null,
        createdAt: now,
        validFrom: null,
        contentHash: 'anna-fact-hash',
        embedding: [0.1],
        content: 'Anna lives in Reykjavík',
      }),
      store.doc('occasions', 'anna-birthday').set({
        id: 'anna-birthday',
        agentId,
        contactId: annaId,
        kind: 'birthday',
        label: '',
        month: birthday.getUTCMonth() + 1,
        day: birthday.getUTCDate(),
        year: null,
        recurrence: 'annual',
        leadDays: 7,
        quarantined: false,
      }),
      store.doc('knowledgeGraphEntities', 'anna-entity').set({
        id: 'anna-entity',
        agentId,
        contactId: annaId,
        kind: 'person',
        label: 'Anna',
        canonicalKey: `contact:${annaId}`,
        preferredLabel: null,
      }),
      store.doc('knowledgeGraphEntities', 'reykjavik-entity').set({
        id: 'reykjavik-entity',
        agentId,
        contactId: null,
        kind: 'place',
        label: 'Reykjavík',
        canonicalKey: 'place:reykjavik',
        preferredLabel: null,
      }),
      store.doc('knowledgeGraphSources', 'anna-fact').set({
        memoryId: 'anna-fact',
        status: 'ready',
        contentHash: 'anna-fact-hash',
        extractionVersion: GRAPH_EXTRACTION_VERSION,
      }),
      store.doc('knowledgeGraphRelations', 'anna-lives-in').set({
        id: 'anna-lives-in',
        agentId,
        subjectEntityId: 'anna-entity',
        objectEntityId: 'reykjavik-entity',
        predicate: 'lives_in',
        sourceMemoryId: 'anna-fact',
        reviewStatus: 'confirmed',
        evidenceQuote: 'Anna lives in Reykjavík',
        validUntil: null,
      }),
      foreignStore.doc('agents', foreignAgentId).set({ id: foreignAgentId, name: 'Foreign' }),
      foreignStore.doc('contacts', 'foreign').set({
        id: 'foreign',
        name: 'Foreign private person',
        relationship: 'friend',
        trust: 'confirmed',
      }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      store.db.recursiveDelete(store.root),
      foreignStore.db.recursiveDelete(foreignStore.root),
    ]);
    await Promise.all([store.db.terminate(), foreignStore.db.terminate()]);
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  const params = (q?: string) => ({ searchParams: Promise.resolve(q ? { q } : {}) });

  it('admits directory reads and blocks Server Actions through the Firestore proxy', async () => {
    const { proxy } = await import('../../proxy.js');
    const request = (path: string, method = 'GET') =>
      new NextRequest(`http://localhost${path}`, { method });
    expect(proxy(request('/people')).status).toBe(200);
    expect(proxy(request('/people', 'POST')).status).toBe(405);
    expect(proxy(request('/people', 'DELETE')).status).toBe(405);
    expect(proxy(request('/people/anna')).status).toBe(307);
  });

  it('renders the browse directory without add-person controls or PostgreSQL', async () => {
    const html = renderToStaticMarkup(await page.default(params()));
    expect(mocks.owner).toHaveBeenCalled();
    expect(mocks.db).not.toHaveBeenCalled();
    expect(html).not.toContain('Add person');
    expect(html).toContain('Coming up');
    expect(html).toContain('Anna Example');
    expect(html).toContain('Reykjavík');
    expect(html).toContain('Max Example');
    expect(html).toContain('daughter');
    expect(html).toContain('Unverified');
    expect(html).toContain(`href="/people/${annaId}"`);
    expect(html).toContain(`href="/people/${maxId}"`);
    expect(html).not.toContain('Private owner');
    expect(html).not.toContain(`href="/people/${ownerId}"`);
    expect(html).not.toContain('Foreign private person');
  });

  it('adds a person through the shared Server Action in Firestore', async () => {
    const { createPersonAction } = await import('@/app/profile/actions');
    const result = await createPersonAction({
      name: 'Grace Example',
      relationship: 'friend',
      aliases: 'Gracie',
    });
    expect(result.error).toBeUndefined();
    expect(result.contactId).toEqual(expect.any(String));
    const saved = await store.doc('contacts', result.contactId as string).get();
    expect(saved.get('name')).toBe('Grace Example');
    const html = renderToStaticMarkup(await page.default(params()));
    expect(html).toContain('Grace Example');
    expect(html).toContain(`href="/people/${result.contactId}"`);
    expect(mocks.db).not.toHaveBeenCalled();
  });

  it('searches names, relationships, and places', async () => {
    const html = renderToStaticMarkup(await page.default(params('daughter')));
    expect(html).toContain('Anna Example');
    expect(html).not.toContain('Max Example');
    const place = renderToStaticMarkup(await page.default(params('reykjav')));
    expect(place).toContain('Anna Example');
    expect(place).not.toContain('Max Example');
  });

  it('authenticates before reading the directory', async () => {
    mocks.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default(params())).rejects.toThrow('owner authentication required');
  });

  it('rejects a configured agent mismatch and ambiguous installation', async () => {
    vi.stubEnv('FIRESTORE_AGENT_ID', foreignAgentId);
    resetConfigForTest();
    try {
      await expect(page.default(params())).rejects.toThrow('exactly one configured agent');
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
    await store.doc('agents', foreignAgentId).set({ id: foreignAgentId });
    try {
      await expect(page.default(params())).rejects.toThrow('exactly one configured agent');
    } finally {
      await store.doc('agents', foreignAgentId).delete();
    }
  });

  it('fails closed while privacy erasure is active', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(page.default(params())).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });
});
