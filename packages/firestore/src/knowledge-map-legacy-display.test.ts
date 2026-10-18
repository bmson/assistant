import { randomUUID } from 'node:crypto';
import { legacyKnowledgeMapDisplayPolicy } from '@assistant/application';
import { afterEach, describe, expect, it } from 'vitest';
import { FirestoreGraphRecallRepository } from './graph-recall.js';
import { FirestoreKnowledgeWorkspaceReadRepository } from './knowledge-workspace-read.js';
import { embeddingSpaceKey } from './memory.js';
import { disposeStore, emulatorStore } from './test-store.js';

const emulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');
const space = { provider: 'test', model: 'fixture', dimensions: 1536, revision: '1' };
const now = new Date('2026-10-18T12:00:00Z');
const filters = { query: '', kind: '', predicates: [], review: 'all' as const, sourceMemoryId: '' };

describe.skipIf(!emulator)('legacy map display compatibility', () => {
  const stores: ReturnType<typeof emulatorStore>[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map(disposeStore));
  });

  async function fixture(version = 2) {
    const store = emulatorStore(() => now);
    stores.push(store);
    const agentId = randomUUID();
    const anna = randomUUID();
    const oslo = randomUUID();
    const memoryId = randomUUID();
    const relationId = randomUUID();
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      ...[
        [anna, 'Anna', 'person'],
        [oslo, 'Oslo', 'place'],
      ].map(([id, label, kind]) =>
        store.doc('knowledgeGraphEntities', id as string).set({
          id,
          agentId,
          label,
          kind,
          preferredLabel: `${label} preferred`,
          canonicalKey: `${kind}:${label}`,
          contactId: null,
        }),
      ),
      store.doc('memories', memoryId).set({
        id: memoryId,
        agentId,
        content: 'Anna lives in Oslo.',
        category: 'knowledge',
        quarantined: false,
        expiresAt: null,
        supersededById: null,
        subjectContactId: null,
        contentHash: 'source-hash',
        embeddingSpace: embeddingSpaceKey(space),
        embedding: Array.from({ length: 1536 }, (_, index) => (index === 0 ? 0.1 : 0)),
        ownerConfirmed: false,
        createdAt: now,
        lastConsolidatedAt: null,
      }),
      store.doc('knowledgeGraphSources', memoryId).set({
        memoryId,
        status: 'ready',
        contentHash: 'source-hash',
        subjectContactId: null,
        extractionVersion: version,
      }),
      store.doc('knowledgeGraphRelations', relationId).set({
        id: relationId,
        agentId,
        subjectEntityId: anna,
        objectEntityId: oslo,
        sourceMemoryId: memoryId,
        predicate: 'lives_in',
        evidenceQuote: 'Anna lives in Oslo',
        assertionId: null,
        assertion:
          version >= 4 ? { tense: 'present', polarity: 'positive', modality: 'asserted' } : null,
        reviewStatus: 'confirmed',
        confidence: '0.9',
        createdAt: now,
        validFrom: null,
        validUntil: null,
      }),
    ]);
    const strict = new FirestoreKnowledgeWorkspaceReadRepository(store, agentId, space);
    const display = new FirestoreKnowledgeWorkspaceReadRepository(
      store,
      agentId,
      space,
      legacyKnowledgeMapDisplayPolicy(),
    );
    const input = { extractionVersion: 4, now };
    const neighborhood = () =>
      display.neighborhood({ ...input, entityId: anna, limit: 1, predicates: [] });
    const map = async () => (await display.snapshot(input)).mapEdges(filters, 1);
    return {
      store,
      agentId,
      anna,
      oslo,
      memoryId,
      relationId,
      strict,
      display,
      input,
      neighborhood,
      map,
    };
  }

  it.each([2, 3])(
    'displays grounded version %i without promoting it into recall or rewriting data',
    async (version) => {
      const f = await fixture(version);
      expect((await f.strict.snapshot(f.input)).graph.activeRelations).toBe(0);
      const snapshot = await f.display.snapshot(f.input);
      expect(snapshot.graph).toMatchObject({
        activeEntities: 2,
        activeRelations: 1,
        pendingSources: 1,
      });
      expect(await f.map()).toMatchObject({
        total: 1,
        rows: [{ id: f.relationId, subjectLabel: 'Anna preferred' }],
      });
      expect(await f.neighborhood()).toMatchObject({
        total: 1,
        edges: [{ id: f.relationId, outbound: true }],
      });
      expect((await snapshot.focus(f.anna))?.relations).toMatchObject([
        { id: f.relationId, inRecall: false },
      ]);
      expect(await f.display.sourceImpact({ ...f.input, memoryId: f.memoryId })).toMatchObject({
        connectionCount: 1,
        activeConnectionCount: 0,
      });
      const recall = new FirestoreGraphRecallRepository(f.store, space);
      expect(
        await recall.connected({
          agentId: f.agentId,
          entityIds: [f.anna],
          sourceMemoryIds: [],
          extractionVersion: 4,
          limit: 10,
        }),
      ).toEqual([]);
      expect(
        (await f.store.doc('knowledgeGraphSources', f.memoryId).get()).get('extractionVersion'),
      ).toBe(version);
      expect((await f.store.collection('knowledgeGraphAssertions').get()).empty).toBe(true);
    },
  );

  it('keeps current-version recall eligibility and review status', async () => {
    const f = await fixture(4);
    expect((await f.strict.snapshot(f.input)).graph.activeRelations).toBe(1);
    expect((await (await f.display.snapshot(f.input)).focus(f.anna))?.relations).toMatchObject([
      { inRecall: true, reviewStatus: 'confirmed' },
    ]);
    expect(await f.display.sourceImpact({ ...f.input, memoryId: f.memoryId })).toMatchObject({
      activeConnectionCount: 1,
    });
    const recall = new FirestoreGraphRecallRepository(f.store, space);
    expect(
      await recall.connected({
        agentId: f.agentId,
        entityIds: [f.anna],
        sourceMemoryIds: [],
        extractionVersion: 4,
        limit: 10,
      }),
    ).toHaveLength(1);
  });

  it.each([null, { tense: 'present', polarity: 'positive', modality: 'unverified' }])(
    'does not label current-version unverified evidence as recallable',
    async (assertion) => {
      const f = await fixture(4);
      await f.store.doc('knowledgeGraphRelations', f.relationId).update({ assertion });
      expect((await f.map()).total).toBe(1);
      expect((await (await f.display.snapshot(f.input)).focus(f.anna))?.relations).toMatchObject([
        { inRecall: false },
      ]);
      expect(await f.display.sourceImpact({ ...f.input, memoryId: f.memoryId })).toMatchObject({
        activeConnectionCount: 0,
      });
      const recall = new FirestoreGraphRecallRepository(f.store, space);
      expect(
        await recall.connected({
          agentId: f.agentId,
          entityIds: [f.anna],
          sourceMemoryIds: [],
          extractionVersion: 4,
          limit: 10,
        }),
      ).toEqual([]);
    },
  );

  it.each([
    ['old version', 'source', { extractionVersion: 1 }],
    ['not ready', 'source', { status: 'pending' }],
    ['changed source hash', 'memory', { contentHash: 'changed' }],
    ['wrong attribution', 'source', { subjectContactId: 'someone-else' }],
    ['missing vector', 'memory', { embedding: null }],
    ['wrong dimensions', 'memory', { embedding: [0.1] }],
    [
      'wrong embedding space',
      'memory',
      { embeddingSpace: embeddingSpaceKey({ ...space, revision: 'other' }) },
    ],
    ['quarantine', 'memory', { quarantined: true }],
    ['superseded', 'memory', { supersededById: 'replacement' }],
    ['expired', 'memory', { expiresAt: new Date(now.getTime() - 1) }],
    ['foreign owner', 'memory', { agentId: 'foreign' }],
    ['rejected review', 'relation', { reviewStatus: 'rejected' }],
    ['linked legacy assertion', 'relation', { assertionId: 'unsupported-assertion' }],
    ['invented quotation', 'memory', { content: 'Anna visits Bergen.' }],
    ['negation', 'memory', { content: 'Anna does not live in Oslo.' }],
    ['uncertainty', 'memory', { content: 'Anna might live in Oslo.' }],
    ['reported claim', 'memory', { content: 'Someone said Anna lives in Oslo.' }],
  ] as const)(
    'excludes %s from counts, the map and targeted neighborhoods',
    async (_, target, patch) => {
      const f = await fixture();
      const ref =
        target === 'memory'
          ? f.store.doc('memories', f.memoryId)
          : target === 'source'
            ? f.store.doc('knowledgeGraphSources', f.memoryId)
            : f.store.doc('knowledgeGraphRelations', f.relationId);
      await ref.update(patch);
      expect((await f.display.snapshot(f.input)).graph.activeRelations).toBe(0);
      expect(await f.map()).toEqual({ total: 0, rows: [] });
      expect(await f.neighborhood()).toMatchObject({ total: 0, edges: [] });
    },
  );

  it('requires canonical labels and preserves privacy tombstones on both display paths', async () => {
    const f = await fixture();
    await f.store
      .doc('knowledgeGraphEntities', f.anna)
      .update({ label: 'Annabelle', preferredLabel: 'Anna' });
    expect((await f.map()).total).toBe(0);
    expect((await f.neighborhood()).total).toBe(0);
    await f.store.doc('knowledgeGraphEntities', f.anna).update({ label: 'Anna' });
    await f.store.doc('memoryTombstones', 'source-hash').set({ erasedAt: now });
    expect((await f.map()).total).toBe(0);
    expect((await f.neighborhood()).total).toBe(0);
  });

  it('blocks compatibility reads while privacy erasure is running', async () => {
    const f = await fixture();
    await f.store
      .doc('privacyErasureJobs', f.agentId)
      .set({ agentId: f.agentId, status: 'running' });
    await expect(f.map()).rejects.toThrow('Privacy erasure is in progress');
    await expect(f.neighborhood()).rejects.toThrow('Privacy erasure is in progress');
    await expect(f.display.sourceImpact({ ...f.input, memoryId: f.memoryId })).rejects.toThrow(
      'Privacy erasure is in progress',
    );
  });
});
