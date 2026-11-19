import type {
  MailHealthCounts,
  MailHealthWindow,
  ProactiveHealthCounts,
  ProactiveHealthRepository,
} from '@assistant/persistence';
import {
  emailIngestReadable,
  type MailAdmissionStage,
  PENDING_MAIL_ADMISSION_STAGES,
  type Records,
} from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { FirestoreDeviceTokenRepository } from './device-tokens.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const MAIL_SCAN_LIMIT = 10_000;

/** The proactive-health counts on Firestore, through aggregation queries. */
export class FirestoreProactiveHealthRepository implements ProactiveHealthRepository {
  readonly kind = 'proactive-health-repository' as const;
  private readonly devices: FirestoreDeviceTokenRepository;

  constructor(readonly store: InstallationStore) {
    this.devices = new FirestoreDeviceTokenRepository(store);
  }

  async counts(agentId: string, window: MailHealthWindow): Promise<ProactiveHealthCounts> {
    const [
      { mailStalledAdmissionByStage: _stageCounts, ...mailCounts },
      moments,
      deliveredPings,
      heldPings,
      devices,
    ] = await Promise.all([
      this.mailCounts(agentId, window),
      this.store
        .collection('proactiveMoments')
        .where('agentId', '==', agentId)
        .where('deliveredAt', '>=', window.since24h)
        .count()
        .get(),
      this.store
        .collection('proactivePings')
        .where('agentId', '==', agentId)
        .where('delivered', '==', true)
        .where('createdAt', '>=', window.since24h)
        .count()
        .get(),
      this.store
        .collection('proactivePings')
        .where('agentId', '==', agentId)
        .where('delivered', '==', false)
        .where('createdAt', '>=', window.since24h)
        .count()
        .get(),
      this.devices.listActive(agentId),
    ]);
    return {
      ...mailCounts,
      momentsDelivered24h: moments.data().count,
      pingsDelivered24h: deliveredPings.data().count,
      pingsHeld24h: heldPings.data().count,
      pushDevices: devices.length,
    };
  }

  async mailCounts(agentId: string, window: MailHealthWindow): Promise<MailHealthCounts> {
    let mailReceived7d = 0;
    let mailProcessed7d = 0;
    let mailPendingOver6h7d = 0;
    let mailAwaitingAdmissionOver6h7d = 0;
    const mailStalledAdmissionByStage: MailHealthCounts['mailStalledAdmissionByStage'] = {};
    const admissionStages = new Set<string>(PENDING_MAIL_ADMISSION_STAGES);
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
        .orderBy('createdAt', 'desc')
        .select(
          'id',
          'agentId',
          'createdAt',
          'pipelineStage',
          'ingestMode',
          'authenticated',
          'admittedSourceId',
          'admittedSourceKind',
          'messagePersisted',
          'scoreStatus',
          'scoreOutcome',
          'extractedAt',
        )
        .limit(Math.min(250, MAIL_SCAN_LIMIT - scanned));
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = decodeRecord<Partial<Records['emailIngest']>>(doc.data());
        if (
          typeof row.id !== 'string' ||
          documentKey(row.id) !== doc.id ||
          row.agentId !== agentId ||
          !(row.createdAt instanceof Date)
        )
          continue;
        mailReceived7d += 1;
        if (!emailIngestReadable(row)) {
          if (
            row.createdAt < window.since6h &&
            row.pipelineStage &&
            admissionStages.has(row.pipelineStage)
          ) {
            mailAwaitingAdmissionOver6h7d += 1;
            const stage = row.pipelineStage as MailAdmissionStage;
            mailStalledAdmissionByStage[stage] = (mailStalledAdmissionByStage[stage] ?? 0) + 1;
          }
          continue;
        }
        mailScored7d += 1;
        if (row.extractedAt instanceof Date) mailProcessed7d += 1;
        else if (row.createdAt < window.since6h) mailPendingOver6h7d += 1;
        if (row.createdAt >= window.since24h) mailScored24h += 1;
        if (lastMailAt === null || row.createdAt > lastMailAt) lastMailAt = row.createdAt;
      }
      scanned += page.size;
      if (page.size < 250) break;
      cursor = page.docs[page.docs.length - 1];
    }
    if (scanned >= MAIL_SCAN_LIMIT)
      throw new Error('Proactive health mail scan exceeded its bounded window');
    return {
      mailReceived7d,
      mailProcessed7d,
      mailPendingOver6h7d,
      mailAwaitingAdmissionOver6h7d,
      mailStalledAdmissionByStage,
      mailScored24h,
      mailScored7d,
      lastMailAt,
    };
  }
}
