import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFirestoreKnowledgeGraphRelation } from './knowledge-graph-read.js';
import { FirestoreKnowledgeGraphRelationMutationRepository } from './knowledge-graph-relation-mutations.js';
import { embeddingSpaceKey } from './memory.js';
import { createInstallationStore } from './store.js';

const space = { provider: 'vertex', model: 'fixture', dimensions: 1, revision: 'v1' };
const emulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');

describe.skipIf(!emulator)('Firestore owner knowledge relationship review', () => {
  const agentId = randomUUID();
  const memoryId = randomUUID();
  const subjectId = randomUUID();
  const objectId = randomUUID();
  const relationId = randomUUID();
  const now = new Date('2026-09-23T12:00:00.000Z');
  const store = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId: `graph-relation-review-${randomUUID()}`,
    databaseId: 'assistant-graph-relation-review-test',
  });
  const repository = new FirestoreKnowledgeGraphRelationMutationRepository(store, agentId);

  beforeAll(async () => {
    const batch = store.db.batch();
    batch.set(store.doc('agents', agentId), { id: agentId });
    batch.set(store.doc('knowledgeGraphEntities', subjectId), {
      id: subjectId,
      agentId,
      kind: 'person',
      canonicalKey: 'person:owner',
      label: 'Owner',
      preferredLabel: null,
    });
    batch.set(store.doc('knowledgeGraphEntities', objectId), {
      id: objectId,
      agentId,
      kind: 'place',
      canonicalKey: 'place:home',
      label: 'Home',
      preferredLabel: null,
    });
    batch.set(store.doc('memories', memoryId), {
      id: memoryId,
      agentId,
      category: 'knowledge',
      content: 'Owner lives in Home.',
      contentHash: 'review-source-hash',
      createdAt: now,
      expiresAt: null,
      quarantined: false,
      embedding: [0.1],
      embeddingSpace: embeddingSpaceKey(space),
      ownerConfirmed: true,
      originTrust: 'owner',
    });
    batch.set(store.doc('knowledgeGraphSources', memoryId), {
      memoryId,
      status: 'ready',
      contentHash: 'review-source-hash',
      extractionVersion: 1,
    });
    batch.set(store.doc('knowledgeGraphRelations', relationId), {
      id: relationId,
      agentId,
      subjectEntityId: subjectId,
      objectEntityId: objectId,
      sourceMemoryId: memoryId,
      predicate: 'lives_in',
      confidence: '1.00',
      reviewStatus: 'unreviewed',
      reviewedAt: null,
      validFrom: null,
      validUntil: null,
      evidenceQuote: 'Owner lives in Home.',
      createdAt: now,
    });
    await batch.commit();
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
  });

  it('reads one source-backed relation and retains evidence across confirmation and rejection', async () => {
    const before = await getFirestoreKnowledgeGraphRelation(
      store,
      agentId,
      1,
      relationId,
      now,
      space,
    );
    expect(before).toMatchObject({
      id: relationId,
      reviewStatus: 'unreviewed',
      inRecall: true,
      source: { memoryId, content: 'Owner lives in Home.' },
    });
    expect(await repository.review(relationId, 'confirmed')).toBe(true);
    expect(
      await getFirestoreKnowledgeGraphRelation(store, agentId, 1, relationId, now, space),
    ).toMatchObject({
      reviewStatus: 'confirmed',
      inRecall: true,
    });
    expect(await repository.review(relationId, 'rejected')).toBe(true);
    expect(
      await getFirestoreKnowledgeGraphRelation(store, agentId, 1, relationId, now, space),
    ).toMatchObject({
      reviewStatus: 'rejected',
      inRecall: false,
      source: { memoryId, content: 'Owner lives in Home.' },
    });
  });

  it('rejects foreign ownership and an active erasure without changing review state', async () => {
    const foreign = new FirestoreKnowledgeGraphRelationMutationRepository(store, randomUUID());
    await expect(foreign.review(relationId, 'confirmed')).rejects.toThrow('configured owner');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(repository.review(relationId, 'confirmed')).rejects.toThrow('Privacy erasure');
    expect((await store.doc('knowledgeGraphRelations', relationId).get()).get('reviewStatus')).toBe(
      'rejected',
    );
    await store.doc('privacyErasureJobs', agentId).delete();
  });
});
