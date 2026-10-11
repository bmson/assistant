export interface ChecklistCorrectionRequest {
  taskId: string;
  itemId: string;
  expectedRevision: number;
  ownerMessageId: string;
  replacementLabel: string;
}

interface CorrectionAuditResponse {
  revision: number;
  ownerMessageId: string;
  itemId: string;
  toLabel: string;
  toKind?: string;
}

interface CorrectionReconciliationResponse {
  id: string;
  revision: number;
  audit: CorrectionAuditResponse | null;
}

export type ChecklistCorrectionResult =
  | { kind: 'saved'; ownerMessageId: string }
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
      return 'This request has work that prevents changing its lookup. Review Activity to continue.';
    case 'no_longer_retriable':
      return 'This request is no longer waiting for a lookup change. Refresh Activity to review it.';
    case 'not_found':
      return 'This Activity item is no longer available.';
    default:
      return 'This lookup could not be changed. Review the request and try again.';
  }
}

function matchesCorrection(
  request: ChecklistCorrectionRequest,
  value: unknown,
): value is CorrectionReconciliationResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<CorrectionReconciliationResponse>;
  const audit = response.audit;
  return (
    response.id === request.taskId &&
    Number.isSafeInteger(response.revision) &&
    Number(response.revision) >= request.expectedRevision + 1 &&
    Number(response.revision) <= 12 &&
    Boolean(audit) &&
    audit?.ownerMessageId === request.ownerMessageId &&
    audit?.itemId === request.itemId &&
    audit?.revision === request.expectedRevision + 1 &&
    audit?.toLabel === request.replacementLabel &&
    audit?.toKind === 'lookup'
  );
}

export async function reconcileActivityChecklistCorrection(
  request: ChecklistCorrectionRequest,
  fetcher: typeof fetch = fetch,
  timeoutMs = 3_000,
  externalSignal?: AbortSignal,
): Promise<boolean> {
  try {
    const url = `/api/mobile/v1/activity/${encodeURIComponent(request.taskId)}?correctionOwnerMessageId=${encodeURIComponent(request.ownerMessageId)}`;
    const { response, body } = await boundedJson(
      fetcher,
      url,
      { method: 'GET', cache: 'no-store' },
      timeoutMs,
      externalSignal,
    );
    if (!response.ok) return false;
    return matchesCorrection(request, body);
  } catch {
    return false;
  }
}

/** One bounded POST; on ambiguous delivery, perform exactly one bounded GET reconciliation. */
export async function saveActivityChecklistCorrection(
  request: ChecklistCorrectionRequest,
  fetcher: typeof fetch = fetch,
  externalSignal?: AbortSignal,
): Promise<ChecklistCorrectionResult> {
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
          action: 'correct-checklist',
          itemId: request.itemId,
          expectedRevision: request.expectedRevision,
          ownerMessageId: request.ownerMessageId,
          replacementKind: 'lookup',
          replacementLabel: request.replacementLabel,
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
      revision?: unknown;
      replacementLabel?: unknown;
      replacementKind?: unknown;
    };
    if (
      response.ok &&
      body.ok === true &&
      (body.outcome === 'corrected' || body.outcome === 'already_applied') &&
      body.transitioned === (body.outcome === 'corrected') &&
      Number.isSafeInteger(body.queueGeneration) &&
      Number(body.queueGeneration) >= 0 &&
      body.ownerMessageId === request.ownerMessageId &&
      body.taskId === request.taskId &&
      body.itemId === request.itemId &&
      body.revision === request.expectedRevision + 1 &&
      body.replacementLabel === request.replacementLabel &&
      body.replacementKind === 'lookup'
    )
      return { kind: 'saved', ownerMessageId: request.ownerMessageId };
    if (response.status >= 400 && response.status < 500)
      return { kind: 'rejected', message: rejectionMessage(body.outcome) };
  } catch {
    // A timeout or dropped connection leaves the write outcome unknown.
  }

  const remaining = WALL_DEADLINE_MS - (Date.now() - startedAt);
  if (
    remaining > 0 &&
    (await reconcileActivityChecklistCorrection(request, fetcher, remaining, externalSignal))
  )
    return { kind: 'saved', ownerMessageId: request.ownerMessageId };
  return { kind: 'unknown' };
}
