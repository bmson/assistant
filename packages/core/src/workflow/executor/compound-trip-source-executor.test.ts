import { createHash, randomUUID } from 'node:crypto';
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
import { compoundTripRecoveryFetchTargets } from '../compound-trip-read.js';
import { tripPrompt, tripSourceResult, tripTools } from '../compound-trip-source.test-fixtures.js';
import { taskState } from '../machine.js';
import {
  buildReadToolInput,
  detectPersonalReadRequest,
  nextRequiredReadTool,
  type ReadToolEvidence,
} from '../read-intent.js';
import type { RunContext } from './phases.js';
import { authorizedCompoundTripFetchUrl, runStepLoop } from './step-loop.js';
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

  it('rejects model-invented trip URLs unless they are source-bound or owner-supplied verbatim', () => {
    const request = detectPersonalReadRequest([{ role: 'user', content: tripPrompt }], {
      now: new Date('2030-11-08T15:00:00Z'),
      timeZone: 'America/New_York',
    });
    if (!request?.compoundTripDiscovery) throw new Error('Expected compound-trip read intent');
    const inventedUrl = 'https://maps.example/route?destination=unverified';

    expect(
      authorizedCompoundTripFetchUrl({
        request,
        evidence: [],
        ownerText: tripPrompt,
        url: inventedUrl,
      }),
    ).toBe(false);
    expect(
      authorizedCompoundTripFetchUrl({
        request,
        evidence: [],
        ownerText: `${tripPrompt} Please fetch ${inventedUrl}`,
        url: inventedUrl,
      }),
    ).toBe(true);
    expect(
      authorizedCompoundTripFetchUrl({
        request,
        evidence: [],
        ownerText: `${tripPrompt} Please fetch ${inventedUrl}`,
        url: 'https://maps.example/route?destination=other',
      }),
    ).toBe(false);
  });

  it.each([
    'separate pages',
    'hotel directions',
    'blocked hotel fallback',
    'all sources blocked',
    'alternate source search',
    'recovery budget boundary',
    'recovery budget resume',
    'focused flight',
    'unbound model fetch',
  ] as const)('retains source facts and bounded completion for %s', async (scenario) => {
    const agent = await db.query.agents.findFirst();
    if (!agent) throw new Error('Allocator fixture agent missing');
    const agentId = agent.id;
    const conversationId = randomUUID();
    const taskId = randomUUID();
    const focused = scenario === 'focused flight';
    const fixtureNow = new Date(focused ? '2030-11-15T15:00:00Z' : '2030-11-08T15:00:00Z');
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
      createdAt: fixtureNow,
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
        async ({
          toolName,
          args,
          ctx,
        }: {
          toolName: string;
          args: Record<string, unknown>;
          ctx: {
            authorizedCompoundTripPublicRead?: {
              taskId: string;
              toolName: string;
              query?: string;
              url?: string;
            };
          };
        }) => {
          if (toolName === 'web.search' || toolName === 'web.fetch') {
            expect(ctx.authorizedCompoundTripPublicRead).toMatchObject({
              taskId,
              toolName,
              ...(toolName === 'web.search' ? { query: args.query } : { url: args.url }),
            });
          }
          calls.push({ toolName, args });
          let result = tripSourceResult(toolName, args);
          if (scenario === 'unbound model fetch' && toolName === 'web.search') {
            result = { results: [] };
          }
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
            result =
              scenario === 'alternate source search' &&
              calls.filter((call) => call.toolName === 'web.search').length === 2
                ? {
                    results: [
                      {
                        url: 'https://official.example/location',
                        title: 'Canal House directions',
                        snippet: 'Taxi and public transport',
                      },
                    ],
                  }
                : {
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
              (scenario === 'alternate source search' &&
                !String(args.url).includes('official.example')) ||
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
    let preseededCallCount = 0;
    const recoveryBoundary =
      scenario === 'recovery budget boundary' || scenario === 'recovery budget resume';
    if (recoveryBoundary) {
      const read = detectPersonalReadRequest([{ role: 'user', content: request }], {
        now: fixtureNow,
        timeZone: 'America/New_York',
      });
      if (!read?.compoundTripDiscovery) throw new Error('Expected bounded compound-trip read');
      const seededEvidence: ReadToolEvidence[] = [];
      let searchCount = 0;
      for (let index = 0; index < 18; index += 1) {
        const toolName = nextRequiredReadTool(read, seededEvidence);
        if (!toolName || toolName === 'maps.directions') break;
        if (toolName === 'web.fetch' && searchCount === 3) break;
        const args = buildReadToolInput(read, toolName, seededEvidence);
        if (!args) throw new Error(`No grounded input for ${toolName}`);
        let status = 'succeeded';
        let result: Record<string, unknown> | null;
        let error: string | undefined;
        if (toolName === 'web.search') {
          searchCount += 1;
          result =
            searchCount < 3
              ? {
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
                }
              : {
                  results: [
                    {
                      url: 'https://moovit.example/transit-route',
                      title: 'Airport transit directions',
                      snippet: 'Public transport from CPH Airport to Canal House.',
                    },
                    {
                      url: 'https://overview.example/hotel',
                      title: 'Hotel information',
                      snippet: 'Hotel overview and amenities.',
                    },
                    {
                      url: 'https://forum.example/travel',
                      title: 'Traveler discussion',
                      snippet: 'Visitor discussion about Copenhagen.',
                    },
                  ],
                };
        } else if (toolName === 'web.fetch') {
          status = 'failed';
          result = null;
          error = 'HTTP 403 CAPTCHA challenge';
        } else result = tripSourceResult(toolName, args) as Record<string, unknown>;
        seededEvidence.push({
          toolName,
          status,
          fromCurrentTask: true,
          args,
          result,
          ...(error ? { error } : {}),
        });
      }
      const recoveryTargets = compoundTripRecoveryFetchTargets(read, seededEvidence);
      expect(recoveryTargets).toEqual([
        { mode: 'public transport', url: 'https://moovit.example/transit-route' },
      ]);
      await db.insert(toolCalls).values(
        seededEvidence.map((row, index) => ({
          taskId,
          step: index + 1,
          toolName: row.toolName,
          args: row.args,
          risk: 'autonomous' as const,
          status: row.status as 'succeeded' | 'failed',
          result: row.result,
          error: row.error ?? null,
        })),
      );
      preseededCallCount = seededEvidence.length;
      // The seeded ledger reflects a recovery search emitted on the last
      // available step. One case exercises a fresh grant, the other resumes
      // from the checkpoint written by that grant.
      state.step = 11;
      if (scenario === 'recovery budget resume') {
        const requestHash = createHash('sha256').update(request.trim()).digest('hex');
        state.plannerState.compoundTripRecoveryStepBudget = {
          version: 1,
          originalMaxSteps: 12,
          effectiveMaxSteps: 14,
          requestHash,
          sourceUrl: recoveryTargets[0]?.url,
        };
      }
    }
    if (scenario === 'unbound model fetch')
      state.pendingToolBatch = {
        step: state.step,
        modelId: 'scripted/model',
        calls: [
          {
            toolCallId: `invented-fetch-${taskId}`,
            toolName: 'web.fetch',
            input: { url: 'https://maps.example/route?destination=unverified' },
            status: 'queued',
          },
        ],
      };
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
        now: () => fixtureNow,
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
    const expectedFetches =
      scenario === 'unbound model fetch'
        ? 1
        : focused
          ? 0
          : recoveryBoundary
            ? 1
            : scenario === 'hotel directions'
              ? 1
              : scenario === 'alternate source search'
                ? 3
                : 2;
    if (scenario === 'unbound model fetch') {
      const fetchedUrls = calls
        .filter((call) => call.toolName === 'web.fetch')
        .map((call) => call.args.url);
      expect(fetchedUrls).toEqual(['https://hotel.example/canal-house/map']);
      expect(state.pendingApprovals).toEqual([]);
      expect(state.pendingToolBatch).toBeNull();
    } else if (recoveryBoundary) {
      expect(calls.map((call) => call.toolName)).toEqual(['web.fetch', 'maps.directions']);
      expect(calls[0]?.args.url).toBe('https://moovit.example/transit-route');
      expect(state.plannerState.compoundTripRecoveryStepBudget).toMatchObject({
        version: 1,
        originalMaxSteps: 12,
        effectiveMaxSteps: 14,
      });
      expect(lease.maxSteps).toBe(14);
      expect(state.step).toBeLessThanOrEqual(14);
      if (scenario === 'recovery budget resume') {
        expect(state.plannerState.compoundTripRecoveryStepBudget).toMatchObject({
          effectiveMaxSteps: 14,
          sourceUrl: 'https://moovit.example/transit-route',
        });
      }
    } else {
      expect(calls.map((call) => call.toolName)).toEqual([
        'calendar.list_events',
        'gmail.search',
        ...(!focused ? ['gmail.search'] : []),
        'gmail.read_thread',
        'gmail.read_thread',
        ...(!focused ? ['web.search'] : []),
        ...Array.from(
          { length: scenario === 'alternate source search' ? 2 : expectedFetches },
          () => 'web.fetch',
        ),
        ...(scenario === 'alternate source search'
          ? ['web.search', 'web.fetch']
          : scenario === 'all sources blocked'
            ? ['web.search', 'web.search']
            : []),
        ...(!focused ? ['maps.directions'] : []),
      ]);
    }
    if (!focused)
      expect(calls.find((call) => call.toolName === 'maps.directions')?.args).toMatchObject({
        origin: 'CPH Airport',
        destination: 'Canal House, Canal Street 42, Copenhagen',
      });
    expect(calls.filter((call) => call.toolName === 'web.fetch')).toHaveLength(expectedFetches);
    expect(
      new Set(calls.filter((call) => call.toolName === 'web.fetch').map((call) => call.args.url))
        .size,
    ).toBe(expectedFetches);
    expect(calls.length).toBeLessThanOrEqual(18);
    if (!recoveryBoundary)
      expect(state.plannerState.compoundTripRecoveryStepBudget).toBeUndefined();
    if (scenario === 'all sources blocked') {
      const searches = calls.filter((call) => call.toolName === 'web.search');
      expect(searches).toHaveLength(3);
      expect(searches.at(-1)?.args.query).toContain('"Canal House"');
      expect(searches.at(-1)?.args.query).toContain('public transport train bus fare duration');
    }
    expect(state.step).toBeLessThanOrEqual(lease.maxSteps);
    const persisted = await db.query.messages.findMany({ where: eq(messages.taskId, taskId) });
    const answer = persisted.find((row) => row.role === 'assistant')?.text ?? '';
    expect(answer).toContain('KL702 CPH→AMS');
    expect(answer).toContain('2030-11-17');
    expect(answer).toContain('zone');
    expect(answer).not.toContain('|---|');
    if (scenario === 'unbound model fetch') {
      expect(answer).not.toContain('maps.example');
      expect(answer).toContain('Hotel');
      expect(answer).toContain('unverified');
    } else if (focused) {
      expect(answer).toContain('Outbound/return direction is not explicitly stated');
      expect(answer).toContain('local; zone not stated');
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
      expect(answer).toContain(
        'The booking lists route 1 before route 2; route 2 reverses route 1. The source does not label either route outbound or return.',
      );
      if (scenario === 'all sources blocked') {
        expect(answer).not.toContain('EUR 5');
        expect(answer).not.toContain('EUR 45');
        expect(answer).toContain('complete endpoint-matched page is still needed');
      } else if (recoveryBoundary) {
        expect(answer).toContain('- **Public transport:** EUR 5; 40 minutes.');
        expect(answer).not.toContain('EUR 45');
        expect(answer).toContain('https://moovit.example/transit-route');
      } else {
        expect(answer).toContain('- **Public transport:** EUR 5; 40 minutes.');
        expect(answer).toContain('EUR 45');
        expect(answer).toContain(
          scenario === 'separate pages'
            ? 'https://transit.example/route'
            : scenario === 'alternate source search'
              ? 'https://official.example/location'
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
      preseededCallCount + calls.length,
    );
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.budgetUsdLimit).toBe(
      '0.0500',
    );
  });
});
