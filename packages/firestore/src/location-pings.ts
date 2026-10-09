import { randomUUID } from 'node:crypto';
import type {
  LocationPingRepository,
  LocationPingWrite,
  RecentLocationPing,
} from '@assistant/persistence';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/** A day and a half of pings is far below this; exceeding it fails loudly. */
const MAX_RECENT_PINGS = 2_000;
/** Arrival events for a few local days; the cooldown needs the newest handful. */
const ARRIVAL_EVENT_SCAN = 50;

/**
 * Owner location pings in `locationPings`, stored in the imported PostgreSQL
 * shape (decimal strings for coordinates) so the ambient-context reader treats
 * new and migrated rows alike.
 */
export class FirestoreLocationPingRepository implements LocationPingRepository {
  readonly kind = 'location-ping-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async record(agentId: string, ping: LocationPingWrite) {
    if (!agentId) throw new Error('agent is required');
    if (!Number.isFinite(ping.capturedAt.getTime())) throw new Error('Invalid ping time');
    const id = randomUUID();
    const arrivalExpiresAt = ping.arrivalOptIn
      ? new Date(ping.capturedAt.getTime() + 5 * 60_000)
      : null;
    await this.store.db.runTransaction(async (tx) => {
      const agents = await tx.get(this.store.collection('agents').limit(2));
      const owner = agents.docs[0];
      if (
        agents.size !== 1 ||
        !owner ||
        owner.id !== documentKey(agentId) ||
        owner.get('id') !== agentId
      )
        throw new Error('Location ping requires one matching configured agent');
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId || privacyErasureIsActive(erasure.get('status')))
      )
        throw new Error('Privacy erasure is in progress');
      tx.create(
        this.store.doc('locationPings', id),
        encodeRecord({
          id,
          createdAt: this.store.now(),
          agentId,
          source: ping.source,
          label: ping.label,
          lat: String(ping.lat),
          lng: String(ping.lng),
          accuracyM: ping.accuracyM,
          timeZone: ping.timeZone,
          capturedAt: ping.capturedAt,
          arrivalExpiresAt,
        }),
      );
    });
    return { id, arrivalExpiresAt };
  }

  async recent(
    agentId: string,
    { from, before }: { from: Date; before: Date },
  ): Promise<RecentLocationPing[]> {
    const snapshot = await this.store
      .collection('locationPings')
      .where('agentId', '==', agentId)
      .where('capturedAt', '>=', from)
      .where('capturedAt', '<', before)
      .orderBy('capturedAt', 'desc')
      .limit(MAX_RECENT_PINGS + 1)
      .get();
    if (snapshot.size > MAX_RECENT_PINGS)
      throw new Error('Recent location pings exceed the arrival scan limit');
    return snapshot.docs.flatMap((doc) => {
      const row = decodeRecord<{
        id?: unknown;
        agentId?: unknown;
        lat?: unknown;
        lng?: unknown;
        accuracyM?: unknown;
        capturedAt?: unknown;
      }>(doc.data());
      const lat = Number(row.lat);
      const lng = Number(row.lng);
      if (
        row.agentId !== agentId ||
        typeof row.id !== 'string' ||
        documentKey(row.id) !== doc.id ||
        !(row.capturedAt instanceof Date) ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng)
      )
        return [];
      return [
        {
          lat,
          lng,
          accuracyM: typeof row.accuracyM === 'number' ? row.accuracyM : null,
          capturedAt: row.capturedAt,
        },
      ];
    });
  }

  /**
   * Arrival event IDs are `arrival:<agentId>:<local date>:<grid>`, so the
   * agent's arrivals are one key range and sort by date. The newest few rows
   * cover a 12-hour cooldown without a composite index.
   */
  async hasArrivalTaskSince(agentId: string, since: Date): Promise<boolean> {
    const prefix = `arrival:${agentId}:`;
    const snapshot = await this.store
      .collection('tasks')
      .where('externalEventId', '>=', prefix)
      .where('externalEventId', '<', `arrival:${agentId};`)
      .orderBy('externalEventId', 'desc')
      .limit(ARRIVAL_EVENT_SCAN)
      .get();
    return snapshot.docs.some((doc) => {
      const row = decodeRecord<{ agentId?: unknown; createdAt?: unknown }>(doc.data());
      return row.agentId === agentId && row.createdAt instanceof Date && row.createdAt >= since;
    });
  }

  async isArrivalObservationActive(agentId: string, id: string, now: Date): Promise<boolean> {
    const snapshot = await this.store.doc('locationPings', id).get();
    if (!snapshot.exists) return false;
    const row = decodeRecord<{
      id?: unknown;
      agentId?: unknown;
      capturedAt?: unknown;
      arrivalExpiresAt?: unknown;
    }>(snapshot.data());
    return (
      row.id === id &&
      row.agentId === agentId &&
      row.capturedAt instanceof Date &&
      row.capturedAt <= now &&
      row.arrivalExpiresAt instanceof Date &&
      row.arrivalExpiresAt > now
    );
  }
}
