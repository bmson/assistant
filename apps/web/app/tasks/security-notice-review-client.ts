import type { OwnerSecurityReviewItem } from '@assistant/application/security-incidents';

const endpoint = '/api/mobile/v1/security-reviews';
const incidentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SECURITY_REVIEW_REQUEST_TIMEOUT_MS = 12_000;

class RequestTimeoutError extends Error {
  constructor() {
    super('Security review request timed out');
    this.name = 'TimeoutError';
  }
}

function withRequestDeadline<T>(
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', onParentAbort);
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onParentAbort = () => {
      controller.abort(parentSignal?.reason);
      finish(() => reject(parentSignal?.reason ?? new DOMException('Aborted', 'AbortError')));
    };
    const timeout = setTimeout(() => {
      controller.abort();
      finish(() => reject(new RequestTimeoutError()));
    }, SECURITY_REVIEW_REQUEST_TIMEOUT_MS);
    if (parentSignal?.aborted) {
      onParentAbort();
      return;
    }
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validEvidence(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  const limits: Record<string, number> = {
    providerIncidentRef: 200,
    eventType: 200,
    affectedAccount: 200,
    eventAt: 200,
    device: 200,
    location: 200,
    recoveryCopyOf: 200,
    evidenceQuote: 600,
  };
  return Object.entries(evidence).every(
    ([key, entry]) => key in limits && boundedText(entry, limits[key] ?? 0),
  );
}

function validReviewItem(value: unknown): value is OwnerSecurityReviewItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.incidentId === 'string' &&
    incidentIdPattern.test(item.incidentId) &&
    Number.isSafeInteger(item.revision) &&
    (item.revision as number) >= 1 &&
    typeof item.disposition === 'string' &&
    ['unreviewed', 'expected', 'dismissed'].includes(item.disposition) &&
    boundedText(item.confidence, 80) &&
    boundedText(item.category, 120) &&
    Number.isFinite(item.importance) &&
    (item.importance as number) >= 0 &&
    (item.importance as number) <= 10 &&
    boundedText(item.subject, 300) &&
    (item.fromName === null || boundedText(item.fromName, 200)) &&
    typeof item.observedAt === 'string' &&
    Number.isFinite(Date.parse(item.observedAt)) &&
    (item.materialChangeReason === null || boundedText(item.materialChangeReason, 300)) &&
    validEvidence(item.evidence)
  );
}

export async function listSecurityReviews(
  signal?: AbortSignal,
): Promise<OwnerSecurityReviewItem[]> {
  const payload: unknown = await withRequestDeadline(signal, async (requestSignal) => {
    const response = await fetch(`${endpoint}?limit=50`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: requestSignal,
    });
    if (!response.ok) throw new Error(`Security review list failed (${response.status})`);
    return response.json();
  });
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { items?: unknown }).items)
  )
    throw new Error('Invalid security review list');
  const items = (payload as { items: unknown[] }).items;
  if (items.length > 50 || !items.every(validReviewItem))
    throw new Error('Invalid security review list');
  const ids = new Set(items.map((item) => (item as OwnerSecurityReviewItem).incidentId));
  if (ids.size !== items.length) throw new Error('Invalid security review list');
  return items as OwnerSecurityReviewItem[];
}

export type SecurityReviewDecisionResult = 'saved' | 'stale' | 'uncertain';

export async function decideSecurityReview(
  incidentId: string,
  body: { expectedRevision: number; disposition: 'expected' | 'dismissed'; reason: string },
  signal?: AbortSignal,
): Promise<SecurityReviewDecisionResult> {
  try {
    return await withRequestDeadline(signal, async (requestSignal) => {
      const response = await fetch(`${endpoint}/${encodeURIComponent(incidentId)}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: requestSignal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 409) return 'stale';
      if (!response.ok) return 'uncertain';
      const payload: unknown = await response.json();
      return payload && typeof payload === 'object' && (payload as { ok?: unknown }).ok === true
        ? 'saved'
        : 'uncertain';
    });
  } catch {
    return 'uncertain';
  }
}
