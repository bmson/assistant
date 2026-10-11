import { type ClarificationContinuation, ClarificationContinuationSchema } from '../events.js';
import { extractOwnerIntent, type OwnerIntent, type OwnerIntentScope } from './owner-intent.js';
import { detectPersonalReadRequest, type PersonalReadRequest } from './read-intent.js';
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
