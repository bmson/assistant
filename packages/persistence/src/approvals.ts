import type {
  OwnerCallGrantOperationRepository,
  OwnerCallOperationBinding,
} from './owner-call-operations.js';
import type { OwnerCallActionGrantMatch } from './phone-call-owner-action-grant.js';
import type { PhoneCallOwnerNumberGrantFinalizationBinding } from './phone-call-owner-number-grant.js';
import type { Records } from './records.js';

export interface OwnerCallActionGrantFinalizationBinding
  extends Omit<PhoneCallOwnerNumberGrantFinalizationBinding, 'match'> {
  match: OwnerCallActionGrantMatch;
  operation: OwnerCallOperationBinding;
}

export interface ResolveApprovalInput {
  approvalId?: string;
  /** SMS path: "YES A7" → shortCode A7. Only matches pending approvals. */
  shortCode?: string;
  decision: 'approved' | 'denied';
  via: 'web' | 'sms';
  /** When provided, resolve only if the linked task belongs to this owner. */
  expectedAgentId?: string;
  /** Edit-then-approve: these args are used at execution instead of the original payload. */
  editedPayload?: Record<string, unknown>;
  /**
   * Always/Never: create a policy from the tool's constrained template.
   * Built by the caller (which has the registry); web-only — never offered via SMS.
   */
  policy?: {
    agentId: string;
    toolName: string;
    templateKey: string;
    match: Record<string, unknown>;
    effect: 'allow' | 'deny';
  };
  /** Dedicated, token-bound path for granting future calls to an approved number. */
  ownerCallNumberGrant?: PhoneCallOwnerNumberGrantFinalizationBinding;
  /** New versioned scope requires a durably admitted operation; legacy grants are untouched. */
  ownerCallActionGrant?: OwnerCallActionGrantFinalizationBinding;
  /** Caller will resume the task itself (used by bounded internal canaries/tests). */
  deferNotification?: boolean;
}

export type ResolveApprovalResult =
  | {
      ok: true;
      taskId: string;
      toolCallId: string;
      approvalId: string;
      ownerCallNumberGrant?: { policyId: string; grantId: string; expiresAt: string };
    }
  | { ok: false; reason: string };

export type ApprovalResolution = ResolveApprovalResult & {
  wake?: { taskId: string; generation: number };
};

export interface ApprovalInboxQuery {
  /** Recent history is ordered by resolvedAt, falling back to expiresAt, then id. */
  recentLimit?: number;
  now?: Date;
}

export interface PendingApprovalItem {
  rememberLabel?: string | null;
  ownerNumberGrantAvailable?: boolean;
  ownerCallSourceFingerprint?: string | null;
  ownerCallAdmissionAvailable?: boolean;
  approval: Records['approvals'];
  taskType: string;
  taskTrust: string;
  toolName: string;
  decision: unknown;
}

/** Resolved history intentionally omits payloads and tool arguments. */
export interface ResolvedApprovalItem {
  /** Exact linked tool identity; permits manual permission recovery without returning payload. */
  toolName?: string;
  approval: Pick<
    Records['approvals'],
    | 'id'
    | 'taskId'
    | 'shortCode'
    | 'summary'
    | 'status'
    | 'requestedAt'
    | 'resolvedAt'
    | 'resolvedVia'
    | 'expiresAt'
  > & { edited: boolean };
  taskType: string;
}

export interface ApprovalInbox {
  pending: PendingApprovalItem[];
  resolved: ResolvedApprovalItem[];
}

export interface ApprovalRepository {
  readonly kind: 'approval-repository';
  /** Durable metadata barrier for the separately reviewed reusable-call flow. No fallback. */
  readonly ownerCallOperations?: OwnerCallGrantOperationRepository;
  /** Commit the gated tool call and approval together; task parking is a separate lease-fenced command. */
  create(input: CreateApprovalInput): Promise<CreatedApproval>;
  /** Read the current owner-scoped approval payload needed to derive a standing policy. */
  getRememberable(agentId: string, approvalId: string): Promise<RememberableApproval | null>;
  /** Current pending owner-call approval and its directly linked owner task/tool call. */
  getOwnerCallNumberGrantReview?(
    agentId: string,
    approvalId: string,
  ): Promise<OwnerCallNumberGrantReview | null>;
  /** Owner-scoped bounded approval screen projection; resolved history excludes payloads. */
  listInbox(agentId: string, options?: ApprovalInboxQuery): Promise<ApprovalInbox>;
  /** A bounded scan may return no eligible notices while its durable cursor still has more pages. */
  listStalledNotices(options?: ApprovalNoticeQuery): Promise<ApprovalNoticeGroup[]>;
  /** Atomically union delivered channels; never remove an earlier successful delivery. */
  markNotified(approvalIds: string[], channels: string[]): Promise<void>;
  resolve(input: ResolveApprovalInput): Promise<ApprovalResolution>;
  /** Each expired approval, tool denial and eligible task wake commit atomically. */
  expireStale(batch?: number, now?: Date): Promise<ApprovalWake[]>;
  /** Recheck the locked task checkpoint and every referenced approval before waking. */
  resumeResolved(batch?: number, now?: Date): Promise<ApprovalWake[]>;
}

export interface RememberableApproval {
  approval: Records['approvals'];
  toolName: string;
}

export interface OwnerCallNumberGrantReview {
  approval: Records['approvals'];
  toolCall: Pick<Records['toolCalls'], 'id' | 'taskId' | 'toolName' | 'args' | 'status'>;
  task: Pick<Records['tasks'], 'id' | 'agentId' | 'trust' | 'status'>;
  ownerTimeZone: string;
  repositoryNow: Date;
  directOwnerRequest: import('./phone-call-owner-number-grant.js').DirectOwnerCallRequestBinding;
  existingActiveGrants: Array<{
    policyId: string;
    match:
      | import('./phone-call-owner-number-grant.js').PhoneCallToOwnerNumberGrantMatch
      | OwnerCallActionGrantMatch;
  }>;
}

export interface ApprovalWake {
  taskId: string;
  generation: number;
}

/** Bound both the sweep query and each parked task's approval reads. */
export function approvalSweepBatch(batch = 200): number {
  if (!Number.isInteger(batch) || batch < 1 || batch > 200)
    throw new Error('Invalid approval sweep batch');
  return batch;
}

/** Malformed or oversized checkpoints must not authorize resuming a task. */
export function parkedApprovalIds(state: unknown): string[] | null {
  const entries = (state as { pendingApprovals?: unknown } | null)?.pendingApprovals;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 200) return null;
  const ids: string[] = [];
  for (const entry of entries) {
    const id = (entry as { approvalId?: unknown } | null)?.approvalId;
    if (typeof id !== 'string' || id.length === 0 || new TextEncoder().encode(id).length > 1000)
      return null;
    ids.push(id);
  }
  return [...new Set(ids)];
}

export function approvalIsResolved(status: unknown): boolean {
  return status === 'approved' || status === 'denied' || status === 'expired';
}

export interface CreateApprovalInput {
  taskId: string;
  step: number;
  toolName: string;
  args: Record<string, unknown>;
  decision: Record<string, unknown>;
  summary: string;
}

export interface CreatedApproval {
  toolCallId: string;
  approvalId: string;
  shortCode: string;
  summary: string;
}

export interface ApprovalNoticeQuery {
  batch?: number;
  olderThanMinutes?: number;
  now?: Date;
}

export interface ApprovalNoticeGroup {
  task: Records['tasks'];
  notices: Array<Records['approvals'] & { toolName: string }>;
}

export function approvalInboxLimit(limit = 20): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error('Invalid approval inbox limit');
  return limit;
}
