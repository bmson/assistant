import { gmailSearchReceiptSourceId } from '@assistant/persistence/gmail-search-identity';
import type { CompoundTripExtraction, CompoundTripHotelFact } from './compound-trip-extraction.js';
import type { PersonalReadRequest, ReadToolEvidence } from './read-intent.js';

const MAX_COMPOUND_CALENDAR_COVERAGE_PAGES = 2;
export const MAX_COMPOUND_TRIP_TOOL_CALLS = 12;

export interface CompoundTripFlightSegment {
  threadId: string;
  messageId: string;
  subject: string;
  bookingReference?: string;
  flightNumber: string;
  departureDate: string;
  departureTime: string;
  departureTimeZone?: string;
  arrivalDate?: string;
  arrivalTime?: string;
  arrivalTimeZone?: string;
  originAirport?: string;
  destinationAirport?: string;
  direction: 'outbound' | 'return' | 'connection' | 'unknown';
  excerpt: string;
}

export interface CompoundTripFlightCandidate {
  event: Record<string, unknown>;
  instant: string;
  flightNumber?: string;
  originAirport?: string;
  bookingReference?: string;
  arrivalAirport?: string;
  destinationCity?: string;
  sourceOffset?: string;
  sourceTimeZone?: string;
  direction: 'outbound' | 'return' | 'connection' | 'unknown';
  calendarDirection?: 'outbound' | 'return' | 'connection' | 'unknown';
  calendarReportedArrivalAirport?: string;
  calendarConflicts?: string[];
  segment?: CompoundTripFlightSegment;
  /** Arrival date after every source-linked connection, not just the first leg. */
  itineraryArrivalDate?: string;
  itineraryHasConnections?: boolean;
  itineraryConnectionChainComplete?: boolean;
  itineraryChronology?: 'valid' | 'unknown' | 'impossible';
}

export interface CompoundTripHotelCandidate {
  threadId: string;
  subject: string;
  hotelName?: string;
  address?: string;
  city?: string;
  checkIn?: string;
  checkOut?: string;
  bookingReference?: string;
  sourceExcerpt: string;
  association: 'shared_reference' | 'date_city_candidate' | 'unlinked';
}

export interface CompoundTripCalendarLodgingObservation {
  title: string;
  dateStart: string;
  dateEnd?: string;
  city?: string;
  sourceUrl?: string;
  association: 'shared_reference' | 'date_city_candidate' | 'unlinked';
}

export interface CompoundTripComparisonEvidence {
  mode: 'public transport' | 'taxi';
  title: string;
  url: string;
  endpointMatched: boolean;
  fare?: string;
  duration?: string;
  quote?: string;
}

export interface CompoundTripReadProjection {
  calendarRows: ReadToolEvidence[];
  calendarComplete: boolean;
  gmailSearchRows: ReadToolEvidence[];
  gmailSearchComplete: boolean;
  readThreads: ReadToolEvidence[];
  threadsComplete: boolean;
  flight?: CompoundTripFlightCandidate;
  returnFlight?: CompoundTripFlightCandidate;
  currentTripReturn?: CompoundTripFlightCandidate;
  flightConfirmationThreadId?: string;
  hotel?: CompoundTripHotelCandidate;
  calendarLodgingObservation?: CompoundTripCalendarLodgingObservation;
  routeOrigin?: string;
  routeDestination?: string;
  webQuery?: string;
  mapRoute?: Record<string, unknown>;
  webSearch?: Record<string, unknown>;
  webFetches: Array<{
    mode: 'public transport' | 'taxi';
    row: ReadToolEvidence;
    endpointMatched: boolean;
    comparison?: CompoundTripComparisonEvidence;
  }>;
  flightSegments: CompoundTripFlightSegment[];
  unmatchedBookingSegments: CompoundTripFlightSegment[];
  connectionSummary?: string;
  comparison: CompoundTripComparisonEvidence[];
  blocked: boolean;
  text: string;
}

export interface UpcomingFlightReadProjection {
  calendarComplete: boolean;
  gmailSearchComplete: boolean;
  threadsComplete: boolean;
  /** Next booking-matched future flight, including a return already underway. */
  flight?: CompoundTripFlightCandidate;
  returnFlight?: CompoundTripFlightCandidate;
  currentTripReturn?: CompoundTripFlightCandidate;
  /** Calendar-only candidate retained when booking identity cannot be matched. */
  calendarCandidate?: CompoundTripFlightCandidate;
  flightSegments: CompoundTripFlightSegment[];
  unmatchedBookingSegments: CompoundTripFlightSegment[];
  blocked: boolean;
  text: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function markdownText(value: string): string {
  // Parentheses are safe in ordinary text nodes. Escaping them leaks the
  // Markdown backslashes in clients that render this projection as plain text.
  // Brackets and other delimiters remain escaped so source text cannot create
  // links or formatting when the same string is rendered as Markdown.
  return value.replace(/[\\`*_{}[\]<>#+\-=|!]/g, '\\$&');
}

function successful(row: ReadToolEvidence): boolean {
  if (row.fromCurrentTask === false || row.status !== 'succeeded') return false;
  const result = object(row.result);
  return result?.ok !== false && !(typeof result?.status === 'number' && result.status >= 400);
}

function hasExactRange(row: ReadToolEvidence, request: PersonalReadRequest): boolean {
  const args = object(row.args);
  return (
    args?.timeMin === request.timeWindow?.timeMin &&
    args?.timeMax === request.timeWindow?.timeMax &&
    !Array.isArray(args?.calendarIds)
  );
}

function currentCalendarRows(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): ReadToolEvidence[] {
  return evidence.filter(
    (row) =>
      successful(row) && row.toolName === 'calendar.list_events' && hasExactRange(row, request),
  );
}

function currentGmailRows(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): ReadToolEvidence[] {
  const queries =
    request.mailQueries?.map((entry) => entry.query) ??
    (request.mailQuery ? [request.mailQuery] : []);
  const allowed = new Set(queries.map((query) => query.toLowerCase()));
  return evidence.filter((row) => {
    if (!successful(row) || row.toolName !== 'gmail.search') return false;
    const query = text(object(row.args)?.query, 4096);
    return Boolean(query && allowed.has(query.toLowerCase()));
  });
}

function currentGmailThreads(
  searches: ReadonlyArray<ReadToolEvidence>,
  evidence: ReadonlyArray<ReadToolEvidence>,
): ReadToolEvidence[] {
  const threadIds = new Set<string>();
  for (const row of searches) {
    const results = object(row.result)?.results;
    if (!Array.isArray(results)) continue;
    for (const hit of results) {
      const id = text(object(hit)?.threadId, 100);
      if (id) threadIds.add(id);
    }
  }
  return evidence.filter((row) => {
    if (!successful(row) || row.toolName !== 'gmail.read_thread') return false;
    return threadIds.has(text(object(row.args)?.threadId, 100));
  });
}

function validSearchPage(row: ReadToolEvidence, query: string): boolean {
  const args = object(row.args);
  const result = object(row.result);
  const receipt = object(result?.receipt);
  const requested = object(receipt?.requested);
  const covered = object(receipt?.covered);
  const results = Array.isArray(result?.results) ? result.results : undefined;
  const unavailable = Array.isArray(result?.unavailable) ? result.unavailable : undefined;
  const receiptContinuation = object(receipt?.continuation);
  const receiptContinuationInput = object(receiptContinuation?.input);
  const resultContinuationPresent = Boolean(result && 'continuation' in result);
  const resultContinuation = object(result?.continuation);
  const resultContinuationInput = object(resultContinuation?.input);
  const nextPageToken = text(result?.nextPageToken, 4096);
  if (
    !args ||
    !result ||
    !receipt ||
    !requested ||
    !covered ||
    !results ||
    !unavailable ||
    args.query !== query ||
    result.query !== query ||
    !Number.isInteger(args.maxResults) ||
    typeof result.complete !== 'boolean' ||
    typeof result.hasMore !== 'boolean' ||
    receipt.version !== 1 ||
    object(receipt.source)?.kind !== 'gmail-search' ||
    object(receipt.source)?.id !== gmailSearchReceiptSourceId(query) ||
    requested.scope !== 'query-page' ||
    requested.limit !== args.maxResults ||
    requested.cursor !== args.pageToken ||
    covered.count !== results.length ||
    covered.unavailable !== unavailable.length ||
    receipt.complete !== (result.complete === true) ||
    !Array.isArray(receipt.losses)
  )
    return false;
  if (result.hasMore === true) {
    return Boolean(
      nextPageToken &&
        receiptContinuation?.tool === 'gmail.search' &&
        receiptContinuationInput?.query === query &&
        receiptContinuationInput?.maxResults === args.maxResults &&
        receiptContinuationInput?.pageToken === nextPageToken &&
        (!resultContinuationPresent ||
          (resultContinuation?.tool === 'gmail.search' &&
            resultContinuationInput?.query === query &&
            resultContinuationInput?.maxResults === args.maxResults &&
            resultContinuationInput?.pageToken === nextPageToken)) &&
        receipt.losses.includes('provider-page'),
    );
  }
  return (
    result.complete === true &&
    !nextPageToken &&
    (!resultContinuationPresent || result.continuation === null) &&
    receipt.continuation === null &&
    receipt.losses.length === 0
  );
}

function completeSearchQuery(rows: ReadonlyArray<ReadToolEvidence>, query: string): boolean {
  if (rows.length === 0 || rows.length > 2) return false;
  let cursor: string | undefined;
  const remaining = new Set(rows);
  const seenCursors = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const cursorKey = cursor ?? '<first-page>';
    if (seenCursors.has(cursorKey)) return false;
    seenCursors.add(cursorKey);
    const page = rows.find((row) => object(row.args)?.pageToken === cursor && remaining.has(row));
    if (!page || !validSearchPage(page, query)) return false;
    remaining.delete(page);
    const result = object(page.result);
    if (result?.hasMore === true) {
      const next = text(result.nextPageToken, 4096);
      if (!next || seenCursors.has(next) || index === rows.length - 1) return false;
      cursor = next;
    } else {
      return index === rows.length - 1 && remaining.size === 0 && result?.complete === true;
    }
  }
  return false;
}

function validSearchPrefixRows(
  rows: ReadonlyArray<ReadToolEvidence>,
  query: string,
): ReadToolEvidence[] {
  const validRows = rows.filter((row) => validSearchPage(row, query));
  const used = new Set<ReadToolEvidence>();
  const prefix: ReadToolEvidence[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < 2; index += 1) {
    const key = cursor ?? '<first-page>';
    if (seen.has(key)) break;
    seen.add(key);
    const page = validRows.find(
      (row) => !used.has(row) && (text(object(row.args)?.pageToken, 4096) || undefined) === cursor,
    );
    if (!page) break;
    used.add(page);
    prefix.push(page);
    const result = object(page.result);
    if (result?.hasMore !== true) break;
    const next = text(result.nextPageToken, 4096);
    if (!next || seen.has(next)) break;
    cursor = next;
  }
  return prefix;
}

/** Current-task, source-receipted complete threads from the validated search prefix. */
export function compoundTripCompleteSourceThreads(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): ReadToolEvidence[] {
  const queries =
    request.mailQueries?.map((entry) => entry.query) ??
    (request.mailQuery ? [request.mailQuery] : []);
  if (queries.length === 0) return [];
  const searches = currentGmailRows(request, evidence);
  const searchPrefix = queries.flatMap((query) =>
    validSearchPrefixRows(
      searches.filter(
        (row) => text(object(row.args)?.query, 4096)?.toLowerCase() === query.toLowerCase(),
      ),
      query,
    ),
  );
  if (searchPrefix.length === 0) return [];
  const threads = currentGmailThreads(searchPrefix, evidence);
  const completeIds = completeThreadIds(threads);
  return threads.filter((row) => completeIds.has(text(object(row.args)?.threadId, 100)));
}

function completeThreadIds(rows: ReadonlyArray<ReadToolEvidence>): Set<string> {
  const byThread = new Map<string, ReadToolEvidence[]>();
  for (const row of rows) {
    if (!successful(row) || row.toolName !== 'gmail.read_thread') continue;
    const id = text(object(row.args)?.threadId, 100);
    if (!id) continue;
    byThread.set(id, [...(byThread.get(id) ?? []), row]);
  }
  const complete = new Set<string>();
  for (const [threadId, pages] of byThread) {
    let contiguous = true;
    for (let index = 0; index < pages.length; index += 1) {
      const row = pages[index];
      const args = object(row?.args);
      const result = object(row?.result);
      const receipt = object(result?.receipt);
      if (!args || !result) {
        contiguous = false;
        break;
      }
      const start = Number.isInteger(args.startMessageIndex) ? Number(args.startMessageIndex) : 0;
      const offset = Number.isInteger(args.startMessageOffset)
        ? Number(args.startMessageOffset)
        : 0;
      const messages = Array.isArray(result.messages) ? result.messages : [];
      const previous = pages[index - 1];
      if (index === 0) {
        if (start !== 0 || offset !== 0) contiguous = false;
      } else {
        const previousResult = object(previous?.result);
        const continuation = object(previousResult?.continuation);
        const continuationInput = object(continuation?.input);
        if (
          continuation?.tool !== 'gmail.read_thread' ||
          continuationInput?.threadId !== threadId ||
          continuationInput?.startMessageIndex !== start ||
          continuationInput?.startMessageOffset !== offset
        )
          contiguous = false;
      }
      const requested = object(receipt?.requested);
      const covered = object(receipt?.covered);
      const receiptContinuation = object(receipt?.continuation);
      const receiptContinuationInput = object(receiptContinuation?.input);
      const rowContinuation = object(result.continuation);
      const rowContinuationInput = object(rowContinuation?.input);
      if (
        receipt?.version !== 1 ||
        typeof result.complete !== 'boolean' ||
        typeof result.hasMore !== 'boolean' ||
        result.threadId !== threadId ||
        object(receipt.source)?.kind !== 'gmail-thread' ||
        object(receipt.source)?.id !== threadId ||
        receipt.complete !== (result.complete === true) ||
        requested?.scope !== 'thread-messages' ||
        requested?.start !== start ||
        requested?.offset !== offset ||
        !Number.isInteger(args.maxMessages) ||
        requested.limit !== args.maxMessages ||
        !Number.isInteger(args.maxChars) ||
        covered?.start !== start ||
        covered?.offset !== offset ||
        covered?.end !== start + messages.length ||
        covered?.count !== messages.length ||
        covered?.unavailable !== 0 ||
        !Array.isArray(receipt.losses) ||
        (result.complete === true && receipt.losses.length !== 0) ||
        (result.hasMore === true &&
          (rowContinuation?.tool !== 'gmail.read_thread' ||
            rowContinuationInput?.threadId !== threadId ||
            rowContinuationInput?.maxMessages !== args.maxMessages ||
            rowContinuationInput?.maxChars !== args.maxChars ||
            receiptContinuation?.tool !== 'gmail.read_thread' ||
            receiptContinuationInput?.threadId !== threadId ||
            receiptContinuationInput?.startMessageIndex !==
              rowContinuationInput?.startMessageIndex ||
            receiptContinuationInput?.startMessageOffset !==
              rowContinuationInput?.startMessageOffset ||
            receiptContinuationInput?.maxMessages !== args.maxMessages ||
            receiptContinuationInput?.maxChars !== args.maxChars)) ||
        (result.hasMore !== true &&
          (rowContinuation !== undefined || receipt?.continuation !== null))
      )
        contiguous = false;
      if (!contiguous) break;
    }
    if (contiguous && !threadBodyIsContiguous(pages)) contiguous = false;
    const last = pages.at(-1);
    const lastResult = object(last?.result);
    const lastContinuation = object(lastResult?.continuation);
    if (contiguous && lastResult?.complete === true && !lastContinuation) complete.add(threadId);
  }
  return complete;
}

function threadBodyIsContiguous(rows: ReadonlyArray<ReadToolEvidence>): boolean {
  const fragments = new Map<
    string,
    Array<{ offset: number; text: string; sourceLength?: number; truncated?: boolean }>
  >();
  for (const row of rows) {
    const args = object(row.args);
    const firstOffset = Number.isInteger(args?.startMessageOffset)
      ? Number(args?.startMessageOffset)
      : 0;
    const messages = object(row.result)?.messages;
    if (!Array.isArray(messages)) return false;
    for (const [index, raw] of messages.entries()) {
      const message = object(raw);
      const messageId = text(message?.messageId, 100);
      const body = message?.text;
      if (!message || !messageId || typeof body !== 'string') return false;
      const sourceLength = Number.isInteger(message.sourceLength)
        ? Number(message.sourceLength)
        : undefined;
      const truncated = typeof message.truncated === 'boolean' ? message.truncated : undefined;
      const offset = index === 0 ? firstOffset : 0;
      const list = fragments.get(messageId) ?? [];
      list.push({
        offset,
        text: body,
        ...(sourceLength !== undefined ? { sourceLength } : {}),
        ...(truncated !== undefined ? { truncated } : {}),
      });
      fragments.set(messageId, list);
    }
  }
  for (const parts of fragments.values()) {
    if (parts.some((part) => part.sourceLength === undefined || part.truncated === undefined))
      return false;
    const ordered = parts.toSorted((a, b) => a.offset - b.offset);
    const sourceLength = ordered[0]?.sourceLength;
    if (sourceLength === undefined || ordered.some((part) => part.sourceLength !== sourceLength))
      return false;
    let cursor = 0;
    for (let index = 0; index < ordered.length; index += 1) {
      const part = ordered[index];
      if (!part || part.offset !== cursor) return false;
      cursor += part.text.length;
      if (part.truncated === true && index === ordered.length - 1) return false;
      if (part.truncated === false && cursor !== sourceLength) return false;
    }
    if (cursor !== sourceLength || ordered.at(-1)?.truncated === true) return false;
  }
  return true;
}

function bookingReference(value: string): string | undefined {
  const match =
    /\b(?:booking|reservation|confirmation)(?:\s+(?:booking|reservation|confirmation))?\s+(?:reference|ref|number|code|id|no\.?|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,15})\b|\b(?:PNR|record locator)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,15})\b/i.exec(
      value,
    );
  const valueMatch = match?.[1] ?? match?.[2];
  return valueMatch?.replace(/-+$/, '').toUpperCase();
}

function calendarFlightNumber(value: string): string | undefined {
  const match = /\b([A-Z]{2})\s?([0-9]{1,4})\b/i.exec(value);
  return match ? `${match[1]?.toUpperCase()}${match[2]}` : undefined;
}

function arrivalAirport(value: string): string | undefined {
  const labelled =
    /\b(?:arrival airport|destination airport|arrives? at)\s*[:=-]?\s*([A-Z]{3})\b/i.exec(value);
  if (labelled?.[1]) return labelled[1].toUpperCase();
  const routeCode = /(?:→|\bto\b)\s*([A-Z]{3})\b/.exec(value);
  if (routeCode?.[1]) return routeCode[1].toUpperCase();
  const airport = /\b([A-Z]{3})\s+airport\b/i.exec(value);
  return airport?.[1]?.toUpperCase();
}

function destinationCity(value: string): string | undefined {
  const patterns = [
    /\b(?:flight|arriv(?:e|es|ing)|destination)\s+(?:to|in|at)\s+([A-Z][\p{L}' -]{1,48})/iu,
    /\b(?:destination|arrival city)\s*[:=-]\s*([^\n,;]{2,60})/i,
    /\bto\s+([A-Z][\p{L}' -]{1,48})(?=\s*(?:[,;.]|\n|$))/u,
    /\b(?:location|destination)\s*[:=-]\s*([A-Z][\p{L}' -]{1,48})\s+(?:airport|airfield)\b/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern
      .exec(value)?.[1]
      ?.trim()
      .replace(/[.\s]+$/, '');
    if (match && !/\b(?:airport|terminal|gate)\b/i.test(match)) return match.slice(0, 60);
  }
  return undefined;
}

function validInstant(value: unknown, request: PersonalReadRequest): string | undefined {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return undefined;
  const instant = Date.parse(value);
  const start = Date.parse(request.timeWindow?.timeMin ?? '');
  const end = Date.parse(request.timeWindow?.timeMax ?? '');
  return Number.isFinite(instant) && instant >= start && instant < end
    ? new Date(instant).toISOString()
    : undefined;
}

function flightCandidates(
  request: PersonalReadRequest,
  rows: ReadonlyArray<ReadToolEvidence>,
): CompoundTripFlightCandidate[] {
  const candidates: CompoundTripFlightCandidate[] = [];
  for (const row of rows) {
    const events = object(row.result)?.events;
    if (!Array.isArray(events)) continue;
    for (const item of events) {
      const event = object(item);
      if (!event || text(event.status).toLowerCase() === 'cancelled') continue;
      const instant = validInstant(event.start, request);
      const summary = text(event.summary, 240);
      const details = `${summary}\n${text(event.description, 1200)}\n${text(event.location, 300)}`;
      if (!instant || !/\b(?:flight|airline|itinerary|boarding pass)\b/i.test(details)) continue;
      candidates.push({
        event,
        instant,
        direction: /\b(?:return|inbound|homebound|returning)\b/i.test(details)
          ? 'return'
          : /\b(?:outbound|departing)\b/i.test(details)
            ? 'outbound'
            : 'unknown',
        ...(calendarFlightNumber(details) ? { flightNumber: calendarFlightNumber(details) } : {}),
        ...(airportRoute(details)?.origin ? { originAirport: airportRoute(details)?.origin } : {}),
        ...(bookingReference(details) ? { bookingReference: bookingReference(details) } : {}),
        ...(arrivalAirport(details) ? { arrivalAirport: arrivalAirport(details) } : {}),
        ...(destinationCity(details) ? { destinationCity: destinationCity(details) } : {}),
        ...(sourceOffset(event.start) ? { sourceOffset: sourceOffset(event.start) } : {}),
        ...(validTimeZone(event.timeZone) ? { sourceTimeZone: String(event.timeZone) } : {}),
      });
    }
  }
  return candidates.sort((a, b) => Date.parse(a.instant) - Date.parse(b.instant));
}

function airportRoute(value: string): { origin: string; destination: string } | undefined {
  const match = /\b([A-Z]{3})\s*(?:→|->|–|—|\bto\b)\s*([A-Z]{3})\b/i.exec(value);
  return match?.[1] && match[2]
    ? { origin: match[1].toUpperCase(), destination: match[2].toUpperCase() }
    : undefined;
}

function nextOutboundFlight(
  request: PersonalReadRequest,
  calendar: ReadonlyArray<CompoundTripFlightCandidate>,
  segments: ReadonlyArray<CompoundTripFlightSegment>,
): {
  flight?: CompoundTripFlightCandidate;
  returnFlight?: CompoundTripFlightCandidate;
  currentTripReturn?: CompoundTripFlightCandidate;
  ambiguous: boolean;
} {
  const startDate = request.timeWindow?.timeMin.slice(0, 10) ?? '';
  const endDate = request.timeWindow?.timeMax.slice(0, 10) ?? '';
  const startInstant = Date.parse(request.timeWindow?.timeMin ?? '');
  const matchSegment = (
    segment: CompoundTripFlightSegment,
    expectedDirection: 'outbound' | 'return',
  ): { flight?: CompoundTripFlightCandidate; ambiguous: boolean } => {
    const connected = connectionSegments(segment, segments);
    const chain = [segment, ...connected];
    const hasCompleteChain = chain.every(
      (leg, index) => index === 0 || chain[index - 1]?.destinationAirport === leg.originAirport,
    );
    const itineraryArrivalAirport = hasCompleteChain
      ? chain.at(-1)?.destinationAirport
      : segment.destinationAirport;
    const matchingCalendar = calendar.filter((candidate) => {
      const eventDate = sourceCivilDate(candidate.event);
      const numberMatches =
        candidate.flightNumber === undefined || candidate.flightNumber === segment.flightNumber;
      const referenceMatches =
        !candidate.bookingReference ||
        !segment.bookingReference ||
        candidate.bookingReference === segment.bookingReference;
      const destinationMatches =
        !candidate.arrivalAirport ||
        !itineraryArrivalAirport ||
        candidate.arrivalAirport === itineraryArrivalAirport;
      const directionMatches =
        candidate.direction === expectedDirection ||
        (candidate.direction === 'unknown' && segment.direction === expectedDirection);
      const routeMatches = Boolean(
        segment.originAirport &&
          segment.destinationAirport &&
          candidate.originAirport === segment.originAirport &&
          candidate.arrivalAirport === segment.destinationAirport,
      );
      const referenceMatchesStrongly = Boolean(
        candidate.bookingReference &&
          segment.bookingReference &&
          candidate.bookingReference === segment.bookingReference,
      );
      const sourceDeparture = sourceLocalInstant(segment);
      const calendarDeparture = Date.parse(candidate.instant);
      const timeMatches =
        sourceDeparture !== undefined &&
        Number.isFinite(calendarDeparture) &&
        Math.abs(sourceDeparture - calendarDeparture) <= 5 * 60_000;
      const departureZone = text(segment.departureTimeZone, 120);
      const boundLocalDate =
        referenceMatchesStrongly && validTimeZone(departureZone)
          ? civilDateInTimeZone(candidate.instant, departureZone)
          : undefined;
      const dateMatches =
        eventDate === segment.departureDate || boundLocalDate === segment.departureDate;
      const calendarHasSparseIdentity =
        candidate.direction === 'unknown' || candidate.flightNumber === undefined;
      const strictMatch =
        directionMatches &&
        numberMatches &&
        dateMatches &&
        referenceMatches &&
        destinationMatches &&
        (!calendarHasSparseIdentity ||
          (segment.direction === expectedDirection &&
            (routeMatches || referenceMatchesStrongly) &&
            timeMatches));
      // An exact reference plus a departure-day match in the booking's own
      // time zone can bind one dated leg even when the calendar has stale or
      // conflicting flight metadata. Keep the conflict attached for reporting;
      // do not let the same reference/date bind several itinerary legs.
      const sameReferenceDayLegs = segments.filter(
        (item) =>
          item.threadId === segment.threadId &&
          item.bookingReference === segment.bookingReference &&
          item.direction === expectedDirection &&
          item.departureDate === segment.departureDate,
      );
      const strongReferenceMatch =
        referenceMatchesStrongly &&
        dateMatches &&
        (candidate.direction === 'unknown' || candidate.direction === expectedDirection) &&
        (!candidate.originAirport ||
          !segment.originAirport ||
          candidate.originAirport === segment.originAirport) &&
        sameReferenceDayLegs.length === 1;
      return strongReferenceMatch || strictMatch;
    });
    if (matchingCalendar.length > 1) return { ambiguous: true };
    const event = matchingCalendar[0];
    if (!event) return { ambiguous: false };
    const hasConnections = connected.length > 0;
    const chainArrival = hasCompleteChain ? chain.at(-1)?.arrivalDate : undefined;
    const chronology = flightChronology(chain);
    const itineraryArrivalDate = hasConnections
      ? chainArrival
      : (segment.arrivalDate ?? sourceCivilDate(event.event));
    const calendarConflicts: string[] = [];
    if (event.flightNumber && event.flightNumber !== segment.flightNumber)
      calendarConflicts.push('flight-number');
    if (event.direction !== 'unknown' && event.direction !== expectedDirection)
      calendarConflicts.push('direction');
    if (
      event.arrivalAirport &&
      itineraryArrivalAirport &&
      event.arrivalAirport !== itineraryArrivalAirport
    )
      calendarConflicts.push('arrival-airport');
    return {
      flight: {
        ...event,
        calendarDirection: event.direction,
        ...(event.arrivalAirport ? { calendarReportedArrivalAirport: event.arrivalAirport } : {}),
        direction: expectedDirection,
        ...(calendarConflicts.length ? { calendarConflicts } : {}),
        ...(hasConnections && hasCompleteChain && chain.at(-1)?.destinationAirport
          ? { arrivalAirport: chain.at(-1)?.destinationAirport }
          : {}),
        ...(itineraryArrivalDate ? { itineraryArrivalDate } : {}),
        itineraryHasConnections: hasConnections,
        itineraryConnectionChainComplete:
          !hasConnections || (hasCompleteChain && chronology === 'valid'),
        itineraryChronology: chronology,
        segment,
      },
      ambiguous: false,
    };
  };
  const futureSegments = (direction: 'outbound' | 'return') => {
    const endInstant = Date.parse(request.timeWindow?.timeMax ?? '');
    const candidates = segments
      .filter(
        (segment) =>
          (segment.direction === direction ||
            (direction === 'outbound' && segment.direction === 'unknown')) &&
          segment.departureDate >= startDate &&
          segment.departureDate < endDate,
      )
      .map((segment) => ({ segment, instant: sourceLocalInstant(segment) }))
      .filter(
        ({ instant }) =>
          instant === undefined ||
          (Number.isFinite(startInstant) &&
            Number.isFinite(endInstant) &&
            instant >= startInstant &&
            instant < endInstant),
      )
      .sort((a, b) => {
        if (a.instant === undefined || b.instant === undefined) return 0;
        return a.instant - b.instant;
      });
    return {
      segments: candidates.map(({ segment }) => segment),
      unknownSegments: candidates
        .filter(({ instant }) => instant === undefined)
        .map(({ segment }) => segment),
    };
  };
  const outboundCandidates = futureSegments('outbound');
  const outbounds = outboundCandidates.segments;
  const firstOutbound = outbounds[0];
  let ambiguous = outboundCandidates.unknownSegments.length > 0;
  let flight: CompoundTripFlightCandidate | undefined;
  if (firstOutbound && outboundCandidates.unknownSegments.length === 0) {
    const firstInstant = sourceLocalInstant(firstOutbound);
    const sameInstant = outbounds.filter((candidate) => {
      const instant = sourceLocalInstant(candidate);
      return firstInstant !== undefined && instant === firstInstant;
    });
    if (sameInstant.length > 1) ambiguous = true;
    else {
      const matched = matchSegment(firstOutbound, 'outbound');
      flight = matched.flight;
      ambiguous = matched.ambiguous;
    }
  }
  const returnCandidates = futureSegments('return');
  const returns = returnCandidates.segments;
  const pairedReturns = flight?.segment?.bookingReference
    ? returns.filter(
        (segment) =>
          segment.threadId === flight?.segment?.threadId &&
          segment.bookingReference === flight.segment.bookingReference &&
          segment.departureDate >= flight.segment.departureDate,
      )
    : [];
  const pairedUnknownReturns = flight?.segment?.bookingReference
    ? returnCandidates.unknownSegments.filter(
        (segment) =>
          segment.threadId === flight?.segment?.threadId &&
          segment.bookingReference === flight.segment.bookingReference &&
          segment.departureDate >= flight.segment.departureDate,
      )
    : [];
  ambiguous ||= pairedUnknownReturns.length > 0;
  const firstPairedReturn =
    pairedReturns.length === 1 && pairedUnknownReturns.length === 0 ? pairedReturns[0] : undefined;
  let returnFlight: CompoundTripFlightCandidate | undefined;
  if (pairedReturns.length > 1) {
    ambiguous = true;
  } else if (firstPairedReturn) {
    const matched = matchSegment(firstPairedReturn, 'return');
    returnFlight = matched.flight;
    ambiguous ||= matched.ambiguous;
  }
  if (flight) return { flight, ...(returnFlight ? { returnFlight } : {}), ambiguous };
  ambiguous ||= returnCandidates.unknownSegments.length > 0;
  if (ambiguous) return { ambiguous };
  const firstReturn = returns[0];
  let currentTripReturn: CompoundTripFlightCandidate | undefined;
  if (firstReturn) {
    if (returns.length > 1) ambiguous = true;
    else currentTripReturn = matchSegment(firstReturn, 'return').flight;
  }
  return { ...(currentTripReturn ? { currentTripReturn } : {}), ambiguous };
}

function connectionSegments(
  flight: CompoundTripFlightSegment | undefined,
  segments: ReadonlyArray<CompoundTripFlightSegment>,
): CompoundTripFlightSegment[] {
  if (!flight?.bookingReference) return [];
  const firstDeparture = sourceLocalInstant(flight);
  return segments
    .map((segment, index) => ({ segment, index, instant: sourceLocalInstant(segment) }))
    .filter(
      ({ segment, instant }) =>
        segment.threadId === flight.threadId &&
        segment.bookingReference === flight.bookingReference &&
        segment !== flight &&
        (segment.direction === 'connection' || segment.direction === 'outbound') &&
        (firstDeparture === undefined ||
          instant === undefined ||
          (instant > firstDeparture && instant - firstDeparture <= 3 * 86_400_000)),
    )
    .sort((a, b) => {
      if (a.instant === undefined || b.instant === undefined) return a.index - b.index;
      return a.instant - b.instant;
    })
    .map(({ segment }) => segment);
}

function connectionChainSummary(
  first: CompoundTripFlightSegment | undefined,
  segments: ReadonlyArray<CompoundTripFlightSegment>,
): string | undefined {
  if (!first || segments.length === 0) return undefined;
  const legs = [first, ...segments];
  for (let index = 1; index < legs.length; index += 1) {
    if (!legs[index - 1]?.destinationAirport || !legs[index]?.originAirport) return undefined;
    if (legs[index - 1]?.destinationAirport !== legs[index]?.originAirport) return undefined;
  }
  if (flightChronology(legs) !== 'valid') return undefined;
  return legs.map(formatFlightSegment).join('; ');
}

function flightChronology(
  legs: ReadonlyArray<CompoundTripFlightSegment>,
): 'valid' | 'unknown' | 'impossible' {
  if (legs.length === 0) return 'unknown';
  let previousArrival: number | undefined;
  for (const leg of legs) {
    const departure = sourceLocalInstant(leg);
    const arrival = sourceLocalDateTimeInstant(
      leg.arrivalDate,
      leg.arrivalTime,
      leg.arrivalTimeZone,
    );
    if (departure === undefined || arrival === undefined) return 'unknown';
    if (arrival <= departure || (previousArrival !== undefined && departure < previousArrival))
      return 'impossible';
    previousArrival = arrival;
  }
  return 'valid';
}

function formatFlightSegment(leg: CompoundTripFlightSegment): string {
  const departure = `${leg.departureDate} ${leg.departureTime}${leg.departureTimeZone ? ` ${markdownText(leg.departureTimeZone)}` : ' (departure time zone not stated)'}`;
  const arrival =
    leg.arrivalDate && leg.arrivalTime
      ? `${leg.arrivalDate} ${leg.arrivalTime}${leg.arrivalTimeZone ? ` ${markdownText(leg.arrivalTimeZone)}` : ' (arrival time zone not stated)'}`
      : `arrival date or clock time not stated${leg.arrivalTimeZone ? ` ${markdownText(leg.arrivalTimeZone)}` : ''}`;
  return `${leg.flightNumber} ${leg.originAirport ?? 'origin not stated'}→${leg.destinationAirport ?? 'destination not stated'}; departs ${departure}; arrives ${arrival}`;
}

interface SourceThreadMessage {
  threadId: string;
  messageId: string;
  subject: string;
  text: string;
}

function threadMessages(rows: ReadonlyArray<ReadToolEvidence>): SourceThreadMessage[] {
  const grouped = new Map<
    string,
    {
      threadId: string;
      messageId: string;
      subject: string;
      pages: Array<{ start: number; offset: number; text: string }>;
    }
  >();
  for (const row of rows) {
    const args = object(row.args);
    const threadId = text(args?.threadId, 100);
    const start = Number.isInteger(args?.startMessageIndex) ? Number(args?.startMessageIndex) : 0;
    const offset = Number.isInteger(args?.startMessageOffset)
      ? Number(args?.startMessageOffset)
      : 0;
    const messages = object(row.result)?.messages;
    if (!threadId || !Array.isArray(messages)) continue;
    for (const raw of messages) {
      const message = object(raw);
      const messageId = text(message?.messageId, 100);
      if (!message || !messageId) continue;
      const key = `${threadId}:${messageId}`;
      const groupedMessage = grouped.get(key) ?? {
        threadId,
        messageId,
        subject: text(message.subject, 240),
        pages: [],
      };
      groupedMessage.pages.push({ start, offset, text: text(message.text, 8_000) });
      grouped.set(key, groupedMessage);
    }
  }
  return [...grouped.values()].map((message) => ({
    threadId: message.threadId,
    messageId: message.messageId,
    subject: message.subject,
    text: message.pages
      .sort((a, b) => a.start - b.start || a.offset - b.offset)
      .map((page) => page.text)
      .join('')
      .slice(0, 24_000),
  }));
}

function exactSourceToken(quote: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(quote);
}

function sourceDateMatches(quote: string, date: string): boolean {
  const match = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(date);
  if (!match?.[1] || !match[2] || !match[3]) return false;
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date)
    return false;
  const [, year, month, day] = match;
  const names = [
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
  const name = names[Number(month) - 1];
  if (!name || Number(day) < 1 || Number(day) > 31) return false;
  const normalizedQuote = quote.replace(/\s+/g, ' ');
  return [
    new RegExp(`\\b${year}-${month}-${day}\\b`),
    new RegExp(`\\b${name}\\s+${Number(day)}(?:st|nd|rd|th)?[,]?\\s+${year}\\b`, 'i'),
    new RegExp(`\\b${Number(day)}(?:st|nd|rd|th)?\\s+${name}[,]?\\s+${year}\\b`, 'i'),
    new RegExp(
      `\\b${name.slice(0, 3)}[a-z]*\\.?\\s+${Number(day)}(?:st|nd|rd|th)?[,]?\\s+${year}\\b`,
      'i',
    ),
    new RegExp(
      `\\b${Number(day)}(?:st|nd|rd|th)?\\s+${name.slice(0, 3)}[a-z]*\\.?[,]?\\s+${year}\\b`,
      'i',
    ),
  ].some((pattern) => pattern.test(normalizedQuote));
}

function normalizedSourceClock(value: string): string | undefined {
  const match = /^(\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 23) return undefined;
  if (match[3]) {
    if (hour < 1 || hour > 12) return undefined;
    if (hour === 12) hour = 0;
    if (match[3].toUpperCase() === 'PM') hour += 12;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function sourceHasClock(quote: string, value: string): boolean {
  const target = normalizedSourceClock(value);
  if (!target) return false;
  const clocks = /\b(\d{1,2}):(\d{2})(?:\s*([AP]M))?\b/gi;
  for (const match of quote.matchAll(clocks)) {
    const clock = normalizedSourceClock(`${match[1]}:${match[2]}${match[3] ? ` ${match[3]}` : ''}`);
    if (clock === target) return true;
  }
  return false;
}

function sourceHasFlightNumber(quote: string, flightNumber: string): boolean {
  const expected = flightNumber.replace(/\s+/g, '').toUpperCase();
  return [...quote.matchAll(/\b([A-Z]{2,3}\s*\d{1,4})\b/gi)].some(
    (match) => match[1]?.replace(/\s+/g, '').toUpperCase() === expected,
  );
}

function extractedSegmentMatchesCurrentSource(
  segment: CompoundTripFlightSegment,
  source: SourceThreadMessage | undefined,
  sourceMessageIds: ReadonlySet<string>,
): boolean {
  const quote = segment.excerpt?.trim();
  if (
    !source ||
    !quote ||
    quote.length > 700 ||
    !source.text.includes(quote) ||
    !sourceMessageIds.has(segment.messageId) ||
    !/^[A-Z]{2,3}\s*\d{1,4}$/i.test(segment.flightNumber) ||
    !sourceHasFlightNumber(quote, segment.flightNumber) ||
    !sourceDateMatches(quote, segment.departureDate) ||
    !sourceHasClock(quote, segment.departureTime)
  )
    return false;
  if (segment.arrivalDate && !sourceDateMatches(quote, segment.arrivalDate)) return false;
  if (segment.arrivalTime && !sourceHasClock(quote, segment.arrivalTime)) return false;
  for (const zone of [segment.departureTimeZone, segment.arrivalTimeZone]) {
    if (zone && !exactSourceToken(quote, zone)) return false;
  }
  for (const airport of [segment.originAirport, segment.destinationAirport]) {
    if (airport && !exactSourceToken(quote, airport)) return false;
  }
  if (segment.bookingReference && !exactSourceToken(quote, segment.bookingReference)) return false;
  if (
    (segment.direction === 'outbound' && !/\b(?:outbound|departing|departure)\b/i.test(quote)) ||
    (segment.direction === 'return' && !/\b(?:return|inbound|homebound)\b/i.test(quote)) ||
    (segment.direction === 'connection' &&
      !/\b(?:connection|connecting|layover|transfer)\b/i.test(quote))
  )
    return false;
  return true;
}

function bindTripExtractionToCurrentEvidence(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
  extraction: CompoundTripExtraction | undefined,
): CompoundTripExtraction | undefined {
  if (extraction?.status !== 'complete') return extraction;
  const messages = threadMessages(compoundTripCompleteSourceThreads(request, evidence));
  const sourceByPair = new Map(
    messages.map((message) => [`${message.threadId}:${message.messageId}`, message]),
  );
  const sourceMessageIds = new Set(extraction.sourceMessageIds);
  const segments = extraction.segments.filter((segment) =>
    extractedSegmentMatchesCurrentSource(
      segment,
      sourceByPair.get(`${segment.threadId}:${segment.messageId}`),
      sourceMessageIds,
    ),
  );
  return {
    ...extraction,
    segments,
    hotels: [],
    rejectedFacts: extraction.rejectedFacts + extraction.segments.length - segments.length,
  };
}

function sameFlightSegment(
  left: CompoundTripFlightSegment,
  right: CompoundTripFlightSegment,
): boolean {
  return (
    left.threadId === right.threadId &&
    left.messageId === right.messageId &&
    left.flightNumber === right.flightNumber &&
    left.departureDate === right.departureDate &&
    left.departureTime === right.departureTime &&
    left.bookingReference === right.bookingReference
  );
}

function compoundTripExtractionFromEvidence(
  evidence: ReadonlyArray<ReadToolEvidence>,
): CompoundTripExtraction | undefined {
  const row = [...evidence]
    .reverse()
    .find((item) => item.toolName === 'compound_trip.extract_bookings');
  const value = object(row?.result);
  if (!row || !value || (value.status !== 'complete' && value.status !== 'unavailable'))
    return undefined;
  const segments = Array.isArray(value.segments)
    ? value.segments.filter((item): item is CompoundTripFlightSegment => {
        const segment = object(item);
        return Boolean(
          segment &&
            typeof segment.threadId === 'string' &&
            typeof segment.messageId === 'string' &&
            typeof segment.flightNumber === 'string' &&
            typeof segment.departureDate === 'string' &&
            typeof segment.departureTime === 'string' &&
            ['outbound', 'return', 'connection', 'unknown'].includes(String(segment.direction)),
        );
      })
    : [];
  const hotels = Array.isArray(value.hotels)
    ? value.hotels.filter((item): item is CompoundTripHotelFact => {
        const hotel = object(item);
        return Boolean(
          hotel &&
            typeof hotel.threadId === 'string' &&
            typeof hotel.messageId === 'string' &&
            typeof hotel.quote === 'string',
        );
      })
    : [];
  return {
    status: value.status,
    segments,
    hotels,
    rejectedFacts: Number.isInteger(value.rejectedFacts) ? Number(value.rejectedFacts) : 0,
    sourceMessageIds: Array.isArray(value.sourceMessageIds)
      ? value.sourceMessageIds.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function extractedHotelCandidates(
  hotels: ReadonlyArray<CompoundTripHotelFact>,
  flight: CompoundTripFlightCandidate | undefined,
): CompoundTripHotelCandidate[] {
  return hotels.map((hotel) => {
    const destination = normalizePlace(flight?.destinationCity ?? '');
    const cityMatches = Boolean(destination && normalizePlace(hotel.city ?? '') === destination);
    const arrival = flight ? destinationCivilDate(flight) : undefined;
    const stayMatchesArrival = Boolean(
      arrival &&
        hotel.checkIn &&
        hotel.checkOut &&
        hotel.checkIn === arrival &&
        hotel.checkOut > arrival,
    );
    const sharedReference = Boolean(
      hotel.bookingReference &&
        (flight?.segment?.bookingReference ?? flight?.bookingReference) &&
        hotel.bookingReference === (flight?.segment?.bookingReference ?? flight?.bookingReference),
    );
    return {
      threadId: hotel.threadId,
      subject: hotel.sourceSubject,
      ...(hotel.name ? { hotelName: hotel.name } : {}),
      ...(hotel.address ? { address: hotel.address } : {}),
      ...(hotel.city ? { city: hotel.city } : {}),
      ...(hotel.checkIn ? { checkIn: hotel.checkIn } : {}),
      ...(hotel.checkOut ? { checkOut: hotel.checkOut } : {}),
      ...(hotel.bookingReference ? { bookingReference: hotel.bookingReference } : {}),
      sourceExcerpt: hotel.quote,
      association: sharedReference
        ? ('shared_reference' as const)
        : cityMatches && stayMatchesArrival
          ? ('date_city_candidate' as const)
          : ('unlinked' as const),
    };
  });
}

function labeledCivilDate(line: string, label: string): string | undefined {
  const value = new RegExp(`\\b(?:${label})\\s*[:=-]?\\s*(.+)$`, 'i').exec(line)?.[1]?.trim();
  if (!value) return undefined;
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(value);
  if (iso) {
    const result = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return validDate(result) ? result : undefined;
  }
  const named =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/i.exec(
      value,
    );
  if (!named?.[1] || !named[2] || !named[3]) return undefined;
  const month = new Date(`${named[1]} 1, 2000`).getMonth() + 1;
  const result = `${named[3]}-${String(month).padStart(2, '0')}-${named[2].padStart(2, '0')}`;
  return validDate(result) ? result : undefined;
}

function explicitFlightNumber(block: string): string | undefined {
  const match =
    /\b(?:flight(?:\s+number)?|flight\s+no\.?|airline\s+flight|leg\s+\d{1,2})\s*[:#-]?\s*([A-Z]{2})\s?([0-9]{1,4})\b/i.exec(
      block,
    );
  return match ? `${match[1]?.toUpperCase()}${match[2]}` : undefined;
}

function airportField(block: string, labels: string): string | undefined {
  const match = new RegExp(`\\b(?:${labels})\\s*[:=-]?\\s*([A-Z]{3})\\b`, 'i').exec(block);
  return match?.[1]?.toUpperCase();
}

function timeField(
  block: string,
  label: 'departure' | 'arrival',
): { time: string; timeZone?: string } | undefined {
  const expression = new RegExp(
    `\\b(?:${label}(?:\\s+time)?|${label}s\\s+at)\\s*[:=-]?\\s*(\\d{1,2}:\\d{2}(?:\\s*[AP]M)?)(?:\\s+(UTC|GMT|[A-Z]{2,5}|[+-]\\d{2}:?\\d{2}|[A-Za-z_]+(?:/[A-Za-z0-9_+-]+)+))?\\b`,
    'i',
  );
  const match = expression.exec(block);
  if (!match?.[1]) return undefined;
  const time = match[1].replace(/\s+/g, ' ').toUpperCase();
  const timeZone = match[2]?.includes('/') ? match[2] : match[2]?.toUpperCase();
  return { time, ...(timeZone ? { timeZone } : {}) };
}

function flightBlocks(
  body: string,
): Array<{ direction: CompoundTripFlightSegment['direction']; excerpt: string }> {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (
      /^(?:outbound(?:\s+flight)?|return(?:\s+flight)?|connection(?:\s+\d+)?|leg\s+\d{1,2})\b/i.test(
        line,
      )
    )
      starts.push(index);
  });
  if (!starts.length) return [{ direction: 'unknown', excerpt: lines.join('\n').slice(0, 1800) }];
  if (starts[0] !== 0) starts.unshift(0);
  return starts.flatMap((start, index) => {
    const block = lines
      .slice(start, starts[index + 1] ?? lines.length)
      .join('\n')
      .slice(0, 1800);
    if (!/\b(?:flight|airline|itinerary|boarding pass|e-?ticket|leg\s+\d+)\b/i.test(block))
      return [];
    const direction = /\breturn\b/i.test(lines[start] ?? '')
      ? 'return'
      : /\bconnection\b/i.test(lines[start] ?? '')
        ? 'connection'
        : /\boutbound\b/i.test(lines[start] ?? '')
          ? 'outbound'
          : 'unknown';
    return [{ direction, excerpt: block }];
  });
}

function parseFlightSegments(
  messages: ReadonlyArray<SourceThreadMessage>,
): CompoundTripFlightSegment[] {
  const segments: CompoundTripFlightSegment[] = [];
  for (const message of messages) {
    const messageReference = bookingReference(`${message.subject}\n${message.text}`);
    for (const block of flightBlocks(message.text)) {
      const flightNumber = explicitFlightNumber(block.excerpt);
      const departureDateLine = block.excerpt
        .split(/\r?\n/)
        .find((line) => /\b(?:departure\s+date|flight\s+date|travel\s+date|date)\b/i.test(line));
      const arrivalDateLine = block.excerpt
        .split(/\r?\n/)
        .find((line) => /\b(?:arrival\s+date)\b/i.test(line));
      const departureDate = departureDateLine
        ? labeledCivilDate(
            departureDateLine,
            '(?:departure\\s+date|flight\\s+date|travel\\s+date|date)',
          )
        : undefined;
      const arrivalDate = arrivalDateLine
        ? labeledCivilDate(arrivalDateLine, 'arrival\\s+date')
        : undefined;
      const departure = timeField(block.excerpt, 'departure');
      const arrival = timeField(block.excerpt, 'arrival');
      if (!flightNumber || !departureDate || !departure) continue;
      const fromTo = /\bfrom\s+([A-Z]{3})\s+(?:to|→|->)\s+([A-Z]{3})\b/i.exec(block.excerpt);
      segments.push({
        threadId: message.threadId,
        messageId: message.messageId,
        subject: message.subject,
        ...(messageReference ? { bookingReference: messageReference } : {}),
        flightNumber,
        departureDate,
        departureTime: departure.time,
        ...(departure.timeZone ? { departureTimeZone: departure.timeZone } : {}),
        ...(arrivalDate ? { arrivalDate } : {}),
        ...(arrival
          ? {
              arrivalTime: arrival.time,
              ...(arrival.timeZone ? { arrivalTimeZone: arrival.timeZone } : {}),
            }
          : {}),
        ...((airportField(block.excerpt, 'from|origin|departure airport') ?? fromTo?.[1])
          ? {
              originAirport:
                airportField(block.excerpt, 'from|origin|departure airport') ??
                fromTo?.[1]?.toUpperCase(),
            }
          : {}),
        ...((airportField(block.excerpt, 'to|destination|arrival airport') ?? fromTo?.[2])
          ? {
              destinationAirport:
                airportField(block.excerpt, 'to|destination|arrival airport') ??
                fromTo?.[2]?.toUpperCase(),
            }
          : {}),
        direction: block.direction,
        excerpt: block.excerpt,
      });
    }
  }
  return segments;
}

function hotelCandidates(
  threads: ReadonlyArray<ReadToolEvidence>,
  flight: CompoundTripFlightCandidate | undefined,
): CompoundTripHotelCandidate[] {
  const candidates: CompoundTripHotelCandidate[] = [];
  for (const message of threadMessages(threads)) {
    const threadId = message.threadId;
    const subject = text(message.subject, 240);
    const body = text(message.text, 8000);
    const source = `${subject}\n${body}`;
    if (
      !threadId ||
      !/\b(?:hotel|accommodation|lodging)\b/i.test(source) ||
      !/\b(?:booking|reservation|confirmation|check[- ]?in)\b/i.test(source)
    )
      continue;
    const address = hotelAddress(body);
    const { name: parsedName, city: parsedCity } = hotelNameAndCity(source);
    const hotelName =
      /\bhotel\s+(?:name|property)\s*:\s*([^\n\r]{2,160})/i.exec(body)?.[1]?.trim() ?? parsedName;
    const city =
      /\b(?:hotel\s+)?city\s*:\s*([^\n\r]{2,100})/i.exec(body)?.[1]?.trim() ?? parsedCity;
    const { checkIn, checkOut } = hotelStayDates(body);
    const reference = bookingReference(source);
    const sharedReference = Boolean(
      reference &&
        (flight?.segment?.bookingReference ?? flight?.bookingReference) &&
        reference === (flight?.segment?.bookingReference ?? flight?.bookingReference),
    );
    const flightDate = flight ? destinationCivilDate(flight) : undefined;
    const dateCityCandidate = Boolean(
      flight?.direction === 'outbound' &&
        flight &&
        city &&
        flight.destinationCity &&
        normalizePlace(city) === normalizePlace(flight.destinationCity) &&
        checkIn &&
        checkOut &&
        flightDate &&
        flightDate === checkIn &&
        flightDate < checkOut,
    );
    candidates.push({
      threadId,
      subject,
      ...(hotelName ? { hotelName: hotelName.slice(0, 160) } : {}),
      ...(address ? { address: address.slice(0, 240) } : {}),
      ...(city ? { city: city.slice(0, 100) } : {}),
      ...(checkIn ? { checkIn } : {}),
      ...(checkOut ? { checkOut } : {}),
      ...(reference ? { bookingReference: reference } : {}),
      sourceExcerpt: source.slice(0, 500),
      association: sharedReference
        ? 'shared_reference'
        : dateCityCandidate
          ? 'date_city_candidate'
          : 'unlinked',
    });
  }
  return candidates;
}

function calendarLodgingObservation(
  rows: ReadonlyArray<ReadToolEvidence>,
  flight: CompoundTripFlightCandidate | undefined,
  currentTripReturn: CompoundTripFlightCandidate | undefined,
): CompoundTripCalendarLodgingObservation | undefined {
  const anchor = flight ?? currentTripReturn;
  if (!anchor) return undefined;
  const anchorReference = anchor.segment?.bookingReference ?? anchor.bookingReference;
  const anchorCity = flight?.destinationCity ?? calendarFlightOriginCity(currentTripReturn?.event);
  const anchorDate = flight
    ? destinationCivilDate(flight)
    : currentTripReturn?.segment?.departureDate;
  if (!anchorDate) return undefined;

  const candidates = new Map<string, CompoundTripCalendarLodgingObservation>();
  for (const row of rows) {
    const events = object(row.result)?.events;
    if (!Array.isArray(events)) continue;
    for (const item of events) {
      const event = object(item);
      if (!event || text(event.status).toLowerCase() === 'cancelled') continue;
      const eventId = text(event.eventId, 160);
      if (!eventId) continue;
      const title = text(event.summary, 180);
      const description = text(event.description, 1_200);
      const location = text(event.location, 240);
      const sourceText = `${title}\n${description}\n${location}`;
      if (!/\b(?:hotel|lodging|accommodation|guesthouse|hostel|inn|resort)\b/i.test(sourceText))
        continue;
      const endValue = object(event.end)?.date ?? object(event.end)?.dateTime ?? event.end;
      const dateStart = sourceCivilDate(event);
      const dateEnd = endValue
        ? sourceCivilDate({ start: endValue, timeZone: event.timeZone })
        : undefined;
      const startIsDate = Boolean(object(event.start)?.date);
      const endIsDate = Boolean(object(event.end)?.date);
      const allDayRange = startIsDate && endIsDate;
      if (
        !dateStart ||
        dateStart > anchorDate ||
        (dateEnd && (allDayRange ? dateEnd <= anchorDate : dateEnd < anchorDate))
      )
        continue;
      // Descriptions are untrusted and may only classify a record as lodging.
      // Use the visible title/location fields for any candidate association.
      const associationText = `${title}\n${location}`;
      const reference = bookingReference(associationText);
      const sharedReference = Boolean(anchorReference && reference === anchorReference);
      const city = calendarLodgingCity(title, location);
      const dateCityCandidate = Boolean(
        !sharedReference &&
          anchorCity &&
          city &&
          normalizePlace(city) === normalizePlace(anchorCity),
      );
      if (!sharedReference && !dateCityCandidate) continue;
      const url = calendarSource(event);
      if (!url) continue;
      candidates.set(eventId, {
        title: title || 'Lodging calendar entry',
        dateStart,
        ...(dateEnd ? { dateEnd } : {}),
        ...(city ? { city } : {}),
        ...(url ? { sourceUrl: url } : {}),
        association: sharedReference ? 'shared_reference' : 'date_city_candidate',
      });
    }
  }
  const uniqueCandidates = [...candidates.values()];
  const sharedReferenceCandidates = uniqueCandidates.filter(
    (candidate) => candidate.association === 'shared_reference',
  );
  if (sharedReferenceCandidates.length > 1) return undefined;
  if (sharedReferenceCandidates.length === 1) return sharedReferenceCandidates[0];
  const cityDateCandidates = uniqueCandidates.filter(
    (candidate) => candidate.association === 'date_city_candidate',
  );
  return cityDateCandidates.length === 1 ? cityDateCandidates[0] : undefined;
}

function calendarLodgingCity(title: string, location: string): string | undefined {
  const source = title;
  const parsed = hotelNameAndCity(source).city;
  if (parsed) return parsed.slice(0, 80);
  const labelled = /\b(?:hotel\s+)?city\s*:\s*([^\n,;]{2,80})/i.exec(source)?.[1]?.trim();
  if (labelled) return labelled;
  const locationCity = /^\s*([\p{L}][\p{L}' -]{1,60})\s*,\s*(?:[\p{L}]{2,40}|[A-Z]{2})\b/u
    .exec(location)?.[1]
    ?.trim();
  return locationCity || undefined;
}

function calendarFlightOriginCity(event: Record<string, unknown> | undefined): string | undefined {
  if (!event) return undefined;
  const source = `${text(event.summary, 240)}\n${text(event.description, 1_200)}\n${text(event.location, 240)}`;
  const from = /\bfrom\s+([\p{L}][\p{L}' -]{1,50}?)(?=\s+(?:to|airport|terminal)\b|[,;.\n]|$)/iu
    .exec(source)?.[1]
    ?.trim();
  return from ? from.slice(0, 80) : undefined;
}

function hotelAddress(body: string): string | undefined {
  const labelled = /\b(?:hotel\s+)?address\s*:\s*([^\n\r]{8,240})/i
    .exec(body)?.[1]
    ?.trim()
    .replace(/[.,;:]\s*$/, '');
  if (labelled && /\d/.test(labelled)) return labelled;
  const line = body
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(
      (part) =>
        (/^\d{1,6}\s+[\p{L}0-9.' -]{3,100}(?:,\s*[^\n]{2,100})?$/u.test(part) ||
          /^[\p{L}][\p{L}0-9.' -]{2,80}\s+\d{1,6}(?:,\s*[^\n]{2,100})?$/u.test(part)) &&
        /\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|platz|strasse|straße|gasse|boulevard|blvd\.?|lane|ln\.?|way|square)\b/i.test(
          part,
        ),
    );
  return line?.replace(/[.,;:]\s*$/, '').slice(0, 240);
}

function hotelNameAndCity(source: string): { name?: string; city?: string } {
  const patterns = [
    /\b(?:reservation|booking)\s+(?:confirmed|confirmation|details)?\s*(?:for|at)\s+(?:hotel\s+)?([^\n,.;]{2,100}),\s*([^\n,.;]{2,80})/i,
    /\b(?:hotel\s+)?reservation\s*:\s*([^\n,.;]{2,100}),\s*([^\n,.;]{2,80})/i,
    /\bhotel\s+([^\n,.;]{2,100}),\s*([^\n,.;]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match?.[1] && match[2]) {
      const name = match[0].match(/\bhotel\s+/i)
        ? `Hotel ${match[1].trim().replace(/^(?:the\s+)?hotel\s+/i, '')}`
        : match[1].trim().replace(/^(?:the\s+)?hotel\s+/i, '');
      const city = match[2].trim();
      if (name && city) return { name: name.slice(0, 120), city: city.slice(0, 80) };
    }
  }
  return {};
}

function hotelStayDates(body: string): { checkIn?: string; checkOut?: string } {
  const lines = body.split(/\r?\n|(?<=[.!?])\s+/).map((line) => line.trim());
  const isoIn = lines
    .map(
      (line) =>
        /^(?:hotel\s+)?(?:check[- ]?in|arrival date)\s*[:=-]\s*(20\d{2}-\d{2}-\d{2})\b/i.exec(
          line,
        )?.[1],
    )
    .find(Boolean);
  const isoOut = lines
    .map(
      (line) =>
        /^(?:hotel\s+)?(?:check[- ]?out|departure date)\s*[:=-]\s*(20\d{2}-\d{2}-\d{2})\b/i.exec(
          line,
        )?.[1],
    )
    .find(Boolean);
  if (isoIn || isoOut)
    return { ...(isoIn ? { checkIn: isoIn } : {}), ...(isoOut ? { checkOut: isoOut } : {}) };
  const namedInLine = lines.find((line) =>
    /^(?:hotel\s+)?(?:check[- ]?in|arrival date)\s*[:=-]/i.test(line),
  );
  const namedOutLine = lines.find((line) =>
    /^(?:hotel\s+)?(?:check[- ]?out|departure date)\s*[:=-]/i.test(line),
  );
  const monthDate = (line: string | undefined) =>
    line
      ? /^(?:hotel\s+)?(?:check[- ]?in|check[- ]?out|arrival date|departure date)\s*[:=-]\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s+(20\d{2}))?\b/i.exec(
          line,
        )
      : null;
  const namedIn = monthDate(namedInLine);
  const namedOut = monthDate(namedOutLine);
  if (namedIn || namedOut) {
    const toIso = (match: RegExpExecArray | null): string | undefined => {
      if (!match?.[1] || !match[2]) return undefined;
      const year = match[3];
      if (!year) return undefined;
      const month = new Date(`${match[1]} 1, 2000`).getMonth() + 1;
      const value = `${year}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
      return validDate(value) ? value : undefined;
    };
    const checkIn = toIso(namedIn);
    const checkOut = toIso(namedOut);
    if (checkIn || checkOut)
      return { ...(checkIn ? { checkIn } : {}), ...(checkOut ? { checkOut } : {}) };
  }
  const range = lines
    .map((line) =>
      /^(?:hotel\s+)?(?:stay(?:\s+dates?)?|reservation dates?|booking dates?|dates)\s*[:=-]\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:\s*[-–—]\s*(?:(January|February|March|April|May|June|July|August|September|October|November|December)\s+)?(\d{1,2}))?,?\s*(20\d{2})[.]?\s*$/i.exec(
        line,
      ),
    )
    .find(Boolean);
  if (!range?.[1] || !range[2] || !range[4] || !range[5]) return {};
  const monthIndex = (month: string) => new Date(`${month} 1, 2000`).getMonth() + 1;
  const startMonth = monthIndex(range[1]);
  const endMonth = monthIndex(range[3] ?? range[1]);
  const year = Number(range[5]);
  const checkIn = `${year}-${String(startMonth).padStart(2, '0')}-${range[2].padStart(2, '0')}`;
  const checkOut = `${year}-${String(endMonth).padStart(2, '0')}-${range[4].padStart(2, '0')}`;
  return validDate(checkIn) && validDate(checkOut) ? { checkIn, checkOut } : {};
}

function validDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizePlace(value: string): string {
  return value
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function sourceCivilDate(event: Record<string, unknown>): string | undefined {
  const start = object(event.start);
  const raw = text(start?.dateTime ?? start?.date ?? event.start, 80);
  if (/^20\d{2}-\d{2}-\d{2}$/.test(raw)) return validDate(raw) ? raw : undefined;
  if (!/^20\d{2}-\d{2}-\d{2}T/.test(raw) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return undefined;
  const instant = new Date(raw);
  if (!Number.isFinite(instant.getTime())) return undefined;
  const timeZone = text(event.timeZone, 120);
  if (timeZone) {
    if (!validTimeZone(timeZone)) return undefined;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const date = `${values.year}-${values.month}-${values.day}`;
    return validDate(date) ? date : undefined;
  }
  const localDate = raw.slice(0, 10);
  return validDate(localDate) ? localDate : undefined;
}

function civilDateInTimeZone(instantValue: string, timeZone: string): string | undefined {
  const instant = new Date(instantValue);
  if (!Number.isFinite(instant.getTime()) || !validTimeZone(timeZone)) return undefined;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  return validDate(date) ? date : undefined;
}

function destinationCivilDate(flight: CompoundTripFlightCandidate): string | undefined {
  if (flight.itineraryHasConnections)
    return flight.itineraryConnectionChainComplete ? flight.itineraryArrivalDate : undefined;
  if (flight.itineraryArrivalDate) return flight.itineraryArrivalDate;
  if (flight.segment?.arrivalDate) return flight.segment.arrivalDate;
  const end = object(flight.event.end);
  const endValue = text(end?.dateTime ?? end?.date ?? flight.event.end, 80);
  if (/^20\d{2}-\d{2}-\d{2}(?:T|$)/.test(endValue)) return endValue.slice(0, 10);
  return sourceCivilDate(flight.event);
}

function sourceOffset(rawStart: unknown): string | undefined {
  if (typeof rawStart !== 'string') return undefined;
  if (rawStart.endsWith('Z')) return 'UTC';
  return /(\+|-)\d{2}:?\d{2}$/.exec(rawStart)?.[0];
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function threadSourceLinks(threads: ReadonlyArray<ReadToolEvidence>): Map<string, string> {
  const links = new Map<string, string>();
  for (const row of threads) {
    const threadId = text(object(row.args)?.threadId, 100);
    if (threadId && /^[A-Za-z0-9_-]{3,100}$/.test(threadId))
      links.set(threadId, `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`);
  }
  return links;
}

function calendarSource(event: Record<string, unknown>): string {
  const links = Array.isArray(event.links) ? event.links.map(object).filter(Boolean) : [];
  const raw = links.find((link) => link?.type === 'calendar')?.url;
  if (typeof raw !== 'string') return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      ['calendar.google.com', 'www.google.com'].includes(url.hostname) &&
      url.pathname === '/calendar/event'
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

function calendarField(event: Record<string, unknown>, edge: 'start' | 'end'): string {
  const value = event[edge];
  const wrapped = object(value);
  return text(wrapped?.dateTime ?? wrapped?.date ?? value, 80);
}

function calendarObservationOverlaps(
  event: Record<string, unknown>,
  request: PersonalReadRequest,
): boolean {
  const start = calendarField(event, 'start');
  const end = calendarField(event, 'end');
  const windowStart = Date.parse(request.timeWindow?.timeMin ?? '');
  const windowEnd = Date.parse(request.timeWindow?.timeMax ?? '');
  if (!start || !Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) return false;

  const startInstant = Date.parse(start);
  const endInstant = Date.parse(end);
  const hasExplicitOffset = (value: string) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const startIsInstant =
    /T/.test(start) && hasExplicitOffset(start) && Number.isFinite(startInstant);
  const endIsInstant = /T/.test(end) && hasExplicitOffset(end) && Number.isFinite(endInstant);
  if (startIsInstant) {
    return (
      startInstant < windowEnd &&
      (endIsInstant ? endInstant > windowStart : startInstant >= windowStart)
    );
  }

  // All-day Calendar dates are civil dates, not UTC instants. Compare their
  // recorded half-open range against the requested window's civil dates and
  // do not reinterpret the end as a checkout date.
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(start) || !validDate(start)) return false;
  const zone = validTimeZone(event.timeZone) ? String(event.timeZone) : (request.timeZone ?? 'UTC');
  const windowStartDate = civilDateInTimeZone(new Date(windowStart).toISOString(), zone);
  const windowEndDate = civilDateInTimeZone(new Date(windowEnd - 1).toISOString(), zone);
  if (!windowStartDate || !windowEndDate) return false;
  const explicitEnd = /^20\d{2}-\d{2}-\d{2}$/.test(end) && validDate(end);
  if (end && !explicitEnd) return false;
  const recordedEnd = explicitEnd
    ? end
    : new Date(Date.parse(`${start}T00:00:00.000Z`) + 24 * 60 * 60_000).toISOString().slice(0, 10);
  if (recordedEnd <= start) return false;
  return start <= windowEndDate && recordedEnd > windowStartDate;
}

function calendarObservationDirection(
  event: Record<string, unknown>,
): 'return' | 'outbound' | 'unknown' {
  const labels = `${text(event.summary, 240)}\n${text(event.description, 1200)}`;
  const returnLabel =
    /\b(?:return|inbound|homebound)\s+flight\b|\bflight\s+direction\s*[:=-]\s*(?:return|inbound|homebound)\b/i.test(
      labels,
    ) &&
    !/\b(?:not|no|never|isn't|is not)\s+(?:a\s+)?(?:return|inbound|homebound)\s+flight\b/i.test(
      labels,
    );
  const outboundLabel =
    /\b(?:outbound|departing)\s+flight\b|\bflight\s+direction\s*[:=-]\s*outbound\b/i.test(labels) &&
    !/\b(?:not|no|never|isn't|is not)\s+(?:an?\s+)?(?:outbound|departing)\s+flight\b/i.test(labels);
  if (returnLabel === outboundLabel) return 'unknown';
  return returnLabel ? 'return' : 'outbound';
}

function calendarObservationLines(
  request: PersonalReadRequest,
  rows: ReadonlyArray<ReadToolEvidence>,
  representedFlights: ReadonlyArray<CompoundTripFlightCandidate | undefined>,
  hasDisplayedLodging: boolean,
  allowFlightObservation: boolean,
): string[] {
  const events = rows.flatMap((row) => {
    const resultEvents = object(row.result)?.events;
    return Array.isArray(resultEvents) ? resultEvents.map(object).filter(Boolean) : [];
  });
  const unique = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (!event || text(event.status).toLowerCase() === 'cancelled') continue;
    const id = text(event.eventId, 160);
    const start = calendarField(event, 'start');
    const summary = text(event.summary, 240);
    if (!id || !start || !summary || !calendarObservationOverlaps(event, request)) continue;
    if (!unique.has(id)) unique.set(id, event);
  }

  const representedEventIds = new Set(
    representedFlights.map((flight) => text(flight?.event.eventId, 160)).filter(Boolean),
  );
  const flightCandidate = allowFlightObservation
    ? flightCandidates(request, rows)
        .filter(
          (candidate) =>
            !representedEventIds.has(text(candidate.event.eventId, 160)) &&
            Boolean(calendarSource(candidate.event)),
        )
        .sort((left, right) => Date.parse(left.instant) - Date.parse(right.instant))[0]
    : undefined;

  const lodgingEvent = hasDisplayedLodging
    ? undefined
    : [...unique.values()]
        .filter((event) => {
          // Description text is consulted only to classify a calendar record
          // as lodging; it is never rendered or used to link it to a flight.
          const details = `${text(event.summary, 240)}\n${text(event.location, 300)}\n${text(event.description, 1200)}`;
          return (
            /\b(?:hotel|lodging|accommodation|stay|check[ -]in|check[ -]out)\b/i.test(details) &&
            Boolean(calendarSource(event))
          );
        })
        .sort((left, right) =>
          calendarField(left, 'start').localeCompare(calendarField(right, 'start')),
        )[0];

  const lines: string[] = [];
  if (flightCandidate) {
    const event = flightCandidate.event;
    const start = calendarField(event, 'start');
    const title = markdownText(text(event.summary, 100));
    const direction =
      calendarObservationDirection(event) === 'return'
        ? 'The calendar labels its direction as a return.'
        : calendarObservationDirection(event) === 'outbound'
          ? 'The calendar labels its direction as outbound.'
          : 'The calendar does not state its direction.';
    lines.push(
      `Flight calendar observation only — not a verified next-flight or itinerary match: ${title}; recorded start ${markdownText(start)}. ${direction} [Calendar source](${calendarSource(event)}).`,
    );
  }
  if (lodgingEvent) {
    const title = markdownText(text(lodgingEvent.summary, 100));
    const start = markdownText(calendarField(lodgingEvent, 'start'));
    const end = calendarField(lodgingEvent, 'end');
    const recordedRange = end ? `${start} to ${markdownText(end)}` : start;
    lines.push(
      `Lodging calendar observation only — not a booking confirmation or link to a flight: ${title}; recorded calendar date/time fields ${recordedRange}. ${end ? 'The end field is shown as recorded, not interpreted as checkout.' : 'No end or checkout date is inferred.'} [Calendar source](${calendarSource(lodgingEvent)}).`,
    );
  }
  return lines;
}

export function compoundTripWebQuery(
  flight: CompoundTripFlightCandidate,
  hotel: CompoundTripHotelCandidate,
): string | undefined {
  if (!flight.arrivalAirport || !hotel.hotelName || !hotel.city) return undefined;
  return `"${flight.arrivalAirport}" public transport taxi "${hotel.hotelName}" "${hotel.city}" official`;
}

export function compoundTripFetchTargets(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): Array<{ mode: 'public transport' | 'taxi'; url: string }> {
  const projection = compoundTripReadProjection(request, evidence);
  return projection.webSearch
    ? compoundTripFetchTargetsFromResult({
        toolName: 'web.search',
        status: 'succeeded',
        result: projection.webSearch,
      })
    : [];
}

export function compoundTripRoute(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): { origin: string; destination: string } | undefined {
  const projection = compoundTripReadProjection(request, evidence);
  if (!projection.routeOrigin || !projection.routeDestination) return undefined;
  return {
    origin: projection.routeOrigin,
    destination: projection.routeDestination,
  };
}

export function compoundTripReadProjection(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
  extractedFacts?: CompoundTripExtraction,
): CompoundTripReadProjection {
  const calendarRows = currentCalendarRows(request, evidence);
  const gmailSearchRows = currentGmailRows(request, evidence);
  const readThreads = currentGmailThreads(gmailSearchRows, evidence);
  const calendarComplete =
    calendarRows.length > 0 &&
    calendarRows.length <= MAX_COMPOUND_CALENDAR_COVERAGE_PAGES &&
    calendarRows.every((row) => {
      const result = object(row.result);
      return (
        result?.calendarRosterComplete === true &&
        result.paginationUnavailable !== true &&
        Array.isArray(result.unavailable) &&
        result.unavailable.length === 0
      );
    }) &&
    object(calendarRows.at(-1)?.result)?.complete === true &&
    typeof object(calendarRows.at(-1)?.result)?.nextPageToken !== 'string';
  const mailQueries =
    request.mailQueries?.map((entry) => entry.query) ??
    (request.mailQuery ? [request.mailQuery] : []);
  const gmailSearchComplete =
    mailQueries.length > 0 &&
    mailQueries.every((query) =>
      completeSearchQuery(
        gmailSearchRows.filter(
          (row) => text(object(row.args)?.query, 4096)?.toLowerCase() === query.toLowerCase(),
        ),
        query,
      ),
    );
  const threadIds = new Set(
    gmailSearchRows.flatMap((row) => {
      const results = object(row.result)?.results;
      return Array.isArray(results)
        ? results.map((item) => text(object(item)?.threadId, 100)).filter(Boolean)
        : [];
    }),
  );
  const completeIds = completeThreadIds(readThreads);
  const allThreadsRead =
    threadIds.size === 0
      ? gmailSearchRows.length > 0
      : [...threadIds].every((id) => completeIds.has(id));
  const completeThreads = readThreads.filter((row) =>
    completeIds.has(text(object(row.args)?.threadId, 100)),
  );
  const sourceMessages = threadMessages(completeThreads);
  const tripExtraction = extractedFacts ?? compoundTripExtractionFromEvidence(evidence);
  const flightSegments = tripExtraction
    ? tripExtraction.status === 'complete'
      ? tripExtraction.segments
      : []
    : parseFlightSegments(sourceMessages);
  const candidates = flightCandidates(request, calendarRows);
  const selectedFlight = nextOutboundFlight(request, candidates, flightSegments);
  const flight = selectedFlight.flight;
  const returnFlight = selectedFlight.returnFlight;
  const currentTripReturn = selectedFlight.currentTripReturn;
  const flightConfirmation = flight?.segment
    ? completeThreads.find(
        (row) => text(object(row.args)?.threadId, 100) === flight.segment?.threadId,
      )
    : undefined;
  const unmatchedBookingSegments =
    !flight && !selectedFlight.ambiguous && tripExtraction?.status === 'complete'
      ? tripExtraction.segments.filter((segment) => {
          if (segment.direction !== 'outbound') return false;
          const instant = sourceLocalInstant(segment);
          return (
            instant !== undefined &&
            instant >= Date.parse(request.timeWindow?.timeMin ?? '') &&
            instant < Date.parse(request.timeWindow?.timeMax ?? '')
          );
        })
      : [];
  const returnConfirmation = (returnFlight ?? currentTripReturn)?.segment
    ? completeThreads.find(
        (row) =>
          text(object(row.args)?.threadId, 100) ===
          (returnFlight ?? currentTripReturn)?.segment?.threadId,
      )
    : undefined;
  const hotelFlightContext = flight ?? currentTripReturn;
  const hotels = dedupeHotels(
    tripExtraction
      ? tripExtraction.status === 'complete'
        ? extractedHotelCandidates(tripExtraction.hotels, hotelFlightContext)
        : []
      : hotelCandidates(completeThreads, hotelFlightContext),
  );
  const relatedUnconfirmedHotels = hotels.filter(
    (candidate) =>
      candidate.association === 'unlinked' &&
      flight?.direction === 'outbound' &&
      flight.destinationCity &&
      candidate.city &&
      normalizePlace(candidate.city) === normalizePlace(flight.destinationCity) &&
      (!candidate.checkIn || !candidate.checkOut),
  );
  const relevantHotels = [
    ...hotels.filter((candidate) => candidate.association !== 'unlinked'),
    ...relatedUnconfirmedHotels,
  ];
  const hotel = relevantHotels.length === 1 ? relevantHotels[0] : undefined;
  const calendarLodging = calendarLodgingObservation(calendarRows, flight, currentTripReturn);
  // Partial reads may still contain exact, source-local details. Keep these
  // separate from verified trip selection: they never establish which trip is
  // next, connect flight and hotel records, or enable a route query.
  const partialSearchRows = mailQueries.flatMap((query) =>
    validSearchPrefixRows(
      gmailSearchRows.filter(
        (row) => text(object(row.args)?.query, 4096)?.toLowerCase() === query.toLowerCase(),
      ),
      query,
    ),
  );
  const partialReadThreads = currentGmailThreads(partialSearchRows, evidence).filter(
    (row) => !completeIds.has(text(object(row.args)?.threadId, 100)),
  );
  const partialSourceMessages = threadMessages(partialReadThreads);
  const partialFlightSegments =
    tripExtraction?.status === 'complete' ? [] : parseFlightSegments(partialSourceMessages);
  const partialHotelCandidates =
    tripExtraction?.status === 'complete' ? [] : hotelCandidates(partialReadThreads, undefined);
  const partialMailLinks = threadSourceLinks(partialReadThreads);
  const partialSourceLines = [
    ...partialFlightSegments.flatMap((segment) => {
      const link = partialMailLinks.get(segment.threadId);
      return link
        ? [
            `Flight details in a partially read email, not verified as a booking, the next trip, or a match to a calendar flight: ${formatFlightSegment(segment)} [Email source](${link}).`,
          ]
        : [];
    }),
    ...partialHotelCandidates.flatMap((candidate) => {
      const link = partialMailLinks.get(candidate.threadId);
      if (!link) return [];
      const label = candidate.hotelName || candidate.subject || 'Accommodation record';
      const details = [
        candidate.city ? markdownText(candidate.city) : undefined,
        candidate.checkIn && candidate.checkOut
          ? `${candidate.checkIn} to ${candidate.checkOut}`
          : undefined,
      ].filter(Boolean);
      return [
        `Accommodation candidate in a partially read email${details.length ? ` (${details.join('; ')})` : ''}; the reservation is not verified or linked to a flight: ${markdownText(label)} [Email source](${link}).`,
      ];
    }),
  ];
  const selectedItineraryLead = flight?.segment ?? currentTripReturn?.segment;
  const selectedBookingSegments = selectedItineraryLead
    ? flightSegments.filter(
        (segment) =>
          segment.threadId === selectedItineraryLead.threadId &&
          segment.bookingReference === selectedItineraryLead.bookingReference,
      )
    : [];
  const legs = connectionSegments(flight?.segment, selectedBookingSegments);
  const connectionSummary = connectionChainSummary(flight?.segment, legs);
  const returnLead = returnFlight?.segment ?? (!flight ? currentTripReturn?.segment : undefined);
  const returnLegs = connectionSegments(returnLead, selectedBookingSegments);
  const returnConnectionSummary = connectionChainSummary(returnLead, returnLegs);
  const outboundChronology = flight?.segment
    ? flightChronology([flight.segment, ...legs])
    : 'unknown';
  const bookedReturnChronology = returnFlight?.segment
    ? flightChronology([returnFlight.segment, ...returnLegs])
    : undefined;
  const outboundArrival = flight?.segment
    ? sourceLocalDateTimeInstant(
        (legs.at(-1) ?? flight.segment).arrivalDate,
        (legs.at(-1) ?? flight.segment).arrivalTime,
        (legs.at(-1) ?? flight.segment).arrivalTimeZone,
      )
    : undefined;
  const returnDeparture = returnFlight?.segment
    ? sourceLocalInstant(returnFlight.segment)
    : undefined;
  const returnChronology = returnFlight
    ? bookedReturnChronology !== 'valid' ||
      outboundArrival === undefined ||
      returnDeparture === undefined
      ? bookedReturnChronology === 'impossible'
        ? 'impossible'
        : 'unknown'
      : returnDeparture >= outboundArrival
        ? 'valid'
        : 'impossible'
    : undefined;
  const route =
    flight &&
    hotel &&
    !flight.calendarConflicts?.includes('arrival-airport') &&
    outboundChronology === 'valid' &&
    (!returnFlight || returnChronology === 'valid') &&
    (!flight.itineraryHasConnections || flight.itineraryConnectionChainComplete)
      ? compoundTripRouteFromCandidates(flight, hotel)
      : undefined;
  const mapRoute = evidence.find((row) => {
    if (!successful(row) || row.toolName !== 'maps.directions' || !route) return false;
    const args = object(row.args);
    return args?.origin === route.origin && args?.destination === route.destination;
  });
  const mapUrl = safePublicSourceUrl(text(object(mapRoute?.result)?.mapsUrl, 1000))
    ? text(object(mapRoute?.result)?.mapsUrl, 1000)
    : '';
  const webQuery = route && flight && hotel ? compoundTripWebQuery(flight, hotel) : undefined;
  const webSearch = webQuery
    ? evidence.find(
        (row) =>
          successful(row) && row.toolName === 'web.search' && object(row.args)?.query === webQuery,
      )
    : undefined;
  const fetchTargets = webSearch ? compoundTripFetchTargetsFromResult(webSearch) : [];
  const webFetches = fetchTargets.flatMap((target) => {
    const row = evidence.find(
      (item) =>
        item.toolName === 'web.fetch' &&
        object(item.args)?.url === target.url &&
        item.fromCurrentTask !== false,
    );
    if (!row) return [];
    const comparison =
      flight && hotel && webSearch
        ? comparisonFromPage(target.mode, row, webSearch, flight, hotel)
        : undefined;
    const endpointMatched = comparison?.endpointMatched === true;
    return [{ mode: target.mode, row, endpointMatched, ...(comparison ? { comparison } : {}) }];
  });
  const comparison = webFetches.flatMap((item) => (item.comparison ? [item.comparison] : []));
  const clockCandidate = flight ?? returnFlight ?? currentTripReturn;
  const timeInstant = clockCandidate?.segment
    ? sourceLocalInstant(clockCandidate.segment)
    : undefined;
  const calendarInstant = clockCandidate ? Date.parse(clockCandidate.instant) : undefined;
  const departureTimeConflict =
    timeInstant !== undefined &&
    calendarInstant !== undefined &&
    Math.abs(timeInstant - calendarInstant) > 5 * 60_000;
  const departureTimeMatched =
    timeInstant !== undefined &&
    calendarInstant !== undefined &&
    Math.abs(timeInstant - calendarInstant) <= 5 * 60_000;
  const returnTimeInstant = returnFlight?.segment
    ? sourceLocalInstant(returnFlight.segment)
    : undefined;
  const returnCalendarInstant = returnFlight ? Date.parse(returnFlight.instant) : undefined;
  const returnTimeConflict =
    returnTimeInstant !== undefined &&
    returnCalendarInstant !== undefined &&
    Math.abs(returnTimeInstant - returnCalendarInstant) > 5 * 60_000;
  const returnTimeMatched =
    returnTimeInstant !== undefined &&
    returnCalendarInstant !== undefined &&
    Math.abs(returnTimeInstant - returnCalendarInstant) <= 5 * 60_000;
  const gaps: string[] = [];
  if (!calendarComplete)
    gaps.push('Calendar coverage is incomplete, so I cannot establish which flight is next.');
  if (!gmailSearchComplete || !allThreadsRead)
    gaps.push('Booking-email search or thread coverage is incomplete.');
  if (selectedFlight.ambiguous)
    gaps.push(
      'The checked booking and calendar evidence has more than one plausible flight candidate or an unresolved source clock, so I could not choose which leg is next.',
    );
  else if (!flight)
    gaps.push(
      currentTripReturn
        ? 'The checked sources identify a return leg from the current trip, but not a new outbound trip. I need a dated outbound booking and matching calendar entry to plan the next trip.'
        : 'I could not match a dated outbound leg from a fully read booking thread to a calendar flight event. A return event or a flight number alone is not enough to identify the next trip.',
    );
  if (flight && outboundChronology === 'impossible')
    gaps.push(
      'The dated flight legs overlap or run in reverse order, so I could not verify this connection chain.',
    );
  else if (flight && outboundChronology === 'unknown')
    gaps.push(
      'I could not verify the chronological order of every dated flight leg because a departure or arrival clock/time zone is missing or ambiguous.',
    );
  if (returnFlight && returnChronology === 'impossible')
    gaps.push(
      'The booked return leaves before the outbound itinerary arrives, so I could not verify the trip chronology.',
    );
  else if (returnFlight && returnChronology === 'unknown')
    gaps.push(
      'I could not verify that the booked return follows the outbound itinerary because a source clock or time zone is missing or ambiguous.',
    );
  if (relevantHotels.length > 1)
    gaps.push('More than one hotel booking candidate matched; I could not choose one safely.');
  else if (!hotel && partialHotelCandidates.length > 0)
    gaps.push(
      'A hotel candidate appears in a partially read email, so I could not verify its full reservation or link it to a flight.',
    );
  else if (!hotel && completeThreads.length > 0)
    gaps.push('I did not identify a hotel booking candidate in the complete email threads I read.');
  else if (!hotel)
    gaps.push(
      'I could not verify a hotel booking because no complete booking-email thread was read.',
    );
  else if (!hotel.address) gaps.push('The hotel candidate did not include an explicit address.');
  else if (hotel.association === 'unlinked')
    gaps.push(
      'I found the hotel independently, but could not establish that it belongs to this flight itinerary.',
    );
  if (hotel && flight && (!hotel.checkIn || !hotel.checkOut))
    gaps.push('The hotel stay dates were not both explicit in the source.');
  if (flight?.segment && !flight.segment.departureTimeZone)
    gaps.push('The booking email gives a departure clock time but no time-zone label.');
  else if (flight?.segment && !timeInstant)
    gaps.push('The booking email time-zone label could not be safely normalized for comparison.');
  if (departureTimeConflict)
    gaps.push(
      'The dated calendar event and booking email give departure times that differ by more than five minutes after time-zone conversion.',
    );
  if (returnFlight?.segment && !returnFlight.segment.departureTimeZone)
    gaps.push('The booked return leg gives a departure clock time but no time-zone label.');
  else if (returnFlight?.segment && !returnTimeInstant)
    gaps.push('The booked return leg time-zone label could not be safely normalized.');
  if (returnTimeConflict)
    gaps.push(
      'The dated return calendar event and booking email times conflict after time-zone conversion.',
    );
  const selectedFlightConflicts = [flight, returnFlight, currentTripReturn]
    .filter((candidate): candidate is CompoundTripFlightCandidate => Boolean(candidate))
    .flatMap((candidate) => candidate.calendarConflicts ?? []);
  const calendarConflictDetails = [flight, returnFlight, currentTripReturn]
    .filter((candidate): candidate is CompoundTripFlightCandidate => Boolean(candidate))
    .flatMap((candidate) => {
      const segment = candidate.segment;
      if (!segment) return [];
      return [
        candidate.calendarConflicts?.includes('flight-number') && candidate.flightNumber
          ? `Calendar lists flight ${markdownText(candidate.flightNumber)}; the booking thread lists ${markdownText(segment.flightNumber)}.`
          : '',
        candidate.calendarConflicts?.includes('direction') && candidate.calendarDirection
          ? `Calendar labels this leg ${candidate.calendarDirection}; the booking thread labels it ${segment.direction}.`
          : '',
        candidate.calendarConflicts?.includes('arrival-airport') &&
        candidate.calendarReportedArrivalAirport &&
        candidate.arrivalAirport
          ? `Calendar lists arrival at ${candidate.calendarReportedArrivalAirport}; the booking chain ends at ${candidate.arrivalAirport}.`
          : '',
      ].filter(Boolean);
    });
  if (selectedFlightConflicts.includes('flight-number'))
    gaps.push('A calendar flight number differs from the leg in the matching booking reference.');
  if (selectedFlightConflicts.includes('direction'))
    gaps.push('The calendar event direction label conflicts with the dated booking leg.');
  if (selectedFlightConflicts.includes('arrival-airport'))
    gaps.push('The calendar arrival airport conflicts with the dated booking itinerary.');
  const itinerarySegments = [
    ...(flight?.segment ? [flight.segment] : []),
    ...legs,
    ...(returnFlight?.segment ? [returnFlight.segment] : []),
    ...returnLegs,
    ...(!flight && currentTripReturn?.segment ? [currentTripReturn.segment] : []),
  ];
  for (const segment of itinerarySegments) {
    const label =
      segment === flight?.segment
        ? 'outbound'
        : segment === returnFlight?.segment || segment === currentTripReturn?.segment
          ? 'return'
          : 'connecting';
    if (!segment.departureTimeZone)
      gaps.push(
        `The ${label} leg ${segment.flightNumber} has no source-stated departure time zone.`,
      );
    if (!segment.arrivalDate || !segment.arrivalTime)
      gaps.push(
        `The ${label} leg ${segment.flightNumber} has no source-stated arrival date and clock time.`,
      );
    else if (!segment.arrivalTimeZone)
      gaps.push(`The ${label} leg ${segment.flightNumber} has no source-stated arrival time zone.`);
  }
  const bookingMentionsConnection = sourceMessages
    .filter((message) => message.threadId === flight?.segment?.threadId)
    .some((message) => /\b(?:connection|connecting flight|layover|transfer)\b/i.test(message.text));
  const bookingConfirmsNonstop = sourceMessages
    .filter((message) => message.threadId === flight?.segment?.threadId)
    .some((message) => /\b(?:nonstop|non-stop|direct flight)\b/i.test(message.text));
  if (flight && !connectionSummary && !bookingConfirmsNonstop) {
    gaps.push(
      bookingMentionsConnection
        ? 'The booking source mentions a connection, but I could not validate a complete dated airport-to-airport segment chain.'
        : 'The fully read booking thread contains no separately identified connecting leg, so I cannot confirm whether this flight is nonstop.',
    );
  }
  if (route && !mapRoute)
    gaps.push(
      'I could not verify a driving route from the stated arrival airport to the hotel candidate.',
    );
  if (webQuery && !webSearch)
    gaps.push(
      'I could not retrieve public-transport and taxi source results for this candidate route.',
    );
  if (webSearch && !fetchTargets.some((target) => target.mode === 'public transport'))
    gaps.push('The search did not return a public-transport source to inspect.');
  if (webSearch && !fetchTargets.some((target) => target.mode === 'taxi'))
    gaps.push('The search did not return a taxi source to inspect.');
  for (const target of fetchTargets) {
    const fetched = webFetches.find(
      (item) => item.mode === target.mode && object(item.row.args)?.url === target.url,
    );
    if (!fetched || !successful(fetched.row))
      gaps.push(`I could not inspect the ${target.mode} source.`);
    else if (!fetched.endpointMatched)
      gaps.push(`The ${target.mode} page did not establish both route endpoints.`);
  }
  const transitEvidence = comparison.find(
    (item) => item.mode === 'public transport' && item.endpointMatched,
  );
  const taxiEvidence = comparison.find((item) => item.mode === 'taxi' && item.endpointMatched);
  if (transitEvidence && taxiEvidence) {
    if (!transitEvidence.fare)
      gaps.push('The inspected public-transport source did not state a fare for this route.');
    if (!taxiEvidence.fare)
      gaps.push('The inspected taxi source did not state a fare for this route.');
  }
  if (!transitEvidence || !taxiEvidence)
    gaps.push('I did not find checked source text that supports both sides of a route comparison.');
  const partialCalendarLines =
    gaps.length > 0
      ? calendarObservationLines(
          request,
          calendarRows,
          [flight, returnFlight, currentTripReturn],
          hotel !== undefined || calendarLodging !== undefined,
          flight === undefined && returnFlight === undefined && currentTripReturn === undefined,
        )
      : [];
  const calendarUrl = flight
    ? calendarSource(flight.event)
    : currentTripReturn
      ? calendarSource(currentTripReturn.event)
      : '';
  const returnCalendarUrl = returnFlight
    ? calendarSource(returnFlight.event)
    : currentTripReturn
      ? calendarSource(currentTripReturn.event)
      : '';
  const mailLinks = threadSourceLinks(readThreads);
  const flightStart = clockCandidate?.instant;
  const localFlightTime = flightStart
    ? new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: request.timeZone ?? 'UTC',
      }).format(new Date(flightStart))
    : '';
  const itinerary = [
    flight
      ? `Dated outbound leg: ${flight.segment ? formatFlightSegment(flight.segment) : (flight.flightNumber ?? 'flight')}${localFlightTime ? `; Calendar displays ${localFlightTime} in ${request.timeZone ?? 'UTC'}` : ''}${flight.sourceOffset ? ` (calendar source offset ${flight.sourceOffset})` : ''}${departureTimeMatched ? '; the clocks agree after time-zone conversion' : ''}${departureTimeConflict ? '; the clocks conflict after time-zone conversion' : ''}${calendarUrl ? ` [Calendar source](${calendarUrl})` : ''}${flightConfirmation && mailLinks.has(text(object(flightConfirmation.args)?.threadId)) ? ` [dated booking-thread source](${mailLinks.get(text(object(flightConfirmation.args)?.threadId))})` : ''}.`
      : '',
    partialSourceLines.length > 0
      ? `Partial source details, kept separate from the unverified trip selection:\n${partialSourceLines.map((line) => `- ${line}`).join('\n')}`
      : '',
    partialCalendarLines.length > 0
      ? `Calendar observations — not a verified next-trip itinerary:\n${partialCalendarLines.map((line) => `- ${line}`).join('\n')}`
      : '',
    ...unmatchedBookingSegments.map((segment) => {
      const sourceLink = mailLinks.get(segment.threadId);
      return `Future booking candidate, not matched to a calendar flight: ${formatFlightSegment(segment)}${sourceLink ? ` [Booking email](${sourceLink})` : ''}.`;
    }),
    returnFlight?.segment
      ? `Dated return leg from the same booking: ${formatFlightSegment(returnFlight.segment)}${returnTimeMatched ? '; the calendar and booking clocks agree after time-zone conversion' : ''}${returnTimeConflict ? '; the calendar and booking clocks conflict after time-zone conversion' : ''}${returnCalendarUrl ? ` [Calendar source](${returnCalendarUrl})` : ''}${returnConfirmation && mailLinks.has(text(object(returnConfirmation.args)?.threadId)) ? ` [dated booking-thread source](${mailLinks.get(text(object(returnConfirmation.args)?.threadId))})` : ''}.`
      : '',
    !flight && currentTripReturn
      ? `I found a dated return leg from a current trip: ${currentTripReturn.segment ? formatFlightSegment(currentTripReturn.segment) : (currentTripReturn.flightNumber ?? 'flight')}${localFlightTime ? `; Calendar displays ${localFlightTime} in ${request.timeZone ?? 'UTC'}` : ''}${currentTripReturn.sourceOffset ? ` (calendar source offset ${currentTripReturn.sourceOffset})` : ''}${departureTimeMatched ? '; the clocks agree after time-zone conversion' : ''}${departureTimeConflict ? '; the clocks conflict after time-zone conversion' : ''}${returnCalendarUrl ? ` [Calendar source](${returnCalendarUrl})` : ''}${returnConfirmation && mailLinks.has(text(object(returnConfirmation.args)?.threadId)) ? ` [dated booking-thread source](${mailLinks.get(text(object(returnConfirmation.args)?.threadId))})` : ''}. This does not identify a new outbound trip.`
      : '',
    connectionSummary ? `Source-backed connected flight segments: ${connectionSummary}.` : '',
    returnConnectionSummary ? `Source-backed return connections: ${returnConnectionSummary}.` : '',
    departureTimeConflict ? 'The calendar and booking clock times conflict after conversion.' : '',
    ...calendarConflictDetails,
    hotel
      ? `Separately sourced hotel candidate: ${markdownText(hotel.hotelName || hotel.subject)}${hotel.city ? `, ${markdownText(hotel.city)}` : ''}${hotel.address ? ` — ${markdownText(hotel.address)}` : ''}${hotel.checkIn && hotel.checkOut ? ` (${hotel.checkIn} to ${hotel.checkOut})` : ''}${mailLinks.has(hotel.threadId) ? ` [Booking email](${mailLinks.get(hotel.threadId)})` : ''}.`
      : '',
    calendarLodging
      ? `Calendar lodging candidate, not a confirmed hotel booking: ${markdownText(calendarLodging.title)}${calendarLodging.city ? `, ${markdownText(calendarLodging.city)}` : ''} (calendar range ${calendarLodging.dateStart}${calendarLodging.dateEnd ? ` to ${calendarLodging.dateEnd}` : ''})${calendarLodging.sourceUrl ? ` [Calendar source](${calendarLodging.sourceUrl})` : ''}. ${calendarLodging.association === 'shared_reference' ? 'The calendar entry carries the same booking reference.' : 'Its city and date overlap make it a candidate, not proof of the same stay.'}`
      : '',
    hotel?.association === 'shared_reference'
      ? 'The hotel and flight sources share a booking reference.'
      : '',
    hotel?.association === 'date_city_candidate'
      ? 'The hotel was booked separately; its stay dates and city align with this flight, so I treated the connection as an inference rather than a shared booking.'
      : '',
    hotel?.association === 'unlinked' ? 'I could not link this hotel candidate to the flight.' : '',
    mapRoute
      ? `Driving estimate from ${markdownText(route?.origin ?? 'the arrival airport')} to the hotel candidate: ${routeDuration(mapRoute.result)}; this is not a taxi quote.${mapUrl ? ` [Maps route](${mapUrl})` : ''}`
      : '',
    ...comparison.map(
      (item) =>
        `${item.mode === 'public transport' ? 'Public transport' : 'Taxi'} source checked${item.fare ? `; source-reported fare ${item.fare}` : ''}${item.duration ? `; source-reported duration ${item.duration}` : ''}${item.quote ? `; “${markdownText(item.quote)}”` : ''} [${item.title}](${item.url}).`,
    ),
    ...gaps.map((gap) => `Needs confirmation: ${gap}`),
  ].filter(Boolean);
  return {
    calendarRows,
    calendarComplete,
    gmailSearchRows,
    gmailSearchComplete,
    readThreads,
    threadsComplete: allThreadsRead,
    ...(flight ? { flight } : {}),
    ...(returnFlight ? { returnFlight } : {}),
    ...(currentTripReturn ? { currentTripReturn } : {}),
    ...(flightConfirmation
      ? { flightConfirmationThreadId: text(object(flightConfirmation.args)?.threadId, 100) }
      : {}),
    ...(hotel ? { hotel } : {}),
    ...(calendarLodging ? { calendarLodgingObservation: calendarLodging } : {}),
    flightSegments: selectedBookingSegments,
    unmatchedBookingSegments,
    ...(connectionSummary ? { connectionSummary } : {}),
    ...(route ? { routeOrigin: route.origin, routeDestination: route.destination } : {}),
    ...(webQuery ? { webQuery } : {}),
    ...(mapRoute ? { mapRoute: object(mapRoute.result) } : {}),
    ...(webSearch ? { webSearch: object(webSearch.result) } : {}),
    webFetches,
    comparison,
    blocked: gaps.length > 0 || !webSearch,
    text: [
      partialCalendarLines.length > 0 && !flight
        ? 'I checked the available trip sources. Here are limited calendar observations, not a verified itinerary:'
        : `I checked the available trip sources. Here is the ${gaps.length === 0 ? 'source-checked' : 'supported partial'} itinerary:`,
      ...itinerary,
      'I did not book, change, or send anything.',
    ].join('\n\n'),
  };
}

/**
 * Flight-only form of the typed trip projection. It shares the same current-task
 * source validation and candidate selection, but does not make hotel or route
 * evidence a prerequisite for answering a flight question.
 */
export function upcomingFlightReadProjection(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
  extractedFacts?: CompoundTripExtraction,
): UpcomingFlightReadProjection {
  const extraction = bindTripExtractionToCurrentEvidence(
    request,
    evidence,
    extractedFacts ?? compoundTripExtractionFromEvidence(evidence),
  );
  const trip = compoundTripReadProjection(request, evidence, extraction);
  const allSegments =
    extraction?.status === 'complete'
      ? extraction.segments
      : extraction === undefined
        ? parseFlightSegments(threadMessages(compoundTripCompleteSourceThreads(request, evidence)))
        : trip.flightSegments;
  const futureOutboundBookings = new Set(
    allSegments.flatMap((segment) => {
      const instant = sourceLocalInstant(segment);
      return segment.direction === 'outbound' &&
        segment.bookingReference &&
        instant !== undefined &&
        instant >= Date.parse(request.timeWindow?.timeMin ?? '') &&
        instant < Date.parse(request.timeWindow?.timeMax ?? '')
        ? [`${segment.threadId}:${segment.bookingReference}`]
        : [];
    }),
  );
  const unpairedFutureReturns = allSegments.filter(
    (segment) =>
      segment.direction === 'return' &&
      (!segment.bookingReference ||
        !futureOutboundBookings.has(`${segment.threadId}:${segment.bookingReference}`)),
  );
  const returnOnly = nextOutboundFlight(
    request,
    flightCandidates(request, trip.calendarRows),
    unpairedFutureReturns,
  );
  const matchedFlights = [trip.flight, trip.currentTripReturn, returnOnly.currentTripReturn].filter(
    (candidate): candidate is CompoundTripFlightCandidate => candidate !== undefined,
  );
  const uniqueMatchedFlights = [
    ...new Map(
      matchedFlights.map((candidate) => [
        `${candidate.segment?.threadId ?? ''}|${candidate.segment?.messageId ?? ''}|${candidate.segment?.bookingReference ?? ''}|${candidate.instant}`,
        candidate,
      ]),
    ).values(),
  ].sort((left, right) => Date.parse(left.instant) - Date.parse(right.instant));
  const earliestInstant = uniqueMatchedFlights[0]?.instant;
  const earliestMatches = earliestInstant
    ? uniqueMatchedFlights.filter((candidate) => candidate.instant === earliestInstant)
    : [];
  const matchedFlightAmbiguous = earliestMatches.length > 1;
  const flight = matchedFlightAmbiguous ? undefined : earliestMatches[0];
  const calendarCandidates = flight ? [] : flightCandidates(request, trip.calendarRows);
  const firstCalendarInstant = calendarCandidates[0]?.instant;
  const firstCalendarMatches = firstCalendarInstant
    ? calendarCandidates.filter((candidate) => candidate.instant === firstCalendarInstant)
    : [];
  const calendarCandidateAmbiguous = !matchedFlightAmbiguous && firstCalendarMatches.length > 1;
  const calendarCandidate =
    !matchedFlightAmbiguous && !calendarCandidateAmbiguous ? firstCalendarMatches[0] : undefined;
  const selectedFlight = flight ?? calendarCandidate;
  const selectedFlightMatchesTripOutbound = Boolean(
    selectedFlight?.segment &&
      trip.flight?.segment &&
      sameFlightSegment(selectedFlight.segment, trip.flight.segment),
  );
  const matchedSegments = [
    flight?.segment,
    trip.returnFlight?.segment,
    trip.currentTripReturn?.segment,
  ].filter((segment): segment is CompoundTripFlightSegment => segment !== undefined);
  const selectedInstant = selectedFlight
    ? Date.parse(selectedFlight.instant)
    : Number.POSITIVE_INFINITY;
  const selectedDate = selectedFlight
    ? (selectedFlight.segment?.departureDate ?? sourceCivilDate(selectedFlight.event))
    : undefined;
  const startInstant = Date.parse(request.timeWindow?.timeMin ?? '');
  const endInstant = Date.parse(request.timeWindow?.timeMax ?? '');
  const unmatchedFutureSegments = allSegments
    .filter((segment) => {
      if (segment.direction !== 'outbound' && segment.direction !== 'return') return false;
      if (matchedSegments.some((matched) => sameFlightSegment(segment, matched))) return false;
      const instant = sourceLocalInstant(segment);
      if (
        instant === undefined ||
        !Number.isFinite(startInstant) ||
        !Number.isFinite(endInstant) ||
        instant < startInstant ||
        instant >= endInstant
      )
        return false;
      return instant <= selectedInstant || segment.departureDate === selectedDate;
    })
    .sort(
      (left, right) =>
        (sourceLocalInstant(left) ?? Number.POSITIVE_INFINITY) -
        (sourceLocalInstant(right) ?? Number.POSITIVE_INFINITY),
    );
  const firstUnmatchedInstant = unmatchedFutureSegments[0]
    ? sourceLocalInstant(unmatchedFutureSegments[0])
    : undefined;
  const firstUnmatchedMatches = firstUnmatchedInstant
    ? unmatchedFutureSegments.filter(
        (segment) => sourceLocalInstant(segment) === firstUnmatchedInstant,
      )
    : [];
  const unmatchedBookingAmbiguous = firstUnmatchedMatches.length > 1;
  const unmatchedBookingCandidate = unmatchedBookingAmbiguous
    ? undefined
    : firstUnmatchedMatches[0];
  const unmatchedBookingInstant = unmatchedBookingCandidate
    ? sourceLocalInstant(unmatchedBookingCandidate)
    : undefined;
  const unmatchedCandidatePrecedesSelected = Boolean(
    unmatchedBookingInstant !== undefined &&
      Number.isFinite(selectedInstant) &&
      unmatchedBookingInstant < selectedInstant,
  );
  const gaps: string[] = [];
  if (!trip.calendarComplete)
    gaps.push('Calendar search coverage is incomplete, so an earlier flight may be missing.');
  if (!trip.gmailSearchComplete || !trip.threadsComplete)
    gaps.push(
      'Booking-email search or reads were incomplete, so a matching booking may be missing.',
    );
  if (matchedFlightAmbiguous || calendarCandidateAmbiguous)
    gaps.push(
      'More than one future flight candidate has the same departure instant, so I could not choose one safely.',
    );
  if (unmatchedBookingAmbiguous)
    gaps.push(
      'More than one separate future booking segment has the same departure instant, so I could not select one safely.',
    );
  if (!selectedFlight)
    gaps.push(
      matchedFlightAmbiguous || calendarCandidateAmbiguous
        ? 'I could not identify one unambiguous next flight from the checked sources.'
        : 'I could not identify a dated future flight candidate in the checked calendar.',
    );
  if (selectedFlight?.segment && selectedFlight.itineraryChronology === 'impossible')
    gaps.push('The source-backed flight legs overlap or run in reverse order.');
  else if (selectedFlight?.segment && selectedFlight.itineraryChronology !== 'valid')
    gaps.push('I could not verify the chronological order of the source-backed flight legs.');
  if (selectedFlight?.segment && !selectedFlight.segment.departureTimeZone)
    gaps.push('The booking source does not state the outbound departure time zone.');
  if (selectedFlight?.segment && !selectedFlight.itineraryConnectionChainComplete)
    gaps.push('The booking source does not establish a complete dated connection chain.');
  if (unmatchedBookingCandidate) {
    if (unmatchedBookingInstant !== undefined && Number.isFinite(selectedInstant)) {
      if (unmatchedCandidatePrecedesSelected)
        gaps.push(
          'An earlier booking candidate is not matched to the calendar flight, so I could not establish which source identifies the next flight.',
        );
      else if (unmatchedBookingCandidate.departureDate === selectedDate)
        gaps.push(
          'A separate booking candidate falls on the calendar flight date but is not matched to it; I could not confirm whether the sources describe the same flight.',
        );
    }
  }
  const summary: string[] = [];
  if (selectedFlight) {
    const calendarLink = calendarSource(selectedFlight.event);
    const threadId = selectedFlight.segment?.threadId;
    const links = threadSourceLinks(trip.readThreads);
    const bookingLink = threadId ? links.get(threadId) : undefined;
    const displayTimeZone = selectedFlight.sourceTimeZone ?? request.timeZone ?? 'UTC';
    const calendarTime = selectedFlight.instant
      ? new Intl.DateTimeFormat('en-US', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: displayTimeZone,
        }).format(new Date(selectedFlight.instant))
      : '';
    if (calendarCandidate) {
      const title = markdownText(text(selectedFlight.event.summary, 160) || 'Flight event');
      const candidateDate = sourceCivilDate(selectedFlight.event);
      summary.push(
        `Next future calendar flight candidate: ${title}${candidateDate ? `; calendar date ${candidateDate}` : ''}${calendarTime ? `; calendar time in ${displayTimeZone}: ${calendarTime}` : ''}${calendarLink ? ` [Calendar source](${calendarLink})` : ''}. The calendar time is not verified as departure time; booking identity, flight number, and direction are unconfirmed.`,
      );
    } else {
      const flightLabel = unmatchedCandidatePrecedesSelected
        ? 'Later calendar-matched flight'
        : selectedFlight.segment?.direction === 'return'
          ? 'Next matched future return flight'
          : 'Next matched outbound flight';
      summary.push(
        `${flightLabel}: ${selectedFlight.segment ? formatFlightSegment(selectedFlight.segment) : (selectedFlight.flightNumber ?? 'calendar flight')}${calendarTime ? `; calendar time in ${displayTimeZone}: ${calendarTime}` : ''}${calendarLink ? ` [Calendar](${calendarLink})` : ''}${bookingLink ? ` [Booking email](${bookingLink})` : ''}.`,
      );
    }
    if (selectedFlightMatchesTripOutbound && trip.returnFlight?.segment) {
      const returnCalendarLink = calendarSource(trip.returnFlight.event);
      const returnBookingLink = links.get(trip.returnFlight.segment.threadId);
      summary.push(
        `Booked return flight: ${formatFlightSegment(trip.returnFlight.segment)}${returnCalendarLink ? ` [Calendar](${returnCalendarLink})` : ''}${returnBookingLink ? ` [Booking email](${returnBookingLink})` : ''}.`,
      );
    }
    if (selectedFlightMatchesTripOutbound && trip.connectionSummary)
      summary.push(`Source-backed connecting legs: ${trip.connectionSummary}.`);
  }
  if (unmatchedBookingCandidate) {
    const link = threadSourceLinks(trip.readThreads).get(unmatchedBookingCandidate.threadId);
    const candidateSummary = `${unmatchedCandidatePrecedesSelected ? 'Earlier' : 'Separate'} future booking candidate: ${formatFlightSegment(unmatchedBookingCandidate)}${link ? ` [Booking email](${link})` : ''}. I could not match it to a calendar flight.`;
    if (unmatchedCandidatePrecedesSelected) summary.unshift(candidateSummary);
    else summary.push(candidateSummary);
  }
  return {
    calendarComplete: trip.calendarComplete,
    gmailSearchComplete: trip.gmailSearchComplete,
    threadsComplete: trip.threadsComplete,
    ...(flight ? { flight } : {}),
    ...(trip.returnFlight ? { returnFlight: trip.returnFlight } : {}),
    ...(trip.currentTripReturn ? { currentTripReturn: trip.currentTripReturn } : {}),
    ...(calendarCandidate ? { calendarCandidate } : {}),
    flightSegments: trip.flightSegments,
    unmatchedBookingSegments: unmatchedBookingCandidate ? [unmatchedBookingCandidate] : [],
    blocked: gaps.length > 0 || calendarCandidate !== undefined,
    text: [
      summary.length > 0
        ? summary.join('\n\n')
        : 'I could not verify a dated flight from the checked sources.',
      ...gaps.map((gap) => `Needs confirmation: ${gap}`),
    ].join('\n\n'),
  };
}

function compoundTripRouteFromCandidates(
  flight: CompoundTripFlightCandidate,
  hotel: CompoundTripHotelCandidate,
): { origin: string; destination: string } | undefined {
  const flightDate = destinationCivilDate(flight);
  const dateAndCityMatch = Boolean(
    flightDate &&
      hotel.city &&
      flight.destinationCity &&
      normalizePlace(hotel.city) === normalizePlace(flight.destinationCity) &&
      hotel.checkIn &&
      hotel.checkOut &&
      flightDate === hotel.checkIn &&
      flightDate < hotel.checkOut,
  );
  if (
    !flight.arrivalAirport ||
    !hotel.address ||
    !dateAndCityMatch ||
    (hotel.association !== 'date_city_candidate' && hotel.association !== 'shared_reference')
  )
    return undefined;
  return { origin: `${flight.arrivalAirport} Airport`, destination: hotel.address };
}

function dedupeHotels(candidates: CompoundTripHotelCandidate[]): CompoundTripHotelCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = [
      normalizePlace(candidate.hotelName ?? candidate.subject),
      normalizePlace(candidate.city ?? ''),
      normalizePlace(candidate.address ?? ''),
      candidate.checkIn ?? '',
      candidate.checkOut ?? '',
      candidate.bookingReference ?? '',
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function routeDuration(value: unknown): string {
  const seconds = Number(object(value)?.durationSeconds);
  return Number.isFinite(seconds) && seconds > 0
    ? `${Math.max(1, Math.round(seconds / 60))} minutes`
    : 'duration unavailable';
}

function safePublicSourceUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hostname.length <= 180
    );
  } catch {
    return false;
  }
}

function compoundTripFetchTargetsFromResult(
  row: ReadToolEvidence,
): Array<{ mode: 'public transport' | 'taxi'; url: string }> {
  const results = object(row.result)?.results;
  if (!Array.isArray(results)) return [];
  const candidates = results
    .map(object)
    .filter((result): result is Record<string, unknown> => Boolean(result))
    .flatMap((result) => {
      const url = text(result.url, 1000);
      const title = text(result.title, 200);
      const snippet = text(result.snippet, 400);
      if (!safePublicSourceUrl(url)) return [];
      return [{ url, text: `${title} ${snippet}`.toLowerCase() }];
    });
  const transit = candidates.find((candidate) =>
    /\b(?:public transport|transit|metro|rail|train|bus|airport express)\b/i.test(candidate.text),
  );
  const taxi = candidates.find(
    (candidate) =>
      candidate.url !== transit?.url && /\b(?:taxi|cab|airport transfer)\b/i.test(candidate.text),
  );
  return [
    ...(transit ? [{ mode: 'public transport' as const, url: transit.url }] : []),
    ...(taxi ? [{ mode: 'taxi' as const, url: taxi.url }] : []),
  ];
}

function durationFromQuote(quote: string): string | undefined {
  const match = /\b(\d{1,3})\s*(minutes?|mins?|hours?|hrs?)\b/i.exec(quote);
  if (!match?.[1] || !match[2]) return undefined;
  const amount = Number(match[1]);
  const minutes = /^(?:hours?|hrs?)$/i.test(match[2]) ? amount * 60 : amount;
  return minutes > 0 && minutes <= 24 * 60 ? `${amount} ${match[2].toLowerCase()}` : undefined;
}

function fareFromQuote(quote: string): string | undefined {
  const match =
    /(?:€|EUR\s?)(\d{1,4}(?:[.,]\d{1,2})?)|(?:£|GBP\s?)(\d{1,4}(?:[.,]\d{1,2})?)|(?:\$|USD\s?)(\d{1,4}(?:[.,]\d{1,2})?)/i.exec(
      quote,
    );
  if (!match) return undefined;
  const currency =
    match[0].startsWith('€') || /^EUR/i.test(match[0])
      ? 'EUR'
      : match[0].startsWith('£') || /^GBP/i.test(match[0])
        ? 'GBP'
        : 'USD';
  const amount = match[1] ?? match[2] ?? match[3];
  return amount ? `${currency} ${amount.replace(',', '.')}` : undefined;
}

function sentenceNamesAirport(sentence: string, flight: CompoundTripFlightCandidate): boolean {
  const code = (flight.arrivalAirport ?? flight.segment?.destinationAirport ?? '').trim();
  if (code && new RegExp(`\\b${escapeRegExp(code)}\\b`, 'i').test(sentence)) return true;

  // A city name alone is not an airport endpoint. Accept a source-backed airport
  // name from the calendar location, or an explicit "<destination> Airport" label.
  const location = text(flight.event.location, 300);
  if (/\bairport\b/i.test(location) && sentence.toLowerCase().includes(location.toLowerCase()))
    return true;
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function comparisonFromPage(
  mode: 'public transport' | 'taxi',
  page: ReadToolEvidence,
  search: ReadToolEvidence,
  flight: CompoundTripFlightCandidate,
  hotel: CompoundTripHotelCandidate,
): CompoundTripComparisonEvidence | undefined {
  if (!successful(page) || !successful(search)) return undefined;
  const result = object(page.result);
  const finalUrl = text(result?.finalUrl, 1000);
  if (!safePublicSourceUrl(finalUrl)) return undefined;
  const targetUrl = text(object(page.args)?.url, 1000);
  if (!safePublicSourceUrl(targetUrl)) return undefined;
  const results = object(search.result)?.results;
  const entry = Array.isArray(results)
    ? results.map(object).find((item) => text(item?.url, 1000) === targetUrl)
    : undefined;
  const title = text(entry?.title, 180).replace(/[<>[\]`*_]/g, '');
  const body = text(result?.text, 20_000);
  const airport = (flight.arrivalAirport ?? flight.segment?.destinationAirport ?? '').toLowerCase();
  const hotelName = (hotel.hotelName ?? '').toLowerCase().trim();
  const street = (hotel.address ?? '').split(',')[0]?.toLowerCase().trim() ?? '';
  const destinationAnchor = [hotelName, street].filter((value) => value.length >= 5);
  const hasRouteEndpoints = (sentence: string) =>
    Boolean(
      destinationAnchor.length > 0 &&
        sentenceNamesAirport(sentence, flight) &&
        destinationAnchor.some((anchor) => sentence.toLowerCase().includes(anchor)),
    );
  const endpointMatched = body
    .split(/\r?\n\s*\r?\n/)
    .flatMap((paragraph) => paragraph.split(/(?<=[.!?])\s+|\r?\n/))
    .some((sentence) => sentence.length <= 800 && hasRouteEndpoints(sentence));
  const expectedMode =
    mode === 'taxi'
      ? /\b(?:taxi|cab|ride[- ]?hail)\b/i
      : /\b(?:public transport|transit|metro|rail|train|bus|airport express)\b/i;
  const support = body
    .split(/\r?\n\s*\r?\n/)
    .flatMap((paragraph) => {
      const sentences = paragraph.split(/(?<=[.!?])\s+|\r?\n/).map((part) => part.trim());
      const index = sentences.findIndex(
        (part) =>
          part.length > 0 &&
          part.length <= 800 &&
          expectedMode.test(part) &&
          airport &&
          hasRouteEndpoints(part),
      );
      if (index < 0) return [];
      return sentences[index] ? [sentences[index]] : [];
    })
    .find(Boolean);
  if (!endpointMatched || !support)
    return { mode, title: title || mode, url: finalUrl, endpointMatched };
  const quote = support.replace(/[<>]/g, '').replace(/\s+/g, ' ').slice(0, 240);
  return {
    mode,
    title: title || mode,
    url: finalUrl,
    endpointMatched: true,
    ...(fareFromQuote(support) ? { fare: fareFromQuote(support) } : {}),
    ...(durationFromQuote(support) ? { duration: durationFromQuote(support) } : {}),
    quote,
  };
}

function parseClockMinutes(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 23) return undefined;
  if (match[3]) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (match[3].toUpperCase() === 'PM' ? 12 : 0);
  }
  return hour * 60 + minute;
}

function sourceLocalInstant(segment: CompoundTripFlightSegment): number | undefined {
  return sourceLocalDateTimeInstant(
    segment.departureDate,
    segment.departureTime,
    segment.departureTimeZone,
  );
}

function sourceLocalDateTimeInstant(
  date: string | undefined,
  clock: string | undefined,
  zone: string | undefined,
): number | undefined {
  const minutes = clock ? parseClockMinutes(clock) : undefined;
  if (!date || !/^20\d{2}-\d{2}-\d{2}$/.test(date) || minutes === undefined || !zone)
    return undefined;
  const midnight = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== date)
    return undefined;
  const numeric = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  const localAsUtc = Date.parse(
    `${date}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00Z`,
  );
  if (!Number.isFinite(localAsUtc)) return undefined;
  if (numeric?.[1] && numeric[2] && numeric[3]) {
    if (Number(numeric[2]) > 14 || Number(numeric[3]) > 59) return undefined;
    const offset = (Number(numeric[2]) * 60 + Number(numeric[3])) * (numeric[1] === '+' ? 1 : -1);
    return localAsUtc - offset * 60_000;
  }
  if (!validTimeZone(zone)) return undefined;
  const candidates: number[] = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const instant = localAsUtc - offset * 60_000;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (
      value.year === date.slice(0, 4) &&
      value.month === date.slice(5, 7) &&
      value.day === date.slice(8, 10) &&
      value.hour === String(Math.floor(minutes / 60)).padStart(2, '0') &&
      value.minute === String(minutes % 60).padStart(2, '0')
    )
      candidates.push(instant);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}
