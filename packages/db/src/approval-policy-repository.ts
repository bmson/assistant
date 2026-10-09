import {
  type ApprovalPolicyRepository,
  MAX_APPROVAL_POLICY_SNAPSHOT_ROWS,
  type Records,
} from '@assistant/persistence';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { approvalPolicies } from './schema.js';

export async function listApprovalPolicies(
  db: Db,
  agentId: string,
  options: { toolName?: string; enabledOnly?: boolean } = {},
): Promise<Records['approvalPolicies'][]> {
  const rows = await db
    .select()
    .from(approvalPolicies)
    .where(
      and(
        eq(approvalPolicies.agentId, agentId),
        options.toolName === undefined
          ? undefined
          : eq(approvalPolicies.toolName, options.toolName),
        options.enabledOnly === true ? eq(approvalPolicies.enabled, true) : undefined,
      ),
    )
    .orderBy(asc(approvalPolicies.toolName), asc(approvalPolicies.id))
    .limit(MAX_APPROVAL_POLICY_SNAPSHOT_ROWS + 1);
  if (rows.length > MAX_APPROVAL_POLICY_SNAPSHOT_ROWS)
    throw new Error('Approval policy list exceeded its row bound');
  return rows;
}

export async function setApprovalPolicyEnabled(
  db: Db,
  agentId: string,
  policyId: string,
  enabled: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockPostgresPrivacyObservationFence(tx as unknown as Db, agentId);
    const [updated] = await tx
      .update(approvalPolicies)
      .set({ enabled, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(approvalPolicies.agentId, agentId), eq(approvalPolicies.id, policyId)))
      .returning({ id: approvalPolicies.id });
    return Boolean(updated);
  });
}

export async function deleteApprovalPolicy(
  db: Db,
  agentId: string,
  policyId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockPostgresPrivacyObservationFence(tx as unknown as Db, agentId);
    const [deleted] = await tx
      .delete(approvalPolicies)
      .where(and(eq(approvalPolicies.agentId, agentId), eq(approvalPolicies.id, policyId)))
      .returning({ id: approvalPolicies.id });
    return Boolean(deleted);
  });
}

export function createPostgresApprovalPolicyRepository(db: Db): ApprovalPolicyRepository {
  return {
    kind: 'approval-policy-repository',
    list: (agentId, options) => listApprovalPolicies(db, agentId, options),
    setEnabled: (agentId, policyId, enabled) =>
      setApprovalPolicyEnabled(db, agentId, policyId, enabled),
    delete: (agentId, policyId) => deleteApprovalPolicy(db, agentId, policyId),
  };
}
