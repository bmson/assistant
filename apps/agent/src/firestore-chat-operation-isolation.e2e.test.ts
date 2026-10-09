import { randomUUID } from 'node:crypto';
import { handleChatTurn } from '@assistant/application';
import { loadConfig } from '@assistant/config';
import { type ExecutorDeps, executeTask, type ModelRouter } from '@assistant/core';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreApplicationChatPersistence,
} from '@assistant/firestore';
import type { EmbeddingSpace } from '@assistant/persistence';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import type { UIMessage } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { retireProvisionalReplies } from '../../web/app/chat/[id]/message-reconciliation.js';

const enabled = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');
const SPACE: EmbeddingSpace = {
  provider: 'synthetic',
  model: 'p02-firestore-operation-race',
  dimensions: 1536,
  revision: '1',
};
const REPLY_A = 'A planning review is on your calendar.';
const REPLY_B = 'B planning review is on your calendar.';

const unavailableDb = new Proxy(
  {},
  {
    get: (_target, property) => {
      throw new Error(
        `Unexpected PostgreSQL access in Firestore operation test: ${String(property)}`,
      );
    },
  },
) as Db;

function route(modelId: string) {
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

function config(agentId: string, installationId: string) {
  return loadConfig({
    NODE_ENV: process.env.NODE_ENV ?? 'test',
    PERSISTENCE_DRIVER: 'firestore',
    FIRESTORE_AGENT_ID: agentId,
    ASSISTANT_WORKSPACE_ID: installationId,
    FIRESTORE_EMBEDDING_SPACE: JSON.stringify(SPACE),
    OPENROUTER_API_KEY: 'synthetic-not-a-real-key',
    QUEUE_DRIVER: 'local',
    CHAT_RECALL_ENABLED: 'false',
    GRAPH_RAG_ENABLED: 'false',
  });
}

function messageView(row: {
  id: string;
  role: string;
  parts: unknown;
  createdAt: Date;
}): UIMessage {
  return {
    id: row.id,
    role: row.role as UIMessage['role'],
    parts: row.parts as UIMessage['parts'],
    metadata: { createdAt: row.createdAt.toISOString() },
  } as UIMessage;
}

describe.skipIf(!enabled)('P02 Firestore queued owner-operation isolation', () => {
  let store: InstallationStore | undefined;

  afterEach(async () => {
    if (store) await disposeStore(store);
    store = undefined;
  });

  it('keeps delayed task A and completed task B bound to their own owner messages', async () => {
    store = emulatorStore();
    const agentId = randomUUID();
    await store.doc('agents', agentId).set({
      id: agentId,
      name: 'Synthetic P02 owner',
      email: `${agentId}@example.test`,
      timezone: 'UTC',
    });
    await store.doc('coordination', 'budget-policy').set({
      dailyLimitMicros: 1_000_000,
      monthlyLimitMicros: 10_000_000,
      softPct: 80,
    });

    const chat = new FirestoreApplicationChatPersistence(store, agentId);
    const persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
    const conversation = await chat.createConversation(agentId);
    const runConfig = config(agentId, store.installationId);
    const requestA = 'Check my calendar for October 9.';
    const requestB = 'Check my calendar for October 10.';
    const operationA = randomUUID();
    const operationB = randomUUID();

    const admissionRouter = {
      async route() {
        return route('synthetic/p02-firestore-admission');
      },
    } as unknown as ModelRouter;

    async function admit(text: string, operationId: string) {
      const response = await handleChatTurn(
        new Request('http://assistant.local/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId: conversation.id,
            clientOperationId: operationId,
            force: true,
            messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
          }),
        }),
        { config: runConfig, router: admissionRouter, chat, persistence },
      );
      await response.text();
      expect(response.status).toBe(200);
      const taskId = response.headers.get('x-async-task');
      const messageId = response.headers.get('x-owner-message-id');
      expect(taskId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(messageId).toMatch(/^[0-9a-f-]{36}$/i);
      return { taskId: taskId as string, messageId: messageId as string };
    }

    // Both admissions commit before either Firestore task is executed.
    const [acceptedA, acceptedB] = await Promise.all([
      admit(requestA, operationA),
      admit(requestB, operationB),
    ]);
    expect(operationA).not.toBe(operationB);
    expect(acceptedA.taskId).not.toBe(acceptedB.taskId);
    expect(acceptedA.messageId).not.toBe(acceptedB.messageId);

    const [taskA, taskB] = await Promise.all([
      persistence.tasks.getTask(acceptedA.taskId),
      persistence.tasks.getTask(acceptedB.taskId),
    ]);
    if (!taskA || !taskB) throw new Error('Firestore did not persist both admitted tasks');
    const admissionA = (
      taskA.trigger as { payload?: { text?: string; chatAdmission?: Record<string, unknown> } }
    ).payload;
    const admissionB = (
      taskB.trigger as { payload?: { text?: string; chatAdmission?: Record<string, unknown> } }
    ).payload;
    expect(taskA).toMatchObject({
      id: acceptedA.taskId,
      status: 'pending',
      conversationId: conversation.id,
    });
    expect(taskB).toMatchObject({
      id: acceptedB.taskId,
      status: 'pending',
      conversationId: conversation.id,
    });
    expect(admissionA?.text).toBe(requestA);
    expect(admissionB?.text).toBe(requestB);
    expect(admissionA?.chatAdmission).toMatchObject({
      clientOperationId: operationA,
      phase: 'queued',
      triggerMessageId: acceptedA.messageId,
    });
    expect(admissionB?.chatAdmission).toMatchObject({
      clientOperationId: operationB,
      phase: 'queued',
      triggerMessageId: acceptedB.messageId,
    });

    const ownerRows =
      (await chat.listMessages(agentId, conversation.id, { limit: 20 }))?.messages ?? [];
    expect(ownerRows.find((row) => row.id === acceptedA.messageId)).toMatchObject({
      id: acceptedA.messageId,
      role: 'user',
      taskId: acceptedA.taskId,
      text: requestA,
    });
    expect(ownerRows.find((row) => row.id === acceptedB.messageId)).toMatchObject({
      id: acceptedB.messageId,
      role: 'user',
      taskId: acceptedB.taskId,
      text: requestB,
    });

    const dispatches: string[] = [];
    const calendarCalls: Array<{ eventId: string; args: { timeMin: string; timeMax: string } }> =
      [];
    function calendarDispatcher(eventId: string, summary: string): ToolDispatcher {
      const registry = new ToolRegistry();
      registry.register(
        {
          name: 'calendar.list_events',
          description: 'Read one date range from the local synthetic calendar fixture.',
          inputSchema: z.object({
            timeMin: z.string().datetime({ offset: true }),
            timeMax: z.string().datetime({ offset: true }),
            maxResults: z.number().int().min(1).max(50),
          }),
          risk: 'autonomous',
          acceptsUntrustedInput: true,
          execute: async (args) => {
            const input = args as { timeMin: string; timeMax: string };
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
                  location: 'Synthetic test room',
                },
              ],
            };
          },
        },
        { confidentialRead: true, returnsUntrustedContent: true },
      );
      return new ToolDispatcher(
        unavailableDb,
        registry,
        persistence.toolExecution,
        persistence.costs,
        persistence.approvals,
        persistence.approvalPolicies,
      );
    }

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let signalAAtModel!: () => void;
    const aAtModel = new Promise<void>((resolve) => {
      signalAAtModel = resolve;
    });
    function executorRouter(
      planSummary: string,
      responseText: string,
      blockAtStep = false,
    ): ModelRouter {
      let blocked = false;
      return {
        async object(role: string) {
          return {
            ok: true,
            modelId: 'synthetic/p02-firestore-executor',
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
          return values.map(() => new Array(SPACE.dimensions).fill(0));
        },
        async step() {
          if (blockAtStep && !blocked) {
            blocked = true;
            signalAAtModel();
            await gateA;
          }
          return {
            ok: true,
            modelId: 'synthetic/p02-firestore-executor',
            degraded: false,
            text: responseText,
            toolCalls: [],
            finishReason: 'stop',
          };
        },
      } as unknown as ModelRouter;
    }
    function runTask(taskId: string, eventId: string, summary: string, router: ModelRouter) {
      const deps: ExecutorDeps = {
        db: unavailableDb,
        persistence,
        router,
        dispatcher: calendarDispatcher(eventId, summary),
      };
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
        'firestore-event-operation-a',
        'A planning review',
        executorRouter('October 9', REPLY_A, true),
      );
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        aAtModel,
        new Promise<never>((_resolve, reject) => {
          waitTimer = setTimeout(
            () => reject(new Error('Firestore task A did not reach its delayed model step')),
            10_000,
          );
        }),
      ]).finally(() => {
        if (waitTimer) clearTimeout(waitTimer);
      });
      expect(dispatches.filter((id) => id === 'firestore-event-operation-a')).toHaveLength(1);

      workerBResult = await runTask(
        acceptedB.taskId,
        'firestore-event-operation-b',
        'B planning review',
        executorRouter('October 10', REPLY_B),
      );
      expect(workerBResult.outcome, JSON.stringify(workerBResult)).toBe('done');

      const whileAIsDelayed =
        (await chat.listMessages(agentId, conversation.id, { limit: 20 }))?.messages ?? [];
      const assistantRows = whileAIsDelayed.filter((row) => row.role === 'assistant');
      expect(assistantRows).toHaveLength(1);
      expect(assistantRows[0]).toMatchObject({
        id: expect.any(String),
        taskId: acceptedB.taskId,
        text: REPLY_B,
      });
      durableBId = assistantRows[0]?.id;
      expect(
        whileAIsDelayed.some((row) => row.taskId === acceptedA.taskId && row.role === 'assistant'),
      ).toBe(false);
      expect(dispatches.filter((id) => id === 'firestore-event-operation-b')).toHaveLength(1);
      expect(
        calendarCalls.filter((call) => call.eventId === 'firestore-event-operation-b'),
      ).toHaveLength(1);

      const localReplyA: UIMessage = {
        id: `local-reply-a-${operationA}`,
        role: 'assistant',
        metadata: { taskId: acceptedA.taskId },
        parts: [{ type: 'text', text: REPLY_A }],
      } as UIMessage;
      const localReplyB: UIMessage = {
        id: `local-reply-b-${operationB}`,
        role: 'assistant',
        metadata: { taskId: acceptedB.taskId, durableMessageId: durableBId },
        parts: [{ type: 'text', text: REPLY_B }],
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
      ).toEqual([REPLY_A, REPLY_B]);
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
    expect(dispatches.filter((id) => id === 'firestore-event-operation-a')).toHaveLength(1);
    expect(dispatches.filter((id) => id === 'firestore-event-operation-b')).toHaveLength(1);
    expect(
      calendarCalls.filter((call) => call.eventId === 'firestore-event-operation-a'),
    ).toHaveLength(1);
    expect(
      calendarCalls.filter((call) => call.eventId === 'firestore-event-operation-b'),
    ).toHaveLength(1);

    const finalRows =
      (await chat.listMessages(agentId, conversation.id, { limit: 20 }))?.messages ?? [];
    const finalAssistants = finalRows.filter(
      (row) =>
        row.role === 'assistant' && [acceptedA.taskId, acceptedB.taskId].includes(row.taskId ?? ''),
    );
    expect(finalAssistants).toHaveLength(2);
    const finalA = finalAssistants.find((row) => row.taskId === acceptedA.taskId);
    const finalB = finalAssistants.find((row) => row.taskId === acceptedB.taskId);
    expect(finalA).toMatchObject({ taskId: acceptedA.taskId, text: REPLY_A });
    expect(finalB).toMatchObject({ id: durableBId, taskId: acceptedB.taskId, text: REPLY_B });
    expect(finalA?.id).not.toBe(finalB?.id);
    expect((await persistence.tasks.getTask(acceptedA.taskId))?.status).toBe('done');
    expect((await persistence.tasks.getTask(acceptedB.taskId))?.status).toBe('done');

    const localReplyA: UIMessage = {
      id: `final-local-reply-a-${operationA}`,
      role: 'assistant',
      metadata: { taskId: acceptedA.taskId, durableMessageId: finalA?.id },
      parts: [{ type: 'text', text: REPLY_A }],
    } as UIMessage;
    const localReplyB: UIMessage = {
      id: `final-local-reply-b-${operationB}`,
      role: 'assistant',
      metadata: { taskId: acceptedB.taskId, durableMessageId: finalB?.id },
      parts: [{ type: 'text', text: REPLY_B }],
    } as UIMessage;
    const finalServerIds = new Set(finalRows.map((row) => row.id));
    const settled = retireProvisionalReplies(
      [localReplyA, localReplyB, ...finalRows.map(messageView)],
      finalServerIds,
    );
    expect(settled.some((row) => row.id === localReplyA.id)).toBe(false);
    expect(settled.some((row) => row.id === localReplyB.id)).toBe(false);
    expect(settled.some((row) => row.id === finalA?.id)).toBe(true);
    expect(settled.some((row) => row.id === finalB?.id)).toBe(true);
  }, 90_000);
});
