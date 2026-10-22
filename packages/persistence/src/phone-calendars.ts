import { z } from 'zod';
import type { ToolExecutionRepository } from './dispatch.js';
import type { PhoneCalendarSharingRepository } from './phone-calendar-sharing.js';

const instant = z.string().datetime({ offset: true });
const timeZone = z
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
  });
const eventTime = z.union([instant, z.string().date()]);
export const phoneCalendarSnapshotSchema = z
  .object({
    timeMin: instant,
    timeMax: instant,
    capturedAt: instant.optional(),
    selectionRevision: z.number().int().nonnegative().optional(),
    complete: z.boolean().optional(),
    truncated: z.boolean().optional(),
    sourceAvailability: z
      .array(
        z
          .object({
            calendarId: z.string().min(1).max(200),
            status: z.enum(['available', 'missing', 'permission-denied']),
            complete: z.boolean(),
            reason: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    timeZone,
    calendars: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            name: z.string().max(300),
            purpose: z.enum(['unspecified', 'commitments', 'reference']).optional(),
            timeZone: timeZone.optional(),
          })
          .strict(),
      )
      .max(100),
    events: z
      .array(
        z
          .object({
            eventId: z.string().min(1).max(1024),
            calendarId: z.string().min(1).max(200),
            providerExternalIdentifier: z.string().max(1024).optional(),
            status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
            calendarTimeZone: timeZone.optional(),
            ownerParticipant: z
              .object({
                email: z.string().email().max(320),
                responseStatus: z.enum(['accepted', 'declined', 'tentative', 'needsAction']),
              })
              .strict()
              .optional(),
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
export type PhoneCalendarCache = Pick<ToolExecutionRepository, 'cacheGet' | 'cachePut'> & {
  phoneCalendarSharing?: PhoneCalendarSharingRepository;
};
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
  now = new Date(),
): Promise<PhoneCalendarSnapshot | null> {
  const sharing = await cache.phoneCalendarSharing?.get(agentId);
  // Legacy cache rows do not establish consent to the new sharing protocol.
  if (cache.phoneCalendarSharing && (!sharing?.enabled || !sharing.calendars.length)) return null;
  const cached = await cache.cacheGet(key(agentId));
  const unavailableSnapshot = (): PhoneCalendarSnapshot | null =>
    sharing
      ? {
          calendars: sharing.calendars,
          events: [],
          timeMin: sharing.timeMin ?? now.toISOString(),
          timeMax: sharing.timeMax ?? new Date(now.getTime() + 1000).toISOString(),
          timeZone: sharing.calendars.find((calendar) => calendar.timeZone)?.timeZone ?? 'UTC',
          selectionRevision: sharing.generation,
          capturedAt: sharing.capturedAt,
          syncedAt: sharing.receivedAt ?? new Date(0).toISOString(),
          complete: false,
          truncated: false,
          sourceAvailability: sharing.calendars.map((calendar) => ({
            calendarId: calendar.id,
            status: 'missing',
            complete: false,
            reason: sharing.receivedAt
              ? 'The shared calendar snapshot expired or no longer matches the selected calendars.'
              : 'No shared calendar snapshot has been received yet.',
          })),
        }
      : null;
  if (!cached?.result) return unavailableSnapshot();
  // The input schema is strict; validate the server-owned timestamp separately.
  const value = cached.result as Record<string, unknown>;
  const { syncedAt, ...input } = value;
  const snapshot = phoneCalendarSnapshotSchema.safeParse(input);
  return snapshot.success &&
    typeof syncedAt === 'string' &&
    Number.isFinite(Date.parse(syncedAt)) &&
    (!sharing || snapshot.data.selectionRevision === sharing.generation)
    ? { ...snapshot.data, syncedAt }
    : unavailableSnapshot();
}

export function phoneCalendarCoverage(
  snapshot: PhoneCalendarSnapshot,
  timeMin?: string,
  timeMax?: string,
  now = new Date(),
  calendarIds?: string[],
) {
  const received = Date.parse(snapshot.syncedAt);
  const captured = snapshot.capturedAt ? Date.parse(snapshot.capturedAt) : received;
  const effective = Math.min(received, captured);
  const fresh =
    Number.isFinite(effective) &&
    effective <= now.getTime() + 5 * 60_000 &&
    now.getTime() - effective <= 30 * 60_000;
  const wanted = new Set(
    calendarIds?.map((id) => id.replace(/^iphone:/, '')) ??
      snapshot.calendars.map((calendar) => calendar.id),
  );
  const sources = snapshot.sourceAvailability?.filter((source) => wanted.has(source.calendarId));
  const narrowed = calendarIds !== undefined && wanted.size < snapshot.calendars.length;
  const sourceComplete = sources
    ? sources.length === wanted.size &&
      sources.every((source) => source.status === 'available' && source.complete) &&
      (snapshot.complete !== false || narrowed)
    : snapshot.complete !== false;
  const complete = fresh && sourceComplete && !snapshot.truncated;
  const covered = Boolean(
    timeMin &&
      timeMax &&
      Date.parse(timeMin) >= Date.parse(snapshot.timeMin) &&
      Date.parse(timeMax) <= Date.parse(snapshot.timeMax),
  );
  return {
    complete: complete && covered,
    ...(snapshot.capturedAt ? { capturedAt: snapshot.capturedAt } : {}),
    receivedAt: snapshot.syncedAt,
    ...(sources ? { sources } : {}),
    ...(snapshot.truncated ? { truncated: true } : {}),
    syncedAt: snapshot.syncedAt,
    timeMin: snapshot.timeMin,
    timeMax: snapshot.timeMax,
    ...(!complete || !covered
      ? {
          note: 'Shared iPhone calendar coverage is incomplete. Open Assistant on the sharing iPhone and refresh. Only the last sent date window and available selected calendars can be checked; missing coverage does not establish a free or empty calendar.',
        }
      : {}),
  };
}
