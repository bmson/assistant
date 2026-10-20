export interface CalendarOccurrenceIdentity {
  calendarId?: unknown;
  eventId?: unknown;
  iCalUID?: unknown;
  recurringEventId?: unknown;
  originalStartTime?: unknown;
  start?: unknown;
  end?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function time(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

/** Provider identity, never title/location similarity, establishes equivalence. */
export function sameCalendarOccurrence(
  left: CalendarOccurrenceIdentity,
  right: CalendarOccurrenceIdentity,
): boolean {
  const leftCalendar = text(left.calendarId);
  const rightCalendar = text(right.calendarId);
  const leftId = text(left.eventId);
  const rightId = text(right.eventId);
  if (!leftCalendar || !rightCalendar) return false;
  if (leftCalendar === rightCalendar) return Boolean(leftId && leftId === rightId);
  const uid = text(left.iCalUID);
  if (!uid || uid !== text(right.iCalUID)) return false;
  const leftOriginal = time(left.originalStartTime);
  const rightOriginal = time(right.originalStartTime);
  if (leftOriginal || rightOriginal) {
    return Boolean(leftOriginal && leftOriginal === rightOriginal);
  }
  // A series UID cannot identify an occurrence without its original start.
  if (text(left.recurringEventId) || text(right.recurringEventId)) return false;
  return Boolean(
    time(left.start) &&
      time(left.start) === time(right.start) &&
      time(left.end) &&
      time(left.end) === time(right.end),
  );
}

/** Advisory mirror match; retain both sources and never use it to authorize edits. */
export function probablePhoneCalendarDuplicate(
  left: CalendarOccurrenceIdentity & { summary?: unknown; location?: unknown },
  right: CalendarOccurrenceIdentity & { summary?: unknown; location?: unknown },
): boolean {
  const leftCalendar = text(left.calendarId);
  const rightCalendar = text(right.calendarId);
  if (
    !leftCalendar ||
    !rightCalendar ||
    leftCalendar === rightCalendar ||
    (!leftCalendar.startsWith('iphone:') && !rightCalendar.startsWith('iphone:'))
  )
    return false;
  const normalized = (value: unknown) =>
    text(value)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const title = normalized(left.summary);
  if (title.length < 4 || title !== normalized(right.summary)) return false;
  if (
    !time(left.start) ||
    time(left.start) !== time(right.start) ||
    !time(left.end) ||
    time(left.end) !== time(right.end)
  )
    return false;
  if (
    left.originalStartTime &&
    right.originalStartTime &&
    time(left.originalStartTime) !== time(right.originalStartTime)
  )
    return false;
  const location = normalized(left.location);
  const otherLocation = normalized(right.location);
  return !location || !otherLocation || location === otherLocation;
}
