export type CalendarHouseholdRSVP =
  | 'accepted'
  | 'declined'
  | 'tentative'
  | 'needsAction'
  | 'unknown'
  | 'not_verified';

export interface CalendarHouseholdCoverageV1 {
  complete: boolean;
  summary: string;
  freshnessSummary: string;
  details: Array<{ title: string; detail: string }>;
}

export interface CalendarHouseholdDayV1 {
  version: 1;
  coverage: CalendarHouseholdCoverageV1;
  nextQuestion?: {
    basis: 'verified_owner_accepted_overlap';
    id: string;
    question: string;
    detail: string;
    eventIds: [string, string];
    remainingIssueCount: number;
  };
}

export interface CalendarHouseholdItemV1 {
  version: 1;
  sources: Array<{
    calendar: string;
    title: string;
    start: string;
    end?: string;
    timeZone?: string;
    allDay: boolean;
    rsvp: CalendarHouseholdRSVP;
  }>;
  eventFor: 'not_stated';
  driving: 'not_stated';
}

export interface CalendarHouseholdComparisonV1 {
  version: 1;
  leftEventId: string;
  rightEventId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const isDenseArray = (value: unknown[]): boolean => {
  for (let index = 0; index < value.length; index += 1)
    if (!Object.hasOwn(value, index)) return false;
  return true;
};
const rsvps = new Set<CalendarHouseholdRSVP>([
  'accepted',
  'declined',
  'tentative',
  'needsAction',
  'unknown',
  'not_verified',
]);

function parseCalendarHouseholdDayValue(value: unknown): CalendarHouseholdDayV1 | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.coverage)) return null;
  const coverage = value.coverage;
  if (
    typeof coverage.complete !== 'boolean' ||
    !nonempty(coverage.summary) ||
    !nonempty(coverage.freshnessSummary) ||
    !Array.isArray(coverage.details) ||
    !isDenseArray(coverage.details)
  )
    return null;
  const details = coverage.details.map((item) => {
    if (!isRecord(item) || !nonempty(item.title) || !nonempty(item.detail)) return null;
    return { title: item.title.trim(), detail: item.detail.trim() };
  });
  if (details.some((item) => item === null)) return null;
  let nextQuestion: CalendarHouseholdDayV1['nextQuestion'];
  if (value.nextQuestion !== undefined) {
    const question = value.nextQuestion;
    if (
      !isRecord(question) ||
      question.basis !== 'verified_owner_accepted_overlap' ||
      !nonempty(question.id) ||
      !nonempty(question.question) ||
      !nonempty(question.detail) ||
      !Array.isArray(question.eventIds) ||
      question.eventIds.length !== 2 ||
      !isDenseArray(question.eventIds) ||
      !question.eventIds.every(nonempty) ||
      typeof question.remainingIssueCount !== 'number' ||
      !Number.isInteger(question.remainingIssueCount) ||
      question.remainingIssueCount < 0
    )
      return null;
    const eventIds = question.eventIds as [string, string];
    if (eventIds[0].trim() === eventIds[1].trim()) return null;
    nextQuestion = {
      basis: 'verified_owner_accepted_overlap',
      id: question.id.trim(),
      question: question.question.trim(),
      detail: question.detail.trim(),
      eventIds: [eventIds[0].trim(), eventIds[1].trim()],
      remainingIssueCount: question.remainingIssueCount,
    };
  }
  return {
    version: 1,
    coverage: {
      complete: coverage.complete,
      summary: coverage.summary.trim(),
      freshnessSummary: coverage.freshnessSummary.trim(),
      details: details as Array<{ title: string; detail: string }>,
    },
    ...(nextQuestion ? { nextQuestion } : {}),
  };
}

function parseCalendarHouseholdItemValue(value: unknown): CalendarHouseholdItemV1 | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.sources) ||
    value.sources.length === 0 ||
    !isDenseArray(value.sources) ||
    value.eventFor !== 'not_stated' ||
    value.driving !== 'not_stated'
  )
    return null;
  const sources = value.sources.map((source) => {
    if (
      !isRecord(source) ||
      !nonempty(source.calendar) ||
      !nonempty(source.title) ||
      !nonempty(source.start) ||
      (source.end !== undefined && !nonempty(source.end)) ||
      (source.timeZone !== undefined && !nonempty(source.timeZone)) ||
      typeof source.allDay !== 'boolean' ||
      !rsvps.has(source.rsvp as CalendarHouseholdRSVP)
    )
      return null;
    return {
      calendar: source.calendar.trim(),
      title: source.title.trim(),
      start: source.start.trim(),
      ...(nonempty(source.end) ? { end: source.end.trim() } : {}),
      ...(nonempty(source.timeZone) ? { timeZone: source.timeZone.trim() } : {}),
      allDay: source.allDay,
      rsvp: source.rsvp as CalendarHouseholdRSVP,
    };
  });
  if (sources.some((source) => source === null)) return null;
  return {
    version: 1,
    sources: sources as CalendarHouseholdItemV1['sources'],
    eventFor: 'not_stated',
    driving: 'not_stated',
  };
}

function parseCalendarHouseholdComparisonValue(
  value: unknown,
): CalendarHouseholdComparisonV1 | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !nonempty(value.leftEventId) ||
    !nonempty(value.rightEventId) ||
    value.leftEventId.trim() === value.rightEventId.trim()
  )
    return null;
  return {
    version: 1,
    leftEventId: value.leftEventId.trim(),
    rightEventId: value.rightEventId.trim(),
  };
}

export function parseCalendarHouseholdDay(value: unknown): CalendarHouseholdDayV1 | null {
  try {
    return parseCalendarHouseholdDayValue(value);
  } catch {
    return null;
  }
}

export function parseCalendarHouseholdItem(value: unknown): CalendarHouseholdItemV1 | null {
  try {
    return parseCalendarHouseholdItemValue(value);
  } catch {
    return null;
  }
}

export function parseCalendarHouseholdComparison(
  value: unknown,
): CalendarHouseholdComparisonV1 | null {
  try {
    return parseCalendarHouseholdComparisonValue(value);
  } catch {
    return null;
  }
}

export function calendarHouseholdItemHasAcceptedRSVP(value: unknown): boolean {
  const item = parseCalendarHouseholdItem(value);
  return Boolean(
    item?.sources.length && item.sources.every((source) => source.rsvp === 'accepted'),
  );
}
