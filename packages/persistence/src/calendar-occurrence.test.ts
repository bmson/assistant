import { describe, expect, it } from 'vitest';
import { sameCalendarOccurrence } from './calendar-occurrence.js';

const base = {
  calendarId: 'work',
  eventId: 'one',
  iCalUID: 'series',
  recurringEventId: 'r',
  originalStartTime: '2026-10-07T09:00:00Z',
  start: '2026-10-07T09:00:00Z',
  end: '2026-10-07T10:00:00Z',
};
describe('calendar occurrence identity', () => {
  it('keeps same-calendar distinct rows even with a shared UID and occurrence time', () => {
    expect(sameCalendarOccurrence(base, { ...base, eventId: 'two' })).toBe(false);
    expect(sameCalendarOccurrence(base, { ...base })).toBe(true);
  });
  it('keeps separate series occurrences and missing occurrence identity', () => {
    expect(
      sameCalendarOccurrence(base, {
        ...base,
        calendarId: 'personal',
        originalStartTime: '2026-10-08T09:00:00Z',
      }),
    ).toBe(false);
    expect(
      sameCalendarOccurrence(
        { ...base, originalStartTime: undefined },
        { ...base, calendarId: 'personal', originalStartTime: undefined },
      ),
    ).toBe(false);
  });
  it('recognizes cross-calendar copies of a moved occurrence and equivalent time offsets', () => {
    expect(
      sameCalendarOccurrence(base, {
        ...base,
        calendarId: 'personal',
        eventId: 'copy',
        originalStartTime: '2026-10-07T02:00:00-07:00',
        start: '2026-10-07T09:15:00Z',
      }),
    ).toBe(true);
  });
  it('requires provider UID and matching bounds for a single-event copy', () => {
    const single = { ...base, recurringEventId: undefined, originalStartTime: undefined };
    expect(sameCalendarOccurrence(single, { ...single, calendarId: 'personal' })).toBe(true);
    expect(
      sameCalendarOccurrence(single, { ...single, calendarId: 'personal', iCalUID: undefined }),
    ).toBe(false);
    expect(
      sameCalendarOccurrence(single, {
        ...single,
        calendarId: 'personal',
        end: '2026-10-07T11:00:00Z',
      }),
    ).toBe(false);
  });
});
