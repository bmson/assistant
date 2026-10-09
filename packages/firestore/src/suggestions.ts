import { createHash } from 'node:crypto';
import type {
  CreateSuggestionRecord,
  SuggestionRecord,
  SuggestionRepository,
} from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { withEmulatorTransactionRetry } from './emulator-transaction.js';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const PAGE = 200;
/** Open proposals expire within days; far beyond what one owner ever has waiting. */
const OPEN_SCAN_LIMIT = 2_000;

/**
 * A UUID-shaped id fixed by `(agentId, sourceRef)`, so concurrent producers
 * converge on one document. Owner routes accept suggestion ids as UUIDs.
 */
export function suggestionIdFor(agentId: string, sourceRef: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([agentId, sourceRef]))
    .digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function valid(snapshot: QueryDocumentSnapshot, agentId: string): SuggestionRecord | null {
  const row = decodeRecord<SuggestionRecord>(snapshot.data());
  if (
    typeof row.id !== 'string' ||
    documentKey(row.id) !== snapshot.id ||
    row.agentId !== agentId ||
    !(row.expiresAt instanceof Date) ||
    !(row.createdAt instanceof Date)
  )
    return null;
  return row;
}

export class FirestoreSuggestionRepository implements SuggestionRepository {
  readonly kind = 'suggestion-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async create(input: CreateSuggestionRecord): Promise<SuggestionRecord | null> {
    if (!input.agentId || !input.sourceRef) throw new Error('Invalid suggestion');
    if (
      input.bookingCancellation &&
      (!input.bookingKey ||
        !Number.isInteger(input.bookingVersion) ||
        !input.bookingCancellation.calendarEventId.trim() ||
        !input.bookingCancellation.bookingIdentity.trim())
    )
      throw new Error('Invalid booking cancellation binding');
    const id = suggestionIdFor(input.agentId, input.sourceRef);
    const ref = this.store.doc('suggestions', id);
    // Imported proposals keep their random ids, so the source is also looked up.
    const existing = this.store
      .collection('suggestions')
      .where('agentId', '==', input.agentId)
      .where('sourceRef', '==', input.sourceRef)
      .limit(1);
    // Idempotent: a retry finds the row a committed attempt created and returns null.
    return withEmulatorTransactionRetry(() =>
      this.store.db.runTransaction(async (tx) => {
        await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
        const [byId, bySource] = await Promise.all([tx.get(ref), tx.get(existing)]);
        if (byId.exists || !bySource.empty) return null;
        const now = this.store.now();
        const row: SuggestionRecord = {
          id,
          createdAt: now,
          updatedAt: now,
          agentId: input.agentId,
          status: input.status ?? 'pending',
          expiresAt: input.expiresAt,
          conversationId: input.conversationId ?? null,
          origin: input.origin,
          bookingKey: input.bookingKey ?? null,
          bookingVersion: input.bookingVersion ?? null,
          bookingCancellation: input.bookingCancellation ?? null,
          snoozedUntil: null,
          summary: input.summary,
          proposedAction: input.proposedAction,
          sourceRef: input.sourceRef,
          acceptedTaskId: null,
        };
        tx.create(ref, encodeRecord(row));
        return row;
      }),
    );
  }

  async listOpen(agentId: string, now: Date): Promise<SuggestionRecord[]> {
    const rows: SuggestionRecord[] = [];
    let scanned = 0;
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.store
        .collection('suggestions')
        .where('agentId', '==', agentId)
        .where('status', 'in', ['pending', 'snoozed'])
        .orderBy('createdAt', 'asc')
        .orderBy('id', 'asc')
        .limit(PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = valid(doc, agentId);
        if (
          row &&
          row.expiresAt > now &&
          (!(row.snoozedUntil instanceof Date) || row.snoozedUntil <= now)
        )
          rows.push(row);
      }
      scanned += page.size;
      if (page.size < PAGE) return rows;
      if (scanned >= OPEN_SCAN_LIMIT) throw new Error('Open suggestion scan exceeded bound');
      cursor = page.docs[page.docs.length - 1];
    }
  }

  async inactiveSourceRefs(agentId: string, sourceRefs: readonly string[]): Promise<string[]> {
    const refs = [...new Set(sourceRefs)];
    if (!agentId || refs.length > 64 || refs.some((ref) => !ref || ref.length > 2048))
      throw new Error('Invalid suggestion identity batch');
    const inactive: string[] = [];
    for (const sourceRef of refs) {
      // Imported suggestions retain random IDs, so use the bounded exact-source
      // lookup rather than assuming the current deterministic document key.
      const page = await this.store
        .collection('suggestions')
        .where('agentId', '==', agentId)
        .where('sourceRef', '==', sourceRef)
        .limit(2)
        .get();
      if (
        page.docs.some((snapshot) => {
          const row = valid(snapshot, agentId);
          return row && row.status !== 'pending';
        })
      )
        inactive.push(sourceRef);
    }
    return inactive;
  }

  async acceptedForTask(input: {
    agentId: string;
    suggestionId: string;
    taskId: string;
  }): Promise<SuggestionRecord | null> {
    if (!input.agentId || !input.suggestionId || !input.taskId) return null;
    const snapshot = await this.store.doc('suggestions', input.suggestionId).get();
    if (!snapshot.exists) return null;
    const row = valid(snapshot as QueryDocumentSnapshot, input.agentId);
    return row?.status === 'accepted' && row.acceptedTaskId === input.taskId ? row : null;
  }

  async supersedeBooking(agentId: string, bookingKey: string, now: Date): Promise<number> {
    if (!agentId || !bookingKey) return 0;
    const query = this.store
      .collection('suggestions')
      .where('agentId', '==', agentId)
      .where('bookingKey', '==', bookingKey)
      .where('status', 'in', ['pending', 'snoozed']);
    return withEmulatorTransactionRetry(() =>
      this.store.db.runTransaction(async (tx) => {
        const page = await tx.get(query.limit(200));
        let changed = 0;
        for (const doc of page.docs) {
          const row = valid(doc, agentId);
          if (!row || row.bookingKey !== bookingKey) continue;
          tx.update(doc.ref, encodeRecord({ status: 'superseded', updatedAt: now }));
          changed += 1;
        }
        return changed;
      }),
    );
  }
}
