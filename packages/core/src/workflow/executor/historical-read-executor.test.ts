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
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { taskState } from '../machine.js';
import { detectPersonalReadRequest } from '../read-intent.js';
import { stageModelFinalResponse } from './finalize.js';
import type { ExecutorDeps } from './types.js';

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL;
  assertAllocatedTestTarget({
    databaseUrl: url,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    kind: 'standard',
  });
  if (!url) throw new Error('Missing allocated test database URL');
  return url;
})();

describe('historical conversation read finalization', () => {
  let db: Db;
  let dbUp = false;
  let agentId = '';
  const taskIds: string[] = [];
  const conversationIds: string[] = [];
  const messageIds: string[] = [];

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      const [agent] = await db
        .select({ id: (await import('@assistant/db')).agents.id })
        .from((await import('@assistant/db')).agents)
        .limit(1);
      if (!agent) throw new Error('The allocated test database must contain its base agent');
      agentId = agent.id;
      dbUp = true;
    } catch {
      console.warn('historical-read-executor.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    try {
      if (dbUp) {
        if (taskIds.length) {
          await db.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
          await db.delete(messages).where(inArray(messages.taskId, taskIds));
          await db.delete(tasks).where(inArray(tasks.id, taskIds));
        }
        if (conversationIds.length)
          await db.delete(conversations).where(inArray(conversations.id, conversationIds));
        if (messageIds.length) await db.delete(messages).where(inArray(messages.id, messageIds));
      }
    } finally {
      await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
    }
  });

  it('selects and revalidates the exact owner correction from persisted history, not assistant or unrelated rows', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const conversationId = randomUUID();
    const priorTaskId = randomUUID();
    const currentTaskId = randomUUID();
    const currentOwnerMessageId = randomUUID();
    conversationIds.push(conversationId);
    taskIds.push(priorTaskId, currentTaskId);

    await db.insert(conversations).values({
      id: conversationId,
      agentId,
      channel: 'chat',
      trust: 'owner',
      title: 'historical-read-executor-test',
    });

    const request = 'What did I tell you in an earlier conversation about my return date?';
    const ownerCorrection = `You asked, “${request}” I corrected you: my return date is October 16, not October 15.`;
    const assistantClaim = `When you asked, “${request}” I answered incorrectly that your return date was October 15.`;
    const unrelatedRecord =
      'My passport form has a return date field; TEST-DO-NOT-REPEAT is unrelated.';
    const historicalMessages = [
      { id: randomUUID(), text: ownerCorrection, role: 'user' as const, origin: 'owner' },
      { id: randomUUID(), text: assistantClaim, role: 'assistant' as const, origin: 'assistant' },
      { id: randomUUID(), text: unrelatedRecord, role: 'user' as const, origin: 'owner' },
    ];
    messageIds.push(...historicalMessages.map((message) => message.id), currentOwnerMessageId);
    await db.insert(tasks).values({
      id: priorTaskId,
      agentId,
      conversationId,
      type: 'chat_turn',
      status: 'done',
      trust: 'owner',
      trigger: {
        source: 'chat',
        agentId,
        conversationId,
        trust: 'owner',
        payload: { text: 'prior discussion' },
      },
    });
    await db.insert(messages).values(
      historicalMessages.map((message, index) => ({
        id: message.id,
        conversationId,
        taskId: priorTaskId,
        role: message.role,
        origin: message.origin,
        text: message.text,
        parts: [],
        createdAt: new Date(Date.UTC(2026, 9, 1, 12, index)),
      })),
    );

    const sourceMatches = historicalMessages.map((message, index) => ({
      messageId: message.id,
      conversationId,
      sourceRevision: conversationMessageSourceRevision(message.id, message.text),
      speakerRevision: conversationMessageSpeakerRevision(
        message.id,
        message.text,
        message.role,
        message.origin,
      ),
      text: message.text,
      role: message.role,
      origin: message.origin,
      createdAt: new Date(Date.UTC(2026, 9, 1, 12, index)).toISOString(),
    }));
    await db.insert(tasks).values({
      id: currentTaskId,
      agentId,
      conversationId,
      type: 'chat_turn',
      status: 'pending',
      trust: 'owner',
      trigger: {
        source: 'chat',
        agentId,
        conversationId,
        trust: 'owner',
        payload: { text: request, triggerMessageId: currentOwnerMessageId },
      },
      state: {},
    });
    await db.insert(messages).values({
      id: currentOwnerMessageId,
      conversationId,
      taskId: currentTaskId,
      role: 'user',
      origin: 'owner',
      text: request,
      parts: [{ type: 'text', text: request }],
    });
    await db.insert(toolCalls).values({
      taskId: currentTaskId,
      step: 1,
      toolName: 'conversations.search',
      args: { query: request, limit: 5 },
      risk: 'autonomous',
      status: 'succeeded',
      result: { mode: 'text', matches: sourceMatches },
    });

    const taskRepository = createPostgresTaskRepository(db);
    const lease = await taskRepository.claim(currentTaskId);
    if (!lease) throw new Error('The historical read task could not be claimed');
    const scriptedObjects: unknown[] = [
      {
        selections: [{ sourceKey: `message:${historicalMessages[0]?.id}`, quote: ownerCorrection }],
      },
      { decision: 'publish' },
    ];
    const selectorPrompts: string[] = [];
    const router = {
      object: vi.fn(async (_role: string, input: { system: string; prompt: string }) => {
        if (input.system.includes('Select only historical source passages'))
          selectorPrompts.push(input.prompt);
        const object = scriptedObjects.shift();
        if (!object) throw new Error('Unexpected additional model object call');
        return { ok: true, modelId: 'scripted/historical-read', degraded: false, object };
      }),
      step: vi.fn(async () => {
        throw new Error('Historical finalization must not plan tool calls');
      }),
      embed: vi.fn(async () => {
        throw new Error('Historical finalization must not run semantic retrieval');
      }),
    };
    const dispatch = vi.fn(async () => {
      throw new Error('Historical personal read must not call calendar or Gmail');
    });
    const persistence = createPostgresExecutionPersistence(db);
    const deps = {
      db,
      persistence,
      router,
      dispatcher: {
        toolDefs: () => [],
        resultIsUntrusted: () => true,
        dispatch,
        executeApproved: vi.fn(),
      },
      notifyOwner: vi.fn(async () => ({ legs: [{ channel: 'push', status: 'delivered' }] })),
    } as unknown as ExecutorDeps;
    const window = [{ role: 'user' as const, content: request }];
    expect(detectPersonalReadRequest(window)?.kind).toBe('memory');
    const persistedHistory = await persistence.executionEvidence.taskEvidence({
      agentId,
      taskId: currentTaskId,
    });
    expect(persistedHistory).toHaveLength(1);
    expect(persistedHistory[0]?.toolName).toBe('conversations.search');
    const state = taskState(lease);
    const result = await stageModelFinalResponse(deps, lease, state, window, {
      text: 'I think you said October 15 and your passport number was TEST-DO-NOT-REPEAT.',
      progress: 'Read historical conversation evidence.',
      terminalStatus: 'done',
      outcome: 'done',
    });

    expect(selectorPrompts).toHaveLength(1);
    expect(selectorPrompts[0]).toContain(ownerCorrection);
    expect(selectorPrompts[0]).toContain(assistantClaim);
    expect(dispatch).not.toHaveBeenCalled();
    expect(router.step).not.toHaveBeenCalled();
    expect(router.object).toHaveBeenCalledTimes(2);

    const persisted = await db.query.messages.findMany({
      where: eq(messages.taskId, currentTaskId),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    });
    const finalText = persisted.find((message) => message.role === 'assistant')?.text ?? '';
    expect(finalText).toContain(ownerCorrection);
    expect(finalText).toContain('Recorded owner message');
    expect(finalText).not.toContain(assistantClaim);
    expect(finalText).not.toContain('TEST-DO-NOT-REPEAT');

    const [completed] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, currentTaskId));
    expect(result.outcome).toBe('done');
    expect(completed?.status).toBe('done');
  });
});
