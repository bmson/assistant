import { randomUUID } from 'node:crypto';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/application/knowledge-graph';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore, embeddingSpaceKey } from '@assistant/firestore';
import { FieldValue } from '@google-cloud/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), db: vi.fn(), store: null as unknown }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/server', () => ({
  getDb: mocks.db,
  getFirestoreInstallationStore: () => mocks.store,
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile person card with PostgreSQL offline', () => {
  const installationId = `mobile-person-card-${randomUUID()}`;
  const foreignInstallationId = `mobile-person-card-foreign-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const contactId = randomUUID();
  const ownerContactId = randomUUID();
  const foreignContactId = randomUUID();
  const selfEntityId = randomUUID();
  const placeEntityId = randomUUID();
  const friendEntityId = randomUUID();
  const friendContactId = randomUUID();
  const eventEntityId = randomUUID();
  const companyEntityId = randomUUID();
  const embeddingSpace = {
    provider: 'vertex',
    model: 'fixture',
    dimensions: 768,
    revision: '1',
  } as const;
  const embedding = Array.from({ length: embeddingSpace.dimensions }, (_, index) =>
    index === 0 ? 1 : 0,
  );
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const foreignStore = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId: foreignInstallationId,
  });
  let route: typeof import('./route.js');
  const context = (id: string) => ({ params: Promise.resolve({ id }) });
  const request = (id: string) => new Request(`https://example.test/api/mobile/v1/people/${id}`);

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
    mocks.store = store;
    mocks.auth.mockResolvedValue(true);
    mocks.db.mockImplementation(() => {
      throw new Error('PostgreSQL is unreachable');
    });
    route = await import('./route.js');
    const now = new Date();
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('contacts', contactId).set({
        id: contactId,
        name: 'Anna Example',
        relationship: 'daughter',
        trust: 'confirmed',
      }),
      store.doc('contacts', ownerContactId).set({
        id: ownerContactId,
        name: 'Owner private contact',
        relationship: '',
        trust: 'owner',
      }),
      foreignStore.doc('agents', foreignAgentId).set({ id: foreignAgentId }),
      foreignStore.doc('contacts', foreignContactId).set({
        id: foreignContactId,
        name: 'Foreign private person',
        relationship: 'friend',
        trust: 'confirmed',
      }),
      store.doc('knowledgeGraphEntities', selfEntityId).set({
        id: selfEntityId,
        agentId,
        contactId,
        kind: 'person',
        canonicalKey: `contact:${contactId}`,
        label: 'Anna Example',
        preferredLabel: null,
      }),
      store.doc('knowledgeGraphEntities', placeEntityId).set({
        id: placeEntityId,
        agentId,
        contactId: null,
        kind: 'place',
        canonicalKey: 'place:reykjavik',
        label: 'Reykjavík',
        preferredLabel: null,
      }),
      store.doc('knowledgeGraphEntities', friendEntityId).set({
        id: friendEntityId,
        agentId,
        contactId: friendContactId,
        kind: 'person',
        canonicalKey: `contact:${friendContactId}`,
        label: 'Björk',
        preferredLabel: null,
      }),
      store.doc('knowledgeGraphEntities', eventEntityId).set({
        id: eventEntityId,
        agentId,
        contactId: null,
        kind: 'event',
        canonicalKey: 'event:conference',
        label: 'Conference',
        preferredLabel: null,
      }),
      store.doc('knowledgeGraphEntities', companyEntityId).set({
        id: companyEntityId,
        agentId,
        contactId: null,
        kind: 'organization',
        canonicalKey: 'organization:atlas',
        label: 'Atlas',
        preferredLabel: null,
      }),
      store.doc('knowledgeGraphRelations', 'home').set({
        id: 'home',
        agentId,
        subjectEntityId: selfEntityId,
        objectEntityId: placeEntityId,
        sourceMemoryId: 'home',
        predicate: 'lives_in',
        reviewStatus: 'confirmed',
        evidenceQuote: 'Anna lives in Reykjavík',
        validFrom: null,
        validUntil: null,
        createdAt: now,
      }),
      store.doc('knowledgeGraphRelations', 'parent').set({
        id: 'parent',
        agentId,
        subjectEntityId: friendEntityId,
        objectEntityId: selfEntityId,
        sourceMemoryId: 'parent',
        predicate: 'parent_of',
        reviewStatus: 'unreviewed',
        evidenceQuote: 'Björk is Anna’s parent',
        validFrom: '2019',
        validUntil: null,
        createdAt: now,
      }),
      store.doc('knowledgeGraphRelations', 'met').set({
        id: 'met',
        agentId,
        subjectEntityId: selfEntityId,
        objectEntityId: eventEntityId,
        sourceMemoryId: 'met',
        predicate: 'met_at',
        reviewStatus: 'confirmed',
        evidenceQuote: 'Met at the conference',
        validFrom: null,
        validUntil: null,
        createdAt: now,
      }),
      store.doc('knowledgeGraphRelations', 'work').set({
        id: 'work',
        agentId,
        subjectEntityId: selfEntityId,
        objectEntityId: companyEntityId,
        sourceMemoryId: 'work',
        predicate: 'works_at',
        reviewStatus: 'confirmed',
        evidenceQuote: 'Anna works at Atlas',
        validFrom: null,
        validUntil: null,
        createdAt: now,
      }),
      ...['home', 'parent', 'met', 'work'].map((id) =>
        store.doc('knowledgeGraphSources', id).set({
          memoryId: id,
          status: 'ready',
          contentHash: `hash-${id}`,
          extractionVersion: GRAPH_EXTRACTION_VERSION,
        }),
      ),
      ...['home', 'parent', 'met', 'work'].map((id) =>
        store.doc('memories', id).set({
          id,
          agentId,
          subjectContactId: contactId,
          category: 'knowledge',
          quarantined: false,
          expiresAt: null,
          createdAt: now,
          validFrom: null,
          embedding: FieldValue.vector(embedding),
          embeddingSpace: embeddingSpaceKey(embeddingSpace),
          contentHash: `hash-${id}`,
        }),
      ),
      store.doc('memories', 'visit').set({
        id: 'visit',
        agentId,
        subjectContactId: contactId,
        category: 'experience',
        quarantined: false,
        expiresAt: null,
        createdAt: now,
        validFrom: now,
        embedding: null,
        contentHash: 'hash-visit',
        content: 'Had lunch together.',
        kind: 'episode',
        originTrust: 'owner',
      }),
      store.doc('memories', 'foreign-visit').set({
        id: 'foreign-visit',
        agentId: foreignAgentId,
        subjectContactId: contactId,
        category: 'experience',
        quarantined: false,
        expiresAt: null,
        createdAt: now,
        validFrom: now,
        embedding: null,
        contentHash: 'hash-foreign-visit',
        content: 'Foreign private event.',
        kind: 'episode',
        originTrust: 'owner',
      }),
      store.doc('occasions', 'birthday').set({
        id: 'birthday',
        agentId,
        contactId,
        kind: 'birthday',
        label: '',
        month: now.getUTCMonth() + 1,
        day: now.getUTCDate(),
        year: 1990,
        recurrence: 'annual',
        leadDays: 14,
        quarantined: false,
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

  it('permits only exact UUID GET through the Firestore proxy', async () => {
    const { proxy } = await import('../../../../../../proxy.js');
    const nextRequest = (path: string, method = 'GET') =>
      new NextRequest(`https://example.test${path}`, { method });
    expect(proxy(nextRequest(`/api/mobile/v1/people/${contactId}`)).status).toBe(200);
    expect(proxy(nextRequest(`/api/mobile/v1/people/${contactId}`, 'PATCH')).status).toBe(503);
    expect(proxy(nextRequest('/api/mobile/v1/people/not-a-uuid')).status).toBe(503);
  });

  it('returns actual card details and no PostgreSQL reads', async () => {
    const response = await route.GET(request(contactId), context(contactId));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      id: contactId,
      name: 'Anna Example',
      relationship: 'daughter',
      group: 'family',
      location: 'Reykjavík',
      factCount: 4,
      lastContact: expect.any(String),
      birthday: expect.stringContaining('turns'),
      reminder: { headline: expect.stringContaining('birthday is today') },
      eventsAreRecent: true,
      events: [{ id: 'visit', content: 'Had lunch together.', dateIsRecordTime: false }],
      relations: [
        {
          id: 'parent',
          sentence: "Björk is Anna Example's parent.",
          otherContactId: friendContactId,
          span: 'Since 2019',
          unreviewed: true,
        },
      ],
    });
    expect(body.howWeMet).toEqual([expect.any(String)]);
    expect(body.connections).toEqual([
      expect.objectContaining({ id: 'work', sentence: expect.any(String) }),
    ]);
    expect(JSON.stringify(body)).not.toContain('Foreign private event');
    expect(mocks.db).not.toHaveBeenCalled();
  });

  it('authenticates before reads and hides missing, foreign, and owner contacts', async () => {
    mocks.auth.mockResolvedValueOnce(false);
    expect((await route.GET(request(contactId), context(contactId))).status).toBe(401);
    expect((await route.GET(request('bad'), context('bad'))).status).toBe(400);
    for (const id of [randomUUID(), foreignContactId, ownerContactId]) {
      const response = await route.GET(request(id), context(id));
      expect(response.status).toBe(404);
    }
  });

  it('rejects a configured-agent mismatch and active erasure', async () => {
    vi.stubEnv('FIRESTORE_AGENT_ID', foreignAgentId);
    resetConfigForTest();
    try {
      await expect(route.GET(request(contactId), context(contactId))).rejects.toThrow(
        'exactly one configured agent',
      );
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(route.GET(request(contactId), context(contactId))).rejects.toThrow(
        'Privacy erasure is in progress',
      );
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });

  it('fails closed on malformed source data rather than returning a partial card', async () => {
    await store.doc('memories', 'visit').update({ quarantined: null });
    try {
      await expect(route.GET(request(contactId), context(contactId))).rejects.toThrow(
        'malformed projection record',
      );
    } finally {
      await store.doc('memories', 'visit').update({ quarantined: false });
    }
  });
});
