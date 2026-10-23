import { createHash } from 'node:crypto';
import { classifyCalendarOccurrence } from '@assistant/persistence';
import type { BriefingCalendarEvent } from './briefing.js';
import {
  calendarArrivalLead,
  calendarOverlapAttendanceNote,
  calendarRelationship,
  classifyCalendarOverlap,
  parseCalendarOwnerParticipation,
  possibleCalendarIdentityDisagreement,
  verifiedOwnerParticipation,
} from './calendar-relationship.js';
import { ownerCalendarToolName } from './calendar-scope.js';
import type { PersonalReadRequest } from './read-intent.js';
import type { ResponseCard } from './response-cards.js';
import type { ActionEvidence } from './response-contract.js';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const eventSources = (event: ResponseCard): Record<string, unknown>[] => {
  const sources = list(event.sourceVariants)
    .map(record)
    .filter((source) => Object.keys(source).length);
  return sources.length ? sources : [event];
};
const sourceNames = (sources: Record<string, unknown>[]): string[] => [
  ...new Set(
    sources.map((source) => text(source.calendar) || text(source.calendarId) || 'Calendar'),
  ),
];
function relationshipEvent(event: ResponseCard): BriefingCalendarEvent {
  const source = eventSources(event)[0] ?? {};
  return {
    summary: text(source.summary ?? event.title) || '(untitled event)',
    start: text(event.start),
    end: text(event.end),
    calendar: text(event.calendar),
    allDay: event.allDay === true,
    ...(text(source.calendarId ?? event.calendarId)
      ? { calendarId: text(source.calendarId ?? event.calendarId) }
      : {}),
    ...(text(source.eventId ?? event.eventId)
      ? { eventId: text(source.eventId ?? event.eventId) }
      : {}),
    ...(text(source.iCalUID ?? event.iCalUID)
      ? { iCalUID: text(source.iCalUID ?? event.iCalUID) }
      : {}),
    ...(text(source.recurringEventId ?? event.recurringEventId)
      ? { recurringEventId: text(source.recurringEventId ?? event.recurringEventId) }
      : {}),
    ...(text(source.originalStartTime ?? event.originalStartTime)
      ? { originalStartTime: text(source.originalStartTime ?? event.originalStartTime) }
      : {}),
    ...(text(source.location ?? event.location)
      ? { location: text(source.location ?? event.location) }
      : {}),
    ...(text(source.description ?? event.description)
      ? { description: text(source.description ?? event.description) }
      : {}),
  };
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validZones = new Map<string, boolean>();
const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_FORMATTERS = 64;
const MAX_VALID_ZONES = 64;
const validDate = (value: string) =>
  DATE.test(value) &&
  Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
  new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const successful = (row: ActionEvidence) =>
  row.status === 'succeeded' &&
  record(row.result).ok !== false &&
  !(typeof record(row.result).status === 'number' && Number(record(row.result).status) >= 400) &&
  record(row.result).deliveryStatus !== 'unknown';
const INSTANT = /(?:Z|[+-]\d{2}:\d{2})$/i;
const MAX_PAIR_DETAILS = 100;

/** A presentation cannot turn an unscoped lookup into a named-calendar answer. */
export function calendarAgendaScopedEvidence(
  evidence: ActionEvidence[],
  request?: PersonalReadRequest | null,
): ActionEvidence[] {
  if (!request?.calendarScope) return evidence;
  const name = ownerCalendarToolName(request.calendarScope);
  const normalize = (value: unknown) => text(value).normalize('NFKC').toLocaleLowerCase();
  return evidence.map((row) => {
    if (!/^calendar\.(?:list_events|search_events)$/.test(row.toolName)) return row;
    const ids = list(record(row.args).calendarIds);
    if (ids.length === 1 && normalize(ids[0]) === normalize(name)) return row;
    return {
      ...row,
      status: 'failed',
      result: { ok: false, complete: false, scopeMismatch: true },
    };
  });
}

/** Incidental calendar lookups must not replace a trip, analysis or availability answer. */
export function wantsCalendarAgenda(request?: PersonalReadRequest | null, ownerText = ''): boolean {
  if (
    /\b(?:what time|when (?:is|does|will)|where (?:is|does|will)|who (?:is|will))\b/i.test(
      ownerText,
    ) &&
    !/\b(?:agenda|overview|briefing|show|list)\b/i.test(ownerText)
  )
    return false;
  if (
    request?.answerFocus === 'flight' ||
    request?.sourceReads ||
    request?.personCalendar ||
    request?.weeklyCalendarPlan ||
    request?.calendarEventAnalysis ||
    request?.compoundTripDiscovery ||
    request?.upcomingFlightDiscovery ||
    request?.firstToolName === 'calendar.availability'
  )
    return false;
  return (
    request?.kind === 'calendar' ||
    (!request &&
      /\b(?:calendar|agenda|schedule)\b/i.test(ownerText) &&
      !/\b(?:email|mail|flight|trip|availability)\b/i.test(ownerText))
  );
}

function validZone(value: unknown): string | undefined {
  const zone = text(value);
  if (!zone) return undefined;
  const cached = validZones.get(zone);
  if (cached === false) return undefined;
  if (cached === true) return zone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    if (validZones.size >= MAX_VALID_ZONES) {
      const oldest = validZones.keys().next().value;
      if (oldest !== undefined) validZones.delete(oldest);
    }
    validZones.set(zone, true);
    return zone;
  } catch {
    if (validZones.size >= MAX_VALID_ZONES) {
      const oldest = validZones.keys().next().value;
      if (oldest !== undefined) validZones.delete(oldest);
    }
    validZones.set(zone, false);
    return undefined;
  }
}

function formatter(
  key: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let value = formatters.get(key);
  if (value) {
    formatters.delete(key);
    formatters.set(key, value);
    return value;
  }
  value = new Intl.DateTimeFormat(locale, options);
  if (formatters.size >= MAX_FORMATTERS) {
    const oldest = formatters.keys().next().value;
    if (oldest !== undefined) formatters.delete(oldest);
  }
  formatters.set(key, value);
  return value;
}

function dayKey(event: ResponseCard, zone?: string): string {
  const sources = eventSources(event);
  if (sources.length > 1) {
    const sourceDays = sources.map((source) => {
      const start = text(source.start);
      if (source.allDay === true)
        return validDate(start) && validZone(source.calendarTimeZone) ? start : 'unverified';
      if (!zone || !INSTANT.test(start) || !Number.isFinite(Date.parse(start))) return 'unverified';
      return formatter(`day:${zone}`, 'en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(start));
    });
    if (new Set(sourceDays).size > 1) return 'unverified';
  }
  const start = text(event.start);
  if (event.allDay === true)
    return validDate(start) && validZone(event.calendarTimeZone) ? start : 'unverified';
  if (!zone || !INSTANT.test(start) || !Number.isFinite(Date.parse(start))) return 'unverified';
  return formatter(`day:${zone}`, 'en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(start));
}

function dateLabel(day: string, zone?: string): string {
  if (!validDate(day)) return 'Dates not verified';
  const label = formatter('date-label', 'en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${day}T12:00:00Z`));
  if (!zone) return `${label} · Source dates`;
  const zoneLabel = formatter(`zone-label:${zone}`, 'en-US', {
    timeZone: zone,
    timeZoneName: 'short',
  })
    .formatToParts(new Date(`${day}T12:00:00Z`))
    .find((part) => part.type === 'timeZoneName')?.value;
  return `${label} · ${zoneLabel ?? zone}`;
}

function clock(value: string, zone: string): string {
  return formatter(`clock:${zone}`, 'en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function eventTime(event: ResponseCard, zone?: string): string {
  const start = text(event.start);
  const end = text(event.end);
  if (event.allDay === true) {
    if (validDate(end) && validDate(start)) {
      const inclusive = new Date(Date.parse(`${end}T12:00:00Z`) - 86_400_000)
        .toISOString()
        .slice(0, 10);
      if (inclusive > start) return `All day · through ${dateLabel(inclusive).split(' · ')[0]}`;
    }
    return 'All day';
  }
  if (!zone || !INSTANT.test(start) || !Number.isFinite(Date.parse(start)))
    return 'Time unavailable';
  const from = clock(start, zone);
  if (!INSTANT.test(end) || !Number.isFinite(Date.parse(end))) return from;
  const endDay = dayKey({ ...event, start: end }, zone);
  return `${from} – ${endDay !== dayKey(event, zone) ? `${dateLabel(endDay).split(' · ')[0]}, ` : ''}${clock(end, zone)}`;
}

function sourceLocalTime(source: Record<string, unknown>, fallbackZone?: string): string {
  const start = text(source.start);
  const end = text(source.end);
  if (source.allDay === true) return 'All day';
  const zone = validZone(source.calendarTimeZone) ?? fallbackZone;
  if (!zone || !INSTANT.test(start) || !INSTANT.test(end)) return 'Time unavailable';
  const day = (value: Date) =>
    formatter(`day:${zone}`, 'en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(value);
  const startDay = day(new Date(start));
  const endDay = day(new Date(end));
  const startLabel = `${dateLabel(startDay, zone).split(' · ')[0]} ${clock(start, zone)}`;
  const endLabel = `${endDay !== startDay ? `${dateLabel(endDay, zone).split(' · ')[0]} ` : ''}${clock(end, zone)}`;
  return `${startLabel} – ${endLabel} (${zone})`;
}

function sourceDifferences(
  event: ResponseCard,
  zone?: string,
): { fields: string[]; detail: string; titleDiffers: boolean; timeDiffers: boolean } | undefined {
  const sources = eventSources(event);
  if (sources.length < 2) return undefined;
  const ownerResponse = (source: Record<string, unknown>) => {
    const participation = parseCalendarOwnerParticipation(source.ownerParticipation);
    if (participation?.identityVerified && participation.basis === 'attendee-email') {
      return {
        accepted: 'owner accepted',
        declined: 'owner declined',
        tentative: 'owner tentative',
        needsAction: 'owner response needed',
        unknown: 'owner response unknown',
      }[participation.status];
    }
    const providerStatus = text(source.ownerResponse).toLowerCase();
    const providerLabel =
      providerStatus === 'accepted'
        ? 'provider copy says accepted'
        : providerStatus === 'declined'
          ? 'provider copy says declined'
          : providerStatus === 'tentative'
            ? 'provider copy says tentative'
            : providerStatus === 'needsaction'
              ? 'provider copy asks for a response'
              : 'provider response status unverified';
    return providerLabel;
  };
  const fields: Array<{ label: string; value: (source: Record<string, unknown>) => string }> = [
    { label: 'title', value: (source) => text(source.summary) || '(untitled)' },
    {
      label: 'time',
      value: (source) => sourceLocalTime(source, zone),
    },
    {
      label: 'event type',
      value: (source) => (source.allDay === true ? 'all day' : 'timed'),
    },
    {
      label: 'time zone',
      value: (source) => text(source.calendarTimeZone) || 'time zone unavailable',
    },
    {
      label: 'location',
      value: (source) => text(source.location) || 'location not listed',
    },
    {
      label: 'status',
      value: (source) => text(source.status) || 'status not reported',
    },
    {
      label: 'busy state',
      value: (source) =>
        source.blocksTime === true
          ? 'busy'
          : source.blocksTime === false
            ? 'free'
            : 'availability not reported',
    },
    { label: 'response metadata', value: ownerResponse },
    {
      label: 'calendar purpose',
      value: (source) =>
        source.calendarPurpose === 'commitments'
          ? 'commitments'
          : source.calendarPurpose === 'reference'
            ? 'reference'
            : 'purpose unspecified',
    },
  ];
  const timeDiffers =
    new Set(
      sources.map((source) =>
        JSON.stringify(
          [source.start, source.end]
            .map((value) => {
              const raw = text(value);
              if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `date:${raw}`;
              const instant = Date.parse(raw);
              return Number.isFinite(instant) ? `instant:${instant}` : raw;
            })
            .concat([source.allDay === true ? 'all-day' : 'timed']),
        ),
      ),
    ).size > 1;
  const differing = fields.filter((field) =>
    field.label === 'time' ? timeDiffers : new Set(sources.map(field.value)).size > 1,
  );
  if (!differing.length) return undefined;
  const titleDiffers =
    new Set(sources.map((source) => text(source.summary) || '(untitled)')).size > 1;
  const timeZoneDisplayDiffers =
    new Set(sources.map((source) => text(source.calendarTimeZone) || 'time zone unavailable'))
      .size > 1;
  const detailFields =
    !timeDiffers && timeZoneDisplayDiffers
      ? [...differing, fields.find((field) => field.label === 'time')].filter(
          (field): field is (typeof fields)[number] => Boolean(field),
        )
      : differing;
  const detail = sources
    .map((source) => {
      const calendar = text(source.calendar) || text(source.calendarId) || 'Calendar';
      return `${calendar}: ${detailFields.map((field) => `${field.label} ${field.value(source)}`).join('; ')}`;
    })
    .join(' · ');
  const sameTimedMeetingInDifferentZones =
    !timeDiffers &&
    timeZoneDisplayDiffers &&
    sources.every((source) => {
      const start = text(source.start);
      const end = text(source.end);
      const startInstant = Date.parse(start);
      const endInstant = Date.parse(end);
      return (
        source.allDay === false &&
        INSTANT.test(start) &&
        INSTANT.test(end) &&
        Number.isFinite(startInstant) &&
        Number.isFinite(endInstant) &&
        endInstant > startInstant &&
        Boolean(validZone(source.calendarTimeZone))
      );
    });
  return {
    fields: differing.map((field) => field.label),
    detail: sameTimedMeetingInDifferentZones
      ? `${detail}. These entries show the same meeting time in different calendar time zones.`
      : detail,
    titleDiffers,
    timeDiffers,
  };
}

/** Only the final followed page can close a paginated read; missing metadata is not complete. */
function coverageComplete(rows: ActionEvidence[]): boolean {
  return (
    rows.length > 0 &&
    rows.every((row, index) => {
      const result = record(row.result);
      if (!successful(row) || list(result.unavailable).length > 0) return false;
      const token = text(result.nextPageToken);
      if (token)
        return rows
          .slice(index + 1)
          .some(
            (next) =>
              text(record(next.args).pageToken) === token &&
              next.toolName === row.toolName &&
              JSON.stringify({ ...record(next.args), pageToken: undefined }) ===
                JSON.stringify({ ...record(row.args), pageToken: undefined }),
          );
      return result.complete === true;
    })
  );
}

type CalendarPairAttention = {
  conflicts: Array<{
    title: string;
    detail: string;
    classification?:
      | 'personal_commitment_conflict'
      | 'commitments_policy_overlap'
      | 'attendance_unconfirmed';
  }>;
  sourceIdentityDisagreements: Array<{ title: string; detail: string }>;
  duplicateListings: Array<{ title: string; detail: string }>;
  arrivalGuidance: Array<{ title: string; detail: string }>;
  conflictCount: number;
  sourceIdentityDisagreementCount: number;
  duplicateCount: number;
  arrivalCount: number;
};

const emptyPairAttention = (): CalendarPairAttention => ({
  conflicts: [],
  sourceIdentityDisagreements: [],
  duplicateListings: [],
  arrivalGuidance: [],
  conflictCount: 0,
  sourceIdentityDisagreementCount: 0,
  duplicateCount: 0,
  arrivalCount: 0,
});

/** Analyze pairs once globally; cap only formatted details, never the counts or agenda rows. */
function calendarPairAttentionByDay(
  events: ResponseCard[],
  zone: string | undefined,
  include: boolean,
): Map<string, CalendarPairAttention> {
  const byDay = new Map<string, CalendarPairAttention>();
  if (!include || !zone) return byDay;
  const chronological = [...events].sort(
    (left, right) => Date.parse(text(left.start)) - Date.parse(text(right.start)),
  );
  const overlapDayCache = new Map<number, string>();
  const metadata = chronological.map((event) => {
    const startMs = Date.parse(text(event.start));
    const endMs = Date.parse(text(event.end));
    const sources = eventSources(event);
    return {
      event,
      startMs,
      endMs,
      sources,
      hasPhoneSource: sources.some((source) => text(source.calendarId).startsWith('iphone:')),
      eligible:
        !event.allDay &&
        event.blocksTime !== false &&
        event.status !== 'cancelled' &&
        verifiedOwnerParticipation(event) !== 'declined' &&
        Number.isFinite(startMs) &&
        Number.isFinite(endMs) &&
        INSTANT.test(text(event.start)) &&
        INSTANT.test(text(event.end)),
      relationship: relationshipEvent(event),
    };
  });
  let formattedDetails = 0;
  for (let i = 0; i < metadata.length; i += 1) {
    const left = metadata[i];
    if (!left) continue;
    for (let j = i + 1; j < metadata.length; j += 1) {
      const right = metadata[j];
      if (!right) continue;
      if (
        !left.event.allDay &&
        Number.isFinite(left.endMs) &&
        Number.isFinite(right.startMs) &&
        right.startMs >= left.endMs
      )
        break;
      if (!left.eligible || !right.eligible) continue;
      const from = Math.max(left.startMs, right.startMs);
      const to = Math.min(left.endMs, right.endMs);
      if (from >= to) continue;
      let day = overlapDayCache.get(from);
      if (!day) {
        day = dayKey({ kind: 'calendar-event', id: '', start: new Date(from).toISOString() }, zone);
        overlapDayCache.set(from, day);
      }
      let attention = byDay.get(day);
      if (!attention) {
        attention = emptyPairAttention();
        byDay.set(day, attention);
      }
      if (calendarRelationship(left.relationship, right.relationship) === 'compatible_time_roles') {
        attention.arrivalCount += 1;
        if (formattedDetails < MAX_PAIR_DETAILS) {
          formattedDetails += 1;
          const lead = calendarArrivalLead(left.relationship, right.relationship);
          attention.arrivalGuidance.push({
            title: 'Possible arrival and start records',
            detail: lead
              ? `${text(left.event.title)} and ${text(right.event.title)} may be listings for one event; the invitation asks for arrival ${lead} minutes early. Both entries remain visible.`
              : `${text(left.event.title)} and ${text(right.event.title)} may be listings for one event. Both entries remain visible; check the invitation to confirm.`,
          });
        }
        continue;
      }
      const sourceIdentityDisagreement = left.sources.some((leftSource) =>
        right.sources.some((rightSource) =>
          possibleCalendarIdentityDisagreement(leftSource, rightSource),
        ),
      );
      if (sourceIdentityDisagreement) {
        attention.sourceIdentityDisagreementCount += 1;
        if (formattedDetails < MAX_PAIR_DETAILS) {
          formattedDetails += 1;
          attention.sourceIdentityDisagreements.push({
            title: `Possible copies with different times: ${text(left.event.title)} (${sourceNames(left.sources).join(', ')}) · ${text(right.event.title)} (${sourceNames(right.sources).join(', ')})`,
            detail:
              'Assistant cannot confirm whether these are the same event or which time is current. Both entries stay visible; check each invitation.',
          });
        }
        continue;
      }
      const probableMirror =
        (left.hasPhoneSource || right.hasPhoneSource) &&
        left.sources.some((leftSource) =>
          right.sources.some(
            (rightSource) =>
              classifyCalendarOccurrence(leftSource, rightSource).kind === 'probable-mirror',
          ),
        );
      if (probableMirror) {
        attention.duplicateCount += 1;
        if (formattedDetails < MAX_PAIR_DETAILS) {
          formattedDetails += 1;
          attention.duplicateListings.push({
            title: `Possible copies: ${text(left.event.title)} (${sourceNames(left.sources).join(', ')}) · ${text(right.event.title)} (${sourceNames(right.sources).join(', ')})`,
            detail:
              'These listings may be copies of one event. Both remain visible; check the invitation to confirm whether they are copies.',
          });
        }
        continue;
      }
      attention.conflictCount += 1;
      if (formattedDetails < MAX_PAIR_DETAILS) {
        formattedDetails += 1;
        const endIso = new Date(to).toISOString();
        const fromIso = new Date(from).toISOString();
        const endDay = dayKey({ kind: 'calendar-event', id: '', start: endIso }, zone);
        const label =
          day === endDay
            ? `${clock(fromIso, zone)} – ${clock(endIso, zone)}`
            : `${dateLabel(day).split(' · ')[0]} ${clock(fromIso, zone)} – ${dateLabel(endDay).split(' · ')[0]} ${clock(endIso, zone)}`;
        const classification = classifyCalendarOverlap(left.event, right.event);
        const overlapTitle =
          classification === 'personal_commitment_conflict'
            ? `Your accepted commitments overlap: ${label}`
            : classification === 'commitments_policy_overlap'
              ? `Possible commitments overlap: ${label}`
              : `Possible overlap: ${label}`;
        const leftLabel = `${text(left.event.title)} (${sourceNames(left.sources).join(', ')})`;
        const rightLabel = `${text(right.event.title)} (${sourceNames(right.sources).join(', ')})`;
        const qualification = calendarOverlapAttendanceNote(
          left.event,
          right.event,
          leftLabel,
          rightLabel,
          classification,
        );
        attention.conflicts.push({
          title: overlapTitle,
          detail: `${leftLabel} · ${rightLabel}. ${qualification}`,
          classification,
        });
      }
    }
  }
  return byDay;
}

/**
 * An evidence-only agenda in the existing primary briefing contract. Older
 * native clients already render every supplied row; six-row previews belong
 * to newer renderers, never to this payload. No model or card composer needed.
 */
export function calendarAgendaCards(input: {
  evidence: ActionEvidence[];
  events: ResponseCard[];
  request?: PersonalReadRequest | null;
  requestText?: string;
}): ResponseCard[] {
  if (!wantsCalendarAgenda(input.request, input.requestText)) return [];
  const rows = input.evidence.filter(
    (row) =>
      row.fromCurrentTask !== false &&
      /^calendar\.(?:list_events|search_events)$/.test(row.toolName),
  );
  if (
    !rows.length ||
    input.evidence.some(
      (row) =>
        row.fromCurrentTask !== false &&
        /^calendar\.(?:create_event|update_event|cancel_event)$/.test(row.toolName),
    )
  )
    return [];
  const usable = rows.filter(successful);
  const complete = coverageComplete(rows);
  const names = [
    ...new Set(
      usable.flatMap((row) => list(record(row.result).calendarsSearched).map(text)).filter(Boolean),
    ),
  ];
  const zone = validZone(input.request?.timeZone) ?? validZone(input.events[0]?.calendarTimeZone);
  const scope =
    names.length === 1
      ? (names[0] as string)
      : names.length > 1
        ? `${names.length} calendars`
        : 'the requested calendar';
  const warning = !complete
    ? 'Coverage is incomplete; some events or calendars may be missing.'
    : '';
  const groups = new Map<string, ResponseCard[]>();
  for (const event of input.events) {
    const day = event.windowMembership === 'source-date-only' ? 'unverified' : dayKey(event, zone);
    groups.set(day, [...(groups.get(day) ?? []), event]);
  }
  if (!groups.size) {
    const requestDay = input.request?.timeWindow?.timeMin;
    const day =
      requestDay && zone
        ? dayKey({ kind: 'calendar-event', id: '', start: requestDay }, zone)
        : 'unverified';
    groups.set(day, []);
  }
  const pairAttention = calendarPairAttentionByDay(
    input.events,
    zone,
    input.request?.includeCalendarOverlapSummary !== false,
  );
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, events]) => {
      const groupComplete = complete && day !== 'unverified';
      events.sort(
        (a, b) =>
          Number(b.allDay === true) - Number(a.allDay === true) ||
          (Date.parse(text(a.start)) || 0) - (Date.parse(text(b.start)) || 0),
      );
      const unresolvedScope =
        input.request?.calendarScope &&
        rows.some((row) => {
          const result = record(row.result);
          return (
            result.scopeMismatch === true ||
            list(result.unavailable).some((item) =>
              /calendar (?:name is ambiguous|was not found)/i.test(text(record(item).reason)),
            )
          );
        });
      const emptyLead = unresolvedScope
        ? `Couldn’t resolve ${ownerCalendarToolName(input.request?.calendarScope ?? { name: 'the requested calendar' })} in the checked calendars. Which calendar should I use?`
        : complete
          ? `No events on ${scope} for ${dateLabel(day).split(' · ')[0]}.`
          : usable.length
            ? `No matching events were verified in the checked subset. ${warning}`
            : `Couldn’t load ${scope}. Please retry the calendar lookup.`;
      const hasPossibleCopies =
        (pairAttention.get(day)?.duplicateCount ?? 0) > 0 ||
        (pairAttention.get(day)?.sourceIdentityDisagreementCount ?? 0) > 0;
      const lead = events.length
        ? `${events.length} calendar ${events.length === 1 ? 'entry' : 'entries'} from ${scope}.${hasPossibleCopies ? ' Some listings may be copies; both remain visible.' : ''}${warning ? ` ${warning}` : ''}`
        : emptyLead;
      const items = events.map((event) => {
        const differences = sourceDifferences(event, zone);
        const status = text(event.status).toLowerCase();
        const note = [
          verifiedOwnerParticipation(event) === 'needsAction'
            ? 'Needs response'
            : verifiedOwnerParticipation(event) === 'tentative'
              ? 'Tentative'
              : '',
          status === 'cancelled' ? 'Cancelled' : '',
          differences ? `Calendar copies differ in ${differences.fields.join(', ')}.` : '',
          event.windowMembership === 'source-date-only'
            ? `Date could not be verified in the requested window.${validDate(text(event.start)) ? ` Source date: ${text(event.start)}${validDate(text(event.end)) ? `; ends ${text(event.end)} (exclusive)` : ''}.${!validZone(event.calendarTimeZone) ? ' Calendar time zone unavailable.' : ''}` : ''}`
            : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return {
          id: event.id,
          day:
            differences &&
            new Set(eventSources(event).map((source) => source.allDay === true)).size > 1
              ? 'Time unavailable'
              : event.allDay === true
                ? 'All day'
                : 'Timed',
          time:
            differences?.timeDiffers &&
            new Set(eventSources(event).map((source) => source.allDay === true)).size > 1
              ? 'Time unavailable'
              : differences?.timeDiffers
                ? 'Time differs by source'
                : eventTime(event, zone),
          title: differences?.titleDiffers ? 'Title differs by source' : text(event.title),
          ...(text(event.location) ? { location: text(event.location) } : {}),
          ...(note ? { note } : {}),
          calendars: list(event.calendars),
          sourceVariants: eventSources(event),
          calendarLinks: list(event.calendarLinks),
          ...(event.meetingLink ? { meetingLink: event.meetingLink } : {}),
        };
      });
      const sections: Record<string, unknown>[] = items.length
        ? [{ type: 'agenda', title: dateLabel(day, zone), complete: groupComplete, items }]
        : [];
      const sourceDifferencesForDay = events.flatMap((event) => {
        const differences = sourceDifferences(event, zone);
        return differences
          ? [
              {
                title: differences.titleDiffers
                  ? `Source titles differ · ${text(event.title) || text(event.id)}`
                  : `${text(event.title) || text(event.id)} · calendar sources differ in ${differences.fields.join(', ')}`,
                detail: differences.detail,
              },
            ]
          : [];
      });
      if (sourceDifferencesForDay.length)
        sections.push({
          type: 'attention',
          title: 'Calendar source differences',
          items: sourceDifferencesForDay,
        });
      const unavailable = [
        ...new Map(
          rows
            .flatMap((row) => list(record(row.result).unavailable))
            .map((value) => record(value))
            .map((value) => ({
              title: text(value.calendar) || text(value.name) || 'Calendar unavailable',
              detail: text(value.reason) || 'This calendar could not be checked.',
            }))
            .map((item) => [JSON.stringify(item), item] as const),
        ).values(),
      ];
      if (unavailable.length)
        sections.push({ type: 'attention', title: 'Calendars not checked', items: unavailable });
      if (day === 'unverified' && items.length)
        sections.push({
          type: 'attention',
          title: 'Dates not verified',
          items: [
            { title: 'Some source dates or times could not be verified for the requested window.' },
          ],
        });
      const {
        conflicts,
        sourceIdentityDisagreements,
        duplicateListings,
        arrivalGuidance,
        conflictCount,
        sourceIdentityDisagreementCount,
        duplicateCount,
        arrivalCount,
      } = pairAttention.get(day) ?? emptyPairAttention();
      if (conflictCount) {
        const truncated = conflictCount > conflicts.length;
        let summary: string;
        if (truncated) {
          summary = `${conflictCount.toLocaleString('en-US')} calendar-entry pairs overlap in time; ${(conflictCount - conflicts.length).toLocaleString('en-US')} additional pairs counted but not expanded; ${conflicts.length} detail previews are available.`;
        } else {
          const personalCount = conflicts.filter(
            (conflict) => conflict.classification === 'personal_commitment_conflict',
          ).length;
          const policyCount = conflicts.filter(
            (conflict) => conflict.classification === 'commitments_policy_overlap',
          ).length;
          const otherCount = conflictCount - personalCount - policyCount;
          summary = [
            personalCount
              ? `${personalCount} accepted commitment conflict${personalCount === 1 ? '' : 's'}`
              : '',
            policyCount
              ? `${policyCount} configured commitment overlap${policyCount === 1 ? '' : 's'} (acceptance unconfirmed)`
              : '',
            otherCount ? `${otherCount} other overlap${otherCount === 1 ? '' : 's'}` : '',
          ]
            .filter(Boolean)
            .join(' · ');
        }
        sections.push({
          type: 'attention',
          title: truncated ? 'Many overlapping listings' : summary,
          items: [
            {
              title: truncated ? 'Many overlapping listings' : summary,
              detail: truncated
                ? `${summary} Calendar timing alone does not confirm attendance.${hasPossibleCopies ? ' Counts compare pairs of calendar listings; possible copies can repeat a warning.' : ''}`
                : `${hasPossibleCopies ? 'Counts compare pairs of calendar listings; possible copies can repeat a warning. ' : ''}Each pair below states whether attendance is confirmed or remains unconfirmed.`,
            },
          ],
          overlaps: conflicts,
          overlapCount: conflictCount,
          overlapsTruncated: truncated,
        });
      }
      if (sourceIdentityDisagreementCount)
        sections.push({
          type: 'attention',
          title: `${sourceIdentityDisagreementCount} possible copy pair${sourceIdentityDisagreementCount === 1 ? '' : 's'} with different times`,
          items: [
            ...sourceIdentityDisagreements,
            ...(sourceIdentityDisagreementCount > sourceIdentityDisagreements.length
              ? [
                  {
                    title: `${sourceIdentityDisagreementCount - sourceIdentityDisagreements.length} more possible-copy or different-time pairs counted but not expanded.`,
                  },
                ]
              : []),
          ],
          itemCount: sourceIdentityDisagreementCount,
          itemsTruncated: sourceIdentityDisagreementCount > sourceIdentityDisagreements.length,
        });
      if (duplicateCount)
        sections.push({
          type: 'attention',
          title: `${duplicateCount} possible copy ${duplicateCount === 1 ? 'pair' : 'pairs'}`,
          items: [
            ...duplicateListings,
            ...(duplicateCount > duplicateListings.length
              ? [
                  {
                    title: `${duplicateCount - duplicateListings.length} more possible-copy pairs counted but not expanded.`,
                  },
                ]
              : []),
          ],
          itemCount: duplicateCount,
          itemsTruncated: duplicateCount > duplicateListings.length,
        });
      if (arrivalCount)
        sections.push({
          type: 'attention',
          title: `${arrivalCount} possible arrival and start ${arrivalCount === 1 ? 'pair' : 'pairs'}`,
          items: [
            ...arrivalGuidance,
            ...(arrivalCount > arrivalGuidance.length
              ? [
                  {
                    title: `${arrivalCount - arrivalGuidance.length} additional arrival and start pairs counted but not expanded.`,
                  },
                ]
              : []),
          ],
          itemCount: arrivalCount,
          itemsTruncated: arrivalCount > arrivalGuidance.length,
        });
      return {
        kind: 'briefing',
        id: `calendar-agenda-${createHash('sha256')
          .update(JSON.stringify([day, items, lead]))
          .digest('hex')
          .slice(0, 24)}`,
        presentation: 'calendar-agenda',
        title: 'Agenda',
        date: dateLabel(day, zone),
        ...(zone ? { timeZone: zone } : {}),
        lead,
        sections,
        complete: groupComplete,
      };
    });
}

export function calendarAgendaSummary(
  cards: readonly Record<string, unknown>[],
): string | undefined {
  const agenda = cards.filter(
    (card) => card.kind === 'briefing' && card.presentation === 'calendar-agenda',
  );
  if (!agenda.length || agenda.length !== cards.length) return undefined;
  return agenda.length === 1
    ? text(agenda[0]?.lead)
    : 'The checked calendar agenda is shown by day below.';
}
