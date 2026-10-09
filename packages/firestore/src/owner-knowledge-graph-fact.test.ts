import { createHash, randomUUID } from 'node:crypto';
import type { EmbeddingSpace, Records } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreGraphRecallRepository } from './graph-recall.js';
import { embeddingSpaceKey } from './memory.js';
import { FirestoreMemoryToolRepository } from './memory-tools.js';
import { FirestoreOwnerKnowledgeGraphFactRepository } from './owner-knowledge-graph-fact.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space: EmbeddingSpace = { provider: 'test', model: 'unit', dimensions: 768, revision: '1' };

function vector(): number[] {
  const values = new Array(space.dimensions).fill(0);
  values[0] = 1;
  return values;
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore atomic owner graph correction',
  () => {
    let store: InstallationStore;
    let agentId: string;
    let sourceMemoryId: string;
    let relationId: string;
    let contentHash: string;
    let repo: FirestoreOwnerKnowledgeGraphFactRepository;

    beforeEach(async () => {
      store = emulatorStore();
      agentId = randomUUID();
      sourceMemoryId = randomUUID();
      relationId = randomUUID();
      const sourceContent = `A direct owner fact ${randomUUID()}`;
      contentHash = createHash('sha256').update(sourceContent).digest('hex');
      repo = new FirestoreOwnerKnowledgeGraphFactRepository(store, space, agentId);
      const memory: Records['memories'] = {
        id: sourceMemoryId,
        createdAt: new Date(),
        agentId,
        expiresAt: null,
        embedding: vector(),
        embeddingSpaceKey: null,
        sourceTaskId: null,
        kind: 'fact',
        confidence: '1.00',
        contentHash,
        goalId: null,
        originTrust: 'owner',
        category: 'knowledge',
        content: sourceContent,
        importance: 3,
        quarantined: false,
        subjectContactId: null,
        domain: 'other',
        validFrom: null,
        validUntil: null,
        supersededById: null,
        ownerConfirmed: true,
        pinned: false,
        source: 'knowledge-graph-owner',
        lastAccessedAt: null,
        lastConsolidatedAt: null,
      };
      const relation: Records['knowledgeGraphRelations'] = {
        id: relationId,
        createdAt: new Date(),
        agentId,
        sourceFingerprint: 'old-source|supports|old-target',
        confidence: '1.00',
        validFrom: null,
        validUntil: null,
        subjectEntityId: randomUUID(),
        predicate: 'supports',
        assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
        assertionId: null,
        objectEntityId: randomUUID(),
        sourceMemoryId,
        evidenceQuote: sourceContent,
        ordinal: 1,
        reviewStatus: 'confirmed',
        reviewedAt: null,
        correctedByRelationId: null,
        correctionSourceContentHash: null,
        correctionDisposition: null,
      };
      await Promise.all([
        store.doc('agents', agentId).set({ id: agentId, timezone: 'UTC', locale: 'en' }),
        store.doc('memories', sourceMemoryId).set(encodeRecord(memory)),
        store.doc('knowledgeGraphRelations', relationId).set(encodeRecord(relation)),
      ]);
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    async function correctionTarget() {
      const target = await repo.correctionTarget(agentId, relationId);
      if (!target) throw new Error('expected correction target');
      return target;
    }

    function correctionInput(
      target: Awaited<ReturnType<typeof correctionTarget>>,
      disposition: 'graph_only' | 'whole_fact',
    ) {
      const content = `I corrected the relationship ${randomUUID()}`;
      return {
        agentId,
        content,
        contentHash: createHash('sha256').update(content).digest('hex'),
        embedding: vector(),
        embeddingSpaceKey: embeddingSpaceKey(space),
        subject: {
          label: 'Owner',
          kind: 'person' as const,
          canonicalKey: 'person:owner',
          contactId: null,
          authoritativeLabel: false,
        },
        predicate: 'supports',
        object: {
          label: 'New target',
          kind: 'topic' as const,
          canonicalKey: 'topic:new target',
          contactId: null,
          authoritativeLabel: false,
        },
        subjectContactId: null,
        createdAt: new Date(),
        extractionVersion: 2,
        correction: { target, disposition },
      };
    }

    it('commits graph-only receipt with replacement and returns the same replacement on replay', async () => {
      const target = await correctionTarget();
      const input = correctionInput(target, 'graph_only');
      const first = await repo.createAtomic(input);
      expect(first).toMatchObject({ sourceDisposition: 'graph_only' });
      expect(first.relationId).toBeTruthy();

      const [oldRelation, oldMemory] = await Promise.all([
        store.doc('knowledgeGraphRelations', relationId).get(),
        store.doc('memories', sourceMemoryId).get(),
      ]);
      expect(oldRelation.get('correctedByRelationId')).toBe(first.relationId);
      expect(oldRelation.get('correctionSourceContentHash')).toBe(contentHash);
      expect(oldRelation.get('reviewStatus')).toBe('rejected');
      expect(oldMemory.get('expiresAt')).toBeNull();
      expect(oldMemory.get('supersededById')).toBeNull();

      const replay = await repo.createAtomic(input);
      expect(replay).toMatchObject({
        relationId: first.relationId,
        sourceDisposition: 'graph_only',
        alreadyApplied: true,
      });
    });

    it('expires only a standalone owner fact for explicit whole-fact correction', async () => {
      const result = await repo.createAtomic(
        correctionInput(await correctionTarget(), 'whole_fact'),
      );
      expect(result).toMatchObject({ sourceDisposition: 'whole_fact' });
      const oldMemory = await store.doc('memories', sourceMemoryId).get();
      expect(oldMemory.get('supersededById')).toBe(result.memoryId);
      expect(oldMemory.get('expiresAt')?.toDate()).toBeInstanceOf(Date);
    });

    it.each(['graph_only', 'whole_fact'] as const)(
      'qualifies raw-memory and graph retrieval after %s correction',
      async (disposition) => {
        const relation = (await store.doc('knowledgeGraphRelations', relationId).get()).data();
        if (!relation) throw new Error('Missing old relation');
        await store.doc('memories', sourceMemoryId).update({
          embedding: FieldValue.vector(vector()),
          embeddingSpace: embeddingSpaceKey(space),
        });
        for (const [id, label] of [
          [relation.subjectEntityId, 'Old source'],
          [relation.objectEntityId, 'Old target'],
        ])
          await store.doc('knowledgeGraphEntities', id).set({
            id,
            agentId,
            label,
            preferredLabel: null,
            kind: 'topic',
            canonicalKey: `topic:${id}`,
            contactId: null,
          });
        await store.doc('knowledgeGraphSources', sourceMemoryId).set({
          memoryId: sourceMemoryId,
          agentId,
          contentHash,
          status: 'ready',
          extractionVersion: 4,
        });
        const input = correctionInput(await correctionTarget(), disposition);
        input.extractionVersion = 4;
        const result = await repo.createAtomic(input);
        if (!result.memoryId || !result.relationId) throw new Error('Correction failed');
        const raw = await new FirestoreMemoryToolRepository(store, space).recall({
          agentId,
          embedding: vector(),
          query: 'relationship corrected',
          limit: 10,
          embeddingSpaceKey: embeddingSpaceKey(space),
        });
        const rawIds = raw.memories.map((row) => row.id);
        expect(rawIds).toContain(result.memoryId);
        expect(rawIds.includes(sourceMemoryId)).toBe(disposition === 'graph_only');
        const graph = await new FirestoreGraphRecallRepository(store, space).seeds({
          agentId,
          embedding: vector(),
          limit: 10,
          extractionVersion: 4,
        });
        expect(graph.map((row) => row.relationId)).toContain(result.relationId);
        expect(graph.map((row) => row.relationId)).not.toContain(relationId);
      },
    );

    it('rejects a stale source snapshot before writing a replacement', async () => {
      const target = await correctionTarget();
      await store.doc('memories', sourceMemoryId).update({ contentHash: 'changed-after-review' });
      const input = correctionInput(target, 'graph_only');
      const result = await repo.createAtomic(input);
      expect(result.error).toMatch(/source changed/i);
      const oldRelation = await store.doc('knowledgeGraphRelations', relationId).get();
      expect(oldRelation.get('reviewStatus')).toBe('confirmed');
      expect(oldRelation.get('correctedByRelationId')).toBeNull();
      const replacement = await store
        .collection('memories')
        .where('contentHash', '==', input.contentHash)
        .get();
      expect(replacement.empty).toBe(true);
    });
  },
);
