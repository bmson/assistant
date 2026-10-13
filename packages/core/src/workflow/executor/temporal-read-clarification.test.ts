import type { ExecutionEvidenceRepository, TaskLeaseRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '../../events.js';
import { TaskStateSchema } from '../../events.js';
import { buildRequestChecklist } from '../request-checklist.js';
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
  options: {
    currentBookingFourth?: boolean;
    incompleteCalendarSearch?: boolean;
    missingCalendarRosterFlag?: boolean;
    incompleteMailSearch?: boolean;
    hostileCalendarTitle?: string;
    newsletterLisbonSource?: boolean;
    yearlessLisbonConfirmation?: boolean;
    withoutFlightCandidate?: boolean;
    withRequestChecklist?: boolean;
    upcomingFlight?: boolean;
    weeklyCalendarPlan?: boolean;
    weeklyCalendarIncomplete?: boolean;
    weeklyBusy?: unknown[];
    modelIgnoresNoTools?: boolean;
    modelFinalText?: string;
  } = {},
) {
  const rows: Array<Record<string, unknown>> = [];
  const router = {
    step: vi.fn(async () => ({
      ok: true as const,
      modelId: 'synthetic/flight-continuation',
      degraded: false as const,
      text: options.modelFinalText ?? '',
      toolCalls: options.modelIgnoresNoTools
        ? [{ toolCallId: 'forbidden-provider-call', toolName: 'calendar.create_event', input: {} }]
        : [],
      ...(options.modelIgnoresNoTools ? { finishReason: 'tool-calls' as const } : {}),
    })),
    object: vi.fn(async (_purpose: string, _input: Record<string, unknown>) => {
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
      if (toolName === 'calendar.availability' && options.weeklyCalendarPlan) {
        result = {
          busy: options.weeklyBusy ?? [],
          complete: !options.weeklyCalendarIncomplete,
          calendarsChecked: ['Work', 'Personal'],
          unavailable: options.weeklyCalendarIncomplete ? ['Holidays in United States'] : [],
        };
      } else if (toolName === 'calendar.list_events' && options.weeklyCalendarPlan) {
        const secondPage = args.pageToken === 'weekly-page-2';
        result = {
          events: secondPage
            ? [
                {
                  eventId: 'weekly-event-2',
                  calendarId: 'work',
                  summary: 'Focus review',
                  start: '2026-10-14T17:00:00.000Z',
                  end: '2026-10-14T18:00:00.000Z',
                  ownerResponse: 'accepted',
                  blocksTime: true,
                },
              ]
            : [
                {
                  eventId: 'weekly-event-1',
                  calendarId: 'work',
                  summary: 'Team meeting',
                  start: '2026-10-12T17:00:00.000Z',
                  end: '2026-10-12T18:00:00.000Z',
                  ownerResponse: 'accepted',
                  blocksTime: true,
                },
              ],
          complete: secondPage,
          calendarRosterComplete: true,
          unavailable: [],
          ...(!secondPage ? { nextPageToken: 'weekly-page-2' } : {}),
        };
      } else if (toolName === 'calendar.list_events') {
        result = {
          events: [
            ...(options.upcomingFlight
              ? [
                  {
                    eventId: 'dentist-before-flight',
                    summary: 'Dentist appointment',
                    start: '2026-10-15T16:00:00.000Z',
                  },
                ]
              : []),
            ...(!options.withoutFlightCandidate
              ? [
                  {
                    eventId: options.upcomingFlight ? 'lisbon-flight' : 'upcoming-flight',
                    summary: options.hostileCalendarTitle ?? 'Flight to Lisbon',
                    start: options.upcomingFlight
                      ? '2026-11-12T17:00:00.000Z'
                      : '2026-11-12T17:00:00.000Z',
                    links: [
                      {
                        type: 'calendar',
                        url: 'https://calendar.google.com/calendar/event?eid=lisbon',
                      },
                    ],
                  },
                ]
              : []),
            ...(options.upcomingFlight
              ? [
                  {
                    eventId: 'oslo-flight-later-same-day',
                    summary: 'Flight to Oslo',
                    start: '2026-11-12T20:00:00.000Z',
                  },
                ]
              : []),
          ],
          complete: !options.incompleteCalendarSearch,
          calendarRosterComplete: options.missingCalendarRosterFlag ? undefined : true,
          unavailable: [],
          calendarsSearched: ['primary'],
        };
      } else if (toolName === 'calendar.search_events') {
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
          results: options.incompleteMailSearch
            ? []
            : options.upcomingFlight
              ? (() => {
                  const booking = {
                    threadId: 'booking-upcoming',
                    subject: 'Lisbon flight confirmation',
                    snippet: 'Departure November 12, 2026. Fare expires December 2, 2026.',
                  };
                  const oslo = {
                    threadId: 'oslo-flight-same-day',
                    subject: 'Oslo flight confirmation',
                    snippet: 'Departure November 12, 2026.',
                  };
                  const alternate = options.newsletterLisbonSource
                    ? {
                        threadId: 'lisbon-newsletter',
                        subject: 'Lisbon flight deals',
                        snippet: 'Flight departure November 12, 2026 at 7:30 AM.',
                      }
                    : options.yearlessLisbonConfirmation
                      ? {
                          threadId: 'lisbon-yearless',
                          subject: 'Lisbon flight itinerary',
                          snippet: 'Departure November 12 at 7:30 AM.',
                        }
                      : { threadId: 'old-flight', subject: 'Lisbon flight itinerary' };
                  return options.newsletterLisbonSource || options.yearlessLisbonConfirmation
                    ? [booking, alternate, oslo]
                    : [booking, oslo, alternate];
                })()
              : options.currentBookingFourth
                ? [
                    {
                      threadId: 'stale-1',
                      subject: 'Berlin flight update',
                      snippet: 'Gate information for your earlier trip.',
                    },
                    {
                      threadId: 'stale-2',
                      subject: 'Berlin airport notice',
                      snippet: 'Terminal information for your earlier trip.',
                    },
                    {
                      threadId: 'stale-3',
                      subject: 'Your Berlin travel details',
                      snippet: 'Information from an earlier trip.',
                    },
                    {
                      threadId: 'current',
                      subject: 'Berlin flight confirmation',
                      snippet: 'Your itinerary and departure details.',
                    },
                  ]
                : [
                    { threadId: 'current', subject: 'Berlin flight itinerary' },
                    { threadId: 'old', subject: 'Berlin flight itinerary' },
                    { threadId: 'newsletter', subject: 'Asiana newsletter' },
                  ],
          mailboxSearched: 'all mail',
          complete: !options.incompleteMailSearch,
        };
      } else if (toolName === 'gmail.read_thread') {
        const source =
          options.upcomingFlight && String(args.threadId) === 'booking-upcoming'
            ? {
                subject: 'Lisbon flight confirmation',
                text: 'Lisbon flight itinerary\nDeparture\nNovember 12, 2026 at 9:30 AM CET\nFare expires December 2, 2026.',
              }
            : options.upcomingFlight && String(args.threadId) === 'oslo-flight-same-day'
              ? {
                  subject: 'Oslo flight confirmation',
                  text: 'Oslo flight itinerary\nDeparture\nNovember 12, 2026 at 8:00 PM',
                }
              : options.upcomingFlight && String(args.threadId) === 'old-flight'
                ? {
                    subject: 'Lisbon flight itinerary',
                    text: 'Lisbon flight itinerary\nDeparture\nSeptember 8, 2026 at 9:30 AM',
                  }
                : options.upcomingFlight && String(args.threadId) === 'lisbon-newsletter'
                  ? {
                      subject: 'Lisbon flight deals',
                      text: 'Flight departure November 12, 2026 at 7:30 AM.',
                    }
                  : options.upcomingFlight && String(args.threadId) === 'lisbon-yearless'
                    ? {
                        subject: 'Lisbon flight itinerary',
                        text: 'Departure November 12 at 7:30 AM.',
                      }
                    : options.upcomingFlight
                      ? {
                          subject: 'Weekly travel news',
                          text: 'Weekly travel news and flight offers.',
                        }
                      : String(args.threadId) === 'current'
                        ? {
                            subject: options.currentBookingFourth
                              ? 'Berlin flight confirmation'
                              : 'Berlin flight itinerary',
                            text: 'Berlin flight itinerary\nDeparture\nOctober 9, 2026 at 1:45 PM',
                          }
                        : options.currentBookingFourth && String(args.threadId).startsWith('stale-')
                          ? {
                              subject: 'Berlin flight details from an earlier trip',
                              text: `Berlin flight itinerary\nDeparture\n${
                                String(args.threadId) === 'stale-1'
                                  ? 'January 4, 2026 at 9:15 AM'
                                  : 'February 12, 2026 at 8:30 AM'
                              }`,
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
      const evidenceArgs = { ...args };
      if (toolName === 'gmail.search') {
        const query = String(args.query ?? '');
        const maxResults = Number.isInteger(args.maxResults) ? Number(args.maxResults) : 10;
        const results = Array.isArray(result.results) ? result.results : [];
        const unavailable = Array.isArray(result.unavailable) ? result.unavailable : [];
        const complete = result.complete === true;
        const hasMore = result.hasMore === true;
        const nextPageToken =
          typeof result.nextPageToken === 'string' ? result.nextPageToken : undefined;
        evidenceArgs.maxResults = maxResults;
        Object.assign(result, {
          query,
          unavailable,
          hasMore,
          receipt: {
            version: 1,
            source: { kind: 'gmail-search', id: query },
            requested: {
              limit: maxResults,
              ...(typeof args.pageToken === 'string' ? { cursor: args.pageToken } : {}),
              scope: 'query-page',
            },
            covered: {
              count: results.length,
              total: results.length,
              unavailable: unavailable.length,
            },
            complete,
            losses: complete ? [] : ['coverage-unknown'],
            continuation:
              hasMore && nextPageToken
                ? { tool: 'gmail.search', input: { query, maxResults, pageToken: nextPageToken } }
                : null,
          },
        });
      } else if (toolName === 'gmail.read_thread') {
        const threadId = String(args.threadId ?? '');
        const start = Number.isInteger(args.startMessageIndex) ? Number(args.startMessageIndex) : 0;
        const offset = Number.isInteger(args.startMessageOffset)
          ? Number(args.startMessageOffset)
          : 0;
        const maxMessages = Number.isInteger(args.maxMessages) ? Number(args.maxMessages) : 20;
        const maxChars = Number.isInteger(args.maxChars) ? Number(args.maxChars) : 20_000;
        const messages = Array.isArray(result.messages)
          ? result.messages.map((message, index) => {
              const item = message as Record<string, unknown>;
              const body = typeof item.text === 'string' ? item.text : '';
              return {
                ...item,
                messageId:
                  typeof item.messageId === 'string'
                    ? item.messageId
                    : `${threadId}-message-${index}`,
                sourceLength: body.length,
                truncated: false,
              };
            })
          : [];
        const complete = result.complete === true;
        evidenceArgs.startMessageIndex = start;
        evidenceArgs.startMessageOffset = offset;
        evidenceArgs.maxMessages = maxMessages;
        evidenceArgs.maxChars = maxChars;
        Object.assign(result, {
          threadId,
          messages,
          hasMore: false,
          receipt: {
            version: 1,
            source: { kind: 'gmail-thread', id: threadId },
            requested: { start, offset, limit: maxMessages, scope: 'thread-messages' },
            covered: {
              start,
              offset,
              end: start + messages.length,
              count: messages.length,
              total: start + messages.length,
              unavailable: 0,
            },
            complete,
            losses: complete ? [] : ['coverage-unknown'],
            continuation: null,
          },
        });
      }
      const id = `flight-evidence-${rows.length + 1}`;
      rows.push({
        id,
        toolName,
        status: 'succeeded',
        args: evidenceArgs,
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
  const toolDefs = vi.fn(() => [
    { name: 'calendar.availability', description: 'fixture availability', inputSchema: {} },
    { name: 'calendar.list_events', description: 'fixture calendar', inputSchema: {} },
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
    ...(options.withRequestChecklist ? { requestChecklist: buildRequestChecklist(request) } : {}),
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
  it('finishes a checked read when the provider ignores the no-tool boundary', async () => {
    const request =
      'Review my calendar for next week and identify scheduling conflicts and overloaded days. Find three realistic 90-minute focus blocks during working hours, allowing time for travel and breaks. Recommend changes, but show me the plan before editing my calendar.';
    const { result, state, router, dispatch } = await runFlightContinuation([], request, {
      weeklyCalendarPlan: true,
      weeklyCalendarIncomplete: true,
      modelIgnoresNoTools: true,
    });
    expect(result.outcome).toBe('needs_attention');
    expect(router.step).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls.map(([call]) => call.toolName)).toEqual([
      'calendar.availability',
      'calendar.list_events',
      'calendar.list_events',
    ]);
    expect(state.pendingFinal?.text).toContain('review-only plan for next week');
    expect(state.pendingFinal?.text).toContain('Holidays in United States');
    expect(state.pendingFinal?.responseCards ?? []).toEqual([]);
  });

  it('reads availability and every bounded event page before proposing a review-only week', async () => {
    const request =
      'Review my calendar for next week and identify scheduling conflicts and overloaded days. Find three realistic 90-minute focus blocks during working hours, allowing time for travel and breaks. Recommend changes, but show me the plan before editing my calendar.';
    const { result, state, dispatch } = await runFlightContinuation([], request, {
      weeklyCalendarPlan: true,
    });
    expect(result.outcome).toBe('done');
    expect(dispatch.mock.calls.map(([call]) => call.toolName)).toEqual([
      'calendar.availability',
      'calendar.list_events',
      'calendar.list_events',
    ]);
    expect(dispatch.mock.calls[0]?.[0].args).toMatchObject({
      timeMin: '2026-10-12T07:00:00.000Z',
      timeMax: '2026-10-19T07:00:00.000Z',
    });
    expect(dispatch.mock.calls[1]?.[0].args.pageToken).toBeUndefined();
    expect(dispatch.mock.calls[2]?.[0].args.pageToken).toBe('weekly-page-2');
    expect(state.pendingFinal?.text).toContain('review-only plan for next week');
    expect(state.pendingFinal?.text.match(/\(90 minutes\)/g)).toHaveLength(3);
    expect(state.pendingFinal?.text).toContain('I haven’t changed your calendar.');
    // The fixture returns an empty model final after the source reads. Keep
    // the checked plan, without reconstructing a raw agenda or busy-block dump.
    expect(state.pendingFinal?.responseCards ?? []).toEqual([]);
    expect(
      dispatch.mock.calls.some(([call]) =>
        /calendar\.(?:create|update|delete)/.test(call.toolName),
      ),
    ).toBe(false);
  });

  it('keeps an incomplete-coverage proposal in Activity for owner review', async () => {
    const request =
      'Review my calendar for next week and identify scheduling conflicts and overloaded days. Find three realistic 90-minute focus blocks during working hours, allowing time for travel and breaks. Recommend changes, but show me the plan before editing my calendar.';
    const { result, state } = await runFlightContinuation([], request, {
      weeklyCalendarPlan: true,
      weeklyCalendarIncomplete: true,
    });
    expect(result.outcome).toBe('needs_attention');
    expect(state.pendingFinal?.terminalStatus).toBe('needs_attention');
    expect(state.pendingFinal?.preserveCheckedReadResponse).toBe(true);
    expect(state.pendingFinal?.text).toContain('Holidays in United States');
    expect(state.pendingFinal?.text).toContain('not confirmed free');
  });

  it.each([false, true])(
    'uses source coverage to complete a non-empty model final (incomplete=%s)',
    async (incomplete) => {
      const request =
        'Review my calendar for next week and identify scheduling conflicts and overloaded days. Find three realistic 90-minute focus blocks during working hours, allowing time for travel and breaks. Recommend changes, but show me the plan before editing my calendar.';
      const { result, state, dispatch } = await runFlightContinuation([], request, {
        weeklyCalendarPlan: true,
        weeklyCalendarIncomplete: incomplete,
        modelFinalText: 'Here is your review-only calendar plan. I have not changed your calendar.',
      });
      expect(result.outcome).toBe(incomplete ? 'needs_attention' : 'done');
      expect(state.pendingFinal?.terminalStatus).toBe(incomplete ? 'needs_attention' : 'done');
      expect(state.pendingFinal?.text).toContain('review-only plan for next week');
      expect(state.pendingFinal?.responseCards ?? []).toEqual([]);
      if (incomplete) {
        expect(state.pendingFinal?.preserveCheckedReadResponse).toBe(true);
        expect(state.pendingFinal?.text).toContain('not confirmed free');
        expect(state.pendingFinal?.text).toContain('Holidays in United States');
      }
      expect(
        dispatch.mock.calls.some(([call]) =>
          /calendar\.(?:create|update|delete)/.test(call.toolName),
        ),
      ).toBe(false);
    },
  );

  it('keeps a complete-coverage plan in Activity when fewer than three focus blocks fit', async () => {
    const request =
      'Review my calendar for next week and identify scheduling conflicts and overloaded days. Find three realistic 90-minute focus blocks during working hours, allowing time for travel and breaks. Recommend changes, but show me the plan before editing my calendar.';
    const { result, state } = await runFlightContinuation([], request, {
      weeklyCalendarPlan: true,
      modelFinalText: 'Here is your review-only calendar plan. I have not changed your calendar.',
      weeklyBusy: [
        { start: '2026-10-12T16:00:00Z', end: '2026-10-13T00:00:00Z' },
        { start: '2026-10-13T17:45:00Z', end: '2026-10-14T00:00:00Z' },
        { start: '2026-10-14T16:00:00Z', end: '2026-10-15T00:00:00Z' },
        { start: '2026-10-15T16:00:00Z', end: '2026-10-16T00:00:00Z' },
        { start: '2026-10-16T16:00:00Z', end: '2026-10-17T00:00:00Z' },
      ],
    });
    expect(result.outcome).toBe('needs_attention');
    expect(state.pendingFinal?.terminalStatus).toBe('needs_attention');
    expect(state.pendingFinal?.text).toContain('I found 1 of 3 requested focus blocks');
  });

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

  it('selects a fourth-result booking but reports incomplete coverage within the three-thread bound', async () => {
    const { result, state, dispatch } = await runFlightContinuation(
      [
        { role: 'user', content: 'When is my flight to Berlin tomorrow?' },
        { role: 'assistant', content: 'Your flight is at 9:15 AM.' },
        { role: 'user', content: 'Are you sure?' },
        { role: 'assistant', content: 'What is the date of the flight you want me to recheck?' },
      ],
      'October 9, 2026.',
      { currentBookingFourth: true },
    );

    expect(result.outcome).toBe('done');
    expect(dispatch.mock.calls.map(([call]) => call.toolName)).toEqual([
      'calendar.search_events',
      'gmail.search',
      'gmail.read_thread',
      'gmail.read_thread',
      'gmail.read_thread',
    ]);
    const openedThreadIds = dispatch.mock.calls
      .filter(([call]) => call.toolName === 'gmail.read_thread')
      .map(([call]) => call.args.threadId);
    expect(openedThreadIds).toEqual(['current', 'stale-1', 'stale-2']);
    expect(openedThreadIds).toHaveLength(3);
    expect(state.pendingFinal?.text).toMatch(/couldn't finish checking the booking emails/i);
    expect(state.pendingFinal?.text).toMatch(/departure time is still unverified/i);
    expect(state.pendingFinal?.text).not.toMatch(/9:15 AM|8:30 AM|January|February/);
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

  it('keeps a calendar-only flight candidate incomplete when booking identity is not verified', async () => {
    const request =
      'Find my next flight from my booking emails and calendar. Confirm its departure date and time zone, and clearly mark anything you cannot verify.';
    const { result, state, dispatch, router } = await runFlightContinuation([], request, {
      upcomingFlight: true,
      withRequestChecklist: true,
    });

    expect(result.outcome).toBe('needs_attention');
    expect(dispatch.mock.calls.map(([call]) => call.toolName)).toEqual([
      'calendar.list_events',
      'gmail.search',
      'gmail.read_thread',
      'gmail.read_thread',
    ]);
    expect(dispatch.mock.calls[0]?.[0].args).toMatchObject({
      timeMin: '2026-10-09T12:00:00.000Z',
      timeMax: '2027-10-09T12:00:00.000Z',
      maxResults: 50,
    });
    expect(dispatch.mock.calls[1]?.[0].args.query).toBe(
      '{flight flights itinerary "e-ticket" "boarding pass" "booking confirmation" "reservation confirmation"}',
    );
    expect(router.object).toHaveBeenCalledTimes(1);
    expect(router.object.mock.calls[0]?.[1]).toMatchObject({
      taskId: 'synthetic-flight-task',
      maxRetries: 0,
      singleAttempt: true,
      maxEstimatedCostUsd: 0.05,
      requestProfile: { tools: 'none', output: 'json_schema', streaming: false },
    });
    expect(state.pendingFinal?.contractBlocked).toBe(true);
    expect(state.pendingFinal?.text).toContain(
      'Next future calendar flight candidate: Flight to Lisbon; calendar date 2026-11-12',
    );
    expect(state.pendingFinal?.text).toContain(
      'calendar time in America/Los_Angeles: Nov 12, 2026, 9:00 AM',
    );
    expect(state.pendingFinal?.text).toContain('Its booking and departure time are unconfirmed.');
    expect(state.pendingFinal?.text).toContain(
      'I could not match it to a fully dated booking segment',
    );
    expect(state.pendingFinal?.text).toContain(
      '[Calendar source](https://calendar.google.com/calendar/event?eid=lisbon)',
    );
    expect(state.pendingFinal?.text).not.toContain('Booking email candidate');
    expect(state.pendingFinal?.text).not.toContain('This request is not fully completed.');
    expect(state.pendingFinal?.text).not.toContain('Not completed:');
    expect(state.pendingFinal?.terminalStatus).toBe('needs_attention');
    expect(state.pendingFinal?.text).not.toMatch(/September 8|flight-newsletter|taxi|transit/);
    expect(
      (state.pendingFinal?.responseCards ?? []).some(
        (card) => card.kind === 'email-results' || card.kind === 'email-thread',
      ),
    ).toBe(false);
  });

  it('names incomplete mail coverage instead of claiming a flight was fully checked', async () => {
    const request = 'Find my next flight and call out anything you cannot verify.';
    const { result, state, dispatch } = await runFlightContinuation([], request, {
      incompleteMailSearch: true,
      withRequestChecklist: true,
    });
    expect(result.outcome).toBe('needs_attention');
    expect(dispatch.mock.calls.map(([call]) => call.toolName)).toEqual([
      'calendar.list_events',
      'gmail.search',
    ]);
    expect(state.pendingFinal?.text).toContain(
      'Booking-email search or thread coverage is incomplete.',
    );
    expect(state.pendingFinal?.text).toContain(
      'Next future calendar flight candidate: Flight to Lisbon; calendar date 2026-11-12',
    );
    expect(state.pendingFinal?.text).toContain(
      '[Calendar source](https://calendar.google.com/calendar/event?eid=lisbon)',
    );
    expect(state.pendingFinal?.text).toContain('Its booking and departure time are unconfirmed.');
    expect(state.pendingFinal?.terminalStatus).toBe('needs_attention');
  });

  it('labels a flight as a candidate when calendar coverage is incomplete', async () => {
    const request = 'Find my next flight and call out anything you cannot verify.';
    const { result, state } = await runFlightContinuation([], request, {
      incompleteCalendarSearch: true,
    });
    expect(result.outcome).toBe('needs_attention');
    expect(state.pendingFinal?.text).toContain(
      'Next future calendar flight candidate: Flight to Lisbon',
    );
    expect(state.pendingFinal?.text).toContain('Calendar coverage is incomplete');
  });

  it('does not infer that no next flight exists from an incomplete calendar search', async () => {
    const request = 'Find my next flight and call out anything you cannot verify.';
    const { result, state } = await runFlightContinuation([], request, {
      incompleteCalendarSearch: true,
      withoutFlightCandidate: true,
    });
    expect(result.outcome).toBe('needs_attention');
    expect(state.pendingFinal?.text).toContain('I cannot establish which flight is next.');
    expect(state.pendingFinal?.text).not.toContain('I found no dated flight candidate');
    expect(state.pendingFinal?.text).toContain(
      'I could not identify a dated future flight candidate in the checked calendar.',
    );
  });

  it('treats a missing calendar-roster completeness flag as partial coverage', async () => {
    const request = 'Find my next flight and call out anything you cannot verify.';
    const { result, state } = await runFlightContinuation([], request, {
      missingCalendarRosterFlag: true,
    });
    expect(result.outcome).toBe('needs_attention');
    expect(state.pendingFinal?.text).toContain('Next future calendar flight candidate');
    expect(state.pendingFinal?.text).toContain('Calendar coverage is incomplete');
    expect(state.pendingFinal?.text).toContain(
      'Booking-email search or thread coverage is incomplete.',
    );
  });

  it('does not use a same-route newsletter to confirm a departure clock', async () => {
    const request = 'Find my next flight and call out anything you cannot verify.';
    const { state } = await runFlightContinuation([], request, {
      upcomingFlight: true,
      newsletterLisbonSource: true,
    });
    expect(state.pendingFinal?.text).toContain('Next future calendar flight candidate');
    expect(state.pendingFinal?.text).toContain('Its booking and departure time are unconfirmed.');
    expect(state.pendingFinal?.text).not.toMatch(/7:30 AM|9:30 AM|Booking email candidate/);
  });

  it('does not bind a yearless old confirmation to a future flight date', async () => {
    const request = 'Find my next flight and call out anything you cannot verify.';
    const { state } = await runFlightContinuation([], request, {
      upcomingFlight: true,
      yearlessLisbonConfirmation: true,
    });
    expect(state.pendingFinal?.text).toContain('Next future calendar flight candidate');
    expect(state.pendingFinal?.text).toContain('Its booking and departure time are unconfirmed.');
    expect(state.pendingFinal?.text).not.toMatch(/7:30 AM|9:30 AM|Booking email candidate/);
  });

  it('bounds and escapes the selected calendar title', async () => {
    const request = 'Find my next flight and call out anything you cannot verify.';
    const { state } = await runFlightContinuation([], request, {
      incompleteMailSearch: true,
      hostileCalendarTitle: 'Flight to Lisbon [click](https://evil.example)',
    });
    expect(state.pendingFinal?.text).toContain(
      String.raw`Flight to Lisbon \[click\]\(https://evil.example\)`,
    );
    expect(state.pendingFinal?.text).not.toContain('[click](https://evil.example)');
  });
});
