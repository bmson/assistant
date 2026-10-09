/** Missing evidence (including historical events) must never imply a verified charge. */
export type CostBasis =
  | 'provider_reported'
  | 'token_rate'
  | 'preflight_estimate'
  | 'component_ledger'
  | 'unknown';

export interface CostEvidence {
  basis: CostBasis;
  provider?: string;
  model?: string;
  requestId?: string;
  endpoint?: string;
  modelUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
    accounting: 'provider-reported' | 'usage-rate-estimate';
  };
  /** Component ledger for an outbound voice call; contains no transcript content. */
  voiceCallLedger?: import('./call-sessions.js').CallCostLedger;
  /** SMS accounting contains no message body or destination. */
  sms?: import('./sms-segments.js').SmsDeliveryAccounting;
  /** Durable poll state for filling a provider's delayed SMS usage receipt. */
  smsUsageReconciliation?: {
    status: 'pending' | 'complete' | 'exhausted';
    attempts: number;
    nextAttemptAt?: string;
    claimToken?: string;
    leaseUntil?: string;
    lastError?: string;
  };
}

export const COST_BASIS_LABELS: Record<CostBasis, string> = {
  provider_reported: 'Provider-reported',
  token_rate: 'Estimated from usage and rates',
  preflight_estimate: 'Estimated without complete usage',
  component_ledger: 'Reported and estimated components',
  unknown: 'Unverified / historical',
};

export function costBasis(evidence: CostEvidence | null | undefined): CostBasis {
  return evidence?.basis && Object.hasOwn(COST_BASIS_LABELS, evidence.basis)
    ? evidence.basis
    : 'unknown';
}

export interface CostEvidenceTotal {
  basis: CostBasis;
  usd: string;
  count: number;
}
