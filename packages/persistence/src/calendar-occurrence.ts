export interface CalendarOccurrenceIdentity {
  calendarId?: unknown;
  eventId?: unknown;
  iCalUID?: unknown;
  recurringEventId?: unknown;
  originalStartTime?: unknown;
  start?: unknown;
  end?: unknown;
}

export type CalendarOwnerParticipationStatus =
  | 'accepted'
  | 'declined'
  | 'tentative'
  | 'needsAction'
  | 'unknown';

/** A response is personal attendance only when its attendee identity is verified. */
export interface CalendarOwnerParticipation {
  status: CalendarOwnerParticipationStatus;
  identityVerified: boolean;
  basis: 'attendee-email' | 'organizer-email' | 'unverified';
}

/** Calendar role is explicit metadata, never an attendance signal. */
export type CalendarPurpose = 'unspecified' | 'commitments' | 'reference';

/** Small source-preserving event variant suitable for projections and conflict review. */
export interface CalendarOccurrenceSource extends CalendarOccurrenceIdentity {
  calendar?: string;
  calendarTimeZone?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  blocksTime?: boolean;
  ownerResponse?: string;
  ownerParticipation?: CalendarOwnerParticipation;
  calendarPurpose?: CalendarPurpose;
  allDay?: boolean;
}

export type CalendarOccurrenceClassification =
  | { kind: 'canonical'; key: string }
  | { kind: 'probable-mirror'; reason: 'matching-phone-listing' }
  | { kind: 'distinct' };

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

function occurrenceTime(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `date:${raw}`;
  const normalized = time(raw);
  return normalized ? `instant:${normalized}` : '';
}

/** Stable identity key for exact provider identity only; never falls back to title. */
export function calendarOccurrenceKey(event: CalendarOccurrenceIdentity): string | undefined {
  const calendarId = text(event.calendarId);
  const eventId = text(event.eventId);
  const uid = text(event.iCalUID);
  const original = occurrenceTime(event.originalStartTime);
  // Local event IDs identify ordinary events directly. EventKit can reuse a
  // calendar event identifier across recurring occurrences, so those need
  // their original occurrence start in both grouping and stable keys.
  if (calendarId && eventId) {
    const occurrence = occurrenceTime(event.originalStartTime);
    if (occurrence)
      return `calendar:${encodeURIComponent(calendarId)}\0event:${encodeURIComponent(eventId)}\0occurrence:${occurrence}`;
    if (text(event.recurringEventId)) return undefined;
    return `calendar:${encodeURIComponent(calendarId)}\0event:${encodeURIComponent(eventId)}`;
  }
  if (uid && original) return `ical:${encodeURIComponent(uid)}\0occurrence:${original}`;
  if (uid && !text(event.recurringEventId)) {
    const start = occurrenceTime(event.start);
    const end = occurrenceTime(event.end);
    if (start && end) return `ical:${encodeURIComponent(uid)}\0bounds:${start}\0${end}`;
  }
  return undefined;
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
  if (leftCalendar === rightCalendar) {
    if (!leftId || leftId !== rightId) return false;
    const leftOriginal = time(left.originalStartTime);
    const rightOriginal = time(right.originalStartTime);
    if (leftOriginal || rightOriginal)
      return Boolean(leftOriginal && leftOriginal === rightOriginal);
    // Without an original start, a reused recurring event ID cannot establish
    // that two source rows refer to the same occurrence.
    return !text(left.recurringEventId) && !text(right.recurringEventId);
  }
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

/** Classify strong provider identity separately from similarity-only phone mirrors. */
export function classifyCalendarOccurrence(
  left: CalendarOccurrenceIdentity & { summary?: unknown; location?: unknown },
  right: CalendarOccurrenceIdentity & { summary?: unknown; location?: unknown },
): CalendarOccurrenceClassification {
  if (sameCalendarOccurrence(left, right)) {
    const key = calendarOccurrenceKey(left) ?? calendarOccurrenceKey(right);
    if (key) return { kind: 'canonical', key };
  }
  if (probablePhoneCalendarDuplicate(left, right))
    return { kind: 'probable-mirror', reason: 'matching-phone-listing' };
  return { kind: 'distinct' };
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
