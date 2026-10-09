import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import type { AssistantTool, ToolFlags } from '../types.js';
import type { GoogleClient } from './client.js';

const CAL = 'https://www.googleapis.com/calendar/v3';

/**
 * How many calendars a single read will fan out across. A Google account
 * typically carries a handful, but subscribed holiday/birthday calendars can
 * push the list up, and every extra calendar is another HTTP round trip.
 */
const MAX_CALENDAR_FANOUT = 50;
const MAX_CALENDAR_ROSTER_PAGES = 10;
const MAX_CALENDAR_CURSOR_BYTES = 2_000_000;
const MAX_EVENT_PAGES_PER_CALENDAR_PER_CALL = 20;

async function assertBookingCurrent(ctx: Parameters<AssistantTool['execute']>[1]): Promise<void> {
  if (!ctx.bookingOccurrence) return;
  if (!ctx.assertBookingOccurrenceCurrent || !(await ctx.assertBookingOccurrenceCurrent())) {
    throw new Error(
      'This booking changed after the suggestion was accepted. Review the latest email before changing the calendar.',
    );
  }
}

async function cancelBoundBooking(
  deps: CalendarToolDeps,
  args: { eventId: string; ownerOnly?: boolean },
  ctx: Parameters<AssistantTool['execute']>[1],
): Promise<{ cancelled: string }> {
  const booking = ctx.bookingOccurrence;
  if (
    booking?.operation !== 'cancel_existing' ||
    !booking.calendarEventId ||
    !booking.bookingIdentity ||
    args.eventId !== booking.calendarEventId
  )
    throw new Error('This cancellation is not bound to the exact approved booking event.');
  await assertBookingCurrent(ctx);
  const event = await deps.client.api<CalendarEventSnapshot>(
    `${CAL}/calendars/primary/events/${encodeURIComponent(booking.calendarEventId)}?fields=id,etag,status,summary,description,attendees`,
  );
  if (
    event.id !== booking.calendarEventId ||
    event.status === 'cancelled' ||
    !hasExactBookingMarker(
      `${event.summary ?? ''}\n${event.description ?? ''}`,
      booking.bookingIdentity,
    )
  )
    throw new Error(
      'The calendar event no longer matches this cancelled booking. Review it before making a change.',
    );
  const attendees = event.attendees ?? [];
  if (args.ownerOnly && attendees.length > 0) {
    throw new Error(
      `Cannot cancel event ${args.eventId} as owner-only: it has ${attendees.length} attendee(s) who would be notified. Retry without ownerOnly so the owner can approve it.`,
    );
  }
  const etag = requireEventEtag(event, args.eventId);
  // Recheck after the provider read so reinstatement during that read cannot
  // authorize deletion of a now-current booking.
  await assertBookingCurrent(ctx);
  await deps.client.api(
    `${CAL}/calendars/primary/events/${encodeURIComponent(args.eventId)}?sendUpdates=${args.ownerOnly ? 'none' : 'all'}`,
    { method: 'DELETE', headers: { 'If-Match': etag } },
  );
  return { cancelled: args.eventId };
}

/** freeBusy accepts at most 50 items per request. */
const MAX_FREEBUSY_ITEMS = 50;

export interface CalendarToolDeps {
  client: GoogleClient;
  botEmail: string;
  ownerEmail: string;
}

interface CalendarEntry {
  id: string;
  name: string;
  primary: boolean;
  accessRole: string;
}

interface RawEvent {
  id: string;
  iCalUID?: string;
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string };
  /** 'confirmed' | 'tentative' | 'cancelled'. Not every provider populates it. */
  status?: string;
  transparency?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  organizer?: { email?: string; displayName?: string };
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }>;
  };
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email: string; responseStatus?: string; self?: boolean }>;
}

function urlsIn(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>'"`]+/gi) ?? []).map((url) =>
    url.replace(/[.,;:!?)\]]+$/, ''),
  );
}

function isVideoConferenceURL(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ['zoom.us', 'meet.google.com', 'teams.microsoft.com', 'webex.com'].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

/** Only expose provider links that identify the selected event. */
function isSpecificCalendarURL(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    const path = parsed.pathname.toLowerCase();
    const query = parsed.search.toLowerCase();
    return path.includes('/event') || query.includes('eid=') || query.includes('eventid=');
  } catch {
    return false;
  }
}

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

/**
 * Every calendar this account can read — its own plus any the owner (or anyone
 * else) has shared with it. `calendar.readonly` already covers shared
 * calendars; before this the tools only ever addressed `calendars/primary`, so
 * a calendar shared with the bot was invisible no matter how it was shared.
 */
interface CalendarRoster {
  calendars: CalendarEntry[];
  /** Provider page left unread when the bounded roster walk reaches its limit. */
  nextPageToken?: string;
}

async function fetchCalendarPage(
  client: GoogleClient,
  pageToken?: string,
): Promise<CalendarRoster> {
  const params = new URLSearchParams({
    minAccessRole: 'reader',
    maxResults: '250',
    showDeleted: 'false',
  });
  if (pageToken) params.set('pageToken', pageToken);
  const res = await client.api<{
    items?: Array<{
      id?: string;
      summary?: string;
      summaryOverride?: string;
      primary?: boolean;
      accessRole?: string;
      deleted?: boolean;
    }>;
    nextPageToken?: string;
  }>(`${CAL}/users/me/calendarList?${params.toString()}`);
  return {
    calendars: (res.items ?? [])
      .filter((c): c is typeof c & { id: string } => Boolean(c.id) && c.deleted !== true)
      .map((c) => ({
        id: c.id,
        name: c.summaryOverride || c.summary || c.id,
        primary: c.primary === true,
        accessRole: c.accessRole ?? 'reader',
      })),
    ...(res.nextPageToken ? { nextPageToken: res.nextPageToken } : {}),
  };
}

async function fetchCalendars(client: GoogleClient): Promise<CalendarRoster> {
  const calendars: CalendarEntry[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  while (pages < MAX_CALENDAR_ROSTER_PAGES) {
    const res = await fetchCalendarPage(client, pageToken);
    calendars.push(...res.calendars);
    pages += 1;
    pageToken = res.nextPageToken;
    if (!pageToken) break;
  }
  return { calendars, ...(pageToken ? { nextPageToken: pageToken } : {}) };
}

function startedAt(event: { start: string }): number {
  const ms = Date.parse(event.start);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

function normalizeEvent(raw: RawEvent, calendar: CalendarEntry) {
  const links: Array<{ type: string; label: string; url: string }> = [];
  const addLink = (type: string, label: string, url?: string) => {
    if (!url || !/^https?:\/\//i.test(url) || links.some((link) => link.url === url)) return;
    links.push({ type, label, url });
  };
  if (raw.htmlLink && isSpecificCalendarURL(raw.htmlLink)) {
    addLink('calendar', 'Open in Google Calendar', raw.htmlLink);
  }
  addLink('video', 'Video meeting', raw.hangoutLink);
  for (const entry of raw.conferenceData?.entryPoints ?? []) {
    addLink(entry.entryPointType ?? 'conference', entry.label ?? 'Conference link', entry.uri);
  }
  for (const url of urlsIn(raw.location ?? '')) {
    addLink(
      isVideoConferenceURL(url) ? 'video' : 'location',
      isVideoConferenceURL(url) ? 'Video meeting' : 'Location link',
      url,
    );
  }
  for (const url of urlsIn(raw.description ?? '')) addLink('description', 'Event link', url);

  return {
    eventId: raw.id,
    iCalUID: raw.iCalUID,
    recurringEventId: raw.recurringEventId,
    originalStartTime: raw.originalStartTime?.dateTime ?? raw.originalStartTime?.date,
    // Carried through verbatim so a caller can tell a merely-tentative hold
    // from a firm booking, and — the reason this was added — so a change-diff
    // downstream can recognize an explicit cancellation when the provider
    // sends one, rather than inferring it purely from the event's absence.
    status: raw.status,
    blocksTime: raw.transparency !== 'transparent',
    ownerResponse: raw.attendees?.find((attendee) => attendee.self === true)?.responseStatus,
    // Which calendar this came from — without it a merged list can't say
    // whether something is on the work calendar or the family one.
    calendar: calendar.name,
    calendarId: calendar.id,
    summary: raw.summary ?? '',
    location: raw.location ?? '',
    description: (raw.description ?? '').slice(0, 4000),
    start: raw.start?.dateTime ?? raw.start?.date ?? '',
    end: raw.end?.dateTime ?? raw.end?.date ?? '',
    organizer: raw.organizer?.email
      ? raw.organizer.displayName
        ? `${raw.organizer.displayName} <${raw.organizer.email}>`
        : raw.organizer.email
      : '',
    allDay: Boolean(raw.start?.date && !raw.start.dateTime),
    attendees: (raw.attendees ?? []).map((a) => `${a.email} (${a.responseStatus ?? '?'})`),
    links,
  };
}

/**
 * Read across several calendars at once and merge the results into one
 * chronological list.
 *
 * A single calendar failing (revoked share, transient 5xx) must not blank the
 * whole answer, so failures are collected per calendar and returned alongside
 * the events rather than thrown — the caller can then say what it did and
 * didn't see instead of silently under-reporting.
 */
async function collectEvents(
  deps: CalendarToolDeps,
  opts: {
    calendarIds?: string[];
    maxResults: number;
    pageToken?: string;
    queryKey: string;
    query: (calendarId: string, maxResults: number, pageToken?: string) => string;
  },
) {
  const roster = await fetchCalendars(deps.client);
  const available = roster.calendars;
  const explicit = Boolean(opts.calendarIds?.length);
  const requestedNames = opts.calendarIds ?? [];
  const resolved: CalendarEntry[] = [];
  const unresolved: Array<{ requested: string; reason: string; candidates?: string[] }> = [];
  if (explicit) {
    for (const requested of requestedNames) {
      const byId = available.filter((calendar) => calendar.id === requested);
      const matches =
        byId.length > 0 ? byId : available.filter((calendar) => calendar.name === requested);
      if (matches.length === 1) {
        const match = matches[0];
        if (match && !resolved.some((calendar) => calendar.id === match.id)) resolved.push(match);
      } else if (matches.length > 1) {
        unresolved.push({
          requested,
          reason: 'calendar name is ambiguous; select by calendar ID',
          candidates: matches.map((calendar) => calendar.id),
        });
      } else {
        unresolved.push({
          requested,
          reason: roster.nextPageToken
            ? 'calendar was not found in the readable roster pages inspected'
            : 'calendar was not found in the readable roster',
        });
      }
    }
  } else {
    resolved.push(...available);
  }
  const targets = resolved.slice(0, MAX_CALENDAR_FANOUT);
  if (targets.length === 0 && !explicit)
    throw new Error('the assistant account returned no readable calendars');

  const queryKey = createHash('sha256')
    .update(
      JSON.stringify({
        query: opts.queryKey,
        requested: requestedNames,
        calendars: targets.map((calendar) => calendar.id),
        maxResults: opts.maxResults,
      }),
    )
    .digest('hex');
  const cursorSchema = z
    .object({
      version: z.literal(1),
      queryKey: z.string().regex(/^[a-f0-9]{64}$/),
      calendars: z.array(
        z
          .object({
            id: z.string().min(1).max(512),
            token: z.string().max(4096).nullable(),
            buffered: z.array(z.record(z.string(), z.unknown())).max(50),
          })
          .strict(),
      ),
    })
    .strict();
  type Event = ReturnType<typeof normalizeEvent>;
  type PageCursor = { id: string; token: string | null; buffered: Event[] };
  let priorCursors: PageCursor[] | undefined;
  if (opts.pageToken) {
    if (opts.pageToken.length > MAX_CALENDAR_CURSOR_BYTES)
      throw new Error('Calendar page token is too large');
    let decoded: unknown;
    try {
      const verified = deps.client.verifyOpaqueToken(opts.pageToken);
      if (!verified) throw new Error('signature mismatch');
      decoded = JSON.parse(verified);
    } catch {
      throw new Error('Invalid calendar page token');
    }
    const parsed = cursorSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.queryKey !== queryKey)
      throw new Error('Calendar page token does not match this request');
    const currentIds = targets.map((calendar) => calendar.id).sort();
    const cursorIds = parsed.data.calendars.map((calendar) => calendar.id).sort();
    if (
      currentIds.length !== cursorIds.length ||
      currentIds.some((id, index) => id !== cursorIds[index])
    )
      throw new Error('Calendar roster changed; restart the calendar search');
    priorCursors = parsed.data.calendars.map((cursor) => ({
      id: cursor.id,
      token: cursor.token,
      buffered: cursor.buffered as Event[],
    }));
  }

  const cursorById = new Map(priorCursors?.map((cursor) => [cursor.id, cursor]));
  const queryIndexes = targets
    .map((calendar, index) => ({ calendar, index, prior: cursorById.get(calendar.id) }))
    .filter(
      ({ prior }) => !prior || (prior.token !== null && prior.buffered.length < opts.maxResults),
    )
    .map(({ index }) => index);

  const settled = await Promise.allSettled(
    queryIndexes.map(async (index) => {
      const calendar = targets[index];
      if (!calendar) throw new Error('Calendar page target was lost');
      const prior = cursorById.get(calendar.id);
      let token: string | null = prior?.token ?? '';
      const buffered = [...(prior?.buffered ?? [])];
      let pages = 0;
      while (
        buffered.length < opts.maxResults &&
        token !== null &&
        pages < MAX_EVENT_PAGES_PER_CALENDAR_PER_CALL
      ) {
        const pageSize = opts.maxResults - buffered.length;
        const page: { items?: RawEvent[]; nextPageToken?: string } = await deps.client.api(
          opts.query(calendar.id, pageSize, token || undefined),
        );
        buffered.push(...(page.items ?? []).map((raw: RawEvent) => normalizeEvent(raw, calendar)));
        token = page.nextPageToken ?? null;
        pages += 1;
      }
      return { id: calendar.id, token, buffered };
    }),
  );

  const unavailable: Array<{ calendar: string; reason: string; candidates?: string[] }> = [];
  const nextCursorById = new Map<string, PageCursor>();
  for (const calendar of targets)
    nextCursorById.set(
      calendar.id,
      cursorById.get(calendar.id) ?? { id: calendar.id, token: '', buffered: [] },
    );
  settled.forEach((result, index) => {
    const targetIndex = queryIndexes[index];
    const calendar = targetIndex === undefined ? undefined : targets[targetIndex];
    if (!calendar) return;
    if (result.status === 'fulfilled') nextCursorById.set(calendar.id, result.value);
    else
      unavailable.push({
        calendar: calendar.name,
        reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
  });

  const candidates = [...nextCursorById.values()].flatMap((cursor) => cursor.buffered);
  candidates.sort((a, b) => startedAt(a) - startedAt(b));
  const events = candidates.slice(0, opts.maxResults);
  const selected = new Set(
    events.map((event) => `${event.calendarId}\0${event.eventId}\0${event.start}`),
  );
  for (const [calendarId, cursor] of nextCursorById) {
    nextCursorById.set(calendarId, {
      ...cursor,
      buffered: cursor.buffered.filter(
        (event) => !selected.has(`${event.calendarId}\0${event.eventId}\0${event.start}`),
      ),
    });
  }

  unavailable.push(
    ...unresolved.map(({ requested, reason, candidates }) => ({
      calendar: requested,
      reason,
      ...(candidates ? { candidates } : {}),
    })),
  );
  const searchedIds = new Set([
    ...(priorCursors ?? []).map((cursor) => cursor.id),
    ...queryIndexes.map((index) => targets[index]?.id).filter(Boolean),
  ]);
  const calendarsSearched = targets
    .filter((calendar) => searchedIds.has(calendar.id))
    .map((calendar) => calendar.name);
  const fanoutTruncated = resolved.length > targets.length;
  const rosterTruncated = Boolean(roster.nextPageToken);
  const remainingCursors = [...nextCursorById.values()];
  const moreEvents = remainingCursors.some(
    (cursor) => cursor.token !== null || cursor.buffered.length > 0,
  );
  const signedToken = moreEvents
    ? deps.client.signOpaqueToken(
        JSON.stringify({ version: 1, queryKey, calendars: remainingCursors }),
      )
    : undefined;
  const paginationUnavailable = Boolean(
    signedToken && signedToken.length > MAX_CALENDAR_CURSOR_BYTES,
  );
  const nextPageToken = signedToken && !paginationUnavailable ? signedToken : undefined;
  const truncatedCalendars = remainingCursors
    .filter((cursor) => cursor.token !== null || cursor.buffered.length > 0)
    .map((cursor) => targets.find((calendar) => calendar.id === cursor.id)?.name)
    .filter((name): name is string => Boolean(name));
  const notes: string[] = [];
  if (truncatedCalendars.length > 0) {
    notes.push(
      `Additional matching events remain on: ${[...new Set(truncatedCalendars)].join(', ')}.`,
    );
  }
  if (unresolved.length > 0) {
    notes.push('Some requested calendars could not be resolved; their results are not covered.');
  }
  if (fanoutTruncated) {
    notes.push(`Searched the first ${targets.length} of ${resolved.length} resolved calendars.`);
  }
  if (paginationUnavailable)
    notes.push(
      'The remaining event cursor exceeds the response size limit; narrow the date range.',
    );
  if (rosterTruncated) {
    notes.push(
      'The readable calendar roster is truncated; use calendar.list_calendars to continue.',
    );
  }

  return {
    events,
    calendarsRequested: requestedNames,
    calendarsResolved: resolved.map(({ id, name }) => ({ id, name })),
    calendarsSearched,
    unavailable,
    calendarRosterComplete: !rosterTruncated,
    ...(roster.nextPageToken ? { calendarRosterNextPageToken: roster.nextPageToken } : {}),
    ...(nextPageToken ? { nextPageToken } : {}),
    ...(paginationUnavailable ? { paginationUnavailable: true } : {}),
    complete:
      unresolved.length === 0 &&
      unavailable.length === 0 &&
      !fanoutTruncated &&
      !rosterTruncated &&
      truncatedCalendars.length === 0 &&
      !nextPageToken &&
      !paginationUnavailable,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

/**
 * The calendar read for NON-tool callers — the daily briefing's code job
 * composes from structured inputs and holds no tools, so it reaches the same
 * fan-out and merge through here. Only the client is used, hence the bare
 * deps. The result carries event content verbatim from Google; callers treat
 * it as data, never instructions.
 */
/**
 * Refuse an "owner only" write whose event turns out to have attendees.
 *
 * This is the enforcement half of the `ownerOnly` argument: the declared flag
 * buys the autonomous tier, and this fetch is what makes the claim true. It
 * throws rather than silently downgrading to an approval, because by the time
 * execute runs the risk decision is already made — failing loudly is the only
 * honest outcome, and it tells the model exactly how to retry.
 */
const respondSchema = z.object({
  eventId: z.string().min(1).max(1024),
  response: z.enum(['accepted', 'declined', 'tentative']),
  /**
   * The calendar the event was found on. Reads fan out across every calendar
   * the assistant can see, so an invitation frequently lives on a shared one
   * and `primary` would 404 — `list_events` and `search_events` both return
   * the calendar identity for this reason.
   */
  calendarId: z.string().min(1).max(512).default('primary'),
  comment: z.string().max(500).default(''),
});

/**
 * Identify the configured actor whose attendee row is authorized to respond.
 * Google defines `self` relative to the event's calendar copy, so a self flag
 * on an arbitrary shared calendar cannot prove that the bot or owner is the
 * responding attendee. Prefer explicit configured email identity, using the
 * selected calendar only to disambiguate when both are guests.
 *
 * Returns -1 when no row is ours, which the caller reports rather than
 * papering over: replying to an invitation and adding yourself to someone
 * else's guest list are different acts.
 */
function selfAttendeeIndex(
  attendees: ReadonlyArray<Record<string, unknown>>,
  identity: { botEmail: string; ownerEmail: string },
  calendarId: string,
): number {
  const normalize = (email: string) => email.trim().toLowerCase();
  const bot = identity.botEmail.trim() ? normalize(identity.botEmail) : '';
  const owner = identity.ownerEmail.trim() ? normalize(identity.ownerEmail) : '';
  const configured = [...new Set([bot, owner].filter(Boolean))];
  if (configured.length === 0) return -1;
  const calendar = normalize(calendarId);
  const calendarActor =
    calendar === 'primary' || (bot && calendar === bot)
      ? bot
      : owner && calendar === owner
        ? owner
        : '';
  const matchingIndexes = attendees.flatMap((attendee, index) =>
    typeof attendee.email === 'string' && configured.includes(normalize(attendee.email))
      ? [index]
      : [],
  );
  if (calendarActor) {
    const actorMatches = matchingIndexes.filter(
      (index) => normalize(String(attendees[index]?.email ?? '')) === calendarActor,
    );
    return actorMatches.length === 1 ? (actorMatches[0] ?? -1) : -1;
  }
  // A self flag is relative to the calendar copy. It cannot establish that
  // the configured owner or bot is the responding attendee on a shared one.
  return matchingIndexes.length === 1 ? (matchingIndexes[0] ?? -1) : -1;
}

interface CalendarEventSnapshot {
  id?: string;
  etag?: string;
  attendees?: Array<Record<string, unknown>>;
  summary?: string;
  description?: string;
  status?: string;
  htmlLink?: string;
  organizer?: { email?: string };
}

function hasExactBookingMarker(sourceText: string, identity: string): boolean {
  const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(
    sourceText.normalize('NFKC'),
  );
}

function requireEventEtag(event: CalendarEventSnapshot, eventId: string): string {
  if (typeof event.etag !== 'string' || !event.etag.trim())
    throw new Error(`Google did not return an ETag for event ${eventId}; refusing an unsafe write`);
  return event.etag;
}

function mergeAttendeeRows(
  existing: ReadonlyArray<Record<string, unknown>>,
  additions: readonly string[],
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const merged: Array<Record<string, unknown>> = [];
  for (const attendee of existing) {
    const key = typeof attendee.email === 'string' ? attendee.email.trim().toLowerCase() : '';
    if (key) seen.add(key);
    merged.push({ ...attendee });
  }
  for (const address of additions) {
    const normalized = address.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push({ email: normalized });
  }
  return merged;
}

async function assertNoAttendees(
  deps: CalendarToolDeps,
  eventId: string,
  action: 'update' | 'cancel',
  requireEmpty = true,
): Promise<{ event: CalendarEventSnapshot; etag: string }> {
  const event = await deps.client.api<CalendarEventSnapshot>(
    `${CAL}/calendars/primary/events/${encodeURIComponent(eventId)}?fields=id,etag,attendees`,
  );
  const attendees = event.attendees ?? [];
  if (requireEmpty && attendees.length > 0) {
    throw new Error(
      `Cannot ${action} event ${eventId} as owner-only: it has ${attendees.length} attendee(s) ` +
        `who would be notified. Retry without ownerOnly so the owner can approve it.`,
    );
  }
  const etag = requireEventEtag(event, eventId);
  return { event, etag };
}

/** An absent/inaccessible point read is unknown, never a cancellation receipt. */
export async function readCalendarEvent(
  client: GoogleClient,
  input: { calendarId: string; eventId: string; signal?: AbortSignal },
) {
  const raw = await client.api<RawEvent>(
    `${CAL}/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
    { signal: input.signal },
  );
  if (!raw || raw.id !== input.eventId)
    throw new Error('Calendar point read returned a different identity');
  const event = normalizeEvent(raw, {
    id: input.calendarId,
    name: input.calendarId,
    primary: false,
    accessRole: 'reader',
  });
  if (
    event.status !== 'cancelled' &&
    (!event.start ||
      !event.end ||
      !Number.isFinite(Date.parse(event.start)) ||
      !Number.isFinite(Date.parse(event.end)))
  )
    throw new Error('Calendar point read lacks valid event times');
  return event;
}

export async function listEventsInWindow(
  client: GoogleClient,
  opts: { timeMin: Date; timeMax: Date; maxResults?: number },
) {
  const maxResults = Math.min(Math.max(opts.maxResults ?? 20, 1), 50);
  return collectEvents(
    { client, botEmail: '', ownerEmail: '' },
    {
      maxResults,
      queryKey: `events:${opts.timeMin.toISOString()}:${opts.timeMax.toISOString()}:singleEvents=true:orderBy=startTime`,
      query: (calendarId, pageSize, pageToken) => {
        const params = new URLSearchParams({
          timeMin: opts.timeMin.toISOString(),
          timeMax: opts.timeMax.toISOString(),
          maxResults: String(pageSize),
          singleEvents: 'true',
          orderBy: 'startTime',
        });
        if (pageToken) params.set('pageToken', pageToken);
        return `${CAL}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
      },
    },
  );
}

export function registerCalendarTools(
  registry: ToolRegistry,
  deps: CalendarToolDeps,
  options: { readOnly?: boolean } = {},
): ToolRegistry {
  register(
    registry,
    {
      name: 'calendar.availability',
      description:
        'Check when the owner is free or busy. Covers every calendar shared with the assistant, plus its own. Times are ISO 8601 with offset.',
      inputSchema: z.object({
        timeMin: z.string().datetime({ offset: true }),
        timeMax: z.string().datetime({ offset: true }),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      cacheTtlSeconds: 300,
      execute: async (args) => {
        // Ask about every calendar this account can see, not just the bot's own
        // and the owner's address: a busy block on a shared "Work" calendar is
        // exactly as blocking as one on the owner's primary.
        let calendarRosterComplete = true;
        const roster: CalendarRoster = await fetchCalendars(deps.client).catch(() => {
          calendarRosterComplete = false;
          return { calendars: [] as CalendarEntry[], nextPageToken: undefined };
        });
        calendarRosterComplete = calendarRosterComplete && !roster.nextPageToken;
        const ids = new Set<string>([deps.botEmail, deps.ownerEmail]);
        for (const calendar of roster.calendars) ids.add(calendar.id);
        const items = [...ids].slice(0, MAX_FREEBUSY_ITEMS).map((id) => ({ id }));
        const nameFor = new Map(roster.calendars.map((c) => [c.id, c.name]));

        const res = await deps.client.api<{
          calendars?: Record<
            string,
            { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }
          >;
        }>(`${CAL}/freeBusy`, {
          method: 'POST',
          body: JSON.stringify({
            timeMin: args.timeMin,
            timeMax: args.timeMax,
            items,
          }),
        });

        const calendars = res.calendars ?? {};
        const busy: Array<{ start: string; end: string; calendar: string }> = [];
        const unavailable: string[] = [];
        for (const { id } of items) {
          const entry = calendars[id];
          const label = nameFor.get(id) ?? id;
          if (!entry || (Array.isArray(entry.errors) && entry.errors.length > 0)) {
            unavailable.push(label);
            continue;
          }
          for (const slot of entry.busy ?? []) busy.push({ ...slot, calendar: label });
        }
        busy.sort((a, b) => startedAt(a) - startedAt(b));

        const complete =
          calendarRosterComplete && ids.size === items.length && unavailable.length === 0;
        const coverageNotes: string[] = [];
        if (!calendarRosterComplete) {
          coverageNotes.push('The readable calendar list could not be loaded.');
        }
        if (ids.size > items.length) {
          coverageNotes.push(`Checked the first ${items.length} of ${ids.size} calendars.`);
        }
        if (unavailable.length > 0) {
          coverageNotes.push('Some calendars did not return free/busy data.');
        }

        return {
          busy,
          calendarsChecked: items.map(({ id }) => nameFor.get(id) ?? id),
          complete,
          ...(roster.nextPageToken ? { calendarRosterNextPageToken: roster.nextPageToken } : {}),
          ...(unavailable.length > 0 ? { unavailable } : {}),
          ...(coverageNotes.length > 0 ? { note: coverageNotes.join(' ') } : {}),
        };
      },
    },
    // Free/busy is time ranges and owner-chosen calendar labels — no
    // third-party-authored prose — so checking availability does not taint the
    // session the way reading event bodies (external invites) does.
    { confidentialRead: true },
  );

  register(
    registry,
    {
      name: 'calendar.list_calendars',
      description:
        'List every calendar the assistant can read — its own and any shared with it. Use this to find out which calendars exist before reading a specific one.',
      inputSchema: z.object({ pageToken: z.string().max(4096).optional() }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      cacheTtlSeconds: 300,
      execute: async (args) => {
        const roster = await fetchCalendarPage(deps.client, args.pageToken);
        return {
          calendars: roster.calendars.map((c) => ({
            id: c.id,
            name: c.name,
            primary: c.primary,
            // reader = shared read-only; owner/writer = the bot can edit it.
            access: c.accessRole,
          })),
          ...(roster.nextPageToken ? { nextPageToken: roster.nextPageToken } : {}),
          complete: !roster.nextPageToken,
        };
      },
    },
    // The roster of calendars the owner subscribed to is owner-curated
    // metadata, not third-party content; listing it must not strip the owner
    // card mid-task.
    { confidentialRead: true },
  );

  register(
    registry,
    {
      name: 'calendar.list_events',
      description:
        'List events in a time range across every calendar the assistant can read: its own plus all shared calendars. This is the default for "what is happening Monday" and "what\'s on my calendar". Do not ask which calendar or provider; omit calendarIds to read them all. Results include literal organizer, attendee, location, and event/meeting links when Google returned them, plus whether coverage was complete.',
      inputSchema: z.object({
        timeMin: z.string().datetime({ offset: true }),
        timeMax: z.string().datetime({ offset: true }),
        maxResults: z.number().int().min(1).max(50).default(20),
        pageToken: z.string().max(MAX_CALENDAR_CURSOR_BYTES).optional(),
        /** Names or ids from calendar.list_calendars. Omit to read every one. */
        calendarIds: z.array(z.string().min(1).max(200)).max(25).optional(),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args) =>
        collectEvents(deps, {
          calendarIds: args.calendarIds,
          maxResults: args.maxResults,
          pageToken: args.pageToken,
          queryKey: `events:${args.timeMin}:${args.timeMax}:singleEvents=true:orderBy=startTime`,
          query: (calendarId, pageSize, pageToken) => {
            const params = new URLSearchParams({
              timeMin: args.timeMin,
              timeMax: args.timeMax,
              maxResults: String(pageSize),
              singleEvents: 'true',
              orderBy: 'startTime',
            });
            if (pageToken) params.set('pageToken', pageToken);
            return `${CAL}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
          },
        }),
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );

  // Firestore deployments may enable the independent calendar module without
  // installing the SQL-backed Google Workspace module. Keep that surface
  // strictly read-only until event mutations have their own portable approval
  // and audit path.
  if (options.readOnly) return registry;

  const createSchema = z
    .object({
      summary: z.string().min(1).max(200),
      start: z.union([
        z.string().datetime({ offset: true }),
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      ]),
      end: z.union([
        z.string().datetime({ offset: true }),
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      ]),
      allDay: z.boolean().default(false),
      description: z.string().max(4000).default(''),
      location: z.string().max(300).default(''),
      /** Adding attendees sends real invite emails — that's what gates approval. */
      attendees: z.array(z.string().email()).max(20).default([]),
    })
    .refine(
      (event) =>
        event.allDay
          ? /^\d{4}-\d{2}-\d{2}$/.test(event.start) && /^\d{4}-\d{2}-\d{2}$/.test(event.end)
          : !/^\d{4}-\d{2}-\d{2}$/.test(event.start) && !/^\d{4}-\d{2}-\d{2}$/.test(event.end),
      {
        message:
          'all-day events require date-only start and exclusive end; timed events require zoned datetimes',
      },
    );

  register(
    registry,
    {
      name: 'calendar.create_event',
      description:
        "Create an event on the assistant's own calendar. With attendees it sends real invite emails (the usual way to put something on the owner's calendar: invite them).",
      inputSchema: createSchema,
      risk: (args) =>
        ((args as z.infer<typeof createSchema>).attendees?.length ?? 0) > 0
          ? 'approval'
          : 'autonomous',
      acceptsUntrustedInput: false,
      approvalSummary: (args) => {
        const a = args as z.infer<typeof createSchema>;
        return `Create event "${a.summary}" ${a.start} and invite ${a.attendees.join(', ')}`;
      },
      idempotencyKey: (args, ctx) => {
        const a = args as z.infer<typeof createSchema>;
        return `cal-create-${ctx.taskId}-${a.summary}-${a.start}`;
      },
      execute: async (args, ctx) => {
        await assertBookingCurrent(ctx);
        const event = await deps.client.api<{ id: string; htmlLink?: string }>(
          `${CAL}/calendars/primary/events?sendUpdates=all`,
          {
            method: 'POST',
            body: JSON.stringify({
              summary: args.summary,
              description: args.description || undefined,
              location: args.location || undefined,
              start: args.allDay ? { date: args.start } : { dateTime: args.start },
              end: args.allDay ? { date: args.end } : { dateTime: args.end },
              attendees: args.attendees.map((email) => ({ email })),
            }),
          },
        );
        return {
          eventId: event.id,
          link: event.htmlLink,
          invited: args.attendees,
        };
      },
    },
    {
      outwardFacing: true,
      /**
       * An event with NO attendees is written to the owner's own calendar and
       * nothing else happens: no invitation is addressed, no third party is told,
       * nothing leaves the account. That makes it owner-visible in exactly the
       * sense `owner.notify` is — the same reasoning, applied to the calendar
       * instead of the dashboard — so it stays autonomous when untrusted content
       * is in the session. The moment there is an attendee, `sendUpdates=all`
       * mails them, and the call is gated like any other outward action.
       *
       * This is a deliberate, narrow widening of the anticipation-layer rule
       * that untrusted content may inform the owner but never author an outward
       * action (docs/anticipation-layer.md): it lets forwarded mail put a date on
       * the owner's calendar without an approval tap. It is confined to this one
       * argument shape on purpose — extending it to anything with a third-party
       * sink would be a redesign, not an increment.
       *
       * `outwardFacing` stays set: it is what keeps the tool out of an untrusted
       * sender's registry entirely, which is a separate protection from this one.
       */
      ownerVisibleOnly: (args) =>
        ((args as z.infer<typeof createSchema>).attendees?.length ?? 0) === 0,
    },
  );

  register(
    registry,
    {
      name: 'calendar.search_events',
      description:
        'Search by keyword (attendee, title, location, or description) across every calendar the assistant can read: its own plus all shared calendars. Do not ask which calendar or provider; omit calendarIds to search them all. Results include literal organizer, attendee, location, and event/meeting links when Google returned them, plus calendar identity, coverage, and ISO 8601 times.',
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        timeMin: z.string().datetime({ offset: true }).optional(),
        timeMax: z.string().datetime({ offset: true }).optional(),
        maxResults: z.number().int().min(1).max(50).default(20),
        pageToken: z.string().max(MAX_CALENDAR_CURSOR_BYTES).optional(),
        /** Names or ids from calendar.list_calendars. Omit to search every one. */
        calendarIds: z.array(z.string().min(1).max(200)).max(25).optional(),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args) =>
        collectEvents(deps, {
          calendarIds: args.calendarIds,
          maxResults: args.maxResults,
          pageToken: args.pageToken,
          queryKey: `search:${args.query}:${args.timeMin ?? ''}:${args.timeMax ?? ''}:singleEvents=true:orderBy=startTime`,
          query: (calendarId, pageSize, pageToken) => {
            const params = new URLSearchParams({
              q: args.query,
              maxResults: String(pageSize),
              singleEvents: 'true',
              orderBy: 'startTime',
            });
            if (args.timeMin) params.set('timeMin', args.timeMin);
            if (args.timeMax) params.set('timeMax', args.timeMax);
            if (pageToken) params.set('pageToken', pageToken);
            return `${CAL}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
          },
        }),
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );

  const updateSchema = z
    .object({
      eventId: z.string().min(3).max(200),
      summary: z.string().min(1).max(200).optional(),
      start: z.string().datetime({ offset: true }).optional(),
      end: z.string().datetime({ offset: true }).optional(),
      location: z.string().max(300).optional(),
      description: z.string().max(4000).optional(),
      addAttendees: z.array(z.string().email()).max(20).optional(),
      /**
       * "This event is mine alone — nobody gets mailed about the change."
       *
       * The claim, not the check. `risk` is synchronous and sees only these
       * args, never the stored event, so a caller could assert this about an
       * event that does in fact have attendees. Execute therefore fetches the
       * event and refuses outright when it finds any — the assertion buys the
       * autonomous tier, the fetch is what makes it true.
       */
      ownerOnly: z.boolean().optional(),
    })
    .refine(
      (u) =>
        u.summary !== undefined ||
        u.start !== undefined ||
        u.end !== undefined ||
        u.location !== undefined ||
        u.description !== undefined ||
        (u.addAttendees?.length ?? 0) > 0,
      { message: 'provide at least one field to change' },
    );

  register(
    registry,
    {
      name: 'calendar.update_event',
      description:
        "Reschedule or edit an existing event on the assistant's own calendar (new time, title, location, or added attendees). Attendees are notified.",
      inputSchema: updateSchema,
      /**
       * Approval by default, because the risk callback sees only the new args
       * and not whether the EXISTING event has attendees who would be mailed
       * about a reschedule — a dynamic tier alone would under-gate that.
       *
       * `ownerOnly: true` is the caller stating there are none, which earns the
       * autonomous tier here and is then *verified* against the stored event in
       * execute. Adding an attendee in the same call contradicts the claim
       * outright, so that combination stays gated no matter what was asserted.
       * Editing an appointment on one's own calendar is reversible and reaches
       * nobody — the same reasoning `create_event` already applies below.
       */
      risk: (args) => {
        const a = args as z.infer<typeof updateSchema>;
        return a.ownerOnly === true && (a.addAttendees?.length ?? 0) === 0
          ? 'autonomous'
          : 'approval';
      },
      acceptsUntrustedInput: false,
      approvalSummary: (args) => {
        const a = args as z.infer<typeof updateSchema>;
        const changes = [
          a.start ? `move to ${a.start}` : '',
          a.summary ? `rename to "${a.summary}"` : '',
          a.location ? `at ${a.location}` : '',
          a.addAttendees?.length ? `invite ${a.addAttendees.join(', ')}` : '',
        ].filter(Boolean);
        return `Update calendar event ${a.eventId}: ${changes.join('; ') || 'edit details'}`;
      },
      execute: async (args, ctx) => {
        await assertBookingCurrent(ctx);
        const needsSnapshot = args.ownerOnly === true || (args.addAttendees?.length ?? 0) > 0;
        let etag: string | undefined;
        let attendeeSnapshot: CalendarEventSnapshot | undefined;
        if (needsSnapshot) {
          const checked = await assertNoAttendees(
            deps,
            args.eventId,
            'update',
            args.ownerOnly === true,
          );
          etag = checked.etag;
          attendeeSnapshot = checked.event;
        }
        const patch: Record<string, unknown> = {};
        if (args.summary !== undefined) patch.summary = args.summary;
        if (args.start !== undefined) patch.start = { dateTime: args.start };
        if (args.end !== undefined) patch.end = { dateTime: args.end };
        if (args.location !== undefined) patch.location = args.location;
        if (args.description !== undefined) patch.description = args.description;
        if (args.addAttendees?.length) {
          patch.attendees = mergeAttendeeRows(attendeeSnapshot?.attendees ?? [], args.addAttendees);
        }
        const sendUpdates = args.ownerOnly && !args.addAttendees?.length ? 'none' : 'all';
        const updated = await deps.client.api<{
          id: string;
          htmlLink?: string;
          summary?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
        }>(
          `${CAL}/calendars/primary/events/${encodeURIComponent(args.eventId)}?sendUpdates=${sendUpdates}`,
          {
            method: 'PATCH',
            body: JSON.stringify(patch),
            ...(etag ? { headers: { 'If-Match': etag } } : {}),
          },
        );
        return {
          eventId: updated.id,
          link: updated.htmlLink,
          updated: true,
          ...(updated.summary ? { summary: updated.summary } : {}),
          ...(updated.start?.dateTime ? { start: updated.start.dateTime } : {}),
          ...(updated.end?.dateTime ? { end: updated.end.dateTime } : {}),
        };
      },
    },
    {
      outwardFacing: true,
      /**
       * Same reasoning as `create_event`'s flag below, applied to an edit: an
       * owner-only change mails nobody, so it stays autonomous when untrusted
       * content is in the session. `ownerVisibleOnlyFor` fails closed on an
       * argument shape it cannot read, and execute still verifies the claim
       * against the stored event, so a false assertion cannot slip a
       * third-party notification through this gate.
       */
      ownerVisibleOnly: (args) => {
        const a = args as z.infer<typeof updateSchema>;
        return a.ownerOnly === true && (a.addAttendees?.length ?? 0) === 0;
      },
    },
  );

  register(
    registry,
    {
      name: 'calendar.cancel_event',
      description:
        "Cancel an event on the assistant's calendar. If it has attendees they are notified — hence approval. Set ownerOnly=true for an event with no attendees (a private appointment); the call is refused if the event turns out to have any.",
      inputSchema: z.object({
        eventId: z.string().min(3).max(200),
        /** See `updateSchema.ownerOnly`: the claim, verified in execute. */
        ownerOnly: z.boolean().optional(),
      }),
      /**
       * Approval by default: cancelling an event with attendees mails all of
       * them. `ownerOnly: true` claims there are none, which is verified
       * against the stored event before anything is deleted — the async check
       * the original "revisit if it gets annoying" note was waiting for, done
       * in execute because the risk callback cannot await.
       */
      risk: (args) =>
        (args as { ownerOnly?: boolean }).ownerOnly === true ? 'autonomous' : 'approval',
      acceptsUntrustedInput: false,
      approvalSummary: (args) => `Cancel calendar event ${(args as { eventId: string }).eventId}`,
      execute: async (args, ctx) => {
        const booking = ctx.bookingOccurrence;
        if (booking?.operation === 'cancel_existing') return cancelBoundBooking(deps, args, ctx);
        await assertBookingCurrent(ctx);
        const checked = args.ownerOnly
          ? await assertNoAttendees(deps, args.eventId, 'cancel')
          : undefined;
        await deps.client.api(
          `${CAL}/calendars/primary/events/${encodeURIComponent(args.eventId)}?sendUpdates=${
            args.ownerOnly ? 'none' : 'all'
          }`,
          {
            method: 'DELETE',
            ...(checked ? { headers: { 'If-Match': checked.etag } } : {}),
          },
        );
        return { cancelled: args.eventId };
      },
    },
    {
      outwardFacing: true,
      /** See `update_event`: verified in execute, so the claim cannot lie. */
      ownerVisibleOnly: (args) => (args as { ownerOnly?: boolean }).ownerOnly === true,
    },
  );

  register(registry, {
    name: 'calendar.cancel_booking_event',
    description:
      'Cancel only the exact calendar event bound to a current cancelled email booking suggestion. The event is fetched again, its booking reference and revision are rechecked, and its ETag is required before deletion.',
    inputSchema: z.object({
      eventId: z.string().min(3).max(200),
      ownerOnly: z.boolean().optional(),
    }),
    risk: (args) =>
      (args as { ownerOnly?: boolean }).ownerOnly === true ? 'autonomous' : 'approval',
    acceptsUntrustedInput: true,
    prepareSecurity: async (args, ctx) => {
      if (
        ctx.bookingOccurrence?.operation !== 'cancel_existing' ||
        ctx.bookingOccurrence.calendarEventId !== args.eventId ||
        !ctx.bookingOccurrence.bookingIdentity?.trim()
      )
        throw new Error('This cancellation is missing its current booking authority binding.');
      return args;
    },
    approvalSummary: (args) =>
      `Cancel the confirmed booking event ${(args as { eventId: string }).eventId}`,
    execute: async (args, ctx) => cancelBoundBooking(deps, args, ctx),
  });

  register(
    registry,
    {
      name: 'calendar.respond_to_event',
      description:
        "Answer an invitation: accept, decline, or mark tentative on an event the assistant or owner was invited to. Use this for an event someone ELSE organized — calendar.update_event edits the assistant's own events and cannot set an RSVP. Pass the calendarId the event was found on (list_events and search_events return it); the default is the assistant's own calendar. The organizer is notified.",
      inputSchema: respondSchema,
      /**
       * Approval by default; the owner can save a calendar-scoped response rule.
       * An RSVP is a message to whoever called the meeting —
       * declining is a social act with consequences the assistant is in no
       * position to weigh — so there is no owner-only tier here the way there
       * is for editing a private appointment. The risk callback is a constant
       * rather than a function for exactly that reason.
       */
      risk: 'approval',
      acceptsUntrustedInput: false,
      approvalSummary: (args) => {
        const a = args as z.infer<typeof respondSchema>;
        const verb =
          a.response === 'accepted'
            ? 'Accept'
            : a.response === 'declined'
              ? 'Decline'
              : 'Tentatively accept';
        return `${verb} the invitation to ${a.eventId}${a.comment ? ` — "${a.comment}"` : ''}`;
      },
      execute: async (args) => {
        const path = `${CAL}/calendars/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.eventId)}`;
        const event = await deps.client.api<CalendarEventSnapshot>(path);

        const attendees = event.attendees ?? [];
        const index = selfAttendeeIndex(attendees, deps, args.calendarId);
        if (index < 0) {
          // Without an attendee row there is nothing to answer. Saying so beats
          // inventing one: adding the assistant to someone else's guest list is
          // a different act from replying to an invitation, and not one the
          // owner approved when they approved an RSVP.
          throw new Error(
            attendees.length === 0
              ? `Event ${args.eventId} has no attendees, so there is no invitation to answer. It may be an event the assistant owns — use calendar.update_event or calendar.cancel_event instead.`
              : `Neither ${deps.botEmail} nor ${deps.ownerEmail} is on the guest list for event ${args.eventId}, so there is no invitation to answer.`,
          );
        }

        // Calendar replaces the attendees array wholesale, so every other guest
        // is written back exactly as it was read — spread rather than rebuilt,
        // because the stored rows carry fields this code does not model
        // (displayName, optional, organizer, additionalGuests) and mapping them
        // through a narrower shape would quietly drop them from the event.
        const patched = attendees.map((attendee, at) =>
          at === index
            ? {
                ...attendee,
                responseStatus: args.response,
                ...(args.comment ? { comment: args.comment } : {}),
              }
            : attendee,
        );
        const etag = requireEventEtag(event, args.eventId);

        const updated = await deps.client.api<{ id: string; htmlLink?: string }>(
          `${path}?sendUpdates=all`,
          {
            method: 'PATCH',
            headers: { 'If-Match': etag },
            body: JSON.stringify({ attendees: patched }),
          },
        );
        return {
          eventId: updated.id,
          response: args.response,
          summary: event.summary ?? '',
          organizer: event.organizer?.email ?? '',
          link: updated.htmlLink ?? event.htmlLink,
          responded: true,
        };
      },
    },
    { outwardFacing: true },
  );

  return registry;
}

/** Register the portable read-only calendar surface for Firestore agents. */
export function registerCalendarReadTools(
  registry: ToolRegistry,
  deps: CalendarToolDeps,
): ToolRegistry {
  return registerCalendarTools(registry, deps, { readOnly: true });
}
