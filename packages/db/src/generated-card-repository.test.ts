import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { createPostgresGeneratedCardRepository } from './generated-card-repository.js';
import { agents, conversations, generatedCards } from './schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';

const spec = (title: string) => ({
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

describe('PostgreSQL generated-card repository', () => {
  it('deduplicates concurrent creates, revises atomically, and scopes reads/dismissal', async () => {
    const db = createDb(DATABASE_URL);
    const cardIds: string[] = [];
    let conversationId = '';
    try {
      const [agent] = await db.select().from(agents).limit(1);
      if (!agent) throw new Error('Seed the test database');
      conversationId = randomUUID();
      await db.insert(conversations).values({
        id: conversationId,
        agentId: agent.id,
        channel: 'chat',
        trust: 'owner',
      });
      const repository = createPostgresGeneratedCardRepository(db);
      const sourceFingerprint = `generated-card-test-${randomUUID()}`;
      const first = {
        agentId: agent.id,
        conversationId,
        id: randomUUID(),
        revisionId: randomUUID(),
        sourceFingerprint,
        sourceLabel: 'test',
        spec: spec('initial'),
        expiresAt: new Date(Date.now() + 86_400_000),
      };
      const second = { ...first, id: randomUUID(), revisionId: randomUUID() };
      const results = await Promise.all([
        repository.createOrRevise(first),
        repository.createOrRevise(second),
      ]);
      expect(results[0]?.card.id).toBe(results[1]?.card.id);
      expect(results[0]?.revision.id).toBe(results[1]?.revision.id);
      cardIds.push(results[0].card.id);
      expect(results[0].card.conversationId).toBe(conversationId);

      const revised = await repository.createOrRevise({
        ...first,
        id: randomUUID(),
        revisionId: randomUUID(),
        spec: spec('revised'),
      });
      expect(revised.card.id).toBe(results[0].card.id);
      expect(revised.revision.version).toBe(2);
      await expect(
        repository.createOrRevise({
          ...first,
          id: randomUUID(),
          revisionId: randomUUID(),
          spec: spec('stale refresh result'),
          targetCardId: revised.card.id,
          targetRevisionId: results[0].revision.id,
          touch: true,
        }),
      ).rejects.toThrow('refresh revision is stale');
      expect(
        (await repository.list(agent.id, new Date(), [revised.card.id])).map(
          (row) => row.revision.id,
        ),
      ).toEqual([revised.revision.id]);
      const refreshed = await repository.createOrRevise({
        ...first,
        revisionId: randomUUID(),
        spec: spec('revised'),
        targetCardId: revised.card.id,
        touch: true,
      });
      expect(refreshed.revision.id).toBe(revised.revision.id);
      expect(refreshed.card.updatedAt.getTime()).toBeGreaterThanOrEqual(
        revised.card.updatedAt.getTime(),
      );
      expect((await repository.get(agent.id, revised.card.id))?.revision.id).toBe(
        revised.revision.id,
      );
      expect(await repository.get(randomUUID(), revised.card.id)).toBeNull();
      expect(await repository.dismiss(randomUUID(), revised.card.id)).toBe(false);
      expect(await repository.dismiss(agent.id, revised.card.id)).toBe(true);
      expect(await repository.list(agent.id, new Date(), [revised.card.id])).toEqual([]);

      await expect(
        repository.createOrRevise({
          ...first,
          id: randomUUID(),
          sourceFingerprint: `generated-card-test-${randomUUID()}`,
          revisionId: revised.revision.id,
        }),
      ).rejects.toThrow('revision belongs');
    } finally {
      if (cardIds.length)
        await db.delete(generatedCards).where(inArray(generatedCards.id, cardIds));
      if (conversationId)
        await db.delete(conversations).where(eq(conversations.id, conversationId));
      await db.$client.end();
    }
  });
});
