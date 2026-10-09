import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { ownerVisibleOnlyFor } from '../types.js';
import { registerCalendarReadTools, registerCalendarTools } from './calendar.js';
import type { GoogleClient } from './client.js';

/** `risk` may be a tier or a per-call function; tests care about the tier. */
function riskOf(entry: ReturnType<ToolRegistry['get']>, args: unknown): string | undefined {
  const risk = entry?.tool.risk;
  return typeof risk === 'function' ? risk(args as never, {} as never) : risk;
}

function toolsWith(api: ReturnType<typeof vi.fn>) {
  const registry = new ToolRegistry();
  const signOpaqueToken = (value: string) => `test.${value}`;
  const verifyOpaqueToken = (token: string) => {
    return token.startsWith('test.') ? token.slice('test.'.length) : null;
  };
  registerCalendarTools(registry, {
    client: { api, signOpaqueToken, verifyOpaqueToken } as unknown as GoogleClient,
    botEmail: 'bot@example.com',
    ownerEmail: 'owner@example.com',
  });
  return registry;
}

const CALENDARS = [
  {
    id: 'bot@example.com',
    summary: 'Assistant',
    primary: true,
    accessRole: 'owner',
  },
  { id: 'owner@example.com', summary: 'Baldvin', accessRole: 'reader' },
  { id: 'work@example.com', summary: 'Work', accessRole: 'reader' },
];

function calendarIdIn(url: string): string {
  return decodeURIComponent(/calendars\/([^/]+)\/events/.exec(url)?.[1] ?? '');
}

/**
 * Mocks the calendarList lookup every read now makes, then serves events per
 * calendar. `events` maps a calendar id to its items; a calendar mapped to an
 * Error rejects, standing in for a revoked share.
 */
function apiFor(events: Record<string, unknown[] | Error>, calendars = CALENDARS) {
  return vi.fn(async (url: string) => {
    if (url.includes('/users/me/calendarList')) return { items: calendars };
    const id = calendarIdIn(url);
    const entry = events[id];
    if (entry instanceof Error) throw entry;
    return { items: entry ?? [] };
  });
}

function event(id: string, summary: string, start: string) {
  return { id, summary, start: { dateTime: start }, end: { dateTime: start } };
}

describe('calendar.list_events', () => {
  it('reads every shared calendar and merges them in chronological order', async () => {
    const api = apiFor({
      'bot@example.com': [event('b1', 'Bot task', '2026-07-24T15:00:00Z')],
      'owner@example.com': [event('o1', 'Dentist', '2026-07-24T09:00:00Z')],
      'work@example.com': [event('w1', 'Standup', '2026-07-24T12:00:00Z')],
    });
    const result = (await toolsWith(api)
      .get('calendar.list_events')
      ?.tool.execute(
        {
          timeMin: '2026-07-24T00:00:00Z',
          timeMax: '2026-07-25T00:00:00Z',
          maxResults: 20,
        },
        {} as never,
      )) as {
      events: Array<{ eventId: string; summary: string; calendar: string }>;
      calendarsSearched: string[];
    };

    // The owner's 09:00 sorts ahead of the bot's own 15:00 — a merged list has
    // to interleave calendars, not concatenate them.
    expect(result.events.map((e) => e.eventId)).toEqual(['o1', 'w1', 'b1']);
    expect(result.events.map((e) => e.calendar)).toEqual(['Baldvin', 'Work', 'Assistant']);
    expect(result.calendarsSearched).toEqual(['Assistant', 'Baldvin', 'Work']);
    expect(result).toMatchObject({ complete: true });
  });

  it('returns the globally earliest future event and preserves other calendars in the cursor', async () => {
    const byCalendar = {
      'bot@example.com': [event('later-bot', 'Later bot event', '2026-07-24T17:00:00Z')],
      'owner@example.com': [
        event('past-owner', 'Already finished', '2026-07-24T09:00:00Z'),
        event('first-future', 'First future', '2026-07-24T12:00:00Z'),
      ],
      'work@example.com': [event('later-work', 'Later work event', '2026-07-24T13:00:00Z')],
    };
    const api = vi.fn(async (url: string) => {
      if (url.includes('/users/me/calendarList')) return { items: CALENDARS };
      const parsed = new URL(url, 'https://calendar.test');
      const id = calendarIdIn(url);
      const timeMin = Date.parse(parsed.searchParams.get('timeMin') ?? '');
      const timeMax = Date.parse(parsed.searchParams.get('timeMax') ?? '');
      const pageSize = Number(parsed.searchParams.get('maxResults'));
      const items = (byCalendar[id as keyof typeof byCalendar] ?? [])
        .filter((item) => {
          const start = Date.parse(item.start.dateTime);
          return start >= timeMin && start < timeMax;
        })
        .sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime))
        .slice(0, pageSize);
      return { items };
    });
    const result = (await toolsWith(api)
      .get('calendar.list_events')
      ?.tool.execute(
        {
          timeMin: '2026-07-24T10:00:00Z',
          timeMax: '2026-07-25T00:00:00Z',
          maxResults: 1,
        },
        {} as never,
      )) as {
      events: Array<{ eventId: string; start: string }>;
      complete: boolean;
      nextPageToken?: string;
    };

    const eventQueries = api.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/events'))
      .map((url) => new URL(url, 'https://calendar.test'));
    expect(eventQueries).toHaveLength(3);
    expect(
      eventQueries.every((url) => url.searchParams.get('timeMin') === '2026-07-24T10:00:00Z'),
    ).toBe(true);
    expect(eventQueries.every((url) => url.searchParams.get('maxResults') === '1')).toBe(true);
    expect(result.events.map(({ eventId, start }) => ({ eventId, start }))).toEqual([
      { eventId: 'first-future', start: '2026-07-24T12:00:00Z' },
    ]);
    expect(result.complete).toBe(false);
    expect(result.nextPageToken).toMatch(/^test\./);
    if (!result.nextPageToken) throw new Error('Expected a cursor for unreturned calendars');
    const cursor = JSON.parse(result.nextPageToken.slice('test.'.length)) as {
      calendars: Array<{ buffered: Array<{ eventId: string }> }>;
    };
    expect(
      cursor.calendars.flatMap((calendar) => calendar.buffered.map((item) => item.eventId)),
    ).toEqual(expect.arrayContaining(['later-bot', 'later-work']));
  });

  it('addresses each calendar by id rather than the hardcoded primary', async () => {
    const api = apiFor({});
    await toolsWith(api)
      .get('calendar.list_events')
      ?.tool.execute(
        {
          timeMin: '2026-07-24T00:00:00Z',
          timeMax: '2026-07-25T00:00:00Z',
          maxResults: 20,
        },
        {} as never,
      );
    const requested = api.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/events'))
      .map(calendarIdIn);
    expect(requested).toEqual(['bot@example.com', 'owner@example.com', 'work@example.com']);
    expect(requested).not.toContain('primary');
  });

  it('preserves Google all-day events as date-only entries', async () => {
    const api = apiFor({
      'owner@example.com': [
        {
          id: 'first-day',
          summary: 'FIRST DAY OF SCHOOL',
          start: { date: '2026-08-17' },
          end: { date: '2026-08-18' },
        },
      ],
    });
    const result = (await toolsWith(api)
      .get('calendar.list_events')
      ?.tool.execute(
        {
          timeMin: '2026-08-17T00:00:00-07:00',
          timeMax: '2026-08-18T00:00:00-07:00',
          maxResults: 20,
        },
        {} as never,
      )) as {
      events: Array<{ summary: string; start: string; end: string; allDay: boolean }>;
    };

    expect(result.events).toContainEqual(
      expect.objectContaining({
        summary: 'FIRST DAY OF SCHOOL',
        start: '2026-08-17',
        end: '2026-08-18',
        allDay: true,
      }),
    );
  });

  it('still answers when one calendar fails, and names the one it could not read', async () => {
    const api = apiFor({
      'owner@example.com': [event('o1', 'Dentist', '2026-07-24T09:00:00Z')],
      'work@example.com': new Error('Google API 403 on work: forbidden'),
    });
    const result = (await toolsWith(api)
      .get('calendar.list_events')
      ?.tool.execute(
        {
          timeMin: '2026-07-24T00:00:00Z',
          timeMax: '2026-07-25T00:00:00Z',
          maxResults: 20,
        },
        {} as never,
      )) as {
      events: Array<{ eventId: string }>;
      unavailable?: Array<{ calendar: string; reason: string }>;
    };
    expect(result.events.map((e) => e.eventId)).toEqual(['o1']);
    expect(result.unavailable).toEqual([
      { calendar: 'Work', reason: 'Google API 403 on work: forbidden' },
    ]);
    expect(result).toMatchObject({ complete: false });
  });

  it('fails instead of treating an empty calendar roster as an empty schedule', async () => {
    await expect(
      toolsWith(apiFor({}, []))
        .get('calendar.list_events')
        ?.tool.execute(
          {
            timeMin: '2026-08-17T00:00:00-07:00',
            timeMax: '2026-08-18T00:00:00-07:00',
          },
          {} as never,
        ),
    ).rejects.toThrow(/no readable calendars/i);
  });

  it('narrows to named calendars when asked, by name or by id', async () => {
    const api = apiFor({
      'owner@example.com': [event('o1', 'Dentist', '2026-07-24T09:00:00Z')],
      'work@example.com': [event('w1', 'Standup', '2026-07-24T12:00:00Z')],
    });
    const result = (await toolsWith(api)
      .get('calendar.list_events')
      ?.tool.execute(
        {
          timeMin: '2026-07-24T00:00:00Z',
          timeMax: '2026-07-25T00:00:00Z',
          maxResults: 20,
          calendarIds: ['Work'],
        },
        {} as never,
      )) as { events: Array<{ eventId: string }>; calendarsSearched: string[] };
    expect(result.calendarsSearched).toEqual(['Work']);
    expect(result.events.map((e) => e.eventId)).toEqual(['w1']);
  });

  it('keeps requested, resolved, and searched calendar coverage distinct when some names are missing', async () => {
    const api = apiFor({ 'work@example.com': [event('w1', 'Standup', '2026-07-24T12:00:00Z')] });
    const result = (await toolsWith(api)
      .get('calendar.list_events')
      ?.tool.execute(
        {
          timeMin: '2026-07-24T00:00:00Z',
          timeMax: '2026-07-25T00:00:00Z',
          maxResults: 20,
          calendarIds: ['Work', 'Former team calendar'],
        },
        {} as never,
      )) as {
      events: Array<{ eventId: string }>;
      calendarsRequested: string[];
      calendarsResolved: Array<{ id: string; name: string }>;
      calendarsSearched: string[];
      unavailable: Array<{ calendar: string; reason: string }>;
      complete: boolean;
    };

    expect(result.events.map((entry) => entry.eventId)).toEqual(['w1']);
    expect(result.calendarsRequested).toEqual(['Work', 'Former team calendar']);
    expect(result.calendarsResolved).toEqual([{ id: 'work@example.com', name: 'Work' }]);
    expect(result.calendarsSearched).toEqual(['Work']);
    expect(result.unavailable).toEqual([
      { calendar: 'Former team calendar', reason: 'calendar was not found in the readable roster' },
    ]);
    expect(result.complete).toBe(false);
  });

  it('does not guess when a requested display name matches multiple calendars', async () => {
    const duplicateName = [
      { id: 'team-a@example.com', summary: 'Team', accessRole: 'reader' },
      { id: 'team-b@example.com', summary: 'Team', accessRole: 'reader' },
    ];
    const api = apiFor({}, duplicateName);
    const result = (await toolsWith(api)
      .get('calendar.list_events')
      ?.tool.execute(
        {
          timeMin: '2026-07-24T00:00:00Z',
          timeMax: '2026-07-25T00:00:00Z',
          maxResults: 20,
          calendarIds: ['Team'],
        },
        {} as never,
      )) as {
      unavailable: Array<{ calendar: string; reason: string; candidates?: string[] }>;
      calendarsSearched: string[];
      complete: boolean;
    };

    expect(result.unavailable).toEqual([
      {
        calendar: 'Team',
        reason: 'calendar name is ambiguous; select by calendar ID',
        candidates: ['team-a@example.com', 'team-b@example.com'],
      },
    ]);
    expect(result.calendarsSearched).toEqual([]);
    expect(api.mock.calls.some(([url]) => String(url).includes('/events'))).toBe(false);
    expect(result.complete).toBe(false);
  });

  it('paginates the readable calendar roster and can resolve a calendar on the next page', async () => {
    const api = vi.fn(async (url: string) => {
      if (url.includes('/users/me/calendarList')) {
        const token = new URL(url).searchParams.get('pageToken');
        return token === 'roster-2'
          ? { items: [{ id: 'second@example.com', summary: 'Second page', accessRole: 'reader' }] }
          : {
              items: [{ id: 'first@example.com', summary: 'First page', accessRole: 'reader' }],
              nextPageToken: 'roster-2',
            };
      }
      return { items: [event('on-second-page', 'Found', '2026-07-24T09:00:00Z')] };
    });
    const registry = toolsWith(api);
    const firstRosterPage = (await registry
      .get('calendar.list_calendars')
      ?.tool.execute({}, {} as never)) as {
      calendars: Array<{ id: string }>;
      nextPageToken?: string;
      complete: boolean;
    };
    const secondRosterPage = (await registry
      .get('calendar.list_calendars')
      ?.tool.execute({ pageToken: firstRosterPage.nextPageToken }, {} as never)) as {
      calendars: Array<{ id: string }>;
      complete: boolean;
    };
    const events = (await registry.get('calendar.list_events')?.tool.execute(
      {
        timeMin: '2026-07-24T00:00:00Z',
        timeMax: '2026-07-25T00:00:00Z',
        maxResults: 20,
        calendarIds: ['Second page'],
      },
      {} as never,
    )) as { events: Array<{ eventId: string }>; complete: boolean };

    expect(firstRosterPage.calendars.map((calendar) => calendar.id)).toEqual(['first@example.com']);
    expect(firstRosterPage.nextPageToken).toBe('roster-2');
    expect(firstRosterPage.complete).toBe(false);
    expect(secondRosterPage.calendars.map((calendar) => calendar.id)).toEqual([
      'second@example.com',
    ]);
    expect(secondRosterPage.complete).toBe(true);
    expect(events.events.map((entry) => entry.eventId)).toEqual(['on-second-page']);
    expect(events.complete).toBe(true);
  });

  it('continues chronological event pagination with the same filters and authenticated cursor', async () => {
    const api = vi.fn(async (url: string) => {
      if (url.includes('/users/me/calendarList')) return { items: [CALENDARS[0]] };
      const params = new URL(url).searchParams;
      if (params.get('pageToken') === 'second')
        return { items: [event('b2', 'Second', '2026-07-24T10:00:00Z')] };
      return {
        items: [event('b1', 'First', '2026-07-24T09:00:00Z')],
        nextPageToken: 'second',
      };
    });
    const tool = toolsWith(api).get('calendar.list_events')?.tool;
    const first = (await tool?.execute(
      {
        timeMin: '2026-07-24T00:00:00Z',
        timeMax: '2026-07-25T00:00:00Z',
        maxResults: 1,
      },
      {} as never,
    )) as { events: Array<{ eventId: string }>; nextPageToken: string; complete: boolean };
    const second = (await tool?.execute(
      {
        timeMin: '2026-07-24T00:00:00Z',
        timeMax: '2026-07-25T00:00:00Z',
        maxResults: 1,
        pageToken: first.nextPageToken,
      },
      {} as never,
    )) as { events: Array<{ eventId: string }>; nextPageToken?: string; complete: boolean };

    expect(first.events.map((entry) => entry.eventId)).toEqual(['b1']);
    expect(first.complete).toBe(false);
    expect(second.events.map((entry) => entry.eventId)).toEqual(['b2']);
    expect(second.complete).toBe(true);
    const eventUrls = api.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/events'));
    expect(eventUrls).toHaveLength(2);
    for (const url of eventUrls) {
      expect(new URL(url).searchParams.get('timeMin')).toBe('2026-07-24T00:00:00Z');
      expect(new URL(url).searchParams.get('timeMax')).toBe('2026-07-25T00:00:00Z');
      expect(new URL(url).searchParams.get('singleEvents')).toBe('true');
      expect(new URL(url).searchParams.get('orderBy')).toBe('startTime');
    }
    const secondEventUrl = eventUrls.at(1);
    expect(secondEventUrl).toBeDefined();
    expect(new URL(secondEventUrl ?? '').searchParams.get('pageToken')).toBe('second');
  });

  it('trims the merged list to maxResults after sorting, not per calendar', async () => {
    const api = apiFor({
      'bot@example.com': [event('b1', 'Late', '2026-07-24T23:00:00Z')],
      'owner@example.com': [event('o1', 'Early', '2026-07-24T01:00:00Z')],
    });
    const result = (await toolsWith(api)
      .get('calendar.list_events')
      ?.tool.execute(
        {
          timeMin: '2026-07-24T00:00:00Z',
          timeMax: '2026-07-25T00:00:00Z',
          maxResults: 1,
        },
        {} as never,
      )) as { events: Array<{ eventId: string }>; complete: boolean };
    expect(result.events.map((e) => e.eventId)).toEqual(['o1']);
    expect(result.complete).toBe(false);
  });

  it('marks coverage partial when Google has another page of events', async () => {
    const api = vi.fn(async (url: string) => {
      if (url.includes('/users/me/calendarList')) {
        return { items: [CALENDARS[0]] };
      }
      return {
        items: [event('b1', 'First match', '2026-07-24T09:00:00Z')],
        nextPageToken: 'another-page',
      };
    });
    const result = (await toolsWith(api)
      .get('calendar.search_events')
      ?.tool.execute({ query: 'Clay', maxResults: 1 }, {} as never)) as {
      complete: boolean;
      note?: string;
    };

    expect(result.complete).toBe(false);
    expect(result.note).toMatch(/additional matching events/i);
  });

  it('reads as confidential untrusted content and stays autonomous', () => {
    const entry = toolsWith(vi.fn()).get('calendar.list_events');
    expect(entry?.tool.risk).toBe('autonomous');
    expect(entry?.flags).toMatchObject({
      confidentialRead: true,
      returnsUntrustedContent: true,
    });
  });
});

describe('mail-derived calendar mutation fence', () => {
  it('does not call Google when a booking lifecycle changed after acceptance', async () => {
    const api = vi.fn(async () => ({ id: 'should-not-create' }));
    const registered = toolsWith(api).get('calendar.create_event');
    const recheck = vi.fn(async () => false);

    await expect(
      registered?.tool.execute(
        {
          summary: 'Berlin spa booking',
          start: '2026-10-20T14:40:00Z',
          end: '2026-10-20T16:40:00Z',
          description: '',
          location: '',
          attendees: [],
        },
        {
          bookingOccurrence: {
            agentId: 'agent-1',
            bookingKey: 'opaque-key',
            version: 1,
          },
          assertBookingOccurrenceCurrent: recheck,
        } as never,
      ),
    ).rejects.toThrow('booking changed');
    expect(recheck).toHaveBeenCalledOnce();
    expect(api).not.toHaveBeenCalled();
  });
});

describe('portable calendar read surface', () => {
  it('registers availability and event reads while excluding every mutation', () => {
    const registry = new ToolRegistry();
    registerCalendarReadTools(registry, {
      client: { api: vi.fn() } as unknown as GoogleClient,
      botEmail: 'bot@example.com',
      ownerEmail: 'owner@example.com',
    });

    expect(
      registry
        .all()
        .map(({ tool }) => tool.name)
        .sort(),
    ).toEqual(['calendar.availability', 'calendar.list_calendars', 'calendar.list_events']);
  });
});

describe('calendar.list_calendars', () => {
  it('lists the shared calendars with the access the assistant has', async () => {
    const result = (await toolsWith(apiFor({}))
      .get('calendar.list_calendars')
      ?.tool.execute({}, {} as never)) as {
      calendars: Array<{
        id: string;
        name: string;
        primary: boolean;
        access: string;
      }>;
    };
    expect(result.calendars).toEqual([
      {
        id: 'bot@example.com',
        name: 'Assistant',
        primary: true,
        access: 'owner',
      },
      {
        id: 'owner@example.com',
        name: 'Baldvin',
        primary: false,
        access: 'reader',
      },
      {
        id: 'work@example.com',
        name: 'Work',
        primary: false,
        access: 'reader',
      },
    ]);
  });

  it('prefers the local name the owner gave a shared calendar', async () => {
    const api = apiFor({}, [
      {
        id: 'work@example.com',
        summary: 'work@example.com',
        accessRole: 'reader',
      },
    ]);
    // summaryOverride is what the owner renamed it to in their own UI.
    (api as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
      async () => ({
        items: [
          {
            id: 'work@example.com',
            summary: 'work@example.com',
            summaryOverride: 'Day job',
            accessRole: 'reader',
          },
        ],
      }),
    );
    const result = (await toolsWith(api)
      .get('calendar.list_calendars')
      ?.tool.execute({}, {} as never)) as {
      calendars: Array<{ name: string }>;
    };
    expect(result.calendars[0]?.name).toBe('Day job');
  });
});

describe('calendar.search_events', () => {
  it('drops a provider landing page that does not identify an event', async () => {
    const api = apiFor({
      'owner@example.com': [
        {
          id: 'evt-generic',
          summary: 'Review',
          htmlLink: 'https://calendar.google.com/calendar/u/0/r',
          start: { dateTime: '2026-07-24T12:00:00-07:00' },
          end: { dateTime: '2026-07-24T13:00:00-07:00' },
        },
      ],
    });
    const result = (await toolsWith(api)
      .get('calendar.search_events')
      ?.tool.execute({ query: 'Review', maxResults: 20 }, {} as never)) as {
      events: Array<{ links: Array<{ type: string }> }>;
    };
    expect(result.events[0]?.links ?? []).not.toContainEqual(
      expect.objectContaining({ type: 'calendar' }),
    );
  });

  it('searches every shared calendar and normalizes results', async () => {
    const api = apiFor({
      'owner@example.com': [
        {
          id: 'evt-1',
          summary: 'Lunch with Sam',
          location: 'Cafe',
          description: 'Join at https://meet.example.com/sam-room.',
          htmlLink: 'https://calendar.google.com/event?eid=evt-1',
          organizer: { email: 'sam@example.com', displayName: 'Sam' },
          start: { dateTime: '2026-07-24T12:00:00-07:00' },
          end: { dateTime: '2026-07-24T13:00:00-07:00' },
          attendees: [{ email: 'sam@example.com', responseStatus: 'accepted' }],
        },
      ],
    });
    const result = (await toolsWith(api)
      .get('calendar.search_events')
      ?.tool.execute({ query: 'Sam', maxResults: 20 }, {} as never)) as {
      events: Array<{
        eventId: string;
        attendees: string[];
        calendar: string;
        organizer: string;
        links: Array<{ url: string }>;
      }>;
    };
    expect(result.events[0]?.eventId).toBe('evt-1');
    expect(result.events[0]?.attendees).toEqual(['sam@example.com (accepted)']);
    expect(result.events[0]?.calendar).toBe('Baldvin');
    expect(result.events[0]?.organizer).toBe('Sam <sam@example.com>');
    expect(result.events[0]?.links.map((link) => link.url)).toEqual([
      'https://calendar.google.com/event?eid=evt-1',
      'https://meet.example.com/sam-room',
    ]);

    const eventUrls = api.mock.calls
      .map(([url]) => String(url))
      .filter((u) => u.includes('/events'));
    expect(eventUrls).toHaveLength(3); // one per shared calendar
    for (const url of eventUrls) {
      expect(url).toContain('q=Sam');
      expect(url).toContain('singleEvents=true');
    }
  });

  it('reads as confidential untrusted content and stays autonomous', () => {
    const entry = toolsWith(vi.fn()).get('calendar.search_events');
    expect(entry?.tool.risk).toBe('autonomous');
    expect(entry?.flags).toMatchObject({
      confidentialRead: true,
      returnsUntrustedContent: true,
    });
  });
});

describe('calendar.availability', () => {
  it('asks free/busy about every shared calendar, not just the bot and owner', async () => {
    // Typed with the init argument so the POST body can be asserted on.
    const api = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('/users/me/calendarList')) return { items: CALENDARS };
      return {
        calendars: {
          'bot@example.com': { busy: [] },
          'owner@example.com': {
            busy: [{ start: '2026-07-24T09:00:00Z', end: '2026-07-24T10:00:00Z' }],
          },
          'work@example.com': {
            busy: [{ start: '2026-07-24T08:00:00Z', end: '2026-07-24T08:30:00Z' }],
          },
        },
      };
    });
    const result = (await toolsWith(api)
      .get('calendar.availability')
      ?.tool.execute(
        { timeMin: '2026-07-24T00:00:00Z', timeMax: '2026-07-25T00:00:00Z' },
        {} as never,
      )) as {
      busy: Array<{ calendar: string; start: string }>;
      calendarsChecked: string[];
    };

    const freeBusyCall = api.mock.calls.find(([url]) => String(url).includes('/freeBusy'));
    expect(freeBusyCall).toBeDefined();
    const body = JSON.parse(String((freeBusyCall?.[1] as RequestInit | undefined)?.body));
    expect(body.items).toEqual([
      { id: 'bot@example.com' },
      { id: 'owner@example.com' },
      { id: 'work@example.com' },
    ]);
    // Merged and sorted, each block labelled with the calendar it came from.
    expect(result.busy.map((b) => b.calendar)).toEqual(['Work', 'Baldvin']);
    expect(result.calendarsChecked).toContain('Work');
    expect(result).toMatchObject({ complete: true });
  });

  it('names calendars that have not shared free/busy instead of reporting them free', async () => {
    const api = vi.fn(async (url: string) => {
      if (url.includes('/users/me/calendarList')) return { items: CALENDARS };
      return {
        calendars: {
          'bot@example.com': { busy: [] },
          'owner@example.com': { errors: [{ reason: 'notFound' }] },
          'work@example.com': { busy: [] },
        },
      };
    });
    const result = (await toolsWith(api)
      .get('calendar.availability')
      ?.tool.execute(
        { timeMin: '2026-07-24T00:00:00Z', timeMax: '2026-07-25T00:00:00Z' },
        {} as never,
      )) as { complete: boolean; unavailable?: string[] };
    expect(result.unavailable).toEqual(['Baldvin']);
    expect(result.complete).toBe(false);
  });

  it('treats an omitted free/busy calendar response as unavailable, not free', async () => {
    const api = vi.fn(async (url: string) => {
      if (url.includes('/users/me/calendarList')) return { items: CALENDARS };
      return {
        calendars: {
          'bot@example.com': { busy: [] },
          'owner@example.com': { busy: [] },
          // Google omitted work@example.com entirely.
        },
      };
    });
    const result = (await toolsWith(api)
      .get('calendar.availability')
      ?.tool.execute(
        { timeMin: '2026-07-24T00:00:00Z', timeMax: '2026-07-25T00:00:00Z' },
        {} as never,
      )) as { complete: boolean; unavailable?: string[] };
    expect(result).toMatchObject({ complete: false, unavailable: ['Work'] });
  });

  it('does not claim complete coverage when the shared-calendar roster fails', async () => {
    const api = vi.fn(async (url: string) => {
      if (url.includes('/users/me/calendarList')) throw new Error('calendar list unavailable');
      return {
        calendars: {
          'bot@example.com': { busy: [] },
          'owner@example.com': { busy: [] },
        },
      };
    });
    const result = (await toolsWith(api)
      .get('calendar.availability')
      ?.tool.execute(
        { timeMin: '2026-07-24T00:00:00Z', timeMax: '2026-07-25T00:00:00Z' },
        {} as never,
      )) as { complete: boolean; note?: string };
    expect(result.complete).toBe(false);
    expect(result.note).toMatch(/calendar list could not be loaded/i);
  });
});

describe('calendar.update_event', () => {
  it('needs approval by default and summarizes the change', () => {
    const entry = toolsWith(vi.fn()).get('calendar.update_event');
    expect(riskOf(entry, { eventId: 'evt-1', start: '2026-07-24T16:00:00-07:00' })).toBe(
      'approval',
    );
    expect(entry?.flags).toMatchObject({ outwardFacing: true });
    const summary = entry?.tool.approvalSummary?.({
      eventId: 'evt-1',
      start: '2026-07-24T16:00:00-07:00',
    });
    expect(summary).toContain('evt-1');
    expect(summary).toContain('move to');
  });

  it('runs autonomously when the caller claims the event is owner-only', () => {
    const entry = toolsWith(vi.fn()).get('calendar.update_event');
    expect(
      riskOf(entry, { eventId: 'evt-1', start: '2026-07-24T16:00:00-07:00', ownerOnly: true }),
    ).toBe('autonomous');
    // ...and it stays autonomous under taint, the same way create_event does.
    expect(
      ownerVisibleOnlyFor(entry?.flags ?? {}, {
        eventId: 'evt-1',
        start: '2026-07-24T16:00:00-07:00',
        ownerOnly: true,
      }),
    ).toBe(true);
  });

  it('will not launder an invitation through the owner-only claim', () => {
    const entry = toolsWith(vi.fn()).get('calendar.update_event');
    // Adding an attendee contradicts "nobody gets mailed", so the combination
    // is gated no matter what the caller asserted.
    const args = { eventId: 'evt-1', ownerOnly: true, addAttendees: ['someone@example.com'] };
    expect(riskOf(entry, args)).toBe('approval');
    expect(ownerVisibleOnlyFor(entry?.flags ?? {}, args)).toBe(false);
  });

  it('refuses an owner-only edit once it sees the event has attendees', async () => {
    // The declared flag bought the autonomous tier; this fetch is what makes
    // the claim true. A wrong claim must fail loudly, not mail the attendees.
    const api = vi.fn().mockResolvedValueOnce({
      etag: 'version-1',
      attendees: [{ email: 'someone@example.com' }],
    });
    await expect(
      toolsWith(api)
        .get('calendar.update_event')
        ?.tool.execute(
          { eventId: 'evt-1', start: '2026-07-24T16:00:00-07:00', ownerOnly: true },
          {} as never,
        ),
    ).rejects.toThrow(/owner-only/i);
    // Only the verification GET happened — nothing was patched.
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('suppresses notifications on a verified owner-only edit', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ etag: 'version-1', attendees: [] }) // verification GET
      .mockResolvedValueOnce({ id: 'evt-1' }); // PATCH
    await toolsWith(api)
      .get('calendar.update_event')
      ?.tool.execute(
        { eventId: 'evt-1', start: '2026-07-24T16:00:00-07:00', ownerOnly: true },
        {} as never,
      );
    const [patchUrl, patchInit] = api.mock.calls[1] as [string, RequestInit];
    expect(patchUrl).toContain('sendUpdates=none');
    expect(patchInit.headers).toEqual({ 'If-Match': 'version-1' });
  });

  it('PATCHes only the changed fields and merges added attendees onto existing ones', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({
        etag: 'version-2',
        attendees: [
          {
            email: 'Existing@Example.com',
            responseStatus: 'tentative',
            optional: true,
            comment: 'arriving later',
            displayName: 'Existing guest',
          },
          { email: 'existing@example.com', displayName: 'Existing duplicate row' },
        ],
      }) // GET existing
      .mockResolvedValueOnce({
        id: 'evt-1',
        htmlLink: 'https://cal.example/evt-1',
      }); // PATCH
    await toolsWith(api)
      .get('calendar.update_event')
      ?.tool.execute(
        {
          eventId: 'evt-1',
          start: '2026-07-24T16:00:00-07:00',
          addAttendees: ['new@example.com', 'EXISTING@example.com'],
        },
        {} as never,
      );
    const [patchUrl, patchInit] = api.mock.calls[1] as [string, RequestInit];
    expect(patchUrl).toContain('/events/evt-1');
    expect(patchUrl).toContain('sendUpdates=all');
    const body = JSON.parse(String(patchInit.body));
    expect(body.start).toEqual({ dateTime: '2026-07-24T16:00:00-07:00' });
    expect(body.summary).toBeUndefined(); // untouched fields aren't sent
    expect(body.attendees).toEqual([
      {
        email: 'Existing@Example.com',
        responseStatus: 'tentative',
        optional: true,
        comment: 'arriving later',
        displayName: 'Existing guest',
      },
      { email: 'existing@example.com', displayName: 'Existing duplicate row' },
      { email: 'new@example.com' },
    ]);
    expect((patchInit as RequestInit).headers).toEqual({ 'If-Match': 'version-2' });
  });

  it('returns the canonical event time from a successful patch response', async () => {
    const api = vi.fn().mockResolvedValueOnce({
      id: 'evt-1',
      htmlLink: 'https://cal.example/evt-1',
      summary: 'Sample Air flight SFO to BER via AMS',
      description: 'private event description',
      location: 'private event location',
      start: { dateTime: '2026-10-09T13:45:00-07:00' },
      end: { dateTime: '2026-10-10T09:05:00+02:00' },
    });
    const result = (await toolsWith(api)
      .get('calendar.update_event')
      ?.tool.execute(
        { eventId: 'evt-1', start: '2026-10-09T13:45:00-07:00' },
        {} as never,
      )) as Record<string, unknown>;

    expect(result).toMatchObject({
      eventId: 'evt-1',
      updated: true,
      summary: 'Sample Air flight SFO to BER via AMS',
      start: '2026-10-09T13:45:00-07:00',
      end: '2026-10-10T09:05:00+02:00',
    });
    expect(result).not.toHaveProperty('description');
    expect(result).not.toHaveProperty('location');
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('does not manufacture a canonical time when the patch response omits it', async () => {
    const api = vi.fn().mockResolvedValueOnce({ id: 'evt-1', updated: true });
    const result = (await toolsWith(api)
      .get('calendar.update_event')
      ?.tool.execute(
        { eventId: 'evt-1', start: '2026-10-09T13:45:00-07:00' },
        {} as never,
      )) as Record<string, unknown>;

    expect(result.updated).toBe(true);
    expect(result.start).toBeUndefined();
  });

  it('rejects an update with no fields to change', () => {
    const schema = toolsWith(vi.fn()).get('calendar.update_event')?.tool.inputSchema;
    expect(schema?.safeParse({ eventId: 'evt-1' }).success).toBe(false);
  });
});

describe('calendar.cancel_event', () => {
  it('needs approval by default — cancelling mails every attendee', () => {
    const entry = toolsWith(vi.fn()).get('calendar.cancel_event');
    expect(riskOf(entry, { eventId: 'evt-1' })).toBe('approval');
    expect(ownerVisibleOnlyFor(entry?.flags ?? {}, { eventId: 'evt-1' })).toBe(false);
  });

  it('cancels a private appointment autonomously once verified', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ etag: 'version-3', attendees: [] }) // verification GET
      .mockResolvedValueOnce({}); // DELETE
    const entry = toolsWith(api).get('calendar.cancel_event');
    expect(riskOf(entry, { eventId: 'evt-1', ownerOnly: true })).toBe('autonomous');

    await entry?.tool.execute({ eventId: 'evt-1', ownerOnly: true }, {} as never);
    const [deleteUrl, init] = api.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(deleteUrl).toContain('sendUpdates=none');
    expect(init.headers).toEqual({ 'If-Match': 'version-3' });
  });

  it('refuses rather than cancelling on someone else’s behalf', async () => {
    const api = vi.fn().mockResolvedValueOnce({ attendees: [{ email: 'guest@example.com' }] });
    await expect(
      toolsWith(api)
        .get('calendar.cancel_event')
        ?.tool.execute({ eventId: 'evt-1', ownerOnly: true }, {} as never),
    ).rejects.toThrow(/owner-only/i);
    // The DELETE never went out.
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('cancellation reconciliation is bound to the frozen event and fresh source marker', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'event-314',
        etag: 'event-v7',
        status: 'confirmed',
        summary: 'Berlin spa',
        description: 'Booking reference R-314',
        attendees: [],
      })
      .mockResolvedValueOnce({});
    const current = vi.fn().mockResolvedValue(true);
    const entry = toolsWith(api).get('calendar.cancel_booking_event');
    await entry?.tool.execute({ eventId: 'event-314', ownerOnly: true }, {
      bookingOccurrence: {
        agentId: 'agent-1',
        bookingKey: 'booking-314',
        version: 2,
        operation: 'cancel_existing',
        calendarEventId: 'event-314',
        bookingIdentity: 'R-314',
      },
      assertBookingOccurrenceCurrent: current,
    } as never);
    expect(current).toHaveBeenCalledTimes(2);
    const [deleteUrl, init] = api.mock.calls[1] as [string, RequestInit];
    expect(deleteUrl).toContain('/events/event-314?sendUpdates=none');
    expect(init.headers).toEqual({ 'If-Match': 'event-v7' });
  });

  it('requires booking authority before exposing the narrow cancellation tool to tainted work', async () => {
    const tool = toolsWith(vi.fn()).get('calendar.cancel_booking_event')?.tool;
    await expect(
      tool?.prepareSecurity?.({ eventId: 'event-314' } as never, {} as never, 'dispatch'),
    ).rejects.toThrow(/authority binding/i);
    await expect(
      tool?.prepareSecurity?.(
        { eventId: 'different-event' } as never,
        {
          bookingOccurrence: {
            operation: 'cancel_existing',
            calendarEventId: 'event-314',
            bookingIdentity: 'R-314',
          },
        } as never,
        'approved',
      ),
    ).rejects.toThrow(/authority binding/i);
  });

  it('abstains if the frozen event changed or the source occurrence was reinstated', async () => {
    const api = vi.fn().mockResolvedValueOnce({
      id: 'event-314',
      etag: 'event-v8',
      status: 'confirmed',
      summary: 'Berlin spa',
      description: 'Booking reference R-3144',
      attendees: [],
    });
    const entry = toolsWith(api).get('calendar.cancel_booking_event');
    const context = {
      bookingOccurrence: {
        agentId: 'agent-1',
        bookingKey: 'booking-314',
        version: 2,
        operation: 'cancel_existing',
        calendarEventId: 'event-314',
        bookingIdentity: 'R-314',
      },
      assertBookingOccurrenceCurrent: vi.fn().mockResolvedValue(true),
    };
    await expect(
      entry?.tool.execute({ eventId: 'event-314', ownerOnly: true }, context as never),
    ).rejects.toThrow(/no longer matches/i);
    expect(api).toHaveBeenCalledTimes(1);

    const matchingApi = vi.fn().mockResolvedValueOnce({
      id: 'event-314',
      etag: 'event-v7',
      status: 'confirmed',
      summary: 'Berlin spa',
      description: 'Booking reference R-314',
      attendees: [],
    });
    const race = {
      ...context,
      assertBookingOccurrenceCurrent: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    };
    await expect(
      toolsWith(matchingApi)
        .get('calendar.cancel_booking_event')
        ?.tool.execute({ eventId: 'event-314', ownerOnly: true }, race as never),
    ).rejects.toThrow(/booking changed/i);
    expect(matchingApi).toHaveBeenCalledTimes(1);
  });
});

describe('calendar.respond_to_event', () => {
  const invitation = {
    etag: 'invite-version-1',
    summary: 'Design review',
    htmlLink: 'https://calendar.google.com/evt-9',
    organizer: { email: 'organizer@acme.example' },
    attendees: [
      { email: 'organizer@acme.example', responseStatus: 'accepted', organizer: true },
      {
        email: 'bot@example.com',
        responseStatus: 'needsAction',
        self: true,
        displayName: 'Assistant',
        optional: true,
      },
      { email: 'someone@acme.example', responseStatus: 'tentative', displayName: 'Someone' },
    ],
  };

  it('always needs approval — an RSVP reaches the organizer', () => {
    const entry = toolsWith(vi.fn()).get('calendar.respond_to_event');
    expect(riskOf(entry, { eventId: 'evt-9', response: 'declined' })).toBe('approval');
    expect(riskOf(entry, { eventId: 'evt-9', response: 'accepted' })).toBe('approval');
    expect(entry?.flags.outwardFacing).toBe(true);
    expect(entry?.tool.acceptsUntrustedInput).toBe(false);
    // There is no owner-only tier to launder a decline through.
    expect(
      ownerVisibleOnlyFor(entry?.flags ?? {}, { eventId: 'evt-9', response: 'declined' }),
    ).toBe(false);
  });

  it('names the event and the answer on the approval card', () => {
    const entry = toolsWith(vi.fn()).get('calendar.respond_to_event');
    const summary = entry?.tool.approvalSummary?.({
      eventId: 'evt-9',
      response: 'declined',
      calendarId: 'primary',
      comment: 'clashes with the offsite',
    } as never);
    expect(summary).toContain('Decline');
    expect(summary).toContain('evt-9');
    expect(summary).toContain('clashes with the offsite');
  });

  it('sets only its own response and writes every other guest back untouched', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce(invitation)
      .mockResolvedValueOnce({ id: 'evt-9', htmlLink: 'https://calendar.google.com/evt-9' });

    const result = await toolsWith(api)
      .get('calendar.respond_to_event')
      ?.tool.execute(
        { eventId: 'evt-9', response: 'accepted', calendarId: 'primary', comment: '' },
        {} as never,
      );

    const [, init] = api.mock.calls[1] as [string, { body: string }];
    const sent = JSON.parse(init.body) as { attendees: Array<Record<string, unknown>> };
    // Calendar replaces the array wholesale, so fields this code does not model
    // must survive the round trip rather than being rebuilt out of existence.
    expect(sent.attendees).toEqual([
      { email: 'organizer@acme.example', responseStatus: 'accepted', organizer: true },
      {
        email: 'bot@example.com',
        responseStatus: 'accepted',
        self: true,
        displayName: 'Assistant',
        optional: true,
      },
      { email: 'someone@acme.example', responseStatus: 'tentative', displayName: 'Someone' },
    ]);
    expect(result).toMatchObject({
      response: 'accepted',
      responded: true,
      summary: 'Design review',
    });
  });

  it('tells the organizer, and addresses the calendar it was given', async () => {
    const api = vi.fn().mockResolvedValueOnce(invitation).mockResolvedValueOnce({ id: 'evt-9' });
    await toolsWith(api)
      .get('calendar.respond_to_event')
      ?.tool.execute(
        { eventId: 'evt-9', response: 'declined', calendarId: 'work@example.com', comment: '' },
        {} as never,
      );
    const [url] = api.mock.calls[1] as [string];
    expect(url).toContain('sendUpdates=all');
    expect(calendarIdIn(url)).toBe('work@example.com');
  });

  it('carries a comment onto its own guest row only', async () => {
    const api = vi.fn().mockResolvedValueOnce(invitation).mockResolvedValueOnce({ id: 'evt-9' });
    await toolsWith(api)
      .get('calendar.respond_to_event')
      ?.tool.execute(
        {
          eventId: 'evt-9',
          response: 'tentative',
          calendarId: 'primary',
          comment: 'may be ten minutes late',
        },
        {} as never,
      );
    const [, init] = api.mock.calls[1] as [string, { body: string }];
    const sent = JSON.parse(init.body) as { attendees: Array<Record<string, unknown>> };
    expect(sent.attendees[1]).toMatchObject({
      responseStatus: 'tentative',
      comment: 'may be ten minutes late',
    });
    expect(sent.attendees[0]?.comment).toBeUndefined();
    expect(sent.attendees[2]?.comment).toBeUndefined();
  });

  it('answers as the owner when the guest row is theirs rather than the assistant’s', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({
        etag: 'invite-version-owner',
        attendees: [
          { email: 'organizer@acme.example', responseStatus: 'accepted' },
          { email: 'Owner@Example.com', responseStatus: 'needsAction' },
        ],
      })
      .mockResolvedValueOnce({ id: 'evt-9' });
    await toolsWith(api)
      .get('calendar.respond_to_event')
      ?.tool.execute(
        { eventId: 'evt-9', response: 'declined', calendarId: 'owner@example.com', comment: '' },
        {} as never,
      );
    const [, init] = api.mock.calls[1] as [string, { body: string }];
    const sent = JSON.parse(init.body) as { attendees: Array<Record<string, unknown>> };
    expect(sent.attendees[1]?.responseStatus).toBe('declined');
    expect(sent.attendees[0]?.responseStatus).toBe('accepted');
  });

  it('ignores a foreign self row on a writable shared calendar and refuses ambiguous identities', async () => {
    const foreignSelf = {
      etag: 'foreign-copy',
      attendees: [
        { email: 'calendar-owner@example.com', self: true, responseStatus: 'needsAction' },
        { email: 'BOT@example.com', responseStatus: 'needsAction' },
      ],
    };
    const api = vi.fn().mockResolvedValueOnce(foreignSelf).mockResolvedValueOnce({ id: 'evt-9' });
    await toolsWith(api)
      .get('calendar.respond_to_event')
      ?.tool.execute(
        { eventId: 'evt-9', response: 'accepted', calendarId: 'work@example.com', comment: '' },
        {} as never,
      );
    const sent = JSON.parse(String(api.mock.calls[1]?.[1]?.body)) as {
      attendees: Array<Record<string, unknown>>;
    };
    expect(sent.attendees[0]?.responseStatus).toBe('needsAction');
    expect(sent.attendees[1]?.responseStatus).toBe('accepted');
    expect(api.mock.calls[1]?.[1]?.headers).toEqual({ 'If-Match': 'foreign-copy' });

    const ambiguous = vi.fn().mockResolvedValueOnce({
      etag: 'ambiguous-copy',
      attendees: [
        { email: 'bot@example.com', responseStatus: 'needsAction' },
        { email: 'owner@example.com', responseStatus: 'needsAction' },
        { email: 'calendar-owner@example.com', self: true, responseStatus: 'needsAction' },
      ],
    });
    await expect(
      toolsWith(ambiguous)
        .get('calendar.respond_to_event')
        ?.tool.execute(
          { eventId: 'evt-9', response: 'accepted', calendarId: 'work@example.com', comment: '' },
          {} as never,
        ),
    ).rejects.toThrow(/guest list/i);
    expect(ambiguous).toHaveBeenCalledTimes(1);
  });

  it('refuses when no guest row is ours instead of adding one', async () => {
    // Replying to an invitation and putting yourself on someone else's guest
    // list are different acts, and only the first one was approved.
    const api = vi.fn().mockResolvedValueOnce({
      attendees: [{ email: 'organizer@acme.example', responseStatus: 'accepted' }],
    });
    await expect(
      toolsWith(api)
        .get('calendar.respond_to_event')
        ?.tool.execute(
          { eventId: 'evt-9', response: 'accepted', calendarId: 'primary', comment: '' },
          {} as never,
        ),
    ).rejects.toThrow(/guest list/i);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('points at the right tool when the event has no attendees at all', async () => {
    const api = vi.fn().mockResolvedValueOnce({ summary: 'Dentist' });
    await expect(
      toolsWith(api)
        .get('calendar.respond_to_event')
        ?.tool.execute(
          { eventId: 'evt-9', response: 'declined', calendarId: 'primary', comment: '' },
          {} as never,
        ),
    ).rejects.toThrow(/no invitation to answer/i);
    expect(api).toHaveBeenCalledTimes(1);
  });
});
