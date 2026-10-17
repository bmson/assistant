import { generateText, type ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigForTest } from '../../config.js';
import { TaskStateSchema } from '../../events.js';
import { preparePlanningRecall, type RunContext } from './phases.js';
import { compact, replaceToolResultMessage, toolResultMessage } from './util.js';

const stubs = vi.hoisted(() => ({ recall: vi.fn() }));
vi.mock('../../memory/recall-context.js', () => ({ retrieveOwnerContext: stubs.recall }));
vi.mock('../../memory/recall-metrics.js', () => ({ recordRecallMetric: async () => {} }));

afterEach(() => {
  vi.restoreAllMocks();
  stubs.recall.mockReset();
  resetConfigForTest();
});

function batchWindow(): ModelMessage[] {
  return [
    { role: 'user', content: 'Please email the project agenda to recipient@example.test.' },
    { role: 'system', content: '[[assistant:owner-context-recall:v1]]\nobsolete reference' },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'call-a', toolName: 'contacts.lookup', input: {} },
        { type: 'tool-call', toolCallId: 'call-b', toolName: 'gmail.send', input: {} },
      ],
    },
    toolResultMessage('call-a', 'contacts.lookup', { contacts: [] }),
  ];
}

async function expectValidPrompt(window: ModelMessage[]) {
  const model = new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text: 'Synthetic response.' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
  // Match the router's SDK opt-in for runtime-owned system context. The real
  // SDK validates pairing before this in-memory provider can run.
  const result = await generateText({
    model,
    messages: window,
    allowSystemInMessages: true,
    maxRetries: 0,
  });
  expect(result.text).toBe('Synthetic response.');
  expect(model.doGenerateCalls).toHaveLength(1);
}

describe('tool-result ordering across resumed context', () => {
  it.each(['available', 'unavailable'] as const)(
    'keeps a resumed batch paired after %s planning recall refresh',
    async (availability) => {
      loadConfig({ CHAT_RECALL_ENABLED: 'true', GRAPH_RAG_ENABLED: 'false' });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      if (availability === 'unavailable') {
        stubs.recall.mockRejectedValue(new Error('synthetic recall failure'));
      } else {
        stubs.recall.mockResolvedValue({
          sources: [],
          block: 'Current synthetic reference.',
          situationDecisionStatus: 'complete',
          situationDecisions: [],
          historyFailed: false,
          graphFailed: false,
          discussionFrame: { bytes: 20, currentTurnComplete: true, coverage: {}, omittedTurns: 0 },
          graph: { candidates: 0, used: 0 },
          history: { tier: 'none', used: 0, sources: [] },
        });
      }
      const window = batchWindow();
      const state = TaskStateSchema.parse({
        step: 1,
        contextWindow: window,
        pendingToolBatch: {
          step: 1,
          modelId: 'synthetic',
          calls: [
            { toolCallId: 'call-a', toolName: 'contacts.lookup', input: {}, status: 'settled' },
            { toolCallId: 'call-b', toolName: 'gmail.send', input: {}, status: 'budget' },
          ],
        },
      });
      const checkpoint = vi.fn(async () => true);
      const context = {
        deps: { persistence: { tasks: { kind: 'task-lease-repository', checkpoint } } },
        db: {},
        router: {},
        task: {
          id: 'synthetic-task',
          agentId: 'synthetic-owner',
          conversationId: 'synthetic-conversation',
          trust: 'owner',
          type: 'chat_turn',
          trigger: { source: 'chat', payload: { text: window[0]?.content } },
        },
        agent: { id: 'synthetic-owner' },
        state,
        ctx: {},
        window,
      } as unknown as RunContext;

      expect(await preparePlanningRecall(context)).toBe(true);
      expect(stubs.recall).toHaveBeenCalledOnce();
      expect(checkpoint).toHaveBeenCalled();
      expect(JSON.stringify(window)).not.toContain('obsolete reference');
      expect(window.at(-1)?.role).toBe('system');
      expect(window.at(-1)?.content).toContain(
        availability === 'available' ? 'Current synthetic reference.' : 'retrieval was unavailable',
      );

      // Resume the remaining journaled call without generating another batch.
      replaceToolResultMessage(
        window,
        'call-b',
        'gmail.send',
        { sent: true },
        {
          dbToolCallId: 'durable-call-b',
        },
      );
      await expectValidPrompt(window);
      expect(window.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
        'system',
      ]);
      expect(state.untrustedContext).toBe(false);
    },
  );

  it('repairs a saved result after an owner reply without moving a later exchange', async () => {
    const window = batchWindow();
    const ownerReply: ModelMessage = { role: 'user', content: 'Please summarize the outcome.' };
    const laterExchange: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-c', toolName: 'memory.search', input: {} },
        ],
      },
      toolResultMessage('call-c', 'memory.search', { matches: [] }),
    ];
    window.push(
      ownerReply,
      toolResultMessage('call-b', 'gmail.send', { pending: true }),
      ...laterExchange,
    );

    replaceToolResultMessage(window, 'call-b', 'gmail.send', { sent: true });

    await expectValidPrompt(window);
    expect(window.slice(-2)).toEqual(laterExchange);
    const resultIndex = window.findIndex((message) =>
      JSON.stringify(message).includes('"sent":true'),
    );
    expect(resultIndex).toBeLessThan(window.indexOf(ownerReply));
    expect(JSON.stringify(window)).not.toContain('"pending":true');
  });

  it('retains shared-result siblings while two pending calls settle across compaction', async () => {
    const window = batchWindow();
    const assistant = window[2];
    if (assistant?.role !== 'assistant' || !Array.isArray(assistant.content))
      throw new Error('Missing synthetic batch');
    assistant.content.push({
      type: 'tool-call',
      toolCallId: 'call-d',
      toolName: 'memory.search',
      input: {},
    });
    const sibling = window.pop();
    const provisional = toolResultMessage('call-b', 'gmail.send', { pending: true });
    if (sibling?.role !== 'tool' || provisional.role !== 'tool')
      throw new Error('Missing synthetic results');
    window.push(
      { role: 'tool', content: [...sibling.content, ...provisional.content] },
      { role: 'system', content: 'Refreshed synthetic reference.' },
      { role: 'user', content: 'Include a short summary.' },
    );
    window.unshift(
      ...Array.from(
        { length: 65 },
        (_, index): ModelMessage => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `Synthetic earlier message ${index}.`,
        }),
      ),
    );

    replaceToolResultMessage(window, 'call-b', 'gmail.send', { sent: true });
    replaceToolResultMessage(window, 'call-d', 'memory.search', { matches: [] });

    const compacted = compact(window);
    expect(compacted.length).toBeLessThan(window.length);
    const resultIds = compacted.flatMap((message) =>
      message.role === 'tool'
        ? message.content.flatMap((part) => (part.type === 'tool-result' ? [part.toolCallId] : []))
        : [],
    );
    expect(resultIds).toEqual(['call-a', 'call-b', 'call-d']);
    expect(JSON.stringify(compacted)).not.toContain('"pending":true');
    await expectValidPrompt(compacted);
  });
});
