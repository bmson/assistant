import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core';
import {
  agents,
  conversations,
  createDb,
  createPostgresConversationSearchRepository,
  type Db,
  maintenanceCursors,
  messages,
  tasks,
  toolCalls,
} from '@assistant/db';
import {
  conversationMessageSourceRevision,
  type EmbeddingSpace,
  embeddingSpaceIdentityKey,
} from '@assistant/persistence';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { registerBuiltinTools } from './index.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const related = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
const space: EmbeddingSpace = {
  provider: 'test',
  model: 'conversation-search',
  dimensions: 1536,
  revision: '1',
};
const spaceKey = embeddingSpaceIdentityKey(space);
const oldSpaceKey = 'a'.repeat(64);

describe('conversations.search PostgreSQL owner and privacy filters', () => {
  let db: Db;
  let dbUp = false;
  let agentId = '';
  let foreignAgentId = '';
  const conversationIds: string[] = [];
  const messageIds: string[] = [];
  const cursorNames: string[] = [];
  const taskIds: string[] = [];
  const toolCallIds: string[] = [];
  const additionalAgentIds: string[] = [];

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      foreignAgentId = randomUUID();
      await db.insert(agents).values({
        id: foreignAgentId,
        name: `conversation-search-${foreignAgentId.slice(0, 8)}`,
        email: `${foreignAgentId}@conversation-search.invalid`,
        workspacePrefix: `conversation-search/${foreignAgentId}`,
      });
      dbUp = true;
    } catch {
      console.warn('conversation-search.integration.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) {
      if (toolCallIds.length) await db.delete(toolCalls).where(inArray(toolCalls.id, toolCallIds));
      if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
      if (messageIds.length) await db.delete(messages).where(inArray(messages.id, messageIds));
      if (conversationIds.length)
        await db.delete(conversations).where(inArray(conversations.id, conversationIds));
      if (cursorNames.length)
        await db.delete(maintenanceCursors).where(inArray(maintenanceCursors.name, cursorNames));
      if (foreignAgentId) await db.delete(agents).where(eq(agents.id, foreignAgentId));
      if (additionalAgentIds.length)
        await db.delete(agents).where(inArray(agents.id, additionalAgentIds));
    }
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  });

  it('keeps semantic and text results owner-scoped, visible, exact-space, and fixture-free', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [owned] = await db
      .insert(conversations)
      .values({
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: 'conversation search owned fixture',
      })
      .returning({ id: conversations.id });
    const [foreign] = await db
      .insert(conversations)
      .values({
        agentId: foreignAgentId,
        channel: 'chat',
        trust: 'owner',
        title: 'conversation search foreign fixture',
      })
      .returning({ id: conversations.id });
    if (!owned || !foreign) throw new Error('Could not create search fixture conversations');
    conversationIds.push(owned.id, foreign.id);

    async function add(input: {
      conversationId: string;
      text: string;
      createdAt?: Date;
      embedding?: number[] | null;
      embeddingSpaceKey?: string | null;
      hidden?: boolean;
      channelMessageId?: string;
    }) {
      const [row] = await db
        .insert(messages)
        .values({
          conversationId: input.conversationId,
          role: 'user',
          origin: 'owner',
          parts: [],
          text: input.text,
          ...(input.createdAt ? { createdAt: input.createdAt } : {}),
          embedding: input.embedding === undefined ? related : input.embedding,
          embeddingSpaceKey:
            input.embeddingSpaceKey === undefined ? spaceKey : input.embeddingSpaceKey,
          hiddenAt: input.hidden ? new Date() : null,
          ...(input.channelMessageId ? { channelMessageId: input.channelMessageId } : {}),
        })
        .returning({ id: messages.id });
      if (!row) throw new Error('Could not create search fixture message');
      messageIds.push(row.id);
    }

    await add({ conversationId: owned.id, text: 'owner semantic visible result' });
    await add({ conversationId: owned.id, text: 'literal %_\\ marker', embedding: null });
    await add({ conversationId: owned.id, text: 'literal wildcard decoy marker', embedding: null });
    await add({ conversationId: owned.id, text: 'owner semantic hidden result', hidden: true });
    await add({ conversationId: foreign.id, text: 'foreign semantic result' });
    await add({
      conversationId: owned.id,
      text: 'old embedding space semantic result',
      embeddingSpaceKey: oldSpaceKey,
    });
    await add({
      conversationId: owned.id,
      text: 'unknown embedding identity result',
      embeddingSpaceKey: null,
    });
    await add({
      conversationId: owned.id,
      text: 'readability semantic result',
      channelMessageId: `readability-search-${randomUUID()}-semantic`,
    });
    await add({
      conversationId: owned.id,
      text: 'visual-qa semantic result',
      channelMessageId: 'visual-qa:search-run:semantic',
    });
    await add({ conversationId: owned.id, text: 'owner unique fallback marker', embedding: null });
    await add({
      conversationId: owned.id,
      text: 'hidden unique fallback marker',
      embedding: null,
      hidden: true,
    });
    await add({
      conversationId: foreign.id,
      text: 'foreign unique fallback marker',
      embedding: null,
    });
    await add({
      conversationId: owned.id,
      text: 'readability unique fallback marker',
      embedding: null,
      channelMessageId: `readability-search-${randomUUID()}-fallback`,
    });
    await add({
      conversationId: owned.id,
      text: 'visual-qa unique fallback marker',
      embedding: null,
      channelMessageId: 'visual-qa:search-run:fallback',
    });

    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [related],
      embedWithIdentity: async () => ({ embeddings: [related], embeddingSpaceKey: spaceKey }),
      conversations: createPostgresConversationSearchRepository(db),
      workspace: {} as never,
    });
    const tool = registry.get('conversations.search')?.tool;
    if (!tool) throw new Error('conversations.search is not registered');
    const context = {
      taskId: randomUUID(),
      agentId,
      trust: 'owner',
      tainted: false,
      db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
    } as ToolContext;

    const semantic = (await tool.execute(
      { query: 'semantic fixture query', limit: 20 },
      context,
    )) as { mode: string; matches: Array<{ text: string }> };
    expect(semantic.mode).toBe('semantic');
    expect(semantic.matches.map((row) => row.text)).toEqual(['owner semantic visible result']);
    expect(semantic.matches.some((row) => row.text === 'readability semantic result')).toBe(false);

    const literal = await createPostgresConversationSearchRepository(db).text({
      agentId,
      query: '%_\\',
      limit: 10,
    });
    expect(literal.map((row) => row.text)).toEqual(['literal %_\\ marker']);

    await db.update(messages).set({ embedding: null }).where(inArray(messages.id, messageIds));
    const fallback = (await tool.execute(
      { query: 'unique fallback marker', limit: 20 },
      context,
    )) as { mode: string; matches: Array<{ text: string }> };
    expect(fallback.mode).toBe('text');
    expect(fallback.matches.map((row) => row.text)).toEqual(['owner unique fallback marker']);
    expect(fallback.matches.some((row) => row.text.includes('readability'))).toBe(false);
  });

  it('applies active and completed erasure fences without trusting a foreign current conversation', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [owned] = await db
      .insert(conversations)
      .values({
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: 'conversation search cutoff fixture',
      })
      .returning({ id: conversations.id });
    const [foreign] = await db
      .insert(conversations)
      .values({
        agentId: foreignAgentId,
        channel: 'chat',
        trust: 'owner',
        title: 'conversation search foreign cutoff fixture',
      })
      .returning({ id: conversations.id });
    if (!owned || !foreign) throw new Error('Could not create cutoff fixture conversations');
    conversationIds.push(owned.id, foreign.id);

    const repository = createPostgresConversationSearchRepository(db);
    const marker = `search-cutoff-${randomUUID()}`;
    const before = new Date(Date.now() - 10_000);
    async function addRow(input: {
      conversationId: string;
      text: string;
      createdAt: Date;
    }): Promise<string> {
      const [row] = await db
        .insert(messages)
        .values({
          conversationId: input.conversationId,
          role: 'user',
          origin: 'owner',
          parts: [],
          text: input.text,
          createdAt: input.createdAt,
          embedding: related,
          embeddingSpaceKey: spaceKey,
        })
        .returning({ id: messages.id });
      if (!row) throw new Error('Could not create cutoff fixture message');
      messageIds.push(row.id);
      return row.id;
    }
    await db.insert(maintenanceCursors).values({
      name: `privacy-erasure-result:${agentId}`,
      cursor: '{}',
    });
    cursorNames.push(`privacy-erasure-result:${agentId}`);
    await expect(repository.text({ agentId, query: marker, limit: 10 })).rejects.toThrow(
      'Privacy erasure is in progress',
    );
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-result:${agentId}`));
    cursorNames.pop();

    const cutoff = new Date(Date.now());
    const generationName = `privacy-erasure-generation:${agentId}`;
    await db
      .insert(maintenanceCursors)
      .values({ name: generationName, cursor: randomUUID(), updatedAt: cutoff });
    cursorNames.push(generationName);
    await addRow({ conversationId: owned.id, text: `${marker} old owner row`, createdAt: before });
    await addRow({
      conversationId: owned.id,
      text: `${marker} current owner row`,
      createdAt: before,
    });
    const freshOwnerMessageId = await addRow({
      conversationId: owned.id,
      text: `${marker} fresh owner row`,
      createdAt: new Date(Date.now() + 10_000),
    });
    await addRow({
      conversationId: foreign.id,
      text: `${marker} fresh foreign row`,
      createdAt: new Date(Date.now() + 10_000),
    });

    const ordinary = await repository.text({ agentId, query: marker, limit: 10 });
    expect(ordinary.map((row) => row.text)).toEqual([`${marker} fresh owner row`]);
    expect(
      ordinary.every((row) => row.messageId && /^[a-f0-9]{64}$/.test(row.sourceRevision)),
    ).toBe(true);

    const foreignCurrent = await repository.text({
      agentId,
      query: marker,
      limit: 10,
      currentConversationId: foreign.id,
    } as Parameters<typeof repository.text>[0]);
    expect(foreignCurrent.map((row) => row.text)).toEqual([`${marker} fresh owner row`]);

    const ownerCurrent = await repository.text({
      agentId,
      query: marker,
      limit: 10,
      currentConversationId: owned.id,
    } as Parameters<typeof repository.text>[0]);
    expect(ownerCurrent.map((row) => row.text).sort()).toEqual(
      [
        `${marker} fresh owner row`,
        `${marker} current owner row`,
        `${marker} old owner row`,
      ].sort(),
    );

    const semantic = await repository.semantic({
      agentId,
      embedding: related,
      embeddingSpaceKey: spaceKey,
      limit: 10,
      currentConversationId: owned.id,
    } as Parameters<typeof repository.semantic>[0]);
    expect(semantic.map((row) => row.text).sort()).toEqual(
      [
        `${marker} fresh owner row`,
        `${marker} current owner row`,
        `${marker} old owner row`,
      ].sort(),
    );
    const foreignSemanticCurrent = await repository.semantic({
      agentId,
      embedding: related,
      embeddingSpaceKey: spaceKey,
      limit: 10,
      currentConversationId: foreign.id,
    } as Parameters<typeof repository.semantic>[0]);
    expect(foreignSemanticCurrent.map((row) => row.text)).toEqual([`${marker} fresh owner row`]);

    const previousRevision = ordinary.find(
      (row) => row.text === `${marker} fresh owner row`,
    )?.sourceRevision;
    await db
      .update(messages)
      .set({ text: `${marker} fresh owner row revised` })
      .where(eq(messages.id, freshOwnerMessageId));
    const revised = await repository.text({ agentId, query: marker, limit: 10 });
    expect(revised.find((row) => row.text.endsWith('revised'))?.sourceRevision).not.toBe(
      previousRevision,
    );
  });

  it('uses a strict microsecond erasure cutoff for text, semantic, and exact resume sources', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const precisionAgentId = randomUUID();
    await db.insert(agents).values({
      id: precisionAgentId,
      name: `conversation-search-precision-${precisionAgentId.slice(0, 8)}`,
      email: `${precisionAgentId}@conversation-search.invalid`,
      workspacePrefix: `conversation-search/${precisionAgentId}`,
    });
    additionalAgentIds.push(precisionAgentId);
    const [owned] = await db
      .insert(conversations)
      .values({
        agentId: precisionAgentId,
        channel: 'chat',
        trust: 'owner',
        title: 'strict cutoff precision fixture',
      })
      .returning({ id: conversations.id });
    if (!owned) throw new Error('Could not create strict cutoff conversation');
    conversationIds.push(owned.id);
    const generationName = `privacy-erasure-generation:${precisionAgentId}`;
    const generationId = randomUUID();
    await db
      .insert(maintenanceCursors)
      .values({ name: generationName, cursor: generationId })
      .onConflictDoUpdate({ target: maintenanceCursors.name, set: { cursor: generationId } });
    cursorNames.push(generationName);
    const cutoffText = '2026-10-07 12:00:00.123456+00';
    await db.execute(
      sql`update maintenance_cursors set updated_at = ${cutoffText}::timestamptz where name = ${generationName}`,
    );
    const marker = `microsecond-cutoff-${randomUUID()}`;
    const beforeId = randomUUID();
    const equalId = randomUUID();
    const afterId = randomUUID();
    messageIds.push(beforeId, equalId, afterId);
    await db.execute(sql`insert into messages (id, conversation_id, role, origin, parts, text, created_at, embedding, embedding_space_key, hidden_at)
      values
      (${beforeId}::uuid, ${owned.id}::uuid, 'user', 'owner', '[]'::jsonb, ${`${marker} before`}, '2026-10-07 12:00:00.123455+00'::timestamptz, ${JSON.stringify(related)}::vector, ${spaceKey}, null),
      (${equalId}::uuid, ${owned.id}::uuid, 'user', 'owner', '[]'::jsonb, ${`${marker} equal`}, '2026-10-07 12:00:00.123456+00'::timestamptz, ${JSON.stringify(related)}::vector, ${spaceKey}, null),
      (${afterId}::uuid, ${owned.id}::uuid, 'user', 'owner', '[]'::jsonb, ${`${marker} after`}, '2026-10-07 12:00:00.123457+00'::timestamptz, ${JSON.stringify(related)}::vector, ${spaceKey}, null)`);
    const repository = createPostgresConversationSearchRepository(db);
    const text = await repository.text({ agentId: precisionAgentId, query: marker, limit: 10 });
    expect(text.map((row) => row.text)).toEqual([`${marker} after`]);
    const semantic = await repository.semantic({
      agentId: precisionAgentId,
      embedding: related,
      embeddingSpaceKey: spaceKey,
      limit: 10,
    });
    expect(semantic.map((row) => row.text)).toEqual([`${marker} after`]);
    const resumed = await repository.refreshForResume({
      agentId: precisionAgentId,
      query: marker,
      limit: 10,
      sourceRefs: [beforeId, equalId, afterId].map((messageId) => ({
        messageId,
        conversationId: owned.id,
        sourceRevision: conversationMessageSourceRevision(
          messageId,
          `${marker} ${messageId === beforeId ? 'before' : messageId === equalId ? 'equal' : 'after'}`,
        ),
      })),
    });
    expect(resumed.unchangedSourceRefs).toEqual([false, false, true]);
    expect(resumed.matches.map((row) => row.messageId)).toEqual([afterId]);
  });

  it('validates exact source revisions and refreshes literal owner text after erasure', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [owned] = await db
      .insert(conversations)
      .values({
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: 'resume refresh owned',
      })
      .returning({ id: conversations.id });
    const [foreign] = await db
      .insert(conversations)
      .values({
        agentId: foreignAgentId,
        channel: 'chat',
        trust: 'owner',
        title: 'resume refresh foreign',
      })
      .returning({ id: conversations.id });
    if (!owned || !foreign) throw new Error('Could not create resume-refresh conversations');
    conversationIds.push(owned.id, foreign.id);
    const cutoff = new Date();
    const generationName = `privacy-erasure-generation:${agentId}`;
    await db
      .insert(maintenanceCursors)
      .values({
        name: generationName,
        cursor: randomUUID(),
        updatedAt: cutoff,
      })
      .onConflictDoUpdate({
        target: maintenanceCursors.name,
        set: { cursor: randomUUID(), updatedAt: cutoff },
      });
    cursorNames.push(generationName);
    async function add(conversationId: string, text: string, createdAt: Date): Promise<string> {
      const [row] = await db
        .insert(messages)
        .values({
          conversationId,
          role: 'user',
          origin: 'owner',
          parts: [],
          text,
          createdAt,
          embedding: null,
          embeddingSpaceKey: null,
          hiddenAt: null,
        })
        .returning({ id: messages.id });
      if (!row) throw new Error('Could not create resume-refresh message');
      messageIds.push(row.id);
      return row.id;
    }
    const oldText = 'newsletter private source before reset';
    const oldId = await add(owned.id, oldText, new Date(cutoff.getTime() - 60_000));
    const freshText = 'newsletter fresh source after reset';
    const freshId = await add(owned.id, freshText, new Date(cutoff.getTime() + 60_000));
    const foreignId = await add(
      foreign.id,
      'newsletter foreign source',
      new Date(cutoff.getTime() + 60_000),
    );
    const repository = createPostgresConversationSearchRepository(db);
    const refreshed = await repository.refreshForResume({
      agentId,
      query: 'newsletter',
      limit: 5,
      sourceRefs: [
        {
          messageId: oldId,
          conversationId: owned.id,
          sourceRevision: conversationMessageSourceRevision(oldId, oldText),
        },
      ],
    });
    expect(refreshed.mode).toBe('text');
    expect(refreshed.unchangedSourceRefs).toEqual([false]);
    expect(refreshed.matches.map((row) => row.messageId)).toEqual([freshId]);
    expect(refreshed.matches.map((row) => row.messageId)).not.toContain(foreignId);
    const freshRef = {
      messageId: freshId,
      conversationId: owned.id,
      sourceRevision: refreshed.matches[0]?.sourceRevision ?? '',
    };
    expect(
      (
        await repository.refreshForResume({
          agentId,
          query: 'newsletter',
          limit: 5,
          sourceRefs: [freshRef],
        })
      ).unchangedSourceRefs,
    ).toEqual([true]);
    await db
      .update(messages)
      .set({ text: 'newsletter corrected after reset' })
      .where(eq(messages.id, freshId));
    const corrected = await repository.refreshForResume({
      agentId,
      query: 'newsletter',
      limit: 5,
      sourceRefs: [freshRef],
    });
    expect(corrected.unchangedSourceRefs).toEqual([false]);
    expect(corrected.matches[0]?.text).toBe('newsletter corrected after reset');
    await db.update(messages).set({ hiddenAt: new Date() }).where(eq(messages.id, freshId));
    const hidden = await repository.refreshForResume({
      agentId,
      query: 'newsletter',
      limit: 5,
      sourceRefs: [
        {
          ...freshRef,
          sourceRevision: corrected.matches[0]?.sourceRevision ?? '',
        },
      ],
    });
    expect(hidden.unchangedSourceRefs).toEqual([false]);
    expect(hidden.matches).toEqual([]);
    const literalId = await add(
      owned.id,
      'lit%_marker literal source',
      new Date(cutoff.getTime() + 120_000),
    );
    await add(owned.id, 'litabmarker wildcard decoy', new Date(cutoff.getTime() + 130_000));
    const literal = await repository.refreshForResume({
      agentId,
      query: 'lit%_marker',
      limit: 5,
      sourceRefs: [],
    });
    expect(literal.matches.map((row) => row.messageId)).toEqual([literalId]);
  });

  async function readResultRefusalCase(change: 'corrected' | 'hidden' | 'erased') {
    const readResultAgentId = randomUUID();
    await db.insert(agents).values({
      id: readResultAgentId,
      name: `read-result-${readResultAgentId.slice(0, 8)}`,
      email: `${readResultAgentId}@conversation-search.invalid`,
      workspacePrefix: `conversation-search/${readResultAgentId}`,
    });
    additionalAgentIds.push(readResultAgentId);
    const [sourceConversation] = await db
      .insert(conversations)
      .values({
        agentId: readResultAgentId,
        channel: 'chat',
        trust: 'owner',
        title: `read-result source ${change}`,
      })
      .returning({ id: conversations.id });
    const [currentConversation] = await db
      .insert(conversations)
      .values({
        agentId: readResultAgentId,
        channel: 'chat',
        trust: 'owner',
        title: `read-result current ${change}`,
      })
      .returning({ id: conversations.id });
    if (!sourceConversation || !currentConversation)
      throw new Error('Could not create read-result conversations');
    conversationIds.push(sourceConversation.id, currentConversation.id);

    const taskId = randomUUID();
    const toolCallId = randomUUID();
    const body = `newsletter privacy marker ${'old private source '.repeat(700)}`;
    const [source] = await db
      .insert(messages)
      .values({
        conversationId: sourceConversation.id,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: body,
        createdAt: new Date(Date.now() - 60_000),
        embedding: null,
        embeddingSpaceKey: null,
        hiddenAt: null,
      })
      .returning({ id: messages.id });
    if (!source) throw new Error('Could not create oversized search source');
    messageIds.push(source.id);
    const repository = createPostgresConversationSearchRepository(db);
    const matches = await repository.text({
      agentId: readResultAgentId,
      query: 'privacy marker',
      limit: 5,
      currentConversationId: currentConversation.id,
    });
    expect(matches).toHaveLength(1);
    const result = {
      mode: 'semantic',
      matches: matches.map((match) => ({ ...match, similarity: 0.9 })),
    };
    expect(JSON.stringify(result).length).toBeGreaterThan(8_000);

    await db.insert(tasks).values({
      id: taskId,
      agentId: readResultAgentId,
      type: 'chat_turn',
      status: 'running',
      trust: 'owner',
      conversationId: currentConversation.id,
    });
    taskIds.push(taskId);
    await db.insert(toolCalls).values({
      id: toolCallId,
      taskId,
      step: 1,
      toolName: 'conversations.search',
      risk: 'autonomous',
      status: 'succeeded',
      args: { query: 'privacy marker', limit: 5 },
      result,
    });
    toolCallIds.push(toolCallId);

    if (change === 'corrected') {
      await db
        .update(messages)
        .set({ text: 'newsletter privacy marker corrected; old source withdrawn.' })
        .where(eq(messages.id, source.id));
    } else if (change === 'hidden') {
      await db.update(messages).set({ hiddenAt: new Date() }).where(eq(messages.id, source.id));
    } else {
      const generationName = `privacy-erasure-generation:${readResultAgentId}`;
      const cutoff = new Date();
      await db
        .insert(maintenanceCursors)
        .values({ name: generationName, cursor: randomUUID(), updatedAt: cutoff })
        .onConflictDoUpdate({
          target: maintenanceCursors.name,
          set: { cursor: randomUUID(), updatedAt: cutoff },
        });
      cursorNames.push(generationName);
    }

    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [],
      embedWithIdentity: async () => ({ embeddings: [], embeddingSpaceKey: spaceKey }),
      conversations: repository,
      workspace: {} as never,
    });
    const tool = registry.get('tools.read_result')?.tool;
    if (!tool) throw new Error('tools.read_result was not registered');
    const page = (await tool.execute({ toolCallId, offset: 0 }, {
      taskId,
      agentId: readResultAgentId,
      conversationId: currentConversation.id,
      trust: 'owner',
      tainted: false,
      db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
    } as ToolContext)) as Record<string, unknown>;
    expect(page).toMatchObject({ error: expect.stringContaining('changed') });
    expect(JSON.stringify(page)).not.toContain(body);
    const unchangedEffect = await db
      .select({ result: toolCalls.result })
      .from(toolCalls)
      .where(eq(toolCalls.id, toolCallId));
    const persistedJSONResult = JSON.parse(JSON.stringify(result));
    expect(unchangedEffect[0]?.result).toEqual(persistedJSONResult);
  }

  for (const change of ['corrected', 'hidden', 'erased'] as const) {
    it(`does not page an oversized stored search after its source is ${change}`, async (ctx) => {
      if (!dbUp) return ctx.skip();
      await readResultRefusalCase(change);
    });
  }
});
