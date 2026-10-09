import { randomUUID } from 'node:crypto';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/application/knowledge-graph';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ mobile: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) =>
    Response.json(body, {
      ...init,
      headers: { 'cache-control': 'no-store' },
    }),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile People directory with PostgreSQL offline', () => {
  const installationId = `mobile-people-${randomUUID()}`;
  const foreignInstallationId = `mobile-people-foreign-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const ownerId = randomUUID();
  const personId = randomUUID();
  const emptyPersonId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const foreignStore = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId: foreignInstallationId,
  });
  const url = 'http://localhost/api/mobile/v1/people';
  const now = new Date();
  const birthday = new Date(now.getTime() + 7 * 86_400_000);

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
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
    auth.mobile.mockResolvedValue(true);
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' }),
      store
        .doc('contacts', ownerId)
        .set({ id: ownerId, name: 'Owner', relationship: '', trust: 'owner' }),
      store
        .doc('contacts', personId)
        .set({ id: personId, name: 'Anna Example', relationship: 'daughter', trust: 'confirmed' }),
      store.doc('contacts', emptyPersonId).set({
        id: emptyPersonId,
        name: 'Max Example',
        relationship: 'friend',
        trust: 'confirmed',
      }),
      store.doc('memories', 'person-fact').set({
        id: 'person-fact',
        agentId,
        subjectContactId: personId,
        category: 'knowledge',
        quarantined: false,
        expiresAt: null,
        createdAt: now,
        validFrom: null,
        contentHash: 'person-fact-hash',
        embedding: [0.1],
        content: 'Anna lives in Reykjavík',
      }),
      store.doc('memories', 'person-experience').set({
        id: 'person-experience',
        agentId,
        subjectContactId: personId,
        category: 'experience',
        quarantined: false,
        expiresAt: null,
        createdAt: now,
        validFrom: now,
        contentHash: 'person-experience-hash',
        embedding: null,
        content: 'We spoke today',
      }),
      store.doc('memories', 'stale-person-fact').set({
        id: 'stale-person-fact',
        agentId,
        subjectContactId: personId,
        category: 'knowledge',
        quarantined: true,
        expiresAt: null,
        createdAt: now,
        validFrom: null,
        contentHash: 'stale-person-fact-hash',
        embedding: [0.1],
      }),
      store.doc('occasions', 'anna-birthday').set({
        id: 'anna-birthday',
        agentId,
        contactId: personId,
        kind: 'birthday',
        month: birthday.getUTCMonth() + 1,
        day: birthday.getUTCDate(),
        year: null,
        recurrence: 'annual',
        quarantined: false,
      }),
      store.doc('knowledgeGraphEntities', 'anna-entity').set({
        id: 'anna-entity',
        agentId,
        contactId: personId,
        kind: 'person',
        label: 'Anna',
        preferredLabel: null,
      }),
      store.doc('knowledgeGraphEntities', 'reykjavik-entity').set({
        id: 'reykjavik-entity',
        agentId,
        contactId: null,
        kind: 'place',
        label: 'Reykjavík',
        preferredLabel: null,
      }),
      store.doc('knowledgeGraphEntities', 'stale-place-entity').set({
        id: 'stale-place-entity',
        agentId,
        contactId: null,
        kind: 'place',
        label: 'Stale Place',
        preferredLabel: null,
      }),
      store.doc('knowledgeGraphSources', 'person-fact').set({
        memoryId: 'person-fact',
        status: 'ready',
        contentHash: 'person-fact-hash',
        extractionVersion: GRAPH_EXTRACTION_VERSION,
      }),
      store.doc('knowledgeGraphSources', 'stale-person-fact').set({
        memoryId: 'stale-person-fact',
        status: 'ready',
        contentHash: 'stale-person-fact-hash',
        extractionVersion: GRAPH_EXTRACTION_VERSION,
      }),
      store.doc('knowledgeGraphRelations', 'a-stale-location-relation').set({
        id: 'a-stale-location-relation',
        agentId,
        subjectEntityId: 'anna-entity',
        objectEntityId: 'stale-place-entity',
        predicate: 'lives_in',
        sourceMemoryId: 'stale-person-fact',
        reviewStatus: 'confirmed',
        evidenceQuote: 'Anna lives in Stale Place',
        validUntil: null,
      }),
      store.doc('knowledgeGraphRelations', 'location-relation').set({
        id: 'location-relation',
        agentId,
        subjectEntityId: 'anna-entity',
        objectEntityId: 'reykjavik-entity',
        predicate: 'lives_in',
        sourceMemoryId: 'person-fact',
        reviewStatus: 'confirmed',
        evidenceQuote: 'Anna lives in Reykjavík',
        validUntil: null,
      }),
      foreignStore.doc('agents', foreignAgentId).set({ id: foreignAgentId }),
      foreignStore.doc('contacts', 'foreign-person').set({
        id: 'foreign-person',
        name: 'Foreign Private Person',
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

  it('allows the directory and person reads but not directory writes through the proxy', async () => {
    const { proxy } = await import('../../../../../proxy.js');
    const status = (path: string, method = 'GET') =>
      proxy(new NextRequest(`http://localhost${path}`, { method })).status;
    expect(status('/api/mobile/v1/people')).toBe(200);
    expect(status('/api/mobile/v1/people', 'POST')).toBe(503);
    expect(status(`/api/mobile/v1/people/${personId}`)).toBe(200);
    expect(status(`/api/mobile/v1/people/${personId}`, 'DELETE')).toBe(503);
  });

  it('preserves the mobile contract and real directory derivations without PostgreSQL', async () => {
    const { GET } = await import('./route.js');
    const { getDb } = await import('@/lib/server');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.generatedAt).toEqual(expect.any(String));
    expect(body.people).toHaveLength(2);
    const anna = body.people.find((person: { id: string }) => person.id === personId);
    expect(anna).toMatchObject({
      id: personId,
      name: 'Anna Example',
      initials: 'AE',
      relationship: 'daughter',
      group: 'family',
      groupLabel: 'Family',
      trust: 'confirmed',
      location: 'Reykjavík',
      factCount: 1,
      birthday: expect.any(String),
      birthdayDaysUntil: expect.any(Number),
      lastContact: expect.any(String),
    });
    expect(Object.keys(anna).sort()).toEqual(
      [
        'id',
        'name',
        'initials',
        'relationship',
        'group',
        'groupLabel',
        'trust',
        'location',
        'factCount',
        'birthday',
        'birthdayDaysUntil',
        'lastContact',
      ].sort(),
    );
    expect(body.people.find((person: { id: string }) => person.id === emptyPersonId)).toMatchObject(
      {
        factCount: 0,
        location: null,
        birthday: null,
        lastContact: null,
      },
    );
    expect(JSON.stringify(body)).not.toContain('Foreign Private Person');
    expect(JSON.stringify(body)).not.toContain('Owner');
  });

  it('pages the Firestore directory without repeating contacts or returning the owner', async () => {
    const { GET } = await import('./route.js');
    const firstResponse = await GET(new Request(`${url}?limit=1`));
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.people.map((person: { id: string }) => person.id)).toEqual([personId]);
    expect(first.pagination).toMatchObject({
      consistency: 'live-keyset',
      pageSize: 1,
      hasMore: true,
      complete: false,
    });
    const secondResponse = await GET(
      new Request(`${url}?limit=1&cursor=${encodeURIComponent(first.pagination.nextCursor)}`),
    );
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json();
    expect(second.people.map((person: { id: string }) => person.id)).toEqual([emptyPersonId]);
    expect(second.pagination).toMatchObject({ hasMore: false, complete: true, nextCursor: null });
  });

  it('uses the encoded document identity to continue through equal-name contacts', async () => {
    const { GET } = await import('./route.js');
    // These encoded keys distinguish byte ordering from language collation.
    const tiedIds = [
      '00000007-0000-4000-8000-000000000001',
      '00000001-0000-4000-8000-000000000001',
      '00000003-0000-4000-8000-000000000001',
    ];
    await Promise.all(
      tiedIds.map((id) =>
        store.doc('contacts', id).set({
          id,
          name: 'Tied Example',
          relationship: 'friend',
          trust: 'confirmed',
        }),
      ),
    );
    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: '1' });
      if (cursor) query.set('cursor', cursor);
      const response = await GET(new Request(`${url}?${query}`));
      expect(response.status).toBe(200);
      const page = await response.json();
      collected.push(...page.people.map((person: { id: string }) => person.id));
      cursor = page.pagination.nextCursor;
    } while (cursor);
    expect(collected).toHaveLength(5);
    expect(new Set(collected).size).toBe(5);
    expect(collected.slice(-3)).toEqual([
      '00000001-0000-4000-8000-000000000001',
      '00000003-0000-4000-8000-000000000001',
      '00000007-0000-4000-8000-000000000001',
    ]);
  });

  it('authenticates first and fails closed for erasure or ambiguous owner', async () => {
    const { GET } = await import('./route.js');
    auth.mobile.mockResolvedValueOnce(false);
    expect((await GET(new Request(url))).status).toBe(401);
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      const response = await GET(new Request(url));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: 'People are unavailable. Retry before viewing them.',
      });
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
    vi.stubEnv('FIRESTORE_AGENT_ID', foreignAgentId);
    resetConfigForTest();
    try {
      expect((await GET(new Request(url))).status).toBe(503);
    } finally {
      vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
      resetConfigForTest();
    }
    await store.doc('agents', foreignAgentId).set({ id: foreignAgentId });
    try {
      expect((await GET(new Request(url))).status).toBe(503);
    } finally {
      await store.doc('agents', foreignAgentId).delete();
    }
  });

  it('fails closed when migrated projection fields are malformed', async () => {
    const { GET } = await import('./route.js');
    const corruptions: Array<{
      collection: string;
      id: string;
      field: string;
      bad: unknown;
      original: unknown;
    }> = [
      {
        collection: 'memories',
        id: 'person-fact',
        field: 'quarantined',
        bad: null,
        original: false,
      },
      {
        collection: 'memories',
        id: 'person-fact',
        field: 'expiresAt',
        bad: 'invalid',
        original: null,
      },
      {
        collection: 'memories',
        id: 'person-fact',
        field: 'category',
        bad: null,
        original: 'knowledge',
      },
      { collection: 'memories', id: 'person-fact', field: 'createdAt', bad: null, original: now },
      {
        collection: 'memories',
        id: 'person-fact',
        field: 'embedding',
        bad: 'invalid',
        original: [0.1],
      },
      {
        collection: 'occasions',
        id: 'anna-birthday',
        field: 'month',
        bad: null,
        original: birthday.getUTCMonth() + 1,
      },
      {
        collection: 'knowledgeGraphEntities',
        id: 'reykjavik-entity',
        field: 'label',
        bad: null,
        original: 'Reykjavík',
      },
      {
        collection: 'knowledgeGraphRelations',
        id: 'location-relation',
        field: 'reviewStatus',
        bad: null,
        original: 'confirmed',
      },
      {
        collection: 'knowledgeGraphSources',
        id: 'person-fact',
        field: 'extractionVersion',
        bad: null,
        original: GRAPH_EXTRACTION_VERSION,
      },
    ];
    for (const { collection, id, field, bad, original } of corruptions) {
      const ref = store.doc(collection, id);
      await ref.update({ [field]: bad });
      try {
        const response = await GET(new Request(url));
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: 'People are unavailable. Retry before viewing them.',
        });
      } finally {
        await ref.update({ [field]: original });
      }
    }
  });
});
