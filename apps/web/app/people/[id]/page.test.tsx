import { randomUUID } from 'node:crypto';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/application/knowledge-graph';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore, embeddingSpaceKey } from '@assistant/firestore';
import { FieldValue } from '@google-cloud/firestore';
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

describe.skipIf(!localEmulator)('Firestore person detail with PostgreSQL offline', () => {
  const installationId = `web-person-${randomUUID()}`;
  const foreignInstallationId = `web-person-foreign-${randomUUID()}`;
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const contactId = randomUUID();
  const friendId = randomUUID();
  const foreignContactId = randomUUID();
  const ownerContactId = randomUUID();
  const factId = randomUUID();
  const eventId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const foreignStore = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId: foreignInstallationId,
  });
  const now = new Date();
  const embeddingSpace = {
    provider: 'vertex',
    model: 'example-embedding',
    dimensions: 768,
    revision: 'fixture-v1',
  } as const;
  const embedding = Array.from({ length: embeddingSpace.dimensions }, (_, index) =>
    index === 0 ? 1 : 0,
  );
  let page: typeof import('./page.js');
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  function person(id: string, name: string, patch: Record<string, unknown> = {}) {
    return store.doc('contacts', id).set({
      id,
      agentId,
      name,
      relationship: '',
      trust: 'known',
      aliases: [],
      emails: [],
      phones: [],
      notes: '',
      createdAt: new Date('2026-09-01T00:00:00Z'),
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      ...patch,
    });
  }

  function memory(id: string, content: string, patch: Record<string, unknown>) {
    return store.doc('memories', id).set({
      id,
      agentId,
      subjectContactId: contactId,
      content,
      contentHash: `${id}-hash`,
      kind: 'fact',
      category: 'knowledge',
      confidence: '0.70',
      importance: 3,
      quarantined: false,
      ownerConfirmed: false,
      pinned: false,
      originTrust: 'owner',
      domain: 'relationships',
      sourceTaskId: null,
      supersededById: null,
      lastConsolidatedAt: null,
      expiresAt: null,
      validFrom: null,
      validUntil: null,
      embedding: FieldValue.vector(embedding),
      embeddingSpace: embeddingSpaceKey(embeddingSpace),
      createdAt: now,
      ...patch,
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
      person(contactId, 'Anna Example', { relationship: 'daughter', trust: 'confirmed' }),
      person(friendId, 'Bob Example', { relationship: 'friend' }),
      person(ownerContactId, 'Owner private contact', { trust: 'owner' }),
      memory(factId, 'Anna is close friends with Bob', {}),
      memory(eventId, 'Went hiking with Anna', {
        kind: 'event',
        category: 'experience',
        embedding: null,
        validFrom: new Date('2026-09-10T00:00:00Z'),
      }),
      store.doc('occasions', 'anna-birthday').set({
        id: 'anna-birthday',
        agentId,
        contactId,
        kind: 'birthday',
        label: '',
        month: 3,
        day: 14,
        year: null,
        recurrence: 'annual',
        leadDays: 7,
        notes: '',
        originTrust: 'owner',
        ownerConfirmed: true,
        source: null,
        quarantined: false,
        createdAt: new Date('2026-09-01T00:00:00Z'),
        updatedAt: new Date('2026-09-01T00:00:00Z'),
      }),
      store.doc('knowledgeGraphEntities', 'anna-entity').set({
        id: 'anna-entity',
        agentId,
        contactId,
        kind: 'person',
        label: 'Anna',
        canonicalKey: `contact:${contactId}`,
        preferredLabel: null,
      }),
      store.doc('knowledgeGraphEntities', 'bob-entity').set({
        id: 'bob-entity',
        agentId,
        contactId: friendId,
        kind: 'person',
        label: 'Bobby',
        canonicalKey: `contact:${friendId}`,
        preferredLabel: null,
      }),
      store.doc('knowledgeGraphSources', factId).set({
        memoryId: factId,
        status: 'ready',
        contentHash: `${factId}-hash`,
        extractionVersion: GRAPH_EXTRACTION_VERSION,
      }),
      store.doc('knowledgeGraphRelations', 'anna-friend-bob').set({
        id: 'anna-friend-bob',
        agentId,
        subjectEntityId: 'anna-entity',
        objectEntityId: 'bob-entity',
        predicate: 'friend_of',
        sourceMemoryId: factId,
        reviewStatus: 'confirmed',
        evidenceQuote: 'Anna is close friends with Bob',
        validFrom: null,
        validUntil: null,
        createdAt: now,
      }),
      foreignStore.doc('agents', otherAgentId).set({ id: otherAgentId, name: 'Foreign' }),
      foreignStore.doc('contacts', foreignContactId).set({
        id: foreignContactId,
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

  it('admits UUID detail GET and Server Action POST through the Firestore proxy', async () => {
    const { proxy } = await import('../../../proxy.js');
    const request = (path: string, method = 'GET') =>
      new NextRequest(`http://localhost${path}`, { method });
    expect(proxy(request(`/people/${contactId}`)).status).toBe(307);
    expect(proxy(request(`/people/${contactId}`, 'POST')).status).toBe(410);
    expect(proxy(request(`/people/${contactId}`, 'DELETE')).status).toBe(410);
    expect(proxy(request('/people/not-a-uuid')).status).toBe(307);
    expect(proxy(request('/people/not-a-uuid', 'POST')).status).toBe(410);
  });

  it('renders the full dossier and every editing control without PostgreSQL', async () => {
    const html = renderToStaticMarkup(await page.default(params(contactId)));
    expect(mocks.owner).toHaveBeenCalled();
    expect(mocks.db).not.toHaveBeenCalled();
    expect(html).toContain('Anna Example');
    expect(html).toContain('daughter');
    // Saved facts, the timeline, occasions, and graph relations.
    expect(html).toContain('Anna is close friends with Bob');
    expect(html).toContain('Went hiking with Anna');
    expect(html).toContain('id="important-dates"');
    expect(html).toContain('Explore connections');
    expect(html).toContain('Bobby');
    expect(html).toContain(`href="/people/${friendId}"`);
    // Every control the PostgreSQL page offers.
    expect(html).toContain('Add a fact about Anna Example');
    expect(html).toContain('Add connection');
    expect(html).toContain('Save changes');
    expect(html).toContain('merge into…');
    expect(html).toContain('Bob Example (friend)');
    expect(html).toContain('Delete person');
  });

  it('edits the person and adds an occasion through the shared Server Actions', async () => {
    const { addOccasionAction, updateContactIdentityAction } = await import(
      '@/app/profile/actions'
    );
    expect(await updateContactIdentityAction(contactId, 'Anna Renamed', 'Annie, Nan')).toEqual({});
    expect(
      await addOccasionAction(contactId, {
        kind: 'anniversary',
        label: '',
        month: '6',
        day: '12',
        year: '2015',
        leadDays: '7',
        notes: 'Wedding day',
      }),
    ).toEqual({});

    const saved = await store.doc('contacts', contactId).get();
    expect(saved.get('name')).toBe('Anna Renamed');
    // The previous name is kept as an alias, as in PostgreSQL.
    expect(saved.get('aliases')).toEqual(['Annie', 'Nan', 'Anna Example']);
    const occasions = await store
      .collection('occasions')
      .where('contactId', '==', contactId)
      .where('kind', '==', 'anniversary')
      .get();
    expect(occasions.size).toBe(1);
    expect(occasions.docs[0]?.get('notes')).toBe('Wedding day');

    const html = renderToStaticMarkup(await page.default(params(contactId)));
    expect(html).toContain('Anna Renamed');
    expect(html).toContain('Wedding day');
    expect(mocks.db).not.toHaveBeenCalled();
  });

  it('deletes a person through the shared Server Action', async () => {
    const { deleteContactAction } = await import('@/app/profile/actions');
    const doomedId = randomUUID();
    await person(doomedId, 'Temporary Example');
    expect(renderToStaticMarkup(await page.default(params(doomedId)))).toContain(
      'Temporary Example',
    );
    expect(await deleteContactAction(doomedId)).toEqual({});
    await expect(page.default(params(doomedId))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('authenticates before reading and hides absent, foreign, and owner contacts', async () => {
    mocks.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(page.default(params(contactId))).rejects.toThrow('owner authentication required');
    for (const id of [randomUUID(), foreignContactId, ownerContactId]) {
      await expect(page.default(params(id))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    }
  });

  it('rejects a configured agent mismatch and ambiguous installation', async () => {
    vi.stubEnv('FIRESTORE_AGENT_ID', otherAgentId);
    resetConfigForTest();
    try {
      await expect(page.default(params(contactId))).rejects.toThrow('exactly one configured agent');
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
    await store.doc('agents', otherAgentId).set({ id: otherAgentId });
    try {
      await expect(page.default(params(contactId))).rejects.toThrow('exactly one configured agent');
    } finally {
      await store.doc('agents', otherAgentId).delete();
    }
  });

  it('fails closed while privacy erasure is active', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(page.default(params(contactId))).rejects.toThrow(
        'Privacy erasure is in progress',
      );
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });
});
