import { describe, expect, it, vi } from 'vitest';
import { readCalendarEvent } from './calendar.js';
import type { GoogleClient } from './client.js';

describe('authoritative calendar point read', () => {
  it('uses provider event identity, escapes path segments, and forwards cancellation', async () => {
    const api = vi.fn(async () => ({ id: 'event/instance', status: 'cancelled' }));
    const controller = new AbortController();
    const result = await readCalendarEvent({ api } as unknown as GoogleClient, {
      calendarId: 'owner@example.test',
      eventId: 'event/instance',
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      calendarId: 'owner@example.test',
      eventId: 'event/instance',
      status: 'cancelled',
    });
    expect(api).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/owner%40example.test/events/event%2Finstance',
      { signal: controller.signal },
    );
  });
  it('does not turn inaccessible or absent responses into cancellation', async () => {
    const api = vi.fn(async () => {
      throw new Error('404 can also mean lost read access');
    });
    await expect(
      readCalendarEvent({ api } as unknown as GoogleClient, {
        calendarId: 'work',
        eventId: 'meeting',
      }),
    ).rejects.toThrow('404');
  });
  it('rejects a different event or malformed live times', async () => {
    for (const raw of [
      { id: 'other', status: 'cancelled' },
      { id: 'meeting', status: 'confirmed' },
    ]) {
      await expect(
        readCalendarEvent({ api: async () => raw } as unknown as GoogleClient, {
          calendarId: 'work',
          eventId: 'meeting',
        }),
      ).rejects.toThrow();
    }
  });
});
