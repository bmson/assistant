import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
    { prompt: 'What does my calendar look like tomorrow?', named: false, variant: 'mirror' },
    { prompt: 'What does my calendar look like tomorrow?', named: false, variant: 'verified' },
    { prompt: 'What does my calendar look like tomorrow?', named: false, variant: 'marked' },
    { prompt: 'What does my calendar look like tomorrow?', named: false, variant: 'dense' },
    { prompt: 'What does my calendar look like tomorrow?', named: false, variant: 'location' },
    { prompt: 'What does my calendar look like tomorrow?', named: false, variant: 'mixed' },
    { prompt: 'What does my calendar look like tomorrow?', named: false, variant: 'shifted' },
    { prompt: 'What does my calendar look like tomorrow?', named: false, variant: 'zone' },
    { prompt: 'Show my Family calendar tomorrow', named: true, variant: 'family' },
  ])(
    'persists the actual producer result for $prompt ($variant)',
    async ({ prompt, named, variant }) => {
      const startedAt = performance.now();
      const baselineRss = process.memoryUsage().rss;
      const canonicalDispute = variant === 'location' || variant === 'mixed' || variant === 'zone';
      const sharedUID = canonicalDispute || variant === 'shifted';
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
          items:
            variant === 'dense'
              ? []
              : [
                  {
                    id: 'google-review',
                    ...(sharedUID ? { iCalUID: 'trusted-rfc-uid' } : {}),
                    ...(canonicalDispute ? { originalStartTime: { dateTime: start } } : {}),
                    ...(variant === 'location' ? { location: 'Office A' } : {}),
                    summary: 'Team planning',
                    start: {
                      dateTime: start,
                      ...(variant === 'zone' ? { timeZone: 'Asia/Tokyo' } : {}),
                    },
                    end: { dateTime: end },
                    attendees: [
                      { email: 'owner@example.com', self: true, responseStatus: 'accepted' },
                    ],
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
      const prepareSnapshot = async (args: { timeMin: string; timeMax: string }) => {
        start = new Date(
          Date.parse(args.timeMin) + (variant === 'zone' ? 1 : 10) * 3_600_000,
        ).toISOString();
        end = new Date(Date.parse(start) + 3_600_000).toISOString();
        await savePhoneCalendars(cache, agentId, {
          timeMin: args.timeMin,
          timeMax: args.timeMax,
          timeZone: 'UTC',
          calendars: [
            {
              id: 'work',
              name: 'Phone work',
              timeZone: variant === 'zone' ? 'America/Los_Angeles' : 'UTC',
              ...(variant === 'marked' ? { purpose: 'commitments' } : {}),
            },
            { id: 'family', name: 'Family', purpose: 'reference' },
          ],
          events:
            variant === 'dense'
              ? Array.from({ length: 2000 }, (_, index) => ({
                  eventId: `dense-${index}`,
                  calendarId: 'work',
                  summary: `Dense event ${index}`,
                  location: '',
                  start,
                  end,
                  allDay: false,
                  blocksTime: true,
                }))
              : [
                  {
                    eventId: 'phone-review',
                    ...(sharedUID ? { iCalUID: 'trusted-rfc-uid' } : {}),
                    ...(canonicalDispute ? { originalStartTime: start } : {}),
                    ...(variant === 'zone' ? { calendarTimeZone: 'America/Los_Angeles' } : {}),
                    calendarId: 'work',
                    providerExternalIdentifier: 'opaque-provider-id',
                    summary:
                      variant === 'mirror' || named || sharedUID
                        ? 'Team planning'
                        : 'Project check-in',
                    location: variant === 'location' ? 'Office B' : '',
                    start:
                      variant === 'mixed'
                        ? start.slice(0, 10)
                        : variant === 'shifted'
                          ? new Date(Date.parse(start) + 300000).toISOString()
                          : start,
                    end:
                      variant === 'mixed'
                        ? new Date(Date.parse(start) + 86400000).toISOString().slice(0, 10)
                        : variant === 'shifted'
                          ? new Date(Date.parse(end) + 300000).toISOString()
                          : end,
                    allDay: variant === 'mixed',
                    blocksTime: true,
                    ...(variant === 'marked'
                      ? {}
                      : {
                          ownerParticipant: {
                            email: 'owner@example.com',
                            responseStatus: 'accepted',
                          },
                        }),
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
                    ownerParticipant: {
                      email: 'other@example.com',
                      responseStatus: 'accepted',
                    },
                  },
                ],
        });
      };
      const densePageArgs: Record<string, unknown>[] = [];
      let denseResult: Record<string, unknown> = {};
      const denseEvents: unknown[] = [];
      if (variant === 'dense') {
        const tomorrow = new Date();
        tomorrow.setUTCHours(0, 0, 0, 0);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        const base = {
          timeMin: tomorrow.toISOString(),
          timeMax: new Date(tomorrow.getTime() + 86400000).toISOString(),
          maxResults: 50,
        };
        await prepareSnapshot(base);
        let pageToken: string | undefined;
        do {
          const input = { ...base, ...(pageToken ? { pageToken } : {}) };
          densePageArgs.push(input);
          const page = (await tool.execute(tool.inputSchema.parse(input), {
            agentId,
          } as never)) as { nextPageToken?: string; events: unknown[] };
          denseEvents.push(...page.events);
          denseResult = { ...page, events: denseEvents };
          pageToken = page.nextPageToken;
        } while (pageToken && densePageArgs.length < 41);
        expect(densePageArgs).toHaveLength(40);
      }
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
              if (variant === 'dense') {
                // Aggregate 40 genuine provider pages to stress finalization.
                // Production reads keep their 50-row page and partial coverage.
                return denseResult;
              }
              await prepareSnapshot(args);
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
      const cards =
        parts?.flatMap((part) =>
          part.data?.presentation === 'calendar-agenda' ? [part.data] : [],
        ) ?? [];
      expect(cards.length).toBeGreaterThan(0);
      const card = cards[0];
      const rows = cards
        .flatMap((card) => card.sections ?? [])
        .filter((section) => section.type === 'agenda')
        .flatMap((section) => section.items ?? []);
      expect(rows, variant).toHaveLength(
        variant === 'dense' ? 2000 : named ? 1 : canonicalDispute ? 2 : 3,
      );
      const fixtureDirectory = process.env.CALENDAR_REVIEW_FIXTURE_DIR;
      if (fixtureDirectory) {
        await mkdir(fixtureDirectory, { recursive: true });
        await writeFile(path.join(fixtureDirectory, `${variant}.json`), JSON.stringify(cards));
      }
      if (variant === 'dense') {
        const metrics = {
          elapsedMs: performance.now() - startedAt,
          baselineRss,
          finalRss: process.memoryUsage().rss,
          processMaxRssKiB: process.resourceUsage().maxRSS,
          maxOldSpace: process.env.NODE_OPTIONS,
        };
        console.info('Dense actual finalization metrics:', JSON.stringify(metrics));
        if (fixtureDirectory)
          await writeFile(path.join(fixtureDirectory, 'dense.metrics'), JSON.stringify(metrics));
        expect(JSON.stringify(card)).toContain('counted but not expanded');
        const sections = card?.sections as Array<{ overlapCount?: number; overlaps?: unknown[] }>;
        expect(
          sections.reduce((total, section) => total + (section.overlaps?.length ?? 0), 0),
        ).toBe(100);
        expect(sections.reduce((total, section) => total + (section.overlapCount ?? 0), 0)).toBe(
          1999000,
        );
        return;
      }
      expect(JSON.stringify(cards)).toContain('Family appointment');
      if (canonicalDispute) {
        expect(JSON.stringify(cards)).toContain('Team planning');
        if (variant !== 'zone')
          expect(JSON.stringify(cards)).toContain('Calendar source differences');
        if (variant === 'zone') {
          expect(JSON.stringify(cards)).not.toContain('Dates not verified');
          expect(JSON.stringify(cards)).not.toContain('copies differ in time');
          expect(JSON.stringify(cards)).toContain('Asia/Tokyo');
          expect(JSON.stringify(cards)).toContain('America/Los_Angeles');
        }
        if (variant === 'location') {
          expect(JSON.stringify(cards)).toContain('Office A');
          expect(JSON.stringify(cards)).toContain('Office B');
        }
        return;
      }
      if (variant === 'mirror' || named)
        expect(JSON.stringify(card)).not.toContain('Your accepted commitments overlap');
      if (named) expect(JSON.stringify(card)).not.toContain('Team planning');
      else {
        expect(JSON.stringify(card)).toContain('Team planning');
        if (variant === 'mirror') expect(JSON.stringify(card)).toContain('Possible duplicate');
        if (variant === 'verified')
          expect(JSON.stringify(card)).toContain('Your accepted commitments overlap');
        if (variant === 'marked') expect(JSON.stringify(card)).toContain('Commitments overlap');
        if (variant === 'shifted') {
          expect(JSON.stringify(card)).toContain('different source times');
          expect(JSON.stringify(card)).not.toContain('Your accepted commitments overlap');
        }
        expect(JSON.stringify(card)).toContain('Possible overlap');
      }
    },
  );
});
