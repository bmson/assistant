import type {
  BriefingInputs,
  BriefingMail,
  BriefingRepository,
  Records,
} from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE = 200;
/**
 * Mail ingested in one briefing window. Newest is kept when a day's mail runs
 * past this; the briefing reports how many it scanned.
 */
const MAIL_SCAN_LIMIT = 2_000;
/** Pending approvals across the installation; far above any real backlog. */
const APPROVAL_SCAN_LIMIT = 1_000;
/** Recently stopped tasks read before archived ones are dropped. */
const ATTENTION_SCAN = 100;

function owned<T extends { id: string; agentId: string }>(
  doc: QueryDocumentSnapshot,
  agentId: string,
): T | null {
  const row = decodeRecord<T>(doc.data());
  return typeof row.id === 'string' && documentKey(row.id) === doc.id && row.agentId === agentId
    ? row
    : null;
}

/** The daily briefing's reads on Firestore: the same inputs as the PostgreSQL job. */
export class FirestoreBriefingRepository implements BriefingRepository {
  readonly kind = 'briefing-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async inputs(
    agentId: string,
    window: Parameters<BriefingRepository['inputs']>[1],
  ): Promise<BriefingInputs> {
    const [mail, bookings, attention, pending, goalDeltas, watchHits] = await Promise.all([
      this.mail(agentId, window.since),
      this.bookings(agentId),
      this.attention(agentId, window.since, window.attentionLimit),
      this.pending(agentId, window.now, window.pendingLimit),
      this.goalDeltas(agentId, window.since, window.goalLimit),
      this.watchHits(agentId, window.since, window.watchLimit),
    ]);
    return { mail, bookings, attention, pending, goalDeltas, watchHits };
  }

  private async bookings(agentId: string) {
    const snapshot = await this.store
      .collection('emailBookingOccurrences')
      .where('agentId', '==', agentId)
      .limit(2_000)
      .get();
    return snapshot.docs.flatMap((doc) => {
      const row = owned<Records['emailBookingOccurrences']>(doc, agentId);
      return row && row.sourceAuthenticated === true ? [row] : [];
    });
  }

  private async mail(agentId: string, since: Date): Promise<BriefingMail[]> {
    const rows: Array<BriefingMail & { createdAt: Date }> = [];
    let cursor: QueryDocumentSnapshot | undefined;
    while (rows.length < MAIL_SCAN_LIMIT) {
      let query = this.store
        .collection('emailIngest')
        .where('agentId', '==', agentId)
        .where('createdAt', '>=', since)
        .orderBy('createdAt', 'desc')
        .limit(PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = owned<Records['emailIngest']>(doc, agentId);
        if (
          !row ||
          !(row.createdAt instanceof Date) ||
          (row.pipelineStage !== undefined && row.pipelineStage !== 'complete')
        )
          continue;
        rows.push({
          fromEmail: row.fromEmail,
          fromName: row.fromName ?? null,
          subject: row.subject,
          category: row.category,
          importance: Number(row.importance) || 0,
          dates: row.dates,
          channelMessageId: row.channelMessageId,
          authenticated: row.authenticated === true,
          createdAt: row.createdAt,
        });
      }
      if (page.size < PAGE) break;
      cursor = page.docs[page.docs.length - 1];
    }
    return rows
      .slice(0, MAIL_SCAN_LIMIT)
      .sort((a, b) => b.importance - a.importance || b.createdAt.getTime() - a.createdAt.getTime())
      .map(({ createdAt: _createdAt, ...row }) => row);
  }

  private async attention(agentId: string, since: Date, limit: number) {
    const snapshot = await this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('status', '==', 'needs_attention')
      .where('updatedAt', '>=', since)
      .orderBy('updatedAt', 'desc')
      .limit(ATTENTION_SCAN)
      .get();
    return snapshot.docs
      .flatMap((doc) => {
        const row = owned<Records['tasks']>(doc, agentId);
        return row && !row.archivedAt
          ? [{ title: row.title ?? null, progress: row.progress ?? '' }]
          : [];
      })
      .slice(0, limit);
  }

  private async pending(agentId: string, now: Date, limit: number) {
    const rows: Array<{ shortCode: string; summary: string }> = [];
    let scanned = 0;
    let cursor: QueryDocumentSnapshot | undefined;
    while (rows.length < limit) {
      let query = this.store
        .collection('approvals')
        .where('status', '==', 'pending')
        .where('expiresAt', '>', now)
        .orderBy('expiresAt', 'asc')
        .orderBy('id', 'asc')
        .limit(PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      const approvals = page.docs.flatMap((doc) => {
        const row = decodeRecord<Records['approvals']>(doc.data());
        return typeof row.id === 'string' && documentKey(row.id) === doc.id ? [row] : [];
      });
      const tasks = approvals.length
        ? await this.store.db.getAll(
            ...approvals.map((approval) => this.store.doc('tasks', approval.taskId)),
          )
        : [];
      approvals.forEach((approval, i) => {
        const task = tasks[i];
        if (
          rows.length < limit &&
          task?.exists &&
          task.get('agentId') === agentId &&
          !task.get('archivedAt')
        )
          rows.push({ shortCode: approval.shortCode, summary: approval.summary });
      });
      scanned += page.size;
      if (page.size < PAGE) break;
      if (scanned >= APPROVAL_SCAN_LIMIT) throw new Error('Pending approval scan exceeded bound');
      cursor = page.docs[page.docs.length - 1];
    }
    return rows;
  }

  private async goalDeltas(agentId: string, since: Date, limit: number) {
    const snapshot = await this.store
      .collection('goals')
      .where('agentId', '==', agentId)
      .where('updatedAt', '>=', since)
      .orderBy('updatedAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.flatMap((doc) => {
      const row = owned<Records['goals']>(doc, agentId);
      return row && row.updatedAt instanceof Date
        ? [
            {
              title: row.title,
              status: row.status,
              nextAction: row.nextAction ?? '',
              updatedAt: row.updatedAt,
            },
          ]
        : [];
    });
  }

  private async watchHits(agentId: string, since: Date, limit: number) {
    const snapshot = await this.store
      .collection('watchFires')
      .where('agentId', '==', agentId)
      .where('createdAt', '>=', since)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    const fires = snapshot.docs.flatMap((doc) => {
      const row = owned<Records['watchFires']>(doc, agentId);
      return row ? [row] : [];
    });
    if (fires.length === 0) return [];
    const watches = await this.store.db.getAll(
      ...fires.map((fire) => this.store.doc('watches', fire.watchId)),
    );
    return fires.flatMap((fire, i) => {
      const watch = watches[i];
      return watch?.exists && watch.get('agentId') === agentId
        ? [{ name: String(watch.get('name')), summary: fire.summary }]
        : [];
    });
  }
}
