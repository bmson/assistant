import { resolveBookingLocalDateTime } from './email-booking.js';
import { emailIngestReadable } from './email-ingest-readiness.js';
import type { Records } from './records.js';

export interface PracticeChangeMailFact {
  kind: 'practice-change';
  previousIso: string;
  iso: string;
  timeZone: string;
  practiceField: string;
  previousField?: string;
  dateEvidence: string;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
// A single explicit move with two wall times, weekday, date and new venue.
const PRACTICE_LINE =
  /^(\w+), (\w+) (\d{1,2}) practice has moved from ([1-9]|1[0-2]):([0-5]\d) (AM|PM)(?: at ([-\p{L}\p{N} .,'’()]{1,100}?))? to ([1-9]|1[0-2]):([0-5]\d) (AM|PM) at ([-\p{L}\p{N} .,'’()]{1,100})\.$/iu;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function wallTime(hour: string, minute: string, meridiem: string): string {
  const militaryHour = (Number(hour) % 12) + (meridiem.toUpperCase() === 'PM' ? 12 : 0);
  return `${String(militaryHour).padStart(2, '0')}:${minute}`;
}

function isNamedField(field: string): boolean {
  return (
    /\bfield\b/i.test(field) && !/\b(?:and|or|either|maybe|instead of|tentative)\b/i.test(field)
  );
}

function practiceLine(
  line: string,
  receivedAt: Date,
  timeZone: string,
): PracticeChangeMailFact | null {
  const match = PRACTICE_LINE.exec(line);
  if (!match || !Number.isFinite(receivedAt.getTime())) return null;
  const [
    ,
    weekday,
    month,
    day,
    fromHour,
    fromMinute,
    fromMeridiem,
    previousField,
    toHour,
    toMinute,
    toMeridiem,
    field,
  ] = match;
  if (
    !weekday ||
    !month ||
    !day ||
    !fromHour ||
    !fromMinute ||
    !fromMeridiem ||
    !toHour ||
    !toMinute ||
    !toMeridiem ||
    !field ||
    !isNamedField(field) ||
    (previousField !== undefined && !isNamedField(previousField))
  )
    return null;
  const monthNumber = MONTHS.findIndex((name) => name.toLowerCase() === month.toLowerCase());
  if (monthNumber < 0) return null;
  const year = receivedAt.getUTCFullYear();
  for (const candidateYear of [year - 1, year, year + 1]) {
    const calendarDate = new Date(Date.UTC(candidateYear, monthNumber, Number(day)));
    if (
      calendarDate.getUTCDate() !== Number(day) ||
      WEEKDAYS[calendarDate.getUTCDay()]?.toLowerCase() !== weekday.toLowerCase()
    )
      continue;
    const civilDate = calendarDate.toISOString().slice(0, 10);
    const iso = resolveBookingLocalDateTime(
      `${civilDate}T${wallTime(toHour, toMinute, toMeridiem)}`,
      timeZone,
    );
    const previousIso = resolveBookingLocalDateTime(
      `${civilDate}T${wallTime(fromHour, fromMinute, fromMeridiem)}`,
      timeZone,
    );
    if (!iso || !previousIso || previousIso === iso) continue;
    const delay = Date.parse(iso) - receivedAt.getTime();
    if (delay <= 0 || delay > 14 * DAY) continue;
    return {
      kind: 'practice-change',
      iso,
      previousIso,
      timeZone,
      practiceField: field.trim(),
      ...(previousField ? { previousField: previousField.trim() } : {}),
      dateEvidence: line,
    };
  }
  return null;
}

export function extractPracticeChangeMail(
  body: string,
  provenance: Records['emailIngest']['emailContentProvenance'],
  receivedAt: Date,
  timeZone: string,
): PracticeChangeMailFact | null {
  if (!provenance || provenance.hasExternalOrUnknown) return null;
  const lines = [...body.matchAll(/^[^\r\n]*practice has moved[^\r\n]*$/gimu)];
  if (lines.length !== 1) return null;
  const [match] = lines;
  if (!match) return null;
  const start = match.index;
  const end = start + match[0].length;
  if (
    !provenance.spans.some(
      (span) => span.author === 'sender' && span.start <= start && span.end >= end,
    )
  )
    return null;
  return practiceLine(match[0], receivedAt, timeZone);
}

export function practiceChangeFromMail(
  row: Partial<Records['emailIngest']>,
): PracticeChangeMailFact | null {
  if (
    row.ingestMode !== 'direct' ||
    row.authenticated !== true ||
    row.hasExternalOrUnknown !== false ||
    !row.admittedSourceId ||
    !(row.providerReceivedAt instanceof Date) ||
    !emailIngestReadable(row) ||
    !Array.isArray(row.dates)
  )
    return null;
  const [value] = row.dates;
  if (
    row.dates.length !== 1 ||
    value?.kind !== 'practice-change' ||
    typeof value.dateEvidence !== 'string' ||
    typeof value.timeZone !== 'string'
  )
    return null;
  const fact = practiceLine(value.dateEvidence, row.providerReceivedAt, value.timeZone);
  return fact?.iso === value.iso &&
    fact?.previousIso === value.previousIso &&
    fact?.practiceField === value.practiceField &&
    fact?.previousField === value.previousField
    ? fact
    : null;
}
