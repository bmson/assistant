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
import {
  conversationMessageSourceRevision,
  conversationMessageSpeakerRevision,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  countries,
  germany,
  resultFor,
  threadResult,
} from '../explicit-source-read.test-fixtures.js';
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

describe('explicit source bundle through allocated PostgreSQL executor', () => {
  let db: Db;
  beforeAll(() => {
    if (!databaseUrl) throw new Error('Allocated test database missing');
    db = createDb(databaseUrl);
  });
  afterAll(async () => {
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  });

  it.each([
    { name: 'countries', prompt: countries, maxSteps: 6, failCalendar: false },
    { name: 'Germany', prompt: germany, maxSteps: 6, failCalendar: false },
    { name: 'calendar failure', prompt: countries, maxSteps: 7, failCalendar: true },
    { name: 'step-bound gap', prompt: countries, maxSteps: 4, failCalendar: false },
    { name: 'seventh-message', prompt: countries, maxSteps: 6, failCalendar: false },
    { name: 'trimmed-content', prompt: countries, maxSteps: 6, failCalendar: false },
  ])(
    'persists fair source execution and honest terminal state: $name',
    async ({ name, prompt, maxSteps, failCalendar }) => {
      const agent = await db.query.agents.findFirst();
      if (!agent) throw new Error('Allocator fixture agent missing');
      const agentId = agent.id;
      const conversationId = randomUUID();
      const taskId = randomUUID();
      const priorTaskId = randomUUID();
      const historyMessageId = randomUUID();
      const historyText = 'I visited Germany in 2024.';
      const request = prompt;
      await db.insert(conversations).values({
        id: conversationId,
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: 'Synthetic explicit source bundle',
      });
      await db.insert(tasks).values({
        id: priorTaskId,
        agentId,
        conversationId,
        type: 'chat_turn',
        status: 'done',
        trust: 'owner',
        createdAt: new Date('2024-10-20T12:00:00Z'),
        trigger: {},
        state: {},
      });
      await db.insert(messages).values({
        id: historyMessageId,
        conversationId,
        taskId: priorTaskId,
        role: 'user',
        origin: 'owner',
        text: historyText,
        parts: [],
        createdAt: new Date('2024-10-20T12:00:00Z'),
      });
      await db.insert(tasks).values({
        id: taskId,
        agentId,
        conversationId,
        type: 'chat_turn',
        status: 'pending',
        trust: 'owner',
        createdAt: new Date('2026-10-15T19:00:00Z'),
        maxSteps,
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
          [
            'conversations.search',
            'gmail.search',
            'calendar.search_events',
            'gmail.read_thread',
          ].map((name) => ({ name, description: 'Synthetic local fixture', inputSchema: {} })),
        resultIsUntrusted: () => true,
        executeApproved: vi.fn(),
        dispatch: vi.fn(
          async ({ toolName, args }: { toolName: string; args: Record<string, unknown> }) => {
            calls.push({ toolName, args });
            const failed = failCalendar && toolName === 'calendar.search_events';
            const result = failed
              ? { error: 'Synthetic calendar unavailable' }
              : toolName === 'conversations.search'
                ? {
                    mode: 'semantic',
                    matches: [
                      {
                        messageId: historyMessageId,
                        conversationId,
                        text: historyText,
                        role: 'user',
                        origin: 'owner',
                        createdAt: '2024-10-20T12:00:00.000Z',
                        sourceRevision: conversationMessageSourceRevision(
                          historyMessageId,
                          historyText,
                        ),
                        speakerRevision: conversationMessageSpeakerRevision(
                          historyMessageId,
                          historyText,
                          'user',
                          'owner',
                        ),
                      },
                    ],
                  }
                : toolName === 'gmail.read_thread' && name === 'seventh-message'
                  ? threadResult(undefined, [
                      ...Array.from({ length: 5 }, () => 'Confirmation ABC-123 booking copy.'),
                      'Confirmation ABC-123 was cancelled; only an airport connection remained.',
                    ])
                  : toolName === 'gmail.read_thread' && name === 'trimmed-content'
                    ? threadResult(
                        `${threadResult().messages[0]?.text ?? ''}${' context'.repeat(600)} Confirmation ABC-123 was cancelled; only an airport connection remained.`,
                      )
                    : resultFor(toolName, args);
            const [stored] = await db
              .insert(toolCalls)
              .values({
                taskId,
                step: calls.length,
                toolName,
                args,
                risk: 'autonomous',
                status: failed ? 'failed' : 'succeeded',
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
          text: 'Unsupported old answer claiming all sources completed.',
          toolCalls: [],
          finishReason: 'stop' as const,
        })),
        object: vi.fn(async (..._arguments: unknown[]) => {
          const owner =
            prompt === countries
              ? [
                  {
                    sourceKey: `message:${historyMessageId}`,
                    quote: 'I visited Germany in 2024.',
                    country: 'Germany',
                    classification: 'completed_visit',
                    date: '2024',
                  },
                ]
              : [];
          return {
            ok: true,
            object: {
              selections: [
                ...owner,
                {
                  sourceKey: 'mail:thread-1:mail-1',
                  quote: 'Germany booking for 2025-10-10. Confirmation ABC-123.',
                  country: 'Germany',
                  classification: 'booking',
                  date: '2025-10-10',
                },
              ],
              claims: [
                { text: 'Your Germany booking is for 2025-10-10.', evidence: [owner.length] },
              ],
              addressed:
                prompt === countries ? ['country_count', 'conflicts'] : ['chronology', 'conflicts'],
            },
          };
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
        reasoning: 'Read explicit source bundle',
        steps: [],
        missingInfo: [],
      });
      const synthesisLimited = name === 'seventh-message' || name === 'trimmed-content';
      const incomplete =
        failCalendar || name === 'step-bound gap' || prompt === germany || synthesisLimited;
      if (prompt === countries && !failCalendar && name !== 'step-bound gap') {
        const synthesis = router.object.mock.calls[0]?.[1] as { prompt: string } | undefined;
        const payload = JSON.parse(synthesis?.prompt ?? '{}');
        expect(payload.sources).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              key: `message:${historyMessageId}`,
              owner: true,
              body: 'I visited Germany in 2024.',
            }),
          ]),
        );
      }
      expect(result.outcome).toBe(incomplete ? 'needs_attention' : 'done');
      const firstReads =
        prompt === germany
          ? ['gmail.search', 'calendar.search_events']
          : ['conversations.search', 'gmail.search', 'calendar.search_events'];
      expect(calls.slice(0, firstReads.length).map((row) => row.toolName)).toEqual(firstReads);
      expect(calls.some((row) => row.toolName === 'memory.recall')).toBe(false);
      if (!incomplete) expect(calls.at(-1)?.toolName).toBe('gmail.read_thread');
      if (name === 'step-bound gap')
        expect(calls.some((row) => row.toolName === 'gmail.read_thread')).toBe(false);
      expect(calls.find((row) => row.toolName === 'calendar.search_events')?.args).toMatchObject({
        timeMax: '2026-10-15T19:00:00.000Z',
      });
      expect(state.step).toBeLessThanOrEqual(lease.maxSteps);
      expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.status).toBe(
        incomplete ? 'needs_attention' : 'done',
      );
      const persisted = await db.query.messages.findMany({ where: eq(messages.taskId, taskId) });
      const assistantMessage = persisted.find((row) => row.role === 'assistant');
      const answer = assistantMessage?.text ?? '';
      expect(
        (assistantMessage?.parts as Array<{ type: string }> | undefined)?.some(
          (part) => part.type === 'data-card',
        ),
      ).toBe(false);
      expect(answer).toContain('mail:');
      expect(answer).toContain('calendar:');
      if (failCalendar || name === 'step-bound gap')
        expect(answer).toContain('coverage incomplete');
      if (synthesisLimited) {
        expect(answer).toContain('mail: coverage incomplete');
        expect(answer).toContain('not assessed');
        expect(answer).toContain(
          '[Synthetic booking](https://mail.google.com/mail/u/0/#all/thread-1)',
        );
        const payload = JSON.parse(
          (router.object.mock.calls[0]?.[1] as { prompt: string } | undefined)?.prompt ?? '{}',
        );
        expect(JSON.stringify(payload)).not.toContain('only an airport connection remained');
        expect(
          payload.sources.filter((source: { key: string }) => source.key.startsWith('mail:'))
            .length,
        ).toBeLessThanOrEqual(6);
      }
      if (prompt === germany) {
        expect(answer).toContain('I cannot confirm when you last completed this trip');
        expect(answer).not.toContain('country/territory');
      } else if (name !== 'step-bound gap')
        expect(answer).toContain('At least **1 supported country/territory name**');
      else {
        expect(answer).toContain('could not reliably complete');
        expect(answer).not.toContain('At least **0');
      }
      expect(answer).not.toContain('Unsupported old answer');
      expect(answer).not.toContain('Synthetic calendar unavailable');
      expect(router.object.mock.calls.length).toBeLessThanOrEqual(1);
      expect(router.embed).not.toHaveBeenCalled();
      expect(await db.select().from(toolCalls).where(eq(toolCalls.taskId, taskId))).toHaveLength(
        calls.length,
      );
      expect(
        (await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.budgetUsdLimit,
      ).toBe('0.0500');
    },
  );
});
