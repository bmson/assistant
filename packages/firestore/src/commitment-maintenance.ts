import {
  type CommitmentMaintenanceRepository,
  type CommitmentMaintenanceResult,
  commitmentMaintenanceTransition,
  type Records,
} from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

type Commitment = Records['commitments'];

const PAGE = 200;
/** Live loops for one owner; far above what the desk ever holds. */
const SCAN_LIMIT = 10_000;

/**
 * Wake elapsed snoozes and restore legacy age-retired obligations. Each
 * transition rechecks the row transactionally, preserving concurrent closure.
 */
export class FirestoreCommitmentMaintenanceRepository implements CommitmentMaintenanceRepository {
  readonly kind = 'commitment-maintenance-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async maintain(agentId: string, now: Date): Promise<CommitmentMaintenanceResult> {
    if (!agentId || !Number.isFinite(now.getTime()))
      throw new Error('Commitment sweep requires an agent');
    const candidates: string[] = [];
    let scanned = 0;
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.store
        .collection('commitments')
        .where('agentId', '==', agentId)
        .where('status', 'in', ['stale', 'snoozed'])
        .orderBy('updatedAt', 'desc')
        .limit(PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = decodeRecord<Commitment>(doc.data());
        if (
          row.agentId === agentId &&
          documentKey(row.id) === doc.id &&
          commitmentMaintenanceTransition(row, now)
        )
          candidates.push(row.id);
      }
      scanned += page.size;
      if (page.size < PAGE) break;
      // Fail loudly rather than silently leaving part of the desk unswept.
      if (scanned >= SCAN_LIMIT) throw new Error('Commitment sweep exceeded its scan bound');
      cursor = page.docs.at(-1);
    }

    const result: CommitmentMaintenanceResult = { woken: 0, restored: 0 };
    for (const id of candidates) {
      const ref = this.store.doc('commitments', id);
      const changed = await this.store.db.runTransaction(async (tx) => {
        await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) return null;
        const row = decodeRecord<Commitment>(snapshot.data());
        const transition = commitmentMaintenanceTransition(row, now);
        if (row.agentId !== agentId || !transition) return null;
        tx.update(ref, { status: 'open', snoozedUntil: null, updatedAt: now });
        return transition;
      });
      if (changed) result[changed]++;
    }
    return result;
  }
}
