import {
  type ClarificationContinuation,
  ClarificationContinuationSchema,
  PendingFinalSchema,
} from '../events.js';
import { extractOwnerIntent, type OwnerIntent, type OwnerIntentScope } from './owner-intent.js';
import { detectPersonalReadRequest, type PersonalReadRequest } from './read-intent.js';
import { ownerCancellationAuditIsConsistent } from './request-checklist.js';
import { type RequestChecklist, RequestChecklistSchema } from './request-checklist-schema.js';

export interface ChecklistCorrectionResumeMessage {
  id: string;
  taskId: string;
  agentId: string;
  conversationId: string;
  role: 'user';
  origin: 'owner';
  text: string;
  createdAt: Date;
}

export interface ChecklistCorrectionResumeInput {
  task: { id: string; agentId: string; conversationId: string };
  checklist: RequestChecklist;
  /** Exact durable row referenced by the final revision audit entry. */
  ownerMessage: ChecklistCorrectionResumeMessage;
  /** Current conversation head supplied by the caller, never inferred from window order. */
  latestConversationOwnerMessageId: string;
  /** Authority extracted from the task's original trigger/request, not the correction. */
  originalIntent: OwnerIntent;
  clarificationContinuation?: ClarificationContinuation;
}

/**
 * Whether an owner retry may deliver an already staged correction response
 * after a definite channel rejection. The caller still has to load the exact
 * durable owner message and fence this snapshot in its transaction.
 */
type ChecklistCorrectionFinalEligibilityInput = {
  task: {
    id: string;
    agentId: string;
    conversationId: string | null;
    type: string;
    trust: string;
    goalId: string | null;
    trigger: unknown;
  };
  state: unknown;
  ownerMessage: {
    id: string;
    taskId: string | null;
    agentId: string;
    conversationId: string | null;
    role: string;
    origin: string;
    text: string;
    hiddenAt?: Date | null;
  };
};

function checklistCorrectionFinalMatches(
  input: ChecklistCorrectionFinalEligibilityInput,
  failedStatus: 'rejected' | 'unknown',
): boolean {
  const { task, ownerMessage } = input;
  const state = input.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  const stateRecord = state as Record<string, unknown>;
  const checklistResult = RequestChecklistSchema.safeParse(stateRecord.requestChecklist);
  if (!checklistResult.success) return false;
  const checklist = checklistResult.data;
  const pendingResult = PendingFinalSchema.safeParse(stateRecord.pendingFinal);
  if (!pendingResult.success) return false;
  const pending = pendingResult.data;
  const correction = pending.checklistCorrection;
  if (!correction) return false;
  const outcomes = correction.outcomes;
  const legs = pending.finalDelivery?.legs;
  if (!legs) return false;
  const trigger = task.trigger;
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return false;
  const triggerRecord = trigger as Record<string, unknown>;
  const payload = triggerRecord.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const payloadRecord = payload as Record<string, unknown>;
  const revision = checklist.revision;
  const audit = checklist.revisionAudit;
  const latestAudit = audit?.at(-1);
  if (
    task.type !== 'chat_turn' ||
    task.trust !== 'owner' ||
    task.goalId !== null ||
    !task.conversationId ||
    triggerRecord.source !== 'chat' ||
    triggerRecord.agentId !== task.agentId ||
    triggerRecord.conversationId !== task.conversationId ||
    triggerRecord.trust !== 'owner' ||
    payloadRecord.text !== checklist.request ||
    typeof payloadRecord.triggerMessageId !== 'string' ||
    payloadRecord.triggerMessageId.length === 0 ||
    pending.deliveryNeedsAttention !== true ||
    pending.terminalStatus !== 'needs_attention' ||
    pending.outcome !== 'needs_attention' ||
    !legs.some(
      (leg) => leg && typeof leg === 'object' && !Array.isArray(leg) && leg.status === failedStatus,
    ) ||
    legs.some((leg) => {
      if (!leg || typeof leg !== 'object' || Array.isArray(leg)) return true;
      const status = leg.status;
      const allowedStatuses =
        failedStatus === 'unknown'
          ? ['accepted', 'rejected', 'unknown', 'not_applicable']
          : ['accepted', 'rejected', 'not_applicable'];
      return !allowedStatuses.includes(status);
    }) ||
    !Number.isSafeInteger(revision) ||
    revision === undefined ||
    correction.revision !== revision ||
    typeof correction.ownerMessageId !== 'string' ||
    !latestAudit ||
    latestAudit.revision !== revision ||
    latestAudit.taskId !== task.id ||
    latestAudit.conversationId !== task.conversationId ||
    latestAudit.ownerTaskId !== task.id ||
    latestAudit.ownerMessageId !== correction.ownerMessageId ||
    !outcomes.length ||
    ownerMessage.id !== correction.ownerMessageId ||
    ownerMessage.taskId !== task.id ||
    ownerMessage.agentId !== task.agentId ||
    ownerMessage.conversationId !== task.conversationId ||
    ownerMessage.role !== 'user' ||
    ownerMessage.origin !== 'owner' ||
    ownerMessage.hiddenAt !== null ||
    directClause(ownerMessage.text) !== directClause(latestAudit.toLabel)
  )
    return false;
  const seen = new Set<string>();
  for (const value of outcomes) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const outcome = value as Record<string, unknown>;
    if (
      typeof outcome.id !== 'string' ||
      seen.has(outcome.id) ||
      !Array.isArray(outcome.evidenceIds) ||
      outcome.evidenceIds.some((id) => typeof id !== 'string')
    )
      return false;
    seen.add(outcome.id);
    const item = checklist.items.find((candidate) => candidate.id === outcome.id);
    if (
      !item ||
      (outcome.status !== 'completed' && outcome.status !== 'blocked') ||
      item.status !== outcome.status ||
      new Set(outcome.evidenceIds).size !== outcome.evidenceIds.length ||
      new Set(item.evidence.map((entry) => entry.id)).size !== item.evidence.length ||
      [...outcome.evidenceIds].sort().join('\u0000') !==
        item.evidence
          .map((entry) => entry.id)
          .sort()
          .join('\u0000') ||
      (item.status === 'completed' && outcome.evidenceIds.length === 0)
    )
      return false;
  }
  return seen.has(latestAudit.itemId);
}

/** Owner retry may redeliver only a definitely rejected correction response. */
export function isRetryableChecklistCorrectionFinal(
  input: ChecklistCorrectionFinalEligibilityInput,
): boolean {
  return checklistCorrectionFinalMatches(input, 'rejected');
}

/** A correction final with an ambiguous delivery stays saved and cannot be retried. */
export function isParkedUnknownChecklistCorrectionFinal(
  input: ChecklistCorrectionFinalEligibilityInput,
): boolean {
  return checklistCorrectionFinalMatches(input, 'unknown');
}

export interface ChecklistCorrectionResumeProjection {
  taskId: string;
  conversationId: string;
  revision: number;
  ownerMessageId: string;
  selectedOutcomeId: string;
  selectedReferenceAt: Date;
  originalRequest: string;
  authorizedScopes: OwnerIntentScope[];
  activeOutcomes: Array<{
    id: string;
    kind: RequestChecklist['items'][number]['kind'];
    label: string;
    targetTerms: string[];
    status: 'pending' | 'blocked';
    excludedEvidenceIds: string[];
    /** Resolved from the selected correction message or the item's latest prior audit. */
    referenceAt?: Date;
  }>;
  /** Outcomes completed during an earlier correction attempt remain in the final answer. */
  completedOutcomes: Array<{ id: string; label: string; detail?: string }>;
  excludedOutcomeIds: string[];
  clarificationContinuation?: ClarificationContinuation;
}

/**
 * Bounded projection for an explicit Activity cancellation. It is intentionally
 * separate from correction: the owner removed selected work, not replaced its
 * meaning. Callers must validate every audit message and the current task lease
 * before constructing this projection.
 */
export interface ChecklistCancellationResumeProjection {
  taskId: string;
  conversationId: string;
  cancellationRevision: number;
  ownerMessageId: string;
  originalRequest: string;
  authorizedScopes: OwnerIntentScope[];
  activeOutcomes: Array<{
    id: string;
    kind: RequestChecklist['items'][number]['kind'];
    label: string;
    targetTerms: string[];
    status: 'pending' | 'blocked';
    referenceAt: Date;
  }>;
  completedOutcomes: Array<{ id: string; label: string; detail?: string }>;
  cancelledOutcomeIds: string[];
}

export interface ChecklistCancellationResumeInput {
  task: { id: string; agentId: string; conversationId: string; createdAt: Date };
  checklist: RequestChecklist;
  ownerMessage: ChecklistCorrectionResumeMessage;
  latestConversationOwnerMessageId: string;
  originalIntent: OwnerIntent;
}

/**
 * Create a cancellation-only execution view. Remaining work is limited to
 * direct private lookups; unsupported pending writes park for owner review.
 */
export function projectChecklistCancellationResume(
  input: ChecklistCancellationResumeInput,
): ChecklistCancellationResumeProjection | undefined {
  const { task, checklist, ownerMessage, latestConversationOwnerMessageId, originalIntent } = input;
  if (!RequestChecklistSchema.safeParse(checklist).success) return undefined;
  if (
    !ownerCancellationAuditIsConsistent(checklist) ||
    !task.id ||
    !task.agentId ||
    !task.conversationId ||
    !(task.createdAt instanceof Date) ||
    !Number.isFinite(task.createdAt.getTime()) ||
    ownerMessage.taskId !== task.id ||
    ownerMessage.agentId !== task.agentId ||
    ownerMessage.conversationId !== task.conversationId ||
    ownerMessage.role !== 'user' ||
    ownerMessage.origin !== 'owner' ||
    !ownerMessage.text ||
    ownerMessage.text.length > 8_000 ||
    latestConversationOwnerMessageId !== ownerMessage.id ||
    originalIntent.sourceActor !== 'owner' ||
    originalIntent.requestKind !== 'new_request' ||
    originalIntent.separation !== 'none' ||
    originalIntent.ownerAuthoredText.trim() !== checklist.request.trim()
  )
    return undefined;

  const revision = checklist.cancellationRevision;
  const audit = checklist.cancellationAudit;
  const latest = audit?.at(-1);
  const action = checklist.lastOwnerAction;
  if (
    !Number.isSafeInteger(revision) ||
    revision === undefined ||
    revision < 1 ||
    !audit ||
    audit.length !== revision ||
    !latest ||
    latest.revision !== revision ||
    latest.taskId !== task.id ||
    latest.conversationId !== task.conversationId ||
    latest.ownerTaskId !== task.id ||
    latest.ownerMessageId !== ownerMessage.id ||
    action?.kind !== 'cancel' ||
    action.revision !== revision ||
    action.ownerMessageId !== ownerMessage.id ||
    JSON.stringify(action.itemIds) !== JSON.stringify(latest.itemIds)
  )
    return undefined;

  const cancelledOutcomeIds = [...new Set(audit.flatMap((entry) => entry.itemIds))];
  const active = checklist.items.filter(
    (item) => item.status === 'pending' || item.status === 'blocked',
  );
  if (active.some((item) => item.kind !== 'lookup')) return undefined;
  const completed = checklist.items.filter((item) => item.status === 'completed');
  const excluded = checklist.items.filter((item) => item.status === 'cancelled');
  if (
    cancelledOutcomeIds.length === 0 ||
    excluded.some((item) => !cancelledOutcomeIds.includes(item.id)) ||
    cancelledOutcomeIds.some(
      (id) => !checklist.items.some((item) => item.id === id && item.status === 'cancelled'),
    )
  )
    return undefined;

  return {
    taskId: task.id,
    conversationId: task.conversationId,
    cancellationRevision: revision,
    ownerMessageId: ownerMessage.id,
    originalRequest: checklist.request,
    authorizedScopes: [...originalIntent.authorizedScopes],
    activeOutcomes: active.map((item) => ({
      id: item.id,
      kind: item.kind,
      label: item.label,
      targetTerms: [...item.targetTerms],
      status: item.status as 'pending' | 'blocked',
      referenceAt: task.createdAt,
    })),
    completedOutcomes: completed.map((item) => ({
      id: item.id,
      label: item.label,
      ...('detail' in item && item.detail ? { detail: item.detail } : {}),
    })),
    cancelledOutcomeIds,
  };
}

function directClause(text: string): string {
  return text
    .trim()
    .replace(/[.!?]+$/, '')
    .trim();
}

/** A bounded direct lookup clause, with no quoted, hypothetical, or write scope. */
export function taskBoundCorrectionReadRequest(
  text: string,
  input: {
    now: Date;
    timeZone: string;
    authorizedScopes: OwnerIntentScope[];
  },
): PersonalReadRequest | undefined {
  const intent = extractOwnerIntent({ text, trust: 'owner', trigger: { source: 'chat' } });
  const clause = intent.ownerAuthoredText.trim();
  if (
    intent.sourceActor !== 'owner' ||
    intent.requestKind !== 'new_request' ||
    intent.separation !== 'none' ||
    clause !== text.trim() ||
    !/^\s*(?:please\s+)?(?:find|check|search|look up|read)\b/i.test(clause) ||
    /\b(?:don't|do not|never|if|unless|maybe|might|could|would|likely|possible|said|says|quoted)\b/i.test(
      clause,
    ) ||
    /\b(?:and|then|also)\s+(?:send|email|reply|create|save|remember|remind|schedule|book|cancel|delete|update|invite|draft)\b/i.test(
      clause,
    ) ||
    !intent.authorizedScopes.includes('private_read') ||
    intent.authorizedScopes.some(
      (scope) =>
        (scope !== 'private_read' && scope !== 'external_read') ||
        !input.authorizedScopes.includes(scope),
    )
  )
    return undefined;
  const request = detectPersonalReadRequest([{ role: 'user', content: clause }], input);
  return request && !request.temporalIssue && !request.scopeIssue ? request : undefined;
}

/**
 * Build a task-local resume view after an explicitly selected Activity correction.
 * This does not find a task from conversation recency or create new authority:
 * the caller must provide the complete task identity, its exact durable audit
 * message, and original-trigger intent. Integration must also fence the task
 * lease/state and use the complete durable effect ledger before planning.
 */
export function projectChecklistCorrectionResume(
  input: ChecklistCorrectionResumeInput,
): ChecklistCorrectionResumeProjection | undefined {
  const { task, checklist, ownerMessage, originalIntent } = input;
  if (!RequestChecklistSchema.safeParse(checklist).success) return undefined;
  if (
    !task.id ||
    task.id.length > 128 ||
    !task.agentId ||
    task.agentId.length > 128 ||
    !task.conversationId ||
    task.conversationId.length > 128 ||
    ownerMessage.id.length === 0 ||
    ownerMessage.id.length > 128 ||
    ownerMessage.taskId !== task.id ||
    ownerMessage.agentId !== task.agentId ||
    ownerMessage.conversationId !== task.conversationId ||
    ownerMessage.role !== 'user' ||
    ownerMessage.origin !== 'owner' ||
    !ownerMessage.text ||
    ownerMessage.text.length > 8_000 ||
    !(ownerMessage.createdAt instanceof Date) ||
    !Number.isFinite(ownerMessage.createdAt.getTime()) ||
    input.latestConversationOwnerMessageId !== ownerMessage.id ||
    originalIntent.sourceActor !== 'owner' ||
    originalIntent.requestKind !== 'new_request' ||
    originalIntent.separation !== 'none' ||
    originalIntent.ownerAuthoredText.trim() !== checklist.request.trim() ||
    (input.clarificationContinuation !== undefined &&
      (!ClarificationContinuationSchema.safeParse(input.clarificationContinuation).success ||
        input.clarificationContinuation.answerStatus !== 'answer'))
  )
    return undefined;

  const revision = checklist.revision;
  const audit = checklist.revisionAudit;
  const last = audit?.at(-1);
  if (
    !Number.isSafeInteger(revision) ||
    revision === undefined ||
    revision < 1 ||
    !audit ||
    audit.length !== revision ||
    !last ||
    last.revision !== revision ||
    last.taskId !== task.id ||
    last.conversationId !== task.conversationId ||
    last.ownerTaskId !== task.id ||
    last.ownerMessageId !== ownerMessage.id ||
    directClause(ownerMessage.text) !== directClause(last.toLabel)
  )
    return undefined;

  const selected = checklist.items.find((item) => item.id === last.itemId);
  if (
    !selected ||
    selected.label !== last.toLabel ||
    JSON.stringify(selected.targetTerms) !== JSON.stringify(last.toTargetTerms) ||
    (selected.status !== 'pending' &&
      selected.status !== 'blocked' &&
      selected.status !== 'completed')
  )
    return undefined;

  // Awaiting approval denotes a separate persisted effect/approval lifecycle;
  // it must not be reinterpreted as a resumable checklist outcome here.
  if (checklist.items.some((item) => item.status === 'awaiting_approval')) return undefined;

  const activeOutcomes = checklist.items
    .filter((item) => item.status === 'pending' || item.status === 'blocked')
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      label: item.label,
      targetTerms: [...item.targetTerms],
      status: item.status as 'pending' | 'blocked',
      excludedEvidenceIds: (audit ?? [])
        .filter((entry) => entry.itemId === item.id)
        .flatMap((entry) => entry.excludedEvidenceIds),
    }));
  const completedOutcomes = checklist.items
    .filter(
      (item) => item.status === 'completed' && audit.some((entry) => entry.itemId === item.id),
    )
    .map((item) => ({
      id: item.id,
      label: item.label,
      ...(item.detail ? { detail: item.detail } : {}),
    }));
  return {
    taskId: task.id,
    conversationId: task.conversationId,
    revision,
    ownerMessageId: ownerMessage.id,
    selectedOutcomeId: last.itemId,
    selectedReferenceAt: ownerMessage.createdAt,
    originalRequest: checklist.request,
    authorizedScopes: [...originalIntent.authorizedScopes],
    activeOutcomes,
    completedOutcomes,
    excludedOutcomeIds: checklist.items
      .filter((item) => item.status === 'completed' || item.status === 'cancelled')
      .map((item) => item.id),
    ...(input.clarificationContinuation === undefined
      ? {}
      : { clarificationContinuation: input.clarificationContinuation }),
  };
}
