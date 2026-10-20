import { z } from 'zod';
import type { ToolExecutionRepository } from './dispatch.js';

const instant = z.string().datetime({ offset: true });
const eventTime = z.union([instant, z.string().date()]);
export const phoneCalendarSnapshotSchema = z
  .object({
    timeMin: instant,
    timeMax: instant,
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }),
    calendars: z
      .array(z.object({ id: z.string().min(1).max(200), name: z.string().max(300) }).strict())
      .max(100),
    events: z
      .array(
        z
          .object({
            eventId: z.string().min(1).max(1024),
            calendarId: z.string().min(1).max(200),
            iCalUID: z.string().max(1024).optional(),
            originalStartTime: eventTime.optional(),
            summary: z.string().max(500),
            location: z.string().max(2000),
            start: eventTime,
            end: eventTime,
            allDay: z.boolean(),
            blocksTime: z.boolean(),
            ownerResponse: z.enum(['accepted', 'declined', 'tentative', 'needsAction']).optional(),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const ids = new Set(snapshot.calendars.map((calendar) => calendar.id));
    if (
      ids.size !== snapshot.calendars.length ||
      Date.parse(snapshot.timeMax) <= Date.parse(snapshot.timeMin)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid calendar roster or window' });
    for (const event of snapshot.events) {
      if (
        !ids.has(event.calendarId) ||
        Date.parse(event.end) <= Date.parse(event.start) ||
        event.allDay !== /^\d{4}-\d{2}-\d{2}$/.test(event.start) ||
        event.allDay !== /^\d{4}-\d{2}-\d{2}$/.test(event.end)
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid calendar event' });
    }
  });
export type PhoneCalendarSnapshotInput = z.infer<typeof phoneCalendarSnapshotSchema>;
export type PhoneCalendarSnapshot = PhoneCalendarSnapshotInput & { syncedAt: string };
export type PhoneCalendarCache = Pick<ToolExecutionRepository, 'cacheGet' | 'cachePut'>;
const key = (agentId: string) => `phone-calendars:v1:${agentId}`;

/** Transient device snapshot, on the same portable expiring store as provider reads. */
export async function savePhoneCalendars(
  cache: PhoneCalendarCache,
  agentId: string,
  input: unknown,
  now = new Date(),
) {
  const snapshot =
    input === null
      ? null
      : { ...phoneCalendarSnapshotSchema.parse(input), syncedAt: now.toISOString() };
  await cache.cachePut({
    cacheKey: key(agentId),
    toolName: 'phone-calendars.snapshot',
    result: snapshot ?? { disconnected: true },
    expiresAt: new Date(now.getTime() + (snapshot ? 7 * 86400_000 : 0)),
  });
}

export async function readPhoneCalendars(
  cache: PhoneCalendarCache,
  agentId: string,
): Promise<PhoneCalendarSnapshot | null> {
  const cached = await cache.cacheGet(key(agentId));
  if (!cached?.result) return null;
  // The input schema is strict; validate the server-owned timestamp separately.
  const value = cached.result as Record<string, unknown>;
  const { syncedAt, ...input } = value;
  const snapshot = phoneCalendarSnapshotSchema.safeParse(input);
  return snapshot.success && typeof syncedAt === 'string' && Number.isFinite(Date.parse(syncedAt))
    ? { ...snapshot.data, syncedAt }
    : null;
}

export function phoneCalendarCoverage(
  snapshot: PhoneCalendarSnapshot,
  timeMin?: string,
  timeMax?: string,
  now = new Date(),
) {
  const fresh = now.getTime() - Date.parse(snapshot.syncedAt) <= 30 * 60_000;
  const covered = Boolean(
    timeMin &&
      timeMax &&
      Date.parse(timeMin) >= Date.parse(snapshot.timeMin) &&
      Date.parse(timeMax) <= Date.parse(snapshot.timeMax),
  );
  return {
    complete: fresh && covered,
    syncedAt: snapshot.syncedAt,
    timeMin: snapshot.timeMin,
    timeMax: snapshot.timeMax,
    ...(!fresh || !covered
      ? {
          note: 'iPhone calendar coverage is incomplete. Open Assistant on the iPhone to refresh; only the uploaded date window is available.',
        }
      : {}),
  };
}
