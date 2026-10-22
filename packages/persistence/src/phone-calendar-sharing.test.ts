import { describe, expect, it } from 'vitest';
import {
  type PhoneCalendarSharingCommand,
  type PhoneCalendarSharingState,
  parsePhoneCalendarSharingState,
  phoneCalendarSharingWindow,
  transitionPhoneCalendarSharing,
} from './phone-calendar-sharing.js';
import {
  type PhoneCalendarSnapshotInput,
  phoneCalendarCoverage,
  readPhoneCalendars,
} from './phone-calendars.js';

const now = new Date('2026-10-22T18:00:00Z');
const calendars = [{ id: 'work', name: 'Work', purpose: 'unspecified' as const, timeZone: 'UTC' }];
const enable: PhoneCalendarSharingCommand = {
  command: 'enable',
  publisherId: 'phone-a',
  expectedGeneration: 0,
  mutationId: 'enable-a',
  consentVersion: 1,
  calendars,
};
const apply = (state: PhoneCalendarSharingState | null, command: PhoneCalendarSharingCommand) =>
  transitionPhoneCalendarSharing('owner', state, command, now);
const enabled = () => apply(null, enable).result.state;
function snapshot(overrides: Partial<PhoneCalendarSnapshotInput> = {}): PhoneCalendarSnapshotInput {
  return {
    timeMin: '2026-10-15T00:00:00Z',
    timeMax: '2026-12-07T00:00:00Z',
    timeZone: 'UTC',
    capturedAt: now.toISOString(),
    selectionRevision: 1,
    complete: true,
    truncated: false,
    sourceAvailability: [{ calendarId: 'work', status: 'available', complete: true }],
    calendars,
    events: [],
    ...overrides,
  };
}
const upload = (input = snapshot(), generation = 1): PhoneCalendarSharingCommand => ({
  command: 'snapshot',
  publisherId: 'phone-a',
  expectedGeneration: generation,
  snapshot: input,
});

describe('selected phone calendar sharing authority', () => {
  it('starts disabled and never admits a snapshot without an explicit sharing choice', () => {
    expect(apply(null, upload()).result.ok).toBe(false);
    expect(enabled()).toMatchObject({
      enabled: true,
      generation: 1,
      publisherId: 'phone-a',
      calendars,
    });
  });
  it('keeps a zero-source choice empty instead of reading all calendars', () => {
    expect(apply(null, { ...enable, calendars: [] }).result.state.calendars).toEqual([]);
  });
  it('requires explicit replacement to move ownership to another iPhone', () => {
    const state = enabled();
    expect(
      apply(state, { ...enable, publisherId: 'phone-b', expectedGeneration: 1 }).result,
    ).toMatchObject({ ok: false, error: 'publisher_conflict' });
    const replaced = apply(state, {
      ...enable,
      command: 'replace',
      publisherId: 'phone-b',
      expectedGeneration: 1,
      mutationId: 'replace-b',
    }).result.state;
    expect(replaced).toMatchObject({ publisherId: 'phone-b', generation: 2 });
    expect(
      apply(replaced, { command: 'revoke', publisherId: 'phone-a', expectedGeneration: 1 }).result
        .ok,
    ).toBe(false);
    expect(apply(replaced, upload()).result.ok).toBe(false);
  });
  it.each(['stop-before-enable', 'stop-after-enable'] as const)(
    'rejects late initial enable after %s',
    (order) => {
      let state = order === 'stop-after-enable' ? enabled() : null;
      const stopped = apply(state, {
        command: 'revoke',
        publisherId: 'phone-a',
        expectedGeneration: 0,
        cancelPendingMutationId: 'enable-a',
      });
      expect(stopped.result).toMatchObject({ ok: true, state: { enabled: false } });
      state = stopped.result.state;
      expect(apply(state, enable).result.ok).toBe(false);
      expect(apply(state, upload()).result.ok).toBe(false);
    },
  );
  it.each(['stop-before-selection', 'stop-after-selection'] as const)(
    'rejects a pending selection upload after %s',
    (order) => {
      const select: PhoneCalendarSharingCommand = {
        ...enable,
        command: 'select',
        expectedGeneration: 1,
        mutationId: 'select-b',
        calendars: [],
      };
      let state = enabled();
      if (order === 'stop-after-selection') state = apply(state, select).result.state;
      const stopped = apply(state, {
        command: 'revoke',
        publisherId: 'phone-a',
        expectedGeneration: 1,
        cancelPendingMutationId: 'select-b',
      });
      expect(stopped.result.state.enabled).toBe(false);
      expect(apply(stopped.result.state, select).result.ok).toBe(false);
    },
  );
  it('does not let a stale cancellation target another selection mutation', () => {
    const state = apply(enabled(), {
      ...enable,
      command: 'select',
      expectedGeneration: 1,
      mutationId: 'new-selection',
    }).result.state;
    expect(
      apply(state, {
        command: 'revoke',
        publisherId: 'phone-a',
        expectedGeneration: 1,
        cancelPendingMutationId: 'old-selection',
      }).result.ok,
    ).toBe(false);
  });
  it('preserves revocation across state serialization and allows a deliberate new generation', () => {
    const state = apply(enabled(), {
      command: 'revoke',
      publisherId: 'phone-a',
      expectedGeneration: 1,
    }).result.state;
    const restored = JSON.parse(JSON.stringify(state)) as PhoneCalendarSharingState;
    expect(apply(restored, upload()).result.ok).toBe(false);
    expect(
      apply(restored, { ...enable, expectedGeneration: 2, mutationId: 'explicit-new-consent' })
        .result,
    ).toMatchObject({ ok: true, state: { generation: 3, enabled: true } });
  });
  it('requires the complete selected roster and matching selection generation', () => {
    expect(apply(enabled(), upload(snapshot({ selectionRevision: 0 }))).result.ok).toBe(false);
    expect(apply(enabled(), upload(snapshot({ calendars: [] }))).result.ok).toBe(false);
    expect(apply(enabled(), upload(snapshot({ sourceAvailability: [] }))).result.ok).toBe(false);
    expect(apply(enabled(), upload()).result.ok).toBe(true);
  });
  it('rejects a snapshot with a duplicated calendar ID standing in for a selected source', () => {
    const workCalendar = calendars[0];
    if (!workCalendar) throw new Error('missing work calendar fixture');
    const familyCalendar = { id: 'family', name: 'Family', purpose: 'reference' as const };
    const state = apply(null, { ...enable, calendars: [workCalendar, familyCalendar] }).result
      .state;
    expect(
      apply(
        state,
        upload(
          snapshot({
            calendars: [workCalendar, workCalendar],
            sourceAvailability: [
              { calendarId: 'work', status: 'available', complete: true },
              { calendarId: 'family', status: 'available', complete: true },
            ],
          }),
        ),
      ).result,
    ).toMatchObject({ ok: false, error: 'invalid_snapshot' });
  });
  it('validates optional calendar time zones and requires the uploaded roster to match', () => {
    const workCalendar = calendars[0];
    if (!workCalendar) throw new Error('missing work calendar fixture');
    expect(
      apply(null, { ...enable, calendars: [{ ...workCalendar, timeZone: 'Mars/Olympus' }] }).result,
    ).toMatchObject({ ok: false, error: 'invalid_snapshot' });

    const state = enabled();
    expect(
      apply(
        state,
        upload(snapshot({ calendars: [{ ...workCalendar, timeZone: 'America/Los_Angeles' }] })),
      ).result,
    ).toMatchObject({ ok: false, error: 'invalid_snapshot' });
    expect(
      parsePhoneCalendarSharingState(
        {
          ...state,
          calendars: [{ ...workCalendar, timeZone: '' }],
        },
        'owner',
      ),
    ).toBeNull();
  });
  it('rejects duplicate source-availability rows even when their last value claims completeness', () => {
    expect(
      apply(
        enabled(),
        upload(
          snapshot({
            sourceAvailability: [
              { calendarId: 'work', status: 'missing', complete: false },
              { calendarId: 'work', status: 'available', complete: true },
            ],
          }),
        ),
      ).result,
    ).toMatchObject({ ok: false, error: 'invalid_snapshot' });
  });
  it.each([
    { capturedAt: '2026-10-22T18:06:00Z' },
    { capturedAt: '2026-10-01T18:00:00Z' },
    { complete: true, truncated: true },
    {
      complete: true,
      sourceAvailability: [{ calendarId: 'work', status: 'missing' as const, complete: false }],
    },
  ])('rejects falsely current or complete snapshots %j', (overrides) => {
    expect(apply(enabled(), upload(snapshot(overrides))).result).toMatchObject({
      ok: false,
      error: 'invalid_snapshot',
    });
  });
  it('does not refresh old captured data merely because it arrived just now', () => {
    const input = {
      ...snapshot({ capturedAt: '2026-10-22T17:00:00Z' }),
      syncedAt: now.toISOString(),
    };
    expect(phoneCalendarCoverage(input, input.timeMin, input.timeMax, now)).toMatchObject({
      complete: false,
      capturedAt: '2026-10-22T17:00:00Z',
      receivedAt: now.toISOString(),
    });
  });
  it('explains incomplete phone coverage using the recorded capture and share times', () => {
    const input = {
      ...snapshot({
        timeZone: 'America/Los_Angeles',
        capturedAt: '2026-10-22T17:00:00Z',
        complete: false,
      }),
      syncedAt: '2026-10-22T17:30:00Z',
    };
    const note = phoneCalendarCoverage(input, input.timeMin, input.timeMax, now).note;
    expect(note).toContain('Captured on the sharing iPhone: Oct 22, 2026, 10:00 AM PDT.');
    expect(note).toContain('Last shared with Assistant: Oct 22, 2026, 10:30 AM PDT.');
    expect(note).toContain(
      'On the iPhone where you enabled calendar sharing for this Assistant account, open iPhone calendars and choose Sync now. That phone can refresh the family calendars it shares.',
    );
    expect(note).toContain('Missing coverage does not show a free or empty calendar.');
    expect(note).not.toContain('last sent date window');
  });
  it('does not invent capture or share times when their source timestamps are missing or invalid', () => {
    const withoutCapture = snapshot({ complete: false });
    delete withoutCapture.capturedAt;
    const missingCaptureNote = phoneCalendarCoverage(
      { ...withoutCapture, syncedAt: now.toISOString() },
      withoutCapture.timeMin,
      withoutCapture.timeMax,
      now,
    ).note;
    expect(missingCaptureNote).not.toContain('Captured on the sharing iPhone:');
    expect(missingCaptureNote).toContain('Last shared with Assistant: Oct 22, 2026, 6:00 PM UTC.');

    const invalidCaptureNote = phoneCalendarCoverage(
      { ...snapshot({ capturedAt: 'not-a-time', complete: false }), syncedAt: 'also-not-a-time' },
      snapshot().timeMin,
      snapshot().timeMax,
      now,
    ).note;
    expect(invalidCaptureNote).not.toContain('Captured on the sharing iPhone:');
    expect(invalidCaptureNote).not.toContain('Last shared with Assistant:');
  });
  it('does not present the never-uploaded fallback sentinel as a recorded share time', async () => {
    const state = {
      ...enabled(),
      capturedAt: undefined,
      receivedAt: undefined,
      timeMin: undefined,
      timeMax: undefined,
    };
    const cache = {
      cacheGet: async () => null,
      cachePut: async () => {},
      phoneCalendarSharing: {
        get: async () => state,
        readSnapshot: async () => ({ state, snapshot: null }),
        apply: async () => {
          throw new Error('Unexpected phone calendar mutation');
        },
      },
    };
    const synthetic = await readPhoneCalendars(cache, 'owner', now);
    expect(synthetic?.syncedAt).toBe('1970-01-01T00:00:00.000Z');
    if (!synthetic) throw new Error('Missing synthetic not-yet-uploaded snapshot');
    const note = phoneCalendarCoverage(synthetic, synthetic.timeMin, synthetic.timeMax, now).note;
    expect(note).not.toContain('1970');
    expect(note).not.toContain('Last shared with Assistant:');
    expect(note).not.toContain('Captured on the sharing iPhone:');
  });
  it('limits completeness to requested source coverage without hiding a missing source by default', () => {
    const input = {
      ...snapshot(),
      syncedAt: now.toISOString(),
      complete: false,
      calendars: [...calendars, { id: 'family', name: 'Family' }],
      sourceAvailability: [
        { calendarId: 'work', status: 'available' as const, complete: true },
        {
          calendarId: 'family',
          status: 'missing' as const,
          complete: false,
          reason: 'Account unavailable',
        },
      ],
    };
    expect(phoneCalendarCoverage(input, input.timeMin, input.timeMax, now).complete).toBe(false);
    expect(
      phoneCalendarCoverage(input, input.timeMin, input.timeMax, now, ['iphone:work']).complete,
    ).toBe(true);
  });
  it('bounds sharing by local dates across the autumn DST change', () => {
    const window = phoneCalendarSharingWindow(
      'America/Los_Angeles',
      new Date('2026-10-22T18:00:00Z'),
    );
    expect(window).toEqual({
      timeMin: '2026-10-15T07:00:00.000Z',
      timeMax: '2026-12-07T08:00:00.000Z',
    });
    expect((Date.parse(window.timeMax) - Date.parse(window.timeMin)) / 3_600_000).toBe(53 * 24 + 1);
  });
  it('rejects events entirely outside the disclosed snapshot window', () => {
    const input = snapshot({
      events: [
        {
          eventId: 'outside',
          calendarId: 'work',
          summary: 'Outside',
          location: '',
          start: '2027-01-01T10:00:00Z',
          end: '2027-01-01T11:00:00Z',
          allDay: false,
          blocksTime: true,
        },
      ],
    });
    expect(apply(enabled(), upload(input)).result).toMatchObject({
      ok: false,
      error: 'invalid_snapshot',
    });
  });
  it('does not turn an explicitly partial snapshot into full coverage by default', () => {
    const input = { ...snapshot({ complete: false }), syncedAt: now.toISOString() };
    expect(phoneCalendarCoverage(input, input.timeMin, input.timeMax, now).complete).toBe(false);
  });
});
