import {
  conversations,
  createDb,
  createPostgresToolExecutionRepository,
  type Db,
  messages,
  tasks,
  toolCache,
  toolCalls,
} from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { readPhoneCalendars, savePhoneCalendars } from '@assistant/persistence';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAgent } from '../packages/core/src/chat.js';
import { runGoldenTask } from '../packages/core/src/workflow/golden/harness.js';
import { registerCalendarReadTools } from '../packages/tools/src/google/calendar.js';
import { GoogleClient } from '../packages/tools/src/google/client.js';
import { ToolRegistry } from '../packages/tools/src/registry.js';

assertAllocatedTestTarget({
  databaseUrl: process.env.DATABASE_URL,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: 'standard',
});

describe('calendar sources through provider normalization and persisted agenda', () => {
  let db: Db;
  let agentId: string;
  const taskIds: string[] = [];
  const conversationIds: string[] = [];
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('Missing allocated database');
    db = createDb(process.env.DATABASE_URL);
    agentId = (await getAgent(db)).id;
  });
  afterAll(async () => {
    if (taskIds.length) {
      await db.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
      await db.delete(messages).where(inArray(messages.taskId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
    if (conversationIds.length)
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    await db.delete(toolCache).where(eq(toolCache.cacheKey, `phone-calendars:v1:${agentId}`));
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  });

  it.each([
    { prompt: 'What does my calendar look like tomorrow?', named: false },
    { prompt: 'Show my Family calendar tomorrow', named: true },
  ])('persists the actual producer result for $prompt', async ({ prompt, named }) => {
    const repository = createPostgresToolExecutionRepository(db);
    // This scenario exercises existing cached-phone reads, independently of the
    // new opt-in protocol (whose consent/race behavior has adapter tests).
    const cache = { cacheGet: repository.cacheGet, cachePut: repository.cachePut };
    const client = new GoogleClient({
      clientId: 'test',
      clientSecret: 'test',
      refreshToken: 'test',
    });
    let start = '';
    let end = '';
    vi.spyOn(client, 'api').mockImplementation(async (url) => {
      if (url.includes('calendarList'))
        return {
          items: [{ id: 'primary', primary: true, summary: 'Work', timeZone: 'UTC' }],
        } as never;
      return {
        items: [
          {
            id: 'google-review',
            summary: 'Team planning',
            start: { dateTime: start },
            end: { dateTime: end },
            attendees: [{ email: 'owner@example.com', self: true, responseStatus: 'accepted' }],
            status: 'confirmed',
          },
        ],
      } as never;
    });
    const registry = new ToolRegistry();
    registerCalendarReadTools(registry, {
      client,
      botEmail: 'bot@example.com',
      ownerEmail: 'owner@example.com',
      phoneCalendars: (id) => readPhoneCalendars(cache, id),
    });
    const tool = registry.get('calendar.list_events')?.tool;
    if (!tool) throw new Error('Missing calendar producer');
    const [conversation] = await db
      .insert(conversations)
      .values({
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: 'Real calendar source regression',
      })
      .returning();
    if (!conversation) throw new Error('Missing conversation');
    conversationIds.push(conversation.id);
    const result = await runGoldenTask(db, agentId, {
      name: named ? 'real-calendar-named-phone-source' : 'real-calendar-default-union',
      event: {
        source: 'chat',
        conversationId: conversation.id,
        trust: 'owner',
        payload: { text: prompt },
      },
      taskType: 'chat_turn',
      plan: {
        action: 'workflow',
        reasoning: 'read calendars',
        steps: ['read requested day'],
        missingInfo: [],
      },
      script: [{ text: 'Calendar entries.' }],
      tools: {
        'calendar.list_events': {
          schema: tool.inputSchema,
          execute: async (input) => {
            const args = tool.inputSchema.parse(input) as { timeMin: string; timeMax: string };
            start = new Date(Date.parse(args.timeMin) + 10 * 3_600_000).toISOString();
            end = new Date(Date.parse(start) + 3_600_000).toISOString();
            await savePhoneCalendars(cache, agentId, {
              timeMin: args.timeMin,
              timeMax: args.timeMax,
              timeZone: 'UTC',
              calendars: [
                { id: 'work', name: 'Phone work' },
                { id: 'family', name: 'Family', purpose: 'reference' },
              ],
              events: [
                {
                  eventId: 'phone-review',
                  calendarId: 'work',
                  providerExternalIdentifier: 'opaque-provider-id',
                  summary: 'Team planning',
                  location: '',
                  start,
                  end,
                  allDay: false,
                  blocksTime: true,
                  ownerParticipant: { email: 'owner@example.com', responseStatus: 'accepted' },
                },
                {
                  eventId: 'family-appointment',
                  calendarId: 'family',
                  summary: 'Family appointment',
                  location: '',
                  start,
                  end,
                  allDay: false,
                  blocksTime: true,
                  ownerResponse: 'accepted',
                  ownerParticipant: { email: 'other@example.com', responseStatus: 'accepted' },
                },
              ],
            });
            return tool.execute(args, { agentId } as never);
          },
        },
      },
    });
    taskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['calendar.list_events']);
    const persisted = await db.select().from(messages).where(eq(messages.taskId, result.taskId));
    const parts = persisted.filter((row) => row.role === 'assistant').at(-1)?.parts as Array<{
      data?: { presentation?: string; sections?: Array<{ type: string; items?: unknown[] }> };
    }>;
    const card = parts?.find((part) => part.data?.presentation === 'calendar-agenda')?.data;
    expect(card).toBeDefined();
    const rows = card?.sections
      ?.filter((section) => section.type === 'agenda')
      .flatMap((section) => section.items ?? []);
    expect(rows, JSON.stringify(card)).toHaveLength(named ? 1 : 3);
    expect(JSON.stringify(card)).toContain('Family appointment');
    expect(JSON.stringify(card)).not.toContain('Personal conflict');
    if (named) expect(JSON.stringify(card)).not.toContain('Team planning');
    else {
      expect(JSON.stringify(card)).toContain('Team planning');
      expect(JSON.stringify(card)).toContain('Possible duplicate');
      expect(JSON.stringify(card)).toContain('Possible overlap');
    }
  });
});
