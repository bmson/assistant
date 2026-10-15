import { calendarSourceInterval } from './calendar-read-window.js';
import type { PersonalReadRequest, ReadToolEvidence } from './read-intent.js';

/** A literal subject is a lookup scope, never a resolved contact identity. */
export function requestedCalendarPerson(text: string): string | undefined {
  const name = String.raw`([\p{L}\p{N}@._'’+-]+(?:\s+[\p{L}\p{N}._'’+-]+){0,3}?)`;
  const patterns = [
    new RegExp(String.raw`^\s*what(?:\s+is|'s|’s)\s+${name}\s+(?:doing|planning|up to)\b`, 'iu'),
    new RegExp(String.raw`^\s*(?:is|will)\s+${name}\s+(?:be\s+)?(?:free|busy|available)\b`, 'iu'),
    new RegExp(
      String.raw`^\s*(?:what(?:\s+is|'s|’s)\s+on|show|check|list)\s+${name}['’]s\s+(?:calendar|schedule)\b`,
      'iu',
    ),
    new RegExp(
      String.raw`^\s*what\s+does\s+${name}\s+have\s+(?:planned|scheduled|on (?:their|the) calendar)\b`,
      'iu',
    ),
  ];
  const subject = patterns
    .map((pattern) => pattern.exec(text)?.[1])
    .find(Boolean)
    ?.trim();
  if (
    !subject ||
    subject.length > 100 ||
    /^(?:i|me|my|we|us|our|you|your|he|she|they|it|everyone|anyone|someone|the team|(?:the )?(?:weather|traffic|market|stock market))$/i.test(
      subject,
    ) ||
    /^(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(
      subject,
    )
  )
    return undefined;
  return subject;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (row: Record<string, unknown>, key: string) =>
  typeof row[key] === 'string' ? (row[key] as string) : '';
const normalize = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const escapeText = (value: string) =>
  value
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 240)
    .replace(/[\\`*_{}[\]()<>#+\-=|!]/g, '\\$&');

function calendarNameMatches(name: string, person: string): boolean {
  return normalize(name).replace(/(?:['’]s)?\s+(?:calendar|schedule)$/, '') === normalize(person);
}

/** Contiguous current-task pages only; a model-selected date/calendar is not coverage. */
function pages(request: PersonalReadRequest, evidence: ReadonlyArray<ReadToolEvidence>) {
  const result: Array<{ row: ReadToolEvidence; data: Record<string, unknown> }> = [];
  let token: string | undefined;
  for (const row of evidence) {
    const args = object(row.args);
    const data = object(row.result);
    if (
      row.fromCurrentTask === false ||
      row.status !== 'succeeded' ||
      row.toolName !== 'calendar.list_events' ||
      !args ||
      !data ||
      data.ok === false ||
      (typeof data.status === 'number' && data.status >= 400) ||
      args.timeMin !== request.timeWindow?.timeMin ||
      args.timeMax !== request.timeWindow?.timeMax ||
      (Array.isArray(args.calendarIds) && args.calendarIds.length > 0) ||
      (args.pageToken || undefined) !== token ||
      !Array.isArray(data.events)
    )
      continue;
    result.push({ row, data });
    token =
      typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
    if (!token || result.length === 3) break;
  }
  const complete =
    result.length > 0 &&
    !token &&
    result.at(-1)?.data.complete === true &&
    result.every(
      ({ data }) =>
        data.calendarRosterComplete === true &&
        Array.isArray(data.unavailable) &&
        data.unavailable.length === 0 &&
        data.paginationUnavailable !== true,
    );
  return { result, complete };
}

function namedAttendees(event: Record<string, unknown>, person: string) {
  const rows = Array.isArray(event.attendeeDetails)
    ? event.attendeeDetails.map(object).filter(Boolean)
    : [];
  return rows.filter(
    (row) =>
      row &&
      (normalize(string(row, 'displayName')) === normalize(person) ||
        (person.includes('@') && normalize(string(row, 'email')) === normalize(person))),
  );
}

function attendeeMatch(
  event: Record<string, unknown>,
  person: string,
  ambiguous: boolean,
): string | undefined {
  if (ambiguous) return undefined;
  const matches = namedAttendees(event, person);
  // A shared first name is not a contact disambiguation. Do not choose one address.
  const identities = new Set(matches.map((row) => normalize(row ? string(row, 'email') : '')));
  if (identities.size !== 1 || identities.has('')) return undefined;
  const response = matches[0] ? string(matches[0], 'responseStatus') : '';
  if (response === 'declined') return undefined;
  return response === 'accepted'
    ? 'attendee marked accepted'
    : response === 'tentative'
      ? 'attendee marked tentative'
      : 'invited; attendance unconfirmed';
}

function sourceInterval(event: Record<string, unknown>) {
  const start = string(event, 'start');
  const end = string(event, 'end');
  if (
    (start.includes('T') && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(start)) ||
    (end.includes('T') && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(end))
  )
    return undefined;
  return calendarSourceInterval(event);
}

export function personCalendarResponse(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): { text: string; blocked: boolean } {
  const person = request.personCalendar?.name ?? '';
  if (!request.timeWindow || !request.timeZone)
    return {
      text: `What dates and time zone should I use to check ${escapeText(person)}’s calendar?`,
      blocked: true,
    };
  const from = Date.parse(request.timeWindow.timeMin);
  const to = Date.parse(request.timeWindow.timeMax);
  const format = (value: number, time = false) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: request.timeZone,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      ...(time ? ({ hour: 'numeric', minute: '2-digit' } as const) : {}),
    }).format(value);
  const period = `${format(from)}–${format(to - 1)} (${request.timeZone})`;
  const checked = pages(request, evidence);
  const identities = new Set(
    checked.result.flatMap(({ data }) =>
      (data.events as unknown[]).flatMap((raw) => {
        const event = object(raw);
        if (!event || string(event, 'status') === 'cancelled') return [];
        const interval = sourceInterval(event);
        if (!interval || interval.start >= to || interval.end <= from) return [];
        return namedAttendees(event, person).flatMap((row) =>
          row && string(row, 'email') ? [normalize(string(row, 'email'))] : [],
        );
      }),
    ),
  );
  const ambiguous = identities.size > 1;
  const lines: string[] = [];
  const seen = new Set<string>();
  let uncertainDates = false;
  let namedCalendarFound = false;
  let otherEntries = false;
  for (const { data } of checked.result) {
    const calendars = (Array.isArray(data.calendarsResolved) ? data.calendarsResolved : [])
      .map(object)
      .filter(Boolean);
    if (calendars.some((row) => row && calendarNameMatches(string(row, 'name'), person)))
      namedCalendarFound = true;
    for (const raw of data.events as unknown[]) {
      const event = object(raw);
      if (!event || string(event, 'status') === 'cancelled') continue;
      const key = `${string(event, 'calendarId')}|${string(event, 'eventId')}|${string(event, 'start')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const calendar = calendars.find(
        (row) => row && string(row, 'id') === string(event, 'calendarId'),
      );
      const namedCalendar = Boolean(
        calendar && calendarNameMatches(string(calendar, 'name'), person),
      );
      const attendee = attendeeMatch(event, person, ambiguous);
      if (!attendee && !namedCalendar) {
        otherEntries = true;
        continue;
      }
      const start = string(event, 'start');
      const end = string(event, 'end');
      const interval = sourceInterval(event);
      if (!interval) {
        uncertainDates = true;
        continue;
      }
      if (interval.start >= to || interval.end <= from) continue;
      const when = /^\d{4}-\d{2}-\d{2}$/.test(start)
        ? `${start}${end > start ? ` to ${end} (end exclusive)` : ''}, all day in ${escapeText(string(event, 'calendarTimeZone'))}`
        : `${format(interval.start, true)}–${format(interval.end, true)}`;
      const scope =
        attendee ??
        `on calendar “${escapeText(calendar ? string(calendar, 'name') : '')}”; personal attendance unconfirmed`;
      const links = (Array.isArray(event.links) ? event.links : []).map(object);
      const source = links.find(
        (link) =>
          link &&
          string(link, 'type') === 'calendar' &&
          /^https:\/\/(?:calendar\.google\.com|www\.google\.com)\//i.test(string(link, 'url')),
      );
      lines.push(
        `- **${escapeText(string(event, 'summary') || 'Untitled event')}** — ${when}; ${scope}.${source ? ` [Source event](${string(source, 'url')})` : ''}`,
      );
    }
  }
  const opening = lines.length
    ? `For ${period}, these checked calendar entries link to ${escapeText(person)}:`
    : `I couldn’t confirm ${escapeText(person)}’s plans for ${period} from the calendars I can read.`;
  const tail = [
    !checked.complete
      ? 'Calendar coverage is incomplete; some events or calendars may be missing.'
      : '',
    uncertainDates
      ? 'Some linked entries lacked a usable source time zone or event interval, so I could not place them in this window.'
      : '',
    otherEntries ? 'Other calendar entries do not establish this person’s attendance.' : '',
    ambiguous
      ? `More than one attendee address is named ${escapeText(person)}. Which email address do you mean?`
      : '',
    'Calendar entries and RSVP status do not establish personal availability.',
    !lines.length && !namedCalendarFound && !ambiguous
      ? `Which calendar or email address should I use for ${escapeText(person)}?`
      : '',
  ].filter(Boolean);
  return { text: [opening, ...lines, ...tail].join('\n\n'), blocked: !checked.complete };
}
