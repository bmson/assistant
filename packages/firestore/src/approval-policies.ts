import {
  type ApprovalPolicyRepository,
  MAX_APPROVAL_POLICY_SNAPSHOT_ROWS,
  type Records,
} from '@assistant/persistence';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

function policyTime(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new Error('Invalid approval policy time');
  return now;
}

export class FirestoreApprovalPolicyRepository implements ApprovalPolicyRepository {
  readonly kind = 'approval-policy-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async list(
    agentId: string,
    options: { toolName?: string; enabledOnly?: boolean } = {},
  ): Promise<Records['approvalPolicies'][]> {
    let query = this.store.collection('approvalPolicies').where('agentId', '==', agentId);
    if (options.toolName !== undefined) query = query.where('toolName', '==', options.toolName);
    if (options.enabledOnly) query = query.where('enabled', '==', true);
    const rows = await query
      .orderBy('toolName', 'asc')
      .orderBy('id', 'asc')
      .limit(MAX_APPROVAL_POLICY_SNAPSHOT_ROWS + 1)
      .get();
    if (rows.size > MAX_APPROVAL_POLICY_SNAPSHOT_ROWS)
      throw new Error('Approval policy list exceeded its row bound');
    return rows.docs.map((row) => decodeRecord<Records['approvalPolicies']>(row.data()));
  }

  async setEnabled(agentId: string, policyId: string, enabled: boolean): Promise<boolean> {
    return this.store.db.runTransaction(async (tx) => {
      const ownerRef = this.store.doc('agents', agentId);
      const owner = await tx.get(ownerRef);
      if (!owner.exists || owner.get('id') !== agentId) return false;
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const ref = this.store.doc('approvalPolicies', policyId);
      const policy = await tx.get(ref);
      if (!policy.exists || policy.get('agentId') !== agentId) return false;
      const now = policyTime(this.store.now());
      tx.update(ownerRef, { updatedAt: now });
      tx.update(ref, encodeRecord({ enabled, updatedAt: now }));
      return true;
    });
  }

  async delete(agentId: string, policyId: string): Promise<boolean> {
    return this.store.db.runTransaction(async (tx) => {
      const ownerRef = this.store.doc('agents', agentId);
      const owner = await tx.get(ownerRef);
      if (!owner.exists || owner.get('id') !== agentId) return false;
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const policyRef = this.store.doc('approvalPolicies', policyId);
      const policy = await tx.get(policyRef);
      if (!policy.exists || policy.get('agentId') !== agentId) return false;
      const mappings = await tx.get(
        this.store.collection('approvalPolicyKeys').where('policyId', '==', policyId),
      );
      tx.update(ownerRef, { updatedAt: this.store.now() });
      tx.delete(policyRef);
      for (const mapping of mappings.docs)
        if (mapping.get('policyId') === policyId) tx.delete(mapping.ref);
      return true;
    });
  }
}
