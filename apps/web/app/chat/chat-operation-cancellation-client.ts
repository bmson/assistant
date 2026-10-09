export interface ChatOperationCancellationIdentity {
  conversationId: string;
  clientOperationId: string;
}

export interface ChatOperationTurnFence extends ChatOperationCancellationIdentity {
  turnToken: number;
  scopeGeneration: number;
}

export type ChatOperationCancellationOutcome =
  | {
      kind: 'confirmed';
      outcome: 'cancelled_before_admission';
      taskId: null;
      taskStatus: null;
      transitioned: boolean;
      effectStatus: 'not_started';
    }
  | {
      kind: 'confirmed';
      outcome: 'cancelled' | 'already_cancelled' | 'already_terminal';
      taskId: string;
      taskStatus: 'cancelled' | 'done' | 'failed';
      transitioned: boolean;
      effectStatus: 'unknown';
    }
  | { kind: 'unknown' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function matchesIdentity(
  value: Record<string, unknown>,
  identity: ChatOperationCancellationIdentity,
): boolean {
  return (
    value.conversationId === identity.conversationId &&
    value.clientOperationId === identity.clientOperationId
  );
}

/** A late response may mutate state only while the captured turn is still current. */
export function isCurrentChatOperation(
  current: ChatOperationTurnFence | null,
  captured: ChatOperationTurnFence,
): boolean {
  return (
    current !== null &&
    current.conversationId === captured.conversationId &&
    current.clientOperationId === captured.clientOperationId &&
    current.turnToken === captured.turnToken &&
    current.scopeGeneration === captured.scopeGeneration
  );
}

/** A send-side 409 is terminal only when it carries the exact cancellation receipt. */
export function isCancelledBeforeAdmissionSend(
  value: unknown,
  identity: ChatOperationCancellationIdentity,
): boolean {
  const body = record(value);
  return (
    body !== null &&
    body.ok === false &&
    body.outcome === 'cancelled_before_admission' &&
    body.reason === 'cancelled_before_admission' &&
    body.code === 'chat_turn_cancelled_before_admission' &&
    body.effectStatus === 'not_started' &&
    body.taskId === null &&
    matchesIdentity(body, identity)
  );
}

/** Submit exactly the admission identity; every unrecognized response stays unknown. */
export async function requestChatOperationCancellation(
  identity: ChatOperationCancellationIdentity,
  fetcher: typeof fetch = fetch,
): Promise<ChatOperationCancellationOutcome> {
  if (!UUID_RE.test(identity.conversationId) || !UUID_RE.test(identity.clientOperationId))
    return { kind: 'unknown' };

  let response: Response;
  try {
    response = await fetcher('/api/chat/cancel', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: identity.conversationId,
        clientOperationId: identity.clientOperationId,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return { kind: 'unknown' };
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = record(await response.json());
  } catch {
    return { kind: 'unknown' };
  }
  if (!response.ok || !body || body.ok !== true || !matchesIdentity(body, identity))
    return { kind: 'unknown' };

  if (
    body.outcome === 'cancelled_before_admission' &&
    body.taskId === null &&
    typeof body.transitioned === 'boolean' &&
    body.effectStatus === 'not_started'
  )
    return {
      kind: 'confirmed',
      outcome: 'cancelled_before_admission',
      taskId: null,
      taskStatus: null,
      transitioned: body.transitioned,
      effectStatus: 'not_started',
    };

  if (
    (body.outcome === 'cancelled' || body.outcome === 'already_cancelled') &&
    typeof body.taskId === 'string' &&
    UUID_RE.test(body.taskId) &&
    body.taskStatus === 'cancelled' &&
    typeof body.transitioned === 'boolean' &&
    body.transitioned === (body.outcome === 'cancelled') &&
    body.effectStatus === 'unknown'
  )
    return {
      kind: 'confirmed',
      outcome: body.outcome,
      taskId: body.taskId,
      taskStatus: 'cancelled',
      transitioned: body.transitioned,
      effectStatus: 'unknown',
    };

  if (
    body.outcome === 'already_terminal' &&
    typeof body.taskId === 'string' &&
    UUID_RE.test(body.taskId) &&
    (body.taskStatus === 'done' || body.taskStatus === 'failed') &&
    body.transitioned === false &&
    body.effectStatus === 'unknown'
  )
    return {
      kind: 'confirmed',
      outcome: 'already_terminal',
      taskId: body.taskId,
      taskStatus: body.taskStatus,
      transitioned: false,
      effectStatus: 'unknown',
    };

  return { kind: 'unknown' };
}
