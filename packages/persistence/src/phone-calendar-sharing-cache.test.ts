import { describe, expect, it } from 'vitest';
import { transitionPhoneCalendarSharing } from './phone-calendar-sharing.js';
import { readPhoneCalendars } from './phone-calendars.js';

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
