import { leagueNamedIn } from '../sports/leagues.js';
import { requestedArtifactIntent, requestedDocumentReadIntent } from './artifact-intent.js';
import {
  detectPersonalReadRequest,
  type ReadIntentMessage,
  readIntentText,
  resolveTemporalIntent,
  resolveTimeWindow,
  type TemporalIntentResolution,
} from './read-intent.js';
import type { ActionEvidence } from './response-contract.js';

export type LiveLookup = {
  kind: 'weather' | 'web' | 'sports' | 'directions';
  request: string;
  /** Team/league names extracted from a completion-dependent sports reminder. */
  reminderTeam?: string;
  reminderLeague?: string;
  /**
   * A trip whose destination is an event on the owner's calendar ("my 3pm",
   * "my dentist appointment"): the runtime reads the calendar first and
   * routes to the event's own location, arriving by its start.
   */
  destination?: 'calendar';
  /** A generic airport trip needs itinerary evidence before naming an airport. */
  airportIntent?: true;
};

/** The owner's clock, for lookups that resolve "my 3pm" or "my next meeting". */
export type LookupContext = { now: Date; timeZone: string };

const QUESTION = /^(?:how|what|who|when|where|will|is|are|any|do|does|should|can|could)\b/i;
const WEATHER = /\b(?:weather|forecast|temperature|rain|raining|snow|snowing)\b/i;
const SEARCH =
  /\b(?:look (?:it |that |this )up|search (?:the web|online|for)|check (?:the )?(?:score|wcore)|verify (?:it|that|this))\b/i;
const CURRENT = /\b(?:current|currently|latest|live|right now|today|tonight|tomorrow)\b/i;
const PUBLIC_FACT =
  /\b(?:president|prime minister|ceo|score|standings|weather|forecast|price|news|hiring|jobs?)\b/i;
// A fare comparison depends on the operator's current rules even when the
// owner does not explicitly say "look it up" or "current".
const TRANSIT_PRICING =
  /\b(?:fares?|tickets?|passes|passports?|transit|public transport|bus|buses|trains?|rail|subway|metro|muni|bart|clipper|cable[- ]?cars?)\b/i;
const PRICE_DECISION =
  /\b(?:cheapest|cheaper|costs?|prices?|pricing|fares?|how much|best value|compare)\b/i;

function suppliedPricingExercise(request: string): boolean {
  return (
    /\b(?:fictional|hypothetical|use only|using only|based only on|do not (?:search|look)|don't (?:search|look))\b/i.test(
      request,
    ) ||
    (/\b(?:given|assume|assuming)\b/i.test(request) && /[$€£]\s*\d/.test(request))
  );
}
/** A result, fixture, or table question — about a sport, not a credit score. */
const SPORTS_RESULT =
  /\b(?:scores?|scoreline|standings|fixtures?|who won|kick-?off|box score|league table)\b/i;
const SPORTS_EVENT =
  /\b(?:game|match|playing|play|plays|won|win|lose|lost|beat|playoffs?|results?|table)\b/i;
const SPORT_WORD =
  /\b(?:baseball|football|soccer|basketball|hockey|mlb|nfl|nba|wnba|nhl|mls|premier league|champions league|la ?liga|bundesliga|serie a|ligue 1)\b/i;
/** Scores that are not sport, and the owner's own games, which live on their calendar. */
const NOT_SPORTS =
  /\b(?:credit|test|exam|sat|act|gre|fico|risk|health|sleep|readiness|lighthouse|nps|quiz)\s+scores?\b|\bmy\b[^.?!]{0,40}\b(?:game|match|practice|score)\b/i;
const SPORTS_IMPERATIVE = /\b(?:show|give|get|check|track|follow|create|make|build|render)\b/i;
const SPORTS_LOOKUP_PROHIBITION =
  /\b(?:do\s+not|don't|dont|never)\s+(?:(?:look\s+up|search(?:\s+the\s+web)?|check|fetch|get|show|tell\s+me)\b[^.?!]{0,60}\b(?:scores?|results?|game|match|fixture)\b|(?:search\s+)?(?:scores?|results?)\b)/i;
const EVENT_REMINDER =
  /\b(?:remind me|(?:set|create|add|make|put|schedule) (?:me )?a reminder|reminder to)\b[\s\S]{0,80}\b(?:after|when|once|as soon as)\b[\s\S]{0,80}\b(?:game|match|fixture)\b/i;

/**
 * Extract only the team phrase the owner placed next to a score/game noun.
 * The scores adapter validates the phrase against its covered team rosters;
 * this parser does not infer a city, league, or team from outside the request.
 */
function requestedSportsTeam(request: string): string | undefined {
  if (SPORTS_LOOKUP_PROHIBITION.test(request)) return undefined;
  const explicit =
    /\b(?:scores?|results?)\s+(?:in|for|of)\s+(?:the\s+)?([\p{L}\d][\p{L}\d.'’& -]{0,55}?)(?=\s+(?:game|match|fixture|today|tonight|tomorrow|yesterday)\b|[?.!,;]|$)/iu.exec(
      request,
    );
  let candidate = explicit?.[1];
  if (!candidate) {
    const anchor = /\b(?:scoreline|scores?|results?|game|match|fixture)\b/i.exec(request);
    if (!anchor) return undefined;
    candidate = request.slice(0, anchor.index);
  }

  candidate = candidate
    .replace(/\b(?:today|tonight|tomorrow|yesterday|this|next|last)\b[\s\S]*$/i, '')
    .replace(
      /^(?:(?:what(?:['’]s|\s+(?:is|was|are|were))|who(?:\s+won)?|which|any|is\s+there|did|does|can\s+you|could\s+you|tell\s+me|show\s+me|check|get|give\s+me|please)\s+)+/i,
      '',
    )
    .replace(/^(?:(?:the|a|an|current|currently|latest|live|right\s+now)\s+)+/i, '')
    .replace(/\b(?:the|current|currently|latest|live|right\s+now)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // A league-only question must not be narrowed to a nonexistent team named
  // after that league. Keep an explicitly adjacent team without its league tag.
  const league = leagueNamedIn(candidate);
  if (league) {
    const aliases = [...league.aliases, league.label, league.key]
      .sort((left, right) => right.length - left.length)
      .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    if (new RegExp(`^(?:${aliases})$`, 'i').test(candidate)) return undefined;
    candidate = candidate
      .replace(new RegExp(`^(?:${aliases})\\s+|\\s+(?:in\\s+)?(?:${aliases})$`, 'gi'), '')
      .trim();
  }

  if (
    !candidate ||
    candidate.length > 56 ||
    candidate.split(' ').length > 5 ||
    /\b(?:and|or|versus|vs|not|never|without|instead|score|scores|result|results|game|match|fixture)\b/i.test(
      candidate,
    ) ||
    !/^[\p{L}\d][\p{L}\d.'’& -]*$/u.test(candidate)
  )
    return undefined;
  return candidate;
}

function reminderSportsTeam(request: string): string | undefined {
  const match =
    /\b(?:after|when|once|as soon as)\s+(?:(?:the|my)\s+)?([\p{L}][\p{L}.' -]{0,50}?)\s+(?:game|match|fixture)\b/iu.exec(
      request,
    );
  const value = match?.[1]
    ?.replace(/\b(?:tomorrow|today|tonight|yesterday|next|this|last)\b/gi, '')
    .replace(/['’]s\b/g, '')
    .trim();
  if (!value || /^(?:game|match|fixture|event|my|our)$/i.test(value)) return undefined;
  if (/^(?:my|our)\s+/i.test(value)) return undefined;
  return value;
}

/**
 * A trip question: "directions to Oracle Park", "how long to drive to SFO",
 * "how far is Palo Alto", "when should I leave for the airport". Deliberately
 * narrow — "how long to cook rice" and "how far along is the project" are not
 * trips.
 */
const DIRECTIONS =
  /\b(?:directions?\s+(?:to|from)\b|route\s+to|how\s+(?:long|many\s+minutes)\b[^.?!]{0,30}\bto\s+(?:get|drive|walk|bike|cycle)\s+(?:to|there|home|back)|how\s+far\s+(?:is|away\s+is)\s+(?!it\b|along\b)|when\s+(?:should|do)\s+i\s+(?:leave|head\s+out)\s+(?:for|to)|(?:drive|driving|travel|walk|walking|commute)\s+time\s+(?:to|from))/i;

/**
 * A trip whose destination is on the owner's calendar: "my 3pm", "my next
 * meeting", "my dentist appointment". A bare number is not a time ("my 3
 * kids"), so a clock time needs am/pm or minutes.
 */
const MY_EVENT =
  /\bmy\s+(?:next\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|(?:[a-z'-]+\s+){0,2}(?:meeting|appointment|event|flight|reservation|call|dinner|lunch|interview|class|practice))\b/i;
const FLIGHT_EVENT = /\b(?:flight|airline|itinerary|boarding)\b/i;
/** Event words that name a kind of thing, so the event must say it too. */
const SPECIFIC_EVENT = /\b(?:flight|dinner|lunch|interview|class|practice)\b/i;
/** "What's the Giants score?", "any Premier League results?", "make a live score card". */
function isSportsRequest(request: string, asks: boolean): boolean {
  if (NOT_SPORTS.test(request) || SPORTS_LOOKUP_PROHIBITION.test(request)) return false;
  if (
    !asks &&
    !SPORTS_IMPERATIVE.test(request) &&
    !(
      EVENT_REMINDER.test(request) &&
      (SPORT_WORD.test(request) || leagueNamedIn(request) || reminderSportsTeam(request))
    )
  )
    return false;
  if (SPORTS_RESULT.test(request)) return true;
  return SPORTS_EVENT.test(request) && (SPORT_WORD.test(request) || !!leagueNamedIn(request));
}

/**
 * A generic airport is not a route destination. A named airport or a place
 * attached to it is already a usable destination and stays on the ordinary
 * Maps path.
 */
function asksForGenericAirport(request: string): boolean {
  const airport = /\bairports?\b/i.exec(request);
  if (!airport) return false;
  const before = request.slice(0, airport.index);
  const prepositions = [...before.matchAll(/\b(?:to|at|in|near)\b/gi)];
  const finalPreposition = prepositions.at(-1);
  const namedPlace = finalPreposition
    ? before.slice((finalPreposition.index ?? 0) + finalPreposition[0].length).trim()
    : '';
  if (
    namedPlace &&
    !/^(?:(?:the|a|an|my|our)(?:\s+(?:nearest|closest|local|international|domestic))?|nearest|closest|local|international|domestic)$/i.test(
      namedPlace,
    )
  )
    return false;
  const after = request.slice(airport.index + airport[0].length);
  if (/^\s+(?:in|at|near)\s+[\p{L}\d]/iu.test(after)) return false;
  return true;
}

function airportClarificationContinuation(
  history: ReadonlyArray<ReadIntentMessage>,
): string | undefined {
  const lastUserIndex = history.findLastIndex((message) => message.role === 'user');
  if (lastUserIndex <= 0) return undefined;
  const latestUser = readIntentText(history[lastUserIndex] ?? { role: 'user', content: '' }).trim();
  const assistant = history
    .slice(0, lastUserIndex)
    .findLast((message) => message.role === 'assistant');
  const previousUser = history
    .slice(0, lastUserIndex)
    .findLast((message) => message.role === 'user');
  if (!latestUser || !assistant || !previousUser) return undefined;
  const assistantText = readIntentText(assistant);
  const previousRequest = readIntentText(previousUser).trim();
  const previousAirportRequest =
    DIRECTIONS.test(previousRequest) &&
    (asksForGenericAirport(previousRequest) ||
      (MY_EVENT.test(previousRequest) && /\bflight\b/i.test(previousRequest)));
  const asksForRouteDetails =
    /\b(?:airport|flight)\b/i.test(assistantText) &&
    /\b(?:where|origin|start|leave|departure|what time|which airport)\b/i.test(assistantText);
  if (!previousAirportRequest || !asksForRouteDetails) return undefined;
  const details = [latestUser];
  const time = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i.exec(latestUser)?.[0];
  const asksForOrigin = /\b(?:where|origin|start|starting point)\b/i.test(assistantText);
  const asksForTime = /\b(?:time|leave|departure)\b/i.test(assistantText);
  const hasDeparturePhrase =
    /\b(?:leave|leaving|depart|departing|head\s+out|drive\s+out|start\s+driving)\b[^.?!\n]{0,32}?\b(?:at|around|about)?\s*\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i.test(
      latestUser,
    );
  if (asksForTime && time && !hasDeparturePhrase) details.push(`Owner plans to leave at ${time}`);
  if (asksForOrigin && !airportOrigin(latestUser)) {
    const remainder = latestUser
      .replace(time ?? '', '')
      .replace(/\b(?:and|at|around|about)\b/gi, ' ')
      .replace(/^[,;:\s]+|[,;:\s]+$/g, '')
      .trim();
    if (remainder && !/^(?:unknown|not sure|no|i don't know|idk)$/i.test(remainder))
      details.push(`Owner origin: ${remainder}`);
  }
  return `${previousRequest}\nOwner's route details: ${details.join('; ')}`;
}

const CORRECTION =
  /^(?:look it up|search the web|check (?:the )?(?:score|wcore)|run it|rub it|try again|check again)\b/i;

/** A requested page is read directly; URLs mentioned only as context are not commands. */
function requestedPageUrl(request: string): string | undefined {
  const match =
    /(?:^|[.!?]\s+)(?:please\s+)?(?:read|open|fetch|summarize|review|check)\s+(?:the\s+)?(?:page\s+(?:at|on)\s+)?(https?:\/\/[^\s<>"']+)/i.exec(
      request,
    );
  const value = match?.[1]?.replace(/[.,;!?]+$/, '');
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Routing alone grants no authority: every lookup still uses the dispatcher. */
export function detectLiveLookup(
  history: ReadonlyArray<ReadIntentMessage>,
): LiveLookup | undefined {
  const users = history.filter((m) => m.role === 'user').map(readIntentText);
  const request = users.at(-1)?.trim() ?? '';
  if (!request || /^(?:don't|do not|never)\b/i.test(request)) return undefined;
  // Authenticated owner documents use the dedicated document reader; treating
  // their explicit URL as a public page would bypass that deterministic path.
  if (requestedDocumentReadIntent(request)) return undefined;
  if (/\b(?:password|passcode|wifi|wi-fi|API key)\b/i.test(request)) return undefined;
  const airportContinuation = airportClarificationContinuation(history);
  if (airportContinuation)
    return { kind: 'directions', request: airportContinuation, airportIntent: true };
  const asks = QUESTION.test(request) || request.includes('?') || SEARCH.test(request);
  if (EVENT_REMINDER.test(request) && isSportsRequest(request, asks))
    return {
      kind: 'sports',
      request,
      ...(reminderSportsTeam(request) ? { reminderTeam: reminderSportsTeam(request) } : {}),
      ...(leagueNamedIn(request) ? { reminderLeague: leagueNamedIn(request)?.key } : {}),
    };
  if (WEATHER.test(request) && asks) return { kind: 'weather', request };
  // Before the personal-read router, which reads "drive time" as Google
  // Drive. A trip to "my 3pm" reads the calendar as the first step of the trip
  // rather than as a lookup of its own, so the route is part of the answer.
  if (DIRECTIONS.test(request)) {
    const airportIntent =
      asksForGenericAirport(request) || (MY_EVENT.test(request) && /\bflight\b/i.test(request));
    return airportIntent
      ? { kind: 'directions', request, airportIntent: true }
      : MY_EVENT.test(request)
        ? { kind: 'directions', request, destination: 'calendar' }
        : { kind: 'directions', request };
  }
  if (requestedPageUrl(request)) return { kind: 'web', request };
  if (detectPersonalReadRequest(history)) return undefined;
  if (/\binvestigate\b[\s\S]*\b(?:team|club|company|match)\b/i.test(request))
    return { kind: 'web', request };
  // Before the generic web branch: "check the score" is a sports lookup, which
  // the scores tool answers directly instead of a search-then-fetch chain.
  if (isSportsRequest(request, asks)) return { kind: 'sports', request };
  // Verifying an artifact's privacy or readback belongs to its authenticated
  // tool flow. "Verify it" alone does not authorize searching the creation
  // request (and its potentially private contents) on the public web.
  if (requestedArtifactIntent(request) && !/\bsearch\s+(?:the\s+web|online)\b/i.test(request))
    return undefined;
  if (
    (asks || /^(?:please\s+)?(?:compare|find|recommend)\b/i.test(request)) &&
    TRANSIT_PRICING.test(request) &&
    PRICE_DECISION.test(request) &&
    !suppliedPricingExercise(request)
  )
    return { kind: 'web', request };
  if (SEARCH.test(request) || (asks && CURRENT.test(request) && PUBLIC_FACT.test(request))) {
    const previous = users.slice(-4, -1).findLast((text) => !CORRECTION.test(text));
    if (
      CORRECTION.test(request) &&
      previous &&
      detectPersonalReadRequest([{ role: 'user', content: previous }])
    )
      return undefined;
    if (CORRECTION.test(request) && previous)
      // "Check the wcore" retries the question before it, as that question.
      return { kind: isSportsRequest(previous, true) ? 'sports' : 'web', request: previous };
    return { kind: 'web', request };
  }
  // An address supplied in answer to a weather clarification continues that
  // lookup; a city/address alone is not a standalone weather request.
  const previous = history.slice(0, -1).at(-1);
  if (
    previous?.role === 'assistant' &&
    /\b(?:provide|what|which|where|location|address)\b/i.test(readIntentText(previous)) &&
    WEATHER.test(readIntentText(previous)) &&
    !QUESTION.test(request)
  )
    return {
      kind: 'weather',
      request: `${users.at(-2) ?? 'Check the weather'}\nLocation: ${request}`,
    };
  if (CORRECTION.test(request)) {
    const prior = detectLiveLookup(history.slice(0, -1));
    if (prior) return prior;
  }
  if (
    /\b(?:find|recommend|where should|where can)\b/i.test(request) &&
    /\b(?:eat|restaurant|dining|apply|companies|hiring|jobs)\b/i.test(request)
  )
    return { kind: 'web', request };
  return undefined;
}

/**
 * Where a compound question splits: sentence ends, and the words that join two
 * asks ("the Giants score and the drive time to Oracle Park"). A split that
 * cuts one ask in half ("Giants and Dodgers score") is harmless — only a
 * clause that is a complete lookup on its own counts.
 */
const CLAUSE_BREAK = /[.?!;\n]+\s*|,?\s+(?:and(?:\s+also)?|also|plus|then|as well as)\s+/gi;
/** More parts than this is a list to research, not a question to answer live. */
const MAX_LOOKUPS = 4;
const MAX_AIRPORT_CALENDAR_PAGES = 5;

/**
 * Every live lookup a request asks for, in the order it asks.
 *
 * "What's the Giants score and the drive time to Oracle Park?" needs the
 * scores tool *and* the maps tool; `detectLiveLookup` sees one request and
 * picks one. Each clause is judged as a standalone question, so it qualifies
 * only on the evidence a question of its own would need. Fewer than two
 * qualifying clauses leaves the single-lookup answer untouched.
 */
export function detectLiveLookups(history: ReadonlyArray<ReadIntentMessage>): LiveLookup[] {
  const single = detectLiveLookup(history);
  const fallback = single ? [single] : [];
  const message = history.findLast((m) => m.role === 'user');
  const request = message ? readIntentText(message).trim() : '';
  if (!request || /^(?:don't|do not|never)\b/i.test(request)) return fallback;
  if (/\b(?:password|passcode|wifi|wi-fi|API key)\b/i.test(request)) return fallback;
  const clauses = request
    .split(CLAUSE_BREAK)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length < 2) return fallback;
  // "What's the score and the weather in Reykjavik" asks both halves, though
  // only the first carries the question word.
  const asks = QUESTION.test(request) || request.includes('?');
  const found: LiveLookup[] = [];
  for (const clause of clauses) {
    // "Look it up" means the question before it; alone it names nothing.
    if (CORRECTION.test(clause)) continue;
    const content = asks && !clause.endsWith('?') ? `${clause}?` : clause;
    // Judged alone, not against the thread: "I work at 181 Fremont Street"
    // after a question about the weather reads as the answer to an earlier
    // "which address?", which is right for a whole message and wrong for the
    // second sentence of one. The whole-message reading above keeps that.
    const lookup = detectLiveLookup([{ role: 'user', content }]);
    if (!lookup) continue;
    if (found.some((prior) => prior.kind === lookup.kind && prior.request === lookup.request))
      continue;
    found.push(lookup);
  }
  if (found.length >= 2 && found.length <= MAX_LOOKUPS) return found;
  // "What's on my calendar tomorrow and the Giants score?" reads as a private
  // read as a whole, which hides its one public half. That half still needs
  // its lookup; the private read runs beside it.
  if (!single && found.length === 1 && detectPersonalReadRequest(history)) return found;
  return fallback;
}

export function successfulLookup(row: ActionEvidence): boolean {
  const result = row.result as Record<string, unknown> | null;
  return (
    row.fromCurrentTask !== false &&
    row.status === 'succeeded' &&
    Boolean(result) &&
    Object.keys(result ?? {}).length > 0 &&
    !result?.error &&
    (row.toolName !== 'web.fetch' ||
      (typeof result?.text === 'string' && result.text.trim().length > 0)) &&
    result?.ok !== false &&
    !(typeof result?.status === 'number' && result.status >= 400)
  );
}

/** A scores lookup that produced games, or the candidates to ask the owner about. */
function sportsAnswered(row: ActionEvidence): boolean {
  if (!successfulLookup(row)) return false;
  const result = row.result as { games?: unknown[]; candidates?: unknown[] };
  return (result.games?.length ?? 0) > 0 || (result.candidates?.length ?? 0) > 0;
}

type TripEvent = { summary: string; start: string; location: string; end?: string };

function calendarEvents(rows: ActionEvidence[]): TripEvent[] {
  return rows
    .filter((row) => row.toolName === 'calendar.list_events' && successfulLookup(row))
    .flatMap((row) => {
      const events = (row.result as { events?: unknown[] }).events;
      return Array.isArray(events) ? events : [];
    })
    .flatMap((value) => {
      const event = value as Record<string, unknown> | null;
      const start = typeof event?.start === 'string' ? event.start : '';
      // An all-day entry has no time to arrive by.
      if (!start.includes('T')) return [];
      return [
        {
          summary: typeof event?.summary === 'string' ? event.summary.trim() : '',
          start,
          location: typeof event?.location === 'string' ? event.location.trim() : '',
          ...(typeof event?.end === 'string' ? { end: event.end } : {}),
        },
      ];
    });
}

function localClock(iso: string, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(new Date(iso));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return { hour: read('hour') % 24, minute: read('minute') };
}

function describeEvent(event: TripEvent, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(event.start));
  return `${event.summary ? `"${event.summary}"` : 'The event'} at ${time}`;
}

const DEFAULT_CONTEXT: LookupContext = { now: new Date(0), timeZone: 'UTC' };

/**
 * Which calendar event "my 3pm" or "my dentist appointment" means.
 *
 * A named time must match the event's local start; named words ("dentist")
 * must appear in its title; a specific kind ("my flight") must too. Only a
 * generic "my next meeting" falls through to the next event. A match with no
 * location is reported, not skipped: routing to the event after it would
 * answer a question the owner did not ask.
 */
function hasMalformedIsoDate(text: string): boolean {
  const match = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  return (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() + 1 !== month ||
    normalized.getUTCDate() !== day
  );
}

function tripWindow(lookup: LiveLookup, context: LookupContext): TemporalIntentResolution {
  return resolveTemporalIntent(lookup.request, 'calendar', false, context, 'trip');
}

type AirportCalendarCoverage = {
  complete: boolean;
  pages: ActionEvidence[];
  nextPageToken?: string;
};

function airportCalendarRows(
  lookup: LiveLookup,
  rows: ActionEvidence[],
  context: LookupContext,
): ActionEvidence[] {
  const temporal = tripWindow(lookup, context);
  if (temporal.kind !== 'resolved') return [];
  const { start, endExclusive } = temporal.intent.interval;
  return rows.filter((row) => {
    if (row.toolName !== 'calendar.list_events' || row.fromCurrentTask === false) return false;
    const args = row.args as Record<string, unknown> | null;
    return (
      args?.timeMin === start &&
      args?.timeMax === endExclusive &&
      (args?.calendarIds === undefined ||
        (Array.isArray(args.calendarIds) && args.calendarIds.length === 0))
    );
  });
}

function airportCalendarCoverage(
  lookup: LiveLookup,
  rows: ActionEvidence[],
  context: LookupContext,
): AirportCalendarCoverage {
  const matching = airportCalendarRows(lookup, rows, context);
  const tokenOf = (row: ActionEvidence) => {
    const value = (row.args as Record<string, unknown> | null)?.pageToken;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  let expectedToken: string | undefined;
  const visited = new Set<string>();
  const pages: ActionEvidence[] = [];
  for (let index = 0; index < MAX_AIRPORT_CALENDAR_PAGES; index += 1) {
    const attempts = matching.filter((row) => tokenOf(row) === expectedToken);
    const page = attempts.find(successfulLookup);
    if (!page)
      return {
        complete: false,
        pages,
        ...(attempts.length < 2 ? { nextPageToken: expectedToken ?? '' } : {}),
      };
    const result = page.result as Record<string, unknown> | null;
    if (!Array.isArray(result?.events)) return { complete: false, pages };
    pages.push(page);
    const unavailable = result.unavailable;
    const pageCoverageOkay =
      result.calendarRosterComplete === true &&
      result.paginationUnavailable !== true &&
      (!Array.isArray(unavailable) || unavailable.length === 0);
    if (!pageCoverageOkay) return { complete: false, pages };
    const token = result.nextPageToken;
    if (typeof token === 'string' && token.length > 0) {
      if (visited.has(token) || token === expectedToken) return { complete: false, pages };
      visited.add(token);
      expectedToken = token;
      if (index + 1 >= MAX_AIRPORT_CALENDAR_PAGES) return { complete: false, pages };
      continue;
    }
    const complete = result.complete === true && pageCoverageOkay;
    return { complete, pages };
  }
  return { complete: false, pages };
}

function airportOrigin(request: string): string | undefined {
  const match =
    /\b(?:from|starting\s+(?:at|from)|origin\s*(?:is|:)|(?:i\s+am|i'm|we\s+are|we're|currently)\s+at)\s+([^.;?!\n]+?)(?=\s+\b(?:leave|leaving|depart|departing|head\s+out|at|around|about)\b|[.;?!\n]|$)/i.exec(
      request,
    );
  const value = match?.[1]
    ?.trim()
    .replace(/[,;]+$/, '')
    .replace(/\s+/g, ' ');
  if (!value || isUnresolvedAirportOrigin(value)) return undefined;
  return value;
}

/** Deictic origins need a verified address before they can be sent to Maps. */
function isUnresolvedAirportOrigin(value: string): boolean {
  const normalized = value
    .toLocaleLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:my|our|the)\s+/, '');
  return (
    /^(?:here|there|me|current location|where i am)$/i.test(normalized) ||
    /^(?:home|house|place|apartment|flat|condo|residence|hotel|work|office|workplace)(?: address)?(?:\s+(?:in|at|near)\s+.+)?$/i.test(
      normalized,
    )
  );
}

function airportDepartureInstant(request: string, context: LookupContext): string | undefined {
  const match =
    /\b(?:leave|leaving|depart|departing|head\s+out|drive\s+out|start\s+driving)\b[^.?!\n]{0,32}?\b(?:at|around|about)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i.exec(
      request,
    );
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const isPm = /^p/i.test(match[3] ?? '');
  if (hour < 1 || hour > 12 || minute > 59) return undefined;
  const temporal = tripWindow({ kind: 'directions', request }, context);
  if (temporal.kind !== 'resolved') return undefined;
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: context.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(temporal.intent.interval.start));
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return undefined;
  const local = { year, month, date, hour: (hour % 12) + (isPm ? 12 : 0), minute };
  const target = Date.UTC(local.year, local.month - 1, local.date, local.hour, local.minute);
  const partsAt = (value: number) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: context.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(value));
    const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return {
      year: read('year'),
      month: read('month'),
      date: read('day'),
      hour: read('hour'),
      minute: read('minute'),
    };
  };
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = partsAt(instant);
    instant +=
      target -
      Date.UTC(observed.year, observed.month - 1, observed.date, observed.hour, observed.minute);
  }
  const localKey = (value: number) => {
    const parts = partsAt(value);
    return `${parts.year}-${parts.month}-${parts.date} ${parts.hour}:${parts.minute}`;
  };
  const expected = `${year}-${month}-${date} ${local.hour}:${local.minute}`;
  if (localKey(instant) !== expected) return undefined;
  // A repeated wall-clock time during a fall-back transition is ambiguous.
  for (let offset = -180; offset <= 180; offset += 15) {
    if (offset !== 0 && localKey(instant + offset * 60_000) === expected) return undefined;
  }
  return new Date(instant).toISOString();
}

export function tripEvent(
  lookup: LiveLookup,
  evidence: ActionEvidence[],
  context: LookupContext = DEFAULT_CONTEXT,
): { event: TripEvent; problem?: undefined } | { event?: undefined; problem: string } {
  const temporal = tripWindow(lookup, context);
  if (temporal.kind === 'unsupported') return { problem: temporal.message };
  if (temporal.kind !== 'resolved')
    return {
      problem:
        'The requested calendar date is not valid, so I have not looked up or routed to an event.',
    };
  const window = temporal.intent;
  const calendarRows = evidence.filter(
    (row) => row.toolName === 'calendar.list_events' && row.fromCurrentTask !== false,
  );
  if (
    calendarRows.some((row) => {
      const result = row.result as { complete?: unknown } | null;
      return result?.complete === false;
    })
  )
    return {
      problem:
        'Calendar coverage is incomplete, so I cannot choose a unique destination or route yet.',
    };
  const now = Math.max(Date.parse(window.anchor.instant), Date.parse(window.interval.start));
  const end = Date.parse(window.interval.endExclusive);
  const events = calendarEvents(evidence.filter((row) => row.fromCurrentTask !== false));
  const upcoming = events
    .filter((event) => {
      const start = Date.parse(event.start);
      return Number.isFinite(start) && start >= now && start < end;
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const reference = MY_EVENT.exec(lookup.request)?.[0] ?? '';
  const clock = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(
    reference.replace(/^my\s+(?:next\s+)?/i, ''),
  );
  const matchesReference = (candidates: TripEvent[]) => {
    if (clock && (clock[3] || clock[2])) {
      const meridiem = clock[3]?.toLowerCase();
      const hour24 = meridiem
        ? (Number(clock[1]) % 12) + (meridiem === 'pm' ? 12 : 0)
        : Number(clock[1]);
      const minute = Number(clock[2] ?? 0);
      return candidates.filter((event) => {
        const local = localClock(event.start, context.timeZone);
        return local.hour === hour24 && local.minute === minute;
      });
    }
    const words = reference
      .replace(/^my\s+(?:next\s+)?/i, '')
      .split(/\s+/)
      .filter(Boolean);
    const noun = words.at(-1) ?? '';
    const named = [...words.slice(0, -1), ...(SPECIFIC_EVENT.test(noun) ? [noun] : [])];
    if (named.length === 0) return candidates;
    return candidates.filter((event) =>
      named.every((word) => {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(event.summary);
      }),
    );
  };
  const matches = matchesReference(upcoming);
  const explicitNextEvent =
    /^my\s+next\b/i.test(reference) ||
    /\b(?:next|nearest|soonest)\s+(?:calendar\s+)?(?:event|meeting|appointment|call)\b/i.test(
      lookup.request,
    );
  const windowStart = Date.parse(window.interval.start);
  const currentTime = context.now.getTime();
  if (!explicitNextEvent && Number.isFinite(windowStart) && windowStart <= currentTime) {
    const underway = matchesReference(
      events.filter((event) => {
        const start = Date.parse(event.start);
        const eventEnd = Date.parse(event.end ?? '');
        return (
          Number.isFinite(start) &&
          Number.isFinite(eventEnd) &&
          start < currentTime &&
          currentTime < eventEnd
        );
      }),
    );
    const underwayEvent = underway[0];
    if (underwayEvent)
      return {
        problem: `${describeEvent(underwayEvent, context.timeZone)} is already underway, so I haven't worked out a route. If you meant a later event, tell me which one.`,
      };
  }
  if (matches.length > 1 && !explicitNextEvent)
    return {
      problem: `I found more than one matching event for ${reference.replace(/^my\b/i, 'your') || 'that request'}; please choose which one before I route you.`,
    };
  const event = matches[0];
  if (!event)
    return {
      problem: `I couldn't find ${reference.replace(/^my\b/i, 'your') || 'that event'} on your calendar in ${window.window.label}, so I haven't worked out a route.`,
    };
  if (!event.location)
    return {
      problem: `${describeEvent(event, context.timeZone)} has no location on your calendar, so I can't route to it. Add the address to the event, or tell me where it is.`,
    };
  return { event };
}

function nextTripStep(
  lookup: LiveLookup,
  rows: ActionEvidence[],
  context: LookupContext = DEFAULT_CONTEXT,
): { toolName: string; input?: Record<string, unknown> } | undefined {
  const temporal = tripWindow(lookup, context);
  if (temporal.kind !== 'resolved') return undefined;
  const window = temporal.intent;
  if (!rows.some((row) => row.toolName === 'calendar.list_events'))
    return {
      toolName: 'calendar.list_events',
      input: {
        timeMin: window.interval.start,
        timeMax: window.interval.endExclusive,
        maxResults: 50,
      },
    };
  if (rows.some((row) => row.toolName === 'maps.directions')) return undefined;
  const { event } = tripEvent(lookup, rows, context);
  if (!event) return undefined;
  return {
    toolName: 'maps.directions',
    input: { destination: event.location, arriveBy: new Date(event.start).toISOString() },
  };
}

function nextAirportStep(
  lookup: LiveLookup,
  rows: ActionEvidence[],
  context: LookupContext,
): { toolName: string; input?: Record<string, unknown> } | undefined {
  const temporal = tripWindow(lookup, context);
  if (temporal.kind !== 'resolved') return undefined;
  const coverage = airportCalendarCoverage(lookup, rows, context);
  if (coverage.nextPageToken !== undefined)
    return {
      toolName: 'calendar.list_events',
      input: {
        timeMin: temporal.intent.interval.start,
        timeMax: temporal.intent.interval.endExclusive,
        maxResults: 50,
        ...(coverage.nextPageToken ? { pageToken: coverage.nextPageToken } : {}),
      },
    };
  if (!coverage.complete) return undefined;
  const input = airportRouteInput(lookup, coverage, context);
  if (!input || rows.some((row) => matchingAirportRoute(row, input))) return undefined;
  return { toolName: 'maps.directions', input };
}

function airportRouteInput(
  lookup: LiveLookup,
  coverage: AirportCalendarCoverage,
  context: LookupContext,
): Record<string, unknown> | undefined {
  if (!coverage.complete) return undefined;
  const candidates = airportItineraryEvents(lookup, coverage.pages, context);
  const origin = airportOrigin(lookup.request);
  const departAt = airportDepartureInstant(lookup.request, context);
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  return candidate && origin && departAt
    ? { origin, destination: candidate.location, departAt }
    : undefined;
}

function matchingAirportRoute(row: ActionEvidence, input: Record<string, unknown>): boolean {
  const args = row.args as Record<string, unknown> | null;
  return (
    row.fromCurrentTask !== false &&
    row.toolName === 'maps.directions' &&
    args?.origin === input.origin &&
    args?.destination === input.destination &&
    args?.departAt === input.departAt &&
    args?.arriveBy === undefined &&
    (args?.mode === undefined || args.mode === 'driving')
  );
}

function airportItineraryEvents(
  lookup: LiveLookup,
  rows: ActionEvidence[],
  context: LookupContext,
): TripEvent[] {
  const temporal = tripWindow(lookup, context);
  if (temporal.kind !== 'resolved') return [];
  const start = Date.parse(temporal.intent.interval.start);
  const end = Date.parse(temporal.intent.interval.endExclusive);
  return calendarEvents(rows)
    .filter((event) => {
      const eventStart = Date.parse(event.start);
      // A flight title only identifies a likely itinerary record. The airport
      // candidate must come from the event's explicit location field.
      if (!FLIGHT_EVENT.test(event.summary) || !/\b(?:airport|airfield)\b/i.test(event.location))
        return false;
      const airportMentions = event.location.match(/\b(?:airport|airfield)\b/gi) ?? [];
      const placeName = event.location
        .replace(/\b(?:airport|airfield)\b/gi, '')
        .replace(/\([^)]+\)/g, '')
        .trim();
      // One explicit, named airport only. A terminal or a joined list of
      // airport names is not enough to choose the route destination.
      if (
        airportMentions.length !== 1 ||
        !/[\p{L}\d]{2}/u.test(placeName) ||
        /[;&/→]|\s[-–—]\s|\b(?:from|to|via|and|or)\b/i.test(event.location)
      )
        return false;
      return Number.isFinite(eventStart) && eventStart >= start && eventStart < end;
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** Search snippets are discovery, not a complete live-score or research read. */
export function nextLiveLookup(
  lookup: LiveLookup,
  evidence: ActionEvidence[],
  context?: LookupContext,
): { toolName: string; input?: Record<string, unknown> } | undefined {
  const rows = evidence.filter((row) => row.fromCurrentTask !== false);
  if (lookup.airportIntent) return nextAirportStep(lookup, rows, context ?? DEFAULT_CONTEXT);
  if (lookup.destination === 'calendar') return nextTripStep(lookup, rows, context);
  if (lookup.kind === 'weather') {
    if (!rows.some((row) => row.toolName === 'weather.lookup'))
      return { toolName: 'weather.lookup' };
    return undefined;
  }
  if (lookup.kind === 'directions') {
    if (!rows.some((row) => row.toolName === 'maps.directions'))
      return { toolName: 'maps.directions' };
    return undefined;
  }
  if (lookup.kind === 'sports') {
    const scores = rows.filter((row) => row.toolName === 'sports.scores');
    if (!scores.length) {
      // A partial deterministic input bypasses model argument generation.
      // A date alone loses the team named in an ordinary score question, so
      // only force arguments when we also have a team or league identity.
      const league = lookup.reminderLeague ?? leagueNamedIn(lookup.request)?.key;
      const team = lookup.reminderTeam ?? requestedSportsTeam(lookup.request);
      if (!team && !league) return { toolName: 'sports.scores' };
      const dateWindow = context
        ? resolveTimeWindow(lookup.request, 'calendar', false, context)
        : undefined;
      const date = dateWindow
        ? new Intl.DateTimeFormat('en-CA', {
            timeZone: context?.timeZone ?? 'UTC',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(new Date(dateWindow.timeMin))
        : undefined;
      return {
        toolName: 'sports.scores',
        ...(team || league
          ? {
              input: {
                ...(team ? { team } : {}),
                ...(league ? { league } : {}),
                ...(date ? { date } : {}),
              },
            }
          : {}),
      };
    }
    if (scores.some(sportsAnswered)) return undefined;
    // An uncovered team or league, or a provider outage: search the web.
    return nextLiveLookup({ kind: 'web', request: lookup.request }, evidence);
  }
  const requestedUrl = requestedPageUrl(lookup.request);
  if (requestedUrl) {
    return rows.some((row) => row.toolName === 'web.fetch')
      ? undefined
      : { toolName: 'web.fetch', input: { url: requestedUrl } };
  }
  const searches = rows.filter((row) => row.toolName === 'web.search');
  if (!searches.length && !rows.some((row) => row.toolName === 'web.fetch'))
    // Longer research requests need a focused model-generated query. Forcing
    // an over-limit input repeats the same validation rejection every step.
    return {
      toolName: 'web.search',
      ...(lookup.request.length <= 256 ? { input: { query: lookup.request, count: 5 } } : {}),
    };
  if (rows.some((row) => row.toolName === 'web.fetch')) return undefined;
  for (const row of searches.filter(successfulLookup)) {
    const results = (row.result as { results?: Array<{ url?: string }> }).results;
    const url = results?.find((item) => /^https?:\/\//i.test(item.url ?? ''))?.url;
    if (url) return { toolName: 'web.fetch', input: { url } };
  }
  return undefined;
}

/**
 * Each lookup's share of the ledger, for a request with several.
 *
 * The runtime answers the lookups one after another, so the k-th call to a
 * tool belongs to the k-th lookup that needs it: the first `weather.lookup`
 * row to the first weather question, the second to the second. A sports
 * lookup whose scores call came back empty also takes the next search and
 * read, because that is the fallback `nextLiveLookup` sends it down.
 */
export function attributeLookupEvidence(
  lookups: readonly LiveLookup[],
  evidence: ActionEvidence[],
  context: LookupContext = DEFAULT_CONTEXT,
): ActionEvidence[][] {
  const queues = new Map<string, ActionEvidence[]>();
  for (const row of evidence) {
    if (row.fromCurrentTask === false) continue;
    queues.set(row.toolName, [...(queues.get(row.toolName) ?? []), row]);
  }
  const take = (toolName: string): ActionEvidence[] => {
    const row = queues.get(toolName)?.shift();
    return row ? [row] : [];
  };
  const webChain = () => [...take('web.search'), ...take('web.fetch')];
  return lookups.map((lookup) => {
    if (lookup.kind === 'weather') return take('weather.lookup');
    if (lookup.airportIntent) {
      const calendar = airportCalendarRows(lookup, evidence, context);
      const input = airportRouteInput(
        lookup,
        airportCalendarCoverage(lookup, calendar, context),
        context,
      );
      const routes = input
        ? (queues.get('maps.directions') ?? []).filter((row) => matchingAirportRoute(row, input))
        : [];
      if (routes.length)
        queues.set(
          'maps.directions',
          (queues.get('maps.directions') ?? []).filter((row) => !routes.includes(row)),
        );
      return [...calendar, ...routes];
    }

    if (lookup.kind === 'directions')
      return lookup.destination === 'calendar'
        ? [...take('calendar.list_events'), ...take('maps.directions')]
        : take('maps.directions');
    if (lookup.kind === 'web') return webChain();
    const scores = take('sports.scores');
    return scores.length === 0 || scores.some(sportsAnswered) ? scores : [...scores, ...webChain()];
  });
}

/** The next call the runtime owes the owner, and which part of the request it answers. */
export function nextLiveLookups(
  lookups: readonly LiveLookup[],
  evidence: ActionEvidence[],
  context?: LookupContext,
): { toolName: string; input?: Record<string, unknown>; lookup: LiveLookup } | undefined {
  const [first] = lookups;
  if (lookups.length === 1 && first) {
    const next = nextLiveLookup(first, evidence, context);
    return next && { ...next, lookup: first };
  }
  const shares = attributeLookupEvidence(lookups, evidence, context);
  for (const [index, lookup] of lookups.entries()) {
    const next = nextLiveLookup(lookup, shares[index] ?? [], context);
    if (next) return { ...next, lookup };
  }
  return undefined;
}

/** The parts of the request whose lookup came back with nothing usable. */
export function liveLookupFailures(
  lookups: readonly LiveLookup[],
  evidence: ActionEvidence[],
  context?: LookupContext,
): Array<{ lookup: LiveLookup; failure: string }> {
  const shares =
    lookups.length === 1 ? [evidence] : attributeLookupEvidence(lookups, evidence, context);
  return lookups.flatMap((lookup, index) => {
    const failure = liveLookupFailure(lookup, shares[index] ?? [], context);
    return failure ? [{ lookup, failure }] : [];
  });
}

/**
 * What the model is told about the lookups this turn owes. A single lookup
 * keeps the wording it has always had; a compound request also names every
 * part, the one being fetched now, and any part whose lookup already failed —
 * so the answer covers the parts that worked and says which did not.
 */
export function liveLookupDirective(
  lookups: readonly LiveLookup[],
  context: {
    next?: LiveLookup;
    failures?: ReadonlyArray<{ lookup: LiveLookup; failure: string }>;
    requestAt: Date;
    timeZone: string;
  },
): string {
  const [first] = lookups;
  if (!first) return '';
  const fareRules = lookups.some(
    (lookup) =>
      lookup.kind === 'web' &&
      TRANSIT_PRICING.test(lookup.request) &&
      PRICE_DECISION.test(lookup.request),
  )
    ? " For fares or passes, verify prices, validity, transfers and exclusions against the transport operator's official pages; distinguish sourced prices from your arithmetic and state assumptions that change the cheapest option."
    : '';
  const rules = `Use a successful lookup from this task. Earlier assistant answers and recalled conversations are not current evidence. If a provider fails, report the gap; never invent measurements, scores, office holders, opening hours, player traits, or verified job openings. Search snippets locate sources; read the source before concluding.${fareRules} Resolve relative dates using the owner's request time ${context.requestAt.toISOString()} and timezone ${context.timeZone}.`;
  const eventReminder = lookups.some((lookup) => lookup.kind === 'sports' && lookup.reminderTeam)
    ? '\nThis game is the dependency of a requested event-completion reminder. Use the exact event ID, league, start time and team IDs returned by this task. If the lookup has multiple or no matching games, ask which occurrence the owner means. The reminder will poll the exact fixture and fire only when the provider reports it finished; never substitute the scheduled start/end time.'
    : '';
  const trip = lookups.some((lookup) => lookup.destination === 'calendar')
    ? "\nThe trip destination is an event on the owner's calendar. The runtime read the calendar, chose that event, and routed to its own location arriving by its start. Name the event, the travel time, and when to leave; never route to or suggest a different event."
    : '';
  const airportTrip = lookups.some((lookup) => lookup.airportIntent)
    ? '\nThis request concerns a trip to an airport. Check the requested calendar window before choosing one. A flight title or its scheduled start does not establish the airport to travel to or an airport-arrival deadline. Use an airport only when one matching flight event has a single explicit airport in its location. Do not route with an assumed airport, origin, or time; ask only for any details still missing.'
    : '';
  const failed = (context.failures ?? []).map(
    ({ lookup }) =>
      `The ${lookup.kind} lookup for "${lookup.request}" failed. Say so for that part instead of answering it, and answer the other parts.`,
  );
  if (lookups.length === 1)
    return [
      `This request needs fresh ${first.kind} evidence: ${first.request}\n${rules}${trip}${airportTrip}${eventReminder}`,
      // Only a turn that also reads the calendar or mail gets this far with a
      // failed lookup; alone, the failure is the whole answer.
      ...failed,
    ].join('\n');
  const parts = lookups.map((lookup, index) => `${index + 1}. ${lookup.kind}: ${lookup.request}`);
  const now = context.next ? [`Look up this part now: ${context.next.request}`] : [];
  const lines = [
    `This request has ${lookups.length} parts that each need fresh evidence. Answer every part, in the order asked:`,
    ...parts,
    ...now,
    ...failed,
    rules,
  ];
  return `${lines.join('\n')}${trip}${airportTrip}${eventReminder}`;
}

/**
 * The text a live lookup actually retrieved, as one searchable corpus.
 *
 * Search *snippets* are deliberately included alongside fetched bodies: the
 * Giants case turned on a snippet figure ("7-3") that was a batted-ball stat
 * rather than the score, and a check that treated the snippet as unseen would
 * have called the right answer ungrounded.
 */
function retrievedCorpus(evidence: ActionEvidence[]): string {
  return evidence
    .filter(successfulLookup)
    .map((row) => {
      const result = row.result as Record<string, unknown> | null;
      const parts = [result?.text, result?.snippet, result?.summary, result?.title];
      const results = (result?.results as Array<Record<string, unknown>> | undefined) ?? [];
      for (const item of results) parts.push(item.snippet, item.title, item.description);
      // Weather adapters return numbers, not prose; stringify so a temperature
      // reading is searchable in the same corpus as fetched text.
      if (row.toolName === 'weather.lookup') parts.push(JSON.stringify(result));
      // Each game's `line` states its scoreline next to both team names.
      if (row.toolName === 'sports.scores')
        for (const game of (result?.games as Array<{ line?: unknown }> | undefined) ?? [])
          parts.push(game.line);
      return parts.filter((part) => typeof part === 'string').join('\n');
    })
    .join('\n');
}

/**
 * Everything this turn's live lookups returned, for the calendar-answer
 * contract to license the non-calendar half of a mixed answer: the retrieved
 * text plus the structured route and game rows, whose venue names, route
 * names and departure times are what that half legitimately says. Kept apart
 * from `retrievedCorpus` so the scoreline check stays exactly as strict.
 */
export function liveLookupCorpus(evidence: ActionEvidence[]): string {
  const rows = evidence.filter((row) => row.fromCurrentTask !== false);
  const structured = rows
    .filter(
      (row) =>
        (row.toolName === 'maps.directions' || row.toolName === 'sports.scores') &&
        successfulLookup(row),
    )
    .map((row) => JSON.stringify(row.result));
  return [retrievedCorpus(rows), ...structured].filter(Boolean).join('\n');
}

/** Digits only, so "5 - 4", "5–4" and "5-4" all compare equal. */
const digitsOf = (value: string): string => value.replace(/\D/g, '');

/**
 * A scoreline (`5-4`, `5–4`) or a temperature (`72°F`, `-3C`) in the draft.
 *
 * Narrow on purpose. A general "every number must appear in the source" rule
 * would fire on every figure the model legitimately derives — a count of list
 * items, "10-15 minutes", a date it computed from "tomorrow" — and a false
 * positive here replaces a correct answer with a refusal. These two shapes are
 * the ones the September audit actually got wrong, they are never arithmetic
 * the assistant should be doing itself, and they are exactly the claims an
 * owner cannot check without re-doing the lookup.
 */
const SCORE_FIGURE = /\b(\d{1,3})\s*[-–—]\s*(\d{1,3})\b/g;
const TEMPERATURE_FIGURE = /(-?\d{1,3})\s*°\s*[CF]?\b|\b(-?\d{1,3})\s*degrees\b/gi;
/** A request whose answer is a scoreline, so the score rule is worth running. */
const SCORE_REQUEST = /\b(?:score|final|beat|won|lost|standings)\b/i;
/** Dates and version-like runs are not scorelines. */
const DATE_LIKE = /\d{4}\s*[-–—]\s*\d{1,2}|\d{1,2}\s*[-–—]\s*\d{1,2}\s*[-–—]\s*\d{2,4}/;
/**
 * A unit right after the figure makes it a quantity, not a result: "10-15
 * minutes" is the assistant estimating, which it is entitled to do and which no
 * retrieved source would ever contain. Without this the rule refuses correct
 * answers, which is worse than the defect it exists to catch.
 */
const RANGE_UNIT =
  /^\s*(?:°|(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|seconds?|secs?|people|items?|percent|%|dollars?|euros?|miles?|kms?|km|degrees?)\b)/i;

/**
 * A figure the answer asserts that the retrieved sources never contained.
 *
 * `liveLookupFailure` below proves a lookup *happened*; nothing proved the
 * answer matched it, which is how a stale training-data score reached the owner
 * over a successful fetch that said otherwise. This closes that specific gap
 * the way `groundReadDraft` closes it for calendar reads: compare the claim
 * against the literal evidence, and refuse rather than guess.
 */
export function ungroundedLiveFigure(
  lookup: LiveLookup,
  text: string,
  evidence: ActionEvidence[],
): string | undefined {
  const rows = evidence.filter((row) => row.fromCurrentTask !== false);
  const corpus = retrievedCorpus(rows);
  if (!corpus.trim()) return undefined;
  const corpusDigits = corpus.replace(/[^\d]+/g, ' ');

  if (lookup.kind === 'weather') {
    for (const match of text.matchAll(TEMPERATURE_FIGURE)) {
      const reading = match[1] ?? match[2];
      if (!reading) continue;
      if (!new RegExp(`(?:^|\\s)-?${digitsOf(reading)}(?:\\s|$)`).test(corpusDigits))
        return `The retrieved weather data does not contain ${reading}°, so I have not reported a temperature I cannot show you. The lookup needs to be retried.`;
    }
    return undefined;
  }

  if (!SCORE_REQUEST.test(lookup.request)) return undefined;
  for (const match of text.matchAll(SCORE_FIGURE)) {
    const [whole, left, right] = match;
    if (!left || !right || DATE_LIKE.test(whole)) continue;
    // The match may be the tail of a longer run the pattern cannot see from
    // the inside: `2026-09-07` offers up `09-07`, which is a date, not a
    // result. Judge by what sits either side of it.
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + whole.length);
    if (/[\d\-–—]\s*$/.test(before) || /^\s*[-–—]\s*\d/.test(after)) continue;
    if (RANGE_UNIT.test(after)) continue;
    // Accept either order: sources state a result home-first as often as not.
    const stated = new RegExp(`${left}\\s+${right}|${right}\\s+${left}`);
    if (!stated.test(corpusDigits))
      return `The sources I retrieved do not state ${left}-${right}, so I have not reported a result they do not support. The lookup needs to be retried.`;
  }
  return undefined;
}

export function liveLookupFailure(
  lookup: LiveLookup,
  evidence: ActionEvidence[],
  context?: LookupContext,
): string | undefined {
  if (lookup.airportIntent) {
    const rows = evidence.filter((row) => row.fromCurrentTask !== false);
    const lookupContext = context ?? DEFAULT_CONTEXT;
    const temporal = tripWindow(lookup, lookupContext);
    if (temporal.kind === 'unsupported') return temporal.message;
    if (temporal.kind !== 'resolved' || hasMalformedIsoDate(lookup.request))
      return 'The requested airport travel date is not valid, so I have not chosen an airport or estimated a route.';
    const coverage = airportCalendarCoverage(lookup, rows, lookupContext);
    if (coverage.pages.length === 0)
      return "I couldn't read the requested calendar window, so I haven't verified an airport or estimated the route.";
    if (!coverage.complete)
      return "Calendar coverage is incomplete, so I haven't verified an airport or estimated the route.";
    const input = airportRouteInput(lookup, coverage, lookupContext);
    const attempts = input ? rows.filter((row) => matchingAirportRoute(row, input)) : [];
    if (attempts.length)
      return attempts.some(successfulLookup)
        ? undefined
        : "I couldn't get a route from Apple Maps using the confirmed airport, origin, and departure time, so I haven't estimated travel time.";
    // A full read with missing or ambiguous route details is an ordinary
    // clarification, not a failed provider lookup. The model is instructed to
    // ask only for the fields that are still absent.
    return undefined;
  }
  if (lookup.destination === 'calendar') {
    const temporal = context ? tripWindow(lookup, context) : undefined;
    if (temporal?.kind === 'unsupported') return temporal.message;
    if (temporal?.kind === 'unresolved' || hasMalformedIsoDate(lookup.request))
      return 'The requested calendar date is not valid, so I have not looked up or routed to an event.';
    const rows = evidence.filter((row) => row.fromCurrentTask !== false);
    if (rows.some((row) => row.toolName === 'maps.directions' && successfulLookup(row)))
      return undefined;
    if (!rows.some((row) => row.toolName === 'calendar.list_events' && successfulLookup(row)))
      return "I couldn't read your calendar, so I can't tell where that event is or how long it takes to get there. The lookup needs to be retried.";
    const chosen = tripEvent(lookup, rows, context);
    if (chosen.problem) return chosen.problem;
  }
  if (
    lookup.kind === 'sports' &&
    evidence.some((row) => row.fromCurrentTask !== false && sportsAnswered(row))
  )
    return undefined;
  if (lookup.kind === 'directions') {
    const routed = evidence.some(
      (row) =>
        row.fromCurrentTask !== false &&
        row.toolName === 'maps.directions' &&
        successfulLookup(row),
    );
    return routed
      ? undefined
      : "I couldn't get a route from Apple Maps for this trip, so I haven't estimated a travel time. The lookup needs to be retried.";
  }
  const names = lookup.kind === 'weather' ? ['weather.lookup'] : ['web.fetch'];
  const rows = evidence.filter(
    (row) => names.includes(row.toolName) && row.fromCurrentTask !== false,
  );
  if (rows.some(successfulLookup)) return undefined;
  return lookup.kind === 'weather'
    ? "I couldn't retrieve current weather data for this request, so I can't confirm temperatures or a forecast. Earlier weather replies are not a current reading."
    : "I couldn't retrieve live sources for this request, so I haven't verified the answer. The lookup needs to be retried.";
}
