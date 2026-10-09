import type { PulseCalendarSnapshot } from '@assistant/persistence';
import type { BriefingCalendarEvent, CalendarEventReader } from '../workflow/briefing.js';

const MAX_POINT_READS = 50;
const READ_DEADLINE_MS = 10_000;

/** A successful bounded window cannot certify what happened to an absent event. */
export async function resolveCalendarWindow(
  events: readonly BriefingCalendarEvent[],
  previous: readonly PulseCalendarSnapshot[],
  now: Date,
  reader?: CalendarEventReader,
): Promise<BriefingCalendarEvent[]> {
  const observed = [...events];
  if (!reader) return observed;
  const key = (row: { calendarId?: string; eventId?: string }) =>
    JSON.stringify([row.calendarId, row.eventId]);
  const present = new Set(events.map(key));
  const missing = previous
    .filter(
      (row) =>
        row.status !== 'cancelled' &&
        Date.parse(row.start) >= now.getTime() &&
        !present.has(key(row)),
    )
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || key(a).localeCompare(key(b)))
    .slice(0, MAX_POINT_READS);
  if (!missing.length) return observed;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, READ_DEADLINE_MS);
  });
  let position = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(4, missing.length) }, async () => {
        while (position < missing.length && !controller.signal.aborted) {
          const row = missing[position++];
          if (!row) return;
          const event = await Promise.race([
            reader({
              calendarId: row.calendarId,
              eventId: row.eventId,
              signal: controller.signal,
            }).catch(() => null),
            deadline,
          ]);
          if (
            event?.calendarId === row.calendarId &&
            event.eventId === row.eventId &&
            (event.status === 'cancelled' ||
              (Number.isFinite(Date.parse(event.start)) && Number.isFinite(Date.parse(event.end))))
          )
            observed.push(event);
        }
      }),
    );
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
  return observed;
}
