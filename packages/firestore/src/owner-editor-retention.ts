import {
  parseOwnerEditorEpochCursor,
  parseOwnerEditorOperationRecord,
} from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { ownerEditorFirestorePrivacyToken } from './owner-editor-repository.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const replayMs = 24 * 60 * 60 * 1000;
const pageSize = 50;
const epochName = (ownerId: string) => `owner-editor-epoch:${ownerId}`;

function retentionCutoff(now: Date, actualNow: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new Error('Editor receipt retention time is invalid');
  if (!(actualNow instanceof Date) || !Number.isFinite(actualNow.getTime()))
    throw new Error('Editor receipt retention clock is invalid');
  // Caller time must never advance deletion ahead of the authoritative replay clock.
  return new Date(actualNow.getTime() - replayMs);
}

function expiredOperation(
  snapshot: DocumentSnapshot,
  ownerId: string,
  cutoff: Date,
): { id: string; ref: DocumentSnapshot['ref'] } {
  if (!snapshot.exists) throw new Error('Editor receipt disappeared during retention');
  const row = parseOwnerEditorOperationRecord(decodeRecord(snapshot.data()));
  if (
    snapshot.id !== documentKey(row.id) ||
    snapshot.ref.id !== documentKey(row.id) ||
    row.ownerId !== ownerId ||
    row.formIssuedAt.getTime() > cutoff.getTime()
  )
    throw new Error('Editor receipt physical identity is unavailable');
  return { id: row.id, ref: snapshot.ref };
}

/**
 * Removes at most one owner-scoped page of replay-expired receipts.
 * Call repeatedly from maintenance until this returns zero. A missing row
 * after retention is never converted into a not-applied operation outcome.
 */
export async function pruneExpiredFirestoreOwnerEditorReceipts(
  store: InstallationStore,
  ownerId: string,
  now: Date,
): Promise<number> {
  const cutoff = retentionCutoff(now, store.now());
  return store.db.runTransaction(async (tx: Transaction) => {
    // Read owner, privacy state and epoch before reading receipts or writing.
    const owners = await tx.get(store.collection('agents').limit(2));
    if (
      owners.size !== 1 ||
      owners.docs[0]?.get('id') !== ownerId ||
      owners.docs[0]?.id !== documentKey(ownerId)
    )
      throw new Error('Editor owner is unavailable');

    const name = epochName(ownerId);
    const [job, epoch] = await tx.getAll(
      store.doc('privacyErasureJobs', ownerId),
      store.doc('maintenanceCursors', name),
    );
    // Existing non-complete privacy jobs fail closed; an absent job means the
    // installation has no generation marker. Missing epochs remain cleanup-safe.
    if (!job) throw new Error('Editor privacy state is unavailable');
    ownerEditorFirestorePrivacyToken(job, ownerId);
    if (epoch?.exists) {
      if (
        epoch.id !== documentKey(name) ||
        epoch.get('name') !== name ||
        typeof epoch.get('cursor') !== 'string'
      )
        throw new Error('Editor epoch identity is malformed');
      const parsed = parseOwnerEditorEpochCursor(JSON.parse(epoch.get('cursor') as string));
      if (parsed.ownerId !== ownerId) throw new Error('Editor epoch owner is unavailable');
    }

    const page = await tx.get(
      store
        .collection('ownerEditorOperations')
        .where('ownerId', '==', ownerId)
        .where('formIssuedAt', '<=', cutoff)
        .orderBy('formIssuedAt', 'asc')
        .orderBy('id', 'asc')
        .limit(pageSize),
    );
    const rows = page.docs.map((snapshot) => expiredOperation(snapshot, ownerId, cutoff));
    for (const row of rows) tx.delete(row.ref);
    return rows.length;
  });
}
