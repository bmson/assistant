/**
 * Exercise handleChatTurn with real durable chat adapters. The first Response
 * is deliberately dropped after handleChatTurn has committed its receipt.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig, resetConfigForTest } from '@assistant/config';
import type { ModelRouter } from '@assistant/core/model-router';
import { createDb, createPostgresApplicationChatPersistence } from '@assistant/db';
import { conversations, messages, tasks } from '@assistant/db/schema';
import { createInstallationStore, FirestoreApplicationChatPersistence } from '@assistant/firestore';
import type { ApplicationChatPersistence } from '@assistant/persistence';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatTurnDependencies,
  handleChatTurn,
} from '../packages/application/src/chat-turn.js';

const TEST_TEXT = 'Say hello.';

// Keep only the classifier and reply stream under test; these ambient reads are
// unrelated to operation replay and must never touch external/provider state.
vi.mock('@assistant/core/memory/commitments', () => ({
  listOpenCommitments: async () => [],
  renderOpenCommitments: () => '',
}));
vi.mock('@assistant/core/memory/ambient', () => ({ getAmbientBlock: async () => undefined }));
vi.mock('@assistant/core/memory/consolidation', () => ({ getOwnerCard: async () => undefined }));
const testConfig = () =>
  loadConfig({
    OPENROUTER_API_KEY: 'test-only-key',
    QUEUE_DRIVER: 'local',
    CHAT_RECALL_ENABLED: 'false',
    GRAPH_RAG_ENABLED: 'false',
  });

afterEach(() => resetConfigForTest());

function request(conversationId: string, operationId: string) {
  return new Request('https://assistant.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      clientOperationId: operationId,
      messages: [{ id: operationId, role: 'user', parts: [{ type: 'text', text: TEST_TEXT }] }],
    }),
  });
}

function countedRouter() {
  const calls = { route: 0, classify: 0, stream: 0 };
  const router = {
    route: async () => {
      calls.route += 1;
      return { ok: true, modelId: 'test/model' };
    },
    object: async () => {
      calls.classify += 1;
      return { ok: true, object: { needsAction: false } };
    },
    stream: async (_role: string, options: { onComplete(text: string): Promise<void> }) => {
      calls.stream += 1;
      await options.onComplete('Hello.');
      return {
        ok: true,
        modelId: 'test/model',
        degraded: false,
        text: Promise.resolve('Hello.'),
        toUIMessageStream: () =>
          (async function* () {
            yield { type: 'start' };
            yield { type: 'text-start', id: 'answer' };
            yield { type: 'text-delta', id: 'answer', delta: 'Hello.' };
            yield { type: 'text-end', id: 'answer' };
          })(),
      };
    },
  } as unknown as ModelRouter;
  return { router, calls };
}

async function verifyLostResponseReplay(input: {
  chat: ApplicationChatPersistence;
  conversationId: string;
  inspect(): Promise<{ ownerMessages: number; assistantMessages: number; taskIds: string[] }>;
}) {
  const operationId = randomUUID();
  const { router, calls } = countedRouter();
  const config = testConfig();
  const dependencies = {
    config,
    router,
    chat: input.chat,
    persistence: { tasks: {}, ownerContext: {} },
  } as ChatTurnDependencies;

  // The application completes durable admission and returns the acceptance
  // response. Simulate the network dropping it before the client receives it.
  const droppedResponse = await handleChatTurn(
    request(input.conversationId, operationId),
    dependencies,
  );
  expect(droppedResponse.status).toBe(200);
  const firstMessageId = droppedResponse.headers.get('x-owner-message-id');
  expect(firstMessageId).toBeTruthy();
  await droppedResponse.body?.cancel();
  const afterFirst = await input.inspect();
  expect(afterFirst.taskIds).toHaveLength(1);
  const firstTaskId = afterFirst.taskIds[0];
  expect(firstTaskId).toBeTruthy();

  // Client retries the exact frozen request with the same operation ID.
  const replayResponse = await handleChatTurn(
    request(input.conversationId, operationId),
    dependencies,
  );
  expect(replayResponse.status).toBe(200);
  expect(replayResponse.headers.get('x-async-task')).toBe(firstTaskId);
  expect(replayResponse.headers.get('x-owner-message-id')).toBe(firstMessageId);
  await replayResponse.body?.cancel();
  expect(await input.inspect()).toEqual(afterFirst);
  expect(afterFirst.ownerMessages).toBe(1);
  expect(afterFirst.taskIds).toEqual([firstTaskId]);
  // The replay must return before classification or streamed model work.
  expect(calls.classify).toBe(1);
  expect(calls.stream).toBe(1);

  // Repeating identical text with a fresh operation ID is an intentional send.
  const distinctResponse = await handleChatTurn(
    request(input.conversationId, randomUUID()),
    dependencies,
  );
  expect(distinctResponse.status).toBe(200);
  await distinctResponse.body?.cancel();
  expect(await input.inspect()).toMatchObject({ ownerMessages: 2, assistantMessages: 2 });
  expect(calls.classify).toBe(2);
  expect(calls.stream).toBe(2);
}

describe('P02 durable chat admission replay composition', () => {
  it('replays a lost response against the PostgreSQL adapter without new work', async () => {
    const db = createDb(
      process.env.DATABASE_URL ?? 'postgres://assistant@127.0.0.1:55432/assistant_test',
    );
    let conversationId: string | undefined;
    try {
      const chat = createPostgresApplicationChatPersistence(db);
      const agent = await chat.resolveAgent();
      const conversation = await chat.createConversation(agent.id);
      conversationId = conversation.id;
      const admittedConversationId = conversation.id;
      await verifyLostResponseReplay({
        chat,
        conversationId,
        inspect: async () => {
          const durableMessages =
            (await chat.listMessages(agent.id, admittedConversationId, { limit: 20 }))?.messages ??
            [];
          const durableTasks = await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              and(eq(tasks.agentId, agent.id), eq(tasks.conversationId, admittedConversationId)),
            );
          return {
            ownerMessages: durableMessages.filter((message) => message.role === 'user').length,
            assistantMessages: durableMessages.filter((message) => message.role === 'assistant')
              .length,
            taskIds: durableTasks.map((task) => task.id).sort(),
          };
        },
      });
    } finally {
      if (conversationId) {
        await db.delete(messages).where(eq(messages.conversationId, conversationId));
        await db.delete(tasks).where(eq(tasks.conversationId, conversationId));
        await db.delete(conversations).where(eq(conversations.id, conversationId));
      }
      await db.$client.end();
    }
  });

  it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
    'replays a lost response against the Firestore emulator without new work',
    async () => {
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? ''))
        throw new Error('This integration test only permits a loopback Firestore emulator');
      const store = createInstallationStore({
        projectId: 'demo-assistant-test',
        installationId: `p02-${randomUUID()}`,
      });
      const agentId = randomUUID();
      try {
        await store.doc('agents', agentId).set({
          id: agentId,
          name: 'P02 test owner',
          email: `${agentId}@example.test`,
          timezone: 'UTC',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        const chat = new FirestoreApplicationChatPersistence(store, agentId);
        const conversation = await chat.createConversation(agentId);
        await verifyLostResponseReplay({
          chat,
          conversationId: conversation.id,
          inspect: async () => {
            const durableMessages =
              (await chat.listMessages(agentId, conversation.id, { limit: 20 }))?.messages ?? [];
            const durableTasks = await store
              .collection('tasks')
              .where('conversationId', '==', conversation.id)
              .get();
            return {
              ownerMessages: durableMessages.filter((message) => message.role === 'user').length,
              assistantMessages: durableMessages.filter((message) => message.role === 'assistant')
                .length,
              taskIds: durableTasks.docs
                .map((task) => {
                  const id: unknown = task.get('id');
                  if (typeof id !== 'string') throw new Error('Durable task ID is missing');
                  return id;
                })
                .sort(),
            };
          },
        });
      } finally {
        await store.db.recursiveDelete(store.root);
        await store.db.terminate();
      }
    },
  );
});
