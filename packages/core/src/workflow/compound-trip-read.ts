import { gmailSearchReceiptSourceId } from '@assistant/persistence/gmail-search-identity';
import type { CompoundTripExtraction, CompoundTripHotelFact } from './compound-trip-extraction.js';
import type { PersonalReadRequest, ReadToolEvidence } from './read-intent.js';

export const MAX_COMPOUND_CALENDAR_COVERAGE_PAGES = 3;
export const MAX_COMPOUND_TRIP_TOOL_CALLS = 16;
export const MAX_COMPOUND_TRIP_THREADS_TO_READ = 6;
const MAX_COMPOUND_CALENDAR_CURSOR_LENGTH = 2_000_000;

function compoundCalendarCursor(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' && value.length <= MAX_COMPOUND_CALENDAR_CURSOR_LENGTH
    ? value
    : null;
}

export interface CompoundTripFlightSegment {
  threadId: string;
  messageId: string;
  subject: string;
  bookingReference?: string;
  /** A source-stated table reference, used only for observation comparisons. */
  itineraryReference?: string;
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
  calendarCarrier?: string;
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
  messageId?: string;
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
  bookingObservationLines?: string[];
  connectionSummary?: string;
  comparison: CompoundTripComparisonEvidence[];
  blocked: boolean;
  /** Full diagnostic projection; required-read gates consume every gap below. */
  text: string;
  presentation: {
    summary: string;
    groups: Array<{ label: string; inferred: boolean; legs: CompoundTripFlightSegment[] }>;
    hotels: CompoundTripHotelCandidate[];
    calendarNotes: string[];
    calendarObservations: string[];
    gaps: string[];
    associationInferred: boolean;
    localClocks: boolean;
  };
}

export interface UpcomingFlightReadProjection {
  calendarComplete: boolean;
  /** True only when ordered calendar pages prove coverage through this matched candidate. */
  calendarPrefixCompleteThroughCandidate: boolean;
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

/**
 * Select a bounded, source-diverse set of trip mail threads. Search metadata
 * only ranks candidates; the selected threads still require complete reads
 * before any booking facts are used.
 */
export function compoundTripThreadIdsToRead(
  evidence: ReadonlyArray<ReadToolEvidence>,
  request: PersonalReadRequest,
): string[] {
  const metadata = new Map<string, { subject: string; snippet: string; categories: Set<string> }>();
  if (request.explicitSource === 'mail') {
    return [
      ...new Set(
        evidence
          .filter(
            (row) =>
              row.fromCurrentTask !== false &&
              successful(row) &&
              row.toolName === 'gmail.search' &&
              object(row.args)?.query === request.mailQuery,
          )
          .flatMap((row) => {
            const results = object(row.result)?.results;
            return Array.isArray(results)
              ? results.flatMap((raw) => {
                  const id = text(object(raw)?.threadId, 100);
                  return id ? [id] : [];
                })
              : [];
          }),
      ),
    ].slice(0, 3);
  }
  const calendarLodgingTitles = evidence.flatMap((row) => {
    if (
      row.fromCurrentTask === false ||
      !successful(row) ||
      row.toolName !== 'calendar.list_events'
    )
      return [];
    const events = object(row.result)?.events;
    if (!Array.isArray(events)) return [];
    return events.flatMap((value) => {
      const event = object(value);
      const title = text(event?.summary, 240);
      const details = `${title}\n${text(event?.description, 1200)}`;
      return title && /\b(?:hotel|lodging|check[- ]?in|check[- ]?out)\b/i.test(details)
        ? [title.toLowerCase()]
        : [];
    });
  });
  const matchesCalendarLodgingTitle = (subject: string) =>
    calendarLodgingTitles.some(
      (title) => title.length >= 12 && subject.toLowerCase().includes(title),
    );
  const unique: string[] = [];
  for (const row of evidence) {
    if (row.fromCurrentTask === false || !successful(row) || row.toolName !== 'gmail.search')
      continue;
    const query = text(object(row.args)?.query, 4096).toLowerCase();
    const category = request.mailQueries?.find(
      (entry) => entry.query.toLowerCase() === query,
    )?.category;
    if (!category && request.mailQueries?.length) continue;
    const results = object(row.result)?.results;
    if (!Array.isArray(results)) continue;
    for (const item of results) {
      const result = object(item);
      const id = text(result?.threadId, 100);
      if (!id) continue;
      if (!metadata.has(id)) unique.push(id);
      const prior = metadata.get(id);
      const categories = prior?.categories ?? new Set<string>();
      if (category) categories.add(category);
      metadata.set(id, {
        subject: [prior?.subject, text(result?.subject, 240)].filter(Boolean).join(' '),
        snippet: [prior?.snippet, text(result?.snippet, 500)].filter(Boolean).join(' '),
        categories,
      });
    }
  }
  const strongEditorialSubject = (subject: string) =>
    /\b(?:newsletters?|news|digest|offers?|deals?|advice|trends?|product\s+updates?|promotions?|marketing|market\s+news|weekly\s+guides?|coupons?|discounts?|sponsored|press\s+releases?)\b/i.test(
      subject,
    );
  const clearlyNonTravelSubject = (subject: string) =>
    /\b(?:software\s+subscriptions?|subscription\s+(?:renewals?|receipts?|invoices?)|shower|spa|lounge|survey|evaluate)\b/i.test(
      subject,
    );
  const bookingSubjectCue = (subject: string) =>
    /\b(?:booked|reserved|confirmation|confirmed|reservation|ticket|e-?ticket|itinerary|record locator|booking\s+(?:details|reference|receipt|number|confirmation))\b/i.test(
      subject,
    );
  const clearlyEditorialOrPromotional = (subject: string, snippet: string) => {
    if (clearlyNonTravelSubject(subject) || strongEditorialSubject(subject)) return true;
    if (/\b(?:reservation|purchase)\b/i.test(subject) && /\b(?:shower|spa|lounge)\b/i.test(snippet))
      return true;
    // A direct booking-like subject is stronger than incidental promotional
    // language in the snippet, which can come from a footer or search excerpt.
    if (bookingSubjectCue(subject)) return false;
    return /\b(?:newsletters?|news|digest|offers?|deals?|advice|trends?|product\s+updates?|promotions?|marketing|market\s+news|weekly\s+guides?|coupons?|discounts?|sponsored|press\s+releases?|software\s+subscriptions?|subscription\s+(?:renewals?|receipts?|invoices?))\b/i.test(
      `${subject} ${snippet}`,
    );
  };
  const sourceMatches = (id: string, kind: 'flight' | 'lodging') => {
    const item = metadata.get(id);
    const subject = item?.subject ?? '';
    const snippet = item?.snippet ?? '';
    const source = `${subject} ${snippet}`;
    if (clearlyEditorialOrPromotional(subject, snippet)) return false;
    if (kind === 'flight') {
      const booking =
        /\b(?:booked|reserved|confirmation|confirmed|reservation|ticket|e-?ticket|itinerary|record locator|booking\s+(?:details|reference|receipt|number|confirmation))\b/i.test(
          source,
        );
      const itinerarySubject = /^(?:(?:fw|fwd|re)\s*:\s*)*flight\s*[-–—:]/i.test(subject);
      const flightTerm =
        /\b(?:flight|airline|itinerary|boarding pass|e-?ticket|record locator)\b/i.test(source) ||
        (/\bconfirmation\s+code\b/i.test(subject) && /\b[A-Z]{2,3}\s+\d{1,4}\b/.test(subject));
      return (
        (item?.categories.has('flight') === true || !request.mailQueries?.length) &&
        flightTerm &&
        (booking || itinerarySubject)
      );
    }
    return (
      (item?.categories.has('lodging') === true ||
        !request.mailQueries?.length ||
        matchesCalendarLodgingTitle(subject)) &&
      (/\b(?:hotels?|accommodation|lodging|airbnb|guesthouse|hostel|inn|resort)\b/i.test(source) ||
        matchesCalendarLodgingTitle(subject)) &&
      (matchesCalendarLodgingTitle(subject) ||
        /\b(?:booked|reserved|confirmed|reservation|confirmation|check[- ]?in|booking\s+(?:details|reference|receipt|number|confirmation))\b/i.test(
          source,
        ))
    );
  };
  // A complete itinerary is more useful than a generic ancillary purchase.
  // Ranking still authorizes only reads; source bodies must verify every fact.
  const ranked = [...unique].sort((left, right) => {
    const score = (id: string) => {
      const subject = metadata.get(id)?.subject ?? '';
      return /^(?:(?:fw|fwd|re)\s*:\s*)*flight\s*[-–—:]\s*booked\b/i.test(subject)
        ? 4
        : /\bconfirmation\s+code\b/i.test(subject)
          ? 3
          : matchesCalendarLodgingTitle(subject)
            ? 2
            : /\b(?:purchase|payment)\b/i.test(subject)
              ? -1
              : 0;
    };
    return score(right) - score(left);
  });
  const first = (kind: 'flight' | 'lodging') => ranked.find((id) => sourceMatches(id, kind));
  const genericLodgingCandidate = ranked.find((id) => {
    const item = metadata.get(id);
    if (!item?.categories.has('lodging')) return false;
    const subject = item.subject;
    const source = `${subject} ${item.snippet}`;
    // Some provider results from a lodging query expose only a generic
    // reservation subject (for example, "Your Online Reservation"). Read at
    // most one such candidate when no lodging-specific result is available;
    // this metadata can only prioritize a read, never establish a stay.
    return (
      /\b(?:reservation|booking)\b/i.test(source) &&
      !clearlyEditorialOrPromotional(subject, item.snippet)
    );
  });
  const priority = [first('flight')];
  if (request.compoundTripDiscovery) priority.push(first('lodging') ?? genericLodgingCandidate);
  const secondFlight = ranked.find((id) => sourceMatches(id, 'flight') && id !== priority[0]);
  if (secondFlight) priority.push(secondFlight);
  return [
    ...new Set([
      ...priority.filter((id): id is string => Boolean(id)),
      // Search ranking may miss a real confirmation whose metadata is generic.
      // Read a small, distinct sample from the complete category results before
      // reporting all searched mail as covered; the thread content remains the
      // only source of verified booking facts.
      ...unique.filter((id) => {
        const item = metadata.get(id);
        return !clearlyEditorialOrPromotional(item?.subject ?? '', item?.snippet ?? '');
      }),
    ]),
  ].slice(0, MAX_COMPOUND_TRIP_THREADS_TO_READ);
}

/** Runtime-grounded bounded batch of current-task trip thread reads. */
export function compoundTripThreadReadInputs(
  evidence: ReadonlyArray<ReadToolEvidence>,
  request: PersonalReadRequest,
): Array<Record<string, unknown>> {
  if (
    !(
      request.compoundTripDiscovery ||
      request.upcomingFlightDiscovery ||
      request.explicitSource === 'mail'
    )
  )
    return [];
  const inputs: Array<Record<string, unknown>> = [];
  // Keep selection local to this module: read-intent imports the helper above,
  // so calling back into gmailThreadIdsToRead here would create a runtime cycle.
  const selectedThreadIds = compoundTripThreadIdsToRead(evidence, request).slice(
    0,
    request.compoundTripDiscovery
      ? MAX_COMPOUND_TRIP_THREADS_TO_READ
      : request.explicitSource === 'mail'
        ? 3
        : 2,
  );
  for (const threadId of selectedThreadIds) {
    const attempts = evidence.filter(
      (row) =>
        row.fromCurrentTask !== false &&
        row.toolName === 'gmail.read_thread' &&
        object(row.args)?.threadId === threadId,
    );
    const pages = attempts.filter(successful);
    if (pages.length === 0) {
      if (attempts.length < 2)
        inputs.push({
          threadId,
          startMessageIndex: 0,
          startMessageOffset: 0,
          maxMessages: 20,
          maxChars: 20_000,
        });
      continue;
    }
    const latest = pages.at(-1);
    const result = object(latest?.result);
    if (result?.complete === true || pages.length >= 2 || attempts.length >= 2) continue;
    const continuation = object(result?.continuation);
    const input = object(continuation?.input);
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
      inputs.push(input);
  }
  return inputs;
}

function text(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function markdownText(value: string): string {
  // Parentheses are safe in ordinary text nodes. Escaping them leaks the
  // Markdown backslashes in clients that render this projection as plain text.
  // Brackets and other delimiters remain escaped so source text cannot create
  // links or formatting when the same string is rendered as Markdown.
  return value.replace(/[\\`*_{}[\]<>#+=|!]/g, '\\$&');
}

function calendarFlightDetails(event: Record<string, unknown>): string | undefined {
  const summary = text(event.summary, 240);
  const details = `${summary}\n${text(event.description, 1200)}\n${text(event.location, 300)}`;
  if (
    /\b(?:hotel|lodging|check[- ]?in|check[- ]?out)\b/i.test(details) &&
    !/\b(?:flight|airline|boarding pass)\b/i.test(summary) &&
    !calendarFlightNumber(summary)
  )
    return undefined;
  if (/\b(?:flight|airline|boarding pass)\b/i.test(details)) return details;
  // An itinerary identifier is also common in hotel records. It requires
  // independent flight evidence before it can create a flight candidate.
  return /\bitinerary\b/i.test(details) && (calendarFlightNumber(details) || airportRoute(details))
    ? details
    : undefined;
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

function calendarPageChainComplete(rows: ReadonlyArray<ReadToolEvidence>): boolean {
  if (rows.length === 0 || rows.length > MAX_COMPOUND_CALENDAR_COVERAGE_PAGES) return false;
  const remaining = new Set(rows);
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let index = 0; index < rows.length; index += 1) {
    const cursorKey = cursor ?? '<first-page>';
    if (seen.has(cursorKey)) return false;
    seen.add(cursorKey);
    const page = rows.find((row) => {
      if (!remaining.has(row)) return false;
      const pageCursor = compoundCalendarCursor(object(row.args)?.pageToken);
      return pageCursor !== null && pageCursor === cursor;
    });
    if (!page) return false;
    remaining.delete(page);
    const result = object(page.result);
    if (!result) return false;
    const next = compoundCalendarCursor(result.nextPageToken);
    if (next === null) return false;
    if (next) {
      if (index === rows.length - 1 || seen.has(next)) return false;
      cursor = next;
      continue;
    }
    return result.complete === true && index === rows.length - 1 && remaining.size === 0;
  }
  return false;
}

function calendarPrefixCoversCandidate(
  rows: ReadonlyArray<ReadToolEvidence>,
  candidate: CompoundTripFlightCandidate | undefined,
): boolean {
  if (!candidate || rows.length === 0 || rows.length > MAX_COMPOUND_CALENDAR_COVERAGE_PAGES)
    return false;
  const remaining = new Set(rows);
  const seen = new Set<string>();
  const pages: ReadToolEvidence[] = [];
  let cursor: string | undefined;
  let candidatePage = -1;
  const candidateInstant = Date.parse(candidate.instant);
  let proofPageIndex = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const cursorKey = cursor ?? '<first-page>';
    if (seen.has(cursorKey)) return false;
    seen.add(cursorKey);
    const page = rows.find((row) => {
      if (!remaining.has(row)) return false;
      const pageCursor = compoundCalendarCursor(object(row.args)?.pageToken);
      return pageCursor !== null && pageCursor === cursor;
    });
    if (!page) return false;
    remaining.delete(page);
    const result = object(page.result);
    if (!result) return false;
    pages.push(page);
    const events = Array.isArray(result.events) ? result.events : [];
    if (
      events.some((event) => {
        const item = object(event);
        return (
          item === candidate.event ||
          (text(item?.eventId, 200) === text(candidate.event.eventId, 200) &&
            text(item?.calendarId, 200) === text(candidate.event.calendarId, 200) &&
            text(item?.start, 120) === text(candidate.event.start, 120))
        );
      })
    ) {
      candidatePage = index;
    }
    const coveredThrough = Date.parse(text(result.chronologicalPrefixThrough, 120));
    const lastReturnedEvent = object(events.at(-1));
    const lastReturnedStart = text(lastReturnedEvent?.start, 120);
    const lastReturnedInstant = /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(lastReturnedStart)
      ? Date.parse(lastReturnedStart)
      : Number.NaN;
    if (
      Number.isFinite(candidateInstant) &&
      Number.isFinite(coveredThrough) &&
      coveredThrough === lastReturnedInstant &&
      coveredThrough >= candidateInstant
    )
      proofPageIndex = index;
    const next = compoundCalendarCursor(result.nextPageToken);
    if (next === null) return false;
    if (next) {
      if (seen.has(next)) return false;
      cursor = next;
      continue;
    }
    if (result.complete !== true || index !== rows.length - 1 || remaining.size !== 0) return false;
    break;
  }
  if (remaining.size !== 0 || candidatePage < 0 || candidatePage >= pages.length) return false;

  const firstResult = object(pages[0]?.result);
  const calendars = firstResult?.calendarsResolved;
  const initiallySearched = firstResult?.calendarsSearched;
  if (!Array.isArray(calendars) || calendars.length === 0 || !Array.isArray(initiallySearched))
    return false;
  const roster = calendars.map((value) => object(value));
  if (roster.some((calendar) => !calendar || !text(calendar.id, 512) || !text(calendar.name, 240)))
    return false;
  const calendarIds = roster.map((calendar) => text(calendar?.id, 512));
  const calendarNames = roster.map((calendar) => text(calendar?.name, 240)).sort();
  if (
    new Set(calendarIds).size !== calendarIds.length ||
    calendarIds.length > 50 ||
    initiallySearched.length !== calendarNames.length ||
    initiallySearched
      .map((name) => text(name, 240))
      .sort()
      .some((name, index) => name !== calendarNames[index])
  )
    return false;
  const expectedRoster = JSON.stringify(
    roster.map((calendar) => [text(calendar?.id, 512), text(calendar?.name, 240)]).sort(),
  );
  for (const page of pages) {
    const result = object(page.result);
    const currentRoster = Array.isArray(result?.calendarsResolved)
      ? result.calendarsResolved
          .map((value) => {
            const calendar = object(value);
            return [text(calendar?.id, 512), text(calendar?.name, 240)];
          })
          .sort()
      : [];
    const searched = Array.isArray(result?.calendarsSearched)
      ? result.calendarsSearched.map((name) => text(name, 240))
      : [];
    if (
      result?.calendarRosterComplete !== true ||
      result.paginationUnavailable === true ||
      !Array.isArray(result.unavailable) ||
      result.unavailable.length !== 0 ||
      JSON.stringify(currentRoster) !== expectedRoster ||
      searched.length !== calendarNames.length ||
      searched
        .slice()
        .sort()
        .some((name, index) => name !== calendarNames[index])
    )
      return false;
  }
  return Number.isFinite(candidateInstant) && proofPageIndex >= candidatePage;
}

function hasEarlierUnresolvedAllDayFlight(
  rows: ReadonlyArray<ReadToolEvidence>,
  candidate: CompoundTripFlightCandidate | undefined,
): boolean {
  if (!candidate) return false;
  const candidateInstant = Date.parse(candidate.instant);
  if (!Number.isFinite(candidateInstant)) return false;
  const latestPossibleUtcOffset = 14 * 60 * 60 * 1000;
  return rows.some((row) => {
    const events = object(row.result)?.events;
    if (!Array.isArray(events)) return false;
    return events.some((value) => {
      const event = object(value);
      if (event?.allDay !== true) return false;
      if (!calendarFlightDetails(event)) return false;
      const date = text(event.start, 40);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !validDate(date)) return false;
      const earliestPossibleInstant = Date.parse(`${date}T00:00:00.000Z`) - latestPossibleUtcOffset;
      return earliestPossibleInstant < candidateInstant;
    });
  });
}

function hasEarlierUnresolvedTimedFlight(
  rows: ReadonlyArray<ReadToolEvidence>,
  candidate: CompoundTripFlightCandidate | undefined,
): boolean {
  if (!candidate) return false;
  const candidateInstant = Date.parse(candidate.instant);
  if (!Number.isFinite(candidateInstant)) return false;
  const earliestPossibleUtcOffset = 14 * 60 * 60 * 1000;
  return rows.some((row) => {
    const events = object(row.result)?.events;
    if (!Array.isArray(events)) return false;
    return events.some((value) => {
      const event = object(value);
      if (!event || event.allDay === true || text(event.status).toLowerCase() === 'cancelled')
        return false;
      if (!calendarFlightDetails(event)) return false;
      const start = text(event.start, 120);
      if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(start)) {
        const instant = Date.parse(start);
        // Valid absolute times are ranked by earlierCalendarFlight. This
        // helper concerns only timestamps whose offset cannot be resolved.
        return !Number.isFinite(instant);
      }
      const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
        start,
      );
      if (!local) return true;
      const [, year, month, day, hour, minute, second = '0', fraction = '0'] = local;
      const date = `${year}-${month}-${day}`;
      const hourNumber = Number(hour);
      const minuteNumber = Number(minute);
      const secondNumber = Number(second);
      if (!validDate(date) || hourNumber > 23 || minuteNumber > 59 || secondNumber > 59)
        return true;
      const wallClockAsUtc = Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        hourNumber,
        minuteNumber,
        secondNumber,
        Number(fraction.padEnd(3, '0')),
      );
      const earliestPossibleInstant = wallClockAsUtc - earliestPossibleUtcOffset;
      return earliestPossibleInstant < candidateInstant;
    });
  });
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
/** Exact-query search receipts with a contiguous provider page chain. */
export function boundedMailSearchPages(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): ReadToolEvidence[] {
  const queries =
    request.mailQueries?.map((entry) => entry.query) ??
    (request.mailQuery ? [request.mailQuery] : []);
  const searches = currentGmailRows(request, evidence);
  return queries.flatMap((query) =>
    validSearchPrefixRows(
      searches.filter(
        (row) => text(object(row.args)?.query, 4096)?.toLowerCase() === query.toLowerCase(),
      ),
      query,
    ),
  );
}

export function compoundTripCompleteSourceThreads(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): ReadToolEvidence[] {
  const searchPrefix = boundedMailSearchPages(request, evidence);
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

function explicitCarrierLabel(value: string, flightNumber?: string): string | undefined {
  const flightContext = flightNumber
    ? (() => {
        const code = flightNumber.replace(/\s+/g, '');
        const matches = [
          ...value.matchAll(
            new RegExp(
              `\\b${escapeRegExp(code.slice(0, 2))}\\s?${escapeRegExp(code.slice(2))}\\b`,
              'gi',
            ),
          ),
        ];
        if (matches.length !== 1) return undefined;
        const match = matches[0];
        if (!match || match.index === undefined) return undefined;
        const delimiters = /[\n;|]/g;
        let left = 0;
        let right = value.length;
        for (const delimiter of value.matchAll(delimiters)) {
          const index = delimiter.index;
          if (index === undefined) continue;
          if (index < match.index) left = index + 1;
          else if (index >= match.index + match[0].length) {
            right = index;
            break;
          }
        }
        const before = value.slice(left, match.index);
        const after = value.slice(match.index + match[0].length, right);
        const nearby = `${before}${match[0]}${after}`;
        const labels = [
          /\b(?:operated|flown)\s+by\s+([^\n,;.()]{2,48})/i.exec(nearby)?.[1],
          /\(([^()]{2,48})\)/.exec(after)?.[1],
          /\(([^()]{2,48})\)/.exec(before)?.[1],
        ].filter((label): label is string => Boolean(label?.trim()));
        const preceding = before
          .split(/[\n,;.]/)
          .at(-1)
          ?.replace(/\b(?:airline\s+)?flight(?:\s+(?:number|no\.?))?\s*#?\s*$/i, '')
          .replace(/\b(?:return|outbound|inbound|connection|connecting)\s*$/i, '')
          .trim();
        if (preceding && !/^(?:flight|itinerary|booking|reference)$/i.test(preceding))
          labels.push(preceding);
        const uniqueLabels = [...new Set(labels.map((label) => label.replace(/\s+/g, ' ').trim()))];
        return uniqueLabels.length === 1 ? uniqueLabels[0] : undefined;
      })()
    : undefined;
  const labels = flightContext
    ? [flightContext]
    : [
        /\b(?:operated|flown)\s+by\s+([^\n,;.()]{2,48})/i.exec(value)?.[1],
        /\bflight\s*\(([^()]{2,48})\)/i.exec(value)?.[1],
        /\bcarrier\s*[:=-]\s*([^\n,;.]{2,48})/i.exec(value)?.[1],
      ].filter((label): label is string => Boolean(label?.trim()));
  const uniqueLabels = [...new Set(labels.map((label) => label.replace(/\s+/g, ' ').trim()))];
  const explicit = uniqueLabels.length === 1 ? uniqueLabels[0] : undefined;
  const normalized = explicit
    ?.trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '');
  return normalized && normalized.length <= 48 ? normalized : undefined;
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
      const details = calendarFlightDetails(event);
      if (!instant || !details) continue;
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
  connectionContext: ReadonlyArray<CompoundTripFlightSegment> = segments,
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
    const connectionChain = connectionChainFor(segment, connectionContext);
    const connected = connectionChain.segments;
    const chain = [segment, ...connected];
    const hasConnections = connectionChain.candidateCount > 0;
    const hasCompleteChain =
      connectionChain.complete &&
      chain.every(
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
      const sameReferenceDayLegs = connectionContext.filter(
        (item) =>
          item.threadId === segment.threadId &&
          item.bookingReference === segment.bookingReference &&
          item.direction === expectedDirection &&
          item.departureDate === segment.departureDate,
      );
      const sameReferenceDayOriginLegs = candidate.originAirport
        ? sameReferenceDayLegs.filter((item) => item.originAirport === candidate.originAirport)
        : [];
      const strongReferenceMatch =
        referenceMatchesStrongly &&
        dateMatches &&
        (!candidate.originAirport ||
          !segment.originAirport ||
          candidate.originAirport === segment.originAirport) &&
        (sameReferenceDayLegs.length === 1 ||
          (Boolean(candidate.originAirport) &&
            sameReferenceDayOriginLegs.length === 1 &&
            sameReferenceDayOriginLegs[0] === segment));
      return strongReferenceMatch || strictMatch;
    });
    if (matchingCalendar.length > 1) return { ambiguous: true };
    const event = matchingCalendar[0];
    if (!event) return { ambiguous: false };
    const chainArrival = hasCompleteChain ? chain.at(-1)?.arrivalDate : undefined;
    const chronology =
      hasConnections && !connectionChain.complete
        ? connectionChain.chronology
        : flightChronology(chain);
    const itineraryArrivalDate = hasConnections
      ? chainArrival
      : (segment.arrivalDate ?? sourceCivilDate(event.event));
    const calendarConflicts: string[] = [];
    const calendarSummary = text(event.event.summary, 240);
    const hasFlightNumber = /\b[A-Z]{2}\s?[0-9]{1,4}\b/i.test(calendarSummary);
    const calendarCarrier =
      explicitCarrierLabel(calendarSummary, segment.flightNumber) ??
      (!hasFlightNumber ? explicitCarrierLabel(calendarSummary) : undefined);
    const bookingCarrier = explicitCarrierLabel(segment.excerpt, segment.flightNumber);
    if (calendarCarrier && bookingCarrier && calendarCarrier !== bookingCarrier)
      calendarConflicts.push('carrier');
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
        ...(calendarCarrier ? { calendarCarrier } : {}),
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
    const returnChain = [firstReturn];
    const remainingReturns = returns.slice(1);
    while (remainingReturns.length > 0) {
      const previous = returnChain.at(-1);
      const previousInstant = previous ? sourceLocalInstant(previous) : undefined;
      const nextLegs = remainingReturns.filter((candidate) => {
        const candidateInstant = sourceLocalInstant(candidate);
        return Boolean(
          previous?.destinationAirport &&
            candidate.originAirport === previous.destinationAirport &&
            previousInstant !== undefined &&
            candidateInstant !== undefined &&
            candidateInstant > previousInstant &&
            candidateInstant - previousInstant <= 3 * 86_400_000 &&
            candidate.threadId === firstReturn.threadId &&
            candidate.bookingReference === firstReturn.bookingReference &&
            flightChronology([...returnChain, candidate]) === 'valid',
        );
      });
      const nextLeg = nextLegs[0];
      if (nextLegs.length !== 1 || !nextLeg) break;
      returnChain.push(nextLeg);
      remainingReturns.splice(remainingReturns.indexOf(nextLeg), 1);
    }
    if (remainingReturns.length > 0) ambiguous = true;
    else currentTripReturn = matchSegment(firstReturn, 'return').flight;
  }
  return { ...(currentTripReturn ? { currentTripReturn } : {}), ambiguous };
}

function connectionChainFor(
  flight: CompoundTripFlightSegment | undefined,
  segments: ReadonlyArray<CompoundTripFlightSegment>,
): {
  segments: CompoundTripFlightSegment[];
  candidateCount: number;
  complete: boolean;
  chronology: 'valid' | 'unknown' | 'impossible';
} {
  if (!flight?.bookingReference)
    return { segments: [], candidateCount: 0, complete: true, chronology: 'valid' };
  const firstDeparture = sourceLocalInstant(flight);
  const firstDay = Date.parse(`${flight.departureDate}T00:00:00.000Z`);
  const candidates = segments
    .map((segment, index) => ({ segment, index, instant: sourceLocalInstant(segment) }))
    .filter(
      ({ segment, instant }) =>
        segment.threadId === flight.threadId &&
        segment.bookingReference === flight.bookingReference &&
        segment !== flight &&
        (segment.direction === 'connection' || segment.direction === flight.direction) &&
        Number.isFinite(firstDay) &&
        Date.parse(`${segment.departureDate}T00:00:00.000Z`) >= firstDay &&
        Date.parse(`${segment.departureDate}T00:00:00.000Z`) <= firstDay + 3 * 86_400_000 &&
        (firstDeparture === undefined ||
          instant === undefined ||
          (instant > firstDeparture && instant - firstDeparture <= 3 * 86_400_000)),
    )
    .sort((a, b) => {
      if (a.instant === undefined || b.instant === undefined) return a.index - b.index;
      return a.instant - b.instant;
    });
  const connected: CompoundTripFlightSegment[] = [];
  const remaining = [...candidates];
  let previous = flight;
  let unresolvedChronology: 'unknown' | 'impossible' = 'unknown';
  while (remaining.length > 0) {
    const previousDeparture = sourceLocalInstant(previous);
    const nextSegments = remaining.flatMap((candidate) => {
      const { segment, instant } = candidate;
      if (
        !previous?.destinationAirport ||
        segment.originAirport !== previous.destinationAirport ||
        previousDeparture === undefined ||
        instant === undefined ||
        instant <= previousDeparture ||
        instant - previousDeparture > 3 * 86_400_000
      )
        return [];
      const chronology = flightChronology([flight, ...connected, segment]);
      if (chronology === 'impossible') unresolvedChronology = 'impossible';
      if (chronology !== 'valid') return [];
      return [{ candidate, segment }];
    });
    if (nextSegments.length !== 1) break;
    const next = nextSegments[0]?.candidate;
    if (!next) break;
    connected.push(next.segment);
    remaining.splice(remaining.indexOf(next), 1);
    previous = next.segment;
  }
  return {
    segments: connected,
    candidateCount: candidates.length,
    complete: remaining.length === 0,
    chronology:
      remaining.length === 0 ? flightChronology([flight, ...connected]) : unresolvedChronology,
  };
}

function connectionSegments(
  flight: CompoundTripFlightSegment | undefined,
  segments: ReadonlyArray<CompoundTripFlightSegment>,
): CompoundTripFlightSegment[] {
  return connectionChainFor(flight, segments).segments;
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
  order: number;
  subject: string;
  text: string;
}

function threadMessages(rows: ReadonlyArray<ReadToolEvidence>): SourceThreadMessage[] {
  const grouped = new Map<
    string,
    {
      threadId: string;
      messageId: string;
      order: number;
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
    for (const [messageIndex, raw] of messages.entries()) {
      const message = object(raw);
      const messageId = text(message?.messageId, 100);
      if (!message || !messageId) continue;
      const key = `${threadId}:${messageId}`;
      const groupedMessage = grouped.get(key) ?? {
        threadId,
        messageId,
        order: start + messageIndex,
        subject: text(message.subject, 240),
        pages: [],
      };
      groupedMessage.order = Math.min(groupedMessage.order, start + messageIndex);
      groupedMessage.pages.push({ start, offset, text: text(message.text, 8_000) });
      grouped.set(key, groupedMessage);
    }
  }
  return [...grouped.values()].map((message) => ({
    threadId: message.threadId,
    messageId: message.messageId,
    order: message.order,
    subject: message.subject,
    text: message.pages
      .sort((a, b) => a.start - b.start || a.offset - b.offset)
      .map((page) => page.text)
      .join('')
      .slice(0, 24_000),
  }));
}

/** MIME transport line endings are equivalent; omitted or rewritten text is not. */
export function compoundTripSourceQuote(
  source: string,
  quote: string,
  max: number,
): string | undefined {
  const normalized = quote.replace(/\r\n/g, '\n').trim();
  return normalized &&
    normalized.length <= max &&
    source.replace(/\r\n/g, '\n').includes(normalized)
    ? normalized
    : undefined;
}

function exactSourceToken(quote: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(quote);
}

export function compoundTripSourceHasDate(quote: string, date: string): boolean {
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

export function compoundTripSourceHasClock(quote: string, value: string): boolean {
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
    !compoundTripSourceQuote(source.text, quote, 700) ||
    !sourceMessageIds.has(segment.messageId) ||
    !/^[A-Z]{2,3}\s*\d{1,4}$/i.test(segment.flightNumber) ||
    !sourceHasFlightNumber(quote, segment.flightNumber) ||
    !compoundTripSourceHasDate(quote, segment.departureDate) ||
    !compoundTripSourceHasClock(quote, segment.departureTime)
  )
    return false;
  if (segment.arrivalDate && !compoundTripSourceHasDate(quote, segment.arrivalDate)) return false;
  if (segment.arrivalTime && !compoundTripSourceHasClock(quote, segment.arrivalTime)) return false;
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
      messageId: hotel.messageId,
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

function hotelFitsCurrentTripStay(
  hotel: CompoundTripHotelCandidate,
  currentTripReturn: CompoundTripFlightCandidate | undefined,
  segments: ReadonlyArray<CompoundTripFlightSegment>,
): boolean {
  const returning = currentTripReturn?.segment;
  if (
    !returning?.bookingReference ||
    hotel.threadId !== returning.threadId ||
    !hotel.city ||
    !hotel.checkIn ||
    !hotel.checkOut
  )
    return false;
  const returnCity = calendarFlightOriginCity(currentTripReturn?.event);
  if (!returnCity || normalizePlace(hotel.city) !== normalizePlace(returnCity)) return false;

  // A checkout-day stay can be relevant to a current trip even though it does
  // not overlap the return departure date. Keep this as a sourced observation:
  // require the outbound and return legs in the same verified booking thread,
  // a complete chronological flight chain, and an explicit matching city.
  const outbound = segments.find(
    (segment) =>
      segment.threadId === returning.threadId &&
      segment.bookingReference === returning.bookingReference &&
      segment.direction === 'outbound',
  );
  if (!outbound) return false;
  const outboundConnections = connectionSegments(outbound, segments);
  const outboundChain = [outbound, ...outboundConnections];
  if (
    !outbound.destinationAirport ||
    flightChronology(outboundChain) !== 'valid' ||
    (outboundConnections.length > 0 && !connectionChainSummary(outbound, outboundConnections))
  )
    return false;

  const arrival = outboundChain[outboundChain.length - 1];
  const arrivalInstant = sourceLocalDateTimeInstant(
    arrival?.arrivalDate,
    arrival?.arrivalTime,
    arrival?.arrivalTimeZone,
  );
  const returnInstant = sourceLocalInstant(returning);
  if (
    !arrival?.arrivalDate ||
    !returning.departureDate ||
    arrivalInstant === undefined ||
    returnInstant === undefined ||
    arrivalInstant >= returnInstant
  )
    return false;

  return (
    hotel.checkIn >= arrival.arrivalDate &&
    hotel.checkOut > hotel.checkIn &&
    hotel.checkOut <= returning.departureDate
  );
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

interface SourceBookingInvalidation {
  threadId: string;
  messageId: string;
  order: number;
  kind: 'flight' | 'hotel';
  bookingReference?: string;
  flightNumber?: string;
  dates: string[];
  hotelName?: string;
}

function explicitBookingInvalidation(
  message: SourceThreadMessage,
): SourceBookingInvalidation | undefined {
  const body = message.text;
  const action =
    '(?:(?:has been|was|is now|is)\\s+)?(?:cancelled|canceled|voided|refunded|rejected|declined|denied)';
  const reverseAction = '(?:cancelled|canceled|voided|rejected|declined|denied)\\s+';
  const statements = body
    .split(/(?<=[.!?])\s+|\n/)
    .filter(
      (statement) =>
        !/^\s*(?:if|when|unless|whether|in case|assuming)\b/i.test(statement) &&
        !/\b(?:not|never|no longer|not yet|isn't|wasn't|aren't|weren't|hasn't|haven't|hadn't)\s+(?:\w+\s+){0,4}(?:cancelled|canceled|voided|refunded|rejected|declined|denied)\b/i.test(
          statement,
        ),
    );
  const flightPattern = new RegExp(
    `\\b(?:flight|airline itinerary)\\b[^.!?\\n]{0,60}\\b${action}\\b|\\b${reverseAction}(?:flight|airline itinerary)\\b|\\bflight\\s+(?:cancellation|rejection|denial)\\s+(?:is|was)\\s+confirmed\\b`,
    'i',
  );
  const hotelPattern = new RegExp(
    `\\b(?:hotel|room|lodging|accommodation)\\b[^.!?\\n]{0,60}\\b${action}\\b|\\b${reverseAction}(?:hotel|room|lodging|accommodation)\\b|\\b(?:hotel|room)\\s+(?:cancellation|rejection|denial)\\s+(?:is|was)\\s+confirmed\\b`,
    'i',
  );
  let kind: 'flight' | 'hotel' | undefined;
  let cancellationStatement = statements.find((statement) => flightPattern.test(statement));
  if (cancellationStatement) kind = 'flight';
  else {
    cancellationStatement = statements.find((statement) => hotelPattern.test(statement));
    if (cancellationStatement) kind = 'hotel';
  }
  if (!kind) return undefined;
  const identitySource = `${message.subject}\n${cancellationStatement ?? ''}`;
  const hotelDetails = kind === 'hotel' ? hotelNameAndCity(identitySource) : undefined;
  return {
    threadId: message.threadId,
    messageId: message.messageId,
    order: message.order,
    kind,
    ...(bookingReference(identitySource)
      ? { bookingReference: bookingReference(identitySource) }
      : {}),
    ...(explicitFlightNumber(cancellationStatement ?? '')
      ? { flightNumber: explicitFlightNumber(cancellationStatement ?? '') }
      : {}),
    dates: [...(cancellationStatement ?? '').matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)].map(
      (match) => match[0],
    ),
    ...(hotelDetails?.name ? { hotelName: normalizePlace(hotelDetails.name) } : {}),
  };
}

function sourceFactInvalidated(
  threadId: string,
  messageId: string | undefined,
  kind: 'flight' | 'hotel',
  fact: { bookingReference?: string; flightNumber?: string; dates?: string[]; hotelName?: string },
  invalidations: ReadonlyArray<SourceBookingInvalidation>,
  sourceMessages: ReadonlyArray<SourceThreadMessage>,
  allowAmbiguousFallback = false,
): boolean {
  const sourceOrder = sourceMessages.find(
    (message) => message.threadId === threadId && message.messageId === messageId,
  )?.order;
  if (sourceOrder === undefined) return false;
  return invalidations.some((invalidation) => {
    if (invalidation.threadId !== threadId || invalidation.kind !== kind) return false;
    const sameMessage = invalidation.messageId === messageId;
    if (!sameMessage && invalidation.order < sourceOrder) return false;
    const hasIdentity = Boolean(
      invalidation.bookingReference ||
        invalidation.flightNumber ||
        invalidation.hotelName ||
        invalidation.dates.length,
    );
    // A PNR identifies a reservation, which may contain multiple flight legs.
    // An explicit conflicting flight number is stronger evidence than a shared
    // reservation reference and must not invalidate the other leg.
    if (
      kind === 'flight' &&
      fact.flightNumber &&
      invalidation.flightNumber &&
      fact.flightNumber !== invalidation.flightNumber
    )
      return false;
    if (fact.bookingReference && invalidation.bookingReference)
      return fact.bookingReference === invalidation.bookingReference;
    if (kind === 'flight' && fact.flightNumber && invalidation.flightNumber) {
      if (fact.flightNumber !== invalidation.flightNumber) return false;
      if (!invalidation.dates.length) return sameMessage;
      return (fact.dates ?? []).some((date) => invalidation.dates.includes(date));
    }
    if (kind === 'hotel' && fact.hotelName && invalidation.hotelName) {
      if (normalizePlace(fact.hotelName) !== invalidation.hotelName) return false;
      if (!invalidation.dates.length) return sameMessage;
      return (fact.dates ?? []).some((date) => invalidation.dates.includes(date));
    }
    if (sameMessage) return allowAmbiguousFallback && !hasIdentity;
    return allowAmbiguousFallback && !hasIdentity;
  });
}

function parseFlightSegments(
  messages: ReadonlyArray<SourceThreadMessage>,
): CompoundTripFlightSegment[] {
  const segments: CompoundTripFlightSegment[] = [];
  for (const message of messages) {
    const messageReference = bookingReference(`${message.subject}\n${message.text}`);
    segments.push(...parseEgenciaTableSegments(message));
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
      const segmentReference = bookingReference(block.excerpt) ?? messageReference;
      const fromTo = /\bfrom\s+([A-Z]{3})\s+(?:to|→|->)\s+([A-Z]{3})\b/i.exec(block.excerpt);
      segments.push({
        threadId: message.threadId,
        messageId: message.messageId,
        subject: message.subject,
        ...(segmentReference ? { bookingReference: segmentReference } : {}),
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

/** Exact source-local table facts, without inferred direction or airport zones. */
function parseEgenciaTableSegments(message: SourceThreadMessage): CompoundTripFlightSegment[] {
  if (
    !/\bEgencia\b/i.test(message.text) ||
    !/\b(?:Booking Confirmation|Trip Booked)\b/i.test(message.text)
  )
    return [];
  const normalized = message.text.replace(/\r\n/g, '\n');
  const table =
    /(?:^|\n)[^\n]{0,60}\b([A-Z]{2,3}\d{1,4})\nOperated by ([^\n]{1,60})\nDEPARTURE\n([A-Za-z]{3,9} \d{1,2}, 20\d{2}) at (\d{1,2}:\d{2} [ap]m)\n([^\n]{1,200})\nARRIVAL(?: \+1)?\n([A-Za-z]{3,9} \d{1,2}, 20\d{2}) at (\d{1,2}:\d{2} [ap]m)\n([^\n]{1,200})/gim;
  const date = (value: string) => {
    const match = /^(\w+) (\d{1,2}), (20\d{2})$/.exec(value);
    if (!match?.[1] || !match[2] || !match[3]) return undefined;
    const month = new Date(`${match[1]} 1, 2000`).getMonth() + 1;
    const iso = `${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
    return validDate(iso) ? iso : undefined;
  };
  const airport = (value: string) => /\(([A-Z]{3})(?:[-)]|\b)/.exec(value)?.[1];
  return [...normalized.matchAll(table)].slice(0, 8).flatMap((match) => {
    const [, flightNumber, , departure, departureTime, origin, arrival, arrivalTime, destination] =
      match;
    if (
      !flightNumber ||
      !departure ||
      !departureTime ||
      !origin ||
      !arrival ||
      !arrivalTime ||
      !destination
    )
      return [];
    const departureDate = date(departure);
    const arrivalDate = date(arrival);
    const originAirport = airport(origin);
    const destinationAirport = airport(destination);
    if (
      !departureDate ||
      !arrivalDate ||
      !originAirport ||
      !destinationAirport ||
      parseClockMinutes(departureTime) === undefined ||
      parseClockMinutes(arrivalTime) === undefined
    )
      return [];
    const reference = bookingReference(`${message.subject}\n${message.text}`);
    const itineraryReference = egenciaItineraryReference(message.text);
    return [
      {
        threadId: message.threadId,
        messageId: message.messageId,
        subject: message.subject,
        ...(reference ? { bookingReference: reference } : {}),
        ...(itineraryReference ? { itineraryReference } : {}),
        flightNumber: flightNumber.toUpperCase(),
        departureDate,
        departureTime: departureTime.toUpperCase(),
        arrivalDate,
        arrivalTime: arrivalTime.toUpperCase(),
        originAirport,
        destinationAirport,
        direction: 'unknown' as const,
        excerpt: match[0].trim(),
      },
    ];
  });
}

function egenciaItineraryReference(value: string): string | undefined {
  return /\bEgencia(?:\s+(?:reference|ref)(?:\s*#)?)?\s+([0-9]{6,16})\b/i.exec(value)?.[1];
}

function sameSourceTableLeg(
  left: CompoundTripFlightSegment,
  right: CompoundTripFlightSegment,
): boolean {
  const clock = parseClockMinutes(left.departureTime);
  return (
    left.threadId === right.threadId &&
    left.messageId === right.messageId &&
    left.flightNumber === right.flightNumber &&
    left.departureDate === right.departureDate &&
    clock !== undefined &&
    clock === parseClockMinutes(right.departureTime)
  );
}

function compatibleTableFields(
  segment: CompoundTripFlightSegment,
  table: CompoundTripFlightSegment,
): boolean {
  return !(['originAirport', 'destinationAirport', 'arrivalDate', 'arrivalTime'] as const).some(
    (field) => {
      const current = segment[field];
      const candidate = table[field];
      return (
        current !== undefined &&
        candidate !== undefined &&
        (field === 'arrivalTime'
          ? parseClockMinutes(current) !== parseClockMinutes(candidate)
          : current !== candidate)
      );
    },
  );
}

/** Enrich only one compatible exact row from the same completely read message. */
function mergeSourceTableSegments(
  extracted: ReadonlyArray<CompoundTripFlightSegment>,
  tables: ReadonlyArray<CompoundTripFlightSegment>,
): CompoundTripFlightSegment[] {
  const used = new Set<CompoundTripFlightSegment>();
  const merged = extracted.map((segment) => {
    const matches = tables.filter((table) => sameSourceTableLeg(segment, table));
    const table = matches.length === 1 ? matches[0] : undefined;
    if (!table) return segment;
    const fields = ['originAirport', 'destinationAirport', 'arrivalDate', 'arrivalTime'] as const;
    if (!compatibleTableFields(segment, table)) return segment;
    used.add(table);
    const enriched = { ...segment };
    for (const field of fields) {
      if (enriched[field] === undefined && table[field] !== undefined)
        enriched[field] = table[field];
    }
    // This table identifier supports observations only; it does not supply a
    // missing booking identity, direction or time zone for route selection.
    if (!enriched.itineraryReference && table.itineraryReference)
      enriched.itineraryReference = table.itineraryReference;
    return enriched;
  });
  return [...merged, ...tables.filter((table) => !used.has(table))];
}

interface BookedRouteGroup {
  threadId: string;
  direction: 'outbound' | 'return';
  origin: string;
  destination: string;
  reference: string;
  legs: CompoundTripFlightSegment[];
  destinationCity: string;
}

/** Route order is an inference from two reversed, source-labeled itinerary groups. */
function bookedRouteGroups(
  messages: ReadonlyArray<SourceThreadMessage>,
  validated: ReadonlyArray<CompoundTripFlightSegment>,
): BookedRouteGroup[] {
  return messages.flatMap((message) => {
    const body = message.text.replace(/\r\n/g, '\n');
    const headers = [
      ...body.matchAll(/\[image:\s*Flight\]\s*([A-Z]{3}) to ([A-Z]{3})\s*#([0-9]{6,16})\b/g),
    ];
    const first = headers[0];
    const second = headers[1];
    if (
      headers.length !== 2 ||
      !first ||
      !second ||
      first[1] !== second[2] ||
      first[2] !== second[1] ||
      first[3] !== second[3]
    )
      return [];
    const tables = parseEgenciaTableSegments(message).filter((leg) =>
      validated.some((item) => sameSourceTableLeg(item, leg) && compatibleTableFields(item, leg)),
    );
    const groups = headers.map((header, index) => {
      const start = header.index ?? -1;
      const end = headers[index + 1]?.index ?? body.length;
      const legs = tables.filter((leg) => {
        const at = body.indexOf(leg.excerpt);
        return at > start && at < end;
      });
      const last = legs.at(-1);
      const destinationLine = last?.excerpt.split('\n').at(-1) ?? '';
      const city = destinationLine.split(',')[0]?.split('(')[0]?.trim() ?? '';
      if (
        !legs.length ||
        legs[0]?.originAirport !== header[1] ||
        last?.destinationAirport !== header[2] ||
        !city ||
        !last?.arrivalDate ||
        legs.some((leg, at) => {
          const previous = legs[at - 1];
          return (
            !leg.arrivalDate ||
            leg.arrivalDate < leg.departureDate ||
            (previous &&
              (previous.destinationAirport !== leg.originAirport ||
                !previous.arrivalDate ||
                previous.arrivalDate > leg.departureDate))
          );
        })
      )
        return undefined;
      return {
        threadId: message.threadId,
        direction: index === 0 ? ('outbound' as const) : ('return' as const),
        origin: header[1] ?? '',
        destination: header[2] ?? '',
        reference: header[3] ?? '',
        legs,
        destinationCity: city,
      };
    });
    return groups.every((group) => group !== undefined) ? (groups as BookedRouteGroup[]) : [];
  });
}

function bookedHotelTransfer(
  request: PersonalReadRequest,
  groups: ReadonlyArray<BookedRouteGroup>,
  hotels: ReadonlyArray<CompoundTripHotelCandidate>,
): { group: BookedRouteGroup; hotel: CompoundTripHotelCandidate } | undefined {
  const day = request.timeWindow?.timeMin.slice(0, 10);
  const end = request.timeWindow?.timeMax.slice(0, 10);
  if (!request.compoundTripDiscovery || !day || !end) return undefined;
  const matches = groups
    .filter((group) => group.direction === 'outbound')
    .flatMap((group) => {
      const returning = groups.find(
        (item) =>
          item.threadId === group.threadId &&
          item.direction === 'return' &&
          item.reference === group.reference,
      );
      const arrival = group.legs.at(-1)?.arrivalDate;
      const departure = returning?.legs[0]?.departureDate;
      if (!arrival || !departure || departure < day || arrival >= end || arrival > departure)
        return [];
      return hotels
        .filter(
          (hotel) =>
            hotel.hotelName &&
            hotel.address &&
            hotel.city &&
            hotel.checkIn === arrival &&
            hotel.checkOut &&
            hotel.checkOut <= departure &&
            hotel.checkOut > day &&
            hotel.checkOut > arrival &&
            normalizePlace(hotel.city) === normalizePlace(group.destinationCity),
        )
        .map((hotel) => ({ group, hotel }));
    });
  return matches.length === 1 ? matches[0] : undefined;
}

function bookedCalendarDifferences(
  groups: ReadonlyArray<BookedRouteGroup>,
  calendarRows: ReadonlyArray<ReadToolEvidence>,
  links: ReadonlyMap<string, string>,
  compact = false,
): string[] {
  const lines: string[] = [];
  for (const row of calendarRows) {
    const events = object(row.result)?.events;
    if (!Array.isArray(events)) continue;
    for (const value of events) {
      const event = object(value);
      if (!event || text(event.status).toLowerCase() === 'cancelled') continue;
      const details = `${text(event.summary, 240)}\n${text(event.description, 1200)}`;
      const reference = egenciaItineraryReference(details);
      const route = airportRoute(details);
      const matches = groups.filter(
        (group) =>
          reference === group.reference &&
          route?.origin === group.origin &&
          route.destination === group.destination,
      );
      const group = matches.length === 1 ? matches[0] : undefined;
      if (!group) continue;
      const first = group.legs[0];
      const carrier = carrierRoleLabel(details);
      const carriers = [
        ...new Set(group.legs.map((leg) => carrierRoleLabel(leg.excerpt)?.name).filter(Boolean)),
      ];
      const carrierDifference =
        carrier?.role === 'operating' && carriers.length === 1 && carrier.name !== carriers[0];
      if (compact) {
        lines.push(
          `Calendar: ${markdownText(text(event.summary, 120))}, start ${markdownText(calendarField(event, 'start'))}; booking: ${group.legs.map((leg) => leg.originAirport).join('→')}→${group.destination}, ${first?.departureDate} ${first?.departureTime}${carrierDifference ? `, operated by ${markdownText(carriers[0] ?? '')} instead of ${markdownText(carrier.name)}` : ''}. Same itinerary reference; ${first?.departureTimeZone ? 'exact segment identity still needs checking' : 'clock difference cannot be verified without the booking time zone'}.${calendarSource(event) ? ` [Calendar](${calendarSource(event)})` : ''}${links.get(group.threadId) ? ` [Booking](${links.get(group.threadId)})` : ''}`,
        );
        continue;
      }
      lines.push(
        `Same-itinerary calendar comparison for ${group.origin}→${group.destination}: Calendar records ${markdownText(text(event.summary, 160))}, start ${markdownText(calendarField(event, 'start'))}; the booking route group starts ${first?.departureDate} ${first?.departureTime} at ${group.origin}${carrierDifference ? ` and names ${markdownText(carriers[0] ?? '')} as operating carrier, while Calendar names ${markdownText(carrier.name)}` : ''}. ${first?.departureTimeZone ? 'This compares the route group, not an independently verified calendar-to-segment identity.' : 'The booking departure time zone is not stated, so I cannot establish an instant-level clock conflict or convert the calendar offset into a flight time zone.'}${calendarSource(event) ? ` [Calendar source](${calendarSource(event)})` : ''}${links.get(group.threadId) ? ` [Booking email](${links.get(group.threadId)})` : ''}.`,
      );
    }
  }
  return lines;
}

function sourceLocalBookingLines(
  request: PersonalReadRequest,
  threads: ReadonlyArray<ReadToolEvidence>,
  calendarRows: ReadonlyArray<ReadToolEvidence>,
  segments: ReadonlyArray<CompoundTripFlightSegment>,
): string[] {
  const links = threadSourceLinks(threads);
  const tableSources = threadMessages(threads).flatMap(parseEgenciaTableSegments);
  const day = request.timeWindow?.timeMin.slice(0, 10);
  const observed = segments.filter(
    (segment) =>
      (segment.direction === 'unknown' || !segment.departureTimeZone) &&
      (!day || segment.departureDate >= day),
  );
  if (observed.length === 0) return [];
  const lines = observed
    .slice(0, 4)
    .map(
      (segment) =>
        `Booking email observation — not a verified next-flight match: ${formatFlightSegment(segment)}; direction ${segment.direction === 'unknown' ? 'not explicitly stated' : `source labels ${segment.direction}`}${links.has(segment.threadId) ? ` [Booking email](${links.get(segment.threadId)})` : ''}.`,
    );
  for (const message of threadMessages(threads)) {
    const routes = [
      ...message.text.matchAll(
        /\[image:\s*Flight\]\s*([A-Z]{3}) to ([A-Z]{3})\s*#([0-9]{6,16})\b/g,
      ),
    ];
    if (
      routes.length === 2 &&
      routes[0]?.[1] === routes[1]?.[2] &&
      routes[0]?.[2] === routes[1]?.[1] &&
      routes[0]?.[3] === routes[1]?.[3] &&
      observed.some((segment) => segment.threadId === message.threadId)
    )
      lines.push(
        `The booked table groups ${routes[0]?.[1]}→${routes[0]?.[2]} before ${routes[1]?.[1]}→${routes[1]?.[2]}. A return is an inference from those reversed itinerary groups; the source does not explicitly label direction.`,
      );
  }
  for (const candidate of flightCandidates(request, calendarRows)) {
    const itineraryReference = egenciaItineraryReference(text(candidate.event.description, 1200));
    if (!candidate.bookingReference && !itineraryReference) continue;
    const sameReference = observed.filter(
      (segment) =>
        (candidate.bookingReference !== undefined &&
          segment.bookingReference === candidate.bookingReference) ||
        (itineraryReference !== undefined && segment.itineraryReference === itineraryReference),
    );
    const calendarCarrier = carrierRoleLabel(
      `${text(candidate.event.summary, 240)}\n${text(candidate.event.description, 1200)}`,
    );
    for (const segment of sameReference.slice(0, 4)) {
      const tables = tableSources.filter(
        (table) => sameSourceTableLeg(table, segment) && compatibleTableFields(segment, table),
      );
      const bookingCarrier = carrierRoleLabel(
        tables.length === 1 ? (tables[0]?.excerpt ?? segment.excerpt) : segment.excerpt,
        segment.flightNumber,
      );
      if (!calendarCarrier || !bookingCarrier || calendarCarrier.name === bookingCarrier.name)
        continue;
      const bookedInstant = sourceLocalInstant(segment);
      const exactLeg =
        candidate.flightNumber === segment.flightNumber &&
        candidate.originAirport !== undefined &&
        candidate.originAirport === segment.originAirport &&
        candidate.arrivalAirport !== undefined &&
        candidate.arrivalAirport === segment.destinationAirport &&
        bookedInstant !== undefined &&
        Math.abs(Date.parse(candidate.instant) - bookedInstant) <= 5 * 60_000;
      const comparableRoles =
        calendarCarrier.role !== 'unspecified' && calendarCarrier.role === bookingCarrier.role;
      lines.push(
        `${exactLeg && comparableRoles ? 'Source conflict for the same dated flight leg' : 'Unresolved carrier difference under the same itinerary reference'}: calendar names ${markdownText(calendarCarrier.name)} (${carrierRoleDescription(calendarCarrier.role)}); booking email names ${markdownText(bookingCarrier.name)} (${carrierRoleDescription(bookingCarrier.role)}) for ${segment.flightNumber} ${segment.originAirport ?? 'origin not stated'}→${segment.destinationAirport ?? 'destination not stated'}.${exactLeg && comparableRoles ? '' : ' Comparable carrier roles and the exact calendar-to-leg match are not both established; these may be different legs or a codeshare.'}`,
      );
    }
  }
  return lines;
}

function carrierRoleLabel(
  value: string,
  flightNumber?: string,
): { name: string; role: 'operating' | 'marketing' | 'unspecified' } | undefined {
  const explicit =
    /\b(operated by|operating carrier\s*:|marketed by|marketing carrier\s*:)\s*([^\r\n.;]{1,48})/i.exec(
      value,
    );
  if (explicit?.[1] && explicit[2])
    return {
      name: explicit[2].trim(),
      role: /^operat/i.test(explicit[1]) ? 'operating' : 'marketing',
    };
  const name = explicitCarrierLabel(value, flightNumber);
  return name ? { name, role: 'unspecified' } : undefined;
}

function carrierRoleDescription(role: 'operating' | 'marketing' | 'unspecified'): string {
  return role === 'unspecified' ? 'carrier role unspecified' : `${role} carrier`;
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
    const rendered = renderedBookedHotel(body);
    const address = rendered.address ?? hotelAddress(body);
    const { name: parsedName, city: parsedCity } = hotelNameAndCity(source);
    const hotelName =
      /\bhotel\s+(?:name|property)\s*:\s*([^\n\r]{2,160})/i.exec(body)?.[1]?.trim() ??
      rendered.name ??
      parsedName;
    const city =
      /\b(?:hotel\s+)?city\s*:\s*([^\n\r]{2,100})/i.exec(body)?.[1]?.trim() ??
      rendered.city ??
      parsedCity;
    const { checkIn, checkOut } = hotelStayDates(body);
    const reference =
      bookingReference(source) ??
      (rendered.name ? /\bItinerary number:\s*([A-Z0-9-]{4,24})\b/i.exec(body)?.[1] : undefined);
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
      messageId: message.messageId,
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

/** Recover adjacent rendered property/address text only when the Maps address repeats it. */
function renderedBookedHotel(body: string): { name?: string; address?: string; city?: string } {
  const normalized = body.replace(/\r\n/g, '\n');
  const blocks = [
    ...normalized.matchAll(
      /(?:^|\n)Hotel \(Booked\)\s*\n([^\n]{4,240})\n([^<\n]{2,100}) <(https:\/\/www\.google\.com\/maps\/search\/[^>]+)>/gi,
    ),
  ];
  if (blocks.length !== 1) return {};
  const block = blocks[0];
  if (!block?.[1] || !block[2] || !block[3]) return {};
  try {
    const url = new URL(block[3]);
    const parts = decodeURIComponent(url.pathname.slice('/maps/search/'.length).replace(/\+/g, ' '))
      .split(/\r?\n/)
      .map((part) => part.trim())
      .filter(Boolean);
    const address = parts[0];
    const city = parts[1];
    if (
      parts.length !== 2 ||
      !address ||
      !city ||
      !/\d/.test(address) ||
      block[2].trim() !== city ||
      !block[1].endsWith(address)
    )
      return {};
    const name = block[1].slice(0, -address.length).trim();
    return name.length >= 2 && name.length <= 140
      ? { name, address: `${address}, ${city}`, city }
      : {};
  } catch {
    return {};
  }
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
    /\b(?:reservation|booking)\s+(?:confirmed|confirmation|details)\s*:\s*(?:hotel\s+)?([^\n,.;]{2,100}),\s*([^\n,.;]{2,80})/i,
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
    const observedDirection = calendarObservationDirection(event);
    const details = `${text(event.summary, 240)}\n${text(event.description, 1200)}\n${text(event.location, 300)}`;
    const route = airportRoute(details);
    const direction =
      observedDirection === 'return'
        ? 'The calendar labels its direction as a return.'
        : observedDirection === 'outbound'
          ? 'The calendar labels its direction as outbound.'
          : route
            ? `The calendar record lists the route ${route.origin} to ${route.destination}; it does not explicitly label the flight outbound or return.`
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
  flight: Pick<CompoundTripFlightCandidate, 'arrivalAirport'>,
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
    calendarPageChainComplete(calendarRows) &&
    calendarRows.every((row) => {
      const result = object(row.result);
      return (
        result?.calendarRosterComplete === true &&
        result.paginationUnavailable !== true &&
        Array.isArray(result.unavailable) &&
        result.unavailable.length === 0
      );
    });
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
  const completeIds = completeThreadIds(readThreads);
  const searchedThreadIds = new Set(
    gmailSearchRows.flatMap((row) => {
      const results = object(row.result)?.results;
      return Array.isArray(results)
        ? results.map((item) => text(object(item)?.threadId, 100)).filter(Boolean)
        : [];
    }),
  );
  // Ranking bounds new reads, not the coverage claim. Only receipted complete
  // reads of searched IDs count; an unselected or failed thread remains a gap.
  // Previously completed search-matched reads still count when thin metadata
  // provides no useful candidate rank.
  const unreadThreadCount = [...searchedThreadIds].filter((id) => !completeIds.has(id)).length;
  const allThreadsRead = gmailSearchRows.length > 0 && unreadThreadCount === 0;
  const completeThreads = readThreads.filter((row) =>
    completeIds.has(text(object(row.args)?.threadId, 100)),
  );
  const sourceMessages = threadMessages(completeThreads);
  const tripExtraction = extractedFacts ?? compoundTripExtractionFromEvidence(evidence);
  const sourceInvalidations = sourceMessages
    .map(explicitBookingInvalidation)
    .filter((invalidation): invalidation is SourceBookingInvalidation => Boolean(invalidation));
  const allowSourceLocalFallback =
    tripExtraction === undefined ||
    (tripExtraction.status === 'complete' && tripExtraction.segments.length === 0);
  const extractionSegments = tripExtraction?.status === 'complete' ? tripExtraction.segments : [];
  // Use strict source-local facts only when there was no extractor or a
  // completed extraction accepted none. An unavailable extraction retains
  // its existing coverage gate. Explicit cancellations suppress only same-
  // message facts of the matching type, preserving later or unrelated bookings.
  const extractedSegments = allowSourceLocalFallback
    ? parseFlightSegments(sourceMessages).filter(
        (segment) =>
          !sourceFactInvalidated(
            segment.threadId,
            segment.messageId,
            'flight',
            {
              bookingReference: segment.bookingReference,
              flightNumber: segment.flightNumber,
              dates: [segment.departureDate, segment.arrivalDate].filter((date): date is string =>
                Boolean(date),
              ),
            },
            sourceInvalidations,
            sourceMessages,
            true,
          ),
      )
    : extractionSegments.filter(
        (segment) =>
          !sourceFactInvalidated(
            segment.threadId,
            segment.messageId,
            'flight',
            {
              bookingReference: segment.bookingReference,
              flightNumber: segment.flightNumber,
              dates: [segment.departureDate, segment.arrivalDate].filter((date): date is string =>
                Boolean(date),
              ),
            },
            sourceInvalidations,
            sourceMessages,
          ),
      );
  const flightSegments = mergeSourceTableSegments(
    extractedSegments,
    sourceMessages.flatMap(parseEgenciaTableSegments).filter(
      (segment) =>
        !sourceFactInvalidated(
          segment.threadId,
          segment.messageId,
          'flight',
          {
            bookingReference: segment.bookingReference,
            flightNumber: segment.flightNumber,
            dates: [segment.departureDate, segment.arrivalDate].filter((date): date is string =>
              Boolean(date),
            ),
          },
          sourceInvalidations,
          sourceMessages,
          allowSourceLocalFallback,
        ),
    ),
  );
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
          if (
            sourceFactInvalidated(
              segment.threadId,
              segment.messageId,
              'flight',
              {
                bookingReference: segment.bookingReference,
                flightNumber: segment.flightNumber,
                dates: [segment.departureDate, segment.arrivalDate].filter((date): date is string =>
                  Boolean(date),
                ),
              },
              sourceInvalidations,
              sourceMessages,
            )
          )
            return false;
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
  const selectedItineraryLead = flight?.segment ?? currentTripReturn?.segment;
  const selectedBookingSegments = selectedItineraryLead
    ? flightSegments.filter(
        (segment) =>
          segment.threadId === selectedItineraryLead.threadId &&
          segment.bookingReference === selectedItineraryLead.bookingReference,
      )
    : [];
  const hotelFlightContext = flight ?? currentTripReturn;
  const extractedHotels =
    tripExtraction?.status === 'complete'
      ? extractedHotelCandidates(tripExtraction.hotels, hotelFlightContext).filter(
          (candidate) =>
            !sourceFactInvalidated(
              candidate.threadId,
              candidate.messageId,
              'hotel',
              {
                bookingReference: candidate.bookingReference,
                hotelName: candidate.hotelName,
                dates: [candidate.checkIn, candidate.checkOut].filter((date): date is string =>
                  Boolean(date),
                ),
              },
              sourceInvalidations,
              sourceMessages,
            ),
        )
      : [];
  const allowHotelFallback =
    tripExtraction === undefined ||
    (tripExtraction.status === 'complete' && extractedHotels.length === 0);
  const sourceHotels =
    tripExtraction?.status === 'unavailable'
      ? []
      : hotelCandidates(completeThreads, hotelFlightContext).filter(
          (candidate) =>
            !sourceFactInvalidated(
              candidate.threadId,
              candidate.messageId,
              'hotel',
              {
                bookingReference: candidate.bookingReference,
                hotelName: candidate.hotelName,
                dates: [candidate.checkIn, candidate.checkOut].filter((date): date is string =>
                  Boolean(date),
                ),
              },
              sourceInvalidations,
              sourceMessages,
              allowHotelFallback,
            ),
        );
  const hotels = dedupeHotels(
    allowHotelFallback
      ? sourceHotels
      : [
          ...extractedHotels.map((candidate) => {
            const matches = sourceHotels.filter(
              (other) =>
                other.threadId === candidate.threadId && other.messageId === candidate.messageId,
            );
            const other = matches.length === 1 ? matches[0] : undefined;
            const fields = [
              'hotelName',
              'address',
              'city',
              'checkIn',
              'checkOut',
              'bookingReference',
            ] as const;
            if (
              !other ||
              fields.some(
                (field) =>
                  candidate[field] &&
                  other[field] &&
                  normalizePlace(candidate[field]) !== normalizePlace(other[field]),
              )
            )
              return candidate;
            return {
              ...other,
              ...candidate,
              hotelName: candidate.hotelName ?? other.hotelName,
              address: candidate.address ?? other.address,
              city: candidate.city ?? other.city,
              checkIn: candidate.checkIn ?? other.checkIn,
              checkOut: candidate.checkOut ?? other.checkOut,
              bookingReference: candidate.bookingReference ?? other.bookingReference,
            };
          }),
          ...sourceHotels.filter(
            (other) =>
              !extractedHotels.some(
                (candidate) =>
                  candidate.threadId === other.threadId && candidate.messageId === other.messageId,
              ),
          ),
        ],
  );
  const bookedGroups = bookedRouteGroups(sourceMessages, flightSegments);
  const bookedTransfer = !flight ? bookedHotelTransfer(request, bookedGroups, hotels) : undefined;
  const tripHotelAnchorDate = flight
    ? destinationCivilDate(flight)
    : currentTripReturn?.segment?.departureDate;
  const standaloneHotelObservations = hotels.filter((candidate) => {
    if (!tripHotelAnchorDate) return true;
    if (!candidate.checkIn || !candidate.checkOut) return false;
    if (!candidate.city) return false;
    const tripCity = flight?.destinationCity ?? calendarFlightOriginCity(currentTripReturn?.event);
    const overlapsAnchor =
      Boolean(tripCity) &&
      normalizePlace(candidate.city) === normalizePlace(tripCity ?? '') &&
      candidate.checkIn <= tripHotelAnchorDate &&
      tripHotelAnchorDate < candidate.checkOut;
    return (
      overlapsAnchor ||
      (candidate.association === 'unlinked' &&
        hotelFitsCurrentTripStay(candidate, currentTripReturn, selectedBookingSegments))
    );
  });
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
  const hotel = relevantHotels.length === 1 ? relevantHotels[0] : bookedTransfer?.hotel;
  const calendarLodging = calendarLodgingObservation(calendarRows, flight, currentTripReturn);
  const calendarLodgingCoveredByEmail = Boolean(
    calendarLodging &&
      standaloneHotelObservations.some(
        (candidate) =>
          normalizePlace(candidate.hotelName ?? candidate.subject) ===
            normalizePlace(calendarLodging.title) &&
          normalizePlace(candidate.city ?? '') === normalizePlace(calendarLodging.city ?? '') &&
          Boolean(
            candidate.checkIn &&
              candidate.checkOut &&
              candidate.checkIn <= (calendarLodging.dateEnd ?? calendarLodging.dateStart) &&
              calendarLodging.dateStart <= candidate.checkOut,
          ),
      ),
  );
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
  const outboundConnectionChain = connectionChainFor(flight?.segment, selectedBookingSegments);
  const legs = outboundConnectionChain.segments;
  const connectionSummary = connectionChainSummary(flight?.segment, legs);
  const returnLead = returnFlight?.segment ?? (!flight ? currentTripReturn?.segment : undefined);
  const returnConnectionChain = connectionChainFor(returnLead, selectedBookingSegments);
  const returnLegs = returnConnectionChain.segments;
  const returnConnectionSummary = connectionChainSummary(returnLead, returnLegs);
  const outboundChronology = flight?.segment
    ? outboundConnectionChain.complete
      ? flightChronology([flight.segment, ...legs])
      : outboundConnectionChain.chronology
    : 'unknown';
  const bookedReturnChronology = returnFlight?.segment
    ? returnConnectionChain.complete
      ? flightChronology([returnFlight.segment, ...returnLegs])
      : returnConnectionChain.chronology
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
      : bookedTransfer?.hotel.address
        ? {
            origin: `${bookedTransfer.group.destination} Airport`,
            destination: bookedTransfer.hotel.address,
          }
        : undefined;
  const comparisonFlight =
    flight ??
    (bookedTransfer ? { arrivalAirport: bookedTransfer.group.destination, event: {} } : undefined);
  const mapRoute = evidence.find((row) => {
    if (!successful(row) || row.toolName !== 'maps.directions' || !route) return false;
    const args = object(row.args);
    return args?.origin === route.origin && args?.destination === route.destination;
  });
  const mapUrl = safePublicSourceUrl(text(object(mapRoute?.result)?.mapsUrl, 1000))
    ? text(object(mapRoute?.result)?.mapsUrl, 1000)
    : '';
  const webQuery =
    route && comparisonFlight && hotel ? compoundTripWebQuery(comparisonFlight, hotel) : undefined;
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
      comparisonFlight && hotel && webSearch
        ? comparisonFromPage(target.mode, row, webSearch, comparisonFlight, hotel)
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
  if (unreadThreadCount > 0)
    gaps.push(
      `${unreadThreadCount} matching email thread${unreadThreadCount === 1 ? ' remains' : 's remain'} unread or incomplete.`,
    );
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
  else if (!hotel && hotels.length > 0)
    gaps.push(
      'I found a separately dated hotel reservation, but could not link it to the selected flight.',
    );
  else if (!hotel && completeThreads.length > 0)
    gaps.push('I did not identify a hotel booking candidate in the complete email threads I read.');
  else if (!hotel)
    gaps.push(
      'I could not verify a hotel booking because no complete booking-email thread was read.',
    );
  else if (!hotel.address) gaps.push('The hotel candidate did not include an explicit address.');
  else if (hotel.association === 'unlinked' && !bookedTransfer)
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
        candidate.calendarConflicts?.includes('carrier') && candidate.calendarCarrier
          ? `Calendar names ${markdownText(candidate.calendarCarrier)} as the carrier; the booking thread names ${markdownText(explicitCarrierLabel(segment.excerpt, segment.flightNumber) ?? 'a different carrier')}.`
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
  if (selectedFlightConflicts.includes('carrier'))
    gaps.push('The calendar and booking thread name different flight carriers.');
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
  const bookingObservationLines = sourceLocalBookingLines(
    request,
    completeThreads,
    calendarRows,
    flightSegments,
  );
  const bookedArrivalDate = bookedTransfer?.group.legs.at(-1)?.arrivalDate;
  const selectedBookingStatesLocalClocks =
    bookedTransfer &&
    sourceMessages.some(
      (message) =>
        message.threadId === bookedTransfer.group.threadId &&
        message.messageId === bookedTransfer.group.legs[0]?.messageId &&
        message.text
          .split(/\r?\n|(?<=[.!?])\s+/)
          .some((line) =>
            /^(?:all\s+)?(?:flight\s+)?(?:times|clocks)\s+(?:shown\s+)?(?:are\s+)?(?:in\s+)?local(?:\s+time)?[.!]?$/i.test(
              line.trim(),
            ),
          ),
    );
  const bookedItineraryLines = bookedTransfer
    ? [
        `The booked itinerary covers ${bookedTransfer.group.legs[0]?.departureDate} to ${bookedGroups.find((group) => group.threadId === bookedTransfer.group.threadId && group.direction === 'return')?.legs.at(-1)?.arrivalDate}. ${bookedArrivalDate && bookedArrivalDate < (request.timeWindow?.timeMin.slice(0, 10) ?? '') ? 'Its outbound arrival is already past; this is a current-trip booking, not a newly departing trip.' : 'This is a booking candidate; the next departure is not fully verified.'}`,
        ...bookedGroups
          .filter((group) => group.threadId === bookedTransfer.group.threadId)
          .map(
            (group) =>
              `${group.direction === 'outbound' ? 'Outbound' : 'Return'} itinerary group ${group.origin}→${group.destination} (direction inferred from the reversed route groups): ${group.legs.map(formatFlightSegment).join('; ')}. [Booking email](${mailLinks.get(group.threadId)}).`,
          ),
        ...bookedCalendarDifferences(
          bookedGroups.filter((group) => group.threadId === bookedTransfer.group.threadId),
          calendarRows,
          mailLinks,
        ),
        `The flight clocks above are source-stated${selectedBookingStatesLocalClocks ? ' local' : ''} clocks. Their time zones and exact connection durations remain unverified; I have not converted them using the calendar’s offset.`,
        `Airport-to-hotel comparison uses the booked arrival airport and this separately booked hotel’s matching city/check-in date. This association is an inference; flight and hotel have separate booking references.`,
      ]
    : [];
  const itinerary = [
    ...bookedItineraryLines,
    ...(bookedTransfer ? [] : bookingObservationLines),
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
    !hotel
      ? standaloneHotelObservations
          .filter((candidate) => candidate.association === 'unlinked')
          .map(
            (candidate) =>
              `${candidate.checkIn && candidate.checkOut ? 'Dated hotel' : 'Hotel'} reservation observed separately from the selected flight: ${markdownText(candidate.hotelName || candidate.subject)}${candidate.city ? `, ${markdownText(candidate.city)}` : ''}${candidate.address ? ` — ${markdownText(candidate.address)}` : ''}${candidate.checkIn && candidate.checkOut ? ` (${candidate.checkIn} to ${candidate.checkOut})` : ''}${mailLinks.has(candidate.threadId) ? ` [Booking email](${mailLinks.get(candidate.threadId)})` : ''}. It is not linked to the selected flight.`,
          )
      : [],
    calendarLodging && !calendarLodgingCoveredByEmail
      ? `Calendar lodging candidate, not a confirmed hotel booking: ${markdownText(calendarLodging.title)}${calendarLodging.city ? `, ${markdownText(calendarLodging.city)}` : ''} (calendar range ${calendarLodging.dateStart}${calendarLodging.dateEnd ? ` to ${calendarLodging.dateEnd}` : ''})${calendarLodging.sourceUrl ? ` [Calendar source](${calendarLodging.sourceUrl})` : ''}. ${calendarLodging.association === 'shared_reference' ? 'The calendar entry carries the same booking reference.' : 'Its city and date overlap make it a candidate, not proof of the same stay.'}`
      : '',
    hotel?.association === 'shared_reference'
      ? 'The hotel and flight sources share a booking reference.'
      : '',
    hotel?.association === 'date_city_candidate'
      ? 'The hotel was booked separately; its stay dates and city align with this flight, so I treated the connection as an inference rather than a shared booking.'
      : '',
    hotel?.association === 'unlinked' && !bookedTransfer
      ? 'I could not link this hotel candidate to the flight.'
      : '',
    mapRoute
      ? `Driving estimate from ${markdownText(route?.origin ?? 'the arrival airport')} to the hotel candidate: ${routeDuration(mapRoute.result)}; this is not a taxi quote.${mapUrl ? ` [Maps route](${mapUrl})` : ''}`
      : '',
    ...comparison.map(
      (item) =>
        `${item.mode === 'public transport' ? 'Public transport' : 'Taxi'} source checked${item.fare ? `; source-reported fare ${item.fare}` : ''}${item.duration ? `; source-reported duration ${item.duration}` : ''}${item.quote ? `; “${markdownText(item.quote)}”` : ''} [${item.title}](${item.url}).`,
    ),
    ...gaps.map((gap) => `Needs confirmation: ${gap}`),
  ].filter(Boolean);
  const sourceGroups = bookedGroups.filter(
    (group) => group.threadId === bookedTransfer?.group.threadId,
  );
  const presentationGroups = flight?.segment
    ? [
        { label: 'Outbound', inferred: false, legs: [flight.segment, ...legs] },
        ...(returnFlight?.segment
          ? [{ label: 'Return', inferred: false, legs: [returnFlight.segment, ...returnLegs] }]
          : []),
      ]
    : sourceGroups.length
      ? sourceGroups.map((group) => ({
          label: group.direction === 'outbound' ? 'Outbound' : 'Return',
          inferred: true,
          legs: group.legs,
        }))
      : currentTripReturn?.segment
        ? [
            {
              label: 'Return',
              inferred: false,
              legs: [
                currentTripReturn.segment,
                ...connectionSegments(currentTripReturn.segment, flightSegments),
              ],
            },
          ]
        : [{ label: 'Candidate', inferred: false, legs: flightSegments }];
  const bookingReturn = sourceGroups.find((group) => group.direction === 'return')?.legs[0]
    ?.departureDate;
  const currentBooking =
    bookedArrivalDate && bookedArrivalDate < (request.timeWindow?.timeMin.slice(0, 10) ?? '');
  const matchedCalendarNotes = [flight, returnFlight, currentTripReturn].flatMap((candidate) => {
    const segment = candidate?.segment;
    if (!candidate || !segment) return [];
    const instant = sourceLocalInstant(segment);
    const calendarInstant = Date.parse(candidate.instant);
    const comparableClocks = instant !== undefined && Number.isFinite(calendarInstant);
    const clockConflict = comparableClocks && Math.abs(instant - calendarInstant) > 5 * 60_000;
    const clockAgreement =
      comparableClocks && instant === calendarInstant && !candidate.calendarConflicts?.length;
    const metadata = [
      candidate.calendarConflicts?.includes('flight-number')
        ? `flight ${candidate.flightNumber} vs ${segment.flightNumber}`
        : '',
      candidate.calendarConflicts?.includes('carrier')
        ? `carrier ${candidate.calendarCarrier} vs ${explicitCarrierLabel(segment.excerpt, segment.flightNumber) ?? 'different source carrier'}`
        : '',
      candidate.calendarConflicts?.includes('direction')
        ? `direction ${candidate.calendarDirection} vs ${segment.direction}`
        : '',
      candidate.calendarConflicts?.includes('arrival-airport')
        ? `arrival ${candidate.calendarReportedArrivalAirport} vs ${candidate.arrivalAirport}`
        : '',
    ].filter(Boolean);
    return [
      `Calendar ${markdownText(text(candidate.event.summary, 120))}, start ${calendarField(candidate.event, 'start')}; booking ${segment.flightNumber}, ${segment.departureDate} ${segment.departureTime} (${segment.departureTimeZone ?? 'zone unknown'}). ${metadata.length ? `${metadata.map(markdownText).join('; ')}. ` : ''}${clockConflict ? 'Clocks differ after time-zone conversion. ' : clockAgreement ? 'Departure clocks agree after time-zone conversion. ' : comparableClocks && metadata.length ? 'Clock comparison does not resolve conflicting itinerary metadata. ' : comparableClocks ? 'Departure clocks differ within the five-minute itinerary matching tolerance; verify the exact departure time. ' : 'Departure clock agreement remains unverified. '}Itinerary association; independent flight identity remains unverified.${clockConflict || metadata.length ? ' Verify which schedule is current.' : ''}${calendarSource(candidate.event) ? ` [Calendar](${calendarSource(candidate.event)})` : ''}${mailLinks.get(segment.threadId) ? ` [Booking](${mailLinks.get(segment.threadId)})` : ''}`,
    ];
  });
  const conciseSummary = flight?.segment
    ? `Next calendar-matched outbound: ${flight.segment.departureDate}${returnFlight?.segment ? `; return ${returnFlight.segment.departureDate}` : '; return not verified'}.`
    : currentTripReturn?.segment || currentBooking
      ? `The booking is for a current trip, with a return ${currentTripReturn?.segment?.departureDate ?? bookingReturn ?? 'date not verified'}. A new outbound trip is not verified.`
      : bookedTransfer
        ? `Booking candidate: ${bookedTransfer.group.legs[0]?.departureDate}–${bookingReturn}. I could not verify this as the next outbound trip.`
        : 'I could not identify one verified next trip. These checked records remain candidates.';
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
    flightSegments: selectedBookingSegments.length
      ? selectedBookingSegments
      : bookedTransfer
        ? bookedGroups
            .filter((group) => group.threadId === bookedTransfer.group.threadId)
            .flatMap((group) => group.legs)
        : [],
    bookingObservationLines,
    unmatchedBookingSegments,
    ...(connectionSummary ? { connectionSummary } : {}),
    ...(route ? { routeOrigin: route.origin, routeDestination: route.destination } : {}),
    ...(webQuery ? { webQuery } : {}),
    ...(mapRoute ? { mapRoute: object(mapRoute.result) } : {}),
    ...(webSearch ? { webSearch: object(webSearch.result) } : {}),
    webFetches,
    comparison,
    blocked: gaps.length > 0 || !webSearch,
    presentation: {
      summary: conciseSummary,
      groups: presentationGroups,
      hotels: hotel ? [hotel] : standaloneHotelObservations,
      calendarNotes: sourceGroups.length
        ? bookedCalendarDifferences(sourceGroups, calendarRows, mailLinks, true)
        : matchedCalendarNotes,
      calendarObservations: partialCalendarLines,
      gaps,
      associationInferred: Boolean(bookedTransfer || hotel?.association === 'date_city_candidate'),
      localClocks: Boolean(selectedBookingStatesLocalClocks),
    },
    text: [
      partialCalendarLines.length > 0 && !flight
        ? 'I checked the available trip sources. Here are limited calendar observations, not a verified itinerary:'
        : `I checked the available trip sources. Here is the ${gaps.length === 0 ? 'source-checked' : 'supported partial'} itinerary:`,
      ...itinerary,
      'I did not book, change, or send anything.',
    ].join('\n\n'),
  };
}

/** Publish a compact view; the full typed ledger and all blocking gaps stay internal. */
export function renderCompoundTripReadResponse(projection: CompoundTripReadProjection): string {
  const view = projection.presentation;
  const cell = (value: string) => markdownText(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const clock = (date: string | undefined, time: string | undefined, zone: string | undefined) =>
    `${date ?? 'date unknown'} ${time ?? 'time unknown'} (${zone ?? 'zone unknown'})`;
  const links = threadSourceLinks(projection.readThreads);
  const lines = [view.summary];
  const groups = view.groups.filter((group) => group.legs.length);
  if (groups.length) {
    const table = ['| Leg | Departure | Arrival | Source |', '|---|---|---|---|'];
    for (const group of groups) {
      for (const leg of group.legs) {
        table.push(
          `| ${cell(`${group.label}${group.inferred ? '*' : ''}: ${leg.flightNumber} ${leg.originAirport ?? '?'}→${leg.destinationAirport ?? '?'}`)} | ${cell(clock(leg.departureDate, leg.departureTime, leg.departureTimeZone))} | ${cell(clock(leg.arrivalDate, leg.arrivalTime, leg.arrivalTimeZone))} | ${links.get(leg.threadId) ? `[Booking](${links.get(leg.threadId)})` : 'link unavailable'} |`,
        );
      }
    }
    lines.push(table.join('\n'));
    if (groups.some((group) => group.inferred))
      lines.push('*Direction inferred from the reversed itinerary route groups.*');
    if (view.localClocks)
      lines.push(
        'The selected booking explicitly labels its clocks local; time-zone offsets remain unverified.',
      );
  }
  if (!groups.length && view.calendarObservations.length)
    lines.push(view.calendarObservations.join('\n\n'));
  for (const hotel of view.hotels.slice(0, 3)) {
    const hotelLabel =
      hotel.association === 'shared_reference'
        ? 'Hotel booking (shared reference)'
        : hotel.association === 'date_city_candidate'
          ? 'Hotel candidate (city/date match; separate booking)'
          : view.associationInferred
            ? 'Hotel candidate (separate booking; transfer association inferred)'
            : 'Unlinked hotel candidate';
    lines.push(
      `${hotelLabel}: **${cell(hotel.hotelName ?? hotel.subject)}** — ${cell(hotel.address ?? 'address unverified')}${hotel.city && !hotel.address?.includes(hotel.city) ? `, ${cell(hotel.city)}` : ''}; ${hotel.checkIn ?? 'check-in unknown'} to ${hotel.checkOut ?? 'check-out unknown'}.${links.get(hotel.threadId) ? ` [Booking](${links.get(hotel.threadId)})` : ''}`,
    );
  }
  if (!view.hotels.length) lines.push('Hotel: no verified linked stay; see gaps below.');
  if (view.hotels.length > 3)
    lines.push(`${view.hotels.length - 3} additional hotel records remain unresolved.`);
  if (view.associationInferred)
    lines.push(
      'Flight–hotel association inferred from matching arrival/check-in date and city; separate bookings.',
    );
  if (view.calendarNotes.length) {
    const visibleCalendarNotes = view.calendarNotes.slice(0, 4);
    const omittedCalendarNotes = view.calendarNotes.length - visibleCalendarNotes.length;
    lines.push(
      `Calendar vs booking: ${visibleCalendarNotes.join(' ')}${omittedCalendarNotes > 0 ? ` ${omittedCalendarNotes} additional calendar comparisons omitted from this brief; all were reviewed.` : ''}`,
    );
  }
  if (projection.routeOrigin && projection.routeDestination) {
    lines.push(
      `Transfer candidate: **${cell(projection.routeOrigin)} → ${cell(projection.routeDestination)}**.`,
    );
    const table = ['| Option | Fare | Duration | Source |', '|---|---|---|---|'];
    for (const mode of ['public transport', 'taxi'] as const) {
      const item = projection.comparison.find(
        (entry) => entry.mode === mode && entry.endpointMatched,
      );
      table.push(
        `| ${mode === 'taxi' ? 'Taxi' : 'Public transport'} | ${cell(item?.fare ?? 'unverified')} | ${cell(item?.duration ?? 'unverified')} | ${item ? `[Source](${item.url})` : 'no checked endpoint-matched source'} |`,
      );
    }
    lines.push(table.join('\n'));
    if (
      projection.mapRoute &&
      !projection.comparison.some((item) => item.mode === 'taxi' && item.duration)
    ) {
      const url = text(projection.mapRoute.mapsUrl, 1000);
      lines.push(
        `Driving estimate: ${routeDuration(projection.mapRoute)}; not a taxi quote.${safePublicSourceUrl(url) ? ` [Maps](${url})` : ''}`,
      );
    }
  } else
    lines.push('Airport-to-hotel comparison: endpoints or trip association remain unverified.');
  const unknowns = new Set<string>();
  for (const gap of view.gaps) {
    if (/overlap or run in reverse|return leaves before/i.test(gap))
      unknowns.add('Flight chronology conflicts; verify the itinerary before travel.');
    else if (/calendar.*(?:conflict|differ)|booking.*(?:conflict|differ)/i.test(gap)) {
      if (!view.calendarNotes.length) unknowns.add(gap);
    } else if (/coverage|matching email threads?[^.]*unread|booking-email search/i.test(gap)) {
      if (!projection.calendarComplete) unknowns.add('Calendar coverage is incomplete.');
      if (!projection.gmailSearchComplete || !projection.threadsComplete)
        unknowns.add('Booking-email search or thread coverage is incomplete.');
      if (
        projection.calendarComplete &&
        projection.gmailSearchComplete &&
        projection.threadsComplete
      )
        unknowns.add(gap);
    } else if (/time.zone|source clock|chronological order/i.test(gap))
      unknowns.add('Flight time zones and exact connection timing remain unverified.');
    else if (/connection|nonstop|connecting leg/i.test(gap))
      unknowns.add('Connection/nonstop completeness remains unverified.');
    else if (/outbound|which flight is next|which leg is next|plausible flight/i.test(gap)) {
      /* The answer-first summary carries next-trip uncertainty. */
    } else if (/hotel|stay dates|lodging/i.test(gap))
      unknowns.add('Hotel selection, stay details or flight association remain unverified.');
    else if (
      /driving route|public.transport|taxi|route comparison|route endpoints|source to inspect|source results/i.test(
        gap,
      )
    )
      unknowns.add('Transfer fares/times or endpoint-matched source coverage remain incomplete.');
    else unknowns.add(gap);
  }
  if (unknowns.size) lines.push(`Unverified: ${[...unknowns].join(' ')}`);
  return lines.join('\n\n');
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
    allSegments,
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
  const matchedLeads = [
    flight?.segment,
    trip.returnFlight?.segment,
    trip.currentTripReturn?.segment,
    returnOnly.currentTripReturn?.segment,
  ].filter((segment): segment is CompoundTripFlightSegment => segment !== undefined);
  const matchedSegments = matchedLeads.flatMap((segment) => [
    segment,
    ...connectionSegments(segment, allSegments),
  ]);
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
  const selectedCalendarCandidates = flightCandidates(request, trip.calendarRows);
  const selectedCalendarCandidateCount = selectedFlight
    ? selectedCalendarCandidates.filter(
        (candidate) => Date.parse(candidate.instant) === selectedInstant,
      ).length
    : 0;
  const earlierCalendarFlight = selectedFlight
    ? selectedCalendarCandidates.some(
        (candidate) => Date.parse(candidate.instant) < selectedInstant,
      )
    : false;
  const earlierUnresolvedAllDayFlight = hasEarlierUnresolvedAllDayFlight(
    trip.calendarRows,
    selectedFlight,
  );
  const earlierUnresolvedTimedFlight = hasEarlierUnresolvedTimedFlight(
    trip.calendarRows,
    selectedFlight,
  );
  const calendarPrefixCompleteThroughCandidate = Boolean(
    flight?.segment &&
      !earlierCalendarFlight &&
      !earlierUnresolvedAllDayFlight &&
      !earlierUnresolvedTimedFlight &&
      selectedCalendarCandidateCount === 1 &&
      trip.gmailSearchComplete &&
      trip.threadsComplete &&
      !matchedFlightAmbiguous &&
      !unmatchedBookingAmbiguous &&
      !unmatchedCandidatePrecedesSelected &&
      !(unmatchedBookingCandidate && unmatchedBookingCandidate.departureDate === selectedDate) &&
      calendarPrefixCoversCandidate(trip.calendarRows, flight),
  );
  const gaps: string[] = [];
  if (!trip.calendarComplete && !calendarPrefixCompleteThroughCandidate)
    gaps.push('Calendar search coverage is incomplete, so an earlier flight may be missing.');
  if (earlierUnresolvedAllDayFlight)
    gaps.push(
      'An earlier all-day calendar flight candidate has no departure time, so I could not establish whether it precedes this flight.',
    );
  if (earlierUnresolvedTimedFlight)
    gaps.push(
      'An earlier calendar flight candidate has no explicit time-zone offset, so I could not establish whether it precedes this flight.',
    );
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
  const summary: string[] = [...(trip.bookingObservationLines ?? [])];
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
      const selectedSegment = selectedFlight.segment;
      const selectedConnections = selectedSegment
        ? connectionSegments(selectedSegment, allSegments)
        : [];
      if (selectedSegment && selectedConnections.length > 0)
        summary.push(
          `Source-backed connected flight segments: ${[selectedSegment, ...selectedConnections].map(formatFlightSegment).join('; ')}.`,
        );
      if (selectedFlight.segment && selectedFlight.calendarConflicts?.includes('flight-number'))
        summary.push(
          `Source conflict: the calendar labels this ${text(selectedFlight.event.summary, 160) || 'event'}${selectedFlight.flightNumber ? ` as ${selectedFlight.flightNumber}` : ''}, while the booking email confirms ${selectedFlight.segment.flightNumber}.`,
        );
      if (selectedFlight.segment && selectedFlight.calendarConflicts?.includes('carrier'))
        summary.push(
          `Source conflict: the calendar names ${selectedFlight.calendarCarrier ?? 'another carrier'}, while the booking email names ${explicitCarrierLabel(selectedFlight.segment.excerpt, selectedFlight.segment.flightNumber) ?? 'a different carrier'}.`,
        );
      if (selectedFlight.segment && selectedFlight.calendarConflicts?.includes('direction'))
        summary.push(
          `Source conflict: the calendar labels this as a ${selectedFlight.calendarDirection} flight, while the booking email labels it ${selectedFlight.segment.direction}.`,
        );
      if (selectedFlight.segment && selectedFlight.calendarConflicts?.includes('arrival-airport'))
        summary.push(
          `Source conflict: the calendar reports arrival airport ${selectedFlight.calendarReportedArrivalAirport}, while the booking itinerary ends at ${selectedFlight.segment.destinationAirport ?? 'an unstated airport'}.`,
        );
      const bookedDeparture = selectedFlight.segment
        ? sourceLocalInstant(selectedFlight.segment)
        : undefined;
      const calendarDeparture = Date.parse(selectedFlight.instant);
      if (
        bookedDeparture !== undefined &&
        Number.isFinite(bookedDeparture) &&
        Number.isFinite(calendarDeparture) &&
        Math.abs(bookedDeparture - calendarDeparture) > 5 * 60_000
      )
        summary.push(
          'Source conflict: the calendar event time differs from the booking departure time after time-zone conversion. I have not verified which reflects the current schedule.',
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
  if (calendarPrefixCompleteThroughCandidate && !trip.calendarComplete)
    summary.push(
      'Calendar coverage is proven through this flight across the checked calendars; later dates in the requested 365-day window were not fully read.',
    );
  return {
    calendarComplete: trip.calendarComplete,
    calendarPrefixCompleteThroughCandidate,
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

function sentenceNamesAirport(
  sentence: string,
  flight: Pick<CompoundTripFlightCandidate, 'arrivalAirport' | 'segment' | 'event'>,
): boolean {
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
  flight: Pick<CompoundTripFlightCandidate, 'arrivalAirport' | 'segment' | 'event'>,
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
