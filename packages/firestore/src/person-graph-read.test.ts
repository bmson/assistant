import { randomUUID } from 'node:crypto';
import { FieldValue } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embeddingSpaceKey } from './memory.js';
import { getFirestorePersonGraph } from './person-graph-read.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space = { provider: 'vertex', model: 'fixture', dimensions: 2, revision: 'v1' };
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore source-backed person graph', () => {
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const contactId = randomUUID();
  const ownerContactId = randomUUID();
  const personContactId = randomUUID();
  const selfId = randomUUID();
  const placeId = randomUUID();
  const personId = randomUUID();
  const now = new Date('2026-09-22T12:00:00Z');
  let store: InstallationStore;

  beforeEach(async () => {
    store = emulatorStore(() => now);
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('contacts', contactId).set({
        id: contactId,
        name: 'Anna',
        relationship: 'daughter',
        trust: 'confirmed',
      }),
      store.doc('contacts', ownerContactId).set({
        id: ownerContactId,
        name: 'Owner',
        relationship: '',
        trust: 'owner',
      }),
      store.doc('knowledgeGraphEntities', selfId).set({
        id: selfId,
        agentId,
        contactId,
        label: 'Anna old',
        preferredLabel: 'Anna graph',
        kind: 'person',
        canonicalKey: `contact:${contactId}`,
      }),
      store.doc('knowledgeGraphEntities', placeId).set({
        id: placeId,
        agentId,
        contactId: null,
        label: 'Reykjavík',
        preferredLabel: null,
        kind: 'place',
        canonicalKey: 'place:reykjavik',
      }),
      store.doc('knowledgeGraphEntities', personId).set({
        id: personId,
        agentId,
        contactId: personContactId,
        label: 'Björk',
        preferredLabel: null,
        kind: 'person',
        canonicalKey: `contact:${personContactId}`,
      }),
    ]);
  });
  afterEach(async () => {
    await disposeStore(store);
  });

  async function edge(
    id: string,
    patch: Record<string, unknown> = {},
    memoryPatch: Record<string, unknown> = {},
    sourcePatch: Record<string, unknown> = {},
  ) {
    await Promise.all([
      store.doc('knowledgeGraphRelations', id).set({
        id,
        agentId,
        subjectEntityId: selfId,
        objectEntityId: placeId,
        sourceMemoryId: id,
        predicate: 'lives_in',
        reviewStatus: 'confirmed',
        evidenceQuote: 'lives in Reykjavík',
        validFrom: null,
        validUntil: null,
        createdAt: new Date('2026-09-20T12:00:00Z'),
        ...patch,
      }),
      store.doc('memories', id).set({
        id,
        agentId,
        category: 'knowledge',
        quarantined: false,
        expiresAt: null,
        embedding: FieldValue.vector([1, 0]),
        embeddingSpace: embeddingSpaceKey(space),
        contentHash: `hash-${id}`,
        ...memoryPatch,
      }),
      store.doc('knowledgeGraphSources', id).set({
        memoryId: id,
        status: 'ready',
        contentHash: `hash-${id}`,
        extractionVersion: 2,
        ...sourcePatch,
      }),
    ]);
  }

  it('rejects stale spaces, missing and malformed vectors, retired facts and tombstones', async () => {
    await edge('current');
    await edge(
      'old-space',
      {},
      {
        embeddingSpace: embeddingSpaceKey({ ...space, revision: 'old' }),
      },
    );
    await edge('missing', {}, { embedding: null });
    await edge('malformed', {}, { embedding: FieldValue.vector([1]) });
    await edge('retired', {}, { supersededById: 'replacement' });
    await edge('forgotten');
    await store.doc('memoryTombstones', 'hash-forgotten').set({ contentHash: 'hash-forgotten' });
    expect(
      (await getFirestorePersonGraph(store, agentId, contactId, 2, undefined, space))?.edges.map(
        (row) => row.id,
      ),
    ).toEqual(['current']);
    expect((await getFirestorePersonGraph(store, agentId, contactId, 2))?.edges).toEqual([]);
  });

  it('returns current sourced edges with stored direction and preferred other labels', async () => {
    await edge('location');
    await edge('incoming', {
      subjectEntityId: personId,
      objectEntityId: selfId,
      predicate: 'parent_of',
      reviewStatus: 'unreviewed',
    });
    const result = await getFirestorePersonGraph(store, agentId, contactId, 2, undefined, space);
    expect(result).toEqual({
      entityId: selfId,
      edges: [
        {
          id: 'location',
          predicate: 'lives_in',
          outbound: true,
          reviewStatus: 'confirmed',
          validFrom: null,
          validUntil: null,
          other: {
            id: placeId,
            label: 'Reykjavík',
            kind: 'place',
            canonicalKey: 'place:reykjavik',
          },
        },
        {
          id: 'incoming',
          predicate: 'parent_of',
          outbound: false,
          reviewStatus: 'unreviewed',
          validFrom: null,
          validUntil: null,
          other: {
            id: personId,
            label: 'Björk',
            kind: 'person',
            canonicalKey: `contact:${personContactId}`,
          },
        },
      ],
    });
  });

  it('excludes stale, rejected, expired, quarantined, and foreign evidence', async () => {
    await edge('active');
    await edge('rejected', { reviewStatus: 'rejected' });
    await edge('stale-source', {}, {}, { contentHash: 'wrong' });
    await edge('pending-source', {}, {}, { status: 'pending' });
    await edge('old-version', {}, {}, { extractionVersion: 1 });
    await edge('quarantined', {}, { quarantined: true });
    await edge('expired', {}, { expiresAt: new Date('2026-09-21T12:00:00Z') });
    await edge('unembedded', {}, { embedding: null });
    await edge('foreign-memory', {}, { agentId: otherAgentId });
    await edge('foreign-entity');
    await store.doc('knowledgeGraphEntities', placeId).update({ agentId: otherAgentId });
    await edge('unquoted', { evidenceQuote: null });
    const result = await getFirestorePersonGraph(store, agentId, contactId, 2, undefined, space);
    expect(result?.edges).toEqual([]);
    await store.doc('knowledgeGraphEntities', placeId).update({ agentId });
    expect(
      (await getFirestorePersonGraph(store, agentId, contactId, 2, undefined, space))?.edges.map(
        (row) => row.id,
      ),
    ).toEqual(['active', 'foreign-entity']);
  });

  it('uses the canonical owner decision even when a linked relation projection is stale', async () => {
    await edge('canonical-rejected');
    const assertionId = randomUUID();
    await store.doc('knowledgeGraphRelations', 'canonical-rejected').update({ assertionId });
    await store.doc('knowledgeGraphAssertions', assertionId).set({
      id: assertionId,
      agentId,
      semanticKey: randomUUID(),
      subjectEntityId: selfId,
      predicate: 'lives_in',
      objectEntityId: placeId,
      assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
      qualifiers: {},
      validFrom: null,
      validUntil: null,
      semanticRevision: 1,
      evidenceRevision: 1,
      lifecycle: 'current',
      reviewStatus: 'rejected',
      reviewedRevision: 1,
      reviewedPayloadHash: null,
      ownerAuthored: false,
      supersededById: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(
      (await getFirestorePersonGraph(store, agentId, contactId, 2, undefined, space))?.edges,
    ).toEqual([]);
  });

  it('refuses owner and missing contacts, mismatched agents, and active erasure', async () => {
    expect(
      await getFirestorePersonGraph(store, agentId, ownerContactId, 2, undefined, space),
    ).toBeNull();
    expect(
      await getFirestorePersonGraph(store, agentId, randomUUID(), 2, undefined, space),
    ).toBeNull();
    await expect(
      getFirestorePersonGraph(store, otherAgentId, contactId, 2, undefined, space),
    ).rejects.toThrow('exactly one configured agent');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(
      getFirestorePersonGraph(store, agentId, contactId, 2, undefined, space),
    ).rejects.toThrow('Privacy erasure is in progress');
  });

  it('fails closed above the relation scan bound', async () => {
    const batch = store.db.batch();
    for (let index = 0; index < 121; index++) {
      const id = `extra-${index}`;
      batch.set(store.doc('knowledgeGraphRelations', id), {
        id,
        agentId,
        subjectEntityId: selfId,
        objectEntityId: placeId,
        sourceMemoryId: id,
      });
    }
    await batch.commit();
    await expect(
      getFirestorePersonGraph(store, agentId, contactId, 2, undefined, space),
    ).rejects.toThrow('relation scan bound reached');
  });
});
