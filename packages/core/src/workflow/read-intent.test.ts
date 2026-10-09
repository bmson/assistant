import { describe, expect, it } from 'vitest';
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

  it.each(['Make this sentence clear.', 'Is the explanation clear?', 'Empty my inbox tomorrow.'])(
    'does not confuse another clear or empty request with availability: %s',
    (text) => {
      expect(detectPersonalReadRequest(turn(text))?.firstToolName).not.toBe(
        'calendar.availability',
      );
    },
  );

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
    expect(
      detectPersonalReadRequest(turn('When did I see the carnival parade in San Francisco?')),
    ).toMatchObject({
      kind: 'memory',
      firstToolName: 'memory.recall',
      queryTerms: ['carnival', 'parade', 'san', 'francisco'],
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
