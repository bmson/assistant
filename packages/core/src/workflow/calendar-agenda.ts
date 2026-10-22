import { createHash } from 'node:crypto';
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
        const response = text(event.ownerResponse).toLowerCase();
        const status = text(event.status).toLowerCase();
        const note = [
          response === 'needsaction'
            ? 'Needs response'
            : response === 'tentative'
              ? 'Tentative'
              : '',
          status === 'cancelled' ? 'Cancelled' : '',
          event.windowMembership === 'source-date-only'
            ? 'Date could not be verified in the requested window.'
            : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return {
          id: event.id,
          day: event.allDay === true ? 'All day' : 'Timed',
          time: eventTime(event, zone),
          title: text(event.title),
          ...(text(event.location) ? { location: text(event.location) } : {}),
          ...(note ? { note } : {}),
          calendars: list(event.calendars),
          calendarLinks: list(event.calendarLinks),
          ...(event.meetingLink ? { meetingLink: event.meetingLink } : {}),
        };
      });
      const sections: Record<string, unknown>[] = items.length
        ? [{ type: 'agenda', title: dateLabel(day, zone), complete: groupComplete, items }]
        : [];
      if (day === 'unverified' && items.length)
        sections.push({
          type: 'attention',
          title: 'Dates not verified',
          items: [
            { title: 'Some source dates or times could not be verified for the requested window.' },
          ],
        });
      const conflicts: { title: string; detail: string }[] = [];
      for (
        let i = 0;
        input.request?.includeCalendarOverlapSummary !== false && i < events.length;
        i++
      )
        for (let j = i + 1; j < events.length; j++) {
          const a = events[i];
          const b = events[j];
          if (
            !a ||
            !b ||
            a.allDay ||
            b.allDay ||
            a.blocksTime === false ||
            b.blocksTime === false ||
            [a, b].some(
              (event) => event.status === 'cancelled' || event.ownerResponse === 'declined',
            )
          )
            continue;
          if (![a.start, a.end, b.start, b.end].every((value) => INSTANT.test(text(value))))
            continue;
          const from = Math.max(Date.parse(text(a.start)), Date.parse(text(b.start)));
          const to = Math.min(Date.parse(text(a.end)), Date.parse(text(b.end)));
          if (zone && from < to)
            conflicts.push({
              title: `Possible overlap: ${clock(new Date(from).toISOString(), zone)} – ${clock(new Date(to).toISOString(), zone)}`,
              detail: `${text(a.title)} · ${text(b.title)}. Calendar overlap does not confirm attendance.`,
            });
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
