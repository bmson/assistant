import { randomUUID } from 'node:crypto';
import {
  approvals,
  conversations,
  createDb,
  createPostgresGeneratedCardRepository,
  type Db,
  generatedCardRevisions,
  generatedCards,
  messages,
  responseChecks,
  tasks,
  toolCalls,
} from '@assistant/db';
import { gmailSearchReceiptSourceId } from '@assistant/persistence/gmail-search-identity';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getAgent } from '../../chat.js';
import { TaskStateSchema } from '../../events.js';
import * as generatedCardModule from '../../generative-card.js';
import { GenerativeCardSpecV1Schema } from '../../generative-card.js';
import { refreshRequestChecklist } from '../executor/checklist.js';
import { detectPersonalReadRequest } from '../read-intent.js';
import {
  buildRequestChecklist,
  recordOwnerChecklistCancellation,
  revisePendingRequestChecklistItem,
} from '../request-checklist.js';
import { RequestChecklistSchema } from '../request-checklist-schema.js';
import { type GoldenFixture, runGoldenTask } from './harness.js';

/**
 * Golden tasks: fixtures that pin what the platform DOES with a scripted model
 * — which tools run, in what order, and what text survives the response
 * contract. This is the regression net for prompt, contract, and executor
 * changes: extend it with a fixture whenever a behavior matters enough that a
 * quiet change to it should fail CI.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];
const createdConversationIds: string[] = [];
const createdCardIds: string[] = [];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('golden: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdCardIds.length) {
    await db
      .delete(generatedCardRevisions)
      .where(inArray(generatedCardRevisions.cardId, createdCardIds));
    await db.delete(generatedCards).where(inArray(generatedCards.id, createdCardIds));
  }
  if (dbUp && createdConversationIds.length) {
    await db.delete(messages).where(inArray(messages.conversationId, createdConversationIds));
  }
  if (dbUp && createdTaskIds.length) {
    await db.delete(approvals).where(inArray(approvals.taskId, createdTaskIds));
    await db.delete(messages).where(inArray(messages.taskId, createdTaskIds));
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  if (dbUp && createdConversationIds.length)
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

/** The fixture's events must land inside the window the runtime resolves for "today". */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const workflowPlan = {
  action: 'workflow' as const,
  reasoning: 'look the fact up, then answer',
  steps: ['look up the fact', 'answer'],
  missingInfo: [],
};

const EMAIL_REVIEW_CONFIRMATION_DRAFT =
  'Thanks for reaching out. Could you clarify what you need me to confirm about this request?';

function emailReviewDraft(threadId: string) {
  return {
    threadId,
    latestMessageId: `latest-${threadId}`,
    disposition: 'draft',
    recipient: 'sender@example.net',
    why: 'The latest message asks for confirmation.',
    whyMessageId: `latest-${threadId}`,
    whyQuote: `Could you confirm request ${threadId}?`,
    deadline: null,
    draftBody: EMAIL_REVIEW_CONFIRMATION_DRAFT,
    draftSourceMessageIds: [`latest-${threadId}`],
  };
}

function gmailThreadPage(input: {
  threadId: string;
  messages: Array<Record<string, unknown>>;
  startMessageIndex: number;
  startMessageOffset?: number;
  totalMessages: number;
  complete: boolean;
  continuation?: Record<string, unknown>;
}) {
  const startMessageOffset = input.startMessageOffset ?? 0;
  const end = input.startMessageIndex + input.messages.length;
  return {
    threadId: input.threadId,
    messages: input.messages,
    complete: input.complete,
    hasMore: !input.complete,
    coverage: {
      requested: 20,
      discovered: input.totalMessages,
      returned: input.messages.length,
      unavailable: 0,
      complete: input.complete,
    },
    ...(input.continuation ? { continuation: input.continuation } : {}),
    receipt: {
      version: 1,
      source: { kind: 'gmail-thread', id: input.threadId },
      requested: {
        start: input.startMessageIndex,
        offset: startMessageOffset,
        limit: 20,
        scope: 'thread-messages',
      },
      covered: {
        start: input.startMessageIndex,
        offset: startMessageOffset,
        end,
        count: input.messages.length,
        total: input.totalMessages,
        unavailable: 0,
      },
      complete: input.complete,
      losses: input.complete ? [] : ['provider-page'],
      continuation: input.continuation ?? null,
    },
  };
}

describe('golden tasks', () => {
  it.for(['complete', 'router-unavailable'] as const)(
    'runs and checkpoints trip extraction after eight source reads (%s)',
    async (outcome, ctx) => {
      if (!dbUp) return ctx.skip();
      const prompt =
        'Find my next future flight using booking emails and calendar. State the date, departure time with its time zone, route and flight number, and whether outbound or return. Do not book, send, or change anything.';
      const futureDay = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const sourceDate = new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${futureDay}T00:00:00Z`));
      const booking = `Egencia\nBooking Confirmation\nTrip Booked\nItinerary/Egencia reference # 555666777888\nLufthansa LH778\nOperated by Lufthansa\nDEPARTURE\n${sourceDate} at 6:00 am\nBerlin (BER-Brandenburg)\nARRIVAL\n${sourceDate} at 11:45 am\nSan Francisco (SFO-San Francisco Intl.)`;
      const purchase = `Ancillary purchase confirmation; flight details\n${'x'.repeat(12356)}`;
      const schema = z.object({}).passthrough();
      let calendarCalls = 0;
      const result = await runGoldenTask(db, agentId, {
        name: `focused-trip-eight-read-extraction-${outcome}`,
        event: {
          source: 'chat',
          trust: 'owner',
          payload: { text: prompt },
        },
        taskType: 'chat_turn',
        plan: workflowPlan,
        maxSteps: 12,
        pinOwnerRequest: true,
        script: [],
        ...(outcome === 'complete'
          ? { compoundTripExtraction: { messages: [] } }
          : { objects: [{ role: 'extract', unavailable: true, value: null }] }),
        tools: {
          'calendar.list_events': {
            schema,
            execute: async () => {
              calendarCalls += 1;
              return {
                events:
                  calendarCalls === 1
                    ? [
                        {
                          eventId: 'candidate',
                          summary: 'BER → SFO flight (United)',
                          description: 'Egencia 555666777888',
                          start: `${futureDay}T06:00:00Z`,
                          end: `${futureDay}T12:00:00Z`,
                          allDay: false,
                        },
                      ]
                    : [],
                complete: false,
                calendarRosterComplete: true,
                unavailable: [],
                nextPageToken: `calendar-page-${calendarCalls + 1}`,
              };
            },
          },
          'gmail.search': {
            schema,
            execute: async (value) => {
              const args = value as { query: string; maxResults: number; pageToken?: string };
              const complete = Boolean(args.pageToken);
              const hits = complete
                ? []
                : [
                    { threadId: 'table-source', subject: 'Fwd: Flight - BOOKED - Berlin' },
                    {
                      threadId: 'purchase-source',
                      subject: 'Thank you for your purchase!',
                      snippet: 'Purchase confirmation with flight details',
                    },
                  ];
              const continuation = complete
                ? null
                : {
                    tool: 'gmail.search',
                    input: {
                      query: args.query,
                      maxResults: args.maxResults,
                      pageToken: 'mail-page-2',
                    },
                  };
              return {
                query: args.query,
                complete,
                hasMore: !complete,
                ...(complete ? {} : { nextPageToken: 'mail-page-2' }),
                results: hits,
                unavailable: [],
                receipt: {
                  version: 1,
                  source: { kind: 'gmail-search', id: gmailSearchReceiptSourceId(args.query) },
                  requested: {
                    scope: 'query-page',
                    limit: args.maxResults,
                    ...(args.pageToken ? { cursor: args.pageToken } : {}),
                  },
                  covered: { count: hits.length, total: hits.length, unavailable: 0 },
                  complete,
                  losses: complete ? [] : ['provider-page'],
                  continuation,
                },
              };
            },
          },
          'gmail.read_thread': {
            schema,
            execute: async (value) => {
              const args = value as { threadId: string; startMessageOffset?: number };
              const source = args.threadId === 'table-source' ? booking : purchase;
              const offset = args.startMessageOffset ?? 0;
              const text = source.slice(offset, offset + 8000);
              const complete = offset + text.length >= source.length;
              const continuation = complete
                ? undefined
                : {
                    tool: 'gmail.read_thread',
                    input: {
                      threadId: args.threadId,
                      startMessageIndex: 0,
                      startMessageOffset: offset + text.length,
                      maxMessages: 20,
                      maxChars: 20000,
                    },
                  };
              return gmailThreadPage({
                threadId: args.threadId,
                messages: [
                  {
                    messageId: args.threadId,
                    subject:
                      args.threadId === 'table-source'
                        ? 'Flight - BOOKED - Berlin'
                        : 'Purchase confirmation',
                    text,
                    sourceLength: source.length,
                    truncated: !complete,
                  },
                ],
                startMessageIndex: 0,
                startMessageOffset: offset,
                totalMessages: 1,
                complete,
                continuation,
              });
            },
          },
        },
      });
      createdTaskIds.push(result.taskId);
      expect(result.toolNames).toEqual([
        'calendar.list_events',
        'calendar.list_events',
        'calendar.list_events',
        'gmail.search',
        'gmail.search',
        'gmail.read_thread',
        'gmail.read_thread',
        'gmail.read_thread',
      ]);
      expect(result.extractCalls).toBe(1);
      expect(result.stepCount).toBeLessThanOrEqual(12);
      expect(result.status).toBe('needs_attention');
      expect(result.finalText).toContain('LH778 BER→SFO');
      expect(result.finalText).toContain('departure time zone not stated');
      expect(result.finalText).not.toContain('Next matched');
      const [finished] = await db
        .select({ state: tasks.state })
        .from(tasks)
        .where(eq(tasks.id, result.taskId));
      const state = TaskStateSchema.parse(finished?.state);
      expect(state.plannerState.tripExtraction).toEqual({
        attempted: true,
        status: outcome === 'complete' ? 'complete' : 'unavailable',
        ...(outcome === 'complete' ? {} : { unavailableReason: outcome }),
        sourceCount: 2,
        segmentCount: 0,
        hotelCount: 0,
        rejectedFacts: 0,
      });
    },
  );

  it('executes a compound trip read through the scripted executor and returns a source-grounded itinerary', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const prompt =
      'Find my next trip from my booking emails and calendar. Confirm the flight dates, departure times and time zones, connections, and hotel. Check for conflicting information. Then plan how to get from the destination airport to my hotel, comparing public transport and taxi. Give me a short itinerary with source links, and clearly mark anything you cannot verify.';
    const detected = detectPersonalReadRequest([{ role: 'user', content: prompt }]);
    const flightQuery = detected?.mailQueries?.find((entry) => entry.category === 'flight')?.query;
    const lodgingQuery = detected?.mailQueries?.find(
      (entry) => entry.category === 'lodging',
    )?.query;
    if (!detected?.compoundTripDiscovery || !flightQuery || !lodgingQuery)
      throw new Error('Exact owner prompt did not enter the compound-trip read path');
    const departure = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const departureDay = departure.toISOString().slice(0, 10);
    const checkout = new Date(departure.getTime() + 2 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const address = '5 Alexanderplatz, 10178 Berlin';
    const outboundQuote = `Outbound flight LH 777 departs from SFO to FRA on ${departureDay} at 10:10 Europe/Berlin and arrives at 11:45 Europe/Berlin. Booking FLIGHT-728.`;
    const connectionQuote = `Connection flight LH 101 departs from FRA to BER on ${departureDay} at 12:30 Europe/Berlin and arrives at 13:20 Europe/Berlin. Booking FLIGHT-728.`;
    const hotelQuote = `Your reserved Hotel Linden at ${address} in Berlin covers ${departureDay} through ${checkout}; confirmation HOTEL-55123.`;
    const toolsSeen: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const emptySchema = z.object({}).passthrough();
    const result = await runGoldenTask(db, agentId, {
      name: 'compound-trip-read-exact-owner-request',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: prompt },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      pinOwnerRequest: true,
      compoundTripExtraction: {
        messages: [
          {
            threadId: 'flight-thread',
            messageId: 'flight-confirmation-message',
            segments: [
              {
                flightNumber: 'LH 777',
                role: 'outbound',
                departureDate: departureDay,
                departureTime: '10:10',
                departureTimeZone: 'Europe/Berlin',
                arrivalDate: departureDay,
                arrivalTime: '11:45',
                arrivalTimeZone: 'Europe/Berlin',
                originAirport: 'SFO',
                destinationAirport: 'FRA',
                bookingReference: 'FLIGHT-728',
                quote: outboundQuote,
              },
              {
                flightNumber: 'LH 101',
                role: 'connection',
                departureDate: departureDay,
                departureTime: '12:30',
                departureTimeZone: 'Europe/Berlin',
                arrivalDate: departureDay,
                arrivalTime: '13:20',
                arrivalTimeZone: 'Europe/Berlin',
                originAirport: 'FRA',
                destinationAirport: 'BER',
                bookingReference: 'FLIGHT-728',
                quote: connectionQuote,
              },
            ],
            hotels: [],
          },
          {
            threadId: 'hotel-thread',
            messageId: 'hotel-confirmation-message',
            segments: [],
            hotels: [
              {
                name: 'Hotel Linden',
                address,
                city: 'Berlin',
                checkIn: departureDay,
                checkOut: checkout,
                bookingReference: 'HOTEL-55123',
                quote: hotelQuote,
              },
            ],
          },
        ],
      },
      script: [
        { toolCalls: [{ toolName: 'calendar.list_events', input: {} }] },
        { toolCalls: [{ toolName: 'gmail.search', input: { query: flightQuery } }] },
        {
          toolCalls: [
            {
              toolName: 'gmail.search',
              input: { query: flightQuery, pageToken: 'flight-page-2' },
            },
          ],
        },
        { toolCalls: [{ toolName: 'gmail.search', input: { query: lodgingQuery } }] },
        {
          toolCalls: [
            {
              toolName: 'gmail.search',
              input: { query: lodgingQuery, pageToken: 'lodging-page-2' },
            },
          ],
        },
        { toolCalls: [{ toolName: 'gmail.read_thread', input: { threadId: 'flight-thread' } }] },
        { toolCalls: [{ toolName: 'gmail.read_thread', input: { threadId: 'hotel-thread' } }] },
        {
          toolCalls: [
            {
              toolName: 'maps.directions',
              input: { origin: 'BER Airport', destination: address, mode: 'driving' },
            },
          ],
        },
        {
          toolCalls: [
            {
              toolName: 'web.search',
              input: {
                query: '"BER" public transport taxi "Hotel Linden" "Berlin" official',
                count: 5,
              },
            },
          ],
        },
        { toolCalls: [{ toolName: 'web.fetch', input: { url: 'https://transit.example/ber' } }] },
        { toolCalls: [{ toolName: 'web.fetch', input: { url: 'https://taxi.example/ber' } }] },
        { text: 'Here is your verified complete trip plan.' },
      ],
      tools: {
        'calendar.list_events': {
          schema: emptySchema,
          execute: async (args) => {
            toolsSeen.push({
              toolName: 'calendar.list_events',
              args: args as Record<string, unknown>,
            });
            return {
              events: [
                {
                  eventId: 'trip-flight-event',
                  summary: 'Outbound flight LH 777 to Berlin',
                  description: 'Arrival airport: BER. Booking reference: FLIGHT-728',
                  location: 'Berlin Brandenburg Airport',
                  start: `${departureDay}T10:10:00+02:00`,
                  timeZone: 'Europe/Berlin',
                  status: 'confirmed',
                  links: [
                    {
                      type: 'calendar',
                      url: 'https://calendar.google.com/calendar/event?eid=golden-trip',
                    },
                  ],
                },
              ],
              complete: true,
              calendarRosterComplete: true,
              unavailable: [],
            };
          },
        },
        'gmail.search': {
          schema: z.object({
            query: z.string(),
            maxResults: z.number().int().default(10),
            pageToken: z.string().optional(),
          }),
          execute: async (args) => {
            const parsed = z
              .object({
                query: z.string(),
                maxResults: z.number().int().default(10),
                pageToken: z.string().optional(),
              })
              .parse(args);
            toolsSeen.push({ toolName: 'gmail.search', args: parsed });
            const flightSearch = parsed.query === flightQuery;
            const lodgingSearch = parsed.query === lodgingQuery;
            if (!flightSearch && !lodgingSearch)
              throw new Error('Unexpected Gmail search category in golden fixture');
            const firstPage = !parsed.pageToken;
            const results = flightSearch
              ? firstPage
                ? [
                    { threadId: 'newsletter-1', subject: 'Flight booking offers - weekly news' },
                    { threadId: 'newsletter-2', subject: 'Airline booking news digest' },
                    { threadId: 'newsletter-3', subject: 'Flight booking product update' },
                    { threadId: 'newsletter-4', subject: 'Airline booking trends' },
                    { threadId: 'newsletter-5', subject: 'Flight booking newsletter' },
                  ]
                : [
                    { threadId: 'newsletter-6', subject: 'Flight booking offers this week' },
                    { threadId: 'flight-thread', subject: 'Airline booking confirmation LH 777' },
                    { threadId: 'newsletter-8', subject: 'Airline booking news' },
                  ]
              : firstPage
                ? [
                    { threadId: 'newsletter-9', subject: 'Hotel booking trends' },
                    { threadId: 'newsletter-10', subject: 'Booking confirmation product update' },
                    { threadId: 'newsletter-11', subject: 'Hotel booking market news' },
                  ]
                : [
                    { threadId: 'newsletter-12', subject: 'Reservation confirmation weekly guide' },
                    { threadId: 'hotel-thread', subject: 'Hotel reservation confirmed' },
                    { threadId: 'newsletter-13', subject: 'Hotel booking news' },
                  ];
            const nextPageToken = flightSearch
              ? firstPage
                ? 'flight-page-2'
                : 'flight-page-3'
              : firstPage
                ? 'lodging-page-2'
                : 'lodging-page-3';
            return {
              query: parsed.query,
              results,
              complete: false,
              hasMore: true,
              nextPageToken,
              continuation: {
                tool: 'gmail.search',
                input: {
                  query: parsed.query,
                  maxResults: parsed.maxResults,
                  pageToken: nextPageToken,
                },
              },
              unavailable: [],
              coverage: {
                requested: parsed.maxResults,
                discovered: firstPage ? 18 : 13,
                returned: results.length,
                unavailable: 0,
                hasMore: true,
                complete: false,
              },
              receipt: {
                version: 1,
                source: { kind: 'gmail-search', id: gmailSearchReceiptSourceId(parsed.query) },
                requested: {
                  limit: parsed.maxResults,
                  ...(parsed.pageToken ? { cursor: parsed.pageToken } : {}),
                  scope: 'query-page',
                },
                covered: { count: results.length, total: results.length, unavailable: 0 },
                complete: false,
                losses: ['provider-page'],
                continuation: {
                  tool: 'gmail.search',
                  input: {
                    query: parsed.query,
                    maxResults: parsed.maxResults,
                    pageToken: nextPageToken,
                  },
                },
              },
            };
          },
        },
        'gmail.read_thread': {
          schema: z.object({
            threadId: z.string(),
            startMessageIndex: z.number().int().default(0),
            startMessageOffset: z.number().int().default(0),
            maxMessages: z.number().int().default(20),
            maxChars: z.number().int().default(20_000),
          }),
          execute: async (args) => {
            const parsed = z
              .object({
                threadId: z.string(),
                startMessageIndex: z.number().int().default(0),
                startMessageOffset: z.number().int().default(0),
                maxMessages: z.number().int().default(20),
                maxChars: z.number().int().default(20_000),
              })
              .parse(args);
            const { threadId } = parsed;
            toolsSeen.push({ toolName: 'gmail.read_thread', args: parsed });
            const messages =
              threadId === 'flight-thread'
                ? [
                    {
                      messageId: 'flight-confirmation-message',
                      subject: 'Airline booking confirmation LH 777',
                      text: `${outboundQuote}\n${connectionQuote}`,
                    },
                  ]
                : threadId === 'hotel-thread'
                  ? [
                      {
                        messageId: 'hotel-confirmation-message',
                        subject: 'Reservation confirmed: Hotel Linden, Berlin',
                        text: hotelQuote,
                      },
                    ]
                  : undefined;
            if (messages)
              return {
                threadId,
                complete: true,
                hasMore: false,
                messages: messages.map((message) => ({
                  ...message,
                  sourceLength: message.text.length,
                  truncated: false,
                })),
                coverage: {
                  requested: parsed.maxMessages,
                  discovered: messages.length,
                  returned: messages.length,
                  unavailable: 0,
                  complete: true,
                },
                receipt: {
                  version: 1,
                  source: { kind: 'gmail-thread', id: threadId },
                  requested: {
                    start: parsed.startMessageIndex,
                    offset: parsed.startMessageOffset,
                    limit: parsed.maxMessages,
                    scope: 'thread-messages',
                  },
                  covered: {
                    start: parsed.startMessageIndex,
                    offset: parsed.startMessageOffset,
                    end: parsed.startMessageIndex + messages.length,
                    count: messages.length,
                    total: messages.length,
                    unavailable: 0,
                  },
                  complete: true,
                  losses: [],
                  continuation: null,
                },
              };
            throw new Error(`Unexpected thread read: ${threadId}`);
          },
        },
        'maps.directions': {
          schema: z.object({
            origin: z.string(),
            destination: z.string(),
            mode: z.literal('driving'),
          }),
          execute: async (args) => {
            const parsed = z
              .object({ origin: z.string(), destination: z.string(), mode: z.literal('driving') })
              .parse(args);
            toolsSeen.push({ toolName: 'maps.directions', args: parsed });
            return { durationSeconds: 1500, mapsUrl: 'https://maps.example/route', ...parsed };
          },
        },
        'web.search': {
          schema: z.object({ query: z.string(), count: z.number().optional() }),
          execute: async (args) => {
            const parsed = z
              .object({ query: z.string(), count: z.number().optional() })
              .parse(args);
            toolsSeen.push({ toolName: 'web.search', args: parsed });
            return {
              query: parsed.query,
              results: [
                {
                  title: 'Berlin airport rail',
                  url: 'https://transit.example/ber',
                  snippet:
                    'Public transport from BER Airport to Hotel Linden, 5 Alexanderplatz, Berlin.',
                },
                {
                  title: 'Berlin airport taxi',
                  url: 'https://taxi.example/ber',
                  snippet: 'Taxi from BER Airport to Hotel Linden, 5 Alexanderplatz, Berlin.',
                },
              ],
            };
          },
        },
        'web.fetch': {
          schema: z.object({ url: z.string() }),
          execute: async (args) => {
            const url = z.object({ url: z.string() }).parse(args).url;
            toolsSeen.push({ toolName: 'web.fetch', args: { url } });
            return {
              status: 200,
              finalUrl: url,
              contentType: 'text/html',
              text:
                url === 'https://transit.example/ber'
                  ? 'Public transport from BER Airport to Hotel Linden at 5 Alexanderplatz, Berlin takes 35 minutes and costs EUR 4.90 for this route.'
                  : 'Taxi from BER Airport to Hotel Linden at 5 Alexanderplatz, Berlin usually takes 45 minutes and costs EUR 62.00.',
              truncated: false,
            };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual([
      'calendar.list_events',
      'gmail.search',
      'gmail.search',
      'gmail.search',
      'gmail.search',
      'gmail.read_thread',
      'gmail.read_thread',
      'web.search',
      'web.fetch',
      'web.fetch',
      'maps.directions',
    ]);
    expect(result.status).toBe('needs_attention');
    expect(result.extractCalls).toBe(1);
    expect(result.finalText).toContain('- **Outbound LH777 SFO→FRA:**');
    expect(result.finalText).toContain(
      `- **Outbound LH777 SFO→FRA:** ${departureDay} 10:10 (Europe/Berlin) → ${departureDay} 11:45 (Europe/Berlin).`,
    );
    expect(result.finalText).toContain(
      `- **Outbound LH101 FRA→BER:** ${departureDay} 12:30 (Europe/Berlin) → ${departureDay} 13:20 (Europe/Berlin).`,
    );
    expect(result.finalText).toContain(
      'Hotel candidate (city/date association inferred; separate booking): **Hotel Linden**',
    );
    expect(result.finalText).toContain(address);
    expect(result.finalText).toContain(`${departureDay} to ${checkout}`);
    expect(result.finalText).toContain('city/date association inferred; separate booking');
    expect(result.finalText).toContain('Departure clocks agree after time-zone conversion');
    expect(result.finalText).toContain('independent flight identity remains unverified');
    expect(result.finalText).toContain('Booking-email search or thread coverage is incomplete');
    expect(result.finalText).not.toContain('Calendar coverage is incomplete');
    expect(result.finalText).toContain(`Transfer candidate: **BER Airport → Hotel Linden**`);
    expect(result.finalText).toContain('- **Public transport:**');
    expect(result.finalText).toContain('- **Public transport:** EUR 4.90; 35 minutes.');
    expect(result.finalText).toContain('- **Taxi:** EUR 62.00; 45 minutes.');
    const visibleAnswer = result.finalText.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    expect(visibleAnswer.split(/\s+/).length).toBeLessThanOrEqual(330);
    expect(result.finalText).toContain(
      'https://calendar.google.com/calendar/event?eid=golden-trip',
    );
    expect(result.finalText).toContain('https://mail.google.com/mail/u/0/#all/flight-thread');
    expect(result.finalText).toContain('https://mail.google.com/mail/u/0/#all/hotel-thread');
    expect(result.finalText).toContain('https://transit.example/ber');
    expect(result.finalText).toContain('https://taxi.example/ber');
    expect(result.finalText).not.toContain('verified complete trip plan');
    expect(toolsSeen.filter(({ toolName }) => toolName === 'gmail.search')).toHaveLength(4);
    expect(
      toolsSeen.filter(({ toolName }) => toolName === 'gmail.search').map(({ args }) => args),
    ).toEqual([
      { query: flightQuery, maxResults: 20 },
      { query: flightQuery, maxResults: 20, pageToken: 'flight-page-2' },
      { query: lodgingQuery, maxResults: 20 },
      { query: lodgingQuery, maxResults: 20, pageToken: 'lodging-page-2' },
    ]);
    expect(
      toolsSeen.every(({ toolName }) =>
        [
          'calendar.list_events',
          'gmail.search',
          'gmail.read_thread',
          'maps.directions',
          'web.search',
          'web.fetch',
        ].includes(toolName),
      ),
    ).toBe(true);
    expect(toolsSeen.find(({ toolName }) => toolName === 'maps.directions')?.args).toEqual({
      origin: 'BER Airport',
      destination: address,
      mode: 'driving',
    });
  }, 15_000); // Twelve dispatcher/tool rounds plus persistence; leave bounded parallel-CI headroom.

  it('ranks bounded mail metadata, reads only selected complete threads, and drafts in chat without mail writes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const prompt =
      'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet.';
    let searchMailbox = 'owner@example.com';
    const fixture: GoldenFixture = {
      name: 'bounded-email-review-no-send-executor',
      event: { source: 'chat', trust: 'owner', payload: { text: prompt } },
      taskType: 'chat_turn',
      pinOwnerRequest: true,
      plan: workflowPlan,
      maxSteps: 12,
      objects: [
        { role: 'reason', value: { threadIds: ['request-a'] } },
        {
          role: 'reason',
          value: {
            items: [
              {
                threadId: 'request-a',
                latestMessageId: 'request-a-latest',
                disposition: 'draft',
                recipient: 'vendor@example.net',
                why: 'The sender asks for confirmation.',
                whyMessageId: 'request-a-latest',
                whyQuote: 'Could you confirm by Friday?',
                deadline: { messageId: 'request-a-latest', quote: 'by Friday' },
                draftBody: EMAIL_REVIEW_CONFIRMATION_DRAFT,
                draftSourceMessageIds: ['request-a-old', 'request-a-latest'],
              },
            ],
          },
        },
      ],
      script: [],
      tools: {
        'gmail.search': {
          schema: z.object({
            query: z.string(),
            maxResults: z.number().optional(),
            pageToken: z.string().optional(),
          }),
          execute: async (args) => {
            expect(args).toMatchObject({ query: 'newer_than:7d -from:me', maxResults: 100 });
            return {
              query: 'newer_than:7d -from:me',
              mailboxSearched: searchMailbox,
              configuredOwnerMailbox: 'owner@example.com',
              complete: true,
              hasMore: false,
              unavailable: [],
              results: [
                {
                  messageId: 'newsletter-message',
                  threadId: 'newsletter',
                  from: 'news@example.org',
                  to: 'owner@example.com',
                  date: '2026-10-12T08:00:00Z',
                  subject: 'Weekly product newsletter',
                  snippet: 'This week in product news.',
                },
                {
                  messageId: 'request-a-search',
                  threadId: 'request-a',
                  from: 'vendor@example.net',
                  to: 'owner@example.com',
                  date: '2026-10-11T16:00:00Z',
                  subject: 'Please confirm renewal',
                  snippet: 'Could you confirm by Friday?',
                },
              ],
            };
          },
        },
        'gmail.read_thread': {
          schema: z.object({
            threadId: z.string(),
            startMessageIndex: z.number().optional(),
            startMessageOffset: z.number().optional(),
            maxMessages: z.number().optional(),
            maxChars: z.number().optional(),
          }),
          execute: async (input) => {
            expect(input).toMatchObject({ threadId: 'request-a', startMessageIndex: 0 });
            return gmailThreadPage({
              threadId: 'request-a',
              startMessageIndex: 0,
              totalMessages: 2,
              complete: true,
              messages: [
                {
                  messageId: 'request-a-old',
                  from: 'owner@example.com',
                  to: 'vendor@example.net',
                  date: '2026-10-10T10:00:00Z',
                  subject: 'Renewal',
                  text: 'Could you send the current terms?',
                  sourceLength: 'Could you send the current terms?'.length,
                  truncated: false,
                },
                {
                  messageId: 'request-a-latest',
                  from: 'vendor@example.net',
                  to: 'owner@example.com',
                  date: '2026-10-11T16:00:00Z',
                  subject: 'Please confirm renewal',
                  text: 'Could you confirm by Friday? The renewal remains available. The new program takes effect November 3.',
                  sourceLength:
                    'Could you confirm by Friday? The renewal remains available. The new program takes effect November 3.'
                      .length,
                  truncated: false,
                },
              ],
            });
          },
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['gmail.search', 'gmail.read_thread']);
    expect(result.objectRoles).toEqual(['reason', 'reason']);
    expect(result.status).toBe('done');
    expect(result.finalText).toContain('**Draft:**');
    expect(result.finalText).toContain('Drafts below are unsent and not saved');
    expect(result.finalText).toContain(EMAIL_REVIEW_CONFIRMATION_DRAFT);
    expect(result.finalText).not.toContain('Weekly product newsletter');
    expect(result.finalText).not.toContain('sent the reply');

    searchMailbox = 'assistant-bot@example.com';
    const mailboxMismatch = await runGoldenTask(db, agentId, {
      ...fixture,
      name: 'bounded-email-review-mailbox-mismatch-preserves-validated-draft',
    });
    createdTaskIds.push(mailboxMismatch.taskId);
    expect(mailboxMismatch.status).toBe('needs_attention');
    expect(mailboxMismatch.toolNames).toEqual(['gmail.search', 'gmail.read_thread']);
    expect(mailboxMismatch.finalText).toContain('**Draft:**');
    expect(mailboxMismatch.finalText).toContain(EMAIL_REVIEW_CONFIRMATION_DRAFT);
    expect(mailboxMismatch.finalText).toContain(
      'the connected mailbox used for search differs from the configured owner mailbox',
    );
    expect(mailboxMismatch.finalText).toContain(
      'confirm it is the intended mailbox before relying on this review',
    );
    expect(mailboxMismatch.finalText).not.toContain('assistant-bot@example.com');
    expect(mailboxMismatch.finalText).not.toContain('owner@example.com');
    searchMailbox = 'owner@example.com';

    const metadataFallback = await runGoldenTask(db, agentId, {
      ...fixture,
      name: 'bounded-email-review-uses-verified-metadata-fallback-after-ranker-failure',
      objects: [
        { role: 'reason', value: {}, unavailable: true },
        fixture.objects?.[1] ?? { role: 'reason', value: { items: [] } },
      ],
    });
    createdTaskIds.push(metadataFallback.taskId);
    expect(metadataFallback.status).toBe('done');
    expect(metadataFallback.toolNames).toEqual(['gmail.search', 'gmail.read_thread']);
    expect(metadataFallback.finalText).toContain('automated ranking was unavailable');
    expect(metadataFallback.finalText).toContain('**Draft:**');
    expect(metadataFallback.finalText).toContain(EMAIL_REVIEW_CONFIRMATION_DRAFT);
    expect(metadataFallback.finalText).not.toContain('Weekly product newsletter');
    const [fallbackTask] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, metadataFallback.taskId));
    expect(TaskStateSchema.parse(fallbackTask?.state).plannerState.emailReview).toMatchObject({
      rankingSource: 'recent_metadata_fallback',
      rankingFailureReason: 'invalid_result',
      selectedThreadIds: ['request-a'],
    });

    const reviewChecklist = RequestChecklistSchema.parse({
      version: 1,
      request: prompt,
      items: [
        {
          id: 'email-review',
          label: 'Find the most important requests that still need my response',
          kind: 'lookup',
          targetTerms: ['requests', 'response'],
          status: 'pending',
          evidence: [],
        },
      ],
    });
    const checklistReview = await runGoldenTask(db, agentId, {
      ...fixture,
      name: 'bounded-email-review-preserves-checked-response-with-request-checklist',
      initialRequestChecklist: reviewChecklist,
    });
    createdTaskIds.push(checklistReview.taskId);

    expect(checklistReview.toolNames).toEqual(['gmail.search', 'gmail.read_thread']);
    expect(checklistReview.status).toBe('needs_attention');
    expect(checklistReview.finalText).toContain('**Draft:**');
    expect(checklistReview.finalText).toContain(EMAIL_REVIEW_CONFIRMATION_DRAFT);
    expect(checklistReview.finalText).not.toContain('This request is not fully completed.');
    expect(checklistReview.finalText).not.toContain('sent the reply');

    const [checklistTask] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, checklistReview.taskId));
    const checklistState = TaskStateSchema.parse(checklistTask?.state);
    expect(checklistState.requestChecklist?.items[0]?.status).toBe('pending');
    expect(checklistState.pendingFinal?.preserveCheckedReadResponse).toBe(true);
    expect(checklistState.pendingFinal?.text).toContain(EMAIL_REVIEW_CONFIRMATION_DRAFT);

    const deadlineNeedsReview = await runGoldenTask(db, agentId, {
      ...fixture,
      name: 'email-review-unverified-optional-deadline-keeps-draft',
      objects: [
        fixture.objects?.[0] ?? { role: 'reason', value: { threadIds: ['request-a'] } },
        {
          role: 'reason',
          value: {
            items: [
              {
                threadId: 'request-a',
                latestMessageId: 'request-a-latest',
                disposition: 'draft',
                recipient: 'vendor@example.net',
                why: 'The sender asks for confirmation.',
                whyMessageId: 'request-a-latest',
                whyQuote: 'Could you confirm by Friday?',
                deadline: {
                  messageId: 'request-a-latest',
                  quote: 'The new program takes effect November 3.',
                },
                draftBody: EMAIL_REVIEW_CONFIRMATION_DRAFT,
                draftSourceMessageIds: ['request-a-old', 'request-a-latest'],
              },
            ],
          },
        },
      ],
    });
    createdTaskIds.push(deadlineNeedsReview.taskId);

    expect(deadlineNeedsReview.status).toBe('needs_attention');
    expect(deadlineNeedsReview.finalText).toContain(EMAIL_REVIEW_CONFIRMATION_DRAFT);
    expect(deadlineNeedsReview.finalText).toContain('Possible deadline to verify');
    expect(deadlineNeedsReview.finalText).toContain('The new program takes effect November 3.');
    expect(deadlineNeedsReview.finalText).not.toContain(
      'Deadline: “The new program takes effect November 3.',
    );
    const [deadlineTask] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, deadlineNeedsReview.taskId));
    expect(
      TaskStateSchema.parse(deadlineTask?.state).pendingFinal?.preserveCheckedReadResponse,
    ).toBe(true);

    const failedGeneration = await runGoldenTask(db, agentId, {
      ...fixture,
      name: 'email-review-generation-failure-keeps-attention-status',
      initialRequestChecklist: reviewChecklist,
      objects: [
        fixture.objects?.[0] ?? { role: 'reason', value: { threadIds: [] } },
        { role: 'reason', value: {}, unavailable: true },
        { role: 'reason', value: {}, unavailable: true },
      ],
    });
    createdTaskIds.push(failedGeneration.taskId);

    expect(failedGeneration.status).toBe('needs_attention');
    expect(failedGeneration.finalText).toContain('0 of 1 selected threads');
    expect(failedGeneration.finalText).toContain(
      '1 selected thread could not be assessed reliably',
    );
    expect(failedGeneration.finalText).not.toContain('**Draft:**');
    expect(failedGeneration.finalText).not.toContain(EMAIL_REVIEW_CONFIRMATION_DRAFT);

    const [failedGenerationTask] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, failedGeneration.taskId));
    expect(
      TaskStateSchema.parse(failedGenerationTask?.state).plannerState.emailReviewGeneration,
    ).toMatchObject({
      status: 'unavailable',
      assessmentGaps: 1,
      unassessedThreadIds: ['request-a'],
    });

    const ownerChoiceScaffold =
      'Owner decision required: choose whether to confirm this request before sending.\n\nIf clarification is needed: “Please clarify what confirmation is required for this request.”';
    const assessment = (draftBody: string) => ({
      role: 'reason' as const,
      value: {
        items: [
          {
            threadId: 'request-a',
            latestMessageId: 'request-a-latest',
            disposition: 'draft',
            recipient: 'vendor@example.net',
            why: 'The sender asks for confirmation by Friday.',
            whyMessageId: 'request-a-latest',
            whyQuote: 'Could you confirm by Friday?',
            deadline: { messageId: 'request-a-latest', quote: 'by Friday' },
            draftBody,
            draftSourceMessageIds: ['request-a-old', 'request-a-latest'],
          },
        ],
      },
    });
    const scaffoldOnly = await runGoldenTask(db, agentId, {
      ...fixture,
      name: 'email-review-owner-choice-scaffold-remains-incomplete-after-repair',
      objects: [
        fixture.objects?.[0] ?? { role: 'reason', value: { threadIds: ['request-a'] } },
        assessment(ownerChoiceScaffold),
        assessment(ownerChoiceScaffold),
      ],
    });
    createdTaskIds.push(scaffoldOnly.taskId);
    expect(scaffoldOnly.status).toBe('needs_attention');
    expect(scaffoldOnly.finalText).toContain('**Reply drafts not ready (1)**');
    expect(scaffoldOnly.finalText).toContain('needs your answer before a reply can be drafted');
    expect(scaffoldOnly.finalText).toContain(
      '[Open the source thread](https://mail.google.com/mail/u/0/#all/request-a)',
    );
    expect(scaffoldOnly.finalText).not.toContain('**Draft:**');
    expect(scaffoldOnly.finalText).not.toContain('Owner decision required');
    expect(scaffoldOnly.finalText).not.toContain('No reply-worthy request was confirmed');
    const [scaffoldTask] = await db.select().from(tasks).where(eq(tasks.id, scaffoldOnly.taskId));
    expect(
      TaskStateSchema.parse(scaffoldTask?.state).plannerState.emailReviewGeneration,
    ).toMatchObject({
      status: 'partial',
      assessmentGaps: 1,
      unassessedThreadIds: ['request-a'],
      ownerDecisionThreadIds: ['request-a'],
    });

    const contextualCorrection = await runGoldenTask(db, agentId, {
      ...fixture,
      name: 'email-review-contextual-retry-corrects-owner-choice-scaffold',
      objects: [
        fixture.objects?.[0] ?? { role: 'reason', value: { threadIds: ['request-a'] } },
        assessment(ownerChoiceScaffold),
        assessment('Thanks for reaching out. Could you clarify what you need me to confirm?'),
      ],
    });
    createdTaskIds.push(contextualCorrection.taskId);
    expect(contextualCorrection.status).toBe('done');
    expect(contextualCorrection.finalText).toContain('**Draft:**');
    expect(contextualCorrection.finalText).toContain(
      'Thanks for reaching out. Could you clarify what you need me to confirm?',
    );
    expect(contextualCorrection.finalText).not.toContain('Owner decision required');
    expect(contextualCorrection.finalText).not.toContain('**Reply drafts not ready');
  });

  it('backfills a fully verified owner-replied thread from the bounded reserve pool', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const prompt =
      'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet.';
    const rankedIds = [
      'answered-a',
      'request-b',
      'request-c',
      'request-d',
      'request-e',
      'request-f',
    ];
    const readThreadIds: string[] = [];
    const result = await runGoldenTask(db, agentId, {
      name: 'bounded-email-review-owner-answer-backfill',
      event: { source: 'chat', trust: 'owner', payload: { text: prompt } },
      taskType: 'chat_turn',
      pinOwnerRequest: true,
      plan: workflowPlan,
      maxSteps: 12,
      objects: [
        { role: 'reason', value: { threadIds: rankedIds } },
        { role: 'reason', value: { items: rankedIds.slice(1).map(emailReviewDraft) } },
      ],
      script: [],
      tools: {
        'gmail.search': {
          schema: z.object({
            query: z.string(),
            maxResults: z.number().optional(),
            pageToken: z.string().optional(),
          }),
          execute: async () => ({
            query: 'newer_than:7d -from:me',
            mailboxSearched: 'owner@example.com',
            configuredOwnerMailbox: 'owner@example.com',
            complete: true,
            hasMore: false,
            unavailable: [],
            results: rankedIds.map((threadId) => ({
              messageId: `search-${threadId}`,
              threadId,
              from: 'sender@example.net',
              to: 'owner@example.com',
              date: '2026-10-12T08:00:00Z',
              subject: `Request ${threadId}`,
              snippet: `Could you confirm request ${threadId}?`,
            })),
          }),
        },
        'gmail.read_thread': {
          schema: z.object({
            threadId: z.string(),
            startMessageIndex: z.number().optional(),
            startMessageOffset: z.number().optional(),
            maxMessages: z.number().optional(),
            maxChars: z.number().optional(),
          }),
          execute: async (input) => {
            const { threadId, startMessageIndex = 0 } = input as {
              threadId: string;
              startMessageIndex?: number;
            };
            readThreadIds.push(threadId);
            const sourceMessages =
              threadId === 'answered-a'
                ? [
                    {
                      messageId: 'answered-a-inbound',
                      from: 'sender@example.net',
                      to: 'owner@example.com',
                      date: '2026-10-10T10:00:00Z',
                      subject: 'Request answered-a',
                      text: 'Could you confirm request answered-a?',
                    },
                    {
                      messageId: 'answered-a-owner-reply',
                      from: 'owner@example.com',
                      to: 'sender@example.net',
                      date: '2026-10-11T10:00:00Z',
                      subject: 'Re: Request answered-a',
                      text: 'I confirmed this request.',
                    },
                  ]
                : [
                    {
                      messageId: `latest-${threadId}`,
                      from: 'sender@example.net',
                      to: 'owner@example.com',
                      date: '2026-10-12T10:00:00Z',
                      subject: `Request ${threadId}`,
                      text: `Could you confirm request ${threadId}?`,
                    },
                  ];
            return gmailThreadPage({
              threadId,
              messages: sourceMessages.map((message) => ({
                ...message,
                sourceLength: message.text.length,
                truncated: false,
              })),
              startMessageIndex,
              totalMessages: sourceMessages.length,
              complete: true,
            });
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.status).toBe('done');
    expect(result.stepCount).toBeLessThanOrEqual(12);
    expect(readThreadIds).toEqual(rankedIds);
    expect(result.toolNames.filter((name) => name === 'gmail.read_thread')).toHaveLength(6);
    expect(result.objectRoles).toEqual(['reason', 'reason']);
    expect(result.finalText.match(/^\*\*Draft:\*\*$/gm)).toHaveLength(5);
    expect(result.finalText).not.toContain('I confirmed this request.');
    expect(result.finalText).toContain('Could you confirm request request-f?');
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    const state = TaskStateSchema.parse(task?.state);
    expect(state.plannerState.emailReview).toMatchObject({
      selectedThreadIds: rankedIds,
      rankedThreadIds: rankedIds,
      attemptedThreadIds: rankedIds,
      excludedThreadIds: ['answered-a'],
    });
  });

  it('completes five verified fallback reads within the default budget after three search pages', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const prompt =
      'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet.';
    const threadIds = ['request-a', 'request-b', 'request-c', 'request-d', 'request-e'];
    let searchPages = 0;
    const readThreadIds: string[] = [];
    const result = await runGoldenTask(db, agentId, {
      name: 'bounded-email-review-three-pages-five-thread-default-budget',
      event: { source: 'chat', trust: 'owner', payload: { text: prompt } },
      taskType: 'chat_turn',
      pinOwnerRequest: true,
      plan: workflowPlan,
      objects: [
        { role: 'reason', value: {}, unavailable: true },
        { role: 'reason', value: { items: threadIds.map(emailReviewDraft) } },
      ],
      script: [],
      tools: {
        'gmail.search': {
          schema: z.object({
            query: z.string(),
            maxResults: z.number().optional(),
            pageToken: z.string().optional(),
          }),
          execute: async (input) => {
            const { pageToken } = z.object({ pageToken: z.string().optional() }).parse(input);
            const page = pageToken ? Number(pageToken.replace('page-', '')) : 1;
            searchPages += 1;
            return {
              query: 'newer_than:7d -from:me',
              mailboxSearched: 'assistant-bot@example.com',
              configuredOwnerMailbox: 'owner@example.com',
              complete: false,
              hasMore: true,
              nextPageToken: `page-${page + 1}`,
              unavailable: [],
              results:
                page === 1
                  ? threadIds.map((threadId, index) => ({
                      messageId: `search-${threadId}`,
                      threadId,
                      from: 'sender@example.net',
                      to: 'owner@example.com',
                      date: `2026-10-12T${String(15 - index).padStart(2, '0')}:00:00Z`,
                      subject: `Request ${threadId}`,
                      snippet: `Could you confirm request ${threadId}?`,
                    }))
                  : [],
            };
          },
        },
        'gmail.read_thread': {
          schema: z.object({
            threadId: z.string(),
            startMessageIndex: z.number().optional(),
            startMessageOffset: z.number().optional(),
            maxMessages: z.number().optional(),
            maxChars: z.number().optional(),
          }),
          execute: async (input) => {
            const { threadId, startMessageIndex = 0 } = input as {
              threadId: string;
              startMessageIndex?: number;
            };
            readThreadIds.push(threadId);
            const text = `Could you confirm request ${threadId}?`;
            return gmailThreadPage({
              threadId,
              startMessageIndex,
              totalMessages: 1,
              complete: true,
              messages: [
                {
                  messageId: `latest-${threadId}`,
                  from: 'sender@example.net',
                  to: 'owner@example.com',
                  date: '2026-10-12T10:00:00Z',
                  subject: `Request ${threadId}`,
                  text,
                  sourceLength: text.length,
                  truncated: false,
                },
              ],
            });
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(searchPages).toBe(3);
    expect(readThreadIds).toHaveLength(5);
    expect(new Set(readThreadIds).size).toBe(5);
    expect(result.stepCount).toBeLessThanOrEqual(12);
    expect(result.toolNames.filter((name) => name === 'gmail.search')).toHaveLength(3);
    expect(result.toolNames.filter((name) => name === 'gmail.read_thread')).toHaveLength(5);
    expect(
      result.toolNames.every((name) => ['gmail.search', 'gmail.read_thread'].includes(name)),
    ).toBe(true);
    expect(result.finalText).toContain('automated ranking was unavailable');
    expect(result.finalText).toContain('beyond the page limit');
    expect(result.finalText.match(/^\*\*Draft:\*\*$/gm)).toHaveLength(5);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    expect(task?.maxSteps).toBe(12);
    expect(TaskStateSchema.parse(task?.state).plannerState.emailReview).toMatchObject({
      rankingSource: 'recent_metadata_fallback',
      rankingFailureReason: 'invalid_result',
      selectedThreadIds: expect.arrayContaining(threadIds),
      attemptedThreadIds: expect.arrayContaining(threadIds),
    });
  });

  it('uses fully verified not-eligible reads for bounded email-review reserves within the review budget', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const prompt =
      'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet.';
    const rankedIds = [
      'request-a',
      'request-b',
      'request-c',
      'request-d',
      'request-e',
      'reserve-f',
      'reserve-g',
      'reserve-h',
    ];
    const eligibleIds = ['request-c', 'request-d', 'request-e', 'reserve-f', 'reserve-g'];
    const readThreadIds: string[] = [];
    let searchPages = 0;
    const result = await runGoldenTask(db, agentId, {
      name: 'bounded-email-review-not-eligible-reserves-with-profile-budget',
      event: { source: 'chat', trust: 'owner', payload: { text: prompt } },
      taskType: 'chat_turn',
      pinOwnerRequest: true,
      plan: workflowPlan,
      maxSteps: 14,
      objects: [
        { role: 'reason', value: { threadIds: rankedIds } },
        { role: 'reason', value: { items: eligibleIds.map(emailReviewDraft) } },
      ],
      script: [],
      tools: {
        'gmail.search': {
          schema: z.object({
            query: z.string(),
            maxResults: z.number().optional(),
            pageToken: z.string().optional(),
          }),
          execute: async (input) => {
            const { pageToken } = z.object({ pageToken: z.string().optional() }).parse(input);
            const page = pageToken ? Number(pageToken.replace('page-', '')) : 1;
            searchPages += 1;
            return {
              query: 'newer_than:7d -from:me',
              mailboxSearched: 'owner@example.com',
              configuredOwnerMailbox: 'owner@example.com',
              complete: page === 3,
              hasMore: page < 3,
              ...(page < 3 ? { nextPageToken: `page-${page + 1}` } : {}),
              unavailable: [],
              results:
                page === 1
                  ? rankedIds.map((threadId, index) => ({
                      messageId: `search-${threadId}`,
                      threadId,
                      from: 'sender@example.net',
                      to: 'owner@example.com',
                      date: `2026-10-12T${String(15 - index).padStart(2, '0')}:00:00Z`,
                      subject: `Request ${threadId}`,
                      snippet: `Could you confirm request ${threadId}?`,
                    }))
                  : [],
            };
          },
        },
        'gmail.read_thread': {
          schema: z.object({
            threadId: z.string(),
            startMessageIndex: z.number().optional(),
            startMessageOffset: z.number().optional(),
            maxMessages: z.number().optional(),
            maxChars: z.number().optional(),
          }),
          execute: async (input) => {
            const { threadId, startMessageIndex = 0 } = input as {
              threadId: string;
              startMessageIndex?: number;
            };
            readThreadIds.push(threadId);
            const ownerAuthoredLatest = threadId === 'request-a' || threadId === 'request-b';
            const text = ownerAuthoredLatest
              ? `I already handled ${threadId}.`
              : `Could you confirm request ${threadId}?`;
            return gmailThreadPage({
              threadId,
              startMessageIndex,
              totalMessages: 1,
              complete: true,
              messages: [
                {
                  messageId: `latest-${threadId}`,
                  from: ownerAuthoredLatest ? 'owner@example.com' : 'sender@example.net',
                  to: ownerAuthoredLatest ? 'other@example.net' : 'owner@example.com',
                  date: '2026-10-12T10:00:00Z',
                  subject: `Request ${threadId}`,
                  text,
                  sourceLength: text.length,
                  truncated: false,
                },
              ],
            });
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(searchPages).toBe(3);
    expect(readThreadIds).toEqual(rankedIds.slice(0, 7));
    expect(result.status).toBe('done');
    expect(result.stepCount).toBe(12);
    expect(result.toolNames.filter((name) => name === 'gmail.search')).toHaveLength(3);
    expect(result.toolNames.filter((name) => name === 'gmail.read_thread')).toHaveLength(7);
    expect(result.toolNames).not.toContain('gmail.send');
    expect(result.finalText.match(/^\*\*Draft:\*\*$/gm)).toHaveLength(5);
    expect(result.finalText).toContain('2 selected threads were reviewed but did not meet');
    expect(result.finalText).not.toContain('request-h');
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    expect(task?.maxSteps).toBe(14);
    expect(TaskStateSchema.parse(task?.state).plannerState.emailReview).toMatchObject({
      selectedThreadIds: rankedIds.slice(0, 7),
      attemptedThreadIds: rankedIds.slice(0, 7),
      notEligibleThreadIds: ['request-a', 'request-b'],
    });
  });

  it('repairs only missing email assessments before backfilling verified no-reply threads', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const prompt =
      'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet.';
    const rankedIds = Array.from({ length: 8 }, (_, index) => `review-${index + 1}`);
    const noReply = (threadId: string) => ({
      ...emailReviewDraft(threadId),
      disposition: 'no_reply' as const,
      recipient: null,
      why: 'The latest message only provides information and requests no response.',
      whyQuote: `The information for ${threadId} is included for your records.`,
      draftBody: null,
      draftSourceMessageIds: [],
    });
    const readIds: string[] = [];
    const result = await runGoldenTask(db, agentId, {
      name: 'email-review-verified-no-reply-reserve-assessment',
      event: { source: 'chat', trust: 'owner', payload: { text: prompt } },
      taskType: 'chat_turn',
      pinOwnerRequest: true,
      plan: workflowPlan,
      maxSteps: 14,
      objects: [
        { role: 'reason', value: { threadIds: rankedIds } },
        {
          role: 'reason',
          value: {
            items: [
              ...rankedIds.slice(0, 2).map(noReply),
              emailReviewDraft(rankedIds[2] as string),
            ],
          },
        },
        { role: 'reason', value: { items: rankedIds.slice(3, 5).map(emailReviewDraft) } },
        { role: 'reason', value: { items: rankedIds.slice(5, 7).map(emailReviewDraft) } },
      ],
      script: [],
      tools: {
        'gmail.search': {
          schema: z.object({
            query: z.string(),
            maxResults: z.number().optional(),
            pageToken: z.string().optional(),
          }),
          execute: async (input) => {
            const { pageToken: token, maxResults } = input as {
              pageToken?: string;
              maxResults?: number;
            };
            expect(maxResults).toBe(100);
            const page = token ? Number(token.replace('page-', '')) : 1;
            return {
              query: 'newer_than:7d -from:me',
              configuredOwnerMailbox: 'owner@example.com',
              complete: page === 3,
              hasMore: page < 3,
              ...(page < 3 ? { nextPageToken: `page-${page + 1}` } : {}),
              unavailable: [],
              results:
                page === 1
                  ? rankedIds.map((threadId, index) => ({
                      messageId: `search-${threadId}`,
                      threadId,
                      from: 'sender@example.net',
                      to: 'owner@example.com',
                      date: `2026-10-12T${String(15 - index).padStart(2, '0')}:00:00Z`,
                      subject: `Request ${threadId}`,
                      snippet: `Could you confirm request ${threadId}?`,
                    }))
                  : [],
            };
          },
        },
        'gmail.read_thread': {
          schema: z.object({
            threadId: z.string(),
            startMessageIndex: z.number().optional(),
            startMessageOffset: z.number().optional(),
            maxMessages: z.number().optional(),
            maxChars: z.number().optional(),
          }),
          execute: async (input) => {
            const { threadId, startMessageIndex = 0 } = input as {
              threadId: string;
              startMessageIndex?: number;
            };
            readIds.push(threadId);
            const text = rankedIds.slice(0, 2).includes(threadId)
              ? `The information for ${threadId} is included for your records.`
              : `Could you confirm request ${threadId}?`;
            return gmailThreadPage({
              threadId,
              startMessageIndex,
              totalMessages: 1,
              complete: true,
              messages: [
                {
                  messageId: `latest-${threadId}`,
                  from: 'sender@example.net',
                  to: 'owner@example.com',
                  date: '2026-10-12T10:00:00Z',
                  subject: `Request ${threadId}`,
                  text,
                  sourceLength: text.length,
                  truncated: false,
                },
              ],
            });
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(readIds).toEqual(rankedIds.slice(0, 7));
    expect(result.stepCount).toBeLessThanOrEqual(14);
    expect(result.status).toBe('done');
    expect(result.toolNames).not.toContain('gmail.send');
    expect(result.finalText.match(/^\*\*Draft:\*\*$/gm)).toHaveLength(5);
    expect(result.finalText).toContain('2 assessed threads did not clearly require a response');
    expect(result.finalText).not.toContain('### Request review-1');
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    expect(
      TaskStateSchema.parse(task?.state).plannerState.emailReviewAssessmentBatches,
    ).toHaveLength(2);
  });

  it('does not read a reserve for a no-reply assessment with an unresolved dated offer', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const prompt =
      'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet.';
    const rankedIds = Array.from({ length: 6 }, (_, index) => `review-${index + 1}`);
    const firstAssessment = {
      ...emailReviewDraft(rankedIds[0] ?? 'review-1'),
      disposition: 'no_reply' as const,
      recipient: null,
      why: 'The latest message only provides dated offer information and requests no response.',
      whyQuote: 'The discount offer is available through Jun. 6th.',
      draftBody: null,
      draftSourceMessageIds: [],
    };
    const assessments = [firstAssessment, ...rankedIds.slice(1, 5).map(emailReviewDraft)];
    const readIds: string[] = [];
    const result = await runGoldenTask(db, agentId, {
      name: 'email-review-unresolved-no-reply-does-not-authorize-reserve',
      event: { source: 'chat', trust: 'owner', payload: { text: prompt } },
      taskType: 'chat_turn',
      pinOwnerRequest: true,
      plan: workflowPlan,
      maxSteps: 14,
      objects: [
        { role: 'reason', value: { threadIds: rankedIds } },
        { role: 'reason', value: { items: assessments } },
        { role: 'reason', value: { items: assessments } },
      ],
      script: [],
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string(), maxResults: z.number().optional() }),
          execute: async () => ({
            query: 'newer_than:7d -from:me',
            configuredOwnerMailbox: 'owner@example.com',
            complete: true,
            hasMore: false,
            unavailable: [],
            results: rankedIds.map((threadId, index) => ({
              messageId: `search-${threadId}`,
              threadId,
              from: 'sender@example.net',
              to: 'owner@example.com',
              date: `2026-10-12T${String(15 - index).padStart(2, '0')}:00:00Z`,
              subject: `Request ${threadId}`,
              snippet: `Could you confirm request ${threadId}?`,
            })),
          }),
        },
        'gmail.read_thread': {
          schema: z.object({
            threadId: z.string(),
            startMessageIndex: z.number().optional(),
            startMessageOffset: z.number().optional(),
            maxMessages: z.number().optional(),
            maxChars: z.number().optional(),
          }),
          execute: async (input) => {
            const { threadId, startMessageIndex = 0 } = input as {
              threadId: string;
              startMessageIndex?: number;
            };
            readIds.push(threadId);
            const text =
              threadId === rankedIds[0]
                ? 'The discount offer is available through Jun. 6th.'
                : `Could you confirm request ${threadId}?`;
            return gmailThreadPage({
              threadId,
              startMessageIndex,
              totalMessages: 1,
              complete: true,
              messages: [
                {
                  messageId: `latest-${threadId}`,
                  from: 'sender@example.net',
                  to: 'owner@example.com',
                  date: '2026-10-12T10:00:00Z',
                  subject: `Request ${threadId}`,
                  text,
                  sourceLength: text.length,
                  truncated: false,
                },
              ],
            });
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(readIds).toEqual(rankedIds.slice(0, 5));
    expect(result.status).toBe('needs_attention');
    expect(result.finalText).toContain('**Possible deadlines to verify (1)**');
    expect(result.finalText).toContain('**Request review\\-1** — No reply draft was prepared');
    expect(result.finalText).toContain(
      '[Open the source thread](https://mail.google.com/mail/u/0/#all/review-1)',
    );
    expect(result.finalText).toContain('No reply draft was prepared; check the source');
    expect(result.finalText).not.toContain('through Jun. 6th');
    expect(result.finalText.match(/^\*\*Draft:\*\*$/gm)).toHaveLength(4);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    expect(
      TaskStateSchema.parse(task?.state).plannerState.emailReviewAssessmentBatches,
    ).toHaveLength(1);
  });

  it('uses a final review step after the two-continuation cap and reports a bounded backfill shortfall', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const prompt =
      'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet.';
    const selectedIds = ['request-a', 'request-b', 'request-c', 'request-d', 'request-e'];
    const rankedIds = [...selectedIds, 'request-f'];
    const readThreadIds: string[] = [];
    const messagesFor = (threadId: string) => [
      {
        messageId: `latest-${threadId}`,
        from: 'sender@example.net',
        to: 'owner@example.com',
        date: '2026-10-12T10:00:00Z',
        subject: `Request ${threadId}`,
        text: `Could you confirm request ${threadId}?`,
      },
    ];
    const rankedAnswer = { items: selectedIds.slice(1).map(emailReviewDraft) };
    const result = await runGoldenTask(db, agentId, {
      name: 'bounded-email-review-twelve-step-cap',
      event: { source: 'chat', trust: 'owner', payload: { text: prompt } },
      taskType: 'chat_turn',
      pinOwnerRequest: true,
      plan: workflowPlan,
      maxSteps: 12,
      objects: [
        { role: 'reason', value: { threadIds: rankedIds } },
        { role: 'reason', value: rankedAnswer },
      ],
      script: [],
      tools: {
        'gmail.search': {
          schema: z.object({
            query: z.string(),
            maxResults: z.number().optional(),
            pageToken: z.string().optional(),
          }),
          execute: async (args) => {
            const pageToken = (args as { pageToken?: string }).pageToken;
            const page = !pageToken ? 1 : pageToken === 'page-2' ? 2 : 3;
            const ids =
              page === 1
                ? ['request-a', 'newsletter']
                : page === 2
                  ? ['request-b', 'request-c']
                  : ['request-d', 'request-e', 'request-f'];
            return {
              query: 'newer_than:7d -from:me',
              mailboxSearched: 'assistant-bot@example.com',
              configuredOwnerMailbox: 'owner@example.com',
              complete: page === 3,
              hasMore: page < 3,
              ...(page < 3 ? { nextPageToken: `page-${page + 1}` } : {}),
              unavailable: [],
              results: ids.map((threadId) => ({
                messageId: `${threadId}-search`,
                threadId,
                from: threadId === 'newsletter' ? 'news@example.org' : 'sender@example.net',
                to: 'owner@example.com',
                date: '2026-10-12T08:00:00Z',
                subject: threadId === 'newsletter' ? 'Weekly newsletter' : `Request ${threadId}`,
                snippet:
                  threadId === 'newsletter'
                    ? 'This week in product news.'
                    : `Could you confirm request ${threadId}?`,
              })),
            };
          },
        },
        'gmail.read_thread': {
          schema: z.object({
            threadId: z.string(),
            startMessageIndex: z.number().optional(),
            startMessageOffset: z.number().optional(),
            maxMessages: z.number().optional(),
            maxChars: z.number().optional(),
          }),
          execute: async (input) => {
            const { threadId, startMessageIndex = 0 } = input as {
              threadId: string;
              startMessageIndex?: number;
            };
            readThreadIds.push(threadId);
            if (threadId === selectedIds[0] && startMessageIndex < 2) {
              const nextIndex = startMessageIndex + 1;
              const pageMessage =
                startMessageIndex === 0
                  ? {
                      messageId: 'request-a-inbound',
                      from: 'sender@example.net',
                      to: 'owner@example.com',
                      date: '2026-10-10T09:00:00Z',
                      subject: 'Renewal date',
                      text: 'Could you confirm the renewal date?',
                    }
                  : {
                      messageId: 'request-a-middle',
                      from: 'owner@example.com',
                      to: 'sender@example.net',
                      date: '2026-10-11T09:00:00Z',
                      subject: 'Re: Renewal date',
                      text: 'I will confirm shortly.',
                    };
              const continuation = {
                tool: 'gmail.read_thread',
                input: {
                  threadId,
                  startMessageIndex: nextIndex,
                  startMessageOffset: 0,
                },
              };
              return gmailThreadPage({
                threadId,
                messages: [
                  { ...pageMessage, sourceLength: pageMessage.text.length, truncated: false },
                ],
                startMessageIndex,
                totalMessages: 3,
                complete: false,
                continuation,
              });
            }
            if (threadId === selectedIds[0]) {
              const latest = {
                messageId: 'request-a-latest',
                from: 'owner@example.com',
                to: 'sender@example.net',
                date: '2026-10-12T10:00:00Z',
                subject: 'Re: Renewal date',
                text: 'I confirmed the renewal date.',
              };
              return gmailThreadPage({
                threadId,
                messages: [{ ...latest, sourceLength: latest.text.length, truncated: false }],
                startMessageIndex,
                totalMessages: 3,
                complete: true,
              });
            }
            const otherMessages = messagesFor(threadId).map((message) => ({
              ...message,
              sourceLength: message.text.length,
              truncated: false,
            }));
            return gmailThreadPage({
              threadId,
              messages: otherMessages,
              startMessageIndex,
              totalMessages: otherMessages.length,
              complete: true,
            });
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.stepCount).toBe(12);
    expect(result.toolNames).toEqual([
      'gmail.search',
      'gmail.search',
      'gmail.search',
      'gmail.read_thread',
      'gmail.read_thread',
      'gmail.read_thread',
      'gmail.read_thread',
      'gmail.read_thread',
      'gmail.read_thread',
      'gmail.read_thread',
    ]);
    expect(result.objectRoles).toEqual(['reason', 'reason']);
    expect(result.status).toBe('needs_attention');
    expect(result.finalText.match(/^\*\*Draft:\*\*$/gm)).toHaveLength(4);
    expect(result.finalText).toContain('1 selected thread had a later reply from your mailbox');
    expect(result.finalText).toContain('step limit prevented another replacement-thread read');
    expect(result.toolNames.filter((name) => name === 'gmail.read_thread')).toHaveLength(7);
    expect(readThreadIds).not.toContain('request-f');
    expect(result.finalText).not.toContain('Weekly newsletter');
  });

  it('prefers the grounded shipment answer to the raw email lookup card', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const card = GenerativeCardSpecV1Schema.parse({
      version: 1,
      title: 'Shipment A123',
      accessibilityLabel: 'Shipment A123 status',
      sourceLabel: 'Shipping email',
      facts: [{ id: 'status', value: 'Delivered', source: 'gmail.read_thread' }],
      blocks: [{ type: 'facts', factIds: ['status'] }],
    });
    const result = await runGoldenTask(db, agentId, {
      name: 'implicit-shipment-answer-card',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'What is the status of my shipment A123?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      card,
      script: [
        { toolCalls: [{ toolName: 'gmail.read_thread', input: { threadId: 'shipment-a123' } }] },
        { text: 'Shipment A123: Delivered.' },
      ],
      tools: {
        'gmail.read_thread': {
          schema: z.object({ threadId: z.string() }),
          execute: async () => ({ messages: [{ subject: 'Shipment A123', text: 'Delivered' }] }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    const cards = TaskStateSchema.parse(task?.state).pendingFinal?.responseCards ?? [];
    for (const saved of cards)
      if (saved.kind === 'generated-card') createdCardIds.push(String(saved.id));
    expect(cards.map((saved) => saved.kind)).toEqual(['generated-card']);
    expect(cards[0]).toMatchObject({ spec: { facts: [{ value: 'Delivered' }] } });
  });

  it('refreshes the same saved card from a new read without posting a duplicate card', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('conversation missing');
    createdConversationIds.push(conversation.id);
    const card = (value: string) =>
      GenerativeCardSpecV1Schema.parse({
        version: 1,
        title: 'Shipment A456',
        accessibilityLabel: 'Shipment A456 status',
        sourceLabel: 'Shipping email',
        facts: [{ id: 'status', value, source: 'gmail.read_thread' }],
        blocks: [{ type: 'facts', factIds: ['status'] }],
      });
    const saved = await generatedCardModule.persistGeneratedCard(
      createPostgresGeneratedCardRepository(db),
      {
        agentId,
        conversationId: conversation.id,
        sourceText: 'What is the status of my shipment A456?',
        payload: {
          kind: 'generated-card',
          id: randomUUID(),
          revisionId: randomUUID(),
          sourceFingerprint: randomUUID(),
          grounding: 'evidence',
          spec: card('In transit'),
        },
        evidence: [
          {
            toolName: 'gmail.read_thread',
            status: 'succeeded',
            args: { threadId: 'shipment-a456' },
            result: { messages: [{ subject: 'Shipment A456', text: 'In transit' }] },
          },
        ],
      },
    );
    createdCardIds.push(saved.id);
    await db.insert(messages).values({
      conversationId: conversation.id,
      role: 'assistant',
      origin: 'assistant',
      text: 'In transit',
      parts: [{ type: 'data-card', data: saved }],
    });
    const result = await runGoldenTask(db, agentId, {
      name: 'saved-shipment-source-refresh',
      event: {
        source: 'internal',
        trust: 'owner',
        conversationId: conversation.id,
        payload: {
          refreshCardId: saved.id,
          instruction: `Refresh saved card ${saved.id} using gmail.read_thread with threadId shipment-a456.`,
          taintedOrigin: true,
        },
      },
      taskType: 'adhoc',
      plan: workflowPlan,
      card: card('Delivered'),
      script: [
        { toolCalls: [{ toolName: 'gmail.read_thread', input: { threadId: 'shipment-a456' } }] },
        {
          text: `The shipping email now says Delivered.\n\n${'The source says Delivered. '.repeat(80)}`,
        },
      ],
      tools: {
        'gmail.read_thread': {
          schema: z.object({ threadId: z.string() }),
          execute: async () => ({ messages: [{ subject: 'Shipment A456', text: 'Delivered' }] }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.status).toBe('done');
    expect(result.finalText).toContain('Refreshed');
    expect(result.finalText.length).toBeLessThan(650);
    const [current] = await db.select().from(generatedCards).where(eq(generatedCards.id, saved.id));
    expect(current?.currentRevisionId).not.toBe(saved.revisionId);
    const [revision] = await db
      .select()
      .from(generatedCardRevisions)
      .where(eq(generatedCardRevisions.id, current?.currentRevisionId ?? ''));
    expect(revision?.spec).toMatchObject({ facts: [{ value: 'Delivered' }] });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    expect(TaskStateSchema.parse(task?.state).pendingFinal?.responseCards ?? []).toEqual([]);
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    expect(
      rows.flatMap((row) =>
        (row.parts as Array<{ type: string }>).filter((part) => part.type === 'data-card'),
      ),
    ).toHaveLength(1);
  });

  it('does not revive the original checklist when a newer owner message changes the request', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing conversation');
    createdConversationIds.push(conversation.id);
    const request = 'Find my hotel reservation and remind me';
    await db.insert(messages).values([
      {
        conversationId: conversation.id,
        role: 'user',
        text: request,
        origin: 'owner',
        createdAt: new Date(Date.now() - 2_000),
      },
      {
        conversationId: conversation.id,
        role: 'user',
        text: 'Cancel the reminder portion; keep the hotel lookup.',
        origin: 'owner',
        createdAt: new Date(Date.now() - 1_000),
      },
    ]);
    const result = await runGoldenTask(db, agentId, {
      name: 'compound-owner-correction',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: request },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'gmail.search', input: { query: 'hotel' } }] },
        { text: 'I found the hotel reservation.' },
        { toolCalls: [{ toolName: 'reminder.create', input: { text: 'Hotel' } }] },
      ],
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => ({ results: [{ subject: 'Hotel reservation' }] }),
        },
        'reminder.create': {
          schema: z.object({ text: z.string() }),
          execute: async () => ({ reminderId: 'must-not-run' }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['gmail.search']);
    const [row] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, result.taskId));
    expect(TaskStateSchema.parse(row?.state).checklistRecoveryAttempts).toBe(0);
  });

  it('cancels only the selected parked outcome before resuming the remaining lookup', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing conversation');
    createdConversationIds.push(conversation.id);

    const request =
      'Find the museum ticket confirmation email and remind me about check-in tomorrow';
    let firstLookupParked = false;
    let lookupExecutions = 0;
    let reminderExecutions = 0;
    const result = await runGoldenTask(db, agentId, {
      name: 'parked-item-cancellation-resumes-supported-email-sibling',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: request },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      pinOwnerRequest: true,
      resumeAfterBudget: true,
      script: [
        {
          toolCalls: [
            { toolName: 'gmail.search', input: { query: 'museum ticket' } },
            { toolName: 'reminder.create', input: { text: 'Museum ticket check-in tomorrow' } },
          ],
        },
        // The model deliberately tries the cancelled write again after resume.
        {
          toolCalls: [
            { toolName: 'reminder.create', input: { text: 'Museum ticket check-in tomorrow' } },
          ],
        },
        { text: 'I found the museum ticket confirmation. I did not create the reminder.' },
      ],
      afterFirstExecution: async ({ taskId }) => {
        const [parked] = await db
          .select({ status: tasks.status })
          .from(tasks)
          .where(eq(tasks.id, taskId));
        expect(parked?.status).toBe('waiting_budget');
        await db.insert(messages).values({
          conversationId: conversation.id,
          taskId,
          role: 'user',
          text: 'Cancel the reminder portion; keep the email lookup.',
          origin: 'owner',
        });
      },
      beforeDispatch: (input) => {
        if (input.toolName === 'gmail.search' && !firstLookupParked) {
          firstLookupParked = true;
          return {
            kind: 'budget_blocked',
            reason: 'fixture budget reset',
            resumeAt: new Date(0),
          };
        }
      },
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => {
            lookupExecutions += 1;
            return {
              complete: true,
              mailboxSearched: 'all mail',
              results: [{ subject: 'Museum ticket confirmation' }],
            };
          },
        },
        'reminder.create': {
          schema: z.object({ text: z.string() }),
          execute: async () => {
            reminderExecutions += 1;
            return { reminderId: 'must-not-run' };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.status, result.finalText).toBe('done');
    expect(result.toolNames).toEqual(['gmail.search']);
    expect(lookupExecutions).toBe(1);
    expect(reminderExecutions).toBe(0);
    expect(result.finalText).toContain('Museum ticket confirmation');
    expect(result.finalText).toContain('Cancelled by the owner; not done.');
    expect(result.finalText).toContain(
      'Thread bodies were not opened because the requested sender/subject metadata was sufficient.',
    );
    expect(result.finalText).not.toContain('reminder was created');

    const [finished] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    const checklist = TaskStateSchema.parse(finished?.state).requestChecklist;
    expect(checklist?.items.map(({ status }) => status)).toEqual(['completed', 'cancelled']);
    expect(checklist?.items[1]?.ownerCancellation?.requestSpan).toBe('Cancel the reminder portion');
    expect(checklist?.cancellationAudit).toHaveLength(1);
    expect(checklist?.lastOwnerAction).toMatchObject({
      kind: 'cancel',
      itemIds: [checklist?.items[1]?.id],
    });
  });

  it('parks a combined calendar-and-email resume when its required calendar tool is unavailable', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing conversation');
    createdConversationIds.push(conversation.id);

    let firstLookupParked = false;
    let reminderExecutions = 0;
    const result = await runGoldenTask(db, agentId, {
      name: 'cancellation-does-not-substitute-email-for-required-calendar-read',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: {
          text: 'Find my hotel reservation and remind me about hotel check-in tomorrow',
        },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      pinOwnerRequest: true,
      resumeAfterBudget: true,
      script: [
        {
          toolCalls: [
            { toolName: 'gmail.search', input: { query: 'hotel reservation' } },
            { toolName: 'reminder.create', input: { text: 'Hotel reservation check-in tomorrow' } },
          ],
        },
        { text: 'I found the hotel reservation. I did not create the reminder.' },
      ],
      afterFirstExecution: async ({ taskId }) => {
        const [parked] = await db
          .select({ status: tasks.status })
          .from(tasks)
          .where(eq(tasks.id, taskId));
        expect(parked?.status).toBe('waiting_budget');
        await db.insert(messages).values({
          conversationId: conversation.id,
          taskId,
          role: 'user',
          text: 'Cancel the reminder portion; keep the hotel lookup.',
          origin: 'owner',
        });
      },
      beforeDispatch: (input) => {
        if (input.toolName === 'gmail.search' && !firstLookupParked) {
          firstLookupParked = true;
          return {
            kind: 'budget_blocked',
            reason: 'fixture budget reset',
            resumeAt: new Date(0),
          };
        }
      },
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => ({
            complete: true,
            mailboxSearched: 'all mail',
            results: [{ subject: 'Harbor Hotel reservation' }],
          }),
        },
        'reminder.create': {
          schema: z.object({ text: z.string() }),
          execute: async () => {
            reminderExecutions += 1;
            return { reminderId: 'must-not-run' };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.status, result.finalText).toBe('failed');
    expect(result.finalText).toContain('Not completed: Find my hotel reservation');
    expect(result.finalText).not.toContain('found the hotel reservation');
    expect(result.finalText).not.toContain('reminder was created');
    expect(reminderExecutions).toBe(0);
    expect(result.toolNames).not.toContain('calendar.search_events');
  });

  it('does not act on a cancellation after a newer owner message changes the head', async (ctx) => {
    if (!dbUp) return ctx.skip();
    let firstLookupParked = false;
    let lookupExecutions = 0;
    let reminderExecutions = 0;
    let checklistBeforeOwnerMessages: unknown;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing conversation');
    createdConversationIds.push(conversation.id);
    const result = await runGoldenTask(db, agentId, {
      name: 'cancellation-owner-head-changed-before-resume',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: 'Find the hotel reservation and remind me about hotel check-in.' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      pinOwnerRequest: true,
      resumeAfterBudget: true,
      script: [
        {
          toolCalls: [
            { toolName: 'gmail.search', input: { query: 'hotel reservation' } },
            { toolName: 'reminder.create', input: { text: 'Hotel check-in tomorrow' } },
          ],
        },
      ],
      afterFirstExecution: async ({ taskId }) => {
        const [beforeMessages] = await db
          .select({ state: tasks.state })
          .from(tasks)
          .where(eq(tasks.id, taskId));
        checklistBeforeOwnerMessages = TaskStateSchema.parse(
          beforeMessages?.state,
        ).requestChecklist;
        const firstCreatedAt = new Date();
        await db.insert(messages).values({
          conversationId: conversation.id,
          taskId,
          role: 'user',
          text: 'Cancel the reminder portion; keep the hotel lookup.',
          origin: 'owner',
          createdAt: firstCreatedAt,
        });
        await db.insert(messages).values({
          conversationId: conversation.id,
          taskId,
          role: 'user',
          text: 'Actually, wait until I review this.',
          origin: 'owner',
          createdAt: new Date(firstCreatedAt.getTime() + 1),
        });
      },
      beforeDispatch: (input) => {
        if (input.toolName === 'gmail.search' && !firstLookupParked) {
          firstLookupParked = true;
          return {
            kind: 'budget_blocked',
            reason: 'fixture budget reset',
            resumeAt: new Date(0),
          };
        }
      },
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => {
            lookupExecutions += 1;
            return { complete: true, results: [{ subject: 'Harbor Hotel reservation' }] };
          },
        },
        'reminder.create': {
          schema: z.object({ text: z.string() }),
          execute: async () => {
            reminderExecutions += 1;
            return { reminderId: 'must-not-run' };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.status).toBe('needs_attention');
    expect(lookupExecutions).toBe(0);
    expect(reminderExecutions).toBe(0);
    expect(result.toolNames).toEqual([]);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    expect(task?.status).toBe('needs_attention');
    const checklist = TaskStateSchema.parse(task?.state).requestChecklist;
    expect(checklist).toEqual(checklistBeforeOwnerMessages);
    expect(checklist?.cancellationAudit).toBeUndefined();
  });

  it('preserves a prior cancellation when the owner later replaces a different pending item', async (ctx) => {
    if (!dbUp) return ctx.skip();
    let lookupExecutions = 0;
    let reminderExecutions = 0;
    let firstLookupBlocked = false;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing conversation');
    createdConversationIds.push(conversation.id);

    const result = await runGoldenTask(db, agentId, {
      name: 'replacement-after-cancellation-preserves-cancelled-sibling',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: 'Find my hotel reservation and remind me about hotel check-in tomorrow' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      pinOwnerRequest: true,
      resumeAfterBudget: true,
      script: [
        {
          toolCalls: [
            { toolName: 'gmail.search', input: { query: 'hotel reservation' } },
            { toolName: 'reminder.create', input: { text: 'Hotel check-in tomorrow' } },
          ],
        },
        {
          toolCalls: [{ toolName: 'reminder.create', input: { text: 'Hotel check-in tomorrow' } }],
        },
        { text: 'I found the train ticket email. I did not create the reminder.' },
      ],
      afterFirstExecution: async ({ taskId }) => {
        const [parked] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        if (!parked) throw new Error('missing parked task');
        const state = TaskStateSchema.parse(parked.state);
        const checklist = state.requestChecklist;
        if (!checklist || checklist.items.length < 2) throw new Error('missing request checklist');

        const cancelledOwnerMessageId = randomUUID();
        const cancelledAt = new Date(Date.now() + 10);
        const [cancelledOwnerMessage] = await db
          .insert(messages)
          .values({
            id: cancelledOwnerMessageId,
            conversationId: conversation.id,
            taskId,
            role: 'user',
            origin: 'owner',
            text: 'Cancel the reminder portion.',
            parts: [{ type: 'text', text: 'Cancel the reminder portion.' }],
            createdAt: cancelledAt,
          })
          .returning({ id: messages.id });
        if (!cancelledOwnerMessage) throw new Error('missing cancellation owner message');
        const cancelled = recordOwnerChecklistCancellation(checklist, {
          taskId,
          agentId,
          conversationId: conversation.id,
          ownerMessageId: cancelledOwnerMessage.id,
          text: 'Cancel the reminder portion.',
        });
        if (cancelled?.lastOwnerAction?.kind !== 'cancel')
          throw new Error('fixture cancellation was not recorded');

        const replacementOwnerMessageId = randomUUID();
        const replacementAt = new Date(cancelledAt.getTime() + 10);
        const [replacementOwnerMessage] = await db
          .insert(messages)
          .values({
            id: replacementOwnerMessageId,
            conversationId: conversation.id,
            taskId,
            role: 'user',
            origin: 'owner',
            text: 'Find the train ticket email instead.',
            parts: [{ type: 'text', text: 'Find the train ticket email instead.' }],
            createdAt: replacementAt,
          })
          .returning({ id: messages.id });
        if (!replacementOwnerMessage) throw new Error('missing replacement owner message');
        const replaced = revisePendingRequestChecklistItem(cancelled, {
          task: { id: taskId, agentId, conversationId: conversation.id },
          ownerMessage: {
            id: replacementOwnerMessage.id,
            taskId,
            agentId,
            conversationId: conversation.id,
            role: 'user',
            origin: 'owner',
            text: 'Find the train ticket email instead.',
          },
          binding: {
            taskId,
            itemId: checklist.items[0]?.id ?? '',
            expectedRevision: cancelled.revision ?? 0,
            ownerTaskId: taskId,
            ownerMessageId: replacementOwnerMessage.id,
          },
          evidence: { complete: true, rows: [] },
          replacement: { kind: 'lookup', label: 'Find the train ticket email instead.' },
        });
        if (replaced.lastOwnerAction?.kind !== 'replace')
          throw new Error('fixture replacement was not recorded');
        await db
          .update(tasks)
          .set({
            state: {
              ...state,
              requestChecklist: replaced,
              seenConversationAt: replacementAt.toISOString(),
              seenConversationId: replacementOwnerMessage.id,
            },
          })
          .where(eq(tasks.id, taskId));
      },
      beforeDispatch: (input) => {
        if (input.toolName === 'gmail.search' && !firstLookupBlocked) {
          firstLookupBlocked = true;
          return {
            kind: 'budget_blocked',
            reason: 'fixture budget reset',
            resumeAt: new Date(0),
          };
        }
      },
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => {
            lookupExecutions += 1;
            return {
              complete: true,
              mailboxSearched: 'owner@example.com',
              results: [
                {
                  threadId: 'train-ticket-1',
                  subject: 'Train ticket receipt',
                  from: 'rail@example.com',
                },
              ],
            };
          },
        },
        'gmail.read_thread': {
          schema: z.object({ threadId: z.literal('train-ticket-1') }),
          execute: async () => ({
            complete: true,
            messages: [
              {
                subject: 'Train ticket receipt',
                from: 'rail@example.com',
                text: 'Your train ticket is confirmed for October 20.',
              },
            ],
          }),
        },
        'reminder.create': {
          schema: z.object({ text: z.string() }),
          execute: async () => {
            reminderExecutions += 1;
            return { reminderId: 'must-not-run' };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.status, result.finalText).toBe('done');
    expect(lookupExecutions).toBe(1);
    expect(reminderExecutions).toBe(0);
    const [finished] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    const checklist = TaskStateSchema.parse(finished?.state).requestChecklist;
    expect(checklist?.items.map((item) => item.status)).toEqual(['completed', 'cancelled']);
    expect(checklist?.lastOwnerAction).toMatchObject({ kind: 'replace' });
    expect(checklist?.cancellationAudit).toHaveLength(1);
  });

  it('parks when the cancelled sibling already has an executing ledger row', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing conversation');
    createdConversationIds.push(conversation.id);
    let blockedFirstLookup = false;
    let lookupExecutions = 0;
    let reminderExecutions = 0;
    const result = await runGoldenTask(db, agentId, {
      name: 'cancelled-running-sibling-parks-before-replay',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: 'Find my hotel reservation and remind me about hotel check-in' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      pinOwnerRequest: true,
      resumeAfterBudget: true,
      script: [
        {
          toolCalls: [
            { toolName: 'gmail.search', input: { query: 'hotel reservation' } },
            { toolName: 'reminder.create', input: { text: 'Hotel check-in' } },
          ],
        },
      ],
      afterFirstExecution: async ({ taskId }) => {
        const [current] = await db
          .select({ state: tasks.state })
          .from(tasks)
          .where(eq(tasks.id, taskId));
        const pending = TaskStateSchema.parse(current?.state).pendingToolBatch;
        const reminder = pending?.calls.find((call) => call.toolName === 'reminder.create');
        if (!pending || !reminder) throw new Error('missing parked reminder call');
        await db.insert(messages).values({
          conversationId: conversation.id,
          taskId,
          role: 'user',
          text: 'Cancel the reminder portion; keep the hotel lookup.',
          origin: 'owner',
        });
        await db.insert(toolCalls).values({
          taskId,
          step: pending.step,
          toolName: reminder.toolName,
          args: reminder.input,
          risk: 'autonomous',
          status: 'executing',
          decision: { modelToolCallId: reminder.toolCallId },
          startedAt: new Date(),
        });
      },
      beforeDispatch: (input) => {
        if (input.toolName === 'gmail.search' && !blockedFirstLookup) {
          blockedFirstLookup = true;
          return {
            kind: 'budget_blocked',
            reason: 'fixture budget reset',
            resumeAt: new Date(0),
          };
        }
      },
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => {
            lookupExecutions += 1;
            return { complete: true, results: [{ subject: 'Harbor Hotel reservation' }] };
          },
        },
        'reminder.create': {
          schema: z.object({ text: z.string() }),
          execute: async () => {
            reminderExecutions += 1;
            return { reminderId: 'must-not-run' };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.status).toBe('needs_attention');
    expect(lookupExecutions).toBe(0);
    expect(reminderExecutions).toBe(0);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    const pending = TaskStateSchema.parse(task?.state).pendingToolBatch;
    expect(
      pending?.calls.map(({ toolName, status, ownerCancellation }) => ({
        toolName,
        status,
        ownerCancellation,
      })),
    ).toEqual([
      { toolName: 'gmail.search', status: 'budget', ownerCancellation: undefined },
      { toolName: 'reminder.create', status: 'queued', ownerCancellation: undefined },
    ]);
    const [startedCall] = await db
      .select({ status: toolCalls.status, decision: toolCalls.decision })
      .from(toolCalls)
      .where(eq(toolCalls.taskId, result.taskId));
    expect(startedCall?.status).toBe('executing');
    expect(startedCall?.decision).toMatchObject({
      modelToolCallId: pending?.calls.find((call) => call.toolName === 'reminder.create')
        ?.toolCallId,
    });
  });

  it('resumes a three-call batch after a budget park without asking the model for new calls', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const executions = new Map<string, number>();
    let budgetBlocked = false;
    const result = await runGoldenTask(db, agentId, {
      name: 'three-call-budget-continuation',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Run all three actions.' } },
      taskType: 'chat_turn',
      plan: workflowPlan,
      resumeAfterBudget: true,
      script: [
        {
          toolCalls: [
            { toolName: 'fixture.one', input: { ordinal: 1 } },
            { toolName: 'fixture.two', input: { ordinal: 2 } },
            { toolName: 'fixture.three', input: { ordinal: 3 } },
          ],
        },
        { text: 'All three actions completed.' },
      ],
      beforeDispatch: (input) => {
        if (input.toolName === 'fixture.one' && !budgetBlocked) {
          budgetBlocked = true;
          return {
            kind: 'budget_blocked',
            reason: 'fixture budget reset',
            resumeAt: new Date(0),
          };
        }
      },
      tools: Object.fromEntries(
        ['fixture.one', 'fixture.two', 'fixture.three'].map((name) => [
          name,
          {
            schema: z.object({ ordinal: z.number() }),
            execute: async (args: unknown) => {
              const ordinal = (args as { ordinal: number }).ordinal;
              executions.set(name, (executions.get(name) ?? 0) + 1);
              return { ordinal, completed: true };
            },
          },
        ]),
      ),
    });
    createdTaskIds.push(result.taskId);
    expect(result.status).toBe('done');
    expect(result.finalText).toContain('All three actions completed.');
    expect([...executions.entries()].sort()).toEqual([
      ['fixture.one', 1],
      ['fixture.three', 1],
      ['fixture.two', 1],
    ]);
    const rows = await db
      .select({ decision: toolCalls.decision })
      .from(toolCalls)
      .where(eq(toolCalls.taskId, result.taskId));
    expect(
      rows.map((row) => (row.decision as { modelToolCallId?: string }).modelToolCallId).sort(),
    ).toEqual(['golden-1-0', 'golden-1-1', 'golden-1-2']);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    expect(TaskStateSchema.parse(task?.state).pendingToolBatch).toBeNull();
  });

  it('does not display a saved card or claim completion when card persistence fails', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const persist = vi
      .spyOn(generatedCardModule, 'persistGeneratedCard')
      .mockRejectedValueOnce(new Error('fixture persistence unavailable'));
    try {
      const result = await runGoldenTask(db, agentId, {
        name: 'compound-card-persistence-failure',
        event: {
          source: 'chat',
          trust: 'owner',
          payload: { text: 'Find my hotel reservation and save it as a card' },
        },
        taskType: 'chat_turn',
        plan: workflowPlan,
        script: [
          { toolCalls: [{ toolName: 'gmail.search', input: { query: 'hotel' } }] },
          { toolCalls: [{ toolName: 'gmail.read_thread', input: { threadId: 'harbor-booking' } }] },
          { text: 'Harbor Hotel is the reservation I found.' },
        ],
        card: GenerativeCardSpecV1Schema.parse({
          version: 1,
          title: 'Harbor Hotel',
          accessibilityLabel: 'Hotel reservation',
          sourceLabel: 'gmail.search',
          facts: [{ id: 'hotel', value: 'Harbor Hotel', source: 'gmail.search' }],
          blocks: [{ type: 'hero', titleFact: 'hotel' }],
        }),
        tools: {
          'gmail.search': {
            schema: z.object({ query: z.string() }),
            execute: async () => ({
              complete: true,
              results: [{ threadId: 'harbor-booking', subject: 'Harbor Hotel' }],
            }),
          },
          'gmail.read_thread': {
            schema: z.object({ threadId: z.literal('harbor-booking') }),
            execute: async () => ({
              complete: true,
              messages: [{ text: 'Harbor Hotel reservation confirmation.' }],
            }),
          },
        },
      });
      createdTaskIds.push(result.taskId);
      expect(persist, result.finalText).toHaveBeenCalledOnce();
      expect(result.status).toBe('needs_attention');
      expect(result.finalText).toContain('Not completed: save it as a card');
      const [row] = await db
        .select({ state: tasks.state })
        .from(tasks)
        .where(eq(tasks.id, result.taskId));
      const state = TaskStateSchema.parse(row?.state);
      expect(state.requestChecklist?.savedCards).toEqual([]);
      expect(
        state.pendingFinal?.responseCards?.some((card) => card.kind === 'generated-card'),
      ).not.toBe(true);
    } finally {
      persist.mockRestore();
    }
  });

  it('records card completion only after its revision is actually persisted', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'compound-card-persistence',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'Find my hotel reservation and save it as a card' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'gmail.search', input: { query: 'hotel' } }] },
        { toolCalls: [{ toolName: 'gmail.read_thread', input: { threadId: 'harbor-booking' } }] },
        { text: 'Harbor Hotel is the reservation I found.' },
      ],
      card: GenerativeCardSpecV1Schema.parse({
        version: 1,
        title: 'Harbor Hotel',
        accessibilityLabel: 'Hotel reservation',
        sourceLabel: 'gmail.search',
        facts: [{ id: 'hotel', value: 'Harbor Hotel', source: 'gmail.search' }],
        blocks: [{ type: 'hero', titleFact: 'hotel' }],
      }),
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => ({
            complete: true,
            results: [{ threadId: 'harbor-booking', subject: 'Harbor Hotel' }],
          }),
        },
        'gmail.read_thread': {
          schema: z.object({ threadId: z.literal('harbor-booking') }),
          execute: async () => ({
            complete: true,
            messages: [{ text: 'Harbor Hotel reservation confirmation.' }],
          }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    const [row] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, result.taskId));
    const state = TaskStateSchema.parse(row?.state);
    const receipt = state.requestChecklist?.savedCards[0];
    if (receipt) createdCardIds.push(receipt.id);
    expect(result.status, result.finalText).toBe('done');
    expect(receipt).toBeDefined();
    if (!receipt) throw new Error('card persistence receipt missing');
    const [revision] = await db
      .select({ id: generatedCardRevisions.id })
      .from(generatedCardRevisions)
      .where(eq(generatedCardRevisions.id, receipt.revisionId));
    expect(revision?.id).toBe(receipt.revisionId);
    expect(state.requestChecklist?.items.map((item) => item.status)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('reconciles only the current task and requires execution after approval', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const inserted = await db
      .insert(tasks)
      .values([
        { agentId, type: 'chat_turn', trust: 'owner' },
        { agentId, type: 'chat_turn', trust: 'owner' },
      ])
      .returning();
    createdTaskIds.push(...inserted.map((task) => task.id));
    const [current, other] = inserted;
    if (!current || !other) throw new Error('missing task fixtures');
    await db.insert(toolCalls).values({
      taskId: other.id,
      toolName: 'gmail.search',
      step: 0,
      risk: 'autonomous',
      status: 'succeeded',
      args: { query: 'hotel' },
      result: { results: [{ subject: 'Hotel' }] },
    });
    const [call] = await db
      .insert(toolCalls)
      .values({
        taskId: current.id,
        toolName: 'reminder.create',
        step: 1,
        risk: 'approval',
        status: 'awaiting_approval',
        args: { text: 'Hotel check-in' },
      })
      .returning();
    if (!call) throw new Error('missing approval call');
    const [approval] = await db
      .insert(approvals)
      .values({
        taskId: current.id,
        toolCallId: call.id,
        shortCode: `checklist-${current.id}`,
        summary: 'Remind about hotel',
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    if (!approval) throw new Error('missing approval');
    const state = TaskStateSchema.parse({
      requestChecklist: buildRequestChecklist('Find my hotel and remind me'),
    });
    await refreshRequestChecklist(db, current, state);
    expect(state.requestChecklist?.items.map((item) => item.status)).toEqual([
      'pending',
      'awaiting_approval',
    ]);
    await db.update(approvals).set({ status: 'approved' }).where(eq(approvals.id, approval.id));
    await refreshRequestChecklist(db, current, state);
    expect(state.requestChecklist?.items[1]?.status).toBe('blocked');
    await db
      .update(toolCalls)
      .set({ status: 'succeeded', result: { reminderId: 'r1' } })
      .where(eq(toolCalls.id, call.id));
    await refreshRequestChecklist(db, current, state);
    expect(state.requestChecklist?.items[1]?.status).toBe('completed');
    await db.update(approvals).set({ status: 'denied' }).where(eq(approvals.id, approval.id));
    await refreshRequestChecklist(db, current, state);
    expect(state.requestChecklist?.items[1]?.status).toBe('blocked');
  });

  it('finishes an omitted reminder after the lookup without repeating the lookup', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'compound-outcome-recovery',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'Find my hotel reservation and remind me tomorrow' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'gmail.search', input: { query: 'hotel' } }] },
        { text: 'I found your hotel reservation.' },
        {
          toolCalls: [
            {
              toolName: 'reminder.create',
              input: { text: 'Hotel check-in', when: '2026-10-01T15:00:00Z' },
            },
          ],
        },
        { text: 'The requested steps are complete.' },
      ],
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => ({ results: [{ subject: 'Harbor Hotel reservation' }] }),
        },
        'reminder.create': {
          schema: z.object({ text: z.string(), when: z.string() }),
          execute: async () => ({ reminderId: 'reminder1', kind: 'once' }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['gmail.search', 'reminder.create']);
    expect(result.status).toBe('done');
    const [row] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, result.taskId));
    const state = TaskStateSchema.parse(row?.state);
    expect(state.checklistRecoveryAttempts).toBe(1);
    expect(state.requestChecklist?.items.map((item) => item.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(state.requestChecklist?.items.every((item) => item.evidence.length === 1)).toBe(true);
  });

  it('reports the missing outcome when the bounded recovery also produces only prose', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'compound-incomplete-is-not-done',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'Find my hotel reservation and remind me' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'gmail.search', input: { query: 'hotel' } }] },
        { text: 'All done.' },
        { text: 'All done.' },
      ],
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => ({ results: [{ subject: 'Hotel reservation' }] }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['gmail.search']);
    expect(result.status).toBe('needs_attention');
    expect(result.finalText).toContain('Completed: Find my hotel reservation');
    expect(result.finalText).toContain('Not completed: remind me');
    expect(result.finalText).not.toContain('All done');
    const [row] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, result.taskId));
    expect(TaskStateSchema.parse(row?.state).checklistRecoveryAttempts).toBe(1);
  });

  it('does not run automatic missing-step recovery after a definitive failure', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'compound-failure-needs-attention',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'Find my hotel reservation and remind me' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'gmail.search', input: { query: 'hotel' } }] },
        { text: 'No hotel reservation was found.' },
      ],
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => ({ results: [], complete: true }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.status, result.finalText).toBe('needs_attention');
    expect(result.finalText).toContain('Not completed: remind me');
    const [row] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, result.taskId));
    expect(TaskStateSchema.parse(row?.state).checklistRecoveryAttempts).toBe(0);
  });

  it('resolves a short hotel follow-up from owner history and reads the confirmation', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing test conversation');
    createdConversationIds.push(conversation.id);
    await db.insert(messages).values([
      {
        conversationId: conversation.id,
        role: 'user',
        text: 'Save my hotel reservation',
        origin: 'owner',
        createdAt: new Date(Date.now() - 3_000),
      },
      {
        conversationId: conversation.id,
        role: 'assistant',
        text: 'You are probably staying in Morgan Hill.',
        origin: 'assistant',
        createdAt: new Date(Date.now() - 2_000),
      },
      {
        conversationId: conversation.id,
        role: 'user',
        text: 'What time is check-in?',
        origin: 'owner',
        createdAt: new Date(Date.now() - 1_000),
      },
    ]);
    const answer = 'Your stay is at Harbor Hotel. Check-in is at 3:00 PM.';
    const result = await runGoldenTask(db, agentId, {
      name: 'lodging-context-confirmation',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: 'What time is check-in?' },
      },
      taskType: 'chat_turn',
      // Even a mistaken reply plan cannot bypass runtime-owned private reads.
      plan: { action: 'reply', reasoning: 'a short follow-up', steps: [], missingInfo: [] },
      script: [{ text: answer }],
      tools: {
        'calendar.search_events': {
          schema: z.object({}).passthrough(),
          execute: async () => ({ complete: true, calendarsSearched: ['Assistant'], events: [] }),
        },
        'gmail.search': {
          schema: z.object({}).passthrough(),
          execute: async () => ({
            complete: true,
            mailboxSearched: 'assistant@example.com',
            results: [{ threadId: 'hotel-1', subject: 'Hotel booking', from: 'hotel@example.com' }],
          }),
        },
        'gmail.read_thread': {
          schema: z.object({ threadId: z.literal('hotel-1') }),
          execute: async () => ({
            complete: true,
            messages: [{ subject: 'Hotel booking', from: 'hotel@example.com', text: answer }],
          }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual([
      'calendar.search_events',
      'gmail.search',
      'gmail.read_thread',
    ]);
    expect(result.finalText).toBe(answer);
    expect(result.finalText).not.toContain('Morgan Hill');
  });

  it('does not turn an empty lodging lookup into a plausible stay', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const guess = 'you are staying near the soccer fields.';
    const result = await runGoldenTask(db, agentId, {
      name: 'lodging-empty-is-not-a-guess',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Where are we staying?' } },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [{ text: guess }],
      tools: {
        'calendar.search_events': {
          schema: z.object({}).passthrough(),
          execute: async () => ({ complete: true, calendarsSearched: ['Assistant'], events: [] }),
        },
        'gmail.search': {
          schema: z.object({}).passthrough(),
          execute: async () => ({
            complete: true,
            mailboxSearched: 'assistant@example.com',
            results: [],
          }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['calendar.search_events', 'gmail.search']);
    expect(result.finalText).not.toContain('soccer fields');
    expect(result.finalText).toMatch(/no|nothing/i);
  });

  it('reads application confirmations instead of substituting interview events', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'application-history-evidence',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'What companies have I applied for?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [{ text: 'Acme received your application.' }],
      tools: {
        'gmail.search': {
          schema: z.object({}).passthrough(),
          execute: async () => ({
            complete: true,
            mailboxSearched: 'assistant@example.com',
            results: [
              {
                threadId: 'application-1',
                subject: 'Acme application received',
                from: 'jobs@acme.example',
              },
            ],
          }),
        },
        'gmail.read_thread': {
          schema: z.object({ threadId: z.literal('application-1') }),
          execute: async () => ({
            complete: true,
            messages: [
              { subject: 'Acme application received', text: 'Acme received your application.' },
            ],
          }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['gmail.search', 'gmail.read_thread']);
    expect(result.finalText).toBe('Acme received your application.');
  });

  it('leaves interactive planned work needing attention when the tool retry still does nothing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'chat-workflow-no-silent-success',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Look up the wifi password.' } },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [{ text: 'I will look it up now.' }, { text: 'I will check that for you.' }],
      tools: {
        'facts.lookup': {
          schema: z.object({ key: z.string() }),
          execute: async () => ({ value: 'not reached' }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual([]);
    expect(result.status).toBe('needs_attention');
    expect(result.finalText).toContain("couldn't produce a concrete action");
    expect(result.finalText).not.toContain('I will check');
  });

  it('runs the scripted tool sequence in order and delivers the final text', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'lookup-then-answer',
      event: { source: 'chat', trust: 'owner', payload: { text: 'What is our wifi password?' } },
      taskType: 'adhoc',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'facts.lookup', input: { key: 'wifi' } }] },
        { text: 'It is in your workspace notes: hunter2.' },
      ],
      tools: {
        'facts.lookup': {
          schema: z.object({ key: z.string() }),
          execute: async () => ({ value: 'hunter2' }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['facts.lookup']);
    expect(result.finalText).toContain('hunter2');
  });

  it('renders a compact day overview without losing event times or locations', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agenda = [
      'Two things today, and the afternoon is the tight one:',
      '- **09:30–10:15** — Linear interview prep — Zoom',
      '- **13:00–14:00** — Dentist — Laugavegur 12',
    ].join('\n');
    const fixture: GoldenFixture = {
      name: 'calendar-day-answer-grounded',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'what is happening today?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      // The required calendar read is dispatched by the runtime, not scripted;
      // this entry is consumed by the answer turn that follows it.
      script: [{ text: agenda }],
      tools: {
        'calendar.list_events': {
          schema: z.object({}).passthrough(),
          execute: async () => ({
            complete: true,
            calendarsSearched: ['Assistant'],
            events: [
              {
                eventId: 'evt-prep',
                calendarId: 'primary',
                calendar: 'Assistant',
                summary: 'Linear interview prep',
                location: 'Zoom',
                start: `${today()}T09:30:00Z`,
                end: `${today()}T10:15:00Z`,
              },
              {
                eventId: 'evt-dentist',
                calendarId: 'primary',
                calendar: 'Assistant',
                summary: 'Dentist',
                location: 'Laugavegur 12',
                start: `${today()}T13:00:00Z`,
                end: `${today()}T14:00:00Z`,
              },
            ],
          }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['calendar.list_events']);
    expect(result.finalText).toContain('09:30–10:15 — Linear interview prep');
    expect(result.finalText).toContain('13:00–14:00 — Dentist');
    expect(result.finalText).toContain('Zoom');
    expect(result.finalText).toContain('Laugavegur 12');
    expect(result.finalText).toContain('No unresolved overlaps between timed calendar entries');
    expect(result.finalText).not.toContain('the afternoon is the tight one');
    expect(result.finalText).not.toContain("Here's what the calendar has");
    expect(result.finalText).not.toContain('organizer:');

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(false);
  });

  it('answers a dated calendar overview from the calendar alone, without a Gmail search', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const eventUrl = 'https://calendar.google.com/calendar/event?eid=calendar-day-review';
    let calendarReads = 0;
    let gmailSearches = 0;
    const answer = `Tomorrow you have one event: Design review, 16:00–16:30 ([calendar event](${eventUrl})). No overlaps were found.`;
    const result = await runGoldenTask(db, agentId, {
      name: 'calendar-day-overview-does-not-search-email',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: {
          text: 'What is on my calendar tomorrow? Use my local time zone, include event times and calendar names, and point out overlaps. Give a compact answer with source links. Do not edit anything.',
        },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [{ text: answer }],
      tools: {
        'calendar.list_events': {
          schema: z.object({}).passthrough(),
          execute: async () => {
            calendarReads += 1;
            return {
              complete: true,
              calendarsSearched: ['Assistant'],
              events: [
                {
                  eventId: 'evt-design-review',
                  calendarId: 'primary',
                  calendar: 'Assistant',
                  summary: 'Design review',
                  start: `${tomorrow}T16:00:00Z`,
                  end: `${tomorrow}T16:30:00Z`,
                  htmlLink: eventUrl,
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
    });
    createdTaskIds.push(result.taskId);

    expect(calendarReads).toBe(1);
    expect(gmailSearches).toBe(0);
    expect(result.toolNames).toEqual(['calendar.list_events']);
    expect(result.status).toBe('done');
    expect(result.finalText).toContain('Design review');
    expect(result.finalText).toContain('16:00–16:30');
    expect(result.finalText).not.toMatch(/let me read|let me check|email results/i);
  });

  it('runs bounded weekday analysis through persisted calendar pages and checked finalization', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const prompt =
      'For my calendar, over the next 3 weekdays, how many days have an event lasting at least 45 minutes? Also find gaps of at least 30 minutes between events explicitly marked in person.';
    const owner = await getAgent(db);
    const request = detectPersonalReadRequest([{ role: 'user', content: prompt }], {
      now: new Date(),
      timeZone: owner.timezone,
    });
    if (!request?.calendarEventAnalysis || !request.timeWindow)
      throw new Error('Weekday analysis did not resolve its bounded owner-timezone window');
    expect(request.calendarEventAnalysis.durationCountMode).toBe('days');

    const firstStart = new Date(Date.parse(request.timeWindow.timeMin) + 2 * 60 * 60 * 1000);
    const firstEnd = new Date(firstStart.getTime() + 45 * 60 * 1000);
    const secondStart = new Date(firstEnd.getTime() + 75 * 60 * 1000);
    const secondEnd = new Date(secondStart.getTime() + 45 * 60 * 1000);
    const sourceUrl = 'https://calendar.google.com/calendar/event?eid=weekday-review';
    const firstEvent = {
      eventId: 'weekday-review',
      calendarId: 'primary',
      calendar: 'Assistant',
      summary: 'Planning review',
      description: 'Attendance mode: in person',
      location: 'Conference room A',
      start: firstStart.toISOString(),
      end: firstEnd.toISOString(),
      links: [{ label: 'Open event', url: sourceUrl }],
    };
    const secondEvent = {
      eventId: 'weekday-consult',
      calendarId: 'primary',
      calendar: 'Assistant',
      summary: 'Consultation meeting',
      description: 'Attendance mode: in person',
      location: 'Conference room B',
      start: secondStart.toISOString(),
      end: secondEnd.toISOString(),
    };
    let thirdStart = new Date(firstStart.getTime() + 26 * 60 * 60 * 1000);
    const ownerWeekday = new Intl.DateTimeFormat('en-US', {
      timeZone: owner.timezone,
      weekday: 'short',
    });
    // The next civil day may be Saturday. Keep this fixture on the next
    // requested working day, as the actual weekday analysis now requires.
    while (['Sat', 'Sun'].includes(ownerWeekday.format(thirdStart))) {
      thirdStart = new Date(thirdStart.getTime() + 24 * 60 * 60 * 1000);
    }
    expect(thirdStart.getTime()).toBeLessThan(Date.parse(request.timeWindow.timeMax));
    const thirdEnd = new Date(thirdStart.getTime() + 45 * 60 * 1000);
    const thirdEvent = {
      eventId: 'weekday-followup',
      calendarId: 'primary',
      calendar: 'Assistant',
      summary: 'Next-day planning',
      description: 'Attendance mode: in person',
      location: 'Conference room C',
      start: thirdStart.toISOString(),
      end: thirdEnd.toISOString(),
    };
    const ownerClock = new Intl.DateTimeFormat('en-US', {
      timeZone: owner.timezone,
      hour: 'numeric',
      minute: '2-digit',
    });
    const modelAnswer = [
      `Planning review ${ownerClock.format(firstStart)}–${ownerClock.format(firstEnd)}, Consultation meeting ${ownerClock.format(secondStart)}–${ownerClock.format(secondEnd)}, and Next-day planning ${ownerClock.format(thirdStart)}–${ownerClock.format(thirdEnd)}.`,
      'There are 99 qualifying days and a 1-minute gap.',
    ].join(' ');
    const listCalls: Array<Record<string, unknown>> = [];
    const pages = [
      { nextPageToken: 'weekday-page-2', events: [] },
      { nextPageToken: 'weekday-page-3', events: [firstEvent, secondEvent, thirdEvent] },
      { events: [firstEvent] }, // A duplicate across pages must not inflate the count.
    ];

    const result = await runGoldenTask(db, agentId, {
      name: 'calendar-weekday-analysis-pages-and-finalization',
      event: { source: 'chat', trust: 'owner', payload: { text: prompt } },
      taskType: 'chat_turn',
      plan: workflowPlan,
      pinOwnerRequest: true,
      script: [{ text: modelAnswer }],
      tools: {
        'calendar.list_events': {
          schema: z.object({}).passthrough(),
          execute: async (value) => {
            const args = value as Record<string, unknown>;
            listCalls.push(args);
            const pageIndex = listCalls.length - 1;
            const page = pages[pageIndex];
            if (!page) throw new Error('weekday calendar analysis exceeded its three-page cap');
            return {
              ...page,
              complete: true,
              calendarsSearched: ['Assistant'],
              calendarRosterComplete: true,
              unavailable: [],
            };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);
    const [persistedTask] = await db
      .select({ createdAt: tasks.createdAt })
      .from(tasks)
      .where(eq(tasks.id, result.taskId));
    if (!persistedTask) throw new Error('weekday-analysis task was not persisted');
    const admittedRequest = detectPersonalReadRequest([{ role: 'user', content: prompt }], {
      now: persistedTask.createdAt,
      timeZone: owner.timezone,
    });
    if (!admittedRequest?.timeWindow)
      throw new Error('persisted weekday-analysis task has no stable calendar window');

    expect(result.status).toBe('done');
    expect(result.toolNames).toEqual([
      'calendar.list_events',
      'calendar.list_events',
      'calendar.list_events',
    ]);
    expect(listCalls).toHaveLength(3);
    expect(listCalls.map((call) => call.pageToken ?? null)).toEqual([
      null,
      'weekday-page-2',
      'weekday-page-3',
    ]);
    expect(listCalls.every((call) => call.timeMin === admittedRequest.timeWindow?.timeMin)).toBe(
      true,
    );
    expect(listCalls.every((call) => call.timeMax === admittedRequest.timeWindow?.timeMax)).toBe(
      true,
    );
    expect(listCalls.every((call) => call.maxResults === 50)).toBe(true);
    expect(result.finalText).toContain(
      'Days with at least one event lasting 45 minutes: 2 of 3 requested weekdays.',
    );
    expect(result.finalText).toContain('2 qualifying events.');
    expect(result.finalText).toContain('1 qualifying event.');
    expect(result.finalText).toContain('0 qualifying events.');
    expect(result.finalText).toContain('75 minutes');
    expect(result.finalText).toContain('Planning review');
    expect(result.finalText).toContain('Consultation meeting');
    expect(result.finalText).toContain('Next\\-day planning');
    expect(result.finalText).toContain(sourceUrl);
    expect(result.finalText).not.toContain('99 qualifying days');
    expect(result.finalText).not.toContain('1-minute gap');
    expect(result.finalText).not.toContain('checked subset');

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(false);
    const persistedCalls = await db
      .select({ args: toolCalls.args, result: toolCalls.result })
      .from(toolCalls)
      .where(eq(toolCalls.taskId, result.taskId))
      .orderBy(toolCalls.step);
    expect(persistedCalls).toHaveLength(3);
    expect(
      persistedCalls.map((call) => (call.args as Record<string, unknown>).pageToken ?? null),
    ).toEqual([null, 'weekday-page-2', 'weekday-page-3']);
    const [finishedTask] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, result.taskId));
    const finishedState = TaskStateSchema.parse(finishedTask?.state);
    expect(finishedState.pendingFinal?.text).toBe(result.finalText);
  }, 15_000); // Three dispatcher reads plus durable response-contract checks need bounded CI headroom.

  it('plans the hypothetical work schedule without searching the owner calendar', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const request =
      'Plan a hypothetical work morning from 09:00 to 12:30. Include a 90-minute deep-work block, a 45-minute review, a 30-minute meeting at 11:30, and two 15-minute breaks. Show a compact table with start and end times, identify any unused time, and check that nothing overlaps. Do not look at or change my real calendar.';
    const answer = [
      '| Time | Plan |',
      '|---|---|',
      '| 09:00–10:30 | Deep work |',
      '| 10:30–10:45 | Break |',
      '| 10:45–11:30 | Review |',
      '| 11:30–12:00 | Meeting |',
      '| 12:00–12:15 | Break |',
      '| 12:15–12:30 | Unused time |',
      '',
      'The blocks do not overlap. The review is 45 minutes, deep work is 90 minutes, and 15 minutes remain unused.',
    ].join('\n');
    const result = await runGoldenTask(db, agentId, {
      name: 'hypothetical-schedule-does-not-read-private-calendar',
      event: { source: 'chat', trust: 'owner', payload: { text: request } },
      taskType: 'chat_turn',
      plan: {
        action: 'reply',
        reasoning: 'Answer the hypothetical schedule request.',
        steps: [],
        missingInfo: [],
      },
      script: [{ text: answer }],
      tools: {},
    });
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual([]);
    expect(result.stepCount).toBe(1);
    expect(result.status).toBe('done');
    expect(result.finalText).toContain('09:00–10:30');
    expect(result.finalText).toContain('12:15–12:30');
    expect(result.finalText).not.toContain("That's everything I could actually see");
    expect(result.finalText).not.toContain('I could not get to');
  });

  it('blocks an invented flight return time before the calendar tool executes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    let executed = false;
    const result = await runGoldenTask(db, agentId, {
      name: 'calendar-flight-write-rejects-invented-return-time',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: {
          text: 'Add my United flight from SFO to BER to my calendar. It leaves Oct 9 at 9:15 AM PDT and arrives Oct 11 at 5:15 AM CEST.',
        },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        {
          toolCalls: [
            {
              toolName: 'calendar.create_event',
              input: {
                summary: 'United flight SFO to BER',
                start: '2026-10-09T09:15:00-07:00',
                end: '2026-10-11T13:15:00+02:00',
                description: '',
                location: 'SFO to BER',
                attendees: [],
              },
            },
          ],
        },
        { text: 'I need to confirm the arrival time before I add this.' },
      ],
      tools: {
        'calendar.create_event': {
          schema: z.object({}).passthrough(),
          execute: async () => {
            executed = true;
            return { eventId: 'should-not-exist' };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(executed).toBe(false);
    expect(result.toolNames).toEqual([]);
    expect(result.finalText).toContain('confirm');
  });

  it('stages a quality-failure response as needs attention before a malformed finish can retry', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const safeText = "I couldn't produce a reliable answer just now. Please try again.";
    const result = await runGoldenTask(db, agentId, {
      name: 'quality-failure-is-terminal',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'Tell me a short greeting.' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [{ text: safeText, qualityFailure: true, finishReason: 'error' }],
      tools: {},
    });
    createdTaskIds.push(result.taskId);

    expect(result.status, result.finalText).toBe('needs_attention');
    expect(result.finalText).toBe(safeText);
    expect(result.toolNames).toEqual([]);
  });

  it('falls back to the verified list when the agenda invents an event', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'calendar-day-answer-fabricated',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'what is happening today?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        {
          text: [
            'Two things today:',
            '- **09:30–10:15** — Linear interview prep — Zoom',
            '- **19:00–21:00** — Dinner at Zuni Cafe — 1658 Market St',
          ].join('\n'),
        },
      ],
      tools: {
        'calendar.list_events': {
          schema: z.object({}).passthrough(),
          execute: async () => ({
            complete: true,
            calendarsSearched: ['Assistant'],
            events: [
              {
                eventId: 'evt-prep',
                calendarId: 'primary',
                calendar: 'Assistant',
                summary: 'Linear interview prep',
                location: 'Zoom',
                start: `${today()}T09:30:00Z`,
                end: `${today()}T10:15:00Z`,
              },
            ],
          }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).not.toContain('Zuni Cafe');
    expect(result.finalText).toContain('Linear interview prep');
    // A fallback is not an honesty failure: the owner still gets every fact.
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(false);
  });

  it('retries a failed private read once, then delivers an explicit coverage gap', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'calendar-read-outage-is-honest',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'what is happening today?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [],
      tools: {
        'calendar.list_events': {
          schema: z.object({}).passthrough(),
          execute: async () => {
            throw new Error('calendar provider is temporarily unavailable');
          },
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    // The runtime owns private reads, so it retries exactly once without ever
    // letting the scripted model fill the gap with remembered or guessed events.
    expect(result.toolNames).toEqual(['calendar.list_events', 'calendar.list_events']);
    expect(result.finalText).toContain("That's everything I could actually see.");
    expect(result.finalText).toContain('calendar provider is temporarily unavailable');
    expect(result.finalText).not.toContain('Done.');

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({ blocked: true, unsupportedCount: 1 });

    const calls = await db
      .select({ status: toolCalls.status, error: toolCalls.error })
      .from(toolCalls)
      .where(eq(toolCalls.taskId, result.taskId));
    expect(calls).toEqual([
      { status: 'failed', error: 'Error: calendar provider is temporarily unavailable' },
      { status: 'failed', error: 'Error: calendar provider is temporarily unavailable' },
    ]);
  });

  it('lets the response contract block an action claim with no tool evidence', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'fabricated-send-claim',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Email Anna the agenda.' } },
      taskType: 'adhoc',
      // A reply-shaped plan: mustAct would otherwise retry the toolless step
      // and never let this fabricated claim reach the contract at all.
      plan: { ...workflowPlan, action: 'reply' as const },
      // The scripted model claims a send happened; no tool ever ran.
      script: [{ text: "Done — I've sent the email to Anna with the agenda." }],
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual([]);
    // The delivered text must not carry the unsupported claim verbatim.
    expect(result.finalText).not.toContain("I've sent the email");
    expect(result.status).toBe('needs_attention');

    // The verdict is persisted for aggregation, not only rewritten.
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(true);
  });

  it('replaces a completion claim when a proactive action definitively failed', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'failed-send-cannot-look-complete',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Text me the door code.' } },
      taskType: 'adhoc',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'sms.send', input: { to: 'owner', body: 'Door code: 4821' } }] },
        { text: "Done — I've sent the text with the door code." },
      ],
      tools: {
        'sms.send': {
          schema: z.object({ to: z.string(), body: z.string() }),
          execute: async () => {
            throw new Error('SMS provider rejected the request');
          },
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['sms.send']);
    expect(result.finalText).not.toContain("I've sent the text");
    expect(result.finalText).toContain("I couldn't complete this because");
    expect(result.finalText).toContain('SMS provider rejected the request');
    expect(result.status).toBe('needs_attention');

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({ blocked: true, unsupportedCount: 1 });
  });

  it('records a clean response check for an honest answer', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'honest-answer',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Say hi.' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [{ text: 'Hi! What can I do for you?' }],
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toBeDefined();
    expect(check?.blocked).toBe(false);
    expect(check?.mustActRetries).toBe(0);
    expect(result.status).toBe('done');
  });

  it('self-reviews a clean draft once, records the revision, and still delivers through the contract', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'self-reflective-revision',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Say hi.' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [{ text: 'Hi.' }],
      verification: {
        decision: 'revise',
        revisedText: 'Hi! What can I help with?',
        reasons: ['clarity_or_format'],
      },
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).toBe('Hi! What can I help with?');
    expect(result.status).toBe('done');
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({
      blocked: false,
      outputVerificationAttempted: true,
      outputVerificationRevised: true,
      outputVerificationUnavailable: false,
    });
  });

  it('publishes independently attributed public transport from the current complete fetch', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const url = 'https://transit.example/options';
    const answer = `- **Rail** — R10 links Central with the airport.
- **Buses** — B12 and B13 serve the airport, with B12 running every 5–10 minutes.
- **Intercity** — IC connects North with the airport. Some local buses require a change.

[Source](${url})`;
    const source = `${'Navigation item. '.repeat(750)}
R10
- Route: Central - Airport
- Frequency: every 15 minutes
Express buses (B12, B13)
B12
- Route: City - Airport
- Frequency: every 5–10 minutes
B13
- Route: City - Airport
- Frequency: every 20 minutes
Intercity services (IC)
- Route: North - Airport - South
Local buses to Airport
Passengers reaching Junction must change to a train to reach the airport.
731
- Route: Town - Junction
- Continue to the airport with R10.`;
    const result = await runGoldenTask(db, agentId, {
      name: 'public-transport-local-attribution',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: {
          text: `Read ${url} and summarize the public transport options in three short bullets with a source link. Do not use my email, calendar, or memories.`,
        },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      pinOwnerRequest: true,
      script: [{ text: answer }],
      verification: { decision: 'publish', reasons: [] },
      tools: {
        'web.fetch': {
          schema: z.object({ url: z.string() }),
          execute: async (args) => {
            expect(args).toEqual({ url });
            return { status: 200, finalUrl: url, truncated: false, text: source };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['web.fetch']);
    expect(result.finalText).toBe(answer);
    expect(result.status).toBe('done');
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({
      blocked: false,
      unsupportedCount: 0,
      outputVerificationAttempted: true,
      outputVerificationRevised: false,
      outputVerificationUnavailable: false,
    });
  });

  it('delivers the checked draft and records a verifier outage without failing the owner response', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'self-reflective-verifier-unavailable',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Say hi.' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [{ text: 'Hi! What can I do for you?' }],
      verification: { unavailable: true },
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).toBe('Hi! What can I do for you?');
    expect(result.status).toBe('done');
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({
      blocked: false,
      outputVerificationAttempted: false,
      outputVerificationRevised: false,
      outputVerificationUnavailable: true,
    });
  });

  it('holds a self-review revision to the same evidence contract before delivery', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'self-reflective-revision-is-contract-checked',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Say hi.' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [{ text: 'Hi.' }],
      verification: {
        decision: 'revise',
        revisedText: 'Hi — I sent the email to Anna.',
        reasons: ['unsupported_claim'],
      },
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).not.toContain('I sent the email');
    expect(result.finalText).toBe('Hi.');
    expect(result.status).toBe('done');
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({
      blocked: true,
      unsupportedCount: 1,
      outputVerificationAttempted: true,
      outputVerificationRevised: true,
    });
  });

  it.for([
    { name: 'invented-link', revision: 'Hi. Read https://invented.example/receipt.' },
    { name: 'malformed-wording', revision: 'The reported temperature is 12°Chare.' },
  ])(
    'preserves the checked draft after a rejected $name review',
    async ({ name, revision }, ctx) => {
      if (!dbUp) return ctx.skip();
      const fixture: GoldenFixture = {
        name: `self-review-rejected-${name}`,
        event: { source: 'chat', trust: 'owner', payload: { text: 'Say hi.' } },
        taskType: 'adhoc',
        plan: { ...workflowPlan, action: 'reply' as const },
        script: [{ text: 'Hi.' }],
        verification: { decision: 'revise', revisedText: revision, reasons: ['clarity_or_format'] },
        tools: {},
      };
      const result = await runGoldenTask(db, agentId, fixture);
      createdTaskIds.push(result.taskId);
      expect(result.finalText).toBe('Hi.');
      expect(result.status).toBe('done');
      expect(result.toolNames).toEqual([]);
      const [check] = await db
        .select()
        .from(responseChecks)
        .where(eq(responseChecks.taskId, result.taskId));
      expect(check).toMatchObject({
        outputVerificationAttempted: true,
        outputVerificationRevised: name !== 'malformed-wording',
        outputVerificationUnavailable: false,
      });
    },
  );

  it('lets an action claim WITH tool evidence through untouched', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The inverse of the fabricated-claim fixture: the send actually ran, so
    // the contract must not rewrite the honest confirmation. This pins the
    // false-positive side — a claim-detection tightening that starts blocking
    // real confirmations fails here, not on a user.
    const fixture: GoldenFixture = {
      name: 'evidence-supported-send',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Text me the door code.' } },
      taskType: 'adhoc',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'sms.send', input: { to: 'owner', body: 'Door code: 4821' } }] },
        { text: "Done — I've sent the text with the door code." },
      ],
      tools: {
        'sms.send': {
          schema: z.object({ to: z.string(), body: z.string() }),
          execute: async () => ({ deliveryStatus: 'accepted', sid: 'SM-golden-1' }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['sms.send']);
    expect(result.finalText).toContain("I've sent the text");
    expect(result.status).toBe('done');

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(false);
    expect(check?.unsupportedCount).toBe(0);
  });

  it('strips a fabricated link but does not block the answer around it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The REWRITE verdict path: an unevidenced URL loses its href while the
    // answer survives — distinct from blocking, and the only place the
    // urlCorpus assembly in finalize.ts is exercised end to end.
    const fixture: GoldenFixture = {
      name: 'fabricated-link',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Where do I manage this?' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [
        {
          text: 'You can manage it at https://acme.example/settings/9f3a2b under Preferences.',
        },
      ],
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).not.toContain('https://acme.example/settings/9f3a2b');
    expect(result.finalText).toMatch(/removed a link/i);
    expect(result.status).toBe('done');

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(false);
  });

  it('forces a workflow plan to act, and counts the retry it took', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // A workflow plan whose first step proposes no tool is retried with the
    // forced-action nudge; the retry consumes the next script entry. Closes
    // the carve-out the fabricated-send fixture's comment notes.
    const fixture: GoldenFixture = {
      name: 'must-act-retry',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Look up the wifi password.' } },
      taskType: 'adhoc',
      plan: workflowPlan,
      script: [
        { text: 'I will look that up now.' }, // toolless first step → forced retry
        { toolCalls: [{ toolName: 'facts.lookup', input: { key: 'wifi' } }] },
        { text: 'It is hunter2.' },
      ],
      tools: {
        'facts.lookup': {
          schema: z.object({ key: z.string() }),
          execute: async () => ({ value: 'hunter2' }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['facts.lookup']);
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.mustActRetries).toBe(1);
    expect(check?.blocked).toBe(false);
  });

  it('answers save-status checks without letting a planner or prose model invent a receipt', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing test conversation');
    createdConversationIds.push(conversation.id);
    const [previous] = await db
      .insert(tasks)
      .values({
        agentId,
        conversationId: conversation.id,
        type: 'chat_turn',
        status: 'failed',
        trust: 'owner',
        trigger: { source: 'chat', payload: { text: 'Remember our family birthdays' } },
        createdAt: new Date(Date.now() - 60_000),
      })
      .returning();
    if (!previous) throw new Error('missing previous task');
    createdTaskIds.push(previous.id);
    await db.insert(toolCalls).values({
      taskId: previous.id,
      toolName: 'occasions.save',
      step: 1,
      risk: 'autonomous',
      status: 'succeeded',
      args: { kind: 'birthday' },
      result: { saved: true, person: 'Ada', quarantined: false },
    });
    const result = await runGoldenTask(db, agentId, {
      name: 'save-status-without-model',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: 'Was it save to long term memory' },
      },
      taskType: 'chat_turn',
      tools: {},
      script: [{ text: 'Everything has been saved!' }],
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual([]);
    expect(result.finalText).toContain('Partly.');
    expect(result.finalText).toContain('1 birthday entry in People: Ada');
    expect(result.finalText).not.toContain('Everything has been saved');
  });

  it('looks up and reads a current score before accepting a model answer', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'home-live-score',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'What is the current Giants score?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [{ text: 'The game is tied 1–1 in the fifth inning.' }],
      tools: {
        'web.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => ({ results: [{ url: 'https://example.com/game' }] }),
        },
        'web.fetch': {
          schema: z.object({ url: z.string() }),
          execute: async () => ({ status: 200, text: 'Giants 1 Dodgers 1. Fifth inning.' }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['web.search', 'web.fetch']);
    expect(result.finalText).toContain('1–1');
  });

  it('blocks invented temperatures after the weather provider fails', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'home-failed-weather',
      event: { source: 'chat', trust: 'owner', payload: { text: 'How is the weather currently?' } },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'weather.lookup', input: { place: 'San Francisco' } }] },
        { text: 'It is sunny and 14°C right now.' },
      ],
      tools: {
        'weather.lookup': {
          schema: z.object({ place: z.string() }),
          execute: async () => {
            throw new Error('HTTP 400');
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['weather.lookup']);
    expect(result.status).toBe('needs_attention');
    expect(result.finalText).toContain("can't confirm temperatures");
    expect(result.finalText).not.toContain('14°C');
  });

  it('saves a multi-person birthday list in bounded batches with an exact receipt', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const names = Array.from({ length: 17 }, (_, i) => `Person ${i + 1}`);
    const result = await runGoldenTask(db, agentId, {
      name: 'home-birthday-batch',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: {
          text: `Remember these birthdays:\n${names.map((name) => `${name} April 20, 1980`).join('\n')}`,
        },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      maxSteps: 5,
      script: [{ text: 'Everything is saved and linked in your graph.' }],
      tools: {
        'memory.save': {
          schema: z.object({ subject: z.string(), content: z.string() }),
          execute: async () => ({ saved: true, quarantined: false }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toHaveLength(17);
    expect(result.toolNames.every((name) => name === 'memory.save')).toBe(true);
    expect(result.status).toBe('done');
    expect(result.finalText).toContain('Saved 17 of 17');
    expect(result.finalText).not.toContain('Everything is saved and linked');
  });

  it('does not mark graph attachment complete after memory saves alone', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'home-birthday-graph-coverage',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: {
          text: 'Attach these birthdays to my graph and memory:\nAda April 20, 1980\nGrace May 2, 1985',
        },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [{ text: 'Everything is linked.' }],
      tools: {
        'memory.save': {
          schema: z.object({ subject: z.string(), content: z.string() }),
          execute: async () => ({ saved: true }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.finalText).toContain('Saved 2 of 2');
    expect(result.finalText).toContain('Graph attachments are not yet verified');
    expect(result.status).toBe('needs_attention');
  });

  it('reports saved birthdays when a batch reaches the step cap', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'birthday-step-cap-receipt',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'Remember our family birthdays, update their information.' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      maxSteps: 1,
      script: [
        {
          toolCalls: [
            { toolName: 'occasions.save', input: { subject: 'Ada', kind: 'birthday' } },
            { toolName: 'occasions.save', input: { subject: 'Grace', kind: 'birthday' } },
          ],
        },
      ],
      tools: {
        'occasions.save': {
          schema: z.object({ subject: z.string(), kind: z.string() }),
          execute: async (args) => ({
            saved: true,
            person: z.object({ subject: z.string() }).parse(args).subject,
            quarantined: false,
          }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);
    expect(result.status).toBe('failed');
    expect(result.finalText).toContain('2 birthday entries in People: Ada, Grace');
    expect(result.finalText).toContain('remaining work has not been completed');
  });

  it('reports verified progress instead of an opaque failure when proactive work reaches its step cap', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'step-cap-progress-summary',
      event: {
        source: 'internal',
        trust: 'assistant',
        payload: { instruction: 'Find the wifi password and then send it to me.' },
      },
      taskType: 'adhoc',
      plan: workflowPlan,
      maxSteps: 1,
      script: [
        {
          text: 'I found the wifi password in the workspace notes, but have not sent it yet.',
          toolCalls: [{ toolName: 'facts.lookup', input: { key: 'wifi' } }],
        },
      ],
      tools: {
        'facts.lookup': {
          schema: z.object({ key: z.string() }),
          execute: async () => ({ value: 'hunter2' }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['facts.lookup']);
    expect(result.status).toBe('failed');
    expect(result.finalText).toContain('stopped after 1 steps without finishing');
    expect(result.finalText).toContain('1 tool call completed (facts.lookup)');
    expect(result.finalText).toContain('remaining work has not been completed');
    // The model's pre-tool narration is not a verified completion summary.
    expect(result.finalText).not.toContain('found the wifi password');
    expect(result.finalText).not.toContain('See task log');
  });
});
