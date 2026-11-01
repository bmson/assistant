import { loadConfig } from '@assistant/config';
import { approvalRule } from '@assistant/core/approval-rule';

import { getAgent } from '@assistant/core/chat';
import {
  type ApprovalInbox,
  type ApprovalRepository,
  listApprovalInbox as listApprovalInboxWorkflow,
  type ResolveApprovalResult,
  resolveApproval,
} from '@assistant/core/workflow/approvals';
import { createPostgresApprovalRepository, type Db } from '@assistant/db';

export { approvalRule } from '@assistant/core/approval-rule';

export type ApprovalDecision = 'approved' | 'denied';

/** Persistence-independent approval data consumed by presentation adapters. */
export interface ApprovalSnapshot {
  id: string;
  taskId: string;
  shortCode: string;
  summary: string;
  payload: unknown;
  resolutionPayload: unknown;
  status: string;
  requestedAt: Date;
  resolvedAt: Date | null;
  resolvedVia: string | null;
  expiresAt: Date;
}

export type {
  ApprovalInbox,
  PendingApprovalItem,
  ResolvedApprovalItem,
} from '@assistant/core/workflow/approvals';

export interface ApprovalInboxStore {
  agentId: string;
  approvals: ApprovalRepository;
}

export interface ApprovalRememberStore {
  agentId: string;
  approvals: ApprovalRepository;
}

/**
 * Load the complete approvals screen projection. Keeping this query here means
 * the UI knows the use case and view shape, not tables, joins, or SQL rules.
 */
export async function listApprovalInbox(
  store: Db | ApprovalInboxStore,
  recentLimit = 20,
  now = new Date(),
): Promise<ApprovalInbox> {
  const inbox = await (async () => {
    if ('approvals' in store) {
      return listApprovalInboxWorkflow(store.approvals, store.agentId, {
        recentLimit,
        now,
      });
    }
    const agent = await getAgent(store);
    return listApprovalInboxWorkflow(store, agent.id, {
      recentLimit,
      now,
    });
  })();
  return {
    ...inbox,
    pending: inbox.pending.map((item) => ({
      ...item,
      rememberLabel: approvalRule(item.toolName, item.approval.payload)?.label ?? null,
      ownerNumberGrantAvailable:
        loadConfig().PHONE_CALL_TO_OWNER_GRANT_ENABLED &&
        item.taskTrust === 'owner' &&
        item.ownerCallAdmissionAvailable === true &&
        item.toolName === 'phone.call' &&
        item.approval.expiresAt > now,
    })),
  };
}

/** Resolve one owner decision through the durable approval workflow. */
export function decideApproval(
  store: Db | ApprovalRememberStore,
  approvalId: string,
  decision: ApprovalDecision,
  editedPayload?: Record<string, unknown>,
): Promise<ResolveApprovalResult> {
  const portableStore = 'approvals' in store ? store : undefined;
  const repository: Db | ApprovalRepository = portableStore
    ? portableStore.approvals
    : (store as Db);
  return resolveApproval(repository, {
    approvalId,
    decision,
    via: 'web',
    ...(portableStore ? { expectedAgentId: portableStore.agentId } : {}),
    ...(editedPayload ? { editedPayload } : {}),
  });
}

/** Resolve a bounded group while preserving a failure result for every item. */
export async function decideApprovals(
  store: Db | ApprovalRememberStore,
  approvalIds: readonly string[],
  decision: ApprovalDecision,
): Promise<Array<{ approvalId: string; error: string }>> {
  const failures: Array<{ approvalId: string; error: string }> = [];
  for (const approvalId of approvalIds.slice(0, 20)) {
    const result = await decideApproval(store, approvalId, decision);
    if (!result.ok) failures.push({ approvalId, error: result.reason });
  }
  return failures;
}

export interface RememberedApprovalPolicy {
  agentId: string;
  toolName: string;
  templateKey: string;
  match: Record<string, unknown>;
  effect: 'allow';
}

/** Derive a bounded rule from the current, owner-scoped approval payload. */
export function rememberedApprovalPolicy(
  agentId: string,
  toolName: string,
  payload: unknown,
): RememberedApprovalPolicy | null {
  const rule = approvalRule(toolName, payload);
  if (!rule) return null;
  const { label: _label, ...policy } = rule;
  return { agentId, ...policy };
}

/** Approve once, remembering its supported scoped rule. */
export async function approveAndRememberApproval(
  store: Db | ApprovalRememberStore,
  approvalId: string,
): Promise<ResolveApprovalResult> {
  const portable = 'approvals' in store && 'agentId' in store;
  const repository = portable ? store.approvals : createPostgresApprovalRepository(store as Db);
  const agentId = portable ? store.agentId : (await getAgent(store as Db)).id;
  const row = await repository.getRememberable(agentId, approvalId);
  if (!row) {
    return { ok: false, reason: 'no pending approval matched (already resolved or expired?)' };
  }

  const policy = rememberedApprovalPolicy(agentId, row.toolName, row.approval.payload);
  if (!policy)
    return {
      ok: false,
      reason: 'This action does not support a standing approval. Approve it once instead.',
    };
  return resolveApproval(repository, {
    approvalId,
    decision: 'approved',
    via: 'web',
    ...(portable ? { expectedAgentId: agentId } : {}),
    ...(policy ? { policy } : {}),
  });
}

/** Existing composition seam shared by dedicated owner-call review and ordinary decisions. */
export type ApprovalDecisionStore = Db | ApprovalRememberStore;
export async function ownerApprovalRepository(
  store: ApprovalDecisionStore,
): Promise<ApprovalRememberStore> {
  if ('approvals' in store) return store;
  return {
    agentId: (await getAgent(store)).id,
    approvals: createPostgresApprovalRepository(store),
  };
}
