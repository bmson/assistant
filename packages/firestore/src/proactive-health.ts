import type {
  MailHealthCounts,
  MailHealthWindow,
  ProactiveHealthCounts,
  ProactiveHealthRepository,
} from '@assistant/persistence';
import {
  eligibleEmailExtraction,
  emailIngestReadable,
  type MailAdmissionStage,
  mailExtractionWindowState,
  PENDING_MAIL_ADMISSION_STAGES,
  type Records,
} from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { FirestoreDeviceTokenRepository } from './device-tokens.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const MAIL_SCAN_LIMIT = 10_000;
const MAIL_HEALTH_FIELDS = [
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
  'category',
  'importance',
  'extractedAt',
];

/** The proactive-health counts on Firestore, through aggregation queries. */
export class FirestoreProactiveHealthRepository implements ProactiveHealthRepository {
  readonly kind = 'proactive-health-repository' as const;
  private readonly devices: FirestoreDeviceTokenRepository;

  constructor(readonly store: InstallationStore) {
    this.devices = new FirestoreDeviceTokenRepository(store);
  }

  async counts(agentId: string, window: MailHealthWindow): Promise<ProactiveHealthCounts> {
    const [
      {
        mailStalledAdmissionByStage: _stageCounts,
        mailFreshIntake7d: _fresh,
        mailIntakeNeedsReview7d: _review,
        ...mailCounts
      },
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
    let mailFreshIntake7d = 0;
    let mailIntakeNeedsReview7d = 0;
    const mailStalledAdmissionByStage: MailHealthCounts['mailStalledAdmissionByStage'] = {};
    const admissionStages = new Set<string>(PENDING_MAIL_ADMISSION_STAGES);
    const until = window.until ?? new Date(window.since24h.getTime() + 24 * 3600_000);
    let mailEligibleIntake24h = 0;
    let mailExtractionCompleted24h = 0;
    let eligiblePastGrace = 0;
    let extractionEvidenceMissing = false;
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
        .select(...MAIL_HEALTH_FIELDS)
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
          if (row.pipelineStage === 'needs_attention') {
            mailIntakeNeedsReview7d += 1;
          } else if (row.pipelineStage && admissionStages.has(row.pipelineStage)) {
            if (row.createdAt < window.since6h) {
              mailAwaitingAdmissionOver6h7d += 1;
              const stage = row.pipelineStage as MailAdmissionStage;
              mailStalledAdmissionByStage[stage] = (mailStalledAdmissionByStage[stage] ?? 0) + 1;
            } else {
              mailFreshIntake7d += 1;
            }
          }
          continue;
        }
        mailScored7d += 1;
        const eligible = eligibleEmailExtraction(row);
        const inIntakeWindow = row.createdAt >= window.since24h && row.createdAt <= until;
        const pastGrace = row.createdAt < window.since6h;
        if (eligible && inIntakeWindow) {
          mailEligibleIntake24h += 1;
          if (row.extractedAt === null && pastGrace) eligiblePastGrace += 1;
          if (row.extractedAt !== null && !(row.extractedAt instanceof Date))
            extractionEvidenceMissing = true;
        }
        if (row.extractedAt instanceof Date) {
          mailProcessed7d += 1;
          if (eligible && row.extractedAt >= window.since24h && row.extractedAt <= until)
            mailExtractionCompleted24h += 1;
        } else if (eligible && row.extractedAt === null && pastGrace) {
          mailPendingOver6h7d += 1;
        }
        if (row.createdAt >= window.since24h) mailScored24h += 1;
        if (lastMailAt === null || row.createdAt > lastMailAt) lastMailAt = row.createdAt;
      }
      scanned += page.size;
      if (page.size < 250) break;
      cursor = page.docs[page.docs.length - 1];
    }
    if (scanned >= MAIL_SCAN_LIMIT)
      throw new Error('Proactive health mail scan exceeded its bounded window');
    const olderCompletions = await this.countOlderCompletions(agentId, window, until);
    const completed =
      extractionEvidenceMissing || olderCompletions === null
        ? null
        : mailExtractionCompleted24h + olderCompletions;
    return {
      mailEligibleIntake24h,
      mailExtractionCompleted24h: completed,
      mailExtraction24hState: mailExtractionWindowState(
        mailEligibleIntake24h,
        completed,
        eligiblePastGrace,
      ),
      mailReceived7d,
      mailProcessed7d,
      mailPendingOver6h7d,
      mailAwaitingAdmissionOver6h7d,
      mailStalledAdmissionByStage,
      mailFreshIntake7d,
      mailIntakeNeedsReview7d,
      mailScored24h,
      mailScored7d,
      lastMailAt,
    };
  }

  /** Recent completions of older mail are outside the existing arrival scan. */
  private async countOlderCompletions(
    agentId: string,
    window: MailHealthWindow,
    until: Date,
  ): Promise<number | null> {
    const query = this.store
      .collection('emailIngest')
      .where('agentId', '==', agentId)
      .where('extractedAt', '>=', window.since24h)
      .where('extractedAt', '<=', until)
      .where('createdAt', '<', window.since7d)
      .orderBy('extractedAt')
      .orderBy('createdAt')
      .select(...MAIL_HEALTH_FIELDS);
    let cursor: QueryDocumentSnapshot | undefined;
    let scanned = 0;
    let count = 0;
    do {
      const page = await (cursor ? query.startAfter(cursor) : query).limit(250).get();
      for (const doc of page.docs) {
        const row = decodeRecord<Partial<Records['emailIngest']>>(doc.data());
        if (!row.id || documentKey(row.id) !== doc.id || row.agentId !== agentId) return null;
        if (emailIngestReadable(row) && eligibleEmailExtraction(row)) count += 1;
      }
      if (page.size < 250) return count;
      scanned += page.size;
      cursor = page.docs.at(-1);
    } while (scanned < MAIL_SCAN_LIMIT);
    return null;
  }
}
