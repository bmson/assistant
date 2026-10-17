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
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaskState } from '../../events.js';
import { taskState } from '../machine.js';
import { detectPersonalReadRequest } from '../read-intent.js';
import { stageModelFinalResponse } from './finalize.js';
import type { RunContext } from './phases.js';
import { runStepLoop } from './step-loop.js';
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
    expect(router.object).toHaveBeenCalledTimes(1);

    const persisted = await db.query.messages.findMany({
      where: eq(messages.taskId, currentTaskId),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    });
    const finalMessage = persisted.find((message) => message.role === 'assistant');
    const finalText = finalMessage?.text ?? '';
    expect(finalText).toContain(ownerCorrection);
    expect(finalText).toContain('Recorded owner message');
    expect(finalText).not.toContain(assistantClaim);
    expect(finalText).not.toContain('TEST-DO-NOT-REPEAT');
    expect(finalMessage?.parts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'data-card' })]),
    );

    const [completed] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, currentTaskId));
    expect(result.outcome).toBe('done');
    expect(completed?.status).toBe('done');
  });

  it('finalizes a context receipt as current-task evidence and selects the owner statement separately', async (ctx) => {
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
      title: 'historical-context-finalizer-test',
    });

    const request =
      "Review our earlier fictional Cobalt exercise. Compare my original budget from the assistant's earlier recommendation, and cite both records.";
    const ownerCorrection = 'For the fictional Cobalt exercise, my original budget was $250.';
    const assistantClaim = 'For the fictional Cobalt exercise, I recommend a $400 budget.';
    const unrelatedRecord = 'My passport form has a budget field; TEST-DO-NOT-REPEAT is unrelated.';
    const historicalMessages = [
      { id: randomUUID(), text: ownerCorrection, role: 'user' as const, origin: 'owner' },
      { id: randomUUID(), text: assistantClaim, role: 'assistant' as const, origin: 'assistant' },
      { id: randomUUID(), text: unrelatedRecord, role: 'user' as const, origin: 'owner' },
    ];
    const assistantSource = historicalMessages[1];
    if (!assistantSource) throw new Error('Missing assistant context anchor');
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

    const sourceMatches = historicalMessages
      .filter((message) => message.role === 'assistant')
      .map((message, index) => ({
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
      args: { query: 'Cobalt', mode: 'text', limit: 20 },
      risk: 'autonomous',
      status: 'succeeded',
      result: { mode: 'text', matches: sourceMatches },
    });
    const contextAnchor = {
      messageId: assistantSource.id,
      conversationId,
      sourceRevision: conversationMessageSourceRevision(assistantSource.id, assistantSource.text),
      speakerRevision: conversationMessageSpeakerRevision(
        assistantSource.id,
        assistantSource.text,
        'assistant',
        'assistant',
      ),
    };
    await db.insert(toolCalls).values({
      taskId: currentTaskId,
      step: 2,
      toolName: 'conversations.context',
      args: { anchors: [contextAnchor] },
      risk: 'autonomous',
      status: 'succeeded',
      result: {
        mode: 'context',
        anchors: [contextAnchor],
        matches: historicalMessages.map((message, index) => ({
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
        })),
        window: { before: 3, after: 1 },
        observationGeneration: 'generation-1',
      },
    });

    const taskRepository = createPostgresTaskRepository(db);
    const lease = await taskRepository.claim(currentTaskId);
    if (!lease) throw new Error('The historical read task could not be claimed');
    const scriptedObjects: unknown[] = [
      {
        selections: [
          { sourceKey: `message:${historicalMessages[0]?.id}`, quote: ownerCorrection },
          { sourceKey: `message:${historicalMessages[1]?.id}`, quote: assistantClaim },
        ],
      },
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
    expect(persistedHistory.map((row) => row.toolName)).toEqual([
      'conversations.search',
      'conversations.context',
    ]);
    const state = taskState(lease);
    const result = await stageModelFinalResponse(deps, lease, state, window, {
      text: 'I infer your budget was $400 and found TEST-DO-NOT-REPEAT.',
      progress: 'Read historical conversation evidence.',
      terminalStatus: 'done',
      outcome: 'done',
    });

    expect(selectorPrompts).toHaveLength(1);
    expect(selectorPrompts[0]).toContain(ownerCorrection);
    expect(selectorPrompts[0]).toContain(assistantClaim);
    expect(selectorPrompts[0]).toContain(`message:${historicalMessages[0]?.id}`);
    expect(dispatch).not.toHaveBeenCalled();
    expect(router.step).not.toHaveBeenCalled();
    expect(router.object).toHaveBeenCalledTimes(1);

    const persisted = await db.query.messages.findMany({
      where: eq(messages.taskId, currentTaskId),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    });
    const finalMessage = persisted.find((message) => message.role === 'assistant');
    const finalText = finalMessage?.text ?? '';
    expect(finalText).toContain(ownerCorrection);
    expect(finalText).toContain('Recorded owner message');
    expect(finalText).toContain(assistantClaim);
    expect(finalText).not.toContain('TEST-DO-NOT-REPEAT');
    expect(finalMessage?.parts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'data-card' })]),
    );

    const [completed] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, currentTaskId));
    expect(result.outcome).toBe('done');
    expect(completed?.status).toBe('done');
  });

  it('routes the exact Berlin correction question through the executor and cites historical speakers separately', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const conversationId = randomUUID();
    const priorTaskId = randomUUID();
    const currentTaskId = randomUUID();
    const currentOwnerMessageId = randomUUID();
    const request =
      'Look back at our earlier conversation about my Berlin flight. What did I say was wrong with the departure time you gave me? Separate my correction from the Assistant’s earlier claim and cite the relevant conversation source. Do not treat this historical answer as a verified current flight time.';
    const ownerCorrection =
      'That departure time is wrong: my Berlin booking says 1:45 PM local time, not 9:15 AM.';
    const assistantClaim = 'Your Berlin flight departs at 9:15 AM.';
    const historicalMessages = [
      { id: randomUUID(), role: 'user' as const, origin: 'owner', text: ownerCorrection },
      { id: randomUUID(), role: 'assistant' as const, origin: 'assistant', text: assistantClaim },
    ];
    conversationIds.push(conversationId);
    taskIds.push(priorTaskId, currentTaskId);
    messageIds.push(...historicalMessages.map((message) => message.id), currentOwnerMessageId);

    await db.insert(conversations).values({
      id: conversationId,
      agentId,
      channel: 'chat',
      trust: 'owner',
      title: 'historical-flight-correction-e2e',
    });
    await db.insert(tasks).values([
      {
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
          payload: { text: 'Earlier discussion about the Berlin flight.' },
        },
      },
      {
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
      },
    ]);
    const createdAt = new Date('2026-10-01T12:00:00.000Z');
    await db.insert(messages).values([
      ...historicalMessages.map((message, index) => ({
        ...message,
        conversationId,
        taskId: priorTaskId,
        parts: [],
        createdAt: new Date(createdAt.getTime() + index * 60_000),
      })),
      {
        id: currentOwnerMessageId,
        conversationId,
        taskId: currentTaskId,
        role: 'user',
        origin: 'owner',
        text: request,
        parts: [{ type: 'text', text: request }],
      },
    ]);

    const taskRepository = createPostgresTaskRepository(db);
    const lease = await taskRepository.claim(currentTaskId);
    if (!lease) throw new Error('The historical flight lookup task could not be claimed');
    const persistence = createPostgresExecutionPersistence(db);
    const detectedRequest = detectPersonalReadRequest([{ role: 'user', content: request }]);
    if (!detectedRequest?.conversationQuery)
      throw new Error('The historical flight prompt did not produce a focused search plan');
    const expectedQueries = [
      detectedRequest.conversationQuery,
      detectedRequest.conversationFollowupQuery,
      detectedRequest.conversationCorrectionQuery,
    ].filter((query): query is string => Boolean(query));
    const observedQueries: string[] = [];
    const sourceConversations = vi.fn(async ({ query }: { query: string; limit: number }) => {
      expect(expectedQueries).toContain(query);
      observedQueries.push(query);
      const rows = await db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.taskId, priorTaskId)));
      return rows
        .filter((row) => /berlin|departure|1:45|9:15/i.test(row.text))
        .map((row) => ({
          messageId: row.id,
          conversationId: row.conversationId,
          sourceRevision: conversationMessageSourceRevision(row.id, row.text),
          speakerRevision: conversationMessageSpeakerRevision(
            row.id,
            row.text,
            row.role,
            row.origin,
          ),
          text: row.text,
          role: row.role,
          origin: row.origin,
          createdAt: row.createdAt.toISOString(),
        }))
        .slice(0, 10);
    });
    const dispatchedNames: string[] = [];
    const dispatch = vi.fn(
      async (input: {
        task: { id: string };
        step: number;
        toolName: string;
        args: Record<string, unknown>;
      }) => {
        dispatchedNames.push(input.toolName);
        const result =
          input.toolName === 'conversations.search'
            ? {
                mode: 'semantic',
                matches: await sourceConversations(input.args as { query: string; limit: number }),
              }
            : (() => {
                throw new Error(`Unexpected historical source read: ${input.toolName}`);
              })();
        const [stored] = await db
          .insert(toolCalls)
          .values({
            taskId: input.task.id,
            step: input.step,
            toolName: input.toolName,
            args: input.args,
            risk: 'autonomous',
            status: 'succeeded',
            result,
          })
          .returning({ id: toolCalls.id });
        if (!stored) throw new Error('The historical search receipt was not persisted');
        return { kind: 'executed' as const, toolCallId: stored.id, result, cached: false };
      },
    );
    const scriptedObjects: unknown[] = [
      {
        selections: [
          { sourceKey: `message:${historicalMessages[0]?.id}`, quote: ownerCorrection },
          { sourceKey: `message:${historicalMessages[1]?.id}`, quote: assistantClaim },
        ],
      },
      { decision: 'publish' },
    ];
    const router = {
      step: vi.fn(async () => ({
        ok: true as const,
        modelId: 'scripted/historical-flight',
        degraded: false as const,
        text: 'The current verified departure time is 9:15 AM.',
        toolCalls: [],
        finishReason: 'stop' as const,
      })),
      object: vi.fn(async (_role: string, _input: { system: string; prompt: string }) => {
        const object = scriptedObjects.shift();
        if (!object) throw new Error('Unexpected additional model object call');
        return { ok: true, modelId: 'scripted/historical-flight', degraded: false, object };
      }),
      embed: vi.fn(async () => {
        throw new Error('Historical conversation search must not invoke semantic embeddings');
      }),
      embeddingSpace: vi.fn(async () => ({
        provider: 'scripted',
        model: 'not-used',
        dimensions: 1536,
        revision: '1',
      })),
    };
    const deps = {
      db,
      persistence,
      router,
      dispatcher: {
        toolDefs: () => [
          {
            name: 'conversations.search',
            description: 'Search persisted conversation history',
            inputSchema: {},
          },
        ],
        resultIsUntrusted: (toolName: string) => toolName === 'conversations.search',
        dispatch,
        executeApproved: vi.fn(),
      },
      notifyOwner: vi.fn(async () => ({ legs: [] })),
    } as unknown as ExecutorDeps;
    const state = taskState(lease);
    state.untrustedContext = true;
    const window = [{ role: 'user' as const, content: request }];
    const now = new Date('2026-10-13T12:00:00.000Z');
    const context = {
      deps,
      db,
      router,
      dispatcher: deps.dispatcher,
      task: lease,
      agent: { id: agentId, timezone: 'America/Los_Angeles' },
      state: state as TaskState,
      ctx: {
        taskId: currentTaskId,
        agentId,
        trust: 'owner',
        tainted: false,
        db,
        now: () => now,
        signal: new AbortController().signal,
        log: vi.fn(async () => {}),
      },
      window,
    } as unknown as RunContext;

    expect(detectPersonalReadRequest(window)?.firstToolName).toBe('conversations.search');
    const result = await runStepLoop(context, {
      action: 'reply',
      reasoning: 'Answer from persisted historical conversation sources.',
      steps: [],
      missingInfo: [],
    });

    const persisted = await db.query.messages.findMany({
      where: eq(messages.taskId, currentTaskId),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    });
    const answer = persisted.find((message) => message.role === 'assistant')?.text ?? '';
    expect(result.outcome, JSON.stringify({ result, answer })).toBe('done');
    expect(dispatchedNames).toEqual(expectedQueries.map(() => 'conversations.search'));
    expect(router.step).toHaveBeenCalledTimes(1);
    expect(router.embed).not.toHaveBeenCalled();
    expect(sourceConversations).toHaveBeenCalledTimes(expectedQueries.length);
    expect(observedQueries).toEqual(expectedQueries);
    expect(answer).toContain(`Recorded owner message:** “${ownerCorrection}”`);
    expect(answer).toContain(`Earlier assistant claim (not verified fact):** “${assistantClaim}”`);
    expect(answer).toContain(`/chat/${conversationId}#message-${historicalMessages[0]?.id}`);
    expect(answer).toContain(`/chat/${conversationId}#message-${historicalMessages[1]?.id}`);
    expect(answer).toContain('not evidence of owner intent');
    expect(answer).not.toContain('The current verified departure time is 9:15 AM.');
    expect(answer).not.toContain('TEST-DO-NOT-REPEAT');
  });

  it('reads same-conversation context for a bounded named exercise when search omits the owner anchor', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const conversationId = randomUUID();
    const priorTaskId = randomUUID();
    const currentTaskId = randomUUID();
    const currentOwnerMessageId = randomUUID();
    const request =
      "Review our earlier fictional Cobalt exercise. Compare my original budget from the assistant's earlier recommendation, and cite both records. Do not save anything to memory.";
    const ownerCorrection = 'For the fictional Cobalt exercise, my original budget was $250.';
    const assistantClaim = 'For the fictional Cobalt exercise, I recommend a $400 budget.';
    const historicalMessages = [
      { id: randomUUID(), role: 'user' as const, origin: 'owner', text: ownerCorrection },
      { id: randomUUID(), role: 'assistant' as const, origin: 'assistant', text: assistantClaim },
    ];
    conversationIds.push(conversationId);
    taskIds.push(priorTaskId, currentTaskId);
    messageIds.push(...historicalMessages.map((message) => message.id), currentOwnerMessageId);

    await db.insert(conversations).values({
      id: conversationId,
      agentId,
      channel: 'chat',
      trust: 'owner',
      title: 'historical-context-read-e2e',
    });
    await db.insert(tasks).values([
      {
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
          payload: { text: 'Earlier fictional Cobalt exercise.' },
        },
      },
      {
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
      },
    ]);
    const createdAt = new Date('2026-10-01T12:00:00.000Z');
    await db.insert(messages).values([
      ...historicalMessages.map((message, index) => ({
        ...message,
        conversationId,
        taskId: priorTaskId,
        parts: [],
        createdAt: new Date(createdAt.getTime() + index * 60_000),
      })),
      {
        id: currentOwnerMessageId,
        conversationId,
        taskId: currentTaskId,
        role: 'user',
        origin: 'owner',
        text: request,
        parts: [{ type: 'text', text: request }],
      },
    ]);

    const taskRepository = createPostgresTaskRepository(db);
    const lease = await taskRepository.claim(currentTaskId);
    if (!lease) throw new Error('The historical flight lookup task could not be claimed');
    const persistence = createPostgresExecutionPersistence(db);
    const detectedRequest = detectPersonalReadRequest([{ role: 'user', content: request }]);
    if (!detectedRequest?.conversationQuery)
      throw new Error('The historical exercise prompt did not produce a focused search plan');
    const expectedQueries = [
      detectedRequest.conversationAnchorQuery,
      detectedRequest.conversationQuery,
      detectedRequest.conversationFollowupQuery,
      detectedRequest.conversationCorrectionQuery,
    ].filter((query): query is string => Boolean(query));
    const observedQueries: string[] = [];
    const sourceConversations = vi.fn(async ({ query }: { query: string; limit: number }) => {
      expect(expectedQueries).toContain(query);
      observedQueries.push(query);
      const rows = await db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.taskId, priorTaskId)));
      return rows
        .filter((row) => row.role === 'assistant' && /cobalt|budget/i.test(row.text))
        .map((row) => ({
          messageId: row.id,
          conversationId: row.conversationId,
          sourceRevision: conversationMessageSourceRevision(row.id, row.text),
          speakerRevision: conversationMessageSpeakerRevision(
            row.id,
            row.text,
            row.role,
            row.origin,
          ),
          text: row.text,
          role: row.role,
          origin: row.origin,
          createdAt: row.createdAt.toISOString(),
        }))
        .slice(0, 10);
    });
    const dispatchedNames: string[] = [];
    const dispatch = vi.fn(
      async (input: {
        task: { id: string };
        step: number;
        toolName: string;
        args: Record<string, unknown>;
      }) => {
        dispatchedNames.push(input.toolName);
        const result =
          input.toolName === 'conversations.search'
            ? {
                mode: 'semantic',
                matches: await sourceConversations(input.args as { query: string; limit: number }),
              }
            : input.toolName === 'conversations.context'
              ? {
                  mode: 'context',
                  anchors: (input.args as { anchors: unknown[] }).anchors,
                  matches: (
                    await db
                      .select()
                      .from(messages)
                      .where(
                        and(
                          eq(messages.conversationId, conversationId),
                          eq(messages.taskId, priorTaskId),
                        ),
                      )
                  ).map((row) => ({
                    messageId: row.id,
                    conversationId: row.conversationId,
                    sourceRevision: conversationMessageSourceRevision(row.id, row.text),
                    speakerRevision: conversationMessageSpeakerRevision(
                      row.id,
                      row.text,
                      row.role,
                      row.origin,
                    ),
                    text: row.text,
                    role: row.role,
                    origin: row.origin,
                    createdAt: row.createdAt.toISOString(),
                  })),
                  window: { before: 3, after: 1 },
                  observationGeneration: null,
                }
              : (() => {
                  throw new Error(`Unexpected historical source read: ${input.toolName}`);
                })();
        const [stored] = await db
          .insert(toolCalls)
          .values({
            taskId: input.task.id,
            step: input.step,
            toolName: input.toolName,
            args: input.args,
            risk: 'autonomous',
            status: 'succeeded',
            result,
          })
          .returning({ id: toolCalls.id });
        if (!stored) throw new Error('The historical search receipt was not persisted');
        return { kind: 'executed' as const, toolCallId: stored.id, result, cached: false };
      },
    );
    const scriptedObjects: unknown[] = [
      {
        selections: [
          { sourceKey: `message:${historicalMessages[0]?.id}`, quote: ownerCorrection },
          { sourceKey: `message:${historicalMessages[1]?.id}`, quote: assistantClaim },
        ],
      },
      { decision: 'publish' },
    ];
    const router = {
      step: vi.fn(async () => ({
        ok: true as const,
        modelId: 'scripted/historical-flight',
        degraded: false as const,
        text: 'The current verified departure time is 9:15 AM.',
        toolCalls: [],
        finishReason: 'stop' as const,
      })),
      object: vi.fn(async (_role: string, _input: { system: string; prompt: string }) => {
        const object = scriptedObjects.shift();
        if (!object) throw new Error('Unexpected additional model object call');
        return { ok: true, modelId: 'scripted/historical-flight', degraded: false, object };
      }),
      embed: vi.fn(async () => {
        throw new Error('Historical conversation search must not invoke semantic embeddings');
      }),
      embeddingSpace: vi.fn(async () => ({
        provider: 'scripted',
        model: 'not-used',
        dimensions: 1536,
        revision: '1',
      })),
    };
    const deps = {
      db,
      persistence,
      router,
      dispatcher: {
        toolDefs: () => [
          {
            name: 'conversations.search',
            description: 'Search persisted conversation history',
            inputSchema: {},
          },
          {
            name: 'conversations.context',
            description: 'Read bounded context around exact searched messages',
            inputSchema: {},
          },
        ],
        resultIsUntrusted: (toolName: string) =>
          toolName === 'conversations.search' || toolName === 'conversations.context',
        dispatch,
        executeApproved: vi.fn(),
      },
      notifyOwner: vi.fn(async () => ({ legs: [] })),
    } as unknown as ExecutorDeps;
    const state = taskState(lease);
    state.untrustedContext = true;
    const window = [{ role: 'user' as const, content: request }];
    const now = new Date('2026-10-13T12:00:00.000Z');
    const context = {
      deps,
      db,
      router,
      dispatcher: deps.dispatcher,
      task: lease,
      agent: { id: agentId, timezone: 'America/Los_Angeles' },
      state: state as TaskState,
      ctx: {
        taskId: currentTaskId,
        agentId,
        trust: 'owner',
        tainted: false,
        db,
        now: () => now,
        signal: new AbortController().signal,
        log: vi.fn(async () => {}),
      },
      window,
    } as unknown as RunContext;

    expect(detectPersonalReadRequest(window)?.firstToolName).toBe('conversations.search');
    const result = await runStepLoop(context, {
      action: 'reply',
      reasoning: 'Answer from persisted historical conversation sources.',
      steps: [],
      missingInfo: [],
    });

    const persisted = await db.query.messages.findMany({
      where: eq(messages.taskId, currentTaskId),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    });
    const answer = persisted.find((message) => message.role === 'assistant')?.text ?? '';
    expect(result.outcome, JSON.stringify({ result, answer })).toBe('done');
    expect(dispatchedNames).toEqual([
      ...observedQueries.map(() => 'conversations.search'),
      'conversations.context',
    ]);
    expect(observedQueries).toHaveLength(2);
    expect(observedQueries).toContain('Cobalt');
    expect(router.step).toHaveBeenCalledTimes(1);
    expect(router.embed).not.toHaveBeenCalled();
    expect(sourceConversations).toHaveBeenCalledTimes(2);
    expect(answer).toContain(`Recorded owner message:** “${ownerCorrection}”`);
    expect(answer).toContain(`Earlier assistant claim (not verified fact):** “${assistantClaim}”`);
    expect(answer).toContain(`/chat/${conversationId}#message-${historicalMessages[0]?.id}`);
    expect(answer).toContain(`/chat/${conversationId}#message-${historicalMessages[1]?.id}`);
    expect(answer).toContain('fictional exercise');
    expect(answer).not.toContain('TEST-DO-NOT-REPEAT');
  });
});
