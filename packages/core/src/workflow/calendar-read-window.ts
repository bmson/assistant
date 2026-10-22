import type { PersonalReadRequest } from './read-intent.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const boundaryFormatters = new Map<string, Intl.DateTimeFormat>();
const MAX_BOUNDARY_FORMATTERS = 16;
const field = (event: Record<string, unknown>, key: string) =>
  typeof event[key] === 'string' ? (event[key] as string) : '';

/** Date-only values are civil source dates, never UTC midnight instants. */
export function calendarCivilBoundary(day: string, timeZone: string): number | undefined {
  if (!DATE_ONLY.test(day)) return undefined;
  const target = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== day)
    return undefined;
  let candidate = target;
  try {
    let formatter = boundaryFormatters.get(timeZone);
    if (formatter) {
      boundaryFormatters.delete(timeZone);
      boundaryFormatters.set(timeZone, formatter);
    } else {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
      if (boundaryFormatters.size >= MAX_BOUNDARY_FORMATTERS) {
        const oldest = boundaryFormatters.keys().next().value;
        if (oldest !== undefined) boundaryFormatters.delete(oldest);
      }
      boundaryFormatters.set(timeZone, formatter);
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const parts = formatter.formatToParts(new Date(candidate));
      const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
      const correction =
        target -
        Date.UTC(
          part('year'),
          part('month') - 1,
          part('day'),
          part('hour'),
          part('minute'),
          part('second'),
        );
      if (correction === 0) return candidate;
      candidate += correction;
    }
  } catch {
    /* Invalid source zone does not establish an instant. */
  }
  return undefined;
}

export function calendarSourceInterval(
  event: Record<string, unknown>,
): { start: number; end: number } | undefined {
  const start = field(event, 'start');
  const end = field(event, 'end');
  const dateOnly = DATE_ONLY.test(start) || DATE_ONLY.test(end);
  const zone = field(event, 'calendarTimeZone');
  if (dateOnly && !zone) return undefined;
  const from = dateOnly ? calendarCivilBoundary(start, zone) : Date.parse(start);
  const to = dateOnly ? calendarCivilBoundary(end, zone) : Date.parse(end);
  return from !== undefined &&
    to !== undefined &&
    Number.isFinite(from) &&
    Number.isFinite(to) &&
    to > from
    ? { start: from, end: to }
    : undefined;
}

export type CalendarWindowMembership = 'confirmed' | 'source-date-only' | 'outside';

/** Missing calendar-zone metadata cannot turn a floating date into the prior local day. */
export function calendarWindowMembership(
  event: Record<string, unknown>,
  request?: PersonalReadRequest | null,
): CalendarWindowMembership {
  if (!request?.timeWindow) return 'confirmed';
  const from = Date.parse(request.timeWindow.timeMin);
  const to = Date.parse(request.timeWindow.timeMax);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 'source-date-only';
  const interval = calendarSourceInterval(event);
  if (!interval) return 'source-date-only';
  return interval.start < to && interval.end > from ? 'confirmed' : 'outside';
}

export function calendarSourceDateLabel(event: Record<string, unknown>): string {
  const start = field(event, 'start');
  if (!DATE_ONLY.test(start)) return '';
  const end = field(event, 'end');
  const endInstant = DATE_ONLY.test(end) ? Date.parse(`${end}T12:00:00Z`) : NaN;
  const inclusive = Number.isFinite(endInstant)
    ? new Date(endInstant - 86_400_000).toISOString().slice(0, 10)
    : '';
  const range = inclusive && inclusive > start ? `${start}–${inclusive}` : start;
  const zone = field(event, 'calendarTimeZone');
  return `source date ${range}${zone ? ` (${zone})` : '; calendar time zone unavailable'}`;
}
