import { sameCalendarOccurrence } from '@assistant/persistence';
import { canonicalOccurrenceGroups } from './calendar-relationship.js';
import { safeCalendarSourceUrl } from './calendar-source-link.js';

// The governed read path permits three pages of at most fifty source rows.
const MAX_ANALYSIS_RECORDS = 3 * 50;

export interface CalendarEventAnalysisRequest {
  weekdayCount: number;
  minimumDurationMinutes?: number;
  durationCountMode?: 'days' | 'events';
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

  const asksForDayCount =
    /\bhow\s+many\s+(?:week)?days?\b[^.!?\n]{0,100}\b(?:have|had|with|contain|include)\b[^.!?\n]{0,80}\b(?:event|appointment)s?\b/i.test(
      text,
    ) ||
    /\bhow\s+many\s+(?:of\s+)?(?:the\s+)?(?:next\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+weekdays?\b[^.!?\n]{0,100}\b(?:have|had|with|contain|include)\b[^.!?\n]{0,80}\b(?:event|appointment)s?\b/i.test(
      text,
    ) ||
    /\bcount\s+(?:the\s+)?(?:week)?days?\b[^.!?\n]{0,100}\b(?:have|had|with|contain|include)\b[^.!?\n]{0,80}\b(?:event|appointment)s?\b/i.test(
      text,
    ) ||
    /\b(?:number|count)\s+of\s+(?:week)?days?\b[^.!?\n]{0,80}\b(?:with|having|containing|including)\b[^.!?\n]{0,80}\b(?:event|appointment)s?\b/i.test(
      text,
    );
  const durationCountMode =
    minimumDurationMinutes === undefined ? undefined : asksForDayCount ? 'days' : 'events';

  return {
    weekdayCount,
    ...(minimumDurationMinutes !== undefined ? { minimumDurationMinutes } : {}),
    ...(minimumDurationMinutes !== undefined ? { durationCountMode } : {}),
    ...(minimumInPersonGapMinutes !== undefined ? { minimumInPersonGapMinutes } : {}),
  };
}

interface TimedEvent {
  sources: Record<string, unknown>[];
  title: string;
  start: number;
  end: number;
  location: string;
  explicitlyInPerson: boolean;
  sourceDetails?: string;
}

interface AnalyzedOccurrence {
  sources: Record<string, unknown>[];
  start?: number;
  end?: number;
  title: string;
  location: string;
  durationResolved: boolean;
  identityResolved: boolean;
  gapEligible: boolean;
  sourceDetails?: string;
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
  const candidate = links.find((link) => Boolean(safeCalendarSourceUrl(text(link?.url))));
  const url = candidate ? safeCalendarSourceUrl(text(candidate.url)) : undefined;
  if (!url) return '';
  const label =
    text(candidate?.label).replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]') ||
    'Source event';
  return `[${label}](${url.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')})`;
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

function sourceLabel(source: Record<string, unknown>, index: number): string {
  return plainText(text(source.calendar) || text(source.calendarId) || `Source ${index + 1}`);
}

function sourceTitle(source: Record<string, unknown>): string {
  const value = text(source.summary);
  return value ? `“${plainText(value).slice(0, 140)}”` : 'Untitled event';
}

function sourceStatus(source: Record<string, unknown>): string {
  const status = text(source.status).toLowerCase();
  if (status === 'cancelled') return 'cancelled';
  if (status === 'confirmed') return 'confirmed';
  if (status === 'tentative') return 'tentative';
  return status ? 'status unspecified' : 'status not provided';
}

function sourceAttendanceMode(source: Record<string, unknown>): string {
  if (isExplicitlyInPerson(source)) return 'in person';
  const value = text(source.attendanceMode ?? source.eventMode ?? source.mode).toLowerCase();
  if (/^(?:in[-_ ]?person|on[-_ ]?site|face[-_ ]?to[-_ ]?face)$/.test(value)) return 'in person';
  if (/^(?:online|virtual|remote)$/.test(value)) return 'online';
  return value ? 'mode unspecified' : 'mode not provided';
}

function eventBounds(source: Record<string, unknown>): { start: number; end: number } | undefined {
  const rawStart = text(source.start);
  const rawEnd = text(source.end);
  if (
    !rawStart ||
    !rawEnd ||
    /^\d{4}-\d{2}-\d{2}$/.test(rawStart) ||
    /^\d{4}-\d{2}-\d{2}$/.test(rawEnd)
  )
    return undefined;
  const start = Date.parse(rawStart);
  const end = Date.parse(rawEnd);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : undefined;
}

function identityIsUnresolved(source: Record<string, unknown>): boolean {
  const calendarId = text(source.calendarId);
  const eventId = text(source.eventId);
  const recurring = Boolean(text(source.recurringEventId));
  const rawOriginal = text(source.originalStartTime);
  if (!calendarId || !eventId) return true;
  if (rawOriginal && !Number.isFinite(Date.parse(rawOriginal))) return true;
  return recurring && !rawOriginal;
}

function ambiguousIdentitySources(
  events: ReadonlyArray<Record<string, unknown>>,
  groups: Record<string, unknown>[][],
): Set<Record<string, unknown>> {
  const groupForSource = new Map<Record<string, unknown>, number>();
  groups.forEach((group, groupIndex) => {
    for (const source of group) groupForSource.set(source, groupIndex);
  });

  const ambiguous = new Set<Record<string, unknown>>();
  for (let leftIndex = 0; leftIndex < events.length; leftIndex += 1) {
    const left = events[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < events.length; rightIndex += 1) {
      const right = events[rightIndex];
      if (!right || groupForSource.get(left) === groupForSource.get(right)) continue;

      const sameOccurrence = sameCalendarOccurrence(left, right);
      const leftUid = text(left.iCalUID);
      const rightUid = text(right.iCalUID);
      const crossCalendarUid =
        leftUid !== '' &&
        leftUid === rightUid &&
        text(left.calendarId) !== '' &&
        text(right.calendarId) !== '' &&
        text(left.calendarId) !== text(right.calendarId);
      const leftOriginal = text(left.originalStartTime);
      const rightOriginal = text(right.originalStartTime);
      const leftHasValidOriginal = leftOriginal !== '' && Number.isFinite(Date.parse(leftOriginal));
      const rightHasValidOriginal =
        rightOriginal !== '' && Number.isFinite(Date.parse(rightOriginal));
      const asymmetricOriginal = crossCalendarUid && leftHasValidOriginal !== rightHasValidOriginal;

      if (sameOccurrence || asymmetricOriginal) {
        ambiguous.add(left);
        ambiguous.add(right);
      }
    }
  }
  return ambiguous;
}

function sourceComparison(
  sources: Record<string, unknown>[],
  timeZone: string,
  differences: string[],
): string | undefined {
  if (sources.length === 1 && differences.length === 0) return undefined;
  const details = sources.map((source, index) => {
    const bounds = eventBounds(source);
    const time = bounds
      ? `${eventTimeRange({ sources: [source], title: '', ...bounds, location: '', explicitlyInPerson: false }, timeZone)}`
      : 'time unavailable';
    const location = text(source.location);
    const metadata = [
      sourceTitle(source),
      time,
      sourceStatus(source),
      sourceAttendanceMode(source),
      location ? plainText(location).slice(0, 100) : 'location not provided',
    ].join('; ');
    const links = sourceLinks([source]);
    return `${sourceLabel(source, index)} — ${metadata}${links ? ` ${links}` : ''}`;
  });
  const suffix = differences.length > 0 ? ` ${differences.join(' ')}` : '';
  return `Source comparison: ${details.join(' · ')}.${suffix}`;
}

function sourceLinks(sources: Record<string, unknown>[]): string {
  const links = new Set<string>();
  for (const source of sources) {
    const value = safeLink(source);
    if (value) links.add(value);
  }
  return [...links].join(' ');
}

function linkSuffix(event: TimedEvent): string {
  const link = sourceLinks(event.sources);
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

  if (input.events.length > MAX_ANALYSIS_RECORDS) {
    const lines = [
      'Too many calendar listings were returned to complete this analysis safely. Narrow the date window and try again.',
    ];
    if (!input.coverageComplete)
      lines.push(
        'Calendar coverage was incomplete, so the returned listings may not include every calendar entry in the requested window.',
      );
    return lines.join('\n');
  }

  const occurrenceGroups = canonicalOccurrenceGroups(input.events);
  const ambiguousIdentities = ambiguousIdentitySources(input.events, occurrenceGroups);
  const occurrences: AnalyzedOccurrence[] = [];
  const timed: TimedEvent[] = [];
  let missingTimeCount = 0;
  let unresolvedIdentityCount = 0;
  let unresolvedSourceCount = 0;
  let hasUnknownPlacement = false;
  for (const sources of occurrenceGroups) {
    if (sources.every((source) => text(source.status).toLowerCase() === 'cancelled')) continue;
    const bounds = sources.map(eventBounds);
    const knownBounds = bounds.filter((value): value is NonNullable<typeof value> =>
      Boolean(value),
    );
    const boundMismatch =
      knownBounds.length !== sources.length ||
      knownBounds.some(
        (value) => value.start !== knownBounds[0]?.start || value.end !== knownBounds[0]?.end,
      );
    const statuses = new Set(sources.map((source) => text(source.status).toLowerCase()));
    const titles = new Set(sources.map((source) => text(source.summary)));
    const locations = new Set(sources.map((source) => text(source.location)));
    const modes = new Set(sources.map(sourceAttendanceMode));
    const statusMismatch = statuses.size > 1;
    const titleMismatch = titles.size > 1;
    const locationMismatch = locations.size > 1;
    const modeMismatch = modes.size > 1;
    const durationResolved = !boundMismatch && !statusMismatch;
    const identityResolved = sources.every(
      (source) => !identityIsUnresolved(source) && !ambiguousIdentities.has(source),
    );
    const allInPerson = sources.every(isExplicitlyInPerson);
    const gapEligible =
      durationResolved && identityResolved && allInPerson && !modeMismatch && !locationMismatch;
    const validDates = knownBounds;
    const start =
      validDates.length > 0 ? Math.min(...validDates.map((value) => value.start)) : undefined;
    const end =
      validDates.length > 0 ? Math.max(...validDates.map((value) => value.end)) : undefined;
    const distinctTitles = [...titles].filter(Boolean);
    const displayTitle = titleMismatch
      ? 'Calendar sources list different titles'
      : (distinctTitles[0] ?? 'Untitled event');
    const differences = [
      ...(boundMismatch ? ['Source times disagree.'] : []),
      ...(statusMismatch ? ['Source status differs.'] : []),
      ...(modeMismatch ? ['Attendance mode differs by source.'] : []),
      ...(locationMismatch ? ['Location differs by source.'] : []),
      ...(titleMismatch ? ['Source titles differ.'] : []),
      ...(!identityResolved ? ['Unique occurrence count is unresolved.'] : []),
    ];
    const sourceDetails =
      sources.length > 1 || differences.length > 0
        ? sourceComparison(sources, timeZone, differences)
        : undefined;
    const location = locationMismatch ? '' : sources[0] ? text(sources[0].location) : '';
    occurrences.push({
      sources,
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
      title: displayTitle,
      location,
      durationResolved,
      identityResolved,
      gapEligible,
      ...(sourceDetails ? { sourceDetails } : {}),
    });

    if (!identityResolved) unresolvedIdentityCount += sources.length;
    if (!durationResolved) unresolvedSourceCount += 1;
    const invalidBoundsCount = sources.length - knownBounds.length;
    if (invalidBoundsCount > 0) {
      missingTimeCount += invalidBoundsCount;
      hasUnknownPlacement = true;
    }

    if (boundMismatch) {
      for (const boundsValue of knownBounds) {
        timed.push({
          sources,
          title: displayTitle,
          ...boundsValue,
          location: '',
          explicitlyInPerson: false,
          ...(sourceDetails ? { sourceDetails } : {}),
        });
      }
    } else if (start !== undefined && end !== undefined) {
      timed.push({
        sources,
        title: displayTitle,
        start,
        end,
        location,
        explicitlyInPerson: gapEligible,
        ...(sourceDetails ? { sourceDetails } : {}),
      });
    }
  }

  const lines = [
    `Calendar review for the next ${input.request.weekdayCount} weekdays, using the configured owner time zone (${timeZone}). The event data does not identify a separate calendar time zone.`,
  ];
  const countsComplete =
    input.coverageComplete &&
    missingTimeCount === 0 &&
    unresolvedSourceCount === 0 &&
    unresolvedIdentityCount === 0;
  const durationThreshold = input.request.minimumDurationMinutes;
  const emittedSourceDetails = new Set<string>();
  if (durationThreshold !== undefined) {
    const dailyMatches = days.map((day) => ({
      day,
      matching: occurrences.filter(
        (occurrence) =>
          occurrence.durationResolved &&
          occurrence.start !== undefined &&
          occurrence.end !== undefined &&
          occurrence.end > day.start &&
          occurrence.start < day.end &&
          (occurrence.end - occurrence.start) / 60_000 >= durationThreshold,
      ),
      unresolved: occurrences.filter(
        (occurrence) =>
          !occurrence.durationResolved &&
          occurrence.start !== undefined &&
          occurrence.end !== undefined &&
          occurrence.end > day.start &&
          occurrence.start < day.end &&
          occurrence.sources.some((source) => {
            const bounds = eventBounds(source);
            return bounds && (bounds.end - bounds.start) / 60_000 >= durationThreshold;
          }),
      ),
    }));
    if (input.request.durationCountMode === 'days') {
      const matchingDays = dailyMatches.filter(({ matching }) => matching.length > 0).length;
      const tally = countsComplete
        ? `${matchingDays} of ${days.length} requested weekdays`
        : `at least ${matchingDays} in the checked subset of ${days.length} requested weekdays`;
      lines.push(`Days with at least one event lasting ${durationThreshold} minutes: ${tally}.`);
    }
    lines.push(
      `Events lasting at least ${durationThreshold} minutes (counted on each local day they overlap):`,
    );
    for (const { day, matching, unresolved } of dailyMatches) {
      const identityUncertainListings = matching
        .filter((occurrence) => !occurrence.identityResolved)
        .reduce((count, occurrence) => count + occurrence.sources.length, 0);
      const resolvedCount = matching.filter((occurrence) => occurrence.identityResolved).length;
      const listingCount =
        matching.length -
        matching.filter((occurrence) => !occurrence.identityResolved).length +
        identityUncertainListings;
      const countText =
        identityUncertainListings > 0
          ? `at least ${listingCount} qualifying returned listings; unique occurrence count unresolved.`
          : countsComplete
            ? `${matching.length} qualifying ${matching.length === 1 ? 'event' : 'events'}.`
            : `at least ${resolvedCount} qualifying ${resolvedCount === 1 ? 'event' : 'events'} in the checked subset${unresolved.length > 0 ? '; additional source times or statuses remain unresolved' : ''}.`;
      lines.push(`- ${displayDay(day.date)}: ${countText}`);
      for (const event of matching) {
        const location = event.location ? ` — ${plainText(event.location)}` : '';
        const start = event.start;
        const end = event.end;
        if (start === undefined || end === undefined) continue;
        lines.push(
          `  ${plainText(event.title).slice(0, 140) || 'Untitled event'} (${eventTimeRange({ sources: event.sources, title: event.title, start, end, location: event.location, explicitlyInPerson: event.gapEligible }, timeZone)})${location}${sourceLinks(event.sources) ? ` ${sourceLinks(event.sources)}` : ''}`,
        );
        if (event.sourceDetails) {
          lines.push(`    ${event.sourceDetails}`);
          emittedSourceDetails.add(event.sourceDetails);
        }
      }
      for (const unresolvedOccurrence of unresolved) {
        if (unresolvedOccurrence.sourceDetails) {
          lines.push(`  ${unresolvedOccurrence.sourceDetails}`);
          emittedSourceDetails.add(unresolvedOccurrence.sourceDetails);
        }
      }
    }
  }

  const gapThreshold = input.request.minimumInPersonGapMinutes;
  for (const occurrence of occurrences) {
    if (occurrence.sourceDetails && !emittedSourceDetails.has(occurrence.sourceDetails)) {
      lines.push(`- ${occurrence.sourceDetails}`);
      emittedSourceDetails.add(occurrence.sourceDetails);
    }
  }
  if (gapThreshold !== undefined) {
    lines.push(
      `Gaps of at least ${gapThreshold} minutes between consecutive events explicitly marked in person:`,
    );
    let gapCount = 0;
    for (const day of hasUnknownPlacement ? [] : days) {
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
        hasUnknownPlacement
          ? '- No positive gap is reported because at least one returned listing has an unknown time or placement.'
          : countsComplete
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
