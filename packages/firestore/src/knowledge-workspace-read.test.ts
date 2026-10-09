import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FirestoreGraphRecallRepository } from './graph-recall.js';
import { FirestoreKnowledgeWorkspaceReadRepository } from './knowledge-workspace-read.js';
import { embeddingSpaceKey } from './memory.js';
import { disposeStore, emulatorStore } from './test-store.js';

const emulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');
const VERSION = 3;
const space = { provider: 'test', model: 'fixture', dimensions: 1536, revision: '1' };

describe.skipIf(!emulator)('Firestore knowledge workspace reads', () => {
  const store = emulator ? emulatorStore() : (null as never);
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const ownerContactId = randomUUID();
  const contactId = randomUUID();
  const now = new Date('2026-09-25T12:00:00.000Z');
  const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const ids = {
    anna: randomUUID(),
    annaJ: randomUUID(),
    oslo: randomUUID(),
    acme: randomUUID(),
    orphan: randomUUID(),
    foreign: randomUUID(),
    active: randomUUID(),
    older: randomUUID(),
    confirmed: randomUUID(),
    stale: randomUUID(),
    rejected: randomUUID(),
    unembedded: randomUUID(),
    foreignRelation: randomUUID(),
    memoryActive: randomUUID(),
    memoryOlder: randomUUID(),
    memoryConfirmed: randomUUID(),
    memoryStale: randomUUID(),
    memoryUnembedded: randomUUID(),
    memoryQuarantined: randomUUID(),
    memoryExpired: randomUUID(),
    memoryPending: randomUUID(),
    memoryForeign: randomUUID(),
    worksAtAssertion: randomUUID(),
    worksAtEvidence: randomUUID(),
  };
  const repository = emulator
    ? new FirestoreKnowledgeWorkspaceReadRepository(store, agentId, space)
    : (null as never);

  function entity(id: string, label: string, kind: string, patch: Record<string, unknown> = {}) {
    return store.doc('knowledgeGraphEntities', id).set({
      id,
      agentId,
      label,
      preferredLabel: null,
      kind,
      canonicalKey: `${kind}:${label.toLowerCase()}`,
      contactId: null,
      createdAt: now,
      updatedAt: now,
      ...patch,
    });
  }

  function memory(id: string, content: string, patch: Record<string, unknown> = {}) {
    return store.doc('memories', id).set({
      id,
      agentId,
      content,
      category: 'knowledge',
      quarantined: false,
      expiresAt: null,
      embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 0.1 : 0)),
      embeddingSpace: embeddingSpaceKey(space),
      contentHash: `hash-${id}`,
      subjectContactId: null,
      ownerConfirmed: false,
      lastConsolidatedAt: null,
      supersededById: null,
      createdAt: now,
      ...patch,
    });
  }

  function source(memoryId: string, patch: Record<string, unknown> = {}) {
    return store.doc('knowledgeGraphSources', memoryId).set({
      memoryId,
      status: 'ready',
      contentHash: `hash-${memoryId}`,
      subjectContactId: null,
      extractionVersion: VERSION,
      ...patch,
    });
  }

  function relation(
    id: string,
    subjectEntityId: string,
    objectEntityId: string,
    sourceMemoryId: string,
    patch: Record<string, unknown> = {},
  ) {
    return store.doc('knowledgeGraphRelations', id).set({
      id,
      agentId,
      subjectEntityId,
      objectEntityId,
      sourceMemoryId,
      predicate: 'lives_in',
      confidence: '0.9',
      reviewStatus: 'unreviewed',
      reviewedAt: null,
      validFrom: null,
      validUntil: null,
      evidenceQuote: 'quoted',
      sourceFingerprint: id,
      ordinal: 0,
      createdAt: now,
      ...patch,
    });
  }

  beforeAll(async () => {
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('contacts', ownerContactId).set({
        id: ownerContactId,
        agentId,
        name: 'Owner',
        trust: 'owner',
        relationship: 'self',
        aliases: [],
      }),
      store.doc('contacts', contactId).set({
        id: contactId,
        agentId,
        name: 'Anna',
        trust: 'known',
        relationship: 'friend',
        aliases: [],
      }),
      entity(ids.anna, 'Anna', 'person', { contactId, canonicalKey: `contact:${contactId}` }),
      entity(ids.annaJ, 'Anna Jónsdóttir', 'person'),
      entity(ids.oslo, 'Oslo', 'place', { preferredLabel: 'Oslo, Norway' }),
      entity(ids.acme, 'Acme', 'organization'),
      entity(ids.orphan, 'Nobody', 'topic'),
      store.doc('knowledgeGraphEntities', ids.foreign).set({
        id: ids.foreign,
        agentId: foreignAgentId,
        label: 'Foreign',
        preferredLabel: null,
        kind: 'person',
        canonicalKey: 'person:foreign',
        contactId: null,
      }),
      memory(ids.memoryActive, 'Anna lives in Oslo', { lastConsolidatedAt: at(5) }),
      memory(ids.memoryOlder, 'Anna works at Acme', { ownerConfirmed: true }),
      memory(ids.memoryConfirmed, 'Anna Jónsdóttir works at Acme'),
      memory(ids.memoryStale, 'Anna moved', { contentHash: 'changed-hash' }),
      memory(ids.memoryUnembedded, 'Imported without a vector', {
        embedding: null,
        embeddingSpace: null,
      }),
      memory(ids.memoryQuarantined, 'Unverified claim', { quarantined: true, createdAt: at(1) }),
      memory(ids.memoryExpired, 'Expired claim', { expiresAt: at(60), createdAt: at(2) }),
      memory(ids.memoryPending, 'Not yet mapped'),
      store.doc('memories', ids.memoryForeign).set({
        id: ids.memoryForeign,
        agentId: foreignAgentId,
        content: 'Foreign claim',
        category: 'knowledge',
        quarantined: true,
        expiresAt: null,
        embeddingSpace: embeddingSpaceKey(space),
        contentHash: 'foreign',
        createdAt: now,
      }),
      source(ids.memoryActive),
      source(ids.memoryOlder),
      source(ids.memoryConfirmed),
      source(ids.memoryStale),
      source(ids.memoryUnembedded),
      source(ids.memoryQuarantined, { status: 'quarantined' }),
      source(ids.memoryExpired),
      source(ids.memoryForeign, { status: 'failed', contentHash: 'foreign' }),
      relation(ids.active, ids.anna, ids.oslo, ids.memoryActive, { createdAt: at(1) }),
      relation(ids.older, ids.anna, ids.acme, ids.memoryOlder, {
        predicate: 'works_at',
        createdAt: at(10),
        assertionId: ids.worksAtAssertion,
      }),
      store.doc('knowledgeGraphAssertions', ids.worksAtAssertion).set({
        id: ids.worksAtAssertion,
        agentId,
        semanticRevision: 3,
        lifecycle: 'current',
        reviewStatus: 'confirmed',
        subjectEntityId: ids.anna,
        predicate: 'works_at',
        objectEntityId: ids.acme,
      }),
      store.doc('knowledgeGraphAssertionEvidence', ids.worksAtEvidence).set({
        id: ids.worksAtEvidence,
        agentId,
        assertionId: ids.worksAtAssertion,
      }),
      relation(ids.confirmed, ids.annaJ, ids.acme, ids.memoryConfirmed, {
        predicate: 'works_at',
        reviewStatus: 'confirmed',
        createdAt: at(20),
      }),
      relation(ids.stale, ids.anna, ids.oslo, ids.memoryStale, { createdAt: at(2) }),
      relation(ids.rejected, ids.anna, ids.acme, ids.memoryActive, {
        predicate: 'founded',
        reviewStatus: 'rejected',
        createdAt: at(3),
      }),
      relation(ids.unembedded, ids.anna, ids.acme, ids.memoryUnembedded, { createdAt: at(4) }),
      store.doc('knowledgeGraphRelations', ids.foreignRelation).set({
        id: ids.foreignRelation,
        agentId: foreignAgentId,
        subjectEntityId: ids.foreign,
        objectEntityId: ids.orphan,
        sourceMemoryId: ids.memoryForeign,
        predicate: 'knows',
        reviewStatus: 'unreviewed',
        evidenceQuote: 'quoted',
        createdAt: now,
      }),
    ]);
  });

  afterAll(async () => {
    if (emulator) await disposeStore(store);
  });

  it('counts memory health, active graph, pending and failed sources, and orphans', async () => {
    const snapshot = await repository.snapshot({ extractionVersion: VERSION, now });
    expect(snapshot.memory).toEqual({
      totalUsable: 6,
      notYetOrganized: 5,
      awaitingReview: 1,
      ownerConfirmed: 1,
      lastOrganizedAt: at(5),
    });
    expect(snapshot.graph).toEqual({
      activeEntities: 4,
      activeRelations: 3,
      // The foreign relation's endpoint does not count as a connection for the owner.
      orphanedEntities: 1,
      // One source has a changed hash and one memory was never mapped.
      pendingSources: 2,
      failedSources: 1,
    });
    expect(snapshot.cleanup.orphanedEntities).toBe(1);
    expect(snapshot.cleanup.memories).toEqual([
      {
        id: ids.memoryQuarantined,
        content: 'Unverified claim',
        quarantined: true,
        supersededById: null,
      },
      { id: ids.memoryExpired, content: 'Expired claim', quarantined: false, supersededById: null },
    ]);
    expect(snapshot.cleanup.relations.map((row) => row.id)).toEqual([
      ids.active,
      ids.stale,
      ids.rejected,
      ids.unembedded,
      ids.older,
    ]);
    expect(snapshot.cleanup.relations[0]).toMatchObject({
      memoryId: ids.memoryActive,
      content: 'Anna lives in Oslo',
    });
    expect(snapshot.cleanup.sources).toEqual([
      { memoryId: ids.memoryQuarantined, status: 'quarantined' },
    ]);
  });

  it('serves recency-ordered map edges with exact totals, filters, and hydrated sources', async () => {
    const snapshot = await repository.snapshot({ extractionVersion: VERSION, now });
    const all = await snapshot.mapEdges(
      { query: '', kind: '', predicates: [], review: 'all', sourceMemoryId: '' },
      2,
    );
    expect(all.total).toBe(3);
    expect(all.rows.map((row) => row.id)).toEqual([ids.active, ids.older]);
    expect(all.rows[0]).toMatchObject({
      subjectLabel: 'Anna',
      subjectContactId: contactId,
      objectLabel: 'Oslo, Norway',
      sourceContent: 'Anna lives in Oslo',
    });
    expect(all.rows[1]?.assertionContext).toEqual({
      id: ids.worksAtAssertion,
      semanticRevision: 3,
      lifecycle: 'current',
      reviewStatus: 'confirmed',
      subjectEntityId: ids.anna,
      predicate: 'works_at',
      objectEntityId: ids.acme,
      evidenceCount: 1,
    });
    const norway = await snapshot.mapEdges(
      { query: 'NORWAY', kind: '', predicates: [], review: 'all', sourceMemoryId: '' },
      10,
    );
    expect(norway.rows.map((row) => row.id)).toEqual([ids.active]);
    const confirmed = await snapshot.mapEdges(
      { query: '', kind: '', predicates: ['works_at'], review: 'confirmed', sourceMemoryId: '' },
      10,
    );
    expect(confirmed.rows.map((row) => row.id)).toEqual([ids.confirmed]);
    const focused = await snapshot.mapEdges(
      {
        query: '',
        kind: 'organization',
        predicates: [],
        review: 'all',
        sourceMemoryId: ids.memoryOlder,
        entityId: ids.anna,
      },
      10,
    );
    expect(focused).toMatchObject({ total: 1, rows: [{ id: ids.older }] });
    expect((await snapshot.interiorEdges([ids.anna, ids.acme], 10)).map((row) => row.id)).toEqual([
      ids.older,
    ]);
    expect(JSON.stringify(all)).not.toContain(ids.foreignRelation);
  });

  it('focuses one owner entity with stale evidence and duplicate hints', async () => {
    const snapshot = await repository.snapshot({ extractionVersion: VERSION, now });
    const focus = await snapshot.focus(ids.anna);
    expect(focus?.selected).toEqual({
      id: ids.anna,
      label: 'Anna',
      kind: 'person',
      canonicalKey: `contact:${contactId}`,
    });
    expect(focus?.duplicates).toEqual([
      { targetId: ids.annaJ, label: 'Anna Jónsdóttir', kind: 'person', reason: 'matching name' },
    ]);
    expect(focus?.relations.map((row) => [row.id, row.inRecall])).toEqual([
      [ids.active, true],
      [ids.stale, false],
      [ids.unembedded, false],
      [ids.older, true],
      [ids.rejected, false],
    ]);
    expect(await snapshot.focus(ids.foreign)).toBeNull();
  });

  it('reads one bounded neighbourhood, confirmed first, with the exact active degree', async () => {
    const acme = await repository.neighborhood({
      entityId: ids.acme,
      limit: 1,
      predicates: [],
      extractionVersion: VERSION,
      now,
    });
    expect(acme.total).toBe(2);
    expect(acme.edges).toEqual([
      {
        id: ids.confirmed,
        predicate: 'works_at',
        outbound: false,
        reviewStatus: 'confirmed',
        validFrom: null,
        validUntil: null,
        other: {
          id: ids.annaJ,
          label: 'Anna Jónsdóttir',
          kind: 'person',
          canonicalKey: 'person:anna jónsdóttir',
        },
      },
    ]);
    const anna = await repository.neighborhood({
      entityId: ids.anna,
      limit: 10,
      predicates: ['lives_in'],
      extractionVersion: VERSION,
      now,
    });
    expect(anna).toMatchObject({ total: 1, edges: [{ id: ids.active, outbound: true }] });
    expect(
      await repository.neighborhood({
        entityId: ids.foreign,
        limit: 10,
        predicates: [],
        extractionVersion: VERSION,
        now,
      }),
    ).toEqual({ entity: null, edges: [], total: 0 });
    expect(await repository.entity(ids.foreign)).toBeNull();
    expect(await repository.entity(ids.oslo)).toMatchObject({ label: 'Oslo, Norway' });
  });

  it('resolves a person graph entity and refuses the owner or unknown contacts', async () => {
    expect(await repository.personEntity(contactId)).toEqual({ entityId: ids.anna });
    expect(await repository.personEntity(ownerContactId)).toBeNull();
    expect(await repository.personEntity(randomUUID())).toBeNull();
  });

  it('reports what forgetting one source removes from the graph', async () => {
    const sourceOnly = randomUUID();
    const orphanMemory = randomUUID();
    const orphanRelation = randomUUID();
    await Promise.all([
      entity(sourceOnly, 'Only Here', 'topic'),
      memory(orphanMemory, 'Anna likes Only Here'),
      source(orphanMemory),
      relation(orphanRelation, ids.anna, sourceOnly, orphanMemory, { predicate: 'likes' }),
    ]);
    try {
      expect(
        await repository.sourceImpact({ memoryId: orphanMemory, extractionVersion: VERSION, now }),
      ).toEqual({
        content: 'Anna likes Only Here',
        connectionCount: 1,
        activeConnectionCount: 1,
        orphanedItems: [{ id: sourceOnly, label: 'Only Here' }],
      });
      expect(
        await repository.sourceImpact({
          memoryId: ids.memoryActive,
          extractionVersion: VERSION,
          now,
        }),
      ).toEqual({
        content: 'Anna lives in Oslo',
        connectionCount: 2,
        activeConnectionCount: 1,
        orphanedItems: [],
      });
      expect(
        await repository.sourceImpact({
          memoryId: ids.memoryForeign,
          extractionVersion: VERSION,
          now,
        }),
      ).toBeNull();
    } finally {
      await Promise.all([
        store.doc('knowledgeGraphRelations', orphanRelation).delete(),
        store.doc('knowledgeGraphEntities', sourceOnly).delete(),
        store.doc('memories', orphanMemory).delete(),
        store.doc('knowledgeGraphSources', orphanMemory).delete(),
      ]);
    }
  });

  it('fails closed during privacy erasure', async () => {
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'running' });
    try {
      await expect(repository.snapshot({ extractionVersion: VERSION, now })).rejects.toThrow(
        'Privacy erasure is in progress',
      );
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });
  it.each([
    ['old embedding space', { embeddingSpace: embeddingSpaceKey({ ...space, revision: 'old' }) }],
    ['missing vector', { embedding: null }],
    ['wrong dimensions', { embedding: [0.1, 0.2] }],
    ['zero vector', { embedding: Array(1536).fill(0) }],
    ['superseded source', { supersededById: 'replacement' }],
    ['expired source', { expiresAt: new Date('2020-01-01T00:00:00Z') }],
    ['tombstoned source', {}],
  ])('does not label %s searchable when actual traversal rejects it', async (label, patch) => {
    const ref = store.doc('memories', ids.memoryActive);
    const saved = (await ref.get()).data();
    if (!saved) throw new Error('Missing active fixture');
    const tombstone = store.doc('memoryTombstones', `hash-${ids.memoryActive}`);
    try {
      if (Object.keys(patch).length) await ref.update(patch);
      if (label === 'tombstoned source')
        await tombstone.set({ contentHash: `hash-${ids.memoryActive}` });
      const snapshot = await repository.snapshot({ extractionVersion: VERSION, now });
      const focus = await snapshot.focus(ids.anna);
      expect(focus?.relations.find((row) => row.id === ids.active)?.inRecall).toBe(false);
      const runtime = new FirestoreGraphRecallRepository(store, space);
      const traversed = await runtime.connected({
        agentId,
        entityIds: [ids.anna],
        sourceMemoryIds: [],
        limit: 20,
        extractionVersion: VERSION,
      });
      expect(traversed.map((row) => row.relationId)).not.toContain(ids.active);
    } finally {
      await ref.set(saved);
      await tombstone.delete();
    }
  });
});
