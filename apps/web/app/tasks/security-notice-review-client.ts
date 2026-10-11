import type { OwnerSecurityReviewItem } from '@assistant/application/security-incidents';

const endpoint = '/api/mobile/v1/security-reviews';
const incidentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    ['unreviewed', 'expected', 'dismissed'].includes(String(item.disposition)) &&
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
  const response = await fetch(`${endpoint}?limit=50`, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`Security review list failed (${response.status})`);
  const payload: unknown = await response.json();
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
  let response: Response;
  try {
    response = await fetch(`${endpoint}/${encodeURIComponent(incidentId)}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return 'uncertain';
  }
  if (response.status === 409) return 'stale';
  if (!response.ok) return 'uncertain';
  try {
    const payload: unknown = await response.json();
    return payload && typeof payload === 'object' && (payload as { ok?: unknown }).ok === true
      ? 'saved'
      : 'uncertain';
  } catch {
    return 'uncertain';
  }
}
