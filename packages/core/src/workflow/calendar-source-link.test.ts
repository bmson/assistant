import { describe, expect, it } from 'vitest';
import { safeCalendarSourceUrl, safeVideoMeetingUrl } from './calendar-source-link.js';

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
    // Google Calendar API htmlLink shape used for event source records.
    expect(
      safeCalendarSourceUrl('https://www.google.com/calendar/event?eid=api-event&authuser=0'),
    ).toBe('https://www.google.com/calendar/event?eid=api-event');
  });

  it.each([
    'https://user:password@calendar.google.com/event?eid=source-event',
    'https://hotel.example/manage?token=bearer-secret#session=fragment-secret',
    'https://calendar.google.com.evil.example/event?eid=source-event',
    'http://calendar.google.com/event?eid=source-event',
    'https://calendar.google.com:8443/event?eid=source-event',
    'https://calendar.google.com/calendar/u/0/r/eventedit?text=New+event',
    'not a URL',
    'https://calendar.google.com:invalid/event?eid=source-event',
  ])('does not publish an unsafe or malformed source URL: %s', (url) => {
    expect(safeCalendarSourceUrl(url)).toBeUndefined();
  });

  it('retains a valid known-provider meeting URL without trusting arbitrary video URLs', () => {
    expect(safeVideoMeetingUrl('https://zoom.us/j/12345?pwd=meeting-password')).toBe(
      'https://zoom.us/j/12345?pwd=meeting-password',
    );
    expect(safeVideoMeetingUrl('https://meet.google.com/abc-defg-hij')).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(safeVideoMeetingUrl('https://zoom.us.evil.example/j/12345')).toBeUndefined();
    expect(safeVideoMeetingUrl('https://user:pass@zoom.us/j/12345')).toBeUndefined();
    expect(safeVideoMeetingUrl('https://zoom.us:8443/j/12345')).toBeUndefined();
  });
});
