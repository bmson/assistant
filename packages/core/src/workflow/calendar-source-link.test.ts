import { describe, expect, it } from 'vitest';
import { safeCalendarSourceUrl } from './calendar-source-link.js';

describe('safe calendar source links', () => {
  it('keeps the Google Calendar event ID while removing query and fragment credentials', () => {
    expect(
      safeCalendarSourceUrl(
        'https://calendar.google.com/event?eid=source-event&access_token=query-secret&other=value#token=fragment-secret',
      ),
    ).toBe('https://calendar.google.com/event?eid=source-event');
    expect(
      safeCalendarSourceUrl('https://www.google.com/calendar/event?eid=source-event&code=secret'),
    ).toBe('https://www.google.com/calendar/event?eid=source-event');
  });

  it.each([
    'https://user:password@calendar.google.com/event?eid=source-event',
    'https://hotel.example/manage?token=bearer-secret#session=fragment-secret',
    'https://calendar.google.com.evil.example/event?eid=source-event',
    'http://calendar.google.com/event?eid=source-event',
    'https://calendar.google.com/calendar/u/0/r/eventedit?text=New+event',
    'not a URL',
    'https://calendar.google.com:invalid/event?eid=source-event',
  ])('does not publish an unsafe or malformed source URL: %s', (url) => {
    expect(safeCalendarSourceUrl(url)).toBeUndefined();
  });
});
