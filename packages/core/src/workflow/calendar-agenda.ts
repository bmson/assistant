import { createHash } from 'node:crypto';
import { classifyCalendarOccurrence } from '@assistant/persistence';
import type { BriefingCalendarEvent } from './briefing.js';
import {
  calendarArrivalLead,
  calendarRelationship,
  parseCalendarOwnerParticipation,
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
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return zone;
  } catch {
    return undefined;
  }
}

function dayKey(event: ResponseCard, zone?: string): string {
  const sources = eventSources(event);
  if (sources.length > 1) {
    const sourceDays = sources.map((source) => {
      const start = text(source.start);
      if (source.allDay === true && validDate(start)) return start;
      const sourceZone = validZone(source.calendarTimeZone) ?? zone;
      if (!sourceZone || !INSTANT.test(start) || !Number.isFinite(Date.parse(start)))
        return 'unverified';
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: sourceZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(start));
    });
    if (new Set(sourceDays).size > 1) return 'unverified';
  }
  const start = text(event.start);
  if (event.allDay === true && validDate(start)) return start;
  if (!zone || !INSTANT.test(start) || !Number.isFinite(Date.parse(start))) return 'unverified';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(start));
}

function dateLabel(day: string, zone?: string): string {
  if (!validDate(day)) return 'Dates not verified';
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${day}T12:00:00Z`));
  if (!zone) return `${label} · Source dates`;
  const zoneLabel = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
    .formatToParts(new Date(`${day}T12:00:00Z`))
    .find((part) => part.type === 'timeZoneName')?.value;
  return `${label} · ${zoneLabel ?? zone}`;
}

function clock(value: string, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
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
      value: (source) =>
        eventTime(
          {
            kind: 'calendar-event',
            id: '',
            start: text(source.start),
            end: text(source.end),
            allDay: source.allDay === true,
          },
          validZone(source.calendarTimeZone) ?? zone,
        ),
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
  const differing = fields.filter((field) => new Set(sources.map(field.value)).size > 1);
  if (!differing.length) return undefined;
  const titleDiffers =
    new Set(sources.map((source) => text(source.summary) || '(untitled)')).size > 1;
  const timeDiffers =
    new Set(
      sources.map((source) =>
        JSON.stringify([text(source.start), text(source.end), source.allDay === true]),
      ),
    ).size > 1;
  const detail = sources
    .map((source) => {
      const calendar = text(source.calendar) || text(source.calendarId) || 'Calendar';
      return `${calendar}: ${differing.map((field) => `${field.label} ${field.value(source)}`).join('; ')}`;
    })
    .join(' · ');
  return { fields: differing.map((field) => field.label), detail, titleDiffers, timeDiffers };
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
      const lead = events.length
        ? `${events.length} ${events.length === 1 ? 'event' : 'events'} from ${scope}.${warning ? ` ${warning}` : ''}`
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
              ? 'Type differs by source'
              : event.allDay === true
                ? 'All day'
                : 'Timed',
          time: differences?.timeDiffers ? 'Time differs by source' : eventTime(event, zone),
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
                title: `${differences.titleDiffers ? 'Event title differs by source' : 'Calendar event'} · ${differences.fields.join(', ')}`,
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
      const conflicts: { title: string; detail: string }[] = [];
      const duplicateListings: { title: string; detail: string }[] = [];
      const arrivalGuidance: { title: string; detail: string }[] = [];
      const chronological = [...input.events].sort(
        (left, right) => Date.parse(text(left.start)) - Date.parse(text(right.start)),
      );
      for (
        let i = 0;
        input.request?.includeCalendarOverlapSummary !== false && i < chronological.length;
        i++
      )
        for (let j = i + 1; j < chronological.length; j++) {
          const a = chronological[i];
          const b = chronological[j];
          if (
            !a ||
            !b ||
            a.allDay ||
            b.allDay ||
            a.blocksTime === false ||
            b.blocksTime === false ||
            [a, b].some(
              (event) =>
                event.status === 'cancelled' || verifiedOwnerParticipation(event) === 'declined',
            )
          )
            continue;
          if (![a.start, a.end, b.start, b.end].every((value) => INSTANT.test(text(value))))
            continue;
          const from = Math.max(Date.parse(text(a.start)), Date.parse(text(b.start)));
          const to = Math.min(Date.parse(text(a.end)), Date.parse(text(b.end)));
          if (zone && from < to) {
            const overlapDay = dayKey(
              { kind: 'calendar-event', id: '', start: new Date(from).toISOString() },
              zone,
            );
            if (overlapDay !== day) continue;
            const relationA = relationshipEvent(a);
            const relationB = relationshipEvent(b);
            if (calendarRelationship(relationA, relationB) === 'compatible_time_roles') {
              const lead = calendarArrivalLead(relationA, relationB);
              arrivalGuidance.push({
                title: 'Possible arrival and start records',
                detail: lead
                  ? `${text(a.title)} and ${text(b.title)} may describe one event; the source asks for arrival ${lead} minutes early. Both records remain visible.`
                  : `${text(a.title)} and ${text(b.title)} may describe one event. Both records remain visible because identity is unverified.`,
              });
              continue;
            }
            const probableMirror = eventSources(a).some((left) =>
              eventSources(b).some(
                (right) => classifyCalendarOccurrence(left, right).kind === 'probable-mirror',
              ),
            );
            if (probableMirror) {
              duplicateListings.push({
                title: `Possible duplicate listing: ${text(a.title)} · ${text(b.title)}`,
                detail:
                  'The calendar sources may describe the same occurrence; both are retained and attendance is unverified.',
              });
              continue;
            }
            const fromDay = dayKey(
              { kind: 'calendar-event', id: '', start: new Date(from).toISOString() },
              zone,
            );
            const toDay = dayKey(
              { kind: 'calendar-event', id: '', start: new Date(to).toISOString() },
              zone,
            );
            const label =
              fromDay === toDay
                ? `${clock(new Date(from).toISOString(), zone)} – ${clock(new Date(to).toISOString(), zone)}`
                : `${dateLabel(fromDay).split(' · ')[0]} ${clock(new Date(from).toISOString(), zone)} – ${dateLabel(toDay).split(' · ')[0]} ${clock(new Date(to).toISOString(), zone)}`;
            conflicts.push({
              title: `Possible overlap: ${label}`,
              detail: `${text(a.title)} · ${text(b.title)}. Calendar overlap does not confirm attendance.`,
            });
          }
        }
      if (conflicts.length)
        sections.push({
          type: 'attention',
          title: `${conflicts.length} possible ${conflicts.length === 1 ? 'overlap' : 'overlaps'}`,
          items: [
            {
              title: `${conflicts.length} possible ${conflicts.length === 1 ? 'overlap' : 'overlaps'}`,
              detail: 'Calendar overlap does not confirm attendance.',
            },
          ],
          overlaps: conflicts,
        });
      if (duplicateListings.length)
        sections.push({
          type: 'attention',
          title: `${duplicateListings.length} possible duplicate ${duplicateListings.length === 1 ? 'listing' : 'listings'}`,
          items: duplicateListings,
        });
      if (arrivalGuidance.length)
        sections.push({ type: 'attention', title: 'Arrival guidance', items: arrivalGuidance });
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
