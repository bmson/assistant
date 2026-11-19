import { createHash, randomUUID } from 'node:crypto';
import type { EmbeddingSpace, KnowledgeGraphSyncSource, Records } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { graphSourceEligible } from './graph-source-eligibility.js';
import { FirestoreKnowledgeGraphSyncRepository } from './knowledge-graph-sync.js';
import { embeddingSpaceKey, FirestoreMemoryRepository } from './memory.js';
import { FirestoreOwnerCardCompilationRepository } from './owner-card-compilation.js';
import { ownerFamilySourceIsRejected } from './owner-family-source-rejection.js';
import { FirestoreProfileLibraryRepository } from './profile-library.js';
import { disposeStore, emulatorStore } from './test-store.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const space: EmbeddingSpace = { provider: 'test', model: 'unit', dimensions: 3, revision: '1' };
it('suppresses only the unchanged rejected evidence and fails closed on malformed stamps', () => {
  expect(ownerFamilySourceIsRejected({ contentHash: hash('original') })).toBe(false);
  const rejected = {
    contentHash: hash('original'),
    ownerFamilyRejectedContentHash: hash('original'),
  };
  expect(ownerFamilySourceIsRejected(rejected)).toBe(true);
  expect(ownerFamilySourceIsRejected({ ...rejected, contentHash: hash('correction') })).toBe(false);
  expect(() =>
    ownerFamilySourceIsRejected({ ...rejected, ownerFamilyRejectedContentHash: true }),
  ).toThrow('Malformed');
});

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('retained rejected family evidence', () => {
  it('stays in the Library but cannot be recalled, compiled, reclaimed or republished by an earlier graph claim', async () => {
    const store = emulatorStore();
    try {
      const agentId = randomUUID(),
        ownerId = randomUUID(),
        id = randomUUID();
      const now = new Date();
      await store
        .doc('contacts', ownerId)
        .set({ id: ownerId, name: 'Owner', trust: 'owner', relationship: '', aliases: [] });
      const memory: Records['memories'] = {
        id,
        agentId,
        content: 'Synthetic parent relationship source',
        contentHash: hash('Synthetic parent relationship source'),
        createdAt: now,
        expiresAt: null,
        embedding: [1, 0, 0],
        sourceTaskId: null,
        kind: 'fact',
        confidence: '1',
        goalId: null,
        originTrust: 'owner',
        category: 'knowledge',
        importance: 5,
        quarantined: false,
        subjectContactId: ownerId,
        domain: 'relationships',
        validFrom: null,
        validUntil: null,
        supersededById: null,
        ownerConfirmed: true,
        pinned: true,
        source: 'test',
        embeddingSpaceKey: null,
        lastAccessedAt: null,
        lastConsolidatedAt: null,
      };
      const graphInput = {
        memory,
        source: {
          memoryId: id,
          status: 'ready',
          contentHash: memory.contentHash,
          extractionVersion: 1,
        },
        agentId,
        space,
        storedSpace: embeddingSpaceKey(space),
        extractionVersion: 1,
        now,
        tombstoned: false,
      };
      expect(graphSourceEligible(graphInput)).toBe(true);
      expect(
        graphSourceEligible({
          ...graphInput,
          memory: { ...memory, ownerFamilyRejectedContentHash: memory.contentHash },
        }),
      ).toBe(false);
      const vectors = new FirestoreMemoryRepository(store, space);
      expect(await vectors.save(memory)).toBe(true);
      const saved = await store.doc('memories', id).get();
      const source: KnowledgeGraphSyncSource = {
        id,
        agentId,
        content: memory.content,
        contentHash: memory.contentHash,
        retrievalRevision: saved.get('retrievalRevision'),
        confidence: '1',
        subjectContactId: ownerId,
        createdAt: now,
      };
      const sync = new FirestoreKnowledgeGraphSyncRepository(store);
      const claim = await sync.claim({ source, extractionVersion: 1, leaseMs: 60000, now });
      expect(claim).not.toBeNull();
      // Keep the retrieval revision unchanged here to exercise the rejection
      // fence itself, independently of the writer's additional revision rotation.
      await store
        .doc('memories', id)
        .update({ ownerFamilyRejectedContentHash: memory.contentHash });
      expect(
        await sync.candidates({ agentId, limit: 5, extractionVersion: 2, leaseMs: 60000, now }),
      ).toEqual([]);
      expect(await sync.claim({ source, extractionVersion: 2, leaseMs: 60000, now })).toBeNull();
      if (!claim) throw Error('Missing initial synthetic graph claim');
      expect(
        await sync.replaceProjection({ source, claim, extractionVersion: 1, relations: [], now }),
      ).toBeNull();
      expect((await vectors.retrieve({ agentId, vector: [1, 0, 0] })).memories).toEqual([]);
      const card = await new FirestoreOwnerCardCompilationRepository(store).compile({
        agentId,
        now,
        render: (input) => JSON.stringify(input),
      });
      expect(card).not.toContain(memory.content);
      const library = await new FirestoreProfileLibraryRepository(store).list(agentId, {
        state: 'in-use',
        filter: 'all',
        query: '',
        page: 1,
        pageSize: 60,
        now,
        extractionVersion: 1,
      });
      expect(library.rows.map((row) => row.memory.id)).toContain(id);
      expect((await store.doc('memories', id).get()).get('content')).toBe(memory.content);
    } finally {
      await disposeStore(store);
    }
  });
});
