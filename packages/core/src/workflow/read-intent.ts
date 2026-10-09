/**
 * Deterministic routing for questions whose answer lives in the assistant's
 * Google accounts. These requests are deliberately not left to a cheap model
 * classifier: a false "conversation" or "clarify" verdict gives a tool-less
 * model room to invent a plausible calendar or inbox answer.
 */

import { requestedCardIntent } from './card-intent.js';
import { detectFutureWatchIntent } from './future-watch-intent.js';

export type PersonalReadKind =
  | 'calendar'
  | 'email'
  | 'calendar_email'
  | 'drive'
  | 'memory'
  | 'knowledge_graph';

export interface PersonalReadTimeWindow {
  timeMin: string;
  timeMax: string;
  label: string;
}

export type TemporalDirection = 'past' | 'present' | 'future' | 'spanning';
export type TemporalGranularity = 'hour' | 'day' | 'week' | 'month' | 'year' | 'rolling';

/** Normalized resolver output consumed by deterministic calendar selection. */
export interface ResolvedTemporalIntent {
  direction: TemporalDirection;
  anchor: { instant: string; timeZone: string; localDate: string };
  interval: { start: string; endExclusive: string };
  granularity: TemporalGranularity;
  /** Compatibility projection used by existing tool-argument bindings. */
  window: PersonalReadTimeWindow;
}

export type TemporalIntentResolution =
  | { kind: 'resolved'; intent: ResolvedTemporalIntent }
  | { kind: 'unsupported'; granularity: TemporalGranularity; message: string }
  | { kind: 'unresolved' };

export interface PersonalReadRequest {
  kind: PersonalReadKind;
  /** Literal subject terms to bind into calendar/Gmail searches. */
  queryTerms: string[];
  /** First read tool the executor must call. */
  firstToolName:
    | 'calendar.list_events'
    | 'calendar.search_events'
    | 'calendar.availability'
    | 'gmail.search'
    | 'drive.search'
    | 'memory.recall'
    | 'memory.graph_snapshot';
  /** A metadata-only Gmail hit is not enough to answer a detail question. */
  requiresThreadRead: boolean;
  /** Runtime-resolved range; the model never chooses the date window. */
  timeWindow?: PersonalReadTimeWindow;
  /** Typed request-time interval consumed by calendar selection; window stays compatibility-shaped. */
  temporalIntent?: ResolvedTemporalIntent;
  /** A recognized temporal phrase that this deterministic resolver cannot safely bound. */
  temporalIssue?: string;
  /** Gmail query derived from the owner's words, not model-proposed narrowing. */
  mailQuery?: string;
  /** Used only to render returned timestamps for the owner. */
  timeZone?: string;
  /** Bound for result sets whose wording asks for a single next item. */
  maxResults?: number;
  /** The owner is challenging a prior claim; prior prose remains hypothesis-only. */
  verification?: boolean;
  /** Specific question to answer, rather than turning every lookup into an agenda. */
  answerFocus?: 'lodging' | 'applications' | 'flight';
  /** Broad mail-history requests use a bounded metadata-page continuation. */
  requiresExhaustiveMail?: boolean;
  /** Current/upcoming mail questions prioritize the newest matching thread. */
  preferLatestMail?: boolean;
}

export interface PersonalReadDetectionOptions {
  now?: Date;
  timeZone?: string;
}

export interface ReadIntentMessage {
  role: string;
  /** Core model messages store text in content; AI SDK UI messages use parts. */
  content?: unknown;
  parts?: unknown;
}

export interface ReadToolEvidence {
  toolName: string;
  status: string;
  args?: unknown;
  result?: unknown;
  error?: string | null;
}

const LODGING_QUESTION =
  /^\s*(?:please\s+)?(?:where\s+(?:am i|are we)\s+staying\b|(?:which|what)\s+(?:hotel|accommodation)\s+(?:am i|are we|did i|did we|have i|have we)\b|(?:what|where|when)\b[^.!?\n]{0,60}\b(?:my|our)\s+(?:hotel|lodging|check[- ]?in|check[- ]?out)\b)/i;
const LODGING_TOPIC = /\b(?:hotel|lodging|accommodation|airbnb|check[- ]?in|check[- ]?out)\b/i;
const DETAIL_FOLLOW_UP =
  /^\s*(?:(?:and|also)\s+)?(?:where\s+is\s+(?:it|that)|what(?:['’]s| is)\s+(?:its|the)\s+(?:address|name)|what\s+time\s+is\s+(?:check[- ]?in|check[- ]?out)|when\s+(?:can|do)\s+(?:i|we)\s+check\s+(?:in|out))\s*[?.!]*\s*$/i;
const APPLICATION_HISTORY_QUESTION =
  /^\s*(?:please\s+)?(?:(?:what|which)\s+(?:companies|employers|jobs|roles|positions)\s+(?:have|did)\s+(?:i|we)\s+(?:already\s+)?appl(?:y|ied)\b|where\s+(?:have|did)\s+(?:i|we)\s+(?:already\s+)?appl(?:y|ied)\b|(?:show|list|find|check|review)\s+(?:me\s+)?(?:my|our)\s+(?:job\s+)?applications\b)/i;
const ACCEPT_LOOKUP = /^(?:yes(?:[, ]+(?:please|go ahead|check that))?|please do|go ahead)[.!]*$/i;
const SAME_SUBJECT_LOOKUP_OFFER =
  /\b(?:would you like me to|shall i|should i|i can)\s+(?:check|verify|look up|read|search for)\s+(?:that|it|the (?:details|confirmation)|(?:your|the|our) hotel(?: confirmation| reservation)?)\b/i;
const MUTATING_OFFER =
  /\b(?:add|archive|book|cancel|create|delete|edit|forward|invite|move|reply|reschedule|save|schedule|send|submit|update)\b/i;

/**
 * Use the nearest substantive OWNER turn to resolve a short detail question.
 * Assistant guesses and background notices never select the subject. Stop at
 * a topic change instead of reaching back to an older, more convenient hotel.
 * Only select a fixed read scope; history is not an instruction or evidence.
 */
function contextualLodgingQuestion(latest: string, ownerTurns: string[]): boolean {
  if (!DETAIL_FOLLOW_UP.test(latest)) return false;
  for (const prior of [...ownerTurns].reverse()) {
    if (/^\s*(?:thanks|thank you|ok|okay|great|got it)[.!]*\s*$/i.test(prior)) continue;
    if (DETAIL_FOLLOW_UP.test(prior)) continue;
    return (
      LODGING_QUESTION.test(prior) ||
      (LODGING_TOPIC.test(prior) && /\b(?:my|our|reservation|booking|staying)\b/i.test(prior))
    );
  }
  return false;
}

const CALENDAR_SURFACE =
  /\b(?:calendars?|schedule|agenda|appointments?|events?|meetings?|interviews?|calls?|chats?|flights?|reservations?)\b/i;
const EMAIL_SURFACE = /\b(?:inbox|mailbox|e-?mail(?:s|ed|ing)?|mail|messages?|threads?)\b/i;
const EXHAUSTIVE_MAIL = /\b(?:all|every|entire|complete|exhaustive|history|ever|over time)\b/i;
const CURRENT_MAIL = /\b(?:current|latest|newest|upcoming|now|still|this trip|next trip)\b/i;
/**
 * Google Drive, not driving: "drive time to Napa", "drive to SFO", and "how long
 * a drive is it" are trips, so a bare "drive" followed by a trip word is not a
 * Drive read.
 */
const DRIVE_SURFACE =
  /\b(?:google\s+drive|drive\s+files?|(?:my|the|in|on|from|shared)\s+drive\b(?!\s+(?:time|to|there|home|over|up|down|back))|drive\b(?!\s+(?:time|to|there|home|over|up|down|back|is|takes?|would|will))(?!s?\s*$))/i;
const MEDIA_FILE_READ =
  /^\s*(?:please\s+)?(?:pull|open|find|show|search)(?:\s+me)?\b[^.!?]*\b(?:photos?|files?|albums?)\b/i;
const KNOWLEDGE_GRAPH_SURFACE =
  /\b(?:(?:memory|knowledge)\s+graph|graph\s+(?:my\s+)?(?:memory|knowledge)|saved\s+connections?)\b/i;
const MEMORY_SURFACE =
  /\b(?:memor(?:y|ies)|remember(?:ed)?|saved facts?|what you know|knowledge about me)\b/i;
const AUTOBIOGRAPHICAL_READ =
  /\b(?:when|where)\s+did\s+i\b|\bhave\s+i\s+ever\b|\bdid\s+i\s+(?:attend|visit|see|go|meet|live|work|travel)\b/i;
const AVAILABILITY_SURFACE =
  /\b(?:availability|available|busy|conflicts?|free|open\s+(?:time|slots?)|(?:calendar|schedule|agenda)\s+(?:(?:is|looks|appears)\s+)?(?:clear|empty))\b/i;
const CALENDAR_TIME_REFERENCE =
  /\b(?:today|tomorrow|weekends?|weeks?|months?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|20\d{2}-\d{2}-\d{2})\b/i;
const SCHEDULED_THING =
  /\b(interviews?|meetings?|appointments?|calls?|chats?|flights?|reservations?|bookings?|events?)\b/i;
const READ_OR_QUESTION =
  /\b(?:what|when|where|which|who|do i|did i|is there|are there|check|checked|look|find|found|search|searched|show|tell|review|reviewed|read|scan|open|pull up|bring up|see)\b/i;
const WHY_LOOKUP = /\bwhy\b/i;
const DAY_SCHEDULE =
  /\bwhat(?:(?:'|’)s| is)?\s+(?:happening|going on|coming up|planned|scheduled)\b|\bwhat\s+(?:am i|are we)\s+doing\b|\bwhat\s+do\s+i\s+have\s+(?:(?:on|this|next)\s+)?(?:today|tomorrow|week(?:end)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bwhat(?:(?:'|’)s| is)\s+on\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const VERIFY =
  /\b(?:are you sure|are you certain|double[- ]check|verify|you checked|did you check|don(?:'|’)t see|do not see|not on my|why did you say|was that made up|made that up|is that real|actually there|nothing (?:from|in|there)|none from|not even|really\?)\b/i;
// Mail *arrives*; it is not "looked at". A receipt question names no read verb
// and no possessive surface — "have I gotten an email about X", "any mail from
// the landlord" — so READ_OR_QUESTION, which is built around opening a surface,
// never matches one. Gated on EMAIL_SURFACE at the call site, which is what
// keeps terms this broad from dragging ordinary chat into a forced read.
const RECEIPT_TERMS =
  /\b(?:any|anything|got|gotten|get|receive[ds]?|hear|heard|email(?:ed|s)?|arrive[ds]?|came\s+in|come\s+in|show(?:ed)?\s+up|land(?:ed)?)\b/i;
// A receipt question is a QUESTION. "I got your email, thanks" is not one, and
// answering it with a mailbox search would be absurd.
const RECEIPT_OPENER =
  /^\s*(?:(?:so|and|but|ok|okay|hey|also|please|pls|just)\b[\s,]*)*(?:have|has|haven(?:'|’)?t|hasn(?:'|’)?t|did|didn(?:'|’)?t|any|anything|is|was|were|are|nothing)\b/i;

function receiptQuestion(text: string): boolean {
  if (!RECEIPT_TERMS.test(text)) return false;
  return text.includes('?') || RECEIPT_OPENER.test(text);
}
const MUTATION_LEAD =
  /^\s*(?:(?:please|can you|could you|would you|i want you to)\s+)*(?:add|archive|block|book|cancel|create|delete|edit|forward|hold|invite|label|mark|move|reply|reschedule|schedule|send|update)\b/i;
// An email imperative is a send/draft workflow, even when a later clause
// mentions a prohibited search. Do not replace it with a mailbox-only read.
const EMAIL_COMMAND_LEAD =
  /^\s*(?:(?:please|can you|could you|would you|i want you to)\s+)*(?:email|e-mail)\s+\S/iu;
const READ_THEN_MUTATION =
  /(?:\b(?:and|then|also)\s+|[,;.!?\n]\s*)(?:please\s+)?(?:add|archive|block|book|cancel|compose|create|delete|draft|edit|email|flag|forward|hold|invite|label|make|mark|move|prepare|remember|remind|reply|reschedule|save|schedule|send|update|write)\b/i;

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const MONTH_NUMBER: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

function civilDateAt(instant: Date, timeZone: string): CivilDate {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const date = { year: value('year'), month: value('month'), day: value('day') };
    if (date.year && date.month && date.day) return date;
  } catch {
    // Invalid or unavailable timezone data falls back to UTC below.
  }
  return {
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
  };
}

function civilDateKey(date: CivilDate): string {
  return `${date.year.toString().padStart(4, '0')}-${date.month.toString().padStart(2, '0')}-${date.day.toString().padStart(2, '0')}`;
}

function addCivilDays(date: CivilDate, days: number): CivilDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function civilWeekday(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Convert a civil midnight in `timeZone` to an exact UTC instant, including DST. */
function zonedMidnight(date: CivilDate, timeZone: string): string {
  const desired = Date.UTC(date.year, date.month - 1, date.day);
  let guess = desired;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = formatter.formatToParts(new Date(guess));
      const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
      const observed = Date.UTC(
        value('year'),
        value('month') - 1,
        value('day'),
        value('hour'),
        value('minute'),
        value('second'),
      );
      guess += desired - observed;
    }
  } catch {
    guess = desired;
  }
  return new Date(guess).toISOString();
}

function timeWindow(
  start: CivilDate,
  end: CivilDate,
  label: string,
  timeZone: string,
): PersonalReadTimeWindow {
  return {
    timeMin: zonedMidnight(start, timeZone),
    timeMax: zonedMidnight(end, timeZone),
    label,
  };
}

function resolveTimeWindowBounds(
  text: string,
  kind: PersonalReadKind,
  hasNamedTerms: boolean,
  options: PersonalReadDetectionOptions,
): PersonalReadTimeWindow | undefined {
  if (!options.timeZone) return undefined;
  const timeZone = options.timeZone;
  const today = civilDateAt(options.now ?? new Date(), timeZone);
  const range = (start: CivilDate, days: number, label: string) =>
    timeWindow(start, addCivilDays(start, days), label, timeZone);

  const relativeCount = /\bnext\s+(\d{1,2})\s+(days?|weeks?)\b/i.exec(text);
  if (relativeCount) {
    const count = Math.max(1, Number(relativeCount[1]));
    const unit = relativeCount[2]?.toLowerCase() ?? 'days';
    const days = unit.startsWith('week') ? count * 7 : count;
    return range(today, days, `the next ${count} ${unit}`);
  }

  const isoDate = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (isoDate) {
    const start = {
      year: Number(isoDate[1]),
      month: Number(isoDate[2]),
      day: Number(isoDate[3]),
    };
    const normalized = new Date(Date.UTC(start.year, start.month - 1, start.day));
    if (
      normalized.getUTCFullYear() !== start.year ||
      normalized.getUTCMonth() + 1 !== start.month ||
      normalized.getUTCDate() !== start.day
    )
      return undefined;
    return range(start, 1, isoDate[0]);
  }

  const namedDate = new RegExp(
    `\\b(${Object.keys(MONTH_NUMBER).join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`,
    'i',
  ).exec(text);
  if (namedDate?.[1] && namedDate[2]) {
    const explicitYear = namedDate[3] ? Number(namedDate[3]) : undefined;
    let year = explicitYear ?? today.year;
    const month = MONTH_NUMBER[namedDate[1].toLowerCase()] as number;
    const day = Number(namedDate[2]);
    if (
      explicitYear === undefined &&
      Date.UTC(year, month - 1, day) < Date.UTC(today.year, today.month - 1, today.day)
    ) {
      if (!/\b(?:last|previous|ago|did|was|were|had|happened)\b/i.test(text)) year += 1;
    }
    const valid = new Date(Date.UTC(year, month - 1, day));
    if (
      valid.getUTCFullYear() === year &&
      valid.getUTCMonth() + 1 === month &&
      valid.getUTCDate() === day
    ) {
      return range({ year, month, day }, 1, namedDate[0]);
    }
    return undefined;
  }

  if (/\byesterday\b/i.test(text)) return range(addCivilDays(today, -1), 1, 'yesterday');
  const pastCount = /\b(?:last|past)\s+(\d{1,2})\s+(days?|weeks?)\b/i.exec(text);
  if (pastCount) {
    const days = Number(pastCount[1]) * (pastCount[2]?.toLowerCase().startsWith('week') ? 7 : 1);
    if (days > 0) return range(addCivilDays(today, -days), days, pastCount[0]);
  }
  if (/\btomorrow\b/i.test(text)) return range(addCivilDays(today, 1), 1, 'tomorrow');
  if (/\btoday\b/i.test(text)) return range(today, 1, 'today');

  const weekdayMatch = new RegExp(
    `\\b((?:next|last|previous)\\s+)?(${WEEKDAYS.join('|')})\\b`,
    'i',
  ).exec(text);
  if (weekdayMatch?.[2]) {
    const target = WEEKDAYS.indexOf(weekdayMatch[2].toLowerCase() as (typeof WEEKDAYS)[number]);
    let delta = (target - civilWeekday(today) + 7) % 7;
    if (/last|previous/i.test(weekdayMatch[1] ?? '')) delta = delta === 0 ? -7 : delta - 7;
    else if (weekdayMatch[1] && delta === 0) delta = 7;
    const start = addCivilDays(today, delta);
    return range(start, 1, weekdayMatch[0].toLowerCase());
  }

  const mondayOffset = (1 - civilWeekday(today) + 7) % 7;
  const currentMonday = addCivilDays(today, mondayOffset === 0 ? 0 : mondayOffset - 7);
  if (/\b(?:last|previous)\s+week(?:end)?\b/i.test(text)) {
    const start = addCivilDays(currentMonday, /weekend/i.test(text) ? -2 : -7);
    return range(
      start,
      /weekend/i.test(text) ? 2 : 7,
      /weekend/i.test(text) ? 'last weekend' : 'last week',
    );
  }
  if (/\bnext\s+week(?:end)?\b/i.test(text)) {
    if (/weekend/i.test(text)) {
      const start = addCivilDays(currentMonday, 12);
      return range(start, 2, 'next weekend');
    }
    const start = addCivilDays(currentMonday, 7);
    return range(start, 7, 'next week');
  }
  if (/\b(?:this\s+)?weekend\b/i.test(text)) {
    const start = addCivilDays(currentMonday, 5);
    return range(start, 2, 'this weekend');
  }
  if (/\bthis\s+week\b/i.test(text)) return range(currentMonday, 7, 'this week');

  const firstOfMonth = { year: today.year, month: today.month, day: 1 };
  const nextMonth =
    today.month === 12
      ? { year: today.year + 1, month: 1, day: 1 }
      : { year: today.year, month: today.month + 1, day: 1 };
  const followingMonth =
    nextMonth.month === 12
      ? { year: nextMonth.year + 1, month: 1, day: 1 }
      : { year: nextMonth.year, month: nextMonth.month + 1, day: 1 };
  if (/\b(?:last|previous)\s+year\b/i.test(text)) {
    const start = { year: today.year - 1, month: 1, day: 1 };
    const end = { year: today.year, month: 1, day: 1 };
    return timeWindow(start, end, 'last year', timeZone);
  }
  if (/\b(?:last|previous)\s+month\b/i.test(text)) {
    const previous =
      today.month === 1
        ? { year: today.year - 1, month: 12, day: 1 }
        : { year: today.year, month: today.month - 1, day: 1 };
    return timeWindow(previous, firstOfMonth, 'last month', timeZone);
  }
  if (/\bnext\s+month\b/i.test(text)) {
    return timeWindow(nextMonth, followingMonth, 'next month', timeZone);
  }
  if (/\bthis\s+month\b/i.test(text)) {
    return timeWindow(firstOfMonth, nextMonth, 'this month', timeZone);
  }

  // A named appointment with no stated date gets a broad, deterministic range
  // around today. A generic schedule question defaults to the next seven days.
  return kind === 'calendar_email' || hasNamedTerms
    ? timeWindow(
        addCivilDays(today, -365),
        addCivilDays(today, 730),
        'one year back through two years ahead',
        timeZone,
      )
    : range(today, 7, 'the next 7 days');
}

const RELATIVE_PERIOD =
  /\b(?:(?:next|last|past|previous|prior|this|coming)\s+(?:(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:hours?|days?|weeks?|weekends?|months?|quarters?|years?|decades?)|(?:in\s+)?(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hours?|days?|weeks?|months?|quarters?|years?|decades?)(?:\s+(?:ago|from\s+now))?)\b/i;
const SUPPORTED_RELATIVE_PERIODS = [
  /\bnext\s+[1-9]\d?\s+(?:days?|weeks?)\b/i,
  /\b(?:last|past)\s+[1-9]\d?\s+(?:days?|weeks?)\b/i,
  /\b(?:last|previous)\s+(?:week(?:end)?|month|year)\b/i,
  /\bnext\s+(?:week(?:end)?|month)\b/i,
  /\bthis\s+(?:week(?:end)?|month)\b/i,
  /\b(?:yesterday|today|tomorrow)\b/i,
].map((pattern) => pattern);

function unsupportedRelativePeriod(text: string): string | undefined {
  const allPeriods = new RegExp(RELATIVE_PERIOD.source, `${RELATIVE_PERIOD.flags}g`);
  for (const match of text.matchAll(allPeriods)) {
    const phrase = match[0];
    if (!SUPPORTED_RELATIVE_PERIODS.some((pattern) => pattern.test(phrase))) return phrase;
  }
  return undefined;
}

function hasHistoricalTemporalCue(text: string): boolean {
  return /\b(?:yesterday|last|past|previous|prior|ago)\b/i.test(text);
}

function temporalGranularity(
  text: string,
  kind: PersonalReadKind,
  hasNamedTerms: boolean,
): TemporalGranularity {
  if (/\bhours?\b/i.test(text)) return 'hour';
  if (/\b(?:years?|decades?)\b/i.test(text)) return 'year';
  if (/\b(?:months?|quarters?)\b/i.test(text)) return 'month';
  if (/\bweeks?(?:ends?)?\b/i.test(text)) return 'week';
  if (
    /\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|20\d{2}-\d{2}-\d{2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2})\b/i.test(
      text,
    )
  )
    return 'day';
  if (/\b\d{1,2}\s+days?\b/i.test(text)) return 'day';
  if (/\b\d{1,2}\s+weeks?\b/i.test(text)) return 'week';
  return kind === 'calendar_email' || hasNamedTerms ? 'rolling' : 'week';
}

function isNextEventRequest(text: string): boolean {
  return /\b(?:next|nearest|soonest)\s+(?:calendar\s+)?(?:event|meeting|appointment|call)\b/i.test(
    text,
  );
}

function hasExplicitTemporalPhrase(text: string): boolean {
  return (
    /\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|(?:last|next|this)\s+(?:week|month|year)|20\d{2}-\d{2}-\d{2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2})\b/i.test(
      text,
    ) || RELATIVE_PERIOD.test(text)
  );
}

function temporalIssueFor(text: string, temporal: TemporalIntentResolution): string | undefined {
  if (temporal.kind === 'unsupported') return temporal.message;
  if (temporal.kind === 'unresolved' && hasExplicitTemporalPhrase(text))
    return 'I can’t safely resolve that calendar date or period from the available information. Please give me a valid date or a period such as last week or last year.';
  return undefined;
}

export function resolveTemporalIntent(
  text: string,
  kind: PersonalReadKind,
  hasNamedTerms: boolean,
  options: PersonalReadDetectionOptions,
  purpose: 'range' | 'next-event' | 'trip' = 'range',
): TemporalIntentResolution {
  if (!options.timeZone) return { kind: 'unresolved' };
  const now = options.now ? new Date(options.now.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) return { kind: 'unresolved' };
  const boundOptions = { ...options, now };
  const unsupported = unsupportedRelativePeriod(text);
  if (unsupported) {
    const granularity = temporalGranularity(unsupported, kind, hasNamedTerms);
    return {
      kind: 'unsupported',
      granularity,
      message: `I can’t safely search that calendar period (“${unsupported}”). Please give me a specific date or a period such as last week or last year.`,
    };
  }
  const today = civilDateAt(now, options.timeZone);
  let window = resolveTimeWindowBounds(text, kind, hasNamedTerms, boundOptions);
  if (purpose === 'trip' && !hasExplicitTemporalPhrase(text)) {
    window = {
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + 36 * 60 * 60 * 1000).toISOString(),
      label: 'the next day and a half',
    };
  }
  if (!window) return { kind: 'unresolved' };

  const futureAnchored =
    (purpose === 'next-event' || purpose === 'trip') &&
    !hasHistoricalTemporalCue(text) &&
    Date.parse(window.timeMax) > now.getTime();
  if (futureAnchored) {
    const anchor = now.toISOString();
    const start = Date.parse(window.timeMin);
    const end = Date.parse(window.timeMax);
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start < now.getTime() &&
      end > now.getTime()
    )
      window = { ...window, timeMin: anchor };
  }
  const start = Date.parse(window.timeMin);
  const end = Date.parse(window.timeMax);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return { kind: 'unresolved' };
  const interval = { start: window.timeMin, endExclusive: window.timeMax };
  const anchorInstant = now.toISOString();
  const direction: TemporalDirection = futureAnchored
    ? 'future'
    : end <= now.getTime()
      ? 'past'
      : start > now.getTime()
        ? 'future'
        : start < now.getTime() && end > now.getTime()
          ? 'spanning'
          : 'present';
  return {
    kind: 'resolved',
    intent: {
      direction,
      anchor: {
        instant: anchorInstant,
        timeZone: options.timeZone,
        localDate: civilDateKey(today),
      },
      interval,
      granularity: temporalGranularity(text, kind, hasNamedTerms),
      window,
    },
  };
}

/** Compatibility API: keep the established tool-window shape unchanged. */
export function resolveTimeWindow(
  text: string,
  kind: PersonalReadKind,
  hasNamedTerms: boolean,
  options: PersonalReadDetectionOptions,
): PersonalReadTimeWindow | undefined {
  const resolved = resolveTemporalIntent(text, kind, hasNamedTerms, options);
  return resolved.kind === 'resolved' ? resolved.intent.window : undefined;
}

function gmailQuery(text: string, terms: string[]): string {
  const parts = terms.length > 0 ? [terms.join(' ')] : [];
  if (/\binbox\b/i.test(text)) parts.push('in:inbox');
  if (terms.length === 0 && /\b(?:urgent|important)\b/i.test(text)) {
    parts.push('{is:starred is:important}');
  }
  if (/\b(?:new|unread)\b/i.test(text)) {
    if (!parts.includes('in:inbox')) parts.push('in:inbox');
    parts.push('is:unread');
  }
  // Relative wording is a DATE FILTER, never a search term: Gmail ANDs terms, so
  // a stray "weekend" turns a findable question into a confident empty result.
  // Mail confirming a *future* event still arrived in the past, so every one of
  // these maps to a lookback window and never to a forward bound. Order matters —
  // "last week" must settle before the bare-week arm sees it.
  const recentDays = /\b(?:last|past)\s+(\d{1,2})\s+days?\b/i.exec(text)?.[1];
  if (recentDays) parts.push(`newer_than:${Math.max(1, Number(recentDays))}d`);
  else if (/\b(?:last|past)\s+week\b/i.test(text)) parts.push('newer_than:7d');
  else if (/\b(?:last|past|this|next|coming)\s+month\b/i.test(text)) {
    parts.push('newer_than:30d');
  } else if (/\b(?:next|coming)\s+(?:week|weekend)\b/i.test(text)) parts.push('newer_than:30d');
  else if (
    /\b(?:this|the)\s+(?:week|weekend)\b|\b(?:today|tonight|tomorrow|recently|lately)\b/i.test(text)
  ) {
    parts.push('newer_than:14d');
  }
  return parts.join(' ').trim() || '-in:spam -in:trash';
}

const QUERY_STOP_WORDS = new Set([
  'a',
  'about',
  'am',
  'an',
  'and',
  'any',
  'anything',
  'are',
  'arrive',
  'arrived',
  'at',
  'back',
  'came',
  'check',
  'checked',
  'calendar',
  'calendars',
  'come',
  'claimed',
  'confirmed',
  'did',
  'do',
  'does',
  'find',
  'found',
  'for',
  'from',
  'get',
  'email',
  'emailed',
  'got',
  'gotten',
  'had',
  'has',
  'have',
  'hear',
  'heard',
  'i',
  'in',
  'is',
  'it',
  'looking',
  'me',
  'mentioned',
  'my',
  'next',
  'no',
  'not',
  'nothing',
  'of',
  'on',
  'our',
  'please',
  'pm',
  'previously',
  'last',
  'past',
  'previous',
  'yesterday',
  'week',
  'month',
  'receive',
  'received',
  'said',
  'say',
  'says',
  'search',
  'searched',
  'saw',
  'send',
  'sent',
  'show',
  'source',
  'system',
  'the',
  'this',
  'time',
  'to',
  'up',
  'was',
  'what',
  'when',
  'where',
  'which',
  'why',
  'you',
  'your',
]);

const QUERY_MODIFIERS = new Set([
  'behavioral',
  'coding',
  'coffee',
  'engineer',
  'final',
  'first',
  'initial',
  'manager',
  'monday',
  'month',
  'months',
  'onsite',
  'panel',
  'phone',
  'product',
  'recruiter',
  'round',
  'saturday',
  'scheduled',
  'screen',
  'screening',
  'second',
  'software',
  'sunday',
  'team',
  'technical',
  'thursday',
  'today',
  'tomorrow',
  'tonight',
  'tuesday',
  'upcoming',
  'urgent',
  'video',
  'virtual',
  'wednesday',
  'week',
  'weekend',
  'weekends',
  'weeks',
  'yesterday',
]);

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function messageText(message: ReadIntentMessage | undefined): string {
  if (!message) return '';
  return contentText(message.content ?? message.parts);
}

/**
 * Ad-hoc tasks without a conversation are seeded with a serialized trigger.
 * Inspect only its owner-authored instruction: metadata such as
 * `"source":"chat"` must never be mistaken for a calendar "chat".
 */
export function readIntentText(message: ReadIntentMessage | undefined): string {
  const text = messageText(message).trim();
  if (!/^(?:External )?Task trigger \([^)]+\):/i.test(text)) return text;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return '';
  try {
    const trigger = JSON.parse(text.slice(start, end + 1)) as {
      payload?: { text?: unknown; instruction?: unknown };
    };
    if (typeof trigger.payload?.text === 'string') return trigger.payload.text.trim();
    if (typeof trigger.payload?.instruction === 'string') {
      return trigger.payload.instruction.trim();
    }
  } catch {
    // A malformed runtime envelope is metadata, not a safe lookup instruction.
  }
  return '';
}

function flightDestinationTerms(text: string): string[] {
  const route = /\bflights?\b[^.!?;\n]{0,100}?\bto\s+([^.!?;\n]+)/i.exec(text)?.[1];
  if (!route) return [];
  const destination =
    route.split(
      /\b(?:tomorrow|today|tonight|yesterday|next|this|on|at|from|via|through|leaving|departing|in the morning|in the afternoon|in the evening)\b/i,
    )[0] ?? '';
  return [
    ...new Set(
      destination
        .toLowerCase()
        .replace(/[^a-z0-9'’-]+/g, ' ')
        .split(/\s+/)
        .filter(
          (word) =>
            word.length > 1 &&
            !QUERY_STOP_WORDS.has(word) &&
            !QUERY_MODIFIERS.has(word) &&
            !SCHEDULED_THING.test(word),
        ),
    ),
  ].slice(0, 3);
}

function queryTerms(text: string): string[] {
  const words = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9'’-]+/g, ' ')
      .split(/\s+/)
      .map((word) => word.replace(/(?:['’]s)$/i, ''))
      .filter(
        (word) =>
          word.length > 1 &&
          !/^\d+$/.test(word) &&
          !QUERY_STOP_WORDS.has(word) &&
          !QUERY_MODIFIERS.has(word) &&
          MONTH_NUMBER[word] === undefined &&
          // Receipt questions reach this path now, and Gmail ANDs terms: the
          // word "email" in "any email about my hotel booking" is the surface
          // being searched, never a thing to search for.
          !EMAIL_SURFACE.test(word) &&
          !SCHEDULED_THING.test(word),
      );

  const nounMatches = [...text.matchAll(new RegExp(SCHEDULED_THING.source, 'gi'))];
  const firstNoun = nounMatches[0];
  if (!firstNoun?.[1] || firstNoun.index === undefined) return [];
  for (const nounMatch of nounMatches) {
    if (!nounMatch[1] || nounMatch.index === undefined) continue;
    const after = text.slice(
      nounMatch.index + nounMatch[0].length,
      nounMatch.index + nounMatch[0].length + 120,
    );
    const related =
      /^\s*(?:(?:is|was|will be)\s+)?(?:with|at|for|from|to|about)\s+([^\n.!?;]+)/i.exec(
        after,
      )?.[1];
    const rawBefore = text.slice(Math.max(0, nounMatch.index - 120), nounMatch.index);
    const clauseStart = Math.max(
      rawBefore.lastIndexOf('\n'),
      rawBefore.lastIndexOf('.'),
      rawBefore.lastIndexOf('!'),
      rawBefore.lastIndexOf('?'),
      rawBefore.lastIndexOf(';'),
      rawBefore.lastIndexOf(':'),
    );
    const before = rawBefore.slice(clauseStart + 1);
    const specific = related ? words(related).slice(0, 2) : words(before).slice(-2);
    if (specific.length > 0) return [...new Set(specific)];
  }

  // Search on the named entity when one is present. Adding generic words such
  // as "interview", "upcoming", or "technical" makes Gmail's default AND
  // semantics miss otherwise-correct messages. Fall back to the appointment
  // noun only when the owner gave no distinguishing term.
  return [firstNoun[1].toLowerCase()];
}

function emailQueryTerms(text: string): string[] {
  const words = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9'’-]+/g, ' ')
      .split(/\s+/)
      .map((word) => word.replace(/(?:['’]s)$/i, ''))
      .filter(
        (word) =>
          word.length > 1 &&
          !QUERY_STOP_WORDS.has(word) &&
          !QUERY_MODIFIERS.has(word) &&
          !EMAIL_SURFACE.test(word) &&
          !/^(?:already|company|days?|important|job|last|latest|mention(?:ed)?|months?|new|position|recent|role|something|unread|weeks?)$/.test(
            word,
          ),
      );
  const related =
    /\b(?:about|concerning|for|from|regarding|with)\s+(.+?)(?=\s+(?:and|but|that|which|who)\b|[?.,;!]|$)/i.exec(
      text,
    )?.[1];
  const candidates = words(related ?? text);
  return [...new Set(candidates.slice(0, 2))];
}

const PRIVATE_QUERY_GENERIC = new Set([
  'drive',
  'file',
  'files',
  'photo',
  'photos',
  'album',
  'albums',
  'memory',
  'memories',
  'knowledge',
  'graph',
  'remember',
  'saved',
  'fact',
  'facts',
  'look',
  'pull',
  'open',
  'find',
  'show',
  'see',
  'attend',
  'visit',
  'went',
  'meet',
  'live',
  'work',
  'travel',
]);

function privateQueryTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9'’-]+/g, ' ')
        .split(/\s+/)
        .map((word) => word.replace(/(?:['’]s)$/i, ''))
        .filter(
          (word) =>
            word.length > 2 &&
            !/^\d+$/.test(word) &&
            !QUERY_STOP_WORDS.has(word) &&
            !QUERY_MODIFIERS.has(word) &&
            !PRIVATE_QUERY_GENERIC.has(word),
        ),
    ),
  ].slice(0, 5);
}

/**
 * Identify private account lookups from the latest owner turn. Recent context
 * is used only for terse verification follow-ups such as "are you sure?".
 */
export function detectPersonalReadRequest(
  messages: ReadonlyArray<ReadIntentMessage>,
  options: PersonalReadDetectionOptions = {},
): PersonalReadRequest | null {
  let latestIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex === -1) return null;
  const latest = readIntentText(messages[latestIndex]);
  // A future notification request needs an executable watch plan. Do not let
  // broad words such as "tell me when" force a read-only answer route.
  if (detectFutureWatchIntent(latest)) return null;
  if (ACCEPT_LOOKUP.test(latest)) {
    const prior = messages.slice(Math.max(0, latestIndex - 8), latestIndex);
    const offer = readIntentText(prior.findLast((message) => message.role === 'assistant'));
    if (SAME_SUBJECT_LOOKUP_OFFER.test(offer) && !MUTATING_OFFER.test(offer)) {
      // Only inherit a concrete prior read. Never turn acceptance of a send,
      // booking, or mixed read/write offer into a read-only task that silently
      // drops the requested action. Repeated assents stay bounded by history.
      const request = detectPersonalReadRequest(prior, options);
      if (LODGING_TOPIC.test(offer) && request?.answerFocus !== 'lodging') return null;
      return request;
    }
  }
  // A saved card copied from a personally requested mailbox reservation is
  // composed by the finalizer after these reads. It is not a separate external
  // mutation, so enforcing its source reads must not turn it into a tool-less
  // answer or authorize any other follow-through.
  if (
    requestedCardIntent(latest) &&
    /^\s*(?:(?:please|can you|could you|would you)\s+)*(?:create|make|save)\b/i.test(latest) &&
    /\b(?:my|our)\s+(?:hotel|reservation|booking)\b/i.test(latest) &&
    /\b(?:mailbox|inbox|email|mail)\b/i.test(latest) &&
    !READ_THEN_MUTATION.test(latest)
  ) {
    const reference = /\bunder\s+([a-z0-9][a-z0-9_-]{2,100})\b/i.exec(latest)?.[1];
    return {
      kind: 'email',
      queryTerms: [reference ?? 'hotel'],
      firstToolName: 'gmail.search',
      requiresThreadRead: true,
      mailQuery: reference ?? '{hotel lodging "reservation confirmation" "booking confirmation"}',
      answerFocus: 'lodging',
    };
  }
  if (
    !latest ||
    /^\s*i\s+(?:read|checked|reviewed|looked|searched|scanned|opened)\b/i.test(latest) ||
    READ_THEN_MUTATION.test(latest) ||
    EMAIL_COMMAND_LEAD.test(latest) ||
    (MUTATION_LEAD.test(latest) && !/\b(?:check|find|search|look|show)\b/i.test(latest))
  ) {
    return null;
  }

  const recentContext = messages
    .slice(Math.max(0, latestIndex - 4), latestIndex)
    .map(messageText)
    .join('\n');
  const verification = VERIFY.test(latest);
  const recentOwnerTurns = messages
    .slice(Math.max(0, latestIndex - 8), latestIndex)
    .filter((message) => message.role === 'user')
    .map(readIntentText)
    .filter(Boolean);
  const lodging =
    LODGING_QUESTION.test(latest) || contextualLodgingQuestion(latest, recentOwnerTurns);
  const applications = APPLICATION_HISTORY_QUESTION.test(latest);
  if (lodging || applications) {
    // A booking can have been made months before travel. Do not translate
    // "tomorrow" into a Gmail received-date filter and hide its confirmation.
    // Likewise, application history must come from actual application mail,
    // not calendar interviews or public job listings.
    const temporal = lodging
      ? resolveTemporalIntent(latest, 'calendar_email', true, options)
      : undefined;
    const temporalIssue = temporal ? temporalIssueFor(latest, temporal) : undefined;
    return {
      kind: lodging ? 'calendar_email' : 'email',
      queryTerms: [lodging ? 'hotel' : 'application'],
      firstToolName: lodging ? 'calendar.search_events' : 'gmail.search',
      requiresThreadRead: true,
      mailQuery: lodging
        ? '{hotel lodging airbnb "reservation confirmation" "booking confirmation"}'
        : gmailQuery(latest, [
            '{"application received" "application confirmation" "thank you for applying" "your application"}',
          ]),
      ...(temporal?.kind === 'resolved'
        ? { timeWindow: temporal.intent.window, temporalIntent: temporal.intent }
        : {}),
      ...(temporalIssue ? { temporalIssue } : {}),
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      answerFocus: lodging ? 'lodging' : 'applications',
    };
  }
  const contextualPrivateTerms = () => {
    const own = privateQueryTerms(latest);
    if (own.length > 0) return own;
    for (const prior of [...recentOwnerTurns].reverse()) {
      const priorTerms = privateQueryTerms(prior);
      if (priorTerms.length > 0) return priorTerms;
    }
    return [];
  };
  const graphRead = KNOWLEDGE_GRAPH_SURFACE.test(latest);
  const driveRead =
    !graphRead &&
    (DRIVE_SURFACE.test(latest) || MEDIA_FILE_READ.test(latest)) &&
    (READ_OR_QUESTION.test(latest) || /^\s*(?:pull|open|find|show)\b/i.test(latest));
  const memoryRead =
    !graphRead &&
    !driveRead &&
    ((MEMORY_SURFACE.test(latest) && (READ_OR_QUESTION.test(latest) || verification)) ||
      AUTOBIOGRAPHICAL_READ.test(latest));
  if (graphRead || driveRead || memoryRead) {
    const kind: PersonalReadKind = graphRead ? 'knowledge_graph' : driveRead ? 'drive' : 'memory';
    return {
      kind,
      queryTerms: contextualPrivateTerms(),
      firstToolName:
        kind === 'knowledge_graph'
          ? 'memory.graph_snapshot'
          : kind === 'drive'
            ? 'drive.search'
            : 'memory.recall',
      requiresThreadRead: false,
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      ...(verification ? { verification: true } : {}),
    };
  }
  // A terse correction such as "was that made up?" carries no subject of its
  // own. Reuse the prior assistant claim only as a search hypothesis — never as
  // answer evidence — so the runtime can actually verify the named item.
  // A terse challenge that still names a sender ("nothing from tripit?") carries
  // its own subject, and reaching back to context would search for the thing the
  // owner is disputing instead of the thing they named. Only a subject-less
  // challenge ("are you sure?") needs the prior turn.
  const namesSender = /\bfrom\s+[a-z0-9][\w.'’-]*/i.test(latest);
  const contextualQuery = verification && queryTerms(latest).length === 0 && !namesSender;
  const hypothesis = contextualQuery ? recentContext : latest;
  let terms = queryTerms(hypothesis);
  const flightTerms = flightDestinationTerms(hypothesis);
  if (flightTerms.length > 0) terms = flightTerms;
  const scheduledNoun = SCHEDULED_THING.exec(hypothesis)?.[1]?.toLowerCase();
  const genericScheduleList = Boolean(
    scheduledNoun?.endsWith('s') &&
      terms.length === 1 &&
      terms[0] === scheduledNoun &&
      /\b(?:all|are my|do i have|find|list|show|what|which)\b/i.test(latest),
  );
  if (genericScheduleList) terms = [];
  const whyLookup =
    WHY_LOOKUP.test(latest) &&
    /\b(?:my|our|you said|said i|i had|i have|calendar|schedule)\b/i.test(latest);
  const nextEventQuestion = isNextEventRequest(latest);
  if (nextEventQuestion) terms = [];
  const personalSchedule =
    /\b(?:my|our|the|this|that|do i|did i|is there|are there)\b/i.test(latest) ||
    terms.some((term) => !SCHEDULED_THING.test(term));
  const namedSchedule =
    !genericScheduleList &&
    !nextEventQuestion &&
    (SCHEDULED_THING.test(latest) || (verification && SCHEDULED_THING.test(recentContext))) &&
    personalSchedule &&
    (READ_OR_QUESTION.test(latest) || verification || whyLookup);
  const daySchedule = DAY_SCHEDULE.test(latest);
  const calendar =
    daySchedule ||
    namedSchedule ||
    (CALENDAR_SURFACE.test(latest) &&
      (READ_OR_QUESTION.test(latest) || verification || whyLookup)) ||
    (verification && CALENDAR_SURFACE.test(recentContext));
  const email =
    (EMAIL_SURFACE.test(latest) &&
      (READ_OR_QUESTION.test(latest) || receiptQuestion(latest) || verification)) ||
    (verification && EMAIL_SURFACE.test(recentContext));
  const availability =
    AVAILABILITY_SURFACE.test(latest) &&
    !namedSchedule &&
    (!EMAIL_SURFACE.test(latest) ||
      CALENDAR_SURFACE.test(latest) ||
      CALENDAR_TIME_REFERENCE.test(latest)) &&
    (/\b(?:am i|are|check|do i|find|is|show|what|when|which)\b/i.test(latest) ||
      CALENDAR_TIME_REFERENCE.test(latest));

  if (!calendar && !email && !availability) return null;
  if (terms.length === 0 && email) terms = emailQueryTerms(hypothesis);

  // Named appointments are commonly confirmed in email before (or instead of)
  // appearing on a calendar. Search both configured sources without asking the
  // owner which provider/account contains the answer.
  const kind: PersonalReadKind = availability
    ? 'calendar'
    : namedSchedule || (calendar && email)
      ? 'calendar_email'
      : email
        ? 'email'
        : 'calendar';
  const firstToolName = availability
    ? 'calendar.availability'
    : kind === 'email'
      ? 'gmail.search'
      : kind === 'calendar_email' || terms.length > 0
        ? 'calendar.search_events'
        : 'calendar.list_events';

  const request: PersonalReadRequest = {
    kind,
    queryTerms: terms,
    ...(namedSchedule && /\b(?:flight|flights|airline|itinerary|boarding)\b/i.test(latest)
      ? { answerFocus: 'flight' as const }
      : {}),
    firstToolName,
    requiresThreadRead:
      kind === 'calendar_email' ||
      (kind === 'email' &&
        (verification || /\b(?:when|where|what time|details?|what does|what did)\b/i.test(latest))),
  };
  if (kind !== 'calendar') {
    if (EXHAUSTIVE_MAIL.test(latest)) request.requiresExhaustiveMail = true;
    if (CURRENT_MAIL.test(latest)) request.preferLatestMail = true;
  }
  if (kind !== 'email' && nextEventQuestion) {
    request.maxResults = 1;
  }
  if (kind !== 'email') {
    const temporal = resolveTemporalIntent(
      contextualQuery ? `${latest}\n${recentContext}` : latest,
      kind,
      terms.length > 0,
      options,
      nextEventQuestion ? 'next-event' : 'range',
    );
    if (temporal.kind === 'resolved') {
      request.timeWindow = temporal.intent.window;
      request.temporalIntent = temporal.intent;
    } else {
      const temporalText = contextualQuery ? `${latest}\n${recentContext}` : latest;
      const issue = temporalIssueFor(temporalText, temporal);
      if (issue) request.temporalIssue = issue;
    }
  }
  if (kind !== 'calendar') {
    request.mailQuery = gmailQuery(hypothesis, terms);
    // A relative travel date describes the itinerary, not when its confirmation
    // arrived. Older booking confirmations can still be authoritative for a
    // future flight, so only an explicitly stated mail-age filter narrows them.
    const explicitMailAge = /\b(?:last|past)\s+(?:\d{1,2}\s+days?|week|month)\b/i.test(hypothesis);
    if (request.answerFocus === 'flight' && !explicitMailAge) {
      request.mailQuery = request.mailQuery.replace(/\s+newer_than:\d+d\b/gi, '').trim();
    }
  }
  if (options.timeZone) request.timeZone = options.timeZone;
  if (verification) request.verification = true;
  return request;
}

function succeeded(row: ReadToolEvidence): boolean {
  if (row.status !== 'succeeded') return false;
  if (!row.result || typeof row.result !== 'object') return true;
  const result = row.result as Record<string, unknown>;
  return result.ok !== false && !(typeof result.status === 'number' && result.status >= 400);
}

function attempts(evidence: ReadonlyArray<ReadToolEvidence>, toolName: string): number {
  return evidence.filter((row) => row.toolName === toolName).length;
}

function argsRecord(row: ReadToolEvidence): Record<string, unknown> | undefined {
  return row.args && typeof row.args === 'object' && !Array.isArray(row.args)
    ? (row.args as Record<string, unknown>)
    : undefined;
}

function queryIncludes(query: unknown, terms: string[]): boolean {
  if (terms.length === 0) return true;
  if (typeof query !== 'string') return false;
  const lower = query.toLowerCase();
  return terms.every((term) => lower.includes(term.toLowerCase()));
}

function calendarReadInterval(
  request: PersonalReadRequest,
): { start: string; endExclusive: string } | undefined {
  if (request.temporalIntent) return request.temporalIntent.interval;
  return request.timeWindow
    ? { start: request.timeWindow.timeMin, endExclusive: request.timeWindow.timeMax }
    : undefined;
}

function matchingCalendarRead(row: ReadToolEvidence, request: PersonalReadRequest): boolean {
  if (!succeeded(row) || row.toolName !== request.firstToolName) return false;
  const args = argsRecord(row);
  if (Array.isArray(args?.calendarIds) && args.calendarIds.length > 0) return false;
  if (
    row.toolName === 'calendar.search_events' &&
    !queryIncludes(args?.query, request.queryTerms)
  ) {
    return false;
  }
  const interval = calendarReadInterval(request);
  return !interval || (args?.timeMin === interval.start && args?.timeMax === interval.endExclusive);
}

function matchingGmailSearch(row: ReadToolEvidence, request: PersonalReadRequest): boolean {
  if (!succeeded(row) || row.toolName !== 'gmail.search') return false;
  const query = argsRecord(row)?.query;
  return request.mailQuery
    ? typeof query === 'string' && query.trim().toLowerCase() === request.mailQuery.toLowerCase()
    : queryIncludes(query, request.queryTerms);
}

function matchingPrivateRead(row: ReadToolEvidence, request: PersonalReadRequest): boolean {
  if (!succeeded(row) || row.toolName !== request.firstToolName) return false;
  return queryIncludes(argsRecord(row)?.query, request.queryTerms);
}

export function gmailSearchThreadIds(
  evidence: ReadonlyArray<ReadToolEvidence>,
  request?: PersonalReadRequest,
): string[] {
  const ids: string[] = [];
  for (const row of evidence) {
    if (
      !succeeded(row) ||
      row.toolName !== 'gmail.search' ||
      !row.result ||
      (request && !matchingGmailSearch(row, request))
    ) {
      continue;
    }
    const results = (row.result as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      if (!result || typeof result !== 'object') continue;
      const id = (result as { threadId?: unknown }).threadId;
      if (typeof id === 'string' && id) ids.push(id);
    }
  }
  const unique = [...new Set(ids)];
  if (request?.answerFocus === 'flight') {
    const scores = new Map<string, number>();
    for (const row of evidence) {
      if (
        !succeeded(row) ||
        row.toolName !== 'gmail.search' ||
        !row.result ||
        !matchingGmailSearch(row, request)
      )
        continue;
      const results = (row.result as { results?: unknown }).results;
      if (!Array.isArray(results)) continue;
      for (const item of results) {
        if (!item || typeof item !== 'object') continue;
        const metadata = item as { threadId?: unknown; subject?: unknown; snippet?: unknown };
        if (typeof metadata.threadId !== 'string') continue;
        const subject = typeof metadata.subject === 'string' ? metadata.subject : '';
        const snippet = typeof metadata.snippet === 'string' ? metadata.snippet : '';
        const score =
          (/\b(?:booking|confirmation|itinerary|ticket|reservation|boarding pass)\b/i.test(subject)
            ? 2
            : 0) +
          (/\b(?:booking|confirmation|itinerary|ticket|reservation|boarding pass|departure)\b/i.test(
            snippet,
          )
            ? 1
            : 0);
        scores.set(metadata.threadId, Math.max(scores.get(metadata.threadId) ?? 0, score));
      }
    }
    return unique
      .map((threadId, index) => ({ threadId, index, score: scores.get(threadId) ?? 0 }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(({ threadId }) => threadId);
  }
  if (!request?.preferLatestMail) return unique;
  const dateByThread = new Map<string, number>();
  for (const row of evidence) {
    if (
      !succeeded(row) ||
      row.toolName !== 'gmail.search' ||
      !row.result ||
      (request && !matchingGmailSearch(row, request))
    )
      continue;
    const results = (row.result as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      if (!result || typeof result !== 'object') continue;
      const item = result as { threadId?: unknown; date?: unknown };
      if (typeof item.threadId !== 'string') continue;
      const timestamp = typeof item.date === 'string' ? Date.parse(item.date) : NaN;
      dateByThread.set(item.threadId, Number.isFinite(timestamp) ? timestamp : 0);
    }
  }
  return unique.sort((a, b) => (dateByThread.get(b) ?? 0) - (dateByThread.get(a) ?? 0));
}

export const MAX_GMAIL_THREADS_TO_READ = 3;
export const MAX_GMAIL_SEARCH_PAGES = 3;

export function gmailThreadIdsToRead(
  evidence: ReadonlyArray<ReadToolEvidence>,
  request?: PersonalReadRequest,
): string[] {
  return gmailSearchThreadIds(evidence, request).slice(0, MAX_GMAIL_THREADS_TO_READ);
}

function gmailReadThreadIds(evidence: ReadonlyArray<ReadToolEvidence>): string[] {
  return evidence
    .filter((row) => succeeded(row) && row.toolName === 'gmail.read_thread')
    .map((row) =>
      row.args && typeof row.args === 'object'
        ? (row.args as { threadId?: unknown }).threadId
        : undefined,
    )
    .filter((id): id is string => typeof id === 'string' && Boolean(id));
}

function gmailThreadAttempts(evidence: ReadonlyArray<ReadToolEvidence>, threadId: string): number {
  return evidence.filter(
    (row) =>
      row.toolName === 'gmail.read_thread' &&
      row.args &&
      typeof row.args === 'object' &&
      (row.args as { threadId?: unknown }).threadId === threadId,
  ).length;
}

function nextGmailThreadId(
  evidence: ReadonlyArray<ReadToolEvidence>,
  request: PersonalReadRequest,
): string | undefined {
  const targets = gmailThreadIdsToRead(evidence, request);
  const completed = new Set(gmailReadThreadIds(evidence));
  // Retry one isolated thread once. When several messages matched, inspect each
  // once so one broken thread cannot consume the whole task budget.
  const attemptsPerThread = targets.length === 1 ? 2 : 1;
  return targets.find(
    (threadId) =>
      !completed.has(threadId) && gmailThreadAttempts(evidence, threadId) < attemptsPerThread,
  );
}

function nextGmailSearchPage(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): string | undefined {
  if (!request.requiresThreadRead && !request.requiresExhaustiveMail) return undefined;
  const searches = evidence.filter((row) => matchingGmailSearch(row, request));
  if (searches.length >= MAX_GMAIL_SEARCH_PAGES) return undefined;
  const latest = searches.at(-1);
  if (!latest?.result || typeof latest.result !== 'object') return undefined;
  const result = latest.result as { hasMore?: unknown; nextPageToken?: unknown };
  return result.hasMore === true && typeof result.nextPageToken === 'string'
    ? result.nextPageToken
    : undefined;
}

/**
 * Return the next read that must happen before a personal-data answer may be
 * drafted. Source retries are bounded; the response contract then publishes
 * an honest coverage gap instead of looping or guessing.
 */
export function nextRequiredReadTool(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): string | undefined {
  if (request.temporalIssue) return undefined;
  if (request.kind === 'drive' || request.kind === 'memory' || request.kind === 'knowledge_graph') {
    if (evidence.some((row) => matchingPrivateRead(row, request))) return undefined;
    return attempts(evidence, request.firstToolName) < 2 ? request.firstToolName : undefined;
  }
  const calendarSucceeded = evidence.some((row) => matchingCalendarRead(row, request));
  if (request.kind !== 'email' && !calendarSucceeded) {
    if (attempts(evidence, request.firstToolName) < 2) return request.firstToolName;
  }

  const gmailSearchSucceeded = evidence.some((row) => matchingGmailSearch(row, request));
  if (request.kind !== 'calendar' && !gmailSearchSucceeded) {
    if (attempts(evidence, 'gmail.search') < 2) return 'gmail.search';
    return undefined;
  }

  if (request.kind !== 'calendar' && nextGmailSearchPage(request, evidence)) {
    return 'gmail.search';
  }

  if (request.requiresThreadRead && gmailThreadIdsToRead(evidence, request).length > 0) {
    return nextGmailThreadId(evidence, request) ? 'gmail.read_thread' : undefined;
  }
  return undefined;
}

/** Runtime-owned bindings for a forced private read. */
export function groundReadToolInput(
  request: PersonalReadRequest,
  toolName: string,
  input: Record<string, unknown>,
  evidence: ReadonlyArray<ReadToolEvidence>,
): Record<string, unknown> {
  if (request.temporalIssue) return {};
  if (toolName === 'calendar.list_events') {
    const { calendarIds: _ignored, ...allCalendars } = input;
    const interval = calendarReadInterval(request);
    return {
      ...allCalendars,
      ...(interval ? { timeMin: interval.start, timeMax: interval.endExclusive } : {}),
      maxResults: request.maxResults ?? 50,
    };
  }
  if (toolName === 'calendar.search_events') {
    const { calendarIds: _ignored, ...allCalendars } = input;
    const interval = calendarReadInterval(request);
    return {
      ...allCalendars,
      ...(interval ? { timeMin: interval.start, timeMax: interval.endExclusive } : {}),
      ...(request.queryTerms.length > 0 ? { query: request.queryTerms.join(' ') } : {}),
      maxResults: request.maxResults ?? 50,
    };
  }
  if (toolName === 'calendar.availability') {
    const interval = calendarReadInterval(request);
    return interval ? { timeMin: interval.start, timeMax: interval.endExclusive } : input;
  }
  if (toolName === 'gmail.search') {
    const pageToken = nextGmailSearchPage(request, evidence);
    const { pageToken: _untrustedPageToken, ...searchInput } = input;
    return {
      ...searchInput,
      query: request.mailQuery || request.queryTerms.join(' ') || '-in:spam -in:trash',
      maxResults: 20,
      ...(pageToken ? { pageToken } : {}),
    };
  }
  if (toolName === 'gmail.read_thread') {
    const target =
      nextGmailThreadId(evidence, request) ?? gmailThreadIdsToRead(evidence, request)[0];
    if (target) return { ...input, threadId: target };
  }
  if (toolName === 'drive.search') {
    return { query: request.queryTerms.join(' ') || 'recent', maxResults: 20 };
  }
  if (toolName === 'memory.recall') {
    return { query: request.queryTerms.join(' ') || 'owner history', limit: 10 };
  }
  if (toolName === 'memory.graph_snapshot') {
    return { query: request.queryTerms.join(' ') || 'owner', limit: 20 };
  }
  return input;
}

/** Build exact forced-read arguments without asking a model to invent them. */
export function buildReadToolInput(
  request: PersonalReadRequest,
  toolName: string,
  evidence: ReadonlyArray<ReadToolEvidence>,
): Record<string, unknown> | null {
  if (request.temporalIssue) return null;
  if (toolName === 'calendar.list_events' && !request.timeWindow) return null;
  if (toolName === 'calendar.search_events' && request.queryTerms.length === 0) return null;
  if (toolName === 'calendar.availability' && !request.timeWindow) return null;
  if (toolName === 'gmail.read_thread' && !nextGmailThreadId(evidence, request)) return null;
  return groundReadToolInput(request, toolName, {}, evidence);
}
