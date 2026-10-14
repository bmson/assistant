export interface CalendarEventAnalysisRequest {
  weekdayCount: number;
  minimumDurationMinutes?: number;
  minimumInPersonGapMinutes?: number;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export function parseCalendarWeekdayCount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const count = NUMBER_WORDS[value.toLowerCase()] ?? Number(value);
  return Number.isInteger(count) && count >= 1 && count <= 10 ? count : undefined;
}

/** Detect a bounded, read-only calendar statistics request without treating it as a focus plan. */
export function requestedCalendarEventAnalysis(
  text: string,
): CalendarEventAnalysisRequest | undefined {
  if (!/\b(?:calendar|schedule)\b/i.test(text)) return undefined;
  const days =
    /\bnext\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+weekdays?\b/i.exec(text);
  const weekdayCount = parseCalendarWeekdayCount(days?.[1]);
  if (!weekdayCount) return undefined;

  const duration =
    /\b(?:events?|appointments?)\b[^.!?\n]{0,80}?\b(?:lasting|that\s+last|of)\s+(?:at\s+least\s+)?(\d{1,3})\s*(?:minutes?|mins?)\b/i.exec(
      text,
    ) ??
    /\bcount\s+(?:events?|appointments?)\s+(?:of\s+)?(?:at\s+least\s+)?(\d{1,3})\s*(?:minutes?|mins?)\b/i.exec(
      text,
    );
  const minimumDurationMinutes = duration ? Number(duration[1] ?? duration[2]) : undefined;
  if (
    minimumDurationMinutes !== undefined &&
    (!Number.isInteger(minimumDurationMinutes) ||
      minimumDurationMinutes < 1 ||
      minimumDurationMinutes > 720)
  )
    return undefined;

  const gap =
    /\bgaps?\s+(?:of\s+)?(?:at\s+least\s+)?(\d{1,3})\s*(?:minutes?|mins?)(?:\s+or\s+more)?\b/i.exec(
      text,
    );
  const minimumInPersonGapMinutes =
    gap && /\b(?:explicitly\s+)?(?:marked|labeled|labelled)\s+(?:as\s+)?in[- ]person\b/i.test(text)
      ? Number(gap[1] ?? gap[2])
      : undefined;
  if (
    minimumInPersonGapMinutes !== undefined &&
    (!Number.isInteger(minimumInPersonGapMinutes) ||
      minimumInPersonGapMinutes < 1 ||
      minimumInPersonGapMinutes > 720)
  )
    return undefined;
  if (minimumDurationMinutes === undefined && minimumInPersonGapMinutes === undefined)
    return undefined;

  return {
    weekdayCount,
    ...(minimumDurationMinutes !== undefined ? { minimumDurationMinutes } : {}),
    ...(minimumInPersonGapMinutes !== undefined ? { minimumInPersonGapMinutes } : {}),
  };
}

interface TimedEvent {
  source: Record<string, unknown>;
  title: string;
  start: number;
  end: number;
  location: string;
  explicitlyInPerson: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function partsAt(
  instant: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const part = (kind: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === kind)?.value);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
  };
}

function dateKey(date: { year: number; month: number; day: number }): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function nextDate(date: { year: number; month: number; day: number }): {
  year: number;
  month: number;
  day: number;
} {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function zonedMidnight(
  date: { year: number; month: number; day: number },
  timeZone: string,
): number {
  const target = Date.UTC(date.year, date.month - 1, date.day);
  let guess = target;
  for (let index = 0; index < 4; index += 1) {
    const actual = partsAt(guess, timeZone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const difference = target - represented;
    if (difference === 0) break;
    guess += difference;
  }
  return guess;
}

function requestedDays(
  timeMin: string,
  timeMax: string,
  timeZone: string,
  limit: number,
): Array<{ date: string; start: number; end: number }> {
  const startMs = Date.parse(timeMin);
  const endMs = Date.parse(timeMax);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  let date: { year: number; month: number; day: number } = partsAt(startMs, timeZone);
  const endDate = partsAt(endMs, timeZone);
  const days = [];
  for (
    let index = 0;
    index < 21 && dateKey(date) < dateKey(endDate) && days.length < limit;
    index += 1
  ) {
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    if (weekday >= 1 && weekday <= 5) {
      days.push({
        date: dateKey(date),
        start: zonedMidnight(date, timeZone),
        end: zonedMidnight(nextDate(date), timeZone),
      });
    }
    date = nextDate(date);
  }
  return days;
}

function isExplicitlyInPerson(event: Record<string, unknown>): boolean {
  for (const value of [event.attendanceMode, event.eventMode, event.mode]) {
    if (
      typeof value === 'string' &&
      /^(?:in[-_ ]?person|on[-_ ]?site|face[-_ ]?to[-_ ]?face)$/i.test(value.trim())
    )
      return true;
  }
  const label = `${text(event.summary)}\n${text(event.description)}`;
  if (
    /\b(?:not|no|virtual|remote|online)\b[^.!?\n]{0,30}\b(?:in[- ]person|on[- ]site|onsite|face[- ]to[- ]face)\b/i.test(
      label,
    )
  )
    return false;
  return (
    /\b(?:attendance|event\s+)?(?:mode|format)\s*[:=—-]\s*(?:in[- ]person|on[- ]site|onsite|face[- ]to[- ]face)\b/i.test(
      label,
    ) ||
    /\b(?:explicitly\s+)?(?:marked|labeled|labelled)\s+(?:as\s+)?(?:in[- ]person|on[- ]site|onsite|face[- ]to[- ]face)\b/i.test(
      label,
    ) ||
    /\b(?:in[- ]person|on[- ]site|onsite|face[- ]to[- ]face)\s+(?:meeting|appointment|event)\b/i.test(
      label,
    )
  );
}

function safeLink(event: Record<string, unknown>): string {
  const links = Array.isArray(event.links) ? event.links.map(record).filter(Boolean) : [];
  const candidate = links.find((link) => /^https?:\/\//i.test(text(link?.url)));
  const url = text(candidate?.url);
  if (!url) return '';
  const label =
    text(candidate?.label).replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]') ||
    'Source event';
  const safeUrl = url.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  return `[${label}](${safeUrl})`;
}

function clock(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(instant));
}

function displayDay(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00.000Z`));
}

function eventTimeRange(event: TimedEvent, timeZone: string): string {
  const startDate = dateKey(partsAt(event.start, timeZone));
  const endDate = dateKey(partsAt(event.end, timeZone));
  if (startDate === endDate) return `${clock(event.start, timeZone)}–${clock(event.end, timeZone)}`;
  return `${displayDay(startDate)} ${clock(event.start, timeZone)}–${displayDay(endDate)} ${clock(event.end, timeZone)}`;
}

function plainText(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|>~-]/g, '\\$&');
}

function title(event: TimedEvent): string {
  return plainText(event.title).slice(0, 140) || 'Untitled event';
}

function linkSuffix(event: TimedEvent): string {
  const link = safeLink(event.source);
  return link ? ` ${link}` : '';
}

/** Deterministic owner-timezone duration counts and explicit-mode gaps from bounded calendar evidence. */
export function calendarEventAnalysisResponse(input: {
  request: CalendarEventAnalysisRequest;
  timeWindow?: { timeMin: string; timeMax: string };
  timeZone?: string;
  events: ReadonlyArray<Record<string, unknown>>;
  coverageComplete: boolean;
}): string {
  const timeZone = input.timeZone;
  if (!timeZone || !input.timeWindow)
    return 'I couldn’t safely resolve the calendar window and configured owner time zone.';
  let days: ReturnType<typeof requestedDays>;
  try {
    days = requestedDays(
      input.timeWindow.timeMin,
      input.timeWindow.timeMax,
      timeZone,
      input.request.weekdayCount,
    );
  } catch {
    return 'I couldn’t safely resolve the calendar window in the configured owner time zone.';
  }
  if (days.length !== input.request.weekdayCount)
    return 'I couldn’t safely resolve all requested weekdays in the configured owner time zone.';

  const seen = new Set<string>();
  const timed: TimedEvent[] = [];
  let missingTimeCount = 0;
  for (const source of input.events) {
    if (text(source.status).toLowerCase() === 'cancelled') continue;
    const eventId = text(source.eventId);
    const calendarId = text(source.calendarId);
    const stableId = eventId && calendarId ? `${calendarId}\0${eventId}` : '';
    if (stableId && seen.has(stableId)) continue;
    if (stableId) seen.add(stableId);
    const rawStart = text(source.start);
    const rawEnd = text(source.end);
    const start = Date.parse(rawStart);
    const end = Date.parse(rawEnd);
    if (
      !rawStart ||
      !rawEnd ||
      /^\d{4}-\d{2}-\d{2}$/.test(rawStart) ||
      /^\d{4}-\d{2}-\d{2}$/.test(rawEnd) ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start
    ) {
      missingTimeCount += 1;
      continue;
    }
    timed.push({
      source,
      title: text(source.summary),
      start,
      end,
      location: text(source.location),
      explicitlyInPerson: isExplicitlyInPerson(source),
    });
  }

  const lines = [
    `Calendar review for the next ${input.request.weekdayCount} weekdays, using the configured owner time zone (${timeZone}). The event data does not identify a separate calendar time zone.`,
  ];
  const countsComplete = input.coverageComplete && missingTimeCount === 0;
  const durationThreshold = input.request.minimumDurationMinutes;
  if (durationThreshold !== undefined) {
    lines.push(
      `Events lasting at least ${durationThreshold} minutes (counted on each local day they overlap):`,
    );
    for (const day of days) {
      const matching = timed.filter(
        (event) =>
          event.end > day.start &&
          event.start < day.end &&
          (event.end - event.start) / 60_000 >= durationThreshold,
      );
      const countText = countsComplete
        ? `${matching.length}`
        : `at least ${matching.length} in the checked subset`;
      lines.push(
        `- ${displayDay(day.date)}: ${countText} qualifying ${matching.length === 1 ? 'event' : 'events'}.`,
      );
      for (const event of matching) {
        const location = event.location ? ` — ${plainText(event.location)}` : '';
        lines.push(
          `  ${title(event)} (${eventTimeRange(event, timeZone)})${location}${linkSuffix(event)}`,
        );
      }
    }
  }

  const gapThreshold = input.request.minimumInPersonGapMinutes;
  if (gapThreshold !== undefined) {
    lines.push(
      `Gaps of at least ${gapThreshold} minutes between consecutive events explicitly marked in person:`,
    );
    let gapCount = 0;
    for (const day of days) {
      const onDay = timed
        .filter((event) => event.start < day.end && event.end > day.start)
        .sort((left, right) => left.start - right.start || left.end - right.end);
      const gaps = [];
      let frontierEnd: number | undefined;
      let frontierEvents: TimedEvent[] = [];
      for (const next of onDay) {
        if (frontierEnd === undefined) {
          frontierEnd = next.end;
          frontierEvents = [next];
          continue;
        }
        if (next.start > frontierEnd) {
          const previous = frontierEvents.length === 1 ? frontierEvents[0] : undefined;
          const minutes = (next.start - frontierEnd) / 60_000;
          if (
            previous?.explicitlyInPerson &&
            next.explicitlyInPerson &&
            previous.end >= day.start &&
            next.start <= day.end &&
            minutes >= gapThreshold
          )
            gaps.push({ previous, next, minutes });
          frontierEnd = next.end;
          frontierEvents = [next];
        } else if (next.end > frontierEnd) {
          frontierEnd = next.end;
          frontierEvents = [next];
        } else if (next.end === frontierEnd) {
          // If multiple overlapping events establish the same end boundary,
          // the in-person source for a later gap is ambiguous.
          frontierEvents.push(next);
        }
      }
      if (gaps.length === 0) continue;
      for (const gap of gaps) {
        gapCount += 1;
        const from = clock(gap.previous.end, timeZone);
        const to = clock(gap.next.start, timeZone);
        const previousLocation = gap.previous.location ? ` at ${gap.previous.location}` : '';
        const nextLocation = gap.next.location ? ` at ${gap.next.location}` : '';
        lines.push(
          `- ${day.date}: ${Math.floor(gap.minutes)} minutes, ${from}–${to}, between ${title(gap.previous)}${previousLocation} and ${title(gap.next)}${nextLocation}.${linkSuffix(gap.previous)}${linkSuffix(gap.next)}`,
        );
      }
    }
    if (gapCount === 0)
      lines.push(
        countsComplete
          ? '- No qualifying gaps were found among events explicitly marked in person.'
          : '- No qualifying gaps appeared among the timed events explicitly marked in person; missing times or incomplete calendar coverage may conceal additional gaps.',
      );
    lines.push(
      'A location alone was not treated as evidence that an event is in person. No travel time was inferred.',
    );
  }

  if (!input.coverageComplete)
    lines.push(
      'Calendar coverage was incomplete, so counts and gaps describe only the events returned in the checked subset.',
    );
  if (missingTimeCount > 0)
    lines.push(
      `${missingTimeCount} event(s) with missing, all-day, or invalid start/end times were excluded from duration and gap calculations.`,
    );
  return lines.join('\n');
}
