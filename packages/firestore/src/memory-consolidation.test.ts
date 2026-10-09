import { createHash, randomUUID } from 'node:crypto';
import {
  type ConsolidationReview,
  canRewriteConsolidationFacts,
  type EmbeddingSpace,
  type Records,
} from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { FirestoreImportCommandRepository } from './imports.js';
import { embeddingSpaceKey } from './memory.js';
import { FirestoreMemoryConsolidationRepository } from './memory-consolidation.js';
import { getFirestoreMobilePeopleDirectory } from './people-directory.js';
import { FirestoreProfileOccasionCommandRepository } from './profile-occasion-command.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space: EmbeddingSpace = {
  provider: 'test',
  model: 'consolidation',
  dimensions: 2,
  revision: 'v1',
};
const now = new Date('2026-09-23T12:00:00.000Z');

function memory(
  id: string,
  agentId: string,
  subjectContactId: string | null,
  changes: Partial<Records['memories']> = {},
): Records['memories'] {
  return {
    id,
    agentId,
    subjectContactId,
    createdAt: new Date('2026-09-20T12:00:00.000Z'),
    expiresAt: null,
    embedding: [1, 0],
    sourceTaskId: null,
    kind: 'fact',
    confidence: '0.70',
    contentHash: createHash('sha256').update(id).digest('hex'),
    goalId: null,
    originTrust: 'assistant',
    category: 'knowledge',
    content: `Fact ${id.replaceAll('-', '')}`,
    importance: 3,
    quarantined: false,
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
    ...changes,
  };
}

async function seed(store: InstallationStore, row: Records['memories']) {
  await store.doc('memories', row.id).set(
    encodeRecord({
      ...row,
      embedding: FieldValue.vector(row.embedding ?? [1, 0]),
      embeddingSpace: embeddingSpaceKey(space),
    }),
  );
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore memory consolidation repository',
  () => {
    it('rejects cyclic and chained retirements without changing any fact', async () => {
      const store = emulatorStore(() => now);
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        await store
          .doc('contacts', 'person')
          .set({ id: 'person', name: 'Anna', trust: 'confirmed' });
        for (const id of ['a', 'b', 'c']) await seed(store, memory(id, 'owner', 'person'));
        const repository = new FirestoreMemoryConsolidationRepository(store, space);
        const batch = await repository.candidates('owner');
        if (!batch.window) throw new Error('Missing candidate window');
        for (const retirements of [
          [
            { id: 'a', supersededById: 'b' },
            { id: 'b', supersededById: 'a' },
          ],
          [
            { id: 'a', supersededById: 'b' },
            { id: 'b', supersededById: 'c' },
          ],
        ]) {
          await expect(
            repository.applyReview({
              agentId: 'owner',
              subjectContactId: 'person',
              facts: batch.window.facts,
              retirements,
              merges: [],
              domainFixes: [],
              timeline: [],
            }),
          ).rejects.toThrow('surviving facts');
          for (const id of ['a', 'b', 'c'])
            expect((await store.doc('memories', id).get()).data()).toMatchObject({
              expiresAt: null,
              supersededById: null,
              lastConsolidatedAt: null,
            });
        }
        await repository.applyReview({
          agentId: 'owner',
          subjectContactId: 'person',
          facts: batch.window.facts,
          retirements: [
            { id: 'a', supersededById: 'c' },
            { id: 'b', supersededById: 'c' },
          ],
          merges: [],
          domainFixes: [],
          timeline: [],
        });
        expect((await store.doc('memories', 'c').get()).get('expiresAt')).toBeNull();
        expect((await store.doc('memories', 'a').get()).get('supersededById')).toBe('c');
        expect((await store.doc('memories', 'b').get()).get('supersededById')).toBe('c');
      } finally {
        await disposeStore(store);
      }
    });
    it('keeps consolidated occasions readable and compatible with owner edits and later reviews', async () => {
      const store = emulatorStore(() => now);
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        await store.doc('contacts', 'person').set({
          id: 'person',
          name: 'Anna Example',
          relationship: 'friend',
          trust: 'confirmed',
        });
        await seed(store, memory(randomUUID(), 'owner', 'person'));
        await seed(store, memory(randomUUID(), 'owner', 'person'));
        const repo = new FirestoreMemoryConsolidationRepository(store, space);
        const birthday = {
          kind: 'birthday' as const,
          label: 'Birthday',
          month: 10,
          day: 1,
          year: null,
          notes: 'From consolidation',
        };
        const apply = async (occasions: ConsolidationReview['occasions']) =>
          repo.applyReview({
            agentId: 'owner',
            subjectContactId: 'person',
            facts: (await repo.candidates('owner')).window?.facts ?? [],
            retirements: [],
            merges: [],
            domainFixes: [],
            timeline: [],
            occasions,
          });

        expect(await apply([birthday])).toMatchObject({ occasionsSaved: 1 });
        const directory = await getFirestoreMobilePeopleDirectory(store, 'owner', now, 1);
        const id = directory[0]?.birthday?.id;
        if (!id) throw new Error('Expected consolidated birthday id');
        expect(directory[0]?.birthday).toMatchObject({ id, month: 10, day: 1, year: null });

        // A later review must find the same logical ID, merge, and avoid duplicates.
        await seed(store, memory(randomUUID(), 'owner', 'person'));
        await apply([{ ...birthday, year: 1990, notes: 'Birth year learned' }]);
        const ref = store.doc('occasions', id);
        expect((await ref.get()).data()).toMatchObject({
          id,
          year: 1990,
          notes: 'From consolidation; Birth year learned',
        });

        // The owner can confirm that same record, and consolidation preserves it.
        const commands = new FirestoreProfileOccasionCommandRepository(store, 'owner');
        await commands.review(id, 'approve');
        const confirmed = (await ref.get()).data();
        await seed(store, memory(randomUUID(), 'owner', 'person'));
        await apply([{ ...birthday, year: 2000, notes: 'Must not replace owner data' }]);
        expect((await ref.get()).data()).toEqual(confirmed);
        expect((await store.collection('occasions').get()).size).toBe(1);
        await commands.update(id, {
          kind: 'birthday',
          label: 'Birthday',
          month: 10,
          day: 2,
          year: 1990,
          leadDays: 7,
          notes: 'Explicit date correction',
        });
        await seed(store, memory(randomUUID(), 'owner', 'person'));
        await seed(store, memory(randomUUID(), 'owner', 'person'));
        await apply([{ ...birthday, year: null, notes: 'Historical source date' }]);
        await seed(store, memory(randomUUID(), 'owner', 'person'));
        await seed(store, memory(randomUUID(), 'owner', 'person'));
        await apply([{ ...birthday, day: 2, year: null, notes: 'Corrected date source' }]);
        const afterReingestion = await ref.get();
        expect(afterReingestion.data()).toMatchObject({
          id,
          day: 2,
          notes: 'Explicit date correction',
          ownerConfirmed: true,
        });
        const history = (await store.collection('occasions').get()).docs.find(
          (doc) => doc.get('day') === 1,
        );
        expect(history).toBeUndefined();
        await commands.forget(id);
        expect(
          (await getFirestoreMobilePeopleDirectory(store, 'owner', now, 1))[0]?.birthday,
        ).toBeNull();
      } finally {
        await disposeStore(store);
      }
    });

    it('selects only live owner facts, stamps standalones, and rotates a bounded person window', async () => {
      const store = emulatorStore(() => now);
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        const alone = memory(randomUUID(), 'owner', null);
        const singleton = memory(randomUUID(), 'owner', 'one');
        const first = memory(randomUUID(), 'owner', 'person', {
          content: 'Alex enjoys music.',
        });
        const second = memory(randomUUID(), 'owner', 'person', {
          content: 'Alex likes tea.',
        });
        await Promise.all([
          seed(store, alone),
          seed(store, singleton),
          seed(store, first),
          seed(store, second),
          seed(store, memory(randomUUID(), 'other', 'person')),
          seed(store, memory(randomUUID(), 'owner', 'person', { quarantined: true })),
          seed(
            store,
            memory(randomUUID(), 'owner', 'person', { expiresAt: new Date('2026-09-22') }),
          ),
        ]);
        const repo = new FirestoreMemoryConsolidationRepository(store, space);
        const batch = await repo.candidates('owner');
        expect(batch.standalone.map((row) => row.id).sort()).toEqual(
          [alone.id, singleton.id].sort(),
        );
        expect(batch.window?.subjectContactId).toBe('person');
        expect(batch.window?.facts.map((row) => row.id).sort()).toEqual(
          [first.id, second.id].sort(),
        );
        expect(await repo.stampStandalone('owner', batch.standalone)).toBe(2);
        expect(
          (await store.doc('memories', alone.id).get()).get('lastConsolidatedAt').toDate(),
        ).toEqual(now);
        expect(
          (await store.doc('memories', singleton.id).get()).get('lastConsolidatedAt').toDate(),
        ).toEqual(now);
      } finally {
        await disposeStore(store);
      }
    });

    it('atomically merges and supersedes, and rejects stale or foreign decisions', async () => {
      const store = emulatorStore(() => now);
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        await store.doc('contacts', 'person').set({
          id: 'person',
          name: 'Anna Example',
          relationship: 'friend',
          trust: 'confirmed',
        });
        // A UUID's numeric groups must not accidentally read as temporal prose.
        const first = memory('aaaaaaaa-2024-4025-8026-aaaaaaaaaaaa', 'owner', 'person');
        const second = memory(randomUUID(), 'owner', 'person');
        await seed(store, first);
        await seed(store, second);
        for (const [source, row, sourceOffset] of [
          ['archive-alpha', first, 14],
          ['archive-beta', second, 29],
        ] as const) {
          const sourceId = randomUUID();
          await store.doc('importSources', sourceId).set({
            id: sourceId,
            agentId: 'owner',
            source,
            status: 'done',
            workspacePath: `import/${source}.txt`,
            taskId: null,
            kind: 'text',
            itemsTotal: 1,
            itemsProcessed: 1,
            memoriesSaved: 1,
            memoriesQuarantined: 0,
            createdAt: now,
            updatedAt: now,
          });
          const claimId = createHash('sha256').update(`owner\0${source}`).digest('hex');
          await store.doc('importSourceKeys', claimId).set({
            agentId: 'owner',
            source,
            sourceId,
          });
          const lineageId = createHash('sha256')
            .update(JSON.stringify([source, row.id]))
            .digest('hex');
          await store.doc('memoryImportLineage', lineageId).set({
            agentId: 'owner',
            source,
            memoryId: row.id,
            sourceUnitProvenance: [
              {
                sourceOffset,
                unitOffset: 0,
                observedAt: '2025-06-01T10:00:00.000Z',
                authorEmail: 'owner@example.test',
                header: 'From owner@example.test',
                hasQuotedContent: false,
                unitTextHash: createHash('sha256').update(source).digest('hex'),
              },
            ],
          });
        }
        const repo = new FirestoreMemoryConsolidationRepository(store, space);
        const facts = (await repo.candidates('owner')).window?.facts;
        expect(facts).toHaveLength(2);
        expect(
          facts?.map(({ content, validFrom, validUntil }) => ({ content, validFrom, validUntil })),
        ).toEqual(
          expect.arrayContaining([
            { content: first.content, validFrom: null, validUntil: null },
            { content: second.content, validFrom: null, validUntil: null },
          ]),
        );
        expect(canRewriteConsolidationFacts(facts ?? [])).toBe(true);
        expect(facts?.map((row) => row.importSources).sort()).toEqual([
          ['archive-alpha'],
          ['archive-beta'],
        ]);
        const mergedId = randomUUID();
        const unified = 'The same person has two facts merged faithfully.';
        const review = {
          agentId: 'owner',
          subjectContactId: 'person',
          facts: facts ?? [],
          retirements: [],
          domainFixes: [],
          timeline: [],
          occasions: [
            {
              kind: 'anniversary' as const,
              label: 'Anniversary',
              month: 8,
              day: 11,
              year: null,
              notes: 'Derived from both imported facts',
            },
          ],
          merges: [
            {
              id: mergedId,
              content: unified,
              contentHash: createHash('sha256').update(unified).digest('hex'),
              embeddingSpaceKey: embeddingSpaceKey(space),
              embedding: [1, 0],
              kind: 'fact',
              confidence: '0.70',
              importance: 3,
              domain: 'work',
              sourceTaskId: null,
              memberIds: [first.id, second.id],
            },
          ],
        };
        await expect(repo.applyReview({ ...review, agentId: 'other' })).rejects.toThrow();
        expect((await store.doc('memories', mergedId).get()).exists).toBe(false);
        expect(await repo.applyReview(review)).toEqual({
          retired: expect.arrayContaining([first.id, second.id]),
          merged: [mergedId],
          domainsAssigned: [],
          occasionsSaved: 1,
        });
        expect((await store.doc('memories', first.id).get()).get('supersededById')).toBe(mergedId);
        expect((await store.doc('memories', second.id).get()).get('supersededById')).toBe(mergedId);
        expect((await store.doc('memories', mergedId).get()).get('content')).toBe(unified);
        expect(facts?.flatMap((row) => row.importSourceProvenance ?? [])).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ source: 'archive-alpha' }),
            expect.objectContaining({ source: 'archive-beta' }),
          ]),
        );
        for (const source of ['archive-alpha', 'archive-beta'])
          expect(
            (
              await store
                .doc(
                  'memoryImportLineage',
                  createHash('sha256')
                    .update(JSON.stringify([source, mergedId]))
                    .digest('hex'),
                )
                .get()
            ).data(),
          ).toMatchObject({
            source,
            memoryId: mergedId,
            sourceUnitProvenance: [
              expect.objectContaining({
                sourceOffset: source === 'archive-alpha' ? 14 : 29,
                unitOffset: 0,
                unitTextHash: createHash('sha256').update(source).digest('hex'),
              }),
            ],
          });
        const derivedOccasion = (
          await store
            .collection('occasions')
            .where('agentId', '==', 'owner')
            .where('contactId', '==', 'person')
            .where('kind', '==', 'anniversary')
            .get()
        ).docs[0];
        if (!derivedOccasion) throw new Error('Expected derived occasion');
        const derivedOccasionId = derivedOccasion.get('id');
        if (typeof derivedOccasionId !== 'string') throw new Error('Derived occasion has no ID');
        for (const source of ['archive-alpha', 'archive-beta'])
          expect(
            (
              await store
                .doc(
                  'occasionImportLineage',
                  createHash('sha256')
                    .update(JSON.stringify([source, derivedOccasionId]))
                    .digest('hex'),
                )
                .get()
            ).data(),
          ).toMatchObject({ source, occasionId: derivedOccasionId });
        expect((await store.doc('memories', mergedId).get()).get('createdAt').toDate()).toEqual(
          first.createdAt,
        );
        await expect(repo.applyReview(review)).rejects.toThrow('changed');
        expect(
          (await store.doc('memoryContentHashes', review.merges[0]?.contentHash ?? '').get()).get(
            'memoryId',
          ),
        ).toBe(mergedId);
      } finally {
        await disposeStore(store);
      }
    });

    it.each([
      ['past', new Date('2019-01-01Z'), new Date('2023-01-01Z'), 'works at Acme'],
      ['future', new Date('2099-01-01Z'), null, 'works at Acme'],
      ['overlap', new Date('2020-01-01Z'), new Date('2030-01-01Z'), 'works at Acme'],
      ['unknown uncertain', null, null, 'might work at Acme'],
    ])(
      'rejects a forged timeless merge of %s claims atomically',
      async (_label, validFrom, validUntil, content) => {
        const store = emulatorStore(() => now);
        try {
          await store.doc('agents', 'owner').set({ id: 'owner' });
          const first = memory(randomUUID(), 'owner', 'person', { content, validFrom, validUntil });
          const second = memory(randomUUID(), 'owner', 'person');
          await seed(store, first);
          await seed(store, second);
          const repository = new FirestoreMemoryConsolidationRepository(store, space);
          const facts = (await repository.candidates('owner')).window?.facts ?? [];
          const id = randomUUID();
          const unified = 'A current timeless employment claim.';
          await expect(
            repository.applyReview({
              agentId: 'owner',
              subjectContactId: 'person',
              facts,
              retirements: [],
              domainFixes: [],
              timeline: [],
              merges: [
                {
                  id,
                  content: unified,
                  contentHash: createHash('sha256').update(unified).digest('hex'),
                  embeddingSpaceKey: embeddingSpaceKey(space),
                  embedding: [1, 0],
                  kind: 'fact',
                  confidence: '0.70',
                  importance: 3,
                  domain: 'work',
                  sourceTaskId: null,
                  memberIds: [first.id, second.id],
                },
              ],
            }),
          ).rejects.toThrow('temporally scoped');
          expect((await store.doc('memories', id).get()).exists).toBe(false);
          expect((await store.doc('memories', first.id).get()).get('supersededById')).toBeNull();
          expect((await store.doc('memories', first.id).get()).get('content')).toBe(content);
        } finally {
          await disposeStore(store);
        }
      },
    );
    it('commits domain and timeline updates with the review stamp', async () => {
      const store = emulatorStore(() => now);
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        const first = memory(randomUUID(), 'owner', 'person');
        const second = memory(randomUUID(), 'owner', 'person');
        await seed(store, first);
        await seed(store, second);
        const repo = new FirestoreMemoryConsolidationRepository(store, space);
        const facts = (await repo.candidates('owner')).window?.facts ?? [];
        const validFrom = new Date('2024-01-01T00:00:00.000Z');
        expect(
          await repo.applyReview({
            agentId: 'owner',
            subjectContactId: 'person',
            facts,
            retirements: [],
            merges: [],
            domainFixes: [{ id: first.id, domain: 'work' }],
            timeline: [{ id: first.id, validFrom }],
          }),
        ).toEqual({ retired: [], merged: [], domainsAssigned: [first.id] });
        const changed = await store.doc('memories', first.id).get();
        expect(changed.get('domain')).toBe('work');
        expect(changed.get('validFrom').toDate()).toEqual(validFrom);
        expect(changed.get('lastConsolidatedAt').toDate()).toEqual(now);
      } finally {
        await disposeStore(store);
      }
    });

    it('preserves owner-confirmed precedence and erased content', async () => {
      const store = emulatorStore(() => now);
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        const confirmed = memory(randomUUID(), 'owner', 'person', { ownerConfirmed: true });
        const unconfirmed = memory(randomUUID(), 'owner', 'person');
        await seed(store, confirmed);
        await seed(store, unconfirmed);
        const repo = new FirestoreMemoryConsolidationRepository(store, space);
        const facts = (await repo.candidates('owner')).window?.facts ?? [];
        const decision = {
          agentId: 'owner',
          subjectContactId: 'person',
          facts,
          retirements: [{ id: confirmed.id, supersededById: unconfirmed.id }],
          merges: [],
          domainFixes: [],
          timeline: [],
        };
        await expect(repo.applyReview(decision)).rejects.toThrow(
          'Invalid consolidation retirement',
        );
        expect((await store.doc('memories', confirmed.id).get()).get('supersededById')).toBeNull();
        await store
          .doc('memoryTombstones', confirmed.contentHash)
          .set({ contentHash: confirmed.contentHash });
        await expect(repo.applyReview({ ...decision, retirements: [] })).rejects.toThrow('erased');
        expect(
          (await store.doc('memories', unconfirmed.id).get()).get('lastConsolidatedAt'),
        ).toBeNull();
      } finally {
        await disposeStore(store);
      }
    });

    it('holds the privacy erasure fence across candidate reads and writes', async () => {
      const store = emulatorStore(() => now);
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        const first = memory(randomUUID(), 'owner', 'person');
        const second = memory(randomUUID(), 'owner', 'person');
        await seed(store, first);
        await seed(store, second);
        const repo = new FirestoreMemoryConsolidationRepository(store, space);
        const facts = (await repo.candidates('owner')).window?.facts ?? [];
        await store.doc('privacyErasureJobs', 'owner').set({ agentId: 'owner', status: 'active' });
        await expect(repo.candidates('owner')).rejects.toThrow('Privacy erasure');
        await expect(
          repo.applyReview({
            agentId: 'owner',
            subjectContactId: 'person',
            facts,
            retirements: [{ id: first.id, supersededById: second.id }],
            merges: [],
            domainFixes: [],
            timeline: [],
          }),
        ).rejects.toThrow('Privacy erasure');
        expect((await store.doc('memories', first.id).get()).get('supersededById')).toBeNull();
      } finally {
        await disposeStore(store);
      }
    });

    it('rejects a reviewed merge after the contributing import is removed', async () => {
      const store = emulatorStore(() => now);
      try {
        const agentId = 'owner';
        const source = 'paused-import';
        const sourceId = randomUUID();
        const taskId = randomUUID();
        await store.doc('agents', agentId).set({ id: agentId });
        await store.doc('contacts', 'person').set({
          id: 'person',
          name: 'Anna Example',
          relationship: 'friend',
          trust: 'known',
        });
        const imported = memory(randomUUID(), agentId, 'person');
        const ownerAdded = memory(randomUUID(), agentId, 'person');
        await seed(store, imported);
        await seed(store, ownerAdded);
        await store.doc('importSources', sourceId).set({
          id: sourceId,
          agentId,
          source,
          status: 'done',
          workspacePath: 'import/paused-import.txt',
          taskId,
          kind: 'text',
          itemsTotal: 1,
          itemsProcessed: 1,
          memoriesSaved: 1,
          memoriesQuarantined: 0,
          createdAt: now,
          updatedAt: now,
        });
        const claimId = createHash('sha256').update(`${agentId}\0${source}`).digest('hex');
        await store.doc('importSourceKeys', claimId).set({ agentId, source, sourceId });
        const lineageId = createHash('sha256')
          .update(JSON.stringify([source, imported.id]))
          .digest('hex');
        await store.doc('memoryImportLineage', lineageId).set({
          id: lineageId,
          agentId,
          source,
          memoryId: imported.id,
          sourceUnitProvenance: [],
        });

        const repo = new FirestoreMemoryConsolidationRepository(store, space);
        const facts = (await repo.candidates(agentId)).window?.facts ?? [];
        expect(facts.map((fact) => fact.importSources)).toContainEqual([source]);
        const unified = 'The owner detail and imported detail were combined.';
        const review = {
          agentId,
          subjectContactId: 'person',
          facts,
          retirements: [],
          domainFixes: [],
          timeline: [],
          occasions: [],
          merges: [
            {
              id: randomUUID(),
              content: unified,
              contentHash: createHash('sha256').update(unified).digest('hex'),
              embeddingSpaceKey: embeddingSpaceKey(space),
              embedding: [1, 0],
              kind: 'fact' as const,
              confidence: '0.70',
              importance: 3,
              domain: 'work',
              sourceTaskId: null,
              memberIds: facts.map((fact) => fact.id),
            },
          ],
        };
        const removed = await new FirestoreImportCommandRepository(store, agentId).remove(source);
        expect(removed.cleanupReady).toBe(true);
        await expect(repo.applyReview(review)).rejects.toThrow(
          /An imported source changed while consolidation was in flight|Consolidation memory changed during review/,
        );
        expect((await store.doc('memories', imported.id).get()).exists).toBe(false);
        expect((await store.doc('memories', ownerAdded.id).get()).get('supersededById')).toBeNull();
        expect(
          (await store.collection('memories').where('content', '==', unified).get()).size,
        ).toBe(0);
      } finally {
        await disposeStore(store);
      }
    });

    it('moves past a full reviewed window and refuses to stamp a newly non-singleton subject', async () => {
      const store = emulatorStore(() => now);
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        const ids = Array.from({ length: 65 }, () => randomUUID());
        for (const id of ids) await seed(store, memory(id, 'owner', 'large'));
        const alone = memory(randomUUID(), 'owner', 'new-person');
        await seed(store, alone);
        const repo = new FirestoreMemoryConsolidationRepository(store, space);
        const first = await repo.candidates('owner');
        expect(first.window?.facts).toHaveLength(60);
        await repo.applyReview({
          agentId: 'owner',
          subjectContactId: 'large',
          facts: first.window?.facts ?? [],
          retirements: [],
          merges: [],
          domainFixes: [],
          timeline: [],
        });
        const next = await repo.candidates('owner');
        expect(next.window?.facts.filter((row) => !row.lastConsolidatedAt)).toHaveLength(5);
        expect(next.standalone.map((row) => row.id)).toContain(alone.id);
        const standalone = next.standalone.find((row) => row.id === alone.id);
        if (!standalone) throw new Error('Expected standalone candidate');
        await seed(store, memory(randomUUID(), 'owner', 'new-person'));
        await expect(repo.stampStandalone('owner', [standalone])).rejects.toThrow(
          'subject changed',
        );
        expect((await store.doc('memories', alone.id).get()).get('lastConsolidatedAt')).toBeNull();
      } finally {
        await disposeStore(store);
      }
    });
  },
);
