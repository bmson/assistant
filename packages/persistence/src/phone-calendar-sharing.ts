import { z } from 'zod';
import { type PhoneCalendarSnapshotInput, phoneCalendarSnapshotSchema } from './phone-calendars.js';

export type PhoneCalendarPurpose = 'unspecified' | 'commitments' | 'reference';
export interface SharedPhoneCalendar {
  id: string;
  name: string;
  purpose: PhoneCalendarPurpose;
  timeZone?: string;
}

/** One active publisher per owner. Retained independently of expiring event data. */
export interface PhoneCalendarSharingState {
  version: 1;
  ownerId: string;
  publisherId: string | null;
  generation: number;
  enabled: boolean;
  consentVersion: number;
  calendars: SharedPhoneCalendar[];
  updatedAt: string;
  mutationId?: string;
  capturedAt?: string;
  receivedAt?: string;
  timeMin?: string;
  timeMax?: string;
  complete?: boolean;
  truncated?: boolean;
}

const phoneCalendarPurposeSchema = z.enum(['unspecified', 'commitments', 'reference']);
const sharedPhoneCalendarSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().max(300),
    purpose: phoneCalendarPurposeSchema,
    timeZone: z.string().min(1).max(100).optional(),
  })
  .strict();
const stateInstant = z.string().datetime({ offset: true });

/** Frozen persisted v1 contract for consent state; unknown fields fail closed. */
export const phoneCalendarSharingStateSchema = z
  .object({
    version: z.literal(1),
    ownerId: z.string().min(1).max(200),
    publisherId: z.string().min(1).max(100).nullable(),
    generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    enabled: z.boolean(),
    consentVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    calendars: z.array(sharedPhoneCalendarSchema).max(100),
    updatedAt: stateInstant,
    mutationId: z.string().min(1).max(100).optional(),
    capturedAt: stateInstant.optional(),
    receivedAt: stateInstant.optional(),
    timeMin: stateInstant.optional(),
    timeMax: stateInstant.optional(),
    complete: z.boolean().optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

export function parsePhoneCalendarSharingState(
  value: unknown,
  ownerId?: string,
): PhoneCalendarSharingState | null {
  const parsed = phoneCalendarSharingStateSchema.safeParse(value);
  return parsed.success && (ownerId === undefined || parsed.data.ownerId === ownerId)
    ? parsed.data
    : null;
}

/** Retain a scrubbed consent generation so delayed pre-erasure writes stay stale. */
export function phoneCalendarSharingErasureTombstone(
  ownerId: string,
  current: unknown,
  now: Date,
): PhoneCalendarSharingState {
  const value = current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
  const generation =
    value.ownerId === ownerId &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) >= 0
      ? (value.generation as number)
      : 0;
  const expectedKeys = [
    'calendars',
    'consentVersion',
    'enabled',
    'generation',
    'ownerId',
    'publisherId',
    'updatedAt',
    'version',
  ];
  if (
    value.ownerId === ownerId &&
    value.version === 1 &&
    value.publisherId === null &&
    value.enabled === false &&
    value.consentVersion === 0 &&
    Array.isArray(value.calendars) &&
    value.calendars.length === 0 &&
    typeof value.updatedAt === 'string' &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) >= 1 &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  )
    return value as unknown as PhoneCalendarSharingState;
  if (generation >= Number.MAX_SAFE_INTEGER)
    throw new Error('Phone calendar sharing generation is exhausted');
  return {
    version: 1,
    ownerId,
    publisherId: null,
    generation: generation + 1,
    enabled: false,
    consentVersion: 0,
    calendars: [],
    updatedAt: now.toISOString(),
  };
}

export type PhoneCalendarSharingCommand =
  | {
      command: 'enable' | 'replace' | 'select';
      publisherId: string;
      expectedGeneration: number;
      mutationId: string;
      consentVersion: 1;
      calendars: SharedPhoneCalendar[];
    }
  | {
      command: 'revoke';
      publisherId: string;
      expectedGeneration: number;
      cancelPendingMutationId?: string;
    }
  | {
      command: 'snapshot';
      publisherId: string;
      expectedGeneration: number;
      snapshot: PhoneCalendarSnapshotInput;
    };

export interface PhoneCalendarSharingResult {
  ok: boolean;
  state: PhoneCalendarSharingState;
  error?: 'publisher_conflict' | 'stale_generation' | 'sharing_disabled' | 'invalid_snapshot';
}

/** Implementations serialize state and event-cache mutation in one transaction. */
export interface PhoneCalendarSharingRepository {
  get(ownerId: string): Promise<PhoneCalendarSharingState | null>;
  apply(
    ownerId: string,
    command: PhoneCalendarSharingCommand,
    now?: Date,
  ): Promise<PhoneCalendarSharingResult>;
}

export const phoneCalendarCacheKey = (ownerId: string) => `phone-calendars:v1:${ownerId}`;

function civilParts(timeZone: string, instant: Date) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
}
function civilMidnight(date: string, timeZone: string): number {
  const target = Date.parse(`${date}T00:00:00Z`);
  let guess = target;
  for (let i = 0; i < 5; i++) {
    const value = civilParts(timeZone, new Date(guess));
    const rendered = Date.UTC(
      value.year ?? 0,
      (value.month ?? 1) - 1,
      value.day ?? 1,
      value.hour ?? 0,
      value.minute ?? 0,
      value.second ?? 0,
    );
    const correction = target - rendered;
    if (!correction) break;
    guess += correction;
  }
  return guess;
}
/** Civil-day bounds, including today; date arithmetic must not assume 24-hour days. */
export function phoneCalendarSharingWindow(timeZone: string, now = new Date()) {
  const today = civilParts(timeZone, now);
  const day = (offset: number) => {
    const date = new Date(
      Date.UTC(today.year ?? 0, (today.month ?? 1) - 1, (today.day ?? 1) + offset),
    )
      .toISOString()
      .slice(0, 10);
    return new Date(civilMidnight(date, timeZone)).toISOString();
  };
  return { timeMin: day(-7), timeMax: day(46) };
}

export function phoneCalendarCacheRecord(
  ownerId: string,
  snapshot: PhoneCalendarSnapshotInput | null,
  now: Date,
) {
  return {
    cacheKey: phoneCalendarCacheKey(ownerId),
    toolName: 'phone-calendars.snapshot',
    result: snapshot ? { ...snapshot, syncedAt: now.toISOString() } : { disconnected: true },
    expiresAt: new Date(now.getTime() + (snapshot ? 7 * 86_400_000 : 0)),
  };
}

export function transitionPhoneCalendarSharing(
  ownerId: string,
  current: PhoneCalendarSharingState | null,
  command: PhoneCalendarSharingCommand,
  now = new Date(),
): { result: PhoneCalendarSharingResult; snapshot?: PhoneCalendarSnapshotInput | null } {
  const state: PhoneCalendarSharingState = current ?? {
    version: 1,
    ownerId,
    publisherId: null,
    generation: 0,
    enabled: false,
    consentVersion: 0,
    calendars: [],
    updatedAt: now.toISOString(),
  };
  const reject = (error: NonNullable<PhoneCalendarSharingResult['error']>) => ({
    result: { ok: false, state, error },
  });
  if (
    state.ownerId !== ownerId ||
    !command.publisherId ||
    command.publisherId.length > 100 ||
    !Number.isSafeInteger(command.expectedGeneration) ||
    command.expectedGeneration < 0
  )
    return reject('stale_generation');
  const samePublisher = state.publisherId === command.publisherId;
  if (command.command === 'revoke') {
    if (state.publisherId && !samePublisher) return reject('publisher_conflict');
    if (!state.enabled && samePublisher && command.expectedGeneration <= state.generation)
      return { result: { ok: true, state }, snapshot: null };
    const cancelledPending =
      command.cancelPendingMutationId &&
      state.generation === command.expectedGeneration + 1 &&
      state.mutationId === command.cancelPendingMutationId;
    if (state.generation !== command.expectedGeneration && !cancelledPending)
      return reject('stale_generation');
    return {
      result: {
        ok: true,
        state: {
          ...state,
          publisherId: command.publisherId,
          generation: state.generation + 1,
          enabled: false,
          calendars: [],
          updatedAt: now.toISOString(),
          mutationId: undefined,
          capturedAt: undefined,
          receivedAt: undefined,
          timeMin: undefined,
          timeMax: undefined,
          complete: undefined,
          truncated: undefined,
        },
      },
      snapshot: null,
    };
  }
  if (command.command === 'snapshot') {
    if (!samePublisher) return reject('publisher_conflict');
    if (state.generation !== command.expectedGeneration) return reject('stale_generation');
    if (!state.enabled) return reject('sharing_disabled');
    const parsed = phoneCalendarSnapshotSchema.safeParse(command.snapshot);
    if (!parsed.success) return reject('invalid_snapshot');
    const input = parsed.data;
    const allowedWindow = phoneCalendarSharingWindow(input.timeZone, now);
    const capture = Date.parse(input.capturedAt ?? '');
    const roster = new Map(state.calendars.map((calendar) => [calendar.id, calendar]));
    const statuses = new Map(
      input.sourceAvailability?.map((source) => [source.calendarId, source]),
    );
    let invalidEventWindow = false;
    try {
      invalidEventWindow = input.events.some((event) => {
        const zone =
          event.calendarTimeZone ?? roster.get(event.calendarId)?.timeZone ?? input.timeZone;
        const start = event.allDay ? civilMidnight(event.start, zone) : Date.parse(event.start);
        const end = event.allDay ? civilMidnight(event.end, zone) : Date.parse(event.end);
        return (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          end <= Date.parse(input.timeMin) ||
          start >= Date.parse(input.timeMax)
        );
      });
    } catch {
      invalidEventWindow = true;
    }

    if (
      invalidEventWindow ||
      !Number.isFinite(capture) ||
      capture > now.getTime() + 5 * 60_000 ||
      capture < now.getTime() - 7 * 86_400_000 ||
      (state.capturedAt && capture < Date.parse(state.capturedAt)) ||
      input.selectionRevision !== state.generation ||
      typeof input.complete !== 'boolean' ||
      typeof input.truncated !== 'boolean' ||
      input.calendars.length !== roster.size ||
      statuses.size !== roster.size ||
      input.calendars.some((calendar) => {
        const selected = roster.get(calendar.id);
        return (
          !selected ||
          selected.name !== calendar.name ||
          selected.purpose !== (calendar.purpose ?? 'unspecified')
        );
      }) ||
      [...roster.keys()].some((id) => !statuses.has(id)) ||
      input.events.some((event) => statuses.get(event.calendarId)?.status !== 'available') ||
      (input.complete &&
        (input.truncated ||
          [...statuses.values()].some(
            (source) => !source.complete || source.status !== 'available',
          ))) ||
      Date.parse(input.timeMin) < Date.parse(allowedWindow.timeMin) ||
      Date.parse(input.timeMax) > Date.parse(allowedWindow.timeMax)
    )
      return reject('invalid_snapshot');
    const next = {
      ...state,
      capturedAt: input.capturedAt,
      receivedAt: now.toISOString(),
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      complete: input.complete,
      truncated: input.truncated,
      updatedAt: now.toISOString(),
    };
    if (
      Buffer.byteLength(
        JSON.stringify({
          stateRecord: { id: ownerId, agentId: ownerId, state: next, updatedAt: now.toISOString() },
          cacheRecord: phoneCalendarCacheRecord(ownerId, input, now),
        }),
      ) > 800_000
    )
      return reject('invalid_snapshot');
    return { result: { ok: true, state: next }, snapshot: input };
  }
  if (state.enabled && !samePublisher && command.command !== 'replace')
    return reject('publisher_conflict');
  if (state.generation !== command.expectedGeneration) return reject('stale_generation');
  if (command.command === 'select' && (!state.enabled || !samePublisher))
    return reject('sharing_disabled');
  if (
    command.consentVersion !== 1 ||
    !command.mutationId ||
    command.mutationId.length > 100 ||
    command.calendars.length > 100 ||
    new Set(command.calendars.map((calendar) => calendar.id)).size !== command.calendars.length ||
    command.calendars.some(
      (calendar) =>
        !calendar.id ||
        calendar.id.length > 200 ||
        calendar.name.length > 300 ||
        !['unspecified', 'commitments', 'reference'].includes(calendar.purpose),
    )
  )
    return reject('invalid_snapshot');
  const next: PhoneCalendarSharingState = {
    version: 1,
    ownerId,
    publisherId: command.publisherId,
    generation: state.generation + 1,
    enabled: true,
    consentVersion: 1,
    calendars: command.calendars,
    mutationId: command.mutationId,
    updatedAt: now.toISOString(),
  };
  if (Buffer.byteLength(JSON.stringify(next)) > 800_000) return reject('invalid_snapshot');
  return { result: { ok: true, state: next }, snapshot: null };
}
