import { randomUUID } from 'node:crypto';
import {
  canonicalizeKnowledgeAssertionDirection,
  knowledgeAssertionEvidenceId,
  knowledgeAssertionId,
  knowledgeAssertionSemanticKey,
} from '@assistant/persistence';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreKnowledgeGraphCurationRepository } from './knowledge-graph-curation.js';
import { decodeRecord } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const emulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');

describe.skipIf(!emulator)('Firestore knowledge graph curation', () => {
  const store = emulator ? emulatorStore() : (null as never);
  const repository = emulator
    ? new FirestoreKnowledgeGraphCurationRepository(store)
    : (null as never);
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const now = new Date('2026-09-25T12:00:00.000Z');

  function entity(label: string, kind: string, patch: Record<string, unknown> = {}) {
    const id = randomUUID();
    return store
      .doc('knowledgeGraphEntities', id)
      .set({
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
      })
      .then(() => id);
  }

  function relation(
    subjectEntityId: string,
    objectEntityId: string,
    patch: Record<string, unknown> = {},
  ) {
    const id = randomUUID();
    return store
      .doc('knowledgeGraphRelations', id)
      .set({
        id,
        agentId,
        subjectEntityId,
        objectEntityId,
        sourceMemoryId: 'memory-1',
        predicate: 'works_at',
        confidence: '0.80',
        reviewStatus: 'unreviewed',
        reviewedAt: null,
        validFrom: null,
        validUntil: null,
        evidenceQuote: 'quoted',
        sourceFingerprint: id,
        ordinal: 0,
        createdAt: now,
        ...patch,
      })
      .then(() => id);
  }

  function alias(canonicalKey: string, entityId: string) {
    const id = randomUUID();
    return store
      .doc('knowledgeGraphEntityAliases', id)
      .set({ id, agentId, canonicalKey, entityId, createdAt: now })
      .then(() => id);
  }

  const data = async (collection: string, id: string) =>
    decodeRecord<Record<string, unknown>>((await store.doc(collection, id).get()).data());
  const aliasesFor = async (canonicalKey: string) =>
    (
      await store
        .collection('knowledgeGraphEntityAliases')
        .where('agentId', '==', agentId)
        .where('canonicalKey', '==', canonicalKey)
        .get()
    ).docs.map((doc) => doc.data());

  beforeEach(async () => {
    await store.db.recursiveDelete(store.root);
    await store.doc('agents', agentId).set({ id: agentId });
  });

  afterAll(async () => {
    if (emulator) await disposeStore(store);
  });

  it('renames an owner entity and refuses a foreign one', async () => {
    const own = await entity('Acme', 'organization');
    const foreign = await entity('Other', 'organization', { agentId: foreignAgentId });
    expect(await repository.rename(agentId, own, 'Acme Corp')).toBe(true);
    expect(await data('knowledgeGraphEntities', own)).toMatchObject({
      label: 'Acme',
      preferredLabel: 'Acme Corp',
    });
    expect(await repository.rename(agentId, foreign, 'Mine')).toBe(false);
    expect(await repository.rename(agentId, randomUUID(), 'Missing')).toBe(false);
    expect((await data('knowledgeGraphEntities', foreign))?.preferredLabel).toBeNull();
  });

  it('re-keys a retyped entity, records the old key as an alias, and declines conflicts', async () => {
    const acme = await entity('Acme', 'topic');
    const input = {
      entityId: acme,
      fromKey: 'topic:acme',
      kind: 'organization',
      canonicalKey: 'organization:acme',
      contactId: null,
    };
    expect(await repository.retype(agentId, input)).toBe('updated');
    expect(await data('knowledgeGraphEntities', acme)).toMatchObject({
      kind: 'organization',
      canonicalKey: 'organization:acme',
    });
    expect(await aliasesFor('topic:acme')).toEqual([
      expect.objectContaining({ agentId, entityId: acme }),
    ]);
    expect(await repository.retype(agentId, input)).toBe('changed');
    const project = await entity('Acme', 'project');
    expect(
      await repository.retype(agentId, {
        entityId: project,
        fromKey: 'project:acme',
        kind: 'organization',
        canonicalKey: 'organization:acme',
        contactId: null,
      }),
    ).toBe('conflict');
    expect((await data('knowledgeGraphEntities', project))?.kind).toBe('project');
    expect(await repository.retype(agentId, { ...input, entityId: randomUUID() })).toBe('missing');
  });

  it('merges one entity into another and keeps the graph consistent', async () => {
    const anna = await entity('Anna', 'person');
    const annaJ = await entity('Anna Jónsdóttir', 'person');
    const acme = await entity('Acme', 'organization');
    const oslo = await entity('Oslo', 'place');
    const moved = await relation(anna, oslo, { predicate: 'lives_in' });
    const duplicateUnreviewed = await relation(anna, acme, { confidence: '0.99' });
    const survivorConfirmed = await relation(annaJ, acme, { reviewStatus: 'confirmed' });
    const selfLoop = await relation(anna, annaJ, { predicate: 'same_as' });
    const otherSource = await relation(anna, acme, { sourceMemoryId: 'memory-2' });
    const importedKeyAlias = await alias('person:anna', anna);
    const olderAlias = await alias('person:ann', anna);

    expect(await repository.merge(agentId, anna, annaJ)).toBe(true);
    expect((await store.doc('knowledgeGraphEntities', anna).get()).exists).toBe(false);
    expect(await data('knowledgeGraphRelations', moved)).toMatchObject({
      subjectEntityId: annaJ,
      objectEntityId: oslo,
    });
    expect(await data('knowledgeGraphRelations', otherSource)).toMatchObject({
      subjectEntityId: annaJ,
    });
    expect((await store.doc('knowledgeGraphRelations', duplicateUnreviewed).get()).exists).toBe(
      false,
    );
    expect((await store.doc('knowledgeGraphRelations', selfLoop).get()).exists).toBe(false);
    expect(await data('knowledgeGraphRelations', survivorConfirmed)).toMatchObject({
      subjectEntityId: annaJ,
      reviewStatus: 'confirmed',
    });
    expect(await data('knowledgeGraphEntityAliases', importedKeyAlias)).toMatchObject({
      canonicalKey: 'person:anna',
      entityId: annaJ,
    });
    expect(await data('knowledgeGraphEntityAliases', olderAlias)).toMatchObject({
      entityId: annaJ,
    });
    expect(await repository.merge(agentId, anna, annaJ)).toBe(false);
  });

  it('remaps canonical assertions and their evidence while retaining a reviewed meaning', async () => {
    const source = await entity('Reviewed source', 'person');
    const target = await entity('Surviving identity', 'person');
    const employer = await entity('Employer', 'organization');
    const memoryA = randomUUID();
    const memoryB = randomUUID();
    const assertion = {
      tense: 'present' as const,
      polarity: 'positive' as const,
      modality: 'asserted' as const,
    };
    const makeMeaning = (subjectEntityId: string) =>
      canonicalizeKnowledgeAssertionDirection({
        subjectEntityId,
        predicate: 'works_at',
        objectEntityId: employer,
        assertion,
        validFrom: null,
        validUntil: null,
        qualifiers: {},
      });
    const sourceMeaning = makeMeaning(source);
    const targetMeaning = makeMeaning(target);
    const sourceKey = knowledgeAssertionSemanticKey(agentId, sourceMeaning);
    const targetKey = knowledgeAssertionSemanticKey(agentId, targetMeaning);
    const sourceAssertion = knowledgeAssertionId(agentId, sourceKey);
    const targetAssertion = knowledgeAssertionId(agentId, targetKey);
    const relationA = await relation(source, employer, {
      sourceMemoryId: memoryA,
      assertionId: sourceAssertion,
      sourceFingerprint: 'source-a',
      reviewStatus: 'confirmed',
    });
    const relationB = await relation(target, employer, {
      sourceMemoryId: memoryB,
      assertionId: targetAssertion,
      sourceFingerprint: 'source-b',
    });
    const assertionRow = (
      id: string,
      semanticKey: string,
      subjectEntityId: string,
      reviewStatus: string,
    ) => ({
      id,
      agentId,
      semanticKey,
      subjectEntityId,
      predicate: 'works_at',
      objectEntityId: employer,
      assertion,
      qualifiers: {},
      validFrom: null,
      validUntil: null,
      semanticRevision: 1,
      evidenceRevision: 1,
      lifecycle: 'current',
      reviewStatus,
      reviewedRevision: reviewStatus === 'confirmed' ? 1 : null,
      reviewedPayloadHash: reviewStatus === 'confirmed' ? semanticKey : null,
      ownerAuthored: false,
      supersededById: null,
      createdAt: now,
      updatedAt: now,
    });
    await Promise.all([
      store
        .doc('knowledgeGraphAssertions', sourceAssertion)
        .set(assertionRow(sourceAssertion, sourceKey, source, 'confirmed')),
      store
        .doc('knowledgeGraphAssertions', targetAssertion)
        .set(assertionRow(targetAssertion, targetKey, target, 'unreviewed')),
      ...[
        { assertionId: sourceAssertion, sourceMemoryId: memoryA, fingerprint: 'source-a' },
        { assertionId: targetAssertion, sourceMemoryId: memoryB, fingerprint: 'source-b' },
      ].map((evidence) => {
        const id = knowledgeAssertionEvidenceId(
          agentId,
          evidence.assertionId,
          evidence.sourceMemoryId,
          evidence.fingerprint,
        );
        return store.doc('knowledgeGraphAssertionEvidence', id).set({
          id,
          agentId,
          assertionId: evidence.assertionId,
          sourceMemoryId: evidence.sourceMemoryId,
          sourceFingerprint: evidence.fingerprint,
          sourceContentHash: `hash-${evidence.fingerprint}`,
          evidenceQuote: 'Owner explicitly said the person works at Employer.',
          sourceAuthor: 'owner',
          sourceTrust: 'owner',
          independent: false,
          spanStart: 0,
          spanEnd: 48,
          extractionVersion: 1,
          evidenceRevision: 1,
          observedAt: now,
          createdAt: now,
        });
      }),
    ]);

    expect(await repository.merge(agentId, source, target)).toBe(true);
    expect(await data('knowledgeGraphAssertions', sourceAssertion)).toMatchObject({
      lifecycle: 'superseded',
      supersededById: targetAssertion,
    });
    expect(await data('knowledgeGraphAssertions', targetAssertion)).toMatchObject({
      lifecycle: 'current',
      reviewStatus: 'confirmed',
      reviewedPayloadHash: targetKey,
    });
    expect(await data('knowledgeGraphRelations', relationA)).toMatchObject({
      subjectEntityId: target,
      assertionId: targetAssertion,
    });
    expect(await data('knowledgeGraphRelations', relationB)).toMatchObject({
      assertionId: targetAssertion,
    });
    const evidence = await store
      .collection('knowledgeGraphAssertionEvidence')
      .where('agentId', '==', agentId)
      .where('assertionId', '==', targetAssertion)
      .get();
    expect(evidence.docs.map((doc) => doc.get('sourceMemoryId')).sort()).toEqual(
      [memoryA, memoryB].sort(),
    );
  });

  it.each([true, false])(
    'preserves rejected curation in either merge direction: %s',
    async (rejectedAtSource) => {
      const source = await entity('Source', 'person');
      const target = await entity('Target', 'person');
      const object = await entity('Place', 'place');
      const rejected = await relation(rejectedAtSource ? source : target, object, {
        reviewStatus: 'rejected',
        reviewedAt: now,
      });
      const unreviewed = await relation(rejectedAtSource ? target : source, object, {
        reviewStatus: 'unreviewed',
        confidence: '0.99',
      });
      expect(await repository.merge(agentId, source, target)).toBe(true);
      expect(await data('knowledgeGraphRelations', rejected)).toMatchObject({
        reviewStatus: 'rejected',
        reviewedAt: now,
        subjectEntityId: target,
      });
      expect((await store.doc('knowledgeGraphRelations', unreviewed).get()).exists).toBe(false);
    },
  );
  it('refuses a confirmed/rejected conflict without changing either owner decision', async () => {
    const source = await entity('Source', 'person');
    const target = await entity('Target', 'person');
    const object = await entity('Place', 'place');
    const rejected = await relation(source, object, { reviewStatus: 'rejected' });
    const confirmed = await relation(target, object, { reviewStatus: 'confirmed' });
    await expect(repository.merge(agentId, source, target)).rejects.toThrow('Merge conflicts');
    expect(await data('knowledgeGraphRelations', rejected)).toMatchObject({
      subjectEntityId: source,
      reviewStatus: 'rejected',
    });
    expect(await data('knowledgeGraphRelations', confirmed)).toMatchObject({
      subjectEntityId: target,
      reviewStatus: 'confirmed',
    });
    expect((await store.doc('knowledgeGraphEntities', source).get()).exists).toBe(true);
  });

  it('creates a merge alias when the absorbed key had none', async () => {
    const acme = await entity('Acme', 'organization');
    const acmeCorp = await entity('Acme Corp', 'organization');
    expect(await repository.merge(agentId, acme, acmeCorp)).toBe(true);
    expect(await aliasesFor('organization:acme')).toEqual([
      expect.objectContaining({ entityId: acmeCorp }),
    ]);
    const foreign = await entity('Foreign', 'organization', { agentId: foreignAgentId });
    expect(await repository.merge(agentId, foreign, acmeCorp)).toBe(false);
    expect((await store.doc('knowledgeGraphEntities', foreign).get()).exists).toBe(true);
  });

  it('removes owner orphans with their aliases and leaves connected or foreign entities', async () => {
    const orphan = await entity('Nobody', 'topic');
    const connected = await entity('Anna', 'person');
    const other = await entity('Oslo', 'place');
    const foreignOrphan = await entity('Foreign', 'topic', { agentId: foreignAgentId });
    await relation(connected, other);
    const orphanAlias = await alias('topic:nobody-old', orphan);
    expect(await repository.removeOrphanedEntities(agentId)).toBe(1);
    expect((await store.doc('knowledgeGraphEntities', orphan).get()).exists).toBe(false);
    expect((await store.doc('knowledgeGraphEntityAliases', orphanAlias).get()).exists).toBe(false);
    expect((await store.doc('knowledgeGraphEntities', connected).get()).exists).toBe(true);
    expect((await store.doc('knowledgeGraphEntities', foreignOrphan).get()).exists).toBe(true);
  });

  it('makes blocked owner sources due and leaves foreign sources alone', async () => {
    const source = async (memoryId: string, owner: string, status: string) => {
      await store.doc('memories', memoryId).set({ id: memoryId, agentId: owner });
      await store.doc('knowledgeGraphSources', memoryId).set({
        memoryId,
        status,
        attempts: 5,
        lastError: 'boom',
        nextRetryAt: null,
        updatedAt: now,
      });
    };
    const quarantined = randomUUID();
    const failed = randomUUID();
    const ready = randomUUID();
    const foreign = randomUUID();
    await Promise.all([
      source(quarantined, agentId, 'quarantined'),
      source(failed, agentId, 'failed'),
      source(ready, agentId, 'ready'),
      source(foreign, foreignAgentId, 'quarantined'),
    ]);
    expect(await repository.retryBlockedSources(agentId)).toBe(2);
    expect(await data('knowledgeGraphSources', quarantined)).toMatchObject({
      status: 'failed',
      attempts: 0,
      lastError: null,
    });
    expect((await data('knowledgeGraphSources', quarantined))?.nextRetryAt).toBeTruthy();
    expect((await data('knowledgeGraphSources', ready))?.status).toBe('ready');
    expect((await data('knowledgeGraphSources', foreign))?.status).toBe('quarantined');
  });

  it('searches owner entities by display label in a stable order', async () => {
    const annaJ = await entity('Anna Jónsdóttir', 'person');
    const anna = await entity('anna', 'person', { preferredLabel: 'Anna' });
    await entity('Annapolis', 'place');
    await entity('Anna', 'person', { agentId: foreignAgentId });
    const rows = await repository.searchEntities(agentId, {
      query: 'ANNA',
      kind: 'person',
      limit: 20,
    });
    expect(rows.map((row) => row.id)).toEqual([anna, annaJ]);
    expect(rows[0]?.label).toBe('Anna');
    expect(
      await repository.searchEntities(agentId, {
        query: 'anna',
        kind: 'person',
        excludeId: anna,
        limit: 20,
      }),
    ).toEqual([expect.objectContaining({ id: annaJ })]);
    expect(await repository.searchEntities(agentId, { query: '', limit: 1 })).toHaveLength(1);
  });

  it('requeues ready sources with relative date wording and no canonical date', async () => {
    const source = async (content: string, patch: Record<string, unknown> = {}) => {
      const memoryId = randomUUID();
      await store.doc('memories', memoryId).set({
        id: memoryId,
        agentId,
        category: 'knowledge',
        quarantined: false,
        content,
        ...patch,
      });
      await store.doc('knowledgeGraphSources', memoryId).set({
        memoryId,
        status: 'ready',
        attempts: 1,
        lastError: null,
        nextRetryAt: null,
        updatedAt: now,
      });
      return memoryId;
    };
    const undated = await source('Dinner with Anna next Friday');
    const dated = await source('Anna visits tomorrow');
    const plain = await source('Anna lives in Oslo');
    const quarantined = await source('Lunch today', { quarantined: true });
    const anna = await entity('Anna', 'person');
    const day = await entity('2026-09-26', 'date', { canonicalKey: 'date:2026-09-26' });
    await relation(anna, day, { sourceMemoryId: dated, predicate: 'happens_on' });
    expect(await repository.requeueRelativeDateSources(agentId)).toBe(1);
    expect(await data('knowledgeGraphSources', undated)).toMatchObject({
      status: 'failed',
      attempts: 0,
    });
    for (const id of [dated, plain, quarantined])
      expect((await data('knowledgeGraphSources', id))?.status).toBe('ready');
  });

  it('refuses curation during privacy erasure', async () => {
    const acme = await entity('Acme', 'organization');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(repository.rename(agentId, acme, 'Acme Corp')).rejects.toThrow(
      'Privacy erasure is in progress',
    );
  });
});
