import { randomUUID } from 'node:crypto';
import type {
  ConversationSearchRepository,
  Records,
  ToolExecutionRepository,
} from '@assistant/persistence';
import { conversationMessageSourceRevision } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { registerBuiltinTools } from './index.js';
import { registerPortableReadResultTool } from './read-result.js';

const AGENT = randomUUID();
const TASK = randomUUID();
const CONVERSATION = randomUUID();
const SEARCH_CALL = randomUUID();
const SOURCE = randomUUID();
const BODY = `Current source: ${'safe text '.repeat(3_500)}`;
const REVISION = conversationMessageSourceRevision(SOURCE, BODY);

function storedCall(overrides: Record<string, unknown> = {}) {
  return {
    id: SEARCH_CALL,
    taskId: TASK,
    toolName: 'conversations.search',
    status: 'succeeded',
    args: { query: 'source result', limit: 5 },
    result: {
      mode: 'semantic',
      matches: [
        {
          messageId: SOURCE,
          conversationId: CONVERSATION,
          sourceRevision: REVISION,
          text: BODY,
          createdAt: '2026-10-01T10:00:00.000Z',
          similarity: 0.91,
        },
      ],
    },
    ...overrides,
  } as unknown as Records['toolCalls'];
}

function harness(options: {
  call?: Records['toolCalls'] | null;
  conversations?: Pick<ConversationSearchRepository, 'refreshForResume'>;
}) {
  const load = vi.fn(async () =>
    options.call ? { toolCall: options.call, task: {} as Records['tasks'], approval: null } : null,
  );
  const registry = new ToolRegistry();
  registerPortableReadResultTool(registry, {
    toolExecution: { load } as Pick<ToolExecutionRepository, 'load'>,
    ...(options.conversations ? { conversations: options.conversations } : {}),
  });
  const tool = registry.get('tools.read_result')?.tool;
  if (!tool) throw new Error('tools.read_result was not registered');
  return {
    load,
    tool,
    run: (offset = 0) =>
      tool.execute({ toolCallId: SEARCH_CALL, offset }, {
        agentId: AGENT,
        taskId: TASK,
        conversationId: CONVERSATION,
        trust: 'owner',
        tainted: false,
        now: () => new Date('2026-10-07T12:00:00.000Z'),
        signal: new AbortController().signal,
        log: async () => {},
      } as never) as Promise<Record<string, unknown>>,
  };
}

function freshRepository(unchanged = true) {
  const refreshForResume = vi.fn(async () => ({
    unchangedSourceRefs: [unchanged],
    mode: 'text' as const,
    observationGeneration: 'generation-7',
    matches: unchanged
      ? [
          {
            messageId: SOURCE,
            conversationId: CONVERSATION,
            sourceRevision: REVISION,
            text: BODY,
            createdAt: new Date('2026-10-01T10:00:00.000Z'),
          },
        ]
      : [],
  }));
  return { semantic: vi.fn(async () => []), text: vi.fn(async () => []), refreshForResume };
}

describe('read_result conversation-search privacy fence', () => {
  it('applies the same stale-source refusal to the PostgreSQL built-in reader', async () => {
    const call = storedCall();
    const row = {
      taskId: TASK,
      toolName: call.toolName,
      args: call.args,
      status: call.status,
      result: call.result,
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(async () => [row]) })),
      })),
    };
    const conversations = freshRepository(false);
    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [],
      embedWithIdentity: async () => ({ embeddings: [], embeddingSpaceKey: 'a'.repeat(64) }),
      conversations,
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
    });
    const tool = registry.get('tools.read_result')?.tool;
    if (!tool) throw new Error('tools.read_result was not registered');
    const page = (await tool.execute({ toolCallId: SEARCH_CALL, offset: 0 }, {
      agentId: AGENT,
      taskId: TASK,
      conversationId: CONVERSATION,
      trust: 'owner',
      tainted: false,
      db,
      now: () => new Date('2026-10-07T12:00:00.000Z'),
      signal: new AbortController().signal,
      log: async () => {},
    } as never)) as Record<string, unknown>;
    expect(page).toMatchObject({ error: expect.stringContaining('changed') });
    expect(JSON.stringify(page)).not.toContain(BODY);
    expect(conversations.refreshForResume).toHaveBeenCalledTimes(1);
  });

  it('keeps normal paging for an unchanged oversized semantic result and validates the next page too', async () => {
    const conversations = freshRepository();
    const dateResult = structuredClone(storedCall().result) as Record<string, unknown>;
    const dateMatches = dateResult.matches as Array<Record<string, unknown>>;
    dateMatches[0]!.createdAt = new Date('2026-10-01T10:00:00.000Z');
    const { run } = harness({
      call: storedCall({ result: dateResult }) as Records['toolCalls'],
      conversations,
    });
    const expected = JSON.stringify(dateResult);
    const first = await run();
    expect(first).toMatchObject({ offset: 0, hasMore: true });
    expect(first.totalChars).toBe(expected.length);
    expect(first.chunk).toBe(expected.slice(0, 30_000));
    const second = await run(30_000);
    expect(second).toMatchObject({ offset: 30_000 });
    expect(conversations.refreshForResume).toHaveBeenCalledTimes(2);
    expect(conversations.refreshForResume).toHaveBeenCalledWith({
      agentId: AGENT,
      currentConversationId: CONVERSATION,
      query: 'source result',
      limit: 5,
      sourceRefs: [{ messageId: SOURCE, conversationId: CONVERSATION, sourceRevision: REVISION }],
    });
  });

  it('rejects an aggregate search payload above the pre-hash text budget', async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    const firstText = 'é'.repeat(35_000);
    const secondText = 'ø'.repeat(35_000);
    const tooMuchText = firstText + secondText;
    const body = {
      ...storedCall(),
      result: {
        mode: 'text',
        matches: [
          {
            messageId: firstId,
            conversationId: CONVERSATION,
            sourceRevision: conversationMessageSourceRevision(firstId, firstText),
            text: firstText,
            createdAt: '2026-10-01T10:00:00.000Z',
          },
          {
            messageId: secondId,
            conversationId: CONVERSATION,
            sourceRevision: conversationMessageSourceRevision(secondId, secondText),
            text: secondText,
            createdAt: '2026-10-01T10:00:00.000Z',
          },
        ],
      },
    } as unknown as Records['toolCalls'];
    const conversations = freshRepository();
    const { run } = harness({ call: body, conversations });
    const page = await run();
    expect(page).toEqual({
      error:
        'This stored conversation search is unavailable. Run a fresh conversations.search before using its results.',
    });
    expect(conversations.refreshForResume).not.toHaveBeenCalled();
    expect(JSON.stringify(page)).not.toContain(tooMuchText);
  });

  it.each([
    ['outer result', { privatePayload: 'stale private text' }],
    ['match', { privatePayload: 'stale private text' }],
  ])(
    'rejects unknown persisted %s fields instead of paging unbound bytes',
    async (where, extra) => {
      const original = storedCall();
      const result = structuredClone(original.result) as Record<string, unknown>;
      if (where === 'outer result') Object.assign(result, extra);
      else {
        const matches = result.matches as Array<Record<string, unknown>>;
        const firstMatch = matches[0];
        if (!firstMatch) throw new Error('Stored search fixture is missing its first match');
        Object.assign(firstMatch, extra);
      }
      const conversations = freshRepository();
      const { run } = harness({
        call: storedCall({ result }) as Records['toolCalls'],
        conversations,
      });
      const page = await run();
      expect(page).toEqual({
        error:
          'This stored conversation search is unavailable. Run a fresh conversations.search before using its results.',
      });
      expect(conversations.refreshForResume).not.toHaveBeenCalled();
      expect(JSON.stringify(page)).not.toContain('stale private text');
    },
  );

  it.each([
    [
      'object-valued createdAt',
      (match: Record<string, unknown>) => {
        match.createdAt = { note: 'stale private bytes' };
      },
    ],
    [
      'non-numeric similarity',
      (match: Record<string, unknown>) => {
        match.similarity = '0.91';
      },
    ],
    [
      'object-valued similarity',
      (match: Record<string, unknown>) => {
        match.similarity = { note: 'stale private bytes' };
      },
    ],
    [
      'non-canonical date',
      (match: Record<string, unknown>) => {
        match.createdAt = 'October 1, 2026';
      },
    ],
  ])('rejects malformed allowed metadata: %s', async (_label, mutate) => {
    const result = structuredClone(storedCall().result) as Record<string, unknown>;
    const matches = result.matches as Array<Record<string, unknown>>;
    mutate(matches[0]!);
    const conversations = freshRepository();
    const { run } = harness({
      call: storedCall({ result }) as Records['toolCalls'],
      conversations,
    });
    const page = await run();
    expect(page).toEqual({
      error:
        'This stored conversation search is unavailable. Run a fresh conversations.search before using its results.',
    });
    expect(conversations.refreshForResume).not.toHaveBeenCalled();
    expect(JSON.stringify(page)).not.toContain('stale private bytes');
  });

  it('uses the persisted query and schema default limit when the call omitted limit', async () => {
    const conversations = freshRepository();
    const { run } = harness({
      call: storedCall({ args: { query: 'source result' } }),
      conversations,
    });
    const page = await run();
    expect(page.offset).toBe(0);
    expect(conversations.refreshForResume).toHaveBeenCalledWith({
      agentId: AGENT,
      currentConversationId: CONVERSATION,
      query: 'source result',
      limit: 5,
      sourceRefs: [{ messageId: SOURCE, conversationId: CONVERSATION, sourceRevision: REVISION }],
    });
  });

  it.each(['corrected', 'hidden', 'erased'] as const)(
    'never returns old bytes after a source is %s',
    async () => {
      const conversations = freshRepository(false);
      const { run } = harness({ call: storedCall(), conversations });
      const page = await run();
      expect(page).toEqual({
        error:
          'This stored conversation search changed. Run a fresh conversations.search before using its results.',
      });
      expect(JSON.stringify(page)).not.toContain(BODY);
    },
  );

  it('fails closed when the active privacy observation fence is unavailable', async () => {
    const conversations = {
      refreshForResume: vi.fn(async () => {
        throw new Error('private adapter diagnostic');
      }),
    };
    const { run } = harness({ call: storedCall(), conversations });
    const page = await run();
    expect(page).toEqual({
      error:
        'This stored conversation search is unavailable. Run a fresh conversations.search before using its results.',
    });
    expect(JSON.stringify(page)).not.toContain('private adapter diagnostic');
    expect(JSON.stringify(page)).not.toContain(BODY);
  });

  it.each([
    ['missing adapter', storedCall(), undefined],
    ['legacy unbound call', storedCall({ args: undefined }), freshRepository()],
    [
      'too-short persisted query',
      storedCall({ args: { query: 'x', limit: 5 } }),
      freshRepository(),
    ],
    [
      'overlong persisted query',
      storedCall({ args: { query: 'x'.repeat(501), limit: 5 } }),
      freshRepository(),
    ],
    [
      'out-of-range persisted limit',
      storedCall({ args: { query: 'source result', limit: 21 } }),
      freshRepository(),
    ],
    [
      'malformed source revision',
      storedCall({ result: { mode: 'text', matches: [{ messageId: SOURCE }] } }),
      freshRepository(),
    ],
    [
      'malformed fence receipt',
      storedCall(),
      {
        refreshForResume: vi.fn(async () => ({
          unchangedSourceRefs: [true],
          mode: 'text',
          matches: [],
          observationGeneration: undefined,
        })),
      },
    ],
  ])('does not return search bytes for %s', async (_label, call, conversations) => {
    const { run } = harness({
      call: call as Records['toolCalls'],
      ...(conversations
        ? { conversations: conversations as Pick<ConversationSearchRepository, 'refreshForResume'> }
        : {}),
    });
    const page = await run();
    expect(page).toEqual({
      error:
        'This stored conversation search is unavailable. Run a fresh conversations.search before using its results.',
    });
    expect(JSON.stringify(page)).not.toContain(BODY);
  });

  it('returns no bytes for another owner or task and does not invoke freshness lookup', async () => {
    const conversations = freshRepository();
    const { run, load } = harness({ call: null, conversations });
    expect(await run()).toEqual({ error: 'no such tool call in this task' });
    expect(load).toHaveBeenCalledWith(AGENT, TASK, SEARCH_CALL);
    expect(conversations.refreshForResume).not.toHaveBeenCalled();
  });

  it('preserves ordinary effect-result paging without rewriting or mutating the receipt', async () => {
    const result = { providerReceipt: 'accepted', detail: 'x'.repeat(40_000) };
    const call = storedCall({
      toolName: 'gmail.send',
      args: { to: ['owner@example.test'] },
      result,
    });
    const conversations = freshRepository();
    const { run } = harness({ call, conversations });
    const page = await run();
    expect(page).toMatchObject({ offset: 0, hasMore: true });
    expect(page.totalChars).toBe(JSON.stringify(result).length);
    expect(page.chunk).toBe(JSON.stringify(result).slice(0, 30_000));
    expect(conversations.refreshForResume).not.toHaveBeenCalled();
    expect(call.result).toEqual(result);
  });
});
