/**
 * Deterministic routing for questions whose answer lives in the assistant's
 * Google accounts. These requests are deliberately not left to a cheap model
 * classifier: a false "conversation" or "clarify" verdict gives a tool-less
 * model room to invent a plausible calendar or inbox answer.
 */

import {
  type CalendarEventAnalysisRequest,
  parseCalendarWeekdayCount,
  requestedCalendarEventAnalysis,
} from './calendar-event-analysis.js';
import { type CalendarPlanOptions, requestedCalendarPlanOptions } from './calendar-plan-intent.js';
import { requestedCardIntent } from './card-intent.js';
import {
  compoundTripFetchTargets,
  compoundTripReadProjection,
  compoundTripRoute,
  compoundTripThreadIdsToRead,
  MAX_COMPOUND_CALENDAR_COVERAGE_PAGES,
  MAX_COMPOUND_TRIP_THREADS_TO_READ,
  MAX_COMPOUND_TRIP_TOOL_CALLS,
} from './compound-trip-read.js';
import {
  EMAIL_REVIEW_MAX_SEARCH_PAGES,
  EMAIL_REVIEW_QUERY,
  emailReviewNextThreadRead,
} from './email-review.js';
import { DEFAULT_TOOL_RESULT_CHAR_LIMIT, toolResultCharacterLimit } from './executor/util.js';
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
  /** Deterministic review-only proposal requiring availability and event-list reads. */
  weeklyCalendarPlan?: boolean;
  calendarPlanOptions?: CalendarPlanOptions;
  /** Read-only calendar duration and explicit in-person gap statistics. */
  calendarEventAnalysis?: CalendarEventAnalysisRequest;
  /** Literal subject terms to bind into calendar/Gmail searches. */
  queryTerms: string[];
  /** Full bounded owner question for semantic memory retrieval. */
  memoryQuery?: string;
  /** Full bounded owner question for an explicitly requested past-chat search. */
  conversationQuery?: string;
  /** One bounded follow-up query that emphasizes owner-authored historical evidence. */
  conversationFollowupQuery?: string;
  /** A literal name from the owner's history request, independent of semantic ranking. */
  conversationAnchorQuery?: string;
  /** One topic-focused pass for an explicit owner-correction comparison. */
  conversationCorrectionQuery?: string;
  /** Saved facts are searched only when the owner explicitly permits that source. */
  searchSavedMemory?: boolean;
  /** Focused semantic query for saved-memory retrieval, separate from the answer prompt. */
  memorySearchQuery?: string;
  /** First read tool the executor must call. */
  firstToolName:
    | 'calendar.list_events'
    | 'calendar.search_events'
    | 'calendar.availability'
    | 'gmail.search'
    | 'conversations.search'
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
  /** A correction has no bounded trip to verify; ask before searching unrelated records. */
  scopeIssue?: string;
  /** Owner-supplied trip fields retained only while a bounded clarification is pending. */
  scopeContext?: { kind: 'flight'; date?: string };
  /** Gmail query derived from the owner's words, not model-proposed narrowing. */
  mailQuery?: string;
  /** Typed trip discovery keeps flight and lodging coverage independently bound. */
  mailQueries?: ReadonlyArray<{ category: 'flight' | 'lodging'; query: string }>;
  /** Explicit trip period used only to rank returned lodging metadata. */
  mailTemporalLabel?: string;
  /** Used only to render returned timestamps for the owner. */
  timeZone?: string;
  /** Bound for result sets whose wording asks for a single next item. */
  maxResults?: number;
  /** The owner is challenging a prior claim; prior prose remains hypothesis-only. */
  verification?: boolean;
  /** Explicit owner-supplied lodging scope used only to rank returned mail metadata. */
  mailRelevanceTerms?: string[];
  /** Specific question to answer, rather than turning every lookup into an agenda. */
  answerFocus?: 'lodging' | 'applications' | 'flight' | 'trip';
  /** Broad mail-history requests use a bounded metadata-page continuation. */
  requiresExhaustiveMail?: boolean;
  /** Current/upcoming mail questions prioritize the newest matching thread. */
  preferLatestMail?: boolean;
  /** A bounded future lookup, distinct from correcting a prior flight claim. */
  upcomingFlightDiscovery?: boolean;
  /** A bounded read-only itinerary lookup spanning flight, hotel, and ground transport. */
  compoundTripDiscovery?: boolean;
  /** Explicit no-send review of a bounded recent-email sample. */
  emailReview?: {
    windowDays: 7;
    requestedCount: 5;
    /** Runtime-selected read IDs, validated against this task's successful searches. */
    selectedThreadIds?: string[];
    /** Exact bounded metadata IDs shown to the structured ranker. */
    rankedCandidateIds?: string[];
    /** Ordered reserve pool returned by the ranker, validated against rankedCandidateIds. */
    rankedThreadIds?: string[];
    /** Source-backed thread IDs for which a read was attempted. */
    attemptedThreadIds?: string[];
    /** Source-backed thread IDs with a complete later owner reply. */
    excludedThreadIds?: string[];
    /** Source-backed threads completely read but conclusively not reply-eligible. */
    notEligibleThreadIds?: string[];
    backfillShortfall?: 'rank_pool_exhausted' | 'step_budget';
    rankingFailed?: boolean;
    rankingSource?: 'model' | 'recent_metadata_fallback';
    rankingFailureReason?: 'router_error' | 'invalid_result';
  };
  /** Include a bounded, source-backed overlap note when the owner asks for one. */
  includeCalendarOverlapSummary?: boolean;
  /** Use a concise agenda format for a requested calendar briefing. */
  includeCalendarBriefing?: boolean;
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
  id?: string;
  toolName: string;
  status: string;
  fromCurrentTask?: boolean;
  args?: unknown;
  result?: unknown;
  error?: string | null;
  decision?: unknown;
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
const NEGATED_LOOKUP_VERB = String.raw`(?:look(?:\s+up)?|check|search|read|open|access|review|scan|inspect|consult|use)`;

function explicitlyProhibitsPrivateRead(
  text: string,
  surface: 'calendar' | 'email' | 'memory',
): boolean {
  const accountSurface =
    surface === 'calendar'
      ? String.raw`(?:google\s+)?(?:calendars?|schedules?|agendas?)`
      : surface === 'email'
        ? `(?:gmail|e-?mails?|mail|inboxes|mailboxes|messages?|threads?)`
        : String.raw`(?:memories|memory|saved\s+(?:facts?|memories)|what\s+you\s+know)`;
  const sourceOwner = String.raw`(?:my|our)\s+(?:(?:real|actual|personal)\s+)?`;
  const clause = String.raw`[^.!?\n]{0,180}`;
  const prefix = String.raw`\b(?:do\s+not|don['’]?t|never)\s+${NEGATED_LOOKUP_VERB}\b`;
  const negatedClause = new RegExp(`${prefix}(${clause})`, 'i').exec(text)?.[1] ?? '';
  const direct = new RegExp(`\\b${sourceOwner}${accountSurface}\\b`, 'i');
  const allPrivateSurfaces = String.raw`(?:gmail|e-?mails?|mail|inboxes|mailboxes|messages?|threads?|(?:google\s+)?calendars?|schedules?|agendas?|memories|memory|saved\s+(?:facts?|memories)|what\s+you\s+know)`;
  const firstOwnedSource = new RegExp(`\\b${sourceOwner}${allPrivateSurfaces}\\b`, 'i').exec(
    negatedClause,
  );
  const listed = firstOwnedSource
    ? negatedClause
        .slice(firstOwnedSource.index + firstOwnedSource[0].length)
        .split(/,|\b(?:and|or)\b/i)
        .some((item) => new RegExp(`^\\s*(?:${sourceOwner})?${accountSurface}\\b`, 'i').test(item))
    : false;
  const without = new RegExp(
    String.raw`\bwithout\s+${NEGATED_LOOKUP_VERB}(?:ing)?\b${clause}\b${sourceOwner}${accountSurface}\b`,
    'i',
  );
  return direct.test(negatedClause) || listed || without.test(text);
}

function explicitlyRequestsCalendarOverlapSummary(text: string): boolean {
  const overlap = `(?:overlaps?|conflicts?|double[ -]?booked|clashes?)`;
  const overlapPattern = new RegExp(`\\b${overlap}\\b`, 'i');
  const negatedAction = String.raw`(?:do\s+not|don['’]?t|never)\s+(?:check|look\s+for|include|mention|point\s+out|identify|analy[sz]e|review|report)`;
  const negatedNeed = String.raw`(?:skip|no\s+need\s+to\s+(?:check|look\s+for|include|mention|identify|analy[sz]e|review))`;
  const negatedWithout = String.raw`without\s+(?:checking|looking\s+for|including|mentioning|identifying|analy[sz]ing|reviewing)`;
  const negation = new RegExp(
    `\\b(?:${negatedAction}|${negatedNeed}|${negatedWithout})\\b[^.!?\\n]{0,60}\\b${overlap}\\b`,
    'i',
  );
  return text
    .split(/[;.!?\n]+|\b(?:but|instead|however)\b/i)
    .some((clause) => overlapPattern.test(clause) && !negation.test(clause));
}

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

function lodgingRelevanceTerms(latest: string, ownerTurns: string[]): string[] {
  let scope = LODGING_QUESTION.test(latest) ? latest : '';
  if (!scope && DETAIL_FOLLOW_UP.test(latest)) {
    for (const prior of [...ownerTurns].reverse()) {
      if (/^\s*(?:thanks|thank you|ok|okay|great|got it)[.!]*\s*$/i.test(prior)) continue;
      if (DETAIL_FOLLOW_UP.test(prior)) continue;
      if (
        LODGING_QUESTION.test(prior) ||
        (LODGING_TOPIC.test(prior) && /\b(?:my|our|reservation|booking|staying)\b/i.test(prior))
      ) {
        scope = prior;
      }
      break;
    }
  }
  if (!scope) return [];

  const generic = new Set([
    'airbnb',
    'accommodation',
    'are',
    'booking',
    'check',
    'confirmation',
    'did',
    'hotel',
    'in',
    'is',
    'it',
    'lodging',
    'my',
    'near',
    'next',
    'our',
    'reservation',
    'stay',
    'staying',
    'trip',
    'we',
    'week',
    'weekend',
    'weekends',
    'where',
    'which',
    'what',
  ]);
  const placeTerms = [...scope.matchAll(/\b(?:in|at|near|for|to)\s+([^?.,;!\n]+)/gi)]
    .flatMap((match) => emailQueryTerms(match[1] ?? ''))
    .filter((term) => !generic.has(term));
  return [...new Set(placeTerms)].slice(0, 3);
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
const CONVERSATION_HISTORY_REQUEST =
  /\b(?:earlier|previous|prior|past)\s+(?:owner\s+)?(?:conversations?|chats?)\b|\b(?:previously|before)\s+(?:told|said|mentioned)\s+you\b|\bwhat\s+(?:did|have)\s+i\s+(?:tell|say|mention)\s+you\b|\bwhat\s+did\s+i\s+say\s+about\b|\b(?:earlier|previous|prior|past)\s+(?:(?:hypothetical|fictional)\s+)?(?:[\p{L}\p{N}_-]+\s+){0,3}(?:exercise|scenario|discussion)\b/iu;
const AUTOBIOGRAPHICAL_READ =
  /\b(?:when|where)\s+did\s+i\b|\bhave\s+i\s+ever\b|\bdid\s+i\s+(?:attend|visit|see|go|meet|live|work|travel)\b/i;
const AVAILABILITY_SURFACE =
  /\b(?:availability|available|busy|conflicts?|free|open\s+(?:time|slots?)|(?:calendar|schedule|agenda)\s+(?:(?:is|looks|appears)\s+)?(?:clear|empty))\b/i;
const CALENDAR_TIME_REFERENCE =
  /\b(?:today|tomorrow|weekends?|weeks?|months?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|20\d{2}-\d{2}-\d{2})\b/i;
const CALENDAR_DAY_OVERVIEW =
  /\bwhat(?:\s+is|['’]s)?\s+on\s+(?:(?:my|our|the)\s+)?(?:calendar|schedule|agenda)\b|\b(?:show|list|review|summari[sz]e)\s+(?:(?:my|our|the)\s+)?(?:calendar|schedule|agenda)\s+(?:for\s+)?(?:today|tomorrow|this week|next week)\b/i;
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

/**
 * Action words in an explicit prohibition do not turn an otherwise read-only
 * lookup into a mixed workflow. Strip only the prohibited sentence before
 * applying the positive read-then-write guard; a requested action elsewhere
 * remains visible to the guard.
 */
function readThenMutationText(text: string): string {
  return text
    .replace(
      /\b(?:do\s+not|don['’]?t|never)\s+(?:add|archive|block|book|cancel|compose|create|delete|draft|edit|email|flag|forward|hold|invite|label|make|mark|move|prepare|remember|remind|reply|reschedule|save|schedule|send|update|write)\b[^.!?\n]*/gi,
      ' ',
    )
    .replace(/\bmark\s+(?:anything\s+)?(?:as\s+)?(?:uncertain|uncertainty|unverified)\b/gi, ' ');
}

function directEmailReviewIntent(text: string): boolean {
  if (
    text.length > 2_000 ||
    /^\s*>/m.test(text) ||
    /^\s*(?:from:|begin forwarded message|on .{1,160}wrote:)/im.test(text) ||
    /\b(?:if|whether|hypothetically|what if|should i|could i|would i)\b/i.test(text)
  )
    return false;
  const asksToReviewRecentMail =
    /\b(?:review|look through|go through)\s+(?:my\s+)?(?:recent\s+)?emails?\b/i.test(text) &&
    /\b(?:last|past)\s+(?:seven|7)\s+days?\b/i.test(text);
  const asksForFiveReplyWorthyRequests =
    /\b(?:find|identify|list)\s+(?:the\s+)?(?:five|5)\s+most\s+important\s+requests?\b/i.test(
      text,
    ) && /\b(?:still\s+)?need\s+my\s+(?:response|reply)\b/i.test(text);
  const asksForContextualDrafts =
    /\b(?:explain|say)\s+why\s+each\s+matters\b/i.test(text) &&
    /\b(?:identify|include|note)\s+(?:any\s+)?deadlines?\b/i.test(text) &&
    /\bdraft\s+repl(?:y|ies)\b/i.test(text) &&
    /\b(?:using|with)\s+(?:the\s+)?relevant\s+thread\s+context\b/i.test(text);
  const explicitNoSend =
    /\b(?:don['’]?t|do\s+not)\s+send\s+anything\s+yet\b/i.test(text) &&
    !/\b(?:send|email|reply)\s+(?:it|them|those|the\s+drafts?)\b/i.test(text);
  const otherMutationText = text
    .replace(/\b(?:and\s+)?draft\s+repl(?:y|ies)\b/gi, '')
    .replace(/\b(?:don['’]?t|do\s+not)\s+send\s+anything\s+yet\b/gi, '');
  return (
    asksToReviewRecentMail &&
    asksForFiveReplyWorthyRequests &&
    asksForContextualDrafts &&
    explicitNoSend &&
    !READ_THEN_MUTATION.test(otherMutationText)
  );
}

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

  const weekdays =
    /\bnext\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+weekdays?\b/i.exec(text);
  if (weekdays?.[1]) {
    const count = parseCalendarWeekdayCount(weekdays[1]);
    if (!count) return undefined;
    let cursor = today;
    let first: CivilDate | undefined;
    let found = 0;
    for (let index = 0; index < 20 && found < count; index += 1) {
      cursor = addCivilDays(cursor, 1);
      const weekday = civilWeekday(cursor);
      if (weekday >= 1 && weekday <= 5) {
        first ??= cursor;
        found += 1;
      }
    }
    if (!first || found !== count) return undefined;
    return timeWindow(first, addCivilDays(cursor, 1), `the next ${count} weekdays`, timeZone);
  }

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
  /\b(?:(?:next|last|past|previous|prior|this|coming)\s+(?:(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:weekdays?|hours?|days?|weeks?|weekends?|months?|quarters?|years?|decades?)|(?:in\s+)?(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hours?|days?|weeks?|months?|quarters?|years?|decades?)(?:\s+(?:ago|from\s+now))?)\b/i;
const SUPPORTED_RELATIVE_PERIODS = [
  /\bnext\s+(?:[1-9]|10|one|two|three|four|five|six|seven|eight|nine|ten)\s+weekdays?\b/i,
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
    /\b(?:weekdays?|today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|20\d{2}-\d{2}-\d{2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2})\b/i.test(
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

function isUpcomingFlightDiscovery(text: string): boolean {
  const nextFlight =
    /\b(?:next|upcoming|soonest)\s+(?:future\s+)?(?:flight|flights|airline|itinerary)\b/i.test(
      text,
    );
  const nextTripWithFlight =
    /\b(?:next|upcoming|soonest)\s+(?:future\s+)?trip\b/i.test(text) && /\bflight\b/i.test(text);
  return (nextFlight || nextTripWithFlight) && (READ_OR_QUESTION.test(text) || VERIFY.test(text));
}

function isCompoundTripDiscovery(text: string): boolean {
  return (
    /\bnext\s+trip\b/i.test(text) &&
    /\b(?:flight|flights)\b/i.test(text) &&
    /\b(?:hotel|accommodation)\b/i.test(text) &&
    /\b(?:airport|public transport|taxi)\b/i.test(text) &&
    /\b(?:find|check|compare|plan|look up|search)\b/i.test(text)
  );
}

function compoundTripWindow(now: Date): PersonalReadTimeWindow {
  const start = new Date(now.getTime());
  const end = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  return {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    label: 'the next 365 days',
  };
}

function upcomingFlightWindow(now: Date): PersonalReadTimeWindow {
  return {
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    label: 'the next 365 days',
  };
}

function calendarPlanWindow(
  options: PersonalReadDetectionOptions,
  plan: CalendarPlanOptions,
): PersonalReadTimeWindow {
  const timeZone = options.timeZone ?? 'UTC';
  const now = options.now ?? new Date();
  if (!plan.workingDays) {
    return (
      resolveTimeWindowBounds('next week', 'calendar', false, {
        ...options,
        timeZone,
      }) ??
      timeWindow(
        civilDateAt(now, timeZone),
        addCivilDays(civilDateAt(now, timeZone), 7),
        'next week',
        timeZone,
      )
    );
  }
  const start = civilDateAt(now, timeZone);
  let cursor = start;
  let weekdays = 0;
  while (weekdays < plan.workingDays) {
    if (civilWeekday(cursor) !== 0 && civilWeekday(cursor) !== 6) weekdays += 1;
    if (weekdays < plan.workingDays) cursor = addCivilDays(cursor, 1);
  }
  return timeWindow(start, addCivilDays(cursor, 1), plan.windowLabel, timeZone);
}

function hasExplicitTemporalPhrase(text: string): boolean {
  return (
    /\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|(?:last|next|this)\s+(?:week|month|year)|20\d{2}-\d{2}-\d{2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2})\b/i.test(
      text,
    ) || RELATIVE_PERIOD.test(text)
  );
}

interface FlightScopeDateAnswer {
  date: string;
  destination?: string;
}

const FLIGHT_SCOPE_DATE =
  '(?:20\\d{2}-\\d{2}-\\d{2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+\\d{1,2}(?:,?\\s+20\\d{2})?)';

function parseFlightScopeDateAnswer(text: string): FlightScopeDateAnswer | undefined {
  // This is deliberately a complete-answer grammar. Quoted mail, explanations,
  // and a new request cannot become lookup instructions through a clarification.
  const match = new RegExp(
    `^\\s*(?:on\\s+)?(${FLIGHT_SCOPE_DATE})(?:\\s+to\\s+([a-z][a-z'’.-]*(?:\\s+[a-z][a-z'’.-]*){0,2}))?[.!]?\\s*$`,
    'i',
  ).exec(text);
  if (!match?.[1]) return undefined;
  return { date: match[1], ...(match[2] ? { destination: match[2] } : {}) };
}

function parseFlightScopeDestinationAnswer(text: string): string | undefined {
  const match =
    /^\s*(?:to\s+)?((?:[a-z][a-z'’.-]+|[A-Z]{3,})(?:\s+(?:[a-z][a-z'’.-]+|[A-Z]{3,})){0,2})[.!]?\s*$/i.exec(
      text,
    );
  const destination = match?.[1]?.trim();
  if (!destination) return undefined;
  const nonDestination = new Set([
    'actually',
    'also',
    'appointment',
    'appointments',
    'calendar',
    'check',
    'dentist',
    'doctor',
    'do',
    'dont',
    'email',
    'flight',
    'flights',
    'ignore',
    'instructions',
    'itinerary',
    'meeting',
    'meetings',
    'me',
    'my',
    'no',
    'okay',
    'please',
    'previous',
    'read',
    'sure',
    'thanks',
    'yes',
  ]);
  const words = destination.toLowerCase().split(/\s+/);
  if (words.some((word) => nonDestination.has(word.replace(/[^a-z]/g, '')))) return undefined;
  return destination;
}

function flightScopeClarificationContinuation(
  messages: ReadonlyArray<ReadIntentMessage>,
  latestIndex: number,
  latest: string,
  options: PersonalReadDetectionOptions,
  clarificationDepth: number,
): PersonalReadRequest | undefined {
  let assistantIndex = -1;
  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return undefined;

  const assistantQuestion = readIntentText(messages[assistantIndex]);
  const dateQuestion =
    /^What (?:is the date of the flight|date and destination is the flight) you want me to recheck\?$/i.test(
      assistantQuestion,
    );
  const destinationQuestion = assistantQuestion === 'What destination should I use for the flight?';
  if (!dateQuestion && !destinationQuestion) return undefined;

  // Parse the current owner answer before looking back. Besides making authority
  // explicit, this bounds the only recursive detection to a small local window.
  const dateAnswer = dateQuestion ? parseFlightScopeDateAnswer(latest) : undefined;
  const destinationAnswer = destinationQuestion
    ? parseFlightScopeDestinationAnswer(latest)
    : undefined;
  if (!dateAnswer && !destinationAnswer) return undefined;

  // A clarification is valid only as the immediate next owner turn after the
  // assistant marker; do not reach across a later owner topic change.
  if (messages.slice(assistantIndex + 1, latestIndex).some((message) => message.role === 'user'))
    return undefined;

  // Re-detect only the owner history before the assistant's exact clarification.
  // The assistant text is a continuation marker, never a source of trip facts.
  const prior = detectPersonalReadRequestInternal(
    messages.slice(Math.max(0, assistantIndex - 12), assistantIndex),
    options,
    clarificationDepth + 1,
  );
  if (
    prior?.answerFocus !== 'flight' ||
    !prior.scopeIssue ||
    prior.scopeIssue !== assistantQuestion
  )
    return undefined;

  const date = dateAnswer?.date ?? prior.scopeContext?.date;
  if (!date) return undefined;
  const suppliedTerms =
    (dateAnswer?.destination ?? destinationAnswer)
      ? flightDestinationTerms(`flight to ${dateAnswer?.destination ?? destinationAnswer}`)
      : [];
  const inheritedTerms = prior.queryTerms.filter(
    (term) =>
      !SCHEDULED_THING.test(term) && !/^(?:flight|flights|airline|itinerary|boarding)$/i.test(term),
  );
  const terms = suppliedTerms.length > 0 ? suppliedTerms : inheritedTerms;
  const asksForDestination = /date and destination/i.test(assistantQuestion);

  const requestBase: PersonalReadRequest = {
    ...prior,
    scopeIssue: undefined,
    temporalIssue: undefined,
    timeWindow: undefined,
    temporalIntent: undefined,
    queryTerms: terms,
    verification: true,
    answerFocus: 'flight',
    requiresThreadRead: true,
    firstToolName: 'calendar.search_events',
  };
  if ((asksForDestination && suppliedTerms.length === 0) || terms.length === 0) {
    return {
      ...requestBase,
      scopeIssue: 'What destination should I use for the flight?',
      scopeContext: { kind: 'flight', date },
    };
  }

  const temporal = resolveTemporalIntent(date, 'calendar_email', terms.length > 0, options);
  if (temporal.kind !== 'resolved') {
    return {
      ...requestBase,
      temporalIssue:
        temporalIssueFor(date, temporal) ??
        'I can’t safely resolve that flight date. Please give me a valid calendar date.',
      scopeContext: { kind: 'flight', date },
    };
  }

  return {
    ...requestBase,
    timeWindow: temporal.intent.window,
    temporalIntent: temporal.intent,
    scopeContext: undefined,
    mailQuery: gmailQuery(`flight ${terms.join(' ')}`, terms),
  };
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
  'double',
  'double-check',
  'verify',
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
  'there',
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
const MAX_MEMORY_RECALL_QUERY_CHARS = 1200;
const MAX_CONVERSATION_SEARCH_QUERY_CHARS = 500;
const MAX_MEMORY_SEARCH_PASSES = 3;
const MAX_CONVERSATION_RESULT_PAGES = 8;
const MAX_CONVERSATION_RESULT_CHARS = 1_000_000;
// Must match tools.read_result's page size. Half of its tool-result clip leaves
// room for worst-case JSON escaping in the page envelope.
const CONVERSATION_RESULT_PAGE_CHARS = 14_000;
const TOOL_CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ResultContinuation = { toolCallId: string; offset: number } | null | false;
const MEMORY_SEARCH_STOP_WORDS = new Set([
  'about',
  'actually',
  'after',
  'again',
  'and',
  'any',
  'are',
  'assistant',
  'before',
  'back',
  'being',
  'can',
  'could',
  'did',
  'do',
  'does',
  'during',
  'earlier',
  'ever',
  'from',
  'have',
  'having',
  'historical',
  'how',
  'i',
  'if',
  'in',
  'inference',
  'into',
  'is',
  'it',
  'its',
  'look',
  'me',
  'mention',
  'mentioned',
  'memories',
  'memory',
  'my',
  'new',
  'of',
  'on',
  'or',
  'our',
  'please',
  'previous',
  'previously',
  'prior',
  'said',
  'save',
  'saved',
  'say',
  'should',
  'source',
  'sources',
  'tell',
  'told',
  'the',
  'them',
  'then',
  'this',
  'those',
  'to',
  'use',
  'using',
  'verified',
  'we',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'would',
  'you',
  'your',
  'claim',
  'claims',
  'correction',
  'corrected',
  'conversation',
  'conversations',
  'distinguish',
  'current',
  'not',
  'guess',
  'answer',
  'relevant',
  'cite',
  'clearly',
  'different',
  'gave',
  'separate',
  'wrong',
  'versus',
]);

function focusedMemoryTopic(text: string): string {
  const tokens = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? [];
  const focused = tokens
    .map((token) => token.trim())
    .filter((token) => {
      const normalized = token.toLowerCase().replace(/['’]s$/u, '');
      return token.length >= 2 && !MEMORY_SEARCH_STOP_WORDS.has(normalized);
    })
    .slice(0, 14);
  return (focused.length ? focused.join(' ') : text.trim()).slice(
    0,
    MAX_CONVERSATION_SEARCH_QUERY_CHARS,
  );
}

function historicalSearchQueries(request: PersonalReadRequest): string[] {
  if (!request.conversationQuery) return [];
  const queries = [
    // An explicit name is a more useful first pass than a generic semantic
    // restatement, and leaves room for both source and correction searches.
    request.conversationAnchorQuery ?? request.conversationQuery,
    request.conversationFollowupQuery,
    request.conversationCorrectionQuery,
  ].filter((query): query is string => typeof query === 'string' && query.length > 0);
  return [...new Set(queries)];
}

function namedHistoricalAnchor(text: string): string | undefined {
  // Search an explicit name literally; a generic semantic hit is not proof that
  // the earlier named exercise or the owner's original statement was found.
  const named =
    /\b(?:called|named)\s+["“'‘]([^"”'’\n]{2,80})["”'’]|\b(?:called|named)\s+([\p{L}\p{N}][\p{L}\p{N}_-]{1,79})/iu.exec(
      text,
    );
  const hypothetical =
    /\b(?:hypothetical|fictional)\s+([A-Z][\p{L}\p{N}_-]{1,79})\s+(?:exercise|scenario|example)\b/u.exec(
      text,
    );
  return (named?.[1] ?? named?.[2] ?? hypothetical?.[1])?.trim();
}

function memoryLookupText(text: string): string {
  // A retention constraint does not request a saved-memory lookup.
  return text.replace(
    /\b(?:do not|don't|don’t|never)\s+(?:save|store|write|update|add|retain|record)\b[^.!?;,]*?\bmemor(?:y|ies)\b[^.!?;,]*/giu,
    '',
  );
}

function requestsOwnerAssistantCorrectionComparison(text: string): boolean {
  const comparison =
    /\b(?:separat\w*|distinguish\w*|compar\w*|contrast\w*|versus|\bvs\.?\b)\b/i.test(text);
  const ownerCorrection =
    /\b(?:my\s+correction|what\s+i\s+(?:actually\s+)?(?:said|told|corrected)|owner(?:'s|’s)?\s+correction)\b/i.test(
      text,
    );
  const priorAssistantStatement =
    /\b(?:your|assistant(?:'s|’s)?)\s+(?:earlier|previous|prior)\s+(?:claim|statement|reply|response|answer|recommendation)\b/i.test(
      text,
    ) ||
    /\bwhat\s+(?:did\s+)?(?:you|the assistant)\s+(?:earlier|previously|before)\s+(?:say|tell|claim|recommend)\b/i.test(
      text,
    );
  return comparison && ownerCorrection && priorAssistantStatement;
}

function nextHistoricalSearchQuery(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): string | undefined {
  for (const query of historicalSearchQueries(request).slice(0, MAX_MEMORY_SEARCH_PASSES)) {
    const attemptsForQuery = evidence.filter(
      (row) =>
        row.fromCurrentTask !== false &&
        row.toolName === 'conversations.search' &&
        argsRecord(row)?.query === query &&
        (query !== request.conversationAnchorQuery || argsRecord(row)?.mode === 'text'),
    );
    if (attemptsForQuery.some(succeeded)) continue;
    if (attemptsForQuery.length < 2) return query;
  }
  return undefined;
}

function conversationSearchResultContinuation(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): { toolCallId: string; offset: number } | undefined {
  const currentPages = evidence.filter(
    (row) => row.fromCurrentTask === true && row.toolName === 'tools.read_result',
  );
  for (const query of historicalSearchQueries(request)) {
    const search = evidence.find(
      (row) =>
        row.fromCurrentTask === true &&
        row.toolName === 'conversations.search' &&
        succeeded(row) &&
        argsRecord(row)?.query === query &&
        (query !== request.conversationAnchorQuery || argsRecord(row)?.mode === 'text'),
    );
    if (!search?.id || !TOOL_CALL_ID.test(search.id)) continue;
    let totalChars: number;
    try {
      totalChars = JSON.stringify(search.result ?? null).length;
    } catch {
      continue;
    }
    if (totalChars <= DEFAULT_TOOL_RESULT_CHAR_LIMIT || totalChars > MAX_CONVERSATION_RESULT_CHARS)
      continue;

    const pending = nextResultPage(search, currentPages);
    if (pending === false) return undefined;
    if (pending) return pending;
  }
  return undefined;
}

function nextResultPage(
  target: ReadToolEvidence,
  pages: ReadonlyArray<ReadToolEvidence>,
  seen = new Set<string>(),
  depth = 0,
): ResultContinuation {
  if (!target.id || !TOOL_CALL_ID.test(target.id) || seen.has(target.id) || depth > 3) return false;
  seen.add(target.id);
  let serialized: string;
  try {
    serialized = JSON.stringify(target.result ?? null);
  } catch {
    return false;
  }
  if (
    target.toolName === 'conversations.search' &&
    serialized.length > MAX_CONVERSATION_RESULT_CHARS
  )
    return false;
  const limit = toolResultCharacterLimit(target.toolName);
  if (serialized.length <= limit) return null;

  let offset = limit;
  let pageCount = 0;
  while (offset < serialized.length && pageCount < MAX_CONVERSATION_RESULT_PAGES) {
    const attempts = pages.filter(
      (row) => argsRecord(row)?.toolCallId === target.id && argsRecord(row)?.offset === offset,
    );
    const validPage = [...attempts].reverse().find((row) => {
      if (!succeeded(row)) return false;
      const result = objectRecord(row.result);
      if (
        !result ||
        result.offset !== offset ||
        result.totalChars !== serialized.length ||
        typeof result.chunk !== 'string' ||
        result.chunk.length === 0 ||
        result.chunk.length > CONVERSATION_RESULT_PAGE_CHARS ||
        typeof result.hasMore !== 'boolean'
      )
        return false;
      const nextOffset = offset + result.chunk.length;
      return nextOffset <= serialized.length && result.hasMore === nextOffset < serialized.length;
    });
    if (!validPage) {
      if (attempts.length < 2 && pages.length < MAX_CONVERSATION_RESULT_PAGES)
        return { toolCallId: target.id, offset };
      return false;
    }
    pageCount += 1;
    const nested = nextResultPage(validPage, pages, seen, depth + 1);
    if (nested !== null) return nested;
    const page = objectRecord(validPage.result);
    if (!page) return false;
    offset += (page.chunk as string).length;
  }
  return offset >= serialized.length ? null : false;
}

function nextSavedMemorySearchQuery(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): string | undefined {
  if (!request.searchSavedMemory) return undefined;
  const query = request.memorySearchQuery ?? request.memoryQuery;
  if (!query) return undefined;
  const attemptsForQuery = evidence.filter(
    (row) =>
      row.fromCurrentTask !== false &&
      row.toolName === 'memory.recall' &&
      argsRecord(row)?.query === query,
  );
  if (attemptsForQuery.some(succeeded) || attemptsForQuery.length >= 2) return undefined;
  return query;
}

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
  return detectPersonalReadRequestInternal(messages, options, 0);
}

function detectPersonalReadRequestInternal(
  messages: ReadonlyArray<ReadIntentMessage>,
  options: PersonalReadDetectionOptions,
  clarificationDepth: number,
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
  const calendarReadProhibited = explicitlyProhibitsPrivateRead(latest, 'calendar');
  const emailReadProhibited = explicitlyProhibitsPrivateRead(latest, 'email');
  const memoryReadProhibited = explicitlyProhibitsPrivateRead(latest, 'memory');
  const flightContinuation =
    clarificationDepth < 2 && !calendarReadProhibited && !emailReadProhibited
      ? flightScopeClarificationContinuation(
          messages,
          latestIndex,
          latest,
          options,
          clarificationDepth,
        )
      : undefined;
  if (flightContinuation) return flightContinuation;
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
    !emailReadProhibited &&
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
  if (!emailReadProhibited && directEmailReviewIntent(latest)) {
    return {
      kind: 'email',
      queryTerms: [],
      firstToolName: 'gmail.search',
      requiresThreadRead: true,
      mailQuery: EMAIL_REVIEW_QUERY,
      emailReview: { windowDays: 7, requestedCount: 5 },
    };
  }
  if (
    !latest ||
    /^\s*i\s+(?:read|checked|reviewed|looked|searched|scanned|opened)\b/i.test(latest) ||
    READ_THEN_MUTATION.test(readThenMutationText(latest)) ||
    EMAIL_COMMAND_LEAD.test(latest) ||
    (MUTATION_LEAD.test(latest) && !/\b(?:check|find|search|look|show)\b/i.test(latest))
  ) {
    return null;
  }

  const recentContext = messages
    .slice(Math.max(0, latestIndex - 4), latestIndex)
    .map(messageText)
    .join('\n');
  const compoundTripDiscovery = isCompoundTripDiscovery(latest);
  const upcomingFlightDiscovery = !compoundTripDiscovery && isUpcomingFlightDiscovery(latest);
  // A phrase such as "find my next flight and verify anything uncertain" is
  // discovery, not a correction to an assistant claim. Only terse challenges
  // without an independently named upcoming flight inherit prior scope.
  const verification = VERIFY.test(latest) && !upcomingFlightDiscovery;
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
      ...(lodging ? { mailRelevanceTerms: lodgingRelevanceTerms(latest, recentOwnerTurns) } : {}),
      ...(lodging && temporal?.kind === 'resolved' && hasExplicitTemporalPhrase(latest)
        ? { mailTemporalLabel: temporal.intent.window.label }
        : {}),
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
  const graphRead = !memoryReadProhibited && KNOWLEDGE_GRAPH_SURFACE.test(latest);
  const driveRead =
    !graphRead &&
    (DRIVE_SURFACE.test(latest) || MEDIA_FILE_READ.test(latest)) &&
    (READ_OR_QUESTION.test(latest) || /^\s*(?:pull|open|find|show)\b/i.test(latest));
  const memoryRead =
    !memoryReadProhibited &&
    !graphRead &&
    !driveRead &&
    ((MEMORY_SURFACE.test(memoryLookupText(latest)) &&
      (READ_OR_QUESTION.test(latest) || verification)) ||
      (CONVERSATION_HISTORY_REQUEST.test(latest) && READ_OR_QUESTION.test(latest)) ||
      AUTOBIOGRAPHICAL_READ.test(latest));
  if (graphRead || driveRead || memoryRead) {
    const kind: PersonalReadKind = graphRead ? 'knowledge_graph' : driveRead ? 'drive' : 'memory';
    const conversationHistoryRequested =
      kind === 'memory' && CONVERSATION_HISTORY_REQUEST.test(latest);
    const savedMemoryRequested =
      kind === 'memory' &&
      (!conversationHistoryRequested ||
        /\b(?:saved|long[- ]term|personal)\s+memor(?:y|ies)\b/i.test(memoryLookupText(latest)));
    const focusedQuery = kind === 'memory' ? focusedMemoryTopic(latest) : undefined;
    const historyAnchor = conversationHistoryRequested ? namedHistoricalAnchor(latest) : undefined;
    return {
      kind,
      queryTerms: conversationHistoryRequested
        ? privateQueryTerms(focusedQuery ?? latest)
        : contextualPrivateTerms(),
      ...(kind === 'memory' ? { memoryQuery: latest.slice(0, MAX_MEMORY_RECALL_QUERY_CHARS) } : {}),
      ...(focusedQuery ? { memorySearchQuery: focusedQuery } : {}),
      ...(conversationHistoryRequested
        ? {
            conversationQuery: focusedQuery,
            ...(historyAnchor ? { conversationAnchorQuery: historyAnchor } : {}),
            conversationFollowupQuery:
              `Owner-authored statements and corrections about ${focusedQuery}`.slice(
                0,
                MAX_CONVERSATION_SEARCH_QUERY_CHARS,
              ),
            ...(requestsOwnerAssistantCorrectionComparison(latest)
              ? {
                  conversationCorrectionQuery: `Owner correction ${focusedQuery}`.slice(
                    0,
                    MAX_CONVERSATION_SEARCH_QUERY_CHARS,
                  ),
                }
              : {}),
          }
        : {}),
      ...(kind === 'memory' ? { searchSavedMemory: savedMemoryRequested } : {}),
      firstToolName:
        kind === 'knowledge_graph'
          ? 'memory.graph_snapshot'
          : kind === 'drive'
            ? 'drive.search'
            : conversationHistoryRequested
              ? 'conversations.search'
              : 'memory.recall',
      requiresThreadRead: false,
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      ...(verification ? { verification: true } : {}),
    };
  }
  if (compoundTripDiscovery) {
    const timeWindow = compoundTripWindow(options.now ?? new Date());
    return {
      kind: 'calendar_email',
      queryTerms: [],
      firstToolName: 'calendar.list_events',
      requiresThreadRead: true,
      timeWindow,
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      answerFocus: 'trip',
      compoundTripDiscovery: true,
      maxResults: 50,
      mailQueries: [
        {
          category: 'flight',
          query:
            '{subject:(flight booking) subject:(flight booked) subject:(flight reserved) subject:(flight confirmation) subject:(airline booking) subject:(airline booked) subject:(airline reserved) subject:(airline confirmation) subject:(e-ticket) subject:(itinerary confirmation) subject:(boarding pass)}',
        },
        {
          category: 'lodging',
          query:
            '{subject:(hotel booking) subject:(hotel booked) subject:(hotel reserved) subject:(hotel reservation) subject:(lodging booked) subject:(lodging reservation) subject:(accommodation booking) subject:(accommodation reservation) subject:(check-in confirmation) subject:(stay confirmation) subject:(booking confirmation) subject:(reservation confirmation) subject:(your reservation) subject:(reservation details)}',
        },
      ],
      mailQuery:
        '{subject:(flight booking) subject:(flight booked) subject:(flight reserved) subject:(flight confirmation) subject:(airline booking) subject:(airline booked) subject:(airline reserved) subject:(airline confirmation) subject:(e-ticket) subject:(itinerary confirmation) subject:(boarding pass)}',
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
  const latestTerms = queryTerms(latest);
  const flightLanguage = /\b(?:flight|flights|airline|itinerary|boarding)\b/i;
  const genericFlightChallenge =
    verification &&
    !namesSender &&
    latestTerms.every((term) => flightLanguage.test(term)) &&
    (!SCHEDULED_THING.test(latest) || flightLanguage.test(latest));
  // Inherit the nearest owner's trip, never the assistant's disputed time.
  // A substantive change of topic ends this search instead of reviving an old trip.
  let ownerFlight: string | undefined;
  if (genericFlightChallenge) {
    for (const prior of [...recentOwnerTurns].reverse()) {
      if (
        ACCEPT_LOOKUP.test(prior) ||
        (VERIFY.test(prior) &&
          queryTerms(prior).every((term) => flightLanguage.test(term)) &&
          !hasExplicitTemporalPhrase(prior))
      )
        continue;
      if (
        detectPersonalReadRequest([{ role: 'user', content: prior }], options)?.answerFocus ===
        'flight'
      )
        ownerFlight = prior;
      break;
    }
  }
  const contextualQuery = verification && latestTerms.length === 0 && !namesSender;
  const hypothesis = ownerFlight ?? (contextualQuery ? recentContext : latest);
  const temporalText = ownerFlight
    ? hasExplicitTemporalPhrase(latest)
      ? latest
      : ownerFlight
    : contextualQuery
      ? `${latest}\n${recentContext}`
      : latest;
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
  const calendarDayList =
    CALENDAR_DAY_OVERVIEW.test(latest) && CALENDAR_TIME_REFERENCE.test(latest);
  if (nextEventQuestion || calendarDayList) terms = [];
  const personalSchedule =
    /\b(?:my|our|the|this|that|do i|did i|is there|are there)\b/i.test(latest) ||
    (verification && flightLanguage.test(latest)) ||
    terms.some((term) => !SCHEDULED_THING.test(term));
  const namedSchedule =
    !calendarReadProhibited &&
    !calendarDayList &&
    !genericScheduleList &&
    !nextEventQuestion &&
    (SCHEDULED_THING.test(latest) || (verification && SCHEDULED_THING.test(recentContext))) &&
    personalSchedule &&
    (READ_OR_QUESTION.test(latest) || verification || whyLookup);
  const daySchedule = DAY_SCHEDULE.test(latest);
  const calendar =
    !calendarReadProhibited &&
    (upcomingFlightDiscovery ||
      daySchedule ||
      namedSchedule ||
      (CALENDAR_SURFACE.test(latest) &&
        (READ_OR_QUESTION.test(latest) || verification || whyLookup)) ||
      (verification && CALENDAR_SURFACE.test(recentContext)));
  const email =
    !emailReadProhibited &&
    (upcomingFlightDiscovery ||
      (EMAIL_SURFACE.test(latest) &&
        (READ_OR_QUESTION.test(latest) || receiptQuestion(latest) || verification)) ||
      (verification && EMAIL_SURFACE.test(recentContext)));
  const availability =
    !calendarReadProhibited &&
    AVAILABILITY_SURFACE.test(latest) &&
    !namedSchedule &&
    (!EMAIL_SURFACE.test(latest) ||
      CALENDAR_SURFACE.test(latest) ||
      CALENDAR_TIME_REFERENCE.test(latest)) &&
    (/\b(?:am i|are|check|do i|find|is|show|what|when|which)\b/i.test(latest) ||
      CALENDAR_TIME_REFERENCE.test(latest));

  const calendarPlanOptions = !calendarReadProhibited
    ? requestedCalendarPlanOptions(latest)
    : undefined;
  const calendarEventAnalysis =
    !calendarReadProhibited &&
    calendarPlanOptions === undefined &&
    !READ_THEN_MUTATION.test(readThenMutationText(latest))
      ? requestedCalendarEventAnalysis(latest)
      : undefined;
  const weeklyCalendarPlan = calendarPlanOptions !== undefined;

  if (!calendar && !email && !availability && !weeklyCalendarPlan) return null;
  if (terms.length === 0 && email) terms = emailQueryTerms(hypothesis);

  // Named appointments are commonly confirmed in email before (or instead of)
  // appearing on a calendar. Search both configured sources without asking the
  // owner which provider/account contains the answer.
  const kind: PersonalReadKind =
    calendarEventAnalysis || weeklyCalendarPlan || availability
      ? 'calendar'
      : namedSchedule || (calendar && email)
        ? 'calendar_email'
        : email
          ? 'email'
          : 'calendar';
  const firstToolName = calendarEventAnalysis
    ? 'calendar.list_events'
    : weeklyCalendarPlan || availability
      ? 'calendar.availability'
      : kind === 'email'
        ? 'gmail.search'
        : kind === 'calendar_email' || terms.length > 0
          ? 'calendar.search_events'
          : 'calendar.list_events';
  const calendarBriefing =
    kind === 'calendar' &&
    /\b(?:calendar|agenda|schedule)\b/i.test(latest) &&
    /\b(?:briefing|brief me|practical briefing|quick overview|short (?:summary|answer)|recap|compact|concise)\b/i.test(
      latest,
    );

  const request: PersonalReadRequest = {
    kind,
    ...(weeklyCalendarPlan ? { weeklyCalendarPlan: true, calendarPlanOptions } : {}),
    ...(calendarEventAnalysis ? { calendarEventAnalysis } : {}),
    queryTerms: weeklyCalendarPlan || calendarEventAnalysis ? [] : terms,
    ...(upcomingFlightDiscovery ||
    (namedSchedule && (flightLanguage.test(latest) || Boolean(ownerFlight)))
      ? { answerFocus: 'flight' as const }
      : {}),
    firstToolName: upcomingFlightDiscovery ? 'calendar.list_events' : firstToolName,
    ...(upcomingFlightDiscovery ? { upcomingFlightDiscovery: true } : {}),
    requiresThreadRead:
      kind === 'calendar_email' ||
      (kind === 'email' &&
        (verification || /\b(?:when|where|what time|details?|what does|what did)\b/i.test(latest))),
    ...(calendarBriefing ? { includeCalendarBriefing: true } : {}),
    ...(explicitlyRequestsCalendarOverlapSummary(latest)
      ? { includeCalendarOverlapSummary: true }
      : {}),
  };
  if (weeklyCalendarPlan && calendarPlanOptions) {
    request.timeWindow = calendarPlanWindow(options, calendarPlanOptions);
  } else if (upcomingFlightDiscovery) {
    // Search a small set of booking-specific OR terms. ANDing the full owner
    // sentence misses confirmations, while a generic "trip" term finds old
    // unrelated itinerary mail.
    request.queryTerms = [];
    request.mailQuery =
      '{flight flights itinerary "e-ticket" "boarding pass" "booking confirmation" "reservation confirmation"}';
  }
  if (kind !== 'calendar' && !upcomingFlightDiscovery) {
    if (EXHAUSTIVE_MAIL.test(latest)) request.requiresExhaustiveMail = true;
    if (CURRENT_MAIL.test(latest)) request.preferLatestMail = true;
  }
  if (weeklyCalendarPlan) {
    request.maxResults = 50;
  } else if (calendarEventAnalysis) {
    request.maxResults = 50;
  } else if (kind !== 'email' && nextEventQuestion) {
    request.maxResults = 1;
  } else if (kind !== 'email' && upcomingFlightDiscovery) {
    // List enough bounded future events to select the first flight rather than
    // letting an earlier dentist appointment consume a one-result page.
    request.maxResults = 50;
  }
  if (kind !== 'email' && !weeklyCalendarPlan && !upcomingFlightDiscovery) {
    const temporal = resolveTemporalIntent(
      temporalText,
      kind,
      terms.length > 0,
      options,
      nextEventQuestion || upcomingFlightDiscovery ? 'next-event' : 'range',
    );
    if (temporal.kind === 'resolved') {
      request.timeWindow = temporal.intent.window;
      request.temporalIntent = temporal.intent;
    } else {
      const issue = temporalIssueFor(temporalText, temporal);
      if (issue) request.temporalIssue = issue;
    }
  }
  if (upcomingFlightDiscovery) {
    request.timeWindow = upcomingFlightWindow(options.now ?? new Date());
  } else if (kind !== 'calendar' && !weeklyCalendarPlan && !upcomingFlightDiscovery) {
    if (!upcomingFlightDiscovery) request.mailQuery = gmailQuery(hypothesis, terms);
    // A relative travel date describes the itinerary, not when its confirmation
    // arrived. Older booking confirmations can still be authoritative for a
    // future flight, so only an explicitly stated mail-age filter narrows them.
    const explicitMailAge = /\b(?:last|past)\s+(?:\d{1,2}\s+days?|week|month)\b/i.test(hypothesis);
    if (request.answerFocus === 'flight' && !explicitMailAge) {
      request.mailQuery = (request.mailQuery ?? '').replace(/\s+newer_than:\d+d\b/gi, '').trim();
    }
  }
  if (
    verification &&
    request.answerFocus === 'flight' &&
    !hasExplicitTemporalPhrase(temporalText)
  ) {
    request.scopeIssue = 'What date and destination is the flight you want me to recheck?';
  }
  if (
    ownerFlight &&
    request.answerFocus === 'flight' &&
    !hasExplicitTemporalPhrase(latest) &&
    /\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|(?:next|last|this|past|previous)\s+(?:week|month|year))\b/i.test(
      ownerFlight,
    ) &&
    !/\b20\d{2}-\d{2}-\d{2}\b/.test(ownerFlight)
  ) {
    // Model history does not carry the original turn's timestamp. Re-resolving
    // its "tomorrow" at this task's clock could move the trip across midnight.
    request.scopeIssue = 'What is the date of the flight you want me to recheck?';
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

function calendarListPages(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
  limit: number,
): ReadToolEvidence[] {
  return evidence
    .filter((row) => {
      if (
        row.fromCurrentTask === false ||
        row.toolName !== 'calendar.list_events' ||
        !succeeded(row)
      )
        return false;
      const args = argsRecord(row);
      const result = objectRecord(row.result);
      const interval = calendarReadInterval(request);
      return (
        (!Array.isArray(args?.calendarIds) || args.calendarIds.length === 0) &&
        Array.isArray(result?.events) &&
        (!interval || (args?.timeMin === interval.start && args?.timeMax === interval.endExclusive))
      );
    })
    .slice(0, limit);
}

function calendarEventAnalysisNextPageToken(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
  limit: number,
): string | undefined {
  const pages = calendarListPages(request, evidence, limit);
  let expectedPageToken: string | undefined;
  let nextPageToken: string | undefined;
  for (const page of pages) {
    if ((argsRecord(page)?.pageToken || undefined) !== expectedPageToken) return undefined;
    const result = objectRecord(page.result);
    const token = result?.nextPageToken;
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
      nextPageToken = undefined;
      break;
    }
    nextPageToken = token;
    expectedPageToken = token;
  }
  return nextPageToken;
}

function matchingGmailSearch(row: ReadToolEvidence, request: PersonalReadRequest): boolean {
  if (!succeeded(row) || row.toolName !== 'gmail.search') return false;
  const query = argsRecord(row)?.query;
  if (request.mailQueries?.length) {
    return (
      typeof query === 'string' &&
      request.mailQueries.some((entry) => query.trim().toLowerCase() === entry.query.toLowerCase())
    );
  }
  return request.mailQuery
    ? typeof query === 'string' && query.trim().toLowerCase() === request.mailQuery.toLowerCase()
    : queryIncludes(query, request.queryTerms);
}

function matchingPrivateRead(row: ReadToolEvidence, request: PersonalReadRequest): boolean {
  if (!succeeded(row) || row.toolName !== request.firstToolName) return false;
  return queryIncludes(argsRecord(row)?.query, request.queryTerms);
}

/** Search metadata prioritizes reads; it never verifies a booking or its fields. */
function flightItinerarySubject(subject: string): boolean {
  return /^(?:(?:fw|fwd|re)\s*:\s*)*flight\s*[-–—:]/i.test(subject.trim());
}

export function gmailSearchThreadIds(
  evidence: ReadonlyArray<ReadToolEvidence>,
  request?: PersonalReadRequest,
): string[] {
  const ids: string[] = [];
  for (const row of evidence) {
    if (hasTypedTripRead(request) && row.fromCurrentTask === false) continue;
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
  if (request?.compoundTripDiscovery) {
    return compoundTripThreadIdsToRead(evidence, request);
  }
  if (
    request?.answerFocus === 'flight' ||
    request?.answerFocus === 'lodging' ||
    request?.answerFocus === 'trip'
  ) {
    const scores = new Map<string, number>();
    for (const row of evidence) {
      if (hasTypedTripRead(request) && row.fromCurrentTask === false) continue;
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
        const flightScore =
          (/\b(?:booking|confirmation|itinerary|ticket|reservation|boarding pass|flight|airline)\b/i.test(
            subject,
          )
            ? 2
            : 0) +
          (/\b(?:booking|confirmation|itinerary|ticket|reservation|boarding pass|departure|flight|airline)\b/i.test(
            snippet,
          )
            ? 1
            : 0);
        const hotelScore = /\b(?:hotel|lodging|accommodation|airbnb)\b/i.test(subject) ? 3 : 0;
        const score =
          request.answerFocus === 'trip'
            ? flightScore + hotelScore
            : request.answerFocus === 'flight'
              ? (/\b(?:booking|confirmation|itinerary|ticket|reservation|boarding pass)\b/i.test(
                  subject,
                )
                  ? 2
                  : 0) +
                (/\b(?:booked|reserved)\b/i.test(subject) ? 2 : 0) +
                (/\b(?:flight|airline)\b/i.test(subject) ? 2 : 0) +
                (flightItinerarySubject(subject) ? 4 : 0) +
                (/\b(?:booking|booked|reserved|confirmation|itinerary|ticket|reservation|boarding pass|departure)\b/i.test(
                  snippet,
                )
                  ? 1
                  : 0)
              : lodgingMetadataScore(
                  subject,
                  snippet,
                  request.mailRelevanceTerms ?? [],
                  request.mailTemporalLabel,
                  request.timeWindow,
                  request.timeZone,
                );
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

function lodgingMetadataScore(
  subject: string,
  snippet: string,
  scopeTerms: string[],
  temporalLabel?: string,
  timeWindow?: PersonalReadTimeWindow,
  timeZone?: string,
): number {
  const normalizedSubject = subject.toLowerCase();
  const normalizedText = `${subject} ${snippet}`.toLowerCase();
  const scopeMatches = scopeTerms.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(normalizedText);
  }).length;
  const hasBookingSignal = /\b(?:reservation|booking|confirmation|itinerary)\b/i.test(
    normalizedSubject,
  )
    ? 2
    : 0;
  const snippetBookingSignal =
    /\b(?:reservation|booking|confirmation|itinerary|check[- ]?in|check[- ]?out)\b/i.test(snippet)
      ? 1
      : 0;
  const normalizedWords = normalizeMetadataWords(normalizedText);
  const temporalWords = temporalLabel ? normalizeMetadataWords(temporalLabel) : [];
  const matchesTripPhrase = containsWordSequence(normalizedWords, temporalWords);
  const matchesTripDate = Boolean(
    temporalLabel && metadataDateOverlapsWindow(normalizedText, timeWindow, timeZone),
  );
  const matchesTrip = matchesTripPhrase || matchesTripDate;
  if (scopeTerms.length === 0 && !temporalLabel) return hasBookingSignal + snippetBookingSignal;
  if (temporalLabel && !matchesTrip) {
    // A reservation keyword cannot make a same-city old stay look like the
    // owner's explicitly dated trip. Keep metadata order unless the returned
    // subject/snippet also names the requested period.
    return scopeMatches > 0 ? 10 + scopeMatches : 0;
  }
  // An owner-named destination is a stronger match than a generic confirmation
  // keyword; a matching explicit period distinguishes this trip from an older
  // stay at the same destination.
  return (
    (scopeMatches > 0 ? 10 + scopeMatches : 0) +
    (matchesTrip ? 4 : 0) +
    hasBookingSignal +
    snippetBookingSignal
  );
}

function metadataDateOverlapsWindow(
  text: string,
  timeWindow?: PersonalReadTimeWindow,
  timeZone?: string,
): boolean {
  if (!timeWindow || !timeZone) return false;
  const startInstant = Date.parse(timeWindow.timeMin);
  const endInstant = Date.parse(timeWindow.timeMax);
  if (
    !Number.isFinite(startInstant) ||
    !Number.isFinite(endInstant) ||
    endInstant <= startInstant
  ) {
    return false;
  }
  const startKey = civilDateKey(civilDateAt(new Date(startInstant), timeZone));
  const endKey = civilDateKey(civilDateAt(new Date(endInstant), timeZone));
  const intervals = metadataDateIntervals(text);
  return intervals.some(({ start, endExclusive }) => start < endKey && endExclusive > startKey);
}

function normalizeMetadataWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function containsWordSequence(words: string[], sequence: string[]): boolean {
  if (sequence.length === 0 || sequence.length > words.length) return false;
  for (let index = 0; index <= words.length - sequence.length; index += 1) {
    if (sequence.every((word, offset) => words[index + offset] === word)) return true;
  }
  return false;
}

function metadataDateIntervals(text: string): Array<{ start: string; endExclusive: string }> {
  const monthPattern = Object.keys(MONTH_NUMBER)
    .sort((left, right) => right.length - left.length)
    .join('|');
  const consumed: Array<{ start: number; end: number }> = [];
  const intervals: Array<{ start: string; endExclusive: string }> = [];
  const isConsumed = (index: number) =>
    consumed.some((span) => index >= span.start && index < span.end);
  const addRange = (
    match: RegExpMatchArray,
    startDate: CivilDate | undefined,
    endDate: CivilDate | undefined,
  ) => {
    if (match.index !== undefined)
      consumed.push({ start: match.index, end: match.index + match[0].length });
    if (!startDate || !endDate || civilDateKey(endDate) < civilDateKey(startDate)) return;
    intervals.push({
      start: civilDateKey(startDate),
      endExclusive: civilDateKey(addCivilDays(endDate, 1)),
    });
  };
  const validDate = (year: number, month: number, day: number): CivilDate | undefined => {
    if (year < 100 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31)
      return undefined;
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (
      candidate.getUTCFullYear() !== year ||
      candidate.getUTCMonth() + 1 !== month ||
      candidate.getUTCDate() !== day
    )
      return undefined;
    return { year, month, day };
  };
  const monthValue = (value: string | undefined) =>
    value ? MONTH_NUMBER[value.toLowerCase()] : undefined;

  const isoRanges =
    /\b(\d{4})-(\d{2})-(\d{2})\s*(?:[-–—]|to|through|until)\s*(?:(\d{4})-)?(\d{2})-(\d{2})\b/gi;
  for (const match of text.matchAll(isoRanges)) {
    const year = Number(match[1]);
    const endYear = Number(match[4] ?? match[1]);
    addRange(
      match,
      validDate(year, Number(match[2]), Number(match[3])),
      validDate(endYear, Number(match[5]), Number(match[6])),
    );
  }

  const namedRanges = new RegExp(
    `\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:[-–—]|to|through|until)\\s*(?:(${monthPattern})\\s+)?(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})\\b`,
    'gi',
  );
  for (const match of text.matchAll(namedRanges)) {
    const year = Number(match[5]);
    const startMonth = monthValue(match[1]);
    const endMonth = monthValue(match[3]) ?? startMonth;
    addRange(
      match,
      startMonth ? validDate(year, startMonth, Number(match[2])) : undefined,
      endMonth ? validDate(year, endMonth, Number(match[4])) : undefined,
    );
  }

  const isoDates = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  for (const match of text.matchAll(isoDates)) {
    if (match.index !== undefined && isConsumed(match.index)) continue;
    const date = validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (!date) continue;
    const key = civilDateKey(date);
    intervals.push({ start: key, endExclusive: civilDateKey(addCivilDays(date, 1)) });
  }

  const namedDates = new RegExp(
    `\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})\\b`,
    'gi',
  );
  for (const match of text.matchAll(namedDates)) {
    if (match.index !== undefined && isConsumed(match.index)) continue;
    const month = monthValue(match[1]);
    const date = month ? validDate(Number(match[3]), month, Number(match[2])) : undefined;
    if (!date) continue;
    const key = civilDateKey(date);
    intervals.push({ start: key, endExclusive: civilDateKey(addCivilDays(date, 1)) });
  }
  return intervals;
}

export const MAX_GMAIL_THREADS_TO_READ = 3;
export const MAX_GMAIL_SEARCH_PAGES = 3;
export const MAX_COMPOUND_CALENDAR_PAGES = MAX_COMPOUND_CALENDAR_COVERAGE_PAGES;

function hasTypedTripRead(request: PersonalReadRequest | undefined): boolean {
  return Boolean(request?.compoundTripDiscovery || request?.upcomingFlightDiscovery);
}

export function gmailThreadIdsToRead(
  evidence: ReadonlyArray<ReadToolEvidence>,
  request?: PersonalReadRequest,
): string[] {
  if (request?.emailReview) return request.emailReview.selectedThreadIds ?? [];
  const limit = request?.compoundTripDiscovery
    ? MAX_COMPOUND_TRIP_THREADS_TO_READ
    : request?.upcomingFlightDiscovery
      ? 2
      : MAX_GMAIL_THREADS_TO_READ;
  return gmailSearchThreadIds(evidence, request).slice(0, limit);
}

function gmailReadThreadIds(evidence: ReadonlyArray<ReadToolEvidence>): string[] {
  return evidence
    .filter(
      (row) =>
        row.fromCurrentTask !== false && succeeded(row) && row.toolName === 'gmail.read_thread',
    )
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
      row.fromCurrentTask !== false &&
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

function compoundThreadReadInput(
  evidence: ReadonlyArray<ReadToolEvidence>,
  request: PersonalReadRequest,
): Record<string, unknown> | undefined {
  if (!hasTypedTripRead(request)) return undefined;
  const targets = gmailThreadIdsToRead(evidence, request);
  for (const threadId of targets) {
    const attempts = evidence.filter(
      (row) =>
        row.fromCurrentTask !== false &&
        row.toolName === 'gmail.read_thread' &&
        objectRecord(row.args)?.threadId === threadId,
    ).length;
    const pages = evidence.filter(
      (row) =>
        row.fromCurrentTask !== false &&
        succeeded(row) &&
        row.toolName === 'gmail.read_thread' &&
        objectRecord(row.args)?.threadId === threadId,
    );
    if (pages.length === 0) {
      if (attempts >= 2) continue;
      return {
        threadId,
        startMessageIndex: 0,
        startMessageOffset: 0,
        maxMessages: 20,
        maxChars: 20_000,
      };
    }
    const latest = pages.at(-1);
    const result = objectRecord(latest?.result);
    if (result?.complete === true) continue;
    if (pages.length >= 2 || attempts >= 2) continue;
    const continuation = objectRecord(result?.continuation);
    const input = objectRecord(continuation?.input);
    if (
      continuation?.tool === 'gmail.read_thread' &&
      input?.threadId === threadId &&
      Number.isInteger(input.startMessageIndex) &&
      Number(input.startMessageIndex) >= 0 &&
      Number(input.startMessageIndex) <= 100_000 &&
      Number.isInteger(input.startMessageOffset) &&
      Number(input.startMessageOffset) >= 0 &&
      Number(input.startMessageOffset) <= 100_000 &&
      Number.isInteger(input.maxMessages) &&
      Number(input.maxMessages) >= 1 &&
      Number(input.maxMessages) <= 100 &&
      Number.isInteger(input.maxChars) &&
      Number(input.maxChars) >= 100 &&
      Number(input.maxChars) <= 50_000
    )
      return { ...input };
  }
  return undefined;
}

function nextGmailSearchPage(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): string | undefined {
  if (!request.requiresThreadRead && !request.requiresExhaustiveMail) return undefined;
  const target = nextGmailSearchTarget(request, evidence);
  return target ? (target.pageToken ?? target.query) : undefined;
}

function nextGmailSearchTarget(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): { query: string; pageToken?: string } | undefined {
  if (request.mailQueries?.length && hasTypedTripRead(request)) {
    for (const { query } of request.mailQueries) {
      const attempts = evidence.filter(
        (row) =>
          row.fromCurrentTask !== false &&
          row.toolName === 'gmail.search' &&
          typeof argsRecord(row)?.query === 'string' &&
          String(argsRecord(row)?.query).trim().toLowerCase() === query.toLowerCase(),
      );
      const searches = evidence.filter(
        (row) =>
          row.fromCurrentTask !== false &&
          succeeded(row) &&
          row.toolName === 'gmail.search' &&
          typeof argsRecord(row)?.query === 'string' &&
          String(argsRecord(row)?.query).trim().toLowerCase() === query.toLowerCase(),
      );
      if (searches.length === 0) {
        if (attempts.length >= 2) continue;
        return { query };
      }
      if (searches.length >= 2) continue;
      const latest = searches.at(-1);
      const result = objectRecord(latest?.result);
      if (result?.hasMore === true && typeof result.nextPageToken === 'string')
        return { query, pageToken: result.nextPageToken };
      if (result?.complete === true && result.hasMore !== true) continue;
    }
    return undefined;
  }
  const searches = evidence.filter(
    (row) => row.fromCurrentTask !== false && matchingGmailSearch(row, request),
  );
  const pageLimit = request.emailReview
    ? EMAIL_REVIEW_MAX_SEARCH_PAGES
    : hasTypedTripRead(request)
      ? 2
      : MAX_GMAIL_SEARCH_PAGES;
  if (searches.length >= pageLimit) return undefined;
  if (searches.length === 0 && request.mailQuery) return { query: request.mailQuery };
  const latest = searches.at(-1);
  if (!latest?.result || typeof latest.result !== 'object') return undefined;
  const result = latest.result as { hasMore?: unknown; nextPageToken?: unknown };
  return result.hasMore === true && typeof result.nextPageToken === 'string'
    ? { query: request.mailQuery ?? '', pageToken: result.nextPageToken }
    : undefined;
}

/**
 * The compound-trip extractor runs only after the bounded search selection is
 * stable and each selected thread has either completed its exact continuation
 * chain or exhausted its bounded retry. A provider's remaining pages do not
 * block extraction once the two-page search budget is reached.
 */
export function compoundTripSourceReadsSettled(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): boolean {
  if (!hasTypedTripRead(request) || nextGmailSearchPage(request, evidence)) return false;
  return (
    compoundThreadReadInput(evidence, request) === undefined &&
    nextGmailThreadId(evidence, request) === undefined
  );
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
  if (request.temporalIssue || request.scopeIssue) return undefined;
  if (request.emailReview) {
    const gmailSearchSucceeded = evidence.some((row) => matchingGmailSearch(row, request));
    if (!gmailSearchSucceeded)
      return attempts(evidence, 'gmail.search') < 2 ? 'gmail.search' : undefined;
    if (nextGmailSearchPage(request, evidence)) return 'gmail.search';
    if (request.emailReview.rankingFailed || request.emailReview.selectedThreadIds === undefined)
      return undefined;
    return emailReviewNextThreadRead(request.emailReview.selectedThreadIds, evidence)
      ? 'gmail.read_thread'
      : undefined;
  }
  if (request.calendarEventAnalysis) {
    const currentEvidence = evidence.filter((row) => row.fromCurrentTask !== false);
    const pages = calendarListPages(request, currentEvidence, 3);
    if (pages.length === 0) {
      const attempted = currentEvidence.filter(
        (row) =>
          row.toolName === 'calendar.list_events' &&
          (argsRecord(row)?.pageToken === undefined || argsRecord(row)?.pageToken === null),
      ).length;
      return attempted < 2 ? 'calendar.list_events' : undefined;
    }
    const token = calendarEventAnalysisNextPageToken(request, currentEvidence, 3);
    if (token && pages.length < 3) {
      const attempted = currentEvidence.filter(
        (row) => row.toolName === 'calendar.list_events' && argsRecord(row)?.pageToken === token,
      ).length;
      return attempted < 2 ? 'calendar.list_events' : undefined;
    }
    return undefined;
  }
  if (request.weeklyCalendarPlan) {
    const availabilitySucceeded = evidence.some((row) => matchingCalendarRead(row, request));
    if (!availabilitySucceeded && attempts(evidence, 'calendar.availability') < 2)
      return 'calendar.availability';

    const interval = calendarReadInterval(request);
    const pages = evidence
      .filter((row) => {
        if (row.toolName !== 'calendar.list_events' || !succeeded(row)) return false;
        const args = argsRecord(row);
        if (Array.isArray(args?.calendarIds) && args.calendarIds.length > 0) return false;
        return (
          !interval || (args?.timeMin === interval.start && args?.timeMax === interval.endExclusive)
        );
      })
      .slice(0, 3);
    let expectedPageToken: string | undefined;
    for (let index = 0; index < pages.length && index < 3; index += 1) {
      const page = pages[index];
      if (!page) break;
      const args = argsRecord(page);
      if ((args?.pageToken || undefined) !== expectedPageToken) break;
      const result =
        page.result && typeof page.result === 'object'
          ? (page.result as Record<string, unknown>)
          : undefined;
      const token = result?.nextPageToken;
      if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
        expectedPageToken = undefined;
        break;
      }
      expectedPageToken = token;
    }
    if (pages.length === 0) {
      const attempted = evidence.filter(
        (row) =>
          row.toolName === 'calendar.list_events' && argsRecord(row)?.pageToken === undefined,
      ).length;
      return attempted < 2 ? 'calendar.list_events' : undefined;
    }
    const lastPage = pages.at(-1);
    const lastArgs = lastPage ? argsRecord(lastPage) : undefined;
    const lastResult =
      lastPage?.result && typeof lastPage.result === 'object'
        ? (lastPage.result as Record<string, unknown>)
        : undefined;
    if (expectedPageToken && pages.length < 3) {
      const attempted = evidence.filter(
        (row) =>
          row.toolName === 'calendar.list_events' &&
          argsRecord(row)?.pageToken === expectedPageToken,
      ).length;
      return attempted < 2 ? 'calendar.list_events' : undefined;
    }
    if (!lastResult || !Array.isArray(lastResult.events)) {
      const attempted = evidence.filter(
        (row) =>
          row.toolName === 'calendar.list_events' &&
          (argsRecord(row)?.pageToken || undefined) === (lastArgs?.pageToken || undefined),
      ).length;
      if (attempted < 2) return 'calendar.list_events';
    }
    return undefined;
  }
  if (request.kind === 'memory') {
    if (conversationSearchResultContinuation(request, evidence)) return 'tools.read_result';
    if (nextHistoricalSearchQuery(request, evidence)) return 'conversations.search';
    if (nextSavedMemorySearchQuery(request, evidence)) return 'memory.recall';
    return undefined;
  }
  if (request.kind === 'drive' || request.kind === 'knowledge_graph') {
    if (evidence.some((row) => matchingPrivateRead(row, request))) return undefined;
    return attempts(evidence, request.firstToolName) < 2 ? request.firstToolName : undefined;
  }
  if (hasTypedTripRead(request)) {
    const currentEvidence = evidence.filter((row) => row.fromCurrentTask !== false);
    const tripReadTools = new Set([
      'calendar.list_events',
      'gmail.search',
      'gmail.read_thread',
      ...(request.compoundTripDiscovery ? ['maps.directions', 'web.search', 'web.fetch'] : []),
    ]);
    if (
      currentEvidence.filter((row) => tripReadTools.has(row.toolName)).length >=
      (request.compoundTripDiscovery ? MAX_COMPOUND_TRIP_TOOL_CALLS : 8)
    )
      return undefined;
    const calendarRows = currentEvidence.filter((row) => matchingCalendarRead(row, request));
    if (calendarRows.length === 0 && attempts(currentEvidence, request.firstToolName) < 2)
      return request.firstToolName;
    const lastCalendar = calendarRows.at(-1);
    const calendarResult = objectRecord(lastCalendar?.result);
    if (
      typeof calendarResult?.nextPageToken === 'string' &&
      calendarResult.paginationUnavailable !== true &&
      calendarRows.length < MAX_COMPOUND_CALENDAR_PAGES
    )
      return request.firstToolName;

    const searches = currentEvidence.filter((row) => matchingGmailSearch(row, request));
    if (searches.length === 0 && attempts(currentEvidence, 'gmail.search') < 2)
      return 'gmail.search';
    if (nextGmailSearchPage(request, currentEvidence)) return 'gmail.search';
    if (gmailThreadIdsToRead(currentEvidence, request).length > 0) {
      const pagedThread = compoundThreadReadInput(currentEvidence, request);
      if (pagedThread) return 'gmail.read_thread';
      const threadId = nextGmailThreadId(currentEvidence, request);
      if (threadId) return 'gmail.read_thread';
    }

    if (!request.compoundTripDiscovery) return undefined;

    const route = compoundTripRoute(request, currentEvidence);
    if (route && !evidence.some((row) => matchingCompoundMapRoute(row, route)))
      return 'maps.directions';
    const projection = compoundTripReadProjection(request, currentEvidence);
    if (
      projection.webQuery &&
      !evidence.some(
        (row) =>
          row.toolName === 'web.search' &&
          objectRecord(row.args)?.query === projection.webQuery &&
          row.fromCurrentTask !== false,
      )
    )
      return 'web.search';
    for (const target of compoundTripFetchTargets(request, currentEvidence)) {
      if (
        !evidence.some(
          (row) =>
            row.toolName === 'web.fetch' &&
            objectRecord(row.args)?.url === target.url &&
            row.fromCurrentTask !== false,
        )
      )
        return 'web.fetch';
    }
    return undefined;
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
  if (request.temporalIssue || request.scopeIssue) return {};
  if (toolName === 'tools.read_result' && request.kind === 'memory')
    return conversationSearchResultContinuation(request, evidence) ?? {};
  if (toolName === 'conversations.search' && request.conversationQuery) {
    const query = nextHistoricalSearchQuery(request, evidence);
    return query
      ? { query, limit: 20, ...(query === request.conversationAnchorQuery ? { mode: 'text' } : {}) }
      : {};
  }
  if (toolName === 'calendar.list_events') {
    const { calendarIds: _ignored, ...unboundCalendarArgs } = input;
    const allCalendars =
      request.weeklyCalendarPlan || request.calendarEventAnalysis
        ? (({ pageToken: _untrustedPageToken, ...args }) => args)(unboundCalendarArgs)
        : unboundCalendarArgs;
    const interval = calendarReadInterval(request);
    return {
      ...allCalendars,
      ...(interval ? { timeMin: interval.start, timeMax: interval.endExclusive } : {}),
      maxResults: request.maxResults ?? 50,
      ...(hasTypedTripRead(request)
        ? { pageToken: compoundCalendarPageToken(request, evidence) }
        : request.weeklyCalendarPlan || request.calendarEventAnalysis
          ? (() => {
              const token = calendarEventAnalysisNextPageToken(request, evidence, 3);
              return token ? { pageToken: token } : {};
            })()
          : {}),
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
    const target = nextGmailSearchTarget(request, evidence);
    const { pageToken: _untrustedPageToken, ...searchInput } = input;
    return {
      ...searchInput,
      query:
        target?.query || request.mailQuery || request.queryTerms.join(' ') || '-in:spam -in:trash',
      maxResults: request.emailReview ? 100 : 20,
      ...(target?.pageToken ? { pageToken: target.pageToken } : {}),
    };
  }
  if (request.compoundTripDiscovery && toolName === 'maps.directions') {
    const route = compoundTripRoute(request, evidence);
    return route ? { ...route, mode: 'driving' } : {};
  }
  if (request.compoundTripDiscovery && toolName === 'web.search') {
    const projection = compoundTripReadProjection(request, evidence);
    return projection.webQuery ? { query: projection.webQuery, count: 5 } : {};
  }
  if (request.compoundTripDiscovery && toolName === 'web.fetch') {
    const projection = compoundTripReadProjection(request, evidence);
    const targets = compoundTripFetchTargets(request, evidence);
    const target = targets.find(
      (candidate) =>
        !evidence.some(
          (row) =>
            row.toolName === 'web.fetch' &&
            objectRecord(row.args)?.url === candidate.url &&
            row.fromCurrentTask !== false,
        ),
    );
    return target && projection.webQuery ? { url: target.url } : {};
  }
  if (toolName === 'gmail.read_thread') {
    const compoundPage = compoundThreadReadInput(evidence, request);
    if (compoundPage) return compoundPage;
    if (request.emailReview) {
      const next = emailReviewNextThreadRead(request.emailReview.selectedThreadIds ?? [], evidence);
      return next?.input ?? {};
    }
    const target =
      nextGmailThreadId(evidence, request) ?? gmailThreadIdsToRead(evidence, request)[0];
    if (target) return { ...input, threadId: target };
  }
  if (request.compoundTripDiscovery && toolName === 'maps.directions') {
    const route = compoundTripRoute(request, evidence);
    return route ? { ...route, mode: 'driving' } : {};
  }
  if (request.compoundTripDiscovery && toolName === 'web.search') {
    const projection = compoundTripReadProjection(request, evidence);
    return projection.webQuery ? { query: projection.webQuery, count: 5 } : {};
  }
  if (toolName === 'drive.search') {
    return { query: request.queryTerms.join(' ') || 'recent', maxResults: 20 };
  }
  if (toolName === 'memory.recall') {
    return {
      query:
        request.memorySearchQuery ??
        request.memoryQuery ??
        (request.queryTerms.join(' ') || 'owner history'),
      limit: 10,
    };
  }
  if (toolName === 'memory.graph_snapshot') {
    return { query: request.queryTerms.join(' ') || 'owner', limit: 20 };
  }
  return input;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compoundCalendarPageToken(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): string | undefined {
  const last = evidence
    .filter((row) => row.fromCurrentTask !== false && matchingCalendarRead(row, request))
    .at(-1);
  const token = objectRecord(last?.result)?.nextPageToken;
  return typeof token === 'string' ? token : undefined;
}

function matchingCompoundMapRoute(
  row: ReadToolEvidence,
  route: { origin: string; destination: string },
): boolean {
  if (row.fromCurrentTask === false || row.toolName !== 'maps.directions') return false;
  const args = objectRecord(row.args);
  return args?.origin === route.origin && args?.destination === route.destination;
}

/** Build exact forced-read arguments without asking a model to invent them. */
export function buildReadToolInput(
  request: PersonalReadRequest,
  toolName: string,
  evidence: ReadonlyArray<ReadToolEvidence>,
): Record<string, unknown> | null {
  if (request.temporalIssue || request.scopeIssue) return null;
  if (toolName === 'calendar.list_events' && !request.timeWindow) return null;
  if (toolName === 'calendar.search_events' && request.queryTerms.length === 0) return null;
  if (toolName === 'calendar.availability' && !request.timeWindow) return null;
  if (toolName === 'gmail.read_thread' && request.emailReview) {
    return (
      emailReviewNextThreadRead(request.emailReview.selectedThreadIds ?? [], evidence)?.input ??
      null
    );
  }
  if (
    toolName === 'gmail.read_thread' &&
    !(hasTypedTripRead(request)
      ? compoundThreadReadInput(evidence, request)
      : nextGmailThreadId(evidence, request))
  )
    return null;
  if (
    request.compoundTripDiscovery &&
    toolName === 'maps.directions' &&
    !compoundTripRoute(request, evidence)
  )
    return null;
  if (
    request.compoundTripDiscovery &&
    toolName === 'web.search' &&
    !compoundTripReadProjection(request, evidence).webQuery
  )
    return null;
  if (
    request.compoundTripDiscovery &&
    toolName === 'web.fetch' &&
    compoundTripFetchTargets(request, evidence).every((target) =>
      evidence.some(
        (row) =>
          row.toolName === 'web.fetch' &&
          objectRecord(row.args)?.url === target.url &&
          row.fromCurrentTask !== false,
      ),
    )
  )
    return null;
  return groundReadToolInput(request, toolName, {}, evidence);
}
