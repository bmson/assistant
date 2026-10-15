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

describe('family birthdays through the allocated PostgreSQL executor', () => {
  let db: Db;
  beforeAll(() => {
    if (!databaseUrl) throw new Error('Missing allocated database');
    db = createDb(databaseUrl);
  });
  afterAll(async () => {
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  });

  it.each(['complete', 'partial', 'absent', 'conflict', 'memory-failure', 'assistant-only'])(
    'persists only grounded facts and the correct terminal status: %s',
    async (variant) => {
      const agent = await db.query.agents.findFirst();
      if (!agent) throw new Error('Missing allocator agent');
      const agentId = agent.id;
      const taskId = randomUUID();
      const priorTaskId = randomUUID();
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const statement = "My sister Alex's birthday is March 4.";
      const body = variant === 'conflict' ? `${statement}\nAlex's birthday is March 5.` : statement;
      const role = variant === 'assistant-only' ? 'assistant' : 'user';
      const origin = variant === 'assistant-only' ? 'assistant' : 'owner';
      const prompt =
        variant === 'partial' || variant === 'absent'
          ? 'When are my siblings’ birthdays?'
          : 'When is my sister’s birthday?';
      await db.insert(conversations).values({
        id: conversationId,
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: 'Synthetic family birthdays',
      });
      await db.insert(tasks).values({
        id: priorTaskId,
        agentId,
        conversationId,
        type: 'chat_turn',
        status: 'done',
        trust: 'owner',
        trigger: {},
        state: {},
      });
      await db.insert(messages).values({
        id: messageId,
        taskId: priorTaskId,
        conversationId,
        role,
        origin,
        text: body,
        parts: [],
        createdAt: new Date('2024-01-01T12:00:00.000Z'),
      });
      await db.insert(tasks).values({
        id: taskId,
        agentId,
        conversationId,
        type: 'chat_turn',
        status: 'pending',
        trust: 'owner',
        maxSteps: 6,
        budgetUsdLimit: '0.0500',
        createdAt: new Date('2026-10-15T19:00:00Z'),
        trigger: {
          source: 'chat',
          agentId,
          conversationId,
          trust: 'owner',
          payload: { text: prompt },
        },
        state: {},
      });
      const repo = createPostgresTaskRepository(db);
      await db.insert(messages).values({
        conversationId,
        taskId,
        role: 'user',
        origin: 'owner',
        text: prompt,
        parts: [{ type: 'text', text: prompt }],
      });
      const lease = await repo.claim(taskId);
      if (!lease) throw new Error('Missing task lease');
      const calls: string[] = [];
      const dispatcher = {
        toolDefs: () =>
          ['conversations.search', 'memory.recall'].map((name) => ({
            name,
            description: 'Synthetic read',
            inputSchema: {},
          })),
        resultIsUntrusted: () => true,
        executeApproved: vi.fn(),
        dispatch: vi.fn(
          async ({ toolName, args }: { toolName: string; args: Record<string, unknown> }) => {
            calls.push(toolName);
            const failed = variant === 'memory-failure' && toolName === 'memory.recall';
            const result = failed
              ? { error: 'Synthetic unavailable source' }
              : toolName === 'conversations.search'
                ? {
                    mode: 'semantic',
                    matches:
                      variant === 'absent'
                        ? []
                        : [
                            {
                              messageId,
                              conversationId,
                              text: body,
                              role,
                              origin,
                              createdAt: '2024-01-01T12:00:00.000Z',
                              sourceRevision: conversationMessageSourceRevision(messageId, body),
                              speakerRevision: conversationMessageSpeakerRevision(
                                messageId,
                                body,
                                role,
                                origin,
                              ),
                            },
                          ],
                  }
                : {
                    memories:
                      variant === 'absent'
                        ? [
                            {
                              id: randomUUID(),
                              content: "Owner's birthday is June 12.",
                              originTrust: 'assistant',
                              ownerConfirmed: false,
                              unconfirmed: true,
                              confidence: 0.99,
                            },
                          ]
                        : [],
                  };
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
            if (!stored) throw new Error('Missing durable tool receipt');
            return { kind: 'executed' as const, toolCallId: stored.id, result, cached: false };
          },
        ),
      };
      const router = {
        step: vi.fn(async () => ({
          ok: true as const,
          modelId: 'scripted/family-birthday',
          degraded: false as const,
          text: 'I found one sibling birthday: June 12.',
          toolCalls: [],
          finishReason: 'stop' as const,
        })),
        object: vi.fn(async () => ({
          ok: true,
          object: {
            selections:
              variant === 'absent' ? [] : [{ sourceKey: `message:${messageId}`, quote: statement }],
            familyBirthdays:
              variant === 'absent'
                ? []
                : [
                    {
                      person: 'Alex',
                      relationship: 'sister',
                      birthday: 'March 4',
                      relationshipSelection: 0,
                      birthdaySelection: 0,
                    },
                  ],
          },
        })),
        embed: vi.fn(async () => {
          throw new Error('No ambient retrieval');
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
      const context = {
        deps,
        db,
        router,
        dispatcher,
        task: lease,
        state,
        window: [{ role: 'user', content: prompt }],
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
        reasoning: 'Read family birthday sources',
        steps: [],
        missingInfo: [],
      });
      const expected = variant === 'complete' ? 'done' : 'needs_attention';
      if (variant !== 'absent') expect(router.object).toHaveBeenCalledTimes(1);
      expect(result.outcome).toBe(expected);
      expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.status).toBe(
        expected,
      );
      expect(calls.slice(0, 2)).toEqual(['conversations.search', 'memory.recall']);
      expect(calls.every((name) => ['conversations.search', 'memory.recall'].includes(name))).toBe(
        true,
      );
      expect(calls.length).toBeLessThanOrEqual(3);
      expect(state.step).toBeLessThanOrEqual(lease.maxSteps);
      const persisted = await db.query.messages.findMany({ where: eq(messages.taskId, taskId) });
      const answer = persisted.find((message) => message.role === 'assistant')?.text ?? '';
      expect(
        (
          persisted.find((message) => message.role === 'assistant')?.parts as
            | Array<{ type: string }>
            | undefined
        )?.some((part) => part.type === 'data-card'),
      ).not.toBe(true);
      expect(answer).not.toContain('I found one sibling');
      expect(answer).not.toContain('June 12');
      if (variant === 'absent' || variant === 'assistant-only') {
        expect(answer).toContain('couldn’t confirm');
        expect(answer).not.toContain('March 4');
      } else {
        expect(answer).toContain('**Alex** (sister)');
        expect(answer).toContain('March 4');
        expect(answer).toContain(`[Source](/chat/${conversationId})`);
      }
      if (variant === 'conflict') expect(answer).toContain('conflicting dates: March 4 / March 5');
      if (variant === 'partial') expect(answer).toContain('cover everyone');
      if (variant === 'memory-failure')
        expect(answer).toContain('could not be searched or assessed completely');
      expect(router.object.mock.calls.length).toBeLessThanOrEqual(1);
      expect(router.embed).not.toHaveBeenCalled();
      expect(
        (await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.budgetUsdLimit,
      ).toBe('0.0500');
    },
  );
});
