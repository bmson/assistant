import { describe, expect, it } from 'vitest';
import {
  calendarOccurrenceKey,
  classifyCalendarOccurrence,
  sameCalendarOccurrence,
} from './calendar-occurrence.js';

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
    const copy = {
      ...base,
      calendarId: 'personal',
      eventId: 'copy',
      originalStartTime: '2026-10-07T02:00:00-07:00',
      start: '2026-10-07T09:15:00Z',
    };
    expect(sameCalendarOccurrence(base, copy)).toBe(true);
    expect(calendarOccurrenceKey(base)).not.toBe(calendarOccurrenceKey(copy));
    expect(classifyCalendarOccurrence(base, copy)).toMatchObject({ kind: 'canonical' });
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

  it('uses namespaced provider identity and never uses title as a canonical key', () => {
    expect(calendarOccurrenceKey(base)).toContain('calendar:work');
    expect(calendarOccurrenceKey({ calendarId: 'work' })).toBeUndefined();
    expect(calendarOccurrenceKey({ calendarId: 'work', eventId: 'one' })).toBe(
      calendarOccurrenceKey({ calendarId: 'work', eventId: 'one' }),
    );
    expect(calendarOccurrenceKey({ calendarId: 'work', eventId: 'one' })).not.toBe(
      calendarOccurrenceKey({ calendarId: 'family', eventId: 'one' }),
    );
  });

  it('does not equate recurring series across copies without an occurrence start', () => {
    const series = { ...base, originalStartTime: undefined };
    expect(
      sameCalendarOccurrence(series, {
        ...series,
        calendarId: 'personal',
        recurringEventId: 'r',
      }),
    ).toBe(false);
  });

  it('keeps same-calendar records distinct even when UID and occurrence match', () => {
    expect(calendarOccurrenceKey(base)).not.toBe(
      calendarOccurrenceKey({ ...base, eventId: 'another-event' }),
    );
    expect(sameCalendarOccurrence(base, { ...base, eventId: 'another-event' })).toBe(false);
  });

  it('uses original occurrence time when a same-calendar recurring ID is reused', () => {
    const first = { ...base, eventId: 'eventkit-reused-id' };
    const nextOccurrence = {
      ...first,
      originalStartTime: '2026-10-14T09:00:00-07:00',
    };
    expect(sameCalendarOccurrence(first, nextOccurrence)).toBe(false);
    expect(calendarOccurrenceKey(first)).not.toBe(calendarOccurrenceKey(nextOccurrence));
    expect(
      sameCalendarOccurrence(first, {
        ...first,
        originalStartTime: '2026-10-07T02:00:00-07:00',
      }),
    ).toBe(true);
    expect(sameCalendarOccurrence(first, { ...first, originalStartTime: undefined })).toBe(false);
    expect(calendarOccurrenceKey({ ...first, originalStartTime: undefined })).toBeUndefined();
    expect(
      sameCalendarOccurrence(
        { ...first, recurringEventId: undefined, originalStartTime: undefined },
        { ...first, recurringEventId: undefined, originalStartTime: undefined },
      ),
    ).toBe(true);
  });
});

it('separates probable phone copies from distinct overlaps and recurring instances', async () => {
  const { probablePhoneCalendarDuplicate } = await import('./calendar-occurrence.js');
  const event = {
    calendarId: 'google',
    summary: 'Team Planning',
    start: '2026-10-19T09:00:00Z',
    end: '2026-10-19T10:00:00Z',
  };
  expect(
    probablePhoneCalendarDuplicate(event, {
      ...event,
      calendarId: 'iphone:work',
      summary: 'Team planning',
      iCalUID: 'different-provider-id',
    }),
  ).toBe(true);
  expect(
    probablePhoneCalendarDuplicate(event, {
      ...event,
      calendarId: 'iphone:work',
      summary: 'Different appointment',
    }),
  ).toBe(false);
  expect(
    probablePhoneCalendarDuplicate(event, {
      ...event,
      calendarId: 'iphone:work',
      start: '2026-10-19T09:30:00Z',
    }),
  ).toBe(false);
  expect(
    probablePhoneCalendarDuplicate(
      { ...event, location: 'Office A' },
      { ...event, calendarId: 'iphone:work', location: 'Office B' },
    ),
  ).toBe(false);
  expect(
    probablePhoneCalendarDuplicate(
      { ...event, originalStartTime: '2026-10-18T09:00:00Z' },
      { ...event, calendarId: 'iphone:work', originalStartTime: event.start },
    ),
  ).toBe(false);
  expect(
    classifyCalendarOccurrence(event, {
      ...event,
      calendarId: 'iphone:work',
      iCalUID: 'different-uid',
    }),
  ).toMatchObject({ kind: 'probable-mirror', reason: 'matching-phone-listing' });
  expect(
    classifyCalendarOccurrence(event, {
      ...event,
      calendarId: 'family',
      summary: 'Team planning',
    }),
  ).toEqual({ kind: 'distinct' });
  expect(
    classifyCalendarOccurrence(base, {
      ...base,
      calendarId: 'personal',
      eventId: 'copy',
      originalStartTime: '2026-10-07T09:00:00Z',
    }),
  ).toMatchObject({ kind: 'canonical' });
});
