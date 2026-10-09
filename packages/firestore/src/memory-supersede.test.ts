import { createHash, randomUUID } from 'node:crypto';
import type { EmbeddingSpace, Records } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { embeddingSpaceKey } from './memory.js';
import { FirestoreMemorySupersedeRepository } from './memory-supersede.js';
import { FirestoreOwnerCardCompilationRepository } from './owner-card-compilation.js';
import { FirestoreOwnerContextRepository } from './owner-context.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space: EmbeddingSpace = {
  provider: 'test',
  model: 'supersede',
  dimensions: 1536,
  revision: 'v1',
};

function vector(x: number, y = 0): number[] {
  return [x, y, ...new Array(space.dimensions - 2).fill(0)];
}

const NEAR = vector(1);
const FAR = vector(0, 1);

function memory(
  id: string,
  input: Partial<Records['memories']> & Pick<Records['memories'], 'agentId' | 'content'>,
): Records['memories'] {
  return {
    id,
    createdAt: new Date(),
    expiresAt: null,
    embedding: NEAR,
    sourceTaskId: null,
    kind: 'fact',
    confidence: '0.70',
    contentHash: createHash('sha256').update(`${id}:${input.content}`).digest('hex'),
    goalId: null,
    originTrust: 'owner',
    category: 'knowledge',
    importance: 3,
    quarantined: false,
    subjectContactId: null,
    domain: null,
    validFrom: null,
    validUntil: null,
    supersededById: null,
    ownerConfirmed: false,
    pinned: false,
    source: 'test',
    embeddingSpaceKey: null,
    lastAccessedAt: null,
    lastConsolidatedAt: null,
    ...input,
  };
}

async function save(
  store: InstallationStore,
  row: Records['memories'],
  embeddingSpace = space,
): Promise<void> {
  await store.doc('memories', row.id).set(
    encodeRecord({
      ...row,
      embedding: row.embedding ? FieldValue.vector(row.embedding) : null,
      embeddingSpace: embeddingSpaceKey(embeddingSpace),
    }),
  );
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore memory supersession', () => {
  it('returns only bounded live same-owner, subject, privacy, and embedding-space candidates', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreMemorySupersedeRepository(store, space);
      const owner = 'owner-a';
      const subject = 'subject-a';
      const written = memory(randomUUID(), {
        agentId: owner,
        content: 'Now lives in Reykjavik',
        subjectContactId: subject,
      });
      const eligible = memory(randomUUID(), {
        agentId: owner,
        content: 'Lives in Oslo',
        subjectContactId: subject,
      });
      const excluded = [
        memory(randomUUID(), {
          agentId: 'owner-b',
          content: 'Foreign owner',
          subjectContactId: subject,
        }),
        memory(randomUUID(), {
          agentId: owner,
          content: 'Different subject',
          subjectContactId: 'subject-b',
        }),
        memory(randomUUID(), {
          agentId: owner,
          content: 'Quarantined',
          subjectContactId: subject,
          quarantined: true,
        }),
        memory(randomUUID(), {
          agentId: owner,
          content: 'Expired',
          subjectContactId: subject,
          expiresAt: new Date(Date.now() - 1_000),
        }),
        memory(randomUUID(), {
          agentId: owner,
          content: 'Already replaced',
          subjectContactId: subject,
          supersededById: written.id,
        }),
        memory(randomUUID(), {
          agentId: owner,
          content: 'Far away',
          subjectContactId: subject,
          embedding: FAR,
        }),
      ];
      await Promise.all([
        save(store, written),
        save(store, eligible),
        ...excluded.map((row) => save(store, row)),
      ]);
      const wrongSpace = memory(randomUUID(), {
        agentId: owner,
        content: 'Wrong embedding space',
        subjectContactId: subject,
      });
      await save(store, wrongSpace, { ...space, revision: 'v2' });
      const erased = memory(randomUUID(), {
        agentId: owner,
        content: 'Erased candidate',
        subjectContactId: subject,
      });
      await save(store, erased);
      await store
        .doc('memoryTombstones', erased.contentHash)
        .set({ contentHash: erased.contentHash });

      expect((await repository.writtenFact({ agentId: owner, id: written.id }))?.id).toBe(
        written.id,
      );
      expect(await repository.writtenFact({ agentId: 'owner-b', id: written.id })).toBeNull();
      const candidates = await repository.candidates({
        agentId: owner,
        newFactId: written.id,
        embedding: NEAR,
        subjectContactId: subject,
      });
      expect(candidates.map((row) => row.id)).toEqual([eligible.id]);
      expect(candidates).toHaveLength(1);
    } finally {
      await disposeStore(store);
    }
  });

  it('retires only live same-owner same-subject facts with a valid replacement', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreMemorySupersedeRepository(store, space);
      const replacement = memory(randomUUID(), {
        agentId: 'owner-a',
        content: 'Lives in Reykjavik',
        subjectContactId: 'subject-a',
      });
      const stale = memory(randomUUID(), {
        agentId: 'owner-a',
        content: 'Lives in Oslo',
        subjectContactId: 'subject-a',
      });
      const foreign = memory(randomUUID(), {
        agentId: 'owner-b',
        content: 'Foreign',
        subjectContactId: 'subject-a',
      });
      const otherSubject = memory(randomUUID(), {
        agentId: 'owner-a',
        content: 'Other subject',
        subjectContactId: 'subject-b',
      });
      const erased = memory(randomUUID(), {
        agentId: 'owner-a',
        content: 'Erased',
        subjectContactId: 'subject-a',
      });
      await Promise.all(
        [replacement, stale, foreign, otherSubject, erased].map((row) => save(store, row)),
      );
      await store.doc('ownerCards', 'owner-a').set({
        agentId: 'owner-a',
        content: 'Earlier compiled card',
        compiledAt: new Date('2026-09-19T10:00:00Z'),
      });
      await store
        .doc('memoryTombstones', erased.contentHash)
        .set({ contentHash: erased.contentHash });

      expect(
        await repository.retire({
          agentId: 'owner-a',
          replacementId: replacement.id,
          ids: [stale.id, foreign.id, otherSubject.id, erased.id, replacement.id],
        }),
      ).toEqual([stale.id]);
      const retired = await store.doc('memories', stale.id).get();
      expect(retired.get('supersededById')).toBe(replacement.id);
      expect(retired.get('expiresAt')).toBeTruthy();
      expect((await store.doc('memories', replacement.id).get()).get('expiresAt')).toBeNull();
      expect((await store.doc('ownerCards', 'owner-a').get()).get('invalidatedAt')).toBeTruthy();
      await expect(
        new FirestoreOwnerCardCompilationRepository(store).compile({
          agentId: 'owner-a',
          now: new Date(),
          render: () => {
            throw new Error('compile failed');
          },
        }),
      ).rejects.toThrow('compile failed');
      expect(
        await new FirestoreOwnerContextRepository(store).getOwnerCard('owner-a'),
      ).toMatchObject({ content: '' });
    } finally {
      await disposeStore(store);
    }
  });

  it('preserves the first replacement when retire calls race', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreMemorySupersedeRepository(store, space);
      const stale = memory(randomUUID(), {
        agentId: 'owner-a',
        content: 'Contested fact',
        subjectContactId: 'subject-a',
      });
      const first = memory(randomUUID(), {
        agentId: 'owner-a',
        content: 'First replacement',
        subjectContactId: 'subject-a',
      });
      const second = memory(randomUUID(), {
        agentId: 'owner-a',
        content: 'Second replacement',
        subjectContactId: 'subject-a',
      });
      await Promise.all([save(store, stale), save(store, first), save(store, second)]);

      const results = await Promise.all([
        repository.retire({ agentId: 'owner-a', replacementId: first.id, ids: [stale.id] }),
        repository.retire({ agentId: 'owner-a', replacementId: second.id, ids: [stale.id] }),
      ]);
      expect(results.flat()).toEqual([stale.id]);
      expect([first.id, second.id]).toContain(
        (await store.doc('memories', stale.id).get()).get('supersededById'),
      );
    } finally {
      await disposeStore(store);
    }
  });
});
