import { describe, expect, it } from 'vitest';
import { latestOwnerIntent } from './owner-intent.js';
import { personCalendarResponse, requestedCalendarPerson } from './person-calendar.js';
import {
  detectPersonalReadRequest,
  groundReadToolInput,
  nextRequiredReadTool,
  type PersonalReadRequest,
  type ReadToolEvidence,
} from './read-intent.js';
import { responseCardsForFinal } from './response-cards.js';
import { enforceResponseContract } from './response-contract.js';

const options = { now: new Date('2026-10-15T19:00:00Z'), timeZone: 'America/Los_Angeles' };
function request(text = 'What is Alex doing next weekend?', config = options) {
  const result = detectPersonalReadRequest([{ role: 'user', content: text }], config);
  if (!result?.personCalendar) throw new Error('Missing named-person scope');
  return result;
}
function read(
  events: unknown[] = [],
  extra: Record<string, unknown> = {},
  req = request(),
): ReadToolEvidence {
  return {
    toolName: 'calendar.list_events',
    status: 'succeeded',
    fromCurrentTask: true,
    args: { ...req.timeWindow, label: undefined },
    result: {
      events,
      complete: true,
      calendarRosterComplete: true,
      unavailable: [],
      calendarsResolved: [
        { id: 'team', name: 'Harbor United' },
        { id: 'owner', name: 'Owner' },
      ],
      ...extra,
    },
  };
}
const event = (extra: Record<string, unknown> = {}) => ({
  eventId: 'source-event',
  calendarId: 'team',
  calendar: 'Harbor United',
  summary: 'Team match',
  start: '2026-10-17T19:00:00Z',
  end: '2026-10-17T20:00:00Z',
  attendees: [],
  ...extra,
});
const named = (email = 'alex@example.test', status = 'accepted') => ({
  attendeeDetails: [{ displayName: 'Alex', email, responseStatus: status }],
});

describe('named-person calendar scope', () => {
  it.each([
    ['What is Brynjar doing next weekend?', 'Brynjar'],
    ['Is Alex Johnson available tomorrow?', 'Alex Johnson'],
    ["What's on María’s calendar today?", 'María'],
    ['Show René’s schedule next week.', 'René'],
    ['What does Sam have planned on October 23?', 'Sam'],
  ])('detects a literal person in %s', (text, name) => {
    expect(requestedCalendarPerson(text)).toBe(name);
  });
  it.each([
    'What am I doing next weekend?',
    'Is she available tomorrow?',
    'What is the weather doing next weekend?',
  ])('does not treat generic subject as resolved person: %s', (text) => {
    expect(requestedCalendarPerson(text)).toBeUndefined();
  });
  it('authorizes only the owner-requested private read even without a clock at classification', () => {
    const intent = latestOwnerIntent(
      [{ role: 'user', content: 'What is Alex doing next weekend?' }],
      { trust: 'owner' },
    );
    expect(intent.authorizedScopes).toContain('private_read');
    expect(intent.authorizedScopes).not.toContain('personal_write');
    expect(intent.authorizedScopes).not.toContain('external_send');
  });
  it('uses the upcoming not-yet-started civil weekend and exact exclusive end', () => {
    expect(request().timeWindow).toEqual({
      timeMin: '2026-10-17T07:00:00.000Z',
      timeMax: '2026-10-19T07:00:00.000Z',
      label: 'next weekend',
    });
    expect(
      request('What is Alex doing next weekend?', {
        ...options,
        now: new Date('2026-10-17T18:00:00Z'),
      }).timeWindow?.timeMin,
    ).toBe('2026-10-24T07:00:00.000Z');
  });
  it('uses owner civil days near the UTC date boundary and across DST', () => {
    const result = request('What is Alex doing next weekend?', {
      now: new Date('2026-11-01T02:00:00Z'),
      timeZone: 'Pacific/Auckland',
    });
    expect(result.timeWindow).toMatchObject({
      timeMin: '2026-11-06T11:00:00.000Z',
      timeMax: '2026-11-08T11:00:00.000Z',
    });
    const dst = request('What is Alex doing this weekend?', {
      now: new Date('2026-10-30T19:00:00Z'),
      timeZone: options.timeZone,
    });
    expect(dst.timeWindow).toMatchObject({
      timeMin: '2026-10-31T07:00:00.000Z',
      timeMax: '2026-11-02T08:00:00.000Z',
    });
  });
  it('asks one bounded clock question instead of making up dates', () => {
    for (const config of [
      {},
      { ...options, timeZone: 'Invalid/Zone' },
      { ...options, now: new Date(NaN) },
    ]) {
      const result = detectPersonalReadRequest(
        [{ role: 'user', content: 'What is Alex doing next weekend?' }],
        config,
      );
      expect(result?.personCalendar?.name).toBe('Alex');
      expect(result?.temporalIssue).toContain('dates and time zone');
      expect(nextRequiredReadTool(result as PersonalReadRequest, [])).toBeUndefined();
    }
    expect(request('What is Alex doing?').temporalIssue).toContain('dates and time zone');
  });
  it('respects explicit read prohibition and does not capture a positive write request', () => {
    expect(
      detectPersonalReadRequest(
        [{ role: 'user', content: 'Do not read calendars. What is Alex doing tomorrow?' }],
        options,
      ),
    ).toBeNull();
    expect(
      detectPersonalReadRequest(
        [{ role: 'user', content: 'What is Alex doing tomorrow? Then cancel the meeting.' }],
        options,
      )?.personCalendar,
    ).toBeUndefined();
  });
  it('binds exact dates, every authorized calendar and current continuation, discarding model scope', () => {
    const req = request();
    expect(
      groundReadToolInput(
        req,
        'calendar.list_events',
        {
          timeMin: '2026-10-19T00:00:00Z',
          timeMax: '2026-10-21T00:00:00Z',
          calendarIds: ['team'],
          query: 'Alex',
          pageToken: 'invented',
        },
        [],
      ),
    ).toEqual({
      timeMin: req.timeWindow?.timeMin,
      timeMax: req.timeWindow?.timeMax,
      maxResults: 50,
    });
    const first = read([], { complete: false, nextPageToken: 'actual-page-2' });
    expect(nextRequiredReadTool(req, [first])).toBe('calendar.list_events');
    expect(groundReadToolInput(req, 'calendar.list_events', {}, [first]).pageToken).toBe(
      'actual-page-2',
    );
  });
  it('never turns a team schedule or an owner availability result into personal plans', () => {
    const req = request();
    const result = personCalendarResponse(req, [
      read([event()]),
      {
        toolName: 'calendar.availability',
        status: 'succeeded',
        result: { busy: [], complete: true },
      },
    ]);
    expect(result.text).toContain('couldn’t confirm Alex’s plans');
    expect(result.text).toContain('Oct 17, 2026–Oct 18, 2026');
    expect(result.text).toContain('Which calendar or email address');
    expect(result.text).not.toContain('Team match');
    expect(result.text).not.toContain('Alex is free');
    expect(
      responseCardsForFinal({
        readRequest: req,
        evidence: [read([event()])].map((row) => ({ ...row, result: row.result ?? null })),
      }),
    ).toEqual([]);
  });
  it('reports an explicitly named calendar with attendance uncertainty', () => {
    const result = personCalendarResponse(request(), [
      read([event({ calendarId: 'alex-calendar', calendar: 'Alex' })], {
        calendarsResolved: [{ id: 'alex-calendar', name: 'Alex' }],
      }),
    ]);
    expect(result.text).toContain('Team match');
    expect(result.text).toContain('on calendar “Alex”; personal attendance unconfirmed');
    expect(result.text).not.toContain('attendee marked accepted');
  });
  it.each(['accepted', 'tentative', 'needsAction'])(
    'preserves actual attendee RSVP %s',
    (status) => {
      const result = personCalendarResponse(request(), [
        read([event(named('alex@example.test', status))]),
      ]);
      expect(result.text).toContain('Team match');
      expect(result.text).toContain(
        status === 'accepted'
          ? 'marked accepted'
          : status === 'tentative'
            ? 'marked tentative'
            : 'attendance unconfirmed',
      );
      expect(result.text).toContain('do not establish personal availability');
    },
  );
  it('does not infer attendee identity from titles, roster labels or email local parts', () => {
    const result = personCalendarResponse(request(), [
      read([
        event({
          summary: 'Alex plays for Harbor United',
          attendees: ['alex@example.test (accepted)'],
        }),
      ]),
    ]);
    expect(result.text).not.toContain('Alex plays');
    expect(result.text).toContain('couldn’t confirm');
  });
  it('does not silently choose between two same-name attendee addresses or a declined invite', () => {
    const ambiguous = event({
      attendeeDetails: [
        ...named('one@example.test').attendeeDetails,
        ...named('two@example.test').attendeeDetails,
      ],
    });
    expect(
      personCalendarResponse(request(), [
        read([
          ambiguous,
          event({ ...named('alex@example.test', 'declined'), eventId: 'declined' }),
        ]),
      ]).text,
    ).not.toContain('Team match');
  });
  it('does not merge different same-name attendees across separate events', () => {
    const result = personCalendarResponse(request(), [
      read([
        event(named('one@example.test')),
        event({ ...named('two@example.test'), eventId: 'different-person' }),
      ]),
    ]);
    expect(result.text).not.toContain('Team match');
    expect(result.text).toContain('More than one attendee address');
    expect(result.text).toContain('Which email address');
  });
  it('filters outside-window, cancelled, floating and unzoned all-day entries from this window', () => {
    const evidence = read([
      event({
        ...named(),
        eventId: 'wrong-day',
        summary: 'Monday appointment',
        start: '2026-10-19T12:00:00Z',
        end: '2026-10-19T13:00:00Z',
      }),
      event({ ...named(), eventId: 'cancelled', status: 'cancelled' }),
      event({
        ...named(),
        eventId: 'floating',
        start: '2026-10-17T12:00:00',
        end: '2026-10-17T13:00:00',
      }),
      event({ ...named(), eventId: 'all-day', start: '2026-10-17', end: '2026-10-18' }),
    ]);
    const result = personCalendarResponse(request(), [evidence]);
    expect(result.text).not.toContain('Monday appointment');
    expect(result.text).not.toContain('**Team match**');
    expect(result.text).toContain('lacked a usable source time zone');
  });
  it('counts a zoned all-day interval only when it overlaps the requested owner window', () => {
    const result = personCalendarResponse(request(), [
      read([
        event({
          ...named(),
          allDay: true,
          start: '2026-10-17',
          end: '2026-10-19',
          calendarTimeZone: 'America/Los_Angeles',
        }),
      ]),
    ]);
    expect(result.text).toContain('all day in America/Los\\_Angeles');
  });
  it('rejects prior-task, different-window, narrowed-calendar and disjoint-page evidence', () => {
    const candidates = [
      { ...read([event(named())]), fromCurrentTask: false },
      {
        ...read([event(named())]),
        args: { timeMin: '2026-10-19T07:00:00.000Z', timeMax: '2026-10-21T07:00:00.000Z' },
      },
      { ...read([event(named())]), args: { ...request().timeWindow, calendarIds: ['team'] } },
      { ...read([event(named())]), args: { ...request().timeWindow, pageToken: 'unread-page' } },
    ];
    for (const evidence of candidates) {
      const result = personCalendarResponse(request(), [evidence]);
      expect(result.blocked).toBe(true);
      expect(result.text).not.toContain('Team match');
    }
  });
  it('retains honest coverage gaps and overrides model positive/absence claims', () => {
    const req = request();
    const evidence = [read([event()], { complete: false, unavailable: ['private calendar'] })];
    const result = enforceResponseContract(
      'Alex is free next weekend; Harbor United confirms attendance.',
      evidence.map((r) => ({ ...r, result: r.result ?? null })),
      { readRequest: req },
    );
    expect(result.blocked).toBe(true);
    expect(result.text).toContain('coverage is incomplete');
    expect(result.text).not.toContain('confirms attendance');
    expect(result.text).not.toContain('Alex is free');
  });
});
