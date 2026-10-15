import { gmailSearchReceiptSourceId } from '@assistant/persistence/gmail-search-identity';

export const tripPrompt =
  'Find my next trip from my booking emails and calendar. Confirm the flight dates, departure times and time zones, connections, and hotel. Check for conflicting information. Then plan how to get from the destination airport to my hotel, comparing public transport and taxi. Give me a short itinerary with source links, and clearly mark anything you cannot verify.';

// Synthetic values; preserves the forwarded MIME/provider layout, including adjacent HTML cells.
export const bookedTable = `Forwarded message
From: Egencia <booking@example.test>
Booking Confirmation
Trip Booked
Itinerary/Egencia reference # 123456789012
[image: Flight] BOS to CPH #123456789012
November 9, 2030
Booked
Confirmation
*ZXCV12*
KLM KL700
Operated by KLM
DEPARTURE
Nov 9, 2030 at 1:45 pm
Boston, United States (BOS-Logan)
ARRIVAL +1
Nov 10, 2030 at 9:05 am
Amsterdam, Netherlands (AMS-Schiphol)
*Layover in Amsterdam AMS* 3h 10m
KLM KL701
Operated by KLM
DEPARTURE
Nov 10, 2030 at 12:15 pm
Amsterdam, Netherlands (AMS-Schiphol)
ARRIVAL
Nov 10, 2030 at 1:35 pm
Copenhagen, Denmark (CPH-Airport)
[image: Flight] CPH to BOS #123456789012
November 17, 2030
Booked
KLM KL702
Operated by KLM
DEPARTURE
Nov 17, 2030 at 6:00 am
Copenhagen, Denmark (CPH-Airport)
ARRIVAL
Nov 17, 2030 at 7:25 am
Amsterdam, Netherlands (AMS-Schiphol)
*Layover in Amsterdam AMS* 2h 25m
KLM KL703
Operated by KLM
DEPARTURE
Nov 17, 2030 at 9:50 am
Amsterdam, Netherlands (AMS-Schiphol)
ARRIVAL
Nov 17, 2030 at 11:45 am
Boston, United States (BOS-Logan)`;

export const bookedHotel = `Forwarded message
From: Egencia <booking@example.test>
Hotel (Booked)
Canal HouseCanal Street 42
Copenhagen <https://www.google.com/maps/search/Canal+Street+42++%0D%0ACopenhagen?entry=gmail&source=g>,
Copenhagen
1000
Phone Number: 00 1234 5678
Check-in: November 10, 2030
Check-out: November 17, 2030
# of nights: 7
Details
Itinerary number: 222333444555`;

export const tripTools = [
  'calendar.list_events',
  'gmail.search',
  'gmail.read_thread',
  'maps.directions',
  'web.search',
  'web.fetch',
];

export function tripSourceResult(tool: string, args: Record<string, unknown>) {
  if (tool === 'calendar.list_events')
    return {
      events: [
        {
          eventId: 'fixture-return',
          calendarId: 'owner',
          summary: 'CPH → BOS flight (Example Air)',
          description: 'Reference: ZXCV12 / Egencia 123456789012. Operated by Example Air.',
          start: '2030-11-16T21:10:00-05:00',
          end: '2030-11-17T08:15:00-05:00',
          links: [
            {
              type: 'calendar',
              url: 'https://calendar.google.com/calendar/event?eid=fixture-return',
            },
          ],
        },
      ],
      calendarsRequested: ['owner'],
      calendarsResolved: ['owner'],
      calendarsSearchedIds: ['owner'],
      calendarRosterComplete: true,
      unavailable: [],
      complete: true,
    };
  if (tool === 'gmail.search') {
    const query = String(args.query);
    const hotels = /hotel booking/.test(query);
    const results = [
      {
        threadId: hotels ? 'hotel-thread' : 'flight-thread',
        subject: hotels ? 'Hotel booked — Canal House' : 'Flight - BOOKED - Copenhagen',
      },
    ];
    return {
      query,
      complete: true,
      hasMore: false,
      results,
      unavailable: [],
      receipt: {
        version: 1,
        source: { kind: 'gmail-search', id: gmailSearchReceiptSourceId(query) },
        requested: { limit: args.maxResults, scope: 'query-page' },
        covered: { count: 1, total: 1, unavailable: 0 },
        complete: true,
        losses: [],
        continuation: null,
      },
    };
  }
  if (tool === 'gmail.read_thread') {
    const hotel = args.threadId === 'hotel-thread';
    const body = (hotel ? bookedHotel : bookedTable).replace(/\n/g, '\r\n');
    return {
      threadId: args.threadId,
      complete: true,
      hasMore: false,
      messages: [
        {
          messageId: hotel ? 'hotel-message' : 'flight-message',
          subject: hotel ? 'Hotel booked — Canal House' : 'Flight - BOOKED - Copenhagen',
          text: body,
          truncated: false,
          sourceLength: body.length,
        },
      ],
      receipt: {
        version: 1,
        source: { kind: 'gmail-thread', id: args.threadId },
        requested: { start: 0, offset: 0, limit: args.maxMessages, scope: 'thread-messages' },
        covered: { start: 0, offset: 0, end: 1, count: 1, total: 1, unavailable: 0 },
        complete: true,
        losses: [],
        continuation: null,
      },
    };
  }
  if (tool === 'maps.directions')
    return { durationSeconds: 1800, mapsUrl: 'https://maps.google.com/?q=fixture' };
  if (tool === 'web.search')
    return {
      results: [
        {
          title: 'Public transport airport route',
          url: 'https://transit.example/route',
          snippet: 'Public transport from CPH Airport to Canal House',
        },
        {
          title: 'Taxi airport route',
          url: 'https://taxi.example/route',
          snippet: 'Taxi from CPH Airport to Canal House',
        },
      ],
    };
  if (tool === 'web.fetch') {
    const taxi = String(args.url).includes('taxi');
    return {
      finalUrl: args.url,
      text: `${taxi ? 'Taxi' : 'Public transport'} from CPH Airport to Canal House at Canal Street 42, Copenhagen costs EUR ${taxi ? '45' : '5'} and takes ${taxi ? '30' : '40'} minutes.`,
    };
  }
  throw new Error(`Unexpected fixture tool ${tool}`);
}
