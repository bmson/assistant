import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ authed: true, ports: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: async () => state.authed,
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
}));
vi.mock('@/lib/server', () => ({ getPhoneCalendarPorts: state.ports }));

import { DELETE, PUT } from './route';

describe('calendar bridge rejects generation-free mutations', () => {
  beforeEach(() => {
    state.authed = true;
    state.ports.mockReset();
  });
  it.each([PUT, DELETE])('authenticates before disclosing protocol support', async (handler) => {
    state.authed = false;
    expect((await handler(new Request('https://assistant.test'))).status).toBe(401);
    expect(state.ports).not.toHaveBeenCalled();
  });
  it.each([PUT, DELETE])(
    'never mutates storage for legacy, delayed, or new publisher payloads',
    async (handler) => {
      for (const body of [
        {
          timeMin: '2026-10-01T00:00:00Z',
          timeMax: '2026-11-01T00:00:00Z',
          calendars: [],
          events: [],
          timeZone: 'UTC',
        },
        { ownerId: 'owner', publisherId: 'replaced-phone', generation: 1, snapshot: {} },
        { ownerId: 'owner', publisherId: 'current-phone', generation: 9 },
        null,
      ]) {
        const response = await handler(
          new Request('https://assistant.test', { method: 'PUT', body: JSON.stringify(body) }),
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'calendar_sharing_protocol_required' });
      }
      expect(state.ports).not.toHaveBeenCalled();
    },
  );
});
