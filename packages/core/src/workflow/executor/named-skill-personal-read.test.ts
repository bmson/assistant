import type { LearnedSkill, SkillContextRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '../../events.js';
import { TaskStateSchema } from '../../events.js';
import { skillRetrievalReceipt } from '../../memory/skills.js';
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

async function runPersonalRead(request: string, foundSkill: LearnedSkill | null = skill) {
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
        events: [
          {
            id: 'design-review-1',
            summary: 'Design review',
            start: '2026-10-13T09:00:00-07:00',
            end: '2026-10-13T09:30:00-07:00',
          },
        ],
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
    persistence: { tasks, executionEvidence: evidence, skills },
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

  it.each([
    'valid',
    'missing receipt',
    'changed advice',
    'invented free time',
    'claimed write',
    'provider failure',
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
      if (condition === 'missing receipt') f.state.skillRetrievalReceipts = [];
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
      f.router.object.mockClear();
      f.router.object.mockImplementation(async () => {
        if (condition === 'provider failure') throw new Error('Unavailable');
        return { ok: true, object: { nextStep }, finishReason: 'stop' } as never;
      });
      const pending = {
        text: 'No timed commitments today.',
        progress: 'Read complete.',
        terminalStatus: 'done' as const,
        outcome: 'done' as const,
      };
      await stageModelFinalResponse(
        f.deps as unknown as import('./types.js').ExecutorDeps,
        { ...f.task, type: 'scheduled_task', conversationId: null } as never,
        f.state,
        f.window as never,
        pending,
        undefined,
        {
          readRequest: {
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
          },
        },
      );
      const final = f.state.pendingFinal;
      expect(final?.text).toContain('Design review');
      expect(final?.text).toContain('09:00–09:30');
      expect(final?.text).not.toContain('No timed commitments');
      expect(f.dispatch).toHaveBeenCalledOnce();
      if (condition === 'valid') {
        expect(final?.text).toContain(`Next step: ${nextStep}`);
        expect(f.router.object).toHaveBeenCalledOnce();
        expect(f.router.object.mock.calls[0]?.[1]).toMatchObject({
          prompt: expect.stringContaining(skill.steps),
        });
      } else expect(final?.text).not.toContain('Next step:');
      if (condition === 'missing receipt' || condition === 'changed advice')
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
