import {
  createPostgresLocationPingRepository,
  createPostgresTaskRepository,
  type Db,
} from '@assistant/db';
import type { LocationPingRepository, TaskRepository } from '@assistant/persistence';
import { InboundEventSchema } from '../events.js';
import { enqueueTask } from '../workflow/machine.js';

/** Arrival detection uses location only for the transient decision, never in task text. */
const ARRIVAL_DISTANCE_KM = 1.5;
const ARRIVAL_WINDOW_HOURS = 36;
const ARRIVAL_COOLDOWN_HOURS = 12;
const ARRIVAL_MAX_ACCURACY_M = 200;
const ARRIVAL_DWELL_MS = 3 * 60_000;
const ARRIVAL_CONFIRMATION_WINDOW_MS = 30 * 60_000;
const ARRIVAL_STATIONARY_RADIUS_KM = 0.2;
export const ARRIVAL_OBSERVATION_TTL_MS = 5 * 60_000;

export interface ArrivalPing {
  /** Opaque owner-scoped location-ping id, valid for at most five minutes. */
  observationId: string;
  lat: number;
  lng: number;
  accuracyM?: number | null;
  capturedAt: Date;
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function accurate(ping: ArrivalPing): boolean {
  return (
    Number.isFinite(ping.lat) &&
    Math.abs(ping.lat) <= 90 &&
    Number.isFinite(ping.lng) &&
    Math.abs(ping.lng) <= 180 &&
    ping.accuracyM != null &&
    Number.isFinite(ping.accuracyM) &&
    ping.accuracyM >= 0 &&
    ping.accuracyM <= ARRIVAL_MAX_ACCURACY_M
  );
}

/** Two separated observations suggest a stop; a single drive-by never does. */
export function hasConfirmedArrival(ping: ArrivalPing, earlier: ArrivalPing[], now: Date): boolean {
  const age = now.getTime() - ping.capturedAt.getTime();
  if (!accurate(ping) || !Number.isFinite(age) || age < -5_000 || age > ARRIVAL_OBSERVATION_TTL_MS)
    return false;
  const history = earlier
    .filter((row) => row.capturedAt < ping.capturedAt)
    .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
  let dwellStart = ping.capturedAt.getTime();
  let index = 0;
  for (; index < history.length; index++) {
    const row = history[index];
    if (
      !row ||
      !accurate(row) ||
      ping.capturedAt.getTime() - row.capturedAt.getTime() > ARRIVAL_CONFIRMATION_WINDOW_MS ||
      haversineKm(ping.lat, ping.lng, row.lat, row.lng) > ARRIVAL_STATIONARY_RADIUS_KM
    )
      break;
    dwellStart = row.capturedAt.getTime();
  }
  if (ping.capturedAt.getTime() - dwellStart < ARRIVAL_DWELL_MS) return false;
  const baseline = history.slice(index).filter(accurate);
  return (
    baseline.length > 0 &&
    baseline.every((row) => haversineKm(ping.lat, ping.lng, row.lat, row.lng) > ARRIVAL_DISTANCE_KM)
  );
}

function localDay(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function maybeEnqueueArrivalNudge(
  db: Db,
  agent: { id: string; timezone: string },
  ping: ArrivalPing,
  now = new Date(),
): Promise<boolean> {
  return maybeEnqueueArrivalNudgeWithRepository(
    createPostgresLocationPingRepository(db),
    createPostgresTaskRepository(db),
    agent,
    ping,
    now,
  );
}

export async function maybeEnqueueArrivalNudgeWithRepository(
  locations: LocationPingRepository,
  tasks: Db | TaskRepository,
  agent: { id: string; timezone: string },
  ping: ArrivalPing,
  now = new Date(),
): Promise<boolean> {
  if (!ping.observationId || !accurate(ping)) return false;
  const expiresAt = new Date(ping.capturedAt.getTime() + ARRIVAL_OBSERVATION_TTL_MS);
  if (
    expiresAt <= now ||
    !(await locations.isArrivalObservationActive(agent.id, ping.observationId, now))
  )
    return false;

  const windowStart = new Date(now.getTime() - ARRIVAL_WINDOW_HOURS * 3600e3);
  const recent = await locations.recent(agent.id, { from: windowStart, before: ping.capturedAt });
  const decisionPing: ArrivalPing = { ...ping };
  const decisionHistory: ArrivalPing[] = recent.map((row) => ({
    ...row,
    observationId: '',
  }));
  if (!hasConfirmedArrival(decisionPing, decisionHistory, now)) return false;

  const cooldownStart = new Date(now.getTime() - ARRIVAL_COOLDOWN_HOURS * 3600e3);
  if (await locations.hasArrivalTaskSince(agent.id, cooldownStart)) return false;

  // A daily owner-scoped key prevents bursts without encoding a place or keeping
  // a per-place location trail. The reference is useless after its short expiry.
  const externalEventId = `arrival:${agent.id}:${localDay(agent.timezone, now)}`;
  const event = InboundEventSchema.parse({
    source: 'internal',
    externalEventId,
    agentId: agent.id,
    trust: 'assistant',
    payload: {
      kind: 'arrival',
      arrivalObservationId: ping.observationId,
      arrivalExpiresAt: expiresAt.toISOString(),
      completionPolicy: { version: 1, kind: 'successful_silent' },
      instruction:
        'The owner explicitly opted into one generic arrival check after a confirmed stationary stop. ' +
        'The short-lived location reference is only a freshness gate. Never read, reveal, mention, infer, or store any coordinate, address, city, or venue from it. ' +
        'If useful, send one brief notification: “You’ve arrived. Would you like help with anything nearby?” Otherwise finish silently. ' +
        'Do not search for places or create follow-up work.',
    },
  });
  const { created } = await enqueueTask(tasks, {
    event,
    type: 'adhoc',
    budgetUsdLimit: '0.06',
    maxSteps: 6,
  });
  return created;
}
