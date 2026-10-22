import {
  type PhoneCalendarCache,
  type PhoneCalendarSnapshotInput,
  readPhoneCalendars,
  savePhoneCalendars,
} from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { registerCalendarReadTools, registerPhoneCalendarFallback } from './calendar.js';
import { GoogleClient } from './client.js';

const now = new Date('2026-10-19T12:00:00Z');
const window = { timeMin: '2026-10-19T00:00:00Z', timeMax: '2026-10-20T00:00:00Z' };
function snapshot(): PhoneCalendarSnapshotInput {
  return {
    timeMin: '2026-09-01T00:00:00Z',
    timeMax: '2027-04-01T00:00:00Z',
    timeZone: 'America/Los_Angeles',
    calendars: [
      { id: 'work', name: 'Work', purpose: 'commitments', timeZone: 'America/Los_Angeles' },
      { id: 'personal', name: 'Personal' },
    ],
    events: [
      {
        eventId: 'phone-meeting',
        calendarId: 'work',
        iCalUID: 'invitation-123',
        summary: 'Team planning',
        location: 'Office',
        start: '2026-10-19T09:00:00-07:00',
        end: '2026-10-19T10:00:00-07:00',
        allDay: false,
        blocksTime: true,
        ownerResponse: 'accepted',
        ownerParticipant: { email: 'owner@example.com', responseStatus: 'accepted' },
        providerExternalIdentifier: 'eventkit-external-id',
        calendarTimeZone: 'America/Los_Angeles',
        status: 'confirmed',
      },
    ],
  };
}
function cacheFixture() {
  const rows = new Map<string, { result: unknown; expiresAt: Date }>();
  const cache: PhoneCalendarCache = {
    async cacheGet(key, at = now) {
      const row = rows.get(key);
      return row && row.expiresAt >= at ? row : null;
    },
    async cachePut(input) {
      rows.set(input.cacheKey, input);
    },
  };
  return cache;
}
function run(registry: ToolRegistry, name: string, args: object) {
  const tool = registry.get(name)?.tool;
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.execute(tool.inputSchema.parse(args), { agentId: 'owner' } as never) as Promise<{
    events: Array<Record<string, unknown>>;
    calendars: unknown[];
    busy: Array<Record<string, unknown>>;
    calendarsSearched: string[];
    complete: boolean;
    nextPageToken?: string;
    duplicateOccurrences: unknown[];
    duplicateNote: string;
    note: string;
    unavailable: Array<{ calendar: string; reason: string }>;
    phoneCalendarCoverage?: {
      complete: boolean;
      sources?: Array<{ calendarId: string; status: string; complete: boolean }>;
    };
  }>;
}

describe('iPhone calendar access through normal calendar tools', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads, searches, and checks availability without Google OAuth', async () => {
    const cache = cacheFixture();
    await savePhoneCalendars(cache, 'owner', snapshot(), now);
    const registry = new ToolRegistry();
    registerPhoneCalendarFallback(registry, cache, 'private-cursor-secret', 'owner@example.com');
    expect((await run(registry, 'calendar.list_calendars', {})).calendars).toHaveLength(2);
    const listing = await run(registry, 'calendar.list_events', window);
    expect(listing.complete).toBe(true);
    expect(listing.events).toMatchObject([
      {
        calendarId: 'iphone:work',
        summary: 'Team planning',
        iCalUID: 'invitation-123',
        providerExternalIdentifier: 'eventkit-external-id',
        status: 'confirmed',
        ownerParticipation: {
          status: 'accepted',
          identityVerified: true,
          basis: 'attendee-email',
        },
        calendarPurpose: 'commitments',
      },
    ]);
    expect(
      (await run(registry, 'calendar.search_events', { ...window, query: 'planning' })).events,
    ).toHaveLength(1);
    expect(
      (await run(registry, 'calendar.search_events', { ...window, query: 'missing' })).events,
    ).toHaveLength(0);
    const availability = await run(registry, 'calendar.availability', window);
    expect(availability.complete).toBe(true);
    expect(availability.busy).toMatchObject([
      { calendarId: 'iphone:work', start: '2026-10-19T16:00:00.000Z' },
    ]);
    expect(registry.toolsForTask('unknown').some((tool) => tool.name.startsWith('calendar.'))).toBe(
      false,
    );
    expect(registry.get('calendar.create_event')).toBeUndefined();
  });

  it('merges Google and iPhone copies and identifies their common occurrence', async () => {
    const cache = cacheFixture();
    await savePhoneCalendars(cache, 'owner', snapshot(), now);
    const client = new GoogleClient({
      clientId: 'test',
      clientSecret: 'secret',
      refreshToken: 'refresh',
    });
    vi.spyOn(client, 'api').mockImplementation(async (url) => {
      if (url.includes('calendarList'))
        return {
          items: [{ id: 'google-work', summary: 'Google Work', timeZone: 'America/Los_Angeles' }],
        } as never;
      return {
        items: [
          {
            id: 'google-meeting',
            iCalUID: 'invitation-123',
            summary: 'Team planning',
            start: { dateTime: '2026-10-19T16:00:00Z' },
            end: { dateTime: '2026-10-19T17:00:00Z' },
          },
        ],
      } as never;
    });
    const registry = new ToolRegistry();
    registerCalendarReadTools(registry, {
      client,
      botEmail: 'bot',
      ownerEmail: 'owner',
      phoneCalendars: (id) => readPhoneCalendars(cache, id),
    });
    const result = await run(registry, 'calendar.list_events', window);
    expect(result.complete).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(result.duplicateOccurrences).toHaveLength(1);
    expect(result.duplicateNote).toContain('Do not count it twice');
    const googleOnly = await run(registry, 'calendar.list_events', {
      ...window,
      calendarIds: ['google-work'],
    });
    expect(googleOnly.complete).toBe(true);
    expect(googleOnly.events).toHaveLength(1);
    expect(googleOnly).not.toHaveProperty('phoneCalendarCoverage');
  });

  it('defaults to every shared phone calendar but scopes coverage to an explicit phone selection', async () => {
    const cache = cacheFixture();
    const data = {
      ...snapshot(),
      complete: false,
      truncated: false,
      sourceAvailability: [
        { calendarId: 'work', status: 'available' as const, complete: true },
        {
          calendarId: 'personal',
          status: 'permission-denied' as const,
          complete: false,
          reason: 'Calendar permission was revoked.',
        },
      ],
    };
    await savePhoneCalendars(cache, 'owner', data, now);
    const registry = new ToolRegistry();
    registerPhoneCalendarFallback(registry, cache, 'secret');

    const all = await run(registry, 'calendar.list_events', window);
    expect(all.complete).toBe(false);
    expect(all.unavailable).toContainEqual(
      expect.objectContaining({
        calendar: 'Personal (iPhone)',
        reason: 'Calendar permission was revoked.',
      }),
    );

    const selected = await run(registry, 'calendar.list_events', {
      ...window,
      calendarIds: ['iphone:work'],
    });
    expect(selected.complete).toBe(true);
    expect(selected.phoneCalendarCoverage).toMatchObject({
      complete: true,
      sources: [{ calendarId: 'work', status: 'available', complete: true }],
    });
  });

  it('includes a shared phone calendar in the bounded default fanout beside a large Google roster', async () => {
    const cache = cacheFixture();
    await savePhoneCalendars(cache, 'owner', snapshot(), now);
    const client = new GoogleClient({
      clientId: 'test',
      clientSecret: 'secret',
      refreshToken: 'refresh',
    });
    const roster = Array.from({ length: 50 }, (_, index) => ({
      id: `google-${index}`,
      summary: `Google ${index}`,
      primary: index === 0,
      timeZone: 'America/Los_Angeles',
    }));
    vi.spyOn(client, 'api').mockImplementation(async (url) => {
      if (url.includes('calendarList')) return { items: roster } as never;
      const calendarId = decodeURIComponent(/\/calendars\/([^/]+)\/events/.exec(url)?.[1] ?? '');
      return {
        items:
          calendarId === 'google-0'
            ? [
                {
                  id: 'primary-event',
                  summary: 'Primary event',
                  start: { dateTime: '2026-10-19T16:00:00Z' },
                  end: { dateTime: '2026-10-19T17:00:00Z' },
                },
              ]
            : [],
      } as never;
    });
    const registry = new ToolRegistry();
    registerCalendarReadTools(registry, {
      client,
      botEmail: 'bot',
      ownerEmail: 'owner@example.com',
      phoneCalendars: (id) => readPhoneCalendars(cache, id),
    });

    const generic = await run(registry, 'calendar.list_events', window);
    expect(generic.events.map((event) => event.calendarId)).toEqual(
      expect.arrayContaining(['google-0', 'iphone:work']),
    );
    expect(generic.calendarsSearched).toContain('Work (iPhone)');
    expect(generic.calendarsSearched).toContain('Google 0');
    expect(generic.calendarsSearched).toHaveLength(50);
    expect(generic.complete).toBe(false);
    expect(generic.note).toContain('first 50 of 52 resolved calendars');

    const namedPhone = await run(registry, 'calendar.list_events', {
      ...window,
      calendarIds: ['Work'],
    });
    expect(namedPhone.events.map((event) => event.calendarId)).toEqual(['iphone:work']);
    expect(namedPhone.complete).toBe(true);
  });

  it('surfaces stale phone coverage as an unavailable warning for downstream cards', async () => {
    const cache = cacheFixture();
    await savePhoneCalendars(cache, 'owner', snapshot(), new Date(now.getTime() - 60 * 60_000));
    const registry = new ToolRegistry();
    registerPhoneCalendarFallback(registry, cache, 'secret');

    const result = await run(registry, 'calendar.list_events', window);

    expect(result.complete).toBe(false);
    expect(result.unavailable).toEqual([
      expect.objectContaining({
        calendar: 'iPhone calendars',
        reason: expect.stringContaining('coverage is incomplete'),
      }),
    ]);
  });

  it('preserves all-day phone source dates when the selected calendar zone is unknown', async () => {
    const cache = cacheFixture();
    const data = snapshot();
    data.calendars[0] = { id: 'work', name: 'Work', purpose: 'commitments' };
    const firstEvent = data.events[0];
    if (!firstEvent) throw new Error('Missing fixture event');
    data.events[0] = {
      ...firstEvent,
      start: '2026-10-19',
      end: '2026-10-20',
      allDay: true,
      calendarTimeZone: undefined,
    };
    await savePhoneCalendars(cache, 'owner', data, now);
    const registry = new ToolRegistry();
    registerPhoneCalendarFallback(registry, cache, 'secret');

    const result = await run(registry, 'calendar.list_events', window);
    expect(result.events).toMatchObject([
      { eventId: 'phone-meeting', start: '2026-10-19', end: '2026-10-20', allDay: true },
    ]);
    expect(result.events[0]).not.toHaveProperty('calendarTimeZone');
  });

  it('keeps an event-specific source zone instead of replacing it with the calendar default', async () => {
    const cache = cacheFixture();
    const data = snapshot();
    const first = data.events[0];
    if (!first) throw new Error('Missing fixture event');
    data.events[0] = {
      ...first,
      start: '2026-10-19',
      end: '2026-10-20',
      allDay: true,
      calendarTimeZone: 'Pacific/Honolulu',
    };
    data.events.push({
      ...first,
      eventId: 'timed-honolulu',
      iCalUID: 'timed-honolulu-uid',
      start: '2026-10-19T09:00:00-10:00',
      end: '2026-10-19T10:00:00-10:00',
      allDay: false,
      calendarTimeZone: 'Pacific/Honolulu',
    });
    await savePhoneCalendars(cache, 'owner', data, now);
    const registry = new ToolRegistry();
    registerPhoneCalendarFallback(registry, cache, 'secret', 'owner@example.com');

    const result = await run(registry, 'calendar.list_events', window);
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventId: 'phone-meeting', allDay: true, calendarTimeZone: 'Pacific/Honolulu' }),
        expect.objectContaining({ eventId: 'timed-honolulu', allDay: false, calendarTimeZone: 'Pacific/Honolulu' }),
      ]),
    );
  });

  it('paginates phone events without repeats or loss and binds the cursor to the request', async () => {
    const cache = cacheFixture();
    const data = snapshot();
    const event = data.events[0];
    if (!event) throw new Error('Missing fixture event');
    data.events.push({
      ...event,
      eventId: 'second',
      iCalUID: 'different',
      start: '2026-10-19T18:00:00Z',
      end: '2026-10-19T19:00:00Z',
    });
    await savePhoneCalendars(cache, 'owner', data, now);
    const registry = new ToolRegistry();
    registerPhoneCalendarFallback(registry, cache, 'secret');
    const first = await run(registry, 'calendar.list_events', { ...window, maxResults: 1 });
    expect(first.complete).toBe(false);
    const second = await run(registry, 'calendar.list_events', {
      ...window,
      maxResults: 1,
      pageToken: first.nextPageToken,
    });
    expect(second.complete).toBe(true);
    expect(second.events[0]?.eventId).toBe('second');
    await expect(
      run(registry, 'calendar.list_events', {
        ...window,
        timeMin: '2026-10-19T01:00:00Z',
        maxResults: 1,
        pageToken: first.nextPageToken,
      }),
    ).rejects.toThrow('does not match');
  });

  it('exposes stale and out-of-window coverage and clears removed calendars', async () => {
    const cache = cacheFixture();
    await savePhoneCalendars(cache, 'owner', snapshot(), new Date(now.getTime() - 31 * 60_000));
    const registry = new ToolRegistry();
    registerPhoneCalendarFallback(registry, cache, 'secret');
    const stale = await run(registry, 'calendar.list_events', window);
    expect(stale.complete).toBe(false);
    expect(stale.note).toContain('refresh');
    expect((await run(registry, 'calendar.availability', window)).complete).toBe(false);
    await savePhoneCalendars(cache, 'owner', snapshot(), now);
    expect(
      (
        await run(registry, 'calendar.list_events', {
          timeMin: '2027-05-01T00:00:00Z',
          timeMax: '2027-05-02T00:00:00Z',
        })
      ).complete,
    ).toBe(false);
    await savePhoneCalendars(cache, 'owner', { ...snapshot(), calendars: [], events: [] }, now);
    expect((await run(registry, 'calendar.list_calendars', {})).calendars).toHaveLength(0);
    await savePhoneCalendars(cache, 'owner', null, now);
    expect(await readPhoneCalendars(cache, 'owner')).toBeNull();
    expect(await readPhoneCalendars(cache, 'another-owner')).toBeNull();
  });

  it('retains phone results during Google outages and reports incomplete coverage', async () => {
    const client = new GoogleClient({
      clientId: 'test',
      clientSecret: 'secret',
      refreshToken: 'refresh',
    });
    vi.spyOn(client, 'api').mockRejectedValue(new Error('Google unavailable'));
    const registry = new ToolRegistry();
    registerCalendarReadTools(registry, {
      client,
      botEmail: 'bot',
      ownerEmail: 'owner',
      phoneCalendars: async () => ({ ...snapshot(), syncedAt: now.toISOString() }),
    });
    for (const name of [
      'calendar.list_events',
      'calendar.availability',
      'calendar.list_calendars',
    ]) {
      const result = await run(registry, name, name === 'calendar.list_calendars' ? {} : window);
      expect(result.complete).toBe(false);
      expect(result.events ?? result.busy ?? result.calendars).not.toHaveLength(0);
    }
  });

  it('verifies owner participation from the configured owner email, not provider self flags', async () => {
    const client = new GoogleClient({
      clientId: 'test',
      clientSecret: 'secret',
      refreshToken: 'refresh',
    });
    vi.spyOn(client, 'api').mockImplementation(async (url) => {
      if (url.includes('/users/me/calendarList'))
        return {
          items: [{ id: 'work-calendar', summary: 'Work', timeZone: 'America/Los_Angeles' }],
        } as never;
      return {
        items: [
          {
            id: 'owner-attendee',
            summary: 'Owner attendee',
            start: { dateTime: '2026-10-19T16:00:00Z' },
            end: { dateTime: '2026-10-19T17:00:00Z' },
            attendees: [
              { email: 'other@example.com', self: true, responseStatus: 'accepted' },
              { email: 'OWNER@example.com', self: false, responseStatus: 'tentative' },
            ],
          },
          {
            id: 'owner-organizer',
            summary: 'Owner organizer',
            start: { dateTime: '2026-10-19T18:00:00Z' },
            end: { dateTime: '2026-10-19T19:00:00Z' },
            organizer: { email: 'owner@example.com' },
            attendees: [{ email: 'other@example.com', self: true, responseStatus: 'accepted' }],
          },
          {
            id: 'unverified-self',
            summary: 'Unverified self',
            start: { dateTime: '2026-10-19T20:00:00Z' },
            end: { dateTime: '2026-10-19T21:00:00Z' },
            attendees: [
              { email: 'some-account@example.com', self: true, responseStatus: 'declined' },
            ],
          },
        ],
      } as never;
    });
    const registry = new ToolRegistry();
    registerCalendarReadTools(registry, {
      client,
      botEmail: 'assistant@example.com',
      ownerEmail: 'owner@example.com',
      phoneCalendars: async () => null,
    });
    const result = await run(registry, 'calendar.list_events', window);
    expect(result.events).toMatchObject([
      {
        eventId: 'owner-attendee',
        ownerResponse: 'accepted',
        ownerParticipation: {
          status: 'tentative',
          identityVerified: true,
          basis: 'attendee-email',
        },
      },
      {
        eventId: 'owner-organizer',
        ownerResponse: 'accepted',
        ownerParticipation: {
          status: 'unknown',
          identityVerified: true,
          basis: 'organizer-email',
        },
      },
      {
        eventId: 'unverified-self',
        ownerResponse: 'declined',
        ownerParticipation: {
          status: 'unknown',
          identityVerified: false,
          basis: 'unverified',
        },
      },
    ]);
  });

  it('does not treat legacy ownerResponse or a mismatched participant email as owner proof', async () => {
    const cache = cacheFixture();
    const legacy = snapshot();
    const firstEvent = legacy.events[0];
    if (!firstEvent) throw new Error('Missing fixture event');
    firstEvent.ownerParticipant = {
      email: 'other@example.com',
      responseStatus: 'accepted',
    };
    await savePhoneCalendars(cache, 'owner', legacy, now);
    const registry = new ToolRegistry();
    registerPhoneCalendarFallback(registry, cache, 'private-cursor-secret', 'owner@example.com');
    const result = await run(registry, 'calendar.list_events', window);
    expect(result.events[0]).toMatchObject({
      ownerResponse: 'accepted',
      ownerParticipation: {
        status: 'unknown',
        identityVerified: false,
        basis: 'unverified',
      },
      calendarPurpose: 'commitments',
    });
  });
});
