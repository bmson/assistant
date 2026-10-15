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
import { countries, germany, resultFor } from '../explicit-source-read.test-fixtures.js';
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
  ])(
    'persists fair source execution and honest terminal state: $name',
    async ({ name, prompt, maxSteps, failCalendar }) => {
      const agent = await db.query.agents.findFirst();
      if (!agent) throw new Error('Allocator fixture agent missing');
      const agentId = agent.id;
      const conversationId = randomUUID();
      const taskId = randomUUID();
      const request = prompt;
      await db.insert(conversations).values({
        id: conversationId,
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: 'Synthetic explicit source bundle',
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
        object: vi.fn(async () => ({
          ok: true,
          object: {
            selections: [
              {
                sourceKey: 'mail:thread-1:mail-1',
                quote: 'Germany booking for 2025-10-10. Confirmation ABC-123.',
                country: 'Germany',
                classification: 'booking',
              },
            ],
          },
        })),
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
      const incomplete = failCalendar || name === 'step-bound gap';
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
      const answer = persisted.find((row) => row.role === 'assistant')?.text ?? '';
      expect(answer).toContain('mail:');
      expect(answer).toContain('calendar:');
      if (incomplete) expect(answer).toContain('coverage incomplete');
      else expect(answer).toContain('booking — Germany');
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
