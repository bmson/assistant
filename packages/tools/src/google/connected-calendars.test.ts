import type { CalendarAccount, CalendarAccountRepository } from '@assistant/persistence';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { listEventsInWindow, readCalendarEvent, registerCalendarTools } from './calendar.js';
import { GoogleClient } from './client.js';
import { ConnectedCalendarClient } from './connected-calendars.js';

const CAL = 'https://www.googleapis.com/calendar/v3';
const credentials = { clientId: 'client', clientSecret: 'secret' };
const workID = 'work@example.test';
const event = {
  id: 'meeting',
  summary: 'Work planning',
  start: { dateTime: '2026-10-19T10:00:00Z' },
  end: { dateTime: '2026-10-19T11:00:00Z' },
  status: 'confirmed',
};

describe('connected calendar reads', () => {
  let accounts: CalendarAccount[];
  let repository: CalendarAccountRepository;
  let bot: GoogleClient;
  let work: GoogleClient;
  let client: ConnectedCalendarClient;
  let botAPI: ReturnType<typeof vi.fn>;
  let workAPI: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    accounts = [
      {
        id: 'work-subject',
        email: workID,
        clientId: 'client',
        refreshTokenEncrypted: 'sealed',
        scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        lastError: null,
        updatedAt: new Date(),
      },
    ];
    repository = {
      list: async () => accounts,
      recordError: vi.fn(async () => {}),
    } as unknown as CalendarAccountRepository;
    bot = new GoogleClient({ ...credentials, refreshToken: 'bot-refresh' });
    work = new GoogleClient({ ...credentials, refreshToken: 'work-refresh' });
    botAPI = vi.fn(async (url: string) =>
      url.includes('/calendarList')
        ? {
            items: [
              { id: 'bot@example.test', summary: 'Bot', primary: true },
              { id: workID, summary: 'Work', accessRole: 'reader' },
            ],
          }
        : { items: [] },
    );
    workAPI = vi.fn(async (url: string) =>
      url.includes('/calendarList')
        ? {
            items: [
              { id: workID, summary: 'Work', primary: true, accessRole: 'owner', timeZone: 'UTC' },
            ],
          }
        : url.includes('/freeBusy')
          ? {
              calendars: {
                [workID]: { busy: [{ start: event.start.dateTime, end: event.end.dateTime }] },
              },
            }
          : url.includes('/events/')
            ? event
            : { items: [event] },
    );
    bot.api = botAPI as typeof bot.api;
    work.api = workAPI as typeof work.api;
    client = new ConnectedCalendarClient(
      bot,
      credentials,
      repository,
      () => 'work-refresh',
      () => work,
    );
  });

  it('prefers the direct work grant over the shared busy-only copy and avoids duplicate calendars', async () => {
    const result = await listEventsInWindow(client, {
      timeMin: new Date('2026-10-19T00:00:00Z'),
      timeMax: new Date('2026-10-20T00:00:00Z'),
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      summary: 'Work planning',
      calendarId: workID,
      connectedAccount: workID,
    });
    expect(result.complete).toBe(true);
    expect(result.calendarsResolved.filter((calendar) => calendar.id === workID)).toHaveLength(1);
    expect(
      botAPI.mock.calls.some(([url]) =>
        String(url).includes(`/calendars/${encodeURIComponent(workID)}/events`),
      ),
    ).toBe(false);
    expect(
      workAPI.mock.calls.some(([url]) =>
        String(url).includes(`/calendars/${encodeURIComponent(workID)}/events`),
      ),
    ).toBe(true);
  });

  it('routes briefing point reads and free/busy through the matching account', async () => {
    expect(
      await readCalendarEvent(client, { calendarId: workID, eventId: 'meeting' }),
    ).toMatchObject({ summary: 'Work planning' });
    const result = await client.api<{ calendars: Record<string, { busy: unknown[] }> }>(
      `${CAL}/freeBusy`,
      { method: 'POST', body: JSON.stringify({ items: [{ id: workID }] }) },
    );
    expect(result.calendars[workID]?.busy).toHaveLength(1);
    expect(workAPI).toHaveBeenCalledWith(
      expect.stringContaining('/freeBusy'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps account failures visible in coverage without discarding the bot calendar', async () => {
    workAPI.mockRejectedValue(new Error('invalid_grant sensitive-provider-body'));
    botAPI.mockImplementation(async (url: string) =>
      url.includes('/calendarList')
        ? { items: [{ id: 'bot@example.test', summary: 'Bot', primary: true }] }
        : { items: [event] },
    );
    const result = await listEventsInWindow(client, {
      timeMin: new Date('2026-10-19T00:00:00Z'),
      timeMax: new Date('2026-10-20T00:00:00Z'),
    });
    expect(result.complete).toBe(false);
    expect(result.events[0]?.summary).toBe('Work planning');
    expect(result.chronologicalPrefixThrough).toBeUndefined();
    expect(result.unavailable.some((item) => item.reason.includes(workID))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sensitive-provider-body');
    expect(repository.recordError).toHaveBeenCalledWith(
      'work-subject',
      'sealed',
      expect.stringContaining('Reconnect'),
    );
  });

  it('isolates accounts that need new consent after changing the client ID', async () => {
    const account = accounts[0];
    if (!account) throw new Error('Missing work fixture');
    account.clientId = 'previous-client';
    const result = await client.api<{ accountErrors: string[]; items: unknown[] }>(
      `${CAL}/users/me/calendarList`,
    );
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.accountErrors[0]).toContain('Reconnect');
    expect(workAPI).not.toHaveBeenCalled();
  });

  it('walks each account roster page independently and rejects cursors after disconnect', async () => {
    workAPI.mockImplementation(async (url: string) =>
      new URL(url).searchParams.has('pageToken')
        ? { items: [{ id: 'team@example.test', summary: 'Team' }] }
        : { items: [{ id: workID, summary: 'Work', primary: true }], nextPageToken: 'work-page-2' },
    );
    const first = await client.api<{ nextPageToken: string }>(`${CAL}/users/me/calendarList`);
    const second = await client.api<{ items: Array<{ id: string }> }>(
      `${CAL}/users/me/calendarList?pageToken=${encodeURIComponent(first.nextPageToken)}`,
    );
    expect(second.items.map((item) => item.id)).toEqual(['team@example.test']);
    expect(botAPI).toHaveBeenCalledTimes(1);
    const cursor = client.signOpaqueToken('private-buffered-events');
    accounts = [];
    await client.api(`${CAL}/users/me/calendarList`);
    expect(client.verifyOpaqueToken(cursor)).toBeNull();
    await expect(
      client.api(
        `${CAL}/users/me/calendarList?pageToken=${encodeURIComponent(first.nextPageToken)}`,
      ),
    ).rejects.toThrow();
    workAPI.mockClear();
    await client.api(`${CAL}/calendars/${encodeURIComponent(workID)}/events`);
    expect(workAPI).not.toHaveBeenCalled();
  });

  it('supports a connected calendar without bot credentials', async () => {
    client = new ConnectedCalendarClient(
      new GoogleClient({ clientId: '', clientSecret: '', refreshToken: '' }),
      credentials,
      repository,
      () => 'work-refresh',
      () => work,
    );
    const result = await listEventsInWindow(client, {
      timeMin: new Date('2026-10-19T00:00:00Z'),
      timeMax: new Date('2026-10-20T00:00:00Z'),
    });
    expect(result.events[0]?.summary).toBe('Work planning');
    expect(result.complete).toBe(true);
  });

  it('refuses writes and non-calendar access while keeping existing bot writes separate', async () => {
    await expect(
      client.api(`${CAL}/calendars/${encodeURIComponent(workID)}/events`, { method: 'POST' }),
    ).rejects.toThrow('read-only');
    await expect(
      client.api('https://gmail.googleapis.com/gmail/v1/users/me/messages'),
    ).rejects.toThrow('calendar reads only');
    const registry = new ToolRegistry();
    registerCalendarTools(
      registry,
      { client: bot, botEmail: 'bot@example.test', ownerEmail: 'owner@example.test' },
      { readClient: client },
    );
    await registry.get('calendar.create_event')?.tool.execute(
      {
        summary: 'Private',
        start: '2026-10-19T10:00:00Z',
        end: '2026-10-19T11:00:00Z',
        attendees: [],
      },
      {} as never,
    );
    expect(botAPI).toHaveBeenCalledWith(
      expect.stringContaining('/calendars/primary/events'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(workAPI).not.toHaveBeenCalled();
  });
});
