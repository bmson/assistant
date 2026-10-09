import { randomUUID } from 'node:crypto';
import type { Records } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { FirestoreGeneratedCardRepository } from './generated-cards.js';
import { encodeRecord } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const cardSpec = (title: string) => ({
  version: 1,
  title,
  icon: 'generic',
  accent: 'mint',
  accessibilityLabel: title,
  sourceLabel: 'test',
  facts: [{ id: 'value', value: title, source: 'test' }],
  blocks: [{ type: 'facts', factIds: ['value'] }],
  actions: [],
  refreshable: false,
});

function cardRecord(
  id: string,
  agentId: string,
  revisionId: string,
  updatedAt = new Date(),
): Records['generatedCards'] {
  return {
    id,
    createdAt: updatedAt,
    updatedAt,
    agentId,
    status: 'active',
    expiresAt: null,
    conversationId: null,
    messageId: null,
    sourceLabel: 'test',
    sourceFingerprint: randomUUID(),
    currentRevisionId: revisionId,
    dismissedAt: null,
  };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore generated-card repository', () => {
  it('deduplicates concurrent creates, revises, and owner-scopes listing and dismissal', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreGeneratedCardRepository(store);
      const sourceFingerprint = `generated-card-test-${randomUUID()}`;
      const first = {
        agentId: 'agent-a',
        id: randomUUID(),
        revisionId: randomUUID(),
        sourceFingerprint,
        sourceLabel: 'test',
        spec: cardSpec('initial'),
        expiresAt: new Date(store.now().getTime() + 86_400_000),
      };
      const second = { ...first, id: randomUUID(), revisionId: randomUUID() };
      const [left, right] = await Promise.all([
        repository.createOrRevise(first),
        repository.createOrRevise(second),
      ]);
      expect(left.card.id).toBe(right.card.id);
      expect(left.revision.id).toBe(right.revision.id);

      const revised = await repository.createOrRevise({
        ...first,
        id: randomUUID(),
        revisionId: randomUUID(),
        spec: cardSpec('revised'),
      });
      expect(revised.card.id).toBe(left.card.id);
      expect(revised.revision.version).toBe(2);
      await expect(
        repository.createOrRevise({
          ...first,
          id: randomUUID(),
          revisionId: randomUUID(),
          spec: cardSpec('stale refresh result'),
          targetCardId: revised.card.id,
          targetRevisionId: left.revision.id,
          touch: true,
        }),
      ).rejects.toThrow('refresh revision is stale');
      expect((await repository.list('agent-a')).map((row) => row.revision.id)).toEqual([
        revised.revision.id,
      ]);
      const refreshed = await repository.createOrRevise({
        ...first,
        revisionId: randomUUID(),
        spec: cardSpec('revised'),
        targetCardId: revised.card.id,
        touch: true,
      });
      expect(refreshed.revision.id).toBe(revised.revision.id);
      expect(refreshed.card.updatedAt.getTime()).toBeGreaterThanOrEqual(
        revised.card.updatedAt.getTime(),
      );
      expect((await repository.get('agent-a', revised.card.id))?.revision.id).toBe(
        revised.revision.id,
      );
      expect(await repository.get('agent-b', revised.card.id)).toBeNull();
      expect(await repository.dismiss('agent-b', revised.card.id)).toBe(false);
      expect(await repository.dismiss('agent-a', revised.card.id)).toBe(true);
      expect(await repository.list('agent-a')).toEqual([]);
    } finally {
      await disposeStore(store);
    }
  });

  it('reads selected IDs directly and fails explicitly when list-all exceeds its bound', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreGeneratedCardRepository(store);
      const selected = await repository.createOrRevise({
        agentId: 'agent-a',
        id: randomUUID(),
        revisionId: randomUUID(),
        sourceFingerprint: randomUUID(),
        sourceLabel: 'test',
        spec: cardSpec('selected'),
        expiresAt: new Date(Date.now() - 60_000),
      });
      const batch = store.db.batch();
      for (let index = 0; index < 201; index++) {
        const id = randomUUID();
        batch.set(
          store.doc('generatedCards', id),
          encodeRecord(cardRecord(id, 'agent-a', randomUUID())),
        );
      }
      await batch.commit();

      expect((await repository.list('agent-a', new Date(), [selected.card.id]))[0]).toMatchObject({
        card: { id: selected.card.id },
        revision: { id: selected.revision.id },
      });
      await expect(repository.list('agent-a')).rejects.toThrow('exceeds 200');
      await expect(
        repository.list(
          'agent-a',
          new Date(),
          Array.from({ length: 101 }, () => randomUUID()),
        ),
      ).rejects.toThrow('more than 100');
    } finally {
      await disposeStore(store);
    }
  });

  it('bounds live cards without counting expired undismissed history', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreGeneratedCardRepository(store);
      const now = new Date();
      const batch = store.db.batch();
      for (let index = 0; index < 401; index++) {
        const id = `expired-${index}`;
        batch.set(
          store.doc('generatedCards', id),
          encodeRecord({
            ...cardRecord(id, 'agent-a', `rev-${index}`),
            expiresAt: new Date(now.getTime() - 1000),
          }),
        );
      }
      await batch.commit();
      expect(await repository.list('agent-a', now)).toEqual([]);
      const input = (id: string, expiresAt: Date | null) => ({
        agentId: 'agent-a',
        id,
        revisionId: `revision-${id}`,
        sourceFingerprint: `fingerprint-${id}`,
        sourceLabel: 'test',
        spec: cardSpec(id),
        expiresAt,
      });
      await repository.createOrRevise(input('no-expiry', null));
      await repository.createOrRevise(input('future', new Date(now.getTime() + 60_000)));
      await repository.createOrRevise(input('at-boundary', now));
      expect((await repository.list('agent-a', now)).map((row) => row.card.id).sort()).toEqual([
        'at-boundary',
        'future',
        'no-expiry',
      ]);
      expect((await store.collection('generatedCards').get()).size).toBe(404);
    } finally {
      await disposeStore(store);
    }
  });

  it('returns only the latest owner-scoped refresh task for each card', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreGeneratedCardRepository(store);
      const firstCard = randomUUID();
      const secondCard = randomUUID();
      const base = Date.now();
      const tasks = [
        { id: randomUUID(), agentId: 'agent-a', cardId: firstCard, createdAt: new Date(base - 30) },
        { id: randomUUID(), agentId: 'agent-a', cardId: firstCard, createdAt: new Date(base - 10) },
        { id: randomUUID(), agentId: 'agent-b', cardId: firstCard, createdAt: new Date(base) },
        {
          id: randomUUID(),
          agentId: 'agent-a',
          cardId: secondCard,
          createdAt: new Date(base - 20),
        },
      ];
      await Promise.all(
        tasks.map((task) =>
          store.doc('tasks', task.id).set({
            id: task.id,
            agentId: task.agentId,
            status: 'done',
            createdAt: task.createdAt,
            trigger: { payload: { refreshCardId: task.cardId } },
          }),
        ),
      );

      expect(await repository.listRefreshes('agent-a', [firstCard, secondCard, firstCard])).toEqual(
        [
          {
            id: tasks[1]?.id,
            cardId: firstCard,
            status: 'done',
            createdAt: tasks[1]?.createdAt,
          },
          {
            id: tasks[3]?.id,
            cardId: secondCard,
            status: 'done',
            createdAt: tasks[3]?.createdAt,
          },
        ],
      );
    } finally {
      await disposeStore(store);
    }
  });
});
