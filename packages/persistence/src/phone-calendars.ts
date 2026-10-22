import { z } from 'zod';
import type { ToolExecutionRepository } from './dispatch.js';
import { unavailableSharedPhoneCalendars } from './phone-calendar-compatibility.js';
import type {
  PhoneCalendarSharingRepository,
  PhoneCalendarSharingState,
} from './phone-calendar-sharing.js';

const instant = z.string().datetime({ offset: true });
export const phoneCalendarTimeZoneSchema = z
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
    timeZone: phoneCalendarTimeZoneSchema,
    calendars: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            name: z.string().max(300),
            purpose: z.enum(['unspecified', 'commitments', 'reference']).optional(),
            timeZone: phoneCalendarTimeZoneSchema.optional(),
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
            calendarTimeZone: phoneCalendarTimeZoneSchema.optional(),
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
export type PhoneCalendarCache = Pick<
  ToolExecutionRepository,
  'cacheGet' | 'cachePut' | 'phoneCalendarCompatibility'
> & { phoneCalendarSharing?: PhoneCalendarSharingRepository };
const key = (agentId: string) => `phone-calendars:v1:${agentId}`;

/** Transient device snapshot, on the same portable expiring store as provider reads. */
export async function savePhoneCalendars(
  cache: PhoneCalendarCache,
  agentId: string,
  input: unknown,
  now = new Date(),
) {
  // The bridge is read-only even before table 129 exists. Do not probe then
  // write: consent could change between those operations. B writes atomically.
  if (cache.phoneCalendarCompatibility || cache.phoneCalendarSharing)
    throw new Error('Legacy calendar writes are disabled by the schema compatibility bridge');
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
  const unavailableSnapshot = (
    sharing: PhoneCalendarSharingState | null,
  ): PhoneCalendarSnapshot | null =>
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
  const sharingRepository = cache.phoneCalendarSharing;
  if (sharingRepository) {
    // A production sharing port without an atomic read capability is not
    // allowed to fall back to an independently read cache row.
    if (!sharingRepository.readSnapshot) return null;
    const { state, snapshot } = await sharingRepository.readSnapshot(agentId, now);
    if (!state?.enabled || !state.calendars.length) return null;
    return snapshot ?? unavailableSnapshot(state);
  }

  // Legacy cache rows remain readable only when no consent repository exists.
  const compatibility = await cache.phoneCalendarCompatibility?.read(agentId);
  if (compatibility?.schema === 'sharing')
    return unavailableSharedPhoneCalendars(compatibility.state);
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

function formatCoverageTime(value: string, timeZone: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    // The ISO value still carries its known offset when a historical or
    // malformed zone identifier cannot be formatted.
    return date.toISOString();
  }
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
  const capturedAt = snapshot.capturedAt
    ? formatCoverageTime(snapshot.capturedAt, snapshot.timeZone)
    : null;
  // readPhoneCalendars uses the epoch only as an internal marker for an
  // enabled source that has never uploaded; it is not a recorded share time.
  const receivedAt =
    Date.parse(snapshot.syncedAt) === 0
      ? null
      : formatCoverageTime(snapshot.syncedAt, snapshot.timeZone);
  const knownTimes = [
    capturedAt ? `Captured on the sharing iPhone: ${capturedAt}.` : null,
    receivedAt ? `Last shared with Assistant: ${receivedAt}.` : null,
  ].filter((value): value is string => value !== null);
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
          note: [
            'iPhone calendar coverage is incomplete.',
            ...knownTimes,
            'Phone calendars may have changed since the last shared snapshot. On the iPhone where you enabled calendar sharing for this Assistant account, open iPhone calendars and choose Sync now. That phone can refresh the family calendars it shares. Missing coverage does not show a free or empty calendar.',
          ].join(' '),
        }
      : {}),
  };
}
