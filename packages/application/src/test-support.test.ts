/** Test-only database fixtures. Production code must not import this subpath. */
import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import { buildRequestChecklist } from '@assistant/core/workflow/request-checklist';
import { agents, createDb, createPostgresApplicationChatPersistence, tasks } from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { newTaskRecord } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

export { buildRequestChecklist };

describe('Activity correction test fixtures', () => {
  it('builds the owner checklist used by route composition tests', () => {
    expect(buildRequestChecklist('Find my hotel and remind me about the hotel')).toMatchObject({
      version: 1,
      items: [{ kind: 'lookup' }, { kind: 'reminder' }],
    });
  });
});

export async function createActivityCorrectionRouteFixture() {
  assertAllocatedTestTarget({
    databaseUrl: process.env.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    kind: process.env.ASSISTANT_TEST_TARGET_KIND === 'restore' ? 'restore' : 'standard',
  });
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('Activity correction route fixture has no database URL');
  const db = createDb(databaseUrl);
  const taskId = randomUUID();
  const blockedTaskId = randomUUID();
  const foreignTaskId = randomUUID();
  const foreignAgentId = randomUUID();
  const originalMessageId = randomUUID();
  const correctionMessageId = randomUUID();
  const blockedOriginalMessageId = randomUUID();
  const blockedCorrectionMessageId = randomUUID();
  const requestText = 'Find my hotel and remind me about the hotel';
  const replacementLabel = 'Find my flight from Berlin to Paris';
  const checklist = buildRequestChecklist(requestText);
  if (!checklist) throw new Error('test checklist is invalid');
  const lookup = checklist.items.find((item) => item.kind === 'lookup');
  if (!lookup) throw new Error('test checklist has no lookup item');

  const owner = await getAgent(db);
  const chat = createPostgresApplicationChatPersistence(db);
  const conversation = await chat.createConversation(owner.id);
  const now = new Date();
  await db.insert(tasks).values([
    {
      ...newTaskRecord(
        {
          agentId: owner.id,
          conversationId: conversation.id,
          type: 'chat_turn',
          trust: 'owner',
          trigger: {
            source: 'chat',
            agentId: owner.id,
            conversationId: conversation.id,
            trust: 'owner',
            payload: { text: requestText, triggerMessageId: originalMessageId },
          },
        },
        taskId,
        now,
      ),
      status: 'needs_attention',
      queueGeneration: 2,
      state: { requestChecklist: checklist },
    },
    {
      ...newTaskRecord(
        {
          agentId: owner.id,
          conversationId: conversation.id,
          type: 'chat_turn',
          trust: 'owner',
          trigger: {
            source: 'chat',
            agentId: owner.id,
            conversationId: conversation.id,
            trust: 'owner',
            payload: { text: requestText, triggerMessageId: blockedOriginalMessageId },
          },
        },
        blockedTaskId,
        now,
      ),
      status: 'needs_attention',
      queueGeneration: 7,
      state: {
        requestChecklist: checklist,
        pendingToolBatch: { calls: [{ toolCallId: 'unresolved-effect' }] },
      },
    },
  ]);
  await db.insert(agents).values({
    id: foreignAgentId,
    name: 'Foreign route test owner',
    email: `foreign-${foreignAgentId}@test.invalid`,
    workspacePrefix: `foreign-test/${foreignAgentId}`,
  });
  await db.insert(tasks).values({
    ...newTaskRecord(
      {
        agentId: foreignAgentId,
        conversationId: conversation.id,
        type: 'chat_turn',
        trust: 'owner',
        trigger: { source: 'chat', payload: { text: requestText } },
      },
      foreignTaskId,
      now,
    ),
    status: 'needs_attention',
    state: { requestChecklist: checklist },
  });
  const [originalMessage, blockedOriginalMessage] = await Promise.all([
    chat.appendOwned(owner.id, {
      conversationId: conversation.id,
      taskId,
      role: 'user',
      origin: 'owner',
      text: requestText,
      parts: [{ type: 'text', text: requestText }],
    }),
    chat.appendOwned(owner.id, {
      conversationId: conversation.id,
      taskId: blockedTaskId,
      role: 'user',
      origin: 'owner',
      text: requestText,
      parts: [{ type: 'text', text: requestText }],
    }),
  ]);
  if (!originalMessage || !blockedOriginalMessage)
    throw new Error('test owner messages were not persisted');
  for (const [id, messageId] of [
    [taskId, originalMessage.id],
    [blockedTaskId, blockedOriginalMessage.id],
  ] as const) {
    await db
      .update(tasks)
      .set({
        trigger: {
          source: 'chat',
          agentId: owner.id,
          conversationId: conversation.id,
          trust: 'owner',
          payload: { text: requestText, triggerMessageId: messageId },
        },
      })
      .where(eq(tasks.id, id));
  }

  return {
    taskId,
    blockedTaskId,
    foreignTaskId,
    conversationId: conversation.id,
    correctionMessageId,
    blockedCorrectionMessageId,
    requestText,
    replacementLabel,
    lookupItemId: lookup.id,
    checklist,
    async readTask(id: string) {
      const [row] = await db.$client.unsafe(
        'SELECT id, status, queue_generation, plan, state FROM tasks WHERE id = $1',
        [id],
      );
      if (!row) return undefined;
      return row as unknown as {
        id: string;
        status: string;
        queue_generation: number;
        plan: unknown;
        state: Record<string, unknown>;
      };
    },
    async readMessage(id: string) {
      return db.$client.unsafe(
        'SELECT id, task_id, conversation_id, role, origin, text FROM messages WHERE id = $1',
        [id],
      );
    },
    async dispose() {
      await db.$client.unsafe('DELETE FROM messages WHERE conversation_id = $1', [conversation.id]);
      await db.$client.unsafe('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [
        [taskId, blockedTaskId, foreignTaskId],
      ]);
      await db.$client.unsafe('DELETE FROM conversations WHERE id = $1', [conversation.id]);
      await db.$client.unsafe('DELETE FROM agents WHERE id = $1', [foreignAgentId]);
      await db.$client.end();
    },
  };
}
