import { createHash } from 'node:crypto';
import { runMemoryConsolidation } from '@assistant/core/memory/consolidation';
import type { ModelRouter } from '@assistant/core/model-router';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import { embeddingSpaceIdentityKey, type Records } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const agentId = 'consolidation-worker-owner';
const contactId = 'consolidation-worker-person';
const SPACE = {
  provider: 'test',
  model: 'test-embedding',
  dimensions: 1536,
  revision: 'test-v1',
} as const;

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore memory consolidation worker',
  () => {
    let store: InstallationStore;

    beforeEach(async () => {
      store = emulatorStore();
      await store
        .doc('agents', agentId)
        .set({ id: agentId, name: 'Owner', timezone: 'UTC', locale: 'en' });
      await store.doc('contacts', contactId).set(
        encodeRecord({
          id: contactId,
          name: 'Owner',
          aliases: [],
          emails: [],
          phones: [],
          relationship: 'self',
          notes: '',
          trust: 'owner',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
    });

    afterEach(async () => disposeStore(store));

    async function seed(content: string, domain: string | null = null) {
      const id = `memory-${content}`;
      const contentHash = createHash('sha256').update(content).digest('hex');
      const row: Records['memories'] = {
        id,
        createdAt: new Date('2026-09-01T12:00:00Z'),
        agentId,
        expiresAt: null,
        embedding: [1, ...new Array(1535).fill(0)],
        embeddingSpaceKey: embeddingSpaceIdentityKey(SPACE),
        sourceTaskId: null,
        kind: 'fact',
        confidence: '0.80',
        contentHash,
        goalId: null,
        originTrust: 'owner',
        category: 'knowledge',
        content,
        importance: 4,
        quarantined: false,
        subjectContactId: contactId,
        domain,
        validFrom: null,
        validUntil: null,
        supersededById: null,
        ownerConfirmed: false,
        pinned: false,
        source: 'test',
        lastAccessedAt: null,
        lastConsolidatedAt: null,
      };
      await store.doc('memories', id).set(
        encodeRecord({
          ...row,
          embeddingSpace: embeddingSpaceIdentityKey(SPACE),
          retrievalRevision: `revision-${id}`,
        }),
      );
      await store.doc('memoryContentHashes', contentHash).set({ memoryId: id });
      return row;
    }

    it('runs review, mutation, and card compilation without touching PostgreSQL', async () => {
      const first = await seed('First work fact');
      const second = await seed('Second work fact');
      const sqlCalls = vi.fn(() => {
        throw new Error('PostgreSQL must be unreachable for this job');
      });
      const db = new Proxy({}, { get: () => sqlCalls }) as Db;
      const router = {
        async embeddingSpace() {
          return SPACE;
        },
        async embeddingSpaceKey() {
          return embeddingSpaceIdentityKey(SPACE);
        },
        async object() {
          return {
            ok: true,
            modelId: 'test',
            degraded: false,
            object: {
              duplicateGroups: [[first.id, second.id]],
              contradictionGroups: [],
              mergeGroups: [],
              domainFixes: [{ id: first.id, domain: 'work' }],
              timeline: [],
              occasions: [{ kind: 'birthday', label: '', month: 6, day: 9, year: null, notes: '' }],
            },
          };
        },
        async embed() {
          return [new Array(1536).fill(0).map((_, index) => (index === 0 ? 1 : 0))];
        },
      } as unknown as ModelRouter;
      const persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);

      const result = await runMemoryConsolidation(
        { db, router, persistence },
        { agentId, taskId: 'test-task' },
      );

      expect(sqlCalls).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        entities: 1,
        batches: 1,
        duplicatesExpired: 1,
        domainsAssigned: 1,
        occasionsSaved: 1,
        cardCompiled: true,
      });
      expect((await store.doc('memories', first.id).get()).get('domain')).toBe('work');
      expect((await store.doc('memories', second.id).get()).get('supersededById')).toBe(first.id);
      expect((await store.doc('ownerCards', agentId).get()).exists).toBe(true);
      const occasions = await store.collection('occasions').where('agentId', '==', agentId).get();
      expect(occasions.docs.map((occasion) => occasion.get('month'))).toContain(6);
    });
  },
);
