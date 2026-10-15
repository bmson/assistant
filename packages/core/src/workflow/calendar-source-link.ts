/**
 * Calendar links are source references, not arbitrary event-provided URLs.
 * Keep Google's authenticated event IDs useful while dropping provider links
 * that may themselves be bearer links (for example, hotel-management URLs).
 */
export function safeCalendarSourceUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      !isGoogleCalendarUrl(url)
    )
      return undefined;

    // Google Calendar event IDs are useful source references. Drop every other
    // query parameter and all fragments, which may carry account or capability
    // material supplied by an event provider.
    const eventId = url.searchParams.get('eid');
    const calendarId = url.searchParams.get('eventid');
    if (!eventId && !calendarId) return undefined;
    url.search = '';
    if (eventId) url.searchParams.set('eid', eventId);
    else if (calendarId) url.searchParams.set('eventid', calendarId);
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

function isGoogleCalendarUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === 'calendar.google.com') return true;
  return (
    (host === 'www.google.com' || host === 'google.com') &&
    /^\/calendar(?:\/|$)/i.test(url.pathname)
  );
}
