import { randomUUID } from 'node:crypto';
import {
  conversations,
  createDb,
  createPostgresExecutionPersistence,
  createPostgresTaskRepository,
  type Db,
  messages,
  tasks,
  toolCalls,
} from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { taskState } from '../machine.js';
import type { RunContext } from './phases.js';
import { runStepLoop } from './step-loop.js';
import type { ExecutorDeps } from './types.js';

const databaseUrl = process.env.DATABASE_URL;
assertAllocatedTestTarget({
  databaseUrl,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: 'standard',
});

describe('named-person calendar through allocated PostgreSQL executor', () => {
  let db: Db;
  beforeAll(() => {
    if (!databaseUrl) throw new Error('Allocated test database missing');
    db = createDb(databaseUrl);
  });
  afterAll(async () => {
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  });

  it('persists the exact two-page read and honest final inside the task step budget', async () => {
    const agent = await db.query.agents.findFirst();
    if (!agent) throw new Error('Allocator fixture agent missing');
    const agentId = agent.id;
    const conversationId = randomUUID();
    const taskId = randomUUID();
    const request = 'What is Alex doing next weekend?';
    await db.insert(conversations).values({
      id: conversationId,
      agentId,
      channel: 'chat',
      trust: 'owner',
      title: 'Synthetic person calendar',
    });
    await db.insert(tasks).values({
      id: taskId,
      agentId,
      conversationId,
      type: 'chat_turn',
      status: 'pending',
      trust: 'owner',
      createdAt: new Date('2026-10-15T19:00:00Z'),
      maxSteps: 4,
      budgetUsdLimit: '0.0500',
      trigger: {
        source: 'chat',
        agentId,
        conversationId,
        trust: 'owner',
        payload: { text: request },
      },
      state: {},
    });
    await db.insert(messages).values({
      conversationId,
      taskId,
      role: 'user',
      origin: 'owner',
      text: request,
      parts: [{ type: 'text', text: request }],
    });
    const repository = createPostgresTaskRepository(db);
    const lease = await repository.claim(taskId);
    if (!lease) throw new Error('Allocated task lease missing');
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const dispatcher = {
      toolDefs: () => [
        { name: 'calendar.list_events', description: 'Synthetic local fixture', inputSchema: {} },
      ],
      resultIsUntrusted: () => true,
      executeApproved: vi.fn(),
      dispatch: vi.fn(
        async ({ toolName, args }: { toolName: string; args: Record<string, unknown> }) => {
          expect(toolName).toBe('calendar.list_events');
          calls.push({ toolName, args });
          const second = args.pageToken === 'fixture-page-2';
          const result = {
            events: second
              ? [
                  {
                    eventId: 'outside-weekend',
                    calendarId: 'owner',
                    summary: 'Monday appointment',
                    start: '2026-10-19T19:00:00Z',
                    end: '2026-10-19T20:00:00Z',
                    attendeeDetails: [
                      {
                        email: 'alex@example.test',
                        displayName: 'Alex',
                        responseStatus: 'accepted',
                      },
                    ],
                  },
                ]
              : [
                  {
                    eventId: 'team-match',
                    calendarId: 'team',
                    summary: 'Team roster includes Alex',
                    start: '2026-10-17T19:00:00Z',
                    end: '2026-10-17T20:00:00Z',
                    attendees: [],
                  },
                ],
            calendarsResolved: [
              { id: 'team', name: 'Harbor United' },
              { id: 'owner', name: 'Owner' },
            ],
            calendarRosterComplete: true,
            unavailable: [],
            complete: second,
            ...(!second ? { nextPageToken: 'fixture-page-2' } : {}),
          };
          const [stored] = await db
            .insert(toolCalls)
            .values({
              taskId,
              step: calls.length,
              toolName,
              args,
              risk: 'autonomous',
              status: 'succeeded',
              result,
            })
            .returning({ id: toolCalls.id });
          if (!stored) throw new Error('No durable read evidence');
          return { kind: 'executed' as const, toolCallId: stored.id, result, cached: false };
        },
      ),
    };
    const router = {
      step: vi.fn(async () => ({
        ok: true as const,
        modelId: 'scripted/person-calendar',
        degraded: false as const,
        text: 'Alex is free; they are attending the Harbor United match.',
        toolCalls: [],
        finishReason: 'stop' as const,
      })),
      object: vi.fn(async () => {
        throw new Error('No model interpretation may replace the person scope');
      }),
      embed: vi.fn(async () => {
        throw new Error('No ambient personal retrieval');
      }),
    };
    const deps = {
      db,
      router,
      dispatcher,
      persistence: createPostgresExecutionPersistence(db),
      notifyOwner: vi.fn(async () => ({ legs: [] })),
    } as unknown as ExecutorDeps;
    const state = taskState(lease);
    state.untrustedContext = true;
    const window = [{ role: 'user' as const, content: request }];
    const context = {
      deps,
      db,
      router,
      dispatcher,
      task: lease,
      state,
      window,
      agent: { id: agentId, timezone: 'America/Los_Angeles' },
      ctx: {
        taskId,
        agentId,
        trust: 'owner',
        tainted: false,
        db,
        now: () => new Date('2026-10-15T19:00:00Z'),
        signal: new AbortController().signal,
        log: vi.fn(async () => {}),
      },
    } as unknown as RunContext;
    const result = await runStepLoop(context, {
      action: 'reply',
      reasoning: 'Read exact person scope',
      steps: [],
      missingInfo: [],
    });
    expect(result.outcome).toBe('done');
    expect(calls).toEqual([
      {
        toolName: 'calendar.list_events',
        args: {
          timeMin: '2026-10-17T07:00:00.000Z',
          timeMax: '2026-10-19T07:00:00.000Z',
          maxResults: 50,
        },
      },
      {
        toolName: 'calendar.list_events',
        args: {
          timeMin: '2026-10-17T07:00:00.000Z',
          timeMax: '2026-10-19T07:00:00.000Z',
          maxResults: 50,
          pageToken: 'fixture-page-2',
        },
      },
    ]);
    expect(state.step).toBeLessThanOrEqual(lease.maxSteps);
    const persisted = await db.query.messages.findMany({ where: eq(messages.taskId, taskId) });
    const answer = persisted.find((row) => row.role === 'assistant')?.text ?? '';
    expect(answer).toContain('couldn’t confirm Alex’s plans');
    expect(answer).toContain('Oct 17, 2026–Oct 18, 2026');
    expect(answer).not.toContain('Alex is free');
    expect(answer).not.toContain('Monday appointment');
    expect(answer).not.toContain('Team roster includes Alex');
    expect(router.embed).not.toHaveBeenCalled();
    expect(await db.select().from(toolCalls).where(eq(toolCalls.taskId, taskId))).toHaveLength(2);
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.budgetUsdLimit).toBe(
      '0.0500',
    );
  });
});
