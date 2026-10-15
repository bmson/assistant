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

describe('airport lookup completion through allocated PostgreSQL executor', () => {
  let db: Db;
  beforeAll(() => {
    if (!databaseUrl) throw new Error('Allocated test database missing');
    db = createDb(databaseUrl);
  });
  afterAll(async () => {
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  });

  it.each([
    { name: 'route success', mixed: false, fail: false, missingOrigin: false },
    { name: 'route failure', mixed: false, fail: true, missingOrigin: false },
    { name: 'weather plus two-page airport', mixed: true, fail: false, missingOrigin: false },
    { name: 'clarifies an unresolved home origin', mixed: false, fail: false, missingOrigin: true },
  ])('finishes once without repeating reads: $name', async ({ mixed, fail, missingOrigin }) => {
    const agent = await db.query.agents.findFirst();
    if (!agent) throw new Error('Allocator fixture agent missing');
    const agentId = agent.id;
    const conversationId = randomUUID();
    const taskId = randomUUID();
    const origin = missingOrigin ? 'Home' : '123 Market Street, San Francisco, CA 94103';
    const routeRequest = `How long to get to the airport tomorrow from ${origin}, leaving at 8am?`;
    const request = mixed ? `What's the weather tomorrow and ${routeRequest}` : routeRequest;
    await db.insert(conversations).values({
      id: conversationId,
      agentId,
      channel: 'chat',
      trust: 'owner',
      title: 'Synthetic airport completion',
    });
    await db.insert(tasks).values({
      id: taskId,
      agentId,
      conversationId,
      type: 'chat_turn',
      status: 'pending',
      trust: 'owner',
      createdAt: new Date('2030-11-15T15:00:00Z'),
      maxSteps: 8,
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
      toolDefs: () =>
        ['calendar.list_events', 'maps.directions', 'weather.lookup'].map((name) => ({
          name,
          description: 'Synthetic local source',
          inputSchema: {},
        })),
      resultIsUntrusted: () => true,
      executeApproved: vi.fn(),
      dispatch: vi.fn(
        async ({ toolName, args }: { toolName: string; args: Record<string, unknown> }) => {
          calls.push({ toolName, args });
          const second = args.pageToken === 'second';
          const result =
            toolName === 'calendar.list_events'
              ? {
                  events:
                    mixed && !second
                      ? []
                      : [
                          {
                            eventId: 'flight',
                            calendarId: 'owner',
                            summary: 'Outbound flight',
                            location: 'Harbor International Airport',
                            start: '2030-11-16T18:00:00Z',
                          },
                        ],
                  complete: !mixed || second,
                  calendarRosterComplete: true,
                  unavailable: [],
                  ...(mixed && !second ? { nextPageToken: 'second' } : {}),
                }
              : toolName === 'maps.directions'
                ? fail
                  ? { error: 'Synthetic route unavailable' }
                  : {
                      origin: {
                        label: '123 Market Street, San Francisco, CA 94103',
                        lat: 40,
                        lng: -74,
                      },
                      destination: { label: 'Harbor International Airport', lat: 41, lng: -73 },
                      durationSeconds: 1800,
                      distanceMeters: 25000,
                      departAt: args.departAt,
                      mapsUrl: 'https://maps.apple.com/?daddr=fixture',
                    }
                : toolName === 'weather.lookup'
                  ? {
                      place: 'Harbor',
                      target: {
                        date: '2030-11-16',
                        weekday: 'Saturday',
                        day: { date: '2030-11-16', highC: 20, lowC: 12, description: 'Clear' },
                      },
                    }
                  : (() => {
                      throw new Error('Unexpected provider');
                    })();
          const [stored] = await db
            .insert(toolCalls)
            .values({
              taskId,
              step: calls.length,
              toolName,
              args,
              risk: 'autonomous',
              status: fail && toolName === 'maps.directions' ? 'failed' : 'succeeded',
              result,
            })
            .returning({ id: toolCalls.id });
          if (!stored) throw new Error('No durable read evidence');
          return { kind: 'executed' as const, toolCallId: stored.id, result, cached: false };
        },
      ),
    };
    const router = {
      step: vi.fn(async (_role: string, input: { toolChoice?: { toolName?: string } }) => ({
        ok: true as const,
        modelId: 'scripted/airport',
        degraded: false as const,
        text:
          input.toolChoice?.toolName === 'weather.lookup'
            ? ''
            : missingOrigin
              ? 'I found the airport on your calendar, but I need the street address where you will start.'
              : `${mixed ? 'The forecast was retrieved. ' : ''}The drive from 123 Market Street, San Francisco, CA 94103 to Harbor International Airport takes 30 minutes.`,
        toolCalls:
          input.toolChoice?.toolName === 'weather.lookup'
            ? [
                {
                  toolCallId: 'fixture-weather',
                  toolName: 'weather.lookup',
                  input: { location: 'Harbor', date: '2030-11-16' },
                },
              ]
            : [],
        finishReason: 'stop' as const,
      })),
      object: vi.fn(async () => ({ ok: true, object: { decision: 'publish', reasons: [] } })),
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
      agent: { id: agentId, timezone: 'America/New_York' },
      ctx: {
        taskId,
        agentId,
        trust: 'owner',
        tainted: false,
        db,
        now: () => new Date('2030-11-15T15:00:00Z'),
        signal: new AbortController().signal,
        log: vi.fn(async () => {}),
      },
    } as unknown as RunContext;
    const result = await runStepLoop(context, {
      action: 'reply',
      reasoning: 'Read a source-bound airport route',
      steps: [],
      missingInfo: [],
    });
    expect(result.outcome).toBe(fail ? 'needs_attention' : 'done');
    expect(calls.filter((call) => call.toolName === 'maps.directions')).toHaveLength(
      missingOrigin ? 0 : 1,
    );
    expect(calls.filter((call) => call.toolName === 'calendar.list_events')).toHaveLength(
      mixed ? 2 : 1,
    );
    expect(calls.filter((call) => call.toolName === 'weather.lookup')).toHaveLength(mixed ? 1 : 0);
    if (!missingOrigin)
      expect(calls.find((call) => call.toolName === 'maps.directions')?.args).toMatchObject({
        origin: '123 Market Street, San Francisco, CA 94103',
        destination: 'Harbor International Airport',
        departAt: '2030-11-16T13:00:00.000Z',
      });
    const pages = calls.filter((call) => call.toolName === 'calendar.list_events');
    expect(pages[0]?.args).toMatchObject({
      timeMin: '2030-11-16T05:00:00.000Z',
      timeMax: '2030-11-17T05:00:00.000Z',
    });
    if (mixed) expect(pages[1]?.args.pageToken).toBe('second');
    expect(state.step).toBeLessThan(lease.maxSteps);
    const persisted = await db.query.messages.findMany({ where: eq(messages.taskId, taskId) });
    const final = persisted.find((row) => row.role === 'assistant');
    const answer = final?.text ?? '';
    if (missingOrigin) {
      expect(answer).toMatch(/need the street address where you will start/i);
      expect(answer).not.toContain('takes 30 minutes');
    } else if (fail) {
      expect(answer).toContain("couldn't get a route");
      expect(answer).not.toContain('takes 30 minutes');
    } else {
      expect(answer).toContain('takes 30 minutes');
      expect(answer).toContain('Harbor International Airport');
    }
    if (mixed) expect(JSON.stringify(final?.parts)).toContain('weather');
    expect(router.embed).not.toHaveBeenCalled();
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.status).toBe(
      fail ? 'needs_attention' : 'done',
    );
    expect(await db.select().from(toolCalls).where(eq(toolCalls.taskId, taskId))).toHaveLength(
      calls.length,
    );
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.budgetUsdLimit).toBe(
      '0.0500',
    );
  });
});
