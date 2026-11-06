import type {
  CalendarOccurrenceIdentity,
  CalendarOwnerParticipation,
  CalendarOwnerParticipationStatus,
} from '@assistant/persistence';
import { probablePhoneCalendarDuplicate, sameCalendarOccurrence } from '@assistant/persistence';
import type { BriefingCalendarEvent } from './briefing.js';

export type CalendarRelationship = 'probable_duplicate' | 'compatible_time_roles' | 'unresolved';
export type CalendarOverlapClassification =
  | 'personal_commitment_conflict'
  | 'commitments_policy_overlap'
  | 'attendance_unconfirmed';

/** A trusted shared UID with incomplete occurrence metadata can signal a copy,
 * but it is never enough to merge sources or suppress an ordinary event row. */
export function possibleCalendarIdentityDisagreement(
  left: CalendarOccurrenceIdentity,
  right: CalendarOccurrenceIdentity,
): boolean {
  const leftCalendar = typeof left.calendarId === 'string' ? left.calendarId : '';
  const rightCalendar = typeof right.calendarId === 'string' ? right.calendarId : '';
  const uid = typeof left.iCalUID === 'string' ? left.iCalUID : '';
  if (
    !leftCalendar ||
    !rightCalendar ||
    leftCalendar === rightCalendar ||
    !uid ||
    uid !== right.iCalUID ||
    left.recurringEventId ||
    right.recurringEventId
  )
    return false;
  const leftOriginal = typeof left.originalStartTime === 'string' ? left.originalStartTime : '';
  const rightOriginal = typeof right.originalStartTime === 'string' ? right.originalStartTime : '';
  if (
    leftOriginal &&
    rightOriginal &&
    Number.isFinite(Date.parse(leftOriginal)) &&
    Number.isFinite(Date.parse(rightOriginal)) &&
    Date.parse(leftOriginal) !== Date.parse(rightOriginal)
  )
    return false;
  const leftStart = Date.parse(String(left.start ?? ''));
  const rightStart = Date.parse(String(right.start ?? ''));
  const leftEnd = Date.parse(String(left.end ?? ''));
  const rightEnd = Date.parse(String(right.end ?? ''));
  return (
    Number.isFinite(leftStart) &&
    Number.isFinite(rightStart) &&
    Number.isFinite(leftEnd) &&
    Number.isFinite(rightEnd) &&
    (leftStart !== rightStart || leftEnd !== rightEnd)
  );
}

/** Merge only pairwise-equivalent canonical components; ambiguous bridges stay separate. */
export function canonicalOccurrenceGroups<T extends CalendarOccurrenceIdentity>(
  events: readonly T[],
): T[][] {
  return occurrenceGroups(events, sameCalendarOccurrence);
}

function occurrenceGroups<T>(
  events: readonly T[],
  equivalent: (left: T, right: T) => boolean,
): T[][] {
  const visited = new Set<number>();
  const groups: Array<{ first: number; values: T[][] }> = [];
  for (let index = 0; index < events.length; index += 1) {
    if (visited.has(index)) continue;
    const component = new Set([index]);
    const queue = [index];
    visited.add(index);
    while (queue.length) {
      const current = queue.pop();
      const event = current === undefined ? undefined : events[current];
      if (!event) continue;
      for (let candidateIndex = 0; candidateIndex < events.length; candidateIndex += 1) {
        if (visited.has(candidateIndex)) continue;
        const candidate = events[candidateIndex];
        if (candidate && equivalent(event, candidate)) {
          visited.add(candidateIndex);
          component.add(candidateIndex);
          queue.push(candidateIndex);
        }
      }
    }
    const indexes = [...component].sort((a, b) => a - b);
    const values = indexes.flatMap((memberIndex) => {
      const event = events[memberIndex];
      return event ? [event] : [];
    });
    const isClique = values.every((left, leftIndex) =>
      values.every((right, rightIndex) => leftIndex === rightIndex || equivalent(left, right)),
    );
    groups.push({ first: index, values: isClique ? [values] : values.map((value) => [value]) });
  }
  return groups.sort((left, right) => left.first - right.first).flatMap((group) => group.values);
}

type PresentationOccurrence = CalendarOccurrenceIdentity & {
  summary?: unknown;
  calendar?: unknown;
  calendarTimeZone?: unknown;
  location?: unknown;
  allDay?: unknown;
  status?: unknown;
};

export interface ProbableCalendarMatchEvidence {
  kind: 'probable-match';
  basis: 'matchup-venue-and-time';
  /** Source start difference; this does not establish an arrival instruction. */
  earlierStartMinutes: number;
}

const sourceText = (value: unknown): string => (typeof value === 'string' ? value : '');

function matchup(event: PresentationOccurrence): string[] | undefined {
  const parts = sourceText(event.summary)
    .replace(/\(\d{1,2}:\d{2}\s*(?:am|pm)\)/gi, '')
    .split(/\s+v(?:s\.?)?\s+/i)
    .map(normalized);
  return parts.length === 2 && parts.every(Boolean) ? parts : undefined;
}

function sameMatchup(left: PresentationOccurrence, right: PresentationOccurrence): boolean {
  const a = matchup(left);
  const b = matchup(right);
  if (!a || !b) return false;
  const contains = (short: string, long: string) =>
    short.split(' ').every((word) => long.split(' ').includes(word));
  // Calendar names can clarify the home team abbreviation, but never the opponent.
  const matches = (short: string[], long: string[], calendar: unknown) =>
    contains(short[0] ?? '', `${long[0]} ${normalized(sourceText(calendar))}`) &&
    contains(short[1] ?? '', long[1] ?? '') &&
    (short[1] ?? '').split(' ').filter((word) => word.length >= 3).length >= 2;
  return matches(a, b, right.calendar) || matches(b, a, left.calendar);
}

function venueName(event: PresentationOccurrence): string {
  // Compare literal venue names, without treating different street addresses as equal.
  // The remaining independent matchup and time signals are also required.
  return normalized(sourceText(event.location).split(/[,\n]/)[0] ?? '')
    .split(' ')
    .filter((word) => !['soccer', 'field', 'fields', 'parking', 'lot', 'and'].includes(word))
    .join(' ');
}

function titleClockMatches(
  earlier: PresentationOccurrence,
  later: PresentationOccurrence,
  timeZone?: string,
): boolean {
  const clock = /\((\d{1,2}):(\d{2})\s*(am|pm)\)/i.exec(sourceText(earlier.summary));
  if (!clock || Number(clock[1]) < 1 || Number(clock[1]) > 12 || Number(clock[2]) > 59)
    return false;
  const hours = (Number(clock[1]) % 12) + (clock[3]?.toLowerCase() === 'pm' ? 12 : 0);
  const start = sourceText(later.start);
  const zone = sourceText(earlier.calendarTimeZone) || timeZone;
  if (zone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(start));
      return (
        Number(parts.find((part) => part.type === 'hour')?.value) === hours &&
        Number(parts.find((part) => part.type === 'minute')?.value) === Number(clock[2])
      );
    } catch {
      return false;
    }
  }
  const local = /T(\d{2}):(\d{2}).*([+-]\d{2}:\d{2})$/.exec(start);
  const earlierOffset = /([+-]\d{2}:\d{2})$/.exec(sourceText(earlier.start))?.[1];
  return (
    !!local &&
    !!earlierOffset &&
    earlierOffset === local[3] &&
    Number(local[1]) === hours &&
    Number(local[2]) === Number(clock[2])
  );
}

/** Advisory presentation evidence only; never provider identity, attendance or write authority. */
export function probableCalendarMatchEvidence(
  left: PresentationOccurrence,
  right: PresentationOccurrence,
  timeZone?: string,
): ProbableCalendarMatchEvidence | undefined {
  if (
    !sourceText(left.calendarId) ||
    !sourceText(right.calendarId) ||
    left.calendarId === right.calendarId ||
    left.allDay === true ||
    right.allDay === true ||
    left.status === 'cancelled' ||
    right.status === 'cancelled' ||
    !/T/.test(sourceText(left.start)) ||
    !/T/.test(sourceText(right.start))
  )
    return;
  // Reject ordinary unrelated events before parsing timestamps. This matcher
  // also sits in the calendar overlap pair loop, where dense calendars can
  // produce millions of candidates with no venue or matchup evidence.
  const venue = venueName(left);
  if (venue.split(' ').filter((word) => word.length >= 3).length < 2 || venue !== venueName(right))
    return;
  if (!sameMatchup(left, right)) return;
  if (
    (left.originalStartTime || right.originalStartTime) &&
    (!left.originalStartTime ||
      !right.originalStartTime ||
      Date.parse(sourceText(left.originalStartTime)) !==
        Date.parse(sourceText(right.originalStartTime)))
  )
    return;
  const startLeft = Date.parse(sourceText(left.start));
  const startRight = Date.parse(sourceText(right.start));
  const endLeft = Date.parse(sourceText(left.end));
  const endRight = Date.parse(sourceText(right.end));
  if (![startLeft, startRight, endLeft, endRight].every(Number.isFinite)) return;
  const distance = Math.abs(startLeft - startRight);
  if (distance > 90 * 60_000 || endLeft !== endRight || endLeft <= Math.max(startLeft, startRight))
    return;
  if (
    distance > 0 &&
    !titleClockMatches(
      startLeft < startRight ? left : right,
      startLeft < startRight ? right : left,
      timeZone,
    )
  )
    return;
  return {
    kind: 'probable-match',
    basis: 'matchup-venue-and-time',
    earlierStartMinutes: distance / 60_000,
  };
}

/** Group only for presentation. Every source remains intact; ambiguous bridges stay separate. */
export function presentationOccurrenceGroups<T extends PresentationOccurrence>(
  events: readonly T[],
  timeZone?: string,
): T[][] {
  const canonical = canonicalOccurrenceGroups(events);
  const probable = (left: T, right: T) => !!probableCalendarMatchEvidence(left, right, timeZone);
  // Canonical blocks are indivisible. Partial probable bridges must never split
  // trusted identity, nor allow one variant to hide a conflicting source.
  const components = occurrenceGroups(canonical, (left, right) =>
    left.some((a) => right.some((b) => probable(a, b))),
  );
  return components.flatMap((blocks) => {
    const compatible = blocks.every((left, index) =>
      blocks.every(
        (right, other) => index === other || left.every((a) => right.every((b) => probable(a, b))),
      ),
    );
    return compatible ? [blocks.flat()] : blocks;
  });
}

export function parseCalendarOwnerParticipation(
  value: unknown,
): CalendarOwnerParticipation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const participation = value as Partial<CalendarOwnerParticipation>;
  const statuses: CalendarOwnerParticipationStatus[] = [
    'accepted',
    'declined',
    'tentative',
    'needsAction',
    'unknown',
  ];
  const bases = ['attendee-email', 'organizer-email', 'unverified'] as const;
  return typeof participation.identityVerified === 'boolean' &&
    statuses.includes(participation.status as CalendarOwnerParticipationStatus) &&
    bases.includes(participation.basis as (typeof bases)[number])
    ? {
        status: participation.status as CalendarOwnerParticipationStatus,
        identityVerified: participation.identityVerified,
        basis: participation.basis as CalendarOwnerParticipation['basis'],
      }
    : undefined;
}

/** Only a verified owner attendee response can establish personal attendance. */
export function verifiedOwnerParticipation(event: {
  [key: string]: unknown;
  ownerParticipation?: unknown;
  sourceVariants?: unknown;
}): CalendarOwnerParticipationStatus {
  const variants = Array.isArray(event.sourceVariants)
    ? event.sourceVariants.filter((value): value is Record<string, unknown> =>
        Boolean(value && typeof value === 'object' && !Array.isArray(value)),
      )
    : [];
  const verifiedStatuses = variants.flatMap((variant) => {
    const participation = parseCalendarOwnerParticipation(variant.ownerParticipation);
    if (!participation) return [];
    return participation.identityVerified === true && participation.basis === 'attendee-email'
      ? [participation.status]
      : [];
  });
  const distinctVerifiedStatuses = new Set(verifiedStatuses);
  if (distinctVerifiedStatuses.size > 1) return 'unknown';
  if (verifiedStatuses.length > 0) {
    const status = verifiedStatuses[0];
    if (
      status === 'accepted' ||
      status === 'declined' ||
      status === 'tentative' ||
      status === 'needsAction' ||
      status === 'unknown'
    )
      return status;
  }
  const value = parseCalendarOwnerParticipation(event.ownerParticipation);
  return value?.identityVerified === true && value.basis === 'attendee-email'
    ? value.status
    : 'unknown';
}

/** Busy personal commitments require proof from the human attendee or policy. */
export function verifiedPersonalCommitment(event: {
  [key: string]: unknown;
  ownerParticipation?: unknown;
  calendarPurpose?: unknown;
  blocksTime?: unknown;
  sourceIntegrity?: unknown;
  sourceVariants?: unknown;
}): boolean {
  if (event.blocksTime !== true || event.sourceIntegrity === 'disputed') return false;
  const variants = Array.isArray(event.sourceVariants)
    ? event.sourceVariants.filter((value): value is Record<string, unknown> =>
        Boolean(value && typeof value === 'object' && !Array.isArray(value)),
      )
    : [];
  const verifiedDecline = (value: unknown) => {
    const participation = parseCalendarOwnerParticipation(value);
    return (
      participation?.status === 'declined' &&
      participation.identityVerified === true &&
      participation.basis === 'attendee-email'
    );
  };
  if (event.status === 'cancelled' || verifiedDecline(event.ownerParticipation)) return false;
  if (
    variants.some(
      (variant) =>
        variant.blocksTime !== true ||
        variant.status === 'cancelled' ||
        verifiedDecline(variant.ownerParticipation),
    )
  )
    return false;
  if (
    variants.length > 1 &&
    (new Set(variants.map((variant) => variant.status ?? '')).size > 1 ||
      new Set(variants.map((variant) => variant.calendarPurpose ?? 'unspecified')).size > 1)
  )
    return false;
  return (
    verifiedOwnerParticipation(event) === 'accepted' || event.calendarPurpose === 'commitments'
  );
}

export function classifyCalendarOverlap(
  left: Parameters<typeof verifiedPersonalCommitment>[0],
  right: Parameters<typeof verifiedPersonalCommitment>[0],
): CalendarOverlapClassification {
  if (!verifiedPersonalCommitment(left) || !verifiedPersonalCommitment(right))
    return 'attendance_unconfirmed';
  if (
    verifiedOwnerParticipation(left) === 'accepted' &&
    verifiedOwnerParticipation(right) === 'accepted'
  )
    return 'personal_commitment_conflict';
  if (left.calendarPurpose === 'commitments' || right.calendarPurpose === 'commitments')
    return 'commitments_policy_overlap';
  return 'attendance_unconfirmed';
}

/** Describe each side only when the human attendee's response is verified. */
export function calendarOverlapAttendanceNote(
  left: Parameters<typeof verifiedOwnerParticipation>[0],
  right: Parameters<typeof verifiedOwnerParticipation>[0],
  leftLabel: string,
  rightLabel: string,
  classification?: CalendarOverlapClassification,
): string {
  const leftParticipation = verifiedOwnerParticipation(left);
  const rightParticipation = verifiedOwnerParticipation(right);
  const settingsPrefix =
    classification === 'commitments_policy_overlap'
      ? 'Your calendar settings mark these as commitments. '
      : '';
  if (leftParticipation === 'accepted' && rightParticipation === 'accepted')
    return 'You accepted both invitations, and the times overlap.';
  if (leftParticipation === 'accepted')
    return `${settingsPrefix}You accepted ${leftLabel}. Your attendance at ${rightLabel} isn’t confirmed.`;
  if (rightParticipation === 'accepted')
    return `${settingsPrefix}You accepted ${rightLabel}. Your attendance at ${leftLabel} isn’t confirmed.`;
  return `${settingsPrefix}Your attendance at ${leftLabel} and ${rightLabel} isn’t confirmed.`;
}

/** Advisory only: independently reconcile a source's explicit early-arrival rule. */
export function calendarArrivalLead(
  left: BriefingCalendarEvent,
  right: BriefingCalendarEvent,
): number | undefined {
  if (!left.calendarId || !right.calendarId || left.calendarId === right.calendarId) return;
  const earlier = Date.parse(left.start) < Date.parse(right.start) ? left : right;
  const later = earlier === left ? right : left;
  const minutes = Number(
    /\barrival:\s*(\d{1,2})\s+minutes?\s+(?:in advance|early|before)/i.exec(
      later.description ?? '',
    )?.[1],
  );
  if (
    !minutes ||
    minutes > 90 ||
    Date.parse(later.start) - Date.parse(earlier.start) !== minutes * 60_000 ||
    Date.parse(left.end) !== Date.parse(right.end)
  )
    return;
  const street = (event: BriefingCalendarEvent) =>
    normalized(/\b\d{1,6}(?:-\d{1,6})?\s+[^,\n]+/u.exec(event.location ?? '')?.[0] ?? '');
  if (!street(left) || street(left) !== street(right)) return;
  const clock = /\((\d{1,2}):(\d{2})\s*(am|pm)\)/i.exec(earlier.summary);
  const start = /T(\d{2}):(\d{2}).*[+-]\d{2}:\d{2}$/.exec(later.start);
  if (
    !clock ||
    !start ||
    (Number(clock[1]) % 12) + (clock[3]?.toLowerCase() === 'pm' ? 12 : 0) !== Number(start[1]) ||
    Number(clock[2]) !== Number(start[2])
  )
    return;
  const words = new Set(
    normalized(earlier.summary)
      .split(' ')
      .filter((word) => word.length >= 5),
  );
  if (
    !normalized(later.summary)
      .split(' ')
      .some((word) => words.has(word))
  )
    return;
  return minutes;
}

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function role(event: BriefingCalendarEvent): 'arrival' | 'start' | undefined {
  const classify = (text: string) => {
    const arrival = /\b(?:arrive|arrival|warm[ -]?up|check[ -]?in)\b/i.test(text);
    const start = /\b(?:kick[ -]?off|match start|event start)\b/i.test(text);
    return arrival === start ? undefined : arrival ? 'arrival' : 'start';
  };
  const summaryRole = classify(event.summary);
  if (summaryRole) return summaryRole;
  const descriptionRole = classify(event.description ?? '');
  if (descriptionRole) return descriptionRole;
  return undefined;
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
  if (probableCalendarMatchEvidence(left, right)) return 'probable_duplicate';
  const name = title(left);
  const phoneMirror =
    left.calendarId.startsWith('iphone:') || right.calendarId.startsWith('iphone:');
  if (name !== title(right) || (name.split(' ').length < 2 && (!phoneMirror || name.length < 4)))
    return 'unresolved';
  if (probablePhoneCalendarDuplicate(left, right)) return 'probable_duplicate';
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
    ? 'Both entries have verified evidence as busy personal commitments; occurrence identity has not been equated.'
    : 'The event times overlap; personal attendance and matching occurrence identity are not established for both records.';
}
