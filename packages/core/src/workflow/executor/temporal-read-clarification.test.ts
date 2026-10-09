import type { ExecutionEvidenceRepository, TaskLeaseRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '../../events.js';
import { TaskStateSchema } from '../../events.js';
import type { RunContext } from './phases.js';
import { runStepLoop } from './step-loop.js';

type Scenario = {
  request: string;
  history?: Array<{ role: string; content: string }>;
  expectedText: RegExp;
  expectedOutcome?: 'done' | 'needs_attention';
};

async function runUnsupportedRequest(scenario: Scenario) {
  const confidentDraft = vi.fn(async () => ({
    ok: true as const,
    modelId: 'synthetic/would-have-guessed',
    degraded: false as const,
    text: 'You have a dentist appointment next Tuesday at 3pm.',
    toolCalls: [{ toolCallId: 'model-tool', toolName: 'calendar.list_events', input: {} }],
  }));
  const router = {
    step: confidentDraft,
    object: vi.fn(async () => {
      throw new Error('the preset plan should skip model planning');
    }),
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Array(1536).fill(0.01))),
    embeddingSpace: vi.fn(async () => ({
      provider: 'synthetic',
      model: 'r9-executor-test',
      dimensions: 1536,
      revision: '1',
    })),
  };
  const dispatch = vi.fn(async () => {
    throw new Error('unsupported temporal intent must not dispatch a provider read');
  });
  const toolDefs = vi.fn(() => [
    { name: 'calendar.list_events', description: 'fixture calendar', inputSchema: {} },
    { name: 'calendar.search_events', description: 'fixture calendar', inputSchema: {} },
    { name: 'maps.directions', description: 'fixture directions', inputSchema: {} },
  ]);
  const taskRepository = {
    kind: 'task-lease-repository' as const,
    renew: vi.fn(async () => true),
    checkpoint: vi.fn(async () => true),
    completeTask: vi.fn(async () => true),
    markTaskNeedsAttention: vi.fn(async () => true),
  };
  const evidence = {
    kind: 'execution-evidence-repository' as const,
    taskEvidence: vi.fn(async () => []),
    conversationEvidence: vi.fn(async () => []),
    hasConversationToolCall: vi.fn(async () => false),
    finalMessageExists: vi.fn(async () => false),
    hasOutboundReply: vi.fn(async () => false),
    checklistDecisions: vi.fn(async () => []),
    recordResponseCheck: vi.fn(async () => true),
  };
  const skills = {
    kind: 'skill-context-repository' as const,
    recall: vi.fn(async () => []),
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
  const tasks = taskRepository as unknown as TaskLeaseRepository;
  const executionEvidence = evidence as unknown as ExecutionEvidenceRepository;
  const deps = {
    db,
    router,
    dispatcher: {
      toolDefs,
      resultIsUntrusted: () => false,
      dispatch,
      executeApproved: vi.fn(),
    },
    persistence: { tasks, executionEvidence, skills },
  } as unknown as RunContext['deps'];
  const now = new Date('2026-09-08T12:00:00.000Z');
  const state = TaskStateSchema.parse({
    untrustedContext: true,
    requestTimeZone: 'America/Los_Angeles',
    contextWindow: [...(scenario.history ?? []), { role: 'user', content: scenario.request }],
  });
  const task = {
    id: 'synthetic-r9-task',
    agentId: 'synthetic-r9-owner',
    conversationId: null,
    type: 'adhoc',
    trust: 'owner',
    trigger: { source: 'internal', payload: { text: scenario.request } },
    createdAt: now,
    maxSteps: 4,
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
    agent: { id: task.agentId, timezone: 'America/Los_Angeles' },
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
    window: [...(scenario.history ?? []), { role: 'user', content: scenario.request }],
  } as unknown as RunContext;

  const result = await runStepLoop(context, {
    action: 'reply',
    reasoning: 'Answer the owner accurately.',
    steps: [],
    missingInfo: [],
  });
  return { result, state, router, dispatch, toolDefs };
}

describe('unsupported temporal requests through the actual executor step loop', () => {
  it.each([
    {
      request: 'There is nothing in the calendar about 9:15 flight.',
      expectedText: /what date and destination is the flight you want me to recheck/i,
    },
    {
      request: 'Are you sure?',
      history: [
        { role: 'user', content: 'When is my flight to Berlin tomorrow?' },
        { role: 'assistant', content: 'Your flight is at 9:15 AM.' },
      ],
      expectedText: /what is the date of the flight you want me to recheck/i,
    },
    {
      request: 'What was on my calendar 3 years ago?',
      expectedText: /can’t safely search that calendar period/i,
    },
    {
      request: 'Find my dentist appointment from 3 years ago on my calendar.',
      expectedText: /can’t safely search that calendar period/i,
    },
    {
      request: 'Directions to my dentist appointment 3 years ago.',
      expectedText: /can’t safely search that calendar period/i,
      expectedOutcome: 'needs_attention',
    },
    {
      request: 'What was on my calendar on February 30?',
      expectedText: /can’t safely resolve that calendar date or period/i,
    },
    {
      request: 'What was on my calendar last 0 days?',
      expectedText: /can’t safely search that calendar period/i,
    },
  ] satisfies Scenario[])(
    'emits a clarification and blocks every tool/model path: $request',
    async (scenario) => {
      const { result, state, router, dispatch } = await runUnsupportedRequest(scenario);
      expect(result.outcome).toBe(scenario.expectedOutcome ?? 'done');
      expect(state.pendingFinal?.text).toMatch(scenario.expectedText);
      expect(state.pendingFinal?.text).not.toContain('dentist appointment next Tuesday');
      expect(router.step).not.toHaveBeenCalled();
      expect(router.object).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
});
