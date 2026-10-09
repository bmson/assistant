import { FieldPath } from '@google-cloud/firestore';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/** Every new conversation must carry the query projection used by chat lists. */
export function conversationDocument<
  T extends { id: string; agentId: string; channel: string; archivedAt: Date | null },
>(row: T): FirebaseFirestore.DocumentData {
  if (
    !row.id ||
    !row.agentId ||
    !['chat', 'email', 'sms', 'voice'].includes(row.channel) ||
    (row.archivedAt !== null &&
      (!(row.archivedAt instanceof Date) || !Number.isFinite(row.archivedAt.getTime())))
  )
    throw new Error('Invalid conversation record');
  const messageSequence = (row as T & { messageSequence?: unknown }).messageSequence;
  return encodeRecord({
    ...row,
    messageSequence: typeof messageSequence === 'number' ? messageSequence : 0,
    archived: row.archivedAt !== null,
  });
}

/** Explicit, bounded and replayable repair; never guesses unknown archive state. */
export async function repairConversationProjectionPage(
  store: InstallationStore,
  agentId: string,
  options: { afterDocumentId?: string; limit?: number } = {},
): Promise<{ scanned: number; repaired: number; skipped: number; nextCursor: string | null }> {
  const limit = options.limit ?? 100;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    (options.afterDocumentId && !/^[A-Za-z0-9_-]{1,1400}$/.test(options.afterDocumentId))
  )
    throw new Error('Invalid conversation repair page');
  return store.db.runTransaction(async (tx) => {
    const owners = await tx.get(store.collection('agents').limit(2));
    const owner = owners.docs[0];
    if (owners.size !== 1 || owner?.get('id') !== agentId || owner.id !== documentKey(agentId))
      throw new Error('Conversation repair requires the configured owner');
    await assertPrivacyErasureInactiveInTransaction(tx, store, agentId);
    let query = store
      .collection('conversations')
      .where('agentId', '==', agentId)
      .orderBy(FieldPath.documentId())
      .select('id', 'agentId', 'channel', 'archivedAt', 'archived');
    if (options.afterDocumentId) query = query.startAfter(options.afterDocumentId);
    const page = await tx.get(query.limit(limit + 1));
    let repaired = 0,
      skipped = 0;
    const rows = page.docs.slice(0, limit);
    for (const doc of rows) {
      const row = decodeRecord<{
        id?: unknown;
        agentId?: unknown;
        channel?: unknown;
        archivedAt?: unknown;
        archived?: unknown;
      }>(doc.data());
      if (
        typeof row.id !== 'string' ||
        documentKey(row.id) !== doc.id ||
        row.agentId !== agentId ||
        typeof row.channel !== 'string' ||
        !['chat', 'email', 'sms', 'voice'].includes(row.channel) ||
        !(
          row.archivedAt === null ||
          (row.archivedAt instanceof Date && Number.isFinite(row.archivedAt.getTime()))
        )
      ) {
        skipped++;
        continue;
      }
      const archived = row.archivedAt !== null;
      if (row.archived !== archived) {
        tx.update(doc.ref, { archived });
        repaired++;
      }
    }
    return {
      scanned: rows.length,
      repaired,
      skipped,
      nextCursor: page.size > limit ? (rows.at(-1)?.id ?? null) : null,
    };
  });
}
