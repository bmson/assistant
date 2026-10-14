import type { CalendarPlanOptions } from './calendar-plan-intent.js';
import type { ActionEvidence } from './response-contract.js';

const SLOT_MS = 15 * 60_000;
const TRAVEL_MS = 30 * 60_000;
const MAX_EVENT_PAGES = 3;

type PlainRecord = Record<string, unknown>;
type BusyInterval = { start: number; end: number; calendar?: string };

function record(value: unknown): PlainRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as PlainRecord)
    : undefined;
}

function dateMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function overlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function mergeIntervals(
  intervals: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = intervals
    .filter(
      (value) =>
        Number.isFinite(value.start) && Number.isFinite(value.end) && value.end > value.start,
    )
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

function localParts(
  at: number,
  timeZone: string,
): { day: string; weekday: number; hour: number; minute: number } | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const get = (type: string) => parts.find((part) => part.type === type)?.value;
    const day = `${get('year')}-${get('month')}-${get('day')}`;
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday') ?? '');
    const hour = Number(get('hour'));
    const minute = Number(get('minute'));
    if (weekday < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
    return { day, weekday, hour, minute };
  } catch {
    return undefined;
  }
}

function labelTime(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(at));
}

function labelDay(day: string): string {
  const at = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(at)) return day;
  return new Intl.DateTimeFormat('en-US', {
    // `day` is already a civil key computed in the owner's zone. Formatting
    // UTC noon in that same zone can shift it across the date line again.
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(at));
}

function resultOf(row: ActionEvidence): PlainRecord | undefined {
  return record(row.result);
}

function successful(row: ActionEvidence): boolean {
  return row.status === 'succeeded' && resultOf(row)?.ok !== false;
}

function strictGoogleCalendarLink(event: PlainRecord): string | undefined {
  const links = Array.isArray(event.links) ? event.links : [];
  for (const item of links) {
    const link = record(item);
    if (link?.type !== 'calendar' || typeof link.url !== 'string') continue;
    try {
      const url = new URL(link.url);
      if (
        url.protocol === 'https:' &&
        ['calendar.google.com', 'www.google.com'].includes(url.hostname) &&
        /event/i.test(url.pathname) &&
        !url.username &&
        !url.password
      )
        return url.href;
    } catch {
      // Ignore malformed or non-Google links.
    }
  }
  return undefined;
}

function eventIdentity(event: PlainRecord): string {
  const occurrence =
    typeof event.originalStartTime === 'string'
      ? event.originalStartTime
      : String(event.start ?? '');
  if (typeof event.iCalUID === 'string' && event.iCalUID)
    return `ical:${event.iCalUID}\0${occurrence}`;
  const stable = event.recurringEventId ?? event.eventId ?? event.summary ?? '';
  return `calendar:${String(event.calendarId ?? event.calendar ?? '')}\0${String(stable)}\0${occurrence}`;
}

function attendance(event: PlainRecord): 'attending' | 'potential' | 'not-attending' {
  if (
    event.status === 'cancelled' ||
    event.ownerResponse === 'declined' ||
    event.blocksTime === false
  )
    return 'not-attending';
  if (event.ownerResponse === 'accepted') return 'attending';
  if (event.ownerResponse === 'tentative') return 'potential';
  return event.blocksTime === true ? 'potential' : 'not-attending';
}

function parseEventInterval(event: PlainRecord): { start: number; end: number } | undefined {
  const start = dateMs(event.start);
  const end = dateMs(event.end);
  return start !== undefined && end !== undefined && end > start ? { start, end } : undefined;
}

function isExtendedContext(interval: { start: number; end: number }): boolean {
  return interval.end - interval.start >= 18 * 60 * 60_000;
}

function isExtendedLodging(event: PlainRecord, interval: { start: number; end: number }): boolean {
  if (!isExtendedContext(interval)) return false;
  const metadata = record(event.sourceMetadata);
  const source = record(event.source);
  const details = [
    event.summary,
    event.description,
    event.source,
    event.sourceType,
    event.category,
    metadata?.type,
    metadata?.category,
    metadata?.description,
    source?.type,
    source?.category,
    source?.description,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  const explicitStayOrReservation =
    /\b(?:hotel|lodging|accommodation|hostel|resort|airbnb)\s+(?:reservation|booking|stay)\b/i.test(
      details,
    ) || /\b(?:overnight|multi[- ]night)\s+(?:hotel\s+)?stay\b/i.test(details);
  const explicitCheckInAndOut =
    /\bcheck[ -]?in\b/i.test(details) && /\bcheck[ -]?out\b/i.test(details);
  return explicitStayOrReservation || explicitCheckInAndOut;
}

/**
 * A complete event listing can explain a free/busy interval that represents a
 * multi-day lodging record. This is used only to generate conditional review
 * candidates; the provider's busy result is retained and disclosed.
 */
function lodgingExplanationForBusy(
  busy: BusyInterval,
  events: PlainRecord[],
  availabilityResult: PlainRecord | undefined,
  eventComplete: boolean,
): PlainRecord | undefined {
  if (!eventComplete || !busy.calendar) return undefined;
  const checked = Array.isArray(availabilityResult?.calendarsChecked)
    ? availabilityResult.calendarsChecked.filter((value) => value === busy.calendar)
    : [];
  if (checked.length !== 1) return undefined;

  const calendarEvents = events.filter(
    (event) => event.calendar === busy.calendar || event.calendarId === busy.calendar,
  );
  if (calendarEvents.length === 0) return undefined;
  const calendarIdentities = new Set(
    calendarEvents
      .map((event) =>
        typeof event.calendarId === 'string'
          ? event.calendarId
          : typeof event.calendar === 'string'
            ? event.calendar
            : '',
      )
      .filter(Boolean),
  );
  if (calendarIdentities.size !== 1) return undefined;

  const lodging = calendarEvents.filter((event) => {
    const interval = parseEventInterval(event);
    return (
      interval !== undefined &&
      attendance(event) !== 'not-attending' &&
      interval.start <= busy.start &&
      interval.end >= busy.end &&
      isExtendedLodging(event, interval)
    );
  });
  if (lodging.length === 0) return undefined;

  // A separate event on the same calendar may be hidden inside the provider's
  // merged busy interval. Keep that interval blocking unless all such events
  // are themselves identified lodging records.
  const blockingOthers = calendarEvents.filter((event) => {
    const interval = parseEventInterval(event);
    return (
      !lodging.includes(event) &&
      attendance(event) !== 'not-attending' &&
      (event.allDay === true || (interval !== undefined && overlap(interval, busy)))
    );
  });
  if (blockingOthers.length > 0) return undefined;
  return lodging[0];
}

export interface WeeklyCalendarPlanResult {
  text: string;
  coverageComplete: boolean;
  slotCount: number;
}

function eventTitle(event: PlainRecord): string {
  return safeText(event.summary, 100) || 'Untitled event';
}

export interface WeeklyCalendarPlanInput {
  timeMin: string;
  timeMax: string;
  timeZone?: string;
  evidence: ActionEvidence[];
  plan?: CalendarPlanOptions;
}

/** A deterministic, review-only proposal. It never schedules or edits events. */
export function weeklyCalendarPlanResult(input: WeeklyCalendarPlanInput): WeeklyCalendarPlanResult {
  const result = (
    text: string,
    coverageComplete = false,
    slotCount = 0,
  ): WeeklyCalendarPlanResult => ({
    text,
    coverageComplete,
    slotCount,
  });
  if (
    input.plan &&
    (!Number.isInteger(input.plan.focusMinutes) ||
      input.plan.focusMinutes < 15 ||
      input.plan.focusMinutes > 240 ||
      !Number.isInteger(input.plan.slotCount) ||
      input.plan.slotCount < 1 ||
      input.plan.slotCount > 10 ||
      !Number.isInteger(input.plan.breakMinutes) ||
      input.plan.breakMinutes < 0 ||
      input.plan.breakMinutes > 60 ||
      (input.plan.meetingBufferMinutes !== undefined &&
        (!Number.isInteger(input.plan.meetingBufferMinutes) ||
          input.plan.meetingBufferMinutes < 0 ||
          input.plan.meetingBufferMinutes > 60)))
  )
    return result(
      'I couldn’t safely resolve the requested focus duration, count, or breaks. Please confirm those constraints.',
    );
  const focusMs = (input.plan?.focusMinutes ?? 90) * 60_000;
  const breakMs = (input.plan?.breakMinutes ?? 15) * 60_000;
  const requestedSlots = input.plan?.slotCount ?? 3;
  const windowLabel = input.plan?.windowLabel ?? 'next week';
  const start = dateMs(input.timeMin);
  const end = dateMs(input.timeMax);
  if (start === undefined || end === undefined || end <= start)
    return result(
      `I couldn’t resolve a safe calendar window for ${windowLabel}. Please check your calendar settings and ask me to try again.`,
    );
  if (!input.timeZone)
    return result(
      `I can review ${windowLabel}, but your time zone is unavailable, so I can’t safely suggest focus times. Please confirm your time zone first.`,
    );
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone }).format(new Date(start));
  } catch {
    return result(
      `I can review ${windowLabel}, but your time zone setting is invalid, so I can’t safely suggest focus times.`,
    );
  }
  const timeZone = input.timeZone;

  const availabilityRows = input.evidence.filter((row) => {
    const args = record(row.args);
    return (
      row.toolName === 'calendar.availability' &&
      successful(row) &&
      args?.timeMin === input.timeMin &&
      args?.timeMax === input.timeMax
    );
  });
  const availability = availabilityRows.at(-1);
  const availabilityResult = availability ? resultOf(availability) : undefined;
  const busyRaw = availabilityResult?.busy;
  const busyValid =
    Array.isArray(busyRaw) &&
    busyRaw.every((value) => {
      const item = record(value);
      return (
        dateMs(item?.start) !== undefined &&
        dateMs(item?.end) !== undefined &&
        (dateMs(item?.end) as number) > (dateMs(item?.start) as number)
      );
    });
  const busy: BusyInterval[] = busyValid
    ? (busyRaw as unknown[]).flatMap((value) => {
        const item = record(value);
        const interval = item
          ? {
              start: dateMs(item.start) as number,
              end: dateMs(item.end) as number,
              ...(typeof item.calendar === 'string' ? { calendar: item.calendar } : {}),
            }
          : undefined;
        return interval ? [interval] : [];
      })
    : [];

  const eventRows = input.evidence.filter((row) => {
    const args = record(row.args);
    return (
      row.toolName === 'calendar.list_events' &&
      successful(row) &&
      args?.timeMin === input.timeMin &&
      args?.timeMax === input.timeMax
    );
  });
  const allPages = eventRows.slice(0, MAX_EVENT_PAGES);
  const events: PlainRecord[] = [];
  let eventRowsValid = allPages.length > 0;
  for (const row of allPages) {
    const result = resultOf(row);
    if (!Array.isArray(result?.events)) {
      eventRowsValid = false;
      continue;
    }
    for (const value of result.events) {
      const event = record(value);
      if (!event || !parseEventInterval(event)) eventRowsValid = false;
      else events.push(event);
    }
  }

  const uniqueEvents = [...new Map(events.map((event) => [eventIdentity(event), event])).values()];
  const availabilityComplete =
    busyValid &&
    availabilityResult?.complete === true &&
    (availabilityResult.unavailable === undefined ||
      (Array.isArray(availabilityResult.unavailable) &&
        availabilityResult.unavailable.length === 0));
  const lastPage = allPages.at(-1);
  const lastEventResult = lastPage ? resultOf(lastPage) : undefined;
  let expectedPageToken: string | undefined;
  const pageSequenceValid = allPages.every((row) => {
    const args = record(row.args);
    const matches = (args?.pageToken || undefined) === expectedPageToken;
    const result = resultOf(row);
    const next = result?.nextPageToken;
    expectedPageToken = typeof next === 'string' && next.length > 0 ? next : undefined;
    return matches;
  });
  const eventComplete =
    eventRowsValid &&
    allPages.length > 0 &&
    pageSequenceValid &&
    lastEventResult?.complete === true &&
    lastEventResult.calendarRosterComplete === true &&
    Array.isArray(lastEventResult.unavailable) &&
    lastEventResult.unavailable.length === 0 &&
    typeof lastEventResult.nextPageToken !== 'string' &&
    lastEventResult.paginationUnavailable !== true;
  const unavailableCalendars = [
    ...(Array.isArray(availabilityResult?.unavailable) ? availabilityResult.unavailable : []),
    ...allPages.flatMap((row) => {
      const unavailable = resultOf(row)?.unavailable;
      return Array.isArray(unavailable)
        ? unavailable.flatMap((value) => {
            if (typeof value === 'string') return [value];
            const name = record(value)?.calendar;
            return typeof name === 'string' ? [name] : [];
          })
        : [];
    }),
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => safeText(value, 100))
    .filter(Boolean)
    .slice(0, 5);
  const complete = availabilityComplete && eventComplete;

  const eventBusy: Array<{ start: number; end: number }> = [];
  let travelBufferCount = 0;
  let potentialTravelBufferCount = 0;
  for (const event of uniqueEvents) {
    const interval = parseEventInterval(event);
    if (
      !interval ||
      attendance(event) === 'not-attending' ||
      event.allDay === true ||
      isExtendedLodging(event, interval)
    )
      continue;
    const location = typeof event.location === 'string' && event.location.trim().length > 0;
    const hasVideo =
      Array.isArray(event.links) && event.links.some((value) => record(value)?.type === 'video');
    const remoteLocation =
      typeof event.location === 'string' &&
      /(?:https?:\/\/|\b(?:online|virtual|remote|zoom|teams|google meet|video call)\b)/i.test(
        event.location,
      );
    const inPerson = location && !hasVideo && !remoteLocation;
    if (inPerson) travelBufferCount += 1;
    if (inPerson && attendance(event) === 'potential') potentialTravelBufferCount += 1;
    eventBusy.push({
      start: Math.max(
        start,
        interval.start -
          Math.max(inPerson ? TRAVEL_MS : 0, (input.plan?.meetingBufferMinutes ?? 0) * 60_000),
      ),
      end: Math.min(
        end,
        interval.end +
          Math.max(inPerson ? TRAVEL_MS : 0, (input.plan?.meetingBufferMinutes ?? 0) * 60_000),
      ),
    });
  }
  const explainedLodgingBusy = new Map<BusyInterval, PlainRecord>();
  for (const interval of busy) {
    const lodging = lodgingExplanationForBusy(
      interval,
      uniqueEvents,
      availabilityResult,
      eventComplete,
    );
    if (lodging) explainedLodgingBusy.set(interval, lodging);
  }
  const candidateBusy = busy.filter((interval) => !explainedLodgingBusy.has(interval));
  const busyMerged = mergeIntervals([...candidateBusy, ...eventBusy]);

  const dayStats = new Map<
    string,
    {
      busyMs: number;
      candidates: Array<{ start: number; end: number; lodgingConditions: string[] }>;
    }
  >();
  for (let at = start; at + focusMs + breakMs <= end; at += SLOT_MS) {
    const parts = localParts(at, input.timeZone);
    if (!parts || parts.weekday === 0 || parts.weekday === 6 || parts.hour < 9 || parts.hour >= 17)
      continue;
    const day = dayStats.get(parts.day) ?? { busyMs: 0, candidates: [] };
    dayStats.set(parts.day, day);
    const focusEnd = at + focusMs;
    const occupiedEnd = focusEnd + breakMs;
    const endParts = localParts(occupiedEnd, input.timeZone);
    if (
      !endParts ||
      endParts.day !== parts.day ||
      endParts.weekday >= 6 ||
      endParts.hour > 17 ||
      (endParts.hour === 17 && endParts.minute > 0)
    )
      continue;
    const candidate = { start: at, end: occupiedEnd };
    if (busyValid && !busyMerged.some((interval) => overlap(interval, candidate))) {
      const lodgingConditions = [
        ...new Set(
          busy
            .filter(
              (interval) => explainedLodgingBusy.has(interval) && overlap(interval, candidate),
            )
            .flatMap((interval) => {
              const lodging = explainedLodgingBusy.get(interval);
              return lodging ? [eventTitle(lodging)] : [];
            }),
        ),
      ];
      day.candidates.push({ ...candidate, lodgingConditions });
    }
  }

  for (let at = start; at < end; at += SLOT_MS) {
    const parts = localParts(at, input.timeZone);
    if (!parts || parts.weekday === 0 || parts.weekday === 6 || parts.hour < 9 || parts.hour >= 17)
      continue;
    const stats = dayStats.get(parts.day);
    if (stats && busyMerged.some((interval) => interval.start < at + SLOT_MS && at < interval.end))
      stats.busyMs += SLOT_MS;
  }

  const rankedDays = [...dayStats.entries()]
    .filter(([, stats]) => stats.candidates.length > 0)
    .sort((a, b) => a[1].busyMs - b[1].busyMs || a[0].localeCompare(b[0]));
  const chosen: Array<{ start: number; end: number; lodgingConditions: string[] }> = [];
  for (const [, stats] of rankedDays) {
    if (chosen.length >= requestedSlots) break;
    const first = stats.candidates[0];
    if (first) chosen.push(first);
  }
  if (chosen.length < requestedSlots) {
    const remaining = rankedDays
      .flatMap(([day, stats]) =>
        stats.candidates.map((candidate) => ({ day, candidate, busyMs: stats.busyMs })),
      )
      .sort((a, b) => a.busyMs - b.busyMs || a.candidate.start - b.candidate.start);
    for (const item of remaining) {
      if (chosen.length >= requestedSlots) break;
      if (chosen.some((selected) => overlap(selected, item.candidate))) continue;
      chosen.push(item.candidate);
    }
  }
  chosen.sort((a, b) => a.start - b.start);

  const conflictPairs: string[] = [];
  const confirmedConflictPairs: string[] = [];
  const possibleOverlapPairs: string[] = [];
  const potentialAttendanceEvents: string[] = [];
  const conflictEvents = uniqueEvents
    .filter((event) => attendance(event) !== 'not-attending' && event.allDay !== true)
    .map((event) => ({ event, interval: parseEventInterval(event), presence: attendance(event) }))
    .filter(
      (
        item,
      ): item is {
        event: PlainRecord;
        interval: { start: number; end: number };
        presence: 'attending' | 'potential';
      } =>
        Boolean(item.interval) &&
        !isExtendedLodging(item.event, item.interval as { start: number; end: number }),
    );
  for (let i = 0; i < conflictEvents.length; i += 1) {
    for (let j = i + 1; j < conflictEvents.length; j += 1) {
      const left = conflictEvents[i];
      const right = conflictEvents[j];
      if (
        !left ||
        !right ||
        eventIdentity(left.event) === eventIdentity(right.event) ||
        !overlap(left.interval, right.interval)
      )
        continue;
      const verified = left.presence === 'attending' && right.presence === 'attending';
      const uncertainLongContext =
        (isExtendedContext(left.interval) && !isExtendedLodging(left.event, left.interval)) ||
        (isExtendedContext(right.interval) && !isExtendedLodging(right.event, right.interval));
      const pair = `${eventTitle(left.event)} and ${eventTitle(right.event)}`;
      if (verified && !uncertainLongContext) confirmedConflictPairs.push(pair);
      else {
        possibleOverlapPairs.push(pair);
        if (left.presence === 'potential') potentialAttendanceEvents.push(eventTitle(left.event));
        if (right.presence === 'potential') potentialAttendanceEvents.push(eventTitle(right.event));
      }
      conflictPairs.push(
        `${verified && !uncertainLongContext ? 'Scheduling conflict' : 'Possible overlap'}: ${pair} (${labelTime(Math.max(left.interval.start, right.interval.start), input.timeZone)}).`,
      );
    }
  }

  const overloads = [...dayStats.entries()]
    .filter(([, stats]) => stats.busyMs >= 6 * 60 * 60_000)
    .map(
      ([day]) =>
        `Overloaded-day estimate: ${labelDay(day)} has at least 6 merged busy hours inside 9–5. This is a planning heuristic.`,
    );
  const attendanceTargets = [...new Set(potentialAttendanceEvents)].slice(0, 3);
  const attendanceCheck = attendanceTargets.length
    ? attendanceTargets.join(', ')
    : `whether both overlapping items are commitments (${possibleOverlapPairs.slice(0, 3).join('; ')})`;
  const lines = [
    `Here’s a review-only plan for ${windowLabel} in ${input.timeZone}. I haven’t changed your calendar.`,
  ];
  const conditionalStayNames = [...new Set(chosen.flatMap((slot) => slot.lodgingConditions))];
  if (conditionalStayNames.length > 0) {
    const conditionalStayNameSet = new Set(conditionalStayNames);
    const stayDetails = [
      ...new Map(
        [...explainedLodgingBusy.values()].flatMap((event) => {
          const interval = parseEventInterval(event);
          const title = eventTitle(event);
          return interval
            ? conditionalStayNameSet.has(title)
              ? [
                  [
                    title,
                    `${title} (${labelTime(interval.start, timeZone)}–${labelTime(interval.end, timeZone)})`,
                  ] as const,
                ]
              : []
            : [];
        }),
      ).values(),
    ];
    lines.push(
      `The availability feed still marks time busy across this window because it overlaps ${stayDetails.join(', ') || conditionalStayNames.join(', ')}. Candidates marked conditional assume this stay is lodging context rather than an all-day work hold; the provider still reports busy, so those times are not confirmed free.`,
    );
  }
  if (!complete) {
    lines.push(
      'Coverage is incomplete, so any times below are tentative and not confirmed free. Confirm the missing calendars before relying on this review.',
    );
    if (unavailableCalendars.length > 0)
      lines.push(
        `Unavailable calendar coverage: ${[...new Set(unavailableCalendars)].join(', ')}.`,
      );
    else if (!availabilityComplete) lines.push('Free/busy coverage could not be fully verified.');
    else lines.push('The event list is incomplete or reached its bounded page limit.');
  }
  lines.push(
    `Working hours are assumed to be 9 AM–5 PM because no configured hours were available. Each focus block is followed by a ${breakMs / 60_000}-minute break.`,
  );
  if (input.plan?.meetingBufferMinutes)
    lines.push(
      `I reserved ${input.plan.meetingBufferMinutes}-minute breaks on both sides of meetings.`,
    );
  if (travelBufferCount > 0)
    lines.push(
      'I reserved an estimated 30-minute travel buffer on each side of events with a physical location and no video link; this is not a route estimate.',
    );
  if (potentialTravelBufferCount > 0)
    lines.push(
      'I included those location-based buffers conservatively where shared-calendar attendance is unconfirmed. Confirm attendance and actual travel time before relying on the plan.',
    );
  if (conflictPairs.length > 0) lines.push(...conflictPairs.slice(0, 5));
  if (conflictPairs.some((line) => line.startsWith('Scheduling conflict:')))
    lines.push(
      `Recommended change: choose which accepted event to reschedule after checking priorities (${confirmedConflictPairs.slice(0, 3).join('; ')}).`,
    );
  if (conflictPairs.some((line) => line.startsWith('Possible overlap:')))
    lines.push(
      `Recommended next step: confirm attendance for ${attendanceCheck}. If both events are required in an overlap, choose one to reschedule; leave the calendar unchanged until attendance is clear.`,
    );
  if (conflictPairs.length === 0 && complete)
    lines.push('I found no overlapping attended events in the checked calendar data.');
  if (overloads.length > 0) lines.push(...overloads.slice(0, 5));
  else if (!busyValid) lines.push('I could not assess overloaded days from usable free/busy data.');
  else
    lines.push(
      `Overloaded-day assessment: No checked working day reaches the 6-hour busy-time threshold inside the assumed 9–5 day.${complete ? ' This is a planning heuristic.' : ' This applies only to the checked data; missing coverage could change this assessment.'}`,
    );
  if (overloads.length > 0)
    lines.push(
      'Recommended change: consider moving flexible work from an overloaded day to a lighter day after checking your priorities.',
    );
  if (chosen.length === 0) {
    lines.push(
      busyValid
        ? `I couldn’t identify suitable ${focusMs / 60_000}-minute blocks from the available data. Please confirm coverage or working hours before I suggest more.`
        : 'I did not suggest focus times because usable free/busy intervals were unavailable. Please confirm coverage before choosing a time.',
    );
  } else {
    lines.push(
      conditionalStayNames.length > 0 || !complete
        ? 'Focus candidates for review (not availability-cleared):'
        : 'Tentative focus blocks:',
    );
    for (const slot of chosen) {
      const focusEnd = slot.start + focusMs;
      lines.push(
        `- ${labelTime(slot.start, input.timeZone)}–${new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(focusEnd))} (${focusMs / 60_000} minutes), then a ${breakMs / 60_000}-minute break.${slot.lodgingConditions.length > 0 ? ` Conditional on treating ${slot.lodgingConditions.join(', ')} as lodging context; free/busy still reports busy.` : ''}`,
      );
    }
  }
  if (chosen.length < requestedSlots)
    lines.push(
      `I found ${chosen.length} of ${requestedSlots} requested focus blocks; the remaining time did not fit without overlapping checked commitments and breaks.`,
    );
  const sourceLinks = uniqueEvents
    .map(strictGoogleCalendarLink)
    .filter((value): value is string => Boolean(value));
  if (sourceLinks.length > 0)
    lines.push(
      `Calendar sources: ${[...new Set(sourceLinks)]
        .slice(0, 5)
        .map((url, index) => `[Event ${index + 1}](<${url}>)`)
        .join(' · ')}`,
    );
  return result(lines.join('\n'), complete, chosen.length);
}

export function weeklyCalendarPlan(input: WeeklyCalendarPlanInput): string {
  return weeklyCalendarPlanResult(input).text;
}
