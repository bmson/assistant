import { describe, expect, it } from 'vitest';
import { ownerCalendarToolName, requestedOwnerCalendarScope } from './calendar-scope.js';

describe('owner named calendar scope', () => {
  it('keeps a literal owner calendar label and the explicit phone source hint', () => {
    const scope = requestedOwnerCalendarScope(
      'Check Zendesk calendar tomorrow, shared from phone.',
    );
    expect(scope).toEqual({ name: 'Zendesk', source: 'iphone' });
    expect(ownerCalendarToolName(scope!)).toBe('Zendesk (iPhone)');
  });

  it('leaves generic calendar references unscoped', () => {
    expect(requestedOwnerCalendarScope('What is on my calendar tomorrow?')).toBeUndefined();
    expect(requestedOwnerCalendarScope('Check all calendars tomorrow.')).toBeUndefined();
    expect(
      requestedOwnerCalendarScope(
        'Review my calendar for the next two weekdays in my calendar’s timezone. For each day, count events lasting at least 45 minutes. Also report gaps of 30 minutes or more between events explicitly marked in person, including the event times and locations when available. Do not infer travel time, event mode, or missing times; link to the source events if the calendar provides links. This is read-only; do not change anything.',
      ),
    ).toBeUndefined();
  });

  it('accepts literal lowercase, qualified, and quoted labels', () => {
    expect(requestedOwnerCalendarScope("What's on work calendar this week?")).toEqual({
      name: 'work',
    });
    expect(requestedOwnerCalendarScope('What is on my zendesk calendar?')).toEqual({
      name: 'zendesk',
    });
    expect(requestedOwnerCalendarScope('Check my Personal Work calendar tomorrow')).toEqual({
      name: 'Personal Work',
    });
    expect(requestedOwnerCalendarScope('Personal Work calendar this week')).toEqual({
      name: 'Personal Work',
    });
    expect(requestedOwnerCalendarScope('Check my zendesk support calendar')).toEqual({
      name: 'zendesk support',
    });
    expect(requestedOwnerCalendarScope('Show the "zendesk support" calendar')).toEqual({
      name: 'zendesk support',
    });
    expect(requestedOwnerCalendarScope('Check my "Research and Development" calendar')).toEqual({
      name: 'Research and Development',
    });
    expect(
      requestedOwnerCalendarScope(
        'Find my next trip from my booking emails and Work calendar. Confirm flight dates.',
      ),
    ).toEqual({ name: 'Work' });
  });
});
