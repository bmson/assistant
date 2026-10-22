import {
  conversationMessageSourceRevision,
  conversationMessageSpeakerRevision,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { EMAIL_REVIEW_QUERY } from './email-review.js';
import {
  buildReadToolInput,
  detectPersonalReadRequest,
  gmailThreadIdsToRead,
  groundReadToolInput,
  nextRequiredReadTool,
  type ReadToolEvidence,
  resolveTemporalIntent,
  resolveTimeWindow,
} from './read-intent.js';

const turn = (text: string, prior = '') => [
  ...(prior ? [{ role: 'assistant', content: prior }] : []),
  { role: 'user', content: text },
];

describe('detectPersonalReadRequest', () => {
  it('binds a literal named phone calendar and replaces model IDs on every page', () => {
    const request = detectPersonalReadRequest(
      turn('Check Zendesk calendar tomorrow, shared from phone.'),
      {
        now: new Date('2026-10-22T12:00:00.000Z'),
        timeZone: 'America/Los_Angeles',
      },
    );
    expect(request).toMatchObject({
      kind: 'calendar',
      calendarScope: { name: 'Zendesk', source: 'iphone' },
      firstToolName: 'calendar.list_events',
    });
    if (!request) throw new Error('Expected named calendar request');
    expect(buildReadToolInput(request, 'calendar.list_events', [])).toMatchObject({
      calendarIds: ['Zendesk (iPhone)'],
      timeMin: expect.any(String),
      timeMax: expect.any(String),
    });
    const firstPage: ReadToolEvidence = {
      toolName: 'calendar.list_events',
      status: 'succeeded',
      args: {
        calendarIds: ['Zendesk (iPhone)'],
        timeMin: request.timeWindow?.timeMin,
        timeMax: request.timeWindow?.timeMax,
      },
      result: { events: [], nextPageToken: 'named-page-2' },
    };
    expect(nextRequiredReadTool(request, [firstPage])).toBe('calendar.list_events');
    expect(buildReadToolInput(request, 'calendar.list_events', [firstPage])).toMatchObject({
      calendarIds: ['Zendesk (iPhone)'],
      pageToken: 'named-page-2',
    });
    expect(
      groundReadToolInput(
        request,
        'calendar.list_events',
        {
          calendarIds: ['Personal Work'],
          pageToken: 'model-page',
          timeMin: '1900',
          timeMax: '2100',
        },
        [],
      ),
    ).toMatchObject({
      calendarIds: ['Zendesk (iPhone)'],
      timeMin: request.timeWindow?.timeMin,
      timeMax: request.timeWindow?.timeMax,
    });
    expect(
      nextRequiredReadTool(request, [
        {
          ...firstPage,
          args: {
            calendarIds: ['Personal Work'],
            timeMin: request.timeWindow?.timeMin,
            timeMax: request.timeWindow?.timeMax,
          },
        },
      ]),
    ).toBe('calendar.list_events');
  });

  it('keeps generic calendar reads unscoped despite model-proposed calendar IDs', () => {
    const request = detectPersonalReadRequest(turn('What is on my calendar tomorrow?'), {
      now: new Date('2026-10-22T12:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    });
    if (!request) throw new Error('Expected generic calendar request');
    expect(request.calendarScope).toBeUndefined();
    expect(
      groundReadToolInput(request, 'calendar.list_events', { calendarIds: ['Personal Work'] }, []),
    ).not.toHaveProperty('calendarIds');
  });

  it('binds a lowercase literal work-calendar reference', () => {
    const request = detectPersonalReadRequest(turn("What's on work calendar this week?"), {
      now: new Date('2026-10-22T12:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(request).toMatchObject({
      calendarScope: { name: 'work' },
      firstToolName: 'calendar.list_events',
    });
    if (!request) throw new Error('Expected named calendar request');
    expect(buildReadToolInput(request, 'calendar.list_events', [])?.calendarIds).toEqual(['work']);
  });

  it('keeps named-calendar planning and statistics intents intact', () => {
    const options = { now: new Date('2026-10-09T12:00:00.000Z'), timeZone: 'America/Los_Angeles' };
    const plan = detectPersonalReadRequest(
      turn(
        'Review my Work calendar for next week and find three focus blocks during working hours, allowing time for breaks.',
      ),
      options,
    );
    expect(plan).toMatchObject({
      calendarScope: { name: 'Work' },
      weeklyCalendarPlan: true,
    });

    const analysis = detectPersonalReadRequest(
      turn(
        'For my Work calendar over the next 3 weekdays, how many days have an event lasting at least 45 minutes? Find gaps of at least 30 minutes between in-person events.',
      ),
      options,
    );
    expect(analysis).toMatchObject({
      calendarScope: { name: 'Work' },
      calendarEventAnalysis: { weekdayCount: 3, minimumDurationMinutes: 45 },
      firstToolName: 'calendar.list_events',
    });
  });

  it('continues a named Work calendar plus email lookup through both sources and the matching thread', () => {
    const request = detectPersonalReadRequest(
      turn(
        'What time is my Zendesk meeting tomorrow on the Work calendar, and did I receive the invitation email?',
      ),
      { now: new Date('2026-10-22T12:00:00.000Z'), timeZone: 'America/Los_Angeles' },
    );
    expect(request).toMatchObject({
      kind: 'calendar_email',
      calendarScope: { name: 'Work' },
      firstToolName: 'calendar.search_events',
      requiresThreadRead: true,
    });
    if (!request) throw new Error('Expected named calendar plus mail request');

    const calendar: ReadToolEvidence = {
      toolName: 'calendar.search_events',
      status: 'succeeded',
      args: {
        calendarIds: ['Work'],
        query: request.queryTerms.join(' '),
        timeMin: request.timeWindow?.timeMin,
        timeMax: request.timeWindow?.timeMax,
      },
      result: { ok: true, complete: true, events: [], calendarsSearched: ['Work'] },
    };
    expect(nextRequiredReadTool(request, [])).toBe('calendar.search_events');
    expect(nextRequiredReadTool(request, [calendar])).toBe('gmail.search');

    const mail: ReadToolEvidence = {
      toolName: 'gmail.search',
      status: 'succeeded',
      args: { query: request.mailQuery },
      result: { results: [{ threadId: 'zendesk-invitation' }] },
    };
    expect(nextRequiredReadTool(request, [calendar, mail])).toBe('gmail.read_thread');
    expect(buildReadToolInput(request, 'gmail.read_thread', [calendar, mail])).toMatchObject({
      threadId: 'zendesk-invitation',
    });
  });

  it('continues named Work-calendar trip discovery into booking-email searches', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Find the next trip from booking emails using the Work calendar. Confirm flight dates, departure times and time zones, connections, and hotel. Then compare public transport and taxi from the destination airport to the hotel.',
      ),
      { now: new Date('2026-10-13T18:00:00.000Z'), timeZone: 'America/Los_Angeles' },
    );
    expect(request).toMatchObject({
      kind: 'calendar_email',
      compoundTripDiscovery: true,
      calendarScope: { name: 'Work' },
      firstToolName: 'calendar.list_events',
    });
    if (!request) throw new Error('Expected named calendar trip request');
    expect(nextRequiredReadTool(request, [])).toBe('calendar.list_events');
    const calendarInput = buildReadToolInput(request, 'calendar.list_events', []);
    expect(calendarInput?.calendarIds).toEqual(['Work']);
    const calendar: ReadToolEvidence = {
      toolName: 'calendar.list_events',
      status: 'succeeded',
      args: calendarInput,
      result: { ok: true, complete: true, events: [], calendarsSearched: ['Work'] },
    };
    expect(nextRequiredReadTool(request, [calendar])).toBe('gmail.search');
  });

  it('binds the named calendar child in an explicit paired-source read', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Check my Work calendar tomorrow and search my email for the Zendesk meeting invitation.',
      ),
      { now: new Date('2026-10-22T12:00:00.000Z'), timeZone: 'America/Los_Angeles' },
    );
    if (!request?.sourceReads) throw new Error('Expected paired source reads');
    const calendarRequest = request.sourceReads.find(
      (child) => child.explicitSource === 'calendar',
    );
    const mailRequest = request.sourceReads.find((child) => child.explicitSource === 'mail');
    expect(calendarRequest?.calendarScope).toEqual({ name: 'Work' });
    if (!calendarRequest || !mailRequest) throw new Error('Expected calendar and email children');

    const mail: ReadToolEvidence = {
      toolName: 'gmail.search',
      status: 'succeeded',
      args: { query: mailRequest.mailQuery },
      result: { results: [] },
    };
    expect(nextRequiredReadTool(request, [])).toBe('gmail.search');
    expect(nextRequiredReadTool(request, [mail])).toBe('calendar.list_events');
    const input = buildReadToolInput(request, 'calendar.list_events', [mail]);
    expect(input?.calendarIds).toEqual(['Work']);
    const calendar: ReadToolEvidence = {
      toolName: 'calendar.list_events',
      status: 'succeeded',
      args: input,
      result: { ok: true, complete: true, events: [], calendarsSearched: ['Work'] },
    };
    expect(nextRequiredReadTool(request, [mail, calendar])).toBeUndefined();
  });

  it('does not widen an unknown or ambiguous named calendar after an unavailable result', () => {
    const request = detectPersonalReadRequest(turn('Check Zendesk calendar tomorrow.'), {
      now: new Date('2026-10-22T12:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    });
    if (!request) throw new Error('Expected named calendar request');
    const bound = buildReadToolInput(request, 'calendar.list_events', []);
    expect(bound?.calendarIds).toEqual(['Zendesk']);
    for (const unavailable of [
      { calendar: 'Zendesk', reason: 'calendar was not found in the readable roster' },
      {
        calendar: 'Zendesk',
        reason: 'calendar name is ambiguous; select by calendar ID',
        candidates: ['zendesk-a@example.com', 'zendesk-b@example.com'],
      },
    ]) {
      expect(
        nextRequiredReadTool(request, [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: bound,
            result: {
              events: [],
              calendarsSearched: [],
              unavailable: [unavailable],
              complete: false,
            },
          },
        ]),
      ).toBeUndefined();
      expect(buildReadToolInput(request, 'calendar.list_events', [])?.calendarIds).toEqual([
        'Zendesk',
      ]);
    }
  });

  it('does not turn a fictional no-tool background check into calendar/mail discovery', () => {
    const text =
      'Simulate a background check only; do not use tools or notify anyone. A fictional assistant already reported that two venue quotes are unchanged and is waiting for the owner to choose. No new source information, deadline, risk, or owner reply has arrived. Should it interrupt again? State the decision and the event that would justify another update in at most 80 words.';
    expect(detectPersonalReadRequest(turn(text))).toBeNull();
    expect(
      detectPersonalReadRequest(
        turn('Do not use tools. What is on my calendar in this supplied fictional example?'),
      ),
    ).toBeNull();
  });

  it('routes a subscription audit to bounded Gmail only and asks for a zone or month count before reading', () => {
    const text =
      'Audit recurring subscriptions evidenced in authorized billing messages over the last 3 complete local calendar months. Separate actual charges, trials, refunds, cancellation notices and uncertain recurring purchases. No login/account change/cancel/unsubscribe/purchase/hold/send/Gmail draft/document/calendar/memory writes.';
    const request = detectPersonalReadRequest(turn(text), {
      now: new Date('2026-10-15T12:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    });
    if (!request) throw new Error('Expected billing audit request');
    expect(request).toMatchObject({
      kind: 'email',
      explicitSource: 'mail',
      firstToolName: 'gmail.search',
      billingAudit: {
        months: 3,
        timeZone: 'America/Los_Angeles',
        startAt: '2026-07-01T07:00:00.000Z',
        endAt: '2026-10-01T07:00:00.000Z',
      },
    });
    expect(request?.mailQuery).toContain('after:2026/06/29');
    expect(request?.mailQuery).toContain('before:2026/10/03');
    expect(request?.sourceReads).toBeUndefined();
    expect(request?.memoryQuery).toBeUndefined();
    expect(request?.firstToolName).not.toMatch(/calendar/);
    expect(nextRequiredReadTool(request, [])).toBe('gmail.search');
    expect(buildReadToolInput(request, 'gmail.search', [])).toMatchObject({
      query: request?.mailQuery,
      maxResults: 20,
    });
    expect(
      detectPersonalReadRequest(turn(text), { now: new Date('2026-10-15T12:00:00.000Z') }),
    ).toMatchObject({ billingAuditIssue: expect.stringContaining('time zone') });
    expect(
      detectPersonalReadRequest(turn('Audit billing emails over the last 13 complete months.'), {
        now: new Date('2026-10-15T12:00:00.000Z'),
        timeZone: 'UTC',
      }),
    ).toMatchObject({ billingAuditIssue: expect.stringContaining('How many') });
    expect(
      detectPersonalReadRequest(
        turn(
          'Audit recurring subscriptions from billing emails over the last 3 months. Do not read Gmail.',
        ),
        { now: new Date('2026-10-15T12:00:00.000Z'), timeZone: 'UTC' },
      ),
    ).toBeNull();
  });

  it.each([
    'Read my earlier conversations about subscriptions and audit recurring billing emails over the last 3 complete local calendar months.',
    'Check my calendar for subscription events and audit recurring billing emails over the last 3 complete local calendar months.',
  ])('keeps an explicitly requested companion source visible as unassessed: %s', (text) => {
    const request = detectPersonalReadRequest(turn(text), {
      now: new Date('2026-10-15T12:00:00Z'),
      timeZone: 'UTC',
    });
    expect(request).toMatchObject({
      kind: 'email',
      billingAudit: expect.any(Object),
      billingAuditCompanionGap: expect.stringMatching(/history|calendar/),
    });
    expect(request?.sourceReads).toBeUndefined();
  });

  it('routes the compound next-trip request as bounded read-only discovery, not flight verification', () => {
    const requestText =
      'Find my next trip from my booking emails and calendar. Confirm the flight dates, departure times and time zones, connections, and hotel. Check for conflicting information. Then plan how to get from the destination airport to my hotel, comparing public transport and taxi. Give me a short itinerary with source links, and clearly mark anything you cannot verify.';
    const request = detectPersonalReadRequest(turn(requestText), {
      now: new Date('2026-10-13T18:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(request).toMatchObject({
      kind: 'calendar_email',
      firstToolName: 'calendar.list_events',
      requiresThreadRead: true,
      answerFocus: 'trip',
      compoundTripDiscovery: true,
      maxResults: 50,
      timeWindow: {
        timeMin: '2026-10-13T18:00:00.000Z',
        timeMax: '2027-10-13T18:00:00.000Z',
      },
    });
    expect(request?.verification).toBeUndefined();
    expect(request?.scopeIssue).toBeUndefined();
    expect(request?.upcomingFlightDiscovery).toBeUndefined();
    expect(request?.mailQueries?.map((entry) => entry.category)).toEqual(['flight', 'lodging']);
    expect(request?.mailQueries?.[0]?.query).toContain('subject:(flight booking)');
    expect(request?.mailQueries?.[0]?.query).toContain('subject:(flight booked)');
    expect(request?.mailQueries?.[0]?.query).toContain('subject:(flight reserved)');
    expect(request?.mailQueries?.[1]?.query).toContain('subject:(hotel reservation)');
    expect(request?.mailQueries?.[1]?.query).toContain('subject:(hotel reserved)');
    expect(request?.mailQueries?.[1]?.query).toContain('subject:(booking confirmation)');
    expect(request?.mailQueries?.[1]?.query).toContain('subject:(reservation confirmation)');
    expect(request?.mailQueries?.[1]?.query).toContain('subject:(your reservation)');
    expect(request?.mailQuery).not.toContain('hotel');
  });

  it('caps compound trip calls at eighteen and never resumes from other-task search or calendar receipts', () => {
    const requestText =
      'Find my next trip from my booking emails and calendar. Confirm the flight dates, departure times and time zones, connections, and hotel. Check for conflicting information. Then plan how to get from the destination airport to my hotel, comparing public transport and taxi. Give me a short itinerary with source links, and clearly mark anything you cannot verify.';
    const request = detectPersonalReadRequest([{ role: 'user', content: requestText }], {
      now: new Date('2026-10-13T18:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    });
    if (!request) throw new Error('Expected read request');
    const capped: ReadToolEvidence[] = Array.from({ length: 18 }, (_, index) => ({
      toolName: index % 2 ? 'web.fetch' : 'gmail.search',
      status: 'failed',
      args: {},
      fromCurrentTask: true,
    }));
    expect(nextRequiredReadTool(request, capped)).toBeUndefined();

    expect(nextRequiredReadTool(request, capped.slice(0, 16))).toBe('calendar.list_events');

    const previousTask = Array.from({ length: 16 }, (_, index) => ({
      ...capped[index],
      fromCurrentTask: false,
      status: 'succeeded',
      result: { complete: true, results: [] },
    })) as ReadToolEvidence[];
    expect(nextRequiredReadTool(request, previousTask)).toBe('calendar.list_events');
  });

  it('reads flight and lodging candidates while excluding an airline news result', () => {
    const requestText =
      'Find my next trip from my booking emails and calendar. Confirm the flight dates, departure times and time zones, connections, and hotel. Check for conflicting information. Then plan how to get from the destination airport to my hotel, comparing public transport and taxi. Give me a short itinerary with source links, and clearly mark anything you cannot verify.';
    const request = detectPersonalReadRequest([{ role: 'user', content: requestText }]);
    if (!request?.mailQuery) throw new Error('Expected the compound trip read query');
    const flightQuery = request.mailQueries?.[0]?.query;
    const lodgingQuery = request.mailQueries?.[1]?.query;
    if (!flightQuery || !lodgingQuery) throw new Error('Expected separate trip mail queries');
    const evidence: ReadToolEvidence[] = [
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { query: lodgingQuery },
        result: {
          results: [
            { threadId: 'hotel-one', subject: 'Hotel reservation confirmation' },
            { threadId: 'hotel-two', subject: 'Hotel booking confirmation' },
            { threadId: 'flight-one', subject: 'Flight booking confirmation' },
          ],
          complete: true,
          hasMore: false,
        },
      },
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { query: flightQuery },
        result: {
          results: [
            { threadId: 'newsletter', subject: 'Airline news: flight routes this week' },
            { threadId: 'flight-one', subject: 'Flight booking confirmation' },
          ],
          complete: true,
          hasMore: false,
        },
      },
    ];
    expect(gmailThreadIdsToRead(evidence, request)).toEqual([
      'flight-one',
      'hotel-one',
      'hotel-two',
    ]);
  });

  it('selects a second distinct flight itinerary before competing lodging hits', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Find my next trip from booking emails and calendar, confirm flights and hotel, and compare public transport and taxi to my hotel.',
      ),
    );
    if (!request?.compoundTripDiscovery || !request.mailQueries)
      throw new Error('Expected compound discovery');
    const evidence: ReadToolEvidence[] = request.mailQueries.map(({ query, category }) => ({
      toolName: 'gmail.search',
      status: 'succeeded',
      fromCurrentTask: true,
      args: { query },
      result: {
        results:
          category === 'flight'
            ? [
                { threadId: 'future-flight', subject: 'Flight booking confirmation' },
                { threadId: 'return-flight', subject: 'Airline itinerary confirmation' },
              ]
            : [
                { threadId: 'hotel-reservation', subject: 'Hotel reservation confirmation' },
                { threadId: 'other-hotel', subject: 'Hotel booking confirmation' },
              ],
        complete: true,
        hasMore: false,
      },
    }));
    expect(gmailThreadIdsToRead(evidence, request)).toEqual([
      'future-flight',
      'hotel-reservation',
      'return-flight',
      'other-hotel',
    ]);
  });

  it('continues trip calendar pages through three pages, then keeps incomplete roster coverage honest', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Find my next trip from booking emails and calendar, confirm flights and hotel, and compare public transport and taxi to my hotel.',
      ),
      { now: new Date('2026-10-13T18:00:00Z'), timeZone: 'America/Los_Angeles' },
    );
    if (!request?.compoundTripDiscovery) throw new Error('Expected compound trip discovery');
    const args = { timeMin: request.timeWindow?.timeMin, timeMax: request.timeWindow?.timeMax };
    const pages: ReadToolEvidence[] = [
      {
        toolName: 'calendar.list_events',
        status: 'succeeded',
        fromCurrentTask: true,
        args,
        result: { events: [], complete: false, nextPageToken: 'calendar-2' },
      },
      {
        toolName: 'calendar.list_events',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { ...args, pageToken: 'calendar-2' },
        result: { events: [], complete: false, nextPageToken: 'calendar-3' },
      },
    ];
    expect(nextRequiredReadTool(request, pages)).toBe('calendar.list_events');
    expect(groundReadToolInput(request, 'calendar.list_events', {}, pages)).toMatchObject({
      ...args,
      pageToken: 'calendar-3',
      maxResults: 50,
    });
    pages.push({
      toolName: 'calendar.list_events',
      status: 'succeeded',
      fromCurrentTask: true,
      args: { ...args, pageToken: 'calendar-3' },
      result: {
        events: [],
        complete: true,
        calendarRosterComplete: false,
        unavailable: ['unavailable-calendar'],
      },
    });
    expect(nextRequiredReadTool(request, pages)).toBe('gmail.search');
  });

  it('binds trip searches and continuation cursors to each booking-intent category', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Find my next trip from my booking emails and calendar. Confirm the flight and hotel. Plan the route from the destination airport to my hotel.',
      ),
      { now: new Date('2026-10-13T18:00:00.000Z'), timeZone: 'America/Los_Angeles' },
    );
    if (!request?.mailQueries?.length) throw new Error('Expected typed trip queries');
    const [flight, lodging] = request.mailQueries;
    if (!flight || !lodging) throw new Error('Expected flight and lodging query entries');
    expect(groundReadToolInput(request, 'gmail.search', { query: 'untrusted' }, [])).toMatchObject({
      query: flight.query,
      maxResults: 20,
    });
    const flightPage: ReadToolEvidence = {
      toolName: 'gmail.search',
      status: 'succeeded',
      fromCurrentTask: true,
      args: { query: flight.query, maxResults: 20 },
      result: { results: [], complete: true, hasMore: false },
    };
    const calendarPage: ReadToolEvidence = {
      toolName: 'calendar.list_events',
      status: 'succeeded',
      fromCurrentTask: true,
      args: {
        timeMin: request.timeWindow?.timeMin,
        timeMax: request.timeWindow?.timeMax,
        calendarIds: [],
      },
      result: { events: [], complete: true },
    };
    expect(nextRequiredReadTool(request, [calendarPage, flightPage])).toBe('gmail.search');
    expect(
      groundReadToolInput(request, 'gmail.search', { query: 'untrusted', pageToken: 'fake' }, [
        flightPage,
      ]),
    ).toMatchObject({ query: lodging.query, maxResults: 20 });
    const lodgingPage: ReadToolEvidence = {
      toolName: 'gmail.search',
      status: 'succeeded',
      fromCurrentTask: true,
      args: { query: lodging.query, maxResults: 20 },
      result: { results: [], complete: false, hasMore: true, nextPageToken: 'lodging-next' },
    };
    expect(
      groundReadToolInput(request, 'gmail.search', { query: 'untrusted', pageToken: 'fake' }, [
        flightPage,
        lodgingPage,
      ]),
    ).toMatchObject({ query: lodging.query, maxResults: 20, pageToken: 'lodging-next' });
    expect(
      groundReadToolInput(request, 'gmail.search', { query: 'untrusted' }, [
        {
          ...flightPage,
          result: {
            results: [],
            complete: false,
            hasMore: true,
            nextPageToken: 'flight-next',
          },
        },
      ]),
    ).toMatchObject({ query: flight.query, pageToken: 'flight-next' });
  });

  it('uses the bounded trip budget for distinct flight and lodging booking candidates', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Find my next trip from my booking emails and calendar. Confirm the flight and hotel. Plan the route from the destination airport to my hotel.',
      ),
    );
    if (!request?.mailQueries?.length) throw new Error('Expected typed trip queries');
    const flightQuery = request.mailQueries.find((entry) => entry.category === 'flight')?.query;
    const lodgingQuery = request.mailQueries.find((entry) => entry.category === 'lodging')?.query;
    if (!flightQuery || !lodgingQuery) throw new Error('Expected flight and lodging searches');
    const evidence: ReadToolEvidence[] = [
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { query: flightQuery },
        result: {
          results: [
            { threadId: 'flight-candidate-a', subject: 'Flight booking confirmation' },
            { threadId: 'flight-candidate-b', subject: 'Airline itinerary confirmation' },
          ],
          complete: true,
          hasMore: false,
        },
      },
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { query: lodgingQuery },
        result: {
          results: [{ threadId: 'lodging-candidate', subject: 'Hotel reservation confirmation' }],
          complete: true,
          hasMore: false,
        },
      },
    ];
    expect(gmailThreadIdsToRead(evidence, request)).toEqual([
      'flight-candidate-a',
      'lodging-candidate',
      'flight-candidate-b',
    ]);
    const afterTwoReads: ReadToolEvidence[] = [
      {
        toolName: 'calendar.list_events',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { timeMin: request.timeWindow?.timeMin, timeMax: request.timeWindow?.timeMax },
        result: { events: [], complete: true, calendarRosterComplete: true, unavailable: [] },
      },
      ...evidence,
      ...['flight-candidate-a', 'lodging-candidate'].map((threadId) => ({
        toolName: 'gmail.read_thread',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { threadId },
        result: { complete: true },
      })),
    ];
    expect(nextRequiredReadTool(request, afterTwoReads)).toBe('gmail.read_thread');
    expect(buildReadToolInput(request, 'gmail.read_thread', afterTwoReads)).toMatchObject({
      threadId: 'flight-candidate-b',
    });
  });

  it('finds booked flight and generic reservation subjects only when returned metadata substantiates each category', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Find my next trip from my booking emails and calendar. Confirm the flight and hotel. Plan the route from the destination airport to my hotel.',
      ),
    );
    if (!request?.mailQueries?.length) throw new Error('Expected typed trip queries');
    const flightQuery = request.mailQueries.find((entry) => entry.category === 'flight')?.query;
    const lodgingQuery = request.mailQueries.find((entry) => entry.category === 'lodging')?.query;
    if (!flightQuery || !lodgingQuery) throw new Error('Expected flight and lodging searches');
    const evidence: ReadToolEvidence[] = [
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { query: flightQuery },
        result: {
          results: [
            { threadId: 'booked-flight', subject: 'Fwd: Flight - BOOKED - City details' },
            { threadId: 'flight-news', subject: 'Flight booking offers for next summer' },
          ],
          complete: true,
          hasMore: false,
        },
      },
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { query: lodgingQuery },
        result: {
          results: [
            { threadId: 'generic-confirmation', subject: 'Booking confirmation' },
            {
              threadId: 'your-reservation',
              subject: 'Your reservation',
              snippet: 'Hotel accommodation and check-in details',
            },
          ],
          complete: true,
          hasMore: false,
        },
      },
    ];
    expect(gmailThreadIdsToRead(evidence, request)).toEqual([
      'booked-flight',
      'your-reservation',
      'generic-confirmation',
    ]);
  });

  it('recognizes only the direct, bounded, explicitly no-send email review request', () => {
    const prompt =
      'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet.';
    expect(detectPersonalReadRequest(turn(prompt))).toMatchObject({
      kind: 'email',
      firstToolName: 'gmail.search',
      mailQuery: 'newer_than:7d -from:me',
      requiresThreadRead: true,
      emailReview: { windowDays: 7, requestedCount: 5 },
    });
    const review = detectPersonalReadRequest(turn(prompt));
    if (!review) throw new Error('Expected email review request');
    expect(buildReadToolInput(review, 'gmail.search', [])).toMatchObject({
      query: EMAIL_REVIEW_QUERY,
      maxResults: 100,
    });
    expect(
      detectPersonalReadRequest(
        turn(
          'Review my recent emails from the past 7 days. Identify the 5 most important requests that still need my reply. Say why each matters, note any deadlines, and draft replies with the relevant thread context. Do not send anything yet.',
        ),
      ),
    ).toMatchObject({ emailReview: { windowDays: 7, requestedCount: 5 } });
  });

  it('routes paraphrased local-calendar email briefs with their exact period and requested count', () => {
    const request = detectPersonalReadRequest(
      turn(
        'From my connected inbox over the last 14 local calendar days, prepare an action brief of up to five outstanding reply requests. Read the full threads and include deadlines and draft replies, but do not send anything.',
      ),
      { now: new Date('2026-10-15T12:00:00.000Z'), timeZone: 'America/Los_Angeles' },
    );
    expect(request).toMatchObject({
      kind: 'email',
      mailQuery: 'after:2026/09/30 before:2026/10/18 -from:me',
      emailReview: {
        windowDays: 14,
        requestedCount: 5,
        startAt: '2026-10-02T07:00:00.000Z',
        endAt: '2026-10-16T07:00:00.000Z',
      },
    });
    if (!request) throw new Error('expected a typed inbox review request');
    expect(buildReadToolInput(request, 'gmail.search', [])).toMatchObject({
      query: 'after:2026/09/30 before:2026/10/18 -from:me',
      maxResults: 100,
    });
    const searchPage: ReadToolEvidence = {
      toolName: 'gmail.search',
      status: 'succeeded',
      args: { query: request.mailQuery },
      result: {
        complete: false,
        hasMore: true,
        nextPageToken: 'local-days-next-page',
      },
    };
    expect(nextRequiredReadTool(request, [searchPage])).toBe('gmail.search');
    expect(buildReadToolInput(request, 'gmail.search', [searchPage])).toMatchObject({
      query: request.mailQuery,
      pageToken: 'local-days-next-page',
    });
  });

  it('keeps exact local inbox boundaries across daylight-saving time', () => {
    const request = detectPersonalReadRequest(
      turn(
        'From my inbox over the past fourteen local calendar days, prepare an action brief of up to three outstanding reply requests and read the full threads.',
      ),
      { now: new Date('2026-11-03T12:00:00.000Z'), timeZone: 'America/Los_Angeles' },
    );
    expect(request).toMatchObject({
      emailReview: {
        windowDays: 14,
        requestedCount: 3,
        startAt: '2026-10-21T07:00:00.000Z',
        endAt: '2026-11-04T08:00:00.000Z',
      },
    });
  });

  it('routes a latest unanswered inbox question to one newest-first full-thread check', () => {
    const request = detectPersonalReadRequest(
      turn("What's the latest message in my inbox that I still need to reply to?"),
    );
    expect(request).toMatchObject({
      kind: 'email',
      firstToolName: 'gmail.search',
      requiresThreadRead: true,
      mailQuery: 'in:inbox -from:me',
      emailReview: { requestedCount: 1, latestUnanswered: true },
    });
    if (!request) throw new Error('expected a typed latest-reply lookup');
    expect(nextRequiredReadTool(request, [])).toBe('gmail.search');
    expect(buildReadToolInput(request, 'gmail.search', [])).toMatchObject({
      query: 'in:inbox -from:me',
      maxResults: 100,
    });
    const searchResult: ReadToolEvidence = {
      toolName: 'gmail.search',
      status: 'succeeded',
      args: { query: request.mailQuery },
      result: {
        complete: true,
        hasMore: false,
        mailboxSearched: 'assistant-bot@example.com',
        configuredOwnerMailbox: 'owner@example.com',
        results: [
          {
            threadId: 'newest-thread',
            date: '2026-10-15T10:00:00Z',
            subject: 'Quick question',
            snippet: 'Could you let me know?',
          },
        ],
      },
    };
    const review = request.emailReview;
    if (!review) throw new Error('expected a typed latest-reply review');
    const selectedRequest = {
      ...request,
      emailReview: { ...review, selectedThreadIds: ['newest-thread'] },
    };
    expect(nextRequiredReadTool(selectedRequest, [searchResult])).toBe('gmail.read_thread');
    expect(buildReadToolInput(selectedRequest, 'gmail.read_thread', [searchResult])).toMatchObject({
      threadId: 'newest-thread',
    });
  });

  it('does not treat an explicitly non-required reply as an unanswered-message lookup', () => {
    for (const text of [
      "What's the latest message in my inbox that I don't need to reply to?",
      'What is the latest email in my inbox that I do not need to reply to?',
      'Show me the latest message in my inbox that needs no reply.',
      "What's the latest message in my inbox that doesn't need my reply?",
      'What is the newest email in my inbox that does not need my response?',
      'Show the latest message in my inbox that is not awaiting my reply.',
    ]) {
      const request = detectPersonalReadRequest(turn(text));
      expect(request?.emailReview?.latestUnanswered).not.toBe(true);
    }

    expect(
      detectPersonalReadRequest(
        turn("What's the latest message in my inbox that I still need to reply to?"),
      )?.emailReview?.latestUnanswered,
    ).toBe(true);
  });

  it('does not route hypothetical or mixed-send latest-message requests as read-only reviews', () => {
    expect(
      detectPersonalReadRequest(
        turn(
          'If I asked for the latest message in my inbox that I still need to reply to, what would you find?',
        ),
      ),
    ).toBeNull();
    expect(
      detectPersonalReadRequest(
        turn("What's the latest message in my inbox that I still need to reply to? Send it now."),
      ),
    ).toBeNull();
  });

  it('does not claim exact local-day or unsupported oversized review coverage', () => {
    const missingZone = detectPersonalReadRequest(
      turn(
        'From my inbox over the last 14 local calendar days, prepare an action brief of up to five outstanding reply requests and read the full threads.',
      ),
    );
    expect(missingZone?.scopeIssue).toMatch(/valid local time zone/i);
    expect(missingZone && nextRequiredReadTool(missingZone, [])).toBeUndefined();

    const tooManyDays = detectPersonalReadRequest(
      turn(
        'From my inbox over the last 45 days, prepare an action brief of up to five outstanding reply requests and read the full threads.',
      ),
    );
    expect(tooManyDays?.scopeIssue).toMatch(/at most 30 days/i);
    expect(tooManyDays && nextRequiredReadTool(tooManyDays, [])).toBeUndefined();

    const tooManyItems = detectPersonalReadRequest(
      turn(
        'From my inbox over the last 14 days, prepare an action brief of up to eight outstanding reply requests and read the full threads.',
      ),
    );
    expect(tooManyItems?.scopeIssue).toMatch(/at most five/i);
    expect(tooManyItems && nextRequiredReadTool(tooManyItems, [])).toBeUndefined();
  });

  it.each([
    'If I asked you to review my emails from the last seven days, find the five most important requests that still need my response, explain why each matters, identify deadlines, draft replies using the relevant thread context, and don’t send anything yet.',
    'Should I review my emails from the last seven days and draft replies to the five most important requests that need my response? Don’t send anything yet.',
    '> Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet.',
    'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet. Also email Riley the results.',
    'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context.',
  ])(
    'does not widen the no-send review intent to quoted, conditional, or mixed requests',
    (text) => {
      expect(detectPersonalReadRequest(turn(text))).toBeNull();
    },
  );

  it('routes an owner weekly planning request through availability plus bounded event pages', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Review my calendar for next week and identify scheduling conflicts and overloaded days. Find three realistic 90-minute focus blocks during working hours, allowing time for travel and breaks. Recommend changes, but show me the plan before editing my calendar.',
      ),
      { now: new Date('2026-10-09T12:00:00.000Z'), timeZone: 'America/Los_Angeles' },
    );
    expect(request).toMatchObject({
      kind: 'calendar',
      weeklyCalendarPlan: true,
      firstToolName: 'calendar.availability',
      queryTerms: [],
      timeWindow: {
        timeMin: '2026-10-12T07:00:00.000Z',
        timeMax: '2026-10-19T07:00:00.000Z',
      },
      calendarPlanOptions: {
        includeWorkloadAssessment: true,
        includeTravelBuffers: true,
      },
    });
    if (!request) throw new Error('expected a typed weekly plan request');
    expect(nextRequiredReadTool(request, [])).toBe('calendar.availability');
    const availability: ReadToolEvidence = {
      toolName: 'calendar.availability',
      status: 'succeeded',
      args: { timeMin: request.timeWindow?.timeMin, timeMax: request.timeWindow?.timeMax },
      result: { busy: [], complete: true },
    };
    expect(nextRequiredReadTool(request, [availability])).toBe('calendar.list_events');
    const firstPage: ReadToolEvidence = {
      toolName: 'calendar.list_events',
      status: 'succeeded',
      args: { timeMin: request.timeWindow?.timeMin, timeMax: request.timeWindow?.timeMax },
      result: { events: [], complete: false, nextPageToken: 'page-two' },
    };
    expect(nextRequiredReadTool(request, [availability, firstPage])).toBe('calendar.list_events');
    expect(
      groundReadToolInput(request, 'calendar.list_events', { pageToken: 'model-forged' }, [
        availability,
        firstPage,
      ]),
    ).toMatchObject({ pageToken: 'page-two', maxResults: 50 });
    const secondPage: ReadToolEvidence = {
      toolName: 'calendar.list_events',
      status: 'succeeded',
      args: {
        timeMin: request.timeWindow?.timeMin,
        timeMax: request.timeWindow?.timeMax,
        pageToken: 'page-two',
      },
      result: { events: [], complete: false, nextPageToken: 'page-three' },
    };
    expect(nextRequiredReadTool(request, [availability, firstPage, secondPage])).toBe(
      'calendar.list_events',
    );
    const thirdPage: ReadToolEvidence = {
      toolName: 'calendar.list_events',
      status: 'succeeded',
      args: {
        timeMin: request.timeWindow?.timeMin,
        timeMax: request.timeWindow?.timeMax,
        pageToken: 'page-three',
      },
      result: { events: [], complete: false, nextPageToken: 'page-four' },
    };
    expect(
      nextRequiredReadTool(request, [availability, firstPage, secondPage, thirdPage]),
    ).toBeUndefined();
  });

  it('routes a bounded next-working-days focus plan after Friday morning to calendar availability only', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Review my calendar for the next 3 working days. Find 2 90-minute focus blocks during working hours, with 15-minute breaks around meetings. Show a compact table and do not edit anything.',
      ),
      { now: new Date('2026-10-09T12:00:00.000Z'), timeZone: 'America/Los_Angeles' },
    );
    expect(request).toMatchObject({
      kind: 'calendar',
      weeklyCalendarPlan: true,
      calendarPlanOptions: {
        focusMinutes: 90,
        slotCount: 2,
        breakMinutes: 15,
        workingDays: 3,
        meetingBufferMinutes: 15,
        includeWorkloadAssessment: false,
        includeTravelBuffers: false,
      },
      firstToolName: 'calendar.availability',
      timeWindow: {
        timeMin: '2026-10-12T07:00:00.000Z',
        timeMax: '2026-10-15T07:00:00.000Z',
        label: 'the next 3 working days',
      },
    });
    expect(request?.mailQuery).toBeUndefined();
    expect(request?.firstToolName).not.toBe('gmail.search');
  });

  it('starts a next-working-days focus plan on the next future weekday after Friday evening', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Look at my calendar for the next three working days. Suggest two 60-minute focus slots between 09:00 and 17:00, leave 15-minute breaks around meetings, and explain any limits in the availability check. Show the plan for review without creating events.',
      ),
      { now: new Date('2026-10-17T01:30:00.000Z'), timeZone: 'America/Los_Angeles' },
    );
    expect(request?.timeWindow).toMatchObject({
      timeMin: '2026-10-19T07:00:00.000Z',
      timeMax: '2026-10-22T07:00:00.000Z',
      label: 'the next 3 working days',
    });
  });

  it('skips the weekend when the next-working-days focus request arrives Saturday', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Review my calendar for the next 3 working days. Find 2 90-minute focus blocks during working hours, with 15-minute breaks around meetings. Show a compact table and do not edit anything.',
      ),
      { now: new Date('2026-10-17T18:00:00.000Z'), timeZone: 'America/Los_Angeles' },
    );
    expect(request?.timeWindow).toMatchObject({
      timeMin: '2026-10-19T07:00:00.000Z',
      timeMax: '2026-10-22T07:00:00.000Z',
      label: 'the next 3 working days',
    });
  });

  it('requires mailbox source reads for a requested reservation card while keeping other actions separate', () => {
    expect(
      detectPersonalReadRequest(
        turn('Create a card for my hotel reservation in my mailbox under QA-BOOKING-123.'),
      ),
    ).toMatchObject({
      kind: 'email',
      firstToolName: 'gmail.search',
      mailQuery: 'QA-BOOKING-123',
      requiresThreadRead: true,
    });
    for (const text of [
      'Do not create a card for my hotel reservation in my mailbox.',
      'Create a card for my hotel reservation in my mailbox and email it to Alice.',
      'How do reservation cards work?',
    ])
      expect(detectPersonalReadRequest(turn(text))).toBeNull();
  });
  it('leaves future notification requests for the watch planner', () => {
    expect(detectPersonalReadRequest(turn('Tell me if Alex emails me'))).toBeNull();
    expect(
      detectPersonalReadRequest(
        turn('Check whether Alex replied; if not, notify me when they do.'),
      ),
    ).toBeNull();
  });

  it('retains present mailbox lookups as read requests', () => {
    expect(detectPersonalReadRequest(turn('Has Alex emailed me?'))).toMatchObject({
      kind: 'email',
      firstToolName: 'gmail.search',
    });
  });

  it.each([
    ['yesterday', '2026-09-07T07:00:00.000Z', '2026-09-08T07:00:00.000Z'],
    ['last week', '2026-08-31T07:00:00.000Z', '2026-09-07T07:00:00.000Z'],
    ['last Monday', '2026-09-07T07:00:00.000Z', '2026-09-08T07:00:00.000Z'],
    ['last month', '2026-08-01T07:00:00.000Z', '2026-09-01T07:00:00.000Z'],
    ['past 3 days', '2026-09-05T07:00:00.000Z', '2026-09-08T07:00:00.000Z'],
  ])('keeps historical calendar range %s in the past', (text, timeMin, timeMax) => {
    expect(
      resolveTimeWindow(text, 'calendar', false, {
        now: new Date('2026-09-08T12:00:00Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toMatchObject({ timeMin, timeMax });
  });

  it('returns a typed interval while preserving the legacy public window shape', () => {
    const options = {
      now: new Date('2026-09-08T12:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    };
    const resolved = resolveTemporalIntent(
      'What did I have last week?',
      'calendar',
      false,
      options,
    );
    expect(resolved).toMatchObject({
      kind: 'resolved',
      intent: {
        direction: 'past',
        anchor: {
          instant: options.now.toISOString(),
          timeZone: 'America/Los_Angeles',
          localDate: '2026-09-08',
        },
        interval: {
          start: '2026-08-31T07:00:00.000Z',
          endExclusive: '2026-09-07T07:00:00.000Z',
        },
        granularity: 'week',
      },
    });
    expect(resolveTimeWindow('What did I have last week?', 'calendar', false, options)).toEqual({
      timeMin: '2026-08-31T07:00:00.000Z',
      timeMax: '2026-09-07T07:00:00.000Z',
      label: 'last week',
    });
  });

  it.each([
    'What was on my calendar 3 years ago?',
    'What is on my calendar next 2 months?',
    'What was on my calendar last week and 3 years ago?',
    'What will be on my calendar in two months?',
    'What is on my calendar two months from now?',
    'What did I have three years ago on my calendar?',
  ])('refuses recognized but unsupported relative period: %s', (text) => {
    const options = {
      now: new Date('2026-09-08T12:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    };
    expect(resolveTemporalIntent(text, 'calendar', false, options).kind).toBe('unsupported');
    expect(resolveTimeWindow(text, 'calendar', false, options)).toBeUndefined();
    const request = detectPersonalReadRequest(turn(text), options);
    expect(request).toMatchObject({ temporalIssue: expect.stringMatching(/can’t safely search/i) });
    if (!request) throw new Error('Expected a calendar request carrying the temporal issue');
    expect(nextRequiredReadTool(request, [])).toBeUndefined();
    expect(buildReadToolInput(request, request.firstToolName, [])).toBeNull();
  });

  it.each([
    ['LAST 2 WEEKS', '2026-08-25T07:00:00.000Z', '2026-09-08T07:00:00.000Z'],
    ['past 2 WEEKS', '2026-08-25T07:00:00.000Z', '2026-09-08T07:00:00.000Z'],
  ])(
    'keeps case-insensitive plural week counts at the requested scale: %s',
    (text, timeMin, timeMax) => {
      expect(
        resolveTimeWindow(`What was on my calendar ${text}?`, 'calendar', false, {
          now: new Date('2026-09-08T12:00:00.000Z'),
          timeZone: 'America/Los_Angeles',
        }),
      ).toMatchObject({ timeMin, timeMax });
    },
  );

  it.each(['last 0 days', 'last 0 weeks', 'past 0 days', 'next 0 days'])(
    'blocks a recognized zero-length period instead of choosing a default window: %s',
    (period) => {
      const options = {
        now: new Date('2026-09-08T12:00:00.000Z'),
        timeZone: 'America/Los_Angeles',
      };
      const text = `What was on my calendar ${period}?`;
      expect(resolveTemporalIntent(text, 'calendar', false, options).kind).toBe('unsupported');
      const request = detectPersonalReadRequest(turn(text), options);
      if (!request) throw new Error('Expected a calendar request carrying the temporal issue');
      expect(request.temporalIssue).toMatch(/can’t safely search/i);
      expect(nextRequiredReadTool(request, [])).toBeUndefined();
      expect(buildReadToolInput(request, request.firstToolName, [])).toBeNull();
    },
  );

  it('keeps the unsupported plural period scale and rejects a later unsupported phrase', () => {
    const options = {
      now: new Date('2026-09-08T12:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    };
    expect(
      resolveTemporalIntent('What happened 3 years ago?', 'calendar', false, options),
    ).toMatchObject({ kind: 'unsupported', granularity: 'year' });
    expect(
      resolveTemporalIntent('What happened last week and 3 years ago?', 'calendar', false, options),
    ).toMatchObject({ kind: 'unsupported', granularity: 'year' });
  });

  it.each(['February 30', '2026-02-30'])('blocks an invalid explicit date: %s', (date) => {
    const request = detectPersonalReadRequest(turn(`What was on my calendar on ${date}?`), {
      now: new Date('2026-09-08T12:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    });
    if (!request) throw new Error('Expected a calendar read request');
    expect(request.temporalIssue).toMatch(/can’t safely resolve that calendar date or period/i);
    expect(nextRequiredReadTool(request, [])).toBeUndefined();
    expect(buildReadToolInput(request, request.firstToolName, [])).toBeNull();
  });

  it('does not let a named search bypass an unsupported temporal interval', () => {
    const request = detectPersonalReadRequest(
      turn('Find my dentist appointment from 3 years ago on my calendar.'),
      {
        now: new Date('2026-09-08T12:00:00.000Z'),
        timeZone: 'America/Los_Angeles',
      },
    );
    if (!request) throw new Error('Expected a calendar search request');
    expect(request.firstToolName).toBe('calendar.search_events');
    expect(request.temporalIssue).toMatch(/can’t safely search/i);
    expect(nextRequiredReadTool(request, [])).toBeUndefined();
    expect(groundReadToolInput(request, request.firstToolName, { query: 'dentist' }, [])).toEqual(
      {},
    );
    expect(buildReadToolInput(request, request.firstToolName, [])).toBeNull();
  });

  it('binds next-event selection to one captured request instant', () => {
    const requestAt = new Date('2026-09-23T17:00:00.000Z');
    const resolved = resolveTemporalIntent(
      'What is my next calendar event?',
      'calendar',
      false,
      { now: requestAt, timeZone: 'America/Los_Angeles' },
      'next-event',
    );
    expect(resolved).toMatchObject({
      kind: 'resolved',
      intent: {
        direction: 'future',
        anchor: { instant: requestAt.toISOString() },
        interval: {
          start: requestAt.toISOString(),
          endExclusive: '2026-09-30T07:00:00.000Z',
        },
      },
    });
  });

  it('resolves last year and an unqualified past named date as historical civil ranges', () => {
    const options = {
      now: new Date('2026-09-08T12:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    };
    expect(resolveTimeWindow('What happened last year?', 'calendar', false, options)).toMatchObject(
      {
        timeMin: '2025-01-01T08:00:00.000Z',
        timeMax: '2026-01-01T08:00:00.000Z',
      },
    );
    expect(
      resolveTimeWindow('What happened on March 12?', 'calendar', false, options),
    ).toMatchObject({
      timeMin: '2026-03-12T07:00:00.000Z',
      timeMax: '2026-03-13T07:00:00.000Z',
    });
  });

  it('resolves last Friday to the previous Friday when the request itself arrives on Friday', () => {
    expect(
      resolveTimeWindow('What did I have last Friday?', 'calendar', false, {
        now: new Date('2026-09-11T18:00:00.000Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toMatchObject({
      timeMin: '2026-09-04T07:00:00.000Z',
      timeMax: '2026-09-05T07:00:00.000Z',
    });
  });

  it('resolves yesterday across the spring daylight-saving boundary using local civil days', () => {
    expect(
      resolveTimeWindow('What did I have yesterday?', 'calendar', false, {
        now: new Date('2026-03-09T07:30:00.000Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toMatchObject({
      timeMin: '2026-03-08T08:00:00.000Z',
      timeMax: '2026-03-09T07:00:00.000Z',
    });
  });

  it.each([
    'Is my calendar clear tomorrow?',
    'Is our schedule empty on Monday?',
    'Check whether my agenda is clear tomorrow.',
  ])('checks all-calendar availability for %s', (text) => {
    expect(
      detectPersonalReadRequest(turn(text), {
        now: new Date('2026-09-08T12:00:00Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toMatchObject({
      kind: 'calendar',
      firstToolName: 'calendar.availability',
      timeWindow: { timeMin: expect.any(String), timeMax: expect.any(String) },
    });
  });

  it.each([
    'Plan a hypothetical work morning from 09:00 to 12:30. Include a 90-minute deep-work block, a 45-minute review, a 30-minute meeting at 11:30, and two 15-minute breaks. Show a compact table with start and end times, identify any unused time, and check that nothing overlaps. Do not look at or change my real calendar.',
    'Hypothetically, make a sample 09:00–12:30 schedule with deep work, a review, an 11:30 meeting, and two breaks. Please do not inspect my actual calendar; use only the details in this message.',
    'Lay out a pretend work morning with a 90-minute focus block and a 30-minute meeting at 11:30. Without checking my calendar, show the times and any unused slot.',
  ])('does not turn a hypothetical schedule into a private read: %s', (text) => {
    expect(detectPersonalReadRequest(turn(text))).toBeNull();
  });

  it('keeps explicit calendar and email reads enabled when the owner only forbids changes', () => {
    expect(
      detectPersonalReadRequest(
        turn('What meetings do I have on my calendar tomorrow? Do not edit it.'),
      ),
    ).toMatchObject({ kind: 'calendar', firstToolName: 'calendar.list_events' });
    expect(
      detectPersonalReadRequest(
        turn('Search my email for the hotel confirmation. Do not reply or change anything.'),
      ),
    ).toMatchObject({ kind: 'email', firstToolName: 'gmail.search' });
  });

  it('honors a prohibition for one private source without suppressing a separate allowed read', () => {
    expect(
      detectPersonalReadRequest(
        turn('Do not look at my real calendar. Search my email for the hotel confirmation.'),
      ),
    ).toMatchObject({ kind: 'email', firstToolName: 'gmail.search' });
    expect(
      detectPersonalReadRequest(
        turn('Do not search my email. What meetings do I have on my calendar tomorrow?'),
      ),
    ).toMatchObject({ kind: 'calendar', firstToolName: 'calendar.list_events' });
  });

  it('keeps tomorrow calendar overviews bounded to the requested calendar day', () => {
    const text =
      'What is on my calendar tomorrow? Use my local time zone, include event times and calendar names, and point out overlaps. Give a compact answer with source links. Do not edit anything.';
    const request = detectPersonalReadRequest(turn(text), {
      now: new Date('2026-10-13T18:08:55.000Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(request).toMatchObject({
      kind: 'calendar',
      queryTerms: [],
      firstToolName: 'calendar.list_events',
      requiresThreadRead: false,
      includeCalendarOverlapSummary: true,
      compactCalendarBriefing: true,
      timeWindow: {
        timeMin: '2026-10-14T07:00:00.000Z',
        timeMax: '2026-10-15T07:00:00.000Z',
      },
    });
    expect(request?.mailQuery).toBeUndefined();
    if (!request) throw new Error('Expected a calendar request');
    expect(buildReadToolInput(request, 'calendar.list_events', [])).toMatchObject({
      timeMin: '2026-10-14T07:00:00.000Z',
      timeMax: '2026-10-15T07:00:00.000Z',
    });
  });

  it.each([
    'What does my calendar look like tomorrow?',
    "What's on my agenda tomorrow?",
    'What do I have scheduled tomorrow?',
  ])('defaults an ordinary day overview to compact agenda presentation: %s', (text) => {
    const request = detectPersonalReadRequest(turn(text), {
      now: new Date('2026-10-13T18:08:55.000Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(request).toMatchObject({
      kind: 'calendar',
      firstToolName: 'calendar.list_events',
      includeCalendarBriefing: true,
      compactCalendarBriefing: true,
      includeCalendarOverlapSummary: true,
      timeWindow: {
        timeMin: '2026-10-14T07:00:00.000Z',
        timeMax: '2026-10-15T07:00:00.000Z',
      },
    });
  });

  it.each(['and include venue names', 'with locations', 'with addresses', 'with venues'])(
    'adds location details to compact calendar reads only when explicitly requested: %s',
    (locationRequest) => {
      const options = {
        now: new Date('2026-10-13T18:08:55.000Z'),
        timeZone: 'America/Los_Angeles',
      };
      const compact = detectPersonalReadRequest(
        turn('What is on my calendar tomorrow? Give me a short practical briefing.'),
        options,
      );
      const withLocations = detectPersonalReadRequest(
        turn(
          `What is on my calendar tomorrow? Give me a short practical briefing ${locationRequest}.`,
        ),
        options,
      );

      expect(compact?.includeCalendarLocations).toBeUndefined();
      expect(withLocations?.includeCalendarLocations).toBe(true);
      expect(withLocations?.queryTerms).toEqual([]);
    },
  );

  it('keeps explicit detail, event-specific, statistics, weekly-plan, and overlap-exclusion intents distinct', () => {
    const detail = detectPersonalReadRequest(
      turn('Show my calendar tomorrow as a full detailed list of every event.'),
      { now: new Date('2026-10-13T18:08:55.000Z'), timeZone: 'America/Los_Angeles' },
    );
    expect(detail).toMatchObject({ kind: 'calendar', firstToolName: 'calendar.list_events' });
    expect(detail?.includeCalendarBriefing).toBeUndefined();
    expect(detail?.compactCalendarBriefing).toBeUndefined();

    const specific = detectPersonalReadRequest(turn('What time is my meeting tomorrow?'));
    expect(specific?.kind).toBe('calendar_email');
    expect(specific?.compactCalendarBriefing).toBeUndefined();

    const statistics = detectPersonalReadRequest(
      turn(
        'For my calendar over the next 3 weekdays, how many days have an event lasting at least 45 minutes? Find gaps of at least 30 minutes between in-person events.',
      ),
    );
    expect(statistics?.calendarEventAnalysis).toBeDefined();
    expect(statistics?.compactCalendarBriefing).toBeUndefined();

    const plan = detectPersonalReadRequest(
      turn(
        'Review my calendar for next week and find three focus blocks during working hours, allowing time for breaks.',
      ),
    );
    expect(plan?.weeklyCalendarPlan).toBe(true);
    expect(plan?.compactCalendarBriefing).toBeUndefined();

    const excluded = detectPersonalReadRequest(
      turn('What does my calendar look like tomorrow? Keep it short; do not check for overlaps.'),
      { now: new Date('2026-10-13T18:08:55.000Z'), timeZone: 'America/Los_Angeles' },
    );
    expect(excluded?.compactCalendarBriefing).toBe(true);
    expect(excluded?.includeCalendarOverlapSummary).toBeUndefined();
  });

  it('retains checked agenda grounding when a request also asks about weather', () => {
    const request = detectPersonalReadRequest(
      turn("What's on my calendar tomorrow and what's the weather?"),
    );
    expect(request?.includeCalendarBriefing).toBe(true);
    expect(request?.compactCalendarBriefing).toBe(true);
    expect(request?.includeCalendarOverlapSummary).toBe(true);
  });

  it('detects a concise practical calendar briefing without coupling to a named skill', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Use my saved skill "Clear task planning" to review my calendar for tomorrow and give me a short practical briefing. Say which saved skill you used, or clearly say if that skill could not be retrieved. Use actual calendar evidence, show source links, and do not change anything.',
      ),
      {
        now: new Date('2026-10-13T18:08:55.000Z'),
        timeZone: 'America/Los_Angeles',
      },
    );
    expect(request).toMatchObject({
      kind: 'calendar',
      firstToolName: 'calendar.list_events',
      includeCalendarBriefing: true,
      compactCalendarBriefing: true,
      includeCalendarOverlapSummary: true,
      timeWindow: {
        timeMin: '2026-10-14T07:00:00.000Z',
        timeMax: '2026-10-15T07:00:00.000Z',
      },
    });
    expect(request?.mailQuery).toBeUndefined();
  });

  it.each([
    'Check my calendar tomorrow for overlaps.',
    'Review my schedule next week and identify conflicts.',
    'Don’t just look for overlaps; check conflicts too.',
    'Do not change my calendar, but check for conflicts.',
    'Check my calendar: don’t mention overlaps; check conflicts instead.',
    'Review my calendar: don’t include overlaps, but report conflicts.',
  ])('includes overlap analysis when explicitly requested: %s', (text) => {
    expect(detectPersonalReadRequest(turn(text))?.includeCalendarOverlapSummary).toBe(true);
  });

  it.each([
    'Brief me on my calendar tomorrow, but do not check for overlaps.',
    'Give me a short schedule overview; no need to look for conflicts.',
  ])('does not add overlap analysis when explicitly excluded: %s', (text) => {
    expect(detectPersonalReadRequest(turn(text))?.includeCalendarOverlapSummary).toBeUndefined();
  });

  it.each(['Make this sentence clear.', 'Is the explanation clear?', 'Empty my inbox tomorrow.'])(
    'does not confuse another clear or empty request with availability: %s',
    (text) => {
      expect(detectPersonalReadRequest(turn(text))?.firstToolName).not.toBe(
        'calendar.availability',
      );
    },
  );

  it('leaves saved-skill inventory questions out of the calendar read route', () => {
    expect(
      detectPersonalReadRequest(
        turn('What saved skills do I have that could help plan a busy day?'),
      ),
    ).toBeNull();
  });

  it('still routes an ordinary busy-day availability request to the calendar', () => {
    expect(
      detectPersonalReadRequest(turn('Check my calendar availability for my busy day tomorrow.'))
        ?.firstToolName,
    ).toBe('calendar.availability');
  });

  it('retains the original lookup on assent, but not when accepting a write or a different topic', () => {
    const history = [
      { role: 'user', content: 'Where are we staying?' },
      { role: 'assistant', content: 'Should I check the hotel confirmation?' },
      { role: 'user', content: 'Yes, please' },
    ];
    expect(detectPersonalReadRequest(history)).toMatchObject({ answerFocus: 'lodging' });
    for (const offer of [
      'Should I book the hotel?',
      'I can check that and cancel it.',
      'I can look up the weather.',
    ]) {
      expect(
        detectPersonalReadRequest([
          { role: 'user', content: 'Where are we staying?' },
          { role: 'assistant', content: offer },
          { role: 'user', content: 'Yes, please' },
        ]),
      ).toBeNull();
    }
  });

  it.each(['Where are we staying', 'Which hotel did we book?', 'Where is our hotel?'])(
    'requires booking evidence for %s',
    (text) => {
      const request = detectPersonalReadRequest(turn(text));
      expect(request).toMatchObject({
        kind: 'calendar_email',
        firstToolName: 'calendar.search_events',
        requiresThreadRead: true,
        answerFocus: 'lodging',
      });
      expect(request?.mailQuery).not.toContain('newer_than:');
    },
  );

  it.each(['What time is check-in?', 'What is the address?', 'Where is it?'])(
    'resolves %s from the recent owner topic, not an assistant guess',
    (text) => {
      const request = detectPersonalReadRequest([
        { role: 'user', parts: [{ type: 'text', text: 'Save my hotel reservation for tomorrow' }] },
        { role: 'assistant', content: 'You are probably staying at Invented Hotel.' },
        { role: 'user', content: text },
      ]);
      expect(request).toMatchObject({ answerFocus: 'lodging', requiresThreadRead: true });
      expect(request?.mailQuery).not.toMatch(/invented|tomorrow|newer_than/i);
    },
  );

  it('does not resurrect a stale topic or use assistant-only speculation as context', () => {
    expect(
      detectPersonalReadRequest(turn('What is the address?', 'Your hotel is in Boston.')),
    ).toBeNull();
    expect(
      detectPersonalReadRequest([
        { role: 'user', content: 'Recommend a hotel in Tokyo' },
        { role: 'user', content: 'What is the address?' },
      ]),
    ).toBeNull();
    expect(
      detectPersonalReadRequest([
        { role: 'user', content: 'Save my hotel reservation' },
        { role: 'user', content: 'Tell me about the new library' },
        { role: 'user', content: 'What is the address?' },
      ]),
    ).toBeNull();
  });

  it.each([
    'Explain the sentence "Where are we staying?"',
    'What companies should I apply for?',
    'What time is check-in usually?',
    'Where are we staying and then book another hotel',
    'Where are we staying? Cancel the reservation.',
    'Cancel our hotel reservation',
  ])('does not replace a different intent with a forced lodging/application read: %s', (text) => {
    expect(detectPersonalReadRequest(turn(text))?.answerFocus).toBeUndefined();
  });

  it.each(['What companies have I applied for?', 'Where did I apply?', 'Show my job applications'])(
    'looks for application receipts instead of calendar interviews: %s',
    (text) => {
      expect(detectPersonalReadRequest(turn(text))).toMatchObject({
        kind: 'email',
        firstToolName: 'gmail.search',
        requiresThreadRead: true,
        answerFocus: 'applications',
      });
    },
  );

  it('routes autobiographical memory, graph, and Drive reads through grounded tools', () => {
    const memoryQuestion = 'When did I see the carnival parade in San Francisco?';
    expect(detectPersonalReadRequest(turn(memoryQuestion))).toMatchObject({
      kind: 'memory',
      firstToolName: 'memory.recall',
      queryTerms: ['carnival', 'parade', 'san', 'francisco'],
      memoryQuery: memoryQuestion,
    });
    expect(detectPersonalReadRequest(turn('Look at my memory graph'))).toMatchObject({
      kind: 'knowledge_graph',
      firstToolName: 'memory.graph_snapshot',
    });
    expect(
      detectPersonalReadRequest([
        { role: 'user', content: 'When did I see the carnival parade in San Francisco?' },
        { role: 'assistant', content: 'I found a saved record.' },
        { role: 'user', content: 'Pull the photos' },
      ]),
    ).toMatchObject({
      kind: 'drive',
      firstToolName: 'drive.search',
      queryTerms: ['carnival', 'parade', 'san', 'francisco'],
    });
  });

  it('uses focused history passes and searches saved memory only when allowed', () => {
    const text =
      'What preferences have I previously told you about the Assistant’s UI and how its replies should look? Use saved memory or our earlier conversations. Distinguish what I actually said from your inference, mention your sources, and do not guess or save new memories.';
    const request = detectPersonalReadRequest(turn(text));
    expect(request).toMatchObject({
      kind: 'memory',
      firstToolName: 'conversations.search',
      memoryQuery: text,
      conversationQuery: 'preferences UI replies',
      conversationFollowupQuery:
        'Owner-authored statements and corrections about preferences UI replies',
      searchSavedMemory: true,
      memorySearchQuery: 'preferences UI replies',
    });
    expect(request).not.toHaveProperty('conversationCorrectionQuery');
    if (!request) throw new Error('Expected a personal memory request');
    const first = buildReadToolInput(request, 'conversations.search', []);
    expect(first).toEqual({
      query: 'preferences UI replies',
      limit: 20,
    });
    expect(JSON.stringify(first)).not.toContain('Do not guess or save new memories');
    expect(JSON.stringify(first)).not.toMatch(/\b(?:guess|save|source)\b/i);

    const firstRead = {
      toolName: 'conversations.search',
      status: 'succeeded',
      args: first,
      result: { matches: [] },
    };
    expect(nextRequiredReadTool(request, [firstRead])).toBe('conversations.search');
    const second = buildReadToolInput(request, 'conversations.search', [firstRead]);
    expect(second).toEqual({
      query: 'Owner-authored statements and corrections about preferences UI replies',
      limit: 20,
    });
    const bothReads = [firstRead, { ...firstRead, args: second }];
    expect(nextRequiredReadTool(request, bothReads)).toBe('memory.recall');
    expect(buildReadToolInput(request, 'memory.recall', bothReads)).toEqual({
      query: 'preferences UI replies',
      limit: 10,
    });
    expect(
      nextRequiredReadTool(request, [
        ...bothReads,
        {
          toolName: 'memory.recall',
          status: 'succeeded',
          args: { query: 'preferences UI replies', limit: 10 },
          result: { memories: [] },
        },
      ]),
    ).toBeUndefined();
  });

  it('routes a direct earlier-conversation question to a bounded history search', () => {
    const text = 'What did I tell you earlier about how I prefer meeting summaries?';
    const request = detectPersonalReadRequest(turn(text));
    expect(request).toMatchObject({
      kind: 'memory',
      firstToolName: 'conversations.search',
      conversationQuery: 'prefer meeting summaries',
      searchSavedMemory: false,
    });
    if (!request) throw new Error('Expected historical conversation search');
    const first = buildReadToolInput(request, 'conversations.search', []);
    if (!first) throw new Error('Expected the first bounded history query');
    for (const term of request.queryTerms)
      expect(String(first.query).toLowerCase()).toContain(term);
    const firstRead = {
      toolName: 'conversations.search',
      status: 'succeeded',
      args: first,
      result: { matches: [] },
    };
    const second = buildReadToolInput(request, 'conversations.search', [firstRead]);
    expect(nextRequiredReadTool(request, [firstRead])).toBe('conversations.search');
    expect(second).toMatchObject({ query: request.conversationFollowupQuery, limit: 20 });
    expect(
      nextRequiredReadTool(request, [firstRead, { ...firstRead, args: second }]),
    ).toBeUndefined();
  });

  it('routes direct questions about what the owner said to conversation history', () => {
    const request = detectPersonalReadRequest(turn('What did I say about my UI preferences?'));
    expect(request).toMatchObject({
      kind: 'memory',
      firstToolName: 'conversations.search',
      conversationQuery: 'UI preferences',
      searchSavedMemory: false,
    });
  });

  it('adds one bounded topic-focused owner-correction pass only for an explicit comparison', () => {
    const text =
      'Look back at our earlier conversation about the project launch. What did I say was wrong with the rollout time you gave me? Separate my correction from your earlier claim and cite the relevant conversation source.';
    const request = detectPersonalReadRequest(turn(text));
    expect(request).toMatchObject({
      kind: 'memory',
      conversationQuery: expect.stringContaining('project launch'),
      conversationCorrectionQuery: expect.stringMatching(/^Owner correction /),
    });
    if (!request) throw new Error('Expected a historical comparison read');
    const first = {
      toolName: 'conversations.search',
      status: 'succeeded',
      fromCurrentTask: true,
      args: { query: request.conversationQuery, limit: 20 },
      result: { matches: [] },
    };
    const second = {
      ...first,
      args: { query: request.conversationFollowupQuery, limit: 20 },
    };
    const third = {
      ...first,
      args: { query: request.conversationCorrectionQuery, limit: 20 },
    };
    expect(nextRequiredReadTool(request, [first])).toBe('conversations.search');
    expect(buildReadToolInput(request, 'conversations.search', [first])).toMatchObject({
      query: request.conversationFollowupQuery,
      limit: 20,
    });
    expect(nextRequiredReadTool(request, [first, second])).toBe('conversations.search');
    expect(buildReadToolInput(request, 'conversations.search', [first, second])).toMatchObject({
      query: request.conversationCorrectionQuery,
      limit: 20,
    });
    expect(nextRequiredReadTool(request, [first, second, third])).toBeUndefined();
  });

  it('bounds repeated failed history searches and never adds unrequested saved-memory reads', () => {
    const request = detectPersonalReadRequest(
      turn('What did I tell you earlier about how I prefer meeting summaries?'),
    );
    if (!request) throw new Error('Expected historical conversation search');
    const firstArgs = buildReadToolInput(request, 'conversations.search', []);
    const failedFirst = {
      toolName: 'conversations.search',
      status: 'failed',
      args: firstArgs,
      result: { error: 'private backend detail' },
    };
    expect(nextRequiredReadTool(request, [failedFirst])).toBe('conversations.search');
    expect(buildReadToolInput(request, 'conversations.search', [failedFirst])).toEqual(firstArgs);

    const failedSecond = { ...failedFirst };
    expect(nextRequiredReadTool(request, [failedFirst, failedSecond])).toBe('conversations.search');
    const followup = buildReadToolInput(request, 'conversations.search', [
      failedFirst,
      failedSecond,
    ]);
    if (!followup) throw new Error('Expected a bounded follow-up search');
    expect(followup.query).toBe(request.conversationFollowupQuery);
    const failedFollowup = { ...failedFirst, args: followup };
    expect(
      nextRequiredReadTool(request, [failedFirst, failedSecond, failedFollowup, failedFollowup]),
    ).toBeUndefined();
    expect(request.searchSavedMemory).toBe(false);
    expect(
      nextRequiredReadTool(request, [failedFirst, failedSecond, failedFollowup, failedFollowup]),
    ).not.toBe('memory.recall');
  });

  it('forces only current-task continuation pages for a truncated historical search', () => {
    const request = detectPersonalReadRequest(
      turn('What did I tell you earlier about my meeting-summary format?'),
    );
    if (!request) throw new Error('Expected historical conversation search');
    const sourceId = '2a4ebf42-1753-4f5a-8ddc-8cc15b2271b8';
    const sourceConversationId = 'd6c376b5-0532-40d7-a5f1-9efc86781af4';
    const sourceText = `I prefer concise meeting summaries with decisions at the top. ${'context '.repeat(5_000)}`;
    const searchResult = {
      mode: 'semantic',
      matches: [
        {
          messageId: sourceId,
          conversationId: sourceConversationId,
          text: sourceText,
          role: 'user',
          origin: 'owner',
          speakerRevision: conversationMessageSpeakerRevision(
            sourceId,
            sourceText,
            'user',
            'owner',
          ),
          sourceRevision: conversationMessageSourceRevision(sourceId, sourceText),
          createdAt: '2026-10-10T12:00:00.000Z',
        },
      ],
    };
    const searchJson = JSON.stringify(searchResult);
    expect(searchJson.length).toBeGreaterThan(8_000);
    const search = {
      id: '4a4f71b4-efaa-49f4-b29b-5821f7becc77',
      toolName: 'conversations.search',
      status: 'succeeded',
      fromCurrentTask: true,
      args: { query: request.conversationQuery, limit: 20 },
      result: searchResult,
    };
    const firstPageInput = buildReadToolInput(request, 'tools.read_result', [search]);
    expect(nextRequiredReadTool(request, [search])).toBe('tools.read_result');
    expect(firstPageInput).toEqual({ toolCallId: search.id, offset: 8_000 });
    const unboundSearch = { ...search, fromCurrentTask: false };
    expect(nextRequiredReadTool(request, [unboundSearch])).toBe('conversations.search');
    expect(buildReadToolInput(request, 'tools.read_result', [unboundSearch])).toEqual({});

    const foreignPage = {
      id: 'f7fd2e17-9ef3-4f2a-b686-ff702aa71bf1',
      toolName: 'tools.read_result',
      status: 'succeeded',
      fromCurrentTask: false,
      args: firstPageInput,
      result: {
        offset: 8_000,
        totalChars: searchJson.length,
        chunk: searchJson.slice(8_000, 22_000),
        hasMore: true,
      },
    };
    expect(buildReadToolInput(request, 'tools.read_result', [search, foreignPage])).toEqual(
      firstPageInput,
    );

    const firstPage = {
      ...foreignPage,
      id: 'a0749114-0ee8-432b-bf85-4d9b6e695204',
      fromCurrentTask: true,
    };
    const secondPageInput = buildReadToolInput(request, 'tools.read_result', [search, firstPage]);
    expect(nextRequiredReadTool(request, [search, firstPage])).toBe('tools.read_result');
    expect(secondPageInput).toEqual({ toolCallId: search.id, offset: 22_000 });

    const secondPage = {
      id: '710ab90e-a552-41b4-b934-d1d43fae9ef0',
      toolName: 'tools.read_result',
      status: 'succeeded',
      fromCurrentTask: true,
      args: secondPageInput,
      result: {
        offset: 22_000,
        totalChars: searchJson.length,
        chunk: searchJson.slice(22_000, 36_000),
        hasMore: 36_000 < searchJson.length,
      },
    };
    const thirdPageInput = buildReadToolInput(request, 'tools.read_result', [
      search,
      firstPage,
      secondPage,
    ]);
    expect(thirdPageInput).toEqual({ toolCallId: search.id, offset: 36_000 });
    const thirdPage = {
      id: '968184c5-0f75-4f8a-98e2-9d0b00ad3c46',
      toolName: 'tools.read_result',
      status: 'succeeded',
      fromCurrentTask: true,
      args: thirdPageInput,
      result: {
        offset: 36_000,
        totalChars: searchJson.length,
        chunk: searchJson.slice(36_000, 50_000),
        hasMore: 50_000 < searchJson.length,
      },
    };
    const allPages = [search, firstPage, secondPage, thirdPage];
    expect(nextRequiredReadTool(request, allPages)).toBe('conversations.search');
    expect(buildReadToolInput(request, 'tools.read_result', allPages)).toEqual({});
  });

  it('honors explicit memory-source prohibitions without suppressing a public URL request', () => {
    expect(
      detectPersonalReadRequest(
        turn(
          'Read https://ber.berlin-airport.de/en/orientation/getting-here/public-transport.html and summarize the airport’s public transport options in three short bullets with a source link. Clearly state if that page cannot be read or does not contain the details. Do not use my email, calendar, or memories.',
        ),
      ),
    ).toBeNull();
    expect(
      detectPersonalReadRequest(
        turn(
          'Do not use my email, calendar, or memories. Summarize https://ber.berlin-airport.de/en/orientation/getting-here/public-transport.html in three bullets.',
        ),
      ),
    ).toBeNull();
    expect(
      detectPersonalReadRequest(
        turn(
          'Do not use my email, calendar, or memories. What do you remember about my writing preferences?',
        ),
      ),
    ).toBeNull();
  });

  it('does not treat an unrelated question containing files as a Drive lookup', () => {
    expect(detectPersonalReadRequest(turn('What files are emitted by TypeScript?'))).toBeNull();
  });

  it('routes implicit day questions to all-calendar reads', () => {
    expect(detectPersonalReadRequest(turn('What is happening on Monday?'))).toMatchObject({
      kind: 'calendar',
      firstToolName: 'calendar.list_events',
    });
    expect(detectPersonalReadRequest(turn('What do I have Monday?'))).toMatchObject({
      kind: 'calendar',
      firstToolName: 'calendar.list_events',
    });
    expect(detectPersonalReadRequest(turn("What's on Monday?"))).toMatchObject({
      kind: 'calendar',
      firstToolName: 'calendar.list_events',
    });
  });

  it('bounds a next-event lookup to one result', () => {
    expect(detectPersonalReadRequest(turn('What is my next calendar event?'))).toMatchObject({
      kind: 'calendar',
      firstToolName: 'calendar.list_events',
      maxResults: 1,
    });
  });

  it('starts a generic next-event read at the request instant, not local midnight', () => {
    const requestAt = new Date('2026-09-23T17:00:00.000Z');
    expect(
      detectPersonalReadRequest(turn('What is my next calendar event?'), {
        now: requestAt,
        timeZone: 'America/Los_Angeles',
      }),
    ).toMatchObject({
      maxResults: 1,
      timeWindow: {
        timeMin: requestAt.toISOString(),
        timeMax: '2026-09-30T07:00:00.000Z',
      },
    });
    expect(
      detectPersonalReadRequest(turn('What is my next event today?'), {
        now: requestAt,
        timeZone: 'America/Los_Angeles',
      })?.timeWindow?.timeMin,
    ).toBe(requestAt.toISOString());
  });

  it('rejects nonexistent ISO calendar dates instead of normalizing them', () => {
    const options = {
      now: new Date('2026-09-23T17:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    };
    expect(resolveTimeWindow('What is on 2026-02-30?', 'calendar', false, options)).toBeUndefined();
    expect(resolveTimeWindow('What is on 2026-13-01?', 'calendar', false, options)).toBeUndefined();
    expect(detectPersonalReadRequest(turn('What is on 2026-02-30?'), options)).toBeNull();
  });

  it.each(['February 30', 'April 31', 'February 29, 2026'])(
    'rejects nonexistent named date %s without selecting a broad fallback range',
    (date) => {
      expect(
        resolveTimeWindow(`What is on my calendar on ${date}?`, 'calendar', false, {
          now: new Date('2026-09-23T17:00:00.000Z'),
          timeZone: 'America/Los_Angeles',
        }),
      ).toBeUndefined();
    },
  );

  it('reads text from AI SDK UI message parts', () => {
    expect(
      detectPersonalReadRequest(
        [{ role: 'user', parts: [{ type: 'text', text: 'What is on my calendar?' }] }],
        {
          now: new Date('2026-08-14T19:00:00Z'),
          timeZone: 'America/Los_Angeles',
        },
      ),
    ).toMatchObject({
      kind: 'calendar',
      firstToolName: 'calendar.list_events',
      timeWindow: {
        label: 'the next 7 days',
        timeMin: '2026-08-14T07:00:00.000Z',
        timeMax: '2026-08-21T07:00:00.000Z',
      },
    });
  });

  it('ignores task-envelope metadata and reads only its payload text', () => {
    const envelope = (text: string) =>
      `Task trigger (adhoc):\n\`\`\`json\n${JSON.stringify({
        source: 'chat',
        trust: 'owner',
        payload: { text },
      })}\n\`\`\``;

    expect(
      detectPersonalReadRequest([
        { role: 'user', content: envelope('What is our wifi password?') },
      ]),
    ).toBeNull();
    expect(
      detectPersonalReadRequest([
        { role: 'user', content: envelope('When is my Clay interview?') },
      ]),
    ).toMatchObject({ kind: 'calendar_email', queryTerms: ['clay'] });
  });

  it('keeps a destination after a relative date in a named flight lookup', () => {
    expect(
      detectPersonalReadRequest(turn('When is my flight tomorrow to Berlin?'), {
        now: new Date('2026-10-08T18:00:00.000Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toMatchObject({
      kind: 'calendar_email',
      queryTerms: ['berlin'],
      firstToolName: 'calendar.search_events',
      requiresThreadRead: true,
      mailQuery: 'berlin',
      answerFocus: 'flight',
      timeWindow: {
        label: 'tomorrow',
        timeMin: '2026-10-09T07:00:00.000Z',
        timeMax: '2026-10-10T07:00:00.000Z',
      },
    });
  });

  it('does not mistake a flight date for a mail-received date filter', () => {
    const request = detectPersonalReadRequest(turn('When is my flight tomorrow?'), {
      now: new Date('2026-10-08T18:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(request).toMatchObject({
      answerFocus: 'flight',
      queryTerms: ['flight'],
      mailQuery: 'flight',
    });

    const explicitlyRecent = detectPersonalReadRequest(
      turn('When is my flight tomorrow from the last 7 days?'),
      {
        now: new Date('2026-10-08T18:00:00.000Z'),
        timeZone: 'America/Los_Angeles',
      },
    );
    expect(explicitlyRecent?.mailQuery).toContain('newer_than:7d');
  });

  it('searches both calendar and Gmail for a named interview', () => {
    expect(detectPersonalReadRequest(turn('When is my Clay interview?'))).toEqual({
      kind: 'calendar_email',
      queryTerms: ['clay'],
      firstToolName: 'calendar.search_events',
      requiresThreadRead: true,
      mailQuery: 'clay',
    });
  });

  it('derives a Gmail search term instead of scanning arbitrary recent mail', () => {
    expect(detectPersonalReadRequest(turn('Did I get an email from Clay?'))).toEqual({
      kind: 'email',
      queryTerms: ['clay'],
      firstToolName: 'gmail.search',
      requiresThreadRead: false,
      mailQuery: 'clay',
    });
    expect(detectPersonalReadRequest(turn('Search my email for Jane Doe'))).toMatchObject({
      kind: 'email',
      queryTerms: ['jane', 'doe'],
      mailQuery: 'jane doe',
    });
  });

  it('prioritizes a target flight booking confirmation ahead of matching newsletters', () => {
    const request = detectPersonalReadRequest(turn('When is my flight tomorrow to Berlin?'), {
      now: new Date('2026-10-08T18:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    });
    if (!request) throw new Error('expected a flight read request');
    const evidence: ReadToolEvidence[] = [
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        args: { query: request.mailQuery },
        result: {
          results: [
            {
              threadId: 'newsletter-1',
              subject: 'Berlin flight deals this week',
              snippet: 'Weekly travel offers',
            },
            {
              threadId: 'newsletter-2',
              subject: 'Your Berlin flight inspiration',
              snippet: 'Explore destinations',
            },
            {
              threadId: 'newsletter-3',
              subject: 'Berlin airport news',
              snippet: 'Terminal updates',
            },
            {
              threadId: 'booking',
              subject: 'Berlin flight confirmation',
              snippet: 'Your itinerary and departure details',
            },
          ],
        },
      },
    ];

    expect(gmailThreadIdsToRead(evidence, request)).toEqual([
      'booking',
      'newsletter-1',
      'newsletter-2',
    ]);
  });

  it('reads a forwarded flight itinerary ahead of hotel confirmations in a next-flight lookup', () => {
    const request = detectPersonalReadRequest(
      turn('Find my next flight from booking emails and calendar.'),
      {
        now: new Date('2026-10-13T18:00:00Z'),
        timeZone: 'America/Los_Angeles',
      },
    );
    if (!request?.upcomingFlightDiscovery) throw new Error('Expected next-flight discovery');
    const evidence: ReadToolEvidence[] = [
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { query: request.mailQuery },
        result: {
          results: [
            {
              threadId: 'hotel-a',
              subject: 'Hotel reservation confirmation',
              snippet: 'Booking details',
            },
            {
              threadId: 'hotel-b',
              subject: 'Hotel reservation confirmation',
              snippet: 'Booking details',
            },
            {
              threadId: 'flight-booked',
              subject: 'Flight booked for your journey',
              snippet: 'Your departure details',
            },
            {
              threadId: 'flight-route',
              subject: 'Fwd: Flight - Example City to Sample Traveler',
              snippet: 'Journey details',
            },
          ],
          complete: true,
          hasMore: false,
        },
      },
    ];
    expect(gmailThreadIdsToRead(evidence, request)).toEqual(['flight-route', 'flight-booked']);
    expect(nextRequiredReadTool(request, evidence)).toBe('calendar.list_events');
  });

  it('keeps structured flight itineraries and lodging reads distinct in compound discovery', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Find my next trip from booking emails and calendar, confirm flights and hotel, and compare public transport and taxi to my hotel.',
      ),
    );
    if (!request?.compoundTripDiscovery || !request.mailQueries)
      throw new Error('Expected compound discovery');
    const evidence: ReadToolEvidence[] = request.mailQueries.map(({ query, category }) => ({
      toolName: 'gmail.search',
      status: 'succeeded',
      fromCurrentTask: true,
      args: { query },
      result: {
        results:
          category === 'flight'
            ? [
                { threadId: 'news', subject: 'Flight routes newsletter' },
                {
                  threadId: 'itinerary',
                  subject: 'Re: Fwd: Flight - Example City to Sample Traveler',
                },
              ]
            : [{ threadId: 'hotel', subject: 'Hotel reservation confirmation' }],
        complete: true,
        hasMore: false,
      },
    }));
    expect(gmailThreadIdsToRead(evidence, request)).toEqual(['itinerary', 'hotel']);
    expect(
      gmailThreadIdsToRead(
        evidence.map((row) => ({ ...row, fromCurrentTask: false })),
        request,
      ),
    ).toEqual([]);
  });

  it('prioritizes a lodging confirmation for the owner-requested trip over generic and stale stays', () => {
    const request = detectPersonalReadRequest(
      turn('Where are we staying in Berlin next weekend?'),
      { now: new Date('2026-10-11T12:00:00Z'), timeZone: 'UTC' },
    );
    if (!request) throw new Error('expected a lodging read request');
    expect(request).toMatchObject({ answerFocus: 'lodging', mailRelevanceTerms: ['berlin'] });

    const evidence: ReadToolEvidence[] = [
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        args: { query: request.mailQuery },
        result: {
          results: [
            {
              threadId: 'generic-berlin-hotels',
              subject: 'Hotels in Berlin',
              snippet: 'A guide to popular places to stay.',
            },
            {
              threadId: 'generic-lodging-newsletter',
              subject: 'Hotel inspiration',
              snippet: 'Ideas for your next city break.',
            },
            {
              threadId: 'generic-travel-news',
              subject: 'Berlin travel news',
              snippet: 'New restaurants and weekend events.',
            },
            {
              threadId: 'old-berlin-stay',
              subject: 'Berlin reservation confirmation',
              snippet: 'Confirmation for your earlier stay in Berlin last year.',
            },
            {
              threadId: 'current-berlin-stay',
              subject: 'Berlin booking confirmation',
              snippet: 'Reservation for your Berlin stay next weekend.',
            },
          ],
        },
      },
    ];

    expect(gmailThreadIdsToRead(evidence, request)).toEqual([
      'current-berlin-stay',
      'generic-berlin-hotels',
      'generic-travel-news',
    ]);
  });

  it('does not promote confirmation keywords above a destination-matching lodging result', () => {
    const request = detectPersonalReadRequest(
      turn('Which hotel did we book for Berlin next weekend?'),
      { now: new Date('2026-10-11T12:00:00Z'), timeZone: 'UTC' },
    );
    if (!request) throw new Error('expected a lodging read request');
    expect(request.mailTemporalLabel).toBe('next weekend');

    const evidence: ReadToolEvidence[] = [
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        args: { query: request.mailQuery },
        result: {
          results: [
            {
              threadId: 'stale-confirmation',
              subject: 'Berlin booking confirmation',
              snippet: 'Confirmation for a previous stay in Berlin last year.',
            },
            {
              threadId: 'current-trip-details',
              subject: 'Berlin stay details',
              snippet: 'Your Berlin lodging information for next weekend.',
            },
            {
              threadId: 'generic-one',
              subject: 'Hotel newsletter one',
              snippet: 'Generic hotel news.',
            },
            {
              threadId: 'generic-two',
              subject: 'Hotel newsletter two',
              snippet: 'Generic hotel news.',
            },
          ],
        },
      },
    ];

    expect(gmailThreadIdsToRead(evidence, request)[0]).toBe('current-trip-details');
  });

  it('matches explicit booking dates against the resolved trip interval without relying on wording', () => {
    const request = detectPersonalReadRequest(
      turn('Which hotel did we book for Berlin next weekend?'),
      { now: new Date('2026-10-11T12:00:00Z'), timeZone: 'UTC' },
    );
    if (!request) throw new Error('expected a lodging read request');

    const evidence: ReadToolEvidence[] = [
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        args: { query: request.mailQuery },
        result: {
          results: [
            {
              threadId: 'old-same-city-confirmation',
              subject: 'Berlin booking confirmation',
              snippet: 'Hotel reservation, October 12–13, 2024.',
            },
            {
              threadId: 'dated-current-stay',
              subject: 'Berlin accommodation details',
              snippet: 'Reservation dates: October 16–18, 2026.',
            },
            {
              threadId: 'nonoverlapping-future-stay',
              subject: 'Berlin booking confirmation',
              snippet: 'Reservation dates: October 20–21, 2026.',
            },
            {
              threadId: 'malformed-date-confirmation',
              subject: 'Berlin booking confirmation',
              snippet: 'Reservation dates: October 32–35, 2026.',
            },
          ],
        },
      },
    ];

    expect(gmailThreadIdsToRead(evidence, request)[0]).toBe('dated-current-stay');
  });

  it('requires exact temporal words instead of matching a shorter word inside a longer one', () => {
    const request = detectPersonalReadRequest(
      turn('Where are we staying in Berlin Mitte this week?'),
      { now: new Date('2026-10-11T12:00:00Z'), timeZone: 'UTC' },
    );
    if (!request) throw new Error('expected a lodging read request');

    const evidence: ReadToolEvidence[] = [
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        args: { query: request.mailQuery },
        result: {
          results: [
            {
              threadId: 'weekly-marketing',
              subject: 'Berlin Mitte booking confirmation',
              snippet: 'This weekly hotel reservation offer is for subscribers.',
            },
            {
              threadId: 'dated-current-stay',
              subject: 'Berlin Mitte accommodation details',
              snippet: 'Reservation dates: October 10–11, 2026.',
            },
          ],
        },
      },
    ];

    expect(gmailThreadIdsToRead(evidence, request)[0]).toBe('dated-current-stay');
  });

  it('matches an explicitly named cross-month date range without guessing a missing month', () => {
    const request = detectPersonalReadRequest(
      turn('Which hotel did we book in Berlin on November 2, 2026?'),
      { now: new Date('2026-10-11T12:00:00Z'), timeZone: 'UTC' },
    );
    if (!request) throw new Error('expected a lodging read request');

    const evidence: ReadToolEvidence[] = [
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        args: { query: request.mailQuery },
        result: {
          results: [
            {
              threadId: 'cross-month-overlap',
              subject: 'Berlin stay details',
              snippet: 'Booking dates: October 31–November 2, 2026.',
            },
            {
              threadId: 'ambiguous-day-range',
              subject: 'Berlin booking confirmation',
              snippet: 'October 31–2, 2026.',
            },
          ],
        },
      },
    ];

    expect(gmailThreadIdsToRead(evidence, request)[0]).toBe('cross-month-overlap');
  });

  it('prioritizes the newest matching thread for current or upcoming mail questions', () => {
    const request = detectPersonalReadRequest(turn('What does the latest trip email say?'));
    expect(request).toMatchObject({
      kind: 'email',
      requiresThreadRead: true,
      preferLatestMail: true,
    });
    if (!request) throw new Error('expected an email read request');
    const evidence: ReadToolEvidence[] = [
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        args: { query: request.mailQuery },
        result: {
          results: [
            { threadId: 'old', date: '2026-08-01T00:00:00Z' },
            { threadId: 'middle', date: '2026-09-01T00:00:00Z' },
            { threadId: 'current', date: '2026-10-01T00:00:00Z' },
            { threadId: 'fourth', date: '2026-10-02T00:00:00Z' },
          ],
        },
      },
    ];
    expect(gmailThreadIdsToRead(evidence, request)).toEqual(['fourth', 'current', 'middle']);
  });

  // The reported miss: the owner asked whether a hotel email had arrived and got
  // "I don't see any emails in your inbox" from a turn that ran no tools. Mail
  // ARRIVES, so a receipt question carries no read verb for READ_OR_QUESTION to
  // find, and the request never reached gmail.search.
  it('routes receipt-shaped email questions, which name no read verb', () => {
    expect(
      detectPersonalReadRequest(turn('Have I gotten an email about the hotel this weekend?')),
    ).toMatchObject({
      kind: 'email',
      firstToolName: 'gmail.search',
      // "this weekend" is a date filter, never a search term: Gmail ANDs terms,
      // and no travel confirmation contains the word "weekend".
      mailQuery: 'hotel newer_than:14d',
    });
    expect(detectPersonalReadRequest(turn('Any email about my hotel booking?'))).toMatchObject({
      kind: 'email',
      mailQuery: 'hotel',
    });
    expect(detectPersonalReadRequest(turn('Has the invoice email arrived?'))).toMatchObject({
      kind: 'email',
      mailQuery: 'invoice',
    });
  });

  it('reads a terse challenge that names its own sender', () => {
    expect(
      detectPersonalReadRequest(
        turn(
          'Nothing from tripit?',
          "I don't see any emails in your inbox about a hotel this weekend.",
        ),
      ),
    ).toMatchObject({ kind: 'email', mailQuery: 'tripit', verification: true });
  });

  it('does not mistake an acknowledgement or idle chat for a receipt question', () => {
    for (const text of [
      'I got your email, thanks',
      'any thoughts on the plan?',
      'has that ever happened to you?',
      'I read the email you drafted, looks good',
    ]) {
      expect(detectPersonalReadRequest(turn(text)), text).toBeNull();
    }
  });

  it('keeps generic inbox and importance requests broad but explicit', () => {
    expect(detectPersonalReadRequest(turn("What's in my inbox?"))).toMatchObject({
      kind: 'email',
      queryTerms: [],
      mailQuery: 'in:inbox',
    });
    expect(detectPersonalReadRequest(turn('Find any urgent email'))).toMatchObject({
      kind: 'email',
      queryTerms: [],
      mailQuery: '{is:starred is:important}',
    });
    expect(detectPersonalReadRequest(turn('Show me unread messages'))).toMatchObject({
      kind: 'email',
      queryTerms: [],
      mailQuery: 'in:inbox is:unread',
    });
    expect(detectPersonalReadRequest(turn('Check emails from last week'))).toMatchObject({
      kind: 'email',
      queryTerms: [],
      mailQuery: 'newer_than:7d',
    });
    expect(detectPersonalReadRequest(turn('Check emails from the last 3 days'))).toMatchObject({
      kind: 'email',
      queryTerms: [],
      mailQuery: 'newer_than:3d',
    });
  });

  it('lists generic meetings over the requested range without keyword narrowing', () => {
    expect(
      detectPersonalReadRequest(turn('What meetings do I have next week?'), {
        now: new Date('2026-08-13T23:00:00Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toMatchObject({
      kind: 'calendar',
      queryTerms: [],
      firstToolName: 'calendar.list_events',
      timeWindow: { label: 'next week' },
    });
  });

  it('uses the all-calendar free/busy tool for an availability question', () => {
    const request = detectPersonalReadRequest(turn('When am I free on Monday?'), {
      now: new Date('2026-08-13T23:00:00Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(request).toMatchObject({
      kind: 'calendar',
      queryTerms: [],
      firstToolName: 'calendar.availability',
      timeWindow: {
        label: 'monday',
        timeMin: '2026-08-17T07:00:00.000Z',
        timeMax: '2026-08-18T07:00:00.000Z',
      },
    });
    expect(
      buildReadToolInput(request as NonNullable<typeof request>, 'calendar.availability', []),
    ).toEqual({
      timeMin: '2026-08-17T07:00:00.000Z',
      timeMax: '2026-08-18T07:00:00.000Z',
    });
    expect(
      detectPersonalReadRequest(turn('Is Monday free?'), {
        now: new Date('2026-08-13T23:00:00Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toMatchObject({ firstToolName: 'calendar.availability' });
  });

  it('resolves Monday in the owner timezone instead of letting a model choose the date', () => {
    const request = detectPersonalReadRequest(turn('What is happening on Monday?'), {
      now: new Date('2026-08-13T23:00:00Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(request).toMatchObject({
      kind: 'calendar',
      timeZone: 'America/Los_Angeles',
      timeWindow: {
        label: 'monday',
        timeMin: '2026-08-17T07:00:00.000Z',
        timeMax: '2026-08-18T07:00:00.000Z',
      },
    });
    expect(
      buildReadToolInput(request as NonNullable<typeof request>, 'calendar.list_events', []),
    ).toEqual({
      timeMin: '2026-08-17T07:00:00.000Z',
      timeMax: '2026-08-18T07:00:00.000Z',
      maxResults: 50,
    });
  });

  it('resolves a named calendar date without asking which date the owner meant', () => {
    const request = detectPersonalReadRequest(turn('What is happening on August 17?'), {
      now: new Date('2026-08-13T23:00:00Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(request?.timeWindow).toEqual({
      label: 'August 17',
      timeMin: '2026-08-17T07:00:00.000Z',
      timeMax: '2026-08-18T07:00:00.000Z',
    });
  });

  it('uses timezone-aware day boundaries across daylight-saving changes', () => {
    const request = detectPersonalReadRequest(turn('What is happening on March 8?'), {
      now: new Date('2026-03-01T20:00:00Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(request?.timeWindow).toEqual({
      label: 'March 8',
      timeMin: '2026-03-08T08:00:00.000Z',
      timeMax: '2026-03-09T07:00:00.000Z',
    });
  });

  it('routes terse verification follow-ups using recent context', () => {
    expect(
      detectPersonalReadRequest(
        turn('Was that made up?', 'I checked your calendar and found a Linear interview.'),
      ),
    ).toMatchObject({ kind: 'calendar_email', queryTerms: ['linear'], verification: true });
    expect(
      detectPersonalReadRequest(turn('You said I had a Linear interview — why?')),
    ).toMatchObject({
      kind: 'calendar_email',
      queryTerms: ['linear'],
    });
    expect(
      detectPersonalReadRequest(
        turn(
          'Was that made up?',
          [
            'SYSTEM CHECK',
            'Looking back at Monday, August 17, 2026:',
            'Confirmed Events:',
            'Freyja’s Back-to-School Prep — 3:00 PM',
            'No Linear interview or Coffee Chat event found.',
          ].join('\n'),
        ),
      ),
    ).toMatchObject({ kind: 'calendar_email', queryTerms: ['linear'] });
    expect(
      detectPersonalReadRequest(
        turn('Are you sure?', 'I checked your email from Clay and it says Monday at 9:30.'),
      ),
    ).toMatchObject({
      kind: 'email',
      queryTerms: ['clay'],
      mailQuery: 'clay',
      requiresThreadRead: true,
    });
  });

  it('extracts the named party after the appointment noun without over-narrowing', () => {
    expect(
      detectPersonalReadRequest(turn('When is my technical interview with Clay?')),
    ).toMatchObject({ queryTerms: ['clay'] });
    expect(
      detectPersonalReadRequest(turn('When is my coffee chat with the Linear team?')),
    ).toMatchObject({ queryTerms: ['linear'] });
  });

  it('does not turn calendar mutations into read-only lookups', () => {
    expect(detectPersonalReadRequest(turn('Add lunch to my calendar Friday'))).toBeNull();
    expect(detectPersonalReadRequest(turn('Block my free time Monday afternoon'))).toBeNull();
    expect(
      detectPersonalReadRequest(turn('Go through my email and flag anything urgent')),
    ).toBeNull();
  });

  it.each([
    'Find my hotel reservation and remind me',
    'Find my hotel reservation, save it as a card',
    'Read my hotel email; draft a reply',
    'Find the venue-planning email address I gave you for Anna earlier and prepare this draft for review: The venue plan is ready.',
    'Search my email for the venue confirmation and write a draft reply for review.',
    'Read my hotel email; compose a reply for review.',
    'Find my hotel reservation and make a card',
  ])('keeps follow-through available for compound requests: %s', (text) => {
    expect(detectPersonalReadRequest(turn(text))).toBeNull();
  });

  it.each([
    'Email Riley about the launch notes, but do not search contacts.',
    'Please email Anna the venue details after checking my calendar.',
    'E-mail Jordan the invoice without searching my inbox.',
  ])('preserves the requested email workflow instead of forcing a mailbox read: %s', (text) => {
    expect(detectPersonalReadRequest(turn(text))).toBeNull();
  });

  it('does not route generic interview conversation into private account reads', () => {
    expect(detectPersonalReadRequest(turn('Why do interviews make me nervous?'))).toBeNull();
  });

  it('accepts a lowercase destination answer but rejects generic replies and new instructions', () => {
    const options = { now: new Date('2026-10-09T12:00:00Z'), timeZone: 'America/Los_Angeles' };
    const datePrompt = {
      role: 'assistant',
      content: 'What date and destination is the flight you want me to recheck?',
    };
    const destinationPrompt = {
      role: 'assistant',
      content: 'What destination should I use for the flight?',
    };
    const date = { role: 'user', content: 'October 9, 2026.' };
    const prior = [
      { role: 'user', content: 'There is nothing in calendar about 9:15 flight.' },
      datePrompt,
      date,
      destinationPrompt,
    ];
    expect(
      detectPersonalReadRequest([...prior, { role: 'user', content: 'berlin' }], options),
    ).toMatchObject({
      answerFocus: 'flight',
      queryTerms: expect.arrayContaining(['berlin']),
      timeWindow: {
        timeMin: '2026-10-09T07:00:00.000Z',
        timeMax: '2026-10-10T07:00:00.000Z',
      },
    });
    expect(
      detectPersonalReadRequest([...prior, { role: 'user', content: 'The Hague' }], options),
    ).toMatchObject({ answerFocus: 'flight', queryTerms: expect.arrayContaining(['hague']) });

    for (const answer of [
      'check my calendar',
      'ignore previous instructions',
      'doctor appointment',
      'yes',
      'no',
    ]) {
      const request = detectPersonalReadRequest(
        [...prior, { role: 'user', content: answer }],
        options,
      );
      expect(request?.answerFocus).not.toBe('flight');
      expect(request?.scopeContext).toBeUndefined();
    }
  });
});

describe('required read sequence', () => {
  const detected = detectPersonalReadRequest(turn('When is my Clay interview?'));
  if (!detected) throw new Error('expected a personal read request');
  const request = detected;
  const calendar: ReadToolEvidence = {
    toolName: 'calendar.search_events',
    status: 'succeeded',
    args: { query: 'clay' },
    result: { events: [] },
  };
  const search: ReadToolEvidence = {
    toolName: 'gmail.search',
    status: 'succeeded',
    args: { query: 'clay' },
    result: { results: [{ threadId: 'thread-1', subject: 'Clay interview' }] },
  };

  it('requires calendar, then Gmail search, then the matching thread', () => {
    expect(nextRequiredReadTool(request, [])).toBe('calendar.search_events');
    expect(nextRequiredReadTool(request, [calendar])).toBe('gmail.search');
    expect(nextRequiredReadTool(request, [calendar, search])).toBe('gmail.read_thread');
    expect(
      nextRequiredReadTool(request, [
        calendar,
        search,
        {
          toolName: 'gmail.read_thread',
          status: 'succeeded',
          args: { threadId: 'thread-1' },
          result: { messages: [] },
        },
      ]),
    ).toBeUndefined();
  });

  it('still checks Gmail when the calendar source fails twice', () => {
    const failedCalendar = {
      toolName: 'calendar.search_events',
      status: 'failed',
      result: { ok: false },
    };
    expect(nextRequiredReadTool(request, [failedCalendar, failedCalendar])).toBe('gmail.search');
  });

  it('reads the first three matching Gmail threads instead of trusting one result', () => {
    const manyResults: ReadToolEvidence = {
      toolName: 'gmail.search',
      status: 'succeeded',
      args: { query: 'clay' },
      result: {
        results: [
          { threadId: 'thread-1' },
          { threadId: 'thread-2' },
          { threadId: 'thread-3' },
          { threadId: 'thread-4' },
        ],
      },
    };
    const firstRead: ReadToolEvidence = {
      toolName: 'gmail.read_thread',
      status: 'succeeded',
      args: { threadId: 'thread-1' },
      result: { messages: [{ text: 'first' }] },
    };
    const evidence = [calendar, manyResults, firstRead];
    expect(nextRequiredReadTool(request, evidence)).toBe('gmail.read_thread');
    expect(buildReadToolInput(request, 'gmail.read_thread', evidence)).toEqual({
      threadId: 'thread-2',
    });
  });

  it('continues a broad mailbox search only through a bounded set of grounded pages', () => {
    const broad = detectPersonalReadRequest(turn('Search my inbox history for Clay'));
    expect(broad).toMatchObject({ kind: 'email', requiresExhaustiveMail: true });
    if (!broad) throw new Error('expected a broad mail request');
    expect(
      groundReadToolInput(broad, 'gmail.search', { pageToken: 'model-invented' }, []),
    ).not.toHaveProperty('pageToken');
    const firstPage: ReadToolEvidence = {
      toolName: 'gmail.search',
      status: 'succeeded',
      args: { query: broad.mailQuery },
      result: { hasMore: true, nextPageToken: 'page-2', results: [] },
    };
    expect(nextRequiredReadTool(broad, [firstPage])).toBe('gmail.search');
    expect(buildReadToolInput(broad, 'gmail.search', [firstPage])).toMatchObject({
      query: broad.mailQuery,
      pageToken: 'page-2',
      maxResults: 20,
    });
    const secondPage: ReadToolEvidence = {
      ...firstPage,
      args: { query: broad.mailQuery, pageToken: 'page-2' },
      result: { hasMore: true, nextPageToken: 'page-3', results: [] },
    };
    const thirdPage: ReadToolEvidence = {
      ...firstPage,
      args: { query: broad.mailQuery, pageToken: 'page-3' },
      result: { hasMore: true, nextPageToken: 'page-4', results: [] },
    };
    expect(nextRequiredReadTool(broad, [firstPage, secondPage, thirdPage])).toBeUndefined();
  });

  it('allows three bounded email-review metadata pages and then proceeds to complete-thread reads', () => {
    const review = detectPersonalReadRequest(
      turn(
        'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet.',
      ),
    );
    expect(review?.emailReview).toBeDefined();
    if (!review?.emailReview) throw new Error('expected bounded email review');
    const pages: ReadToolEvidence[] = [];
    for (let index = 0; index < 3; index += 1) {
      const token = index === 0 ? undefined : `page-${index + 1}`;
      pages.push({
        toolName: 'gmail.search',
        status: 'succeeded',
        args: { query: EMAIL_REVIEW_QUERY, ...(token ? { pageToken: token } : {}) },
        result: { complete: false, hasMore: true, nextPageToken: `page-${index + 2}`, results: [] },
      });
      if (index < 2) expect(nextRequiredReadTool(review, pages)).toBe('gmail.search');
    }
    expect(nextRequiredReadTool(review, pages)).toBeUndefined();
  });

  it('binds searches to the owner wording and removes calendar narrowing', () => {
    expect(
      groundReadToolInput(
        request,
        'calendar.search_events',
        { query: 'Linear', calendarIds: ['Primary'], maxResults: 20 },
        [],
      ),
    ).toEqual({ query: 'clay', maxResults: 50 });
    expect(
      groundReadToolInput(request, 'gmail.read_thread', { threadId: 'invented' }, [search]),
    ).toEqual({ threadId: 'thread-1' });
  });

  it('does not accept a read with a model-chosen date range or Gmail query', () => {
    const dated = detectPersonalReadRequest(turn('What is happening on Monday?'), {
      now: new Date('2026-08-13T23:00:00Z'),
      timeZone: 'America/Los_Angeles',
    });
    if (!dated) throw new Error('expected a dated personal read request');
    expect(
      nextRequiredReadTool(dated, [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: {
            timeMin: '2026-08-24T07:00:00.000Z',
            timeMax: '2026-08-25T07:00:00.000Z',
          },
          result: { events: [] },
        },
      ]),
    ).toBe('calendar.list_events');

    expect(
      nextRequiredReadTool(request, [
        calendar,
        {
          toolName: 'gmail.search',
          status: 'succeeded',
          args: { query: 'linear' },
          result: { results: [] },
        },
      ]),
    ).toBe('gmail.search');
  });
});

describe('Google Drive is not driving', () => {
  it.each(["What's the drive time to Napa?", 'How long is the drive to SFO?'])(
    'leaves the trip %s for the maps tool',
    (content) => {
      expect(detectPersonalReadRequest([{ role: 'user', content }])?.kind).not.toBe('drive');
    },
  );
  it.each(['Find the budget spreadsheet in my Drive', 'Search Google Drive for the lease'])(
    'still reads %s from Drive',
    (content) => {
      expect(detectPersonalReadRequest([{ role: 'user', content }])?.kind).toBe('drive');
    },
  );
});

describe('focused flight verification follow-ups', () => {
  const options = { now: new Date('2026-10-08T18:00:00Z'), timeZone: 'America/Los_Angeles' };
  const history = [
    { role: 'user', content: 'When is my flight to Berlin on October 9, 2026?' },
    { role: 'assistant', content: 'Your flight leaves at 9:15 AM.' },
  ];

  it.each(['Are you sure?', 'There is nothing in the calendar about 9:15 flight.'])(
    'keeps the owner trip and date when challenging an unsupported clock: %s',
    (content) => {
      const request = detectPersonalReadRequest([...history, { role: 'user', content }], options);
      expect(request).toMatchObject({
        kind: 'calendar_email',
        answerFocus: 'flight',
        verification: true,
        queryTerms: ['berlin'],
        mailQuery: 'berlin',
        requiresThreadRead: true,
        timeWindow: { timeMin: '2026-10-09T07:00:00.000Z', timeMax: '2026-10-10T07:00:00.000Z' },
      });
      expect(request?.queryTerms.join(' ')).not.toMatch(/9|15|there/);
    },
  );

  it('asks for missing trip scope instead of searching years of records', () => {
    const request = detectPersonalReadRequest(
      turn('There is nothing in the calendar about 9:15 flight.'),
      options,
    );
    expect(request).toMatchObject({
      answerFocus: 'flight',
      scopeIssue: expect.stringMatching(/date.*destination/i),
    });
    if (!request) throw new Error('expected a scoped clarification');
    expect(nextRequiredReadTool(request, [])).toBeUndefined();
    expect(buildReadToolInput(request, 'calendar.search_events', [])).toBeNull();
  });

  it('keeps the owner trip through repeated generic corrections', () => {
    const request = detectPersonalReadRequest(
      [
        ...history,
        { role: 'user', content: 'There is nothing in the calendar about 9:15 flight.' },
        { role: 'assistant', content: 'I am sure it is at 9:15 AM on January 4, 2026.' },
        { role: 'user', content: 'Are you sure?' },
      ],
      options,
    );
    expect(request).toMatchObject({
      answerFocus: 'flight',
      queryTerms: ['berlin'],
      timeWindow: { timeMin: '2026-10-09T07:00:00.000Z', timeMax: '2026-10-10T07:00:00.000Z' },
    });
  });

  it('applies a new owner date to the same destination', () => {
    const request = detectPersonalReadRequest(
      [...history, { role: 'user', content: 'Double-check my flight on October 10, 2026.' }],
      options,
    );
    expect(request).toMatchObject({
      answerFocus: 'flight',
      queryTerms: ['berlin'],
      timeWindow: { timeMin: '2026-10-10T07:00:00.000Z', timeMax: '2026-10-11T07:00:00.000Z' },
    });
  });

  it('does not move a prior relative trip date across midnight without its original timestamp', () => {
    const request = detectPersonalReadRequest(
      [
        { role: 'user', content: 'When is my flight to Berlin tomorrow?' },
        { role: 'assistant', content: 'Your flight leaves at 9:15 AM.' },
        { role: 'user', content: 'Are you sure?' },
      ],
      options,
    );
    expect(request).toMatchObject({
      answerFocus: 'flight',
      queryTerms: ['berlin'],
      scopeIssue: 'What is the date of the flight you want me to recheck?',
    });
    if (!request) throw new Error('expected a date clarification');
    expect(nextRequiredReadTool(request, [])).toBeUndefined();
  });

  it('uses a newly named destination and date ahead of the prior trip', () => {
    expect(
      detectPersonalReadRequest(
        [
          ...history,
          { role: 'user', content: 'Double-check my flight to Paris on October 10, 2026.' },
        ],
        options,
      ),
    ).toMatchObject({
      answerFocus: 'flight',
      queryTerms: ['paris'],
      timeWindow: { timeMin: '2026-10-10T07:00:00.000Z', timeMax: '2026-10-11T07:00:00.000Z' },
    });
  });

  it('stops at an owner topic change instead of reviving an old flight', () => {
    const request = detectPersonalReadRequest(
      [
        ...history,
        { role: 'user', content: 'When is my doctor appointment on October 9, 2026?' },
        { role: 'assistant', content: 'Your appointment is at 10 AM.' },
        { role: 'user', content: 'Are you sure?' },
      ],
      options,
    );
    expect(request?.answerFocus).not.toBe('flight');
  });

  it('uses the owner date to finish an exact relative-flight clarification', () => {
    const request = detectPersonalReadRequest(
      [
        { role: 'user', content: 'When is my flight to Berlin tomorrow?' },
        { role: 'assistant', content: 'Your flight leaves at 9:15 AM.' },
        { role: 'user', content: 'Are you sure?' },
        {
          role: 'assistant',
          content: 'What is the date of the flight you want me to recheck?',
        },
        { role: 'user', content: 'October 9, 2026.' },
      ],
      options,
    );
    expect(request).toMatchObject({
      kind: 'calendar_email',
      answerFocus: 'flight',
      verification: true,
      queryTerms: ['berlin'],
      timeWindow: { timeMin: '2026-10-09T07:00:00.000Z', timeMax: '2026-10-10T07:00:00.000Z' },
    });
    expect(request?.mailQuery).toBe('berlin');
  });

  it('uses only the owner-supplied date and destination after an exact scope question', () => {
    const request = detectPersonalReadRequest(
      [
        { role: 'user', content: 'There is nothing in the calendar about 9:15 flight.' },
        {
          role: 'assistant',
          content: 'What date and destination is the flight you want me to recheck?',
        },
        { role: 'user', content: 'October 9, 2026 to Berlin.' },
      ],
      options,
    );
    expect(request).toMatchObject({
      kind: 'calendar_email',
      answerFocus: 'flight',
      verification: true,
      queryTerms: ['berlin'],
      timeWindow: { timeMin: '2026-10-09T07:00:00.000Z', timeMax: '2026-10-10T07:00:00.000Z' },
    });
    expect(request?.mailQuery).toBe('berlin');
  });

  it('does not inherit a flight from a quoted answer or a new owner topic', () => {
    const quoted = detectPersonalReadRequest(
      [
        { role: 'user', content: 'There is nothing in the calendar about 9:15 flight.' },
        {
          role: 'assistant',
          content: 'What date and destination is the flight you want me to recheck?',
        },
        { role: 'user', content: '> October 9, 2026 to Berlin' },
      ],
      options,
    );
    expect(quoted?.answerFocus).not.toBe('flight');

    const newTopic = detectPersonalReadRequest(
      [
        { role: 'user', content: 'There is nothing in the calendar about 9:15 flight.' },
        {
          role: 'assistant',
          content: 'What date and destination is the flight you want me to recheck?',
        },
        { role: 'user', content: 'October 9, 2026 to Berlin, and check my doctor appointment.' },
      ],
      options,
    );
    expect(newTopic?.answerFocus).not.toBe('flight');
  });

  it('finishes a missing-destination follow-up without asking the owner to repeat the date', () => {
    const request = detectPersonalReadRequest(
      [
        { role: 'user', content: 'There is nothing in the calendar about 9:15 flight.' },
        {
          role: 'assistant',
          content: 'What date and destination is the flight you want me to recheck?',
        },
        { role: 'user', content: 'October 9, 2026.' },
        { role: 'assistant', content: 'What destination should I use for the flight?' },
        { role: 'user', content: 'Berlin' },
      ],
      options,
    );
    expect(request).toMatchObject({
      kind: 'calendar_email',
      answerFocus: 'flight',
      queryTerms: ['berlin'],
      timeWindow: { timeMin: '2026-10-09T07:00:00.000Z', timeMax: '2026-10-10T07:00:00.000Z' },
    });
  });

  it('uses the current task clock to resolve a yearless owner date answer', () => {
    const request = detectPersonalReadRequest(
      [
        { role: 'user', content: 'When is my flight to Berlin tomorrow?' },
        { role: 'assistant', content: 'Your flight leaves at 9:15 AM.' },
        { role: 'user', content: 'Are you sure?' },
        {
          role: 'assistant',
          content: 'What is the date of the flight you want me to recheck?',
        },
        { role: 'user', content: 'October 9.' },
      ],
      options,
    );
    expect(request).toMatchObject({
      answerFocus: 'flight',
      queryTerms: ['berlin'],
      timeWindow: { timeMin: '2026-10-09T07:00:00.000Z', timeMax: '2026-10-10T07:00:00.000Z' },
    });
  });

  it('does not resume an old flight scope after an intervening owner topic', () => {
    const request = detectPersonalReadRequest(
      [
        { role: 'user', content: 'There is nothing in the calendar about 9:15 flight.' },
        {
          role: 'assistant',
          content: 'What date and destination is the flight you want me to recheck?',
        },
        { role: 'user', content: 'Actually, check my doctor appointment.' },
        {
          role: 'assistant',
          content: 'What date and destination is the flight you want me to recheck?',
        },
        { role: 'user', content: 'October 9, 2026 to Berlin.' },
      ],
      options,
    );
    expect(request?.answerFocus).not.toBe('flight');
  });

  it('asks for the missing destination instead of searching a date alone', () => {
    const request = detectPersonalReadRequest(
      [
        { role: 'user', content: 'There is nothing in the calendar about 9:15 flight.' },
        {
          role: 'assistant',
          content: 'What date and destination is the flight you want me to recheck?',
        },
        { role: 'user', content: 'October 9, 2026.' },
      ],
      options,
    );
    expect(request).toMatchObject({
      answerFocus: 'flight',
      scopeIssue: 'What destination should I use for the flight?',
    });
    if (!request) throw new Error('expected a destination clarification');
    expect(nextRequiredReadTool(request, [])).toBeUndefined();
  });
});

describe('upcoming flight discovery', () => {
  const options = { now: new Date('2026-10-09T12:00:00Z'), timeZone: 'America/Los_Angeles' };

  it('recognizes a next-future-flight request without treating a current return as a new trip', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Find my next future flight using booking emails and calendar. State the date, departure time with its time zone, route and flight number, and whether it is an outbound or return flight. Check for conflicting sources. Do not assume that a return from a trip already underway is a new outbound trip. Keep it short, cite source links, and mark uncertainty. Do not book, send, or change anything.',
      ),
      options,
    );
    expect(request).toMatchObject({
      kind: 'calendar_email',
      answerFocus: 'flight',
      upcomingFlightDiscovery: true,
      firstToolName: 'calendar.list_events',
      queryTerms: [],
      requiresThreadRead: true,
    });
    expect(request?.verification).toBeUndefined();
    expect(request?.scopeIssue).toBeUndefined();
  });

  it('still rejects a genuinely requested booking after a read', () => {
    expect(
      detectPersonalReadRequest(
        turn('Find my next flight and then book it if the fare is under $500.'),
        options,
      ),
    ).toBeNull();
  });

  it('runs a bounded flight-only calendar and booking-thread read without route tools', () => {
    const request = detectPersonalReadRequest(
      turn('Find my next future flight using booking emails and calendar.'),
      options,
    );
    if (!request) throw new Error('Expected flight-only discovery');
    expect(nextRequiredReadTool(request, [])).toBe('calendar.list_events');
    const calendar: ReadToolEvidence = {
      toolName: 'calendar.list_events',
      status: 'succeeded',
      fromCurrentTask: true,
      args: {
        timeMin: request.timeWindow?.timeMin,
        timeMax: request.timeWindow?.timeMax,
        maxResults: 50,
      },
      result: { events: [], complete: true, calendarRosterComplete: true, unavailable: [] },
    };
    expect(nextRequiredReadTool(request, [calendar])).toBe('gmail.search');
    const search: ReadToolEvidence = {
      toolName: 'gmail.search',
      status: 'succeeded',
      fromCurrentTask: true,
      args: { query: request.mailQuery, maxResults: 20 },
      result: {
        query: request.mailQuery,
        complete: true,
        hasMore: false,
        results: [{ threadId: 'future-flight', subject: 'Flight booking confirmation' }],
      },
    };
    expect(nextRequiredReadTool(request, [calendar, search])).toBe('gmail.read_thread');
    const thread: ReadToolEvidence = {
      toolName: 'gmail.read_thread',
      status: 'succeeded',
      fromCurrentTask: true,
      args: { threadId: 'future-flight' },
      result: { complete: true, messages: [] },
    };
    expect(nextRequiredReadTool(request, [calendar, search, thread])).toBeUndefined();
    expect(nextRequiredReadTool(request, [calendar, search, thread])).not.toBe('maps.directions');
  });

  it('continues a partially read booking thread during flight-only discovery', () => {
    const request = detectPersonalReadRequest(
      turn('Find my next future flight using booking emails and calendar.'),
      options,
    );
    if (!request) throw new Error('Expected flight-only discovery');
    const calendar: ReadToolEvidence = {
      toolName: 'calendar.list_events',
      status: 'succeeded',
      fromCurrentTask: true,
      args: {
        timeMin: request.timeWindow?.timeMin,
        timeMax: request.timeWindow?.timeMax,
        maxResults: 50,
      },
      result: { events: [], complete: true, calendarRosterComplete: true, unavailable: [] },
    };
    const search: ReadToolEvidence = {
      toolName: 'gmail.search',
      status: 'succeeded',
      fromCurrentTask: true,
      args: { query: request.mailQuery, maxResults: 20 },
      result: {
        query: request.mailQuery,
        complete: true,
        hasMore: false,
        results: [
          { threadId: 'complete-flight', subject: 'Flight booking confirmation' },
          { threadId: 'paged-flight', subject: 'Flight booking confirmation' },
        ],
      },
    };
    const completeThread: ReadToolEvidence = {
      toolName: 'gmail.read_thread',
      status: 'succeeded',
      fromCurrentTask: true,
      args: { threadId: 'complete-flight', startMessageIndex: 0, startMessageOffset: 0 },
      result: { complete: true, messages: [{ messageId: 'complete-message' }] },
    };
    const continuation = {
      threadId: 'paged-flight',
      startMessageIndex: 0,
      startMessageOffset: 8_000,
      maxMessages: 20,
      maxChars: 20_000,
    };
    const partialThread: ReadToolEvidence = {
      toolName: 'gmail.read_thread',
      status: 'succeeded',
      fromCurrentTask: true,
      args: { threadId: 'paged-flight', startMessageIndex: 0, startMessageOffset: 0 },
      result: {
        complete: false,
        hasMore: true,
        messages: [{ messageId: 'partial-message' }],
        continuation: { tool: 'gmail.read_thread', input: continuation },
      },
    };
    const evidence = [calendar, search, completeThread, partialThread];

    expect(nextRequiredReadTool(request, evidence)).toBe('gmail.read_thread');
    expect(buildReadToolInput(request, 'gmail.read_thread', evidence)).toEqual(continuation);
  });

  it('does not treat the requested verification policy as a correction to an old claim', () => {
    const request = detectPersonalReadRequest(
      turn('Find my next flight, check for conflicts, and call out anything you cannot verify.'),
      options,
    );
    expect(request).toMatchObject({
      kind: 'calendar_email',
      answerFocus: 'flight',
      firstToolName: 'calendar.list_events',
      queryTerms: [],
      mailQuery:
        '{flight flights itinerary "e-ticket" "boarding pass" "booking confirmation" "reservation confirmation"}',
      timeWindow: {
        timeMin: '2026-10-09T12:00:00.000Z',
        timeMax: '2027-10-09T12:00:00.000Z',
      },
    });
    expect(request?.verification).toBeUndefined();
    expect(request?.scopeIssue).toBeUndefined();
    if (!request) throw new Error('expected a bounded upcoming flight discovery');
    expect(buildReadToolInput(request, 'calendar.list_events', [])).toMatchObject({
      timeMin: '2026-10-09T12:00:00.000Z',
      timeMax: '2027-10-09T12:00:00.000Z',
      maxResults: 50,
    });
    expect(buildReadToolInput(request, 'gmail.search', [])?.query).toBe(request.mailQuery);
  });

  it('still asks for the date of a subject-less terse correction', () => {
    const request = detectPersonalReadRequest(
      [
        { role: 'user', content: 'When is my flight to Berlin tomorrow?' },
        { role: 'assistant', content: 'Your flight leaves at 9:15 AM.' },
        { role: 'user', content: 'Are you sure?' },
      ],
      options,
    );
    expect(request).toMatchObject({
      verification: true,
      answerFocus: 'flight',
      scopeIssue: expect.stringMatching(/date/i),
    });
    if (!request) throw new Error('expected a scoped flight correction');
    expect(nextRequiredReadTool(request, [])).toBeUndefined();
  });

  it('does not treat a later next-step phrase as upcoming-flight discovery', () => {
    const request = detectPersonalReadRequest(
      turn('Check my flight tomorrow for conflicts, then plan the next route.'),
      options,
    );
    expect(request?.upcomingFlightDiscovery).toBeUndefined();
  });
});
