import { expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { registerCalendarReadTools } from './calendar.js';
import type { GoogleClient } from './client.js';

it.each(['Asia/Tokyo', undefined])(
  'preserves source all-day dates and available calendar zone (%s)',
  async (timeZone) => {
    const api = vi.fn(async (url: string) =>
      url.includes('/calendarList')
        ? { items: [{ id: 'shared', summary: 'Shared', timeZone }] }
        : {
            items: [
              {
                id: 'payday',
                summary: 'Payday',
                start: { date: '2026-10-16' },
                end: { date: '2026-10-17' },
              },
            ],
          },
    );
    const registry = new ToolRegistry();
    registerCalendarReadTools(registry, {
      client: { api } as unknown as GoogleClient,
      botEmail: 'bot@example.test',
      ownerEmail: 'owner@example.test',
    });
    const result = (await registry
      .get('calendar.list_events')
      ?.tool.execute(
        { timeMin: '2026-10-15T07:00:00Z', timeMax: '2026-10-16T07:00:00Z', maxResults: 50 },
        {} as never,
      )) as { events: Record<string, unknown>[]; calendarsResolved: Record<string, unknown>[] };
    expect(result.events[0]).toMatchObject({
      start: '2026-10-16',
      end: '2026-10-17',
      allDay: true,
    });
    expect(result.events[0]?.calendarTimeZone).toBe(timeZone);
    expect(result.calendarsResolved[0]?.timeZone).toBe(timeZone);
    if (!timeZone) expect(result.events[0]).not.toHaveProperty('calendarTimeZone');
  },
);
