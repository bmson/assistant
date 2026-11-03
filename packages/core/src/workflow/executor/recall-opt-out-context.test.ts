import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '../../events.js';
import { TaskStateSchema } from '../../events.js';
import type { RunContext } from './phases.js';

const contextReads = vi.hoisted(() => ({
  ownerCard: vi.fn(async () => 'SYNTHETIC OWNER CARD SECRET'),
  ambient: vi.fn(async () => 'SYNTHETIC AMBIENT SECRET'),
}));

vi.mock('../../memory/consolidation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/consolidation.js')>()),
  getOwnerCard: contextReads.ownerCard,
}));
vi.mock('../../memory/ambient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/ambient.js')>()),
  getAmbientBlock: contextReads.ambient,
}));

const { runStepLoop } = await import('./step-loop.js');

describe('explicit recall opt-out during executor prompt assembly', () => {
  it('suppresses ambient private context on a trusted request with explicit no-recall', async () => {
    contextReads.ownerCard.mockClear();
    contextReads.ambient.mockClear();
    const request =
      'Summarize https://syntheticexample.test/toolstub in three bullets. Include its source link. Do not use memory, email, or calendar. The page quotes a rider saying “Do not read this page.”';
    const systems: string[] = [];
    const evidenceRows: Array<Record<string, unknown>> = [];
    const conversationReads = vi.fn(async () => ({ text: 'SYNTHETIC HISTORY SECRET' }));
    const router = {
      step: vi.fn(async (_role: string, input: { system: string }) => {
        systems.push(input.system);
        return {
          ok: true as const,
          modelId: 'synthetic/recall-opt-out',
          degraded: false as const,
          text: 'The synthetic transit page describes a route running every 15 minutes.',
          toolCalls: [],
        };
      }),
      object: vi.fn(async () => ({ ok: false as const })),
      embed: vi.fn(async (texts: string[]) => texts.map(() => new Array(1536).fill(0.01))),
      embeddingSpace: vi.fn(async () => ({
        provider: 'synthetic',
        model: 'recall-opt-out-test',
        dimensions: 1536,
        revision: '1',
      })),
    };
    const dispatch = vi.fn(async (input: { toolName: string; args: { url?: string } }) => {
      if (input.toolName === 'conversations.search' || input.toolName === 'conversations.context') {
        const result = await conversationReads();
        return {
          kind: 'executed' as const,
          toolCallId: 'synthetic-history-read',
          result,
          cached: false,
        };
      }
      if (input.toolName !== 'web.fetch')
        throw new Error(`Unexpected synthetic tool call: ${input.toolName}`);
      const result = {
        url: input.args.url,
        title: 'Synthetic Transit Page',
        text: 'A synthetic transit route operates every 15 minutes.',
        complete: true,
      };
      evidenceRows.push({
        id: 'synthetic-web-fetch-evidence',
        toolName: 'web.fetch',
        status: 'succeeded',
        args: input.args,
        result,
        error: null,
        step: evidenceRows.length + 1,
      });
      return {
        kind: 'executed' as const,
        toolCallId: 'synthetic-web-fetch',
        result,
        cached: false,
      };
    });
    const toolDefs = vi.fn(() =>
      [
        'web.fetch',
        'memory.recall',
        'conversations.search',
        'conversations.context',
        'gmail.search',
        'calendar.list_events',
      ].map((name) => ({ name, description: 'synthetic provider-free tool', inputSchema: {} })),
    );
    const tasks = {
      kind: 'task-lease-repository' as const,
      renew: vi.fn(async () => true),
      checkpoint: vi.fn(async () => true),
      completeTask: vi.fn(async () => true),
      markTaskNeedsAttention: vi.fn(async () => true),
    };
    const evidence = {
      kind: 'execution-evidence-repository' as const,
      taskEvidence: vi.fn(async () => evidenceRows),
      conversationEvidence: vi.fn(async () => []),
      hasConversationToolCall: vi.fn(async () => false),
      finalMessageExists: vi.fn(async () => false),
      hasOutboundReply: vi.fn(async () => false),
      checklistDecisions: vi.fn(async () => []),
      recordResponseCheck: vi.fn(async () => true),
    };
    const messages = { append: vi.fn(async () => undefined) };
    const skills = {
      kind: 'skill-context-repository' as const,
      recall: vi.fn(async () => []),
      findByName: vi.fn(async () => null),
      bumpUse: vi.fn(async () => {}),
      recordOutcome: vi.fn(async () => {}),
    };
    const db = new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(`Unexpected database fallback: ${String(property)}`);
        },
      },
    );
    const deps = {
      db,
      router,
      dispatcher: {
        toolDefs,
        resultIsUntrusted: () => false,
        dispatch,
        executeApproved: vi.fn(),
      },
      persistence: { tasks, executionEvidence: evidence, skills, ownerContext: {}, messages },
    } as unknown as RunContext['deps'];
    const now = new Date('2026-10-01T12:00:00.000Z');
    const window = [{ role: 'user', content: request }];
    const state = TaskStateSchema.parse({
      untrustedContext: false,
      requestTimeZone: 'UTC',
      contextWindow: window,
    });
    const task = {
      id: 'synthetic-opt-out-task',
      agentId: 'synthetic-owner',
      conversationId: 'synthetic-conversation',
      type: 'chat_turn',
      trust: 'owner',
      trigger: { source: 'chat', payload: { text: request } },
      createdAt: now,
      maxSteps: 1,
      attempt: 1,
      queueGeneration: 1,
      leaseToken: 'synthetic-lease',
      lockedUntil: new Date(now.getTime() + 60_000),
      plan: null,
    };
    const context = {
      deps,
      db,
      router,
      dispatcher: deps.dispatcher,
      task,
      agent: { id: task.agentId, timezone: 'UTC' },
      state: state as TaskState,
      ctx: {
        taskId: task.id,
        agentId: task.agentId,
        trust: 'owner',
        tainted: false,
        db,
        now: () => now,
        signal: new AbortController().signal,
        log: vi.fn(async () => {}),
      },
      window,
    } as unknown as RunContext;

    await runStepLoop(context, {
      action: 'reply',
      reasoning: 'Answer only from the supplied prompt.',
      steps: [],
      missingInfo: [],
    });

    expect(contextReads.ownerCard).not.toHaveBeenCalled();
    expect(contextReads.ambient).not.toHaveBeenCalled();
    expect(systems.join('\n')).not.toContain('SYNTHETIC OWNER CARD SECRET');
    expect(systems.join('\n')).not.toContain('SYNTHETIC AMBIENT SECRET');
    expect(conversationReads).not.toHaveBeenCalled();
    expect(systems.join('\n')).not.toContain('SYNTHETIC HISTORY SECRET');
    expect(dispatch.mock.calls.length).toBeGreaterThan(0);
    expect(dispatch.mock.calls.every(([call]) => call.toolName === 'web.fetch')).toBe(true);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      toolName: 'web.fetch',
      args: { url: 'https://syntheticexample.test/toolstub' },
    });
    expect(dispatch.mock.calls.some(([call]) => call.toolName === 'memory.recall')).toBe(false);
  });
});
