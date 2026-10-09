import type { ChatTurnCancellationResult } from '@assistant/persistence';

export interface ChatOperationCancellationIdentity {
  conversationId: string;
  clientOperationId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY_KEYS = ['clientOperationId', 'conversationId'];

export const CHAT_OPERATION_CANCEL_MAX_BYTES = 1024;
export const CHAT_OPERATION_CANCEL_MAX_DURATION_MS = 10_000;

export function parseChatOperationCancellationIdentity(
  value: unknown,
): ChatOperationCancellationIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(',') !== IDENTITY_KEYS.join(',')) return null;
  if (
    typeof body.conversationId !== 'string' ||
    !UUID_RE.test(body.conversationId) ||
    typeof body.clientOperationId !== 'string' ||
    !UUID_RE.test(body.clientOperationId)
  )
    return null;
  return {
    conversationId: body.conversationId,
    clientOperationId: body.clientOperationId,
  };
}

/** Public projection deliberately excludes task trigger, prompt and task state. */
export function projectChatOperationCancellation(
  identity: ChatOperationCancellationIdentity,
  result: ChatTurnCancellationResult,
): Record<string, unknown> | null {
  if (result.kind === 'cancelled_before_admission') {
    return {
      ok: true,
      outcome: 'cancelled_before_admission',
      ...identity,
      taskId: null,
      transitioned: result.transitioned,
      effectStatus: 'not_started',
    };
  }
  if (!UUID_RE.test(result.task.id)) return null;
  if (result.status === 'cancelled') {
    return {
      ok: true,
      outcome: result.transitioned ? 'cancelled' : 'already_cancelled',
      ...identity,
      taskId: result.task.id,
      taskStatus: 'cancelled',
      transitioned: result.transitioned,
      effectStatus: 'unknown',
    };
  }
  if (result.status === 'done' || result.status === 'failed') {
    return {
      ok: true,
      outcome: 'already_terminal',
      ...identity,
      taskId: result.task.id,
      taskStatus: result.status,
      transitioned: false,
      effectStatus: 'unknown',
    };
  }
  return null;
}

export function unconfirmedChatOperationCancellation(
  identity: ChatOperationCancellationIdentity,
): Record<string, unknown> {
  return {
    ok: false,
    outcome: 'unknown',
    code: 'cancellation_unconfirmed',
    ...identity,
    taskId: null,
    effectStatus: 'unknown',
    error: 'Cancellation could not be confirmed. Retry with the same operation ID.',
  };
}

export function conflictingChatOperationCancellation(
  identity: ChatOperationCancellationIdentity,
): Record<string, unknown> {
  return {
    ok: false,
    outcome: 'operation_conflict',
    code: 'operation_conflict',
    ...identity,
    taskId: null,
    effectStatus: 'unknown',
    error: 'This operation could not be matched safely.',
  };
}
