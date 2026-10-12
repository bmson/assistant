/** Owner-scoped archive state changes for mobile Activity. */
/** Highest value persisted by PostgreSQL's signed 32-bit queue_generation column. */
export const MAX_TASK_QUEUE_GENERATION = 2_147_483_647;

export interface ArchiveOldActivityProgress {
  /** Stable identifier for resuming a bounded archive run. Null for atomic SQL runs. */
  operationId: string | null;
  scannedThisBatch: number;
  archivedThisBatch: number;
  scannedTotal: number;
  archivedTotal: number;
  complete: boolean;
}

export type TaskActivityOutcomeCode =
  | 'cancelled'
  | 'already_cancelled'
  | 'already_terminal'
  | 'retried'
  | 'no_longer_retriable'
  | 'not_found'
  | 'archived'
  | 'already_archived'
  | 'restored'
  | 'already_restored'
  | 'autonomy_revoked'
  | 'already_applied'
  | 'budget_raised';

/** State returned from the same atomic read/write decision that produced an outcome. */
export interface TaskActivityCurrentState {
  id: string;
  status: string;
  queueGeneration: number | null;
  archivedAt: string | null;
  budgetUsdLimit: string | null;
  autonomyRevoked: boolean;
}

export interface TaskActivityCommandOutcome {
  outcome: TaskActivityOutcomeCode;
  transitioned: boolean;
  current: TaskActivityCurrentState | null;
}

/** Explicit Activity selection for an owner-authored pending checklist correction. */
export interface PendingChecklistCorrectionInput {
  taskId: string;
  itemId: string;
  expectedRevision: number;
  /** Stable across an Activity form retry; also becomes the durable owner-message ID. */
  ownerMessageId: string;
  /** Exact direct request clause entered by the owner and stored as the message text. */
  replacementLabel: string;
  replacementKind:
    | 'lookup'
    | 'save'
    | 'card'
    | 'reminder'
    | 'send'
    | 'draft'
    | 'document'
    | 'calendar';
}

export interface PendingChecklistCorrectionOutcome {
  outcome:
    | 'corrected'
    | 'already_applied'
    | 'not_found'
    | 'no_longer_retriable'
    | 'stale_revision'
    | 'unsafe_evidence'
    | 'invalid';
  transitioned: boolean;
  queueGeneration: number | null;
  ownerMessageId: string | null;
}

/** Explicit Activity selection for cancelling one pending checklist item. */
export interface PendingChecklistCancellationInput {
  taskId: string;
  itemId: string;
  expectedRevision: number;
  expectedCancellationRevision: number;
  /** Stable across retries; becomes the durable owner-message ID. */
  ownerMessageId: string;
  /** Present for composer actions; the exact authenticated owner text is preserved. */
  ownerMessageText?: string;
  /** SHA-256 of the action kind and exact owner text; absent for legacy Activity actions. */
  requestHash?: string;
}

export interface PendingChecklistCancellationOutcome {
  outcome:
    | 'cancelled'
    | 'already_cancelled'
    | 'not_found'
    | 'no_longer_retriable'
    | 'stale_revision'
    | 'unsafe_evidence'
    | 'invalid';
  transitioned: boolean;
  queueGeneration: number | null;
  ownerMessageId: string | null;
}

export interface ChecklistCancellationPolicyInput {
  checklist: unknown;
  task: { id: string; agentId: string; conversationId: string };
  binding: PendingChecklistCancellationInput;
  evidence: unknown;
}

export interface ChecklistCancellationPolicy {
  /** Apply the same cancellation rules to PG and Firestore transaction snapshots. */
  cancel(
    input: ChecklistCancellationPolicyInput,
  ):
    | { decision: 'cancelled'; checklist: unknown; ownerMessageText: string }
    | { decision: 'not_found' | 'stale_revision' | 'invalid' | 'unsafe_evidence' };
  /** Match an exact owner-message replay against the durable cancellation audit. */
  matchesReplay(input: {
    checklist: unknown;
    cancellation: PendingChecklistCancellationInput;
    task: { id: string; conversationId: string };
    priorMessage: {
      id: string;
      taskId: string | null;
      conversationId: string | null;
      role: string;
      origin: string;
      text: string;
    };
  }): boolean;
}

/** Transaction-snapshot inputs for the one shared checklist-correction policy. */
export interface ChecklistCorrectionPolicyInput {
  checklist: unknown;
  task: { id: string; agentId: string; conversationId: string };
  ownerMessage: {
    id: string;
    taskId: string;
    agentId: string;
    conversationId: string;
    role: 'user';
    origin: 'owner';
    text: string;
  };
  binding: {
    taskId: string;
    itemId: string;
    expectedRevision: number;
    ownerTaskId: string;
    ownerMessageId: string;
  };
  evidence: unknown;
  replacement: { kind: PendingChecklistCorrectionInput['replacementKind']; label: string };
}

export interface ChecklistCorrectionPolicy {
  /** Validate the stored v1 checklist and expose only the request needed for message binding. */
  readChecklist(value: unknown): {
    checklist: unknown;
    request: string;
    revision: number;
    latestAudit: {
      revision: number;
      taskId: string;
      conversationId: string;
      ownerTaskId: string;
      ownerMessageId: string;
      itemId: string;
      toLabel: string;
      toKind?: PendingChecklistCorrectionInput['replacementKind'];
    } | null;
  } | null;
  /** Match exact Activity-message replay against its durable revision audit entry. */
  matchesReplay(input: {
    checklist: unknown;
    correction: PendingChecklistCorrectionInput;
    task: { id: string; conversationId: string };
    priorMessage: {
      id: string;
      taskId: string | null;
      conversationId: string | null;
      role: string;
      origin: string;
      text: string;
    };
  }): boolean;
  /** Apply the shared pure policy to the immutable state/effect snapshot in the transaction. */
  revise(
    input: ChecklistCorrectionPolicyInput,
  ): { decision: 'revised'; checklist: unknown } | { decision: 'stale_revision' | 'invalid' };
  /** Positive-only final delivery decisions; callers preserve unrecognized correction finals. */
  isRetryableFinal(input: { task: unknown; state: unknown; ownerMessage: unknown }): boolean;
  isUnknownFinal(input: { task: unknown; state: unknown; ownerMessage: unknown }): boolean;
}

const OWNER_CHAT_MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Return the pinned original owner-message ID only for a supported owner chat task. */
export function ownerChatChecklistRequestMessageId(
  task: {
    id: string;
    agentId: string;
    conversationId: string | null;
    goalId?: string | null;
    type: string;
    trust: string;
    trigger: unknown;
  },
  request: string,
): string | null {
  const trigger = task.trigger;
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return null;
  const row = trigger as Record<string, unknown>;
  const payload = row.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const fields = payload as Record<string, unknown>;
  const messageId = fields.triggerMessageId;
  if (
    task.type !== 'chat_turn' ||
    task.trust !== 'owner' ||
    task.goalId != null ||
    !task.conversationId ||
    row.source !== 'chat' ||
    row.agentId !== task.agentId ||
    row.conversationId !== task.conversationId ||
    row.trust !== 'owner' ||
    fields.text !== request ||
    typeof messageId !== 'string' ||
    !OWNER_CHAT_MESSAGE_ID.test(messageId)
  )
    return null;
  return messageId;
}

/** Validate the durable row pinned by the task's original owner chat trigger. */
export function isPinnedOwnerChatRequestMessage(
  task: { id: string; agentId: string; conversationId: string | null },
  message: {
    id: string;
    taskId: string | null;
    conversationId: string;
    role: string;
    origin: string;
    text: string;
  },
  messageId: string,
  request: string,
): boolean {
  return (
    message.id === messageId &&
    message.taskId === task.id &&
    message.conversationId === task.conversationId &&
    message.role === 'user' &&
    message.origin === 'owner' &&
    message.text === request
  );
}

export function taskActivityOutcome(
  outcome: TaskActivityOutcomeCode,
  current: TaskActivityCurrentState | null,
  transitioned = false,
): TaskActivityCommandOutcome {
  return { outcome, transitioned, current };
}

export interface TaskActivityCommandRepository {
  readonly kind: 'task-activity-command-repository';
  archive(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome>;
  restore(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome>;
  retry(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome>;
  revisePendingChecklist(
    agentId: string,
    input: PendingChecklistCorrectionInput,
  ): Promise<PendingChecklistCorrectionOutcome>;
  cancelPendingChecklist(
    agentId: string,
    input: PendingChecklistCancellationInput,
  ): Promise<PendingChecklistCancellationOutcome>;
  cancel(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome>;
  revokeAutonomy(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome>;
  raiseBudget(agentId: string, taskId: string, limit: number): Promise<TaskActivityCommandOutcome>;
  archiveOld(
    agentId: string,
    olderThanDays?: number,
    operationId?: string,
  ): Promise<ArchiveOldActivityProgress>;
}
