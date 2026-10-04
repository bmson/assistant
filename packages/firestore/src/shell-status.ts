import type { Records, ShellStatusProjection, ShellStatusRepository } from '@assistant/persistence';
import { FieldPath, type Query, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 1000;
const MAX_MEMORY_SCAN = 100_000;
const APPROVAL_PAGE_SIZE = 500;
const MAX_PENDING_APPROVAL_SCAN = 100_000;

async function scanPages(
  query: Query,
  collection: 'memories',
  visit: (doc: QueryDocumentSnapshot) => void,
): Promise<void> {
  const max = MAX_MEMORY_SCAN;
  let cursor: QueryDocumentSnapshot | undefined;
  let scanned = 0;
  while (true) {
    let page = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    scanned += snapshot.size;
    if (scanned > max)
      throw new Error(`Shell status ${collection} scan exceeds its explicit limit`);
    for (const doc of snapshot.docs) visit(doc);
    if (snapshot.size < PAGE_SIZE) return;
    cursor = snapshot.docs.at(-1);
  }
}

async function countPendingApprovals(
  store: InstallationStore,
  ownerAgentId: string,
  now: Date,
): Promise<number> {
  let cursor: QueryDocumentSnapshot | undefined;
  let scanned = 0;
  const live: Array<{ id: string; taskId: string }> = [];
  const base = store
    .collection('approvals')
    .where('status', '==', 'pending')
    .select('id', 'taskId', 'expiresAt') as Query;
  while (true) {
    let query = base.orderBy(FieldPath.documentId()).limit(APPROVAL_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    scanned += snapshot.size;
    if (scanned > MAX_PENDING_APPROVAL_SCAN)
      throw new Error('Shell status approval scan exceeds its explicit limit');
    for (const doc of snapshot.docs) {
      const approval = decodeRecord<{
        id: string;
        taskId: string;
        status: string;
        expiresAt: Date;
      }>(doc.data());
      if (!approval.id || documentKey(approval.id) !== doc.id)
        throw new Error('Malformed shell status approval record');
      if (!(approval.expiresAt instanceof Date) || !Number.isFinite(approval.expiresAt.getTime()))
        throw new Error('Malformed shell status approval expiry');
      if (!approval.taskId) throw new Error('Malformed shell status approval task reference');
      if (approval.expiresAt > now) live.push({ id: approval.id, taskId: approval.taskId });
    }
    if (snapshot.size < APPROVAL_PAGE_SIZE) break;
    cursor = snapshot.docs.at(-1);
  }

  // An approval counts when its task is the owner's. Pending approvals are few, so
  // the owner check reads just their tasks (batched, one field each) instead of
  // holding the id of every task the assistant has ever created.
  const taskIds = [...new Set(live.map((approval) => approval.taskId))];
  const owned = new Set<string>();
  for (let offset = 0; offset < taskIds.length; offset += 100) {
    const refs = taskIds.slice(offset, offset + 100).map((id) => store.doc('tasks', id));
    for (const snapshot of await store.db.getAll(...refs, { fieldMask: ['id', 'agentId'] })) {
      if (snapshot.exists && snapshot.get('agentId') === ownerAgentId)
        owned.add(String(snapshot.get('id')));
    }
  }
  return live.filter((approval) => owned.has(approval.taskId)).length;
}

async function resolveShellAgent(
  store: InstallationStore,
  pinnedAgentId?: string,
): Promise<string> {
  const configured = pinnedAgentId ? null : await store.collection('agents').limit(2).get();
  if (configured && (configured.size !== 1 || !configured.docs[0]))
    throw new Error('Memory hub requires exactly one configured agent');
  const agentDoc = pinnedAgentId
    ? await store.doc('agents', pinnedAgentId).get()
    : configured?.docs[0];
  if (!agentDoc?.exists) throw new Error('Configured Memory hub agent is missing');
  const agentId = agentDoc.get('id');
  if (
    typeof agentId !== 'string' ||
    documentKey(agentId) !== agentDoc.id ||
    (pinnedAgentId !== undefined && agentId !== pinnedAgentId)
  )
    throw new Error('Configured agent record is malformed');
  return agentId;
}

/**
 * Exact owner-facing shell counts. Task counts come from count queries; the memory
 * health figures still scan the owner's memories a page at a time, so that read grows
 * with the number of memories until durable aggregate counters replace it.
 */
export class FirestoreShellStatusRepository implements ShellStatusRepository {
  readonly kind = 'shell-status-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId?: string,
  ) {}

  async load(agentId: string): Promise<ShellStatusProjection> {
    if (this.configuredAgentId && this.configuredAgentId !== agentId)
      throw new Error('Shell status agent is outside the configured installation');
    const ownerAgentId = await resolveShellAgent(this.store, this.configuredAgentId);
    if (ownerAgentId !== agentId)
      throw new Error('Shell status agent is outside the configured installation');

    const fence = await readPrivacyErasureFence(this.store, ownerAgentId);
    const now = this.store.now();
    // Counted, not scanned. This used to read every task the assistant had ever
    // created (15,000+ in production) just to count two statuses, and it ran
    // on every cache miss of the very first request the app makes. `agentId` and
    // `status` equality is served by the existing indexes.
    const owned = this.store.collection('tasks').where('agentId', '==', ownerAgentId);
    const [needsAttentionCount, runningCount, memoryHealth] = await Promise.all([
      owned.where('status', '==', 'needs_attention').count().get(),
      owned.where('status', '==', 'running').count().get(),
      this.readMemoryHealth(ownerAgentId, now),
    ]);
    const needsAttention = needsAttentionCount.data().count;
    const running = runningCount.data().count;
    await assertPrivacyErasureFenceUnchanged(this.store, ownerAgentId, fence);

    const pendingApprovals = await countPendingApprovals(this.store, ownerAgentId, now);
    await assertPrivacyErasureFenceUnchanged(this.store, ownerAgentId, fence);
    return {
      dashboard: {
        pendingApprovals,
        needsAttention,
        presence:
          pendingApprovals > 0 || needsAttention > 0
            ? 'attention'
            : running > 0
              ? 'working'
              : 'idle',
      },
      memoryHealth,
    };
  }

  /** The one remaining scan: usable-memory counts need per-document expiry and quarantine checks. */
  private async readMemoryHealth(
    ownerAgentId: string,
    now: Date,
  ): Promise<ShellStatusProjection['memoryHealth']> {
    let totalUsable = 0;
    let notYetOrganized = 0;
    let awaitingReview = 0;
    let ownerConfirmed = 0;
    let lastOrganizedAt: Date | null = null;
    await scanPages(
      this.store
        .collection('memories')
        .where('agentId', '==', ownerAgentId)
        .select(
          'id',
          'agentId',
          'category',
          'expiresAt',
          'quarantined',
          'ownerConfirmed',
          'lastConsolidatedAt',
        ) as Query,
      'memories',
      (doc) => {
        const memory = decodeRecord<Records['memories']>(doc.data());
        if (!memory.id || documentKey(memory.id) !== doc.id || memory.agentId !== ownerAgentId)
          throw new Error('Malformed or foreign shell status memory');
        const unexpired = !memory.expiresAt || memory.expiresAt > now;
        if (memory.category !== 'knowledge' || !unexpired) return;
        if (memory.quarantined) {
          awaitingReview += 1;
          return;
        }
        totalUsable += 1;
        if (memory.ownerConfirmed) ownerConfirmed += 1;
        if (!memory.lastConsolidatedAt) {
          notYetOrganized += 1;
        } else if (memory.lastConsolidatedAt instanceof Date) {
          if (!lastOrganizedAt || memory.lastConsolidatedAt > lastOrganizedAt)
            lastOrganizedAt = memory.lastConsolidatedAt;
        }
      },
    );
    return { totalUsable, notYetOrganized, awaitingReview, ownerConfirmed, lastOrganizedAt };
  }
}
