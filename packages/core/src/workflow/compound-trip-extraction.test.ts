import { describe, expect, it, vi } from 'vitest';
import { extractCompoundTripBookings } from './compound-trip-extraction.js';
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

function evidence(body = `${flightQuote}\n${hotelQuote}`): ReadToolEvidence[] {
  const messages = [
    {
      messageId: 'booking-message-1',
      subject: 'Your Berlin trip',
      text: body,
      truncated: false,
      sourceLength: body.length,
    },
  ];
  return [
    {
      toolName: 'gmail.search',
      status: 'succeeded',
      fromCurrentTask: true,
      args: { query: request.mailQuery, maxResults: 10 },
      result: {
        query: request.mailQuery,
        complete: true,
        hasMore: false,
        results: [{ threadId: 'trip-thread', subject: 'Your Berlin trip' }],
        unavailable: [],
        receipt: {
          version: 1,
          source: { kind: 'gmail-search', id: request.mailQuery },
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
          covered: { start: 0, offset: 0, end: 1, count: 1, total: 1, unavailable: 0 },
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

  it('admits a complete booking message just over ten thousand characters within the total cap', async () => {
    const longBody = `${flightQuote}\n${'x'.repeat(10_449 - flightQuote.length)}`;
    const object = vi.fn().mockResolvedValue({ ok: true, object: extractedFacts() });
    const result = await extractCompoundTripBookings({
      router: { object } as never,
      taskId: 'task-trip-long-confirmation',
      request,
      evidence: evidence(longBody),
    });

    expect(longBody).toHaveLength(10_450);
    expect(object).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('complete');
    expect(result.segments).toHaveLength(1);
  });
});
