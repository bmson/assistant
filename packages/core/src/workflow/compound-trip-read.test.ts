import { describe, expect, it } from 'vitest';
import {
  compoundTripFetchTargets,
  compoundTripReadProjection,
  compoundTripRoute,
  upcomingFlightReadProjection,
} from './compound-trip-read.js';
import {
  buildReadToolInput,
  detectPersonalReadRequest,
  nextRequiredReadTool,
  type ReadToolEvidence,
} from './read-intent.js';

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
        unavailable,
        receipt: result.receipt ?? {
          version: 1,
          source: { kind: 'gmail-search', id: query },
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

function bookingEmailEvidence(options: { hotelBody?: string; includeFlight?: boolean } = {}) {
  const read = request();
  const flightThread = 'flight-booking-thread';
  const hotelThread = 'hotel-reservation-thread';
  const results = [
    ...(options.includeFlight === false
      ? []
      : [{ threadId: flightThread, subject: 'Lufthansa booking confirmation' }]),
    { threadId: hotelThread, subject: 'Hotel reservation confirmed' },
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
            subject: 'Reservation confirmed: Hotel Linden, Berlin',
            text:
              options.hotelBody ??
              'Reservation confirmed: Hotel Linden, Berlin.\nDates: October 17–19, 2026.\nAddress: Linienstraße 89, 10119 Berlin.\nBooking reference: HOTEL-55123',
          },
        ],
      },
    ),
  ] as ReadToolEvidence[];
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
    links: [{ type: 'calendar', url: 'https://calendar.google.com/calendar/event?eid=abc' }],
  };
}

describe('compound trip read projection', () => {
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

  it('keeps independent flight and hotel bookings as candidates and attempts only grounded endpoint reads', () => {
    const read = request();
    const evidence: ReadToolEvidence[] = [
      completeCalendarEvents([calendarFlight()]),
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
  });

  it('accepts common stay-date summaries but does not infer a street address or route from a city alone', () => {
    const read = request();
    const evidence = [
      completeCalendarEvents([calendarFlight()]),
      ...bookingEmailEvidence({
        hotelBody: 'Reservation confirmed: Hotel Linden, Berlin. Dates: October 16–18, 2026.',
      }),
    ];
    const projection = compoundTripReadProjection(read, evidence);
    expect(projection.hotel).toMatchObject({
      hotelName: 'Hotel Linden',
      city: 'Berlin',
      checkIn: '2026-10-16',
      checkOut: '2026-10-18',
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
    expect(projection.hotel?.association).toBe('unlinked');
    expect(projection.text).toContain(
      'could not establish that it belongs to this flight itinerary',
    );
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
    expect(firstLegHotel.hotel?.association).toBe('unlinked');
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
    expect(flightOnly.flight).toBeUndefined();
    expect(flightOnly.currentTripReturn?.segment?.flightNumber).toBe('LH777');
    expect(flightOnly.text).toContain('not evidence of a new outbound flight');
    expect(flightOnly.text).not.toContain('Next matched outbound flight');
    expect(flightOnly.text).not.toMatch(/hotel|taxi|public.transport/i);
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
});
