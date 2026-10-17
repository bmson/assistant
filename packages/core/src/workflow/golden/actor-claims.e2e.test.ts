import { randomUUID } from 'node:crypto';
import { conversations, createDb, type Db, messages, tasks, toolCalls } from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getAgent } from '../../chat.js';
import { runGoldenTask } from './harness.js';

let db: Db;
let agentId: string;
const taskIds: string[] = [];
const conversationIds: string[] = [];

beforeAll(async () => {
  assertAllocatedTestTarget({
    databaseUrl: process.env.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    kind: 'standard',
  });
  db = createDb(process.env.DATABASE_URL as string);
  agentId = (await getAgent(db)).id;
});

afterAll(async () => {
  if (conversationIds.length)
    await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
  if (taskIds.length) {
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
    await db.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  if (conversationIds.length)
    await db.delete(conversations).where(inArray(conversations.id, conversationIds));
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
});

describe('actor-aware claims in delivered answers', () => {
  it.each([
    ['The client has been contacted by Mira. Her document is ready.', false],
    ['Mira checked the calendar and sent the email.', false],
    ['The client has been contacted by me. Her document is ready.', true],
    ['Her document was created by me.', true],
    ['Her document was updated by me today.', true],
    ['Her document, which I updated, is ready.', true],
    ['Mira checked the calendar, Assistant reviewed the agenda and sent the email.', true],
  ])('persists an honest answer through finalization: %s', async (draft, blocked) => {
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: `actor-claims-${randomUUID()}` })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('Synthetic conversation was not created');
    conversationIds.push(conversation.id);
    const result = await runGoldenTask(db, agentId, {
      name: 'actor-aware-status-summary',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: 'Give me a brief status update from the project record.' },
      },
      pinOwnerRequest: true,
      taskType: 'chat_turn',
      plan: {
        action: 'workflow',
        reasoning: 'Read the project record and summarize it.',
        steps: ['Read the project record', 'Summarize the status'],
        missingInfo: [],
      },
      script: [
        { toolCalls: [{ toolName: 'docs.get', input: { documentId: 'synthetic-project' } }] },
        { text: draft },
      ],
      tools: {
        'docs.get': {
          schema: z.object({ documentId: z.string() }),
          execute: async () => ({
            documentId: 'synthetic-project',
            text: 'Mira checked the calendar and sent the email. The client has been contacted by Mira. Her document is ready.',
          }),
        },
      },
    });
    taskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['docs.get']);
    const replies = await db
      .select({ text: messages.text, role: messages.role })
      .from(messages)
      .where(eq(messages.taskId, result.taskId));
    const answers = replies.filter((reply) => reply.role === 'assistant');
    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toBe(result.finalText);
    if (blocked) {
      expect(result.finalText).not.toBe(draft);
      expect(result.finalText).toContain('No external change was made');
    } else {
      expect(result.status).toBe('done');
      expect(result.finalText).toBe(draft);
    }
  });
});
