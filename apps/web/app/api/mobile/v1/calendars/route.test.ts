import {
  type PhoneCalendarCache,
  type PhoneCalendarSharingRepository,
  type PhoneCalendarSharingState,
  parsePhoneCalendarSnapshotCache,
  phoneCalendarCacheRecord,
  readPhoneCalendars,
  transitionPhoneCalendarSharing,
} from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ authed: true, ports: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: async () => fixture.authed,
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
}));
vi.mock('@/lib/server', () => ({ getPhoneCalendarPorts: fixture.ports }));

import { DELETE, GET, POST, PUT } from './route';

const now = new Date('2026-10-22T18:00:00Z');
const calendars = [{ id: 'work', name: 'Work', purpose: 'unspecified', timeZone: 'UTC' }];
const consent = {
  ownerId: 'owner-a',
  command: 'enable',
  publisherId: 'phone-a',
  expectedGeneration: 0,
  mutationId: 'first-enable',
  consentVersion: 1,
  calendars,
};
const snapshot = {
  timeMin: '2026-10-15T00:00:00Z',
  timeMax: '2026-12-07T00:00:00Z',
  timeZone: 'UTC',
  capturedAt: now.toISOString(),
  selectionRevision: 1,
  complete: true,
  truncated: false,
  sourceAvailability: [{ calendarId: 'work', status: 'available', complete: true }],
  calendars,
  events: [
    {
      eventId: 'event-a',
      calendarId: 'work',
      summary: 'Review',
      location: '',
      start: '2026-10-23T09:00:00Z',
      end: '2026-10-23T10:00:00Z',
      allDay: false,
      blocksTime: true,
    },
  ],
};
const request = (method: string, body?: unknown) =>
  new Request('https://assistant.test/api/mobile/v1/calendars', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
describe('mobile selected-calendar sharing protocol', () => {
  let cache: PhoneCalendarCache;
  let sharing: PhoneCalendarSharingState | null;
  let applies = vi.fn<PhoneCalendarSharingRepository['apply']>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    fixture.authed = true;
    sharing = null;
    const rows = new Map<string, { result: unknown; expiresAt: Date }>();
    applies = vi.fn<PhoneCalendarSharingRepository['apply']>(async (ownerId, command) => {
      const changed = transitionPhoneCalendarSharing(ownerId, sharing, command, now);
      if (changed.result.ok) {
        sharing = changed.result.state;
        if (changed.snapshot !== undefined) {
          const record = phoneCalendarCacheRecord(ownerId, changed.snapshot, now);
          rows.set(record.cacheKey, { result: record.result, expiresAt: record.expiresAt });
        }
      }
      return changed.result;
    });
    cache = {
      cacheGet: async (key) => rows.get(key) ?? null,
      cachePut: async (row) => {
        rows.set(row.cacheKey, { result: row.result, expiresAt: row.expiresAt });
      },
      phoneCalendarSharing: {
        get: async (ownerId) => (ownerId === 'owner-a' ? sharing : null),
        readSnapshot: async (ownerId, at = now) => {
          const state = ownerId === 'owner-a' ? sharing : null;
          const cached = rows.get(`phone-calendars:v1:${ownerId}`);
          return {
            state,
            snapshot: state
              ? parsePhoneCalendarSnapshotCache(state, cached?.result, cached?.expiresAt, at)
              : null,
          };
        },
        apply: applies,
      },
    };
    fixture.ports.mockReset().mockResolvedValue({
      agentId: 'owner-a',
      ownerEmail: 'human@example.test',
      timeZone: 'UTC',
      cache,
    });
  });
  afterEach(() => vi.useRealTimers());
  it('reports the authenticated human owner and sharing state without exposing event payloads', async () => {
    expect(await (await GET(request('GET'))).json()).toEqual({
      ownerId: 'owner-a',
      ownerEmail: 'human@example.test',
      timeZone: 'UTC',
      state: null,
    });
  });
  it('requires explicit consent before snapshots and removes cached events on acknowledged revoke', async () => {
    const body = { ownerId: 'owner-a', publisherId: 'phone-a', generation: 1, snapshot };
    expect((await PUT(request('PUT', body))).status).toBe(409);
    expect((await POST(request('POST', consent))).status).toBe(200);
    expect((await PUT(request('PUT', body))).status).toBe(200);
    expect((await readPhoneCalendars(cache, 'owner-a', now))?.events).toHaveLength(1);
    expect(
      (
        await DELETE(
          request('DELETE', { ownerId: 'owner-a', publisherId: 'phone-a', generation: 1 }),
        )
      ).status,
    ).toBe(200);
    expect(await readPhoneCalendars(cache, 'owner-a', now)).toBeNull();
    expect((await PUT(request('PUT', body))).status).toBe(409);
  });
  it('cancels an initial request that arrives after local stop', async () => {
    expect(
      (
        await DELETE(
          request('DELETE', {
            ownerId: 'owner-a',
            publisherId: 'phone-a',
            generation: 0,
            cancelPendingMutationId: 'first-enable',
          }),
        )
      ).status,
    ).toBe(200);
    expect((await POST(request('POST', consent))).status).toBe(409);
  });
  it('rejects legacy snapshots that cannot establish selected-calendar sharing consent', async () => {
    expect((await PUT(request('PUT', snapshot))).status).toBe(400);
    expect(applies).not.toHaveBeenCalled();
  });
  it('rejects generation-free legacy deletion before storage access', async () => {
    expect((await DELETE(request('DELETE', {}))).status).toBe(400);
    expect(fixture.ports).not.toHaveBeenCalled();
    expect(applies).not.toHaveBeenCalled();
  });
  it.each(['', 'Mars/Olympus'])(
    'rejects an invalid selected calendar time zone (%s)',
    async (zone) => {
      const response = await POST(
        request('POST', {
          ...consent,
          calendars: [{ ...calendars[0], timeZone: zone }],
        }),
      );
      expect(response.status).toBe(400);
      expect(applies).not.toHaveBeenCalled();
    },
  );
  it.each(['POST', 'PUT', 'DELETE'])(
    'rejects a wrong-workspace %s before mutation',
    async (method) => {
      const body =
        method === 'POST'
          ? { ...consent, ownerId: 'other-owner' }
          : method === 'PUT'
            ? { ownerId: 'other-owner', publisherId: 'phone-a', generation: 1, snapshot }
            : { ownerId: 'other-owner', publisherId: 'phone-a', generation: 1 };
      const handler = method === 'POST' ? POST : method === 'PUT' ? PUT : DELETE;
      expect((await handler(request(method, body))).status).toBe(403);
      expect(applies).not.toHaveBeenCalled();
    },
  );
  it('returns publisher conflict until the owner explicitly replaces the current publishing iPhone', async () => {
    await POST(request('POST', consent));
    const second = {
      ...consent,
      publisherId: 'phone-b',
      expectedGeneration: 1,
      mutationId: 'replace-b',
    };
    expect((await POST(request('POST', second))).status).toBe(409);
    expect((await POST(request('POST', { ...second, command: 'replace' }))).status).toBe(200);
    expect(
      (
        await DELETE(
          request('DELETE', { ownerId: 'owner-a', publisherId: 'phone-a', generation: 1 }),
        )
      ).status,
    ).toBe(409);
  });
  it('rejects a snapshot whose selected roster, source membership or timezone is invalid', async () => {
    await POST(request('POST', consent));
    const body = { ownerId: 'owner-a', publisherId: 'phone-a', generation: 1, snapshot };
    expect(
      (
        await PUT(
          request('PUT', {
            ...body,
            snapshot: {
              ...snapshot,
              events: [{ ...snapshot.events[0], calendarId: 'unselected' }],
            },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await PUT(
          request('PUT', { ...body, snapshot: { ...snapshot, timeZone: 'America/Los_Angeles' } }),
        )
      ).status,
    ).toBe(400);
  });
  it.each(['GET', 'POST', 'PUT', 'DELETE'])(
    'rejects unauthenticated %s before storage access',
    async (method) => {
      fixture.authed = false;
      const handler = { GET, POST, PUT, DELETE }[method as 'GET'];
      expect((await handler(request(method, method === 'GET' ? undefined : consent))).status).toBe(
        401,
      );
      expect(fixture.ports).not.toHaveBeenCalled();
    },
  );
  it('bounds the whole request before private storage access', async () => {
    expect((await PUT(request('PUT', { padding: 'x'.repeat(800_001) }))).status).toBe(413);
    expect(fixture.ports).not.toHaveBeenCalled();
  });
});
