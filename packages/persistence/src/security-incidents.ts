import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

/** Security event facts extracted from one source message. Values are usable
 * only when the adjacent quote was checked against the original message. */
export interface SecurityIncidentEvidence {
  providerIncidentRef?: string;
  eventType?: string;
  affectedAccount?: string;
  eventAt?: string;
  device?: string;
  location?: string;
  recoveryCopyOf?: string;
  evidenceQuote?: string;
}

export interface SecurityIncidentSource {
  agentId: string;
  channelMessageId: string;
  sourceMessageId: string | null;
  authenticated: boolean;
  evidence: SecurityIncidentEvidence | null;
  sourceText: string;
}

export interface SecurityIncidentIdentity {
  incidentKey: string;
  evidenceFingerprint: string;
  confidence: 'provider-reference' | 'recovery-reference' | 'source-message' | 'separate-source';
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const norm = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();

function validReference(value: string | undefined): string | null {
  if (!value || value.length > 500) return null;
  const trimmed = value.trim();
  if (!trimmed || /[\r\n\0]/u.test(trimmed)) return null;
  return trimmed;
}

/**
 * Validate the model's exact support quote before it can influence incident
 * grouping. This deliberately requires the extracted account/device/location
 * and event time to appear literally in the quote; absent or transformed facts
 * remain untrusted for clustering.
 */
export function validateSecurityIncidentEvidence(
  evidence: SecurityIncidentEvidence | null | undefined,
  sourceText: string,
): SecurityIncidentEvidence | null {
  if (!evidence) return null;
  const quote = norm(evidence.evidenceQuote ?? '');
  const source = norm(sourceText);
  if (!quote || quote.length > 600 || !source.includes(quote)) return null;
  const assertedValues = [
    evidence.providerIncidentRef,
    evidence.recoveryCopyOf,
    evidence.affectedAccount,
    evidence.eventAt,
    evidence.device,
    evidence.location,
  ].filter((value): value is string => Boolean(value));
  if (assertedValues.some((value) => value.length > 200 || !quote.includes(norm(value))))
    return null;
  const providerIncidentRef = validReference(evidence.providerIncidentRef ?? undefined);
  const recoveryCopyOf = validReference(evidence.recoveryCopyOf ?? undefined);
  const eventType = validReference(evidence.eventType ?? undefined);
  const affectedAccount = validReference(evidence.affectedAccount ?? undefined);
  const eventAt = validReference(evidence.eventAt ?? undefined);
  const device = validReference(evidence.device ?? undefined);
  const location = validReference(evidence.location ?? undefined);
  return {
    ...(providerIncidentRef ? { providerIncidentRef } : {}),
    ...(eventType ? { eventType } : {}),
    ...(affectedAccount ? { affectedAccount } : {}),
    ...(eventAt ? { eventAt } : {}),
    ...(device ? { device } : {}),
    ...(location ? { location } : {}),
    ...(recoveryCopyOf ? { recoveryCopyOf } : {}),
    evidenceQuote: quote,
  };
}

/**
 * Build a durable owner-scoped identity only from explicit provenance. The
 * fallback identity is unique to one source message, so weak matches never
 * merge alerts by sender, subject, or thread.
 */
export function securityIncidentIdentity(input: SecurityIncidentSource): SecurityIncidentIdentity {
  const evidence = input.authenticated
    ? validateSecurityIncidentEvidence(input.evidence, input.sourceText)
    : null;
  const sourceMessageId = validReference(input.sourceMessageId ?? undefined);
  let identityMaterial: string;
  let confidence: SecurityIncidentIdentity['confidence'];
  if (evidence?.providerIncidentRef) {
    identityMaterial = `provider:${norm(evidence.providerIncidentRef).toLowerCase()}`;
    confidence = 'provider-reference';
  } else if (
    evidence?.eventType &&
    evidence.affectedAccount &&
    evidence.eventAt &&
    (evidence.device || evidence.location) &&
    (evidence.recoveryCopyOf || sourceMessageId)
  ) {
    identityMaterial = [
      'recovery',
      norm(evidence.recoveryCopyOf ?? sourceMessageId ?? '').toLowerCase(),
      norm(evidence.eventType).toLowerCase(),
      norm(evidence.affectedAccount).toLowerCase(),
      norm(evidence.eventAt).toLowerCase(),
      norm(evidence.device ?? '').toLowerCase(),
      norm(evidence.location ?? '').toLowerCase(),
    ].join('\u001f');
    confidence = 'recovery-reference';
  } else if (input.authenticated && sourceMessageId) {
    identityMaterial = `source:${sourceMessageId}`;
    confidence = 'source-message';
  } else {
    identityMaterial = `separate:${input.channelMessageId}`;
    confidence = 'separate-source';
  }
  const evidenceMaterial = evidence
    ? [
        evidence.eventType ?? '',
        evidence.affectedAccount ?? '',
        evidence.eventAt ?? '',
        evidence.device ?? '',
        evidence.location ?? '',
      ]
        .map((value) => norm(value).toLowerCase())
        .join('\u001f')
    : '';
  return {
    incidentKey: hash(`${input.agentId}\u001f${identityMaterial}`),
    evidenceFingerprint: hash(evidenceMaterial || `source:${input.channelMessageId}`),
    confidence,
  };
}

export type SecurityIncidentDisposition = 'unreviewed' | 'expected' | 'dismissed';

export interface SecurityIncidentRecord {
  id: string;
  agentId: string;
  incidentKey: string;
  confidence: string;
  revision: number;
  disposition: string;
  decisionRevision: number | null;
  decisionReason: string | null;
  materialChangeReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SecurityIncidentSourceRecord {
  id: string;
  agentId: string;
  incidentId: string;
  channelMessageId: string;
  sourceMessageId: string | null;
  mailboxHash: string;
  evidenceFingerprint: string;
  observedAt: Date;
}

export interface SecurityIncidentObservation {
  agentId: string;
  channelMessageId: string;
  sourceMessageId: string | null;
  mailbox: string;
  authenticated: boolean;
  evidence: SecurityIncidentEvidence | null;
  sourceText: string;
  observedAt: Date;
  /** Generation captured before the provider/source read began. */
  observationFence?: string | null;
}

/** A bounded candidate for owner-facing attention. The body stays in the
 * existing email source record; only classifier-supported evidence is
 * returned to the briefing producer. */
export interface SecurityIncidentAttentionCandidate {
  channelMessageId: string;
  incidentId: string;
  revision: number;
  confidence: SecurityIncidentIdentity['confidence'];
  disposition: SecurityIncidentDisposition;
  decisionRevision: number | null;
  materialChangeReason: string | null;
  observedAt: Date;
  category: string;
  importance: number;
  subject: string;
  fromName: string | null;
  evidence: SecurityIncidentEvidence | null;
}

export interface SecurityIncidentRepository {
  readonly kind: 'security-incident-repository';
  observe(input: SecurityIncidentObservation): Promise<{
    incident: SecurityIncidentRecord;
    source: SecurityIncidentSourceRecord;
    duplicateEvidence: boolean;
    reassessmentReason: string | null;
  }>;
  getForMessage(agentId: string, channelMessageId: string): Promise<SecurityIncidentRecord | null>;
  listAttentionCandidates(
    agentId: string,
    limit: number,
  ): Promise<SecurityIncidentAttentionCandidate[]>;
  decide(input: {
    agentId: string;
    incidentId: string;
    expectedRevision: number;
    disposition: Exclude<SecurityIncidentDisposition, 'unreviewed'>;
    reason: string;
    now: Date;
  }): Promise<boolean>;
  claimAttention(input: {
    agentId: string;
    incidentId: string;
    revision: number;
    producer: 'arrival' | 'pulse' | 'briefing';
    now: Date;
  }): Promise<boolean>;
  completeAttention(input: {
    agentId: string;
    incidentId: string;
    revision: number;
    deliveryStatus: 'accepted' | 'unknown';
    now: Date;
  }): Promise<boolean>;
}

export function normalizedSecurityIncidentEvidence(
  evidence: SecurityIncidentEvidence | null,
  sourceText: string,
): SecurityIncidentEvidence | null {
  return validateSecurityIncidentEvidence(evidence, sourceText);
}

export function securityIncidentMailboxHash(mailbox: string): string {
  return hash(norm(mailbox).toLowerCase());
}

export function securityIncidentId(agentId: string, incidentKey: string): string {
  const bytes = Buffer.from(hash(`${agentId}\u001f${incidentKey}`).slice(0, 32), 'hex');
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
