import type { ProactiveHealthCounts, ProactiveHealthRepository } from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { FirestoreDeviceTokenRepository } from './device-tokens.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

/** Pings read per day; the ambient policy caps them far below this. */
const PING_LIMIT = 2_000;
const MAIL_SCAN_LIMIT = 10_000;

/** The proactive-health counts on Firestore, through aggregation queries. */
export class FirestoreProactiveHealthRepository implements ProactiveHealthRepository {
  readonly kind = 'proactive-health-repository' as const;
  private readonly devices: FirestoreDeviceTokenRepository;

  constructor(readonly store: InstallationStore) {
    this.devices = new FirestoreDeviceTokenRepository(store);
  }

  async counts(
    agentId: string,
    window: { since24h: Date; since7d: Date },
  ): Promise<ProactiveHealthCounts> {
    const [mailCounts, moments, pings, devices] = await Promise.all([
      this.completeMailCounts(agentId, window),
      this.store
        .collection('proactiveMoments')
        .where('agentId', '==', agentId)
        .where('deliveredAt', '>=', window.since24h)
        .count()
        .get(),
      this.store
        .collection('proactivePings')
        .where('agentId', '==', agentId)
        .where('createdAt', '>=', window.since24h)
        .select('delivered')
        .limit(PING_LIMIT)
        .get(),
      this.devices.listActive(agentId),
    ]);
    return {
      ...mailCounts,
      momentsDelivered24h: moments.data().count,
      pingsDelivered24h: pings.docs.filter((doc) => doc.get('delivered') === true).length,
      pingsHeld24h: pings.docs.filter((doc) => doc.get('delivered') !== true).length,
      pushDevices: devices.length,
    };
  }

  private async completeMailCounts(
    agentId: string,
    window: { since24h: Date; since7d: Date },
  ): Promise<Pick<ProactiveHealthCounts, 'mailScored24h' | 'mailScored7d' | 'lastMailAt'>> {
    let mailScored24h = 0;
    let mailScored7d = 0;
    let lastMailAt: Date | null = null;
    let cursor: QueryDocumentSnapshot | undefined;
    let scanned = 0;
    while (scanned < MAIL_SCAN_LIMIT) {
      let query = this.store
        .collection('emailIngest')
        .where('agentId', '==', agentId)
        .where('createdAt', '>=', window.since7d)
        .orderBy('createdAt', 'asc')
        .limit(Math.min(250, MAIL_SCAN_LIMIT - scanned));
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = decodeRecord<{
          id?: unknown;
          agentId?: unknown;
          createdAt?: unknown;
          pipelineStage?: unknown;
        }>(doc.data());
        if (
          typeof row.id !== 'string' ||
          documentKey(row.id) !== doc.id ||
          row.agentId !== agentId ||
          !(row.createdAt instanceof Date) ||
          (row.pipelineStage !== undefined && row.pipelineStage !== 'complete')
        )
          continue;
        mailScored7d += 1;
        if (row.createdAt >= window.since24h) mailScored24h += 1;
        if (lastMailAt === null || row.createdAt > lastMailAt) lastMailAt = row.createdAt;
      }
      scanned += page.size;
      if (page.size < 250) break;
      cursor = page.docs[page.docs.length - 1];
    }
    if (scanned >= MAIL_SCAN_LIMIT)
      throw new Error('Proactive health mail scan exceeded its bounded window');
    return { mailScored24h, mailScored7d, lastMailAt };
  }
}
