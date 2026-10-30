import { createHash, randomUUID } from 'node:crypto';
import type { TaskRow } from '@assistant/db';
import type { ExecutionPersistence, Records } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TaskStateSchema } from '../../events.js';
import { PublicActivityScopeDataSchema } from '../active-read-intent.js';
import { executeTask } from '../executor.js';
import type { ExecutorDeps } from './types.js';

const requestAt = new Date('2026-10-24T06:30:00.000Z'); // October 23 in the owner's timezone.
const zone = 'America/Los_Angeles';
const url = 'https://events.example.test/art-walk';
const listing =
  'San Francisco October 24, 2026. Art Walk at Secret Hall, 10:00 am. Admission $15. Sold out.';
type Evidence = {
  id: string;
  taskId: string;
  toolName: string;
  status: string;
  args: Record<string, unknown>;
  result: unknown;
  step: number;
  error?: string;
};
type Mode = 'matching' | 'snippet' | 'wrong-city' | 'wrong-year' | 'failed';

/** Only persistence and external transports are synthetic; executor, admission, routing and finalization are real. */
function fixture(mode: Mode = 'matching') {
  const agentId = randomUUID(),
    conversationId = randomUUID();
  const tasks = new Map<string, TaskRow>();
  const messages: Records['messages'][] = [];
  const ledger: Evidence[] = [];
  const dispatched: Array<{
    taskId: string;
    toolName: string;
    args: Record<string, unknown>;
    scopes: string[];
  }> = [];
  const checkpoints: Array<{ taskId: string; state: Record<string, unknown> }> = [];
  const forbidden = vi.fn((name: string): never => {
    throw new Error(`Forbidden private/database/provider fallback: ${name}`);
  });
  const db = new Proxy({}, { get: (_target, key) => forbidden(`db.${String(key)}`) });
  const commitmentReads = vi.fn(async () => []);
  const router = {
    object: vi.fn(async (role: string, _input: { taskId: string }) => {
      if (role === 'classify') return { ok: true, object: { trivial: false } };
      if (role === 'plan')
        return {
          ok: true,
          object: {
            action: 'workflow',
            reasoning: 'Search public listings.',
            steps: ['Read public web sources.'],
            missingInfo: [],
          },
        };
      if (role === 'rewrite')
        return { ok: false, decision: { mode: 'block', reason: 'Synthetic verifier unavailable' } };
      return forbidden(`router.object.${role}`);
    }),
    step: vi.fn(async () => forbidden('router.step')),
    embed: vi.fn(async () => forbidden('router.embed')),
  };
  const append = async (input: Record<string, unknown>) => {
    const row = {
      id: randomUUID(),
      hiddenAt: null,
      createdAt: requestAt,
      ...input,
    } as unknown as Records['messages'];
    messages.push(row);
    return row;
  };
  const executionContext = {
    kind: 'execution-context-repository',
    getAgent: async (id: string) =>
      id === agentId ? { id: agentId, name: 'Synthetic owner', timezone: zone } : null,
    getTask: async (owner: string, id: string) =>
      owner === agentId ? (tasks.get(id) ?? null) : null,
    getOwnerMessage: async (input: {
      agentId: string;
      conversationId: string;
      messageId: string;
    }) =>
      input.agentId === agentId && input.conversationId === conversationId
        ? (messages.find(
            (row) =>
              row.id === input.messageId &&
              row.role === 'user' &&
              row.origin === 'owner' &&
              row.hiddenAt === null,
          ) ?? null)
        : null,
    seedHistory: async (input: {
      agentId: string;
      conversationId: string;
      throughMessageId?: string;
      limit: number;
    }) => {
      expect(input.agentId).toBe(agentId);
      expect(input.conversationId).toBe(conversationId);
      const through = input.throughMessageId
        ? messages.findIndex((row) => row.id === input.throughMessageId)
        : messages.length - 1;
      return messages.slice(0, through + 1).slice(-input.limit);
    },
    noticeIds: async () => new Set<string>(),
    getLatestOwnerReplyCursor: async () => {
      const latest = messages.filter((row) => row.role === 'user' && row.origin === 'owner').at(-1);
      return { cursor: latest ? { createdAt: latest.createdAt, id: latest.id } : null };
    },
    getLatestOwnerMessage: async () =>
      messages.filter((row) => row.role === 'user' && row.origin === 'owner').at(-1) ?? null,
    getOwnerRepliesAfter: async (input: { after: { createdAt: Date }; limit?: number }) =>
      messages
        .filter(
          (row) =>
            row.role === 'user' &&
            row.origin === 'owner' &&
            row.hiddenAt === null &&
            row.createdAt > input.after.createdAt,
        )
        .slice(0, input.limit ?? 40),
  };
  const evidence = {
    kind: 'execution-evidence-repository',
    taskEvidence: async (input: { agentId: string; taskId: string }) => {
      expect(input.agentId).toBe(agentId);
      return ledger.filter((row) => row.taskId === input.taskId);
    },
    conversationEvidence: async () => forbidden('conversationEvidence'),
    hasConversationToolCall: async () => false,
    finalMessageExists: async (input: { taskId: string }) =>
      messages.some((row) => row.taskId === input.taskId && row.role === 'assistant'),
    hasOutboundReply: async () => false,
    checklistDecisions: async () => [],
    recordResponseCheck: async () => true,
  };
  const taskRepository = {
    kind: 'task-lease-repository',
    claim: async (id: string) => {
      const task = tasks.get(id);
      if (task?.status !== 'pending') return null;
      Object.assign(task, {
        status: 'running',
        leaseToken: randomUUID(),
        lockedUntil: new Date(Date.now() + 60000),
      });
      return task;
    },
    renew: async () => true,
    checkpoint: async (task: TaskRow, state: unknown) => {
      task.state = structuredClone(state) as TaskRow['state'];
      checkpoints.push({
        taskId: task.id,
        state: structuredClone(state) as Record<string, unknown>,
      });
      return true;
    },
    persistPlan: async (task: TaskRow, plan: unknown) => {
      task.plan = plan;
      return true;
    },
    completeTask: async (task: TaskRow, outcome: { status: TaskRow['status'] }) => {
      task.status = outcome.status;
      return true;
    },
    markTaskNeedsAttention: async (task: TaskRow) => {
      task.status = 'needs_attention';
      return true;
    },
    markAttentionNotified: async () => true,
    recordFailedAttempt: async (_task: TaskRow, error: string) => {
      throw new Error(error);
    },
  };
  const persistence = {
    driver: 'firestore',
    tasks: taskRepository,
    messages: { kind: 'message-repository', append },
    executionContext,
    executionEvidence: evidence,
    executionJobs: {},
    notifications: {},
    ownerContext: { kind: 'owner-context-repository', listOpenCommitments: commitmentReads },
    skills: {
      kind: 'skill-context-repository',
      recall: async () => [],
      findByName: async () => null,
      bumpUse: async () => {},
      recordOutcome: async () => {},
    },
  } as unknown as ExecutionPersistence;
  const dispatcher = {
    toolDefs: () =>
      ['web.search', 'web.fetch', 'calendar.list_events', 'gmail.search', 'memory.recall'].map(
        (name) => ({
          name,
          description: 'Synthetic transport',
          inputSchema: z.object({}).passthrough(),
        }),
      ),
    resultIsUntrusted: () => true,
    dispatch: async (input: {
      task: TaskRow;
      step: number;
      toolName: string;
      args: Record<string, unknown>;
      ctx: { ownerIntent?: { authorizedScopes: string[] } };
    }) => {
      dispatched.push({
        taskId: input.task.id,
        toolName: input.toolName,
        args: input.args,
        scopes: input.ctx.ownerIntent?.authorizedScopes ?? [],
      });
      let result: unknown;
      if (input.toolName === 'web.search')
        result = { results: [{ url, title: 'Art Walk', snippet: listing }] };
      else if (input.toolName === 'web.fetch')
        result = {
          status: 200,
          url,
          finalUrl: url,
          title: 'Art Walk',
          text:
            mode === 'snippet'
              ? ''
              : mode === 'wrong-city'
                ? listing.replace('San Francisco', 'Seattle')
                : mode === 'wrong-year'
                  ? listing.replace('2026', '2025')
                  : listing,
          truncated: false,
        };
      else if (
        input.toolName === 'calendar.list_events' &&
        input.ctx.ownerIntent?.authorizedScopes.includes('private_read')
      )
        result = {
          events: [],
          complete: true,
          calendarRosterComplete: true,
          unavailable: [],
          calendarsResolved: [{ id: 'primary', name: 'Owner' }],
        };
      else return forbidden(input.toolName);
      const failed = mode === 'failed' && input.toolName === 'web.fetch';
      const row: Evidence = {
        id: randomUUID(),
        taskId: input.task.id,
        toolName: input.toolName,
        args: input.args,
        step: input.step,
        status: failed ? 'failed' : 'succeeded',
        result: failed ? null : result,
        ...(failed ? { error: 'Synthetic fetch failure' } : {}),
      };
      ledger.push(row);
      return failed
        ? { kind: 'failed' as const, toolCallId: row.id, error: row.error }
        : { kind: 'executed' as const, toolCallId: row.id, result, cached: false };
    },
  };
  const deps = { db, persistence, router, dispatcher } as unknown as ExecutorDeps;
  async function turn(text: string, createdAt: Date = requestAt) {
    const id = randomUUID();
    const ownerMessage = await append({
      conversationId,
      taskId: id,
      role: 'user',
      origin: 'owner',
      createdAt,
      text,
      parts: [{ type: 'text', text }],
    });
    const task = {
      id,
      agentId,
      conversationId,
      type: 'chat_turn',
      trust: 'owner',
      status: 'pending',
      createdAt,
      trigger: {
        source: 'chat',
        agentId,
        conversationId,
        trust: 'owner',
        payload: { text, triggerMessageId: ownerMessage.id },
      },
      state: {},
      maxSteps: 8,
      attempt: 1,
      queueGeneration: 1,
      goalId: null,
      parentTaskId: null,
      plan: null,
    } as unknown as TaskRow;
    tasks.set(id, task);
    const result = await executeTask(deps, id);
    const reply = messages.filter((row) => row.taskId === id && row.role === 'assistant').at(-1);
    return {
      id,
      task,
      result,
      reply,
      calls: dispatched.filter((call) => call.taskId === id),
      objectRoles: router.object.mock.calls
        .filter((call) => call[1].taskId === id)
        .map((call) => call[0]),
    };
  }
  return {
    turn,
    ledger,
    messages,
    tasks,
    dispatched,
    checkpoints,
    forbidden,
    commitmentReads,
    router,
    agentId,
    conversationId,
  };
}

describe('admitted public city events through the complete offline executor', () => {
  it('keeps verified persisted owner followups public and binds today/weekend/city/date corrections to local time', async () => {
    const f = fixture();
    const initial = await f.turn('Is there anything happening in San Francisco today?');
    expect(
      initial.reply,
      JSON.stringify({
        result: initial.result,
        status: initial.task.status,
        calls: initial.calls,
        state: initial.task.state,
      }),
    ).toBeDefined();
    expect(initial.reply?.text).toContain('2026-10-23');
    const clarified = await f.turn('I mean city events I could attend; my weekend is empty.');
    expect(clarified.reply?.text).toContain('2026-10-24');
    const terse = await f.turn('Search for events for me.');
    expect(terse.calls.map((call) => call.toolName)).toEqual(['web.search', 'web.fetch']);
    expect(terse.calls[0]?.args).toMatchObject({ query: expect.stringContaining('San Francisco') });
    expect(terse.reply?.text).toContain('[Art Walk]');
    expect(terse.reply?.text).toMatch(
      /occurrences, times, venues, admission prices.*availability remain unverified/,
    );
    expect(terse.reply?.text).not.toMatch(/Secret Hall|10:00|\$15|Sold out|PRIVATE_/);
    expect(terse.result.outcome).toBe('needs_attention');
    const scope = PublicActivityScopeDataSchema.parse(
      TaskStateSchema.parse(terse.task.state).plannerState.publicActivityScope,
    );
    expect(scope).toMatchObject({
      conversationId: f.conversationId,
      location: { label: 'San Francisco' },
      civilWindow: { startDate: '2026-10-24', endDateExclusive: '2026-10-26' },
      clock: { referenceAt: requestAt.toISOString(), timeZone: zone, source: 'task_created_at' },
      provenance: {
        agentId: f.agentId,
        conversationId: f.conversationId,
        taskId: terse.id,
        requestHash: createHash('sha256').update('Search for events for me.').digest('hex'),
      },
    });
    expect(scope.requestMessageId).toBe(scope.provenance.triggerMessageId);
    expect(scope.basisMessageIds).toContain(scope.requestMessageId);
    expect(terse.reply?.text?.length).toBeLessThan(1000);
    expect(terse.objectRoles).not.toContain('rewrite');
    const changed = await f.turn('Instead, find public events in Seattle tomorrow.');
    expect(changed.calls[0]?.args).toMatchObject({ query: expect.stringContaining('Seattle') });
    expect(changed.calls[0]?.args).toMatchObject({ query: expect.stringContaining('2026-10-24') });
    expect(changed.reply?.text).not.toContain('[Art Walk]');
    expect(f.dispatched.every((call) => /^web\.(search|fetch)$/.test(call.toolName))).toBe(true);
    expect(f.dispatched.every((call) => call.scopes.join(',') === 'external_read')).toBe(true);
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.commitmentReads).not.toHaveBeenCalled();
    expect(f.router.step).not.toHaveBeenCalled();
  });

  it('applies a supported free-outdoor filter to a linked public followup without private reads', async () => {
    const f = fixture();
    const first = await f.turn('Find public events in San Francisco this weekend.');
    expect(first.calls.map((call) => call.toolName)).toEqual(['web.search', 'web.fetch']);
    const refined = await f.turn('Only free outdoor things.');
    expect(refined.calls.map((call) => call.toolName)).toEqual(['web.search', 'web.fetch']);
    expect(refined.calls[0]?.args.query).toContain('San Francisco');
    expect(refined.calls[0]?.args.query).toContain('2026-10-24 to before 2026-10-26');
    expect(refined.calls[0]?.args.query).toContain('free admission');
    expect(refined.calls[0]?.args.query).toContain('outdoor activities');
    const scope = PublicActivityScopeDataSchema.parse(
      TaskStateSchema.parse(refined.task.state).plannerState.publicActivityScope,
    );
    expect(scope.filters).toEqual([
      { kind: 'free', value: 'free admission', basisMessageId: expect.any(String) },
      { kind: 'category', value: 'outdoor activities', basisMessageId: expect.any(String) },
    ]);
    expect(scope.sourceExclusions).toEqual(['calendar', 'mail']);
    expect(refined.reply?.text).not.toMatch(/Secret Hall|10:00|\$15|Sold out|PRIVATE_/);
    expect(f.dispatched.every((call) => /^web\.(search|fetch)$/.test(call.toolName))).toBe(true);
    expect(f.dispatched.every((call) => call.scopes.join(',') === 'external_read')).toBe(true);
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.commitmentReads).not.toHaveBeenCalled();
    expect(f.router.step).not.toHaveBeenCalled();
  });

  it.each(['snippet', 'wrong-city', 'wrong-year', 'failed'] as const)(
    'rejects %s evidence without private fallback',
    async (mode) => {
      const f = fixture(mode);
      const result = await f.turn('Find public events in San Francisco this weekend.');
      expect(result.reply?.text).not.toMatch(/\[Art Walk\]|Secret Hall|10:00|\$15|Sold out/);
      expect(result.reply?.text).toMatch(
        /could not verify|couldn.t|unverified|could not complete/i,
      );
      expect(result.calls.map((call) => call.toolName)).toEqual(['web.search', 'web.fetch']);
      expect(f.forbidden).not.toHaveBeenCalled();
      expect(f.commitmentReads).not.toHaveBeenCalled();
      expect(f.router.step).not.toHaveBeenCalled();
    },
  );

  it('re-anchors DST date correction to each persisted task and excludes stale/private history', async () => {
    const f = fixture();
    const oldTaskId = randomUUID();
    f.ledger.push({
      id: randomUUID(),
      taskId: oldTaskId,
      toolName: 'web.fetch',
      args: { url },
      status: 'succeeded',
      step: 1,
      result: { title: 'STALE_CANARY', url, text: listing },
    });
    f.messages.push({
      id: randomUUID(),
      conversationId: f.conversationId,
      taskId: oldTaskId,
      role: 'assistant',
      origin: 'assistant',
      text: 'PRIVATE_PRIOR_ASSISTANT_CANARY',
      hiddenAt: null,
      parts: [],
      createdAt: new Date('2026-10-31T05:00:00.000Z'),
    } as Records['messages']);

    const beforeFallback = new Date('2026-11-01T06:30:00.000Z');
    const first = await f.turn('Find public events in San Francisco this weekend.', beforeFallback);
    const firstScope = PublicActivityScopeDataSchema.parse(
      TaskStateSchema.parse(first.task.state).plannerState.publicActivityScope,
    );
    expect(first.task.createdAt.toISOString()).toBe(beforeFallback.toISOString());
    expect(firstScope).toMatchObject({
      civilWindow: { startDate: '2026-10-31', endDateExclusive: '2026-11-02' },
      clock: {
        referenceAt: beforeFallback.toISOString(),
        timeZone: zone,
        source: 'task_created_at',
      },
    });
    expect(first.calls.map((call) => call.toolName)).toEqual(['web.search', 'web.fetch']);
    expect(first.calls.every((call) => call.scopes.join(',') === 'external_read')).toBe(true);
    expect(first.calls[0]?.args.query).toContain('2026-10-31 to before 2026-11-02');
    expect(first.reply?.text).not.toMatch(/STALE_CANARY|PRIVATE_/);

    const afterFallback = new Date('2026-11-01T09:30:00.000Z');
    const corrected = await f.turn('2026-11-07 instead', afterFallback);
    const correctedScope = PublicActivityScopeDataSchema.parse(
      TaskStateSchema.parse(corrected.task.state).plannerState.publicActivityScope,
    );
    expect(corrected.task.createdAt.toISOString()).toBe(afterFallback.toISOString());
    expect(correctedScope).toMatchObject({
      civilWindow: { startDate: '2026-11-07', endDateExclusive: '2026-11-08' },
      clock: {
        referenceAt: afterFallback.toISOString(),
        timeZone: zone,
        source: 'task_created_at',
      },
    });
    expect(corrected.calls.map((call) => call.toolName)).toEqual(['web.search', 'web.fetch']);
    expect(corrected.calls.every((call) => call.scopes.join(',') === 'external_read')).toBe(true);
    expect(corrected.calls[0]?.args.query).toContain('2026-11-07 to before 2026-11-08');
    expect(corrected.reply?.text).not.toMatch(/STALE_CANARY|PRIVATE_/);
    expect(f.dispatched.every((call) => /^web\.(search|fetch)$/.test(call.toolName))).toBe(true);
    expect(f.router.step).not.toHaveBeenCalled();
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.commitmentReads).not.toHaveBeenCalled();
  });

  it.each(['matching', 'failed'] as const)(
    'clarifies an earlier comparison after %s public evidence without claiming prior verification state',
    async (mode) => {
      const f = fixture(mode);
      const first = await f.turn('Find public events in San Francisco this weekend.');
      expect(first.calls.map((call) => call.toolName)).toEqual(['web.search', 'web.fetch']);
      if (mode === 'matching') {
        expect(first.reply?.text).toContain('[Art Walk]');
        expect(first.reply?.text).toMatch(
          /occurrences, times, venues, admission prices.*availability remain unverified/,
        );
      } else {
        expect(first.reply?.text).not.toContain('[Art Walk]');
      }
      expect(first.reply?.text).not.toMatch(/Secret Hall|10:00|\$15|Sold out/);

      const dispatchCount = f.dispatched.length;
      const ledgerCount = f.ledger.length;
      const followup = await f.turn('Anything earlier?');
      expect(followup.result.outcome).toBe('done');
      expect(followup.reply?.text).toBe('Which event or time should I compare against?');
      expect(followup.reply?.text).not.toContain('[Art Walk]');
      expect(followup.calls).toEqual([]);
      expect(followup.objectRoles).toEqual([]);
      expect(f.dispatched).toHaveLength(dispatchCount);
      expect(f.ledger).toHaveLength(ledgerCount);
      expect(f.ledger.filter((row) => row.taskId === followup.id)).toEqual([]);
      expect(f.router.step).not.toHaveBeenCalled();
      expect(f.router.embed).not.toHaveBeenCalled();
      expect(f.forbidden).not.toHaveBeenCalled();
      expect(f.commitmentReads).not.toHaveBeenCalled();
    },
  );

  it('excludes prior-task successful pages and private history, and performs a fresh current-task search', async () => {
    const f = fixture('snippet');
    const oldTaskId = randomUUID();
    f.ledger.push({
      id: randomUUID(),
      taskId: oldTaskId,
      toolName: 'web.fetch',
      args: { url },
      status: 'succeeded',
      step: 1,
      result: { title: 'STALE_CANARY', url, text: listing },
    });
    f.messages.push({
      id: randomUUID(),
      conversationId: f.conversationId,
      taskId: oldTaskId,
      role: 'assistant',
      origin: 'assistant',
      text: 'PRIVATE_PRIOR_ASSISTANT_CANARY',
      hiddenAt: null,
      parts: [],
      createdAt: requestAt,
    } as Records['messages']);
    const result = await f.turn('Find public events in San Francisco this weekend.');
    expect(result.calls.map((call) => call.toolName)).toEqual(['web.search', 'web.fetch']);
    expect(result.reply?.text).not.toMatch(/STALE_CANARY|PRIVATE_|\[Art Walk\]/);
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.commitmentReads).not.toHaveBeenCalled();
  });

  // PR693's shared explicit-commitment gate must preserve the calendar-only source boundary.
  it('requires a distinct explicit private request and reads only the calendar asked for', async () => {
    const f = fixture();
    await f.turn('Find public events in San Francisco this weekend.');
    const privateTurn = await f.turn('What is on my calendar today?');
    expect(privateTurn.calls.map((call) => call.toolName)).toEqual(['calendar.list_events']);
    expect(privateTurn.calls[0]?.scopes).toContain('private_read');
    expect(privateTurn.reply?.text).toBeDefined();
    expect(privateTurn.reply?.text).not.toContain('[Art Walk]');
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.commitmentReads).not.toHaveBeenCalled();
  });
});
