import { conversations, createDb, type Db, messages, tasks, toolCalls } from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getAgent } from '../../chat.js';
import { type GoldenFixture, runGoldenTask } from '../golden/harness.js';

const DATABASE_URL = process.env.DATABASE_URL;
assertAllocatedTestTarget({
  databaseUrl: DATABASE_URL,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: 'standard',
});

describe('executor calendar overview presentation', () => {
  let db: Db;
  let dbUp = false;
  let agentId = '';
  const taskIds: string[] = [];
  const conversationIds: string[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error('Missing allocated test database URL');
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
    } catch {
      console.warn('executor/calendar-overview.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp && taskIds.length) {
      const existing = await db
        .select({ conversationId: tasks.conversationId })
        .from(tasks)
        .where(inArray(tasks.id, taskIds));
      await db.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
      await db.delete(messages).where(inArray(messages.taskId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
      conversationIds.push(
        ...existing.flatMap((row) => (row.conversationId ? [row.conversationId] : [])),
      );
    }
    if (dbUp && conversationIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
      const { conversations } = await import('@assistant/db');
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    if (dbUp) await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  for (const modelText of ['I found the requested calendar entries.', '']) {
    it(`persists a primary evidence agenda with model text ${JSON.stringify(modelText)}`, async (ctx) => {
      if (!dbUp) return ctx.skip();
      const [conversation] = await db
        .insert(conversations)
        .values({ agentId, channel: 'chat', trust: 'owner', title: 'Calendar agenda regression' })
        .returning();
      if (!conversation) throw new Error('Missing conversation');
      conversationIds.push(conversation.id);
      let gmailSearches = 0;
      const fixture: GoldenFixture = {
        name: 'natural-calendar-overview-defaults-to-compact-ledger',
        event: {
          source: 'chat',
          conversationId: conversation.id,
          trust: 'owner',
          payload: { text: 'What does my calendar look like tomorrow?' },
        },
        taskType: 'chat_turn',
        plan: {
          action: 'workflow',
          reasoning: 'inspect the owner calendar for the requested day',
          steps: ['read the requested day', 'summarize the agenda'],
          missingInfo: [],
        },
        script: [{ text: modelText }],
        tools: {
          'calendar.list_events': {
            schema: z.object({ timeMin: z.string(), timeMax: z.string() }).passthrough(),
            execute: async (input) => {
              const args = input as { timeMin: string; timeMax: string };
              const start = Date.parse(args.timeMin);
              const firstStart = new Date(start + 10 * 60 * 60_000).toISOString();
              const firstEnd = new Date(start + 11 * 60 * 60_000).toISOString();
              const secondStart = new Date(start + 10.5 * 60 * 60_000).toISOString();
              const secondEnd = new Date(start + 11.5 * 60 * 60_000).toISOString();
              return {
                complete: true,
                calendarsSearched: ['Work'],
                events: [
                  {
                    eventId: 'overview-review',
                    calendarId: 'work',
                    calendar: 'Work',
                    summary: 'Project review',
                    start: firstStart,
                    end: firstEnd,
                    blocksTime: true,
                    ownerResponse: 'accepted',
                    links: [
                      {
                        type: 'calendar',
                        label: 'Open event',
                        url: 'https://calendar.google.com/calendar/event?eid=overview-review',
                      },
                    ],
                  },
                  {
                    eventId: 'overview-hold',
                    calendarId: 'work',
                    calendar: 'Work',
                    summary: 'Planning hold',
                    start: secondStart,
                    end: secondEnd,
                    blocksTime: true,
                    ownerResponse: 'needsAction',
                    links: [
                      {
                        type: 'calendar',
                        label: 'Open event',
                        url: 'https://calendar.google.com/calendar/event?eid=overview-hold',
                      },
                    ],
                  },
                ],
              };
            },
          },
          'gmail.search': {
            schema: z.object({}).passthrough(),
            execute: async () => {
              gmailSearches += 1;
              return { complete: true, results: [] };
            },
          },
        },
      };
      const result = await runGoldenTask(db, agentId, fixture);
      taskIds.push(result.taskId);
      const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
      if (task?.conversationId) conversationIds.push(task.conversationId);

      expect(result.toolNames).toEqual(['calendar.list_events']);
      expect(gmailSearches).toBe(0);
      expect(result.finalText).toBe('2 events from Work.');
      const persisted = await db.select().from(messages).where(eq(messages.taskId, result.taskId));
      const assistant = persisted.filter((message) => message.role === 'assistant').at(-1);
      const payload = JSON.stringify(assistant?.parts);
      expect(payload).toContain('calendar-agenda');
      expect(payload).toContain('briefing');
      expect(payload).toContain('Project review');
      expect(payload).toContain('Planning hold');
      expect(payload).toContain('Needs response');
      expect(payload).toContain('Possible overlap');
      expect(payload).toContain('Calendar overlap does not confirm attendance.');
      expect(payload).toContain('event?eid=overview-review');
      expect(payload).toContain('event?eid=overview-hold');
      expect(payload).not.toContain('"accepted"');
      expect(result.finalText).not.toContain('Next step:');
    });
  }
});
