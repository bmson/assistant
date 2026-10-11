import { getAgent } from '@assistant/core/chat';
import { getQueueNotifier } from '@assistant/core/queue';
import {
  isParkedUnknownChecklistCorrectionFinal,
  isRetryableChecklistCorrectionFinal,
} from '@assistant/core/workflow/checklist-correction-resume';
import { revisePendingRequestChecklistItem } from '@assistant/core/workflow/request-checklist';
import { RequestChecklistSchema } from '@assistant/core/workflow/request-checklist-schema';
import {
  approvals,
  conversations,
  type Db,
  messages,
  notChatAdmissionCancellationSql,
  tasks,
  toolCallReceipts,
  toolCalls,
} from '@assistant/db';
import type {
  ArchiveOldActivityProgress,
  ChecklistCorrectionPolicy,
  PendingChecklistCorrectionInput,
  PendingChecklistCorrectionOutcome,
  Records,
  TaskActivityCommandOutcome,
  TaskActivityCommandRepository,
  TaskActivityCurrentState,
} from '@assistant/persistence';
import {
  chatAdmissionCancellationPayload,
  completeChecklistCorrectionEvidence,
  isPinnedOwnerChatRequestMessage,
  MAX_CHECKLIST_CORRECTION_LEDGER_ROWS,
  normalizeTaskBudget,
  ownerChatChecklistRequestMessageId,
  taskActivityOutcome,
} from '@assistant/persistence';
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import { terminalTaskStatuses } from './queries.js';

const WAKEABLE = new Set([
  'waiting_approval',
  'waiting_event',
  'sleeping',
  'waiting_budget',
  'needs_attention',
]);

function currentTask(task: typeof tasks.$inferSelect): TaskActivityCurrentState {
  const grant = task.autonomyGrant as Record<string, unknown> | null;
  return {
    id: task.id,
    status: task.status,
    queueGeneration: Number.isSafeInteger(task.queueGeneration) ? task.queueGeneration : null,
    archivedAt: task.archivedAt?.toISOString() ?? null,
    budgetUsdLimit: task.budgetUsdLimit,
    autonomyRevoked: Boolean(grant?.revokedAt),
  };
}

function notifyWake(taskId: string, generation: number): void {
  try {
    getQueueNotifier().notify(taskId, generation);
  } catch {
    // The durable task row and periodic sweeper remain authoritative if a
    // best-effort transport notification fails after the mutation commits.
  }
}

export async function retryActivity(db: Db, taskId: string): Promise<TaskActivityCommandOutcome> {
  const agent = await getAgent(db);
  const outcome = await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
      .limit(1)
      .for('update');
    if (!task || chatAdmissionCancellationPayload(task))
      return taskActivityOutcome('not_found', null);
    if (!WAKEABLE.has(task.status))
      return taskActivityOutcome(
        ['done', 'failed', 'cancelled'].includes(task.status)
          ? 'already_terminal'
          : 'no_longer_retriable',
        currentTask(task),
      );
    if (!Number.isSafeInteger(task.queueGeneration) || task.queueGeneration < 0)
      throw new Error('Invalid task queue generation');
    const state =
      task.state && typeof task.state === 'object' && !Array.isArray(task.state)
        ? { ...(task.state as Record<string, unknown>) }
        : task.state;
    let preserveCorrectionFinal = false;
    let parkUnknownCorrectionFinal = false;
    if (task.status === 'needs_attention' && state && typeof state === 'object') {
      const pendingFinal = (state as Record<string, unknown>).pendingFinal;
      const hasCorrectionFinal = Boolean(
        pendingFinal &&
          typeof pendingFinal === 'object' &&
          Object.hasOwn(pendingFinal, 'checklistCorrection'),
      );
      const correction = hasCorrectionFinal
        ? (pendingFinal as Record<string, unknown>).checklistCorrection
        : undefined;
      const ownerMessageId =
        correction && typeof correction === 'object' && !Array.isArray(correction)
          ? (correction as Record<string, unknown>).ownerMessageId
          : undefined;
      if (hasCorrectionFinal && (typeof ownerMessageId !== 'string' || !task.conversationId))
        return taskActivityOutcome('no_longer_retriable', currentTask(task));
      if (typeof ownerMessageId === 'string' && task.conversationId) {
        const [ownedConversation] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(eq(conversations.id, task.conversationId), eq(conversations.agentId, task.agentId)),
          )
          .limit(1);
        const [ownerMessage] = await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.id, ownerMessageId),
              eq(messages.taskId, task.id),
              eq(messages.conversationId, task.conversationId),
              eq(messages.role, 'user'),
              eq(messages.origin, 'owner'),
              isNull(messages.hiddenAt),
            ),
          )
          .limit(1);
        preserveCorrectionFinal = Boolean(
          ownedConversation &&
            ownerMessage &&
            taskActivityChecklistCorrectionPolicy.isRetryableFinal({
              task,
              state,
              ownerMessage: { ...ownerMessage, agentId: task.agentId },
            }),
        );
        parkUnknownCorrectionFinal = Boolean(
          ownedConversation &&
            ownerMessage &&
            taskActivityChecklistCorrectionPolicy.isUnknownFinal({
              task,
              state,
              ownerMessage: { ...ownerMessage, agentId: task.agentId },
            }),
        );
      }
      if (hasCorrectionFinal && (parkUnknownCorrectionFinal || !preserveCorrectionFinal))
        return taskActivityOutcome('no_longer_retriable', currentTask(task));
      if (!preserveCorrectionFinal) delete (state as Record<string, unknown>).pendingFinal;
    }
    const now = new Date();
    const [updated] = await tx
      .update(tasks)
      .set({
        status: 'pending',
        ...(state === undefined ? {} : { state }),
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        queueGeneration: task.queueGeneration + 1,
        attempt: 0,
        attentionNotifiedAt: null,
        updatedAt: now,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id), eq(tasks.status, task.status)))
      .returning();
    if (!updated) return taskActivityOutcome('no_longer_retriable', currentTask(task));
    return taskActivityOutcome('retried', currentTask(updated), true);
  });
  if (outcome.outcome === 'retried' && outcome.current && outcome.current.queueGeneration !== null)
    notifyWake(taskId, outcome.current.queueGeneration);
  return outcome;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared pure checklist policy injected into storage adapters at composition time. */
export const taskActivityChecklistCorrectionPolicy: ChecklistCorrectionPolicy = {
  readChecklist(value) {
    const parsed = RequestChecklistSchema.safeParse(value);
    return parsed.success
      ? {
          checklist: parsed.data,
          request: parsed.data.request,
          revision: parsed.data.revision ?? 0,
          latestAudit: parsed.data.revisionAudit?.at(-1) ?? null,
        }
      : null;
  },
  matchesReplay({ checklist: value, correction, task, priorMessage }) {
    const parsed = RequestChecklistSchema.safeParse(value);
    if (!parsed.success) return false;
    const audit = parsed.data.revisionAudit?.find(
      (entry) => entry.ownerMessageId === correction.ownerMessageId,
    );
    return (
      priorMessage.id === correction.ownerMessageId &&
      priorMessage.taskId === correction.taskId &&
      priorMessage.conversationId === task.conversationId &&
      priorMessage.role === 'user' &&
      priorMessage.origin === 'owner' &&
      priorMessage.text === correction.replacementLabel &&
      audit?.itemId === correction.itemId &&
      audit.toLabel === correction.replacementLabel &&
      audit.toKind === correction.replacementKind &&
      audit.revision === correction.expectedRevision + 1 &&
      audit.taskId === task.id &&
      audit.conversationId === task.conversationId &&
      audit.ownerTaskId === task.id
    );
  },
  revise(input) {
    const parsed = RequestChecklistSchema.safeParse(input.checklist);
    if (!parsed.success) return { decision: 'invalid' };
    const checklist = revisePendingRequestChecklistItem(parsed.data, {
      task: input.task,
      ownerMessage: input.ownerMessage,
      binding: input.binding,
      evidence: input.evidence as Parameters<
        typeof revisePendingRequestChecklistItem
      >[1]['evidence'],
      replacement: input.replacement,
    });
    if (checklist !== parsed.data) return { decision: 'revised', checklist };
    return {
      decision:
        input.binding.expectedRevision !== (parsed.data.revision ?? 0)
          ? 'stale_revision'
          : 'invalid',
    };
  },
  isRetryableFinal(input) {
    return isRetryableChecklistCorrectionFinal(
      input as Parameters<typeof isRetryableChecklistCorrectionFinal>[0],
    );
  },
  isUnknownFinal(input) {
    return isParkedUnknownChecklistCorrectionFinal(
      input as Parameters<typeof isParkedUnknownChecklistCorrectionFinal>[0],
    );
  },
};

function checklistCorrectionOutcome(
  outcome: PendingChecklistCorrectionOutcome['outcome'],
  queueGeneration: number | null = null,
  ownerMessageId: string | null = null,
  transitioned = false,
): PendingChecklistCorrectionOutcome {
  return { outcome, transitioned, queueGeneration, ownerMessageId };
}

/**
 * Persist an explicitly selected, owner-authored checklist correction as one
 * task-locked transaction. No chat/model text is used to select the target.
 */
export async function revisePendingChecklistActivity(
  db: Db,
  agentId: string,
  input: PendingChecklistCorrectionInput,
): Promise<PendingChecklistCorrectionOutcome> {
  const owner = await getAgent(db);
  if (owner.id !== agentId) return checklistCorrectionOutcome('not_found');
  if (
    !UUID.test(input.taskId) ||
    !UUID.test(input.ownerMessageId) ||
    !input.itemId ||
    input.itemId.length > 128 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !input.replacementLabel ||
    input.replacementLabel.length > 500
  )
    return checklistCorrectionOutcome('invalid');

  const outcome = await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.agentId, agentId)))
      .limit(1)
      .for('update');
    if (!task || chatAdmissionCancellationPayload(task))
      return checklistCorrectionOutcome('not_found');
    if (!task.conversationId) return checklistCorrectionOutcome('invalid');

    const state =
      task.state && typeof task.state === 'object' && !Array.isArray(task.state)
        ? ({ ...(task.state as Record<string, unknown>) } as Record<string, unknown>)
        : null;
    const parsed = taskActivityChecklistCorrectionPolicy.readChecklist(state?.requestChecklist);
    if (!parsed) return checklistCorrectionOutcome('invalid');
    const checklist = parsed.checklist as ReturnType<typeof RequestChecklistSchema.parse>;

    const originalMessageId = ownerChatChecklistRequestMessageId(task, parsed.request);
    if (!originalMessageId) return checklistCorrectionOutcome('unsafe_evidence');
    const [originalMessage] = await tx
      .select()
      .from(messages)
      .where(eq(messages.id, originalMessageId))
      .limit(1);
    if (
      !originalMessage ||
      !isPinnedOwnerChatRequestMessage(task, originalMessage, originalMessageId, parsed.request)
    )
      return checklistCorrectionOutcome('unsafe_evidence');

    // The task lock makes same-message retries observe the already committed audit.
    const [priorMessage] = await tx
      .select()
      .from(messages)
      .where(eq(messages.id, input.ownerMessageId))
      .limit(1);
    if (priorMessage) {
      if (
        taskActivityChecklistCorrectionPolicy.matchesReplay({
          checklist,
          correction: input,
          task: { id: task.id, conversationId: task.conversationId },
          priorMessage,
        })
      )
        return checklistCorrectionOutcome(
          'already_applied',
          Number.isSafeInteger(task.queueGeneration) ? task.queueGeneration : null,
          priorMessage.id,
        );
      return checklistCorrectionOutcome('invalid');
    }

    if (
      task.status !== 'needs_attention' ||
      task.leaseToken !== null ||
      task.lockedUntil !== null ||
      task.archivedAt !== null
    )
      return checklistCorrectionOutcome('no_longer_retriable');
    if (!Number.isSafeInteger(task.queueGeneration) || task.queueGeneration < 0)
      return checklistCorrectionOutcome('invalid');
    if (state?.pendingApprovalId || state?.pendingJob != null || state?.pendingToolBatch != null)
      return checklistCorrectionOutcome('unsafe_evidence');

    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, task.conversationId), eq(conversations.agentId, agentId)))
      .limit(1);
    if (!conversation) return checklistCorrectionOutcome('not_found');
    const [pendingApproval] = await tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.taskId, task.id), inArray(approvals.status, ['pending', 'approved'])))
      .limit(1);
    if (pendingApproval) return checklistCorrectionOutcome('unsafe_evidence');

    const calls = await tx
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.taskId, task.id))
      .orderBy(toolCalls.step, toolCalls.createdAt, toolCalls.id)
      .limit(MAX_CHECKLIST_CORRECTION_LEDGER_ROWS + 1);
    const rawReceipts = await tx
      .select()
      .from(toolCallReceipts)
      // Scope by task alone so a corrupted receipt with a foreign agent ID cannot
      // disappear from the effect history; the shared validator checks both IDs.
      .where(eq(toolCallReceipts.taskId, task.id))
      .orderBy(toolCallReceipts.recordedAt, toolCallReceipts.id)
      .limit(MAX_CHECKLIST_CORRECTION_LEDGER_ROWS + 1);
    if (
      calls.length > MAX_CHECKLIST_CORRECTION_LEDGER_ROWS ||
      rawReceipts.length > MAX_CHECKLIST_CORRECTION_LEDGER_ROWS
    )
      return checklistCorrectionOutcome('unsafe_evidence');
    const receipts: Array<Records['toolCallReceipts']> = [];
    for (const receipt of rawReceipts) {
      if (!['completed', 'failed', 'unknown', 'not_executed'].includes(receipt.effectOutcome))
        return checklistCorrectionOutcome('unsafe_evidence');
      receipts.push(receipt as Records['toolCallReceipts']);
    }
    const evidence = completeChecklistCorrectionEvidence({
      agentId,
      taskId: task.id,
      toolCalls: calls,
      receipts,
    });
    if (!evidence) return checklistCorrectionOutcome('unsafe_evidence');
    const revision = taskActivityChecklistCorrectionPolicy.revise({
      checklist,
      task: {
        id: task.id,
        agentId: task.agentId,
        conversationId: task.conversationId,
      },
      ownerMessage: {
        id: input.ownerMessageId,
        taskId: task.id,
        agentId: task.agentId,
        conversationId: task.conversationId,
        role: 'user',
        origin: 'owner',
        text: input.replacementLabel,
      },
      binding: {
        taskId: task.id,
        itemId: input.itemId,
        expectedRevision: input.expectedRevision,
        ownerTaskId: task.id,
        ownerMessageId: input.ownerMessageId,
      },
      evidence,
      replacement: {
        kind: input.replacementKind,
        label: input.replacementLabel,
      },
    });
    if (revision.decision !== 'revised') return checklistCorrectionOutcome(revision.decision);
    const nextChecklist = revision.checklist as typeof checklist;
    const generation = task.queueGeneration + 1;
    const now = new Date();
    const nextState: Record<string, unknown> = {
      ...(state ?? {}),
      requestChecklist: nextChecklist,
    };
    delete nextState.pendingFinal;
    const [insertedMessage] = await tx
      .insert(messages)
      .values({
        id: input.ownerMessageId,
        conversationId: task.conversationId,
        taskId: task.id,
        role: 'user',
        origin: 'owner',
        parts: [{ type: 'text', text: input.replacementLabel }],
        text: input.replacementLabel,
      })
      .returning({ id: messages.id });
    if (!insertedMessage) throw new Error('Checklist correction owner message was not persisted');
    const [updated] = await tx
      .update(tasks)
      .set({
        state: nextState,
        plan: null,
        status: 'pending',
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        queueGeneration: generation,
        attempt: 0,
        attentionNotifiedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.agentId, agentId),
          eq(tasks.status, 'needs_attention'),
          eq(tasks.queueGeneration, task.queueGeneration),
        ),
      )
      .returning({ queueGeneration: tasks.queueGeneration });
    if (!updated) throw new Error('Checklist correction task changed before commit');
    await tx
      .update(conversations)
      .set({ updatedAt: now })
      .where(and(eq(conversations.id, task.conversationId), eq(conversations.agentId, agentId)));
    return checklistCorrectionOutcome(
      'corrected',
      updated.queueGeneration,
      input.ownerMessageId,
      true,
    );
  });

  if (outcome.outcome === 'corrected' && outcome.queueGeneration !== null) {
    try {
      getQueueNotifier().notify(input.taskId, outcome.queueGeneration);
    } catch {
      // Durable task status and generation remain authoritative; the normal sweeper can wake it.
    }
  }
  return outcome;
}

export async function revokeTaskAutonomy(
  db: Db,
  taskId: string,
): Promise<TaskActivityCommandOutcome> {
  const agent = await getAgent(db);
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
      .limit(1)
      .for('update');
    if (!task || chatAdmissionCancellationPayload(task))
      return taskActivityOutcome('not_found', null);
    const grant = task.autonomyGrant as Record<string, unknown> | null;
    if (!grant?.revokedAt) {
      const now = new Date().toISOString();
      const [updated] = await tx
        .update(tasks)
        .set({ autonomyGrant: { ...(grant ?? {}), revokedAt: now }, updatedAt: new Date(now) })
        .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
        .returning();
      if (updated) return taskActivityOutcome('autonomy_revoked', currentTask(updated), true);
    }
    return taskActivityOutcome('already_applied', currentTask(task));
  });
}

export async function raiseTaskBudget(
  db: Db,
  taskId: string,
  requested: number,
): Promise<TaskActivityCommandOutcome> {
  if (normalizeTaskBudget(requested, 0.01) === null) {
    throw new Error(
      'task budget must be between $0.01 and $9,999.9999 with at most four decimal places',
    );
  }
  const agent = await getAgent(db);
  const outcome = await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
      .limit(1)
      .for('update');
    if (!task || chatAdmissionCancellationPayload(task))
      return taskActivityOutcome('not_found', null);
    if (task.status !== 'needs_attention')
      return taskActivityOutcome(
        ['done', 'failed', 'cancelled'].includes(task.status)
          ? 'already_terminal'
          : 'no_longer_retriable',
        currentTask(task),
      );
    if (requested <= Number(task.budgetUsdLimit) || requested < Number(task.spentUsd))
      return taskActivityOutcome('no_longer_retriable', currentTask(task));
    if (!Number.isSafeInteger(task.queueGeneration) || task.queueGeneration < 0)
      throw new Error('Invalid task queue generation');
    const state =
      task.state && typeof task.state === 'object' && !Array.isArray(task.state)
        ? { ...(task.state as Record<string, unknown>) }
        : task.state;
    if (state && typeof state === 'object' && !Array.isArray(state))
      delete (state as Record<string, unknown>).pendingFinal;
    const now = new Date();
    const [updated] = await tx
      .update(tasks)
      .set({
        status: 'pending',
        budgetUsdLimit: requested.toFixed(4),
        ...(state === undefined ? {} : { state }),
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        queueGeneration: task.queueGeneration + 1,
        attempt: 0,
        attentionNotifiedAt: null,
        updatedAt: now,
      })
      .where(
        and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id), eq(tasks.status, 'needs_attention')),
      )
      .returning();
    return updated
      ? taskActivityOutcome('budget_raised', currentTask(updated), true)
      : taskActivityOutcome('no_longer_retriable', currentTask(task));
  });
  if (
    outcome.outcome === 'budget_raised' &&
    outcome.current &&
    outcome.current.queueGeneration !== null
  )
    notifyWake(taskId, outcome.current.queueGeneration);
  return outcome;
}

export async function cancelActivity(db: Db, taskId: string): Promise<TaskActivityCommandOutcome> {
  const agent = await getAgent(db);
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
      .limit(1)
      .for('update');
    if (!task || chatAdmissionCancellationPayload(task))
      return taskActivityOutcome('not_found', null);
    if (task.status === 'cancelled')
      return taskActivityOutcome('already_cancelled', currentTask(task));
    if (terminalTaskStatuses.includes(task.status as (typeof terminalTaskStatuses)[number]))
      return taskActivityOutcome('already_terminal', currentTask(task));
    const [updated] = await tx
      .update(tasks)
      .set({
        status: 'cancelled',
        progress: 'This task was cancelled.',
        lockedUntil: null,
        leaseToken: null,
        runAfter: null,
        attempt: 0,
        updatedAt: sql`now()`,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id), eq(tasks.status, task.status)))
      .returning();
    return updated
      ? taskActivityOutcome('cancelled', currentTask(updated), true)
      : taskActivityOutcome('already_terminal', currentTask(task));
  });
}

/** Portable owner-scoped commands used by the Firestore mobile Activity route. */
export function archiveActivityWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  taskId: string,
): Promise<TaskActivityCommandOutcome> {
  return repository.archive(agentId, taskId);
}

export function restoreActivityWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  taskId: string,
): Promise<TaskActivityCommandOutcome> {
  return repository.restore(agentId, taskId);
}

export function retryActivityWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  taskId: string,
): Promise<TaskActivityCommandOutcome> {
  return repository.retry(agentId, taskId);
}

export function revisePendingChecklistWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  input: PendingChecklistCorrectionInput,
): Promise<PendingChecklistCorrectionOutcome> {
  return repository.revisePendingChecklist(agentId, input);
}

export function cancelActivityWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  taskId: string,
): Promise<TaskActivityCommandOutcome> {
  return repository.cancel(agentId, taskId);
}

export function revokeTaskAutonomyWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  taskId: string,
): Promise<TaskActivityCommandOutcome> {
  return repository.revokeAutonomy(agentId, taskId);
}

export function raiseTaskBudgetWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  taskId: string,
  limit: number,
): Promise<TaskActivityCommandOutcome> {
  return repository.raiseBudget(agentId, taskId, limit);
}

/** Archives old terminal activity through the configured persistence adapter. */
export function archiveOldActivityWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  olderThanDays = 30,
  operationId?: string,
): Promise<ArchiveOldActivityProgress> {
  return repository.archiveOld(agentId, olderThanDays, operationId);
}

export async function archiveActivity(db: Db, taskId: string): Promise<TaskActivityCommandOutcome> {
  const agent = await getAgent(db);
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
      .limit(1)
      .for('update');
    if (!task || chatAdmissionCancellationPayload(task))
      return taskActivityOutcome('not_found', null);
    if (task.archivedAt) return taskActivityOutcome('already_archived', currentTask(task));
    if (!terminalTaskStatuses.includes(task.status as (typeof terminalTaskStatuses)[number]))
      return taskActivityOutcome('no_longer_retriable', currentTask(task));
    const now = new Date();
    const [updated] = await tx
      .update(tasks)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.agentId, agent.id),
          eq(tasks.status, task.status),
          isNull(tasks.archivedAt),
        ),
      )
      .returning();
    return updated
      ? taskActivityOutcome('archived', currentTask(updated), true)
      : taskActivityOutcome('already_archived', currentTask(task));
  });
}

export async function restoreActivity(db: Db, taskId: string): Promise<TaskActivityCommandOutcome> {
  const agent = await getAgent(db);
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
      .limit(1)
      .for('update');
    if (!task || chatAdmissionCancellationPayload(task))
      return taskActivityOutcome('not_found', null);
    if (!task.archivedAt) return taskActivityOutcome('already_restored', currentTask(task));
    const [updated] = await tx
      .update(tasks)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.agentId, agent.id), isNotNull(tasks.archivedAt)))
      .returning();
    return updated
      ? taskActivityOutcome('restored', currentTask(updated), true)
      : taskActivityOutcome('already_restored', currentTask(task));
  });
}

export async function archiveOldActivity(
  db: Db,
  olderThanDays = 30,
): Promise<ArchiveOldActivityProgress> {
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0)
    throw new Error('Invalid archive-old activity request');
  const agent = await getAgent(db);
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const archived = await db
    .update(tasks)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(tasks.agentId, agent.id),
        notChatAdmissionCancellationSql(),
        isNull(tasks.archivedAt),
        inArray(tasks.status, terminalTaskStatuses),
        lt(tasks.updatedAt, cutoff),
      ),
    )
    .returning({ id: tasks.id });
  return {
    operationId: null,
    scannedThisBatch: archived.length,
    archivedThisBatch: archived.length,
    scannedTotal: archived.length,
    archivedTotal: archived.length,
    complete: true,
  };
}
