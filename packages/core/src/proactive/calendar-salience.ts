import { collapseWhitespace, ownerEventWhen } from '../owner-text.js';
import type { BriefingCalendarEvent } from '../workflow/briefing.js';

/**
 * Which calendar events actually matter — deterministically.
 *
 * The briefing used to treat the calendar as scenery: `briefingHasNews`
 * counted an overlap and nothing else, so a day holding a flight, a hospital
 * appointment or an unanswered invitation read as "routine" and produced
 * silence. That is the single most-felt gap in the anticipation layer, because
 * the owner's calendar is the one place their obligations are already written
 * down.
 *
 * Scoring stays a pure function over the event rows for the same reason the
 * digest's inputs are structured: a model asked "which of these is important?"
 * will always find something, and a briefing that invents urgency is worse
 * than no briefing (`docs/anticipation-layer.md`, the no-fabricated-urgency
 * rule). Every point below is a fact the provider stated. The model's only job
 * downstream is to write these up.
 *
 * No database, no provider, no config — the same shape as
 * `predicate-vocabulary.ts`, so it is trivially testable and cannot drift into
 * doing I/O.
 */

/** A signal's contribution, kept in one table so the weights are readable together. */
const WEIGHTS = {
  /** The owner was invited and has not answered. Nothing else is as actionable. */
  unanswered: 3,
  /** A physical place means leaving, which means lead time. */
  travel: 2,
  /** Outside the hours the owner normally has events — easy to be caught out by. */
  unusualHour: 2,
  /** Someone outside the owner's own domains called the meeting. */
  externalOrganizer: 1,
  /** Big meetings are rarely skippable and rarely uneventful. */
  crowded: 1,
  /** A long block reshapes the day around it. */
  long: 1,
  /** An all-day entry is usually a trip, a holiday, or a deadline. */
  allDay: 1,
} as const;

/** At or above this, an event is worth naming to the owner unprompted. */
export const SALIENCE_THRESHOLD = 3;

const CROWDED_ATTENDEES = 5;
const LONG_EVENT_HOURS = 3;
/** Before this hour, or ending after `LATE_HOUR`, counts as outside normal hours. */
const EARLY_HOUR = 8;
const LATE_HOUR = 19;

export interface SalienceContext {
  /** IANA zone the owner's day is measured in (`agents.timezone`). */
  timeZone: string;
  /**
   * Addresses that count as "the owner or their assistant". Used to find the
   * owner's own RSVP among the attendees and to tell an in-house organizer
   * from an outside one. Compared case-insensitively.
   */
  selfEmails: readonly string[];
}

export interface EventSalience {
  event: BriefingCalendarEvent;
  score: number;
  /** Owner-facing phrases, already written the way the digest should say them. */
  reasons: string[];
}

/** The wall-clock hour in the owner's zone, or null when the timestamp is unusable. */
function localHour(iso: string, timeZone: string): number | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
  }).formatToParts(at);
  const value = Number(hour.find((part) => part.type === 'hour')?.value);
  return Number.isFinite(value) ? value % 24 : null;
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * The calendar adapter renders attendees as `email (responseStatus)`. Parsing
 * it back is unlovely, but it is the shape the port already carries and
 * widening the adapter's return type is a bigger change than this earns.
 * Exported so `calendar-diff.ts` reads the exact same shape rather than
 * growing a second, slightly-different parser.
 */
export function parseAttendee(raw: string): { email: string; status: string } {
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(raw.trim());
  if (!match?.[1]) return { email: raw.trim().toLowerCase(), status: '' };
  return { email: match[1].trim().toLowerCase(), status: (match[2] ?? '').trim().toLowerCase() };
}

/** An organizer field may be `Name <email>` or a bare address. */
function organizerEmail(organizer: string): string {
  const angled = /<([^>]+)>/.exec(organizer);
  return (angled?.[1] ?? organizer).trim().toLowerCase();
}

/**
 * Google mints synthetic organizer addresses for calendars nobody convened: a
 * subscribed ICS feed, a shared group calendar, a bookable room. They are ids,
 * not people, so "<id> called it" is both meaningless to the owner and a leak
 * of an internal identifier into a notification. Treat them as no organizer at
 * all — neither the external-organizer score nor its reason applies.
 */
function isSyntheticOrganizer(email: string): boolean {
  const domain = domainOf(email);
  return domain === 'calendar.google.com' || domain.endsWith('.calendar.google.com');
}

/**
 * What the owner should see for an organizer. A display name when the field
 * carries one, otherwise the bare address; the reason is skipped entirely when
 * neither names a person.
 */
function organizerLabel(organizer: string): string | null {
  const raw = organizer.trim();
  const angled = /^(.*?)\s*<([^>]+)>\s*$/.exec(raw);
  const name = angled?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  // The display name is provider-supplied text, same family as a location —
  // collapsed here, at the point it enters, rather than trusted downstream.
  if (name) return collapseWhitespace(name);
  const email = organizerEmail(raw);
  return email.includes('@') && !isSyntheticOrganizer(email) ? email : null;
}

/**
 * A `location` holding only a link is a video call, not a place to travel to.
 * Conference URLs routinely land in the location field, and treating one as
 * "you need to leave" would nudge the owner about a meeting they take at their
 * desk — the exact false positive the anticipation layer forbids.
 */
function isPhysicalLocation(location: string): boolean {
  const trimmed = location.trim();
  if (trimmed.length === 0) return false;
  const withoutUrls = trimmed.replace(/https?:\/\/[^\s]+/gi, '').trim();
  return withoutUrls.length > 0;
}

export function scoreCalendarEvent(
  event: BriefingCalendarEvent,
  ctx: SalienceContext,
): EventSalience {
  const self = new Set(ctx.selfEmails.map((email) => email.trim().toLowerCase()));
  const selfDomains = new Set([...self].map(domainOf));
  const reasons: string[] = [];
  let score = 0;

  const attendees = (event.attendees ?? []).map(parseAttendee);
  const mine = attendees.find((attendee) => self.has(attendee.email));
  if (
    event.status === 'cancelled' ||
    event.ownerResponse === 'declined' ||
    mine?.status === 'declined'
  )
    return { event, score: 0, reasons: [] };
  if (mine && (mine.status === 'needsaction' || mine.status === '?' || mine.status === '')) {
    score += WEIGHTS.unanswered;
    reasons.push('you have not replied to the invitation');
  }

  if (!event.allDay && isPhysicalLocation(event.location ?? '')) {
    score += WEIGHTS.travel;
    // A Google Calendar location routinely arrives as "Venue\nStreet, City" —
    // collapsed here so the reason stays one line wherever it is later joined
    // into a bullet.
    reasons.push(`it is at ${collapseWhitespace(event.location ?? '')}`);
  }

  if (!event.allDay) {
    const startHour = localHour(event.start, ctx.timeZone);
    const endHour = localHour(event.end, ctx.timeZone);
    if (
      (startHour !== null && startHour < EARLY_HOUR) ||
      (endHour !== null && endHour >= LATE_HOUR)
    ) {
      score += WEIGHTS.unusualHour;
      reasons.push('it falls outside your usual hours');
    }
    const startMs = Date.parse(event.start);
    const endMs = Date.parse(event.end);
    if (
      !Number.isNaN(startMs) &&
      !Number.isNaN(endMs) &&
      endMs - startMs >= LONG_EVENT_HOURS * 3600_000
    ) {
      score += WEIGHTS.long;
      reasons.push('it runs for most of a working block');
    }
  }

  if (event.allDay) {
    score += WEIGHTS.allDay;
    reasons.push('it takes the whole day');
  }

  if (attendees.length >= CROWDED_ATTENDEES) {
    score += WEIGHTS.crowded;
    reasons.push(`${attendees.length} people are on it`);
  }

  const organizer = organizerEmail(event.organizer ?? '');
  if (
    organizer.includes('@') &&
    !self.has(organizer) &&
    !selfDomains.has(domainOf(organizer)) &&
    !isSyntheticOrganizer(organizer)
  ) {
    score += WEIGHTS.externalOrganizer;
    const label = organizerLabel(event.organizer ?? '');
    if (label) reasons.push(`${label} called it`);
  }

  return { event, score, reasons };
}

/**
 * The events worth surfacing, most salient first.
 *
 * Ties break on start time so "soonest" wins, which is what the owner means by
 * important when two things score the same.
 */
export function salientEvents(
  events: ReadonlyArray<BriefingCalendarEvent>,
  ctx: SalienceContext,
): EventSalience[] {
  return events
    .map((event) => scoreCalendarEvent(event, ctx))
    .filter((scored) => scored.score >= SALIENCE_THRESHOLD)
    .sort((a, b) => b.score - a.score || Date.parse(a.event.start) - Date.parse(b.event.start));
}

/**
 * One line per salient event, for the digest's structured notes.
 *
 * `scored.event.start` is the calendar provider's raw string — whatever
 * offset Google happened to return, not the owner's — so it is rendered
 * through `ownerEventWhen` rather than printed as-is. The summary and the
 * joined reasons are collapsed too: a reason built from provider text (a
 * location, an organizer name) can still carry an embedded newline by the
 * time it gets here, and that newline would end the markdown bullet early.
 */
export function describeSalience(scored: EventSalience, timeZone: string): string {
  const when = ownerEventWhen({ start: scored.event.start, allDay: scored.event.allDay }, timeZone);
  const summary = collapseWhitespace(scored.event.summary);
  const reasons = collapseWhitespace(scored.reasons.join('; '));
  return `- ${when}: ${summary} — ${reasons}`;
}
