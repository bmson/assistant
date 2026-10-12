export interface ChecklistCancellationRequest {
  taskId: string;
  itemId: string;
  expectedRevision: number;
  expectedCancellationRevision: number;
  ownerMessageId: string;
}

interface CancellationAuditResponse {
  revision: number;
  checklistRevision: number;
  taskId: string;
  ownerTaskId: string;
  ownerMessageId: string;
  itemIds: string[];
}

interface CancellationReconciliationResponse {
  id: string;
  checklistRevision: number;
  cancellationRevision: number;
  audit: CancellationAuditResponse | null;
}

export type ChecklistCancellationResult =
  | { kind: 'cancelled'; ownerMessageId: string }
  | { kind: 'unknown' }
  | { kind: 'rejected'; message: string };

const WALL_DEADLINE_MS = 12_000;
const POST_DEADLINE_MS = 9_000;

async function boundedJson(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  if (externalSignal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeExternalListener: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new DOMException('Request timed out', 'TimeoutError'));
      },
      Math.max(1, timeoutMs),
    );
  });
  const cancelled = new Promise<never>((_resolve, reject) => {
    if (!externalSignal) return;
    const onAbort = () => {
      controller.abort();
      reject(new DOMException('Request cancelled', 'AbortError'));
    };
    externalSignal.addEventListener('abort', onAbort, { once: true });
    removeExternalListener = () => externalSignal.removeEventListener('abort', onAbort);
    if (externalSignal.aborted) onAbort();
  });
  const operation = (async () => {
    const response = await fetcher(input, { ...init, signal: controller.signal });
    const body: unknown = await response.json();
    return { response, body };
  })();
  try {
    return await Promise.race([operation, timeout, cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    removeExternalListener?.();
  }
}

function rejectionMessage(outcome: unknown): string {
  switch (outcome) {
    case 'stale_revision':
      return 'This request changed while the page was open. Refresh Activity and review it.';
    case 'unsafe_evidence':
      return 'This request has work that prevents cancelling it. Review Activity to continue.';
    case 'no_longer_retriable':
      return 'This request is no longer waiting for a change. Refresh Activity to review it.';
    case 'not_found':
      return 'This Activity item is no longer available.';
    default:
      return 'This request could not be cancelled. Review Activity to continue.';
  }
}

function matchesCancellation(
  request: ChecklistCancellationRequest,
  value: unknown,
): value is CancellationReconciliationResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<CancellationReconciliationResponse>;
  const audit = response.audit;
  return (
    response.id === request.taskId &&
    Number.isSafeInteger(response.checklistRevision) &&
    Number(response.checklistRevision) >= request.expectedRevision &&
    Number.isSafeInteger(response.cancellationRevision) &&
    Number(response.cancellationRevision) >= request.expectedCancellationRevision + 1 &&
    Number(response.cancellationRevision) <= 12 &&
    Boolean(audit) &&
    audit?.revision === request.expectedCancellationRevision + 1 &&
    audit?.checklistRevision === request.expectedRevision &&
    audit?.taskId === request.taskId &&
    audit?.ownerTaskId === request.taskId &&
    audit?.ownerMessageId === request.ownerMessageId &&
    audit?.itemIds?.length === 1 &&
    audit.itemIds[0] === request.itemId
  );
}

async function reconcile(
  request: ChecklistCancellationRequest,
  fetcher: typeof fetch,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<boolean> {
  try {
    const url = `/api/mobile/v1/activity/${encodeURIComponent(request.taskId)}?cancellationOwnerMessageId=${encodeURIComponent(request.ownerMessageId)}`;
    const { response, body } = await boundedJson(
      fetcher,
      url,
      { method: 'GET', cache: 'no-store' },
      timeoutMs,
      externalSignal,
    );
    return response.ok && matchesCancellation(request, body);
  } catch {
    return false;
  }
}

export async function reconcileActivityChecklistCancellation(
  request: ChecklistCancellationRequest,
  fetcher: typeof fetch = fetch,
  timeoutMs = 3_000,
  externalSignal?: AbortSignal,
): Promise<boolean> {
  return reconcile(request, fetcher, timeoutMs, externalSignal);
}

/** One bounded POST; an ambiguous result gets one exact cancellation-audit read. */
export async function cancelActivityChecklistItem(
  request: ChecklistCancellationRequest,
  fetcher: typeof fetch = fetch,
  externalSignal?: AbortSignal,
): Promise<ChecklistCancellationResult> {
  const startedAt = Date.now();
  try {
    const { response, body: rawBody } = await boundedJson(
      fetcher,
      `/api/mobile/v1/activity/${encodeURIComponent(request.taskId)}`,
      {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'cancel-checklist',
          itemId: request.itemId,
          expectedRevision: request.expectedRevision,
          expectedCancellationRevision: request.expectedCancellationRevision,
          ownerMessageId: request.ownerMessageId,
        }),
      },
      POST_DEADLINE_MS,
      externalSignal,
    );
    const body = rawBody as {
      ok?: unknown;
      outcome?: unknown;
      transitioned?: unknown;
      queueGeneration?: unknown;
      ownerMessageId?: unknown;
      taskId?: unknown;
      itemId?: unknown;
      checklistRevision?: unknown;
      cancellationRevision?: unknown;
    };
    if (
      response.ok &&
      body.ok === true &&
      (body.outcome === 'cancelled' || body.outcome === 'already_cancelled') &&
      body.transitioned === (body.outcome === 'cancelled') &&
      Number.isSafeInteger(body.queueGeneration) &&
      Number(body.queueGeneration) >= 0 &&
      body.ownerMessageId === request.ownerMessageId &&
      body.taskId === request.taskId &&
      body.itemId === request.itemId &&
      body.checklistRevision === request.expectedRevision &&
      body.cancellationRevision === request.expectedCancellationRevision + 1
    )
      return { kind: 'cancelled', ownerMessageId: request.ownerMessageId };
    if (response.status >= 400 && response.status < 500)
      return { kind: 'rejected', message: rejectionMessage(body.outcome) };
  } catch {
    // A timeout or dropped connection leaves the write outcome unknown.
  }

  const remaining = WALL_DEADLINE_MS - (Date.now() - startedAt);
  if (
    remaining > 0 &&
    (await reconcile(request, fetcher, Math.min(3_000, remaining), externalSignal))
  )
    return { kind: 'cancelled', ownerMessageId: request.ownerMessageId };
  return { kind: 'unknown' };
}
