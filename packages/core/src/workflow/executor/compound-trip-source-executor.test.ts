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

  it.each([
    'separate pages',
    'hotel directions',
    'blocked hotel fallback',
    'all sources blocked',
    'focused flight',
  ] as const)('retains source facts and bounded completion for %s', async (scenario) => {
    const agent = await db.query.agents.findFirst();
    if (!agent) throw new Error('Allocator fixture agent missing');
    const agentId = agent.id;
    const conversationId = randomUUID();
    const taskId = randomUUID();
    const focused = scenario === 'focused flight';
    const request = focused
      ? 'Find my next future flight using booking emails and calendar. State date, departure time with its time zone, route and flight number, and whether outbound or return. Keep it short, cite source links, and mark uncertainty. Do not book, send, or change anything.'
      : tripPrompt;
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
          let result = tripSourceResult(toolName, args);
          if (focused && toolName === 'gmail.search') {
            const search = result as {
              results: Array<Record<string, unknown>>;
              receipt: { covered: Record<string, unknown> };
            };
            search.results.push({
              threadId: 'clock-thread',
              subject:
                'Passenger - KLM 702 - departs 6:00 AM local time - Confirmation code: ZXCV12',
            });
            search.receipt.covered = { count: 2, total: 2, unavailable: 0 };
          }
          if (focused && toolName === 'gmail.read_thread' && args.threadId === 'clock-thread') {
            const body =
              'Itinerary number: 123456789012\nKLM 702\nScheduled Departure\nNov 17, 2030, 6:00 am, Copenhagen (CPH-Airport)\nArrives\nNov 17, 2030, 7:25 am, Amsterdam (AMS-Schiphol)';
            const page = result as Record<string, unknown>;
            page.messages = [
              {
                messageId: 'clock-message',
                subject:
                  'Passenger - KLM 702 - departs 6:00 AM local time - Confirmation code: ZXCV12',
                text: body,
                sourceLength: body.length,
                truncated: false,
              },
            ];
          }
          if (!focused && scenario !== 'separate pages' && toolName === 'web.search')
            result = {
              results: [
                {
                  url: 'https://hotel.example/canal-house/map',
                  title: 'Location: Canal House',
                  snippet: 'Taxi and public transport directions.',
                },
                {
                  url: 'https://fallback.example/airport-transfer',
                  title: 'Airport taxi and public transport',
                  snippet: 'Taxi and public transport from CPH Airport to Canal House.',
                },
              ],
            };
          if (!focused && scenario !== 'separate pages' && toolName === 'web.fetch') {
            const fail =
              scenario === 'all sources blocked' ||
              (scenario === 'blocked hotel fallback' && String(args.url).includes('hotel.example'));
            if (fail) {
              await db.insert(toolCalls).values({
                taskId,
                step: calls.length,
                toolName,
                args,
                risk: 'autonomous',
                status: 'failed',
                error: 'HTTP403 challenge',
              });
              return { kind: 'rejected' as const, reason: 'execution failed: HTTP403 challenge' };
            }
            result = {
              status: 200,
              truncated: false,
              finalUrl: args.url,
              text: 'Public transport from CPH Airport to Canal House costs EUR 5 and takes 40 minutes.\n\nTaxi from CPH Airport to Canal House costs EUR 45 and takes 30–40 minutes.',
            };
          }
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
    const expectedFetches = focused ? 0 : scenario === 'hotel directions' ? 1 : 2;
    expect(calls.map((call) => call.toolName)).toEqual([
      'calendar.list_events',
      'gmail.search',
      ...(!focused ? ['gmail.search'] : []),
      'gmail.read_thread',
      'gmail.read_thread',
      ...(!focused ? ['maps.directions', 'web.search'] : []),
      ...Array.from({ length: expectedFetches }, () => 'web.fetch'),
    ]);
    if (!focused)
      expect(calls.find((call) => call.toolName === 'maps.directions')?.args).toMatchObject({
        origin: 'CPH Airport',
        destination: 'Canal Street 42, Copenhagen',
      });
    expect(calls.filter((call) => call.toolName === 'web.fetch')).toHaveLength(expectedFetches);
    expect(
      new Set(calls.filter((call) => call.toolName === 'web.fetch').map((call) => call.args.url))
        .size,
    ).toBe(expectedFetches);
    expect(calls.length).toBeLessThanOrEqual(16);
    expect(state.step).toBeLessThanOrEqual(lease.maxSteps);
    const persisted = await db.query.messages.findMany({ where: eq(messages.taskId, taskId) });
    const answer = persisted.find((row) => row.role === 'assistant')?.text ?? '';
    expect(answer).toContain('KL702 CPH→AMS');
    expect(answer).toContain('2030-11-17');
    expect(answer).toContain('zone');
    expect(answer).not.toContain('|---|');
    if (focused) {
      expect(answer).toContain('likely return (inferred from reversed itinerary route groups)');
      expect(answer).toContain('local; zone unspecified');
      expect(answer).toContain(
        '[Local-clock confirmation](https://mail.google.com/mail/u/0/#all/clock-thread)',
      );
      expect(answer).toContain('CPH→AMS→BOS');
      expect(answer).toContain('Example Air');
      expect(answer).toContain('KLM');
      expect(answer).not.toContain('nonstop');
      expect(answer).not.toContain('Europe/Copenhagen');
      expect(
        answer.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').split(/\s+/).length,
      ).toBeLessThanOrEqual(240);
    } else {
      expect(answer).toContain('Canal House');
      expect(answer).toContain('2030-11-10 to 2030-11-17');
      expect(answer).toContain('Direction inferred from the reversed itinerary route groups');
      if (scenario === 'all sources blocked') {
        expect(answer).not.toContain('EUR 5');
        expect(answer).not.toContain('EUR 45');
        expect(answer).toContain('complete endpoint-matched page is still needed');
      } else {
        expect(answer).toContain('- **Public transport:** EUR 5; 40 minutes.');
        expect(answer).toContain('EUR 45');
        expect(answer).toContain(
          scenario === 'separate pages'
            ? 'https://transit.example/route'
            : scenario === 'hotel directions'
              ? 'https://hotel.example/canal-house/map'
              : 'https://fallback.example/airport-transfer',
        );
      }
      expect(
        answer.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').split(/\s+/).length,
      ).toBeLessThanOrEqual(360);
    }
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
