import { describe, expect, it } from 'vitest';
import type { BriefingCalendarEvent } from '../workflow/briefing.js';
import {
  attendeeResponseDigest,
  type CalendarEventSnapshotRow,
  diffCalendarEvents,
  toSnapshotRow,
} from './calendar-diff.js';

const NOW = new Date('2026-03-04T09:00:00Z');

function event(over: Partial<BriefingCalendarEvent> = {}): BriefingCalendarEvent {
  return {
    summary: 'Design review',
    start: '2026-03-04T11:00:00Z',
    end: '2026-03-04T11:30:00Z',
    calendar: 'Work',
    calendarId: 'work@example.com',
    eventId: 'evt-1',
    iCalUID: 'evt-1@google.com',
    allDay: false,
    ...over,
  };
}

/** The snapshot row `toSnapshotRow` would have produced for `event()` last time. */
function snapshot(over: Partial<CalendarEventSnapshotRow> = {}): CalendarEventSnapshotRow {
  return {
    calendarId: 'work@example.com',
    eventId: 'evt-1',
    iCalUID: 'evt-1@google.com',
    summary: 'Design review',
    start: '2026-03-04T11:00:00Z',
    end: '2026-03-04T11:30:00Z',
    status: null,
    attendeeResponseHash: {},
    ...over,
  };
}

describe('diffCalendarEvents — the boring but critical cases', () => {
  it('produces no changes for an unchanged calendar', () => {
    const current = [
      event({
        attendees: ['owner@example.com (accepted)', 'guest@example.com (accepted)'],
      }),
    ];
    const previous = [
      snapshot({
        attendeeResponseHash: attendeeResponseDigest([
          'owner@example.com (accepted)',
          'guest@example.com (accepted)',
        ]),
      }),
    ];
    expect(diffCalendarEvents(current, previous, NOW, true)).toEqual([]);
  });

  it('produces no changes on a first-ever read — nothing to compare against yet', () => {
    // A brand new agent, or one whose snapshot has never been written: every
    // event on the calendar right now is not "new news", it is just the
    // calendar. Announcing all of it would be exactly the fabricated urgency
    // the rest of proactive refuses to produce.
    const current = [
      event({ eventId: 'evt-1' }),
      event({ eventId: 'evt-2', summary: 'Other meeting' }),
      event({ eventId: 'evt-3', summary: 'Yet another', status: 'cancelled' }),
    ];
    expect(diffCalendarEvents(current, [], NOW, true)).toEqual([]);
  });

  it('reports a missing event as unverified even when the bounded window is complete', () => {
    const changes = diffCalendarEvents(
      [],
      [snapshot({ eventId: 'evt-1' }), snapshot({ eventId: 'evt-2' })],
      NOW,
      true,
    );
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.kind === 'unverified')).toBe(true);
  });
});

describe('diffCalendarEvents — cancelled', () => {
  it('keeps an absent upcoming event unverified instead of inferring cancellation', () => {
    const changes = diffCalendarEvents([], [snapshot()], NOW, true);
    expect(changes).toEqual([
      {
        kind: 'unverified',
        calendarId: 'work@example.com',
        eventId: 'evt-1',
        iCalUID: 'evt-1@google.com',
        summary: 'Design review',
        start: '2026-03-04T11:00:00Z',
        end: '2026-03-04T11:30:00Z',
      },
    ]);
  });

  it('flags an event the provider sent back with an explicit cancelled status', () => {
    const changes = diffCalendarEvents([event({ status: 'cancelled' })], [snapshot()], NOW, true);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('cancelled');
  });

  it('trusts an explicit cancellation even when unrelated events were truncated', () => {
    const changes = diffCalendarEvents(
      [event({ status: 'cancelled' })],
      [snapshot(), snapshot({ eventId: 'not-returned' })],
      NOW,
      false,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'cancelled', eventId: 'evt-1' });
  });

  it('does not flag a truncated read — absence proves nothing when the read was incomplete', () => {
    expect(diffCalendarEvents([], [snapshot()], NOW, false)).toEqual([]);
  });

  it('does not flag an event whose start has already passed — it just aged out of the window', () => {
    const past = snapshot({ start: '2026-03-04T08:00:00Z', end: '2026-03-04T08:30:00Z' });
    expect(diffCalendarEvents([], [past], NOW, true)).toEqual([]);
  });

  it('does not re-report a row already marked cancelled', () => {
    const already = snapshot({ status: 'cancelled' });
    expect(diffCalendarEvents([], [already], NOW, true)).toEqual([]);
  });
});

describe('diffCalendarEvents — moved', () => {
  it('flags a changed start time', () => {
    const changes = diffCalendarEvents(
      [event({ start: '2026-03-04T13:00:00Z', end: '2026-03-04T13:30:00Z' })],
      [snapshot()],
      NOW,
      true,
    );
    expect(changes).toEqual([
      {
        kind: 'moved',
        calendarId: 'work@example.com',
        eventId: 'evt-1',
        iCalUID: 'evt-1@google.com',
        summary: 'Design review',
        calendar: 'Work',
        start: '2026-03-04T13:00:00Z',
        end: '2026-03-04T13:30:00Z',
        previousStart: '2026-03-04T11:00:00Z',
      },
    ]);
  });

  it('is not fooled by the same instant written with a different UTC offset', () => {
    const changes = diffCalendarEvents(
      [event({ start: '2026-03-04T13:00:00+02:00' })],
      [snapshot({ start: '2026-03-04T11:00:00Z' })],
      NOW,
      true,
    );
    expect(changes).toEqual([]);
  });

  it('does not flag an unchanged start', () => {
    expect(diffCalendarEvents([event()], [snapshot()], NOW, true)).toEqual([]);
  });
});

describe('diffCalendarEvents — declined', () => {
  it('flags an attendee who had accepted and now declined', () => {
    const changes = diffCalendarEvents(
      [event({ attendees: ['guest@example.com (declined)'] })],
      [
        snapshot({
          attendeeResponseHash: attendeeResponseDigest(['guest@example.com (accepted)']),
        }),
      ],
      NOW,
      true,
    );
    expect(changes).toEqual([
      {
        kind: 'declined',
        calendarId: 'work@example.com',
        eventId: 'evt-1',
        iCalUID: 'evt-1@google.com',
        summary: 'Design review',
        calendar: 'Work',
        start: '2026-03-04T11:00:00Z',
        end: '2026-03-04T11:30:00Z',
        declinedEmails: ['guest@example.com'],
      },
    ]);
  });

  it('does not flag someone who declined without ever having accepted', () => {
    const changes = diffCalendarEvents(
      [event({ attendees: ['guest@example.com (declined)'] })],
      [
        snapshot({
          attendeeResponseHash: attendeeResponseDigest(['guest@example.com (needsAction)']),
        }),
      ],
      NOW,
      true,
    );
    expect(changes).toEqual([]);
  });

  it('does not flag an attendee who is still accepted', () => {
    const changes = diffCalendarEvents(
      [event({ attendees: ['guest@example.com (accepted)'] })],
      [
        snapshot({
          attendeeResponseHash: attendeeResponseDigest(['guest@example.com (accepted)']),
        }),
      ],
      NOW,
      true,
    );
    expect(changes).toEqual([]);
  });

  it('names only the attendee who actually declined, out of several', () => {
    const changes = diffCalendarEvents(
      [
        event({
          attendees: ['a@example.com (declined)', 'b@example.com (accepted)'],
        }),
      ],
      [
        snapshot({
          attendeeResponseHash: attendeeResponseDigest([
            'a@example.com (accepted)',
            'b@example.com (accepted)',
          ]),
        }),
      ],
      NOW,
      true,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'declined', declinedEmails: ['a@example.com'] });
  });
});

describe('attendeeResponseDigest', () => {
  it('hashes case- and whitespace-insensitively, so the same person matches next read', () => {
    const a = attendeeResponseDigest([' Guest@Example.com (accepted)']);
    const b = attendeeResponseDigest(['guest@example.com (accepted)']);
    expect(a).toEqual(b);
  });

  it('never stores a raw email address', () => {
    const digest = attendeeResponseDigest(['guest@example.com (accepted)']);
    expect(JSON.stringify(digest)).not.toContain('guest@example.com');
  });
});

describe('toSnapshotRow', () => {
  it('returns null for an event with no stable identity to compare next time', () => {
    expect(toSnapshotRow(event({ eventId: undefined }))).toBeNull();
    expect(toSnapshotRow(event({ calendarId: undefined }))).toBeNull();
  });

  it('carries the fields the diff needs forward', () => {
    const row = toSnapshotRow(
      event({ status: 'confirmed', attendees: ['guest@example.com (accepted)'] }),
    );
    expect(row).toMatchObject({
      calendarId: 'work@example.com',
      eventId: 'evt-1',
      iCalUID: 'evt-1@google.com',
      summary: 'Design review',
      start: '2026-03-04T11:00:00Z',
      end: '2026-03-04T11:30:00Z',
      status: 'confirmed',
    });
    expect(row?.attendeeResponseHash).toEqual(
      attendeeResponseDigest(['guest@example.com (accepted)']),
    );
  });
});
