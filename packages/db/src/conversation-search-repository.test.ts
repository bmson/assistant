import { randomUUID } from 'node:crypto';
import {
  type ConversationSearchRepository,
  conversationMessageSourceRevision,
  conversationMessageSpeakerRevision,
} from '@assistant/persistence';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresConversationSearchRepository } from './conversation-search-repository.js';
import { agents, conversations, maintenanceCursors, messages } from './schema.js';
import { assertAllocatedTestTarget } from './test-target.js';

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL;
  assertAllocatedTestTarget({
    databaseUrl: url,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    kind: 'standard',
  });
  if (!url) throw new Error('Missing allocated test database URL');
  return url;
})();

function contextFor(repository: ConversationSearchRepository) {
  if (!repository.context) throw new Error('Conversation context is unavailable');
  return repository.context.bind(repository);
}

describe('PostgreSQL conversation context repository', () => {
  let db: Db;
  let agentId: string;
  const conversationIds: string[] = [];
  const messageIds: string[] = [];
  const additionalAgentIds: string[] = [];

  beforeEach(async () => {
    db = createDb(DATABASE_URL);
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      name: 'Conversation context test owner',
      email: `${agentId}@example.test`,
      workspacePrefix: `test/${agentId}`,
    });
  });

  afterEach(async () => {
    if (messageIds.length) await db.delete(messages).where(inArray(messages.id, messageIds));
    if (conversationIds.length)
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${agentId}`));
    await db.delete(agents).where(eq(agents.id, agentId));
    if (additionalAgentIds.length)
      await db.delete(agents).where(inArray(agents.id, additionalAgentIds));
    conversationIds.length = 0;
    messageIds.length = 0;
    additionalAgentIds.length = 0;
    await db.$client.end();
  });

  async function addConversation(owner = agentId): Promise<string> {
    const id = randomUUID();
    await db.insert(conversations).values({ id, agentId: owner, channel: 'chat', trust: 'owner' });
    conversationIds.push(id);
    return id;
  }

  async function addMessage(input: {
    conversationId: string;
    text: string;
    role?: 'user' | 'assistant' | 'system';
    origin?: 'owner' | 'assistant' | 'system';
    createdAt: Date;
    hiddenAt?: Date | null;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(messages).values({
      id,
      conversationId: input.conversationId,
      role: input.role ?? 'user',
      origin: input.origin ?? 'owner',
      text: input.text,
      createdAt: input.createdAt,
      hiddenAt: input.hiddenAt ?? null,
    });
    messageIds.push(id);
    return id;
  }

  function ref(input: {
    messageId: string;
    conversationId: string;
    text: string;
    role: string;
    origin: string;
  }) {
    return {
      messageId: input.messageId,
      conversationId: input.conversationId,
      sourceRevision: conversationMessageSourceRevision(input.messageId, input.text),
      speakerRevision: conversationMessageSpeakerRevision(
        input.messageId,
        input.text,
        input.role,
        input.origin,
      ),
    };
  }

  it('reads the exact anchor and bounded three-before/one-after window, ordered by time then id', async () => {
    const conversationId = await addConversation();
    const rows = [
      { text: 'owner initializer with Aurora exercise cue', role: 'user', origin: 'owner' },
      { text: 'earlier user turn', role: 'user', origin: 'owner' },
      { text: 'assistant setup note', role: 'assistant', origin: 'assistant' },
      { text: 'assistant next step', role: 'assistant', origin: 'assistant' },
      { text: 'later user turn', role: 'user', origin: 'owner' },
      { text: 'later assistant turn', role: 'assistant', origin: 'assistant' },
    ] as const;
    const base = Date.parse('2026-10-16T10:00:00.000Z');
    const ids: string[] = [];
    for (const [index, row] of rows.entries()) {
      ids.push(
        await addMessage({
          conversationId,
          ...row,
          createdAt: new Date(base + index * 60_000),
        }),
      );
    }
    const anchorId = ids[3];
    if (!anchorId) throw new Error('Missing test anchor');
    const repository = createPostgresConversationSearchRepository(db);
    const result = await contextFor(repository)({
      agentId,
      anchors: [
        ref({
          messageId: anchorId,
          conversationId,
          text: rows[3].text,
          role: rows[3].role,
          origin: rows[3].origin,
        }),
      ],
    });
    expect(result.matches.map((row) => row.text)).toEqual(rows.slice(0, 5).map((row) => row.text));
    expect(result.matches).toHaveLength(5);
    expect(result.matches[0]?.origin).toBe('owner');
    expect(result.matches.every((row) => row.sourceRevision.length === 64)).toBe(true);
    expect(result.matches.every((row) => row.speakerRevision?.length === 64)).toBe(true);
    const hiddenNeighborId = await addMessage({
      conversationId,
      text: 'hidden neighbor omitted from context',
      role: 'assistant',
      origin: 'assistant',
      createdAt: new Date(base + 2.5 * 60_000),
      hiddenAt: new Date(),
    });
    const firstContextId = ids[1];
    const secondContextId = ids[4];
    if (!firstContextId || !secondContextId) throw new Error('Missing context fixtures');
    const twoAnchors = await contextFor(repository)({
      agentId,
      anchors: [
        ref({
          messageId: firstContextId,
          conversationId,
          text: rows[1].text,
          role: rows[1].role,
          origin: rows[1].origin,
        }),
        ref({
          messageId: secondContextId,
          conversationId,
          text: rows[4].text,
          role: rows[4].role,
          origin: rows[4].origin,
        }),
      ],
    });
    expect(twoAnchors.matches.length).toBeLessThanOrEqual(10);
    expect(twoAnchors.matches.map((row) => row.messageId)).toContain(ids[1]);
    expect(twoAnchors.matches.map((row) => row.messageId)).toContain(ids[4]);
    expect(twoAnchors.matches.map((row) => row.messageId)).not.toContain(hiddenNeighborId);

    const tiedConversationId = await addConversation();
    const tieLow = '10000000-0000-4000-8000-000000000001';
    const tieAnchor = '10000000-0000-4000-8000-000000000002';
    const tieHigh = '10000000-0000-4000-8000-000000000003';
    const tieAt = new Date('2026-10-16T11:00:00.000Z');
    for (const [id, text] of [
      [tieLow, 'same-time prior'],
      [tieAnchor, 'same-time anchor'],
      [tieHigh, 'same-time next'],
    ] as const) {
      await db.insert(messages).values({
        id,
        conversationId: tiedConversationId,
        role: 'assistant',
        origin: 'assistant',
        text,
        createdAt: tieAt,
      });
      messageIds.push(id);
    }
    const tied = await contextFor(repository)({
      agentId,
      anchors: [
        ref({
          messageId: tieAnchor,
          conversationId: tiedConversationId,
          text: 'same-time anchor',
          role: 'assistant',
          origin: 'assistant',
        }),
      ],
    });
    expect(tied.matches.map((row) => row.messageId)).toEqual([tieLow, tieAnchor, tieHigh]);
  });

  it('uses PostgreSQL microseconds for both neighbor selection and final ordering', async () => {
    const conversationId = await addConversation();
    const base = new Date('2026-10-16T12:00:00.000Z');
    const priorText = 'microsecond prior';
    const anchorText = 'microsecond anchor';
    const followingText = 'microsecond following';
    const priorId = await addMessage({ conversationId, text: priorText, createdAt: base });
    const anchorId = await addMessage({ conversationId, text: anchorText, createdAt: base });
    const followingId = await addMessage({ conversationId, text: followingText, createdAt: base });
    for (const [messageId, timestamp] of [
      [priorId, '2026-10-16T12:00:00.000100Z'],
      [anchorId, '2026-10-16T12:00:00.000200Z'],
      [followingId, '2026-10-16T12:00:00.000300Z'],
    ] as const) {
      await db.execute(
        sql`update messages set created_at = ${timestamp}::timestamptz where id = ${messageId}::uuid`,
      );
    }

    const result = await contextFor(createPostgresConversationSearchRepository(db))({
      agentId,
      anchors: [
        ref({
          messageId: anchorId,
          conversationId,
          text: anchorText,
          role: 'user',
          origin: 'owner',
        }),
      ],
    });

    expect(result.matches.map((row) => row.messageId)).toEqual([priorId, anchorId, followingId]);
    expect(result.matches.map((row) => row.text)).toEqual([priorText, anchorText, followingText]);
  });

  it('fails closed for stale, foreign, hidden, duplicate, oversized, and erased anchors', async () => {
    const conversationId = await addConversation();
    const text = 'exact source anchor';
    const messageId = await addMessage({
      conversationId,
      text,
      role: 'assistant',
      origin: 'assistant',
      createdAt: new Date('2026-10-16T10:00:00.000Z'),
    });
    const anchor = ref({ messageId, conversationId, text, role: 'assistant', origin: 'assistant' });
    const repository = createPostgresConversationSearchRepository(db);
    await expect(
      contextFor(repository)({ agentId, anchors: [{ ...anchor, sourceRevision: '0'.repeat(64) }] }),
    ).rejects.toThrow('stale or unavailable');
    await expect(
      contextFor(repository)({
        agentId,
        anchors: [{ ...anchor, speakerRevision: '0'.repeat(64) }],
      }),
    ).rejects.toThrow('stale or unavailable');
    const foreignAgentId = randomUUID();
    additionalAgentIds.push(foreignAgentId);
    await db.insert(agents).values({
      id: foreignAgentId,
      name: 'Foreign context owner',
      email: `${foreignAgentId}@example.test`,
      workspacePrefix: `test/${foreignAgentId}`,
    });
    const foreignConversationId = await addConversation(foreignAgentId);
    const foreignMessageId = await addMessage({
      conversationId: foreignConversationId,
      text,
      role: 'assistant',
      origin: 'assistant',
      createdAt: new Date('2026-10-16T10:00:00.000Z'),
    });
    const foreignAnchor = ref({
      messageId: foreignMessageId,
      conversationId: foreignConversationId,
      text,
      role: 'assistant',
      origin: 'assistant',
    });
    await expect(contextFor(repository)({ agentId, anchors: [foreignAnchor] })).rejects.toThrow(
      'stale or unavailable',
    );
    await expect(contextFor(repository)({ agentId, anchors: [anchor, anchor] })).rejects.toThrow(
      'Duplicate conversation context anchor',
    );
    await expect(contextFor(repository)({ agentId, anchors: [] })).rejects.toThrow(
      'one or two anchors',
    );
    await expect(
      contextFor(repository)({
        agentId,
        anchors: [
          anchor,
          { ...anchor, messageId: randomUUID() },
          { ...anchor, messageId: randomUUID() },
        ],
      }),
    ).rejects.toThrow('one or two anchors');
    await expect(
      contextFor(repository)({ agentId, anchors: [anchor, { ...anchor, messageId: 'bad' }] }),
    ).rejects.toThrow('Invalid conversation context anchor identity');
    await db
      .update(messages)
      .set({ text: 'body changed after search' })
      .where(eq(messages.id, messageId));
    await expect(contextFor(repository)({ agentId, anchors: [anchor] })).rejects.toThrow(
      'stale or unavailable',
    );
    await db.update(messages).set({ text, origin: 'system' }).where(eq(messages.id, messageId));
    await expect(contextFor(repository)({ agentId, anchors: [anchor] })).rejects.toThrow(
      'stale or unavailable',
    );
    await db.update(messages).set({ hiddenAt: new Date() }).where(eq(messages.id, messageId));
    await expect(contextFor(repository)({ agentId, anchors: [anchor] })).rejects.toThrow(
      'stale or unavailable',
    );

    const boundaryConversationId = await addConversation();
    const boundaryMessageId = await addMessage({
      conversationId: boundaryConversationId,
      text: 'pre-erasure anchor',
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const boundaryAnchor = ref({
      messageId: boundaryMessageId,
      conversationId: boundaryConversationId,
      text: 'pre-erasure anchor',
      role: 'user',
      origin: 'owner',
    });
    await db.insert(maintenanceCursors).values({
      name: `privacy-erasure-generation:${agentId}`,
      cursor: 'test-erasure-generation',
    });
    await expect(contextFor(repository)({ agentId, anchors: [boundaryAnchor] })).rejects.toThrow(
      'stale or unavailable',
    );
    await expect(
      contextFor(repository)({
        agentId,
        currentConversationId: boundaryConversationId,
        anchors: [boundaryAnchor],
      }),
    ).resolves.toMatchObject({ matches: [{ messageId: boundaryMessageId }] });
  });
});
