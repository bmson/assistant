import { gmailSearchReceiptSourceId } from '@assistant/persistence/gmail-search-identity';
import { describe, expect, it } from 'vitest';
import type { CompoundTripExtraction } from './compound-trip-extraction.js';
import {
  compoundTripFetchTargets,
  compoundTripReadProjection,
  compoundTripRoute,
  compoundTripThreadIdsToRead,
  upcomingFlightReadProjection,
} from './compound-trip-read.js';
import {
  buildReadToolInput,
  detectPersonalReadRequest,
  nextRequiredReadTool,
  type ReadToolEvidence,
} from './read-intent.js';
import { enforcePersonalReadResponse } from './response-contract.js';

const PROMPT =
  'Find my next trip from my booking emails and calendar. Confirm the flight dates, departure times and time zones, connections, and hotel. Check for conflicting information. Then plan how to get from the destination airport to my hotel, comparing public transport and taxi. Give me a short itinerary with source links, and clearly mark anything you cannot verify.';

function request() {
  const detected = detectPersonalReadRequest([{ role: 'user', content: PROMPT }], {
    now: new Date('2026-10-13T18:00:00.000Z'),
    timeZone: 'America/Los_Angeles',
  });
  if (!detected?.compoundTripDiscovery) throw new Error('Expected compound-trip read intent');
  return detected;
}

function row(
  toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): ReadToolEvidence {
  if (toolName === 'gmail.search') {
    const query = typeof args.query === 'string' ? args.query : '';
    const maxResults = Number.isInteger(args.maxResults) ? args.maxResults : 10;
    const results = Array.isArray(result.results) ? result.results : [];
    const unavailable = Array.isArray(result.unavailable) ? result.unavailable : [];
    const hasMore = result.hasMore === true;
    const token = typeof result.nextPageToken === 'string' ? result.nextPageToken : undefined;
    const continuation =
      result.continuation ??
      (hasMore && token
        ? { tool: 'gmail.search', input: { query, maxResults, pageToken: token } }
        : null);
    return {
      toolName,
      status: 'succeeded',
      args: { ...args, maxResults },
      result: {
        ...result,
        query,
        ...(Object.hasOwn(result, 'continuation') ? { continuation: result.continuation } : {}),
        unavailable,
        receipt: result.receipt ?? {
          version: 1,
          source: { kind: 'gmail-search', id: gmailSearchReceiptSourceId(query) },
          requested: {
            limit: maxResults,
            ...(typeof args.pageToken === 'string' ? { cursor: args.pageToken } : {}),
            scope: 'query-page',
          },
          covered: {
            count: results.length,
            total: results.length,
            unavailable: unavailable.length,
          },
          complete: result.complete === true,
          losses: hasMore ? ['provider-page'] : [],
          continuation,
        },
      },
      fromCurrentTask: true,
    };
  }
  if (toolName === 'gmail.read_thread') {
    const start =
      typeof args.startMessageIndex === 'number' && Number.isInteger(args.startMessageIndex)
        ? args.startMessageIndex
        : 0;
    const offset =
      typeof args.startMessageOffset === 'number' && Number.isInteger(args.startMessageOffset)
        ? args.startMessageOffset
        : 0;
    const maxMessages =
      typeof args.maxMessages === 'number' && Number.isInteger(args.maxMessages)
        ? args.maxMessages
        : 20;
    const maxChars =
      typeof args.maxChars === 'number' && Number.isInteger(args.maxChars) ? args.maxChars : 20_000;
    const messages = Array.isArray(result.messages)
      ? result.messages.map((message) => {
          const item = message as Record<string, unknown>;
          const body = typeof item.text === 'string' ? item.text : '';
          return {
            ...item,
            ...(!Number.isInteger(item.sourceLength) && item.truncated !== true
              ? { sourceLength: body.length }
              : {}),
            ...(typeof item.truncated === 'boolean' ? {} : { truncated: false }),
          };
        })
      : [];
    const continuation = result.continuation ?? null;
    return {
      toolName,
      status: 'succeeded',
      args: {
        ...args,
        startMessageIndex: start,
        startMessageOffset: offset,
        maxMessages,
        maxChars,
      },
      result: {
        ...result,
        threadId: String(args.threadId ?? ''),
        hasMore: result.hasMore === true,
        messages,
        receipt: result.receipt ?? {
          version: 1,
          source: { kind: 'gmail-thread', id: String(args.threadId ?? '') },
          requested: { start, offset, limit: maxMessages, scope: 'thread-messages' },
          covered: {
            start,
            offset,
            end: start + messages.length,
            count: messages.length,
            total: start + messages.length,
            unavailable: 0,
          },
          complete: result.complete === true,
          losses:
            result.complete === true
              ? []
              : result.hasMore === true
                ? ['character-budget']
                : ['coverage-unknown'],
          continuation,
        },
      },
      fromCurrentTask: true,
    };
  }
  return { toolName, status: 'succeeded', args, result, fromCurrentTask: true };
}

function completeCalendarEvents(events: unknown[], read = request()): ReadToolEvidence {
  return row(
    'calendar.list_events',
    { timeMin: read.timeWindow?.timeMin, timeMax: read.timeWindow?.timeMax },
    {
      events,
      complete: true,
      calendarRosterComplete: true,
      unavailable: [],
    },
  );
}

function prefixCalendarEvents(
  events: unknown[],
  read = request(),
  overrides: Record<string, unknown> = {},
): ReadToolEvidence {
  return row(
    'calendar.list_events',
    { timeMin: read.timeWindow?.timeMin, timeMax: read.timeWindow?.timeMax },
    {
      events,
      complete: false,
      nextPageToken: 'calendar-cursor-next',
      chronologicalPrefixThrough: '2026-10-17T08:10:00.000Z',
      calendarsResolved: [{ id: 'primary', name: 'Baldvin' }],
      calendarsSearched: ['Baldvin'],
      calendarRosterComplete: true,
      unavailable: [],
      ...overrides,
    },
  );
}

function bookingEmailEvidence(
  options: { hotelBody?: string; hotelSubject?: string; includeFlight?: boolean } = {},
) {
  const read = request();
  const flightThread = 'flight-booking-thread';
  const hotelThread = 'hotel-reservation-thread';
  const results = [
    ...(options.includeFlight === false
      ? []
      : [{ threadId: flightThread, subject: 'Lufthansa booking confirmation' }]),
    { threadId: hotelThread, subject: options.hotelSubject ?? 'Hotel reservation confirmed' },
  ];
  const search = row(
    'gmail.search',
    { query: read.mailQuery },
    { results, complete: true, hasMore: false },
  );
  return [
    search,
    ...(options.includeFlight === false
      ? []
      : [
          row(
            'gmail.read_thread',
            { threadId: flightThread },
            {
              complete: true,
              messages: [
                {
                  messageId: 'flight-booking-message',
                  subject: 'Lufthansa booking confirmation LH 777',
                  text: 'Outbound\nFlight number: LH 777\nDeparture date: 2026-10-17\nDeparture time: 10:10 Europe/Berlin\nArrival date: 2026-10-17\nArrival time: 13:10 Europe/Berlin\nFrom: SFO\nTo: BER\nArrival airport: BER\nBooking reference: FLIGHT-728',
                },
              ],
            },
          ),
        ]),
    row(
      'gmail.read_thread',
      { threadId: hotelThread },
      {
        complete: true,
        messages: [
          {
            messageId: 'hotel-booking-message',
            subject: options.hotelSubject ?? 'Reservation confirmed: Hotel Linden, Berlin',
            text:
              options.hotelBody ??
              'Reservation confirmed: Hotel Linden, Berlin.\nDates: October 17–19, 2026.\nAddress: Linienstraße 89, 10119 Berlin.\nBooking reference: HOTEL-55123',
          },
        ],
      },
    ),
  ] as ReadToolEvidence[];
}

function addEmptyCompletedMailQueries(
  evidence: ReadToolEvidence[],
  read = request(),
): ReadToolEvidence[] {
  const present = new Set(
    evidence
      .filter((item) => item.toolName === 'gmail.search')
      .map((item) => String((item.args as Record<string, unknown> | undefined)?.query ?? '')),
  );
  return [
    ...evidence,
    ...(read.mailQueries ?? [])
      .filter((query) => !present.has(query.query))
      .map((query) =>
        row(
          'gmail.search',
          { query: query.query },
          { complete: true, hasMore: false, results: [] },
        ),
      ),
  ];
}

function calendarFlight(): Record<string, unknown> {
  return {
    eventId: 'calendar-flight-1',
    summary: 'Outbound flight LH 777 to Berlin',
    description: 'Arrival airport: BER. Booking reference: FLIGHT-728',
    location: 'Berlin Brandenburg Airport',
    start: '2026-10-17T10:10:00+02:00',
    timeZone: 'Europe/Berlin',
    status: 'confirmed',
    links: [{ type: 'calendar', url: 'https://www.google.com/calendar/event?eid=abc' }],
  };
}

describe('compound trip read projection', () => {
  it('keeps promotional lodging and non-flight confirmation hits behind actual bounded booking candidates', () => {
    const read = request();
    const flightQuery = read.mailQueries?.find((query) => query.category === 'flight')?.query;
    const lodgingQuery = read.mailQueries?.find((query) => query.category === 'lodging')?.query;
    if (!flightQuery || !lodgingQuery) throw new Error('Expected both search categories');
    const evidence = [
      row(
        'gmail.search',
        { query: flightQuery },
        {
          complete: true,
          results: [
            {
              threadId: 'billing-confirmation',
              subject: 'Reservation confirmation for a software subscription',
            },
            { threadId: 'flight-offers', subject: 'Flight booking trends and market news' },
            { threadId: 'outbound', subject: 'Flight booking confirmation' },
            { threadId: 'return', subject: 'Flight - BER to SFO' },
            { threadId: 'third-flight', subject: 'Flight ticket confirmation' },
          ],
        },
      ),
      row(
        'gmail.search',
        { query: lodgingQuery },
        {
          complete: true,
          results: [
            { threadId: 'hotel-trends', subject: 'Hotel booking trends' },
            { threadId: 'hotel-news', subject: 'Hotel booking market news' },
            { threadId: 'stay', subject: 'Airbnb reservation confirmed' },
            { threadId: 'another-stay', subject: 'Hotel booking receipt' },
          ],
        },
      ),
    ];
    expect(compoundTripThreadIdsToRead(evidence, read)).toEqual(['outbound', 'stay', 'return']);
    expect(compoundTripThreadIdsToRead(evidence, read)).toHaveLength(3);
  });

  it.each([
    'booked',
    'reserved',
    'confirmation',
    'check-in details',
    'booking details',
    'booking reference',
    'booking receipt',
    'booking number',
    'booking confirmation',
  ])(
    'accepts explicit lodging reservation evidence (%s) while rejecting bare booking chatter',
    (cue) => {
      const read = request();
      const query = read.mailQueries?.find((entry) => entry.category === 'lodging')?.query;
      const evidence = [
        row(
          'gmail.search',
          { query },
          {
            complete: true,
            results: [
              { threadId: 'generic', subject: 'Hotel booking advice and trends' },
              { threadId: 'source', subject: `Hotel ${cue}` },
            ],
          },
        ),
      ];
      expect(compoundTripThreadIdsToRead(evidence, read)).toEqual(['source']);
    },
  );

  it('counts only actual complete search-matched reads, including previously read thin-metadata hits', () => {
    const read = request();
    const query = read.mailQueries?.find((entry) => entry.category === 'flight')?.query;
    const search = row(
      'gmail.search',
      { query },
      { complete: true, results: [{ threadId: 'thin-a' }, { threadId: 'thin-b' }] },
    );
    const firstRead = row(
      'gmail.read_thread',
      { threadId: 'thin-a' },
      { complete: true, messages: [] },
    );
    const unrelatedRead = row(
      'gmail.read_thread',
      { threadId: 'not-searched' },
      { complete: true, messages: [] },
    );
    const previousTaskRead = {
      ...row('gmail.read_thread', { threadId: 'thin-b' }, { complete: true, messages: [] }),
      fromCurrentTask: false,
    };
    const partial = compoundTripReadProjection(read, [
      search,
      firstRead,
      unrelatedRead,
      previousTaskRead,
    ]);
    expect(compoundTripThreadIdsToRead([search], read)).toEqual([]);
    expect(partial.threadsComplete).toBe(false);
    expect(partial.text).toContain('1 matching email thread remains unread or incomplete');
    const completed = compoundTripReadProjection(read, [
      search,
      firstRead,
      row('gmail.read_thread', { threadId: 'thin-b' }, { complete: true, messages: [] }),
    ]);
    expect(completed.threadsComplete).toBe(true);
    expect(completed.text).not.toContain('remain unread');
    expect(completed.blocked).toBe(true);
    expect(completed.text).not.toContain('Next matched outbound flight');
  });

  it('keeps the prefix claim blocked when a booking search category is incomplete', () => {
    const read = request();
    const projection = upcomingFlightReadProjection(read, [
      prefixCalendarEvents([calendarFlight()], read),
      ...bookingEmailEvidence(),
    ]);

    expect(projection.gmailSearchComplete).toBe(false);
    expect(projection.calendarPrefixCompleteThroughCandidate).toBe(false);
    expect(projection.blocked).toBe(true);
    expect(projection.text).toContain('Booking-email search or reads were incomplete');
  });

  it('does not count a selected but partially read thread as completed coverage', () => {
    const read = request();
    const query = read.mailQueries?.find((entry) => entry.category === 'flight')?.query;
    const search = row(
      'gmail.search',
      { query },
      {
        complete: true,
        results: [{ threadId: 'selected', subject: 'Flight booking confirmation' }],
      },
    );
    const partialRead = row(
      'gmail.read_thread',
      { threadId: 'selected' },
      { complete: false, messages: [] },
    );
    const projection = compoundTripReadProjection(read, [search, partialRead]);
    expect(projection.threadsComplete).toBe(false);
    expect(projection.text).toContain('1 matching email thread remains unread or incomplete');
    expect(projection.text).not.toContain('I read the selected booking candidates');
  });

  it('preserves typed blocking for a calendar-only flight even when all reads completed and prose has no gap paragraph', () => {
    const read = detectPersonalReadRequest(
      [{ role: 'user', content: 'Find my next flight using booking emails and calendar.' }],
      {
        now: new Date('2026-10-13T18:00:00Z'),
        timeZone: 'America/Los_Angeles',
      },
    );
    if (!read?.upcomingFlightDiscovery || !read.mailQuery)
      throw new Error('Expected flight discovery');
    const evidence = [
      completeCalendarEvents(
        [{ eventId: 'candidate', summary: 'Flight to Lisbon', start: '2026-11-12T17:00:00Z' }],
        read,
      ),
      row(
        'gmail.search',
        { query: read.mailQuery },
        {
          complete: true,
          hasMore: false,
          results: [{ threadId: 'note', subject: 'Flight itinerary' }],
        },
      ),
      row('gmail.read_thread', { threadId: 'note' }, { complete: true, messages: [] }),
    ];
    const projection = upcomingFlightReadProjection(read, evidence);
    expect(projection.calendarComplete).toBe(true);
    expect(projection.gmailSearchComplete).toBe(true);
    expect(projection.threadsComplete).toBe(true);
    expect(projection.text).not.toContain('Needs confirmation:');
    expect(projection.text).toContain(
      'booking identity, flight number, and direction are unconfirmed',
    );
    expect(projection.blocked).toBe(true);
    expect(
      enforcePersonalReadResponse(
        read,
        evidence.map((item) => ({ ...item, result: item.result })),
      ),
    ).toMatchObject({
      text: projection.text,
      blocked: true,
    });
  });

  it('accepts a booking-matched flight proven earliest in a chronological calendar prefix', () => {
    const read = request();
    const projection = upcomingFlightReadProjection(
      read,
      addEmptyCompletedMailQueries(
        [prefixCalendarEvents([calendarFlight()], read), ...bookingEmailEvidence()],
        read,
      ),
    );

    expect(projection).toMatchObject({
      calendarComplete: false,
      calendarPrefixCompleteThroughCandidate: true,
      blocked: false,
    });
    expect(projection.flight?.segment).toMatchObject({ flightNumber: 'LH777' });
    expect(projection.text).toContain(
      'later dates in the requested 365-day window were not fully read',
    );
    expect(projection.text).toContain('[Booking email]');
  });

  it('rejects a prefix marker later than every event actually returned', () => {
    const read = request();
    const projection = upcomingFlightReadProjection(
      read,
      addEmptyCompletedMailQueries(
        [
          prefixCalendarEvents([calendarFlight()], read, {
            chronologicalPrefixThrough: '2026-12-01T00:00:00.000Z',
          }),
          ...bookingEmailEvidence(),
        ],
        read,
      ),
    );

    expect(projection.calendarPrefixCompleteThroughCandidate).toBe(false);
    expect(projection.blocked).toBe(true);
  });

  it('requires every continuation page to report the exact resolved calendar roster', () => {
    const read = request();
    const range = { timeMin: read.timeWindow?.timeMin, timeMax: read.timeWindow?.timeMax };
    const first = prefixCalendarEvents([calendarFlight()], read);
    const second = row(
      'calendar.list_events',
      { ...range, pageToken: 'calendar-cursor-next' },
      {
        events: [
          {
            eventId: 'lookahead',
            calendarId: 'primary',
            start: '2026-10-17T09:10:00.000Z',
          },
        ],
        complete: true,
        chronologicalPrefixThrough: '2026-10-17T09:10:00.000Z',
        calendarsResolved: [{ id: 'primary', name: 'Baldvin' }],
        calendarsSearched: [],
        calendarRosterComplete: true,
        unavailable: [],
      },
    );
    const projection = upcomingFlightReadProjection(
      read,
      addEmptyCompletedMailQueries([first, second, ...bookingEmailEvidence()], read),
    );

    expect(projection.calendarPrefixCompleteThroughCandidate).toBe(false);
  });

  it('blocks an earlier all-day flight-like event because it has no departure time', () => {
    const read = request();
    const earlierAllDay = {
      eventId: 'all-day-flight-note',
      summary: 'United flight itinerary',
      start: '2026-10-16',
      end: '2026-10-17',
      allDay: true,
      timeZone: 'America/Los_Angeles',
      status: 'confirmed',
    };
    const projection = upcomingFlightReadProjection(
      read,
      addEmptyCompletedMailQueries(
        [prefixCalendarEvents([earlierAllDay, calendarFlight()], read), ...bookingEmailEvidence()],
        read,
      ),
    );

    expect(projection.calendarPrefixCompleteThroughCandidate).toBe(false);
    expect(projection.blocked).toBe(true);
    expect(projection.text).toContain('earlier all-day calendar flight candidate');
  });

  it('blocks an earlier offsetless timed flight even when its calendar timezone is known', () => {
    const read = request();
    const earlierOffsetlessFlight = {
      eventId: 'offsetless-earlier-flight',
      summary: 'Outbound flight LH 201 to London',
      start: '2026-10-17T08:00:00',
      startTimeZone: 'Europe/Berlin',
      calendarTimeZone: 'Europe/Berlin',
      status: 'confirmed',
    };
    const projection = upcomingFlightReadProjection(
      read,
      addEmptyCompletedMailQueries(
        [
          prefixCalendarEvents([earlierOffsetlessFlight, calendarFlight()], read),
          ...bookingEmailEvidence(),
        ],
        read,
      ),
    );

    expect(projection.calendarPrefixCompleteThroughCandidate).toBe(false);
    expect(projection.blocked).toBe(true);
    expect(projection.text).toContain('no explicit time-zone offset');
  });

  it.each([
    ['unavailable calendar', { unavailable: [{ calendar: 'Work', reason: 'forbidden' }] }],
    ['incomplete roster', { calendarRosterComplete: false }],
    [
      'unsearched resolved calendar',
      {
        calendarsResolved: [
          { id: 'primary', name: 'Baldvin' },
          { id: 'work', name: 'Work' },
        ],
      },
    ],
  ])('keeps the prefix claim blocked for %s', (_label, overrides) => {
    const read = request();
    const projection = upcomingFlightReadProjection(
      read,
      addEmptyCompletedMailQueries(
        [prefixCalendarEvents([calendarFlight()], read, overrides), ...bookingEmailEvidence()],
        read,
      ),
    );

    expect(projection.calendarPrefixCompleteThroughCandidate).toBe(false);
    expect(projection.blocked).toBe(true);
    expect(projection.text).toContain('Calendar search coverage is incomplete');
  });

  it('does not infer a prefix across a discontinuous calendar cursor', () => {
    const read = request();
    const first = prefixCalendarEvents([calendarFlight()], read);
    const second = row(
      'calendar.list_events',
      {
        timeMin: read.timeWindow?.timeMin,
        timeMax: read.timeWindow?.timeMax,
        pageToken: 'wrong-cursor',
      },
      {
        events: [],
        complete: false,
        nextPageToken: 'calendar-cursor-third',
        chronologicalPrefixThrough: '2026-10-17T08:10:00.000Z',
        calendarsResolved: [{ id: 'primary', name: 'Baldvin' }],
        calendarsSearched: ['Baldvin'],
        calendarRosterComplete: true,
        unavailable: [],
      },
    );
    const projection = upcomingFlightReadProjection(
      read,
      addEmptyCompletedMailQueries([first, second, ...bookingEmailEvidence()], read),
    );

    expect(projection.calendarPrefixCompleteThroughCandidate).toBe(false);
    expect(projection.blocked).toBe(true);
  });

  it('compares the full opaque calendar cursor when tokens share a long prefix', () => {
    const read = request();
    const range = { timeMin: read.timeWindow?.timeMin, timeMax: read.timeWindow?.timeMax };
    const commonPrefix = 'c'.repeat(5_000);
    const expectedCursor = `${commonPrefix}expected-tail`;
    const suppliedCursor = `${commonPrefix}different-tail`;
    const first = prefixCalendarEvents([calendarFlight()], read, {
      nextPageToken: expectedCursor,
    });
    const second = row(
      'calendar.list_events',
      { ...range, pageToken: suppliedCursor },
      {
        events: [
          {
            eventId: 'lookahead',
            calendarId: 'primary',
            start: '2026-10-17T09:10:00.000Z',
          },
        ],
        complete: true,
        chronologicalPrefixThrough: '2026-10-17T09:10:00.000Z',
        calendarsResolved: [{ id: 'primary', name: 'Baldvin' }],
        calendarsSearched: ['Baldvin'],
        calendarRosterComplete: true,
        unavailable: [],
      },
    );
    const projection = upcomingFlightReadProjection(
      read,
      addEmptyCompletedMailQueries([first, second, ...bookingEmailEvidence()], read),
    );

    expect(expectedCursor.slice(0, 4_096)).toBe(suppliedCursor.slice(0, 4_096));
    expect(expectedCursor).not.toBe(suppliedCursor);
    expect(projection.calendarPrefixCompleteThroughCandidate).toBe(false);
  });

  it('does not skip an earlier unmatched calendar flight inside the covered prefix', () => {
    const read = request();
    const earlier = {
      eventId: 'earlier-unmatched',
      summary: 'Outbound flight LH 201 to London',
      start: '2026-10-16T09:00:00+02:00',
      timeZone: 'Europe/Berlin',
      status: 'confirmed',
    };
    const projection = upcomingFlightReadProjection(
      read,
      addEmptyCompletedMailQueries(
        [prefixCalendarEvents([earlier, calendarFlight()], read), ...bookingEmailEvidence()],
        read,
      ),
    );

    expect(projection.calendarPrefixCompleteThroughCandidate).toBe(false);
    expect(projection.blocked).toBe(true);
    expect(projection.text).toContain('Calendar search coverage is incomplete');
  });

  it('accepts three consecutive bounded calendar pages while preserving an incomplete roster gap', () => {
    const read = request();
    const range = { timeMin: read.timeWindow?.timeMin, timeMax: read.timeWindow?.timeMax };
    const pages = [
      row('calendar.list_events', range, {
        events: [],
        complete: false,
        nextPageToken: 'page-2',
        calendarRosterComplete: true,
        unavailable: [],
      }),
      row(
        'calendar.list_events',
        { ...range, pageToken: 'page-2' },
        {
          events: [],
          complete: false,
          nextPageToken: 'page-3',
          calendarRosterComplete: true,
          unavailable: [],
        },
      ),
      row(
        'calendar.list_events',
        { ...range, pageToken: 'page-3' },
        {
          events: [],
          complete: true,
          calendarRosterComplete: false,
          unavailable: ['calendar-unavailable'],
        },
      ),
    ];
    const projection = compoundTripReadProjection(read, pages);
    expect(projection.calendarComplete).toBe(false);
    expect(projection.text).toContain('Calendar coverage is incomplete');

    const completePages = pages.map((page, index) =>
      index === 2
        ? {
            ...page,
            result: {
              ...(page.result as Record<string, unknown>),
              complete: true,
              calendarRosterComplete: true,
              unavailable: [],
            },
          }
        : page,
    );
    expect(compoundTripReadProjection(read, completePages).calendarComplete).toBe(true);
    const firstPage = pages[0];
    const thirdPage = pages[2];
    if (!firstPage || !thirdPage) throw new Error('Expected three calendar pages');
    expect(compoundTripReadProjection(read, [firstPage, thirdPage]).calendarComplete).toBe(false);
  });

  it('bounds new reads to selected candidates while keeping unread search hits incomplete', () => {
    const read = request();
    const [flightQuery, lodgingQuery] = read.mailQueries ?? [];
    if (!flightQuery || !lodgingQuery) throw new Error('Expected typed flight and lodging queries');
    const evidence = [
      row(
        'gmail.search',
        { query: flightQuery.query },
        {
          results: [
            { threadId: 'next-flight', subject: 'Flight booking confirmation' },
            { threadId: 'return-itinerary', subject: 'Airline itinerary confirmation' },
            { threadId: 'unread-flight', subject: 'Flight reservation confirmation' },
          ],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.search',
        { query: lodgingQuery.query },
        {
          results: [{ threadId: 'hotel-booking', subject: 'Hotel reservation confirmation' }],
          complete: true,
          hasMore: false,
        },
      ),
      ...['next-flight', 'hotel-booking', 'return-itinerary'].map((threadId) =>
        row('gmail.read_thread', { threadId }, { complete: true, messages: [] }),
      ),
    ];
    expect(compoundTripThreadIdsToRead(evidence, read)).toEqual([
      'next-flight',
      'hotel-booking',
      'return-itinerary',
    ]);
    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.threadsComplete).toBe(false);
    expect(projection.text).toContain('1 matching email thread remains unread or incomplete');
  });

  it('keeps an exact dated hotel reservation visible when calendar coverage is partial', () => {
    const read = request();
    const flightQuery = read.mailQueries?.find((query) => query.category === 'flight');
    const lodgingQuery = read.mailQueries?.find((query) => query.category === 'lodging');
    if (!flightQuery || !lodgingQuery)
      throw new Error('Expected typed flight and lodging searches');
    const flightEvent = {
      ...calendarFlight(),
      start: '2026-10-16T10:10:00+02:00',
    };
    const evidence = [
      row(
        'calendar.list_events',
        { timeMin: read.timeWindow?.timeMin, timeMax: read.timeWindow?.timeMax },
        {
          events: [flightEvent],
          complete: false,
          nextPageToken: 'later-calendar-page',
          calendarRosterComplete: true,
          unavailable: [],
        },
      ),
      row(
        'gmail.search',
        { query: flightQuery.query },
        {
          results: [{ threadId: 'flight-source', subject: 'Lufthansa booking confirmation' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.search',
        { query: lodgingQuery.query },
        {
          results: [{ threadId: 'hotel-source', subject: 'Hotel reservation confirmation' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.read_thread',
        { threadId: 'flight-source' },
        {
          complete: true,
          messages: [
            {
              messageId: 'flight-message',
              subject: 'Lufthansa booking confirmation LH777',
              text: 'Outbound\nFlight number: LH777\nDeparture date: 2026-10-16\nDeparture time: 10:10 Europe/Berlin\nArrival date: 2026-10-16\nArrival time: 13:10 Europe/Berlin\nFrom: SFO\nTo: BER\nArrival airport: BER\nBooking reference: FLIGHT-728',
            },
          ],
        },
      ),
      row(
        'gmail.read_thread',
        { threadId: 'hotel-source' },
        {
          complete: true,
          messages: [
            {
              messageId: 'hotel-message',
              subject: 'Hotel reservation confirmation',
              text: 'Reservation confirmed: NH Collection Berlin Mitte, Berlin.\nDates: October 10–17, 2026.\nAddress: Leipziger Straße 10, 10117 Berlin.\nBooking reference: HOTEL-55123',
            },
          ],
        },
      ),
    ];
    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.calendarComplete).toBe(false);
    expect(
      projection.readThreads.map((thread) => (thread.args as { threadId?: string }).threadId),
    ).toContain('hotel-source');
    expect(projection.text).toContain(
      'Dated hotel reservation observed separately from the selected flight',
    );
    expect(projection.text).toContain('2026-10-10 to 2026-10-17');
    expect(projection.text).toContain('https://mail.google.com/mail/u/0/#all/hotel-source');
    expect(projection.routeOrigin).toBeUndefined();
    expect(projection.webQuery).toBeUndefined();
  });

  it('projects a verified next flight without requiring hotel or ground-transport sources', () => {
    const flightRequest = detectPersonalReadRequest(
      [{ role: 'user', content: 'Find my next future flight using booking emails and calendar.' }],
      { now: new Date('2026-10-13T18:00:00.000Z'), timeZone: 'America/Los_Angeles' },
    );
    if (!flightRequest?.upcomingFlightDiscovery || !flightRequest.mailQuery)
      throw new Error('Expected flight-only discovery');
    const threadId = 'flight-only-booking';
    const bookingText =
      'Outbound flight LH 777 from SFO to BER. Departure 17 October 2026 10:10 Europe/Berlin. Arrival 17 October 2026 13:10 Europe/Berlin. Booking reference FLIGHT-728.';
    const evidence = [
      completeCalendarEvents([calendarFlight()], flightRequest),
      row(
        'gmail.search',
        { query: flightRequest.mailQuery },
        {
          results: [{ threadId, subject: 'Lufthansa flight booking confirmation' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.read_thread',
        { threadId },
        {
          complete: true,
          messages: [
            {
              messageId: 'flight-only-message',
              subject: 'Flight booking confirmation',
              text: bookingText,
            },
          ],
        },
      ),
    ];
    const extracted = {
      status: 'complete' as const,
      segments: [
        {
          threadId,
          messageId: 'flight-only-message',
          subject: 'Flight booking confirmation',
          bookingReference: 'FLIGHT-728',
          flightNumber: 'LH777',
          departureDate: '2026-10-17',
          departureTime: '10:10',
          departureTimeZone: 'Europe/Berlin',
          arrivalDate: '2026-10-17',
          arrivalTime: '13:10',
          arrivalTimeZone: 'Europe/Berlin',
          originAirport: 'SFO',
          destinationAirport: 'BER',
          direction: 'outbound' as const,
          excerpt: bookingText,
        },
      ],
      hotels: [],
      rejectedFacts: 0,
      sourceMessageIds: ['flight-only-message'],
    };
    const projection = upcomingFlightReadProjection(flightRequest, evidence, extracted);
    expect(projection.flight?.segment?.flightNumber).toBe('LH777');
    expect(projection.text).toContain('Next matched outbound flight');
    expect(projection.text).toContain('[Calendar]');
    expect(projection.text).toContain('[Booking email]');
    expect(projection.text).not.toMatch(/hotel|taxi|public.transport/i);
  });

  it('keeps a dated calendar flight candidate when the booking date is yearless', () => {
    const flightRequest = detectPersonalReadRequest(
      [
        {
          role: 'user',
          content:
            'Find my next upcoming flight using booking emails and calendar. Confirm its departure date and time zone.',
        },
      ],
      { now: new Date('2026-10-09T12:00:00.000Z'), timeZone: 'America/Los_Angeles' },
    );
    if (!flightRequest?.upcomingFlightDiscovery || !flightRequest.mailQuery)
      throw new Error('Expected flight-only discovery');
    const threadId = 'yearless-berlin-booking';
    const event = {
      eventId: 'yearless-berlin-flight',
      summary: 'Flight to Berlin (United)',
      start: '2026-11-12T14:00:00Z',
      links: [{ type: 'calendar', url: 'https://www.google.com/calendar/event?eid=yearless' }],
    };
    const evidence = [
      completeCalendarEvents([event], flightRequest),
      row(
        'gmail.search',
        { query: flightRequest.mailQuery },
        {
          results: [{ threadId, subject: 'Berlin booking confirmation' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.read_thread',
        { threadId },
        {
          complete: true,
          messages: [
            {
              messageId: 'yearless-booking-message',
              subject: 'Berlin booking confirmation',
              text: 'Berlin flight booking confirmation.\nDeparture\nNovember 12 at 7:30 AM.',
            },
          ],
        },
      ),
    ];

    const projection = upcomingFlightReadProjection(flightRequest, evidence, {
      status: 'complete',
      segments: [],
      hotels: [],
      rejectedFacts: 1,
      sourceMessageIds: ['yearless-booking-message'],
    });

    expect(projection.flight).toBeUndefined();
    expect(projection.calendarCandidate?.event.summary).toBe('Flight to Berlin (United)');
    expect(projection.text).toContain(
      'Next future calendar flight candidate: Flight to Berlin (United)',
    );
    expect(projection.text).toContain('calendar date 2026-11-12');
    expect(projection.text).toContain('calendar time in America/Los_Angeles');
    expect(projection.text).toContain('[Calendar source]');
    expect(projection.text).toContain(
      'booking identity, flight number, and direction are unconfirmed',
    );
    expect(projection.text).toContain(
      '[Calendar source](https://www.google.com/calendar/event?eid=yearless)',
    );
    expect(projection.text).not.toContain('\\(United\\)');
    expect(projection.text).not.toContain('7:30 AM');
    expect(projection.text).not.toContain('2026-11-12 7:30');
    expect(projection.text).not.toMatch(/hotel|taxi|public.transport|conflict/i);
    expect(projection.blocked).toBe(true);
  });

  it('selects the earliest matched future flight when a current-trip return precedes a later outbound', () => {
    const read = request();
    const events = [
      {
        eventId: 'future-return',
        summary: 'Return flight LH 777',
        description: 'Return flight. Booking reference: CURRENT-TRIP',
        start: '2026-10-16T14:10:00+02:00',
      },
      {
        eventId: 'later-outbound',
        summary: 'Outbound flight KL 606',
        description: 'Outbound flight. Booking reference: NEXT-TRIP',
        start: '2026-10-22T10:00:00-07:00',
      },
      {
        eventId: 'later-return',
        summary: 'Return flight KL 607',
        description: 'Return flight. Booking reference: NEXT-TRIP',
        start: '2026-10-29T12:00:00+02:00',
      },
    ];
    const evidence: ReadToolEvidence[] = [
      completeCalendarEvents(events),
      row(
        'gmail.search',
        { query: read.mailQuery },
        {
          results: [{ threadId: 'two-trips', subject: 'Flight itineraries' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.read_thread',
        { threadId: 'two-trips' },
        {
          complete: true,
          messages: [
            {
              messageId: 'two-trips-message',
              subject: 'Flight itineraries',
              text: 'Return flight LH 777, 2026-10-16 at 14:10 Europe/Berlin from BER to SFO. Booking reference: CURRENT-TRIP.\nOutbound flight KL 606, 2026-10-22 at 10:00 America/Los_Angeles from SFO to AMS. Booking reference: NEXT-TRIP.\nReturn flight KL 607, 2026-10-29 at 12:00 Europe/Amsterdam from AMS to SFO. Booking reference: NEXT-TRIP.',
            },
          ],
        },
      ),
    ];
    const extracted = {
      status: 'complete' as const,
      segments: [
        {
          threadId: 'two-trips',
          messageId: 'two-trips-message',
          subject: 'Flight itineraries',
          flightNumber: 'LH777',
          direction: 'return' as const,
          departureDate: '2026-10-16',
          departureTime: '14:10',
          departureTimeZone: 'Europe/Berlin',
          originAirport: 'BER',
          destinationAirport: 'SFO',
          bookingReference: 'CURRENT-TRIP',
          excerpt:
            'Return flight LH 777, 2026-10-16 at 14:10 Europe/Berlin from BER to SFO. Booking reference: CURRENT-TRIP.',
        },
        {
          threadId: 'two-trips',
          messageId: 'two-trips-message',
          subject: 'Flight itineraries',
          flightNumber: 'KL606',
          direction: 'outbound' as const,
          departureDate: '2026-10-22',
          departureTime: '10:00',
          departureTimeZone: 'America/Los_Angeles',
          originAirport: 'SFO',
          destinationAirport: 'AMS',
          bookingReference: 'NEXT-TRIP',
          excerpt:
            'Outbound flight KL 606, 2026-10-22 at 10:00 America/Los_Angeles from SFO to AMS. Booking reference: NEXT-TRIP.',
        },
        {
          threadId: 'two-trips',
          messageId: 'two-trips-message',
          subject: 'Flight itineraries',
          flightNumber: 'KL607',
          direction: 'return' as const,
          departureDate: '2026-10-29',
          departureTime: '12:00',
          departureTimeZone: 'Europe/Amsterdam',
          originAirport: 'AMS',
          destinationAirport: 'SFO',
          bookingReference: 'NEXT-TRIP',
          excerpt:
            'Return flight KL 607, 2026-10-29 at 12:00 Europe/Amsterdam from AMS to SFO. Booking reference: NEXT-TRIP.',
        },
      ],
      hotels: [],
      rejectedFacts: 0,
      sourceMessageIds: ['two-trips-message'],
    };

    const projection = upcomingFlightReadProjection(read, evidence, extracted);

    expect(projection.flight?.segment).toMatchObject({
      flightNumber: 'LH777',
      direction: 'return',
      departureDate: '2026-10-16',
    });
    expect(projection.text).toContain('Next matched future return flight');
    expect(projection.text).not.toContain('KL606');
    expect(projection.text).not.toContain('KL607');
    expect(projection.text).not.toContain('Booked return flight');
    expect(projection.text).not.toMatch(/hotel|taxi|public transport/i);
  });

  it('does not present a departed calendar flight as a future candidate', () => {
    const base = request();
    const read = {
      ...base,
      timeWindow: {
        timeMin: '2026-10-17T12:00:00.000Z',
        timeMax: '2027-10-17T12:00:00.000Z',
        label: 'next year',
      },
    };
    const projection = upcomingFlightReadProjection(read, [
      completeCalendarEvents(
        [
          {
            eventId: 'departed-flight',
            summary: 'Flight to Berlin',
            start: '2026-10-16T14:10:00+02:00',
          },
        ],
        read,
      ),
    ]);

    expect(projection.calendarCandidate).toBeUndefined();
    expect(projection.flight).toBeUndefined();
    expect(projection.text).not.toContain('Flight to Berlin');
    expect(projection.text).toContain('could not identify a dated future flight candidate');
  });

  it('does not choose between calendar flight candidates with the same departure instant', () => {
    const read = request();
    const projection = upcomingFlightReadProjection(read, [
      completeCalendarEvents([
        { eventId: 'flight-a', summary: 'Flight to Berlin', start: '2026-10-20T14:10:00Z' },
        { eventId: 'flight-b', summary: 'Flight to Berlin', start: '2026-10-20T14:10:00Z' },
      ]),
    ]);

    expect(projection.calendarCandidate).toBeUndefined();
    expect(projection.text).toContain('same departure instant');
    expect(projection.text).toContain('could not identify one unambiguous next flight');
  });

  it('does not promote a return segment whose quote or message is not bound to current complete sources', () => {
    const read = request();
    const quote =
      'Return flight LH 777, 2026-10-16 at 14:10 Europe/Berlin. Booking reference: CURRENT-TRIP.';
    const evidence: ReadToolEvidence[] = [
      completeCalendarEvents([
        {
          eventId: 'current-return',
          summary: 'Return flight to San Francisco',
          description: 'Return flight. Booking reference: CURRENT-TRIP',
          start: '2026-10-16T14:10:00+02:00',
        },
      ]),
      row(
        'gmail.search',
        { query: read.mailQuery },
        {
          results: [{ threadId: 'current-itinerary', subject: 'Itinerary' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.read_thread',
        { threadId: 'current-itinerary' },
        {
          complete: true,
          messages: [
            {
              messageId: 'current-message',
              subject: 'Itinerary',
              text: 'The itinerary has no dated flight details in this message.',
            },
          ],
        },
      ),
    ];
    const forgedSegment = {
      threadId: 'stale-itinerary',
      messageId: 'stale-message',
      subject: 'Old itinerary',
      flightNumber: 'LH777',
      direction: 'return' as const,
      departureDate: '2026-10-16',
      departureTime: '14:10',
      departureTimeZone: 'Europe/Berlin',
      originAirport: 'BER',
      destinationAirport: 'SFO',
      bookingReference: 'CURRENT-TRIP',
      excerpt: quote,
    };
    const mismatchedSegment = {
      ...forgedSegment,
      threadId: 'current-itinerary',
      messageId: 'current-message',
      departureDate: '2026-10-22',
    };
    const projection = upcomingFlightReadProjection(read, evidence, {
      status: 'complete',
      segments: [forgedSegment, mismatchedSegment],
      hotels: [],
      rejectedFacts: 0,
      sourceMessageIds: ['stale-message', 'current-message'],
    });

    expect(projection.flight).toBeUndefined();
    expect(projection.calendarCandidate?.event.eventId).toBe('current-return');
    expect(projection.text).toContain(
      'booking identity, flight number, and direction are unconfirmed',
    );
    expect(projection.text).not.toContain('[Booking email]');
    expect(projection.text).not.toContain('LH777');
  });

  it('keeps the earliest unmatched future return booking separate from a different calendar flight', () => {
    const read = request();
    const firstQuote =
      'Return flight LH 777, 2026-10-16 at 14:10 Europe/Berlin from BER to SFO. Booking reference: RETURN-ONE.';
    const laterQuote =
      'Return flight LH 888, 2026-10-30 at 12:00 Europe/Berlin from BER to SFO. Booking reference: RETURN-TWO.';
    const evidence: ReadToolEvidence[] = [
      completeCalendarEvents([
        {
          eventId: 'different-calendar-flight',
          summary: 'Return flight UA 999',
          description: 'Booking reference: CALENDAR-BOOKING',
          start: '2026-10-16T14:10:00+02:00',
          links: [{ type: 'calendar', url: 'https://calendar.google.com/calendar/event?eid=diff' }],
        },
      ]),
      row(
        'gmail.search',
        { query: read.mailQuery },
        {
          results: [{ threadId: 'return-bookings', subject: 'Airline returns' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.read_thread',
        { threadId: 'return-bookings' },
        {
          complete: true,
          messages: [
            {
              messageId: 'return-bookings-message',
              subject: 'Airline returns',
              text: `${firstQuote}\n${laterQuote}`,
            },
          ],
        },
      ),
    ];
    const projection = upcomingFlightReadProjection(read, evidence, {
      status: 'complete',
      segments: [
        {
          threadId: 'return-bookings',
          messageId: 'return-bookings-message',
          subject: 'Airline returns',
          flightNumber: 'LH777',
          direction: 'return',
          departureDate: '2026-10-16',
          departureTime: '14:10',
          departureTimeZone: 'Europe/Berlin',
          originAirport: 'BER',
          destinationAirport: 'SFO',
          bookingReference: 'RETURN-ONE',
          excerpt: firstQuote,
        },
        {
          threadId: 'return-bookings',
          messageId: 'return-bookings-message',
          subject: 'Airline returns',
          flightNumber: 'LH888',
          direction: 'return',
          departureDate: '2026-10-30',
          departureTime: '12:00',
          departureTimeZone: 'Europe/Berlin',
          originAirport: 'BER',
          destinationAirport: 'SFO',
          bookingReference: 'RETURN-TWO',
          excerpt: laterQuote,
        },
      ],
      hotels: [],
      rejectedFacts: 0,
      sourceMessageIds: ['return-bookings-message'],
    });

    expect(projection.calendarCandidate?.event.eventId).toBe('different-calendar-flight');
    expect(projection.text).toContain('Return flight UA 999');
    expect(projection.text).toContain('Separate future booking candidate: LH777 BER→SFO');
    expect(projection.text).toContain('2026-10-16 14:10 Europe/Berlin');
    expect(projection.text).toContain('[Booking email]');
    expect(projection.text).toContain(
      'could not confirm whether the sources describe the same flight',
    );
    expect(projection.text).not.toContain('LH888');
    expect(projection.text).not.toContain('a confirmed conflict');
  });

  it('keeps independent flight and hotel bookings as candidates and attempts only grounded endpoint reads', () => {
    const read = request();
    const evidence: ReadToolEvidence[] = [
      completeCalendarEvents([
        calendarFlight(),
        {
          eventId: 'calendar-lodging-date-city',
          summary: 'Northstar Collection',
          description: 'Hotel stay on the destination calendar.',
          location: 'Berlin, Germany',
          start: { date: '2026-10-17' },
          end: { date: '2026-10-19' },
          status: 'confirmed',
          links: [{ type: 'calendar', url: 'https://calendar.google.com/calendar/event?eid=stay' }],
        },
      ]),
      ...bookingEmailEvidence(),
      row(
        'maps.directions',
        {
          origin: 'BER Airport',
          destination: 'Linienstraße 89, 10119 Berlin',
          mode: 'driving',
        },
        { durationSeconds: 1500 },
      ),
    ];
    const route = compoundTripRoute(read, evidence);
    expect(route).toEqual({
      origin: 'BER Airport',
      destination: 'Linienstraße 89, 10119 Berlin',
    });

    const webQuery = compoundTripReadProjection(read, evidence).webQuery;
    expect(webQuery).toContain('BER');
    expect(webQuery).toContain('Hotel Linden');
    expect(webQuery).toContain('Berlin');

    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.hotel?.association).toBe('date_city_candidate');
    expect(projection.calendarLodgingObservation).toMatchObject({
      title: 'Northstar Collection',
      association: 'date_city_candidate',
      city: 'Berlin',
    });
    expect(projection.text).toContain('Separately sourced hotel candidate: Hotel Linden, Berlin');
    expect(projection.text).toContain('treated the connection as an inference');
    expect(projection.text).toContain('departs 2026-10-17 10:10 Europe/Berlin');
    expect(projection.text).toContain('calendar source offset +02:00');
    expect(projection.text).toContain('[Calendar source]');
    expect(projection.text).toContain('[dated booking-thread source]');
    expect(projection.text).toContain('[Booking email]');
    expect(projection.text).toContain('no separately identified connecting leg');
    expect(projection.text).toContain('not a taxi quote');
    expect(projection.blocked).toBe(true);
    expect(projection.text).not.toContain('Calendar observations —');
  });

  it('accepts common stay-date summaries but does not infer a street address or route from a city alone', () => {
    const read = request();
    const evidence = [
      completeCalendarEvents([calendarFlight()]),
      ...bookingEmailEvidence({
        hotelBody: 'Reservation confirmed: Hotel Linden, Berlin. Dates: October 17–19, 2026.',
      }),
    ];
    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.hotel).toMatchObject({
      hotelName: 'Hotel Linden',
      city: 'Berlin',
      checkIn: '2026-10-17',
      checkOut: '2026-10-19',
    });
    expect(projection.hotel?.address).toBeUndefined();
    expect(compoundTripRoute(read, evidence)).toBeUndefined();
    expect(projection.text).toContain('did not include an explicit address');
  });

  it('does not associate or route a different-city or nonoverlapping hotel candidate', () => {
    const read = request();
    const evidence = [
      completeCalendarEvents([calendarFlight()]),
      ...bookingEmailEvidence({
        hotelBody:
          'Reservation confirmed: Hotel Linden, Prague.\nDates: October 20–22, 2026.\nAddress: Vinohradská 12, 120 00 Prague.',
      }),
    ];
    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.hotel).toBeUndefined();
    expect(projection.text).not.toContain('Hotel Linden');
    expect(compoundTripRoute(read, evidence)).toBeUndefined();
  });

  it('does not use an unrelated historical thread or another task receipt as booking evidence', () => {
    const read = request();
    const current = bookingEmailEvidence();
    const stale = row(
      'gmail.read_thread',
      { threadId: 'old-thread' },
      {
        complete: true,
        messages: [
          {
            subject: 'Old flight and hotel reservation',
            text: 'Flight LH 777, Hotel Linden, Berlin. Dates: October 16–18, 2026. Address: Linienstraße 89, 10119 Berlin.',
          },
        ],
      },
    );
    const historical = { ...stale, fromCurrentTask: false };
    const evidence = [completeCalendarEvents([calendarFlight()]), ...current, historical];
    expect(compoundTripReadProjection(read, evidence).readThreads).not.toContain(historical);
    expect(compoundTripReadProjection(read, evidence).hotel?.threadId).toBe(
      'hotel-reservation-thread',
    );
  });

  it('shows exact flight and hotel facts from partial email reads without linking them into a trip', () => {
    const read = request();
    const flightThread = 'partial-flight-thread';
    const hotelThread = 'partial-hotel-thread';
    const search = row(
      'gmail.search',
      { query: read.mailQuery, maxResults: 20 },
      {
        results: [
          { threadId: flightThread, subject: 'Flight booking details' },
          { threadId: hotelThread, subject: 'Hotel reservation details' },
        ],
        complete: false,
        hasMore: true,
        nextPageToken: 'next-search-page',
        continuation: {
          tool: 'gmail.search',
          input: {
            query: read.mailQuery,
            maxResults: 20,
            pageToken: 'next-search-page',
          },
        },
      },
    );
    const partialFlight = row(
      'gmail.read_thread',
      { threadId: flightThread },
      {
        complete: false,
        hasMore: true,
        messages: [
          {
            messageId: 'partial-flight-message',
            subject: 'Flight booking details',
            text: 'Outbound flight\nFlight number: LX 102\nDeparture date: 2026-10-17\nDeparture time: 10:10 Europe/Zurich\nFrom: ZRH\nTo: SFO',
          },
        ],
      },
    );
    const partialHotel = row(
      'gmail.read_thread',
      { threadId: hotelThread },
      {
        complete: false,
        hasMore: true,
        messages: [
          {
            messageId: 'partial-hotel-message',
            subject: 'Hotel reservation details',
            text: 'Hotel reservation: Alpine House, Zurich\nCheck-in: 2026-10-17\nCheck-out: 2026-10-19',
          },
        ],
      },
    );
    const incompleteCalendar = row(
      'calendar.list_events',
      { timeMin: read.timeWindow?.timeMin, timeMax: read.timeWindow?.timeMax },
      {
        events: [],
        complete: false,
        calendarRosterComplete: false,
        unavailable: [],
      },
    );
    const evidence = [incompleteCalendar, search, partialFlight, partialHotel];
    const projection = compoundTripReadProjection(read, evidence);

    expect(projection.readThreads).toHaveLength(2);
    expect(projection.blocked).toBe(true);
    expect(projection.flight).toBeUndefined();
    expect(projection.hotel).toBeUndefined();
    expect(projection.routeOrigin).toBeUndefined();
    expect(projection.webQuery).toBeUndefined();
    expect(projection.text).toContain('Partial source details, kept separate');
    expect(projection.text).toContain('LX102 ZRH→SFO; departs 2026-10-17 10:10 Europe/Zurich');
    expect(projection.text).toContain(
      '[Email source](https://mail.google.com/mail/u/0/#all/partial-flight-thread)',
    );
    expect(projection.text).toContain(
      '(Zurich; 2026-10-17 to 2026-10-19); the reservation is not verified or linked to a flight: Hotel Alpine House',
    );
    expect(projection.text).toContain(
      '[Email source](https://mail.google.com/mail/u/0/#all/partial-hotel-thread)',
    );
    expect(projection.text).toContain('not verified as a booking, the next trip, or a match');
    expect(projection.text).toContain('the reservation is not verified or linked to a flight');
    expect(projection.text).toContain('A hotel candidate appears in a partially read email');
    expect(projection.text).not.toContain(
      'I could not identify one hotel booking candidate in the checked email threads',
    );
    expect(projection.text).not.toContain('Dated outbound leg:');
    expect(projection.text).not.toContain('your next trip is');
  });

  it('does not claim booking threads were checked when the email search results were never read', () => {
    const read = request();
    const evidence = [
      completeCalendarEvents([calendarFlight()]),
      row(
        'gmail.search',
        { query: read.mailQuery },
        {
          results: [{ threadId: 'unread-hotel-booking', subject: 'Hotel reservation details' }],
          complete: true,
          hasMore: false,
        },
      ),
    ];

    const projection = compoundTripReadProjection(read, evidence);

    expect(projection.threadsComplete).toBe(false);
    expect(projection.hotel).toBeUndefined();
    expect(projection.routeOrigin).toBeUndefined();
    expect(projection.blocked).toBe(true);
    expect(projection.text).toContain(
      'I could not verify a hotel booking because no complete booking-email thread was read.',
    );
    expect(projection.text).not.toContain('checked email threads');
    expect(projection.text).not.toContain('Dated outbound leg:');
  });

  it('limits a no-hotel finding to the complete email threads actually read', () => {
    const read = request();
    const threadId = 'complete-flight-only-thread';
    const evidence = [
      completeCalendarEvents([calendarFlight()]),
      row(
        'gmail.search',
        { query: read.mailQuery },
        {
          results: [{ threadId, subject: 'Airline itinerary update' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.read_thread',
        { threadId },
        {
          complete: true,
          messages: [
            {
              messageId: 'flight-only-message',
              subject: 'Airline itinerary update',
              text: 'Your airline itinerary was updated. Booking reference: FLIGHT-728.',
            },
          ],
        },
      ),
    ];

    const projection = compoundTripReadProjection(read, evidence);

    expect(projection.threadsComplete).toBe(true);
    expect(projection.hotel).toBeUndefined();
    expect(projection.text).toContain(
      'I did not identify a hotel booking candidate in the complete email threads I read.',
    );
    expect(projection.text).not.toContain('no complete booking-email thread was read');
  });

  it('matches an explicitly outbound booking to an ordinary sparse calendar flight only by exact route and time', () => {
    const read = request();
    const evidence = [
      completeCalendarEvents([
        {
          eventId: 'ordinary-flight',
          summary: 'Flight SFO → BER',
          description: 'Flight to Berlin Brandenburg Airport',
          location: 'SFO → BER',
          start: '2026-10-17T10:10:00+02:00',
          timeZone: 'Europe/Berlin',
          status: 'confirmed',
        },
      ]),
      ...bookingEmailEvidence(),
    ];
    const extracted = {
      status: 'complete' as const,
      segments: [
        {
          threadId: 'flight-booking-thread',
          messageId: 'flight-booking-message',
          subject: 'Lufthansa booking confirmation LH 777',
          flightNumber: 'LH777',
          direction: 'outbound' as const,
          departureDate: '2026-10-17',
          departureTime: '10:10',
          departureTimeZone: 'Europe/Berlin',
          arrivalDate: '2026-10-17',
          arrivalTime: '13:10',
          arrivalTimeZone: 'Europe/Berlin',
          originAirport: 'SFO',
          destinationAirport: 'BER',
          bookingReference: 'FLIGHT-728',
          excerpt: 'Outbound flight LH 777 from SFO to BER, 2026-10-17 at 10:10 Europe/Berlin.',
        },
      ],
      hotels: [],
      rejectedFacts: 0,
      sourceMessageIds: ['flight-booking-message'],
    };
    const projection = compoundTripReadProjection(read, evidence, extracted);
    expect(projection.flight?.segment).toMatchObject({
      flightNumber: 'LH777',
      originAirport: 'SFO',
      destinationAirport: 'BER',
    });
    expect(projection.text).not.toContain('could not match a dated outbound leg');

    const dateOnlyEvidence = [
      completeCalendarEvents([
        {
          eventId: 'date-only-flight',
          summary: 'Outbound flight to Berlin',
          description: 'Travel day in Berlin',
          start: '2026-10-17T08:10:00Z',
          status: 'confirmed',
        },
      ]),
      ...bookingEmailEvidence(),
    ];
    const dateOnlyProjection = compoundTripReadProjection(read, dateOnlyEvidence, extracted);
    expect(dateOnlyProjection.flight).toBeUndefined();
    expect(dateOnlyProjection.text).toContain('could not match a dated outbound leg');
  });

  it('keeps unresolved future flight clocks ambiguous instead of choosing another candidate', () => {
    const read = request();
    const known = {
      threadId: 'clock-ambiguity-thread',
      messageId: 'known-flight',
      subject: 'Itinerary',
      flightNumber: 'LH101',
      direction: 'outbound' as const,
      departureDate: '2026-11-02',
      departureTime: '10:00',
      departureTimeZone: 'Europe/Berlin',
      arrivalDate: '2026-11-02',
      arrivalTime: '12:00',
      arrivalTimeZone: 'Europe/Berlin',
      originAirport: 'SFO',
      destinationAirport: 'BER',
      bookingReference: 'KNOWN-101',
      excerpt: 'LH101 2026-11-02 10:00 Europe/Berlin',
    };
    const unresolved = {
      ...known,
      messageId: 'unresolved-flight',
      flightNumber: 'LH202',
      departureTime: '09:30',
      departureTimeZone: undefined,
      bookingReference: 'UNKNOWN-202',
      excerpt: 'LH202 2026-11-02 09:30',
    };
    const projection = compoundTripReadProjection(
      read,
      [
        completeCalendarEvents([
          {
            ...calendarFlight(),
            eventId: 'known-calendar-flight',
            summary: 'Outbound flight LH101 to Berlin',
            description: 'Booking reference: KNOWN-101',
            start: '2026-11-02T10:00:00+01:00',
          },
        ]),
      ],
      {
        status: 'complete',
        segments: [known, unresolved],
        hotels: [],
        rejectedFacts: 0,
        sourceMessageIds: ['known-flight', 'unresolved-flight'],
      },
    );
    expect(projection.flight).toBeUndefined();
    expect(projection.text).toContain('unresolved source clock');
  });

  it('orders future outbound candidates by normalized instants across time zones', () => {
    const read = request();
    const segments = [
      {
        threadId: 'mixed-zone-thread',
        messageId: 'later-instant',
        subject: 'Itinerary',
        flightNumber: 'LH101',
        direction: 'outbound' as const,
        departureDate: '2026-11-02',
        departureTime: '23:50',
        departureTimeZone: 'America/Los_Angeles',
        arrivalDate: '2026-11-03',
        arrivalTime: '07:00',
        arrivalTimeZone: 'Europe/Paris',
        originAirport: 'SFO',
        destinationAirport: 'LAX',
        bookingReference: 'BOOKING-LA',
        excerpt: 'LH101 2026-11-02 23:50 America/Los_Angeles',
      },
      {
        threadId: 'mixed-zone-thread',
        messageId: 'earlier-instant',
        subject: 'Itinerary',
        flightNumber: 'LH202',
        direction: 'outbound' as const,
        departureDate: '2026-11-03',
        departureTime: '00:10',
        departureTimeZone: 'Europe/Paris',
        arrivalDate: '2026-11-03',
        arrivalTime: '02:00',
        arrivalTimeZone: 'Europe/Paris',
        originAirport: 'SFO',
        destinationAirport: 'BER',
        bookingReference: 'BOOKING-PARIS',
        excerpt: 'LH202 2026-11-03 00:10 Europe/Paris',
      },
    ];
    const projection = compoundTripReadProjection(
      read,
      [
        completeCalendarEvents([
          {
            eventId: 'later-instant-calendar',
            summary: 'Outbound flight LH101 SFO to LAX',
            description: 'Booking reference: BOOKING-LA',
            start: '2026-11-03T07:50:00Z',
            timeZone: 'America/Los_Angeles',
            status: 'confirmed',
          },
          {
            eventId: 'earlier-instant-calendar',
            summary: 'Outbound flight LH202 SFO to BER',
            description: 'Booking reference: BOOKING-PARIS',
            start: '2026-11-02T23:10:00Z',
            timeZone: 'Europe/Paris',
            status: 'confirmed',
          },
        ]),
      ],
      {
        status: 'complete',
        segments,
        hotels: [],
        rejectedFacts: 0,
        sourceMessageIds: ['later-instant', 'earlier-instant'],
      },
    );
    expect(projection.flight?.segment?.flightNumber).toBe('LH202');
    expect(projection.flight?.event.eventId).toBe('earlier-instant-calendar');
  });

  it('uses the bound booking zone when the calendar adapter omits event timeZone', () => {
    const read = request();
    const evidence = [
      completeCalendarEvents([
        {
          eventId: 'kiritimati-flight',
          summary: 'Outbound flight LH401 SFO to BER',
          description: 'Booking reference: KIRI-2026',
          start: '2026-11-01T10:30:00Z',
          status: 'confirmed',
        },
      ]),
      row(
        'gmail.search',
        { query: read.mailQuery },
        { results: [{ threadId: 'kiritimati-booking', subject: 'LH401 itinerary' }] },
      ),
      row(
        'gmail.read_thread',
        { threadId: 'kiritimati-booking' },
        {
          complete: true,
          messages: [
            {
              messageId: 'kiritimati-message',
              subject: 'LH401 itinerary',
              text: 'Outbound LH401. Departure date: 2026-11-02. Departure time: 00:30 Pacific/Kiritimati. Arrival date: 2026-11-02. Arrival time: 10:00 Europe/Berlin. From: SFO. To: BER. Booking reference: KIRI-2026',
            },
          ],
        },
      ),
    ];
    const projection = compoundTripReadProjection(read, evidence, {
      status: 'complete',
      segments: [
        {
          threadId: 'kiritimati-booking',
          messageId: 'kiritimati-message',
          subject: 'LH401 itinerary',
          flightNumber: 'LH401',
          direction: 'outbound',
          departureDate: '2026-11-02',
          departureTime: '00:30',
          departureTimeZone: 'Pacific/Kiritimati',
          arrivalDate: '2026-11-02',
          arrivalTime: '10:00',
          arrivalTimeZone: 'Europe/Berlin',
          originAirport: 'SFO',
          destinationAirport: 'BER',
          bookingReference: 'KIRI-2026',
          excerpt: 'LH401 2026-11-02 00:30 Pacific/Kiritimati',
        },
      ],
      hotels: [],
      rejectedFacts: 0,
      sourceMessageIds: ['kiritimati-message'],
    });
    expect(projection.flight?.event.eventId).toBe('kiritimati-flight');
    expect(projection.flight?.segment).toMatchObject({ departureDate: '2026-11-02' });
  });

  it('does not infer a calendar local date without a strong flight identity', () => {
    const read = request();
    const projection = compoundTripReadProjection(
      read,
      [
        completeCalendarEvents([
          {
            eventId: 'sparse-kiritimati-flight',
            summary: 'Outbound flight SFO to BER',
            start: '2026-11-01T10:30:00Z',
            status: 'confirmed',
          },
        ]),
      ],
      {
        status: 'complete',
        segments: [
          {
            threadId: 'kiritimati-booking',
            messageId: 'kiritimati-message',
            subject: 'LH401 itinerary',
            flightNumber: 'LH401',
            direction: 'outbound',
            departureDate: '2026-11-02',
            departureTime: '00:30',
            departureTimeZone: 'Pacific/Kiritimati',
            arrivalDate: '2026-11-02',
            arrivalTime: '10:00',
            arrivalTimeZone: 'Europe/Berlin',
            originAirport: 'SFO',
            destinationAirport: 'BER',
            bookingReference: 'KIRI-2026',
            excerpt: 'LH401 2026-11-02 00:30 Pacific/Kiritimati',
          },
        ],
        hotels: [],
        rejectedFacts: 0,
        sourceMessageIds: ['kiritimati-message'],
      },
    );

    expect(projection.flight).toBeUndefined();
  });

  it('does not treat two absent flight numbers as a strong identity', () => {
    const read = request();
    const projection = compoundTripReadProjection(
      read,
      [
        completeCalendarEvents([
          {
            eventId: 'unidentified-kiritimati-flight',
            summary: 'Outbound flight SFO to BER',
            start: '2026-11-01T10:30:00Z',
            status: 'confirmed',
          },
        ]),
      ],
      {
        status: 'complete',
        segments: [
          {
            threadId: 'unidentified-booking',
            messageId: 'unidentified-message',
            subject: 'Flight itinerary',
            flightNumber: undefined as unknown as string,
            direction: 'outbound',
            departureDate: '2026-11-02',
            departureTime: '00:30',
            departureTimeZone: 'Pacific/Kiritimati',
            arrivalDate: '2026-11-02',
            arrivalTime: '10:00',
            arrivalTimeZone: 'Europe/Berlin',
            originAirport: 'SFO',
            destinationAirport: 'BER',
            excerpt: '2026-11-02 00:30 Pacific/Kiritimati',
          },
        ],
        hotels: [],
        rejectedFacts: 0,
        sourceMessageIds: ['unidentified-message'],
      },
    );

    expect(projection.flight).toBeUndefined();
  });

  it('treats different local dates and clocks at the same instant as ambiguous outbound candidates', () => {
    const read = request();
    const kiritimati = {
      threadId: 'kiritimati-booking',
      messageId: 'kiritimati-outbound',
      subject: 'Kiritimati itinerary',
      flightNumber: 'LH401',
      direction: 'outbound' as const,
      departureDate: '2026-11-02',
      departureTime: '00:30',
      departureTimeZone: 'Pacific/Kiritimati',
      arrivalDate: '2026-11-02',
      arrivalTime: '10:00',
      arrivalTimeZone: 'Europe/Berlin',
      originAirport: 'SFO',
      destinationAirport: 'BER',
      bookingReference: 'KIRI-2026',
      excerpt: 'LH401 2026-11-02 00:30 Pacific/Kiritimati',
    };
    const kolkata = {
      ...kiritimati,
      threadId: 'kolkata-booking',
      messageId: 'kolkata-outbound',
      subject: 'Kolkata itinerary',
      flightNumber: 'LH402',
      departureDate: '2026-11-01',
      departureTime: '16:00',
      departureTimeZone: 'Asia/Kolkata',
      bookingReference: 'KOL-2026',
      excerpt: 'LH402 2026-11-01 16:00 Asia/Kolkata',
    };
    const projection = compoundTripReadProjection(read, [completeCalendarEvents([])], {
      status: 'complete',
      segments: [kiritimati, kolkata],
      hotels: [],
      rejectedFacts: 0,
      sourceMessageIds: ['kiritimati-outbound', 'kolkata-outbound'],
    });

    expect(projection.flight).toBeUndefined();
    expect(projection.text).toContain('more than one plausible flight candidate');
  });

  it('selects only public-transport and taxi pages from HTTPS search results', () => {
    const read = request();
    const evidence: ReadToolEvidence[] = [
      completeCalendarEvents([calendarFlight()]),
      ...bookingEmailEvidence(),
      row(
        'web.search',
        {
          query: '"BER" public transport taxi "Hotel Linden" "Berlin" official',
        },
        {
          results: [
            {
              title: 'Official airport train',
              url: 'https://transit.example/berlin',
              snippet: 'Public transport from BER to Berlin.',
            },
            {
              title: 'Airport taxi',
              url: 'https://taxi.example/berlin',
              snippet: 'Taxi from BER to Berlin.',
            },
            { title: 'Unsafe', url: 'javascript:alert(1)', snippet: 'Taxi public transport' },
          ],
        },
      ),
    ];
    expect(compoundTripFetchTargets(read, evidence)).toEqual([
      { mode: 'public transport', url: 'https://transit.example/berlin' },
      { mode: 'taxi', url: 'https://taxi.example/berlin' },
    ]);
  });

  it('continues an incomplete full-thread read with its exact bounded continuation', () => {
    const read = request();
    const flightThread = 'flight-booking-thread';
    const body = `${'Earlier message context. '.repeat(400)}\nOutbound\nFlight number: LH 777\nDeparture date: 2026-10-17\nDeparture time: 10:10 Europe/Berlin\nFrom: SFO\nTo: BER\nBooking reference: FLIGHT-728`;
    const pageSize = 8_000;
    const firstPage = body.slice(0, pageSize);
    const secondPage = body.slice(pageSize);
    const evidence: ReadToolEvidence[] = [
      completeCalendarEvents([calendarFlight()]),
      row(
        'gmail.search',
        { query: read.mailQuery },
        {
          results: [{ threadId: flightThread, subject: 'Flight booking confirmation' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.search',
        { query: read.mailQueries?.find((entry) => entry.category === 'lodging')?.query },
        { results: [], complete: true, hasMore: false },
      ),
      row(
        'gmail.read_thread',
        {
          threadId: flightThread,
          startMessageIndex: 0,
          startMessageOffset: 0,
          maxMessages: 20,
          maxChars: 20_000,
        },
        {
          complete: false,
          hasMore: true,
          continuation: {
            tool: 'gmail.read_thread',
            input: {
              threadId: flightThread,
              startMessageIndex: 0,
              startMessageOffset: pageSize,
              maxMessages: 20,
              maxChars: 20_000,
            },
          },
          receipt: {
            version: 1,
            source: { kind: 'gmail-thread', id: flightThread },
            requested: { start: 0, offset: 0, limit: 20, scope: 'thread-messages' },
            covered: { start: 0, offset: 0, end: 1, count: 1, total: 2, unavailable: 0 },
            complete: false,
            losses: ['character-budget'],
            continuation: {
              tool: 'gmail.read_thread',
              input: {
                threadId: flightThread,
                startMessageIndex: 0,
                startMessageOffset: pageSize,
                maxMessages: 20,
                maxChars: 20_000,
              },
            },
          },
          messages: [
            {
              messageId: 'flight-booking-message',
              subject: 'Confirmed itinerary',
              text: firstPage,
              sourceLength: body.length,
              truncated: true,
            },
          ],
        },
      ),
    ];
    expect(compoundTripReadProjection(read, evidence).flightSegments).toEqual([]);
    expect(nextRequiredReadTool(read, evidence)).toBe('gmail.read_thread');
    expect(buildReadToolInput(read, 'gmail.read_thread', evidence)).toEqual({
      threadId: flightThread,
      startMessageIndex: 0,
      startMessageOffset: pageSize,
      maxMessages: 20,
      maxChars: 20_000,
    });
    const completed = row(
      'gmail.read_thread',
      {
        threadId: flightThread,
        startMessageIndex: 0,
        startMessageOffset: pageSize,
        maxMessages: 20,
        maxChars: 20_000,
      },
      {
        complete: true,
        hasMore: false,
        receipt: {
          version: 1,
          source: { kind: 'gmail-thread', id: flightThread },
          requested: {
            start: 0,
            offset: pageSize,
            limit: 20,
            scope: 'thread-messages',
          },
          covered: {
            start: 0,
            offset: pageSize,
            end: 2,
            count: 2,
            total: 2,
            unavailable: 0,
          },
          complete: true,
          losses: [],
          continuation: null,
        },
        messages: [
          {
            messageId: 'flight-booking-message',
            subject: 'Confirmed itinerary',
            text: secondPage,
            sourceLength: body.length,
            truncated: false,
          },
          {
            messageId: 'later-owner-reply',
            subject: 'Re: Confirmed itinerary',
            text: 'The date still works.',
            sourceLength: 21,
            truncated: false,
          },
        ],
      },
    );
    const projection = compoundTripReadProjection(read, [...evidence, completed]);
    expect(projection.flight?.segment).toMatchObject({
      flightNumber: 'LH777',
      departureDate: '2026-10-17',
      departureTime: '10:10',
    });
    expect(projection.flightSegments[0]?.excerpt).toContain('Departure date: 2026-10-17');
    expect(projection.threadsComplete).toBe(true);
  });

  it('requires current search and complete-thread source receipts before using booking messages', () => {
    const read = request();
    const base = [completeCalendarEvents([calendarFlight()]), ...bookingEmailEvidence()];
    const search = base.find((item) => item.toolName === 'gmail.search');
    const thread = base.find((item) => item.toolName === 'gmail.read_thread');
    if (!search || !thread) throw new Error('Expected Gmail fixture rows');
    const missingSearchReceipt = structuredClone(search);
    delete (missingSearchReceipt.result as Record<string, unknown>).receipt;
    const missingThreadReceipt = structuredClone(thread);
    delete (missingThreadReceipt.result as Record<string, unknown>).receipt;

    const searchProjection = compoundTripReadProjection(
      read,
      base.map((item) => (item === search ? missingSearchReceipt : item)),
    );
    const threadProjection = compoundTripReadProjection(
      read,
      base.map((item) => (item === thread ? missingThreadReceipt : item)),
    );

    expect(searchProjection.gmailSearchComplete).toBe(false);
    expect(searchProjection.text).toContain(
      'Booking-email search or thread coverage is incomplete',
    );
    expect(threadProjection.threadsComplete).toBe(false);
    expect(threadProjection.text).toContain(
      'Booking-email search or thread coverage is incomplete',
    );
  });

  it('rejects a search page whose continuation receipt does not match the returned token', () => {
    const read = request();
    const first = row(
      'gmail.search',
      { query: read.mailQuery, maxResults: 10 },
      {
        results: [{ threadId: 'first-thread', subject: 'Flight booking' }],
        complete: false,
        hasMore: true,
        nextPageToken: 'next-page-token',
      },
    );
    const receipt = (first.result as Record<string, unknown>).receipt as Record<string, unknown>;
    receipt.continuation = {
      tool: 'gmail.search',
      input: { query: read.mailQuery, maxResults: 10, pageToken: 'wrong-token' },
    };
    const projection = compoundTripReadProjection(read, [completeCalendarEvents([]), first]);
    expect(projection.gmailSearchComplete).toBe(false);
  });

  it('rejects a duplicate result continuation when it disagrees with the canonical receipt', () => {
    const read = request();
    const first = row(
      'gmail.search',
      { query: read.mailQuery, maxResults: 10 },
      {
        results: [{ threadId: 'first-thread', subject: 'Flight booking' }],
        complete: false,
        hasMore: true,
        nextPageToken: 'next-page-token',
        continuation: {
          tool: 'gmail.search',
          input: { query: read.mailQuery, maxResults: 10, pageToken: 'different-page-token' },
        },
      },
    );
    const projection = compoundTripReadProjection(read, [completeCalendarEvents([]), first]);
    expect(projection.gmailSearchComplete).toBe(false);
  });

  it('accepts receipt-only Gmail continuations across pages and rejects a digest for another query', () => {
    const detected = request();
    const flightQuery = `${'flight '.repeat(42)}flight`;
    expect(flightQuery).toHaveLength(300);
    const read = {
      ...detected,
      mailQuery: flightQuery,
      mailQueries: [
        { category: 'flight' as const, query: flightQuery },
        ...(detected.mailQueries ?? []).filter((entry) => entry.category === 'lodging'),
      ],
    };
    const firstPage = row(
      'gmail.search',
      { query: flightQuery, maxResults: 10 },
      {
        results: [{ threadId: 'long-query-flight-thread', subject: 'Flight confirmation' }],
        complete: false,
        hasMore: true,
        nextPageToken: 'long-query-page-2',
      },
    );
    const secondPage = row(
      'gmail.search',
      { query: flightQuery, maxResults: 10, pageToken: 'long-query-page-2' },
      { results: [], complete: true, hasMore: false },
    );
    const lodgingQuery = read.mailQueries.find((entry) => entry.category === 'lodging')?.query;
    if (!lodgingQuery) throw new Error('Expected a lodging query');
    const lodgingPage = row(
      'gmail.search',
      { query: lodgingQuery, maxResults: 10 },
      { results: [], complete: true, hasMore: false },
    );
    const thread = row(
      'gmail.read_thread',
      { threadId: 'long-query-flight-thread' },
      {
        complete: true,
        messages: [
          {
            messageId: 'long-query-flight-message',
            subject: 'Lufthansa booking confirmation',
            text: 'Outbound\nFlight number: LH777\nDeparture date: 2026-10-17\nDeparture time: 10:10 Europe/Berlin\nArrival date: 2026-10-17\nArrival time: 13:10 Europe/Berlin\nFrom: SFO\nTo: BER\nBooking reference: FLIGHT-728',
          },
        ],
      },
    );
    const evidence = [
      completeCalendarEvents([calendarFlight()], read),
      firstPage,
      secondPage,
      lodgingPage,
      thread,
    ];

    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.gmailSearchComplete).toBe(true);
    expect(projection.threadsComplete).toBe(true);
    expect(projection.flightSegments[0]?.threadId).toBe('long-query-flight-thread');
    expect(projection.flightSegments[0]?.flightNumber).toBe('LH777');

    const mismatchedPage = structuredClone(secondPage);
    const receipt = (mismatchedPage.result as Record<string, unknown>).receipt as Record<
      string,
      unknown
    >;
    (receipt.source as Record<string, unknown>).id = gmailSearchReceiptSourceId(
      `${flightQuery} changed`,
    );
    const mismatched = compoundTripReadProjection(read, [
      completeCalendarEvents([calendarFlight()], read),
      firstPage,
      mismatchedPage,
      lodgingPage,
      thread,
    ]);
    expect(mismatched.gmailSearchComplete).toBe(false);
  });

  it('keeps flight and lodging search coverage independent and incomplete when either category has more pages', () => {
    const read = request();
    const [flight, lodging] = read.mailQueries ?? [];
    if (!flight || !lodging) throw new Error('Expected separate flight and lodging searches');
    const flightPage = row(
      'gmail.search',
      { query: flight.query, maxResults: 20 },
      {
        results: [
          { threadId: 'newsletter', subject: 'Airline news and flight route updates' },
          { threadId: 'flight-confirmation', subject: 'Flight booking confirmation' },
        ],
        complete: true,
        hasMore: false,
      },
    );
    const lodgingPage = row(
      'gmail.search',
      { query: lodging.query, maxResults: 20 },
      {
        results: [{ threadId: 'hotel-confirmation', subject: 'Hotel reservation confirmation' }],
        complete: false,
        hasMore: true,
        nextPageToken: 'lodging-page-2',
      },
    );
    const incomplete = compoundTripReadProjection(read, [
      completeCalendarEvents([]),
      flightPage,
      lodgingPage,
    ]);
    expect(incomplete.gmailSearchComplete).toBe(false);
    expect(incomplete.threadsComplete).toBe(false);
    expect(incomplete.flight).toBeUndefined();
    expect(incomplete.hotel).toBeUndefined();

    const completeLodgingPage = row(
      'gmail.search',
      { query: lodging.query, maxResults: 20 },
      { results: [], complete: true, hasMore: false },
    );
    const complete = compoundTripReadProjection(read, [
      completeCalendarEvents([]),
      flightPage,
      completeLodgingPage,
    ]);
    expect(complete.gmailSearchComplete).toBe(true);
  });

  it('selects the dated outbound leg instead of an earlier return with the same flight number and validates the connection chain', () => {
    const read = request();
    const reference = 'ABC-77881';
    const flightEmail = row(
      'gmail.read_thread',
      { threadId: 'itinerary-thread' },
      {
        complete: true,
        messages: [
          {
            messageId: 'itinerary-message',
            subject: 'LH booking confirmation',
            text: `Return\nFlight number: LH 777\nDeparture date: 2026-10-14\nDeparture time: 08:00 Europe/Berlin\nArrival date: 2026-10-14\nArrival time: 19:00 America/Los_Angeles\nFrom: BER\nTo: SFO\nBooking reference: ${reference}\nOutbound\nFlight number: LH 777\nDeparture date: 2026-11-02\nDeparture time: 10:15 Europe/Berlin\nArrival date: 2026-11-02\nArrival time: 11:45 Europe/Berlin\nFrom: SFO\nTo: FRA\nBooking reference: ${reference}\nConnection\nFlight number: LH 302\nDeparture date: 2026-11-02\nDeparture time: 12:00 Europe/Berlin\nArrival date: 2026-11-02\nArrival time: 13:45 Europe/Berlin\nFrom: FRA\nTo: BER\nBooking reference: ${reference}`,
          },
        ],
      },
    );
    const results = [
      { threadId: 'itinerary-thread', subject: 'LH booking confirmation' },
      { threadId: 'hotel-reservation-thread', subject: 'Hotel reservation confirmed' },
    ];
    const events = [
      {
        ...calendarFlight(),
        eventId: 'return',
        summary: 'Return flight LH 777 to San Francisco',
        description: `Return flight. Booking reference: ${reference}`,
        start: '2026-10-14T08:00:00+02:00',
      },
      {
        ...calendarFlight(),
        eventId: 'wrong-repeated-number',
        summary: 'Outbound flight LH 777 to Berlin',
        description: `Booking reference: ${reference}`,
        start: '2026-11-03T10:15:00+01:00',
      },
      {
        ...calendarFlight(),
        eventId: 'outbound',
        summary: 'Outbound flight LH 777 to Berlin',
        description: `Arrival airport: BER. Booking reference: ${reference}`,
        start: '2026-11-02T10:15:00+01:00',
      },
    ];
    const hotel = row(
      'gmail.read_thread',
      { threadId: 'hotel-reservation-thread' },
      {
        complete: true,
        messages: [
          {
            messageId: 'hotel-message',
            subject: 'Hotel reservation Berlin',
            text: 'Reservation confirmed: Hotel Linden, Berlin.\nCheck-in: 2026-11-02\nCheck-out: 2026-11-04\nAddress: Linienstraße 89, 10119 Berlin.\nBooking reference: HOTEL-55123',
          },
        ],
      },
    );
    const evidence: ReadToolEvidence[] = [
      completeCalendarEvents(events),
      row('gmail.search', { query: read.mailQuery }, { results, complete: true, hasMore: false }),
      flightEmail,
      hotel,
    ];
    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.flight?.event.eventId).toBe('outbound');
    expect(projection.flight?.segment?.departureDate).toBe('2026-11-02');
    expect(projection.connectionSummary).toContain('LH777 SFO→FRA; departs 2026-11-02');
    expect(projection.connectionSummary).toContain('LH302 FRA→BER; departs 2026-11-02');
    expect(projection.text).toContain('Source-backed connected flight segments');
    expect(projection.text).not.toContain('cannot confirm whether this flight is nonstop');
  });

  it('rejects overlapping overnight connections and a return that precedes the outbound arrival', () => {
    const read = request();
    const reference = 'TRIP-77881';
    const segment = (
      messageId: string,
      flightNumber: string,
      role: 'outbound' | 'connection' | 'return',
      departureDate: string,
      departureTime: string,
      arrivalDate: string,
      arrivalTime: string,
      originAirport: string,
      destinationAirport: string,
    ) => ({
      threadId: 'itinerary-thread',
      messageId,
      subject: 'Itinerary',
      flightNumber,
      direction: role,
      departureDate,
      departureTime,
      departureTimeZone: 'Europe/Berlin',
      arrivalDate,
      arrivalTime,
      arrivalTimeZone: 'Europe/Berlin',
      originAirport,
      destinationAirport,
      bookingReference: reference,
      excerpt: `${flightNumber} ${departureDate} ${departureTime} Europe/Berlin`,
    });
    const outbound = segment(
      'outbound-message',
      'LH777',
      'outbound',
      '2026-11-02',
      '22:30',
      '2026-11-03',
      '00:10',
      'SFO',
      'FRA',
    );
    const overlappingConnection = segment(
      'connection-message',
      'LH101',
      'connection',
      '2026-11-02',
      '23:30',
      '2026-11-03',
      '02:15',
      'FRA',
      'BER',
    );
    const hotel = {
      threadId: 'hotel-reservation-thread',
      messageId: 'hotel-booking-message',
      sourceSubject: 'Hotel reservation confirmed',
      name: 'Hotel Linden',
      address: '5 Alexanderplatz, 10178 Berlin',
      city: 'Berlin',
      checkIn: '2026-11-03',
      checkOut: '2026-11-05',
      bookingReference: 'HOTEL-55123',
      quote: 'Hotel Linden, Berlin, 5 Alexanderplatz, 2026-11-03 through 2026-11-05.',
    };
    const validConnection = segment(
      'connection-message',
      'LH101',
      'connection',
      '2026-11-03',
      '00:55',
      '2026-11-03',
      '02:15',
      'FRA',
      'BER',
    );
    const validEvidence = [
      completeCalendarEvents([
        {
          ...calendarFlight(),
          summary: 'Outbound flight LH777 to Berlin',
          description: `Arrival airport: BER. Booking reference: ${reference}`,
          start: '2026-11-02T22:30:00+01:00',
        },
      ]),
      ...bookingEmailEvidence(),
    ];
    const validProjection = compoundTripReadProjection(read, validEvidence, {
      status: 'complete',
      segments: [outbound, validConnection],
      hotels: [hotel],
      rejectedFacts: 0,
      sourceMessageIds: ['outbound-message', 'connection-message', 'hotel-booking-message'],
    });
    expect(validProjection.connectionSummary).toContain('LH101 FRA→BER');
    expect(validProjection.routeOrigin).toBe('BER Airport');
    expect(validProjection.routeDestination).toBe(hotel.address);
    const unknownChronology = compoundTripReadProjection(read, validEvidence, {
      status: 'complete',
      segments: [outbound, { ...validConnection, arrivalTimeZone: undefined }],
      hotels: [hotel],
      rejectedFacts: 0,
      sourceMessageIds: ['outbound-message', 'connection-message', 'hotel-booking-message'],
    });
    expect(unknownChronology.connectionSummary).toBeUndefined();
    expect(unknownChronology.routeOrigin).toBeUndefined();
    expect(unknownChronology.text).toContain('could not verify the chronological order');
    const missingConnectionDepartureZone = compoundTripReadProjection(read, validEvidence, {
      status: 'complete',
      segments: [outbound, { ...validConnection, departureTimeZone: undefined }],
      hotels: [hotel],
      rejectedFacts: 0,
      sourceMessageIds: ['outbound-message', 'connection-message', 'hotel-booking-message'],
    });
    expect(missingConnectionDepartureZone.flightSegments).toHaveLength(2);
    expect(missingConnectionDepartureZone.connectionSummary).toBeUndefined();
    expect(missingConnectionDepartureZone.routeOrigin).toBeUndefined();
    expect(missingConnectionDepartureZone.routeDestination).toBeUndefined();
    expect(missingConnectionDepartureZone.text).toContain(
      'departure or arrival clock/time zone is missing or ambiguous',
    );

    const evidence = [
      completeCalendarEvents([
        {
          ...calendarFlight(),
          summary: 'Outbound flight LH777 to Berlin',
          description: `Arrival airport: BER. Booking reference: ${reference}`,
          start: '2026-11-02T22:30:00+01:00',
        },
      ]),
      ...bookingEmailEvidence(),
    ];
    const extracted = {
      status: 'complete' as const,
      segments: [outbound, overlappingConnection],
      hotels: [hotel],
      rejectedFacts: 0,
      sourceMessageIds: ['outbound-message', 'connection-message', 'hotel-booking-message'],
    };
    const projection = compoundTripReadProjection(read, evidence, extracted);
    expect(projection.connectionSummary).toBeUndefined();
    expect(projection.routeOrigin).toBeUndefined();
    expect(projection.blocked).toBe(true);
    expect(projection.text).toContain('overlap or run in reverse order');
    expect(compoundTripRoute(read, evidence)).toBeUndefined();

    const returnSegment = segment(
      'return-message',
      'LH888',
      'return',
      '2026-11-03',
      '01:30',
      '2026-11-03',
      '12:00',
      'BER',
      'SFO',
    );
    const withReturn = [
      completeCalendarEvents([
        {
          ...calendarFlight(),
          summary: 'Outbound flight LH777 to Berlin',
          description: `Arrival airport: BER. Booking reference: ${reference}`,
          start: '2026-11-02T22:30:00+01:00',
        },
        {
          ...calendarFlight(),
          eventId: 'calendar-return',
          summary: 'Return flight LH888',
          description: `Return. Booking reference: ${reference}`,
          start: '2026-11-03T01:30:00+01:00',
        },
      ]),
      ...bookingEmailEvidence(),
    ];
    const returnProjection = compoundTripReadProjection(read, withReturn, {
      ...extracted,
      segments: [outbound, validConnection, returnSegment],
    });
    expect(returnProjection.returnFlight).toBeDefined();
    expect(returnProjection.routeOrigin).toBeUndefined();
    expect(returnProjection.blocked).toBe(true);
    expect(returnProjection.text).toContain(
      'booked return leaves before the outbound itinerary arrives',
    );
    expect(compoundTripRoute(read, withReturn)).toBeUndefined();
  });

  it('uses an explicitly outbound calendar match when the booking segment direction is unstated', () => {
    const read = request();
    const reference = 'UNK-OUT-441';
    const evidence = [
      completeCalendarEvents([
        {
          ...calendarFlight(),
          summary: 'Outbound flight LH 401 to Berlin',
          description: `Booking reference: ${reference}`,
          start: '2026-11-04T13:45:00-08:00',
        },
      ]),
      row(
        'gmail.search',
        { query: read.mailQuery },
        {
          results: [{ threadId: 'unknown-direction', subject: 'Airline itinerary' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.read_thread',
        { threadId: 'unknown-direction' },
        {
          complete: true,
          hasMore: false,
          messages: [
            {
              messageId: 'unknown-direction-message',
              subject: 'Airline itinerary',
              text: `Flight number: LH 401\nDeparture date: 2026-11-04\nDeparture time: 13:45 America/Los_Angeles\nFrom: SFO\nTo: BER\nBooking reference: ${reference}`,
            },
          ],
        },
      ),
    ];
    const projection = compoundTripReadProjection(read, evidence);

    expect(projection.flight?.segment).toMatchObject({
      flightNumber: 'LH401',
      departureDate: '2026-11-04',
      direction: 'unknown',
    });
    expect(projection.flight?.event.summary).toContain('Outbound');
  });

  it('does not choose the first of multiple paired return alternatives', () => {
    const read = request();
    const reference = 'ALT-RET-41';
    const outbound = {
      threadId: 'alternatives-thread',
      messageId: 'outbound-message',
      subject: 'Itinerary',
      flightNumber: 'LH401',
      direction: 'outbound' as const,
      departureDate: '2026-11-04',
      departureTime: '13:45',
      departureTimeZone: 'America/Los_Angeles',
      arrivalDate: '2026-11-04',
      arrivalTime: '18:30',
      arrivalTimeZone: 'Europe/Berlin',
      originAirport: 'SFO',
      destinationAirport: 'BER',
      bookingReference: reference,
      excerpt: 'LH401 outbound 2026-11-04 13:45 America/Los_Angeles',
    };
    const returns = [
      {
        threadId: 'alternatives-thread',
        messageId: 'return-one',
        subject: 'Itinerary',
        flightNumber: 'LH402',
        direction: 'return' as const,
        departureDate: '2026-11-11',
        departureTime: '09:00',
        departureTimeZone: 'Europe/Berlin',
        arrivalDate: '2026-11-11',
        arrivalTime: '18:00',
        arrivalTimeZone: 'America/Los_Angeles',
        originAirport: 'BER',
        destinationAirport: 'SFO',
        bookingReference: reference,
        excerpt: 'LH402 return 2026-11-11 09:00 Europe/Berlin',
      },
      {
        threadId: 'alternatives-thread',
        messageId: 'return-two',
        subject: 'Itinerary',
        flightNumber: 'LH404',
        direction: 'return' as const,
        departureDate: '2026-11-12',
        departureTime: '11:00',
        departureTimeZone: 'Europe/Berlin',
        arrivalDate: '2026-11-12',
        arrivalTime: '20:00',
        arrivalTimeZone: 'America/Los_Angeles',
        originAirport: 'BER',
        destinationAirport: 'SFO',
        bookingReference: reference,
        excerpt: 'LH404 return 2026-11-12 11:00 Europe/Berlin',
      },
    ];
    const projection = compoundTripReadProjection(
      read,
      [
        completeCalendarEvents([
          {
            ...calendarFlight(),
            eventId: 'outbound-event',
            summary: 'Outbound flight LH401 to Berlin',
            description: `Booking reference: ${reference}`,
            start: '2026-11-04T13:45:00-08:00',
          },
          {
            ...calendarFlight(),
            eventId: 'return-one-event',
            summary: 'Return flight LH402 to SFO',
            description: `Booking reference: ${reference}`,
            start: '2026-11-11T09:00:00+01:00',
          },
          {
            ...calendarFlight(),
            eventId: 'return-two-event',
            summary: 'Return flight LH404 to SFO',
            description: `Booking reference: ${reference}`,
            start: '2026-11-12T11:00:00+01:00',
          },
        ]),
      ],
      {
        status: 'complete',
        segments: [outbound, ...returns],
        hotels: [],
        rejectedFacts: 0,
        sourceMessageIds: ['outbound-message', 'return-one', 'return-two'],
      },
    );
    expect(projection.flight?.segment?.flightNumber).toBe('LH401');
    expect(projection.returnFlight).toBeUndefined();
    expect(projection.text).toContain('more than one plausible flight candidate');
    expect(projection.text).not.toContain('Dated return leg from the same booking');
  });

  it('uses the final connected-leg arrival date for hotel matching and retains the booked return legs', () => {
    const read = request();
    const reference = 'ROUND-TRIP-441';
    const flightThread = 'round-trip-booking';
    const hotelThread = 'round-trip-hotel';
    const booking = [
      'Outbound',
      'Flight number: LH 401',
      'Departure date: 2026-11-04',
      'Departure time: 13:45 America/Los_Angeles',
      'Arrival date: 2026-11-04',
      'Arrival time: 18:30 America/New_York',
      'From: SFO',
      'To: JFK',
      `Booking reference: ${reference}`,
      'Connection',
      'Flight number: LH 777',
      'Departure date: 2026-11-05',
      'Departure time: 08:10 America/New_York',
      'Arrival date: 2026-11-05',
      'Arrival time: 21:10 Europe/Berlin',
      'From: JFK',
      'To: BER',
      `Booking reference: ${reference}`,
      'Return',
      'Flight number: LH 402',
      'Departure date: 2026-11-12',
      'Departure time: 12:00 Europe/Berlin',
      'Arrival date: 2026-11-12',
      'Arrival time: 15:00 America/New_York',
      'From: BER',
      'To: JFK',
      `Booking reference: ${reference}`,
    ].join('\n');
    const calendar = [
      {
        ...calendarFlight(),
        eventId: 'round-trip-outbound',
        summary: 'Outbound flight LH 401 to Berlin',
        description: `Arrival airport: BER. Booking reference: ${reference}`,
        start: '2026-11-04T21:45:00.000Z',
      },
      {
        ...calendarFlight(),
        eventId: 'round-trip-return',
        summary: 'Return flight LH 402 from Berlin',
        description: `Booking reference: ${reference}`,
        start: '2026-11-12T11:00:00.000Z',
      },
    ];
    const hotelMessage = (checkIn: string) =>
      `Hotel Name: Hotel Linden\nCity: Berlin\nCheck-in: ${checkIn}\nCheck-out: 2026-11-09\nAddress: Linienstraße 89, 10119 Berlin\nBooking reference: HOTEL-55123`;
    const project = (checkIn: string) =>
      compoundTripReadProjection(read, [
        completeCalendarEvents(calendar),
        row(
          'gmail.search',
          { query: read.mailQuery },
          {
            results: [
              { threadId: flightThread, subject: 'Round trip itinerary' },
              { threadId: hotelThread, subject: 'Hotel reservation' },
            ],
            complete: true,
            hasMore: false,
          },
        ),
        row(
          'gmail.read_thread',
          { threadId: flightThread },
          {
            complete: true,
            hasMore: false,
            messages: [
              { messageId: 'round-trip-itinerary', subject: 'Round trip itinerary', text: booking },
            ],
          },
        ),
        row(
          'gmail.read_thread',
          { threadId: hotelThread },
          {
            complete: true,
            hasMore: false,
            messages: [
              {
                messageId: 'hotel-confirmation',
                subject: 'Hotel reservation',
                text: hotelMessage(checkIn),
              },
            ],
          },
        ),
      ]);

    const arrivedHotel = project('2026-11-05');
    expect(arrivedHotel.flight?.itineraryArrivalDate).toBe('2026-11-05');
    expect(arrivedHotel.hotel?.association).toBe('date_city_candidate');
    expect(arrivedHotel.returnFlight?.segment).toMatchObject({
      flightNumber: 'LH402',
      departureDate: '2026-11-12',
      departureTime: '12:00',
      departureTimeZone: 'Europe/Berlin',
    });
    expect(arrivedHotel.connectionSummary).toContain('LH401 SFO→JFK; departs 2026-11-04');
    expect(arrivedHotel.connectionSummary).toContain('LH777 JFK→BER; departs 2026-11-05');
    expect(arrivedHotel.text).toContain('Dated return leg from the same booking');
    expect(arrivedHotel.text).toContain('2026-11-12 12:00 Europe/Berlin');

    const firstLegHotel = project('2026-11-04');
    expect(firstLegHotel.hotel).toBeUndefined();
    expect(firstLegHotel.routeDestination).toBeUndefined();
  });

  it('reports a matched return leg without presenting it as a new outbound trip', () => {
    const read = request();
    const reference = 'BER-RET-771';
    const evidence: ReadToolEvidence[] = [
      completeCalendarEvents([
        {
          ...calendarFlight(),
          summary: 'Return flight LH 777',
          description: `Return flight. Booking reference: ${reference}`,
          start: '2026-10-16T14:10:00+02:00',
        },
      ]),
      row(
        'gmail.search',
        { query: read.mailQuery },
        {
          results: [{ threadId: 'current-trip-thread', subject: 'Airline itinerary' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.read_thread',
        { threadId: 'current-trip-thread' },
        {
          complete: true,
          messages: [
            {
              messageId: 'current-trip-message',
              subject: 'Airline itinerary',
              text: `Return\nFlight number: LH 777\nDeparture date: 2026-10-16\nDeparture time: 14:10 Europe/Berlin\nFrom: BER\nTo: SFO\nBooking reference: ${reference}`,
            },
          ],
        },
      ),
    ];
    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.flight).toBeUndefined();
    expect(projection.currentTripReturn?.segment).toMatchObject({
      flightNumber: 'LH777',
      departureDate: '2026-10-16',
      direction: 'return',
    });
    expect(projection.text).toContain('dated return leg from a current trip');
    expect(projection.text).toContain('This does not identify a new outbound trip.');
    expect(projection.text).toContain('[dated booking-thread source]');
    expect(projection.routeOrigin).toBeUndefined();
    expect(projection.webQuery).toBeUndefined();
    const flightOnly = upcomingFlightReadProjection(read, evidence);
    expect(flightOnly.flight?.segment?.flightNumber).toBe('LH777');
    expect(flightOnly.currentTripReturn?.segment?.flightNumber).toBe('LH777');
    expect(flightOnly.text).toContain('Next matched future return flight');
    expect(flightOnly.text).not.toContain('new outbound');
    expect(flightOnly.text).not.toMatch(/hotel|taxi|public.transport/i);
  });

  it('reconciles one dated return leg by exact booking reference and reports calendar conflicts', () => {
    const read = request();
    const reference = 'TRIP-44119';
    const outboundQuote = `Outbound flight KL1701. Departure date: 2026-10-10. Departure time: 07:00 Europe/Amsterdam. Arrival date: 2026-10-10. Arrival time: 08:10 Europe/Berlin. From: AMS. To: BER. Booking reference: ${reference}.`;
    const returnQuote = `Return flight KL1770. Departure date: 2026-10-17. Departure time: 06:00 Europe/Berlin. Arrival date: 2026-10-17. Arrival time: 08:20 Europe/Amsterdam. From: BER. To: AMS. Booking reference: ${reference}.`;
    const connectionQuote = `Connecting flight KL605. Departure date: 2026-10-17. Departure time: 09:50 Europe/Amsterdam. Arrival date: 2026-10-17. Arrival time: 11:45 America/Los_Angeles. From: AMS. To: SFO. Booking reference: ${reference}.`;
    const hotelQuote =
      'Hotel reservation: Northstar Collection, Berlin. Check-in 2026-10-10; check-out 2026-10-17.';
    const calendar = {
      ...calendarFlight(),
      eventId: 'return-event-conflicting-metadata',
      summary: 'Return flight UA 777 from Berlin',
      description: `Booking reference: ${reference}. BER -> JFK. Arrival airport: JFK.`,
      start: '2026-10-16T21:10:00-07:00',
      timeZone: 'America/Los_Angeles',
      links: [
        { type: 'calendar', url: 'https://calendar.google.com/calendar/event?eid=return-conflict' },
      ],
    };
    const stayDescription = (
      'Hotel reservation details for an independently booked stay in Berlin. ' +
      'This private calendar description is used only to classify the row as lodging. '.repeat(4)
    ).slice(0, 351);
    expect(stayDescription).toHaveLength(351);
    const stay = {
      eventId: 'lodging-event-same-booking',
      summary: 'Northstar Collection',
      description: stayDescription,
      location: 'Berlin, Germany',
      start: { date: '2026-10-10' },
      end: { date: '2026-10-18' },
      status: 'confirmed',
      links: [{ type: 'calendar', url: 'https://calendar.google.com/calendar/event?eid=lodging' }],
    };
    const evidence = [
      {
        ...completeCalendarEvents([calendar, stay]),
        result: {
          events: [calendar, stay],
          complete: false,
          calendarRosterComplete: true,
          unavailable: [],
          nextPageToken: 'bounded-calendar-cursor',
        },
      },
      row(
        'gmail.search',
        { query: read.mailQuery },
        {
          results: [
            { threadId: 'round-trip-source', subject: 'Airline itinerary' },
            { threadId: 'unread-ranked-thread', subject: 'Another possible booking' },
          ],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.read_thread',
        { threadId: 'round-trip-source' },
        {
          complete: true,
          messages: [
            {
              messageId: 'return-leg-source',
              subject: 'Airline itinerary',
              text: `${outboundQuote}\n${returnQuote}\n${connectionQuote}\n${hotelQuote}`,
            },
          ],
        },
      ),
    ];
    const extraction = {
      status: 'complete' as const,
      segments: [
        {
          threadId: 'round-trip-source',
          messageId: 'return-leg-source',
          subject: 'Airline itinerary',
          flightNumber: 'KL1701',
          direction: 'outbound' as const,
          departureDate: '2026-10-10',
          departureTime: '07:00',
          departureTimeZone: 'Europe/Amsterdam',
          arrivalDate: '2026-10-10',
          arrivalTime: '08:10',
          arrivalTimeZone: 'Europe/Berlin',
          originAirport: 'AMS',
          destinationAirport: 'BER',
          bookingReference: reference,
          excerpt: outboundQuote,
        },
        {
          threadId: 'round-trip-source',
          messageId: 'return-leg-source',
          subject: 'Airline itinerary',
          flightNumber: 'KL1770',
          direction: 'return' as const,
          departureDate: '2026-10-17',
          departureTime: '06:00',
          departureTimeZone: 'Europe/Berlin',
          arrivalDate: '2026-10-17',
          arrivalTime: '08:20',
          arrivalTimeZone: 'Europe/Amsterdam',
          originAirport: 'BER',
          destinationAirport: 'AMS',
          bookingReference: reference,
          excerpt: returnQuote,
        },
        {
          threadId: 'round-trip-source',
          messageId: 'return-leg-source',
          subject: 'Airline itinerary',
          flightNumber: 'KL605',
          direction: 'connection' as const,
          departureDate: '2026-10-17',
          departureTime: '09:50',
          departureTimeZone: 'Europe/Amsterdam',
          arrivalDate: '2026-10-17',
          arrivalTime: '11:45',
          arrivalTimeZone: 'America/Los_Angeles',
          originAirport: 'AMS',
          destinationAirport: 'SFO',
          bookingReference: reference,
          excerpt: connectionQuote,
        },
      ],
      hotels: [
        {
          threadId: 'round-trip-source',
          messageId: 'return-leg-source',
          sourceSubject: 'Airline itinerary',
          name: 'Northstar Collection',
          city: 'Berlin',
          checkIn: '2026-10-10',
          checkOut: '2026-10-17',
          quote: hotelQuote,
        },
      ],
      rejectedFacts: 0,
      sourceMessageIds: ['return-leg-source'],
    };

    const projection = compoundTripReadProjection(read, evidence, extraction);
    expect(projection.flight).toBeUndefined();
    expect(projection.currentTripReturn?.segment?.flightNumber).toBe('KL1770');
    expect(projection.currentTripReturn?.calendarConflicts).toEqual(
      expect.arrayContaining(['flight-number', 'arrival-airport']),
    );
    expect(projection.flightSegments).toHaveLength(3);
    expect(projection.text).toContain('does not identify a new outbound trip');
    expect(projection.text).toContain('clock times conflict');
    expect(projection.text).toContain('arrival airport conflicts');
    expect(projection.text).toContain(
      'Calendar lists flight UA777; the booking thread lists KL1770.',
    );
    expect(projection.text).toContain(
      'Calendar lists arrival at JFK; the booking chain ends at SFO.',
    );
    expect(projection.text).toContain('Source-backed return connections');
    expect(projection.text).toContain(
      'Dated hotel reservation observed separately from the selected flight',
    );
    expect(projection.text).toContain('Northstar Collection, Berlin (2026-10-10 to 2026-10-17)');
    expect(projection.text).toContain('not linked to the selected flight');
    expect(projection.hotel).toBeUndefined();
    expect(projection.calendarLodgingObservation).toMatchObject({
      title: 'Northstar Collection',
      dateStart: '2026-10-10',
      dateEnd: '2026-10-18',
      association: 'date_city_candidate',
    });
    expect(projection.calendarLodgingObservation).toBeDefined();
    expect(projection.text.match(/Northstar Collection/g)).toHaveLength(1);
    expect(projection.text).not.toContain('Lodging calendar observation only');
    expect(projection.text).not.toContain(
      '[Calendar source](https://calendar.google.com/calendar/event?eid=lodging)',
    );
    expect(projection.text).not.toContain(stayDescription);
    expect(projection.calendarComplete).toBe(false);
    expect(projection.threadsComplete).toBe(false);
    expect(projection.text).toContain('1 matching email thread remains unread or incomplete');
    expect(projection.blocked).toBe(true);
    expect(projection.routeOrigin).toBeUndefined();
    expect(projection.webQuery).toBeUndefined();

    const withStay = (candidate: Record<string, unknown>) => {
      const updatedEvidence = evidence.map((item, index) =>
        index === 0
          ? {
              ...item,
              result: {
                ...(item.result as Record<string, unknown>),
                events: [calendar, candidate],
              },
            }
          : item,
      );
      return compoundTripReadProjection(read, updatedEvidence, extraction);
    };
    expect(
      withStay({ ...stay, eventId: 'end-on-arrival-date', end: { date: '2026-10-17' } })
        .calendarLodgingObservation,
    ).toBeUndefined();

    const withoutSource = withStay({ ...stay, links: [], htmlLink: undefined });
    expect(withoutSource.calendarLodgingObservation).toBeUndefined();
    expect(withoutSource.text).toContain(
      'Dated hotel reservation observed separately from the selected flight',
    );

    const linkedStay = {
      ...stay,
      summary: `Northstar hotel reference ${reference}`,
      eventId: 'linked-stay-one',
    };
    const secondLinkedStay = { ...linkedStay, eventId: 'linked-stay-two' };
    const ambiguousEvidence = evidence.map((item, index) =>
      index === 0
        ? {
            ...item,
            result: {
              ...(item.result as Record<string, unknown>),
              events: [calendar, linkedStay, secondLinkedStay],
            },
          }
        : item,
    );
    expect(
      compoundTripReadProjection(read, ambiguousEvidence, extraction).calendarLodgingObservation,
    ).toBeUndefined();
  });

  it('rejects an unrelated reference and a same-reference event on the wrong local departure date', () => {
    const read = request();
    const reference = 'TRIP-44119';
    const quote = `Return flight KL1770. Departure date: 2026-10-17. Departure time: 06:00 Europe/Berlin. From: BER. To: AMS. Booking reference: ${reference}.`;
    const segment = {
      threadId: 'round-trip-source',
      messageId: 'return-leg-source',
      subject: 'Airline itinerary',
      flightNumber: 'KL1770',
      direction: 'return' as const,
      departureDate: '2026-10-17',
      departureTime: '06:00',
      departureTimeZone: 'Europe/Berlin',
      originAirport: 'BER',
      destinationAirport: 'AMS',
      bookingReference: reference,
      excerpt: quote,
    };
    const source = [
      row(
        'gmail.search',
        { query: read.mailQuery },
        {
          results: [{ threadId: 'round-trip-source', subject: 'Airline itinerary' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.read_thread',
        { threadId: 'round-trip-source' },
        {
          complete: true,
          messages: [{ messageId: 'return-leg-source', subject: 'Airline itinerary', text: quote }],
        },
      ),
    ];
    const extraction = {
      status: 'complete' as const,
      segments: [segment],
      hotels: [],
      rejectedFacts: 0,
      sourceMessageIds: ['return-leg-source'],
    };
    const calendarRow = (booking: string, start: string) =>
      completeCalendarEvents([
        {
          ...calendarFlight(),
          eventId: 'unrelated-return-event',
          summary: 'Return flight KL1770 from Berlin',
          description: `Booking reference: ${booking}. BER -> AMS.`,
          start,
          timeZone: 'Europe/Berlin',
        },
      ]);

    const differentReference = compoundTripReadProjection(
      read,
      [calendarRow('OTHER-9911', '2026-10-17T06:00:00+02:00'), ...source],
      extraction,
    );
    expect(differentReference.currentTripReturn).toBeUndefined();
    expect(differentReference.flight).toBeUndefined();

    const wrongDate = compoundTripReadProjection(
      read,
      [calendarRow(reference, '2026-10-18T06:00:00+02:00'), ...source],
      extraction,
    );
    expect(wrongDate.currentTripReturn).toBeUndefined();
    expect(wrongDate.flight).toBeUndefined();
  });

  it('does not present an unrelated Sunnyvale email hotel as a trip hotel or route endpoint', () => {
    const read = request();
    const evidence = [
      completeCalendarEvents([
        calendarFlight(),
        {
          eventId: 'unrelated-sunnyvale-lodging',
          summary: 'Orchard Suites',
          description: 'Hotel reservation for a separate stay.',
          location: 'Sunnyvale, California',
          start: { date: '2026-10-17' },
          end: { date: '2026-10-19' },
        },
      ]),
      ...bookingEmailEvidence({
        hotelSubject: 'Reservation confirmed: Orchard Suites, Sunnyvale',
        hotelBody:
          'Reservation confirmed: Orchard Suites, Sunnyvale.\nDates: October 17–19, 2026.\nAddress: 100 Main Street, Sunnyvale, CA.\nBooking reference: HOTEL-99181',
      }),
    ];
    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.hotel).toBeUndefined();
    expect(projection.calendarLodgingObservation).toBeUndefined();
    expect(projection.text).not.toContain('Orchard Suites');
    expect(projection.text).not.toContain('Sunnyvale');
    expect(compoundTripRoute(read, evidence)).toBeUndefined();
  });

  it('uses description text only to classify a source-linked lodging observation', () => {
    const read = request();
    const flightText =
      'Outbound\nFlight number: LH 777\nDeparture date: 2026-10-17\nDeparture time: 10:10 Europe/Berlin\nArrival date: 2026-10-17\nArrival time: 13:10 Europe/Berlin\nFrom: SFO\nTo: BER\nBooking reference: FLIGHT-728';
    const flightEmailEvidence = [
      row(
        'gmail.search',
        { query: read.mailQuery },
        {
          results: [{ threadId: 'only-flight-thread', subject: 'Lufthansa booking confirmation' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.read_thread',
        { threadId: 'only-flight-thread' },
        {
          complete: true,
          messages: [
            {
              messageId: 'only-flight-message',
              subject: 'Lufthansa booking confirmation',
              text: flightText,
            },
          ],
        },
      ),
    ];
    const lodging = {
      eventId: 'neutral-title-lodging',
      summary: 'Northstar Collection',
      description: 'Hotel reservation details include a Berlin stay and a reference TRIP-44119.',
      location: 'Berlin, Germany',
      start: { date: '2026-10-17' },
      end: { date: '2026-10-19' },
      links: [{ type: 'calendar', url: 'https://calendar.google.com/calendar/event?eid=neutral' }],
    };
    const evidence = [completeCalendarEvents([calendarFlight(), lodging]), ...flightEmailEvidence];
    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.calendarLodgingObservation).toMatchObject({
      title: 'Northstar Collection',
      city: 'Berlin',
      association: 'date_city_candidate',
    });
    expect(projection.hotel).toBeUndefined();
    expect(projection.text).toContain('Calendar lodging candidate, not a confirmed hotel booking');
    expect(projection.text).not.toContain('include a Berlin stay');
    expect(compoundTripRoute(read, evidence)).toBeUndefined();

    const descriptionOnlyAssociation = {
      ...lodging,
      eventId: 'description-only-association',
      location: '100 Main Street',
    };
    const noAssociationEvidence = [
      completeCalendarEvents([calendarFlight(), descriptionOnlyAssociation]),
      ...flightEmailEvidence,
    ];
    const unassociated = compoundTripReadProjection(read, noAssociationEvidence);
    expect(unassociated.calendarLodgingObservation).toBeUndefined();
    expect(compoundTripRoute(read, noAssociationEvidence)).toBeUndefined();
  });

  it('does not route from a booking-linked flight when its calendar arrival airport conflicts', () => {
    const read = request();
    const conflictingCalendarFlight = {
      ...calendarFlight(),
      description: 'Arrival airport: JFK. Booking reference: FLIGHT-728.',
    };
    const evidence = [
      completeCalendarEvents([conflictingCalendarFlight]),
      ...bookingEmailEvidence(),
      row(
        'maps.directions',
        { origin: 'JFK Airport', destination: 'Linienstraße 89, 10119 Berlin', mode: 'driving' },
        { durationSeconds: 1500 },
      ),
    ];
    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.flight?.segment?.destinationAirport).toBe('BER');
    expect(projection.flight?.calendarConflicts).toContain('arrival-airport');
    expect(projection.hotel?.association).toBe('date_city_candidate');
    expect(projection.routeOrigin).toBeUndefined();
    expect(compoundTripRoute(read, evidence)).toBeUndefined();
  });

  it('does not call an already-departed same-day booking the next trip', () => {
    const base = request();
    const read = {
      ...base,
      timeWindow: {
        timeMin: '2026-10-17T12:00:00.000Z',
        timeMax: '2027-10-17T12:00:00.000Z',
        label: 'next year',
      },
    };
    const evidence: ReadToolEvidence[] = [
      row(
        'calendar.list_events',
        { timeMin: read.timeWindow.timeMin, timeMax: read.timeWindow.timeMax },
        {
          events: [calendarFlight()],
          complete: true,
          calendarRosterComplete: true,
          unavailable: [],
        },
      ),
      ...bookingEmailEvidence(),
    ];
    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.flight).toBeUndefined();
    expect(projection.currentTripReturn).toBeUndefined();
    expect(projection.text).toContain('could not match a dated outbound leg');
  });

  it('matches a same-day connected return by its unique origin and keeps the calendar carrier and clock conflicts visible', () => {
    const read = request();
    const reference = 'SAMPLE-TRIP-55';
    const firstQuote = `KLM KL 401. Return flight. Departure date: 2026-11-15. Departure time: 06:00 Europe/Amsterdam. Arrival date: 2026-11-15. Arrival time: 06:10 Europe/London. From: AMS. To: LHR. Booking reference: ${reference}.`;
    const secondQuote = `Return flight BA 117. Departure date: 2026-11-15. Departure time: 07:15 Europe/London. Arrival date: 2026-11-15. Arrival time: 10:25 America/New_York. From: LHR. To: JFK. Booking reference: ${reference}. British Airways.`;
    const event = {
      eventId: 'connected-return-calendar-event',
      summary: 'AMS → JFK flight (United Airlines)',
      description: `Booking reference: ${reference}. AMS to JFK.`,
      start: '2026-11-15T06:10:00+01:00',
      timeZone: 'Europe/Amsterdam',
      links: [
        {
          type: 'calendar',
          url: 'https://calendar.google.com/calendar/event?eid=connected-return',
        },
      ],
    };
    const flightQuery = read.mailQueries?.find((query) => query.category === 'flight');
    if (!flightQuery) throw new Error('Expected a flight booking search');
    const evidence = addEmptyCompletedMailQueries(
      [
        completeCalendarEvents([event]),
        row(
          'gmail.search',
          { query: flightQuery.query },
          {
            results: [{ threadId: 'connected-return-thread', subject: 'Return itinerary' }],
            complete: true,
            hasMore: false,
          },
        ),
        row(
          'gmail.read_thread',
          { threadId: 'connected-return-thread' },
          {
            complete: true,
            messages: [
              {
                messageId: 'connected-return-message',
                subject: 'Return itinerary',
                text: `${firstQuote}\n${secondQuote}`,
              },
            ],
          },
        ),
      ],
      read,
    );
    const extraction: CompoundTripExtraction = {
      status: 'complete',
      segments: [
        {
          threadId: 'connected-return-thread',
          messageId: 'connected-return-message',
          subject: 'Return itinerary',
          flightNumber: 'KL401',
          direction: 'return',
          departureDate: '2026-11-15',
          departureTime: '06:00',
          departureTimeZone: 'Europe/Amsterdam',
          arrivalDate: '2026-11-15',
          arrivalTime: '06:10',
          arrivalTimeZone: 'Europe/London',
          originAirport: 'AMS',
          destinationAirport: 'LHR',
          bookingReference: reference,
          excerpt: firstQuote,
        },
        {
          threadId: 'connected-return-thread',
          messageId: 'connected-return-message',
          subject: 'Return itinerary',
          flightNumber: 'BA117',
          direction: 'return',
          departureDate: '2026-11-15',
          departureTime: '07:15',
          departureTimeZone: 'Europe/London',
          arrivalDate: '2026-11-15',
          arrivalTime: '10:25',
          arrivalTimeZone: 'America/New_York',
          originAirport: 'LHR',
          destinationAirport: 'JFK',
          bookingReference: reference,
          excerpt: secondQuote,
        },
      ],
      hotels: [],
      rejectedFacts: 0,
      sourceMessageIds: ['connected-return-message'],
    };
    const projection = upcomingFlightReadProjection(read, evidence, extraction);
    const tripProjection = compoundTripReadProjection(read, evidence, extraction);

    expect(projection.flight?.segment).toMatchObject({
      flightNumber: 'KL401',
      direction: 'return',
      originAirport: 'AMS',
    });
    expect(projection.flight?.calendarConflicts).toContain('carrier');
    expect(projection.text).toContain('Next matched future return flight');
    expect(projection.text).toContain('Source-backed connected flight segments');
    expect(projection.text).toContain('KL401 AMS→LHR');
    expect(projection.text).toContain('BA117 LHR→JFK');
    expect(projection.text).toContain('Source conflict: the calendar names United Airlines');
    expect(projection.text).toContain('booking email names KLM');
    expect(projection.text).toContain(
      'Source conflict: the calendar event time differs from the booking departure time',
    );
    expect(tripProjection.flight).toBeUndefined();
    expect(tripProjection.currentTripReturn?.segment?.flightNumber).toBe('KL401');
    expect(tripProjection.text).toContain('Source-backed return connections');
    expect(tripProjection.text).toContain('BA117 LHR→JFK');
    expect(tripProjection.text).toContain('This does not identify a new outbound trip.');
  });

  it('binds a calendar carrier label to the uniquely matched flight in a multi-flight title', () => {
    const read = request();
    const reference = 'MULTIFLIGHT56';
    const quote = `Return flight BA117. Departure date: 2026-11-15. Departure time: 07:15 Europe/London. Arrival date: 2026-11-15. Arrival time: 10:25 America/New_York. From: LHR. To: JFK. Booking reference: ${reference}. Operated by British Airways.`;
    const event = {
      eventId: 'multi-flight-title-event',
      summary: 'KL401 flight (KLM); BA117 flight (United Airlines); return LHR → JFK flight',
      description: `Booking reference: ${reference}`,
      start: '2026-11-15T07:15:00Z',
      timeZone: 'Europe/London',
    };
    const flightQuery = read.mailQueries?.find((query) => query.category === 'flight');
    if (!flightQuery) throw new Error('Expected a flight booking search');
    const evidence = addEmptyCompletedMailQueries(
      [
        completeCalendarEvents([event]),
        row(
          'gmail.search',
          { query: flightQuery.query },
          {
            results: [{ threadId: 'multi-flight-title-thread', subject: 'Return itinerary' }],
            complete: true,
            hasMore: false,
          },
        ),
        row(
          'gmail.read_thread',
          { threadId: 'multi-flight-title-thread' },
          {
            complete: true,
            messages: [
              {
                messageId: 'multi-flight-title-message',
                subject: 'Return itinerary',
                text: quote,
              },
            ],
          },
        ),
      ],
      read,
    );
    const extraction: CompoundTripExtraction = {
      status: 'complete',
      segments: [
        {
          threadId: 'multi-flight-title-thread',
          messageId: 'multi-flight-title-message',
          subject: 'Return itinerary',
          flightNumber: 'BA117',
          direction: 'return',
          departureDate: '2026-11-15',
          departureTime: '07:15',
          departureTimeZone: 'Europe/London',
          arrivalDate: '2026-11-15',
          arrivalTime: '10:25',
          arrivalTimeZone: 'America/New_York',
          originAirport: 'LHR',
          destinationAirport: 'JFK',
          bookingReference: reference,
          excerpt: quote,
        },
      ],
      hotels: [],
      rejectedFacts: 0,
      sourceMessageIds: ['multi-flight-title-message'],
    };

    const projection = upcomingFlightReadProjection(read, evidence, extraction);

    expect(projection.flight?.segment?.flightNumber).toBe('BA117');
    expect(projection.flight?.calendarConflicts).toContain('carrier');
    expect(projection.flight?.calendarConflicts).toContain('flight-number');
    expect(projection.text).toContain('the calendar names United Airlines');
    expect(projection.text).toContain('the booking email names British Airways');
    expect(projection.text).not.toContain('the calendar names KLM');
  });

  it('keeps a later round-trip return separate from an outbound itinerary connection', () => {
    const read = request();
    const reference = 'RTDIRECTION56';
    const outboundQuote = `Outbound flight LH401. Departure date: 2026-10-17. Departure time: 08:00 America/Los_Angeles. Arrival date: 2026-10-18. Arrival time: 09:00 Europe/Berlin. From: SFO. To: BER. Booking reference: ${reference}.`;
    const returnQuote = `Return flight LH402. Departure date: 2026-10-19. Departure time: 12:00 Europe/Berlin. Arrival date: 2026-10-19. Arrival time: 15:00 America/Los_Angeles. From: BER. To: SFO. Booking reference: ${reference}.`;
    const events = [
      {
        eventId: 'round-trip-direction-outbound',
        summary: 'Outbound flight LH401 SFO → BER',
        description: `Arrival airport: BER. Booking reference: ${reference}`,
        start: '2026-10-17T08:00:00-07:00',
        timeZone: 'America/Los_Angeles',
      },
      {
        eventId: 'round-trip-direction-return',
        summary: 'Return flight LH402 BER → SFO',
        description: `Departure airport: BER. Booking reference: ${reference}`,
        start: '2026-10-19T12:00:00+02:00',
        timeZone: 'Europe/Berlin',
      },
    ];
    const flightQuery = read.mailQueries?.find((query) => query.category === 'flight');
    if (!flightQuery) throw new Error('Expected a flight booking search');
    const evidence = addEmptyCompletedMailQueries(
      [
        completeCalendarEvents(events),
        row(
          'gmail.search',
          { query: flightQuery.query },
          {
            results: [{ threadId: 'round-trip-direction-thread', subject: 'Flight itinerary' }],
            complete: true,
            hasMore: false,
          },
        ),
        row(
          'gmail.read_thread',
          { threadId: 'round-trip-direction-thread' },
          {
            complete: true,
            messages: [
              {
                messageId: 'round-trip-direction-message',
                subject: 'Flight itinerary',
                text: `${outboundQuote}\n${returnQuote}`,
              },
            ],
          },
        ),
      ],
      read,
    );
    const extraction: CompoundTripExtraction = {
      status: 'complete',
      segments: [
        {
          threadId: 'round-trip-direction-thread',
          messageId: 'round-trip-direction-message',
          subject: 'Flight itinerary',
          flightNumber: 'LH401',
          direction: 'outbound',
          departureDate: '2026-10-17',
          departureTime: '08:00',
          departureTimeZone: 'America/Los_Angeles',
          arrivalDate: '2026-10-18',
          arrivalTime: '09:00',
          arrivalTimeZone: 'Europe/Berlin',
          originAirport: 'SFO',
          destinationAirport: 'BER',
          bookingReference: reference,
          excerpt: outboundQuote,
        },
        {
          threadId: 'round-trip-direction-thread',
          messageId: 'round-trip-direction-message',
          subject: 'Flight itinerary',
          flightNumber: 'LH402',
          direction: 'return',
          departureDate: '2026-10-19',
          departureTime: '12:00',
          departureTimeZone: 'Europe/Berlin',
          arrivalDate: '2026-10-19',
          arrivalTime: '15:00',
          arrivalTimeZone: 'America/Los_Angeles',
          originAirport: 'BER',
          destinationAirport: 'SFO',
          bookingReference: reference,
          excerpt: returnQuote,
        },
      ],
      hotels: [],
      rejectedFacts: 0,
      sourceMessageIds: ['round-trip-direction-message'],
    };

    const upcoming = upcomingFlightReadProjection(read, evidence, extraction);
    const trip = compoundTripReadProjection(read, evidence, extraction);

    expect(upcoming.flight?.segment?.flightNumber).toBe('LH401');
    expect(upcoming.text).not.toContain('Source-backed connected flight segments');
    expect(trip.flight?.segment?.flightNumber).toBe('LH401');
    expect(trip.returnFlight?.segment?.flightNumber).toBe('LH402');
    expect(trip.text).toContain('Dated return leg from the same booking: LH402 BER→SFO');
    expect(trip.text).not.toContain('Source-backed connection chain: LH401 SFO→BER; LH402 BER→SFO');
  });

  it('keeps a same-origin return tie ambiguous even when the calendar reference and date match', () => {
    const read = request();
    const reference = 'SAMPLE-TIE-55';
    const segments = [
      {
        threadId: 'tied-return-thread',
        messageId: 'tied-return-message',
        subject: 'Itinerary',
        flightNumber: 'KL401',
        direction: 'return' as const,
        departureDate: '2026-11-15',
        departureTime: '06:00',
        departureTimeZone: 'Europe/Amsterdam',
        arrivalDate: '2026-11-15',
        arrivalTime: '07:00',
        arrivalTimeZone: 'Europe/London',
        originAirport: 'AMS',
        destinationAirport: 'LHR',
        bookingReference: reference,
        excerpt: `Return flight KL401. Departure date: 2026-11-15. Departure time: 06:00 Europe/Amsterdam. Arrival date: 2026-11-15. Arrival time: 07:00 Europe/London. From: AMS. To: LHR. Booking reference: ${reference}.`,
      },
      {
        threadId: 'tied-return-thread',
        messageId: 'tied-return-message',
        subject: 'Itinerary',
        flightNumber: 'KL402',
        direction: 'return' as const,
        departureDate: '2026-11-15',
        departureTime: '06:00',
        departureTimeZone: 'Europe/Amsterdam',
        arrivalDate: '2026-11-15',
        arrivalTime: '07:10',
        arrivalTimeZone: 'Europe/London',
        originAirport: 'AMS',
        destinationAirport: 'LGW',
        bookingReference: reference,
        excerpt: `Return flight KL402. Departure date: 2026-11-15. Departure time: 06:00 Europe/Amsterdam. Arrival date: 2026-11-15. Arrival time: 07:10 Europe/London. From: AMS. To: LGW. Booking reference: ${reference}.`,
      },
    ];
    const flightQuery = read.mailQueries?.find((query) => query.category === 'flight');
    if (!flightQuery) throw new Error('Expected a flight booking search');
    const evidence = addEmptyCompletedMailQueries(
      [
        completeCalendarEvents([
          {
            eventId: 'tied-return-event',
            summary: 'AMS → JFK flight',
            description: `Booking reference: ${reference}. AMS to JFK.`,
            start: '2026-11-15T06:00:00+01:00',
          },
        ]),
        row(
          'gmail.search',
          { query: flightQuery.query },
          {
            results: [{ threadId: 'tied-return-thread', subject: 'Itinerary' }],
            complete: true,
            hasMore: false,
          },
        ),
        row(
          'gmail.read_thread',
          { threadId: 'tied-return-thread' },
          {
            complete: true,
            messages: [
              {
                messageId: 'tied-return-message',
                subject: 'Itinerary',
                text: segments.map((segment) => segment.excerpt).join('\n'),
              },
            ],
          },
        ),
      ],
      read,
    );
    const projection = upcomingFlightReadProjection(read, evidence, {
      status: 'complete',
      segments,
      hotels: [],
      rejectedFacts: 0,
      sourceMessageIds: ['tied-return-message'],
    });

    expect(projection.flight).toBeUndefined();
    expect(projection.text).toContain(
      'More than one separate future booking segment has the same departure instant',
    );
  });

  it.each(['unknown continuation time', 'tied continuation routes'] as const)(
    'does not claim a complete return connection chain when continuation evidence is %s',
    (caseName) => {
      const read = request();
      const reference = 'SAMPLE-CHAIN-55';
      const leadQuote = `KLM KL401. Return flight. Departure date: 2026-11-15. Departure time: 06:00 Europe/Amsterdam. Arrival date: 2026-11-15. Arrival time: 06:10 Europe/London. From: AMS. To: LHR. Booking reference: ${reference}.`;
      const unknownContinuation = caseName === 'unknown continuation time';
      const continuationQuotes = unknownContinuation
        ? [
            `Connecting flight BA117. Departure date: 2026-11-15. Departure time: 07:15. Arrival date: 2026-11-15. Arrival time: 10:25 America/New_York. From: LHR. To: JFK. Booking reference: ${reference}.`,
          ]
        : [
            `Connecting flight BA117. Departure date: 2026-11-15. Departure time: 07:15 Europe/London. Arrival date: 2026-11-15. Arrival time: 10:25 America/New_York. From: LHR. To: JFK. Booking reference: ${reference}.`,
            `Connecting flight BA118. Departure date: 2026-11-15. Departure time: 07:15 Europe/London. Arrival date: 2026-11-15. Arrival time: 10:40 America/New_York. From: LHR. To: EWR. Booking reference: ${reference}.`,
          ];
      const followUps = continuationQuotes.map((excerpt, index) => ({
        threadId: 'uncertain-return-thread',
        messageId: 'uncertain-return-message',
        subject: 'Return itinerary',
        flightNumber: index === 0 ? 'BA117' : 'BA118',
        direction: 'connection' as const,
        departureDate: '2026-11-15',
        departureTime: '07:15',
        ...(!unknownContinuation ? { departureTimeZone: 'Europe/London' } : {}),
        arrivalDate: '2026-11-15',
        arrivalTime: index === 0 ? '10:25' : '10:40',
        arrivalTimeZone: 'America/New_York',
        originAirport: 'LHR',
        destinationAirport: index === 0 ? 'JFK' : 'EWR',
        bookingReference: reference,
        excerpt,
      }));
      const flightQuery = read.mailQueries?.find((query) => query.category === 'flight');
      if (!flightQuery) throw new Error('Expected a flight booking search');
      const evidence = addEmptyCompletedMailQueries(
        [
          completeCalendarEvents([
            {
              eventId: 'uncertain-return-event',
              summary: 'AMS → JFK flight',
              description: `Booking reference: ${reference}. AMS to JFK.`,
              start: '2026-11-15T06:10:00+01:00',
            },
          ]),
          row(
            'gmail.search',
            { query: flightQuery.query },
            {
              results: [{ threadId: 'uncertain-return-thread', subject: 'Return itinerary' }],
              complete: true,
              hasMore: false,
            },
          ),
          row(
            'gmail.read_thread',
            { threadId: 'uncertain-return-thread' },
            {
              complete: true,
              messages: [
                {
                  messageId: 'uncertain-return-message',
                  subject: 'Return itinerary',
                  text: [leadQuote, ...continuationQuotes].join('\n'),
                },
              ],
            },
          ),
        ],
        read,
      );
      const projection = upcomingFlightReadProjection(read, evidence, {
        status: 'complete',
        segments: [
          {
            threadId: 'uncertain-return-thread',
            messageId: 'uncertain-return-message',
            subject: 'Return itinerary',
            flightNumber: 'KL401',
            direction: 'return',
            departureDate: '2026-11-15',
            departureTime: '06:00',
            departureTimeZone: 'Europe/Amsterdam',
            arrivalDate: '2026-11-15',
            arrivalTime: '06:10',
            arrivalTimeZone: 'Europe/London',
            originAirport: 'AMS',
            destinationAirport: 'LHR',
            bookingReference: reference,
            excerpt: leadQuote,
          },
          ...followUps,
        ],
        hotels: [],
        rejectedFacts: 0,
        sourceMessageIds: ['uncertain-return-message'],
      });

      expect(projection.flight?.segment?.flightNumber).toBe('KL401');
      expect(projection.flight?.itineraryConnectionChainComplete).toBe(false);
      expect(projection.text).toContain(
        'The booking source does not establish a complete dated connection chain',
      );
      expect(projection.text).not.toContain('Source-backed connected flight segments');
    },
  );

  it('does not use an unrelated footer year to infer hotel stay dates', () => {
    const read = request();
    const evidence = [
      completeCalendarEvents([calendarFlight()]),
      ...bookingEmailEvidence({
        hotelBody:
          'Reservation confirmed: Hotel Linden, Berlin.\nDates: October 16–18.\nAddress: Linienstraße 89, 10119 Berlin.\nCopyright 2028 Hotel Group.',
      }),
    ];
    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.hotel?.checkIn).toBeUndefined();
    expect(projection.hotel?.checkOut).toBeUndefined();
    expect(projection.text).toContain('hotel stay dates were not both explicit');
  });

  it('quotes fetched public sources and compares route-relevant fares and durations when each page supports them', () => {
    const read = request();
    const base: ReadToolEvidence[] = [
      completeCalendarEvents([calendarFlight()]),
      ...bookingEmailEvidence(),
    ];
    const webQuery = compoundTripReadProjection(read, base).webQuery;
    if (!webQuery) throw new Error('Expected grounded route search query');
    const transitUrl = 'https://transit.example/berlin';
    const taxiUrl = 'https://taxi.example/berlin';
    const search = row(
      'web.search',
      { query: webQuery },
      {
        results: [
          {
            title: 'Official BER airport rail',
            url: transitUrl,
            snippet: 'Public transport from BER Airport to Hotel Linden, Linienstraße 89, Berlin.',
          },
          {
            title: 'Taxi operator fare estimate',
            url: taxiUrl,
            snippet: 'Taxi from BER Airport to Hotel Linden, Linienstraße 89, Berlin.',
          },
        ],
      },
    );
    const evidence = [
      ...base,
      search,
      row(
        'web.fetch',
        { url: transitUrl },
        {
          status: 200,
          finalUrl: transitUrl,
          text: 'Public transport from BER Airport to Hotel Linden at Linienstraße 89, Berlin takes 35 minutes and costs €4.90 for this route.',
        },
      ),
      row(
        'web.fetch',
        { url: taxiUrl },
        {
          status: 200,
          finalUrl: taxiUrl,
          text: 'Taxi from BER Airport to Hotel Linden at Linienstraße 89, Berlin usually takes 45 minutes and costs EUR 62.00.',
        },
      ),
    ];
    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.comparison).toEqual([
      expect.objectContaining({
        mode: 'public transport',
        endpointMatched: true,
        fare: 'EUR 4.90',
        duration: '35 minutes',
        url: transitUrl,
      }),
      expect.objectContaining({
        mode: 'taxi',
        endpointMatched: true,
        fare: 'EUR 62.00',
        duration: '45 minutes',
        url: taxiUrl,
      }),
    ]);
    expect(projection.text).toContain('source-reported fare EUR 4.90');
    expect(projection.text).toContain('source-reported fare EUR 62.00');
    expect(projection.text).toContain(
      '“Public transport from BER Airport to Hotel Linden at Linienstraße 89, Berlin takes 35 minutes and costs €4.90 for this route.”',
    );
  });

  it('does not complete the hotel transfer comparison from city-only estimates', () => {
    const read = request();
    const base: ReadToolEvidence[] = [
      completeCalendarEvents([calendarFlight()]),
      ...bookingEmailEvidence(),
    ];
    const webQuery = compoundTripReadProjection(read, base).webQuery;
    if (!webQuery) throw new Error('Expected grounded route search query');
    const transitUrl = 'https://transit.example/berlin';
    const taxiUrl = 'https://taxi.example/berlin';
    const evidence = [
      ...base,
      row(
        'web.search',
        { query: webQuery },
        {
          results: [
            {
              title: 'Airport rail',
              url: transitUrl,
              snippet: 'BER Airport to Berlin city center.',
            },
            { title: 'Taxi estimate', url: taxiUrl, snippet: 'BER Airport to Berlin city center.' },
          ],
        },
      ),
      row(
        'web.fetch',
        { url: transitUrl },
        {
          status: 200,
          finalUrl: transitUrl,
          text: 'Public transport from BER Airport to Berlin takes 35 minutes and costs EUR 4.90.',
        },
      ),
      row(
        'web.fetch',
        { url: taxiUrl },
        {
          status: 200,
          finalUrl: taxiUrl,
          text: 'Taxi from BER Airport to Berlin takes 45 minutes and costs EUR 62.00.',
        },
      ),
    ];

    const projection = compoundTripReadProjection(read, evidence);

    expect(projection.comparison).toEqual([
      expect.objectContaining({ mode: 'public transport', endpointMatched: false }),
      expect.objectContaining({ mode: 'taxi', endpointMatched: false }),
    ]);
    expect(projection.blocked).toBe(true);
    expect(projection.text).toContain('did not establish both route endpoints');
    expect(projection.text).not.toContain('source-reported fare EUR 4.90');
    expect(projection.text).not.toContain('source-reported fare EUR 62.00');
  });

  it('does not treat a hotel route sentence naming Berlin as proof of the BER airport endpoint', () => {
    const read = request();
    const base: ReadToolEvidence[] = [
      completeCalendarEvents([calendarFlight()]),
      ...bookingEmailEvidence(),
    ];
    const webQuery = compoundTripReadProjection(read, base).webQuery;
    if (!webQuery) throw new Error('Expected grounded route search query');
    const transitUrl = 'https://transit.example/hotel-route';
    const taxiUrl = 'https://taxi.example/hotel-route';
    const evidence = [
      ...base,
      row(
        'web.search',
        { query: webQuery },
        {
          results: [
            { title: 'Berlin transit to Hotel Linden', url: transitUrl },
            { title: 'Berlin taxi to Hotel Linden', url: taxiUrl },
          ],
        },
      ),
      row(
        'web.fetch',
        { url: transitUrl },
        {
          status: 200,
          finalUrl: transitUrl,
          text: 'Public transport from Berlin city center to Hotel Linden at Linienstraße 89 takes 35 minutes and costs EUR 4.90.',
        },
      ),
      row(
        'web.fetch',
        { url: taxiUrl },
        {
          status: 200,
          finalUrl: taxiUrl,
          text: 'Taxi from Berlin city center to Hotel Linden at Linienstraße 89 takes 45 minutes and costs EUR 62.00.',
        },
      ),
    ];

    const projection = compoundTripReadProjection(read, evidence);

    expect(projection.comparison).toEqual([
      expect.objectContaining({ mode: 'public transport', endpointMatched: false }),
      expect.objectContaining({ mode: 'taxi', endpointMatched: false }),
    ]);
    expect(projection.blocked).toBe(true);
    expect(projection.text).toContain('did not establish both route endpoints');
    expect(projection.text).not.toContain('source-reported fare EUR 4.90');
    expect(projection.text).not.toContain('source-reported fare EUR 62.00');
  });

  it('does not skip an earlier unlinked outbound email to select a later calendar flight', () => {
    const read = request();
    const evidence = [
      completeCalendarEvents([{ ...calendarFlight(), start: '2026-11-02T10:10:00+01:00' }]),
      row(
        'gmail.search',
        { query: read.mailQuery },
        {
          results: [{ threadId: 'future-bookings', subject: 'Flight bookings' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.read_thread',
        { threadId: 'future-bookings' },
        {
          complete: true,
          messages: [
            {
              messageId: 'future-bookings-message',
              subject: 'Flight bookings',
              text: 'Outbound\nFlight number: LH 201\nDeparture date: 2026-10-20\nDeparture time: 09:00 Europe/Berlin\nFrom: SFO\nTo: LHR\nBooking reference: FIRST-8811\nOutbound\nFlight number: LH 777\nDeparture date: 2026-11-02\nDeparture time: 10:10 Europe/Berlin\nFrom: SFO\nTo: BER\nBooking reference: SECOND-8822',
            },
          ],
        },
      ),
    ];
    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.flight).toBeUndefined();
    expect(projection.text).toContain('A return event or a flight number alone is not enough');
  });

  it('does not attach a flight confirmation by repeated flight number when the civil departure date differs', () => {
    const read = request();
    const evidence = [
      completeCalendarEvents([{ ...calendarFlight(), start: '2026-10-17T10:10:00+02:00' }]),
      row(
        'gmail.search',
        { query: read.mailQuery },
        {
          results: [{ threadId: 'different-date', subject: 'Flight confirmation' }],
          complete: true,
          hasMore: false,
        },
      ),
      row(
        'gmail.read_thread',
        { threadId: 'different-date' },
        {
          complete: true,
          messages: [
            {
              messageId: 'different-date-message',
              subject: 'Flight confirmation',
              text: 'Outbound\nFlight number: LH 777\nDeparture date: 2026-10-18\nDeparture time: 10:10 Europe/Berlin\nFrom: SFO\nTo: BER\nBooking reference: FLIGHT-728',
            },
          ],
        },
      ),
    ];
    expect(compoundTripReadProjection(read, evidence).flight).toBeUndefined();
  });

  it('reports an actual calendar-versus-booking time conflict only after both zones normalize', () => {
    const read = request();
    const calendar = completeCalendarEvents([
      { ...calendarFlight(), start: '2026-10-17T11:10:00+02:00' },
    ]);
    const projection = compoundTripReadProjection(read, [calendar, ...bookingEmailEvidence()]);
    expect(projection.text).toContain('clocks conflict after time-zone conversion');
  });

  it('shows bounded calendar-only observations when coverage is partial without promoting them', () => {
    const read = request();
    const flight = {
      ...calendarFlight(),
      summary: 'Flight <Lufthansa> [fake](https://attacker.example)',
      description: 'Not a return flight. Private notes must not be copied into the observation.',
      eventId: 'partial-flight',
      links: [{ type: 'calendar', url: 'https://www.google.com/calendar/event?eid=partial' }],
    };
    const lodging = {
      eventId: 'active-stay',
      summary: 'Hotel [fake](https://attacker.example) <Berlin>',
      description: 'Private lodging details are not part of the short observation.',
      start: { date: '2026-10-10' },
      end: { date: '2026-10-20' },
      status: 'confirmed',
      links: [{ type: 'calendar', url: 'https://calendar.google.com/calendar/event?eid=stay' }],
    };
    const rejectedEvents = [
      {
        ...calendarFlight(),
        eventId: 'cancelled-flight',
        summary: 'Flight cancelled',
        status: 'cancelled',
      },
      {
        ...calendarFlight(),
        eventId: 'unsafe-link-flight',
        summary: 'Unsafe-link flight',
        start: '2026-10-18T10:10:00+02:00',
        links: [{ type: 'calendar', url: 'https://attacker.example/calendar/event?eid=x' }],
      },
      {
        ...calendarFlight(),
        eventId: 'missing-link-flight',
        summary: 'Missing-link flight',
        start: '2026-10-19T10:10:00+02:00',
        links: [],
      },
      {
        ...calendarFlight(),
        eventId: 'out-of-window-flight',
        summary: 'Out-of-window flight',
        start: '2027-02-10T10:10:00+01:00',
      },
      {
        eventId: 'cancelled-hotel',
        summary: 'Cancelled hotel stay',
        start: { date: '2026-10-10' },
        end: { date: '2026-10-20' },
        status: 'cancelled',
        links: [{ type: 'calendar', url: 'https://calendar.google.com/calendar/event?eid=cancel' }],
      },
      {
        eventId: 'out-of-window-hotel',
        summary: 'Out-of-window hotel stay',
        start: { date: '2027-02-10' },
        end: { date: '2027-02-12' },
        status: 'confirmed',
        links: [{ type: 'calendar', url: 'https://calendar.google.com/calendar/event?eid=future' }],
      },
    ];
    const partialPage = (events: unknown[], pageToken: string) =>
      row(
        'calendar.list_events',
        { timeMin: read.timeWindow?.timeMin, timeMax: read.timeWindow?.timeMax },
        {
          events,
          complete: false,
          calendarRosterComplete: true,
          unavailable: [],
          nextPageToken: pageToken,
        },
      );
    const projection = compoundTripReadProjection(read, [
      partialPage([flight, lodging, ...rejectedEvents], 'page-2'),
      partialPage([flight], 'page-3'),
      {
        ...partialPage([calendarFlight()], 'page-ignored'),
        args: {
          timeMin: new Date(Date.parse(read.timeWindow?.timeMin ?? '') + 1_000).toISOString(),
          timeMax: read.timeWindow?.timeMax,
        },
      },
      {
        ...partialPage([calendarFlight()], 'page-other-task'),
        fromCurrentTask: false,
      },
    ]);

    expect(projection.calendarComplete).toBe(false);
    expect(projection.blocked).toBe(true);
    expect(projection.text).toContain('Calendar observations — not a verified next-trip itinerary');
    expect(projection.text).toContain('Flight calendar observation only');
    expect(projection.text).toContain('The calendar does not state its direction.');
    expect(projection.text).toContain('Lodging calendar observation only');
    expect(projection.text).toContain(
      'recorded calendar date/time fields 2026\\-10\\-10 to 2026\\-10\\-20',
    );
    expect(projection.text).toContain(
      'The end field is shown as recorded, not interpreted as checkout.',
    );
    expect(projection.text.match(/Flight calendar observation only/g)).toHaveLength(1);
    expect(projection.text.match(/Lodging calendar observation only/g)).toHaveLength(1);
    expect(projection.text).toContain('https://www.google.com/calendar/event?eid=partial');
    expect(projection.text).toContain('https://calendar.google.com/calendar/event?eid=stay');
    expect(projection.text).toContain('\\[fake\\]');
    expect(projection.text).not.toMatch(/(?<!\\)\[fake\]\(https:/);
    expect(projection.text).not.toContain('Private notes must not be copied');
    expect(projection.text).not.toContain('Private lodging details');
    expect(projection.text).not.toContain('Flight cancelled');
    expect(projection.text).not.toContain('Unsafe-link flight');
    expect(projection.text).not.toContain('Missing-link flight');
    expect(projection.text).not.toContain('Out-of-window flight');
    expect(projection.text).not.toContain('Cancelled hotel stay');
    expect(projection.text).not.toContain('Out-of-window hotel stay');
    expect(projection.text).not.toContain('Outbound flight LH 777 to Berlin');
    expect(projection.text).not.toContain('The next flight is');
  });

  it('labels an explicitly returned calendar flight without calling it the next itinerary', () => {
    const read = request();
    const returned = {
      ...calendarFlight(),
      summary: 'Flight LH 777',
      description: 'Return flight to SFO',
      eventId: 'calendar-return-only',
    };
    const projection = compoundTripReadProjection(read, [
      row(
        'calendar.list_events',
        { timeMin: read.timeWindow?.timeMin, timeMax: read.timeWindow?.timeMax },
        {
          events: [returned],
          complete: false,
          calendarRosterComplete: true,
          unavailable: [],
          nextPageToken: 'more-calendar-pages',
        },
      ),
    ]);

    expect(projection.text).toContain('Flight calendar observation only');
    expect(projection.text).toContain('The calendar labels its direction as a return.');
    expect(projection.text).not.toContain('Next matched future return flight');
  });

  it('keeps a one-day all-day lodging observation date-only', () => {
    const read = request();
    const projection = compoundTripReadProjection(read, [
      row(
        'calendar.list_events',
        { timeMin: read.timeWindow?.timeMin, timeMax: read.timeWindow?.timeMax },
        {
          events: [
            {
              eventId: 'one-day-stay',
              summary: 'Hotel reservation day',
              start: { date: '2026-10-17' },
              status: 'confirmed',
              links: [{ type: 'calendar', url: 'https://www.google.com/calendar/event?eid=day' }],
            },
          ],
          complete: false,
          calendarRosterComplete: true,
          unavailable: [],
          nextPageToken: 'more-calendar-pages',
        },
      ),
    ]);

    expect(projection.text).toContain('recorded calendar date/time fields 2026\\-10\\-17');
    expect(projection.text).not.toContain('to 2026\\-10\\-18');
    expect(projection.text).toContain('No end or checkout date is inferred.');
  });

  it('uses bounded description text only to classify a lodging observation', () => {
    const read = request();
    const evidence = [
      row(
        'calendar.list_events',
        { timeMin: read.timeWindow?.timeMin, timeMax: read.timeWindow?.timeMax },
        {
          events: [
            {
              eventId: 'unbranded-stay',
              summary: 'NH Collection Berlin',
              location: 'Berlin city center',
              description:
                'Hotel reservation details: a two-night stay, with private notes that must not be shown.',
              start: { date: '2026-10-17' },
              end: { date: '2026-10-19' },
              status: 'confirmed',
              links: [
                { type: 'calendar', url: 'https://calendar.google.com/calendar/event?eid=nh' },
              ],
            },
          ],
          complete: false,
          calendarRosterComplete: true,
          unavailable: [],
          nextPageToken: 'more-calendar-pages',
        },
      ),
    ];
    const projection = compoundTripReadProjection(read, evidence);

    expect(projection.hotel).toBeUndefined();
    expect(compoundTripRoute(read, evidence)).toBeUndefined();
    expect(projection.blocked).toBe(true);
    expect(projection.text).toContain('Lodging calendar observation only');
    expect(projection.text).toContain('NH Collection Berlin');
    expect(projection.text).toContain('https://calendar.google.com/calendar/event?eid=nh');
    expect(projection.text).not.toContain('Hotel reservation details');
    expect(projection.text).not.toContain('two-night stay');
    expect(projection.text).not.toContain('private notes that must not be shown');
  });

  it('does not invent calendar observations when a complete range has no matching records', () => {
    const projection = compoundTripReadProjection(request(), [completeCalendarEvents([])]);

    expect(projection.calendarComplete).toBe(true);
    expect(projection.text).not.toContain('Calendar observations —');
    expect(projection.text).not.toContain('Flight calendar observation only');
    expect(projection.text).not.toContain('Lodging calendar observation only');
  });
});
