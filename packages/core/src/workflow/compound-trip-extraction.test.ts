import { gmailSearchReceiptSourceId } from '@assistant/persistence/gmail-search-identity';
import { describe, expect, it, vi } from 'vitest';
import { extractCompoundTripBookings } from './compound-trip-extraction.js';
import { compoundTripReadProjection } from './compound-trip-read.js';
import type { PersonalReadRequest, ReadToolEvidence } from './read-intent.js';

const request: PersonalReadRequest = {
  kind: 'calendar_email',
  firstToolName: 'calendar.list_events',
  requiresThreadRead: true,
  queryTerms: ['Berlin'],
  mailQuery: 'Berlin flight booking',
  compoundTripDiscovery: true,
  timeZone: 'America/Los_Angeles',
  timeWindow: {
    timeMin: '2026-10-13T07:00:00.000Z',
    timeMax: '2027-10-13T07:00:00.000Z',
    label: 'next trip',
  },
};

const flightQuote =
  'Your journey: flight LH 401 from SFO to FRA, departing 22 October 2026 at 21:10 Europe/Berlin. Booking code FLIGHT-8821.';
const hotelQuote =
  'Hotel Linden in Berlin, 5 Alexanderplatz, 10178 Berlin. Your stay is 22 October 2026 through 24 October 2026. Confirmation HOTEL-55123.';

function evidence(
  body = `${flightQuote}\n${hotelQuote}`,
  additionalBodies: string[] = [],
): ReadToolEvidence[] {
  const query = request.mailQuery;
  if (!query) throw new Error('Expected Gmail query in fixture');
  const messages = [body, ...additionalBodies].map((text, index) => ({
    messageId: index === 0 ? 'booking-message-1' : `booking-message-${index + 1}`,
    subject: 'Your Berlin trip',
    text,
    truncated: false,
    sourceLength: text.length,
  }));
  return [
    {
      toolName: 'gmail.search',
      status: 'succeeded',
      fromCurrentTask: true,
      args: { query, maxResults: 10 },
      result: {
        query,
        complete: true,
        hasMore: false,
        results: [{ threadId: 'trip-thread', subject: 'Your Berlin trip' }],
        unavailable: [],
        receipt: {
          version: 1,
          source: { kind: 'gmail-search', id: gmailSearchReceiptSourceId(query) },
          requested: { limit: 10, scope: 'query-page' },
          covered: { count: 1, total: 1, unavailable: 0 },
          complete: true,
          losses: [],
          continuation: null,
        },
      },
    },
    {
      toolName: 'gmail.read_thread',
      status: 'succeeded',
      fromCurrentTask: true,
      args: {
        threadId: 'trip-thread',
        startMessageIndex: 0,
        startMessageOffset: 0,
        maxMessages: 20,
        maxChars: 20_000,
      },
      result: {
        threadId: 'trip-thread',
        complete: true,
        hasMore: false,
        messages,
        receipt: {
          version: 1,
          source: { kind: 'gmail-thread', id: 'trip-thread' },
          requested: { start: 0, offset: 0, limit: 20, scope: 'thread-messages' },
          covered: {
            start: 0,
            offset: 0,
            end: messages.length,
            count: messages.length,
            total: messages.length,
            unavailable: 0,
          },
          complete: true,
          losses: [],
          continuation: null,
        },
      },
    },
  ];
}

function extractedFacts(overrides: Record<string, unknown> = {}) {
  return {
    messages: [
      {
        threadId: 'trip-thread',
        messageId: 'booking-message-1',
        segments: [
          {
            flightNumber: 'LH 401',
            role: 'outbound',
            departureDate: '22 October 2026',
            departureTime: '21:10',
            departureTimeZone: 'Europe/Berlin',
            arrivalDate: null,
            arrivalTime: null,
            arrivalTimeZone: null,
            originAirport: 'SFO',
            destinationAirport: 'FRA',
            bookingReference: 'FLIGHT-8821',
            quote: flightQuote,
          },
        ],
        hotels: [
          {
            name: 'Hotel Linden',
            address: '5 Alexanderplatz, 10178 Berlin',
            city: 'Berlin',
            checkIn: '22 October 2026',
            checkOut: '24 October 2026',
            bookingReference: 'HOTEL-55123',
            quote: hotelQuote,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('compound trip source extraction', () => {
  it.each(['departing', 'DEPARTURE', 'outbound'])(
    'requires an explicit direction label, not the generic %s clock heading',
    async (label) => {
      const quote = flightQuote.replace('departing', label);
      const facts = extractedFacts();
      const segment = facts.messages[0]?.segments[0];
      if (!segment) throw new Error('Missing segment fixture');
      segment.quote = quote;
      const object = vi.fn().mockResolvedValue({ ok: true, object: facts });
      const result = await extractCompoundTripBookings({
        router: { object } as never,
        taskId: 'direction',
        request,
        evidence: evidence(`${quote}\n${hotelQuote}`),
      });
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0]).toMatchObject({
        direction: label === 'outbound' ? 'outbound' : 'unknown',
        flightNumber: 'LH401',
        departureDate: '2026-10-22',
        departureTime: '21:10',
        departureTimeZone: 'Europe/Berlin',
        excerpt: quote,
      });
      expect(object).toHaveBeenCalledTimes(1);
    },
  );

  it('uses one capped structured extraction and validates facts against exact message quotes', async () => {
    const object = vi.fn().mockResolvedValue({
      ok: true,
      modelId: 'test/extractor',
      degraded: false,
      object: extractedFacts(),
      finishReason: 'stop',
    });
    const result = await extractCompoundTripBookings({
      router: { object } as never,
      taskId: 'task-trip-1',
      request,
      evidence: evidence(),
    });

    expect(object).toHaveBeenCalledTimes(1);
    expect(object).toHaveBeenCalledWith(
      'extract',
      expect.objectContaining({
        taskId: 'task-trip-1',
        maxOutputTokens: 3600,
        maxEstimatedCostUsd: 0.05,
        maxRetries: 0,
        singleAttempt: true,
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.segments).toMatchObject([
      {
        threadId: 'trip-thread',
        messageId: 'booking-message-1',
        flightNumber: 'LH401',
        departureDate: '2026-10-22',
        departureTime: '21:10',
        departureTimeZone: 'Europe/Berlin',
        originAirport: 'SFO',
        destinationAirport: 'FRA',
      },
    ]);
    expect(result.hotels).toMatchObject([
      {
        name: 'Hotel Linden',
        address: '5 Alexanderplatz, 10178 Berlin',
        city: 'Berlin',
        checkIn: '2026-10-22',
        checkOut: '2026-10-24',
        bookingReference: 'HOTEL-55123',
      },
    ]);
    const options = object.mock.calls[0]?.[1] as { prompt: string };
    expect(options.prompt).toContain('untrusted data');
    expect(options.prompt).toContain('booking-message-1');
  });

  it('keeps a full ten-thousand-character booking message available for exact extraction', async () => {
    const body = `${flightQuote}\n${'Additional fare conditions apply to this itinerary. '.repeat(210)}\n${hotelQuote}`;
    expect(body.length).toBeGreaterThan(10_000);
    expect(body.length).toBeLessThan(20_000);
    const object = vi.fn().mockResolvedValue({ ok: true, object: extractedFacts() });
    const result = await extractCompoundTripBookings({
      router: { object } as never,
      taskId: 'task-trip-long-booking-message',
      request,
      evidence: evidence(body),
    });

    expect(result.status).toBe('complete');
    expect(result.segments).toHaveLength(1);
    expect(result.hotels).toHaveLength(1);
    const prompt = (object.mock.calls[0]?.[1] as { prompt: string } | undefined)?.prompt;
    expect(prompt).toContain(flightQuote);
    expect(prompt).toContain(hotelQuote);
    expect(prompt?.length).toBeGreaterThan(body.length);
  });

  it('extracts complete selected threads from a valid search prefix while later provider pages remain', async () => {
    const rows = evidence();
    const search = rows.find((row) => row.toolName === 'gmail.search');
    if (!search) throw new Error('fixture search row missing');
    const result = search.result as Record<string, unknown>;
    const hits = [
      { threadId: 'newsletter-1', subject: 'Weekly newsletter' },
      { threadId: 'newsletter-2', subject: 'Weekly newsletter' },
      { threadId: 'newsletter-3', subject: 'Weekly newsletter' },
      { threadId: 'trip-thread', subject: 'Your Berlin flight booking' },
      { threadId: 'unread-hit-5', subject: 'Travel deals' },
    ];
    result.results = hits;
    result.complete = false;
    result.hasMore = true;
    result.nextPageToken = 'provider-page-2';
    result.continuation = {
      tool: 'gmail.search',
      input: { query: request.mailQuery, maxResults: 10, pageToken: 'provider-page-2' },
    };
    const receipt = result.receipt as Record<string, unknown>;
    receipt.complete = false;
    receipt.losses = ['provider-page'];
    receipt.covered = { count: hits.length, total: 18, unavailable: 0 };
    receipt.continuation = structuredClone(result.continuation);

    const object = vi.fn().mockResolvedValue({ ok: true, object: extractedFacts() });
    const extraction = await extractCompoundTripBookings({
      router: { object } as never,
      taskId: 'task-trip-provider-more',
      request,
      evidence: rows,
    });

    expect(object).toHaveBeenCalledTimes(1);
    expect(extraction.status).toBe('complete');
    expect(extraction.segments).toHaveLength(1);
    expect(extraction.hotels).toHaveLength(1);
    expect(extraction.sourceMessageIds).toEqual(['booking-message-1']);
    const objectCall = object.mock.calls[0];
    if (!objectCall) throw new Error('structured extraction call missing');
    const prompt = (objectCall[1] as { prompt: string }).prompt;
    expect(prompt).toContain('booking-message-1');
    expect(prompt).not.toContain('newsletter-1');
    const projection = compoundTripReadProjection(request, rows, extraction);
    expect(projection.gmailSearchComplete).toBe(false);
    expect(projection.threadsComplete).toBe(false);
    expect(projection.blocked).toBe(true);
    expect(projection.text).toContain('Booking-email search or thread coverage is incomplete');
    expect(projection.text).not.toContain('fully verified complete trip');
    expect(projection.text).toContain(
      'Booking email observation — not a verified next-flight match',
    );
    expect(projection.text).toContain('[Booking email]');
  });

  it('parses source-exact abbreviated English month dates without guessing numeric dates', async () => {
    const body =
      'Outbound flight LH 401 departs SFO to FRA on Oct 22, 2026 at 21:10 Europe/Berlin. Booking code FLIGHT-8821. Hotel Linden, 5 Alexanderplatz, 10178 Berlin, stay 22 Oct 2026 through 24 Oct 2026. Confirmation HOTEL-55123.';
    const facts = extractedFacts();
    const message = (facts.messages as Array<Record<string, unknown>>)[0];
    if (!message) throw new Error('fixture message missing');
    const segment = (message.segments as Array<Record<string, unknown>>)[0];
    const hotel = (message.hotels as Array<Record<string, unknown>>)[0];
    if (!segment || !hotel) throw new Error('fixture facts missing');
    segment.departureDate = 'Oct 22, 2026';
    segment.quote =
      'Outbound flight LH 401 departs SFO to FRA on Oct 22, 2026 at 21:10 Europe/Berlin. Booking code FLIGHT-8821.';
    hotel.checkIn = '22 Oct 2026';
    hotel.checkOut = '24 Oct 2026';
    hotel.quote =
      'Hotel Linden, 5 Alexanderplatz, 10178 Berlin, stay 22 Oct 2026 through 24 Oct 2026. Confirmation HOTEL-55123.';
    const object = vi.fn().mockResolvedValue({ ok: true, object: facts });
    const result = await extractCompoundTripBookings({
      router: { object } as never,
      taskId: 'task-trip-abbreviated-dates',
      request,
      evidence: evidence(body),
    });
    expect(result.segments[0]?.departureDate).toBe('2026-10-22');
    expect(result.hotels[0]).toMatchObject({ checkIn: '2026-10-22', checkOut: '2026-10-24' });
    const numericFacts = extractedFacts();
    const numericMessage = (numericFacts.messages as Array<Record<string, unknown>>)[0];
    if (!numericMessage) throw new Error('numeric fixture message missing');
    const numericSegment = (numericMessage.segments as Array<Record<string, unknown>>)[0];
    if (!numericSegment) throw new Error('numeric fixture segment missing');
    numericSegment.departureDate = '10/22/2026';
    numericSegment.quote = `${flightQuote} Issued 10/22/2026.`;
    const numeric = await extractCompoundTripBookings({
      router: { object: vi.fn().mockResolvedValue({ ok: true, object: numericFacts }) } as never,
      taskId: 'task-trip-numeric-date',
      request,
      evidence: evidence(`${flightQuote} Issued 10/22/2026.\n${hotelQuote}`),
    });
    expect(numeric.segments).toEqual([]);
  });

  it('rejects a quote from a different message and a year absent from the source', async () => {
    const facts = extractedFacts();
    const firstMessage = (facts.messages as Array<Record<string, unknown>>)[0];
    const segments = firstMessage?.segments as Array<Record<string, unknown>>;
    const hotels = firstMessage?.hotels as Array<Record<string, unknown>>;
    if (!segments?.[0] || !hotels?.[0]) throw new Error('fixture facts missing');
    segments[0].quote = 'This is not an exact source quote.';
    segments[0].departureDate = '22 October 2031';
    const object = vi.fn().mockResolvedValue({ ok: true, object: facts });
    const result = await extractCompoundTripBookings({
      router: { object } as never,
      taskId: 'task-trip-2',
      request,
      evidence: evidence(),
    });

    expect(result.status).toBe('complete');
    expect(result.segments).toEqual([]);
    expect(result.rejectedFacts).toBe(1);
    expect(result.hotels).toHaveLength(1);
  });

  it('requires airport and time-zone tokens instead of accepting them inside city or prose words', async () => {
    const facts = extractedFacts();
    const message = (facts.messages as Array<Record<string, unknown>>)[0];
    if (!message) throw new Error('fixture message missing');
    const segment = (message.segments as Array<Record<string, unknown>>)[0];
    if (!segment) throw new Error('fixture segment missing');
    const quote =
      'Your journey: flight LH 401 from SFO, arriving in Berlin, departing 22 October 2026 at 21:10 West. Booking code FLIGHT-8821.';
    segment.destinationAirport = 'BER';
    segment.departureTimeZone = 'EST';
    segment.quote = quote;
    const object = vi.fn().mockResolvedValue({ ok: true, object: facts });
    const result = await extractCompoundTripBookings({
      router: { object } as never,
      taskId: 'task-trip-token-boundary',
      request,
      evidence: evidence(`${quote}\n${hotelQuote}`),
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.destinationAirport).toBeUndefined();
    expect(result.segments[0]?.departureTimeZone).toBeUndefined();
  });

  it('does not extract from a thread with a missing continuation segment', async () => {
    const rows = evidence();
    const read = rows.find((row) => row.toolName === 'gmail.read_thread');
    if (!read) throw new Error('fixture thread row missing');
    read.result = {
      complete: false,
      continuation: {
        tool: 'gmail.read_thread',
        input: { threadId: 'trip-thread', startMessageIndex: 0, startMessageOffset: 50 },
      },
      messages: [
        {
          threadId: 'trip-thread',
          messageId: 'booking-message-1',
          subject: 'Your Berlin trip',
          text: flightQuote.slice(0, 50),
          truncated: true,
          sourceLength: flightQuote.length,
        },
      ],
    };
    const object = vi.fn();
    const result = await extractCompoundTripBookings({
      router: { object } as never,
      taskId: 'task-trip-3',
      request,
      evidence: rows,
    });

    expect(result.status).toBe('unavailable');
    expect(result.segments).toEqual([]);
    expect(object).not.toHaveBeenCalled();
  });

  it('does not extract booking facts from legacy search or thread rows without source receipts', async () => {
    const rows = evidence();
    for (const row of rows) {
      const result = row.result as Record<string, unknown>;
      delete result.receipt;
    }
    const object = vi.fn();
    const result = await extractCompoundTripBookings({
      router: { object } as never,
      taskId: 'task-trip-no-receipt',
      request,
      evidence: rows,
    });

    expect(result.status).toBe('unavailable');
    expect(object).not.toHaveBeenCalled();
  });

  it('extracts a fully continued 12,356-character message within the aggregate cap', async () => {
    const longBody = `${flightQuote}\n${'x'.repeat(12_356 - flightQuote.length - 1)}`;
    const companionBody = 'y'.repeat(3_511);
    const object = vi.fn().mockResolvedValue({ ok: true, object: extractedFacts() });
    const result = await extractCompoundTripBookings({
      router: { object } as never,
      taskId: 'task-trip-long-confirmation',
      request,
      evidence: evidence(longBody, [companionBody]),
    });

    expect(longBody).toHaveLength(12_356);
    expect(longBody.length + companionBody.length).toBe(15_867);
    expect(object).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('complete');
    expect(result.segments).toHaveLength(1);
  });

  it('keeps the aggregate source cap when individually bounded messages exceed it together', async () => {
    const object = vi.fn();
    const result = await extractCompoundTripBookings({
      router: { object } as never,
      taskId: 'task-trip-aggregate-cap',
      request,
      evidence: evidence('x'.repeat(20_000), ['y'.repeat(16_001)]),
    });

    expect(result.status).toBe('unavailable');
    expect(result.segments).toEqual([]);
    expect(object).not.toHaveBeenCalled();
  });

  it('does not trust a continuation read from a thread outside the selected search result', async () => {
    const rows = evidence('x'.repeat(12_356));
    const initialRead = rows.find((row) => row.toolName === 'gmail.read_thread');
    if (!initialRead) throw new Error('fixture thread row missing');
    const initialArgs = initialRead.args as Record<string, unknown>;
    const initialResult = initialRead.result as Record<string, unknown>;
    const initialReceipt = initialResult.receipt as Record<string, unknown>;
    initialArgs.startMessageOffset = 0;
    initialResult.complete = false;
    initialResult.hasMore = true;
    initialResult.continuation = {
      tool: 'gmail.read_thread',
      input: {
        threadId: 'trip-thread',
        startMessageIndex: 0,
        startMessageOffset: 8_000,
        maxMessages: 20,
        maxChars: 20_000,
      },
    };
    initialResult.messages = [
      {
        messageId: 'booking-message-1',
        subject: 'Your Berlin trip',
        text: 'x'.repeat(8_000),
        truncated: true,
        sourceLength: 12_356,
      },
    ];
    initialReceipt.complete = false;
    initialReceipt.losses = ['message-body'];
    initialReceipt.covered = { start: 0, offset: 0, end: 1, count: 1, total: 1, unavailable: 0 };
    initialReceipt.continuation = structuredClone(initialResult.continuation);
    rows.push({
      toolName: 'gmail.read_thread',
      status: 'succeeded',
      fromCurrentTask: true,
      args: {
        threadId: 'foreign-thread',
        startMessageIndex: 0,
        startMessageOffset: 8_000,
        maxMessages: 20,
        maxChars: 20_000,
      },
      result: {
        threadId: 'foreign-thread',
        complete: true,
        hasMore: false,
        messages: [
          {
            messageId: 'booking-message-1',
            subject: 'Your Berlin trip',
            text: 'x'.repeat(4_356),
            truncated: false,
            sourceLength: 12_356,
          },
        ],
        receipt: {
          version: 1,
          source: { kind: 'gmail-thread', id: 'foreign-thread' },
          requested: { start: 0, offset: 8_000, limit: 20, scope: 'thread-messages' },
          covered: { start: 0, offset: 8_000, end: 1, count: 1, total: 1, unavailable: 0 },
          complete: true,
          losses: [],
          continuation: null,
        },
      },
    });
    const object = vi.fn();
    const result = await extractCompoundTripBookings({
      router: { object } as never,
      taskId: 'task-trip-foreign-continuation',
      request,
      evidence: rows,
    });

    expect(result.status).toBe('unavailable');
    expect(result.segments).toEqual([]);
    expect(object).not.toHaveBeenCalled();
  });
});

describe('bounded extraction outcome metadata', () => {
  it.each([
    ['router-unavailable', () => Promise.resolve({ ok: false })],
    ['invalid-output', () => Promise.resolve({ ok: true, object: { messages: 'invalid' } })],
    [
      'extraction-error',
      () => Promise.reject(new Error('private failure content must not be persisted')),
    ],
  ] as const)('records only the enumerated %s reason', async (reason, implementation) => {
    const object = vi.fn(implementation);
    const result = await extractCompoundTripBookings({
      router: { object } as never,
      taskId: 'trip-reason-test',
      request,
      evidence: evidence(),
    });
    expect(result.status).toBe('unavailable');
    expect(result.unavailableReason).toBe(reason);
    expect(JSON.stringify(result)).not.toContain('private failure content');
    expect(object).toHaveBeenCalledOnce();
  });
});

describe('canonical provider quote validation', () => {
  it('retains source facts with ISO date fields and MIME newline-normalized quotes', async () => {
    const body = `${flightQuote}\n${hotelQuote}`;
    const facts = extractedFacts();
    const first = facts.messages[0];
    if (!first) throw new Error('Missing fixture');
    const segment = first.segments[0];
    const hotel = first.hotels[0];
    if (!segment || !hotel) throw new Error('Missing facts');
    segment.departureDate = '2026-10-22';
    hotel.checkIn = '2026-10-22';
    hotel.checkOut = '2026-10-24';
    segment.quote = flightQuote.replace(', departing', ',\ndeparting');
    const result = await extractCompoundTripBookings({
      router: { object: vi.fn(async () => ({ ok: true, object: facts })) } as never,
      taskId: 'canonical-provider-source',
      request,
      evidence: evidence(body.replace(', departing', ',\r\ndeparting')),
    });
    expect(result.rejectedFacts).toBe(0);
    expect(result.segments[0]?.departureDate).toBe('2026-10-22');
    expect(result.hotels[0]).toMatchObject({ checkIn: '2026-10-22', checkOut: '2026-10-24' });
  });

  it('does not accept an ISO field for a different source date or a rewritten quote', async () => {
    const facts = extractedFacts();
    const first = facts.messages[0];
    if (!first?.segments[0] || !first.hotels[0]) throw new Error('Missing fixture');
    first.segments[0].departureDate = '2026-10-23';
    first.hotels[0].quote = hotelQuote.replace('Hotel Linden', 'Hotel Invented');
    const result = await extractCompoundTripBookings({
      router: { object: vi.fn(async () => ({ ok: true, object: facts })) } as never,
      taskId: 'rewritten-provider-source',
      request,
      evidence: evidence(),
    });
    expect(result.segments).toEqual([]);
    expect(result.hotels).toEqual([]);
    expect(result.rejectedFacts).toBe(2);
  });
});

it.each([
  { clock: '13:45', count: 1 },
  { clock: '01:45 AM', count: 0 },
])(
  'normalizes equivalent source clocks but preserves AM/PM polarity: $clock',
  async ({ clock, count }) => {
    const body = flightQuote.replace('21:10', '1:45 pm');
    const facts = extractedFacts();
    const first = facts.messages[0];
    if (!first?.segments[0]) throw new Error('Missing fixture');
    first.hotels = [];
    first.segments[0].departureTime = clock;
    first.segments[0].quote = body;
    const result = await extractCompoundTripBookings({
      router: { object: vi.fn(async () => ({ ok: true, object: facts })) } as never,
      taskId: 'canonical-source-clock',
      request,
      evidence: evidence(body),
    });
    expect(result.segments).toHaveLength(count);
  },
);

it('keeps a dated flight fact while refusing an unsupported direction label', async () => {
  const body = flightQuote.replace('departing', 'scheduled for');
  const facts = extractedFacts();
  const first = facts.messages[0];
  if (!first?.segments[0]) throw new Error('Missing fixture');
  first.hotels = [];
  first.segments[0].quote = body;
  const result = await extractCompoundTripBookings({
    router: { object: vi.fn(async () => ({ ok: true, object: facts })) } as never,
    taskId: 'unsupported-direction',
    request,
    evidence: evidence(body),
  });
  expect(result.rejectedFacts).toBe(0);
  expect(result.segments[0]).toMatchObject({
    flightNumber: 'LH401',
    departureDate: '2026-10-22',
    departureTimeZone: 'Europe/Berlin',
    direction: 'unknown',
  });
});
