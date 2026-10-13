import type { PersonalReadRequest, ReadToolEvidence } from './read-intent.js';

const MAX_COMPOUND_CALENDAR_COVERAGE_PAGES = 2;
export const MAX_COMPOUND_TRIP_TOOL_CALLS = 10;

export interface CompoundTripFlightCandidate {
  event: Record<string, unknown>;
  instant: string;
  flightNumber?: string;
  bookingReference?: string;
  arrivalAirport?: string;
  destinationCity?: string;
  sourceOffset?: string;
  sourceTimeZone?: string;
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
  association: 'shared_reference' | 'date_city_candidate' | 'unlinked';
}

export interface CompoundTripReadProjection {
  calendarRows: ReadToolEvidence[];
  calendarComplete: boolean;
  gmailSearchRows: ReadToolEvidence[];
  gmailSearchComplete: boolean;
  readThreads: ReadToolEvidence[];
  threadsComplete: boolean;
  flight?: CompoundTripFlightCandidate;
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
  }>;
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

function bookingReference(value: string): string | undefined {
  const match =
    /\b(?:booking|reservation|confirmation)(?:\s+(?:booking|reservation|confirmation))?\s+(?:reference|ref|number|code|id|no\.?|#)\s*[:#-]?\s*([A-Z0-9]{5,12})\b|\b(?:PNR|record locator)\s*[:#-]?\s*([A-Z0-9]{5,12})\b/i.exec(
      value,
    );
  return (match?.[1] ?? match?.[2])?.toUpperCase();
}

function flightNumber(value: string): string | undefined {
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
        ...(flightNumber(details) ? { flightNumber: flightNumber(details) } : {}),
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

function threadMessages(row: ReadToolEvidence): Array<Record<string, unknown>> {
  const messages = object(row.result)?.messages;
  return Array.isArray(messages)
    ? (messages.map(object).filter(Boolean) as Array<Record<string, unknown>>)
    : [];
}

function hotelCandidates(
  threads: ReadonlyArray<ReadToolEvidence>,
  flight: CompoundTripFlightCandidate | undefined,
): CompoundTripHotelCandidate[] {
  const candidates: CompoundTripHotelCandidate[] = [];
  for (const row of threads) {
    const threadId = text(object(row.args)?.threadId, 100);
    for (const message of threadMessages(row)) {
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
      const flightDate = flight ? sourceCivilDate(flight.event) : undefined;
      const dateCityCandidate = Boolean(
        flight &&
          city &&
          flight.destinationCity &&
          normalizePlace(city) === normalizePlace(flight.destinationCity) &&
          checkIn &&
          checkOut &&
          flightDate &&
          flightDate >= checkIn &&
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
        association: sharedReference
          ? 'shared_reference'
          : dateCityCandidate
            ? 'date_city_candidate'
            : 'unlinked',
      });
    }
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
  const isoIn = /\bcheck[- ]?in\s*:?\s*(20\d{2}-\d{2}-\d{2})\b/i.exec(body)?.[1];
  const isoOut = /\bcheck[- ]?out\s*:?\s*(20\d{2}-\d{2}-\d{2})\b/i.exec(body)?.[1];
  if (isoIn || isoOut)
    return { ...(isoIn ? { checkIn: isoIn } : {}), ...(isoOut ? { checkOut: isoOut } : {}) };
  const monthDate = (label: 'check[- ]?in' | 'check[- ]?out') =>
    new RegExp(
      `\\b${label}\\s*:?\\s*(January|February|March|April|May|June|July|August|September|October|November|December)\\s+(\\d{1,2})(?:,?\\s+(20\\d{2}))?`,
      'i',
    ).exec(body);
  const namedIn = monthDate('check[- ]?in');
  const namedOut = monthDate('check[- ]?out');
  if (namedIn || namedOut) {
    const toIso = (match: RegExpExecArray | null): string | undefined => {
      if (!match?.[1] || !match[2]) return undefined;
      const year = match[3] ?? /\b(20\d{2})\b/i.exec(body)?.[1];
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
  const range =
    /\b(?:stay|reservation|booking)?\s*(?:dates?|from)\s*:?\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:\s*[-–—]\s*(?:(January|February|March|April|May|June|July|August|September|October|November|December)\s+)?(\d{1,2}))?,?\s*(20\d{2})\b/i.exec(
      body,
    );
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
  const raw = text(event.start, 80);
  return /^20\d{2}-\d{2}-\d{2}T/.test(raw) ? raw.slice(0, 10) : undefined;
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
    gmailSearchRows.length > 0 &&
    gmailSearchRows.length <= 3 &&
    object(gmailSearchRows.at(-1)?.result)?.complete === true &&
    object(gmailSearchRows.at(-1)?.result)?.hasMore !== true;
  const threadIds = new Set(
    gmailSearchRows.flatMap((row) => {
      const results = object(row.result)?.results;
      return Array.isArray(results)
        ? results.map((item) => text(object(item)?.threadId, 100)).filter(Boolean)
        : [];
    }),
  );
  const allThreadsRead =
    threadIds.size === 0
      ? gmailSearchRows.length > 0
      : [...threadIds].every((id) =>
          readThreads.some(
            (row) =>
              text(object(row.args)?.threadId, 100) === id && object(row.result)?.complete === true,
          ),
        );
  const candidates = flightCandidates(request, calendarRows);
  const flight = candidates[0];
  const flightConfirmation = flight
    ? readThreads.find((row) =>
        threadMessages(row).some((message) => {
          const source = `${text(message.subject, 240)}\n${text(message.text, 8000)}`;
          if (!/\b(?:flight|itinerary|boarding pass|e-?ticket)\b/i.test(source)) return false;
          const sameReference = Boolean(
            flight.bookingReference && bookingReference(source) === flight.bookingReference,
          );
          const sameFlightNumber = Boolean(
            flight.flightNumber && flightNumber(source) === flight.flightNumber,
          );
          return sameReference || sameFlightNumber;
        }),
      )
    : undefined;
  const hotels = dedupeHotels(hotelCandidates(readThreads, flight));
  const hotel = hotels.length === 1 ? hotels[0] : undefined;
  const route = flight && hotel ? compoundTripRouteFromCandidates(flight, hotel) : undefined;
  const mapRoute = evidence.find((row) => {
    if (!successful(row) || row.toolName !== 'maps.directions' || !route) return false;
    const args = object(row.args);
    return args?.origin === route.origin && args?.destination === route.destination;
  });
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
    const fetchedText = text(object(row.result)?.text, 20_000).toLowerCase();
    const endpointMatched = Boolean(
      flight?.arrivalAirport &&
        fetchedText.includes(flight.arrivalAirport.toLowerCase()) &&
        (hotel?.city || hotel?.hotelName) &&
        fetchedText.includes((hotel.city || hotel.hotelName || '').toLowerCase()),
    );
    return [{ mode: target.mode, row, endpointMatched }];
  });
  const gaps: string[] = [];
  if (!calendarComplete)
    gaps.push('Calendar coverage is incomplete, so I cannot establish which flight is next.');
  if (!gmailSearchComplete || !allThreadsRead)
    gaps.push('Booking-email search or thread coverage is incomplete.');
  if (!flight) gaps.push('I found no dated flight candidate in the checked calendar range.');
  else if (!flightConfirmation)
    gaps.push(
      'I could not link the calendar flight candidate to a booking confirmation by flight number or booking reference.',
    );
  if (hotels.length > 1)
    gaps.push('More than one hotel booking candidate matched; I could not choose one safely.');
  else if (!hotel)
    gaps.push('I could not identify one hotel booking candidate in the checked email threads.');
  else if (!hotel.address) gaps.push('The hotel candidate did not include an explicit address.');
  else if (hotel.association === 'date_city_candidate')
    gaps.push(
      'The hotel dates and city overlap this calendar flight candidate, but no shared booking identifier proves they belong to the same itinerary.',
    );
  else if (hotel.association === 'unlinked')
    gaps.push(
      'I found the hotel independently, but could not establish that it belongs to this flight itinerary.',
    );
  if (hotel && flight && (!hotel.checkIn || !hotel.checkOut))
    gaps.push('The hotel stay dates were not both explicit in the source.');
  if (flight && !flight.event.timeZone)
    gaps.push(
      'The calendar event did not name a time zone, so its local departure zone is unverified.',
    );
  if (flight && !flightConfirmation)
    gaps.push('Connections and booking-specific departure-time details remain unverified.');
  else if (flight)
    gaps.push(
      'The flight email candidate shares a flight identifier, but its departure time zone and connection segments have not been normalized.',
    );
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
  gaps.push(
    'The checked pages do not provide a structured, verified door-to-door transit-versus-taxi comparison.',
  );
  const calendarUrl = flight ? calendarSource(flight.event) : '';
  const mailLinks = threadSourceLinks(readThreads);
  const flightTitle = text(flight?.event.summary, 140).replace(/[[\]()*_`<>]/g, '');
  const flightStart = flight?.instant;
  const localFlightTime = flightStart
    ? new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: request.timeZone ?? 'UTC',
      }).format(new Date(flightStart))
    : '';
  const itinerary = [
    flight
      ? `Flight candidate: ${flightTitle || 'calendar flight'} — ${localFlightTime} (${request.timeZone ?? 'UTC'} calendar display time${flight.sourceOffset ? `; source timestamp offset ${flight.sourceOffset}` : ''}${flight.sourceTimeZone ? `; source time zone ${flight.sourceTimeZone}` : ''})${calendarUrl ? ` [Calendar source](${calendarUrl})` : ''}${flightConfirmation && mailLinks.has(text(object(flightConfirmation.args)?.threadId)) ? `; [email candidate sharing a flight identifier](${mailLinks.get(text(object(flightConfirmation.args)?.threadId))})` : ''}.`
      : '',
    flight?.flightNumber ? `Flight number shown: ${flight.flightNumber}.` : '',
    hotel
      ? `Separately sourced hotel candidate: ${hotel.hotelName || hotel.subject}${hotel.city ? `, ${hotel.city}` : ''}${hotel.address ? ` — ${hotel.address}` : ''}${hotel.checkIn && hotel.checkOut ? ` (${hotel.checkIn} to ${hotel.checkOut})` : ''}${mailLinks.has(hotel.threadId) ? ` [Booking email](${mailLinks.get(hotel.threadId)})` : ''}.`
      : '',
    hotel?.association === 'shared_reference'
      ? 'The hotel and flight sources share a booking reference.'
      : '',
    hotel?.association === 'date_city_candidate'
      ? 'The hotel dates and destination city overlap the flight candidate, but this does not prove they are the same itinerary.'
      : '',
    hotel?.association === 'unlinked' ? 'I could not link this hotel candidate to the flight.' : '',
    mapRoute
      ? `Driving estimate from ${route?.origin} to the hotel candidate: ${routeDuration(mapRoute.result)}; this is not a taxi quote.`
      : '',
    webSearch ? webSearchSummary(webSearch) : '',
    ...webFetches.map(({ mode, row, endpointMatched }) => {
      const result = object(row.result);
      const sourceUrl = safePublicSourceUrl(text(result?.finalUrl, 1000))
        ? text(result?.finalUrl, 1000)
        : '';
      return `${mode === 'public transport' ? 'Public-transport' : 'Taxi'} source checked${endpointMatched ? ' (it mentions both route endpoints)' : ''}${sourceUrl ? `: [source](${sourceUrl})` : ''}.`;
    }),
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
    ...(flightConfirmation
      ? { flightConfirmationThreadId: text(object(flightConfirmation.args)?.threadId, 100) }
      : {}),
    ...(hotel ? { hotel } : {}),
    ...(route ? { routeOrigin: route.origin, routeDestination: route.destination } : {}),
    ...(webQuery ? { webQuery } : {}),
    ...(mapRoute ? { mapRoute: object(mapRoute.result) } : {}),
    ...(webSearch ? { webSearch: object(webSearch.result) } : {}),
    webFetches,
    blocked: gaps.length > 0 || !webSearch,
    text: [
      'I checked the available trip sources. Here is the supported partial itinerary:',
      ...itinerary,
      'I did not book, change, or send anything.',
    ].join('\n\n'),
  };
}

function compoundTripRouteFromCandidates(
  flight: CompoundTripFlightCandidate,
  hotel: CompoundTripHotelCandidate,
): { origin: string; destination: string } | undefined {
  if (!flight.arrivalAirport || !hotel.address || hotel.association !== 'date_city_candidate')
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

function webSearchSummary(row: ReadToolEvidence): string {
  const results = object(row.result)?.results;
  if (!Array.isArray(results))
    return 'Public transport and taxi search returned no readable source list.';
  const lines = results.slice(0, 4).flatMap((item) => {
    const result = object(item);
    const url = text(result?.url, 1000);
    const title = text(result?.title, 180).replace(/[[\]()*_`<>]/g, '');
    const snippet = text(result?.snippet, 260).replace(/[<>]/g, '');
    if (!title || !snippet || !safePublicSourceUrl(url)) return [];
    return [`- [${title}](${url}): ${snippet}`];
  });
  return lines.length
    ? `Public transport/taxi search results to review (not a verified itinerary or fare):\n${lines.join('\n')}`
    : 'Public transport and taxi search did not return a source I can cite safely.';
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
