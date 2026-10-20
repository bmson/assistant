import { type PhoneCalendarCache, readPhoneCalendars } from '@assistant/persistence';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ authed: true, cache: undefined as unknown, ports: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: async () => state.authed,
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
}));
vi.mock('@/lib/server', () => ({ getPhoneCalendarPorts: state.ports }));

import { DELETE, PUT } from './route';

const input = {
  timeMin: '2026-10-01T00:00:00Z',
  timeMax: '2027-01-01T00:00:00Z',
  timeZone: 'UTC',
  calendars: [{ id: 'work', name: 'Work' }],
  events: [
    {
      eventId: 'event',
      calendarId: 'work',
      summary: 'Review',
      location: '',
      start: '2026-10-19T09:00:00Z',
      end: '2026-10-19T10:00:00Z',
      allDay: false,
      blocksTime: true,
    },
  ],
};
const request = (body: unknown) =>
  new Request('https://assistant.test/api/mobile/v1/calendars', {
    method: 'PUT',
    body: JSON.stringify(body),
  });

describe('mobile calendar snapshot admission', () => {
  let cache: PhoneCalendarCache;
  beforeEach(() => {
    state.authed = true;
    const rows = new Map<string, unknown>();
    cache = {
      async cacheGet(key) {
        return rows.has(key) ? { result: rows.get(key) } : null;
      },
      async cachePut(row) {
        rows.set(row.cacheKey, row.result);
      },
    };
    state.ports.mockReset().mockResolvedValue({ cache, agentId: 'authenticated-owner' });
  });
  it('admits a scoped snapshot and removes it on disconnect', async () => {
    expect((await PUT(request(input))).status).toBe(200);
    expect((await readPhoneCalendars(cache, 'authenticated-owner'))?.events).toHaveLength(1);
    expect(await readPhoneCalendars(cache, 'another-owner')).toBeNull();
    expect((await DELETE(new Request('https://assistant.test', { method: 'DELETE' }))).status).toBe(
      200,
    );
    expect(await readPhoneCalendars(cache, 'authenticated-owner')).toBeNull();
  });
  it('rejects unauthenticated reads before reaching private storage', async () => {
    state.authed = false;
    expect((await PUT(request(input))).status).toBe(401);
    expect((await DELETE(request(null))).status).toBe(401);
    expect(state.ports).not.toHaveBeenCalled();
  });
  it('rejects events outside the selected roster and malformed times', async () => {
    expect(
      (await PUT(request({ ...input, events: [{ ...input.events[0], calendarId: 'unselected' }] })))
        .status,
    ).toBe(400);
    expect(
      (
        await PUT(
          request({ ...input, events: [{ ...input.events[0], end: input.events[0]?.start }] }),
        )
      ).status,
    ).toBe(400);
    expect((await PUT(request({ ...input, agentId: 'other' }))).status).toBe(400);
    expect(state.ports).not.toHaveBeenCalled();
  });
  it('bounds uploads before reading private storage', async () => {
    expect((await PUT(request({ padding: 'x'.repeat(800_001) }))).status).toBe(413);
    expect(state.ports).not.toHaveBeenCalled();
  });
});
