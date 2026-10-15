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
import { tripPrompt, tripSourceResult, tripTools } from '../compound-trip-source.test-fixtures.js';
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

describe('forwarded itinerary through allocated PostgreSQL executor', () => {
  let db: Db;
  beforeAll(() => {
    if (!databaseUrl) throw new Error('Allocated test database missing');
    db = createDb(databaseUrl);
  });
  afterAll(async () => {
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  });

  it('retains booked hotel/route facts and executes a checked comparison within existing caps', async () => {
    const agent = await db.query.agents.findFirst();
    if (!agent) throw new Error('Allocator fixture agent missing');
    const agentId = agent.id;
    const conversationId = randomUUID();
    const taskId = randomUUID();
    const request = tripPrompt;
    await db.insert(conversations).values({
      id: conversationId,
      agentId,
      channel: 'chat',
      trust: 'owner',
      title: 'Synthetic booked itinerary',
    });
    await db.insert(tasks).values({
      id: taskId,
      agentId,
      conversationId,
      type: 'chat_turn',
      status: 'pending',
      trust: 'owner',
      createdAt: new Date('2030-11-15T15:00:00Z'),
      maxSteps: 12,
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
        tripTools.map((name) => ({
          name,
          description: 'Synthetic local fixture',
          inputSchema: {},
        })),
      resultIsUntrusted: () => true,
      executeApproved: vi.fn(),
      dispatch: vi.fn(
        async ({ toolName, args }: { toolName: string; args: Record<string, unknown> }) => {
          calls.push({ toolName, args });
          const result = tripSourceResult(toolName, args);
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
        text: 'No hotel booking was found. The flights and zones are confirmed.',
        toolCalls: [],
        finishReason: 'stop' as const,
      })),
      object: vi.fn(async () => ({ ok: true, object: { messages: [] } })),
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
      reasoning: 'Read source-bound booked itinerary',
      steps: [],
      missingInfo: [],
    });
    expect(result.outcome).toBe('needs_attention');
    expect(calls.map((call) => call.toolName)).toEqual([
      'calendar.list_events',
      'gmail.search',
      'gmail.search',
      'gmail.read_thread',
      'gmail.read_thread',
      'maps.directions',
      'web.search',
      'web.fetch',
      'web.fetch',
    ]);
    expect(calls.find((call) => call.toolName === 'maps.directions')?.args).toMatchObject({
      origin: 'CPH Airport',
      destination: 'Canal Street 42, Copenhagen',
    });
    expect(calls.filter((call) => call.toolName === 'web.fetch')).toHaveLength(2);
    expect(calls.length).toBeLessThanOrEqual(16);
    expect(state.step).toBeLessThanOrEqual(lease.maxSteps);
    const persisted = await db.query.messages.findMany({ where: eq(messages.taskId, taskId) });
    const answer = persisted.find((row) => row.role === 'assistant')?.text ?? '';
    expect(answer).toContain('Canal House');
    expect(answer).toContain('2030-11-10 to 2030-11-17');
    expect(answer).toContain('KL702 CPH→AMS');
    expect(answer).toContain('direction inferred from the reversed route groups');
    expect(answer).toContain('EUR 5');
    expect(answer).toContain('EUR 45');
    expect(answer).toContain('https://transit.example/route');
    expect(answer).toContain('https://taxi.example/route');
    expect(answer).toContain('https://mail.google.com/mail/u/0/#all/hotel-thread');
    expect(answer).toContain('time zones and exact connection durations remain unverified');
    expect(answer).not.toContain('No hotel booking was found');
    expect(answer).not.toContain('flights and zones are confirmed');
    expect(router.embed).not.toHaveBeenCalled();
    expect(router.object).toHaveBeenCalledTimes(1);
    expect(await db.select().from(toolCalls).where(eq(toolCalls.taskId, taskId))).toHaveLength(
      calls.length,
    );
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.budgetUsdLimit).toBe(
      '0.0500',
    );
  });
});
