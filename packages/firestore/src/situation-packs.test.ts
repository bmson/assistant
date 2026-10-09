import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FirestoreSituationPackMutationRepository } from './situation-pack-mutations.js';
import { FirestoreSituationPackReadRepository } from './situation-packs.js';
import { documentKey } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const now = new Date('2026-09-23T12:00:00.000Z');

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore situation pack reads', () => {
  it('keeps cross-pack decision conflicts and filters by owner with revision provenance', async () => {
    const store = emulatorStore(() => now);
    try {
      const owner = randomUUID();
      const other = randomUUID();
      const records = [
        {
          id: randomUUID(),
          agentId: owner,
          creationKey: randomUUID(),
          title: 'Launch plan A',
          createdAt: now,
          updatedAt: now,
          version: 3,
          archived: false,
          data: {
            items: [],
            decisions: [
              {
                id: 'daily-a',
                option: 'Daily check-in',
                outcome: 'rejected',
                reason: 'Daily meetings interrupt focus during launch.',
                scope: 'situation',
                confirmed: true,
              },
            ],
          },
        },
        {
          id: randomUUID(),
          agentId: owner,
          creationKey: randomUUID(),
          title: 'Launch plan B',
          createdAt: now,
          updatedAt: new Date(now.getTime() - 1000),
          version: 2,
          archived: false,
          data: {
            items: [],
            decisions: [
              {
                id: 'daily-b',
                option: 'Daily check-in',
                outcome: 'chosen',
                reason: 'Daily check-ins catch blockers during launch.',
                scope: 'situation',
                confirmed: true,
              },
            ],
          },
        },
        {
          id: randomUUID(),
          agentId: other,
          creationKey: randomUUID(),
          title: 'Launch plan secret',
          createdAt: now,
          updatedAt: now,
          version: 1,
          archived: false,
          data: {
            items: [],
            decisions: [
              {
                id: 'foreign',
                option: 'Daily check-in',
                outcome: 'chosen',
                reason: 'Foreign owner confidential choice.',
                scope: 'situation',
                confirmed: true,
              },
            ],
          },
        },
      ];
      await Promise.all(
        records.map((record) => store.doc('situationPacks', record.id).set(record)),
      );

      const decisions = await new FirestoreSituationPackReadRepository(store).decisionContext(
        owner,
        'Should we add a daily check-in for launch?',
        1,
      );

      expect(decisions).toHaveLength(2);
      expect(decisions.map((decision) => decision.outcome).sort()).toEqual(['chosen', 'rejected']);
      expect(decisions.map(({ packId, packVersion }) => [packId, packVersion])).toEqual([
        [records[0]?.id, 3],
        [records[1]?.id, 2],
      ]);
      expect(JSON.stringify(decisions)).not.toContain('Foreign owner confidential choice');
    } finally {
      await disposeStore(store);
    }
  });

  it('projects only owner packs and sources, detects linked changes, and honors erasure', async () => {
    const store = emulatorStore(() => now);
    try {
      const owner = randomUUID();
      const other = randomUUID();
      const packId = randomUUID();
      const foreignPackId = randomUUID();
      const commitmentId = randomUUID();
      const foreignCommitmentId = randomUUID();
      const cardId = randomUUID();
      const revisionId = randomUUID();
      const earlier = new Date('2026-09-22T12:00:00.000Z');
      await Promise.all([
        store.doc('situationPacks', packId).set({
          id: packId,
          agentId: owner,
          creationKey: 'trip',
          title: 'Trip',
          createdAt: earlier,
          updatedAt: now,
          version: 2,
          archived: false,
          data: {
            items: [
              {
                id: 'booking',
                title: 'Check booking',
                details: '',
                lane: 'plan',
                dependsOn: [],
                needsReview: false,
                source: { kind: 'commitment', id: commitmentId },
                snapshot: {
                  revision: earlier.toISOString(),
                  state: 'open',
                  title: 'Old booking',
                  details: '',
                },
              },
              {
                id: 'travel',
                title: 'Arrange travel',
                details: '',
                lane: 'plan',
                dependsOn: ['booking'],
                needsReview: false,
                source: null,
                snapshot: null,
              },
              {
                id: 'ticket',
                title: 'Use saved ticket',
                details: '',
                lane: 'plan',
                dependsOn: [],
                needsReview: false,
                source: { kind: 'card', id: cardId },
                snapshot: null,
              },
              {
                id: 'foreign_link',
                title: 'Untrusted link',
                details: '',
                lane: 'plan',
                dependsOn: [],
                needsReview: false,
                source: { kind: 'commitment', id: foreignCommitmentId },
                snapshot: null,
              },
            ],
            decisions: [],
          },
        }),
        store.doc('situationPacks', foreignPackId).set({
          id: foreignPackId,
          agentId: other,
          creationKey: 'secret',
          title: 'Secret',
          createdAt: earlier,
          updatedAt: now,
          version: 1,
          archived: false,
          data: { items: [], decisions: [] },
        }),
        store.doc('commitments', commitmentId).set({
          id: commitmentId,
          agentId: owner,
          title: 'New booking',
          status: 'open',
          updatedAt: now,
          kind: 'waiting_on',
          details: '',
          nextAction: '',
          dueAt: null,
          resolution: null,
        }),
        store.doc('commitments', foreignCommitmentId).set({
          id: foreignCommitmentId,
          agentId: other,
          title: 'Foreign secret',
          status: 'open',
          updatedAt: now,
          kind: 'i_owe',
        }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId: owner,
          updatedAt: now,
          status: 'active',
          expiresAt: null,
          currentRevisionId: revisionId,
        }),
        store.doc('generatedCardRevisions', revisionId).set({
          id: revisionId,
          cardId,
          spec: {
            version: 1,
            title: 'Saved card',
            icon: 'generic',
            accent: 'mint',
            accessibilityLabel: 'Saved card',
            sourceLabel: 'test',
            facts: [
              { id: 'public', value: 'Visible', source: 'test' },
              { id: 'private', value: 'Never expose me', source: 'test', sensitive: true },
            ],
            blocks: [{ type: 'facts', factIds: ['public', 'private'] }],
            actions: [],
            refreshable: false,
          },
        }),
      ]);
      const repository = new FirestoreSituationPackReadRepository(store);
      const result = await repository.overview(owner);
      expect(result.packs.map((pack) => pack.id)).toEqual([packId]);
      expect(result.packs[0]?.changes).toMatchObject([
        { itemId: 'booking', after: { title: 'New booking' } },
        { itemId: 'ticket', after: { title: 'Saved card', details: 'public: Visible' } },
        { itemId: 'foreign_link', after: { state: 'unavailable' } },
      ]);
      expect(result.packs[0]?.affectedIds).toEqual(['booking', 'travel', 'ticket', 'foreign_link']);
      expect(result.sources).toMatchObject([
        { id: cardId, title: 'Saved card' },
        { id: commitmentId, title: 'New booking', lane: 'waiting_on' },
      ]);
      expect(JSON.stringify(result)).not.toContain('Foreign secret');
      expect(JSON.stringify(result)).not.toContain('Never expose me');
      await store.doc('privacyErasureJobs', owner).set({
        agentId: owner,
        status: 'active',
        generation: randomUUID(),
      });
      await expect(repository.overview(owner)).rejects.toThrow('Privacy erasure');
    } finally {
      await disposeStore(store);
    }
  });
});

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore situation pack writes', () => {
  it('creates idempotently, checks owner and version, and commits a validated item atomically', async () => {
    const store = emulatorStore(() => now);
    try {
      const owner = randomUUID();
      const other = randomUUID();
      await store.doc('agents', owner).set({ id: owner });
      const repository = new FirestoreSituationPackMutationRepository(store, owner);
      const command = { action: 'create', title: 'Trip', creationKey: 'trip-2026' };
      const first = await repository.command(command);
      expect(first.ok).toBe(true);
      const repeated = await repository.command(command);
      expect(repeated).toEqual(first);
      if (!first.ok) throw new Error('Expected pack creation');
      const packRef = store.doc('situationPacks', first.packId);
      const added = await repository.command({
        action: 'item',
        packId: first.packId,
        version: 1,
        item: { id: 'flight', title: 'Confirm flight', dependsOn: [], source: null },
      });
      expect(added).toEqual({ ok: true, packId: first.packId });
      expect((await packRef.get()).data()).toMatchObject({
        version: 2,
        data: { items: [{ id: 'flight' }] },
      });
      expect(
        await new FirestoreSituationPackMutationRepository(store, other).command({
          action: 'archive',
          packId: first.packId,
          version: 2,
        }),
      ).toMatchObject({ ok: false });
      expect(
        await repository.command({
          action: 'archive',
          packId: first.packId,
          version: 1,
        }),
      ).toMatchObject({ ok: false, error: 'This pack changed. Reload it before trying again.' });
      expect((await packRef.get()).get('archived')).toBe(false);
      expect(documentKey(first.packId)).toBe((await packRef.get()).id);
    } finally {
      await disposeStore(store);
    }
  });

  it('rejects a foreign linked source and privacy-erasure fence without changing the pack', async () => {
    const store = emulatorStore(() => now);
    try {
      const owner = randomUUID();
      const other = randomUUID();
      const packId = randomUUID();
      const cardId = randomUUID();
      await Promise.all([
        store.doc('agents', owner).set({ id: owner }),
        store.doc('situationPacks', packId).set({
          id: packId,
          agentId: owner,
          creationKey: 'c',
          title: 'Trip',
          version: 1,
          archived: false,
          data: { items: [], decisions: [] },
          createdAt: now,
          updatedAt: now,
        }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId: other,
          currentRevisionId: randomUUID(),
          status: 'active',
          updatedAt: now,
        }),
      ]);
      const repository = new FirestoreSituationPackMutationRepository(store, owner);
      const rejected = await repository.command({
        action: 'item',
        packId,
        version: 1,
        item: { id: 'ticket', title: 'Use ticket', source: { kind: 'card', id: cardId } },
      });
      expect(rejected).toMatchObject({
        ok: false,
        error: 'The linked source is unavailable or belongs to another owner.',
      });
      expect((await store.doc('situationPacks', packId).get()).get('version')).toBe(1);
      await store
        .doc('privacyErasureJobs', owner)
        .set({ agentId: owner, status: 'active', generation: randomUUID() });
      await expect(
        repository.command({
          action: 'archive',
          packId,
          version: 1,
        }),
      ).resolves.toMatchObject({ ok: false, error: 'Privacy erasure is in progress' });
      expect((await store.doc('situationPacks', packId).get()).get('archived')).toBe(false);
    } finally {
      await disposeStore(store);
    }
  });
});
