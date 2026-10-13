import { describe, expect, it } from 'vitest';
import {
  compoundTripFetchTargets,
  compoundTripReadProjection,
  compoundTripRoute,
} from './compound-trip-read.js';
import { detectPersonalReadRequest, type ReadToolEvidence } from './read-intent.js';

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
  return { toolName, status: 'succeeded', args, result, fromCurrentTask: true };
}

function completeCalendarEvents(events: unknown[]): ReadToolEvidence {
  const read = request();
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
                  subject: 'Lufthansa booking confirmation LH 777',
                  text: 'Booking confirmation for flight LH 777. Arrival airport: BER. Booking reference: FLIGHT-728.',
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
            subject: 'Reservation confirmed: Hotel Linden, Berlin',
            text:
              options.hotelBody ??
              'Reservation confirmed: Hotel Linden, Berlin.\nDates: October 16–18, 2026.\nAddress: Linienstraße 89, 10119 Berlin.',
          },
        ],
      },
    ),
  ] as ReadToolEvidence[];
}

function calendarFlight(): Record<string, unknown> {
  return {
    eventId: 'calendar-flight-1',
    summary: 'Flight to Berlin, LH 777',
    description: 'Arrival airport: BER',
    location: 'Berlin Brandenburg Airport',
    start: '2026-10-17T10:10:00+02:00',
    timeZone: 'Europe/Berlin',
    status: 'confirmed',
    links: [{ type: 'calendar', url: 'https://calendar.google.com/calendar/event?eid=abc' }],
  };
}

describe('compound trip read projection', () => {
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
    expect(projection.text).toContain('does not prove they are the same itinerary');
    expect(projection.text).toContain(
      'source timestamp offset +02:00; source time zone Europe/Berlin',
    );
    expect(projection.text).toContain('[Calendar source]');
    expect(projection.text).toContain('[email candidate sharing a flight identifier]');
    expect(projection.text).toContain('[Booking email]');
    expect(projection.text).toContain(
      'departure time zone and connection segments have not been normalized',
    );
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
});
