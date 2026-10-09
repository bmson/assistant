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

async function runFlightContinuation(
  history: Array<{ role: string; content: string }>,
  request: string,
) {
  const rows: Array<Record<string, unknown>> = [];
  const router = {
    step: vi.fn(async () => ({
      ok: true as const,
      modelId: 'synthetic/flight-continuation',
      degraded: false as const,
      text: '',
      toolCalls: [],
    })),
    object: vi.fn(async () => {
      throw new Error('private-read route should skip planning');
    }),
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Array(1536).fill(0.01))),
    embeddingSpace: vi.fn(async () => ({
      provider: 'synthetic',
      model: 'r9',
      dimensions: 1536,
      revision: '1',
    })),
  };
  const dispatch = vi.fn(
    async ({ toolName, args }: { toolName: string; args: Record<string, unknown> }) => {
      let result: Record<string, unknown>;
      if (toolName === 'calendar.search_events') {
        result = {
          events: [
            {
              eventId: 'berlin-oct-9',
              summary: 'Berlin flight',
              start: '2026-10-09T20:45:00.000Z',
            },
          ],
          complete: true,
          calendarsSearched: ['primary'],
        };
      } else if (toolName === 'gmail.search') {
        result = {
          results: [
            { threadId: 'current', subject: 'Berlin flight itinerary' },
            { threadId: 'old', subject: 'Berlin flight itinerary' },
            { threadId: 'newsletter', subject: 'Asiana newsletter' },
          ],
          mailboxSearched: 'all mail',
          complete: true,
        };
      } else if (toolName === 'gmail.read_thread') {
        const source =
          String(args.threadId) === 'current'
            ? {
                subject: 'Berlin flight itinerary',
                text: 'Berlin flight itinerary\nDeparture\nOctober 9, 2026 at 1:45 PM',
              }
            : String(args.threadId) === 'old'
              ? {
                  subject: 'Berlin flight itinerary',
                  text: 'Berlin flight itinerary\nDeparture\nJanuary 4, 2026 at 9:15 AM',
                }
              : {
                  subject: 'Asiana newsletter',
                  text: 'Asiana newsletter with flight offers and fare promotions.',
                };
        result = { messages: [source], complete: true };
      } else {
        throw new Error(`Unexpected tool dispatch: ${toolName}`);
      }
      const id = `flight-evidence-${rows.length + 1}`;
      rows.push({
        id,
        toolName,
        status: 'succeeded',
        args,
        result,
        error: null,
        step: rows.length + 1,
      });
      return { kind: 'executed' as const, toolCallId: id, result, cached: false };
    },
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
    taskEvidence: vi.fn(async () => rows),
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
  const toolDefs = vi.fn(() => [
    { name: 'calendar.search_events', description: 'fixture calendar', inputSchema: {} },
    { name: 'gmail.search', description: 'fixture Gmail search', inputSchema: {} },
    { name: 'gmail.read_thread', description: 'fixture Gmail thread', inputSchema: {} },
  ]);
  const deps = {
    db,
    router,
    dispatcher: { toolDefs, resultIsUntrusted: () => false, dispatch, executeApproved: vi.fn() },
    persistence: { tasks, executionEvidence: evidence, skills },
  } as unknown as RunContext['deps'];
  const now = new Date('2026-10-09T12:00:00.000Z');
  const window = [...history, { role: 'user', content: request }];
  const state = TaskStateSchema.parse({
    // Keep unrelated owner-card/ambient loaders outside this executor fixture.
    untrustedContext: true,
    requestTimeZone: 'America/Los_Angeles',
    contextWindow: window,
  });
  const task = {
    id: 'synthetic-flight-task',
    agentId: 'synthetic-flight-owner',
    conversationId: null,
    type: 'chat_turn',
    trust: 'owner',
    trigger: { source: 'internal', payload: { text: request } },
    createdAt: now,
    maxSteps: 8,
    attempt: 1,
    queueGeneration: 1,
    leaseToken: 'synthetic-flight-lease',
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
    window,
  } as unknown as RunContext;
  const result = await runStepLoop(context, {
    action: 'reply',
    reasoning: 'Answer from requested sources.',
    steps: [],
    missingInfo: [],
  });
  return { result, state, rows, router, dispatch };
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

describe('flight clarification through the actual executor step loop', () => {
  it.each([
    {
      name: 'date-only answer after a flight-date question',
      history: [
        { role: 'user', content: 'When is my flight to Berlin tomorrow?' },
        { role: 'assistant', content: 'Your flight is at 9:15 AM.' },
        { role: 'user', content: 'Are you sure?' },
        { role: 'assistant', content: 'What is the date of the flight you want me to recheck?' },
      ],
      answer: 'October 9, 2026.',
    },
    {
      name: 'date then lowercase destination after two complete clarification questions',
      history: [
        { role: 'user', content: 'There is nothing in calendar about 9:15 flight.' },
        {
          role: 'assistant',
          content: 'What date and destination is the flight you want me to recheck?',
        },
        { role: 'user', content: 'October 9, 2026.' },
        { role: 'assistant', content: 'What destination should I use for the flight?' },
      ],
      answer: 'berlin',
    },
  ])('grounds the forced source reads and answer for $name', async ({ history, answer }) => {
    const { result, state, rows, router, dispatch } = await runFlightContinuation(history, answer);
    expect(result.outcome).toBe('done');
    expect(state.pendingFinal?.text).toBe(
      'The matching berlin booking message lists departure at 1:45 PM.',
    );
    expect(state.pendingFinal?.text).not.toMatch(/9:15|January|Asiana|newsletter/i);
    expect(dispatch.mock.calls.map(([call]) => call.toolName)).toEqual([
      'calendar.search_events',
      'gmail.search',
      'gmail.read_thread',
      'gmail.read_thread',
      'gmail.read_thread',
    ]);
    expect(dispatch.mock.calls[0]?.[0].args).toMatchObject({
      query: 'berlin',
      timeMin: '2026-10-09T07:00:00.000Z',
      timeMax: '2026-10-10T07:00:00.000Z',
    });
    expect(dispatch.mock.calls[1]?.[0].args.query).toContain('berlin');
    expect(rows).toHaveLength(5);
    expect(state.pendingFinal?.responseCards ?? []).toEqual([]);
    expect(router.step).toHaveBeenCalledTimes(1);
  });

  it('does not inherit a quoted third-party flight request into private reads', async () => {
    const { dispatch, result } = await runFlightContinuation(
      [
        {
          role: 'user',
          content:
            'My coworker asked, “When is my flight to Berlin tomorrow?” What should I tell them?',
        },
        {
          role: 'assistant',
          content: 'What date and destination is the flight you want me to recheck?',
        },
      ],
      'October 9, 2026 to Berlin.',
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.outcome).not.toBe('done');
  });
});
