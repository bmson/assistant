import type { Records } from './records.js';

export const CHAT_ADMISSION_PROTOCOL = 'owner-chat-v1';
export type ChatAdmissionPhase = 'classifying' | 'streaming' | 'queued';
export type ChatAdmissionTriageOutcome = 'actionable' | 'conversational';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertChatAdmissionOperationId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value))
    throw new Error('Invalid chat admission operation identity');
}

export function chatAdmissionExternalEventId(input: {
  agentId: string;
  conversationId: string;
  clientOperationId: string;
}): string {
  return `chat-admission:${input.agentId}:${input.conversationId}:${input.clientOperationId}`;
}

export function chatAdmissionPayload(task: Pick<Records['tasks'], 'trigger'>): {
  clientOperationId: string;
  requestHash: string;
  triggerMessageId: string;
  phase: ChatAdmissionPhase;
  triageOutcome?: ChatAdmissionTriageOutcome;
} | null {
  const trigger = task.trigger;
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return null;
  const payload = (trigger as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const admission = (payload as Record<string, unknown>).chatAdmission;
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)) return null;
  const value = admission as Record<string, unknown>;
  if (
    value.protocol !== CHAT_ADMISSION_PROTOCOL ||
    typeof value.clientOperationId !== 'string' ||
    typeof value.requestHash !== 'string' ||
    typeof value.triggerMessageId !== 'string' ||
    !['classifying', 'streaming', 'queued'].includes(String(value.phase))
  )
    return null;
  return {
    clientOperationId: value.clientOperationId,
    requestHash: value.requestHash,
    triggerMessageId: value.triggerMessageId,
    phase: value.phase as ChatAdmissionPhase,
    ...(value.triageOutcome === 'actionable' || value.triageOutcome === 'conversational'
      ? { triageOutcome: value.triageOutcome }
      : {}),
  };
}

export function withChatAdmissionPhase(
  trigger: unknown,
  phase: ChatAdmissionPhase,
  triagedActionable = false,
  triageOutcome?: ChatAdmissionTriageOutcome,
): Record<string, unknown> {
  const source =
    trigger && typeof trigger === 'object' && !Array.isArray(trigger)
      ? (trigger as Record<string, unknown>)
      : {};
  const payload =
    source.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
      ? (source.payload as Record<string, unknown>)
      : {};
  const admission =
    payload.chatAdmission &&
    typeof payload.chatAdmission === 'object' &&
    !Array.isArray(payload.chatAdmission)
      ? (payload.chatAdmission as Record<string, unknown>)
      : {};
  const nextPayload = {
    ...payload,
    chatAdmission: {
      ...admission,
      phase,
      ...(triageOutcome ? { triageOutcome } : {}),
    },
    ...(triagedActionable ? { triagedActionable: true } : {}),
  };
  return { ...source, payload: nextPayload };
}

export interface ChatAdmissionCancellationPayload {
  protocol: typeof CHAT_ADMISSION_PROTOCOL;
  clientOperationId: string;
}

type CancellationTask = Pick<
  Records['tasks'],
  | 'agentId'
  | 'trust'
  | 'conversationId'
  | 'externalEventId'
  | 'type'
  | 'status'
  | 'title'
  | 'trigger'
  | 'plan'
  | 'state'
  | 'progress'
  | 'progressPercent'
  | 'nextAction'
  | 'goalId'
  | 'parentTaskId'
  | 'autonomyGrant'
  | 'runAfter'
  | 'lockedUntil'
  | 'leaseToken'
  | 'queueGeneration'
  | 'attempt'
  | 'spentUsd'
  | 'archivedAt'
  | 'attentionNotifiedAt'
  | 'deadline'
  | 'reflectEvery'
  | 'lastReflectedAt'
  | 'reclaimCount'
  | 'maxSteps'
  | 'budgetUsdLimit'
>;

/** Build the deliberately content-free marker used when Stop wins before admission. */
export function chatAdmissionCancellationTrigger(input: {
  agentId: string;
  conversationId: string;
  clientOperationId: string;
}): Record<string, unknown> {
  if (!input.agentId || !input.conversationId || !UUID_RE.test(input.clientOperationId))
    throw new Error('Invalid chat admission cancellation identity');
  return {
    source: 'chat',
    agentId: input.agentId,
    conversationId: input.conversationId,
    trust: 'owner',
    payload: {
      chatAdmissionCancellation: {
        protocol: CHAT_ADMISSION_PROTOCOL,
        clientOperationId: input.clientOperationId,
      },
    },
  };
}

/**
 * Recognizes the marker namespace from the lightweight fields used by Activity
 * and task-status projections. Full replay still uses the stricter empty-row
 * parser below.
 */
export function isChatAdmissionCancellationProjection(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  const trigger = task.trigger;
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return false;
  const triggerRow = trigger as Record<string, unknown>;
  const payload = triggerRow.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const payloadRow = payload as Record<string, unknown>;
  const marker = payloadRow.chatAdmissionCancellation;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
  const markerRow = marker as Record<string, unknown>;
  const operationId = markerRow.clientOperationId;
  const agentId = task.agentId;
  const conversationId = task.conversationId;
  return (
    task.status === 'cancelled' &&
    task.type === 'chat_turn' &&
    task.trust === 'owner' &&
    typeof agentId === 'string' &&
    agentId.length > 0 &&
    typeof conversationId === 'string' &&
    conversationId.length > 0 &&
    typeof task.externalEventId === 'string' &&
    typeof operationId === 'string' &&
    UUID_RE.test(operationId) &&
    task.externalEventId ===
      chatAdmissionExternalEventId({
        agentId,
        conversationId,
        clientOperationId: operationId,
      }) &&
    triggerRow.source === 'chat' &&
    triggerRow.agentId === agentId &&
    triggerRow.conversationId === conversationId &&
    triggerRow.trust === 'owner' &&
    Object.keys(triggerRow).sort().join(',') === 'agentId,conversationId,payload,source,trust' &&
    Object.keys(payloadRow).join(',') === 'chatAdmissionCancellation' &&
    markerRow.protocol === CHAT_ADMISSION_PROTOCOL &&
    Object.keys(markerRow).sort().join(',') === 'clientOperationId,protocol'
  );
}

/**
 * Recognize only the exact empty terminal marker. Normal admission parsing stays
 * unchanged, and malformed or content-bearing rows fail closed as ordinary data.
 */
export function chatAdmissionCancellationPayload(
  task: CancellationTask,
): ChatAdmissionCancellationPayload | null {
  if (!isChatAdmissionCancellationProjection(task)) return null;
  const trigger = task.trigger;
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return null;
  const triggerRow = trigger as Record<string, unknown>;
  const payload = triggerRow.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const payloadRow = payload as Record<string, unknown>;
  const marker = payloadRow.chatAdmissionCancellation;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  const markerRow = marker as Record<string, unknown>;
  const operationId = markerRow.clientOperationId;
  if (
    task.status !== 'cancelled' ||
    task.type !== 'chat_turn' ||
    task.trust !== 'owner' ||
    !task.agentId ||
    !task.conversationId ||
    typeof operationId !== 'string' ||
    !UUID_RE.test(operationId) ||
    task.externalEventId !==
      chatAdmissionExternalEventId({
        agentId: task.agentId,
        conversationId: task.conversationId,
        clientOperationId: operationId,
      }) ||
    task.title !== null ||
    task.plan !== null ||
    task.progress !== '' ||
    task.progressPercent !== null ||
    task.nextAction !== '' ||
    task.goalId !== null ||
    task.parentTaskId !== null ||
    task.autonomyGrant !== null ||
    task.runAfter !== null ||
    task.lockedUntil !== null ||
    task.leaseToken !== null ||
    task.queueGeneration !== 0 ||
    task.attempt !== 0 ||
    task.spentUsd !== '0.000000' ||
    task.archivedAt !== null ||
    task.attentionNotifiedAt !== null ||
    task.deadline !== null ||
    task.reflectEvery !== null ||
    task.lastReflectedAt !== null ||
    task.reclaimCount !== 0 ||
    task.maxSteps !== 12 ||
    task.budgetUsdLimit !== '0.5000' ||
    !task.state ||
    typeof task.state !== 'object' ||
    Array.isArray(task.state) ||
    Object.keys(task.state).length !== 0 ||
    triggerRow.source !== 'chat' ||
    triggerRow.agentId !== task.agentId ||
    triggerRow.conversationId !== task.conversationId ||
    triggerRow.trust !== 'owner' ||
    Object.keys(triggerRow).sort().join(',') !== 'agentId,conversationId,payload,source,trust' ||
    Object.keys(payloadRow).join(',') !== 'chatAdmissionCancellation' ||
    markerRow.protocol !== CHAT_ADMISSION_PROTOCOL ||
    markerRow.clientOperationId !== operationId ||
    Object.keys(markerRow).sort().join(',') !== 'clientOperationId,protocol'
  )
    return null;
  return { protocol: CHAT_ADMISSION_PROTOCOL, clientOperationId: operationId };
}
