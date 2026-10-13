import type { LearnedSkill, SkillContextRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '../../events.js';
import { TaskStateSchema } from '../../events.js';
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
    object: vi.fn(async () => {
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
        events: [],
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
  return { result, skills, systems, router, dispatch, state };
}

describe('named saved skill use during a personal read', () => {
  it('retrieves the exact owner skill as advice without opening a write capability', async () => {
    const { skills, systems, router, dispatch } = await runPersonalRead(
      'What is on my calendar today? Apply my saved skill named "Calendar review".',
    );

    expect(skills.findByName).toHaveBeenCalledWith({ agentId: 'owner-1', name: 'Calendar review' });
    expect(skills.recall).not.toHaveBeenCalled();
    expect(skills.bumpUse).toHaveBeenCalledWith({ agentId: 'owner-1', ids: [skill.id] });
    expect(systems.join('\n')).toContain(skill.steps);
    expect(systems.join('\n')).toContain('ADVICE');
    expect(dispatch.mock.calls.map(([call]) => call.toolName)).toEqual(['calendar.list_events']);
    expect(router.step).toHaveBeenCalledTimes(1);
  });

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
});
