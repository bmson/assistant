import { describe, expect, it } from 'vitest';
import {
  availabilityResponseCards,
  calendarResponseCards,
  responseCardsForFinal,
  routeResponseCards,
  scoreboardResponseCards,
  searchResponseCards,
  sheetRowsResponseCards,
  statusResponseCards,
  threadResponseCards,
  weatherLookupResponseCards,
  weatherResponseCards,
} from './response-cards.js';

const request = {
  kind: 'calendar' as const,
  timeZone: 'America/Los_Angeles',
  queryTerms: [],
  firstToolName: 'calendar.list_events' as const,
  requiresThreadRead: false,
};

describe('response cards', () => {
  it.each([{ ok: false }, { status: 503 }, { deliveryStatus: 'unknown' }])(
    'does not render failed result bodies as verified cards: %j',
    (failure) => {
      const result = responseCardsForFinal({
        evidence: [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            result: {
              events: [{ summary: 'Lunch', start: '2026-09-08T19:00:00Z' }],
              ...failure,
            },
          },
          {
            toolName: 'docs.create',
            status: 'succeeded',
            result: { documentId: 'doc-1', title: 'Plan', ...failure },
          },
        ],
      });
      expect(result).toEqual([]);
    },
  );

  it('shows a fully opened mail result once through its thread card', () => {
    const cards = responseCardsForFinal({
      evidence: [
        {
          toolName: 'gmail.search',
          status: 'succeeded',
          args: { query: 'hotel' },
          result: { complete: true, results: [{ threadId: 'hotel-1', subject: 'Hotel' }] },
        },
        {
          toolName: 'gmail.read_thread',
          status: 'succeeded',
          args: { threadId: 'hotel-1' },
          result: { messages: [{ subject: 'Hotel', text: 'Check in September 5.' }] },
        },
      ],
    });
    expect(cards.map((card) => card.kind)).toEqual(['email-thread']);
    expect(cards[0]).toMatchObject({ messages: [{ excerpt: 'Check in September 5.' }] });
  });

  it.each([
    { complete: false, threadId: 'hotel-1', readStatus: 'succeeded', readText: 'Check in.' },
    { complete: true, threadId: 'unopened', readStatus: 'succeeded', readText: 'Check in.' },
    { complete: true, threadId: '', readStatus: 'succeeded', readText: 'Check in.' },
    { complete: true, threadId: 'hotel-1', readStatus: 'failed', readText: 'Check in.' },
    { complete: true, threadId: 'hotel-1', readStatus: 'succeeded', readText: '' },
  ])('preserves search coverage without a complete linked read: %j', (fixture) => {
    const cards = responseCardsForFinal({
      evidence: [
        {
          toolName: 'gmail.search',
          status: 'succeeded',
          result: {
            complete: fixture.complete,
            results: [{ threadId: fixture.threadId, subject: 'Hotel' }],
          },
        },
        {
          toolName: 'gmail.read_thread',
          status: fixture.readStatus,
          args: { threadId: 'hotel-1' },
          result: { messages: [{ subject: 'Hotel', text: fixture.readText }] },
        },
      ],
    });
    expect(cards.some((card) => card.kind === 'email-results')).toBe(true);
  });

  it.each([{ created: false }, { ok: false }])(
    'does not display a failed reminder creation as a saved reminder: %j',
    (failure) => {
      expect(
        responseCardsForFinal({
          evidence: [
            {
              toolName: 'reminder.create',
              status: 'succeeded',
              result: { reminderId: 'r1', text: 'Bring sunglasses', ...failure },
            },
          ],
        }),
      ).toEqual([]);
    },
  );
  it('merges obvious cross-calendar twins but keeps distinct appointments', () => {
    const result = calendarResponseCards(
      [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          result: {
            events: [
              {
                eventId: 'family',
                calendarId: 'family',
                calendar: 'Family',
                summary: "Frejya's playdate",
                location: "Gweny's house",
                start: '2026-08-24T14:00:00-07:00',
                end: '2026-08-24T17:00:00-07:00',
              },
              {
                eventId: 'work',
                calendarId: 'work',
                calendar: 'Work',
                summary: "Frejya's playdate",
                location: "Gweny's house",
                start: '2026-08-24T14:00:00-07:00',
                end: '2026-08-24T17:00:00-07:00',
              },
              {
                eventId: 'soccer',
                calendarId: 'family',
                calendar: 'Family',
                summary: 'Soccer',
                location: 'PayPal Park',
                start: '2026-08-24T14:00:00-07:00',
                end: '2026-08-24T17:00:00-07:00',
              },
            ],
          },
        },
      ],
      request,
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.calendars).toEqual(['Family', 'Work']);
  });

  it('builds calendar cards from successful evidence even when wording detection missed', () => {
    const result = calendarResponseCards([
      {
        toolName: 'calendar.list_events',
        status: 'succeeded',
        result: {
          events: [
            {
              eventId: 'coffee',
              calendarId: 'family',
              calendar: 'Family',
              summary: 'Coffee with Tine',
              start: '2026-09-02T09:00:00-07:00',
              end: '2026-09-02T10:00:00-07:00',
            },
          ],
        },
      },
    ]);
    expect(result).toMatchObject([
      { kind: 'calendar-event', title: 'Coffee with Tine', time: '9:00 AM–10:00 AM' },
    ]);
  });

  it('keeps an event calendar link separate from its video meeting link', () => {
    const result = calendarResponseCards(
      [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          result: {
            events: [
              {
                eventId: 'review',
                calendarId: 'work',
                calendar: 'Work',
                summary: 'Design review',
                start: '2026-08-24T14:00:00-07:00',
                end: '2026-08-24T15:00:00-07:00',
                links: [
                  {
                    type: 'calendar',
                    label: 'Open in Google Calendar',
                    url: 'https://calendar.google.com/event?eid=review',
                  },
                  { type: 'video', label: 'Video meeting', url: 'https://zoom.us/j/12345' },
                ],
              },
            ],
          },
        },
      ],
      request,
    );

    expect(result).toMatchObject([
      {
        calendarLink: { url: 'https://calendar.google.com/event?eid=review' },
        meetingLink: { url: 'https://zoom.us/j/12345' },
        link: { url: 'https://calendar.google.com/event?eid=review' },
      },
    ]);
  });

  it('renders date-only calendar events as all-day and rejects generic links', () => {
    const result = calendarResponseCards([
      {
        toolName: 'calendar.list_events',
        status: 'succeeded',
        result: {
          events: [
            {
              eventId: 'holiday',
              calendarId: 'family',
              calendar: 'Family',
              summary: 'School holiday',
              start: '2026-09-04',
              end: '2026-09-05',
              allDay: true,
              links: [{ type: 'calendar', url: 'https://calendar.google.com/calendar/u/0/r' }],
            },
          ],
        },
      },
    ]);
    expect(result[0]).toMatchObject({ time: 'All day', allDay: true });
    expect(result[0]?.calendarLink).toBeUndefined();
  });

  it('turns the fresh ambient weather block into a compact card', () => {
    expect(
      weatherResponseCards(
        "Right now (ambient context):\nOwner's current location: near San Francisco (37.7749, -122.4194), as of just now.\nWeather there: overcast, 18°C (today 17–19°C, 2% chance of rain, wind 18 km/h, humidity 70%).",
      ),
    ).toMatchObject([
      {
        kind: 'weather',
        location: 'San Francisco',
        temperature: '18°C',
        details: [
          { label: 'Today', value: '17–19°C' },
          { label: 'Wind', value: '18 km/h' },
          { label: 'Humidity', value: '70%' },
          { label: 'Rain chance', value: '2%' },
        ],
      },
    ]);
  });

  it('carries the coming days as day-labeled details for the card to group', () => {
    expect(
      weatherResponseCards(
        "Right now (ambient context):\nOwner's current location: near San Francisco (37.7749, -122.4194), as of just now.\nWeather there: overcast, 18°C (today 17–19°C, 2% chance of rain, wind 18 km/h).\nComing days: Tue 16–23°C, clear; Wed 14–21°C, light rain, 80% chance of rain.",
      ),
    ).toMatchObject([
      {
        kind: 'weather',
        details: [
          { label: 'Today', value: '17–19°C' },
          { label: 'Wind', value: '18 km/h' },
          { label: 'Rain chance', value: '2%' },
          { label: 'Tue', value: '16–23°C, clear' },
          { label: 'Wed', value: '14–21°C, light rain, 80% chance of rain' },
        ],
      },
    ]);
  });

  it('carries the ambient days as numbers for single-line forecast rows', () => {
    const [card] = weatherResponseCards(
      "Right now (ambient context):\nOwner's current location: near San Francisco (37.7749, -122.4194), as of just now.\nWeather there: overcast, 18°C (today 17–19°C, 2% chance of rain, wind 18 km/h, humidity 70%).\nComing days: Tue 16–23°C, clear; Wed 14–21°C, light rain, 80% chance of rain.",
    );
    expect(card).toMatchObject({
      current: { tempC: 18, lowC: 17, highC: 19, precipPct: 2, windKmh: 18, humidity: 70 },
      days: [
        { weekday: 'Today', lowC: 17, highC: 19, precipPct: 2, symbol: 'cloudy' },
        { weekday: 'Tue', lowC: 16, highC: 23, description: 'clear', symbol: 'clear' },
        { weekday: 'Wed', lowC: 14, highC: 21, precipPct: 80, symbol: 'rain' },
      ],
    });
    // Under 30% the ambient line omits the chance; the card must not claim 0%.
    expect((card?.days as Array<Record<string, unknown>> | undefined)?.[1]).not.toHaveProperty(
      'precipPct',
    );
  });

  it('attaches the ambient card to a plain here-and-now weather question', () => {
    const result = responseCardsForFinal({
      evidence: [],
      ambient:
        "Right now (ambient context):\nOwner's current location: near San Francisco (37.7749, -122.4194), as of just now.\nWeather there: overcast, 18°C (today 17–19°C, 2% chance of rain, wind 18 km/h).",
      requestText: "what's the weather like?",
    });

    expect(result.map((card) => card.kind)).toEqual(['weather']);
  });

  it.each([
    "what's the weather in Palo Alto this weekend?",
    "what's the weather this weekend?",
    'will it rain tomorrow?',
    'how hot will it get on Saturday?',
    'weather for Tokyo next week?',
  ])('keeps the today-here ambient card off an answer it would contradict: %s', (requestText) => {
    const result = responseCardsForFinal({
      evidence: [],
      ambient:
        "Right now (ambient context):\nOwner's current location: near San Francisco (37.7749, -122.4194), as of just now.\nWeather there: overcast, 18°C (today 17–19°C, 2% chance of rain, wind 18 km/h).\nComing days: Sat 16–23°C, clear; Sun 14–21°C, light rain.",
      requestText,
    });

    expect(result).toEqual([]);
  });

  it('cards a dated lookup on the day that was asked about, not on right now', () => {
    const result = weatherLookupResponseCards([
      {
        toolName: 'weather.lookup',
        status: 'succeeded',
        args: { date: '2026-09-17' },
        result: {
          place: 'Reykjavík',
          usedCurrentLocation: true,
          current: {
            tempC: 12,
            description: 'clear',
            lowC: 9,
            highC: 14,
            precipProbabilityMax: 5,
            windKmh: 20,
          },
          forecast: [
            {
              date: '2026-09-17',
              weekday: 'Thu',
              description: 'overcast',
              lowC: 14,
              highC: 17,
              precipProbabilityMax: 1,
            },
            {
              date: '2026-09-18',
              weekday: 'Fri',
              description: 'light rain',
              lowC: 11,
              highC: 15,
              precipProbabilityMax: 80,
            },
          ],
          target: {
            date: '2026-09-17',
            weekday: 'Thu',
            windows: [],
            hours: [],
            day: {
              date: '2026-09-17',
              weekday: 'Thu',
              description: 'overcast',
              lowC: 14,
              highC: 17,
              precipProbabilityMax: 1,
            },
          },
        },
      },
    ]);

    expect(result).toMatchObject([
      {
        kind: 'weather',
        location: 'Reykjavík',
        condition: 'overcast',
        temperature: '14–17°C',
        details: [
          { label: 'Day', value: 'Thu' },
          { label: 'Rain chance', value: '1%' },
          // The headlined day never repeats itself further down its own card.
          { label: 'Fri', value: '11–15°C, light rain, 80% chance of rain' },
        ],
      },
    ]);
  });

  it('gives a lookup card its days as numbers, today first and the headline day omitted', () => {
    const forecast = [
      {
        date: '2026-09-17',
        weekday: 'Thu',
        description: 'overcast',
        lowC: 14,
        highC: 17,
        precipProbabilityMax: 1,
      },
      {
        date: '2026-09-18',
        weekday: 'Fri',
        description: 'light rain',
        lowC: 11,
        highC: 15,
        precipProbabilityMax: 80,
      },
    ];
    const current = {
      tempC: 12,
      description: 'clear',
      lowC: 9,
      highC: 14,
      precipProbabilityMax: 5,
      windKmh: 20,
    };
    const now = weatherLookupResponseCards([
      {
        toolName: 'weather.lookup',
        status: 'succeeded',
        result: { place: 'Reykjavík', current, forecast },
      },
    ])[0];
    expect(now).toMatchObject({
      current: { tempC: 12, lowC: 9, highC: 14, precipPct: 5, windKmh: 20 },
      days: [
        { weekday: 'Today', lowC: 9, highC: 14, precipPct: 5, symbol: 'clear' },
        { weekday: 'Thu', date: '2026-09-17', lowC: 14, highC: 17 },
        { weekday: 'Fri', precipPct: 80, symbol: 'rain' },
      ],
    });

    const dated = weatherLookupResponseCards([
      {
        toolName: 'weather.lookup',
        status: 'succeeded',
        result: {
          place: 'Reykjavík',
          current,
          forecast,
          target: { date: '2026-09-17', weekday: 'Thu', windows: [], hours: [], day: forecast[0] },
        },
      },
    ])[0];
    expect(dated).not.toHaveProperty('current');
    expect(
      (dated?.days as Array<{ weekday: string }> | undefined)?.map((day) => day.weekday),
    ).toEqual(['Today', 'Fri']);
  });

  const window = (
    label: string,
    clock: string,
    description: string,
    lowC: number,
    highC: number,
    precipProbabilityMax = 5,
  ) => ({
    date: '2026-09-17',
    weekday: 'Thu',
    window: clock,
    label,
    description,
    lowC,
    highC,
    precipProbabilityMax,
    windKmhMax: 12,
  });

  it('gives a whole asked-about day one row per part of the day', () => {
    const [card] = weatherLookupResponseCards([
      {
        toolName: 'weather.lookup',
        status: 'succeeded',
        result: {
          place: 'Reykjavík',
          current: { tempC: 12, description: 'clear', lowC: 9, highC: 14 },
          forecast: [],
          target: {
            date: '2026-09-17',
            weekday: 'Thu',
            hours: [],
            // A future date always carries its day row: the tool finds it in
            // the forecast, which starts tomorrow.
            day: {
              date: '2026-09-17',
              weekday: 'Thu',
              description: 'light rain',
              lowC: 9,
              highC: 14,
              precipProbabilityMax: 70,
            },
            windows: [
              window('morning', '08:00–11:00', 'fog', 9, 11),
              window('midday', '11:00–14:00', 'light rain', 12, 14, 70),
              window('evening', '17:00–21:00', 'clear', 10, 12),
            ],
          },
        },
      },
    ]);

    // The band leads the label — it is what the owner asked in — and every row
    // keeps the weekday prefix both clients group on.
    expect(card?.details).toEqual([
      { label: 'Day', value: 'Thu' },
      { label: 'Rain chance', value: '70%' },
      { label: 'Thu Morning', value: '08:00–11:00 · 9–11°C, fog', symbol: 'fog' },
      {
        label: 'Thu Midday',
        value: '11:00–14:00 · 12–14°C, light rain, 70% chance of rain',
        symbol: 'rain',
      },
      { label: 'Thu Evening', value: '17:00–21:00 · 10–12°C, clear', symbol: 'clear' },
    ]);
  });

  it('headlines today with the current reading when the bands are today’s own', () => {
    // The tool's forecast starts tomorrow, so a target it cannot find a day row
    // for is today — and today's headline is what the sky is doing right now.
    const [card] = weatherLookupResponseCards([
      {
        toolName: 'weather.lookup',
        status: 'succeeded',
        result: {
          place: 'Reykjavík',
          current: {
            tempC: 12,
            description: 'clear',
            lowC: 9,
            highC: 14,
            precipProbabilityMax: 5,
            windKmh: 20,
          },
          forecast: [],
          target: {
            date: '2026-09-16',
            weekday: 'Wed',
            hours: [],
            windows: [{ ...window('evening', '17:00–21:00', 'fog', 8, 10), weekday: 'Wed' }],
          },
        },
      },
    ]);

    expect(card).toMatchObject({ temperature: '12°C', condition: 'clear', symbol: 'clear' });
    expect(card?.details).toContainEqual({
      label: 'Wed Evening',
      value: '17:00–21:00 · 8–10°C, fog',
      symbol: 'fog',
    });
  });

  it('labels an explicitly-timed window with its clock range, having no band to name', () => {
    const [card] = weatherLookupResponseCards([
      {
        toolName: 'weather.lookup',
        status: 'succeeded',
        result: {
          place: 'Reykjavík',
          current: { tempC: 12, description: 'clear', lowC: 9, highC: 14 },
          forecast: [],
          target: {
            date: '2026-09-17',
            weekday: 'Thu',
            hours: [],
            windows: [{ ...window('', '13:00–15:00', 'heavy snow', 1, 3), label: undefined }],
          },
        },
      },
    ]);

    // Day alone for the label: the clock carries digits, and iOS drops a
    // detail whose label has any.
    expect(card?.details).toContainEqual({
      label: 'Thu',
      value: '13:00–15:00 · 1–3°C, heavy snow',
      symbol: 'snow',
    });
  });

  it('names each sky from the closed provider vocabulary', () => {
    const skies = [
      ['thunderstorm with hail', 'thunderstorm'],
      ['heavy snow', 'snow'],
      ['snow showers', 'snow'],
      ['freezing rain', 'sleet'],
      ['light drizzle', 'drizzle'],
      ['rain showers', 'rain'],
      ['freezing fog', 'fog'],
      ['fog', 'fog'],
      ['partly cloudy', 'partly-cloudy'],
      ['mostly clear', 'partly-cloudy'],
      ['overcast', 'cloudy'],
      ['clear', 'clear'],
    ] as const;
    const [card] = weatherLookupResponseCards([
      {
        toolName: 'weather.lookup',
        status: 'succeeded',
        result: {
          place: 'Reykjavík',
          current: { tempC: 12, description: 'clear', lowC: 9, highC: 14 },
          forecast: skies.map(([description], index) => ({
            date: `2026-09-${17 + index}`,
            weekday: `D${index}`,
            description,
            lowC: 1,
            highC: 2,
            precipProbabilityMax: 0,
          })),
        },
      },
    ]);

    if (!card) throw new Error('expected a weather card');
    const drawn = new Map(
      (card.details as Array<{ label: string; symbol?: string }>).map((detail) => [
        detail.label,
        detail.symbol,
      ]),
    );
    expect(skies.map(([description], index) => [description, drawn.get(`D${index}`)])).toEqual(
      skies.map(([description, symbol]) => [description, symbol]),
    );
    // An unrecognised description carries no symbol rather than a wrong one.
    expect(
      weatherLookupResponseCards([
        {
          toolName: 'weather.lookup',
          status: 'succeeded',
          result: {
            place: 'Reykjavík',
            current: { tempC: 3, description: 'unsettled' },
            forecast: [],
          },
        },
      ])[0],
    ).not.toHaveProperty('symbol');
  });

  it('keeps every weather label inside what iOS will render', () => {
    // isWeatherCardDetail on iOS drops a label carrying digits or running past
    // three words, so a label that breaks either rule renders on web and
    // silently disappears on the phone.
    const cards = [
      ...weatherLookupResponseCards([
        {
          toolName: 'weather.lookup',
          status: 'succeeded',
          result: {
            place: 'Reykjavík',
            current: {
              tempC: 12,
              description: 'clear',
              lowC: 9,
              highC: 14,
              precipProbabilityMax: 5,
              windKmh: 20,
              humidity: 80,
            },
            forecast: [
              {
                date: '2026-09-18',
                weekday: 'Fri',
                description: 'fog',
                lowC: 3,
                highC: 6,
                precipProbabilityMax: 0,
              },
            ],
            target: {
              date: '2026-09-17',
              weekday: 'Thu',
              hours: [],
              day: {
                date: '2026-09-17',
                weekday: 'Thu',
                description: 'light rain',
                lowC: 9,
                highC: 14,
                precipProbabilityMax: 70,
              },
              windows: [
                window('early-morning', '05:00–08:00', 'fog', 5, 7),
                window('night', '21:00–24:00', 'clear', 4, 6),
                { ...window('', '13:00–15:00', 'snow', 1, 3), label: undefined },
              ],
            },
          },
        },
      ]),
      ...weatherResponseCards(
        "Owner's current location: near San Francisco.\nWeather there: overcast, 18°C (today 17–19°C, 2% chance of rain, wind 18 km/h, humidity 70%).\nComing days: Tue 16–23°C, clear; Wed 14–21°C, light rain, 80% chance of rain.",
      ),
    ];

    const labels = cards.flatMap((card) =>
      (card.details as Array<{ label: string }>).map((detail) => detail.label),
    );
    expect(labels.length).toBeGreaterThan(10);
    expect(labels.filter((label) => /\d/.test(label))).toEqual([]);
    expect(labels.filter((label) => label.split(' ').length > 3)).toEqual([]);
  });

  it('carries a full week of days when a full week was asked for', () => {
    const week = ['Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'];
    const [card] = weatherLookupResponseCards([
      {
        toolName: 'weather.lookup',
        status: 'succeeded',
        args: { days: 6 },
        result: {
          place: 'Reykjavík',
          current: {
            tempC: 12,
            description: 'clear',
            lowC: 9,
            highC: 14,
            precipProbabilityMax: 5,
            windKmh: 20,
          },
          forecast: week.map((weekday, index) => ({
            date: `2026-09-${18 + index}`,
            weekday,
            description: 'partly cloudy',
            lowC: 10 + index,
            highC: 15 + index,
            precipProbabilityMax: 10,
          })),
        },
      },
    ]);

    if (!card) throw new Error('expected a weather card');
    const days = (card.details as Array<{ label: string }>).filter((detail) =>
      week.includes(detail.label),
    );
    expect(days.map((detail) => detail.label)).toEqual(week);
    expect(days[0]).toEqual({
      label: 'Fri',
      value: '10–15°C, partly cloudy',
      symbol: 'partly-cloudy',
    });
  });

  it('cards a named place from its current reading when no day was asked for', () => {
    expect(
      weatherLookupResponseCards([
        {
          toolName: 'weather.lookup',
          status: 'succeeded',
          result: {
            place: 'Tokyo',
            usedCurrentLocation: false,
            current: {
              tempC: 24,
              description: 'partly cloudy',
              lowC: 20,
              highC: 27,
              precipProbabilityMax: 10,
              windKmh: 8,
              humidity: 65,
            },
            forecast: [],
          },
        },
      ]),
    ).toMatchObject([
      {
        kind: 'weather',
        location: 'Tokyo',
        condition: 'partly cloudy',
        temperature: '24°C',
        details: [
          { label: 'Today', value: '20–27°C' },
          { label: 'Wind', value: '8 km/h' },
          { label: 'Humidity', value: '65%' },
          { label: 'Rain chance', value: '10%' },
        ],
      },
    ]);
  });

  it('draws no card from a lookup that resolved no place or failed', () => {
    expect(
      weatherLookupResponseCards([
        {
          toolName: 'weather.lookup',
          status: 'succeeded',
          result: { error: 'no weather reading is available for Crocker Amazon right now' },
        },
        { toolName: 'weather.lookup', status: 'failed', result: { place: 'Oslo', current: {} } },
      ]),
    ).toEqual([]);
  });

  it('attaches the tool-backed card to the tomorrow question the ambient card must skip', () => {
    const result = responseCardsForFinal({
      evidence: [
        {
          toolName: 'weather.lookup',
          status: 'succeeded',
          result: {
            place: 'Reykjavík',
            current: { tempC: 12, description: 'clear', lowC: 9, highC: 14 },
            forecast: [],
            target: {
              date: '2026-09-17',
              weekday: 'Thu',
              windows: [],
              hours: [],
              day: {
                date: '2026-09-17',
                weekday: 'Thu',
                description: 'overcast',
                lowC: 14,
                highC: 17,
                precipProbabilityMax: 1,
              },
            },
          },
        },
      ],
      ambient:
        "Right now (ambient context):\nOwner's current location: near Reykjavík (64.14, -21.94), as of just now.\nWeather there: clear, 12°C (today 9–14°C, 5% chance of rain, wind 20 km/h).",
      requestText: 'How is the weather going to be tomorrow',
    });

    expect(result).toMatchObject([
      { kind: 'weather', temperature: '14–17°C', condition: 'overcast' },
    ]);
  });

  it('builds complete cards for reminders, inbox, documents, Drive, artifacts, and confirmations', () => {
    const result = responseCardsForFinal({
      evidence: [
        {
          toolName: 'reminder.create',
          status: 'succeeded',
          result: {
            reminderId: 'reminder-1',
            text: '**Review** the launch plan',
            cron: '0 9 * * 1',
            nextFires: '2026-08-31T16:00:00.000Z',
          },
        },
        {
          toolName: 'gmail.search',
          status: 'succeeded',
          args: { query: 'launch' },
          result: {
            mailboxSearched: 'owner@example.com',
            complete: false,
            matchingMessagesEstimate: 3,
            results: [
              {
                messageId: 'message-1',
                threadId: 'thread-1',
                from: 'Ada <ada@example.com>',
                to: 'owner@example.com',
                subject: '**Launch** update',
                date: 'Mon, 24 Aug 2026 09:00:00 -0700',
                snippet: 'The plan is ready.',
              },
            ],
          },
        },
        {
          toolName: 'documents.search',
          status: 'succeeded',
          args: { query: 'launch plan' },
          result: {
            passages: [
              {
                document: 'Launch brief',
                source: 'upload',
                snippet: 'The **launch** is scheduled for Monday.',
                similarity: 0.982,
              },
            ],
          },
        },
        {
          toolName: 'drive.search',
          status: 'succeeded',
          args: { query: 'launch' },
          result: {
            files: [
              {
                fileId: 'drive-1',
                name: 'Launch deck',
                mimeType: 'application/vnd.google-apps.presentation',
                modifiedTime: '2026-08-24T16:00:00.000Z',
                size: '2048',
                url: 'https://drive.example.com/launch',
              },
            ],
          },
        },
        {
          toolName: 'docs.create',
          status: 'succeeded',
          args: { title: 'Launch recap' },
          result: {
            documentId: 'doc-1',
            title: 'Launch recap',
            sharedWith: 'owner@example.com',
            url: 'https://docs.example.com/launch-recap',
          },
        },
        {
          toolName: 'gmail.create_draft',
          status: 'succeeded',
          args: { to: ['ada@example.com'], subject: '**Launch** recap' },
          result: { draftId: 'draft-1', to: ['ada@example.com'], subject: '**Launch** recap' },
        },
      ],
    });

    expect(result).toMatchObject([
      {
        kind: 'resource',
        resourceType: 'document',
        title: 'Launch recap',
        link: { label: 'Open document', url: 'https://docs.example.com/launch-recap' },
      },
      {
        kind: 'status',
        title: 'Email draft ready',
        detail: '**Launch** recap',
        details: [{ label: 'To', value: 'ada@example.com' }],
      },
      {
        kind: 'reminder',
        title: '**Review** the launch plan',
        schedule: '0 9 * * 1',
      },
      {
        kind: 'email-results',
        complete: false,
        matchingMessagesEstimate: 3,
        messages: [{ subject: '**Launch** update', snippet: 'The plan is ready.' }],
      },
      {
        kind: 'document-results',
        passages: [{ document: 'Launch brief', source: 'upload', similarity: 0.982 }],
      },
      {
        kind: 'drive-results',
        files: [{ name: 'Launch deck', size: '2048' }],
      },
    ]);
  });

  it('keeps one-time reminder transport instants out of the card copy', () => {
    const result = responseCardsForFinal({
      evidence: [
        {
          toolName: 'reminder.create',
          status: 'succeeded',
          result: {
            reminderId: 'reminder-once',
            kind: 'once',
            text: 'Call the dentist',
            schedule: '2026-09-03T18:10:00.000Z',
            nextFires: '2026-09-03T18:10:00.000Z',
            timezone: 'America/Los_Angeles',
          },
        },
      ],
    });

    expect(result).toMatchObject([
      {
        kind: 'reminder',
        title: 'Call the dentist',
        schedule: '',
        nextFires: '2026-09-03T18:10:00.000Z',
        timezone: 'America/Los_Angeles',
      },
    ]);
  });

  it('turns web search hits into a tappable results card', () => {
    const result = searchResponseCards([
      {
        toolName: 'web.search',
        status: 'succeeded',
        args: { query: 'best time to visit Lisbon' },
        result: {
          query: 'best time to visit Lisbon',
          results: [
            {
              url: 'https://example.com/lisbon',
              title: 'Lisbon travel guide',
              snippet: 'Late spring is ideal.',
            },
            { url: '', title: 'Dropped without a URL', snippet: 'No link.' },
          ],
        },
      },
      { toolName: 'web.search', status: 'failed', result: { query: 'ignored', results: [] } },
    ]);

    expect(result).toMatchObject([
      {
        kind: 'web-search-results',
        query: 'best time to visit Lisbon',
        results: [
          {
            title: 'Lisbon travel guide',
            url: 'https://example.com/lisbon',
            snippet: 'Late spring is ideal.',
          },
        ],
      },
    ]);
    expect(result[0]?.results).toHaveLength(1);
  });

  it('turns a free/busy read into an availability card with its coverage', () => {
    const result = availabilityResponseCards([
      {
        toolName: 'calendar.availability',
        status: 'succeeded',
        args: { timeMin: '2026-08-24T09:00:00-07:00', timeMax: '2026-08-24T17:00:00-07:00' },
        result: {
          busy: [
            {
              start: '2026-08-24T10:00:00-07:00',
              end: '2026-08-24T11:30:00-07:00',
              calendar: 'Work',
            },
            { start: '', end: '', calendar: 'Dropped when malformed' },
          ],
          calendarsChecked: ['Work', 'Family'],
          complete: false,
          note: 'Some calendars did not return free/busy data.',
        },
      },
    ]);

    expect(result).toMatchObject([
      {
        kind: 'availability',
        timeMin: '2026-08-24T09:00:00-07:00',
        timeMax: '2026-08-24T17:00:00-07:00',
        busy: [
          {
            start: '2026-08-24T10:00:00-07:00',
            end: '2026-08-24T11:30:00-07:00',
            calendar: 'Work',
          },
        ],
        calendarsChecked: ['Work', 'Family'],
        complete: false,
        note: 'Some calendars did not return free/busy data.',
      },
    ]);
    expect(result[0]?.busy).toHaveLength(1);
  });

  it('includes search and availability cards in the final response set', () => {
    const result = responseCardsForFinal({
      evidence: [
        {
          toolName: 'web.search',
          status: 'succeeded',
          args: { query: 'lisbon' },
          result: {
            query: 'lisbon',
            results: [{ url: 'https://example.com', title: 'Example', snippet: 'Hi' }],
          },
        },
        {
          toolName: 'calendar.availability',
          status: 'succeeded',
          args: { timeMin: '2026-08-24T09:00:00-07:00', timeMax: '2026-08-24T17:00:00-07:00' },
          result: { busy: [], calendarsChecked: ['Work'], complete: true },
        },
      ],
    });

    expect(result.map((card) => card.kind)).toEqual(['availability', 'web-search-results']);
  });

  it('turns a fetched thread into a compact transcript card', () => {
    const result = threadResponseCards([
      {
        toolName: 'gmail.read_thread',
        status: 'succeeded',
        result: {
          threadId: 'thread-1',
          messages: [
            {
              messageId: 'm1',
              from: 'Ada <ada@example.com>',
              date: 'Mon, 24 Aug 2026 09:00:00 -0700',
              subject: 'Launch recap',
              text: 'The plan is ready.\n\nEverything reviewed.',
            },
            {
              messageId: 'm2',
              from: 'owner@example.com',
              date: 'Mon, 24 Aug 2026 09:15:00 -0700',
              subject: 'Re: Launch recap',
              text: 'Thanks!',
            },
          ],
        },
      },
    ]);

    expect(result).toMatchObject([
      {
        kind: 'email-thread',
        subject: 'Launch recap',
        messageCount: 2,
        messages: [
          {
            id: 'm1',
            sender: 'Ada <ada@example.com>',
            excerpt: 'The plan is ready. Everything reviewed.',
          },
          { id: 'm2', excerpt: 'Thanks!' },
        ],
      },
    ]);
  });

  it('caps sheet previews while keeping the full row count and open link', () => {
    const wideRow = Array.from({ length: 8 }, (_, index) => `col-${index}`);
    const result = sheetRowsResponseCards([
      {
        toolName: 'sheets.get_rows',
        status: 'succeeded',
        result: {
          spreadsheetId: 'sheet-1',
          sheetName: 'Budget',
          url: 'https://sheets.example.com/budget',
          rows: [wideRow, ['Flights', 640], ...Array.from({ length: 40 }, () => ['x', 1])],
        },
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'sheet-rows',
      sheetName: 'Budget',
      totalRows: 42,
      link: { label: 'Open spreadsheet', url: 'https://sheets.example.com/budget' },
    });
    const rows = result[0]?.rows as string[][];
    expect(rows).toHaveLength(9);
    expect(rows[0]).toHaveLength(6);
    expect(rows[1]).toEqual(['Flights', '640']);
  });

  it('confirms inbox, document, and sheet writes with links where they exist', () => {
    const result = statusResponseCards([
      {
        toolName: 'gmail.modify',
        status: 'succeeded',
        args: { messageId: 'm1', archive: true, markRead: true },
        result: { id: 'm1', addedLabels: [], removedLabels: ['UNREAD', 'INBOX'] },
      },
      {
        toolName: 'docs.append',
        status: 'succeeded',
        result: { documentId: 'doc-1', url: 'https://docs.example.com/1', appended: true },
      },
      {
        toolName: 'docs.replace_text',
        status: 'succeeded',
        result: {
          documentId: 'doc-1',
          url: 'https://docs.example.com/1',
          updated: true,
          replacements: [{ oldText: 'a', newText: 'b' }],
        },
      },
      {
        toolName: 'docs.share',
        status: 'succeeded',
        args: { role: 'commenter' },
        result: {
          documentId: 'doc-1',
          url: 'https://docs.example.com/1',
          sharedWith: 'ada@example.com',
        },
      },
      {
        toolName: 'sheets.append_rows',
        status: 'succeeded',
        result: {
          spreadsheetId: 's1',
          sheetName: 'Budget',
          url: 'https://sheets.example.com/budget',
          appendedRows: 3,
        },
      },
      {
        toolName: 'sheets.write_rows',
        status: 'succeeded',
        result: {
          spreadsheetId: 's1',
          sheetName: 'Budget',
          startCell: 'B4',
          url: 'https://sheets.example.com/budget',
          writtenRows: 1,
        },
      },
    ]);

    expect(result).toMatchObject([
      { kind: 'status', title: 'Inbox updated', detail: 'Archived · Marked read' },
      {
        kind: 'status',
        title: 'Document updated',
        symbol: 'doc.badge.plus',
        link: { label: 'Open document', url: 'https://docs.example.com/1' },
      },
      {
        kind: 'status',
        title: 'Document updated',
        detail: '1 text replacement applied.',
      },
      {
        kind: 'status',
        title: 'Document shared',
        detail: 'ada@example.com',
        details: [{ label: 'Role', value: 'commenter' }],
      },
      {
        kind: 'status',
        title: 'Sheet updated',
        detail: '3 rows added to Budget.',
        link: { label: 'Open spreadsheet', url: 'https://sheets.example.com/budget' },
      },
      { kind: 'status', title: 'Sheet updated', detail: '1 row written to Budget.' },
    ]);
  });

  it('does not revive cards from an earlier task in the conversation', () => {
    expect(
      responseCardsForFinal({
        evidence: [
          {
            toolName: 'gmail.send',
            status: 'succeeded',
            fromCurrentTask: false,
            result: { messageId: 'old-message', to: ['person@example.com'] },
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe('scoreboardResponseCards', () => {
  const game = (id: string, state: string, league = 'mlb') => ({
    id,
    league,
    leagueLabel: league.toUpperCase(),
    state,
    statusText: state === 'post' ? 'Final' : 'Top 7th',
    startsAt: '2026-09-22T01:45Z',
    home: {
      id: '26',
      name: 'San Francisco Giants',
      shortName: 'Giants',
      abbreviation: 'SF',
      score: '5',
    },
    away: { id: '9', name: 'Minnesota Twins', shortName: 'Twins', abbreviation: 'MIN', score: '2' },
    line: 'Minnesota Twins at San Francisco Giants: 2-5, Final',
  });
  const row = (games: unknown[], extra: Record<string, unknown> = {}) => ({
    toolName: 'sports.scores',
    status: 'succeeded',
    result: { timeZone: 'America/Los_Angeles', fetchedAt: '2026-09-22T19:00:00Z', games, ...extra },
  });

  it('draws one board from the tool rows, live only for games still to finish', () => {
    const [card] = scoreboardResponseCards([row([game('1', 'post'), game('2', 'in')])]);
    expect(card).toMatchObject({
      kind: 'scoreboard',
      title: 'MLB',
      accompaniesProse: true,
      live: { provider: 'espn', pollSeconds: 30, leagues: [{ league: 'mlb', eventIds: ['2'] }] },
    });
    expect(card?.games).toHaveLength(2);
  });

  it('stops being live once every game is final, and ignores failed lookups', () => {
    const [card] = scoreboardResponseCards([row([game('1', 'post')])]);
    expect(card).not.toHaveProperty('live');
    expect(scoreboardResponseCards([row([], { error: 'provider down' })])).toEqual([]);
    expect(
      scoreboardResponseCards([{ ...row([game('1', 'post')]), fromCurrentTask: false }]),
    ).toEqual([]);
  });

  it('titles a team fallback as its last and next game', () => {
    const [card] = scoreboardResponseCards([
      row([game('1', 'post'), game('3', 'pre')], { selection: 'last-and-next' }),
    ]);
    expect(card?.title).toBe('Last result and next game');
  });
});

describe('routeResponseCards', () => {
  const route = {
    origin: { label: 'Current Location', lat: 37.7857, lng: -122.4011, current: true },
    destination: {
      label: 'Oracle Park',
      address: '24 Willie Mays Plaza, San Francisco',
      lat: 37.7786,
      lng: -122.3893,
    },
    mode: 'driving',
    durationSeconds: 540,
    distanceMeters: 1850,
    departAt: '2026-09-22T18:00:00.000Z',
    arriveAt: '2026-09-22T18:09:00.000Z',
    routeName: 'King St',
    steps: [{ instruction: 'Turn right onto Howard St', distanceMeters: 900 }],
    polyline: '_p~iF~ps|U_ulLnnqC',
    mapsUrl: 'https://maps.apple.com/?saddr=37.7857%2C-122.4011&daddr=37.7786%2C-122.3893&dirflg=d',
  };
  const row = (result: unknown) => ({ toolName: 'maps.directions', status: 'succeeded', result });

  it('draws the route under the reply from the tool row alone', () => {
    const [card] = routeResponseCards([row(route)]);
    expect(card).toMatchObject({
      kind: 'route',
      accompaniesProse: true,
      durationSeconds: 540,
      destination: { label: 'Oracle Park', address: '24 Willie Mays Plaza, San Francisco' },
      origin: { current: true },
      polyline: route.polyline,
      mapsUrl: route.mapsUrl,
    });
  });

  it('draws nothing for a failed route or a link that is not Apple Maps', () => {
    expect(routeResponseCards([row({ error: 'No route found' })])).toEqual([]);
    expect(routeResponseCards([row({ ...route, mapsUrl: 'https://evil.example/' })])).toEqual([]);
  });
});

describe('cards for a request with several live lookups', () => {
  const weather = {
    toolName: 'weather.lookup',
    status: 'succeeded',
    result: {
      place: 'San Francisco',
      current: { tempC: 18, description: 'fog', lowC: 13, highC: 19, precipProbabilityMax: 5 },
    },
  };
  const scores = {
    toolName: 'sports.scores',
    status: 'succeeded',
    result: {
      timeZone: 'America/Los_Angeles',
      fetchedAt: '2026-09-22T19:00:00Z',
      games: [
        {
          id: '1',
          league: 'mlb',
          leagueLabel: 'MLB',
          state: 'post',
          statusText: 'Final',
          startsAt: '2026-09-22T01:45Z',
          home: { id: '26', name: 'San Francisco Giants', shortName: 'Giants', score: '5' },
          away: { id: '19', name: 'Los Angeles Dodgers', shortName: 'Dodgers', score: '2' },
          line: 'Los Angeles Dodgers at San Francisco Giants: 2-5, Final',
        },
      ],
    },
  };
  const kinds = (cards: Array<{ kind: string }>) => cards.map((card) => card.kind);

  it('orders the cards the way the owner asked and keeps the reply beside them', () => {
    const cards = responseCardsForFinal({
      evidence: [weather, scores] as never,
      lookupOrder: ['sports', 'weather'],
    });
    expect(kinds(cards)).toEqual(['scoreboard', 'weather']);
    expect(cards.every((card) => card.accompaniesProse === true)).toBe(true);
  });

  it('leaves a single lookup exactly as it was', () => {
    const [card] = responseCardsForFinal({
      evidence: [weather] as never,
      lookupOrder: ['weather'],
    });
    expect(card?.kind).toBe('weather');
    expect(card).not.toHaveProperty('accompaniesProse');
    expect(responseCardsForFinal({ evidence: [weather] as never })).toEqual([card]);
  });
});
