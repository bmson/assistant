import { sameCalendarOccurrence } from '@assistant/persistence';
import type { LiveLookup } from './live-lookup.js';
import type { PersonalReadRequest } from './read-intent.js';
import { effectiveReminders } from './reminder-state.js';
import type { ActionEvidence } from './response-contract.js';

type RecordValue = Record<string, unknown>;
type EventGroup = [RecordValue, ...RecordValue[]];

export interface ResponseCard {
  kind:
    | 'calendar-event'
    | 'weather'
    | 'reminder'
    | 'email-results'
    | 'document-results'
    | 'drive-results'
    | 'web-search-results'
    | 'availability'
    | 'email-thread'
    | 'sheet-rows'
    | 'resource'
    | 'status'
    | 'knowledge-graph'
    | 'calendar-conflicts'
    | 'proactive-alert'
    | 'briefing'
    | 'scoreboard'
    | 'route'
    | 'generated-card';
  id: string;
  [key: string]: unknown;
}

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
    : [];
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * A number that may arrive as a string, because Postgres `numeric` columns
 * come back as text. Returns undefined for anything that is not a finite
 * number either way — `Number(undefined)` is NaN, which JSON writes as null,
 * which a renderer coercing back with `Number()` reads as a confident zero.
 */
function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function succeeded(row: ActionEvidence): boolean {
  if (row.status !== 'succeeded' || row.fromCurrentTask === false) return false;
  const result = record(row.result);
  return (
    result?.ok !== false &&
    !(typeof result?.status === 'number' && result.status >= 400) &&
    result?.deliveryStatus !== 'unknown'
  );
}

function details(
  entries: Array<[string, string | undefined]>,
): Array<{ label: string; value: string }> {
  return entries.flatMap(([label, value]) => (value ? [{ label, value }] : []));
}

function formatTime(value: string, timeZone?: string): string {
  if (!timeZone) {
    const local = /T(\d{2}):(\d{2})/.exec(value);
    if (local?.[1] && local[2]) {
      const hour = Number(local[1]);
      const minute = local[2];
      const suffix = hour >= 12 ? 'PM' : 'AM';
      return `${hour % 12 || 12}:${minute} ${suffix}`;
    }
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

function isVideoMeetingLink(link: RecordValue | undefined): boolean {
  if (string(link?.type) === 'video') return true;
  try {
    const host = new URL(string(link?.url)).hostname.toLowerCase();
    return ['zoom.us', 'meet.google.com', 'teams.microsoft.com', 'webex.com'].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

function isSpecificCalendarLink(link: RecordValue | undefined): boolean {
  const url = string(link?.url);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    return (
      parsed.pathname.toLowerCase().includes('/event') ||
      parsed.search.toLowerCase().includes('eid=') ||
      parsed.search.toLowerCase().includes('eventid=')
    );
  } catch {
    return false;
  }
}

/** Build UI data solely from successful calendar tool results; model prose is not an input. */
export function calendarResponseCards(
  evidence: ActionEvidence[],
  request?: PersonalReadRequest | null,
): ResponseCard[] {
  // A flight departure answer is reconciled against its dated booking. A raw
  // calendar row would present an unverified airline/time as the answer again.
  // Ordinary agenda requests still show their calendar entries below.
  if (request?.answerFocus === 'flight') return [];
  const updatedEventIds = new Set(
    evidence.flatMap((row) => {
      const result = record(row.result);
      if (!succeeded(row) || row.toolName !== 'calendar.update_event' || result?.updated !== true)
        return [];
      const eventId = string(result.eventId);
      return eventId ? [eventId] : [];
    }),
  );
  const events = evidence.flatMap((row) => {
    if (!succeeded(row) || !/^calendar\.(?:list_events|search_events)$/.test(row.toolName))
      return [];
    const result = record(row.result);
    return Array.isArray(result?.events)
      ? result.events
          .map(record)
          .filter((event): event is RecordValue => !!event)
          // A successful update supersedes a flight row read before the write.
          // Keep its canonical receipt card; omit obsolete calendar copies.
          .filter(
            (event) =>
              !updatedEventIds.has(string(event.eventId)) ||
              !/\b(?:flight|airline|boarding|itinerary)\b/i.test(string(event.summary)),
          )
      : [];
  });
  const groups: EventGroup[] = [];
  for (const event of events) {
    const group = groups.find((candidate) =>
      candidate.every((member) => sameCalendarOccurrence(member, event)),
    );
    if (group) group.push(event);
    else groups.push([event]);
  }
  return groups
    .map((group) => {
      const event = group[0];
      const start = string(event.start);
      const end = string(event.end);
      const allDay = event.allDay === true || /^\d{4}-\d{2}-\d{2}$/.test(start);
      const links = Array.isArray(event.links) ? event.links.map(record).filter(Boolean) : [];
      const calendarLink = links.find(
        (link) => string(link?.type) === 'calendar' && isSpecificCalendarLink(link),
      );
      const meetingLink = links.find(isVideoMeetingLink);
      const calendars = [...new Set(group.map((entry) => string(entry.calendar)).filter(Boolean))];
      return {
        kind: 'calendar-event' as const,
        id: `calendar-${group.map((entry) => `${string(entry.calendarId)}:${string(entry.eventId)}`).join('|')}`,
        title: string(event.summary) || 'Untitled event',
        start,
        end,
        time: allDay
          ? 'All day'
          : [formatTime(start, request?.timeZone), end ? formatTime(end, request?.timeZone) : '']
              .filter(Boolean)
              .join('–'),
        allDay,
        location: string(event.location),
        attendees: Array.isArray(event.attendees)
          ? event.attendees
              .filter((value): value is string => typeof value === 'string')
              .slice(0, 3)
          : [],
        calendars,
        calendarLink: calendarLink
          ? { label: string(calendarLink.label) || 'Open event', url: string(calendarLink.url) }
          : undefined,
        meetingLink: meetingLink
          ? {
              label: string(meetingLink.label) || 'Join video meeting',
              url: string(meetingLink.url),
            }
          : undefined,
        // Retain the established field for older clients, but never point an
        // event affordance at the meeting itself.
        link: calendarLink
          ? { label: string(calendarLink.label) || 'Open event', url: string(calendarLink.url) }
          : undefined,
      };
    })
    .sort((a, b) => Date.parse(String(a.start)) - Date.parse(String(b.start)));
}

/**
 * Rain worth naming in a one-line day summary. Mirrors the ambient block's own
 * threshold (see `getAmbientBlock`), so a day reads the same whichever source
 * drew it.
 */
const NOTABLE_RAIN_PROBABILITY = 30;

/** Formatters that drop out entirely when the provider omitted the reading. */
function degrees(value: unknown): string | undefined {
  const parsed = numeric(value);
  return parsed === undefined ? undefined : `${parsed}°C`;
}

function range(low: unknown, high: unknown): string | undefined {
  const from = numeric(low);
  const to = numeric(high);
  return from === undefined || to === undefined ? undefined : `${from}–${to}°C`;
}

function percent(value: unknown): string | undefined {
  const parsed = numeric(value);
  return parsed === undefined ? undefined : `${parsed}%`;
}

function speed(value: unknown): string | undefined {
  const parsed = numeric(value);
  return parsed === undefined ? undefined : `${parsed} km/h`;
}

/**
 * The provider's vocabulary is a closed set of WMO descriptions (see `WMO` in
 * ambient.ts), so the sky is classified once, here, into a small stable
 * vocabulary the clients map to an icon. Neither client re-parses prose, and a
 * description this list does not know degrades to the same default on both.
 *
 * Order matters: "freezing rain" is sleet rather than rain, and "partly cloudy"
 * is its own sky rather than the overcast one.
 */
const WEATHER_SYMBOLS: ReadonlyArray<readonly [RegExp, string]> = [
  [/thunder/, 'thunderstorm'],
  [/snow/, 'snow'],
  [/freezing rain/, 'sleet'],
  [/drizzle/, 'drizzle'],
  [/rain/, 'rain'],
  [/fog/, 'fog'],
  [/partly cloudy|mostly clear/, 'partly-cloudy'],
  [/overcast|cloud/, 'cloudy'],
  [/clear/, 'clear'],
];

function weatherSymbol(description: string): string | undefined {
  const text = description.toLowerCase();
  return WEATHER_SYMBOLS.find(([pattern]) => pattern.test(text))?.[1];
}

/**
 * "early-morning" is the tool's enum spelling; "Early morning" is the owner's.
 * Anything unrecognised is dropped rather than shown raw, so a band the tool
 * adds later never reaches a card as a hyphenated identifier.
 */
const TIME_OF_DAY_NAMES: Record<string, string> = {
  'early-morning': 'Early morning',
  morning: 'Morning',
  midday: 'Midday',
  afternoon: 'Afternoon',
  evening: 'Evening',
  night: 'Night',
};

function bandName(label: string): string {
  return TIME_OF_DAY_NAMES[label.toLowerCase()] ?? '';
}

/** A detail row that also names its own sky, so a day can carry its own icon. */
function weatherDetail(
  label: string,
  value: string,
  description: string,
): { label: string; value: string; symbol?: string } {
  const symbol = weatherSymbol(description);
  return { label, value, ...(symbol ? { symbol } : {}) };
}

/** "16–23°C, light rain, 80% chance of rain" — one day on one line. */
function weatherDayValue(day: RecordValue): string {
  const rain = numeric(day.precipProbabilityMax);
  return [
    range(day.lowC, day.highC) ?? '',
    string(day.description),
    rain !== undefined && rain >= NOTABLE_RAIN_PROBABILITY ? `${rain}% chance of rain` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * One forecast day as numbers, for clients that draw a fixed-column row
 * (weekday, sky, rain, low–high bar) that never wraps. `details` keeps the
 * same days as text for clients that predate this field.
 */
export interface WeatherCardDay {
  weekday: string;
  date?: string;
  lowC: number;
  highC: number;
  precipPct?: number;
  description: string;
  symbol?: string;
}

function weatherCardDay(
  weekday: string,
  day: RecordValue,
  description = string(day.description),
): WeatherCardDay | undefined {
  const lowC = numeric(day.lowC);
  const highC = numeric(day.highC);
  if (!weekday || lowC === undefined || highC === undefined) return undefined;
  const precipPct = numeric(day.precipProbabilityMax ?? day.precipPct);
  const symbol = weatherSymbol(description);
  const date = string(day.date);
  return {
    weekday,
    ...(date ? { date } : {}),
    lowC,
    highC,
    ...(precipPct === undefined ? {} : { precipPct }),
    description,
    ...(symbol ? { symbol } : {}),
  };
}

/** Ambient data is already trusted context, but only a tiny literal subset becomes a card. */
export function weatherResponseCards(ambient?: string): ResponseCard[] {
  if (!ambient) return [];
  const weather =
    /Weather there:\s*([^,]+),\s*(-?\d+)°C\s*\(today\s*(-?\d+)–(-?\d+)°C,\s*(\d+)% chance of rain, wind\s*(\d+) km\/h(?:, humidity\s*(\d+)%)?\)/i.exec(
      ambient,
    );
  if (!weather) return [];
  const [, condition = '', temperature = '', low = '', high = '', rain = '', wind = '', humidity] =
    weather;
  const location =
    /Owner's current location:\s*(?:near\s+)?([^,(\n.]+)/i.exec(ambient)?.[1]?.trim() ||
    'Right now';
  // "Coming days: Tue 16–23°C, partly cloudy; Wed ..." becomes one
  // day-labeled detail per day so the card can group the forecast by day.
  const coming = /^Coming days:\s*(.+?)\.?\s*$/im.exec(ambient)?.[1] ?? '';
  const forecast = coming
    .split(';')
    .map((entry) => /^(\w+)\s+(.+)$/.exec(entry.trim()))
    .filter((day): day is RegExpExecArray => day !== null)
    // The day's own words are inside its value ("16–23°C, light rain"), which
    // is all the sky classification needs to give each day its own icon.
    .map((day) => weatherDetail(day[1] ?? '', day[2] ?? '', day[2] ?? ''));
  const symbol = weatherSymbol(condition);
  const days = [
    weatherCardDay('Today', { lowC: low, highC: high, precipProbabilityMax: rain }, condition),
    ...coming.split(';').map((entry) => {
      const day = /^(\w+)\s+(-?\d+)–(-?\d+)°C,\s*([^,]+?)(?:,\s*(\d+)% chance of rain)?\.?$/.exec(
        entry.trim(),
      );
      if (!day) return undefined;
      const [, weekday = '', dayLow, dayHigh, description = '', dayRain] = day;
      // The ambient line omits a rain chance under 30%; absent is not zero.
      return weatherCardDay(
        weekday,
        { lowC: dayLow, highC: dayHigh, ...(dayRain ? { precipProbabilityMax: dayRain } : {}) },
        description.trim(),
      );
    }),
  ].filter((day): day is WeatherCardDay => day !== undefined);
  return [
    {
      kind: 'weather',
      id: `weather-${temperature}-${condition.toLowerCase()}`,
      location,
      condition,
      temperature: `${temperature}°C`,
      ...(symbol ? { symbol } : {}),
      current: {
        tempC: Number(temperature),
        lowC: Number(low),
        highC: Number(high),
        precipPct: Number(rain),
        windKmh: Number(wind),
        ...(humidity ? { humidity: Number(humidity) } : {}),
      },
      days,
      details: [
        { label: 'Today', value: `${low}–${high}°C` },
        { label: 'Wind', value: `${wind} km/h` },
        ...(humidity ? [{ label: 'Humidity', value: `${humidity}%` }] : []),
        { label: 'Rain chance', value: `${rain}%` },
        ...forecast,
      ],
    },
  ];
}

/**
 * `weather.lookup` answers exactly the questions the ambient block cannot — a
 * day past today, or a town the owner is not standing in — and those answers
 * arrived as bare prose, because no builder read this tool's ledger row. The
 * ambient card deliberately stays off such a turn (it can only describe
 * today-here, and would contradict the answer), which left "how is the weather
 * tomorrow" with no card at all.
 *
 * Built from the same structured result the response contract checked, never
 * from the prose, so a fluent answer still cannot invent a card.
 */
export function weatherLookupResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'weather.lookup') return [];
    const result = record(row.result);
    // A lookup that could not resolve the place returns `{ error }` and no
    // reading. There is nothing to draw, and the prose already explains it.
    if (!result || string(result.error)) return [];
    const current = record(result.current);
    const target = record(result.target);
    const targetDay = record(target?.day);
    const place = string(result.place);
    const forecast = Array.isArray(result.forecast)
      ? result.forecast.map(record).filter((day): day is RecordValue => !!day)
      : [];

    // A dated question is answered about that day, so the card headlines the
    // day rather than the current reading, which belongs to a different one.
    const headline = targetDay ?? current;
    if (!headline) return [];
    const temperature =
      (targetDay ? range(targetDay.lowC, targetDay.highC) : degrees(current?.tempC)) ?? '';
    const condition = string(headline.description);

    // A date asked about without an hour comes back as one row per named part
    // of the day, which is the shape an owner plans around: "Thu Morning",
    // "Thu Evening". Every row keeps its weekday, because that prefix is how
    // both clients group a day's rows together.
    //
    // The clock range always rides in the value, never the label. iOS drops a
    // detail whose label carries digits — that rule keeps prose like "For your
    // 11:00 Zoom meeting" from being torn into a row — so an explicitly-timed
    // window labelled "Thu 13:00–15:00" would have rendered on web and
    // vanished on iOS.
    const windows = Array.isArray(target?.windows)
      ? target.windows
          .map(record)
          .filter((window): window is RecordValue => !!window)
          .map((window) =>
            weatherDetail(
              [string(window.weekday), bandName(string(window.label))].filter(Boolean).join(' '),
              [string(window.window), weatherDayValue(window)].filter(Boolean).join(' · '),
              string(window.description),
            ),
          )
          .filter((detail) => detail.label && detail.value)
      : [];

    const targetDate = string(target?.date);
    const headlineDetails = targetDay
      ? details([
          // iOS stamps the card with this day; both clients read it as a label.
          ['Day', string(target?.weekday)],
          ['Rain chance', percent(targetDay.precipProbabilityMax)],
        ])
      : details([
          ['Today', range(current?.lowC, current?.highC)],
          ['Wind', speed(current?.windKmh)],
          ['Humidity', percent(current?.humidity)],
          ['Rain chance', percent(current?.precipProbabilityMax)],
        ]);

    // The headlined day is already the card's temperature and condition, so it
    // never repeats itself further down the same card.
    const comingDays = forecast
      .filter((day) => !targetDate || string(day.date) !== targetDate)
      .map((day) =>
        weatherDetail(string(day.weekday), weatherDayValue(day), string(day.description)),
      )
      .filter((detail) => detail.label && detail.value);

    const cardDetails = [...headlineDetails, ...windows, ...comingDays];
    // The same days as numbers. The forecast starts tomorrow, so "Today"
    // leads unless today is the day the card already headlines.
    const headlinesToday = !!targetDay && !forecast.some((day) => string(day.date) === targetDate);
    const today = current && !headlinesToday ? weatherCardDay('Today', current) : undefined;
    const days = [
      today,
      ...forecast
        .filter((day) => !targetDate || string(day.date) !== targetDate)
        .map((day) => weatherCardDay(string(day.weekday), day)),
    ].filter((day): day is WeatherCardDay => day !== undefined);
    const currentReading =
      current && !targetDay
        ? Object.fromEntries(
            Object.entries({
              tempC: numeric(current.tempC),
              lowC: numeric(current.lowC),
              highC: numeric(current.highC),
              precipPct: numeric(current.precipProbabilityMax),
              windKmh: numeric(current.windKmh),
              humidity: numeric(current.humidity),
            }).filter(([, value]) => value !== undefined),
          )
        : undefined;
    if (!temperature && !condition && cardDetails.length === 0) return [];
    const symbol = weatherSymbol(condition);
    return [
      {
        kind: 'weather' as const,
        id: `weather-${place.toLowerCase() || index}-${targetDate || 'now'}`,
        location: place,
        condition,
        temperature,
        // The headline sky, for the client that draws an icon for it. Older
        // clients ignore the field and keep the one weather glyph they have.
        ...(symbol ? { symbol } : {}),
        ...(currentReading ? { current: currentReading } : {}),
        ...(days.length ? { days } : {}),
        details: cardDetails,
      },
    ];
  });
}

/** Completed reminder results are concise enough to own their response surface. */
export function reminderResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  const reminders = new Map<string, ResponseCard>();
  const add = (value: RecordValue) => {
    const reminderId = string(value.reminderId);
    const title = string(value.text);
    if (!reminderId || !title) return;
    reminders.set(reminderId, {
      kind: 'reminder',
      id: `reminder-${reminderId}`,
      title,
      // A one-time reminder's `schedule` used to be the same raw ISO instant
      // as `nextFires`, which leaked transport data into the card. Cron is a
      // meaningful user-facing value only for recurring reminders.
      schedule: string(value.kind) === 'once' ? '' : string(value.schedule) || string(value.cron),
      nextFires: string(value.nextFires),
      timezone: string(value.timezone),
      enabled: value.enabled !== false,
    });
  };

  for (const state of effectiveReminders(evidence).values())
    add({ ...state.value, enabled: state.enabled });
  return [...reminders.values()];
}

/** Metadata-only inbox searches have a stable, complete structured representation. */
export function emailResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  const openedThreads = new Map<string, number>();
  evidence.forEach((row, index) => {
    if (!succeeded(row) || row.toolName !== 'gmail.read_thread') return;
    const result = record(row.result);
    if (
      !result ||
      result.complete === false ||
      !Array.isArray(result.messages) ||
      !result.messages.some((message) => string(record(message)?.text))
    )
      return;
    const threadId = string(record(row.args)?.threadId) || string(result.threadId);
    if (threadId) openedThreads.set(threadId, index);
  });
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'gmail.search') return [];
    const result = record(row.result);
    if (!result) return [];
    const args = record(row.args);
    const hits = Array.isArray(result.results)
      ? result.results.map(record).filter((message): message is RecordValue => !!message)
      : [];
    // A complete search whose every hit was subsequently opened is provenance
    // for the thread cards, rather than a second presentation of the answer.
    // Keep incomplete, unread, empty, or unlinked results visible.
    if (
      result.complete === true &&
      hits.length > 0 &&
      hits.every((message) => (openedThreads.get(string(message.threadId)) ?? -1) > index)
    )
      return [];
    const messages = Array.isArray(result.results)
      ? result.results
          .map(record)
          .filter((message): message is RecordValue => !!message)
          .map((message, messageIndex) => ({
            id:
              string(message.messageId) ||
              string(message.threadId) ||
              `email-${index}-${messageIndex}`,
            sender: string(message.from),
            recipient: string(message.to),
            subject: string(message.subject) || 'No subject',
            date: string(message.date),
            snippet: string(message.snippet),
          }))
      : [];
    return [
      {
        kind: 'email-results' as const,
        id: `email-results-${index}-${string(args?.query) || 'search'}`,
        title: 'Email results',
        query: string(args?.query),
        mailbox: string(result.mailboxSearched),
        complete: result.complete !== false,
        matchingMessagesEstimate: number(result.matchingMessagesEstimate),
        messages,
      },
    ];
  });
}

/** Filed-document search results are external content, but their provenance stays visible in the card. */
export function documentResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'documents.search') return [];
    const result = record(row.result);
    if (!result) return [];
    const args = record(row.args);
    const passages = Array.isArray(result.passages)
      ? result.passages
          .map(record)
          .filter((passage): passage is RecordValue => !!passage)
          .map((passage, passageIndex) => ({
            id: `passage-${index}-${passageIndex}`,
            document: string(passage.document) || 'Untitled document',
            source: string(passage.source),
            snippet: string(passage.snippet),
            similarity: number(passage.similarity),
          }))
      : [];
    return [
      {
        kind: 'document-results' as const,
        id: `document-results-${index}-${string(args?.query) || 'search'}`,
        title: 'Document matches',
        query: string(args?.query),
        passages,
      },
    ];
  });
}

/** Drive search cards keep a result's useful metadata and open link together. */
export function driveResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'drive.search') return [];
    const result = record(row.result);
    if (!result) return [];
    const args = record(row.args);
    const files = Array.isArray(result.files)
      ? result.files
          .map(record)
          .filter((file): file is RecordValue => !!file)
          .map((file, fileIndex) => ({
            id: string(file.fileId) || `file-${index}-${fileIndex}`,
            name: string(file.name) || 'Untitled file',
            mimeType: string(file.mimeType),
            modifiedTime: string(file.modifiedTime),
            size: string(file.size) || (number(file.size) !== undefined ? String(file.size) : ''),
            url: string(file.url),
          }))
      : [];
    if (files.length === 0) return [];
    return [
      {
        kind: 'drive-results' as const,
        id: `drive-results-${index}-${string(args?.query) || 'search'}`,
        title: 'Drive files',
        query: string(args?.query),
        files,
      },
    ];
  });
}

/** Knowledge cards are a direct projection of the active graph tool ledger. */
export function knowledgeGraphResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'memory.graph_snapshot') return [];
    const result = record(row.result);
    const args = record(row.args);
    const relationships = Array.isArray(result?.relationships)
      ? result.relationships.map(record).filter((item): item is RecordValue => !!item)
      : [];
    if (relationships.length === 0) return [];
    const nodes = new Map<string, { id: string; label: string; type: string }>();
    const edges = relationships.map((relationship, relationshipIndex) => {
      const subjectId = string(relationship.subjectId) || `subject-${relationshipIndex}`;
      const objectId = string(relationship.objectId) || `object-${relationshipIndex}`;
      nodes.set(subjectId, {
        id: subjectId,
        label: string(relationship.subjectLabel) || 'Unknown',
        type: string(relationship.subjectKind) || 'concept',
      });
      nodes.set(objectId, {
        id: objectId,
        label: string(relationship.objectLabel) || 'Unknown',
        type: string(relationship.objectKind) || 'concept',
      });
      return {
        id: string(relationship.id) || `relationship-${relationshipIndex}`,
        from: subjectId,
        to: objectId,
        label: string(relationship.predicate).replaceAll('_', ' '),
        evidenceQuote: string(relationship.evidenceQuote),
        sourceMemoryId: string(relationship.sourceMemoryId),
        sourceMemory: string(relationship.sourceMemory),
        source: string(relationship.source),
        confidence: numeric(relationship.memoryConfidence),
        ownerConfirmed: relationship.ownerConfirmed === true,
        validFrom: string(relationship.validFrom),
        validUntil: string(relationship.validUntil),
      };
    });
    return [
      {
        kind: 'knowledge-graph' as const,
        id: `knowledge-graph-${index}-${string(args?.query) || 'query'}`,
        title: 'Saved connections',
        query: string(args?.query),
        complete: result?.complete !== false,
        nodes: [...nodes.values()],
        edges,
      },
    ];
  });
}

/** Web search hits stay a flat list of tappable links with provenance visible. */
/** How often a client re-reads a live game; the provider cache holds 20s. */
const SCOREBOARD_POLL_SECONDS = 30;

/**
 * Games from `sports.scores`, as one scoreboard. Built from the tool's
 * structured rows only, like every card here, so the card can never show a
 * score the provider did not return. `live` names what a client may re-read
 * (league + event ids) through the refresh endpoint, which calls the provider
 * again without a model — the card keeps ticking while a game is on.
 */
export function scoreboardResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  const games = new Map<string, RecordValue>();
  let fetchedAt = '';
  let timeZone = '';
  let selection = '';
  let requestedDate = '';
  let partialCoverage = false;
  for (const row of evidence) {
    if (!succeeded(row) || row.toolName !== 'sports.scores') continue;
    const result = record(row.result);
    if (!result || string(result.error)) continue;
    fetchedAt = string(result.fetchedAt) || fetchedAt;
    timeZone = string(result.timeZone) || timeZone;
    selection = string(result.selection) || selection;
    if (result.explicitDate === true && /^\d{4}-\d{2}-\d{2}$/.test(string(result.requestedDate)))
      requestedDate = string(result.requestedDate);
    if (record(result.coverage)?.complete === false) partialCoverage = true;
    for (const game of Array.isArray(result.games) ? result.games : []) {
      const value = record(game);
      const id = string(value?.id);
      const league = string(value?.league);
      if (value && id && league && record(value.home) && record(value.away))
        games.set(`${league}:${id}`, value);
    }
  }
  if (!games.size) return [];
  const rows = [...games.values()];
  const leagues = [...new Set(rows.map((game) => string(game.league)))];
  const labels = [...new Set(rows.map((game) => string(game.leagueLabel)).filter(Boolean))];
  const pollable = rows.filter((game) => string(game.state) !== 'post');
  return [
    {
      kind: 'scoreboard',
      id: `scoreboard-${rows.map((game) => string(game.id)).join('-')}`,
      title: [
        selection === 'last-and-next'
          ? 'Last result and next game'
          : labels.length === 1
            ? (labels[0] as string)
            : 'Scores',
        requestedDate,
        partialCoverage ? 'Partial coverage' : '',
      ]
        .filter(Boolean)
        .join(' · '),
      fetchedAt,
      timeZone,
      // Shown under the reply, not instead of it: the one-line takeaway (and a
      // "saved to your Cards page" receipt) stays readable above the board.
      accompaniesProse: true,
      games: rows,
      ...(pollable.length
        ? {
            live: {
              provider: 'espn',
              pollSeconds: SCOREBOARD_POLL_SECONDS,
              leagues: leagues
                .map((league) => ({
                  league,
                  eventIds: pollable
                    .filter((game) => string(game.league) === league)
                    .map((game) => string(game.id)),
                }))
                .filter((entry) => entry.eventIds.length > 0),
            },
          }
        : {}),
    },
  ];
}

/**
 * A route from `maps.directions`: both ends, time, distance, the line to draw,
 * and the Apple Maps link. It sits under the reply, which carries the
 * takeaway ("leave by 2:40"); the card is the map.
 */
export function routeResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'maps.directions') return [];
    const result = record(row.result);
    if (!result || string(result.error)) return [];
    const origin = record(result.origin);
    const destination = record(result.destination);
    const durationSeconds = numeric(result.durationSeconds);
    const distanceMeters = numeric(result.distanceMeters);
    const mapsUrl = string(result.mapsUrl);
    const polyline = string(result.polyline);
    const place = (value: RecordValue | undefined) => {
      const lat = numeric(value?.lat);
      const lng = numeric(value?.lng);
      if (lat === undefined || lng === undefined || !string(value?.label)) return undefined;
      return {
        label: string(value?.label),
        lat,
        lng,
        ...(string(value?.address) ? { address: string(value?.address) } : {}),
        ...(value?.current === true ? { current: true } : {}),
      };
    };
    const from = place(origin);
    const to = place(destination);
    if (!from || !to || durationSeconds === undefined || distanceMeters === undefined) return [];
    if (!/^https:\/\/maps\.apple\.com\//.test(mapsUrl)) return [];
    const steps = Array.isArray(result.steps)
      ? result.steps
          .map(record)
          .filter((step): step is RecordValue => !!step && !!string(step.instruction))
          .map((step) => ({
            instruction: string(step.instruction),
            distanceMeters: numeric(step.distanceMeters) ?? 0,
          }))
      : [];
    return [
      {
        kind: 'route' as const,
        id: `route-${index}-${to.lat.toFixed(4)},${to.lng.toFixed(4)}`,
        mode: string(result.mode) || 'driving',
        origin: from,
        destination: to,
        durationSeconds,
        distanceMeters,
        departAt: string(result.departAt),
        arriveAt: string(result.arriveAt),
        ...(string(result.routeName) ? { routeName: string(result.routeName) } : {}),
        ...(typeof result.hasTolls === 'boolean' ? { hasTolls: result.hasTolls } : {}),
        ...(/^[\x3f-\x7e]{2,4000}$/.test(polyline) ? { polyline } : {}),
        steps,
        mapsUrl,
        accompaniesProse: true,
      },
    ];
  });
}

export function searchResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'web.search') return [];
    const result = record(row.result);
    if (!result) return [];
    const args = record(row.args);
    const results = Array.isArray(result.results)
      ? result.results
          .map(record)
          .filter((item): item is RecordValue => !!item)
          .map((item, resultIndex) => ({
            id: string(item.url) || `result-${index}-${resultIndex}`,
            title: string(item.title) || string(item.url),
            url: string(item.url),
            snippet: string(item.snippet),
          }))
          .filter((item) => item.url.length > 0)
      : [];
    return [
      {
        kind: 'web-search-results' as const,
        id: `web-search-${index}-${string(result.query) || string(args?.query) || 'search'}`,
        title: 'Web results',
        query: string(result.query) || string(args?.query),
        results,
      },
    ];
  });
}

/** Free/busy answers render the raw busy blocks; the owner reads the gaps. */
export function availabilityResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'calendar.availability') return [];
    const result = record(row.result);
    if (!result) return [];
    const args = record(row.args);
    const busy = Array.isArray(result.busy)
      ? result.busy
          .map(record)
          .filter((slot): slot is RecordValue => !!slot)
          .map((slot) => ({
            start: string(slot.start),
            end: string(slot.end),
            calendar: string(slot.calendar),
          }))
          .filter((slot) => slot.start.length > 0 && slot.end.length > 0)
      : [];
    const note = string(result.note);
    return [
      {
        kind: 'availability' as const,
        id: `availability-${index}-${string(args?.timeMin)}`,
        timeMin: string(args?.timeMin),
        timeMax: string(args?.timeMax),
        busy,
        calendarsChecked: strings(result.calendarsChecked),
        complete: result.complete !== false,
        ...(note ? { note } : {}),
      },
    ];
  });
}

const THREAD_MESSAGE_LIMIT = 8;
const THREAD_EXCERPT_LIMIT = 280;

/** A fetched thread becomes a compact transcript; excerpts stay short so the card never owns the whole message body. */
export function threadResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'gmail.read_thread') return [];
    const result = record(row.result);
    if (!result) return [];
    const messages = Array.isArray(result.messages)
      ? result.messages.map(record).filter((message): message is RecordValue => !!message)
      : [];
    return [
      {
        kind: 'email-thread' as const,
        id: `email-thread-${string(result.threadId) || index}`,
        subject: string(messages[0]?.subject) || 'Email thread',
        messageCount: messages.length,
        messages: messages.slice(0, THREAD_MESSAGE_LIMIT).map((message, messageIndex) => ({
          id: string(message.messageId) || `message-${index}-${messageIndex}`,
          sender: string(message.from),
          date: string(message.date),
          excerpt: string(message.text).replace(/\s+/g, ' ').trim().slice(0, THREAD_EXCERPT_LIMIT),
        })),
      },
    ];
  });
}

const SHEET_PREVIEW_ROWS = 9;
const SHEET_PREVIEW_COLUMNS = 6;
const SHEET_CELL_LIMIT = 60;

function sheetCell(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, SHEET_CELL_LIMIT);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Sheet reads render as a small preview table; the full row count and the open link carry the rest. */
export function sheetRowsResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'sheets.get_rows') return [];
    const result = record(row.result);
    if (!result) return [];
    const allRows = Array.isArray(result.rows) ? result.rows : [];
    const rows = allRows
      .slice(0, SHEET_PREVIEW_ROWS)
      .map((entry) =>
        Array.isArray(entry) ? entry.slice(0, SHEET_PREVIEW_COLUMNS).map(sheetCell) : [],
      );
    const url = string(result.url);
    return [
      {
        kind: 'sheet-rows' as const,
        id: `sheet-rows-${string(result.spreadsheetId) || index}-${string(result.sheetName)}`,
        sheetName: string(result.sheetName) || 'Sheet',
        totalRows: allRows.length,
        rows,
        ...(url ? { link: { label: 'Open spreadsheet', url } } : {}),
      },
    ];
  });
}

/** Private artifacts deserve a direct, tappable result rather than a prose-only confirmation. */
export function resourceResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row)) return [];
    const result = record(row.result);
    const args = record(row.args);
    if (!result) return [];
    if (row.toolName === 'docs.create') {
      const title = string(result.title) || string(args?.title);
      if (!title) return [];
      return [
        {
          kind: 'resource' as const,
          id: `document-${string(result.documentId) || index}`,
          resourceType: 'document',
          title,
          subtitle: 'Google Doc created',
          details: details([['Shared with', string(result.sharedWith)]]),
          link: { label: 'Open document', url: string(result.url) },
        },
      ];
    }
    if (row.toolName === 'sheets.create') {
      const title = string(result.title) || string(args?.title);
      if (!title) return [];
      return [
        {
          kind: 'resource' as const,
          id: `spreadsheet-${string(result.spreadsheetId) || index}`,
          resourceType: 'spreadsheet',
          title,
          subtitle: 'Google Sheet created',
          details: details([['Shared with', string(result.sharedWith)]]),
          link: { label: 'Open spreadsheet', url: string(result.url) },
        },
      ];
    }
    return [];
  });
}

/** Writes that have no browseable artifact still receive a factual completion card. */
export function statusResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row)) return [];
    const result = record(row.result);
    const args = record(row.args);
    if (!result) return [];
    if (row.toolName === 'reminder.cancel' && result.cancelled === true) {
      return [
        {
          kind: 'status' as const,
          id: `reminder-cancelled-${string(result.reminderId) || index}`,
          title: 'Reminder cancelled',
          detail: 'This reminder will no longer run.',
          symbol: 'bell.slash.fill',
        },
      ];
    }
    if (row.toolName === 'gmail.create_draft') {
      return [
        {
          kind: 'status' as const,
          id: `email-draft-${string(result.draftId) || index}`,
          title: 'Email draft ready',
          detail: string(result.subject) || string(args?.subject),
          symbol: 'envelope.badge.fill',
          details: details([['To', strings(result.to).join(', ') || strings(args?.to).join(', ')]]),
        },
      ];
    }
    if (row.toolName === 'gmail.send') {
      return [
        {
          kind: 'status' as const,
          id: `email-sent-${string(result.messageId) || index}`,
          title: 'Email sent',
          detail: string(args?.subject),
          symbol: 'paperplane.fill',
          details: details([['To', strings(result.to).join(', ') || strings(args?.to).join(', ')]]),
        },
      ];
    }
    if (row.toolName === 'calendar.update_event' && result.updated === true) {
      return [
        {
          kind: 'status' as const,
          id: `calendar-updated-${string(result.eventId) || index}`,
          title: 'Calendar event updated',
          detail: string(result.summary) || 'The event details were updated.',
          symbol: 'calendar.badge.checkmark',
          details: details([
            ['Time', string(result.start)],
            ['Location', string(args?.location)],
            ['Invited', strings(args?.addAttendees).join(', ')],
          ]),
        },
      ];
    }
    if (row.toolName === 'calendar.cancel_event' && string(result.cancelled)) {
      return [
        {
          kind: 'status' as const,
          id: `calendar-cancelled-${string(result.cancelled)}`,
          title: 'Calendar event cancelled',
          detail: 'The event was removed from the calendar.',
          symbol: 'calendar.badge.minus',
        },
      ];
    }
    if (row.toolName === 'gmail.modify' && string(result.id)) {
      const changes = [
        args?.archive === true ? 'Archived' : '',
        args?.markRead === true ? 'Marked read' : '',
        args?.markRead === false ? 'Marked unread' : '',
        strings(args?.addLabels).length ? `Labeled ${strings(args?.addLabels).join(', ')}` : '',
        strings(args?.removeLabels).length
          ? `Removed ${strings(args?.removeLabels).join(', ')}`
          : '',
      ].filter(Boolean);
      return [
        {
          kind: 'status' as const,
          id: `email-modified-${string(result.id)}`,
          title: 'Inbox updated',
          detail: changes.join(' · ') || 'Message updated.',
          symbol: 'tray.full.fill',
        },
      ];
    }
    if (row.toolName === 'docs.append' && result.appended === true) {
      return [
        {
          kind: 'status' as const,
          id: `document-appended-${string(result.documentId) || index}`,
          title: 'Document updated',
          detail: 'Content added to the end of the document.',
          symbol: 'doc.badge.plus',
          link: string(result.url)
            ? { label: 'Open document', url: string(result.url) }
            : undefined,
        },
      ];
    }
    if (row.toolName === 'docs.replace_text' && result.updated === true) {
      const count = Array.isArray(result.replacements) ? result.replacements.length : 0;
      return [
        {
          kind: 'status' as const,
          id: `document-replaced-${string(result.documentId) || index}`,
          title: 'Document updated',
          detail:
            count > 0
              ? `${count} text ${count === 1 ? 'replacement' : 'replacements'} applied.`
              : 'Text updated.',
          symbol: 'doc.text.fill',
          link: string(result.url)
            ? { label: 'Open document', url: string(result.url) }
            : undefined,
        },
      ];
    }
    if (row.toolName === 'docs.share' && string(result.sharedWith)) {
      return [
        {
          kind: 'status' as const,
          id: `document-shared-${string(result.documentId) || index}-${string(result.sharedWith)}`,
          title: 'Document shared',
          detail: string(result.sharedWith),
          symbol: 'person.crop.circle.badge.checkmark',
          details: details([['Role', string(args?.role)]]),
          link: string(result.url)
            ? { label: 'Open document', url: string(result.url) }
            : undefined,
        },
      ];
    }
    if (row.toolName === 'sheets.append_rows' && number(result.appendedRows) !== undefined) {
      const count = number(result.appendedRows) ?? 0;
      return [
        {
          kind: 'status' as const,
          id: `sheet-appended-${string(result.spreadsheetId) || index}`,
          title: 'Sheet updated',
          detail: `${count} ${count === 1 ? 'row' : 'rows'} added to ${string(result.sheetName) || 'the sheet'}.`,
          symbol: 'tablecells.fill',
          link: string(result.url)
            ? { label: 'Open spreadsheet', url: string(result.url) }
            : undefined,
        },
      ];
    }
    if (row.toolName === 'sheets.write_rows' && number(result.writtenRows) !== undefined) {
      const count = number(result.writtenRows) ?? 0;
      return [
        {
          kind: 'status' as const,
          id: `sheet-written-${string(result.spreadsheetId) || index}-${string(result.startCell)}`,
          title: 'Sheet updated',
          detail: `${count} ${count === 1 ? 'row' : 'rows'} written to ${string(result.sheetName) || 'the sheet'}.`,
          symbol: 'tablecells.fill',
          link: string(result.url)
            ? { label: 'Open spreadsheet', url: string(result.url) }
            : undefined,
        },
      ];
    }
    return [];
  });
}

/** Event creation returns an id and link while its executed inputs contain the complete event. */
export function calendarWriteResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'calendar.create_event') return [];
    const result = record(row.result);
    const args = record(row.args);
    const title = string(args?.summary);
    const start = string(args?.start);
    if (!result || !title || !start) return [];
    const end = string(args?.end);
    return [
      {
        kind: 'calendar-event' as const,
        id: `calendar-${string(result.eventId) || index}`,
        title,
        start,
        end,
        time: [formatTime(start), end ? formatTime(end) : ''].filter(Boolean).join('–'),
        location: string(args?.location),
        attendees: strings(result.invited).length
          ? strings(result.invited)
          : strings(args?.attendees),
        calendars: [],
        calendarLink: isSpecificCalendarLink({ url: string(result.link) })
          ? { label: 'Open event', url: string(result.link) }
          : undefined,
        link: isSpecificCalendarLink({ url: string(result.link) })
          ? { label: 'Open event', url: string(result.link) }
          : undefined,
      },
    ];
  });
}

/**
 * The ambient card only describes right now at the owner's current location,
 * so it may attach solely when that is exactly the question. A request about
 * another place ("weather in Palo Alto") or later days ("this weekend",
 * "tomorrow", "on Saturday") is answered from other context, and a
 * today-here card would contradict it.
 */
function isCurrentLocalWeatherRequest(requestText: string): boolean {
  if (!/\b(?:weather|forecast|temperature|rain)\b/i.test(requestText)) return false;
  if (
    /\b(?:tomorrow|tonight|weekend|this\s+week|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i.test(
      requestText,
    )
  ) {
    return false;
  }
  // An explicit place ("in Palo Alto", "for Tokyo") is never the ambient
  // block's location, which is wherever the owner happens to be.
  if (/\b(?:in|at|for)\s+(?:the\s+)?[A-Z][A-Za-z]/.test(requestText)) return false;
  return true;
}

/** The live-lookup kind each lookup-backed card answers. */
const LOOKUP_KIND_OF_CARD: Partial<Record<ResponseCard['kind'], LiveLookup['kind']>> = {
  weather: 'weather',
  scoreboard: 'sports',
  route: 'directions',
  'web-search-results': 'web',
};

/**
 * Cards for a request with several live lookups: in the order the owner asked,
 * each sitting under the reply rather than standing in for it. A weather card
 * alone replaces its prose; beside a scoreboard, that would delete the only
 * words answering the other half of the question.
 */
function orderForLookups(
  cards: ResponseCard[],
  lookupOrder: ReadonlyArray<LiveLookup['kind']>,
): ResponseCard[] {
  if (lookupOrder.length < 2) return cards;
  const rank = (card: ResponseCard) => {
    const kind = LOOKUP_KIND_OF_CARD[card.kind];
    return kind ? lookupOrder.indexOf(kind) : -1;
  };
  return cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => rank(a.card) - rank(b.card) || a.index - b.index)
    .map(({ card }) => ({ ...card, accompaniesProse: true }));
}

export function responseCardsForFinal(input: {
  evidence: ActionEvidence[];
  readRequest?: PersonalReadRequest | null;
  ambient?: string;
  requestText?: string;
  /** The live lookups the request asked for, in the order it asked them. */
  lookupOrder?: ReadonlyArray<LiveLookup['kind']>;
}): ResponseCard[] {
  const cards = orderForLookups(
    [
      ...resourceResponseCards(input.evidence),
      ...statusResponseCards(input.evidence),
      ...calendarWriteResponseCards(input.evidence),
      ...reminderResponseCards(input.evidence),
      ...calendarResponseCards(input.evidence, input.readRequest),
      ...availabilityResponseCards(input.evidence),
      ...emailResponseCards(input.evidence),
      ...threadResponseCards(input.evidence),
      ...documentResponseCards(input.evidence),
      ...knowledgeGraphResponseCards(input.evidence),
      ...driveResponseCards(input.evidence),
      ...sheetRowsResponseCards(input.evidence),
      ...weatherLookupResponseCards(input.evidence),
      ...scoreboardResponseCards(input.evidence),
      ...routeResponseCards(input.evidence),
      ...searchResponseCards(input.evidence),
    ],
    input.lookupOrder ?? [],
  );
  if (cards.length > 0) return cards;
  // Ambient weather is useful for a conversational/weather answer, but must
  // never appear as an unrelated result below a tool-backed response — nor
  // contradict an answer about another place or later days, which the
  // location-and-today ambient block cannot describe. Those questions route to
  // `weather.lookup` and get their card from its ledger row above, so the
  // narrow gate here costs them nothing.
  return input.readRequest || !isCurrentLocalWeatherRequest(input.requestText ?? '')
    ? []
    : weatherResponseCards(input.ambient);
}
