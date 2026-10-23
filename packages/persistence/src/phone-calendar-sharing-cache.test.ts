import { describe, expect, it } from 'vitest';
import {
  parsePhoneCalendarSnapshotCache,
  phoneCalendarCacheRecord,
  transitionPhoneCalendarSharing,
} from './phone-calendar-sharing.js';
import { type PhoneCalendarSnapshotInput, readPhoneCalendars } from './phone-calendars.js';

const now = new Date('2026-10-22T18:00:00Z');
const calendars = [{ id: 'work', name: 'Work', purpose: 'unspecified' as const, timeZone: 'UTC' }];
const enabled = () =>
  transitionPhoneCalendarSharing(
    'owner',
    null,
    {
      command: 'enable',
      publisherId: 'phone-a',
      expectedGeneration: 0,
      mutationId: 'enable-a',
      consentVersion: 1,
      calendars,
    },
    now,
  ).result.state;
describe('shared phone calendar manifest coverage', () => {
  it('rejects cached snapshots whose source-availability rows are duplicated or conflict with the selected roster', () => {
    const input: PhoneCalendarSnapshotInput = {
      timeMin: '2026-10-15T07:00:00.000Z',
      timeMax: '2026-12-07T00:00:00.000Z',
      timeZone: 'UTC',
      capturedAt: now.toISOString(),
      selectionRevision: 1,
      complete: true,
      truncated: false,
      sourceAvailability: [{ calendarId: 'work', status: 'available', complete: true }],
      calendars,
      events: [],
    };
    const state = transitionPhoneCalendarSharing(
      'owner',
      enabled(),
      { command: 'snapshot', publisherId: 'phone-a', expectedGeneration: 1, snapshot: input },
      now,
    ).result.state;
    const record = phoneCalendarCacheRecord('owner', input, now);
    expect(
      parsePhoneCalendarSnapshotCache(state, record.result, record.expiresAt, now),
    ).not.toBeNull();
    expect(
      parsePhoneCalendarSnapshotCache(
        state,
        {
          ...(record.result as Record<string, unknown>),
          calendars: [
            { id: 'work', name: 'Work', purpose: 'unspecified', timeZone: 'America/Los_Angeles' },
          ],
        },
        record.expiresAt,
        now,
      ),
    ).toBeNull();
    expect(
      parsePhoneCalendarSnapshotCache(
        state,
        {
          ...(record.result as Record<string, unknown>),
          sourceAvailability: [
            { calendarId: 'work', status: 'missing', complete: false },
            { calendarId: 'work', status: 'available', complete: true },
          ],
        },
        record.expiresAt,
        now,
      ),
    ).toBeNull();
  });

  it('rejects a cached calendar roster that repeats one selected source and omits another', () => {
    const workCalendar = calendars[0];
    if (!workCalendar) throw new Error('missing work calendar fixture');
    const family = { id: 'family', name: 'Family', purpose: 'reference' as const };
    const selected = [workCalendar, family];
    const state = transitionPhoneCalendarSharing(
      'owner',
      null,
      {
        command: 'enable',
        publisherId: 'phone-a',
        expectedGeneration: 0,
        mutationId: 'enable-two-calendars',
        consentVersion: 1,
        calendars: selected,
      },
      now,
    ).result.state;
    const input: PhoneCalendarSnapshotInput = {
      timeMin: '2026-10-15T07:00:00.000Z',
      timeMax: '2026-12-07T00:00:00.000Z',
      timeZone: 'UTC',
      capturedAt: now.toISOString(),
      selectionRevision: 1,
      complete: true,
      truncated: false,
      sourceAvailability: selected.map((calendar) => ({
        calendarId: calendar.id,
        status: 'available',
        complete: true,
      })),
      calendars: selected,
      events: [],
    };
    const transition = transitionPhoneCalendarSharing(
      'owner',
      state,
      { command: 'snapshot', publisherId: 'phone-a', expectedGeneration: 1, snapshot: input },
      now,
    );
    expect(transition.result.ok).toBe(true);
    const record = phoneCalendarCacheRecord('owner', input, now);
    expect(
      parsePhoneCalendarSnapshotCache(
        transition.result.state,
        {
          ...(record.result as Record<string, unknown>),
          calendars: [workCalendar, workCalendar],
        },
        record.expiresAt,
        now,
      ),
    ).toBeNull();
  });

  it('keeps a known selected source visible as missing after its event cache expires', async () => {
    const state = enabled();
    const result = await readPhoneCalendars(
      {
        cacheGet: async () => null,
        cachePut: async () => {},
        phoneCalendarSharing: {
          get: async () => state,
          readSnapshot: async () => ({ state, snapshot: null }),
          apply: async () => {
            throw new Error('unexpected mutation');
          },
        },
      },
      'owner',
      now,
    );
    expect(result).toMatchObject({
      events: [],
      calendars,
      complete: false,
      selectionRevision: 1,
      sourceAvailability: [{ calendarId: 'work', status: 'missing', complete: false }],
    });
  });

  it('fails closed instead of combining a sharing manifest with a separate cache read', async () => {
    const state = enabled();
    let cacheRead = false;
    const result = await readPhoneCalendars(
      {
        cacheGet: async () => {
          cacheRead = true;
          return { result: { calendars, events: [] } };
        },
        cachePut: async () => {},
        phoneCalendarSharing: {
          get: async () => state,
          apply: async () => {
            throw new Error('unexpected mutation');
          },
        },
      },
      'owner',
      now,
    );
    expect(result).toBeNull();
    expect(cacheRead).toBe(false);
  });
});
