import type {
  LearnedSkill,
  SkillContextRepository,
  SkillLibraryRepository,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '../../events.js';
import { TaskStateSchema } from '../../events.js';
import { skillRetrievalReceipt } from '../../memory/skills.js';
import type { PersonalReadRequest } from '../read-intent.js';
import { verifiedReadResponse } from '../response-contract.js';
import { stageFinalResponse, stageModelFinalResponse } from './finalize.js';
import type { RunContext } from './phases.js';
import { runStepLoop } from './step-loop.js';

const skill: LearnedSkill = {
  id: 'saved-calendar-review',
  agentId: 'owner-1',
  name: 'Calendar review',
  preconditions: 'When reviewing the owner’s calendar',
  steps: 'Check date coverage and unavailable calendars before summarizing.',
  gotchas: 'Do not change events without separate approval.',
  sourceTaskId: null,
  embeddingSpaceKey: null,
  originTrust: 'owner',
  ownerAuthored: true,
  useCount: 0,
  successCount: 0,
  failureCount: 0,
  lastVerifiedAt: null,
  deprecated: false,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
};

async function runPersonalRead(
  request: string,
  foundSkill: LearnedSkill | null = skill,
  skillLibrary?: SkillLibraryRepository,
  calendarEvents: Array<Record<string, unknown>> = [
    {
      id: 'design-review-1',
      summary: 'Design review',
      start: '2026-10-13T09:00:00-07:00',
      end: '2026-10-13T09:30:00-07:00',
    },
  ],
) {
  const rows: Array<Record<string, unknown>> = [];
  const findByName = vi.fn(async () => foundSkill);
  const recall = vi.fn(async () => []);
  const bumpUse = vi.fn(async () => undefined);
  const skills = {
    kind: 'skill-context-repository' as const,
    recall,
    findByName,
    bumpUse,
    recordOutcome: vi.fn(async () => undefined),
  } satisfies SkillContextRepository;
  const systems: string[] = [];
  const router = {
    step: vi.fn(async (_role: string, input: { system: string }) => {
      systems.push(input.system);
      return {
        ok: true as const,
        modelId: 'synthetic/named-skill-read',
        degraded: false as const,
        text: 'I checked the calendar for today.',
        toolCalls: [],
      };
    }),
    object: vi.fn(async (_role: string, _input: Record<string, unknown>) => {
      throw new Error('an owner read request should use the private-read route');
    }),
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Array(1536).fill(0.01))),
    embeddingSpace: vi.fn(async () => ({
      provider: 'synthetic',
      model: 'named-skill-test',
      dimensions: 1536,
      revision: '1',
    })),
  };
  const dispatch = vi.fn(
    async ({ toolName, args }: { toolName: string; args: Record<string, unknown> }) => {
      if (toolName !== 'calendar.list_events') throw new Error(`Unexpected tool: ${toolName}`);
      const result = {
        events: calendarEvents,
        complete: true,
        calendarRosterComplete: true,
        calendarsSearched: ['primary'],
        unavailable: [],
      };
      rows.push({
        id: `read-${rows.length + 1}`,
        toolName,
        status: 'succeeded',
        args,
        result,
        error: null,
        step: rows.length + 1,
      });
      return {
        kind: 'executed' as const,
        toolCallId: `read-${rows.length}`,
        result,
        cached: false,
      };
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
  const db = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`Unexpected database fallback: ${String(property)}`);
      },
    },
  );
  const toolDefs = vi.fn(() => [
    { name: 'calendar.list_events', description: 'read calendar events', inputSchema: {} },
  ]);
  const deps = {
    db,
    router,
    dispatcher: {
      toolDefs,
      resultIsUntrusted: () => true,
      dispatch,
      executeApproved: vi.fn(),
    },
    persistence: { tasks, executionEvidence: evidence, skills, skillLibrary },
  } as unknown as RunContext['deps'];
  const now = new Date('2026-10-13T12:00:00.000Z');
  const window = [{ role: 'user', content: request }];
  const state = TaskStateSchema.parse({
    untrustedContext: true,
    requestTimeZone: 'America/Los_Angeles',
    contextWindow: window,
  });
  const task = {
    id: 'named-skill-read-task',
    agentId: 'owner-1',
    conversationId: null,
    type: 'chat_turn',
    trust: 'owner',
    trigger: { source: 'internal', payload: { text: request } },
    createdAt: now,
    maxSteps: 4,
    attempt: 1,
    queueGeneration: 1,
    leaseToken: 'named-skill-read-lease',
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
      log: vi.fn(async () => undefined),
    },
    window,
  } as unknown as RunContext;
  const result = await runStepLoop(context, {
    action: 'reply',
    reasoning: 'Answer the personal read from checked source data.',
    steps: [],
    missingInfo: [],
  });
  return { result, skills, systems, router, dispatch, state, task, window, deps, rows };
}

describe('named saved skill use during a personal read', () => {
  it('answers a saved-skill inventory from metadata without applying a skill or querying calendar', async () => {
    const list = vi.fn(async () => [
      {
        id: skill.id,
        name: skill.name,
        preconditions: skill.preconditions,
        steps: skill.steps,
        gotchas: skill.gotchas,
        ownerAuthored: skill.ownerAuthored,
        deprecated: skill.deprecated,
        useCount: skill.useCount,
        successCount: skill.successCount,
        failureCount: skill.failureCount,
        updatedAt: skill.updatedAt,
      },
    ]);
    const library: SkillLibraryRepository = {
      kind: 'skill-library-repository',
      list,
    };
    const f = await runPersonalRead(
      'What saved skills do I have that could help plan a busy day?',
      skill,
      library,
    );

    expect(list).toHaveBeenCalledWith('owner-1');
    expect(f.skills.findByName).not.toHaveBeenCalled();
    expect(f.skills.recall).not.toHaveBeenCalled();
    expect(f.skills.bumpUse).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.window.at(-1)?.content).toContain('Calendar review');
    expect(f.window.at(-1)?.content).toContain('scheduling');
    expect(f.window.at(-1)?.content).not.toContain(skill.steps);
  });

  it('reports the library unavailable instead of presenting an empty inventory', async () => {
    const f = await runPersonalRead('What saved skills do I have that could help plan a busy day?');

    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.window.at(-1)?.content).toContain('cannot verify which skills are available');
    expect(f.window.at(-1)?.content).not.toContain('could not find an active saved skill');
  });

  it('retrieves the exact owner skill as advice without opening a write capability', async () => {
    const { skills, systems, router, dispatch, state } = await runPersonalRead(
      'What is on my calendar today? Apply my saved skill named "Calendar review".',
    );

    expect(skills.findByName).toHaveBeenCalledWith({ agentId: 'owner-1', name: 'Calendar review' });
    expect(skills.recall).not.toHaveBeenCalled();
    expect(skills.bumpUse).toHaveBeenCalledWith({ agentId: 'owner-1', ids: [skill.id] });
    expect(systems.join('\n')).toContain(skill.steps);
    expect(systems.join('\n')).toContain('ADVICE');
    expect(dispatch.mock.calls.map(([call]) => call.toolName)).toEqual(['calendar.list_events']);
    expect(router.step).toHaveBeenCalledTimes(1);
    expect(state.skillRetrievalReceipts).toEqual([skillRetrievalReceipt(skill)]);
    expect(JSON.stringify(state.skillRetrievalReceipts)).not.toContain(skill.steps);
  });

  it('keeps a concise calendar-answer directive while preserving event and source coverage', async () => {
    const f = await runPersonalRead(
      'Review my calendar tomorrow and give me a short practical briefing with source links. Note any overlaps.',
      null,
      undefined,
      [
        {
          id: 'event-one',
          summary: 'First event',
          start: '2026-10-14T09:00:00-07:00',
          end: '2026-10-14T10:00:00-07:00',
          location: 'Unrequested address',
          description: 'Unrequested details',
        },
        {
          id: 'event-two',
          summary: 'Second event',
          start: '2026-10-14T09:30:00-07:00',
          end: '2026-10-14T10:30:00-07:00',
        },
      ],
    );

    const answerSystem = f.systems.join('\n');
    expect(answerSystem).toContain('Keep this calendar briefing compact');
    expect(answerSystem).toContain('Represent every returned event');
    expect(answerSystem).toContain('source link when available');
    expect(answerSystem).toContain(
      'Omit unrequested addresses, descriptions, attendees, and booking details',
    );
    expect(answerSystem).toContain('concise overlap facts supported by the checked events');
    expect(f.dispatch.mock.calls.map(([call]) => call.toolName)).toEqual(['calendar.list_events']);
  });

  it.each([
    'valid advice',
    'literal replacement token advice',
    'provider unavailable',
    'rejected advice',
    'truncated advice',
  ])(
    'adds a source-checked next action for a receipt-bound skill request (%s)',
    async (condition) => {
      const actionSkill = {
        ...skill,
        name: 'Action planning',
        steps: 'End the briefing with the next useful action.',
      };
      const events = [
        {
          id: 'review',
          eventId: 'review',
          calendarId: 'work',
          summary: 'Design review',
          start: '2026-10-13T09:00:00-07:00',
          end: '2026-10-13T09:30:00-07:00',
          ownerResponse: 'accepted',
          blocksTime: true,
        },
        {
          id: 'planning',
          eventId: 'planning',
          calendarId: 'shared',
          summary: 'Planning hold',
          start: '2026-10-13T09:20:00-07:00',
          end: '2026-10-13T10:00:00-07:00',
          blocksTime: true,
        },
      ];
      const f = await runPersonalRead('What is on my calendar today?', null, undefined, events);
      f.window[0] = {
        role: 'user',
        content:
          'What is on my calendar today? Give me a compact briefing. Apply my saved skill named "Action planning". End with one next useful action for the overlap.',
      };
      f.state.usedSkillIds = [actionSkill.id];
      f.state.skillRetrievalReceipts = [skillRetrievalReceipt(actionSkill)];
      f.skills.findByName.mockResolvedValue(actionSkill);
      const readRequest: PersonalReadRequest = {
        kind: 'calendar',
        queryTerms: [],
        requiresThreadRead: false,
        firstToolName: 'calendar.list_events',
        includeCalendarBriefing: true,
        includeCalendarOverlapSummary: true,
        compactCalendarBriefing: true,
        timeZone: 'America/Los_Angeles',
        timeWindow: {
          label: 'today',
          timeMin: '2026-10-13T07:00:00.000Z',
          timeMax: '2026-10-14T07:00:00.000Z',
        },
      };
      const projection = verifiedReadResponse(readRequest, f.rows as never);
      expect(projection).toContain('Calendar overlap does not confirm attendance.');
      expect(projection).not.toContain('Next step:');
      f.router.object.mockClear();
      f.router.object.mockImplementation(async () => {
        if (condition === 'provider unavailable') throw new Error('Unavailable');
        return {
          ok: true,
          object: {
            nextStep:
              condition === 'rejected advice'
                ? 'I moved the Design review.'
                : condition === 'literal replacement token advice'
                  ? 'Check whether you need to attend both $&.'
                  : 'Check whether you need to attend both.',
          },
          finishReason: condition === 'truncated advice' ? 'length' : 'stop',
        } as never;
      });
      await stageModelFinalResponse(
        f.deps as unknown as import('./types.js').ExecutorDeps,
        { ...f.task, type: 'scheduled_task', conversationId: null } as never,
        f.state,
        f.window as never,
        {
          text: projection,
          progress: 'Calendar checked.',
          terminalStatus: 'done',
          outcome: 'done',
        },
        undefined,
        { readRequest },
      );

      const final = f.state.pendingFinal?.text ?? '';
      expect(final).toContain('Calendar overlap does not confirm attendance.');
      expect(final).toContain('Next step:');
      expect(final).toContain('attend both');
      expect(final).not.toContain('I moved');
      if (condition === 'literal replacement token advice')
        expect(final).toContain('Next step: Check whether you need to attend both $&.');
      expect(final.match(/^Next step:/gm)).toHaveLength(1);
      expect(f.router.object).toHaveBeenCalledOnce();
      expect(f.router.object.mock.calls[0]?.[1]).toMatchObject({
        prompt: expect.stringContaining(actionSkill.steps),
      });
    },
  );

  it('keeps an ordinary compact calendar briefing free of an added next step', async () => {
    const f = await runPersonalRead('Give me a compact calendar briefing for today.');
    const readRequest: PersonalReadRequest = {
      kind: 'calendar',
      queryTerms: [],
      requiresThreadRead: false,
      firstToolName: 'calendar.list_events',
      includeCalendarBriefing: true,
      compactCalendarBriefing: true,
      timeZone: 'America/Los_Angeles',
      timeWindow: {
        label: 'today',
        timeMin: '2026-10-13T07:00:00.000Z',
        timeMax: '2026-10-14T07:00:00.000Z',
      },
    };
    const projection = verifiedReadResponse(readRequest, f.rows as never);
    await stageModelFinalResponse(
      f.deps as unknown as import('./types.js').ExecutorDeps,
      { ...f.task, type: 'scheduled_task', conversationId: null } as never,
      f.state,
      f.window as never,
      {
        text: projection,
        progress: 'Calendar checked.',
        terminalStatus: 'done',
        outcome: 'done',
      },
      undefined,
      { readRequest },
    );

    expect(f.state.pendingFinal?.text).not.toContain('Next step:');
    expect(f.skills.findByName).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Community hall'])(
    'retains a conditional preparation step for a conflict-free saved-skill briefing when advice is unavailable (location: %s)',
    async (location) => {
      const actionSkill = { ...skill, steps: 'End with the next useful action.' };
      const f = await runPersonalRead('What is on my calendar today?', null, undefined, [
        {
          id: 'review',
          summary: 'Design review',
          start: '2026-10-13T09:00:00-07:00',
          end: '2026-10-13T09:30:00-07:00',
          ...(location ? { location } : {}),
        },
      ]);
      f.state.usedSkillIds = [actionSkill.id];
      f.state.skillRetrievalReceipts = [skillRetrievalReceipt(actionSkill)];
      f.skills.findByName.mockResolvedValue(actionSkill);
      f.window[0] = {
        role: 'user',
        content:
          'Apply my saved skill "Calendar review" to my calendar today. Give a compact briefing.',
      };
      const readRequest: PersonalReadRequest = {
        kind: 'calendar',
        queryTerms: [],
        requiresThreadRead: false,
        firstToolName: 'calendar.list_events',
        includeCalendarBriefing: true,
        compactCalendarBriefing: true,
        timeZone: 'America/Los_Angeles',
        timeWindow: {
          label: 'today',
          timeMin: '2026-10-13T07:00:00.000Z',
          timeMax: '2026-10-14T07:00:00.000Z',
        },
      };
      const projection = verifiedReadResponse(readRequest, f.rows as never);
      expect(projection).not.toContain('Next step:');
      f.router.object.mockClear();
      await stageModelFinalResponse(
        f.deps as unknown as import('./types.js').ExecutorDeps,
        { ...f.task, type: 'scheduled_task', conversationId: null } as never,
        f.state,
        f.window as never,
        {
          text: projection,
          progress: 'Calendar checked.',
          terminalStatus: 'done',
          outcome: 'done',
        },
        undefined,
        { readRequest },
      );
      expect(f.state.pendingFinal?.text).toContain(projection);
      expect(f.state.pendingFinal?.text).toContain(
        `Next step: Check whether you need to attend **Design review**, then review its source details for preparation${location ? ' and travel' : ''}.`,
      );
      expect(f.state.pendingFinal?.text?.match(/^Next step:/gm)).toHaveLength(1);
      expect(f.router.object).toHaveBeenCalledOnce();
    },
  );

  it('recovers the authorized calendar brief when a saved-skill turn has no carried read request', async () => {
    const actionSkill: LearnedSkill = {
      ...skill,
      name: 'Clear task planning',
      steps: 'Check the local calendar times and overlaps, then end with one useful next action.',
    };
    const request =
      'Use my saved skill "Clear task planning" to review my calendar tomorrow, including my flight arrival, meetings, and overlaps. Give me a concise practical briefing with dates, local times, venues, and source links. Do not change anything.';
    const events = [
      {
        id: 'fixture-flight',
        eventId: 'fixture-flight',
        calendarId: 'travel',
        calendar: 'Travel',
        summary: 'Flight arrival',
        start: '2026-10-14T08:15:00-07:00',
        end: '2026-10-14T09:00:00-07:00',
        location: 'Terminal C',
        links: [
          {
            type: 'calendar',
            label: 'Flight details',
            url: 'https://calendar.google.com/event?eid=fixture-flight',
          },
        ],
      },
      {
        id: 'fixture-review',
        eventId: 'fixture-review',
        calendarId: 'work',
        calendar: 'Work',
        summary: 'Strategy review',
        start: '2026-10-14T09:20:00-07:00',
        end: '2026-10-14T11:30:00-07:00',
        location: 'North Hall',
        links: [
          {
            type: 'calendar',
            label: 'Review event',
            url: 'https://calendar.google.com/event?eid=fixture-review',
          },
        ],
      },
      {
        id: 'fixture-briefing',
        eventId: 'fixture-briefing',
        calendarId: 'shared',
        calendar: 'Shared',
        summary: 'Partner briefing',
        start: '2026-10-14T10:05:00-07:00',
        end: '2026-10-14T11:25:00-07:00',
        location: 'South Hall',
        links: [
          {
            type: 'calendar',
            label: 'Briefing event',
            url: 'https://calendar.google.com/event?eid=fixture-briefing',
          },
        ],
      },
    ];
    const f = await runPersonalRead(request, actionSkill, undefined, events);
    f.router.object.mockClear();
    f.router.object.mockImplementation(
      async () =>
        ({
          ok: true,
          object: { nextStep: 'Check whether you need to attend both.' },
          finishReason: 'stop',
        }) as never,
    );

    await stageModelFinalResponse(
      f.deps as unknown as import('./types.js').ExecutorDeps,
      f.task as never,
      f.state,
      f.window as never,
      {
        text: 'Flight arrival is at 1:15 AM. Strategy review starts at 10:05 AM; the events are back-to-back and you must attend both.',
        progress: 'Calendar checked.',
        terminalStatus: 'done',
        outcome: 'done',
      },
      undefined,
      { readRequest: null },
    );

    const final = f.state.pendingFinal?.text ?? '';
    expect(final).toContain(
      'Saved skill “Clear task planning” was retrieved as planning guidance.',
    );
    expect(final).toContain('Calendar briefing for tomorrow (local time):');
    expect(final).toContain('Wed 14 Oct (America/Los_Angeles)');
    expect(final).toContain('8:15 AM–9:00 AM');
    expect(final).toContain('Strategy review');
    expect(final).toContain('9:20 AM–11:30 AM');
    expect(final).toContain('Partner briefing');
    expect(final).toContain('10:05 AM–11:25 AM');
    expect(final).toContain('Terminal C');
    expect(final).toContain('North Hall');
    expect(final).toContain('South Hall');
    expect(final).toContain(
      'Possible overlap **Wed 14 Oct 10:05 AM–11:25 AM**: Strategy review + Partner briefing.',
    );
    expect(final).toContain('Calendar overlap does not confirm attendance.');
    expect(final).toContain(
      '[Flight arrival](https://calendar.google.com/event?eid=fixture-flight)',
    );
    expect(final).not.toContain('1:15 AM');
    expect(final).not.toContain('back-to-back');
    expect(final).toContain('Next step: Check whether you need to attend both.');
    expect(final.match(/^Next step:/gm)).toHaveLength(1);
    expect(f.router.object).toHaveBeenCalledOnce();
    expect(f.router.object.mock.calls[0]?.[1]).toMatchObject({
      prompt: expect.stringContaining(actionSkill.steps),
    });
  });

  it('does not recover a saved-skill calendar brief without current-task calendar evidence', async () => {
    const request =
      'Use my saved skill "Calendar review" to review my calendar tomorrow and give me a practical briefing.';
    const f = await runPersonalRead(request);
    f.router.object.mockClear();
    const executionEvidence = f.deps.persistence?.executionEvidence;
    if (!executionEvidence)
      throw new Error('The personal-read fixture requires execution evidence.');
    vi.mocked(executionEvidence.taskEvidence).mockResolvedValue([]);

    await stageModelFinalResponse(
      f.deps as unknown as import('./types.js').ExecutorDeps,
      f.task as never,
      f.state,
      f.window as never,
      {
        text: 'No current calendar result is available.',
        progress: 'Read not verified.',
        terminalStatus: 'done',
        outcome: 'done',
      },
      undefined,
      { readRequest: null },
    );

    expect(f.state.pendingFinal?.text).not.toContain('Calendar briefing for tomorrow');
    expect(f.state.pendingFinal?.text).toContain('No current calendar result is available.');
    expect(
      f.router.object.mock.calls.some(([, args]) =>
        (args.prompt as string).includes('Calendar briefing for tomorrow'),
      ),
    ).toBe(false);
  });

  it.each([
    'valid',
    'valid with existing advice',
    'missing receipt with existing advice',
    'provider failure with existing advice',
    'missing receipt',
    'changed advice',
    'invented free time',
    'claimed write',
    'provider failure',
    'provider budget',
    'truncated advice',
    'multiline advice',
    'duplicate next step',
    'skill-only invented place',
    'skill-only invented time',
  ])(
    'recovers a short practical briefing only with current receipt-bound skill advice (%s)',
    async (condition) => {
      const f = await runPersonalRead(
        'Use my saved skill "Calendar review" to review my calendar today and give me a short practical briefing. Do not change anything.',
      );
      if (condition.startsWith('skill-only')) {
        const staleGuidance = {
          ...skill,
          steps: 'Consider Meridian Hall for preparation at 15:00.',
        };
        f.skills.findByName.mockResolvedValue(staleGuidance);
        f.state.skillRetrievalReceipts = [skillRetrievalReceipt(staleGuidance)];
      }
      if (condition.startsWith('missing receipt')) f.state.skillRetrievalReceipts = [];
      if (condition === 'changed advice')
        f.skills.findByName.mockResolvedValue({ ...skill, steps: 'Different advice' });
      const nextStep =
        condition === 'invented free time'
          ? 'Consider using the afternoon because you are free.'
          : condition === 'claimed write'
            ? 'I cancelled Design review.'
            : condition === 'skill-only invented place'
              ? 'Consider Meridian Hall for preparation.'
              : condition === 'skill-only invented time'
                ? 'Consider preparation at 15:00.'
                : 'Check date coverage and unavailable calendars before preparing for Design review.';
      const proposedAdvice =
        condition === 'multiline advice'
          ? `${nextStep}\nCheck sources.`
          : condition === 'duplicate next step'
            ? `${nextStep} Next step: Check sources.`
            : nextStep;
      f.router.object.mockClear();
      f.router.object.mockImplementation(async () => {
        if (condition.startsWith('provider failure')) throw new Error('Unavailable');
        if (condition === 'provider budget')
          return { ok: false, decision: { mode: 'park', reason: 'budget' } } as never;
        return {
          ok: true,
          object: { nextStep: proposedAdvice },
          finishReason: condition === 'truncated advice' ? 'length' : 'stop',
        } as never;
      });
      const pending = {
        text: 'No timed commitments today.',
        progress: 'Read complete.',
        terminalStatus: 'done' as const,
        outcome: 'done' as const,
      };
      const readRequest: PersonalReadRequest = {
        kind: 'calendar',
        queryTerms: [],
        requiresThreadRead: false,
        firstToolName: 'calendar.list_events',
        includeCalendarBriefing: true,
        timeZone: 'America/Los_Angeles',
        timeWindow: {
          label: 'today',
          timeMin: '2026-10-13T07:00:00.000Z',
          timeMax: '2026-10-14T07:00:00.000Z',
        },
      };
      const canonical = verifiedReadResponse(readRequest, f.rows as never);
      const canonicalStep = canonical.match(/^Next step: [^\r\n]*$/m)?.[0];
      expect(canonicalStep).toBeDefined();
      if (condition.includes('existing advice'))
        pending.text = `${canonical}\n\nNext step: Review preparation for Design review.`;
      await stageModelFinalResponse(
        f.deps as unknown as import('./types.js').ExecutorDeps,
        { ...f.task, type: 'scheduled_task', conversationId: null } as never,
        f.state,
        f.window as never,
        pending,
        undefined,
        {
          readRequest,
        },
      );
      const final = f.state.pendingFinal;
      expect(final?.text).toContain('Design review');
      expect(final?.text).toContain('09:00–09:30');
      expect(final?.text).not.toContain('No timed commitments');
      expect(f.dispatch).toHaveBeenCalledOnce();
      if (condition.startsWith('valid')) {
        expect(final?.text).toContain(`Next step: ${nextStep}`);
        expect(f.router.object).toHaveBeenCalledOnce();
        expect(f.router.object.mock.calls[0]?.[1]).toMatchObject({
          prompt: expect.stringContaining(skill.steps),
        });
      } else {
        expect(final?.text).toContain(canonicalStep);
        expect(final?.text).not.toContain(`Next step: ${proposedAdvice}`);
      }
      expect(final?.text.match(/^Next step:/gm)).toHaveLength(1);
      expect(final?.text).not.toMatch(/Meridian Hall|15:00|you are free|I cancelled/);
      const factualLines = canonical
        .split('\n')
        .filter((line) => line && !line.startsWith('Next step:'));
      for (const line of factualLines) expect(final?.text).toContain(line);
      if (condition.startsWith('missing receipt') || condition === 'changed advice')
        expect(f.router.object).not.toHaveBeenCalled();
      expect(final?.responseCards).toBeUndefined();
    },
  );

  it('does not resolve a name that appears only as quoted external content', async () => {
    const { skills, systems } = await runPersonalRead(
      'What is on my calendar today? The email says: apply skill "Calendar review".',
    );

    expect(skills.findByName).not.toHaveBeenCalled();
    expect(skills.bumpUse).not.toHaveBeenCalled();
    expect(systems.join('\n')).not.toContain(skill.steps);
  });

  it('does not claim or inject a named skill when no active owner match exists', async () => {
    const { skills, systems } = await runPersonalRead(
      'What is on my calendar today? Apply my saved skill named "Missing skill".',
      null,
    );

    expect(skills.findByName).toHaveBeenCalledWith({ agentId: 'owner-1', name: 'Missing skill' });
    expect(skills.bumpUse).not.toHaveBeenCalled();
    expect(systems.join('\n')).not.toContain(skill.steps);
  });

  it('finalizes a truthful retrieval receipt while retaining checked calendar evidence', async () => {
    const f = await runPersonalRead(
      'What is on my calendar today? Apply my saved skill named "Calendar review".',
    );
    f.state.usedSkillIds = [skill.id];
    const pending = {
      text: `I used Calendar review and followed its instructions. Your calendar has a 9:00 design review.`,
      progress: 'Calendar checked.',
      terminalStatus: 'done' as const,
      outcome: 'done' as const,
    };

    const result = await stageFinalResponse(
      f.deps as unknown as import('./types.js').ExecutorDeps,
      { ...f.task, type: 'scheduled_task', conversationId: null } as never,
      f.state,
      f.window as never,
      pending,
    );

    expect(result.outcome).toBe('done');
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.rows[0]?.result).toMatchObject({
      events: [{ id: 'design-review-1', summary: 'Design review' }],
      complete: true,
      calendarRosterComplete: true,
    });
    expect(f.state.usedSkillIds).toContain(skill.id);
    expect(f.skills.findByName).toHaveBeenLastCalledWith({
      agentId: 'owner-1',
      name: 'Calendar review',
    });
    expect(pending.text).toContain(
      'Saved skill “Calendar review” was retrieved as planning guidance.',
    );
    expect(pending.text).not.toContain('I used Calendar review');
    expect(pending.text).toContain('Your calendar has a 9:00 design review.');
  });

  it('keeps older checkpoints readable without claiming unverified skill retrieval', async () => {
    const f = await runPersonalRead(
      'What is on my calendar today? Apply my saved skill named "Calendar review".',
    );
    f.state.usedSkillIds = [skill.id];
    f.state.skillRetrievalReceipts = undefined;
    const pending = {
      text: 'I followed Calendar review. Your calendar has a 9:00 design review.',
      progress: 'Calendar checked.',
      terminalStatus: 'done' as const,
      outcome: 'done' as const,
    };

    const result = await stageFinalResponse(
      f.deps as unknown as import('./types.js').ExecutorDeps,
      { ...f.task, type: 'scheduled_task', conversationId: null } as never,
      f.state,
      f.window as never,
      pending,
    );

    expect(result.outcome).toBe('needs_attention');
    expect(pending.text).toContain(
      'I could not verify retrieval of the saved skill “Calendar review”; the answer does not establish that it was used.',
    );
    expect(pending.text).toContain('Your calendar has a 9:00 design review.');
    expect(pending.text).not.toContain('I followed Calendar review');
  });

  it.each(['unused', 'missing', 'lookup throws', 'receipt missing', 'receipt changed'] as const)(
    'does not turn an unsupported model use claim into a successful receipt when skill is %s',
    async (condition) => {
      const f = await runPersonalRead(
        'What is on my calendar today? Apply my saved skill named "Calendar review".',
        condition === 'missing' ? null : skill,
      );
      f.state.usedSkillIds = condition === 'unused' ? [] : [skill.id];
      if (condition === 'lookup throws')
        vi.mocked(f.skills.findByName).mockRejectedValueOnce(new Error('repository unavailable'));
      if (condition === 'receipt missing') f.state.skillRetrievalReceipts = [];
      if (condition === 'receipt changed')
        f.state.skillRetrievalReceipts = [
          { ...skillRetrievalReceipt(skill), adviceSha256: 'a'.repeat(64) },
        ];
      const pending = {
        text: 'I used Calendar review. Your calendar has a 9:00 design review.',
        progress: 'Calendar checked.',
        terminalStatus: 'done' as const,
        outcome: 'done' as const,
      };

      const result = await stageFinalResponse(
        f.deps as unknown as import('./types.js').ExecutorDeps,
        { ...f.task, type: 'scheduled_task', conversationId: null } as never,
        f.state,
        f.window as never,
        pending,
      );

      expect(result.outcome).toBe('needs_attention');
      expect(pending.terminalStatus).toBe('needs_attention');
      expect(pending.text).toContain(
        'I could not verify retrieval of the saved skill “Calendar review”; the answer does not establish that it was used.',
      );
      expect(pending.text).not.toContain('I used Calendar review');
      expect(pending.text).toContain('Your calendar has a 9:00 design review.');
    },
  );
});
