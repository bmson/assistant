import type {
  EmailSyncRepository,
  SecurityIncidentDisposition,
  SecurityIncidentEvidence,
} from '@assistant/persistence';

export interface OwnerSecurityReviewItem {
  incidentId: string;
  revision: number;
  confidence: string;
  disposition: Exclude<SecurityIncidentDisposition, 'unreviewed'> | 'unreviewed';
  category: string;
  importance: number;
  subject: string;
  fromName: string | null;
  observedAt: string;
  materialChangeReason: string | null;
  evidence: SecurityIncidentEvidence | null;
}

function safeEvidence(evidence: SecurityIncidentEvidence | null): SecurityIncidentEvidence | null {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  const bounded = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= 200 ? value : undefined;
  const quote = evidence.evidenceQuote;
  const evidenceQuote =
    typeof quote === 'string' && quote.trim().length > 0 && quote.length <= 600 ? quote : undefined;
  const safe: SecurityIncidentEvidence = {
    ...(bounded(evidence.providerIncidentRef)
      ? { providerIncidentRef: bounded(evidence.providerIncidentRef) }
      : {}),
    ...(bounded(evidence.eventType) ? { eventType: bounded(evidence.eventType) } : {}),
    ...(bounded(evidence.affectedAccount)
      ? { affectedAccount: bounded(evidence.affectedAccount) }
      : {}),
    ...(bounded(evidence.eventAt) ? { eventAt: bounded(evidence.eventAt) } : {}),
    ...(bounded(evidence.device) ? { device: bounded(evidence.device) } : {}),
    ...(bounded(evidence.location) ? { location: bounded(evidence.location) } : {}),
    ...(bounded(evidence.recoveryCopyOf)
      ? { recoveryCopyOf: bounded(evidence.recoveryCopyOf) }
      : {}),
    ...(evidenceQuote ? { evidenceQuote } : {}),
  };
  return Object.keys(safe).length > 0 ? safe : null;
}

function boundedDisplayText(value: unknown, maxLength: number, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const text = value.trim();
  if (text.length <= maxLength) return text;
  let prefix = '';
  for (const character of text) {
    if (prefix.length + character.length > maxLength - 1) break;
    prefix += character;
  }
  return `${prefix}…`;
}

function optionalDisplayText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return boundedDisplayText(value, maxLength, '');
}

export async function listOwnerSecurityReviews(
  repository: EmailSyncRepository,
  agentId: string,
  limit = 50,
): Promise<OwnerSecurityReviewItem[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Security review limit must be from one to one hundred');
  const rows = await repository.listSecurityReviewItems(agentId, limit);
  return rows.map((row) => ({
    incidentId: row.incidentId,
    revision: row.revision,
    confidence: boundedDisplayText(row.confidence, 80, 'unknown'),
    disposition: row.disposition,
    category: boundedDisplayText(row.category, 120, 'Security activity'),
    importance: row.importance,
    subject: boundedDisplayText(row.subject, 300, 'Security notice'),
    fromName: optionalDisplayText(row.fromName, 200),
    observedAt: row.observedAt.toISOString(),
    materialChangeReason: optionalDisplayText(row.materialChangeReason, 300),
    evidence: safeEvidence(row.evidence),
  }));
}

export type OwnerSecurityDecision = 'expected' | 'dismissed';

const SECURITY_INCIDENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function decideOwnerSecurityIncident(
  repository: EmailSyncRepository,
  agentId: string,
  input: {
    incidentId: string;
    expectedRevision: number;
    disposition: OwnerSecurityDecision;
    reason: string;
    now?: Date;
  },
): Promise<{ ok: boolean }> {
  if (
    !SECURITY_INCIDENT_ID_RE.test(input.incidentId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    (input.disposition !== 'expected' && input.disposition !== 'dismissed') ||
    !input.reason.trim() ||
    input.reason.length > 500
  )
    throw new Error('Invalid security incident decision');
  return {
    ok: await repository.decideSecurityIncident({
      agentId,
      ...input,
      now: input.now ?? new Date(),
    }),
  };
}
