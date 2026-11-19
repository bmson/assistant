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
  /** Internal budget accounting for a dispatched attempt without a usable usage receipt. */
  modelAttemptEstimate?: 'usage_missing_after_ttl';
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

/** Only a model dispatch with recorded provider/model provenance can be estimated by the sweep. */
export function staleModelAttemptEstimate(metadata: unknown): CostEvidence | undefined {
  if (!metadata || typeof metadata !== 'object') return;
  const { provider, model } = metadata as Record<string, unknown>;
  if (
    typeof provider !== 'string' ||
    !provider.trim() ||
    typeof model !== 'string' ||
    !model.trim()
  )
    return;
  return {
    basis: 'preflight_estimate',
    provider: provider.slice(0, 100),
    model: model.slice(0, 200),
    modelAttemptEstimate: 'usage_missing_after_ttl',
  };
}

export function canCorrectModelAttemptEstimate(evidence: CostEvidence | undefined): boolean {
  return (
    !evidence?.modelAttemptEstimate &&
    (evidence?.basis === 'provider_reported' || evidence?.basis === 'token_rate')
  );
}

export function modelAttemptEstimateKey(reservationId: string): string {
  return `unknown-model-attempt-estimate:${reservationId}`;
}

export function assertUnknownModelSettlementTtl(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
    throw new Error('Invalid unknown model settlement TTL');
}

/** Translate known router diagnostics without exposing stored exception text. */
export function modelAttemptSampleOutcome(reason: unknown): string {
  switch (reason) {
    case 'stream provider attempt aborted':
      return 'stream_aborted';
    case 'provider dispatch exceeded reconciliation window':
      return 'dispatch_timeout';
    case 'provider returned without complete usage or authoritative cost':
      return 'usage_missing';
    case 'usage metering failed after provider success':
      return 'metering_failed';
    case 'model provider attempt failed':
    case 'stream provider attempt failed':
    case 'stream provider call failed':
    case 'tool model attempt failed':
    case 'structured model attempt failed':
      return 'provider_attempt_failed';
    default:
      return 'unknown';
  }
}
