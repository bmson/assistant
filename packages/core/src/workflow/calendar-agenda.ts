import { createHash } from 'node:crypto';
import {
  type CalendarHouseholdComparisonV1,
  type CalendarHouseholdItemV1,
  type CalendarHouseholdRSVP,
  calendarHouseholdItemHasAcceptedRSVP,
  classifyCalendarOccurrence,
  parseCalendarHouseholdDay,
  parseCalendarHouseholdItem,
} from '@assistant/persistence';
import type { BriefingCalendarEvent } from './briefing.js';
import {
  calendarArrivalLead,
  calendarGroupRelationship,
  calendarOverlapAttendanceNote,
  classifyCalendarOverlap,
  parseCalendarOwnerParticipation,
  possibleCalendarIdentityDisagreement,
  verifiedOwnerParticipation,
  verifiedPersonalCommitment,
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
function ownerRSVPNote(event: ResponseCard): string {
  const verified = eventSources(event)
    .map((source) => parseCalendarOwnerParticipation(source.ownerParticipation))
    .filter(
      (participation) =>
        participation?.identityVerified === true && participation.basis === 'attendee-email',
    );
  if (verified.length === 0) {
    const participation = parseCalendarOwnerParticipation(event.ownerParticipation);
    if (participation?.identityVerified === true && participation.basis === 'attendee-email')
      verified.push(participation);
  }
  const statuses = new Set(verified.map((participation) => participation?.status));
  if (statuses.size > 1) return 'Your RSVP differs by calendar source.';
  const status = verified[0]?.status;
  if (status === 'accepted') return 'Your RSVP: accepted.';
  if (status === 'declined') return 'Your RSVP: declined.';
  if (status === 'tentative') return 'Your RSVP: tentative.';
  if (status === 'needsAction') return 'Your RSVP: needs a response.';
  if (status === 'unknown') return 'Your RSVP: unknown.';
  return 'Your RSVP: not verified.';
}

function organizerDetails(events: ResponseCard[]): Array<{ title: string; detail: string }> {
  const seen = new Set<string>();
  return events.flatMap((event) =>
    eventSources(event).flatMap((source) => {
      const organizer = text(source.organizer)
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ');
      if (!organizer) return [];
      const calendar = text(source.calendar) || text(source.calendarId);
      const eventID = text(source.eventId) || text(event.id);
      const eventTitle = text(source.summary) || text(event.title) || 'Untitled event';
      const key = `${eventID}\0${calendar}\0${organizer}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          title: `${eventTitle}: Organizer: ${organizer}`,
          detail: calendar ? `Calendar source: ${calendar}` : 'Calendar source not reported.',
        },
      ];
    }),
  );
}

const sourceNames = (sources: Record<string, unknown>[]): string[] => [
  ...new Set(
    sources.map((source) => text(source.calendar) || text(source.calendarId) || 'Calendar'),
  ),
];
function relationshipEvent(event: ResponseCard): BriefingCalendarEvent {
  const source = eventSources(event)[0] ?? {};
  return {
    summary: text(source.summary ?? event.title) || '(untitled event)',
    start: text(source.start ?? event.start),
    end: text(source.end ?? event.end),
    calendar: text(source.calendar ?? event.calendar),
    allDay: (source.allDay ?? event.allDay) === true,
    ...(text(source.status ?? event.status) ? { status: text(source.status ?? event.status) } : {}),
    ...(text(source.organizer) ? { organizer: text(source.organizer) } : {}),
    ...(Array.isArray(source.attendees)
      ? {
          attendees: source.attendees.filter((value): value is string => typeof value === 'string'),
        }
      : {}),
    ...(Array.isArray(source.links) ? { links: source.links } : {}),
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
    ...(text(source.calendarTimeZone ?? event.calendarTimeZone)
      ? { calendarTimeZone: text(source.calendarTimeZone ?? event.calendarTimeZone) }
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

function asksAboutDriving(ownerText: string): boolean {
  if (
    !ownerText ||
    /["“”`]/.test(ownerText) ||
    /\b(?:translate|translation|paraphrase|rewrite|wording)\b/i.test(ownerText)
  )
    return false;
  const clauses = ownerText.replace(/[‘’]/g, "'").split(/(?<=[.!?])\s+/);
  return clauses.some((clause) => {
    if (
      !clause.includes('?') ||
      /\b(?:don't|do not|not|never|no need|shouldn't|should not|can't|cannot)\b/i.test(clause) ||
      /\b(?:said|says|asked|asks|wrote|writes|quoted|reported|reports|wondered)\b/i.test(clause) ||
      /(?:'[^']*(?:driv(?:e|ing)|driving coverage)[^']*'|‘[^’]*(?:driv(?:e|ing)|driving coverage)[^’]*’)/i.test(
        clause,
      )
    )
      return false;
    return /\bwho(?:'s|’s|\s+(?:is|will))\s+(?:be\s+)?driving\b|\bwho\s+will\s+drive\b|\bdo\s+i\s+need\s+to\s+drive\b|\bshould\s+i\s+drive\b|\bdriving\s+coverage\b/i.test(
      clause,
    );
  });
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
      label: 'organizer',
      value: (source) => text(source.organizer) || 'organizer not reported',
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

function coverageDetails(rows: ActionEvidence[]): Array<{ title: string; detail?: string }> {
  const items: Array<{ title: string; detail?: string }> = [];
  const seen = new Set<string>();
  const add = (title: string, detail?: string) => {
    const normalizedDetail = detail
      ?.replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title || !normalizedDetail) return;
    const key = `${title}\0${normalizedDetail}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ title, detail: normalizedDetail });
  };
  const timestamp = (value: unknown): string | undefined => {
    const raw = text(value);
    const instant = Date.parse(raw);
    return raw && Number.isFinite(instant) && instant !== 0 ? raw : undefined;
  };

  for (const row of rows) {
    const result = record(row.result);
    const args = record(row.args);
    const timeMin = text(args.timeMin);
    const timeMax = text(args.timeMax);
    if (timeMin || timeMax)
      add(
        'Requested window',
        `${timeMin || 'Start not reported'} to ${timeMax || 'end not reported'}`,
      );

    const resolved = list(result.calendarsResolved).map(record).filter(Boolean);
    const resolvedName = (id: string) => {
      const entry = resolved.find((candidate) => candidate && text(candidate.id) === id);
      return entry ? text(entry.name) : '';
    };
    const resolvedTimeZone = (id: string) => {
      const entry = resolved.find((candidate) => candidate && text(candidate.id) === id);
      return entry ? text(entry.timeZone) : '';
    };
    const searchedIDs = list(result.calendarsSearchedIds).map(text).filter(Boolean);
    const searchedNames = list(result.calendarsSearched).map(text).filter(Boolean);
    const resolvedSearched = searchedIDs.map((id) => ({ id, name: resolvedName(id) }));
    const nameCounts = new Map<string, number>();
    for (const item of resolvedSearched)
      if (item.name) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
    const searched = searchedIDs.length
      ? resolvedSearched.map(({ id, name }) => {
          if (!name) return 'Unresolved calendar source';
          const label = nameCounts.get(name) === 1 ? name : `${name} (${id})`;
          const zone = resolvedTimeZone(id);
          return zone ? `${label} (${zone})` : label;
        })
      : searchedNames;
    if (searched.length) add('Calendars checked in this read', [...new Set(searched)].join(', '));
    if (
      searchedIDs.some((id) => !id.startsWith('iphone:')) ||
      (!searchedIDs.length && searchedNames.length)
    )
      add(
        'Source freshness unavailable',
        'This read does not report when these calendar sources were fetched.',
      );
    if (result.calendarRosterComplete === false)
      add('Calendar roster', 'Incomplete; the readable calendar list may omit sources.');

    const phone = record(result.phoneCalendarCoverage);
    if (Object.keys(phone).length) {
      const phoneWindowMin = text(phone.timeMin);
      const phoneWindowMax = text(phone.timeMax);
      const coverageState =
        phone.complete === true
          ? 'Complete for the recorded coverage window'
          : phone.complete === false
            ? 'Incomplete for the recorded coverage window'
            : 'Coverage status not reported';
      const capturedAt = timestamp(phone.capturedAt);
      const receivedAt = timestamp(phone.receivedAt);
      const freshness = [
        capturedAt ? `Captured at ${capturedAt}` : 'Capture time not reported',
        receivedAt
          ? `received by Assistant at ${receivedAt}`
          : text(phone.receivedAt) && Date.parse(text(phone.receivedAt)) === 0
            ? 'receive time unavailable (phone has not uploaded a snapshot)'
            : 'receive time not reported',
      ].join('; ');
      add(
        'iPhone shared-calendar coverage',
        `${coverageState}${phoneWindowMin || phoneWindowMax ? `; source window ${phoneWindowMin || 'start not reported'} to ${phoneWindowMax || 'end not reported'}` : ''}; ${freshness}.`,
      );
      const phoneSources = list(phone.sources).map(record).filter(Boolean);
      for (const source of phoneSources) {
        if (!source) continue;
        const calendarId = text(source.calendarId);
        const scopedID = calendarId ? `iphone:${calendarId}` : '';
        const name = scopedID ? resolvedName(scopedID) : '';
        const zone = scopedID ? resolvedTimeZone(scopedID) : '';
        const sourceLabel = name
          ? `Phone source: ${name}${zone ? ` (${zone})` : ''}`
          : 'Phone calendar source';
        const status = ['available', 'missing', 'permission-denied'].includes(text(source.status))
          ? text(source.status)
          : 'status not reported';
        add(
          sourceLabel,
          `${status}; ${source.complete === true ? 'source complete' : source.complete === false ? 'source incomplete' : 'source completeness not reported'}${text(source.reason) ? `; ${text(source.reason)}` : ''}.`,
        );
      }
      const phoneNote = text(phone.note);
      if (phoneNote) add('Phone coverage note', phoneNote);
    } else if (searchedIDs.some((id) => id.startsWith('iphone:'))) {
      add(
        'iPhone shared-calendar coverage',
        'Coverage metadata not reported for a searched phone source.',
      );
    }

    const note = text(result.note);
    if (note) add('Calendar read note', note);
    if (!successful(row)) {
      const status = text(row.status) || 'not completed';
      const reason = text(result.error) || text(result.message);
      add(`Calendar read ${status}`, reason || 'No successful result was recorded for this read.');
    }
  }
  return items;
}

function householdCoverageSummary(rows: ActionEvidence[], complete: boolean): string {
  const gaps: string[] = [];
  for (const row of rows) {
    const result = record(row.result);
    const resolved = list(result.calendarsResolved).map(record).filter(Boolean);
    for (const item of list(result.unavailable).map(record).filter(Boolean)) {
      const id = text(item.calendarId) || text(item.id);
      const name =
        text(item.calendar) ||
        text(item.name) ||
        text(resolved.find((entry) => text(entry?.id) === id)?.name) ||
        'Calendar source';
      const reason = text(item.reason) || 'could not be checked';
      gaps.push(`${name}: ${reason}`);
    }
    if (result.calendarRosterComplete === false) gaps.push('Readable calendar list is incomplete');
    const phone = record(result.phoneCalendarCoverage);
    const phoneSources = list(phone.sources).map(record).filter(Boolean);
    for (const source of phoneSources) {
      const id = text(source.calendarId);
      const resolvedId = id ? `iphone:${id}` : '';
      const name =
        text(source.calendar) ||
        text(source.name) ||
        text(resolved.find((entry) => text(entry?.id) === resolvedId)?.name) ||
        'Phone calendar source';
      const status = text(source.status);
      if (status === 'missing') gaps.push(`${name}: source missing`);
      else if (status === 'permission-denied') gaps.push(`${name}: permission denied`);
      else if (status !== 'available') gaps.push(`${name}: source status not reported`);
      else if (source.complete === false) gaps.push(`${name}: source coverage incomplete`);
      else if (source.complete !== true) gaps.push(`${name}: source completeness not reported`);
    }
    if (phone.complete === false && phoneSources.length === 0)
      gaps.push('Phone calendar coverage is incomplete');
    else if (Object.keys(phone).length > 0 && phone.complete !== true && phoneSources.length === 0)
      gaps.push('Phone calendar coverage status not reported');
    if (!successful(row)) {
      const reason = text(result.error) || text(result.message);
      gaps.push(
        reason
          ? `Calendar read ${text(row.status) || 'not completed'}: ${reason}`
          : `Calendar read ${text(row.status) || 'not completed'}`,
      );
    } else if (result.complete === false && !text(result.nextPageToken)) {
      gaps.push('A requested calendar read or page is incomplete');
    }
  }
  const unique = [...new Set(gaps)];
  if (complete && !unique.length) {
    const checked = [
      ...new Set(
        rows.flatMap((row) => list(record(row.result).calendarsSearched).map(text)).filter(Boolean),
      ),
    ];
    return checked.length
      ? `Coverage complete for ${checked.join(', ')} in the pages reported by this read.`
      : 'Coverage complete for the sources reported by this read.';
  }
  if (!unique.length)
    return 'Coverage incomplete: some requested calendar sources or pages could not be verified.';
  const shown = unique.slice(0, 2).join('; ');
  const remainder = unique.length > 2 ? `; ${unique.length - 2} additional coverage gaps` : '';
  return `Coverage incomplete: ${shown}${remainder}.`;
}

function householdFreshnessSummary(rows: ActionEvidence[]): string {
  const reported: string[] = [];
  let phoneCoverageSeen = false;
  let otherCalendarSeen = false;
  for (const row of rows) {
    const result = record(row.result);
    const phone = record(result.phoneCalendarCoverage);
    if (Object.keys(phone).length) {
      phoneCoverageSeen = true;
      const capturedAt = text(phone.capturedAt);
      const receivedAt = text(phone.receivedAt);
      if (capturedAt && Number.isFinite(Date.parse(capturedAt)) && Date.parse(capturedAt) !== 0)
        reported.push(`Phone capture ${capturedAt}`);
      if (receivedAt && Number.isFinite(Date.parse(receivedAt)) && Date.parse(receivedAt) !== 0)
        reported.push(`Assistant received phone snapshot ${receivedAt}`);
      else if (receivedAt && Date.parse(receivedAt) === 0)
        reported.push('Phone snapshot has not uploaded; receive time unavailable');
    }
    const ids = list(result.calendarsSearchedIds).map(text);
    otherCalendarSeen ||=
      ids.some((id) => !id.startsWith('iphone:')) ||
      (!ids.length && list(result.calendarsSearched).length > 0);
  }
  const unique = [...new Set(reported)];
  if (!unique.length && !phoneCoverageSeen)
    return 'No source freshness timestamp was reported by this read.';
  if (!unique.length) unique.push('Phone capture/receive timestamp not reported');
  if (otherCalendarSeen) unique.push('Fetch time unavailable for other checked calendar sources');
  return unique.join('; ');
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
  sourceIdentityDisagreements: Array<{
    title: string;
    detail: string;
    comparison?: CalendarHouseholdComparisonV1;
  }>;
  duplicateListings: Array<{
    title: string;
    detail: string;
    comparison?: CalendarHouseholdComparisonV1;
  }>;
  arrivalGuidance: Array<{ title: string; detail: string }>;
  conflictCount: number;
  sourceIdentityDisagreementCount: number;
  duplicateCount: number;
  arrivalCount: number;
  personalConflictQuestion?: {
    eventIds: [string, string];
    titles: [string, string];
    startMs: number;
  };
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

function comparisonFor(
  left: ResponseCard,
  right: ResponseCard,
): CalendarHouseholdComparisonV1 | undefined {
  const leftEventId = text(left.id);
  const rightEventId = text(right.id);
  return leftEventId && rightEventId && leftEventId !== rightEventId
    ? { version: 1, leftEventId, rightEventId }
    : undefined;
}

function householdItemDetails(event: ResponseCard): CalendarHouseholdItemV1 | undefined {
  const sourceVariants = list(event.sourceVariants);
  const hasSourceVariants = sourceVariants.length > 0;
  const sourceRecords = eventSources(event);
  if (hasSourceVariants && sourceRecords.length !== sourceVariants.length) return undefined;
  const sources = sourceRecords.map((source) => {
    const participation = parseCalendarOwnerParticipation(source.ownerParticipation);
    const verified =
      participation?.identityVerified === true && participation.basis === 'attendee-email';
    const rsvp: CalendarHouseholdRSVP = verified ? participation.status : 'not_verified';
    const start = hasSourceVariants ? text(source.start) : text(event.start);
    const title = hasSourceVariants ? text(source.summary) : text(event.title);
    const allDay = hasSourceVariants
      ? typeof source.allDay === 'boolean'
        ? source.allDay
        : undefined
      : typeof event.allDay === 'boolean'
        ? event.allDay
        : undefined;
    if (!start || !title || allDay === undefined) return undefined;
    const calendars = hasSourceVariants
      ? text(source.calendar)
      : text(event.calendar) ||
        (list(event.calendars).length === 1 ? text(list(event.calendars)[0]) : '');
    const end = hasSourceVariants ? text(source.end) : text(event.end);
    return {
      calendar: calendars || 'Calendar source name unavailable',
      title,
      start,
      ...(end ? { end } : {}),
      ...(text(source.calendarTimeZone) ? { timeZone: text(source.calendarTimeZone) } : {}),
      allDay,
      rsvp,
    };
  });
  if (!sources.length || sources.some((source) => !source)) return undefined;
  return {
    version: 1,
    sources: sources as NonNullable<(typeof sources)[number]>[],
    eventFor: 'not_stated',
    driving: 'not_stated',
  };
}

/** Analyze pairs once globally; cap only formatted details, never the counts or agenda rows. */
function calendarPairAttentionByDay(
  events: ResponseCard[],
  zone: string | undefined,
  include: boolean,
  asksAboutDriving: boolean,
  householdDetailsByEvent: ReadonlyMap<ResponseCard, CalendarHouseholdItemV1 | undefined>,
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
    const ownerParticipation = verifiedOwnerParticipation(event);
    const personalCommitment = verifiedPersonalCommitment(event);
    const householdDetails = householdDetailsByEvent.get(event);
    return {
      event,
      eventId: text(event.id),
      agendaDay: event.windowMembership === 'source-date-only' ? 'unverified' : dayKey(event, zone),
      startMs,
      endMs,
      sources,
      ownerParticipation,
      personalCommitment,
      householdDetails,
      allSourceRsvpsAccepted: calendarHouseholdItemHasAcceptedRSVP(householdDetails),
      hasPhoneSource: sources.some((source) => text(source.calendarId).startsWith('iphone:')),
      eligible:
        !event.allDay &&
        event.blocksTime !== false &&
        event.status !== 'cancelled' &&
        ownerParticipation !== 'declined' &&
        Number.isFinite(startMs) &&
        Number.isFinite(endMs) &&
        INSTANT.test(text(event.start)) &&
        INSTANT.test(text(event.end)),
      relationship: relationshipEvent(event),
      relationshipSources: sources.map((source) =>
        relationshipEvent({ ...event, sourceVariants: [source] }),
      ),
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
      // Every variant must be considered: the first source alone can miss a meeting link or a changed time.
      const relationship = calendarGroupRelationship(
        left.relationshipSources,
        right.relationshipSources,
        zone,
      );
      if (relationship === 'compatible_time_roles') {
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
            ...(comparisonFor(left.event, right.event)
              ? { comparison: comparisonFor(left.event, right.event) }
              : {}),
          });
        }
        continue;
      }
      const probableMirror =
        relationship === 'probable_duplicate' ||
        relationship === 'possible_duplicate' ||
        ((left.hasPhoneSource || right.hasPhoneSource) &&
          left.sources.some((leftSource) =>
            right.sources.some(
              (rightSource) =>
                classifyCalendarOccurrence(leftSource, rightSource).kind === 'probable-mirror',
            ),
          ));
      if (probableMirror) {
        attention.duplicateCount += 1;
        if (formattedDetails < MAX_PAIR_DETAILS) {
          formattedDetails += 1;
          attention.duplicateListings.push({
            title: `${relationship === 'possible_duplicate' ? 'Possibly the same event' : 'Possible copies'}: ${text(left.event.title)} (${sourceNames(left.sources).join(', ')}) · ${text(right.event.title)} (${sourceNames(right.sources).join(', ')})`,
            detail:
              'These listings may be copies of one event. Both remain visible; check the invitation to confirm whether they are copies.',
            ...(comparisonFor(left.event, right.event)
              ? { comparison: comparisonFor(left.event, right.event) }
              : {}),
          });
        }
        continue;
      }
      attention.conflictCount += 1;
      const acceptedPersonalPair =
        asksAboutDriving &&
        day !== 'unverified' &&
        left.agendaDay === day &&
        right.agendaDay === day &&
        left.ownerParticipation === 'accepted' &&
        right.ownerParticipation === 'accepted' &&
        left.allSourceRsvpsAccepted &&
        right.allSourceRsvpsAccepted &&
        left.personalCommitment &&
        right.personalCommitment &&
        Boolean(left.eventId && right.eventId && left.eventId !== right.eventId);
      if (acceptedPersonalPair) {
        const firstIsLeft = left.eventId.localeCompare(right.eventId) < 0;
        const firstId = firstIsLeft ? left.eventId : right.eventId;
        const secondId = firstIsLeft ? right.eventId : left.eventId;
        const current = attention.personalConflictQuestion;
        const isEarlier =
          !current ||
          from < current.startMs ||
          (from === current.startMs &&
            (firstId.localeCompare(current.eventIds[0]) < 0 ||
              (firstId === current.eventIds[0] &&
                secondId.localeCompare(current.eventIds[1]) < 0)));
        if (isEarlier) {
          const firstEvent = firstIsLeft ? left.event : right.event;
          const secondEvent = firstIsLeft ? right.event : left.event;
          attention.personalConflictQuestion = {
            eventIds: [firstId, secondId],
            titles: [
              text(firstEvent.title) || 'first commitment',
              text(secondEvent.title) || 'second commitment',
            ],
            startMs: from,
          };
        }
      }
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
  const householdDetailsByEvent = new Map(
    input.events.map((event) => [event, householdItemDetails(event)] as const),
  );
  const pairAttention = calendarPairAttentionByDay(
    input.events,
    zone,
    input.request?.includeCalendarOverlapSummary !== false,
    asksAboutDriving(input.requestText ?? ''),
    householdDetailsByEvent,
  );
  const readCoverage = coverageDetails(rows);
  const coverageSummary = householdCoverageSummary(rows, complete);
  const freshnessSummary = householdFreshnessSummary(rows);
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
          ? `No events returned from ${scope} for ${dateLabel(day).split(' · ')[0]}.`
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
        const householdDetails = householdDetailsByEvent.get(event);
        const status = text(event.status).toLowerCase();
        const note = [
          ownerRSVPNote(event),
          status === 'cancelled' ? 'Cancelled' : '',
          event.probableMatch === true
            ? `Likely the same event.${
                differences?.timeDiffers
                  ? ` Source times: ${eventSources(event)
                      .map(
                        (source) =>
                          `${text(source.calendar) || 'Calendar'} ${zone ? `${clock(text(source.start), zone)}–${clock(text(source.end), zone)}` : `${text(source.start)}–${text(source.end)}`}`,
                      )
                      .join('; ')}. Earliest start and latest end shown.`
                  : ''
              }`
            : differences
              ? `Calendar copies differ in ${differences.fields.join(', ')}.`
              : '',
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
              : differences?.timeDiffers && event.probableMatch !== true
                ? 'Time differs by source'
                : eventTime(event, zone),
          title:
            differences?.titleDiffers && event.probableMatch !== true
              ? 'Title differs by source'
              : text(event.title),
          ...(text(event.location) ? { location: text(event.location) } : {}),
          ...(note ? { note } : {}),
          calendars: list(event.calendars),
          sourceVariants: eventSources(event),
          ...(householdDetails ? { householdDetails } : {}),
          calendarLinks: list(event.calendarLinks),
          ...(event.meetingLink ? { meetingLink: event.meetingLink } : {}),
        };
      });
      const sections: Record<string, unknown>[] = items.length
        ? [{ type: 'agenda', title: dateLabel(day, zone), complete: groupComplete, items }]
        : [];
      const eventDetails = organizerDetails(events);
      if (eventDetails.length)
        sections.push({ type: 'attention', title: 'Event details', items: eventDetails });
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
      if (readCoverage.length)
        sections.push({ type: 'attention', title: 'Calendar read coverage', items: readCoverage });
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
      const pairSummary = pairAttention.get(day) ?? emptyPairAttention();
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
      const agendaEventIds = new Map<string, number>();
      for (const event of events) {
        const eventId = text(event.id);
        if (eventId) agendaEventIds.set(eventId, (agendaEventIds.get(eventId) ?? 0) + 1);
      }
      const candidateQuestion = pairSummary.personalConflictQuestion;
      const firstQuestion =
        candidateQuestion &&
        agendaEventIds.get(candidateQuestion.eventIds[0]) === 1 &&
        agendaEventIds.get(candidateQuestion.eventIds[1]) === 1
          ? candidateQuestion
          : undefined;
      const householdCoverageComplete =
        groupComplete && !coverageSummary.startsWith('Coverage incomplete:');
      const householdCoverageText =
        groupComplete || !complete
          ? coverageSummary
          : `Coverage for this day is unverified. ${coverageSummary}`;
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
        householdDay: {
          version: 1,
          coverage: {
            complete: householdCoverageComplete,
            summary: householdCoverageText,
            freshnessSummary,
            details: readCoverage.flatMap((item) =>
              item.detail ? [{ title: item.title, detail: item.detail }] : [],
            ),
          },
          ...(firstQuestion
            ? {
                nextQuestion: {
                  basis: 'verified_owner_accepted_overlap' as const,
                  id: `driving-overlap-${firstQuestion.eventIds.join('-')}`,
                  question: `Do you need to account for driving between ${firstQuestion.titles[0]} and ${firstQuestion.titles[1]}?`,
                  detail: 'These accepted commitments overlap. Driving is not stated.',
                  eventIds: firstQuestion.eventIds,
                  remainingIssueCount: Math.max(
                    0,
                    conflictCount +
                      sourceIdentityDisagreementCount +
                      duplicateCount +
                      arrivalCount -
                      1,
                  ),
                },
              }
            : {}),
        },
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
  const maxAgendaRows = 50;
  const maxAttentionRows = 50;
  return agenda
    .map((card) => {
      const displayZone = validZone(card.timeZone);
      const blocks = [
        text(card.date),
        displayZone ? `Display time zone: ${displayZone}` : 'Display time zone unavailable.',
        text(card.lead),
      ].filter(Boolean);
      const sections = list(card.sections).map(record).filter(Boolean);
      const agendaRows = sections
        .filter((section) => section.type === 'agenda')
        .flatMap((section) => list(section.items).map(record).filter(Boolean));
      const agendaIdCounts = new Map<string, number>();
      const agendaItemsById = new Map<string, Record<string, unknown>>();
      for (const item of agendaRows) {
        const id = text(item.id);
        if (id) {
          agendaIdCounts.set(id, (agendaIdCounts.get(id) ?? 0) + 1);
          agendaItemsById.set(id, item);
        }
      }
      const householdDay = parseCalendarHouseholdDay(card.householdDay);
      const householdCoverage = householdDay?.coverage;
      if (householdCoverage) {
        blocks.push(householdCoverage.summary, householdCoverage.freshnessSummary);
        for (const item of householdCoverage.details) blocks.push(`${item.title} — ${item.detail}`);
      }
      const nextQuestion = householdDay?.nextQuestion;
      if (
        nextQuestion &&
        agendaIdCounts.get(nextQuestion.eventIds[0]) === 1 &&
        agendaIdCounts.get(nextQuestion.eventIds[1]) === 1 &&
        calendarHouseholdItemHasAcceptedRSVP(
          agendaItemsById.get(nextQuestion.eventIds[0])?.householdDetails,
        ) &&
        calendarHouseholdItemHasAcceptedRSVP(
          agendaItemsById.get(nextQuestion.eventIds[1])?.householdDetails,
        )
      )
        blocks.push(`Next question: ${nextQuestion.question} ${nextQuestion.detail}`);
      for (const section of sections) {
        const title = text(section.title);
        if (section.type === 'agenda') {
          const rows = list(section.items).map(record).filter(Boolean);
          const displayed = rows.slice(0, maxAgendaRows).map((item) => {
            const sourceNames = list(item.calendars).map(text).filter(Boolean);
            const base = [
              `- **${text(item.time) || 'Time unavailable'}** — ${text(item.title) || 'Untitled event'}`,
              text(item.location) ? ` — ${text(item.location)}` : '',
              sourceNames.length ? ` · Calendars: ${[...new Set(sourceNames)].join(', ')}` : '',
              text(item.note) ? ` · ${text(item.note)}` : '',
            ].join('');
            const household = parseCalendarHouseholdItem(item.householdDetails);
            const sourceRsvps =
              household?.sources.map((source) => `${source.calendar}: ${source.rsvp}`) ?? [];
            return `${base}${sourceRsvps.length ? `\n  RSVP by source: ${sourceRsvps.join('; ')}. Event for: not stated. Driving: not stated.` : ''}`;
          });
          if (title && displayed.length) blocks.push(`**${title}**\n${displayed.join('\n')}`);
          const omitted = rows.length - displayed.length;
          if (omitted > 0)
            blocks.push(
              `${omitted} additional retrieved calendar entries are omitted from this text fallback; the structured agenda retains them.`,
            );
          if (typeof section.omittedCount === 'number' && section.omittedCount > 0)
            blocks.push(
              `${section.omittedCount} additional retrieved events are omitted from this agenda preview.`,
            );
          if (section.complete === false)
            blocks.push(
              'Calendar coverage is incomplete; some events or calendars may be missing.',
            );
          continue;
        }
        if (section.type !== 'attention') continue;
        const details = list(section.items).map(record).filter(Boolean);
        const overlaps = list(section.overlaps).map(record).filter(Boolean);
        const detailLines = details
          .slice(0, maxAttentionRows)
          .map(
            (item) =>
              `- ${text(item.title) || title}${text(item.detail) ? ` — ${text(item.detail)}` : ''}`,
          );
        const overlapLines = overlaps
          .slice(0, maxAttentionRows)
          .map(
            (item) =>
              `- ${text(item.title) || 'Calendar overlap'}${text(item.detail) ? ` — ${text(item.detail)}` : ''}`,
          );
        if (title && (detailLines.length || overlapLines.length))
          blocks.push(`**${title}**\n${[...detailLines, ...overlapLines].join('\n')}`);
        const omitted =
          Math.max(0, details.length - maxAttentionRows) +
          Math.max(0, overlaps.length - maxAttentionRows);
        if (omitted > 0)
          blocks.push(
            `${omitted} additional calendar attention details are omitted from this text fallback.`,
          );
        if (section.overlapsTruncated === true && typeof section.overlapCount === 'number')
          blocks.push(
            `${section.overlapCount} overlapping event pairs were counted; only the structured card's available detail previews are shown.`,
          );
      }
      if (
        card.complete === false &&
        !sections.some((section) => section.type === 'agenda' && section.complete === false)
      )
        blocks.push('Calendar coverage is incomplete; some events or calendars may be missing.');
      return blocks.join('\n\n');
    })
    .filter(Boolean)
    .join('\n\n');
}
