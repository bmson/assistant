import {
  isChatAdmissionCancellationProjection,
  type Records,
  type TaskDiscoveryRepository,
  type TaskDiscoveryRow,
} from '@assistant/persistence';
import { FieldPath } from '@google-cloud/firestore';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const fields = [
  'id',
  'agentId',
  'type',
  'status',
  'title',
  'progress',
  'trust',
  'spentUsd',
  'budgetUsdLimit',
  'updatedAt',
  'createdAt',
  'archivedAt',
  'autonomyGrant',
  'conversationId',
  'externalEventId',
  'trigger',
];
export class FirestoreTaskDiscoveryRepository implements TaskDiscoveryRepository {
  readonly driver = 'firestore' as const;
  constructor(readonly store: InstallationStore) {}
  async scan(agentId: string, input: Parameters<TaskDiscoveryRepository['scan']>[1]) {
    if (!agentId || input.limit < 1 || input.limit > 500)
      throw new Error('Invalid owner task scan');
    const owners = await this.store.collection('agents').limit(2).get();
    const owner = owners.docs[0];
    if (
      owners.size !== 1 ||
      !owner ||
      owner.id !== documentKey(agentId) ||
      owner.get('id') !== agentId
    )
      throw new Error('Task discovery requires one matching configured agent');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    let query = this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .orderBy('updatedAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc')
      .select(...fields)
      .limit(input.limit + 1);
    if (input.after) query = query.startAfter(input.after.at, documentKey(input.after.id));
    const snapshot = await query.get();
    const rows: TaskDiscoveryRow[] = [];
    // Preserve the scan boundary even for a canary; it is suppressed in projection.
    for (const doc of snapshot.docs.slice(0, input.limit)) {
      const task = decodeRecord<Records['tasks']>(doc.data());
      if (
        task.agentId !== agentId ||
        documentKey(task.id) !== doc.id ||
        typeof task.id !== 'string' ||
        typeof task.type !== 'string' ||
        typeof task.status !== 'string' ||
        !(task.title === null || typeof task.title === 'string') ||
        typeof task.progress !== 'string' ||
        typeof task.trust !== 'string' ||
        typeof task.spentUsd !== 'string' ||
        typeof task.budgetUsdLimit !== 'string' ||
        !(task.updatedAt instanceof Date) ||
        !Number.isFinite(task.updatedAt.getTime()) ||
        !(
          task.archivedAt === null ||
          (task.archivedAt instanceof Date && Number.isFinite(task.archivedAt.getTime()))
        ) ||
        (task.createdAt != null &&
          (!(task.createdAt instanceof Date) || !Number.isFinite(task.createdAt.getTime())))
      )
        throw new Error('Invalid owner activity task');
      const trigger = task.trigger as { source?: unknown; payload?: { canary?: unknown } } | null;
      rows.push({
        id: task.id,
        suppressed: isChatAdmissionCancellationProjection(task),
        agentId,
        type: task.type,
        status:
          trigger?.payload?.canary === true || trigger?.payload?.canary === 'true'
            ? '__canary__'
            : task.status,
        title: task.title,
        progress: task.progress,
        trust: task.trust,
        spentUsd: task.spentUsd,
        budgetUsdLimit: task.budgetUsdLimit,
        updatedAt: task.updatedAt,
        createdAt: task.createdAt ?? null,
        archivedAt: task.archivedAt,
        autonomyGrant: task.autonomyGrant,
        conversationId: task.conversationId ?? null,
        source: typeof trigger?.source === 'string' ? trigger.source : 'unknown',
        externalEventId: task.externalEventId ?? null,
      });
    }
    const owned = this.store.collection('tasks').where('agentId', '==', agentId);
    const [all, current, pending] = await Promise.all([
      owned.count().get(),
      owned.where('archivedAt', '==', null).count().get(),
      Promise.all(
        rows
          .filter((row) => row.status === 'waiting_approval')
          .map(async (row) => {
            const records = await this.store
              .collection('approvals')
              .where('taskId', '==', row.id)
              .where('status', '==', 'pending')
              .select('taskId')
              .limit(1)
              .get();
            return records.empty ? null : row.id;
          }),
      ),
    ]);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return {
      rows,
      hasMore: snapshot.size > input.limit,
      archivedCount: all.data().count - current.data().count,
      pendingApprovalTaskIds: pending.filter((id): id is string => id !== null),
    };
  }
}
