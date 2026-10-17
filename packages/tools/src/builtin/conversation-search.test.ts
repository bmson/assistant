import { randomUUID } from 'node:crypto';
import {
  agents,
  conversations,
  createDb,
  createPostgresConversationSearchRepository,
  type Db,
  maintenanceCursors,
  messages,
} from '@assistant/db';
import {
  type ConversationSearchMatch,
  type ConversationSearchRepository,
  type ConversationSearchSourceRef,
  conversationMessageSourceRevision,
  conversationMessageSpeakerRevision,
} from '@assistant/persistence';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { registerPortableConversationSearchTool } from './conversation-search.js';

const match: ConversationSearchMatch = {
  messageId: '56a09ec4-c495-4d96-966f-8e8e66476cef',
  conversationId: '8e689bcc-cfef-4ca6-a5e3-f0a546fe306b',
  text: 'Cobalt was a fictional exercise, not a personal preference.',
  role: 'user',
  origin: 'owner',
  createdAt: new Date(),
  sourceRevision: 'b'.repeat(64),
  speakerRevision: 'c'.repeat(64),
};
const context = { agentId: 'owner-a', conversationId: 'current-owned-thread' } as ToolContext;
const contextBody = 'The fictional exercise used the Cobalt travel budget.';
const contextAnchor: ConversationSearchSourceRef = {
  messageId: '78a2e9a0-13c6-4c3e-9b5a-0b72859a4581',
  conversationId: '6c46bc97-0320-4c54-bbc8-9c838af4c520',
  sourceRevision: conversationMessageSourceRevision(
    '78a2e9a0-13c6-4c3e-9b5a-0b72859a4581',
    contextBody,
  ),
  speakerRevision: conversationMessageSpeakerRevision(
    '78a2e9a0-13c6-4c3e-9b5a-0b72859a4581',
    contextBody,
    'user',
    'owner',
  ),
};
const contextMatch: ConversationSearchMatch = {
  ...contextAnchor,
  text: contextBody,
  role: 'user',
  origin: 'owner',
  createdAt: new Date('2026-10-16T12:00:00.000Z'),
};
function fixture(webUrl?: string) {
  const repository = {
    text: vi.fn(async () => [match]),
    semantic: vi.fn(async () => [{ ...match, similarity: 0.95 }]),
    context: vi.fn(async () => ({ matches: [contextMatch], observationGeneration: 'erase-gen-1' })),
    refreshForResume: vi.fn(),
  } satisfies ConversationSearchRepository;
  const embed = vi.fn(async () => ({ embeddings: [[1, 0]], embeddingSpaceKey: 'a'.repeat(64) }));
  const registry = registerPortableConversationSearchTool(new ToolRegistry(), {
    conversations: repository,
    embed,
    webUrl,
  });
  const entry = registry.get('conversations.search');
  const contextEntry = registry.get('conversations.context');
  if (!entry) throw new Error('Missing conversation search tool');
  if (!contextEntry) throw new Error('Missing conversation context tool');
  return {
    repository,
    embed,
    registry,
    ...entry,
    contextTool: contextEntry.tool,
    contextFlags: contextEntry.flags,
  };
}

describe('portable conversation search literal mode and semantic compatibility', () => {
  it('adds configured web links without replacing source identity or trusting a repository URL', async () => {
    const f = fixture('https://assistant.example');
    const result = await f.tool.execute(
      f.tool.inputSchema.parse({ query: 'Cobalt', mode: 'text', limit: 12 }),
      context,
    );
    expect(result).toEqual({
      mode: 'text',
      matches: [
        {
          ...match,
          sourceUrl: `https://assistant.example/chat/${match.conversationId}#message-${match.messageId}`,
        },
      ],
    });
    const contextResult = await f.contextTool.execute(
      f.contextTool.inputSchema.parse({ anchors: [contextAnchor] }),
      context,
    );
    expect(contextResult).toMatchObject({
      matches: [
        {
          ...contextMatch,
          sourceUrl: `https://assistant.example/chat/${contextMatch.conversationId}#message-${contextMatch.messageId}`,
        },
      ],
    });
    const invalid = fixture('javascript:alert(1)');
    expect(
      await invalid.tool.execute(
        invalid.tool.inputSchema.parse({ query: 'Cobalt', mode: 'text' }),
        context,
      ),
    ).toEqual({ mode: 'text', matches: [match] });
  });

  it('runs explicit text search without embeddings, preserving exact source and authenticated scope', async () => {
    const f = fixture();
    const args = f.tool.inputSchema.parse({
      query: 'Cobalt',
      mode: 'text',
      limit: 12,
      agentId: 'foreign',
      currentConversationId: 'foreign-thread',
    });
    expect(await f.tool.execute(args, context)).toEqual({ mode: 'text', matches: [match] });
    expect(f.repository.text).toHaveBeenCalledExactlyOnceWith({
      agentId: 'owner-a',
      currentConversationId: 'current-owned-thread',
      query: 'Cobalt',
      limit: 12,
    });
    expect(f.repository.semantic).not.toHaveBeenCalled();
    expect(f.embed).not.toHaveBeenCalled();
  });

  it('keeps confidential-read and untrusted-result fences for both modes', () => {
    const f = fixture();
    expect(f.flags).toMatchObject({ confidentialRead: true, returnsUntrustedContent: true });
    expect(f.registry.toolsForTask('owner').map((tool) => tool.name)).toContain(
      'conversations.search',
    );
    expect(f.registry.toolsForTask('known')).toEqual([]);
    expect(f.registry.toolsForTask('unknown')).toEqual([]);
  });

  it('registers a bounded context read with exact authenticated source anchors', async () => {
    const f = fixture();
    expect(f.contextFlags).toMatchObject({
      confidentialRead: true,
      returnsUntrustedContent: true,
    });
    expect(f.registry.toolsForTask('owner').map((tool) => tool.name)).toContain(
      'conversations.context',
    );
    expect(f.registry.toolsForTask('known')).toEqual([]);
    const args = f.contextTool.inputSchema.parse({ anchors: [contextAnchor] });

    await expect(f.contextTool.execute(args, context)).resolves.toEqual({
      mode: 'context',
      matches: [contextMatch],
      anchors: [contextAnchor],
      window: { before: 3, after: 1 },
      observationGeneration: 'erase-gen-1',
    });
    expect(f.repository.context).toHaveBeenCalledExactlyOnceWith({
      agentId: 'owner-a',
      currentConversationId: 'current-owned-thread',
      anchors: [contextAnchor],
    });
  });

  it('requires 1–2 distinct complete anchors with speaker revisions and no extra input fields', () => {
    const f = fixture();
    for (const input of [
      { anchors: [] },
      { anchors: [(({ speakerRevision: _revision, ...rest }) => rest)(contextAnchor)] },
      { anchors: [contextAnchor, contextAnchor, contextAnchor] },
      { anchors: [contextAnchor], query: 'broaden the read' },
    ])
      expect(f.contextTool.inputSchema.safeParse(input).success).toBe(false);
  });

  it('fails closed if a context result omits an exact anchor or exceeds ten matches', async () => {
    const f = fixture();
    const args = f.contextTool.inputSchema.parse({ anchors: [contextAnchor] });
    f.repository.context.mockResolvedValueOnce({
      matches: [],
      observationGeneration: 'erase-gen-1',
    });
    await expect(f.contextTool.execute(args, context)).rejects.toThrow(/exact anchor/u);
    f.repository.context.mockResolvedValueOnce({
      matches: Array.from({ length: 11 }, (_, index) => ({
        ...contextMatch,
        messageId: `${index}`,
      })) as ConversationSearchMatch[],
      observationGeneration: 'erase-gen-1',
    });
    await expect(f.contextTool.execute(args, context)).rejects.toThrow(/malformed evidence/u);
  });

  it('fails closed when the optional context capability is unavailable', async () => {
    const f = fixture();
    (f.repository as Partial<typeof f.repository>).context = undefined;
    const args = f.contextTool.inputSchema.parse({ anchors: [contextAnchor] });
    await expect(f.contextTool.execute(args, context)).rejects.toThrow(/unavailable/u);
  });

  it('rejects a context row whose speaker revision does not bind its role and origin', async () => {
    const f = fixture();
    f.repository.context.mockResolvedValueOnce({
      matches: [{ ...contextMatch, speakerRevision: 'f'.repeat(64) }],
      observationGeneration: 'erase-gen-1',
    });
    const args = f.contextTool.inputSchema.parse({ anchors: [contextAnchor] });
    await expect(f.contextTool.execute(args, context)).rejects.toThrow(/malformed evidence/u);
  });

  it('rejects a validly hashed context row from a conversation outside the anchors', async () => {
    const f = fixture();
    const foreignId = randomUUID();
    const foreignText = 'A validly hashed row from another conversation.';
    f.repository.context.mockResolvedValueOnce({
      matches: [
        contextMatch,
        {
          messageId: foreignId,
          conversationId: randomUUID(),
          text: foreignText,
          role: 'user',
          origin: 'owner',
          createdAt: new Date('2026-10-16T12:01:00.000Z'),
          sourceRevision: conversationMessageSourceRevision(foreignId, foreignText),
          speakerRevision: conversationMessageSpeakerRevision(
            foreignId,
            foreignText,
            'user',
            'owner',
          ),
        },
      ],
      observationGeneration: 'erase-gen-1',
    });
    const args = f.contextTool.inputSchema.parse({ anchors: [contextAnchor] });
    await expect(f.contextTool.execute(args, context)).rejects.toThrow(/malformed evidence/u);
  });

  it.each([undefined, 'semantic'])(
    'preserves the existing semantic-first behavior for mode=%s',
    async (mode) => {
      const f = fixture();
      const args = f.tool.inputSchema.parse({
        query: 'telescope preferences',
        ...(mode ? { mode } : {}),
      });
      const result = await f.tool.execute(args, context);
      expect(result).toMatchObject({ mode: 'semantic', matches: [{ text: match.text }] });
      expect(f.embed).toHaveBeenCalledExactlyOnceWith(['telescope preferences']);
      expect(f.repository.semantic).toHaveBeenCalledExactlyOnceWith({
        agentId: 'owner-a',
        currentConversationId: 'current-owned-thread',
        embedding: [1, 0],
        embeddingSpaceKey: 'a'.repeat(64),
        limit: 5,
      });
      expect(f.repository.text).not.toHaveBeenCalled();
    },
  );

  it('uses text fallback after an empty semantic result without changing identity or limits', async () => {
    const f = fixture();
    f.repository.semantic.mockResolvedValue([]);
    expect(
      await f.tool.execute(f.tool.inputSchema.parse({ query: 'Cobalt', limit: 7 }), context),
    ).toEqual({ matches: [match], mode: 'text' });
    expect(f.repository.text).toHaveBeenCalledExactlyOnceWith({
      agentId: 'owner-a',
      currentConversationId: 'current-owned-thread',
      query: 'Cobalt',
      limit: 7,
    });
  });

  it('fails closed when the text repository reports an active privacy erasure', async () => {
    const f = fixture();
    f.repository.text.mockRejectedValue(new Error('Privacy erasure is in progress'));
    await expect(
      f.tool.execute({ query: 'Cobalt', mode: 'text', limit: 20 }, context),
    ).rejects.toThrow('Privacy erasure is in progress');
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.repository.semantic).not.toHaveBeenCalled();
  });

  it('returns an empty literal result without silently broadening into semantic search', async () => {
    const f = fixture();
    f.repository.text.mockResolvedValue([]);
    expect(
      await f.tool.execute(
        { query: 'nonexistent named example', mode: 'text', limit: 20 },
        context,
      ),
    ).toEqual({ matches: [], mode: 'text' });
    expect(f.embed).not.toHaveBeenCalled();
  });

  it('rejects invalid modes and out-of-bound literal query inputs', () => {
    const f = fixture();
    for (const args of [
      { query: 'Cobalt', mode: 'raw' },
      { query: 'Cobalt', mode: 'text', limit: 21 },
      { query: 'x', mode: 'text' },
      { query: 'x'.repeat(501), mode: 'text' },
    ])
      expect(f.tool.inputSchema.safeParse(args).success).toBe(false);
  });
});

describe('literal mode through PostgreSQL owner and privacy boundaries', () => {
  let db: Db;
  const ownerId = randomUUID();
  const foreignId = randomUUID();
  const conversationIds: string[] = [];
  const messageIds: string[] = [];
  const cursorNames: [string, string] = [
    `privacy-erasure-generation:${ownerId}`,
    `privacy-erasure-result:${ownerId}`,
  ];
  const query = `named-Cobalt-${randomUUID()}`;
  const cutoff = new Date('2026-10-01T12:00:00Z');
  let ownedHistory = '';
  let ownedCurrent = '';
  let foreignCurrent = '';
  const embed = vi.fn(async () => {
    throw new Error('Literal mode must not request an embedding');
  });
  let tool: ReturnType<typeof fixture>['tool'];

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl || !new URL(databaseUrl).pathname.includes('_test'))
      throw new Error(
        'Run this privacy regression through pnpm test with an isolated test database.',
      );
    db = createDb(databaseUrl);
    await db.insert(agents).values(
      [ownerId, foreignId].map((id) => ({
        id,
        name: 'Literal search regression',
        email: `${id}@literal-search.invalid`,
        workspacePrefix: `literal-test/${id}`,
      })),
    );
    for (const agentId of [ownerId, ownerId, foreignId]) {
      const [conversation] = await db
        .insert(conversations)
        .values({
          agentId,
          channel: 'chat',
          trust: 'owner',
          title: 'Synthetic literal search fixture',
        })
        .returning({ id: conversations.id });
      if (!conversation) throw new Error('Missing conversation fixture');
      conversationIds.push(conversation.id);
    }
    [ownedHistory, ownedCurrent, foreignCurrent] = conversationIds as [string, string, string];
    const oldDate = new Date(cutoff.getTime() - 1000);
    const freshDate = new Date(cutoff.getTime() + 1000);
    const rows = [
      { conversationId: ownedHistory, text: `${query} visible old source`, createdAt: oldDate },
      { conversationId: ownedHistory, text: `${query} visible fresh source`, createdAt: freshDate },
      {
        conversationId: ownedHistory,
        text: `${query} hidden source`,
        createdAt: freshDate,
        hiddenAt: freshDate,
      },
      {
        conversationId: ownedHistory,
        text: `${query} visual fixture`,
        createdAt: freshDate,
        channelMessageId: `visual-qa:literal:${randomUUID()}`,
      },
      { conversationId: ownedCurrent, text: `${query} current owned source`, createdAt: oldDate },
      { conversationId: foreignCurrent, text: `${query} foreign source`, createdAt: freshDate },
    ];
    const inserted = await db
      .insert(messages)
      .values(
        rows.map((row) => ({
          ...row,
          role: 'user' as const,
          origin: 'owner' as const,
          parts: [],
          embedding: null,
          embeddingSpaceKey: null,
        })),
      )
      .returning({ id: messages.id });
    messageIds.push(...inserted.map((row) => row.id));
    const registry = registerPortableConversationSearchTool(new ToolRegistry(), {
      conversations: createPostgresConversationSearchRepository(db),
      embed,
    });
    const registered = registry.get('conversations.search')?.tool;
    if (!registered) throw new Error('Missing portable search tool');
    tool = registered;
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(maintenanceCursors).where(inArray(maintenanceCursors.name, cursorNames));
    if (messageIds.length) await db.delete(messages).where(inArray(messages.id, messageIds));
    if (conversationIds.length)
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    await db.delete(agents).where(inArray(agents.id, [ownerId, foreignId]));
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  });

  const search = (currentConversationId?: string) =>
    tool.execute({ query, mode: 'text', limit: 20 }, {
      agentId: ownerId,
      ...(currentConversationId ? { conversationId: currentConversationId } : {}),
    } as ToolContext) as Promise<{ mode: string; matches: ConversationSearchMatch[] }>;

  it('keeps literal hits owner-scoped and excludes hidden and visual-fixture rows even without embeddings', async () => {
    const result = await search();
    expect(result.mode).toBe('text');
    expect(result.matches.map((row) => row.text).sort()).toEqual(
      [
        `${query} visible old source`,
        `${query} visible fresh source`,
        `${query} current owned source`,
      ].sort(),
    );
    expect(
      result.matches.every(
        (row) =>
          row.role === 'user' &&
          row.origin === 'owner' &&
          /^[a-f0-9]{64}$/.test(row.sourceRevision),
      ),
    ).toBe(true);
    expect(embed).not.toHaveBeenCalled();
  });

  it('keeps the erasure cutoff and allows only the authenticated owned current thread to bypass it', async () => {
    await db
      .insert(maintenanceCursors)
      .values({ name: cursorNames[0], cursor: randomUUID(), updatedAt: cutoff });
    expect((await search()).matches.map((row) => row.text)).toEqual([
      `${query} visible fresh source`,
    ]);
    expect((await search(foreignCurrent)).matches.map((row) => row.text)).toEqual([
      `${query} visible fresh source`,
    ]);
    expect((await search(ownedCurrent)).matches.map((row) => row.text).sort()).toEqual(
      [`${query} visible fresh source`, `${query} current owned source`].sort(),
    );
  });

  it('fails closed during active erasure even when the query supplies the owned current conversation', async () => {
    await db.insert(maintenanceCursors).values({ name: cursorNames[1], cursor: '{}' });
    await expect(search(ownedCurrent)).rejects.toThrow('Privacy erasure is in progress');
    expect(embed).not.toHaveBeenCalled();
    await db.delete(maintenanceCursors).where(eq(maintenanceCursors.name, cursorNames[1]));
  });
});
