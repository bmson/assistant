import { collapseWhitespace, ownerDate, ownerTime, truncateAtBoundary } from '../owner-text.js';
import type { EventSalience } from '../proactive/calendar-salience.js';
import type { BriefingCalendarEvent, CalendarConflict } from './briefing.js';
import { calendarRelationshipNote } from './calendar-relationship.js';

/**
 * The daily briefing as sections rather than prose.
 *
 * The briefing used to be one model-phrased text block, which on a phone read
 * as a wall. Every item in it already came from a structured row, so the
 * sections are built here, deterministically, from those rows; the model only
 * writes the one-sentence lead. The same sections render twice: as a
 * `briefing` card for clients that know it, and as bold-labelled markdown
 * lists in the message text for clients that do not.
 *
 * Everything is pre-formatted in the owner's zone ("Today", "9:30 AM"), so no
 * client re-derives a time from a timestamp.
 */

export interface BriefingAgendaItem {
  /** "Today", "Tomorrow", or "Thu, Sep 24". */
  day: string;
  /** "9:30 AM – 10:15 AM" or "All day". */
  time: string;
  title: string;
  location?: string;
  /** Why this event deserves a second look, when it does. */
  flag?: 'conflict' | 'salient';
  note?: string;
}

export interface BriefingListItem {
  title: string;
  detail?: string;
  /** A short right-aligned tag: an approval code, a date, a count. */
  meta?: string;
}

export type BriefingSection =
  | {
      type: 'agenda';
      title: string;
      complete: boolean;
      omittedCount?: number;
      items: BriefingAgendaItem[];
    }
  | {
      type: 'weather';
      title: string;
      location: string;
      temperature: string;
      condition: string;
      symbol?: string;
      range?: string;
      rain?: string;
    }
  | {
      type: 'attention' | 'mail' | 'upcoming' | 'goals' | 'watches';
      title: string;
      items: BriefingListItem[];
    };

export interface BriefingCard {
  kind: 'briefing';
  id: string;
  /** The day the briefing is for, as the owner reads it. */
  date: string;
  timeZone: string;
  lead: string;
  sections: BriefingSection[];
}

const MAX_AGENDA = 10;
const DETAIL_LIMIT = 160;

const tidy = (value: string | null | undefined): string => collapseWhitespace(value ?? '');
const brief = (value: string | null | undefined): string =>
  truncateAtBoundary(tidy(value), DETAIL_LIMIT);

function eventKey(event: BriefingCalendarEvent): string {
  return event.eventId ?? `${event.calendar}|${event.start}|${event.summary}`;
}

function eventTime(event: BriefingCalendarEvent, timeZone: string): string {
  if (event.allDay) return 'All day';
  const start = ownerTime(event.start, timeZone);
  if (!event.end) return start;
  // A clock range only reads as one when both ends fall on the same day.
  const sameDay =
    ownerDate(event.start, timeZone, new Date(event.start)) ===
    ownerDate(event.end, timeZone, new Date(event.start));
  return sameDay ? `${start} – ${ownerTime(event.end, timeZone)}` : start;
}

/**
 * The owner's calendar day for an event, as a sortable key. Ordering by raw
 * start instant is wrong for all-day events: their date is midnight UTC, which
 * is the previous evening in California, so tomorrow's paycheck sorted ahead of
 * tonight's practice and the brief read "Tomorrow" above "Today". Events keep
 * their incoming order within a day (the sort is stable).
 */
function localDayOrder(event: BriefingCalendarEvent, timeZone: string): string {
  const day = event.allDay
    ? event.start.slice(0, 10)
    : new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(event.start));
  return day;
}

function eventDay(event: BriefingCalendarEvent, timeZone: string, now: Date): string {
  if (!event.allDay) return ownerDate(event.start, timeZone, now);
  // Compare civil dates in UTC after resolving the owner's current civil day.
  // Noon UTC itself crosses into tomorrow at UTC+12/+13/+14.
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return ownerDate(`${event.start.slice(0, 10)}T12:00:00Z`, 'UTC', new Date(`${today}T12:00:00Z`));
}

export function agendaSection(input: {
  events: BriefingCalendarEvent[];
  complete: boolean;
  conflicts: CalendarConflict[];
  salient: EventSalience[];
  timeZone: string;
  now: Date;
}): BriefingSection | undefined {
  if (!input.events.length) return undefined;
  const conflicting = new Set(
    input.conflicts.flatMap((conflict) => [...conflict.a, ...conflict.b].map(eventKey)),
  );
  const notes = new Map(
    input.salient.map((scored) => [eventKey(scored.event), tidy(scored.reasons.join('; '))]),
  );
  const conflictNotes = new Map(
    input.conflicts.flatMap((conflict) =>
      [...conflict.a, ...conflict.b].map(
        (event) =>
          [
            eventKey(event),
            calendarRelationshipNote(
              conflict.relationship ?? 'unresolved',
              conflict.attendance ?? 'unresolved',
            ),
          ] as const,
      ),
    ),
  );
  const important = (event: BriefingCalendarEvent) =>
    conflicting.has(eventKey(event)) || notes.has(eventKey(event));
  const selected = [...input.events]
    .sort((a, b) => Number(important(b)) - Number(important(a)))
    .slice(0, MAX_AGENDA)
    .sort(
      (a, b) =>
        localDayOrder(a, input.timeZone).localeCompare(localDayOrder(b, input.timeZone)) ||
        input.events.indexOf(a) - input.events.indexOf(b),
    );
  const omittedCount = input.events.length - selected.length;
  return {
    type: 'agenda',
    title:
      omittedCount > 0
        ? `Schedule (${selected.length} of ${input.events.length} events)`
        : 'Schedule',
    complete: input.complete,
    ...(omittedCount > 0 ? { omittedCount } : {}),
    items: selected.map((event) => {
      const key = eventKey(event);
      const location = tidy(event.location);
      const note = notes.get(key);
      const flag = conflicting.has(key) ? 'conflict' : note ? 'salient' : undefined;
      return {
        day: eventDay(event, input.timeZone, input.now),
        time: eventTime(event, input.timeZone),
        title: tidy(event.summary) || 'Untitled event',
        ...(location ? { location } : {}),
        ...(flag ? { flag } : {}),
        ...(flag === 'conflict'
          ? { note: conflictNotes.get(key) ?? 'Overlaps another event; attendance is unverified.' }
          : note
            ? { note: truncateAtBoundary(note, DETAIL_LIMIT) }
            : {}),
      };
    }),
  };
}

/** The ambient weather card, reduced to one glanceable line for the briefing. */
export function weatherSection(
  card: Record<string, unknown> | undefined,
): BriefingSection | undefined {
  if (card?.kind !== 'weather') return undefined;
  const temperature = typeof card.temperature === 'string' ? card.temperature : '';
  const condition = typeof card.condition === 'string' ? card.condition : '';
  if (!temperature || !condition) return undefined;
  const current = (card.current ?? {}) as Record<string, unknown>;
  const low = typeof current.lowC === 'number' ? current.lowC : undefined;
  const high = typeof current.highC === 'number' ? current.highC : undefined;
  const rain = typeof current.precipPct === 'number' ? current.precipPct : undefined;
  return {
    type: 'weather',
    title: 'Weather',
    location: typeof card.location === 'string' ? card.location : '',
    temperature,
    condition,
    ...(typeof card.symbol === 'string' ? { symbol: card.symbol } : {}),
    ...(low !== undefined && high !== undefined ? { range: `${low}–${high}°C` } : {}),
    // Only a chance worth planning around earns a mention.
    ...(rain !== undefined && rain >= 30 ? { rain: `${rain}% chance of rain` } : {}),
  };
}

export function listSection(
  type: 'attention' | 'mail' | 'upcoming' | 'goals' | 'watches',
  title: string,
  items: BriefingListItem[],
): BriefingSection | undefined {
  const kept = items
    .map((item) => ({
      title: tidy(item.title),
      ...(item.detail && tidy(item.detail) ? { detail: brief(item.detail) } : {}),
      ...(item.meta && tidy(item.meta) ? { meta: tidy(item.meta) } : {}),
    }))
    .filter((item) => item.title);
  return kept.length ? { type, title, items: kept } : undefined;
}

/**
 * The same briefing as markdown: the lead, then one bold label per section
 * followed by its list. It is the message text, so it is also what an older
 * client, a search, and the model's own history see.
 */
export function briefingMarkdown(lead: string, sections: BriefingSection[]): string {
  const blocks = [lead.trim()];
  for (const section of sections) {
    if (section.type === 'weather') {
      const reading = [
        `${section.temperature}, ${section.condition.toLowerCase()}`,
        section.range,
        section.rain,
      ]
        .filter(Boolean)
        .join(' · ');
      blocks.push(
        `**${section.title}**\n- ${reading}${section.location ? ` — ${section.location}` : ''}`,
      );
      continue;
    }
    if (section.type === 'agenda') {
      const days: string[] = [];
      for (const item of section.items) if (!days.includes(item.day)) days.push(item.day);
      for (const day of days) {
        const rows = section.items
          .filter((item) => item.day === day)
          .map((item) =>
            [
              `- **${item.time}** — ${item.title}`,
              item.location ? ` — ${item.location}` : '',
              item.note ? ` · ${item.note}` : '',
            ].join(''),
          );
        blocks.push(`**${day}**\n${rows.join('\n')}`);
      }
      if (!section.complete)
        blocks.push('Some calendars could not be read, so this may be incomplete.');
      if (section.omittedCount)
        blocks.push(
          `${section.omittedCount} other retrieved events are omitted from this briefing preview.`,
        );
      continue;
    }
    const rows = section.items.map(
      (item) =>
        `- ${item.meta ? `**${item.meta}** — ` : ''}${item.title}${item.detail ? ` — ${item.detail}` : ''}`,
    );
    blocks.push(`**${section.title}**\n${rows.join('\n')}`);
  }
  return blocks.filter(Boolean).join('\n\n');
}
