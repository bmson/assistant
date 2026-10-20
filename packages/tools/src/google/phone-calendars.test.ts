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
      { id: 'work', name: 'Work' },
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
    complete: boolean;
    nextPageToken?: string;
    duplicateOccurrences: unknown[];
    duplicateNote: string;
    note: string;
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
    registerPhoneCalendarFallback(registry, cache, 'private-cursor-secret');
    expect((await run(registry, 'calendar.list_calendars', {})).calendars).toHaveLength(2);
    const listing = await run(registry, 'calendar.list_events', window);
    expect(listing.complete).toBe(true);
    expect(listing.events).toMatchObject([
      { calendarId: 'iphone:work', summary: 'Team planning', iCalUID: 'invitation-123' },
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
});
