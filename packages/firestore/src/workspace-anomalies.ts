import type { WorkspaceAnomalyRecord, WorkspaceAnomalyRepository } from '@assistant/persistence';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const MAX_OWNER_ANOMALIES = 2_000;
const MOBILE_RESULT_LIMIT = 100;
const FIELDS = [
  'id',
  'agentId',
  'status',
  'kind',
  'toolName',
  'detail',
  'observed',
  'expected',
  'toolCallIds',
  'policyId',
  'createdAt',
] as const;

function fromDocument(
  value: unknown,
  documentId: string,
  agentId: string,
): WorkspaceAnomalyRecord | null {
  const row = decodeRecord<Record<string, unknown>>(value);
  if (
    row.agentId !== agentId ||
    typeof row.id !== 'string' ||
    documentKey(row.id) !== documentId ||
    !['open', 'dismissed', 'suspended'].includes(String(row.status))
  )
    throw new Error('Invalid owner anomaly document');
  if (row.status !== 'open') return null;
  if (
    !['frequency', 'off_hours', 'burst'].includes(String(row.kind)) ||
    typeof row.toolName !== 'string' ||
    typeof row.detail !== 'string' ||
    !Number.isSafeInteger(row.observed) ||
    Number(row.observed) < 0 ||
    !Number.isSafeInteger(row.expected) ||
    Number(row.expected) < 0 ||
    !Array.isArray(row.toolCallIds) ||
    !row.toolCallIds.every((id) => typeof id === 'string') ||
    !(row.policyId === null || typeof row.policyId === 'string') ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime())
  )
    throw new Error('Invalid open anomaly document');
  return {
    id: row.id,
    kind: row.kind as WorkspaceAnomalyRecord['kind'],
    toolName: row.toolName,
    detail: row.detail,
    observed: row.observed as number,
    expected: row.expected as number,
    toolCallIds: row.toolCallIds,
    policyId: row.policyId,
    createdAt: row.createdAt,
  };
}

/** Reads only actionable rows so dismissed history cannot exhaust the workspace bound. */
export class FirestoreWorkspaceAnomalyRepository implements WorkspaceAnomalyRepository {
  readonly kind = 'workspace-anomaly-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async listOpenPage(agentId: string, input: { afterId?: string; limit: number }) {
    const limit = boundedPageSize(input.limit);
    if (!agentId) throw new Error('agent is required');
    if (input.afterId !== undefined && !/^[0-9a-f-]{36}$/i.test(input.afterId))
      throw new Error('Invalid anomaly continuation');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    let query = this.store
      .collection('anomalies')
      .where('agentId', '==', agentId)
      .where('status', '==', 'open')
      .orderBy('id', 'asc')
      .select(...FIELDS);
    if (input.afterId) query = query.startAfter(input.afterId);
    const snapshot = await query.limit(limit + 1).get();
    const page = snapshot.docs
      .slice(0, limit)
      .map((doc) => fromDocument(doc.data(), doc.id, agentId))
      .filter((row): row is WorkspaceAnomalyRecord => row !== null);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return {
      items: page,
      hasMore: snapshot.size > limit,
      nextCursor: snapshot.size > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async listOpen(agentId: string): Promise<WorkspaceAnomalyRecord[]> {
    if (!agentId) throw new Error('agent is required');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store
      .collection('anomalies')
      .where('agentId', '==', agentId)
      .where('status', '==', 'open')
      .select(...FIELDS)
      .limit(MAX_OWNER_ANOMALIES + 1)
      .get();
    if (snapshot.size > MAX_OWNER_ANOMALIES)
      throw new Error('Owner anomalies exceed the mobile workspace scan limit');
    const result = snapshot.docs
      .map((doc) => fromDocument(doc.data(), doc.id, agentId))
      .filter((row): row is WorkspaceAnomalyRecord => row !== null)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id),
      )
      .slice(0, MOBILE_RESULT_LIMIT);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return result;
  }

  /** Dismiss an owner anomaly in the same way as the PostgreSQL dashboard action. */
  dismiss(agentId: string, anomalyId: string): Promise<boolean> {
    return this.updateStatus(agentId, anomalyId, 'dismissed');
  }

  /** Disable the linked owner policy and mark its anomaly acted on atomically. */
  suspendPolicy(agentId: string, anomalyId: string): Promise<boolean> {
    return this.updateStatus(agentId, anomalyId, 'suspended', true);
  }

  private async updateStatus(
    agentId: string,
    anomalyId: string,
    status: 'dismissed' | 'suspended',
    suspendPolicy = false,
  ): Promise<boolean> {
    if (!agentId) throw new Error('agent is required');
    if (!anomalyId) throw new Error('anomaly is required');
    const anomalyRef = this.store.doc('anomalies', anomalyId);
    const erasureRef = this.store.doc('privacyErasureJobs', agentId);
    return this.store.db.runTransaction(async (tx) => {
      const ownerRef = this.store.doc('agents', agentId);
      const owner = await tx.get(ownerRef);
      if (!owner.exists || owner.get('id') !== agentId) return false;
      const [anomaly, erasure] = await tx.getAll(anomalyRef, erasureRef);
      if (erasure?.exists) {
        if (erasure.get('agentId') !== agentId || erasure.get('status') !== 'complete')
          throw new Error('Privacy erasure is in progress');
      }
      if (!anomaly?.exists) return false;
      if (
        anomaly.get('agentId') !== agentId ||
        anomaly.get('id') !== anomalyId ||
        documentKey(anomalyId) !== anomaly.id
      )
        return false;

      const policyId = anomaly.get('policyId');
      let policy: FirebaseFirestore.DocumentSnapshot | null = null;
      if (suspendPolicy && policyId !== null && policyId !== undefined) {
        if (typeof policyId !== 'string' || !policyId)
          throw new Error('Anomaly policy link is invalid');
        const policyRef = this.store.doc('approvalPolicies', policyId);
        policy = await tx.get(policyRef);
        if (
          policy.exists &&
          (policy.get('agentId') !== agentId ||
            policy.get('id') !== policyId ||
            documentKey(policyId) !== policy.id)
        )
          throw new Error('Anomaly policy belongs to another owner');
      }

      const now = this.store.now();
      if (policy?.exists) {
        tx.update(ownerRef, { updatedAt: now });
        tx.update(policy.ref, encodeRecord({ enabled: false, updatedAt: now }));
      }
      tx.update(anomaly.ref, encodeRecord({ status, updatedAt: now }));
      return true;
    });
  }
}

function boundedPageSize(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Workspace page size must be between 1 and 100');
  return limit;
}
