import { randomUUID } from 'node:crypto';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/application/knowledge-graph';
import { resetConfigForTest } from '@assistant/config';
import {
  createInstallationStore,
  embeddingSpaceKey,
  FirestoreOwnerKnowledgeGraphFactRepository,
} from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ mobile: vi.fn() }));
const routerFixture = vi.hoisted(() => ({ embed: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@assistant/core/model-router', () => ({
  ModelRouter: class {
    embed(...args: unknown[]) {
      return routerFixture.embed(...args);
    }
  },
  createConnectedModelProviders: vi.fn(),
}));

import { proxy } from '@/proxy';
import { GET as detail } from './[id]/route';
import { POST as create, GET as list } from './route';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile Knowledge graph with PostgreSQL offline', () => {
  const installationId = `mobile-knowledge-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const subjectId = randomUUID();
  const objectId = randomUUID();
  const foreignId = randomUUID();
  const activeId = randomUUID();
  const staleId = randomUUID();
  const foreignRelationId = randomUUID();
  const crossOwnerRelationId = randomUUID();
  const activeMemoryId = randomUUID();
  const staleMemoryId = randomUUID();
  const foreignMemoryId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const now = new Date();
  const entity = (id: string, owner: string, label: string) => ({
    id,
    agentId: owner,
    label,
    preferredLabel: null,
    kind: 'person',
    canonicalKey: `person:${id}`,
    contactId: null,
    createdAt: now,
    updatedAt: now,
  });
  const memory = (id: string, owner: string, content: string) => ({
    id,
    agentId: owner,
    content,
    category: 'knowledge',
    quarantined: false,
    expiresAt: null,
    embedding: Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
    embeddingSpace: embeddingSpaceKey({
      provider: 'vertex',
      model: 'example-embedding',
      dimensions: 1536,
      revision: 'fixture-v1',
    }),
    contentHash: `hash-${id}`,
    subjectContactId: null,
    createdAt: now,
    ownerConfirmed: true,
    originTrust: 'owner',
  });
  const relation = (id: string, owner: string, sourceMemoryId: string, objectEntityId: string) => ({
    id,
    agentId: owner,
    subjectEntityId: subjectId,
    objectEntityId,
    sourceMemoryId,
    predicate: 'knows',
    confidence: '0.9',
    reviewStatus: 'unreviewed',
    reviewedAt: null,
    validFrom: null,
    validUntil: null,
    evidenceQuote: 'The two know each other',
    createdAt: now,
  });

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"example-embedding","dimensions":1536,"revision":"fixture-v1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.mobile.mockResolvedValue(true);
    routerFixture.embed.mockImplementation(async (texts: string[]) =>
      texts.map(() => Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0))),
    );
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('knowledgeGraphEntities', subjectId).set(entity(subjectId, agentId, 'Anna')),
      store.doc('knowledgeGraphEntities', objectId).set(entity(objectId, agentId, 'Baldvin')),
      store
        .doc('knowledgeGraphEntities', foreignId)
        .set(entity(foreignId, foreignAgentId, 'Foreign')),
      store
        .doc('memories', activeMemoryId)
        .set(memory(activeMemoryId, agentId, 'Anna knows Baldvin')),
      store.doc('memories', staleMemoryId).set(memory(staleMemoryId, agentId, 'Old claim')),
      store
        .doc('memories', foreignMemoryId)
        .set(memory(foreignMemoryId, foreignAgentId, 'Foreign claim')),
      store.doc('knowledgeGraphSources', activeMemoryId).set({
        memoryId: activeMemoryId,
        status: 'ready',
        contentHash: `hash-${activeMemoryId}`,
        subjectContactId: null,
        extractionVersion: GRAPH_EXTRACTION_VERSION,
      }),
      store.doc('knowledgeGraphSources', staleMemoryId).set({
        memoryId: staleMemoryId,
        status: 'failed',
        contentHash: `hash-${staleMemoryId}`,
        subjectContactId: null,
        extractionVersion: GRAPH_EXTRACTION_VERSION,
      }),
      store.doc('knowledgeGraphSources', foreignMemoryId).set({
        memoryId: foreignMemoryId,
        status: 'ready',
        contentHash: `hash-${foreignMemoryId}`,
        subjectContactId: null,
        extractionVersion: GRAPH_EXTRACTION_VERSION,
      }),
      store
        .doc('knowledgeGraphRelations', activeId)
        .set(relation(activeId, agentId, activeMemoryId, objectId)),
      store
        .doc('knowledgeGraphRelations', staleId)
        .set(relation(staleId, agentId, staleMemoryId, objectId)),
      store
        .doc('knowledgeGraphRelations', foreignRelationId)
        .set(relation(foreignRelationId, foreignAgentId, foreignMemoryId, foreignId)),
      store
        .doc('knowledgeGraphRelations', crossOwnerRelationId)
        .set(relation(crossOwnerRelationId, agentId, activeMemoryId, foreignId)),
      ...Array.from({ length: 10 }, (_, index) =>
        store.doc('modelCalls', `owner-extract-${index}`).set({
          id: `owner-extract-${index}`,
          agentId,
          role: 'extract',
          costUsd: '0.020000',
          createdAt: now,
        }),
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        store.doc('modelCalls', `foreign-extract-${index}`).set({
          id: `foreign-extract-${index}`,
          agentId: foreignAgentId,
          role: 'extract',
          costUsd: '99.000000',
          createdAt: now,
        }),
      ),
      store.doc('modelCalls', 'legacy-extract').set({
        id: 'legacy-extract',
        role: 'extract',
        costUsd: '100.000000',
        createdAt: now,
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('browses active owner entities and includes stale evidence only in selected detail', async () => {
    const response = await list(new Request('http://localhost/api/mobile/v1/knowledge?q=anna'));
    expect(response.status).toBe(200);
    const graph = await response.json();
    expect(graph).toMatchObject({
      totalEntities: 2,
      totalRelations: 1,
      unreviewedRelations: 1,
      pendingSources: 1,
      matchingEntities: 1,
      selected: { id: subjectId },
      selectedRelationTotal: 2,
      selectedActiveRelationTotal: 1,
    });
    expect(graph.pendingCostUsd).toBeCloseTo(0.02, 6);
    expect(graph.relations.map((row: { id: string }) => row.id).sort()).toEqual(
      [activeId, staleId].sort(),
    );
    expect(graph.relations.find((row: { id: string }) => row.id === staleId).inRecall).toBe(false);
    expect(graph.relations[0].presentation.sentence).toContain('Anna');
    expect(JSON.stringify(graph)).not.toContain(foreignId);
    expect(JSON.stringify(graph)).not.toContain(crossOwnerRelationId);
  });

  it('finds items by name without loading the whole graph, owner-only', async () => {
    const search = async (q: string) => {
      const response = await list(
        new Request(
          `http://localhost/api/mobile/v1/knowledge?mode=search&q=${encodeURIComponent(q)}`,
        ),
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { entities: Array<{ id: string; label: string }> })
        .entities;
    };
    expect((await search('bald')).map((row) => row.id)).toEqual([objectId]);
    expect((await search('a')).map((row) => row.label)).toEqual(['Anna', 'Baldvin']);
    expect((await search('foreign')).map((row) => row.id)).toEqual([]);
    expect(await search('   ')).toEqual([]);
  });

  it('returns the review queue with active and stale owner evidence only', async () => {
    const response = await list(
      new Request('http://localhost/api/mobile/v1/knowledge?mode=review'),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.relations.map((row: { id: string }) => row.id).sort()).toEqual(
      [activeId, staleId].sort(),
    );
    expect(body.relations.find((row: { id: string }) => row.id === activeId).inRecall).toBe(true);
    expect(JSON.stringify(body)).not.toContain(foreignRelationId);
    expect(JSON.stringify(body)).not.toContain(crossOwnerRelationId);
  });

  it('opens owner detail and rejects foreign or malformed IDs', async () => {
    const request = (id: string) => new Request(`http://localhost/api/mobile/v1/knowledge/${id}`);
    expect(
      (await detail(request(subjectId), { params: Promise.resolve({ id: subjectId }) })).status,
    ).toBe(200);
    expect(
      (await detail(request(foreignId), { params: Promise.resolve({ id: foreignId }) })).status,
    ).toBe(404);
    expect((await detail(request('bad'), { params: Promise.resolve({ id: 'bad' }) })).status).toBe(
      400,
    );
  });

  it('fails closed for a target with more than one configured agent', async () => {
    await store.doc('agents', foreignAgentId).set({ id: foreignAgentId });
    try {
      await expect(list(new Request('http://localhost/api/mobile/v1/knowledge'))).rejects.toThrow(
        'exactly one configured agent',
      );
      await expect(
        list(new Request('http://localhost/api/mobile/v1/knowledge?mode=review')),
      ).rejects.toThrow('exactly one configured agent');
      await expect(
        detail(new Request(`http://localhost/api/mobile/v1/knowledge/${subjectId}`), {
          params: Promise.resolve({ id: subjectId }),
        }),
      ).rejects.toThrow('exactly one configured agent');
    } finally {
      await store.doc('agents', foreignAgentId).delete();
    }
  });

  it('allows exact knowledge browse/create proxy routes and blocks unsupported paths', () => {
    const status = (path: string, method = 'GET') =>
      proxy(new NextRequest(`http://localhost${path}`, { method })).status;
    expect(status('/api/mobile/v1/knowledge')).toBe(200);
    expect(status(`/api/mobile/v1/knowledge/${subjectId}`)).toBe(200);
    expect(status('/api/mobile/v1/knowledge', 'POST')).toBe(200);
    expect(status(`/api/mobile/v1/knowledge/${subjectId}`, 'PATCH')).toBe(200);
    expect(status(`/api/mobile/v1/knowledge/${subjectId}`, 'DELETE')).toBe(503);
    expect(status('/api/mobile/v1/knowledge/graph', 'POST')).toBe(503);
    expect(status('/api/mobile/v1/knowledge/bad')).toBe(503);
  });

  it('atomically stores an owner-authored source, graph relation, and normalized entities', async () => {
    const repo = new FirestoreOwnerKnowledgeGraphFactRepository(
      store,
      { provider: 'vertex', model: 'example-embedding', dimensions: 1536, revision: 'fixture-v1' },
      agentId,
    );
    const prepared = {
      agentId,
      content: 'Anna parent of Baldvin. Owner note: family',
      contentHash: `owner-fact-${randomUUID()}`,
      embedding: Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
      embeddingSpaceKey: embeddingSpaceKey({
        provider: 'vertex',
        model: 'example-embedding',
        dimensions: 1536,
        revision: 'fixture-v1',
      }),
      predicate: 'parent_of',
      subjectContactId: null,
      subject: {
        label: 'Anna',
        kind: 'person' as const,
        canonicalKey: 'person:anna',
        contactId: null,
        authoritativeLabel: false,
      },
      object: {
        label: 'Baldvin',
        kind: 'person' as const,
        canonicalKey: 'person:baldvin',
        contactId: null,
        authoritativeLabel: false,
      },
      createdAt: now,
      extractionVersion: GRAPH_EXTRACTION_VERSION,
    };
    const result = await repo.createAtomic(prepared);
    expect(result.error).toBeUndefined();
    if (!result.memoryId || !result.relationId) throw new Error('expected committed graph fact');
    const [savedMemory, savedSource, savedRelation, entities] = await Promise.all([
      store.doc('memories', result.memoryId).get(),
      store.doc('knowledgeGraphSources', result.memoryId).get(),
      store.doc('knowledgeGraphRelations', result.relationId).get(),
      store.collection('knowledgeGraphEntities').where('agentId', '==', agentId).get(),
    ]);
    expect(savedMemory.data()).toMatchObject({
      agentId,
      content: prepared.content,
      contentHash: prepared.contentHash,
      originTrust: 'owner',
      ownerConfirmed: true,
      category: 'knowledge',
      embeddingSpace: embeddingSpaceKey({
        provider: 'vertex',
        model: 'example-embedding',
        dimensions: 1536,
        revision: 'fixture-v1',
      }),
    });
    expect(savedSource.data()).toMatchObject({
      memoryId: result.memoryId,
      agentId,
      contentHash: prepared.contentHash,
      status: 'ready',
      extractionVersion: GRAPH_EXTRACTION_VERSION,
    });
    expect(savedRelation.data()).toMatchObject({
      agentId,
      sourceMemoryId: result.memoryId,
      predicate: 'parent_of',
      reviewStatus: 'confirmed',
      evidenceQuote: prepared.content,
    });
    expect(entities.docs.map((doc) => doc.get('canonicalKey'))).toContain('person:anna');
    expect(entities.docs.map((doc) => doc.get('canonicalKey'))).toContain('person:baldvin');
    expect(await repo.createAtomic(prepared)).toEqual({
      error: 'That source fact is already in the knowledge library.',
    });
  });

  it('routes authenticated mobile fact creation through the Firestore owner boundary', async () => {
    const response = await create(
      new Request('http://localhost/api/mobile/v1/knowledge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subjectLabel: 'Anna',
          subjectKind: 'person',
          predicate: 'parent of',
          objectLabel: 'Baldvin',
          objectKind: 'person',
          note: 'Family connection confirmed by the owner',
        }),
      }),
    );
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.memoryId).toBeTruthy();
    expect(result.relationId).toBeTruthy();
    expect(auth.mobile).toHaveBeenCalled();
  });

  it('blocks tombstoned hashes and active privacy erasure inside the write transaction', async () => {
    const repo = new FirestoreOwnerKnowledgeGraphFactRepository(
      store,
      { provider: 'vertex', model: 'example-embedding', dimensions: 1536, revision: 'fixture-v1' },
      agentId,
    );
    const base = {
      agentId,
      content: 'Anna parent of Baldvin. Owner note: family',
      contentHash: `owner-fact-${randomUUID()}`,
      embedding: Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
      embeddingSpaceKey: embeddingSpaceKey({
        provider: 'vertex',
        model: 'example-embedding',
        dimensions: 1536,
        revision: 'fixture-v1',
      }),
      predicate: 'parent_of',
      subjectContactId: null,
      subject: {
        label: 'Anna',
        kind: 'person' as const,
        canonicalKey: 'person:anna',
        contactId: null,
        authoritativeLabel: false,
      },
      object: {
        label: 'Baldvin',
        kind: 'person' as const,
        canonicalKey: 'person:baldvin',
        contactId: null,
        authoritativeLabel: false,
      },
      createdAt: now,
      extractionVersion: GRAPH_EXTRACTION_VERSION,
    };
    await store.doc('memoryTombstones', base.contentHash).set({ contentHash: base.contentHash });
    expect(await repo.createAtomic(base)).toEqual({
      error: 'This fact was previously removed, so it was not added again.',
    });
    await store.doc('memoryTombstones', base.contentHash).delete();
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'running' });
    await expect(
      repo.createAtomic({ ...base, contentHash: `${base.contentHash}-erasure` }),
    ).rejects.toThrow('Privacy erasure is in progress');
    await store.doc('privacyErasureJobs', agentId).delete();
  });
});
