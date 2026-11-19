import {
  createPostgresApprovalPolicyRepository,
  createPostgresApprovalRepository,
  type Db,
  type TaskRow,
} from '@assistant/db';
import type {
  ApprovalInbox,
  ApprovalInboxQuery,
  ApprovalPolicyRepository,
  ApprovalRepository,
  CreateApprovalInput,
  MessageRepository,
  Records,
  ResolveApprovalInput,
  ResolveApprovalResult,
} from '@assistant/persistence';
import { approvalHeadline, approvalPrompt } from '../owner-text.js';
import { getQueueNotifier } from '../queue.js';
import { postConversationNotice } from './executor/notices.js';

export type {
  ApprovalInbox,
  ApprovalInboxQuery,
  ApprovalRepository,
  PendingApprovalItem,
  ResolveApprovalInput,
  ResolveApprovalResult,
  ResolvedApprovalItem,
} from '@assistant/persistence';

export function createApproval(store: Db | ApprovalRepository, input: CreateApprovalInput) {
  const repository =
    'kind' in store && store.kind === 'approval-repository'
      ? (store as ApprovalRepository)
      : createPostgresApprovalRepository(store as Db);
  return repository.create(input);
}

/** Read the owner-scoped approval screen through the selected persistence adapter. */
export function listApprovalInbox(
  store: Db | ApprovalRepository,
  agentId: string,
  options?: ApprovalInboxQuery,
): Promise<ApprovalInbox> {
  const repository =
    'kind' in store && store.kind === 'approval-repository'
      ? (store as ApprovalRepository)
      : createPostgresApprovalRepository(store as Db);
  return repository.listInbox(agentId, options);
}

/**
 * Resolve a pending approval. Idempotent: the status-guarded UPDATE means a
 * double-tap (or a YES both in web and SMS) resolves exactly once.
 */
export async function resolveApproval(
  store: Db | ApprovalRepository,
  input: ResolveApprovalInput,
): Promise<ResolveApprovalResult> {
  const repository =
    'kind' in store && store.kind === 'approval-repository'
      ? (store as ApprovalRepository)
      : createPostgresApprovalRepository(store as Db);
  const { wake, ...result } = await repository.resolve(input);
  if (wake && !input.deferNotification) getQueueNotifier().notify(wake.taskId, wake.generation);
  return result;
}

/**
 * Which delivery legs of a park notice actually landed. Only a leg that
 * succeeded may be stamped: renotifyStalledApprovals() repairs whatever is
 * missing, so recording a conversation write that in fact failed retires the
 * backstop and strands the approval with no card in the chat — invisible to
 * the owner until the 24h expiry, and unrecoverable by a page reload.
 */
export function deliveredChannels(input: {
  ownerNotified: boolean;
  conversationNotified: boolean;
}): string[] {
  return [
    ...(input.ownerNotified ? ['owner'] : []),
    ...(input.conversationNotified ? ['conversation'] : []),
  ];
}

/**
 * Record which park notices for these approvals actually reached the owner. An
 * approval still missing the 'conversation' leg after a grace period was parked
 * by a worker that crashed — or whose conversation write failed — between the
 * park commit and the notices; renotifyStalledApprovals() re-emits those.
 *
 * Each stamp adds delivered channels atomically, preserving earlier successes.
 */
export async function markApprovalsNotified(
  store: Db | ApprovalRepository,
  approvalIds: string[],
  channels: string[],
): Promise<void> {
  if (approvalIds.length === 0 || channels.length === 0) return;
  const repository =
    'kind' in store && store.kind === 'approval-repository'
      ? (store as ApprovalRepository)
      : createPostgresApprovalRepository(store as Db);
  await repository.markNotified(approvalIds, channels);
}

export interface ApprovalNoticeStore {
  approvals: ApprovalRepository;
  messages: MessageRepository;
}

/**
 * Sweep backstop for a crash between approval park and notify: the task sits
 * in waiting_approval with a pending approval row, but no SMS/email/dashboard
 * notice ever went out — silent until the 24h expiry. Re-emit the notices for
 * any un-notified pending approval older than the grace window, then stamp it.
 * At-least-once safe: a concurrent stamp just makes the next sweep skip it.
 */
export async function renotifyStalledApprovals(
  store: Db | ApprovalNoticeStore,
  notifyApproval?: (
    task: TaskRow,
    notices: Array<{ taskId: string; shortCode: string; summary: string; toolName?: string }>,
  ) => Promise<void>,
  opts: { olderThanMinutes?: number; batch?: number } = {},
): Promise<number> {
  const portable = 'approvals' in store;
  const repository = portable ? store.approvals : createPostgresApprovalRepository(store);
  const messages = portable ? store.messages : store;
  const groups = await repository.listStalledNotices(opts);

  let renotified = 0;
  for (const { task, notices } of groups) {
    try {
      const missingOwner = notices.filter(
        (approval) => !approval.notifiedChannels.includes('owner'),
      );
      if (notifyApproval && missingOwner.length > 0) {
        await notifyApproval(
          task,
          missingOwner.map((approval) => ({
            taskId: task.id,
            shortCode: approval.shortCode,
            summary: approval.summary,
            toolName: approval.toolName,
          })),
        );
        // Persist this successful leg before attempting the conversation write.
        // A failed chat write must not make the next repair send the owner ping again.
        await repository.markNotified(
          missingOwner.map((approval) => approval.id),
          ['owner'],
        );
      }
      if (task.conversationId) {
        const delivered = await postConversationNotice(
          messages,
          task,
          approvalPrompt(notices.map((approval) => approvalHeadline(approval.summary))),
          notices.map((approval) => ({
            type: 'approval',
            approvalId: approval.id,
            shortCode: approval.shortCode,
            summary: approvalHeadline(approval.summary),
          })),
        );
        if (!delivered) continue;
      }
      // No conversation means no chat card is owed. Otherwise the append above
      // succeeded. Union this leg with any already-stamped owner delivery.
      await repository.markNotified(
        notices.map((approval) => approval.id),
        ['conversation'],
      );
      renotified += notices.length;
    } catch (err) {
      // Preserve any successful leg; the next sweep retries the remaining delivery.
      console.error('approval re-notification failed', { taskId: task.id }, err);
    }
  }
  return renotified;
}

/**
 * Backstop for the pre-park race: an approval resolved in the narrow window
 * between its row being created and the task transitioning to waiting_approval
 * fires a wake that finds the task still 'running' and no-ops, stranding it in
 * waiting_approval forever. Resume any waiting_approval task whose parked
 * approvals are ALL resolved (nothing still pending) — so a task genuinely
 * waiting on a human is never woken early, but a stranded one recovers on the
 * next bounded scan cycle. Each repository rechecks and atomically wakes the task.
 */
export async function resumeResolvedApprovalTasks(
  store: Db | ApprovalRepository,
  batch = 200,
  now?: Date,
): Promise<string[]> {
  const portable = 'kind' in store && store.kind === 'approval-repository';
  const repository = portable
    ? (store as ApprovalRepository)
    : createPostgresApprovalRepository(store as Db);
  const wakes = await repository.resumeResolved(batch, now);
  if (!portable) for (const wake of wakes) getQueueNotifier().notify(wake.taskId, wake.generation);
  return wakes.map((wake) => wake.taskId);
}

/**
 * Sweep: expire stale pending approvals and wake their tasks so the model
 * learns the approval expired (instead of the task dying silently).
 */
export async function expireStaleApprovals(
  store: Db | ApprovalRepository,
  batch = 200,
  now?: Date,
): Promise<string[]> {
  const portable = 'kind' in store && store.kind === 'approval-repository';
  const repository = portable
    ? (store as ApprovalRepository)
    : createPostgresApprovalRepository(store as Db);
  const wakes = await repository.expireStale(batch, now);
  if (!portable) for (const wake of wakes) getQueueNotifier().notify(wake.taskId, wake.generation);
  return wakes.map((wake) => wake.taskId);
}

export type { ApprovalPolicyRepository } from '@assistant/persistence';
export type ApprovalPolicy = Records['approvalPolicies'];
export type ApprovalPolicyStore = Db | ApprovalPolicyRepository;

function policyRepository(store: ApprovalPolicyStore): ApprovalPolicyRepository {
  return 'kind' in store && store.kind === 'approval-policy-repository'
    ? (store as ApprovalPolicyRepository)
    : createPostgresApprovalPolicyRepository(store as Db);
}

export function listApprovalPolicies(
  store: ApprovalPolicyStore,
  agentId: string,
  options?: { toolName?: string; enabledOnly?: boolean },
) {
  return policyRepository(store).list(agentId, options);
}

export function setApprovalPolicyEnabledForAgent(
  store: ApprovalPolicyStore,
  agentId: string,
  policyId: string,
  enabled: boolean,
) {
  return policyRepository(store).setEnabled(agentId, policyId, enabled);
}

export function deleteApprovalPolicyForAgent(
  store: ApprovalPolicyStore,
  agentId: string,
  policyId: string,
) {
  return policyRepository(store).delete(agentId, policyId);
}
