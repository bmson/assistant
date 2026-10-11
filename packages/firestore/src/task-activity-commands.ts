import { randomUUID } from 'node:crypto';
import type {
  ArchiveOldActivityProgress,
  ChecklistCancellationPolicy,
  ChecklistCorrectionPolicy,
  PendingChecklistCancellationInput,
  PendingChecklistCancellationOutcome,
  PendingChecklistCorrectionInput,
  PendingChecklistCorrectionOutcome,
  Records,
  TaskActivityCommandOutcome,
  TaskActivityCommandRepository,
  TaskActivityCurrentState,
} from '@assistant/persistence';
import {
  completeChecklistCorrectionEvidence,
  isChatAdmissionCancellationProjection,
  isPinnedOwnerChatRequestMessage,
  MAX_CHECKLIST_CORRECTION_LEDGER_ROWS,
  MAX_TASK_QUEUE_GENERATION,
  normalizeTaskBudget,
  ownerChatChecklistRequestMessageId,
  taskActivityOutcome,
} from '@assistant/persistence';
import {
  type DocumentReference,
  type DocumentSnapshot,
  FieldPath,
  type QueryDocumentSnapshot,
  type Transaction,
} from '@google-cloud/firestore';
import { messageRecord } from './messages.js';
import { createWakeIntent } from './outbox.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function correctionOutcome(
  outcome: PendingChecklistCorrectionOutcome['outcome'],
  queueGeneration: number | null = null,
  ownerMessageId: string | null = null,
  transitioned = false,
): PendingChecklistCorrectionOutcome {
  return { outcome, transitioned, queueGeneration, ownerMessageId };
}

function cancellationOutcome(
  outcome: PendingChecklistCancellationOutcome['outcome'],
  queueGeneration: number | null = null,
  ownerMessageId: string | null = null,
  transitioned = false,
): PendingChecklistCancellationOutcome {
  return { outcome, transitioned, queueGeneration, ownerMessageId };
}

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const WAKEABLE = new Set([
  'waiting_approval',
  'waiting_event',
  'sleeping',
  'waiting_budget',
  'needs_attention',
]);
const ARCHIVE_BATCH_SIZE = 250;
const ARCHIVE_OPERATION_COLLECTION = 'taskActivityArchiveRuns';

function currentTask(task: Record<string, unknown>): TaskActivityCurrentState {
  if (typeof task.id !== 'string' || typeof task.status !== 'string')
    throw new Error('Invalid activity task');
  const generation = task.queueGeneration;
  if (
    generation !== undefined &&
    generation !== null &&
    (!Number.isSafeInteger(generation) || Number(generation) < 0)
  )
    throw new Error('Invalid activity task');
  const archivedAt = task.archivedAt;
  if (
    archivedAt !== undefined &&
    archivedAt !== null &&
    (!(archivedAt instanceof Date) || !Number.isFinite(archivedAt.getTime()))
  )
    throw new Error('Invalid activity task');
  const grant = task.autonomyGrant;
  if (grant !== undefined && grant !== null && (typeof grant !== 'object' || Array.isArray(grant)))
    throw new Error('Invalid activity task');
  const revoked = (grant as Record<string, unknown> | null | undefined)?.revokedAt;
  return {
    id: task.id,
    status: task.status,
    queueGeneration: generation === undefined || generation === null ? null : Number(generation),
    archivedAt: archivedAt instanceof Date ? archivedAt.toISOString() : null,
    budgetUsdLimit: typeof task.budgetUsdLimit === 'string' ? task.budgetUsdLimit : null,
    autonomyRevoked: typeof revoked === 'string' && revoked.length > 0,
  };
}

function withCurrent(
  task: Record<string, unknown>,
  patch: Partial<TaskActivityCurrentState>,
  outcome: Parameters<typeof taskActivityOutcome>[0],
  transitioned = false,
): TaskActivityCommandOutcome {
  return taskActivityOutcome(outcome, { ...currentTask(task), ...patch }, transitioned);
}

interface ArchiveRun {
  operationId: string;
  agentId: string;
  cutoff: Date;
  cursorId: string | null;
  scannedTotal: number;
  archivedTotal: number;
  complete: boolean;
}

function archiveRun(value: unknown, agentId: string): ArchiveRun {
  const row = decodeRecord<Record<string, unknown>>(value);
  if (
    row.agentId !== agentId ||
    typeof row.operationId !== 'string' ||
    !row.operationId ||
    !(row.cutoff instanceof Date) ||
    !Number.isFinite(row.cutoff.getTime()) ||
    !(row.cursorId === null || typeof row.cursorId === 'string') ||
    !Number.isSafeInteger(row.scannedTotal) ||
    Number(row.scannedTotal) < 0 ||
    !Number.isSafeInteger(row.archivedTotal) ||
    Number(row.archivedTotal) < 0 ||
    typeof row.complete !== 'boolean'
  )
    throw new Error('Invalid archive-old activity progress');
  return row as unknown as ArchiveRun;
}

function progress(
  run: ArchiveRun,
  scannedThisBatch: number,
  archivedThisBatch: number,
): ArchiveOldActivityProgress {
  return {
    operationId: run.operationId,
    scannedThisBatch,
    archivedThisBatch,
    scannedTotal: run.scannedTotal,
    archivedTotal: run.archivedTotal,
    complete: run.complete,
  };
}

function isTerminalArchiveCandidate(
  document: DocumentSnapshot | QueryDocumentSnapshot,
  agentId: string,
  cutoff: Date,
): boolean {
  const data = document.data();
  if (!document.exists || !data) return false;
  const task = decodeRecord<Record<string, unknown>>(data);
  if (
    task.agentId !== agentId ||
    typeof task.id !== 'string' ||
    documentKey(task.id) !== document.id ||
    typeof task.status !== 'string' ||
    !(
      task.archivedAt === null ||
      (task.archivedAt instanceof Date && Number.isFinite(task.archivedAt.getTime()))
    ) ||
    !(task.updatedAt instanceof Date) ||
    !Number.isFinite(task.updatedAt.getTime())
  )
    throw new Error('Invalid owner activity task');
  if (isChatAdmissionCancellationProjection(task)) return false;
  return (
    task.archivedAt === null &&
    TERMINAL.has(task.status) &&
    task.updatedAt.getTime() < cutoff.getTime()
  );
}

/** Archives or restores one owned task in the same transaction as its safety checks. */
export class FirestoreTaskActivityCommandRepository implements TaskActivityCommandRepository {
  readonly kind = 'task-activity-command-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly checklistCorrectionPolicy?: ChecklistCorrectionPolicy,
    readonly checklistCancellationPolicy?: ChecklistCancellationPolicy,
  ) {}

  /** Atomically append the selected owner correction, revise its checklist, and queue the task. */
  revisePendingChecklist(
    agentId: string,
    input: PendingChecklistCorrectionInput,
  ): Promise<PendingChecklistCorrectionOutcome> {
    const policy = this.checklistCorrectionPolicy;
    if (!policy) return Promise.resolve(correctionOutcome('unsafe_evidence'));
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
      return Promise.resolve(correctionOutcome('invalid'));

    return this.store.db.runTransaction(async (tx) => {
      const owners = await tx.get(this.store.collection('agents').limit(2));
      const owner = owners.docs[0];
      if (
        owners.size !== 1 ||
        !owner ||
        owner.id !== documentKey(agentId) ||
        owner.get('id') !== agentId
      )
        return correctionOutcome('not_found');
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');

      const taskRef = this.store.doc('tasks', input.taskId);
      const messageRef = this.store.doc('messages', input.ownerMessageId);
      const taskSnapshot = await tx.get(taskRef);
      if (!taskSnapshot.exists || taskSnapshot.get('agentId') !== agentId)
        return correctionOutcome('not_found');
      const task = decodeRecord<Record<string, unknown>>(taskSnapshot.data());
      if (
        task.id !== input.taskId ||
        documentKey(input.taskId) !== taskSnapshot.id ||
        isChatAdmissionCancellationProjection(task)
      )
        return correctionOutcome('not_found');
      if (typeof task.conversationId !== 'string' || !task.conversationId)
        return correctionOutcome('invalid');

      const state =
        task.state && typeof task.state === 'object' && !Array.isArray(task.state)
          ? ({ ...(task.state as Record<string, unknown>) } as Record<string, unknown>)
          : null;
      const parsed = policy.readChecklist(state?.requestChecklist);
      if (!parsed) return correctionOutcome('invalid');
      const checklist = parsed.checklist;

      const originalMessageId = ownerChatChecklistRequestMessageId(
        task as {
          id: string;
          agentId: string;
          conversationId: string | null;
          goalId: string | null;
          type: string;
          trust: string;
          trigger: unknown;
        },
        parsed.request,
      );
      if (!originalMessageId) return correctionOutcome('unsafe_evidence');
      const originalMessageSnapshot = await tx.get(this.store.doc('messages', originalMessageId));
      if (!originalMessageSnapshot.exists) return correctionOutcome('unsafe_evidence');
      const originalMessage = decodeRecord<Record<string, unknown>>(originalMessageSnapshot.data());
      if (
        !isPinnedOwnerChatRequestMessage(
          task as { id: string; agentId: string; conversationId: string | null },
          originalMessage as {
            id: string;
            taskId: string | null;
            conversationId: string;
            role: string;
            origin: string;
            text: string;
          },
          originalMessageId,
          parsed.request,
        )
      )
        return correctionOutcome('unsafe_evidence');

      const priorMessageSnapshot = await tx.get(messageRef);
      if (priorMessageSnapshot.exists) {
        const priorMessage = decodeRecord<Record<string, unknown>>(priorMessageSnapshot.data());
        if (
          policy.matchesReplay({
            checklist,
            correction: input,
            task: { id: task.id, conversationId: task.conversationId },
            priorMessage: priorMessage as {
              id: string;
              taskId: string | null;
              conversationId: string | null;
              role: string;
              origin: string;
              text: string;
            },
          })
        )
          return correctionOutcome(
            'already_applied',
            Number.isSafeInteger(task.queueGeneration) ? Number(task.queueGeneration) : null,
            input.ownerMessageId,
          );
        return correctionOutcome('invalid');
      }

      if (
        task.status !== 'needs_attention' ||
        task.leaseToken !== null ||
        task.lockedUntil !== null ||
        task.archivedAt !== null
      )
        return correctionOutcome('no_longer_retriable');
      if (
        !Number.isSafeInteger(task.queueGeneration) ||
        Number(task.queueGeneration) < 0 ||
        Number(task.queueGeneration) >= MAX_TASK_QUEUE_GENERATION
      )
        return correctionOutcome('invalid');
      if (state?.pendingApprovalId || state?.pendingJob != null || state?.pendingToolBatch != null)
        return correctionOutcome('unsafe_evidence');

      const conversationRef = this.store.doc('conversations', task.conversationId);
      const callsQuery = this.store
        .collection('toolCalls')
        .where('taskId', '==', task.id)
        .limit(MAX_CHECKLIST_CORRECTION_LEDGER_ROWS + 1);
      const receiptsQuery = this.store
        .collection('toolCallReceipts')
        .where('taskId', '==', task.id)
        .limit(MAX_CHECKLIST_CORRECTION_LEDGER_ROWS + 1);
      const pendingApprovalsQuery = this.store
        .collection('approvals')
        .where('taskId', '==', task.id)
        .where('status', 'in', ['pending', 'approved'])
        .limit(1);
      const [conversationSnapshot, callsSnapshot, receiptsSnapshot, approvalsSnapshot] =
        await Promise.all([
          tx.get(conversationRef),
          tx.get(callsQuery),
          tx.get(receiptsQuery),
          tx.get(pendingApprovalsQuery),
        ]);
      if (!conversationSnapshot.exists || conversationSnapshot.get('agentId') !== agentId)
        return correctionOutcome('not_found');
      if (approvalsSnapshot.size > 0) return correctionOutcome('unsafe_evidence');
      if (
        callsSnapshot.size > MAX_CHECKLIST_CORRECTION_LEDGER_ROWS ||
        receiptsSnapshot.size > MAX_CHECKLIST_CORRECTION_LEDGER_ROWS
      )
        return correctionOutcome('unsafe_evidence');

      const calls: Parameters<
        typeof completeChecklistCorrectionEvidence
      >[0]['toolCalls'][number][] = [];
      for (const document of callsSnapshot.docs) {
        const row = decodeRecord<Record<string, unknown>>(document.data());
        if (
          typeof row.id !== 'string' ||
          document.id !== documentKey(row.id) ||
          row.taskId !== task.id ||
          typeof row.toolName !== 'string' ||
          typeof row.status !== 'string'
        )
          return correctionOutcome('unsafe_evidence');
        calls.push(
          row as unknown as Parameters<
            typeof completeChecklistCorrectionEvidence
          >[0]['toolCalls'][number],
        );
      }
      const receipts: Parameters<
        typeof completeChecklistCorrectionEvidence
      >[0]['receipts'][number][] = [];
      for (const document of receiptsSnapshot.docs) {
        const row = decodeRecord<Record<string, unknown>>(document.data());
        if (
          typeof row.id !== 'string' ||
          document.id !== documentKey(row.id) ||
          row.agentId !== agentId ||
          row.taskId !== task.id ||
          typeof row.toolCallId !== 'string' ||
          typeof row.toolName !== 'string' ||
          !['completed', 'failed', 'unknown', 'not_executed'].includes(String(row.effectOutcome))
        )
          return correctionOutcome('unsafe_evidence');
        receipts.push(
          row as unknown as Parameters<
            typeof completeChecklistCorrectionEvidence
          >[0]['receipts'][number],
        );
      }
      const evidence = completeChecklistCorrectionEvidence({
        agentId,
        taskId: task.id,
        toolCalls: calls,
        receipts,
      });
      if (!evidence) return correctionOutcome('unsafe_evidence');
      const replacement = {
        kind: input.replacementKind,
        label: input.replacementLabel,
      };
      const revision = policy.revise({
        checklist,
        task: { id: task.id, agentId, conversationId: task.conversationId },
        ownerMessage: {
          id: input.ownerMessageId,
          taskId: task.id,
          agentId,
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
        replacement,
      });
      if (revision?.decision !== 'revised')
        return correctionOutcome(revision?.decision ?? 'unsafe_evidence');
      const verifiedRevision = policy.readChecklist(revision.checklist);
      const audit = verifiedRevision?.latestAudit;
      if (
        !verifiedRevision ||
        verifiedRevision.request !== parsed.request ||
        verifiedRevision.revision !== input.expectedRevision + 1 ||
        audit?.revision !== input.expectedRevision + 1 ||
        audit.taskId !== task.id ||
        audit.conversationId !== task.conversationId ||
        audit.ownerTaskId !== task.id ||
        audit.ownerMessageId !== input.ownerMessageId ||
        audit.itemId !== input.itemId ||
        audit.toLabel !== input.replacementLabel ||
        audit.toKind !== input.replacementKind
      )
        return correctionOutcome('unsafe_evidence');
      const revised = verifiedRevision.checklist;

      const generation = Number(task.queueGeneration) + 1;
      const now = this.store.now();
      const nextState: Record<string, unknown> = { ...(state ?? {}), requestChecklist: revised };
      delete nextState.pendingFinal;
      const message = messageRecord(
        {
          conversationId: task.conversationId,
          taskId: task.id,
          role: 'user',
          origin: 'owner',
          parts: [{ type: 'text', text: input.replacementLabel }],
          text: input.replacementLabel,
        },
        input.ownerMessageId,
        now,
      );
      const nextTask = {
        ...task,
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
      };
      tx.create(messageRef, encodeRecord(message));
      tx.update(taskRef, encodeRecord(nextTask));
      tx.update(conversationRef, { updatedAt: now });
      createWakeIntent(tx, this.store, { taskId: task.id, generation, availableAt: now });
      return correctionOutcome('corrected', generation, input.ownerMessageId, true);
    });
  }

  /** Atomically record and queue an explicitly selected checklist cancellation. */
  cancelPendingChecklist(
    agentId: string,
    input: PendingChecklistCancellationInput,
  ): Promise<PendingChecklistCancellationOutcome> {
    const policy = this.checklistCancellationPolicy;
    if (!policy) return Promise.resolve(cancellationOutcome('unsafe_evidence'));
    if (
      !UUID.test(input.taskId) ||
      !UUID.test(input.ownerMessageId) ||
      !input.itemId ||
      input.itemId.length > 128 ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isSafeInteger(input.expectedCancellationRevision) ||
      input.expectedCancellationRevision < 0
    )
      return Promise.resolve(cancellationOutcome('invalid'));

    return this.store.db.runTransaction(async (tx) => {
      const owners = await tx.get(this.store.collection('agents').limit(2));
      const owner = owners.docs[0];
      if (
        owners.size !== 1 ||
        !owner ||
        owner.id !== documentKey(agentId) ||
        owner.get('id') !== agentId
      )
        return cancellationOutcome('not_found');
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');

      const taskRef = this.store.doc('tasks', input.taskId);
      const messageRef = this.store.doc('messages', input.ownerMessageId);
      const taskSnapshot = await tx.get(taskRef);
      if (!taskSnapshot.exists || taskSnapshot.get('agentId') !== agentId)
        return cancellationOutcome('not_found');
      const task = decodeRecord<Record<string, unknown>>(taskSnapshot.data());
      if (
        task.id !== input.taskId ||
        documentKey(input.taskId) !== taskSnapshot.id ||
        isChatAdmissionCancellationProjection(task)
      )
        return cancellationOutcome('not_found');
      if (
        task.type !== 'chat_turn' ||
        task.trust !== 'owner' ||
        task.goalId != null ||
        typeof task.conversationId !== 'string' ||
        !task.conversationId
      )
        return cancellationOutcome('unsafe_evidence');

      const state =
        task.state && typeof task.state === 'object' && !Array.isArray(task.state)
          ? ({ ...(task.state as Record<string, unknown>) } as Record<string, unknown>)
          : null;
      const checklistValue = state?.requestChecklist;
      if (!checklistValue || typeof checklistValue !== 'object' || Array.isArray(checklistValue))
        return cancellationOutcome('invalid');
      const request = (checklistValue as Record<string, unknown>).request;
      if (typeof request !== 'string') return cancellationOutcome('invalid');
      const originalMessageId = ownerChatChecklistRequestMessageId(
        task as {
          id: string;
          agentId: string;
          conversationId: string | null;
          goalId: string | null;
          type: string;
          trust: string;
          trigger: unknown;
        },
        request,
      );
      if (!originalMessageId) return cancellationOutcome('unsafe_evidence');
      const originalMessageSnapshot = await tx.get(this.store.doc('messages', originalMessageId));
      if (!originalMessageSnapshot.exists) return cancellationOutcome('unsafe_evidence');
      const originalMessage = decodeRecord<Record<string, unknown>>(originalMessageSnapshot.data());
      if (
        !isPinnedOwnerChatRequestMessage(
          task as { id: string; agentId: string; conversationId: string | null },
          originalMessage as {
            id: string;
            taskId: string | null;
            conversationId: string;
            role: string;
            origin: string;
            text: string;
          },
          originalMessageId,
          request,
        )
      )
        return cancellationOutcome('unsafe_evidence');

      const priorMessageSnapshot = await tx.get(messageRef);
      if (priorMessageSnapshot.exists) {
        const priorMessage = decodeRecord<Record<string, unknown>>(priorMessageSnapshot.data());
        if (
          policy.matchesReplay({
            checklist: checklistValue,
            cancellation: input,
            task: { id: task.id, conversationId: task.conversationId },
            priorMessage: priorMessage as {
              id: string;
              taskId: string | null;
              conversationId: string | null;
              role: string;
              origin: string;
              text: string;
            },
          })
        )
          return cancellationOutcome(
            'already_cancelled',
            Number.isSafeInteger(task.queueGeneration) ? Number(task.queueGeneration) : null,
            input.ownerMessageId,
          );
        return cancellationOutcome('invalid');
      }

      if (
        task.status !== 'needs_attention' ||
        task.leaseToken !== null ||
        task.lockedUntil !== null ||
        task.archivedAt !== null
      )
        return cancellationOutcome('no_longer_retriable');
      if (
        !Number.isSafeInteger(task.queueGeneration) ||
        Number(task.queueGeneration) < 0 ||
        Number(task.queueGeneration) >= MAX_TASK_QUEUE_GENERATION
      )
        return cancellationOutcome('invalid');
      if (
        state?.pendingApprovalId ||
        state?.pendingJob != null ||
        state?.pendingToolBatch != null ||
        state?.pendingFinal != null ||
        (Array.isArray(state?.pendingApprovals) && state.pendingApprovals.length > 0)
      )
        return cancellationOutcome('unsafe_evidence');

      const conversationRef = this.store.doc('conversations', task.conversationId);
      const callsQuery = this.store
        .collection('toolCalls')
        .where('taskId', '==', task.id)
        .limit(MAX_CHECKLIST_CORRECTION_LEDGER_ROWS + 1);
      const receiptsQuery = this.store
        .collection('toolCallReceipts')
        .where('taskId', '==', task.id)
        .limit(MAX_CHECKLIST_CORRECTION_LEDGER_ROWS + 1);
      const pendingApprovalsQuery = this.store
        .collection('approvals')
        .where('taskId', '==', task.id)
        .where('status', 'in', ['pending', 'approved'])
        .limit(1);
      const [conversationSnapshot, callsSnapshot, receiptsSnapshot, approvalsSnapshot] =
        await Promise.all([
          tx.get(conversationRef),
          tx.get(callsQuery),
          tx.get(receiptsQuery),
          tx.get(pendingApprovalsQuery),
        ]);
      if (
        !conversationSnapshot.exists ||
        conversationSnapshot.get('agentId') !== agentId ||
        conversationSnapshot.get('channel') !== 'chat'
      )
        return cancellationOutcome('not_found');
      if (conversationSnapshot.get('archivedAt') !== null)
        return cancellationOutcome('no_longer_retriable');
      if (approvalsSnapshot.size > 0) return cancellationOutcome('unsafe_evidence');
      if (
        callsSnapshot.size > MAX_CHECKLIST_CORRECTION_LEDGER_ROWS ||
        receiptsSnapshot.size > MAX_CHECKLIST_CORRECTION_LEDGER_ROWS
      )
        return cancellationOutcome('unsafe_evidence');

      const calls: Parameters<
        typeof completeChecklistCorrectionEvidence
      >[0]['toolCalls'][number][] = [];
      for (const document of callsSnapshot.docs) {
        const row = decodeRecord<Record<string, unknown>>(document.data());
        if (
          typeof row.id !== 'string' ||
          document.id !== documentKey(row.id) ||
          row.taskId !== task.id ||
          typeof row.toolName !== 'string' ||
          typeof row.status !== 'string' ||
          !Object.hasOwn(row, 'args')
        )
          return cancellationOutcome('unsafe_evidence');
        calls.push(
          row as unknown as Parameters<
            typeof completeChecklistCorrectionEvidence
          >[0]['toolCalls'][number],
        );
      }
      const receipts: Parameters<
        typeof completeChecklistCorrectionEvidence
      >[0]['receipts'][number][] = [];
      for (const document of receiptsSnapshot.docs) {
        const row = decodeRecord<Record<string, unknown>>(document.data());
        if (
          typeof row.id !== 'string' ||
          document.id !== documentKey(row.id) ||
          row.agentId !== agentId ||
          row.taskId !== task.id ||
          typeof row.toolCallId !== 'string' ||
          typeof row.toolName !== 'string' ||
          !['completed', 'failed', 'unknown', 'not_executed'].includes(String(row.effectOutcome))
        )
          return cancellationOutcome('unsafe_evidence');
        receipts.push(
          row as unknown as Parameters<
            typeof completeChecklistCorrectionEvidence
          >[0]['receipts'][number],
        );
      }
      const evidence = completeChecklistCorrectionEvidence({
        agentId,
        taskId: task.id,
        toolCalls: calls,
        receipts,
      });
      if (!evidence) return cancellationOutcome('unsafe_evidence');
      const cancellation = policy.cancel({
        checklist: checklistValue,
        task: { id: task.id, agentId, conversationId: task.conversationId },
        binding: input,
        evidence: evidence.rows,
      });
      if (cancellation.decision !== 'cancelled') return cancellationOutcome(cancellation.decision);
      if (
        !policy.matchesReplay({
          checklist: cancellation.checklist,
          cancellation: input,
          task: { id: task.id, conversationId: task.conversationId },
          priorMessage: {
            id: input.ownerMessageId,
            taskId: task.id,
            conversationId: task.conversationId,
            role: 'user',
            origin: 'owner',
            text: cancellation.ownerMessageText,
          },
        })
      )
        return cancellationOutcome('unsafe_evidence');

      const generation = Number(task.queueGeneration) + 1;
      const now = this.store.now();
      const nextState: Record<string, unknown> = {
        ...(state ?? {}),
        requestChecklist: cancellation.checklist,
      };
      const message = messageRecord(
        {
          conversationId: task.conversationId,
          taskId: task.id,
          role: 'user',
          origin: 'owner',
          parts: [{ type: 'text', text: cancellation.ownerMessageText }],
          text: cancellation.ownerMessageText,
        },
        input.ownerMessageId,
        now,
      );
      tx.create(messageRef, encodeRecord(message));
      tx.update(taskRef, {
        ...task,
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
      });
      tx.update(conversationRef, { updatedAt: now });
      createWakeIntent(tx, this.store, { taskId: task.id, generation, availableAt: now });
      return cancellationOutcome('cancelled', generation, input.ownerMessageId, true);
    });
  }

  archive(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome> {
    return this.change(agentId, taskId, 'archive');
  }

  restore(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome> {
    return this.change(agentId, taskId, 'restore');
  }

  /** Requeue a parked owner task and publish its generation in the same transaction. */
  retry(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome> {
    return this.changeOwnerTask(agentId, taskId, async (task, ref, tx) => {
      if (typeof task.status !== 'string') throw new Error('Invalid activity task');
      // This makes client retries idempotent: after the first successful wake,
      // pending is no longer wakeable and cannot increment the generation twice.
      if (!WAKEABLE.has(task.status))
        return withCurrent(
          task,
          {},
          TERMINAL.has(task.status) ? 'already_terminal' : 'no_longer_retriable',
        );
      if (!Number.isSafeInteger(task.queueGeneration) || Number(task.queueGeneration) < 0)
        throw new Error('Invalid activity task');

      const generation = Number(task.queueGeneration) + 1;
      const now = this.store.now();
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
        if (typeof ownerMessageId === 'string') {
          const ownerMessageSnapshot = await tx.get(this.store.doc('messages', ownerMessageId));
          const conversationId = task.conversationId;
          const conversationSnapshot =
            typeof conversationId === 'string'
              ? await tx.get(this.store.doc('conversations', conversationId))
              : null;
          const ownerMessage = ownerMessageSnapshot.exists
            ? decodeRecord<Records['messages']>(ownerMessageSnapshot.data())
            : null;
          const conversation = conversationSnapshot?.exists
            ? decodeRecord<Records['conversations']>(conversationSnapshot.data())
            : null;
          preserveCorrectionFinal = Boolean(
            ownerMessage &&
              conversation?.agentId === agentId &&
              this.checklistCorrectionPolicy?.isRetryableFinal({
                task: task as never,
                state,
                ownerMessage: { ...ownerMessage, agentId },
              }),
          );
          parkUnknownCorrectionFinal = Boolean(
            ownerMessage &&
              conversation?.agentId === agentId &&
              this.checklistCorrectionPolicy?.isUnknownFinal({
                task: task as never,
                state,
                ownerMessage: { ...ownerMessage, agentId },
              }),
          );
        }
        if (
          hasCorrectionFinal &&
          (typeof ownerMessageId !== 'string' ||
            !this.checklistCorrectionPolicy ||
            parkUnknownCorrectionFinal ||
            !preserveCorrectionFinal)
        )
          return withCurrent(task, {}, 'no_longer_retriable');
        if (!preserveCorrectionFinal) delete (state as Record<string, unknown>).pendingFinal;
      }
      tx.update(ref, {
        status: 'pending',
        ...(state === undefined ? {} : { state }),
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        queueGeneration: generation,
        attempt: 0,
        attentionNotifiedAt: null,
        updatedAt: now,
      });
      createWakeIntent(tx, this.store, { taskId, generation, availableAt: now });
      return withCurrent(
        task,
        { status: 'pending', queueGeneration: generation, archivedAt: null },
        'retried',
        true,
      );
    });
  }

  /** Cancel an owned non-terminal task; clearing its lease fences any live worker. */
  async cancel(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome> {
    if (!agentId || !taskId) throw new Error('Activity agent and task are required');
    return this.store.db.runTransaction(async (tx) => {
      const agents = await tx.get(this.store.collection('agents').limit(2));
      const agent = agents.docs[0];
      if (
        agents.size !== 1 ||
        !agent ||
        agent.id !== documentKey(agentId) ||
        agent.get('id') !== agentId
      )
        throw new Error('Activity requires one matching configured agent');

      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');

      const ref = this.store.doc('tasks', taskId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== agentId)
        return taskActivityOutcome('not_found', null);
      const task = decodeRecord<Record<string, unknown>>(snapshot.data());
      if (task.id !== taskId || documentKey(taskId) !== snapshot.id)
        throw new Error('Invalid activity task');
      if (typeof task.status !== 'string') throw new Error('Invalid activity task');
      if (isChatAdmissionCancellationProjection(task))
        return taskActivityOutcome('not_found', null);
      if (task.status === 'cancelled') return withCurrent(task, {}, 'already_cancelled');
      if (TERMINAL.has(task.status)) return withCurrent(task, {}, 'already_terminal');
      const current = withCurrent(task, { status: 'cancelled' }, 'cancelled', true);
      tx.update(ref, {
        status: 'cancelled',
        progress: 'This task was cancelled.',
        lockedUntil: null,
        leaseToken: null,
        runAfter: null,
        attempt: 0,
        updatedAt: this.store.now(),
      });
      return current;
    });
  }

  revokeAutonomy(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome> {
    return this.changeOwnerTask(agentId, taskId, (task, ref, tx) => {
      const grant = task.autonomyGrant;
      if (grant === null || grant === undefined) return withCurrent(task, {}, 'already_applied');
      if (typeof grant !== 'object' || Array.isArray(grant))
        throw new Error('Invalid task autonomy grant');
      const current = grant as Record<string, unknown>;
      if (current.revokedAt) return withCurrent(task, {}, 'already_applied');
      const now = this.store.now();
      tx.update(ref, {
        autonomyGrant: { ...current, revokedAt: now.toISOString() },
        updatedAt: now,
      });
      return withCurrent(task, { autonomyRevoked: true }, 'autonomy_revoked', true);
    });
  }

  async raiseBudget(
    agentId: string,
    taskId: string,
    limit: number,
  ): Promise<TaskActivityCommandOutcome> {
    if (normalizeTaskBudget(limit, 0.01) === null)
      throw new Error(
        'task budget must be between $0.01 and $9,999.9999 with at most four decimal places',
      );
    return this.changeOwnerTask(agentId, taskId, (task, ref, tx) => {
      if (task.status !== 'needs_attention')
        return withCurrent(
          task,
          {},
          TERMINAL.has(String(task.status)) ? 'already_terminal' : 'no_longer_retriable',
        );
      const currentLimit = Number(task.budgetUsdLimit);
      const spent = Number(task.spentUsd);
      if (
        !Number.isFinite(currentLimit) ||
        !Number.isFinite(spent) ||
        limit <= currentLimit ||
        limit < spent
      )
        return withCurrent(task, {}, 'no_longer_retriable');
      if (!Number.isSafeInteger(task.queueGeneration) || Number(task.queueGeneration) < 0)
        throw new Error('Invalid activity task');

      const now = this.store.now();
      const generation = Number(task.queueGeneration) + 1;
      const state =
        task.state && typeof task.state === 'object' && !Array.isArray(task.state)
          ? { ...(task.state as Record<string, unknown>) }
          : task.state;
      if (state && typeof state === 'object' && !Array.isArray(state))
        delete (state as Record<string, unknown>).pendingFinal;
      const statePatch = state === undefined ? {} : { state };
      tx.update(ref, {
        status: 'pending',
        budgetUsdLimit: limit.toFixed(4),
        ...statePatch,
        runAfter: null,
        lockedUntil: null,
        queueGeneration: generation,
        attempt: 0,
        attentionNotifiedAt: null,
        updatedAt: now,
      });
      createWakeIntent(tx, this.store, { taskId, generation, availableAt: now });
      return withCurrent(
        task,
        {
          status: 'pending',
          queueGeneration: generation,
          budgetUsdLimit: limit.toFixed(4),
          archivedAt: null,
        },
        'budget_raised',
        true,
      );
    });
  }

  async archiveOld(
    agentId: string,
    olderThanDays = 30,
    requestedOperationId?: string,
  ): Promise<ArchiveOldActivityProgress> {
    if (!agentId || !Number.isFinite(olderThanDays) || olderThanDays <= 0)
      throw new Error('Invalid archive-old activity request');
    if (requestedOperationId !== undefined && !/^[0-9a-f-]{36}$/i.test(requestedOperationId))
      throw new Error('Invalid archive-old activity operation');
    const operationRef = this.store.doc(ARCHIVE_OPERATION_COLLECTION, agentId);
    const run = await this.store.db.runTransaction(async (tx): Promise<ArchiveRun> => {
      const ownerQuery = await tx.get(this.store.collection('agents').limit(2));
      const owner = ownerQuery.docs[0];
      if (
        ownerQuery.size !== 1 ||
        !owner ||
        owner.id !== documentKey(agentId) ||
        owner.get('id') !== agentId
      )
        throw new Error('Activity requires one matching configured agent');
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');
      const snapshot = await tx.get(operationRef);
      if (snapshot.exists) {
        const current = archiveRun(snapshot.data(), agentId);
        if (requestedOperationId && requestedOperationId !== current.operationId)
          throw new Error('Archive-old activity operation changed; refresh its progress');
        if (!current.complete) return current;
        if (requestedOperationId) return current;
      }
      if (requestedOperationId) throw new Error('Archive-old activity operation was not found');
      const created: ArchiveRun = {
        operationId: randomUUID(),
        agentId,
        cutoff: new Date(this.store.now().getTime() - olderThanDays * 24 * 60 * 60 * 1000),
        cursorId: null,
        scannedTotal: 0,
        archivedTotal: 0,
        complete: false,
      };
      tx.set(operationRef, created);
      return created;
    });

    if (run.complete) return progress(run, 0, 0);

    let query = this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('archivedAt', '==', null)
      .where('status', 'in', [...TERMINAL])
      .select(
        'id',
        'agentId',
        'conversationId',
        'externalEventId',
        'type',
        'trust',
        'trigger',
        'status',
        'archivedAt',
        'updatedAt',
      )
      .orderBy(FieldPath.documentId())
      .limit(ARCHIVE_BATCH_SIZE);
    if (run.cursorId) query = query.startAfter(run.cursorId);
    const page = await query.get();
    const cutoff = run.cutoff;
    const candidates = page.docs.filter((document) =>
      isTerminalArchiveCandidate(document, agentId, cutoff),
    );
    const cursorId = page.docs.at(-1)?.id ?? run.cursorId;
    const complete = page.size < ARCHIVE_BATCH_SIZE;
    const now = this.store.now();

    return this.store.db.runTransaction(async (tx) => {
      const ownerQuery = await tx.get(this.store.collection('agents').limit(2));
      const owner = ownerQuery.docs[0];
      if (
        ownerQuery.size !== 1 ||
        !owner ||
        owner.id !== documentKey(agentId) ||
        owner.get('id') !== agentId
      )
        throw new Error('Activity requires one matching configured agent');
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');
      const currentSnapshot = await tx.get(operationRef);
      if (!currentSnapshot.exists) throw new Error('Archive-old activity progress disappeared');
      const current = archiveRun(currentSnapshot.data(), agentId);
      if (current.operationId !== run.operationId)
        throw new Error('Archive-old activity operation changed; refresh its progress');
      if (current.complete) return progress(current, 0, 0);
      if (current.cursorId !== run.cursorId) return progress(current, 0, 0);

      const currentCandidates = await Promise.all(
        candidates.map((document) => tx.get(document.ref)),
      );
      let archivedThisBatch = 0;
      for (const snapshot of currentCandidates) {
        if (!snapshot.exists) continue;
        if (isTerminalArchiveCandidate(snapshot, agentId, cutoff)) {
          tx.update(snapshot.ref, { archivedAt: now, updatedAt: now });
          archivedThisBatch += 1;
        }
      }
      const advanced: ArchiveRun = {
        ...current,
        cursorId,
        scannedTotal: current.scannedTotal + page.size,
        archivedTotal: current.archivedTotal + archivedThisBatch,
        complete,
      };
      tx.set(operationRef, advanced);
      return progress(advanced, page.size, archivedThisBatch);
    });
  }

  private async change(
    agentId: string,
    taskId: string,
    action: 'archive' | 'restore',
  ): Promise<TaskActivityCommandOutcome> {
    if (!agentId || !taskId) throw new Error('Activity agent and task are required');
    return this.store.db.runTransaction(async (tx) => {
      const agents = await tx.get(this.store.collection('agents').limit(2));
      const agent = agents.docs[0];
      if (
        agents.size !== 1 ||
        !agent ||
        agent.id !== documentKey(agentId) ||
        agent.get('id') !== agentId
      )
        throw new Error('Activity requires one matching configured agent');

      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');

      const ref = this.store.doc('tasks', taskId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return taskActivityOutcome('not_found', null);
      const task = decodeRecord<Record<string, unknown>>(snapshot.data());
      if (task.agentId !== agentId) return taskActivityOutcome('not_found', null);
      if (
        task.id !== taskId ||
        documentKey(taskId) !== snapshot.id ||
        typeof task.status !== 'string' ||
        !(
          task.archivedAt === null ||
          (task.archivedAt instanceof Date && Number.isFinite(task.archivedAt.getTime()))
        )
      )
        throw new Error('Invalid activity task');

      if (isChatAdmissionCancellationProjection(task))
        return taskActivityOutcome('not_found', null);
      if (action === 'archive') {
        if (!TERMINAL.has(task.status)) return withCurrent(task, {}, 'no_longer_retriable');
        if (task.archivedAt !== null) return withCurrent(task, {}, 'already_archived');
      } else if (task.archivedAt === null) {
        return withCurrent(task, {}, 'already_restored');
      }
      const now = this.store.now();
      tx.update(ref, { archivedAt: action === 'archive' ? now : null, updatedAt: now });
      return withCurrent(
        task,
        { archivedAt: action === 'archive' ? now.toISOString() : null },
        action === 'archive' ? 'archived' : 'restored',
        true,
      );
    });
  }

  private async changeOwnerTask(
    agentId: string,
    taskId: string,
    update: (
      task: Record<string, unknown>,
      ref: DocumentReference,
      tx: Transaction,
    ) => TaskActivityCommandOutcome | Promise<TaskActivityCommandOutcome>,
  ): Promise<TaskActivityCommandOutcome> {
    if (!agentId || !taskId) throw new Error('Activity agent and task are required');
    return this.store.db.runTransaction(async (tx) => {
      const agents = await tx.get(this.store.collection('agents').limit(2));
      const agent = agents.docs[0];
      if (
        agents.size !== 1 ||
        !agent ||
        agent.id !== documentKey(agentId) ||
        agent.get('id') !== agentId
      )
        throw new Error('Activity requires one matching configured agent');

      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');

      const ref = this.store.doc('tasks', taskId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== agentId) {
        return taskActivityOutcome('not_found', null);
      }
      const task = decodeRecord<Record<string, unknown>>(snapshot.data());
      if (task.id !== taskId || documentKey(taskId) !== snapshot.id)
        throw new Error('Invalid activity task');
      if (isChatAdmissionCancellationProjection(task))
        return taskActivityOutcome('not_found', null);
      return update(task, ref, tx);
    });
  }
}
