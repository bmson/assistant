import { calendarOccurrenceKey, sameCalendarOccurrence } from '@assistant/persistence';
import type { BriefingCalendarEvent } from './briefing.js';
import type { CalendarPlanOptions } from './calendar-plan-intent.js';
import { calendarCivilBoundary, calendarSourceInterval } from './calendar-read-window.js';
import {
  calendarRelationship,
  verifiedOwnerParticipation,
  verifiedPersonalCommitment,
} from './calendar-relationship.js';
import type { ActionEvidence } from './response-contract.js';

const SLOT_MS = 15 * 60_000;
const TRAVEL_MS = 30 * 60_000;
const MAX_EVENT_PAGES = 3;

type PlainRecord = Record<string, unknown>;
type BusyInterval = { start: number; end: number; calendar?: string; calendarId?: string };

function record(value: unknown): PlainRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as PlainRecord)
    : undefined;
}

function dateMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function overlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function mergeIntervals(
  intervals: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = intervals
    .filter(
      (value) =>
        Number.isFinite(value.start) && Number.isFinite(value.end) && value.end > value.start,
    )
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

function subtractIntervals(
  intervals: Array<{ start: number; end: number }>,
  exclusions: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  return intervals.flatMap((interval) => {
    let remaining = [{ ...interval }];
    for (const exclusion of exclusions) {
      remaining = remaining.flatMap((part) => {
        if (!overlap(part, exclusion)) return [part];
        return [
          ...(part.start < exclusion.start ? [{ start: part.start, end: exclusion.start }] : []),
          ...(exclusion.end < part.end ? [{ start: exclusion.end, end: part.end }] : []),
        ];
      });
      if (remaining.length === 0) break;
    }
    return remaining;
  });
}

function localParts(
  at: number,
  timeZone: string,
): { day: string; weekday: number; hour: number; minute: number } | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const get = (type: string) => parts.find((part) => part.type === type)?.value;
    const day = `${get('year')}-${get('month')}-${get('day')}`;
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday') ?? '');
    const hour = Number(get('hour'));
    const minute = Number(get('minute'));
    if (weekday < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
    return { day, weekday, hour, minute };
  } catch {
    return undefined;
  }
}

function labelTime(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(at));
}

function labelDay(day: string): string {
  const at = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(at)) return day;
  return new Intl.DateTimeFormat('en-US', {
    // `day` is already a civil key computed in the owner's zone. Formatting
    // UTC noon in that same zone can shift it across the date line again.
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(at));
}

function resultOf(row: ActionEvidence): PlainRecord | undefined {
  return record(row.result);
}

function successful(row: ActionEvidence): boolean {
  return row.status === 'succeeded' && resultOf(row)?.ok !== false;
}

function strictGoogleCalendarLink(event: PlainRecord): string | undefined {
  const links = Array.isArray(event.links) ? event.links : [];
  for (const item of links) {
    const link = record(item);
    if (link?.type !== 'calendar' || typeof link.url !== 'string') continue;
    try {
      const url = new URL(link.url);
      if (
        url.protocol === 'https:' &&
        ['calendar.google.com', 'www.google.com'].includes(url.hostname) &&
        /event/i.test(url.pathname) &&
        !url.username &&
        !url.password
      )
        return url.href;
    } catch {
      // Ignore malformed or non-Google links.
    }
  }
  return undefined;
}

const unidentifiedEventIds = new WeakMap<object, number>();
let nextUnidentifiedEventId = 0;

function eventIdentity(event: PlainRecord): string {
  if (typeof event._calendarPlanIdentity === 'string') return event._calendarPlanIdentity;
  const canonical = calendarOccurrenceKey(event);
  if (canonical) return canonical;
  let id = unidentifiedEventIds.get(event);
  if (!id) {
    id = ++nextUnidentifiedEventId;
    unidentifiedEventIds.set(event, id);
  }
  return `unidentified:${id}`;
}

function uniqueCanonicalEvents(events: PlainRecord[]): PlainRecord[] {
  const consumed = new Set<number>();
  const result: PlainRecord[] = [];
  for (let start = 0; start < events.length; start += 1) {
    if (consumed.has(start)) continue;
    const first = events[start];
    if (!first) continue;
    if (!calendarOccurrenceKey(first)) {
      consumed.add(start);
      result.push(first);
      continue;
    }
    const component = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const currentIndex = queue.pop();
      const current = currentIndex === undefined ? undefined : events[currentIndex];
      if (!current) continue;
      events.forEach((candidate, index) => {
        if (
          !consumed.has(index) &&
          !component.has(index) &&
          calendarOccurrenceKey(candidate) &&
          sameCalendarOccurrence(current, candidate)
        ) {
          component.add(index);
          queue.push(index);
        }
      });
    }
    for (const index of component) consumed.add(index);
    const members = [...component]
      .sort((a, b) => a - b)
      .flatMap((index) => {
        const event = events[index];
        return event ? [event] : [];
      });
    const isClique = members.every((left, leftIndex) =>
      members.every(
        (right, rightIndex) => leftIndex === rightIndex || sameCalendarOccurrence(left, right),
      ),
    );
    if (members.length < 2 || !isClique) {
      const ambiguity = `ambiguous:${members
        .map((event) => calendarOccurrenceKey(event))
        .sort()
        .join('|')}`;
      result.push(
        ...members.map((event, index) => ({
          ...event,
          _calendarPlanIdentity: `${ambiguity}:${index}`,
          ...(members.length > 1 ? { _canonicalIdentityAmbiguity: ambiguity } : {}),
        })),
      );
      continue;
    }
    const firstEvent = members[0];
    if (!firstEvent) continue;
    const sourceVariants = members.flatMap((event) =>
      Array.isArray(event.sourceVariants)
        ? event.sourceVariants.map(record).filter((value): value is PlainRecord => Boolean(value))
        : [event],
    );
    const statuses = [...new Set(sourceVariants.map((event) => verifiedOwnerParticipation(event)))];
    const ownerStatus = statuses.length === 1 ? statuses[0] : 'unknown';
    const busyValues = sourceVariants.map((event) => event.blocksTime);
    const blocksTime = busyValues.every((value) => value === true)
      ? true
      : busyValues.every((value) => value === false)
        ? false
        : undefined;
    const purposes = sourceVariants.map((event) =>
      event.calendarPurpose === 'commitments' || event.calendarPurpose === 'reference'
        ? event.calendarPurpose
        : 'unspecified',
    );
    const calendarPurpose = purposes.every((purpose) => purpose === 'commitments')
      ? 'commitments'
      : purposes.includes('reference')
        ? 'reference'
        : 'unspecified';
    const differs = (field: string) =>
      new Set(
        sourceVariants.map((event) => {
          const value = event[field];
          if ((field === 'start' || field === 'end') && typeof value === 'string') {
            const instant = dateMs(value);
            return instant ?? value;
          }
          return value ?? '';
        }),
      ).size > 1;
    const sourceIntegrity =
      ['summary', 'location', 'start', 'end', 'status', 'blocksTime', 'calendarPurpose'].some(
        differs,
      ) || statuses.length > 1
        ? 'disputed'
        : 'consistent';
    result.push({
      ...firstEvent,
      _calendarPlanIdentity: `canonical:${calendarOccurrenceKey(firstEvent)}`,
      sourceVariants,
      blocksTime,
      calendarPurpose,
      sourceIntegrity,
      ...(new Set(sourceVariants.map((event) => event.status ?? '')).size === 1 &&
      typeof firstEvent.status === 'string'
        ? { status: firstEvent.status }
        : { status: undefined }),
      ...(ownerStatus !== 'unknown'
        ? {
            ownerParticipation: {
              status: ownerStatus,
              identityVerified: true,
              basis: 'attendee-email',
            },
          }
        : {
            ownerParticipation: {
              status: 'unknown',
              identityVerified: false,
              basis: 'unverified',
            },
          }),
    });
  }
  return result;
}

function relationshipEvent(event: PlainRecord): BriefingCalendarEvent {
  return {
    summary: safeText(event.summary, 100),
    start: typeof event.start === 'string' ? event.start : '',
    end: typeof event.end === 'string' ? event.end : '',
    calendar: safeText(event.calendar, 100),
    allDay: event.allDay === true,
    ...(typeof event.calendarId === 'string' ? { calendarId: event.calendarId } : {}),
    ...(typeof event.eventId === 'string' ? { eventId: event.eventId } : {}),
    ...(typeof event.iCalUID === 'string' ? { iCalUID: event.iCalUID } : {}),
    ...(typeof event.recurringEventId === 'string'
      ? { recurringEventId: event.recurringEventId }
      : {}),
    ...(typeof event.originalStartTime === 'string'
      ? { originalStartTime: event.originalStartTime }
      : {}),
    ...(typeof event.status === 'string' ? { status: event.status } : {}),
    ...(typeof event.blocksTime === 'boolean' ? { blocksTime: event.blocksTime } : {}),
    ...(typeof event.ownerResponse === 'string' ? { ownerResponse: event.ownerResponse } : {}),
    ...(event.ownerParticipation && typeof event.ownerParticipation === 'object'
      ? {
          ownerParticipation:
            event.ownerParticipation as BriefingCalendarEvent['ownerParticipation'],
        }
      : {}),
    ...(event.calendarPurpose === 'commitments' || event.calendarPurpose === 'reference'
      ? { calendarPurpose: event.calendarPurpose }
      : {}),
    ...(typeof event.location === 'string' ? { location: event.location } : {}),
    ...(typeof event.description === 'string' ? { description: event.description } : {}),
  };
}

function planWorkingDays(
  start: number,
  end: number,
  timeZone: string,
  count: number | undefined,
): Array<{ day: string; start: number; end: number }> | undefined {
  if (!count) return undefined;
  const localStart = localParts(start, timeZone)?.day;
  if (!localStart) return [];
  const cursor = new Date(`${localStart}T12:00:00.000Z`);
  if (!Number.isFinite(cursor.getTime())) return [];
  const days: Array<{ day: string; start: number; end: number }> = [];
  for (let attempts = 0; attempts < 370 && days.length < count; attempts += 1) {
    const day = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getUTCDay();
    const next = new Date(cursor);
    next.setUTCDate(next.getUTCDate() + 1);
    const dayStart = calendarCivilBoundary(day, timeZone);
    const dayEnd = calendarCivilBoundary(next.toISOString().slice(0, 10), timeZone);
    if (
      weekday !== 0 &&
      weekday !== 6 &&
      dayStart !== undefined &&
      dayEnd !== undefined &&
      dayStart < end &&
      dayEnd > start
    )
      days.push({ day, start: Math.max(start, dayStart), end: Math.min(end, dayEnd) });
    if (dayStart !== undefined && dayStart >= end) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function attendance(event: PlainRecord): 'attending' | 'potential' | 'not-attending' {
  if (
    event.status === 'cancelled' ||
    verifiedOwnerParticipation(event) === 'declined' ||
    event.blocksTime === false
  )
    return 'not-attending';
  if (verifiedPersonalCommitment(event)) return 'attending';
  if (verifiedOwnerParticipation(event) === 'tentative') return 'potential';
  return event.blocksTime === true ? 'potential' : 'not-attending';
}

function parseEventInterval(event: PlainRecord): { start: number; end: number } | undefined {
  const start = dateMs(event.start);
  const end = dateMs(event.end);
  return start !== undefined && end !== undefined && end > start ? { start, end } : undefined;
}

function isExtendedContext(interval: { start: number; end: number }): boolean {
  return interval.end - interval.start >= 18 * 60 * 60_000;
}

function hasExplicitLodgingDetails(event: PlainRecord): boolean {
  const metadata = record(event.sourceMetadata);
  const source = record(event.source);
  const details = [
    event.summary,
    event.description,
    event.source,
    event.sourceType,
    event.category,
    metadata?.type,
    metadata?.category,
    metadata?.description,
    source?.type,
    source?.category,
    source?.description,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  const explicitStayOrReservation =
    /\b(?:hotel|lodging|accommodation|hostel|resort|airbnb)\s+(?:reservation|booking|stay)\b/i.test(
      details,
    ) || /\b(?:overnight|multi[- ]night)\s+(?:hotel\s+)?stay\b/i.test(details);
  return (
    explicitStayOrReservation &&
    /\bcheck[ -]?in\b/i.test(details) &&
    /\bcheck[ -]?out\b/i.test(details)
  );
}

function isExtendedLodging(event: PlainRecord, interval: { start: number; end: number }): boolean {
  if (!isExtendedContext(interval)) return false;
  const start = typeof event.start === 'string' ? event.start : '';
  const end = typeof event.end === 'string' ? event.end : '';
  const explicitInstant = (value: string) =>
    /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && dateMs(value) !== undefined;
  return explicitInstant(start) && explicitInstant(end) && hasExplicitLodgingDetails(event);
}

function isExtendedAllDayLodging(event: PlainRecord): boolean {
  if (event.allDay !== true || !hasExplicitLodgingDetails(event)) return false;
  const interval = calendarSourceInterval(event);
  return interval !== undefined && isExtendedContext(interval);
}

/**
 * A complete event listing can explain a free/busy interval that represents a
 * multi-day lodging record. This is used only to generate conditional review
 * candidates; the provider's busy result is retained and disclosed.
 */
function lodgingExplanationForBusy(
  busy: BusyInterval,
  events: PlainRecord[],
  availabilityResult: PlainRecord | undefined,
  eventComplete: boolean,
): PlainRecord | undefined {
  if (!eventComplete || !busy.calendar) return undefined;
  const identityCoverage = Array.isArray(availabilityResult?.calendarCoverage)
    ? availabilityResult.calendarCoverage
    : [];
  if (
    busy.calendarId &&
    identityCoverage.filter((value) => record(value)?.calendarId === busy.calendarId).length !== 1
  )
    return undefined;
  const checked = busy.calendarId
    ? [busy.calendarId]
    : Array.isArray(availabilityResult?.calendarsChecked)
      ? availabilityResult.calendarsChecked.filter((value) => value === busy.calendar)
      : [];
  if (checked.length !== 1) return undefined;

  const calendarEvents = events.filter((event) =>
    busy.calendarId
      ? event.calendarId === busy.calendarId
      : event.calendar === busy.calendar || event.calendarId === busy.calendar,
  );
  if (calendarEvents.length === 0) return undefined;
  const calendarIdentities = new Set(
    calendarEvents
      .map((event) =>
        typeof event.calendarId === 'string'
          ? event.calendarId
          : typeof event.calendar === 'string'
            ? event.calendar
            : '',
      )
      .filter(Boolean),
  );
  if (calendarIdentities.size !== 1) return undefined;

  const lodging = calendarEvents.filter((event) => {
    const interval =
      event.allDay === true ? calendarSourceInterval(event) : parseEventInterval(event);
    return (
      interval !== undefined &&
      attendance(event) !== 'not-attending' &&
      interval.start <= busy.start &&
      interval.end >= busy.end &&
      (event.allDay === true ? isExtendedAllDayLodging(event) : isExtendedLodging(event, interval))
    );
  });
  if (lodging.length === 0) return undefined;

  // A separate event on the same calendar may be hidden inside the provider's
  // merged busy interval. Keep that interval blocking unless all such events
  // are themselves identified lodging records.
  const blockingOthers = calendarEvents.filter((event) => {
    const interval = parseEventInterval(event);
    return (
      !lodging.includes(event) &&
      attendance(event) !== 'not-attending' &&
      (event.allDay === true || (interval !== undefined && overlap(interval, busy)))
    );
  });
  // These timed events are independently added to eventBusy below. Keep the
  // provider interval blocking when an overlapping item cannot be rebuilt as
  // an exact instant interval (notably all-day or offsetless local events).
  // This lets a complete event listing explain a long stay interval without
  // erasing a flight or meeting that happens during the stay.
  if (
    blockingOthers.some((event) => {
      if (event.allDay === true) return true;
      const start = typeof event.start === 'string' ? event.start : '';
      const end = typeof event.end === 'string' ? event.end : '';
      const explicitInstant = (value: string) =>
        /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && dateMs(value) !== undefined;
      return !explicitInstant(start) || !explicitInstant(end);
    })
  )
    return undefined;
  const declinedBusyEvent = calendarEvents.some((event) => {
    if (
      lodging.includes(event) ||
      event.status === 'cancelled' ||
      event.blocksTime === false ||
      verifiedOwnerParticipation(event) !== 'declined'
    )
      return false;
    const interval =
      event.allDay === true ? calendarSourceInterval(event) : parseEventInterval(event);
    return interval === undefined ? event.allDay === true : overlap(interval, busy);
  });
  if (declinedBusyEvent) return undefined;
  return lodging[0];
}

/** Recover only provider-unavailable IDs from a complete, exact-window event ledger.
 * Missing identity/roster, malformed data and unknown transparency fail closed.
 * Returned provider busy intervals remain authoritative and are never removed here.
 */
function recoverUnavailableCalendarBusy(
  availability: PlainRecord | undefined,
  eventRows: ActionEvidence[],
  eventComplete: boolean,
  events: PlainRecord[],
  timeMin: string,
  timeMax: string,
): { names: string[]; busy: BusyInterval[] } | undefined {
  const window = record(availability?.coverageWindow);
  const requested = availability?.calendarIdsRequested;
  const coverage = availability?.calendarCoverage;
  if (
    !eventComplete ||
    availability?.complete !== false ||
    availability.calendarRosterComplete !== true ||
    availability.calendarRosterNextPageToken !== undefined ||
    window?.timeMin !== timeMin ||
    window.timeMax !== timeMax ||
    !Array.isArray(requested) ||
    requested.length === 0 ||
    !requested.every((id) => typeof id === 'string' && id.length > 0) ||
    new Set(requested).size !== requested.length ||
    !Array.isArray(coverage) ||
    coverage.length !== requested.length
  )
    return undefined;
  const byId = new Map<string, PlainRecord>();
  for (const value of coverage) {
    const item = record(value);
    if (
      !item ||
      typeof item.calendarId !== 'string' ||
      !requested.includes(item.calendarId) ||
      byId.has(item.calendarId) ||
      typeof item.name !== 'string' ||
      !item.name ||
      !['checked', 'unavailable'].includes(String(item.status))
    )
      return undefined;
    byId.set(item.calendarId, item);
  }
  const failed = [...byId.values()].filter((item) => item.status === 'unavailable');
  if (failed.length === 0) return undefined;
  for (const row of eventRows) {
    const result = resultOf(row);
    const ids = result?.calendarsSearchedIds;
    const resolved = result?.calendarsResolved;
    if (
      result?.calendarRosterComplete !== true ||
      !Array.isArray(result.unavailable) ||
      result.unavailable.length !== 0 ||
      result.paginationUnavailable === true ||
      result.calendarRosterNextPageToken !== undefined ||
      !Array.isArray(ids) ||
      ids.length !== requested.length ||
      new Set(ids).size !== ids.length ||
      !requested.every((id) => ids.includes(id)) ||
      !Array.isArray(resolved) ||
      resolved.length !== requested.length ||
      new Set(resolved.map((item) => record(item)?.id)).size !== requested.length ||
      !requested.every((id) => resolved.some((item) => record(item)?.id === id))
    )
      return undefined;
  }
  const recovered: BusyInterval[] = [];
  for (const event of events) {
    const id = typeof event.calendarId === 'string' ? event.calendarId : '';
    // Validate every row: a malformed or unidentified row cannot establish a
    // complete source, even if it purports to be transparent or cancelled.
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(event.start));
    const instant = (value: unknown) =>
      typeof value === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
    const interval = calendarSourceInterval(event);
    if (
      !byId.has(id) ||
      typeof event.blocksTime !== 'boolean' ||
      !interval ||
      (event.allDay === true && !dateOnly) ||
      (dateOnly && event.allDay !== true) ||
      (!dateOnly && (!instant(event.start) || !instant(event.end)))
    )
      return undefined;
    if (
      byId.get(id)?.status !== 'unavailable' ||
      event.blocksTime === false ||
      event.status === 'cancelled'
    )
      continue;
    recovered.push({ ...interval, calendar: String(byId.get(id)?.name), calendarId: id });
  }
  return { names: failed.map((item) => safeText(item.name, 100)), busy: recovered };
}

export interface WeeklyCalendarPlanResult {
  text: string;
  coverageComplete: boolean;
  slotCount: number;
}

function eventTitle(event: PlainRecord): string {
  return safeText(event.summary, 100) || 'Untitled event';
}

function calendarSourceLabel(event: PlainRecord): string {
  return eventTitle(event)
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*');
}

function calendarSourceReference(event: PlainRecord): string {
  const title = calendarSourceLabel(event);
  const url = strictGoogleCalendarLink(event);
  return url ? `[${title}](<${url}>)` : `**${title}**`;
}

export interface WeeklyCalendarPlanInput {
  timeMin: string;
  timeMax: string;
  timeZone?: string;
  evidence: ActionEvidence[];
  plan?: CalendarPlanOptions;
}

/** A deterministic, review-only proposal. It never schedules or edits events. */
export function weeklyCalendarPlanResult(input: WeeklyCalendarPlanInput): WeeklyCalendarPlanResult {
  const result = (
    text: string,
    coverageComplete = false,
    slotCount = 0,
  ): WeeklyCalendarPlanResult => ({
    text,
    coverageComplete,
    slotCount,
  });
  if (
    input.plan &&
    (!Number.isInteger(input.plan.focusMinutes) ||
      input.plan.focusMinutes < 15 ||
      input.plan.focusMinutes > 240 ||
      !Number.isInteger(input.plan.slotCount) ||
      input.plan.slotCount < 1 ||
      input.plan.slotCount > 10 ||
      !Number.isInteger(input.plan.breakMinutes) ||
      input.plan.breakMinutes < 0 ||
      input.plan.breakMinutes > 60 ||
      (input.plan.meetingBufferMinutes !== undefined &&
        (!Number.isInteger(input.plan.meetingBufferMinutes) ||
          input.plan.meetingBufferMinutes < 0 ||
          input.plan.meetingBufferMinutes > 60)))
  )
    return result(
      'I couldn’t safely resolve the requested focus duration, count, or breaks. Please confirm those constraints.',
    );
  const focusMs = (input.plan?.focusMinutes ?? 90) * 60_000;
  const breakMs = (input.plan?.breakMinutes ?? 15) * 60_000;
  const requestedSlots = input.plan?.slotCount ?? 3;
  const windowLabel = input.plan?.windowLabel ?? 'next week';
  const start = dateMs(input.timeMin);
  const end = dateMs(input.timeMax);
  if (start === undefined || end === undefined || end <= start)
    return result(
      `I couldn’t resolve a safe calendar window for ${windowLabel}. Please check your calendar settings and ask me to try again.`,
    );
  if (!input.timeZone)
    return result(
      `I can review ${windowLabel}, but your time zone is unavailable, so I can’t safely suggest focus times. Please confirm your time zone first.`,
    );
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone }).format(new Date(start));
  } catch {
    return result(
      `I can review ${windowLabel}, but your time zone setting is invalid, so I can’t safely suggest focus times.`,
    );
  }
  const timeZone = input.timeZone;
  const selectedWorkingDays = planWorkingDays(start, end, timeZone, input.plan?.workingDays);
  const selectedWorkingDayKeys = selectedWorkingDays
    ? new Set(selectedWorkingDays.map(({ day }) => day))
    : undefined;

  const availabilityRows = input.evidence.filter((row) => {
    const args = record(row.args);
    return (
      row.toolName === 'calendar.availability' &&
      successful(row) &&
      args?.timeMin === input.timeMin &&
      args?.timeMax === input.timeMax
    );
  });
  const availability = availabilityRows.at(-1);
  const availabilityResult = availability ? resultOf(availability) : undefined;
  const busyRaw = availabilityResult?.busy;
  const providerMalformed =
    Array.isArray(availabilityResult?.calendarCoverage) &&
    availabilityResult.calendarCoverage.some((value) => record(value)?.status === 'malformed');
  const busyValid =
    !providerMalformed &&
    Array.isArray(busyRaw) &&
    busyRaw.every((value) => {
      const item = record(value);
      return (
        dateMs(item?.start) !== undefined &&
        dateMs(item?.end) !== undefined &&
        (dateMs(item?.end) as number) > (dateMs(item?.start) as number)
      );
    });
  const busy: BusyInterval[] = busyValid
    ? (busyRaw as unknown[]).flatMap((value) => {
        const item = record(value);
        const interval = item
          ? {
              start: dateMs(item.start) as number,
              end: dateMs(item.end) as number,
              ...(typeof item.calendar === 'string' ? { calendar: item.calendar } : {}),
              ...(typeof item.calendarId === 'string' ? { calendarId: item.calendarId } : {}),
            }
          : undefined;
        return interval ? [interval] : [];
      })
    : [];

  const eventRows = input.evidence.filter((row) => {
    const args = record(row.args);
    return (
      row.toolName === 'calendar.list_events' &&
      successful(row) &&
      args?.timeMin === input.timeMin &&
      args?.timeMax === input.timeMax
    );
  });
  const allPages = eventRows.slice(0, MAX_EVENT_PAGES);
  const events: PlainRecord[] = [];
  let eventRowsValid = allPages.length > 0;
  let unresolvedAllDayBlockingEvent = false;
  for (const row of allPages) {
    const result = resultOf(row);
    if (!Array.isArray(result?.events)) {
      eventRowsValid = false;
      continue;
    }
    for (const value of result.events) {
      const event = record(value);
      if (!event || !parseEventInterval(event)) {
        eventRowsValid = false;
        continue;
      }
      if (
        event.allDay === true &&
        attendance(event) !== 'not-attending' &&
        !calendarSourceInterval(event)
      ) {
        eventRowsValid = false;
        unresolvedAllDayBlockingEvent = true;
      }
      events.push(event);
    }
  }

  const uniqueEvents = uniqueCanonicalEvents(events);
  const availabilityComplete =
    busyValid &&
    availabilityResult?.complete === true &&
    (availabilityResult.unavailable === undefined ||
      (Array.isArray(availabilityResult.unavailable) &&
        availabilityResult.unavailable.length === 0));
  const lastPage = allPages.at(-1);
  const lastEventResult = lastPage ? resultOf(lastPage) : undefined;
  let expectedPageToken: string | undefined;
  const pageSequenceValid = allPages.every((row) => {
    const args = record(row.args);
    const matches = (args?.pageToken || undefined) === expectedPageToken;
    const result = resultOf(row);
    const next = result?.nextPageToken;
    expectedPageToken = typeof next === 'string' && next.length > 0 ? next : undefined;
    return matches;
  });
  const eventComplete =
    eventRowsValid &&
    allPages.length > 0 &&
    pageSequenceValid &&
    lastEventResult?.complete === true &&
    lastEventResult.calendarRosterComplete === true &&
    Array.isArray(lastEventResult.unavailable) &&
    lastEventResult.unavailable.length === 0 &&
    typeof lastEventResult.nextPageToken !== 'string' &&
    lastEventResult.paginationUnavailable !== true;
  const unavailableCalendars = [
    ...(Array.isArray(availabilityResult?.unavailable) ? availabilityResult.unavailable : []),
    ...allPages.flatMap((row) => {
      const unavailable = resultOf(row)?.unavailable;
      return Array.isArray(unavailable)
        ? unavailable.flatMap((value) => {
            if (typeof value === 'string') return [value];
            const name = record(value)?.calendar;
            return typeof name === 'string' ? [name] : [];
          })
        : [];
    }),
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => safeText(value, 100))
    .filter(Boolean)
    .slice(0, 5);
  const recoveredCoverage = busyValid
    ? recoverUnavailableCalendarBusy(
        availabilityResult,
        allPages,
        eventComplete,
        events,
        input.timeMin,
        input.timeMax,
      )
    : undefined;
  if (recoveredCoverage) busy.push(...recoveredCoverage.busy);
  const complete = (availabilityComplete || recoveredCoverage !== undefined) && eventComplete;

  const eventBusy: Array<{ start: number; end: number }> = [];
  const workloadEventBusy: Array<{ start: number; end: number }> = [];
  const eventBusySources: Array<{
    event: PlainRecord;
    interval: { start: number; end: number };
  }> = [];
  let travelBufferCount = 0;
  let potentialTravelBufferCount = 0;
  const reserveTravelBuffers = input.plan?.includeTravelBuffers ?? true;
  for (const event of events) {
    const interval = parseEventInterval(event);
    if (
      !interval ||
      attendance(event) === 'not-attending' ||
      event.allDay === true ||
      isExtendedLodging(event, interval)
    )
      continue;
    const location = typeof event.location === 'string' && event.location.trim().length > 0;
    const hasVideo =
      Array.isArray(event.links) && event.links.some((value) => record(value)?.type === 'video');
    const remoteLocation =
      typeof event.location === 'string' &&
      /(?:https?:\/\/|\b(?:online|virtual|remote|zoom|teams|google meet|video call)\b)/i.test(
        event.location,
      );
    const inPerson = location && !hasVideo && !remoteLocation;
    const reserveTravel = inPerson && reserveTravelBuffers;
    if (reserveTravel) travelBufferCount += 1;
    if (reserveTravel && attendance(event) === 'potential') potentialTravelBufferCount += 1;
    const meetingBufferMs = (input.plan?.meetingBufferMinutes ?? 0) * 60_000;
    const surroundingBufferMs = meetingBufferMs + (reserveTravel ? TRAVEL_MS : 0);
    const blockingInterval = {
      start: Math.max(start, interval.start - surroundingBufferMs),
      end: Math.min(end, interval.end + surroundingBufferMs),
    };
    eventBusy.push(blockingInterval);
    const sourceInterval = {
      start: Math.max(start, interval.start),
      end: Math.min(end, interval.end),
    };
    if (sourceInterval.end > sourceInterval.start) workloadEventBusy.push(sourceInterval);
    eventBusySources.push({ event, interval: blockingInterval });
  }
  const explainedLodgingBusy = new Map<BusyInterval, PlainRecord>();
  for (const interval of busy) {
    const lodging = lodgingExplanationForBusy(
      interval,
      uniqueEvents,
      availabilityResult,
      eventComplete,
    );
    if (lodging) explainedLodgingBusy.set(interval, lodging);
  }
  const candidateBusy = busy.filter((interval) => !explainedLodgingBusy.has(interval));
  const allDayBusySources = uniqueEvents.flatMap((event) => {
    if (
      event.allDay !== true ||
      attendance(event) === 'not-attending' ||
      isExtendedAllDayLodging(event)
    )
      return [];
    const interval = calendarSourceInterval(event);
    // Only attribute a focus block to an all-day event when its source-local
    // date can be resolved. An unresolved blocking row still closes focus
    // windows conservatively below, but must not be presented as a proven
    // overlap on a guessed date.
    if (!interval) return [];
    const bounded = { start: Math.max(start, interval.start), end: Math.min(end, interval.end) };
    return bounded.end > bounded.start ? [{ event, interval: bounded }] : [];
  });
  const allDayEventBusy = allDayBusySources.map(({ interval }) => interval);
  if (unresolvedAllDayBlockingEvent) allDayEventBusy.push({ start, end });
  const busyMerged = mergeIntervals([...candidateBusy, ...eventBusy, ...allDayEventBusy]);
  // All-day holds and identified multi-day lodging still block focus selection,
  // but are not meeting workload. Subtract only the calendar-source spans we
  // can identify; timed meetings are added back from their exact event spans.
  const workloadBusyMerged = mergeIntervals([
    ...subtractIntervals(
      candidateBusy,
      allDayBusySources.map(({ interval }) => interval),
    ),
    ...workloadEventBusy,
  ]);
  const potentialFocusIntervals: Array<{ start: number; end: number }> = [];

  const dayStats = new Map<
    string,
    {
      busyMs: number;
      candidates: Array<{ start: number; end: number; lodgingConditions: string[] }>;
    }
  >();
  for (let at = start; at + focusMs + breakMs <= end; at += SLOT_MS) {
    const parts = localParts(at, input.timeZone);
    if (
      !parts ||
      parts.weekday === 0 ||
      parts.weekday === 6 ||
      (selectedWorkingDayKeys && !selectedWorkingDayKeys.has(parts.day)) ||
      parts.hour < 9 ||
      parts.hour >= 17
    )
      continue;
    const day = dayStats.get(parts.day) ?? { busyMs: 0, candidates: [] };
    dayStats.set(parts.day, day);
    const focusEnd = at + focusMs;
    const occupiedEnd = focusEnd + breakMs;
    const endParts = localParts(occupiedEnd, input.timeZone);
    if (
      !endParts ||
      endParts.day !== parts.day ||
      endParts.weekday >= 6 ||
      endParts.hour > 17 ||
      (endParts.hour === 17 && endParts.minute > 0)
    )
      continue;
    const candidate = { start: at, end: occupiedEnd };
    potentialFocusIntervals.push(candidate);
    if (busyValid && !busyMerged.some((interval) => overlap(interval, candidate))) {
      const lodgingConditions = [
        ...new Set(
          busy
            .filter(
              (interval) => explainedLodgingBusy.has(interval) && overlap(interval, candidate),
            )
            .flatMap((interval) => {
              const lodging = explainedLodgingBusy.get(interval);
              return lodging ? [eventTitle(lodging)] : [];
            }),
        ),
      ];
      day.candidates.push({ ...candidate, lodgingConditions });
    }
  }

  for (let at = start; at < end; at += SLOT_MS) {
    const parts = localParts(at, input.timeZone);
    if (
      !parts ||
      parts.weekday === 0 ||
      parts.weekday === 6 ||
      (selectedWorkingDayKeys && !selectedWorkingDayKeys.has(parts.day)) ||
      parts.hour < 9 ||
      parts.hour >= 17
    )
      continue;
    const stats = dayStats.get(parts.day);
    if (
      stats &&
      workloadBusyMerged.some((interval) => interval.start < at + SLOT_MS && at < interval.end)
    )
      stats.busyMs += SLOT_MS;
  }

  const rankedDays = [...dayStats.entries()]
    .filter(([, stats]) => stats.candidates.length > 0)
    .sort((a, b) => a[1].busyMs - b[1].busyMs || a[0].localeCompare(b[0]));
  const chosen: Array<{ start: number; end: number; lodgingConditions: string[] }> = [];
  for (const [, stats] of rankedDays) {
    if (chosen.length >= requestedSlots) break;
    const first = stats.candidates[0];
    if (first) chosen.push(first);
  }
  if (chosen.length < requestedSlots) {
    const remaining = rankedDays
      .flatMap(([day, stats]) =>
        stats.candidates.map((candidate) => ({ day, candidate, busyMs: stats.busyMs })),
      )
      .sort((a, b) => a.busyMs - b.busyMs || a.candidate.start - b.candidate.start);
    for (const item of remaining) {
      if (chosen.length >= requestedSlots) break;
      if (chosen.some((selected) => overlap(selected, item.candidate))) continue;
      chosen.push(item.candidate);
    }
  }
  chosen.sort((a, b) => a.start - b.start);

  const conflictPairs: string[] = [];
  const duplicateListingPairs: string[] = [];
  const probableDuplicatePairs = new Set<string>();
  const ambiguityGroups = new Set(
    uniqueEvents
      .map((event) => event._canonicalIdentityAmbiguity)
      .filter((value): value is string => typeof value === 'string'),
  );
  for (const ambiguity of ambiguityGroups) {
    const variants = uniqueEvents.filter(
      (event) => event._canonicalIdentityAmbiguity === ambiguity,
    );
    duplicateListingPairs.push(
      `Calendar occurrence identity is ambiguous across ${variants.map(calendarSourceReference).join('; ')}. All records are retained separately; confirm which entries represent the same occurrence before treating their overlap as a personal conflict.`,
    );
  }
  for (const event of uniqueEvents) {
    const variants = Array.isArray(event.sourceVariants)
      ? event.sourceVariants.map(record).filter((value): value is PlainRecord => Boolean(value))
      : [];
    if (variants.length < 2) continue;
    const differingFields = [
      'summary',
      'start',
      'end',
      'status',
      'blocksTime',
      'calendarPurpose',
    ].filter(
      (field) =>
        new Set(
          variants.map((variant) =>
            field === 'start' || field === 'end'
              ? (dateMs(variant[field]) ?? variant[field])
              : variant[field],
          ),
        ).size > 1,
    );
    if (new Set(variants.map((variant) => verifiedOwnerParticipation(variant))).size > 1)
      differingFields.push('verified owner response');
    if (differingFields.length > 0) {
      duplicateListingPairs.push(
        `Canonical calendar copies differ in ${differingFields.join(', ')} for ${eventTitle(event)}. Both source variants are retained for review: ${variants.map(calendarSourceReference).join('; ')}.`,
      );
    }
  }
  const conflictEvents = uniqueEvents
    .filter((event) => attendance(event) !== 'not-attending' && event.allDay !== true)
    .map((event) => ({ event, interval: parseEventInterval(event), presence: attendance(event) }))
    .filter(
      (
        item,
      ): item is {
        event: PlainRecord;
        interval: { start: number; end: number };
        presence: 'attending' | 'potential';
      } =>
        Boolean(item.interval) &&
        !isExtendedLodging(item.event, item.interval as { start: number; end: number }),
    );
  for (let i = 0; i < conflictEvents.length; i += 1) {
    for (let j = i + 1; j < conflictEvents.length; j += 1) {
      const left = conflictEvents[i];
      const right = conflictEvents[j];
      if (
        !left ||
        !right ||
        eventIdentity(left.event) === eventIdentity(right.event) ||
        !overlap(left.interval, right.interval)
      )
        continue;
      if (
        typeof left.event._canonicalIdentityAmbiguity === 'string' &&
        left.event._canonicalIdentityAmbiguity === right.event._canonicalIdentityAmbiguity
      )
        continue;
      const pair = `${eventTitle(left.event)} and ${eventTitle(right.event)}`;
      const overlappingInterval = {
        start: Math.max(left.interval.start, right.interval.start, start),
        end: Math.min(left.interval.end, right.interval.end, end),
      };
      if (
        overlappingInterval.end <= overlappingInterval.start ||
        (selectedWorkingDays &&
          !selectedWorkingDays.some(
            (day) => day.start < overlappingInterval.end && overlappingInterval.start < day.end,
          ))
      )
        continue;
      const relationship = calendarRelationship(
        relationshipEvent(left.event),
        relationshipEvent(right.event),
      );
      if (relationship === 'probable_duplicate') {
        const pairKey = [eventIdentity(left.event), eventIdentity(right.event)].sort().join('\0');
        if (!probableDuplicatePairs.has(pairKey)) {
          probableDuplicatePairs.add(pairKey);
          duplicateListingPairs.push(
            `Possible duplicate listing: ${pair} (${labelTime(overlappingInterval.start, input.timeZone)}); occurrence identity unverified. Sources: ${calendarSourceReference(left.event)}; ${calendarSourceReference(right.event)}.\n  - Next: verify whether these entries are one occurrence.`,
          );
        }
        continue;
      }
      const verified = left.presence === 'attending' && right.presence === 'attending';
      const uncertainLongContext =
        (isExtendedContext(left.interval) && !isExtendedLodging(left.event, left.interval)) ||
        (isExtendedContext(right.interval) && !isExtendedLodging(right.event, right.interval));
      const uncertain = [left, right].filter((item) => item.presence === 'potential');
      const overlapQualification =
        verified && uncertainLongContext
          ? 'Both entries have verified evidence as busy personal commitments, but a long event span may not represent simultaneous attendance.'
          : verified
            ? 'Both entries have verified evidence as busy personal commitments.'
            : uncertain.length === 2
              ? 'Attendance for both is unconfirmed.'
              : `Attendance is unconfirmed for ${eventTitle(uncertain[0]?.event ?? right.event)}.`;
      let nextStep: string;
      if (verified && !uncertainLongContext) {
        nextStep =
          'Next: choose which invite to keep and ask the other organizer whether it can move.';
      } else if (uncertainLongContext && uncertain.length === 0) {
        nextStep =
          'Next: verify the actual occurrence times for both invites before treating this long-span overlap as a conflict.';
      } else {
        nextStep = `Next: confirm ${uncertain.length === 2 ? 'attendance for both' : 'that attendance'}; if you will attend both, choose which to keep and ask the other organizer whether it can move.`;
      }
      conflictPairs.push(
        `${verified && !uncertainLongContext ? 'Scheduling conflict' : 'Possible overlap'}: ${pair} (${labelTime(Math.max(left.interval.start, right.interval.start), input.timeZone)}). ${overlapQualification} Sources: ${calendarSourceReference(left.event)}; ${calendarSourceReference(right.event)}.\n  - ${nextStep}`,
      );
    }
  }

  const overloads = [...dayStats.entries()]
    .filter(([, stats]) => stats.busyMs >= 6 * 60 * 60_000)
    .map(([day]) => `${labelDay(day)}: at least 6 merged busy hours (9–5 heuristic)`);
  const eveningStats = new Map<string, { busyMs: number; events: Map<string, PlainRecord> }>();
  for (let at = start; at + SLOT_MS <= end; at += SLOT_MS) {
    const parts = localParts(at, timeZone);
    if (
      !parts ||
      parts.weekday === 0 ||
      parts.weekday === 6 ||
      (selectedWorkingDayKeys && !selectedWorkingDayKeys.has(parts.day)) ||
      parts.hour < 17
    )
      continue;
    const slot = { start: at, end: at + SLOT_MS };
    const stats = eveningStats.get(parts.day) ?? { busyMs: 0, events: new Map() };
    if (workloadBusyMerged.some((interval) => overlap(interval, slot))) stats.busyMs += SLOT_MS;
    for (const item of conflictEvents) {
      if (overlap(item.interval, slot)) stats.events.set(eventIdentity(item.event), item.event);
    }
    eveningStats.set(parts.day, stats);
  }
  const eveningAssessments: string[] = [];
  if (!busyValid) {
    eveningAssessments.push(
      'Evening-load assessment: I could not assess after-hours load from usable free/busy data.',
    );
  } else {
    const evenings = [...eveningStats.entries()].filter(
      ([, stats]) => stats.busyMs > 0 || stats.events.size > 0,
    );
    if (evenings.length === 0) {
      eveningAssessments.push(
        complete
          ? 'No checked weekday has busy time after 5 PM.'
          : 'No after-5 PM busy time in the checked subset.',
      );
    }
    for (const [day, stats] of evenings) {
      const hours = Math.round(stats.busyMs / 60_000 / 15) / 4;
      if (hours >= 3)
        eveningAssessments.push(
          `Evening-heavy estimate: ${labelDay(day)}, ${hours} checked busy hours after 5 PM (unique occupied time; overlapping intervals count once; 3-hour heuristic)`,
        );
      const scheduled = [...stats.events.values()]
        .map((event) => ({ event, interval: parseEventInterval(event) }))
        .filter(
          (item): item is { event: PlainRecord; interval: { start: number; end: number } } =>
            item.interval !== undefined,
        )
        .sort((left, right) => left.interval.start - right.interval.start);
      for (let index = 1; index < scheduled.length; index += 1) {
        const previous = scheduled[index - 1];
        const next = scheduled[index];
        if (!previous || !next) continue;
        const gap = next.interval.start - previous.interval.end;
        if (gap >= 0 && gap <= 30 * 60_000)
          eveningAssessments.push(
            `Tight turnaround: ${eventTitle(previous.event)} ends ${labelTime(previous.interval.end, timeZone)}; ${eventTitle(next.event)} starts ${labelTime(next.interval.start, timeZone)} (${Math.round(gap / 60_000)} min; attendance/travel unverified)`,
          );
      }
    }
  }
  const conditionalStayNames = [...new Set(chosen.flatMap((slot) => slot.lodgingConditions))];
  const lines = [
    `Review-only plan for ${windowLabel} (${input.timeZone}); no calendar changes made.`,
    '',
  ];
  const formatClock = (at: number) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: input.timeZone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(at));
  if (chosen.length > 0) {
    lines.push(
      conditionalStayNames.length > 0 || !complete
        ? 'Focus candidates (not availability-cleared):'
        : 'Focus candidates:',
      '| Candidate | Break |',
      '| --- | --- |',
      ...chosen.map((slot) => {
        const focusEnd = slot.start + focusMs;
        return `| ${labelTime(slot.start, timeZone)}–${formatClock(focusEnd)} (${focusMs / 60_000}m) | ${breakMs / 60_000}m |`;
      }),
      '',
    );
  }
  const availabilityNotes: string[] = [];
  if (conditionalStayNames.length > 0) {
    const conditionalStayNameSet = new Set(conditionalStayNames);
    const stayDetails = [
      ...new Map(
        [...explainedLodgingBusy.values()].flatMap((event) => {
          const interval = parseEventInterval(event);
          const title = eventTitle(event);
          return interval
            ? conditionalStayNameSet.has(title)
              ? [
                  [
                    title,
                    `${title} (${labelTime(interval.start, timeZone)}–${labelTime(interval.end, timeZone)})`,
                  ] as const,
                ]
              : []
            : [];
        }),
      ).values(),
    ];
    availabilityNotes.push(
      `Availability caveat: the feed still reports busy across this window where it overlaps ${stayDetails.join(', ') || conditionalStayNames.join(', ')}; conditional slots assume lodging context, not a work hold.`,
    );
  }
  const coverageNotes: string[] = [];
  if (recoveredCoverage)
    coverageNotes.push(
      `free/busy unavailable for ${recoveredCoverage.names.join(', ')}; blocking intervals came from the complete event list for this exact window (event-list fallback, not independent free/busy confirmation)`,
    );
  else if (complete && availabilityComplete && busyValid)
    coverageNotes.push('free/busy and event listing report complete for this exact window');
  else if (complete && !busyValid)
    coverageNotes.push(
      'reported window coverage is complete, but usable free/busy intervals are unavailable',
    );
  if (allDayBusySources.length > 0) {
    const shownAllDay = allDayBusySources.slice(0, 3);
    const omittedAllDay = allDayBusySources.length - shownAllDay.length;
    availabilityNotes.push(
      `All-day holds that still block focus time (not counted as meeting workload): ${shownAllDay
        .map(
          ({ event, interval }) =>
            `${calendarSourceReference(event)} (${labelTime(interval.start, timeZone)}–${labelTime(interval.end, timeZone)})`,
        )
        .join(
          '; ',
        )}; they do not establish continuous meeting attendance.${omittedAllDay > 0 ? ` ${omittedAllDay} additional all-day holds omitted.` : ''}`,
    );
  }
  if (explainedLodgingBusy.size > 0)
    availabilityNotes.push(
      'Multi-day lodging is excluded from meeting workload; conditional slots still rely on the feed’s busy interval being lodging context.',
    );
  if (!complete) {
    const missing =
      unavailableCalendars.length > 0
        ? `Unavailable free/busy or event coverage: ${[...new Set(unavailableCalendars)].join(', ')}`
        : !availabilityComplete
          ? 'Free/busy coverage could not be fully verified'
          : 'Event listing is incomplete or reached its bounded page limit';
    coverageNotes.push(
      `${missing}; proposed times are tentative, not confirmed free. Confirm the missing calendars before relying on this review`,
    );
  }
  if (availabilityNotes.length > 0) {
    lines.push('Availability notes:', ...availabilityNotes.map((note) => `- ${note}`), '');
  }
  if (coverageNotes.length > 0) {
    lines.push('Limits:', ...coverageNotes.map((note) => `- ${note}.`), '');
  }
  const assumptions = [
    `assumed 9 AM–5 PM work hours (not configured) and a ${breakMs / 60_000}-minute break after each focus block`,
  ];
  if (input.plan?.meetingBufferMinutes)
    assumptions.push(`${input.plan.meetingBufferMinutes}-minute buffers before and after meetings`);
  if (travelBufferCount > 0)
    assumptions.push(
      'estimated 30-minute travel buffers before and after physical events without video; not route estimates',
    );
  if (potentialTravelBufferCount > 0)
    assumptions.push(
      'some shared-event attendance is unconfirmed; verify before relying on travel time',
    );
  if (assumptions.length > 0) {
    lines.push('Assumptions:', ...assumptions.map((assumption) => `- ${assumption}.`), '');
  }
  const visibleConflictLimit = 5;
  const allConflictDetails = [...duplicateListingPairs, ...conflictPairs];
  if (allConflictDetails.length > 0) {
    lines.push(
      'Conflicts and review choices:',
      ...allConflictDetails.slice(0, visibleConflictLimit).map((detail) => `- ${detail}`),
      '',
    );
  }
  if (allConflictDetails.length > visibleConflictLimit)
    lines.push(
      `${allConflictDetails.length - visibleConflictLimit} additional overlaps or possible duplicate listings omitted from this brief; all were included in the planning check.`,
    );
  if (conflictPairs.length === 0 && duplicateListingPairs.length === 0 && complete)
    lines.push('Conflicts: none found in checked calendar data.');
  const includeWorkloadAssessment = input.plan?.includeWorkloadAssessment ?? true;
  if (includeWorkloadAssessment) {
    const workloadNotes: string[] = [];
    if (overloads.length > 0)
      workloadNotes.push(`Overloaded-day estimate: ${overloads.join('; ')}.`);
    else if (!busyValid)
      workloadNotes.push('I could not assess overloaded days from usable free/busy data.');
    else
      workloadNotes.push(
        `Overloaded-day assessment: No checked working day reaches the 6-hour busy-time threshold inside the assumed 9–5 day.${complete ? ' This is a planning heuristic.' : ' This applies only to the checked data; missing coverage could change this assessment.'}`,
      );
    if (eveningAssessments.length > 0)
      workloadNotes.push(`Evening review: ${eveningAssessments.join(' · ')}`);
    if (overloads.length > 0)
      workloadNotes.push(
        'Recommended change: consider moving flexible work from an overloaded day to a lighter day after checking your priorities.',
      );
    if (workloadNotes.length > 0) {
      lines.push('Workload review:', ...workloadNotes.map((note) => `- ${note}`), '');
    }
  }
  if (chosen.length === 0) {
    const constrainingEvents = [
      ...new Map(
        [...eventBusySources, ...allDayBusySources]
          .filter(({ interval }) =>
            potentialFocusIntervals.some((candidate) => overlap(interval, candidate)),
          )
          .map(({ event }) => [eventIdentity(event), event]),
      ).values(),
    ].slice(0, 3);
    if (busyValid && constrainingEvents.length > 0) {
      lines.push(
        `Checked events overlapping possible focus windows include ${constrainingEvents.map(calendarSourceReference).join(', ')}. No ${focusMs / 60_000}-minute focus block plus its ${breakMs / 60_000}-minute break fit in the checked data.`,
      );
    }
    lines.push(
      busyValid
        ? `I couldn’t identify suitable ${focusMs / 60_000}-minute blocks from the available data. Please confirm coverage or working hours before I suggest more.`
        : 'I did not suggest focus times because usable free/busy intervals were unavailable. Please confirm coverage before choosing a time.',
    );
  }
  if (chosen.length < requestedSlots)
    lines.push(
      `I found ${chosen.length} of ${requestedSlots} requested focus blocks; the remaining time did not fit without overlapping checked commitments and breaks.`,
    );
  // Keep source links attached to the event details that need them (conflicts,
  // all-day holds, and focus-window constraints). A second catalog of every
  // event adds a long, repetitive URL block to a review-only focus plan.
  return result(lines.join('\n'), complete, chosen.length);
}

export function weeklyCalendarPlan(input: WeeklyCalendarPlanInput): string {
  return weeklyCalendarPlanResult(input).text;
}
