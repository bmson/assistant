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

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+\-=|!]/g, '\\$&');
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
  return evidence.filter((row) => {
    if (!successful(row) || row.toolName !== 'gmail.search') return false;
    return object(row.args)?.query === request.mailQuery;
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
  const continuation = object(result?.continuation);
  const continuationInput = object(continuation?.input);
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
    object(receipt.source)?.id !== query ||
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
        continuation?.tool === 'gmail.search' &&
        continuationInput?.query === query &&
        continuationInput?.maxResults === args.maxResults &&
        continuationInput?.pageToken === nextPageToken &&
        object(receipt.continuation)?.tool === 'gmail.search' &&
        object(object(receipt.continuation)?.input)?.query === query &&
        object(object(receipt.continuation)?.input)?.maxResults === args.maxResults &&
        object(object(receipt.continuation)?.input)?.pageToken === nextPageToken &&
        receipt.losses.includes('provider-page'),
    );
  }
  return (
    result.complete === true &&
    !nextPageToken &&
    !continuation &&
    receipt.continuation === null &&
    receipt.losses.length === 0
  );
}

function completeSearchQuery(rows: ReadonlyArray<ReadToolEvidence>, query: string): boolean {
  if (rows.length === 0 || rows.length > 3) return false;
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
  if (!request.mailQuery) return [];
  const searchPrefix = validSearchPrefixRows(
    currentGmailRows(request, evidence),
    request.mailQuery,
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
      const dateMatches = eventDate === segment.departureDate;
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
      const calendarHasSparseIdentity =
        candidate.direction === 'unknown' || candidate.flightNumber === undefined;
      return (
        directionMatches &&
        numberMatches &&
        dateMatches &&
        referenceMatches &&
        destinationMatches &&
        (!calendarHasSparseIdentity ||
          (segment.direction === expectedDirection &&
            (routeMatches || referenceMatchesStrongly) &&
            timeMatches))
      );
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
    return {
      flight: {
        ...event,
        direction: expectedDirection,
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
    const sameTime = outbounds.filter(
      (candidate) =>
        candidate.departureDate === firstOutbound.departureDate &&
        candidate.departureTime === firstOutbound.departureTime,
    );
    if (sameTime.length > 1) ambiguous = true;
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
        flight?.bookingReference &&
        hotel.bookingReference === flight.bookingReference,
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
      reference && flight?.bookingReference && reference === flight.bookingReference,
    );
    const flightDate = flight ? destinationCivilDate(flight) : undefined;
    const dateCityCandidate = Boolean(
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
    return url.protocol === 'https:' && url.hostname === 'calendar.google.com'
      ? url.toString()
      : '';
  } catch {
    return '';
  }
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
  const gmailSearchComplete =
    typeof request.mailQuery === 'string' &&
    completeSearchQuery(gmailSearchRows, request.mailQuery);
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
  const hotels = dedupeHotels(
    tripExtraction
      ? tripExtraction.status === 'complete'
        ? extractedHotelCandidates(tripExtraction.hotels, flight)
        : []
      : hotelCandidates(completeThreads, flight),
  );
  const hotel = hotels.length === 1 ? hotels[0] : undefined;
  const selectedBookingSegments = flight?.segment
    ? flightSegments.filter(
        (segment) =>
          segment.threadId === flight.segment?.threadId &&
          segment.bookingReference === flight.segment?.bookingReference,
      )
    : [];
  const legs = connectionSegments(flight?.segment, selectedBookingSegments);
  const connectionSummary = connectionChainSummary(flight?.segment, legs);
  const returnLegs = connectionSegments(returnFlight?.segment, selectedBookingSegments);
  const returnConnectionSummary = connectionChainSummary(returnFlight?.segment, returnLegs);
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
  if (hotels.length > 1)
    gaps.push('More than one hotel booking candidate matched; I could not choose one safely.');
  else if (!hotel)
    gaps.push('I could not identify one hotel booking candidate in the checked email threads.');
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
  const itinerarySegments = [
    ...(flight?.segment ? [flight.segment] : []),
    ...legs,
    ...(returnFlight?.segment ? [returnFlight.segment] : []),
    ...returnLegs,
  ];
  for (const segment of itinerarySegments) {
    const label =
      segment === flight?.segment
        ? 'outbound'
        : segment === returnFlight?.segment
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
    hotel
      ? `Separately sourced hotel candidate: ${markdownText(hotel.hotelName || hotel.subject)}${hotel.city ? `, ${markdownText(hotel.city)}` : ''}${hotel.address ? ` — ${markdownText(hotel.address)}` : ''}${hotel.checkIn && hotel.checkOut ? ` (${hotel.checkIn} to ${hotel.checkOut})` : ''}${mailLinks.has(hotel.threadId) ? ` [Booking email](${mailLinks.get(hotel.threadId)})` : ''}.`
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
      `I checked the available trip sources. Here is the ${gaps.length === 0 ? 'source-checked' : 'supported partial'} itinerary:`,
      ...itinerary,
      'I did not book, change, or send anything.',
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
