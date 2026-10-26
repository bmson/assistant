const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function validRecoveryTask(value: string | null): string | null {
  return value && UUID.test(value) ? value : null;
}

/** Recovery URLs carry identity only. The owner status read must verify it again. */
export function requestRecoveryHref(conversationId: string, taskId: string): string | null {
  if (!UUID.test(conversationId) || !UUID.test(taskId)) return null;
  return `/chat/${conversationId}?task=${taskId}#request-status`;
}

export function recoveryTaskFromUrl(value: string, conversationId: string): string | null {
  if (!UUID.test(conversationId)) return null;
  const url = new URL(value);
  if (url.pathname !== `/chat/${conversationId}` && url.pathname !== '/chat') return null;
  const task = url.searchParams.get('task');
  return validRecoveryTask(task);
}

export const CANCELLED_REQUEST_NOTE =
  'This request was stopped. Work already sent to a service may still finish; its outcome is unconfirmed.';

export interface RequestRecoveryNote {
  text: string;
  retryable: boolean;
  taskId?: string;
  /** Set only from a confirmed cancellation receipt or persisted cancelled status. */
  confirmedCancellation?: true;
}

export function cancelledRequestNote(taskId: string): RequestRecoveryNote {
  return { text: CANCELLED_REQUEST_NOTE, retryable: false, taskId, confirmedCancellation: true };
}

/** URL selection is identity only; retain an already confirmed same-task receipt. */
export function selectedRequestNote(
  previous: RequestRecoveryNote | null,
  taskId: string,
): RequestRecoveryNote {
  if (previous?.taskId === taskId && previous.confirmedCancellation === true) return previous;
  return { text: 'Checking this request’s saved status…', retryable: false, taskId };
}

/** Persisted task status never proves a service-side effect was undone. */
export function requestStatusNote(status: string | null): string {
  switch (status) {
    case 'cancelled':
      return CANCELLED_REQUEST_NOTE;
    case 'failed':
      return 'Unable to finish this request. Check the saved reply for any partial results.';
    case 'waiting_approval':
      return 'This request needs your approval. Review its saved approval card in this chat.';
    case 'waiting_budget':
      return 'This request needs a budget decision. Review its saved budget card in this chat.';
    case 'needs_attention':
      return 'This request needs your attention. Review its saved explanation in this chat.';
    case 'pending':
      return 'Checking this request: it is queued and has not started yet.';
    case 'running':
      return 'Checking this request: it is still running. Its answer has not arrived yet.';
    case 'sleeping':
      return 'This request is waiting until its next run.';
    case 'waiting_event':
      return 'This request is waiting for an event.';
    case 'done':
      return 'This request is marked complete. Check its saved reply for the result.';
    default:
      return 'Unable to verify this request’s current status. No result or stop has been confirmed.';
  }
}

export interface StopRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
function stopKey(scope: string, conversationId: string): string {
  return `assistant:unconfirmed-stop:${encodeURIComponent(scope)}:${conversationId}`;
}
/** Store identity, never an inferred cancellation result or private message text. */
export function saveUnconfirmedStop(
  storage: StopRecoveryStorage,
  scope: string,
  conversationId: string,
  operationId: string | null,
): void {
  if (!scope || !UUID.test(conversationId)) return;
  const key = stopKey(scope, conversationId);
  if (operationId === null) storage.removeItem(key);
  else if (UUID.test(operationId)) storage.setItem(key, operationId);
}
export function readUnconfirmedStop(
  storage: StopRecoveryStorage,
  scope: string,
  conversationId: string,
): string | null {
  if (!scope || !UUID.test(conversationId)) return null;
  const value = storage.getItem(stopKey(scope, conversationId));
  return value && UUID.test(value) ? value : null;
}
