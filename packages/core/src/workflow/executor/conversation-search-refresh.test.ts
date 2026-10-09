import type { ConversationSearchRepository, ExecutionEvidenceRecord } from '@assistant/persistence';
import { conversationMessageSourceRevision } from '@assistant/persistence';
import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import {
  refreshConversationSearchEvidence,
  refreshResumedConversationSearch,
} from './conversation-search-refresh.js';

const ids = {
  message: '10000000-0000-4000-8000-000000000001',
  conversation: '20000000-0000-4000-8000-000000000002',
  task: '30000000-0000-4000-8000-000000000003',
};
const oldSourceText = 'Old private newsletter content';
const freshSourceText = 'Corrected newsletter content after reset';
const oldRevision = conversationMessageSourceRevision(ids.message, oldSourceText);
const freshRevision = conversationMessageSourceRevision(ids.message, freshSourceText);
const gmailCall = {
  type: 'tool-call',
  toolCallId: 'send-1',
  toolName: 'gmail.send',
  input: { to: ['owner@example.test'], subject: 'Approved', body: 'Exact approved copy' },
};
const gmailResult = {
  type: 'tool-result',
  toolCallId: 'send-1',
  toolName: 'gmail.send',
  output: { type: 'json', value: { deliveryStatus: 'accepted', providerMessageId: 'fake-1' } },
};

function originalWindow(): ModelMessage[] {
  return [
    { role: 'user', content: 'Find the prior newsletter and send this exact approved note.' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'search-1',
          toolName: 'conversations.search',
          input: { query: 'newsletter', limit: 5 },
        },
      ],
    } as ModelMessage,
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'search-1',
          toolName: 'conversations.search',
          output: {
            type: 'json',
            value: {
              mode: 'semantic',
              matches: [
                {
                  messageId: ids.message,
                  conversationId: ids.conversation,
                  sourceRevision: oldRevision,
                  text: oldSourceText,
                  createdAt: '2026-10-01T00:00:00.000Z',
                },
              ],
            },
          },
        },
      ],
    } as ModelMessage,
    { role: 'assistant', content: 'The old private newsletter said this.' },
    { role: 'assistant', content: [gmailCall] } as ModelMessage,
    { role: 'tool', content: [gmailResult] } as ModelMessage,
  ];
}

const match = {
  messageId: ids.message,
  conversationId: ids.conversation,
  sourceRevision: freshRevision,
  text: freshSourceText,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
};

function repository(unchangedSourceRefs: boolean[]): ConversationSearchRepository {
  return {
    semantic: vi.fn(async () => []),
    text: vi.fn(async () => []),
    refreshForResume: vi.fn(async () => ({
      unchangedSourceRefs,
      matches: [match],
      mode: 'text' as const,
      observationGeneration: 'generation-2',
    })),
  };
}

function searchResult(window: ModelMessage[], toolCallId: string): unknown {
  for (const message of window) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const candidate of message.content) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const part = candidate as Record<string, unknown>;
      if (
        part.type !== 'tool-result' ||
        part.toolName !== 'conversations.search' ||
        part.toolCallId !== toolCallId
      )
        continue;
      const output = part.output;
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        const value = output as Record<string, unknown>;
        if (value.type === 'json') return value.value;
      }
    }
  }
  return undefined;
}

function toolResultCount(window: ModelMessage[], toolCallId: string): number {
  return window.reduce((count, message) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) return count;
    return (
      count +
      message.content.filter((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
        const part = candidate as Record<string, unknown>;
        return part.type === 'tool-result' && part.toolCallId === toolCallId;
      }).length
    );
  }, 0);
}

const refreshedTextResult = {
  mode: 'text',
  matches: [
    {
      messageId: ids.message,
      conversationId: ids.conversation,
      sourceRevision: freshRevision,
      text: freshSourceText,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ],
};

describe('resumed conversations.search refresh', () => {
  it('replaces stale search evidence and derived assistant prose without changing approved effects', async () => {
    const window = originalWindow();
    const refresh = repository([false]);
    const approvedCallBefore = JSON.stringify(window[4]);
    const receiptBefore = JSON.stringify(window[5]);

    const result = await refreshResumedConversationSearch(window, {
      agentId: ids.task,
      currentConversationId: ids.conversation,
      repository: refresh,
    });

    expect(result).toEqual({
      changed: true,
      observationGeneration: 'generation-2',
      invalidatedToolCallIds: ['search-1'],
    });
    expect(refresh.refreshForResume).toHaveBeenCalledWith({
      agentId: ids.task,
      currentConversationId: ids.conversation,
      query: 'newsletter',
      limit: 5,
      sourceRefs: [
        { messageId: ids.message, conversationId: ids.conversation, sourceRevision: oldRevision },
      ],
    });
    const serialized = JSON.stringify(window);
    expect(serialized).toContain('Corrected newsletter content after reset');
    expect(serialized).not.toContain('Old private newsletter content');
    expect(serialized).not.toContain('The old private newsletter said this.');
    const approvedCallAfter = window.find(
      (message) =>
        message.role === 'assistant' &&
        Array.isArray(message.content) &&
        (message.content as unknown[]).some((part) => {
          const item = part as { type?: unknown; toolCallId?: unknown };
          return item.type === 'tool-call' && item.toolCallId === 'send-1';
        }),
    );
    const receiptAfter = window.find(
      (message) =>
        message.role === 'tool' &&
        Array.isArray(message.content) &&
        (message.content as unknown[]).some((part) => {
          const item = part as { type?: unknown; toolCallId?: unknown };
          return item.type === 'tool-result' && item.toolCallId === 'send-1';
        }),
    );
    expect(JSON.stringify(approvedCallAfter)).toBe(approvedCallBefore);
    expect(JSON.stringify(receiptAfter)).toBe(receiptBefore);
    expect(refresh.semantic).not.toHaveBeenCalled();
    expect(refresh.text).not.toHaveBeenCalled();
  });

  it('discards legacy cached refs and refreshes only the validated bounded text query', async () => {
    const window = originalWindow();
    const resultMessage = window[2] as { role: string; content: Array<Record<string, unknown>> };
    resultMessage.content[0] = {
      type: 'tool-result',
      toolCallId: 'search-1',
      toolName: 'conversations.search',
      output: {
        type: 'json',
        value: { mode: 'semantic', matches: [{ text: 'LEGACY PRIVATE BYTES' }] },
      },
    };
    const refresh = repository([]);

    await refreshResumedConversationSearch(window, {
      agentId: ids.task,
      currentConversationId: ids.conversation,
      repository: refresh,
    });

    const serialized = JSON.stringify(window);
    expect(serialized).not.toContain('LEGACY PRIVATE BYTES');
    expect(serialized).not.toContain('The old private newsletter said this.');
    expect(searchResult(window, 'search-1')).toEqual(refreshedTextResult);
    expect(refresh.refreshForResume).toHaveBeenCalledWith({
      agentId: ids.task,
      currentConversationId: ids.conversation,
      query: 'newsletter',
      limit: 5,
      sourceRefs: [],
    });
    expect(serialized).toContain('Exact approved copy');
  });

  it('rejects unknown cached fields and replaces them only with a bounded fresh text result', async () => {
    for (const scope of ['outer', 'match'] as const) {
      const window = originalWindow();
      const resultMessage = window[2] as { role: string; content: Array<Record<string, unknown>> };
      const part = resultMessage.content[0] as Record<string, unknown>;
      const output = part.output as { type: string; value: Record<string, unknown> };
      if (scope === 'outer') {
        output.value.secretExtension = 'UNVERSIONED PRIVATE BYTES';
      } else {
        const matches = output.value.matches as Array<Record<string, unknown>>;
        matches[0] = { ...(matches[0] ?? {}), secretExtension: 'UNVERSIONED PRIVATE BYTES' };
      }
      const refresh = repository([]);

      await refreshResumedConversationSearch(window, {
        agentId: ids.task,
        currentConversationId: ids.conversation,
        repository: refresh,
      });

      const serialized = JSON.stringify(window);
      expect(serialized).not.toContain('UNVERSIONED PRIVATE BYTES');
      expect(serialized).not.toContain('Old private newsletter content');
      expect(serialized).not.toContain('The old private newsletter said this.');
      expect(searchResult(window, 'search-1')).toEqual(refreshedTextResult);
      expect(refresh.refreshForResume).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'newsletter',
          limit: 5,
          sourceRefs: [],
        }),
      );
    }
  });

  it('rejects malformed allowed timestamp and similarity metadata before fresh text lookup', async () => {
    for (const malformed of ['createdAt', 'similarity'] as const) {
      const window = originalWindow();
      const resultMessage = window[2] as { role: string; content: Array<Record<string, unknown>> };
      const part = resultMessage.content[0] as Record<string, unknown>;
      const output = part.output as {
        type: string;
        value: { matches: Array<Record<string, unknown>> };
      };
      const savedMatch = output.value.matches[0] ?? {};
      output.value.matches[0] =
        malformed === 'createdAt'
          ? { ...savedMatch, createdAt: '2026-02-30T00:00:00.000Z' }
          : { ...savedMatch, similarity: Number.POSITIVE_INFINITY };
      const refresh = repository([]);

      await refreshResumedConversationSearch(window, {
        agentId: ids.task,
        currentConversationId: ids.conversation,
        repository: refresh,
      });

      expect(refresh.refreshForResume).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'newsletter',
          limit: 5,
          sourceRefs: [],
        }),
      );
      expect(searchResult(window, 'search-1')).toEqual(refreshedTextResult);
      expect(JSON.stringify(window)).not.toContain('Old private newsletter content');
      expect(JSON.stringify(window)).not.toContain('The old private newsletter said this.');
    }
  });

  it('returns unavailable when there is no valid query or the bounded refresh cannot run', async () => {
    const missingRepository = originalWindow();
    await refreshResumedConversationSearch(missingRepository, { agentId: ids.task });
    expect(searchResult(missingRepository, 'search-1')).toMatchObject({
      mode: 'unavailable',
      matches: [],
    });
    expect(JSON.stringify(missingRepository)).not.toContain('Old private newsletter content');
    expect(JSON.stringify(missingRepository)).not.toContain(
      'The old private newsletter said this.',
    );

    const invalidQuery = originalWindow();
    const call = invalidQuery[1] as { role: string; content: Array<Record<string, unknown>> };
    const searchCall = call.content[0] as Record<string, unknown>;
    searchCall.input = { query: 'x', limit: 5 };
    const invalidQueryRepository = repository([]);
    await refreshResumedConversationSearch(invalidQuery, {
      agentId: ids.task,
      repository: invalidQueryRepository,
    });
    expect(invalidQueryRepository.refreshForResume).not.toHaveBeenCalled();
    expect(searchResult(invalidQuery, 'search-1')).toMatchObject({
      mode: 'unavailable',
      matches: [],
    });
    expect(JSON.stringify(invalidQuery)).not.toContain('Old private newsletter content');

    const rejectedRefresh = originalWindow();
    const rejectingRepository = repository([]);
    vi.mocked(rejectingRepository.refreshForResume).mockRejectedValue(new Error('fixture failure'));
    await refreshResumedConversationSearch(rejectedRefresh, {
      agentId: ids.task,
      repository: rejectingRepository,
    });
    expect(searchResult(rejectedRefresh, 'search-1')).toMatchObject({
      mode: 'unavailable',
      matches: [],
    });
    expect(JSON.stringify(rejectedRefresh)).not.toContain('Old private newsletter content');
    expect(JSON.stringify(rejectedRefresh)).not.toContain('The old private newsletter said this.');
  });

  it('scrubs a read_result chunk linked by the search result paging receipt', async () => {
    const window = originalWindow();
    const searchResult = window[2] as { role: string; content: Array<Record<string, unknown>> };
    searchResult.content[0] = {
      type: 'tool-result',
      toolCallId: 'search-1',
      toolName: 'conversations.search',
      output: {
        type: 'json',
        value: {
          truncated: true,
          note: 'result truncated; read more with tools.read_result({ toolCallId: "durable-search-1", offset: 8000 })',
          preview: 'Old private preview',
        },
      },
    };
    window.splice(
      3,
      0,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'read-1',
            toolName: 'tools.read_result',
            input: { toolCallId: 'durable-search-1', offset: 8000 },
          },
        ],
      } as ModelMessage,
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'read-1',
            toolName: 'tools.read_result',
            output: { type: 'json', value: { text: 'Old private durable result bytes' } },
          },
        ],
      } as ModelMessage,
    );
    const refresh = repository([]);

    await refreshResumedConversationSearch(window, {
      agentId: ids.task,
      currentConversationId: ids.conversation,
      repository: refresh,
    });

    const serialized = JSON.stringify(window);
    expect(serialized).not.toContain('Old private preview');
    expect(serialized).not.toContain('Old private durable result bytes');
    expect(serialized).toContain('durable-search-1');
    expect(serialized).toContain('Exact approved copy');
  });

  it('fails every search closed when an observed null generation changes between pairs', async () => {
    const window: ModelMessage[] = [
      { role: 'user', content: 'Find both newsletters.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'search-1',
            toolName: 'conversations.search',
            input: { query: 'newsletter' },
          },
          {
            type: 'tool-call',
            toolCallId: 'search-2',
            toolName: 'conversations.search',
            input: { query: 'newsletter' },
          },
        ],
      } as ModelMessage,
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'search-1',
            toolName: 'conversations.search',
            output: {
              type: 'json',
              value: {
                mode: 'semantic',
                matches: [
                  {
                    messageId: ids.message,
                    conversationId: ids.conversation,
                    sourceRevision: oldRevision,
                    text: oldSourceText,
                    createdAt: '2026-10-01T00:00:00.000Z',
                  },
                ],
              },
            },
          },
          {
            type: 'tool-result',
            toolCallId: 'search-2',
            toolName: 'conversations.search',
            output: {
              type: 'json',
              value: {
                mode: 'semantic',
                matches: [
                  {
                    messageId: ids.message,
                    conversationId: ids.conversation,
                    sourceRevision: oldRevision,
                    text: oldSourceText,
                    createdAt: '2026-10-01T00:00:00.000Z',
                  },
                ],
              },
            },
          },
        ],
      } as ModelMessage,
      { role: 'assistant', content: 'Old private newsletter content appeared here.' },
    ];
    const refresh = {
      semantic: vi.fn(async () => []),
      text: vi.fn(async () => []),
      refreshForResume: vi
        .fn()
        .mockResolvedValueOnce({
          unchangedSourceRefs: [true],
          matches: [match],
          mode: 'text',
          observationGeneration: null,
        })
        .mockResolvedValueOnce({
          unchangedSourceRefs: [true],
          matches: [match],
          mode: 'text',
          observationGeneration: 'new-generation',
        }),
    } as unknown as ConversationSearchRepository;

    const result = await refreshResumedConversationSearch(window, {
      agentId: ids.task,
      currentConversationId: ids.conversation,
      repository: refresh,
    });

    expect(result.observationGeneration).toBeNull();
    expect(result.invalidatedToolCallIds).toEqual(['search-1', 'search-2']);
    const serialized = JSON.stringify(window);
    expect(serialized).not.toContain('Old private newsletter content');
    expect(serialized.match(/Conversation history could not be refreshed\./gu)).toHaveLength(2);
    expect(toolResultCount(window, 'search-1')).toBe(1);
    expect(toolResultCount(window, 'search-2')).toBe(1);
  });

  it('accepts a stable null erasure generation across multiple searches', async () => {
    const window = originalWindow();
    const assistant = window[1] as { role: string; content: Array<Record<string, unknown>> };
    assistant.content.push({
      type: 'tool-call',
      toolCallId: 'search-2',
      toolName: 'conversations.search',
      input: { query: 'newsletter' },
    });
    const tool = window[2] as { role: string; content: Array<Record<string, unknown>> };
    tool.content.push({
      type: 'tool-result',
      toolCallId: 'search-2',
      toolName: 'conversations.search',
      output: {
        type: 'json',
        value: {
          mode: 'semantic',
          matches: [
            {
              messageId: ids.message,
              conversationId: ids.conversation,
              sourceRevision: oldRevision,
              text: oldSourceText,
              createdAt: '2026-10-01T00:00:00.000Z',
            },
          ],
        },
      },
    });
    const sameSource = {
      messageId: ids.message,
      conversationId: ids.conversation,
      sourceRevision: oldRevision,
      text: oldSourceText,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
    };
    const refresh = {
      semantic: vi.fn(async () => []),
      text: vi.fn(async () => []),
      refreshForResume: vi
        .fn()
        .mockResolvedValueOnce({
          unchangedSourceRefs: [true],
          matches: [sameSource],
          mode: 'text',
          observationGeneration: null,
        })
        .mockResolvedValueOnce({
          unchangedSourceRefs: [true],
          matches: [sameSource],
          mode: 'text',
          observationGeneration: null,
        }),
    } as unknown as ConversationSearchRepository;

    const result = await refreshResumedConversationSearch(window, {
      agentId: ids.task,
      currentConversationId: ids.conversation,
      repository: refresh,
    });

    expect(result).toEqual({
      changed: true,
      observationGeneration: null,
      invalidatedToolCallIds: [],
    });
    const serialized = JSON.stringify(window);
    expect(serialized).toContain('Old private newsletter content');
    expect(serialized.match(/"mode":"text"/gu)).toHaveLength(2);
  });

  it('rejects source text whose bytes do not match the stored revision and refreshes by validated query', async () => {
    const window = originalWindow();
    const resultMessage = window[2] as { role: string; content: Array<Record<string, unknown>> };
    const resultPart = resultMessage.content[0] as Record<string, unknown>;
    const output = resultPart.output as {
      type: string;
      value: { matches: Array<Record<string, unknown>> };
    };
    output.value.matches[0] = {
      messageId: ids.message,
      conversationId: ids.conversation,
      sourceRevision: oldRevision,
      text: 'altered private bytes',
    };
    const refresh = repository([]);

    await refreshResumedConversationSearch(window, {
      agentId: ids.task,
      currentConversationId: ids.conversation,
      repository: refresh,
    });

    expect(refresh.refreshForResume).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRefs: [] }),
    );
    expect(JSON.stringify(window)).not.toContain('altered private bytes');
    expect(JSON.stringify(window)).not.toContain('The old private newsletter said this.');
    expect(searchResult(window, 'search-1')).toEqual(refreshedTextResult);
  });

  it('scrubs orphaned search results and linked read chunks in the same tool message', async () => {
    const window: ModelMessage[] = [
      { role: 'user', content: 'Find the old newsletter.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'read-1',
            toolName: 'tools.read_result',
            input: { toolCallId: 'durable-search-1', offset: 0 },
          },
        ],
      } as ModelMessage,
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'orphan-search',
            toolName: 'conversations.search',
            output: {
              type: 'json',
              value: {
                truncated: true,
                note: 'read with tools.read_result({ toolCallId: "durable-search-1", offset: 0 })',
                preview: 'ORPHAN PRIVATE SEARCH BYTES',
              },
            },
          },
          {
            type: 'tool-result',
            toolCallId: 'read-1',
            toolName: 'tools.read_result',
            output: { type: 'json', value: { text: 'ORPHAN PRIVATE READ BYTES' } },
          },
        ],
      } as ModelMessage,
      { role: 'assistant', content: 'Orphan search prose must be removed.' },
    ];

    const result = await refreshResumedConversationSearch(window, {
      agentId: ids.task,
      repository: repository([]),
    });
    const serialized = JSON.stringify(window);
    expect(result.changed).toBe(true);
    expect(result.invalidatedToolCallIds).toEqual(['orphan-search']);
    expect(serialized).not.toContain('ORPHAN PRIVATE SEARCH BYTES');
    expect(serialized).not.toContain('ORPHAN PRIVATE READ BYTES');
    expect(serialized).not.toContain('Orphan search prose must be removed.');
    expect(serialized).toContain('Conversation history could not be refreshed.');
  });

  it('scrubs search results without a usable call ID while preserving paired results and effects', async () => {
    for (const malformedId of [undefined, 42]) {
      const window = originalWindow();
      const searchMessage = window[2] as { role: string; content: Array<Record<string, unknown>> };
      searchMessage.content.push({
        type: 'tool-result',
        toolName: 'conversations.search',
        ...(malformedId === undefined ? {} : { toolCallId: malformedId }),
        output: {
          type: 'json',
          value: { mode: 'semantic', matches: [{ text: 'MALFORMED PRIVATE BYTES' }] },
        },
      });
      window.splice(
        3,
        0,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'read-malformed',
              toolName: 'tools.read_result',
              input: { toolCallId: 'unknown-parent', offset: 0 },
            },
          ],
        } as ModelMessage,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'read-malformed',
              toolName: 'tools.read_result',
              output: { type: 'json', value: { text: 'MALFORMED PRIVATE READ BYTES' } },
            },
          ],
        } as ModelMessage,
      );
      const refresh = repository([true]);

      const result = await refreshResumedConversationSearch(window, {
        agentId: ids.task,
        currentConversationId: ids.conversation,
        repository: refresh,
      });

      const serialized = JSON.stringify(window);
      expect(result.changed).toBe(true);
      expect(result.invalidatedToolCallIds).toEqual([]);
      expect(serialized).not.toContain('MALFORMED PRIVATE BYTES');
      expect(serialized).not.toContain('MALFORMED PRIVATE READ BYTES');
      expect(serialized).not.toContain('The old private newsletter said this.');
      expect(serialized).toContain('Exact approved copy');
      expect(toolResultCount(window, 'search-1')).toBe(1);
      expect(serialized).toContain('Conversation history could not be refreshed.');
    }
  });

  it('refreshes verifier evidence without rewriting immutable tool/effect rows', async () => {
    const searchId = '40000000-0000-4000-8000-000000000004';
    const readId = '50000000-0000-4000-8000-000000000005';
    const gmailId = '60000000-0000-4000-8000-000000000006';
    const durableRows = [
      {
        id: searchId,
        toolName: 'conversations.search',
        status: 'succeeded',
        args: { query: 'newsletter', limit: 5 },
        result: {
          mode: 'semantic',
          matches: [
            {
              messageId: ids.message,
              conversationId: ids.conversation,
              sourceRevision: oldRevision,
              text: oldSourceText,
              createdAt: '2026-10-01T00:00:00.000Z',
            },
          ],
        },
        error: null,
        step: 1,
      },
      {
        id: readId,
        toolName: 'tools.read_result',
        status: 'succeeded',
        args: { toolCallId: searchId, offset: 100 },
        result: { text: 'OLD PAGED PRIVATE BYTES' },
        error: null,
        step: 2,
      },
      {
        id: gmailId,
        toolName: 'gmail.send',
        status: 'succeeded',
        args: { to: ['owner@example.test'], body: 'Exact approved copy' },
        result: { deliveryStatus: 'accepted', providerMessageId: 'fake-1' },
        error: null,
        step: 3,
      },
    ] as ExecutionEvidenceRecord[];
    const before = JSON.stringify(durableRows);
    const refresh = repository([false]);

    const safe = await refreshConversationSearchEvidence(durableRows, {
      agentId: ids.task,
      currentConversationId: ids.conversation,
      repository: refresh,
    });

    expect(safe.invalidatedSearchCallIds).toEqual(new Set([searchId]));
    expect(JSON.stringify(safe.rows)).toContain('Corrected newsletter content after reset');
    expect(JSON.stringify(safe.rows)).not.toContain('OLD PAGED PRIVATE BYTES');
    expect(safe.rows.find((row) => row.id === readId)?.result).toMatchObject({
      mode: 'unavailable',
    });
    expect(safe.rows.find((row) => row.id === gmailId)).toMatchObject({
      args: { body: 'Exact approved copy' },
      result: { deliveryStatus: 'accepted', providerMessageId: 'fake-1' },
    });
    expect(JSON.stringify(durableRows)).toBe(before);
  });

  it('does nothing when a context has no completed conversation search call', async () => {
    const window: ModelMessage[] = [{ role: 'user', content: 'Ordinary owner request' }];
    const refresh = repository([]);
    await expect(
      refreshResumedConversationSearch(window, { agentId: ids.task, repository: refresh }),
    ).resolves.toEqual({ changed: false, observationGeneration: null, invalidatedToolCallIds: [] });
    expect(refresh.refreshForResume).not.toHaveBeenCalled();
  });
});
