import { createHash, randomUUID } from 'node:crypto';
import { handleChatTurn } from '@assistant/application';
import { loadConfig } from '@assistant/config';
import { type ExecutorDeps, executeTask, type ModelRouter } from '@assistant/core';
import { resetQueueNotifierForTest } from '@assistant/core/queue';
import {
  approvals,
  conversations,
  createDb,
  createPostgresApplicationChatPersistence,
  createPostgresExecutionPersistence,
  type Db,
  messages,
  recallSurfaces,
  tasks,
  toolCalls,
} from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import type { EmbeddingSpace } from '@assistant/persistence';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import type { UIMessage } from 'ai';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createChatLogOrder,
  orderChatLog,
  retireProvisionalReplies,
  retireProvisionalUserTurns,
} from '../../web/app/chat/[id]/message-reconciliation.js';

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL;
  assertAllocatedTestTarget({
    databaseUrl: url,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    kind: 'standard',
  });
  if (!url) throw new Error('Missing allocator-owned test database URL');
  return url;
})();
const SPACE: EmbeddingSpace = {
  provider: 'offline-test',
  model: 'web12-identity-fixture',
  dimensions: 1536,
  revision: '1',
};
const REQUEST_TEXT = 'What is on my calendar on October 9?';
const REPLY_TEXT = 'You have Planning review on your calendar.';

function request(conversationId: string, operationId: string): Request {
  return new Request('https://assistant.example/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      conversationId,
      clientOperationId: operationId,
      force: true,
      messages: [
        {
          id: operationId,
          role: 'user',
          parts: [{ type: 'text', text: REQUEST_TEXT }],
        },
      ],
    }),
  });
}

function messageView(row: {
  id: string;
  role: string;
  text: string;
  parts: unknown;
  createdAt: Date;
  channelMessageId?: string | null;
}): UIMessage {
  return {
    id: row.id,
    role: row.role as UIMessage['role'],
    parts: row.parts as UIMessage['parts'],
    metadata: {
      createdAt: row.createdAt.toISOString(),
      ...(row.channelMessageId ? { channelMessageId: row.channelMessageId } : {}),
    },
  } as UIMessage;
}

function optimisticUser(operationId: string, durableMessageId?: string): UIMessage {
  return {
    id: operationId,
    role: 'user',
    parts: [{ type: 'text', text: REQUEST_TEXT }],
    metadata: durableMessageId ? { durableMessageId } : {},
  } as UIMessage;
}

function syntheticPreflightRoute(modelId: string) {
  return {
    ok: true as const,
    model: {} as never,
    modelId,
    degraded: false,
    thinking: false,
    decision: { mode: 'primary' as const },
    params: {},
    promptCostPerMTok: 0,
    completionCostPerMTok: 0,
  };
}

function routerFor(
  interruptAfterCalendarRead = false,
  planSummary = 'October 9 calendar request',
): ModelRouter {
  const router = {
    route: async () => syntheticPreflightRoute('synthetic/web12'),
    async object(role: string) {
      return {
        ok: true,
        modelId: 'synthetic/web12',
        degraded: false,
        object:
          role === 'plan'
            ? {
                action: 'workflow',
                reasoning: `Read the requested calendar day for ${planSummary}.`,
                steps: ['Read the calendar for October 9.'],
                missingInfo: [],
              }
            : { decision: 'publish', reasons: [] },
      };
    },
    async embeddingSpace() {
      return SPACE;
    },
    async embed(values: string[]) {
      return values.map(() => Array.from({ length: SPACE.dimensions }, () => 0));
    },
    async step() {
      // Owner calendar questions use the executor's deterministic private-read
      // route. Its `calendar.list_events` call is already persisted before this
      // model boundary, so interrupt here to exercise the real post-receipt
      // recovery path rather than inventing a model tool call.
      if (interruptAfterCalendarRead)
        throw new Error('synthetic worker interruption after calendar receipt');
      return {
        ok: true,
        modelId: 'synthetic/web12',
        degraded: false,
        text: REPLY_TEXT,
        toolCalls: [],
        finishReason: 'stop',
      };
    },
  };
  return router as unknown as ModelRouter;
}

const dispatches: string[] = [];
const calendarCalls: Array<{
  eventId: string;
  args: { timeMin: string; timeMax: string; maxResults: number };
}> = [];

function calendarDispatcher(
  db: Db,
  persistence: ReturnType<typeof createPostgresExecutionPersistence>,
  eventId: string,
  summary: string,
): ToolDispatcher {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'calendar.list_events',
      description: 'Read one date range from the synthetic calendar fixture.',
      inputSchema: z.object({
        timeMin: z.string().datetime({ offset: true }),
        timeMax: z.string().datetime({ offset: true }),
        maxResults: z.number().int().min(1).max(50),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args) => {
        const input = args as { timeMin: string; timeMax: string; maxResults: number };
        dispatches.push(eventId);
        calendarCalls.push({ eventId, args: input });
        const start = new Date(Date.parse(input.timeMin) + 60 * 60 * 1_000).toISOString();
        const end = new Date(Date.parse(start) + 30 * 60 * 1_000).toISOString();
        return {
          calendarsSearched: ['primary'],
          complete: true,
          events: [
            {
              eventId,
              calendarId: 'primary',
              calendar: 'Primary',
              summary,
              start,
              end,
              location: 'Test room',
            },
          ],
        };
      },
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );
  return new ToolDispatcher(
    db,
    registry,
    persistence.toolExecution,
    persistence.costs,
    persistence.approvals,
    persistence.approvalPolicies,
  );
}

describe('WEB-12 persisted chat identity across interrupted card completion', () => {
  let db: Db;
  let ownerId: string;
  let chat: ReturnType<typeof createPostgresApplicationChatPersistence>;
  let persistence: ReturnType<typeof createPostgresExecutionPersistence>;
  const conversationIds: string[] = [];
  const previousQueueDriver = process.env.QUEUE_DRIVER;

  beforeAll(async () => {
    process.env.QUEUE_DRIVER = 'local';
    resetQueueNotifierForTest();
    db = createDb(DATABASE_URL);
    chat = createPostgresApplicationChatPersistence(db);
    persistence = createPostgresExecutionPersistence(db);
    ownerId = (await chat.resolveAgent()).id;
  });

  afterEach(async () => {
    dispatches.length = 0;
    calendarCalls.length = 0;
    if (!conversationIds.length) return;
    const ids = [...conversationIds];
    const taskRows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.conversationId, ids));
    const taskIds = taskRows.map((row) => row.id);
    const messageRows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(inArray(messages.conversationId, ids));
    const messageIds = messageRows.map((row) => row.id);
    if (messageIds.length) {
      await db.delete(recallSurfaces).where(inArray(recallSurfaces.lastMessageId, messageIds));
      await db.delete(messages).where(inArray(messages.id, messageIds));
    }
    if (taskIds.length) {
      await db
        .update(toolCalls)
        .set({ approvalId: null })
        .where(inArray(toolCalls.taskId, taskIds));
      await db.delete(approvals).where(inArray(approvals.taskId, taskIds));
      await db.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
    await db.delete(conversations).where(inArray(conversations.id, ids));
    conversationIds.length = 0;
  });

  afterAll(async () => {
    try {
      await db?.$client.end();
    } finally {
      resetQueueNotifierForTest();
      if (previousQueueDriver === undefined) delete process.env.QUEUE_DRIVER;
      else process.env.QUEUE_DRIVER = previousQueueDriver;
    }
  });

  it('keeps duplicate sends distinct while a persisted tool task resumes into its own card', async () => {
    const conversation = await chat.createConversation(ownerId);
    conversationIds.push(conversation.id);
    const config = loadConfig({
      NODE_ENV: process.env.NODE_ENV ?? 'test',
      PERSISTENCE_DRIVER: 'postgres',
      OPENROUTER_API_KEY: 'synthetic-not-a-real-key',
      QUEUE_DRIVER: 'local',
      CHAT_RECALL_ENABLED: 'false',
      GRAPH_RAG_ENABLED: 'false',
    });

    async function admit(operationId: string) {
      const response = await handleChatTurn(request(conversation.id, operationId), {
        config,
        db,
        chat,
        persistence,
        router: routerFor(),
      });
      await response.text();
      expect(response.status).toBe(200);
      const taskId = response.headers.get('x-async-task');
      const ownerMessageId = response.headers.get('x-owner-message-id');
      expect(taskId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(ownerMessageId).toMatch(/^[0-9a-f-]{36}$/i);
      return { taskId: taskId as string, ownerMessageId: ownerMessageId as string };
    }

    async function runTask(taskId: string, eventId: string, summary: string, interrupted: boolean) {
      const deps = {
        db,
        persistence,
        router: routerFor(interrupted),
        dispatcher: calendarDispatcher(db, persistence, eventId, summary),
      } satisfies ExecutorDeps;
      return executeTask(deps, taskId);
    }

    const operationA = randomUUID();
    const admittedA = await admit(operationA);
    expect(admittedA.ownerMessageId).not.toBe(operationA);
    const firstRun = await runTask(admittedA.taskId, 'event-a', 'Planning review', false);
    expect(firstRun.outcome, JSON.stringify(firstRun)).toBe('done');

    // A genuine server rejection before admission leaves no new database row;
    // the local failed send must not be retired by the earlier identical text.
    const failedOperation = randomUUID();
    const failedConversation = randomUUID();
    const failedResponse = await handleChatTurn(request(failedConversation, failedOperation), {
      config,
      db,
      chat,
      persistence,
      router: routerFor(false, 'Failed send'),
    });
    expect(failedResponse.status).toBe(404);
    expect(await chat.listMessages(ownerId, failedConversation, { limit: 20 })).toBeNull();
    const prior = await chat.listMessages(ownerId, conversation.id, { limit: 50 });
    expect(prior).not.toBeNull();
    const failedLocal = optimisticUser(failedOperation);
    const afterFailure = retireProvisionalUserTurns(
      [...(prior?.messages ?? []).map(messageView), failedLocal],
      new Set((prior?.messages ?? []).map((row) => row.id)),
    );
    expect(afterFailure.some((row) => row.id === failedOperation)).toBe(true);

    // Before the second POST is acknowledged, the old durable identical text is
    // present. Repeated idle merges must keep the new optimistic send visible.
    const operationB = randomUUID();
    const localB = optimisticUser(operationB);
    const beforeAck = [...(prior?.messages ?? []).map(messageView), localB];
    const once = retireProvisionalUserTurns(
      beforeAck,
      new Set(beforeAck.map((row) => row.id).filter((id) => id !== operationB)),
    );
    const twice = retireProvisionalUserTurns(
      once,
      new Set(once.map((row) => row.id).filter((id) => id !== operationB)),
    );
    expect(once.some((row) => row.id === operationB)).toBe(true);
    expect(twice.some((row) => row.id === operationB)).toBe(true);
    expect(orderChatLog(beforeAck, createChatLogOrder()).at(-1)?.id).toBe(operationB);

    const admittedB = await admit(operationB);
    const acknowledgedB = optimisticUser(operationB, admittedB.ownerMessageId);
    const afterAdmission = await chat.listMessages(ownerId, conversation.id, { limit: 50 });
    expect(afterAdmission).not.toBeNull();
    const userLog = retireProvisionalUserTurns(
      [...(afterAdmission?.messages ?? []).map(messageView), acknowledgedB],
      new Set((afterAdmission?.messages ?? []).map((row) => row.id)),
    );
    expect(userLog.some((row) => row.id === operationB)).toBe(false);
    expect(
      userLog.filter(
        (row) =>
          row.role === 'user' &&
          row.parts.some((part) => part.type === 'text' && part.text === REQUEST_TEXT),
      ),
    ).toHaveLength(2);

    const interrupted = await runTask(admittedB.taskId, 'event-b', 'Planning review', true);
    expect(interrupted.outcome).toBe('failed');
    const [sleeping] = await db.select().from(tasks).where(eq(tasks.id, admittedB.taskId));
    expect(sleeping?.status).toBe('sleeping');
    const toolReceiptBeforeResume = await db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.taskId, admittedB.taskId));
    const calendarReceiptsBeforeResume = toolReceiptBeforeResume.filter(
      (row) => row.toolName === 'calendar.list_events' && row.status === 'succeeded',
    );
    expect(calendarReceiptsBeforeResume).toHaveLength(1);
    const eventBCalls = calendarCalls.filter((call) => call.eventId === 'event-b');
    expect(eventBCalls).toHaveLength(1);
    expect(eventBCalls[0]?.args).toMatchObject({
      timeMin: expect.stringMatching(/^2026-10-09T/),
      timeMax: expect.stringMatching(/^2026-10-10T/),
      maxResults: 50,
    });
    const ledgerBeforeResume = createHash('sha256')
      .update(
        JSON.stringify(
          calendarReceiptsBeforeResume.map(({ id, toolName, status, args, result, decision }) => ({
            id,
            toolName,
            status,
            args,
            result,
            decision,
          })),
        ),
      )
      .digest('hex');
    const eventResultBeforeResume = calendarReceiptsBeforeResume[0]?.result;

    await db
      .update(tasks)
      .set({ runAfter: new Date(Date.now() - 1_000) })
      .where(eq(tasks.id, admittedB.taskId));
    const beforeResumeDispatches = dispatches.filter((id) => id === 'event-b').length;
    const resumed = await executeTask(
      {
        db,
        persistence,
        router: routerFor(),
        dispatcher: calendarDispatcher(db, persistence, 'event-b', 'Planning review'),
      },
      admittedB.taskId,
    );
    expect(resumed.outcome, JSON.stringify(resumed)).toBe('done');
    expect(dispatches.filter((id) => id === 'event-b')).toHaveLength(beforeResumeDispatches);
    expect(dispatches.filter((id) => id === 'event-b')).toHaveLength(1);
    const toolReceiptAfterResume = await db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.taskId, admittedB.taskId));
    const calendarReceiptsAfterResume = toolReceiptAfterResume.filter(
      (row) => row.toolName === 'calendar.list_events' && row.status === 'succeeded',
    );
    expect(calendarReceiptsAfterResume).toHaveLength(1);
    const ledgerAfterResume = createHash('sha256')
      .update(
        JSON.stringify(
          calendarReceiptsAfterResume.map(({ id, toolName, status, args, result, decision }) => ({
            id,
            toolName,
            status,
            args,
            result,
            decision,
          })),
        ),
      )
      .digest('hex');
    expect(ledgerAfterResume).toBe(ledgerBeforeResume);
    expect(calendarReceiptsAfterResume[0]?.result).toEqual(eventResultBeforeResume);

    const persisted = await chat.listMessages(ownerId, conversation.id, { limit: 50 });
    expect(persisted).not.toBeNull();
    const assistantRows = (persisted?.messages ?? []).filter((row) => row.role === 'assistant');
    const eventCards = assistantRows.flatMap((row) =>
      Array.isArray(row.parts)
        ? row.parts.flatMap((part) =>
            part && typeof part === 'object' && (part as { type?: unknown }).type === 'data-card'
              ? [(part as { data?: unknown }).data]
              : [],
          )
        : [],
    );
    const calendarCards = eventCards.filter(
      (card): card is Record<string, unknown> =>
        Boolean(card) &&
        typeof card === 'object' &&
        (card as { kind?: unknown }).kind === 'calendar-event',
    );
    expect(calendarCards).toHaveLength(2);
    expect(calendarCards.map((card) => card.title)).toEqual(['Planning review', 'Planning review']);
    expect(new Set(calendarCards.map((card) => card.id)).size).toBe(2);
    expect(assistantRows.filter((row) => row.text === REPLY_TEXT)).toHaveLength(2);
    expect(assistantRows[0]?.taskId).not.toBe(assistantRows[1]?.taskId);
    const eventCardHash = (rows: typeof assistantRows) =>
      createHash('sha256')
        .update(JSON.stringify(rows.map((row) => row.parts)))
        .digest('hex');
    const publishedCardHash = eventCardHash(assistantRows);
    const reread = await chat.listMessages(ownerId, conversation.id, { limit: 50 });
    const rereadAssistants = (reread?.messages ?? []).filter((row) => row.role === 'assistant');
    expect(eventCardHash(rereadAssistants)).toBe(publishedCardHash);
  });

  it('keeps two queued owner operations bound to their own trigger when A completes after B', async () => {
    const conversation = await chat.createConversation(ownerId);
    conversationIds.push(conversation.id);
    const config = loadConfig({
      NODE_ENV: process.env.NODE_ENV ?? 'test',
      PERSISTENCE_DRIVER: 'postgres',
      OPENROUTER_API_KEY: 'synthetic-not-a-real-key',
      QUEUE_DRIVER: 'local',
      CHAT_RECALL_ENABLED: 'false',
      GRAPH_RAG_ENABLED: 'false',
    });
    const requestA = 'Check my calendar for October 9.';
    const requestB = 'Check my calendar for October 10.';
    const replyA = 'A planning review is on your calendar.';
    const replyB = 'B planning review is on your calendar.';
    const operationA = randomUUID();
    const operationB = randomUUID();

    const admissionRouter = {
      async route() {
        return { ok: true, modelId: 'synthetic/web12', degraded: false };
      },
    } as unknown as ModelRouter;
    async function admit(text: string, operationId: string) {
      const response = await handleChatTurn(
        new Request('https://assistant.example/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId: conversation.id,
            clientOperationId: operationId,
            force: true,
            messages: [{ id: operationId, role: 'user', parts: [{ type: 'text', text }] }],
          }),
        }),
        { config, db, chat, persistence, router: admissionRouter },
      );
      await response.text();
      expect(response.status).toBe(200);
      const taskId = response.headers.get('x-async-task');
      const messageId = response.headers.get('x-owner-message-id');
      expect(taskId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(messageId).toMatch(/^[0-9a-f-]{36}$/i);
      return { taskId: taskId as string, messageId: messageId as string };
    }

    // Both owner sends are durably admitted before either executor starts.
    const [acceptedA, acceptedB] = await Promise.all([
      admit(requestA, operationA),
      admit(requestB, operationB),
    ]);
    expect(acceptedA.taskId).not.toBe(acceptedB.taskId);
    expect(acceptedA.messageId).not.toBe(acceptedB.messageId);
    expect(operationA).not.toBe(operationB);

    const admittedTasks = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.id, [acceptedA.taskId, acceptedB.taskId]));
    expect(admittedTasks).toHaveLength(2);
    const byOperation = new Map(
      admittedTasks.map((task) => {
        const payload = (task.trigger as { payload?: Record<string, unknown> }).payload ?? {};
        const admission = payload.chatAdmission as Record<string, unknown> | undefined;
        return [String(admission?.clientOperationId), { task, payload, admission }] as const;
      }),
    );
    const taskA = byOperation.get(operationA);
    const taskB = byOperation.get(operationB);
    expect(taskA?.task.id).toBe(acceptedA.taskId);
    expect(taskB?.task.id).toBe(acceptedB.taskId);
    expect(taskA?.payload.text).toBe(requestA);
    expect(taskB?.payload.text).toBe(requestB);
    expect(taskA?.task.status).toBe('pending');
    expect(taskB?.task.status).toBe('pending');
    expect(taskA?.admission?.phase).toBe('queued');
    expect(taskB?.admission?.phase).toBe('queued');
    expect(taskA?.admission?.triggerMessageId).toBe(acceptedA.messageId);
    expect(taskB?.admission?.triggerMessageId).toBe(acceptedB.messageId);

    const admittedMessages =
      (await chat.listMessages(ownerId, conversation.id, { limit: 20 }))?.messages ?? [];
    const ownerA = admittedMessages.find((row) => row.id === acceptedA.messageId);
    const ownerB = admittedMessages.find((row) => row.id === acceptedB.messageId);
    expect(ownerA).toMatchObject({ role: 'user', taskId: acceptedA.taskId, text: requestA });
    expect(ownerB).toMatchObject({ role: 'user', taskId: acceptedB.taskId, text: requestB });

    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let signalAAtModel!: () => void;
    const aAtModel = new Promise<void>((resolve) => {
      signalAAtModel = resolve;
    });
    function executorRouter(
      planSummary: string,
      responseText: string,
      options: { blockAtStep?: boolean } = {},
    ): ModelRouter {
      let blocked = false;
      return {
        async object(role: string) {
          return {
            ok: true,
            modelId: 'synthetic/web12',
            degraded: false,
            object:
              role === 'plan'
                ? {
                    action: 'workflow',
                    reasoning: `Read the requested calendar day for ${planSummary}.`,
                    steps: [`Read the calendar for ${planSummary}.`],
                    missingInfo: [],
                  }
                : { decision: 'publish', reasons: [] },
          };
        },
        async embeddingSpace() {
          return SPACE;
        },
        async embed(values: string[]) {
          return values.map(() => Array.from({ length: SPACE.dimensions }, () => 0));
        },
        async step() {
          if (options.blockAtStep && !blocked) {
            blocked = true;
            signalAAtModel();
            await aGate;
          }
          return {
            ok: true,
            modelId: 'synthetic/web12',
            degraded: false,
            text: responseText,
            toolCalls: [],
            finishReason: 'stop',
          };
        },
      } as unknown as ModelRouter;
    }
    function runTask(taskId: string, eventId: string, summary: string, router: ModelRouter) {
      const deps = {
        db,
        persistence,
        router,
        dispatcher: calendarDispatcher(db, persistence, eventId, summary),
      } satisfies ExecutorDeps;
      return executeTask(deps, taskId);
    }

    let workerA: Promise<Awaited<ReturnType<typeof executeTask>>> | undefined;
    let workerAResult: Awaited<ReturnType<typeof executeTask>> | undefined;
    let workerAError: unknown;
    let workerBResult: Awaited<ReturnType<typeof executeTask>> | undefined;
    let durableBId: string | undefined;
    try {
      workerA = runTask(
        acceptedA.taskId,
        'event-operation-a',
        'A planning review',
        executorRouter('October 9', replyA, { blockAtStep: true }),
      );
      let enterTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        aAtModel,
        new Promise<never>((_resolve, reject) => {
          enterTimer = setTimeout(
            () => reject(new Error('A did not reach its delayed model step')),
            10_000,
          );
        }),
      ]).finally(() => {
        if (enterTimer) clearTimeout(enterTimer);
      });
      expect(dispatches.filter((id) => id === 'event-operation-a')).toHaveLength(1);

      workerBResult = await runTask(
        acceptedB.taskId,
        'event-operation-b',
        'B planning review',
        executorRouter('October 10', replyB),
      );
      expect(workerBResult.outcome, JSON.stringify(workerBResult)).toBe('done');

      const whileAIsDelayed =
        (await chat.listMessages(ownerId, conversation.id, { limit: 20 }))?.messages ?? [];
      const assistantRowsWhileAIsDelayed = whileAIsDelayed.filter(
        (row) => row.role === 'assistant',
      );
      expect(assistantRowsWhileAIsDelayed).toHaveLength(1);
      expect(assistantRowsWhileAIsDelayed[0]).toMatchObject({
        taskId: acceptedB.taskId,
        text: replyB,
      });
      durableBId = assistantRowsWhileAIsDelayed[0]?.id;
      expect(
        whileAIsDelayed.some((row) => row.taskId === acceptedA.taskId && row.role === 'assistant'),
      ).toBe(false);

      const localReplyA: UIMessage = {
        id: `local-reply-a-${operationA}`,
        role: 'assistant',
        metadata: { clientOperationId: operationA },
        parts: [{ type: 'text', text: replyA }],
      } as UIMessage;
      const localReplyB: UIMessage = {
        id: `local-reply-b-${operationB}`,
        role: 'assistant',
        metadata: { durableMessageId: durableBId },
        parts: [{ type: 'text', text: replyB }],
      } as UIMessage;
      const serverIdsWhileAIsDelayed = new Set(whileAIsDelayed.map((row) => row.id));
      const mergedWhileAIsDelayed = retireProvisionalReplies(
        [localReplyA, localReplyB, ...whileAIsDelayed.map(messageView)],
        serverIdsWhileAIsDelayed,
      );
      expect(mergedWhileAIsDelayed.some((row) => row.id === localReplyA.id)).toBe(true);
      expect(mergedWhileAIsDelayed.some((row) => row.id === localReplyB.id)).toBe(false);
      expect(mergedWhileAIsDelayed.some((row) => row.id === durableBId)).toBe(true);
      expect(
        mergedWhileAIsDelayed
          .filter((row) => row.role === 'assistant')
          .flatMap((row) => row.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))),
      ).toEqual([replyA, replyB]);
    } finally {
      releaseA();
      if (workerA) {
        try {
          workerAResult = await workerA;
        } catch (error) {
          workerAError = error;
        }
      }
    }

    expect(workerAError).toBeUndefined();
    expect(workerAResult?.outcome, JSON.stringify(workerAResult)).toBe('done');
    expect(workerBResult?.outcome).toBe('done');
    expect(dispatches.filter((id) => id === 'event-operation-a')).toHaveLength(1);
    expect(dispatches.filter((id) => id === 'event-operation-b')).toHaveLength(1);

    const finalRows =
      (await chat.listMessages(ownerId, conversation.id, { limit: 20 }))?.messages ?? [];
    const finalTasks = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.id, [acceptedA.taskId, acceptedB.taskId]));
    expect(finalTasks).toHaveLength(2);
    const completedById = new Map(finalTasks.map((task) => [task.id, task]));
    expect(completedById.get(acceptedA.taskId)?.status).toBe('done');
    expect(completedById.get(acceptedB.taskId)?.status).toBe('done');

    const finalAssistants = finalRows.filter(
      (row) =>
        row.role === 'assistant' && [acceptedA.taskId, acceptedB.taskId].includes(row.taskId ?? ''),
    );
    expect(finalAssistants).toHaveLength(2);
    const assistantByTask = new Map(finalAssistants.map((row) => [row.taskId, row]));
    const finalA = assistantByTask.get(acceptedA.taskId);
    const finalB = assistantByTask.get(acceptedB.taskId);
    if (!finalA || !finalB) throw new Error('A completed operation has no durable reply');
    expect(finalA).toMatchObject({
      text: replyA,
    });
    expect(finalB).toMatchObject({
      id: durableBId,
      text: replyB,
    });

    const localReplyA: UIMessage = {
      id: `final-local-reply-a-${operationA}`,
      role: 'assistant',
      metadata: { durableMessageId: finalA?.id },
      parts: [{ type: 'text', text: replyA }],
    } as UIMessage;
    const localReplyB: UIMessage = {
      id: `final-local-reply-b-${operationB}`,
      role: 'assistant',
      metadata: { durableMessageId: durableBId },
      parts: [{ type: 'text', text: replyB }],
    } as UIMessage;
    const finalServerIds = new Set(finalRows.map((row) => row.id));
    const settledLog = retireProvisionalReplies(
      [localReplyA, localReplyB, ...finalRows.map(messageView)],
      finalServerIds,
    );
    expect(settledLog.some((row) => row.id === localReplyA.id)).toBe(false);
    expect(settledLog.some((row) => row.id === localReplyB.id)).toBe(false);
    const settledAssistants = settledLog.filter((row) => row.role === 'assistant');
    expect(settledAssistants).toHaveLength(2);
    expect(settledAssistants.map((row) => row.id).sort()).toEqual([finalA?.id, durableBId].sort());
    expect(settledAssistants.find((row) => row.id === durableBId)?.parts).toEqual(
      messageView(finalB).parts,
    );
  }, 30_000);

  it('reconciles persisted card-only replies by channel identity and preserves distinct payloads', async () => {
    const conversation = await chat.createConversation(ownerId);
    conversationIds.push(conversation.id);
    const taskA = await chat.createDirectChatTask({
      agentId: ownerId,
      conversationId: conversation.id,
      title: 'Card-only A',
    });
    const taskB = await chat.createDirectChatTask({
      agentId: ownerId,
      conversationId: conversation.id,
      title: 'Card-only B',
    });
    const cardA = { kind: 'weather', id: 'weather-card-a', temperature: '16°C' };
    const cardB = { kind: 'weather', id: 'weather-card-b', temperature: '19°C' };
    const observationGeneration = await chat.privacyObservationGeneration(ownerId);
    expect(
      await chat.completeDirectChatTask({
        agentId: ownerId,
        task: taskA,
        status: 'done',
        progress: 'Persist card A',
        privacyObservationGeneration: observationGeneration,
        messages: [
          {
            conversationId: conversation.id,
            taskId: taskA.id,
            channelMessageId: `chat-reply:${taskA.id}`,
            role: 'assistant',
            origin: 'assistant',
            parts: [{ type: 'data-card', data: cardA }],
            text: '',
          },
        ],
      }),
    ).toBe(true);
    const localA: UIMessage = {
      id: 'local-card-a',
      role: 'assistant',
      metadata: { channelMessageId: `chat-reply:${taskA.id}` },
      parts: [{ type: 'data-card', data: cardA } as UIMessage['parts'][number]],
    } as UIMessage;
    const localB: UIMessage = {
      id: 'local-card-b',
      role: 'assistant',
      metadata: { channelMessageId: `chat-reply:${taskB.id}` },
      parts: [{ type: 'data-card', data: cardB } as UIMessage['parts'][number]],
    } as UIMessage;
    const afterFirstPersist = await chat.listMessages(ownerId, conversation.id, { limit: 20 });
    expect(afterFirstPersist?.messages).toHaveLength(1);
    const durableA = afterFirstPersist?.messages.map(messageView) ?? [];
    const pendingCards = retireProvisionalReplies(
      [localA, localB, ...durableA],
      new Set(durableA.map((row) => row.id)),
    );
    expect(pendingCards.some((row) => row.id === localA.id)).toBe(false);
    expect(pendingCards.some((row) => row.id === localB.id)).toBe(true);
    expect(
      pendingCards.flatMap((row) =>
        row.parts.flatMap((part) => (part.type === 'data-card' ? [part.data] : [])),
      ),
    ).toEqual(expect.arrayContaining([cardA, cardB]));

    expect(
      await chat.completeDirectChatTask({
        agentId: ownerId,
        task: taskB,
        status: 'done',
        progress: 'Persist card B',
        privacyObservationGeneration: observationGeneration,
        messages: [
          {
            conversationId: conversation.id,
            taskId: taskB.id,
            channelMessageId: `chat-reply:${taskB.id}`,
            role: 'assistant',
            origin: 'assistant',
            parts: [{ type: 'data-card', data: cardB }],
            text: '',
          },
        ],
      }),
    ).toBe(true);
    const afterSecondPersist = await chat.listMessages(ownerId, conversation.id, { limit: 20 });
    expect(afterSecondPersist?.messages).toHaveLength(2);
    const durableBoth = afterSecondPersist?.messages.map(messageView) ?? [];
    const settled = retireProvisionalReplies(
      [localB, ...durableBoth],
      new Set(durableBoth.map((row) => row.id)),
    );
    expect(settled.some((row) => row.id === localB.id)).toBe(false);
    expect(settled.filter((row) => row.role === 'assistant')).toHaveLength(2);
    expect(
      settled.flatMap((row) =>
        row.parts.flatMap((part) => (part.type === 'data-card' ? [part.data] : [])),
      ),
    ).toEqual(expect.arrayContaining([cardA, cardB]));
  });
});
