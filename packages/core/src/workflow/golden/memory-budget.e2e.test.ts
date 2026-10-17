import { approvals, conversations, createDb, messages, tasks, toolCalls } from '@assistant/db';
import {
  conversationMessageSourceRevision,
  conversationMessageSpeakerRevision,
} from '@assistant/persistence';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getAgent } from '../../chat.js';
import { runGoldenTask } from './harness.js';

const db = createDb(
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant',
);
let agentId: string;
const chatIds: string[] = [];
const taskIds: string[] = [];
beforeAll(async () => {
  agentId = (await getAgent(db)).id;
});
afterAll(async () => {
  if (chatIds.length) await db.delete(messages).where(inArray(messages.conversationId, chatIds));
  if (taskIds.length) {
    await db.delete(approvals).where(inArray(approvals.taskId, taskIds));
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
    await db.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  if (chatIds.length) await db.delete(conversations).where(inArray(conversations.id, chatIds));
  await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
});

const requests = [
  'Find the earlier hypothetical planning exercise called Nimbus in our past chats. Recall its project name, budget, deadline, and travel constraint, citing the conversation source. Clearly distinguish the fictional exercise from facts about me. Do not use email or calendar, and do not save new memories.',
  'Look back at the earlier hypothetical Nimbus exercise. Did I earmark its project budget for public transport, or was that an Assistant inference? Separate my original budget and travel constraint from the Assistant’s suggested next step, citing the relevant conversation messages. Keep the fictional exercise separate from my real plans, and do not save new memories.',
];

describe('historical recall through the real executor after budget-rejected follow-up reads', () => {
  it.each(requests)(
    'delivers source-backed history rather than an empty-memory notice: %s',
    async (text) => {
      const [sourceChat, testChat] = await db
        .insert(conversations)
        .values([
          { agentId, channel: 'chat', trust: 'owner', title: 'Fictional Nimbus source' },
          { agentId, channel: 'chat', trust: 'owner', title: 'Bounded recall test' },
        ])
        .returning();
      if (!sourceChat || !testChat) throw new Error('Source fixture was not persisted');
      chatIds.push(sourceChat.id, testChat.id);
      const sourceRows = await db
        .insert(messages)
        .values([
          {
            conversationId: sourceChat.id,
            role: 'user',
            origin: 'owner',
            text: 'For this hypothetical exercise only, the project is named Nimbus, the budget is €310, the deadline is Thursday, and we must avoid taxi travel. Acknowledge only.',
          },
          {
            conversationId: sourceChat.id,
            role: 'assistant',
            origin: 'assistant',
            text: 'For Nimbus, a sensible next step is to map public transport options within the €310 travel limit.',
          },
        ])
        .returning();
      const result = await runGoldenTask(db, agentId, {
        name: 'successful text history followed by failed semantic passes',
        pinOwnerRequest: true,
        taskType: 'chat_turn',
        event: {
          source: 'chat',
          trust: 'owner',
          payload: { text, conversationId: testChat.id },
        },
        plan: {
          action: 'workflow',
          reasoning: 'Read recorded history and answer.',
          steps: ['Read history', 'Answer'],
          missingInfo: [],
        },
        objects: [{ role: 'extract', value: undefined, unavailable: true }],
        script: [{ text: 'Answer from the successful history source.' }],
        tools: {
          'conversations.search': {
            schema: z.object({
              query: z.string(),
              mode: z.enum(['text', 'semantic']).optional(),
              limit: z.number().optional(),
            }),
            execute: async (raw) => {
              const args = raw as { query: string; mode?: string };
              if (args.query !== 'Nimbus' || args.mode !== 'text')
                throw new Error(
                  'BudgetReservationError: daily budget cannot cover this reservation',
                );
              return {
                mode: 'text',
                matches: sourceRows.map((row) => ({
                  messageId: row.id,
                  conversationId: sourceChat.id,
                  text: row.text,
                  role: row.role,
                  origin: row.origin,
                  createdAt: row.createdAt.toISOString(),
                  sourceRevision: conversationMessageSourceRevision(row.id, row.text),
                  speakerRevision: conversationMessageSpeakerRevision(
                    row.id,
                    row.text,
                    row.role,
                    row.origin,
                  ),
                })),
              };
            },
          },
        },
      });
      taskIds.push(result.taskId);
      expect(result.status, result.finalText).toBe('done');
      expect(result.toolNames).toEqual(Array(3).fill('conversations.search'));
      expect(result.finalText).toContain('€310');
      expect(result.finalText).toContain('Thursday');
      expect(result.finalText).toContain('avoid taxi travel');
      const ownerSource = sourceRows.find((row) => row.role === 'user');
      const assistantSource = sourceRows.find((row) => row.role === 'assistant');
      if (!ownerSource || !assistantSource) throw new Error('Missing persisted source message');
      expect(result.finalText).toContain(`/chat/${sourceChat.id}#message-${ownerSource.id}`);
      expect(result.finalText).toContain('fictional exercise, not facts about you');
      expect(result.finalText).toContain('coverage is limited to the returned sources');
      expect(result.finalText).not.toContain('No matching saved memories');
      expect(result.finalText).not.toContain('BudgetReservationError');
      if (text === requests[1]) {
        expect(result.finalText).toContain('Earlier assistant claim (not verified fact)');
        expect(result.finalText).toContain(`/chat/${sourceChat.id}#message-${assistantSource.id}`);
      }
      const [persisted] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
      expect(persisted?.status).toBe('done');
    },
  );
});
