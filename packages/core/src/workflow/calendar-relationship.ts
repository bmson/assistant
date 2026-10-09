import type { BriefingCalendarEvent } from './briefing.js';

export type CalendarRelationship = 'probable_duplicate' | 'compatible_time_roles' | 'unresolved';

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function role(event: BriefingCalendarEvent): 'arrival' | 'start' | undefined {
  const text = `${event.summary}\n${event.description ?? ''}`;
  const arrival = /\b(?:arrive|arrival|warm[ -]?up|check[ -]?in)\b/i.test(text);
  const start = /\b(?:kick[ -]?off|match start|event start)\b/i.test(text);
  return arrival === start ? undefined : arrival ? 'arrival' : 'start';
}

function title(event: BriefingCalendarEvent): string {
  return normalized(
    event.summary.replace(
      /\b(?:arrive|arrival|warm[ -]?up|check[ -]?in|kick[ -]?off|match start|event start)\b/gi,
      '',
    ),
  );
}

function venues(event: BriefingCalendarEvent): Set<string> {
  // An explicit source statement may support a probable relationship, never
  // provider identity or a write decision. Similar street names are insufficient.
  const aliases = /^venue aliases:\s*(.+)$/im.exec((event.description ?? '').slice(0, 4000))?.[1];
  return new Set(
    [event.location ?? '', ...(aliases?.split('|') ?? [])].map(normalized).filter(Boolean),
  );
}

/** Similarity is advisory only: callers retain every original source and time. */
export function calendarRelationship(
  left: BriefingCalendarEvent,
  right: BriefingCalendarEvent,
): CalendarRelationship {
  if (!left.calendarId || !right.calendarId || left.calendarId === right.calendarId)
    return 'unresolved';
  if (
    (left.recurringEventId || right.recurringEventId) &&
    left.originalStartTime !== right.originalStartTime
  )
    return 'unresolved';
  const name = title(left);
  if (name !== title(right) || name.split(' ').length < 2) return 'unresolved';
  const venue = venues(right);
  if (![...venues(left)].some((entry) => venue.has(entry))) return 'unresolved';
  const earlier = Date.parse(left.start) <= Date.parse(right.start) ? left : right;
  const later = earlier === left ? right : left;
  const distance = Date.parse(later.start) - Date.parse(earlier.start);
  if (!Number.isFinite(distance) || distance > 60 * 60_000) return 'unresolved';
  if (role(earlier) === 'arrival' && role(later) === 'start') return 'compatible_time_roles';
  return distance === 0 && left.end === right.end ? 'probable_duplicate' : 'unresolved';
}

export function calendarRelationshipNote(
  relationship: CalendarRelationship,
  attendance: 'confirmed' | 'unresolved',
): string {
  if (relationship === 'compatible_time_roles')
    return 'These may describe arrival and kickoff for one event. Keep the earlier arrival time; source identity is unverified.';
  if (relationship === 'probable_duplicate')
    return 'These may be duplicate listings. Both sources are retained because their occurrence identity is unverified.';
  return attendance === 'confirmed'
    ? 'Provider records show accepted invitations for both obligations; occurrence identity has not been equated.'
    : 'The event times overlap; personal attendance and matching occurrence identity are not established for both records.';
}
