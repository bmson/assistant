import { createHash } from 'node:crypto';
import type { BriefingCalendarEvent } from '../workflow/briefing.js';
import { parseAttendee } from './calendar-salience.js';

/**
 * Calendar change detection — deterministic, and pure.
 *
 * Both the briefing and the pulse take a fresh, stateless read of the
 * calendar every time: nothing has ever compared one read to the last one, so
 * a meeting the organizer cancelled, an invite someone just declined, and a
 * recurring instance that quietly moved are all invisible. This module is the
 * comparison. It takes the events a read just returned and the last known
 * shape of each (persisted by the caller in `calendar_event_snapshots`), and
 * says what changed — nothing more.
 *
 * No database, no provider client, no model call: same discipline as
 * `calendar-salience.ts`, for the same reason. A "did this change" question
 * answered by a model is a question a model can hallucinate an answer to, and
 * a cancellation that was never actually a cancellation is worse than staying
 * silent (`pulse.ts`'s "no fabricated urgency" rule applies here just as much
 * as it does to the digest text).
 *
 * The one thing this module cannot know, and deliberately does not guess at:
 * whether a fresh read is trustworthy in the first place. That is the
 * caller's job — see the big warning on `diffCalendarEvents` below.
 */

/** Google's event-level status; other providers may send nothing at all. */
const CANCELLED_STATUS = 'cancelled';
/** The only prior RSVP state a "declined" change is judged against. */
const ACCEPTED_STATUS = 'accepted';
const DECLINED_STATUS = 'declined';

/**
 * A per-attendee fingerprint, keyed on a hash of their email rather than the
 * address itself. The snapshot row this lives in is written on every pulse
 * tick and durable for as long as an event stays upcoming — there is no
 * reason for it to also be the one place in the schema holding a plain-text
 * guest list for every meeting the owner has ever had. The diff does not lose
 * anything by hashing: it always re-derives the hash from the CURRENT read's
 * (real, human-readable) attendee list to look itself up, so the owner-facing
 * text still names the real person even though the row at rest does not.
 */
export type AttendeeResponseDigest = Record<string, string>;

/** The last known shape of one event, as persisted in `calendar_event_snapshots`. */
export interface CalendarEventSnapshotRow {
  calendarId: string;
  eventId: string;
  iCalUID: string | null;
  summary: string;
  start: string;
  end: string;
  status: string | null;
  attendeeResponseHash: AttendeeResponseDigest;
}

export type CalendarChangeKind = 'cancelled' | 'moved' | 'declined' | 'unverified';

export interface CalendarChange {
  kind: CalendarChangeKind;
  calendarId: string;
  eventId: string;
  iCalUID: string | null;
  summary: string;
  /** The event's own calendar label, when the change kind still has a live event to read it from. */
  calendar?: string;
  /** Current start for 'moved'/'declined'; last known start for 'cancelled'. */
  start: string;
  end: string;
  /** 'moved' only. */
  previousStart?: string;
  /** 'declined' only — real addresses, read from the CURRENT event, never from the snapshot. */
  declinedEmails?: string[];
}

/** Sixteen hex chars (64 bits) is ample to avoid a collision among one event's attendees. */
function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/** The digest to persist for one event's current attendee list. */
export function attendeeResponseDigest(
  attendees: readonly string[] | undefined,
): AttendeeResponseDigest {
  const digest: AttendeeResponseDigest = {};
  for (const raw of attendees ?? []) {
    const { email, status } = parseAttendee(raw);
    if (!email) continue;
    digest[hashEmail(email)] = status;
  }
  return digest;
}

/**
 * The snapshot row to persist for one currently-read event, or null when the
 * event carries no stable identity to compare against next time — a reader
 * that predates `normalizeEvent` carrying `eventId`/`calendarId`, or a synthetic
 * entry a caller assembled by hand. Nothing can be diffed against an event
 * with no key, so there is nothing useful to store either.
 */
export function toSnapshotRow(
  event: BriefingCalendarEvent,
): (CalendarEventSnapshotRow & { calendarId: string; eventId: string }) | null {
  if (!event.eventId || !event.calendarId) return null;
  return {
    calendarId: event.calendarId,
    eventId: event.eventId,
    iCalUID: event.iCalUID ?? null,
    summary: event.summary,
    start: event.start,
    end: event.end,
    status: event.status ?? null,
    attendeeResponseHash: attendeeResponseDigest(event.attendees),
  };
}

// A structured join rather than a delimited string: an id is provider text of
// unknown shape, and this way no choice of delimiter can ever be the thing
// two different (calendarId, eventId) pairs collide on.
function eventKey(calendarId: string, eventId: string): string {
  return JSON.stringify([calendarId, eventId]);
}

/** Two ISO-ish timestamps naming the same instant, tolerant of offset formatting. */
function sameInstant(a: string, b: string): boolean {
  if (a === b) return true;
  const am = Date.parse(a);
  const bm = Date.parse(b);
  return !Number.isNaN(am) && !Number.isNaN(bm) && am === bm;
}

/** Attendees who show as declined now but were recorded as accepted last time. */
function newlyDeclined(
  previous: AttendeeResponseDigest,
  currentAttendees: readonly string[] | undefined,
): string[] {
  const declined: string[] = [];
  for (const raw of currentAttendees ?? []) {
    const { email, status } = parseAttendee(raw);
    if (!email || status !== DECLINED_STATUS) continue;
    if (previous[hashEmail(email)] === ACCEPTED_STATUS) declined.push(email);
  }
  return declined;
}

/**
 * What changed between the last snapshot and this read.
 *
 * SAFETY CONTRACT — read this before calling it from anywhere new:
 *
 * `previous` empty means "nothing to compare against" (the agent's first
 * calendar read ever, or every prior row has aged out), and produces NO
 * changes — it must never read as "every current event is new news," the
 * same way a briefing with nothing to say stays silent rather than
 * inventing a headline.
 *
 * A window does not establish an event's cancellation. Missing events produce
 * an unverified observation only; callers may augment the current list with
 * authoritative point reads to establish a move or explicit cancellation.
 * Incomplete windows suppress absence notices, while present explicit changes
 * remain valid. A failed read must still skip comparison entirely.
 */
export function diffCalendarEvents(
  current: readonly BriefingCalendarEvent[],
  previous: readonly CalendarEventSnapshotRow[],
  now: Date,
  complete: boolean,
): CalendarChange[] {
  const changes: CalendarChange[] = [];
  const currentByKey = new Map<string, BriefingCalendarEvent>();
  for (const event of current) {
    if (!event.eventId || !event.calendarId) continue;
    currentByKey.set(eventKey(event.calendarId, event.eventId), event);
  }

  for (const prev of previous) {
    // Already told — do not re-derive the same finding from a snapshot row
    // that has not been refreshed since (see `toSnapshotRow`'s caller for why
    // a cancelled row is deleted rather than lingering with this status; this
    // guard is what keeps things correct even if that ever changes).
    if (prev.status === CANCELLED_STATUS) continue;

    const match = currentByKey.get(eventKey(prev.calendarId, prev.eventId));
    if (!match || match.status === CANCELLED_STATUS) {
      if (!match && !complete) continue; // incomplete windows do not even establish disappearance
      const prevStartMs = Date.parse(prev.start);
      // Only a still-upcoming event's disappearance is news. One that simply
      // finished and rolled out of the forward-looking window is routine —
      // the same self-silence rule the rest of proactive follows.
      if (Number.isNaN(prevStartMs) || prevStartMs < now.getTime()) continue;
      changes.push({
        kind: match?.status === CANCELLED_STATUS ? 'cancelled' : 'unverified',
        calendarId: prev.calendarId,
        eventId: prev.eventId,
        iCalUID: prev.iCalUID,
        summary: prev.summary,
        start: prev.start,
        end: prev.end,
      });
      continue;
    }

    if (!sameInstant(match.start, prev.start)) {
      changes.push({
        kind: 'moved',
        calendarId: prev.calendarId,
        eventId: prev.eventId,
        iCalUID: prev.iCalUID ?? match.iCalUID ?? null,
        summary: match.summary,
        calendar: match.calendar,
        start: match.start,
        end: match.end,
        previousStart: prev.start,
      });
    }

    const declinedEmails = newlyDeclined(prev.attendeeResponseHash, match.attendees);
    if (declinedEmails.length > 0) {
      changes.push({
        kind: 'declined',
        calendarId: prev.calendarId,
        eventId: prev.eventId,
        iCalUID: prev.iCalUID ?? match.iCalUID ?? null,
        summary: match.summary,
        calendar: match.calendar,
        start: match.start,
        end: match.end,
        declinedEmails,
      });
    }
  }

  return changes;
}
