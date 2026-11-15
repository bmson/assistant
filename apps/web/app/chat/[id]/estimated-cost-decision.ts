import type {
  EstimatedCostDecision,
  EstimatedCostDecisionReceipt,
  EstimatedCostQuote,
} from '@assistant/persistence';

export interface CostDecisionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CostDecisionScope {
  session: string;
  operationId: string;
}

const identifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  /^[A-Za-z0-9._:-]+$/u.test(value);

function storageKey(scope: CostDecisionScope): string {
  if (!identifier(scope.session) || !identifier(scope.operationId)) {
    throw new Error('The current decision session is unavailable.');
  }
  return `assistant.cost-decision.v1:${encodeURIComponent(scope.session)}:${encodeURIComponent(scope.operationId)}`;
}

/** Exact USD text: even a one-microdollar allowance must never appear as zero. */
export function formatCostMicros(micros: number): string {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new Error('Invalid cost amount');
  const amount = BigInt(micros);
  const whole = (amount / 1_000_000n).toLocaleString('en-US');
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `$${whole}.${fraction.padEnd(2, '0')}`;
}

/** Stable across reloads after an ambiguous refresh; changing the current quote creates a new command. */
export async function costQuoteRefreshId(quote: EstimatedCostQuote): Promise<string> {
  const input = new TextEncoder().encode(
    JSON.stringify(['cost-quote-refresh-v1', quote.operationId, quote.quoteId, quote.quoteVersion]),
  );
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', input)).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const moneyFields = [
  'nextAttemptMicros',
  'allowanceMicros',
  'recordedDailyMicros',
  'recordedMonthlyMicros',
  'totalHeldMicros',
  'eligibleHistoricalUnknownMicros',
  'pendingApprovalMicros',
  'dailyCeilingMicros',
  'monthlyCeilingMicros',
  'dailyProjectedGrossMicros',
  'monthlyProjectedGrossMicros',
] as const;

export function isCostQuotePayload(value: unknown): value is EstimatedCostQuote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const quote = value as EstimatedCostQuote;
  return (
    quote.type === 'estimated-cost-approval' &&
    identifier(quote.operationId) &&
    identifier(quote.taskId) &&
    identifier(quote.quoteId) &&
    identifier(quote.quoteVersion) &&
    typeof quote.requestText === 'string' &&
    typeof quote.complete === 'boolean' &&
    typeof quote.canApprove === 'boolean' &&
    typeof quote.expiresAt === 'string' &&
    Number.isFinite(Date.parse(quote.expiresAt)) &&
    moneyFields.every((field) => Number.isSafeInteger(quote[field]) && quote[field] >= 0) &&
    quote.eligibleHistoricalUnknownMicros <= quote.totalHeldMicros
  );
}

export const estimatedCostQuoteKey = (quote: EstimatedCostQuote): string =>
  JSON.stringify([quote.operationId, quote.quoteId, quote.quoteVersion]);

/** Transcript revisions remain durable; one current review is shown per original request. */
export function latestEstimatedCostQuotes(
  messages: readonly { parts: readonly unknown[] }[],
): Map<string, string> {
  const latest = new Map<string, string>();
  for (const message of messages)
    for (const part of message.parts) {
      if (isCostQuotePayload(part)) latest.set(part.operationId, estimatedCostQuoteKey(part));
    }
  return latest;
}

export function isReviewableCostQuote(quote: EstimatedCostQuote, now: number): boolean {
  return (
    isCostQuotePayload(quote) &&
    Number.isFinite(now) &&
    quote.complete &&
    Date.parse(quote.expiresAt) > now
  );
}

export function canApproveCostQuote(quote: EstimatedCostQuote, now: number): boolean {
  return (
    isReviewableCostQuote(quote, now) &&
    quote.canApprove &&
    quote.nextAttemptMicros > 0 &&
    quote.allowanceMicros >= quote.nextAttemptMicros
  );
}

function isDecision(value: unknown): value is EstimatedCostDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    identifier(row.operationId) &&
    identifier(row.quoteId) &&
    identifier(row.quoteVersion) &&
    identifier(row.decisionId) &&
    (row.decision === 'approve' || row.decision === 'decline')
  );
}

const sameDecision = (left: EstimatedCostDecision, right: EstimatedCostDecision): boolean =>
  left.operationId === right.operationId &&
  left.quoteId === right.quoteId &&
  left.quoteVersion === right.quoteVersion &&
  left.decisionId === right.decisionId &&
  left.decision === right.decision;

/** Storage is a recovery journal, never approval authority or a replay instruction. */
export function readCostDecision(
  storage: CostDecisionStorage,
  scope: CostDecisionScope,
): EstimatedCostDecision | null {
  const raw = storage.getItem(storageKey(scope));
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isDecision(value) || value.operationId !== scope.operationId) throw new Error();
    return value;
  } catch {
    throw new Error(
      'The previous decision could not be recovered. Check this request before deciding again.',
    );
  }
}

/** Persist the owner's explicit intent before a network mutation can start. */
export function retainCostDecision(
  storage: CostDecisionStorage,
  scope: CostDecisionScope,
  decision: EstimatedCostDecision,
): void {
  if (!isDecision(decision) || decision.operationId !== scope.operationId) {
    throw new Error('The decision does not match this request.');
  }
  const previous = readCostDecision(storage, scope);
  if (previous && !sameDecision(previous, decision)) {
    throw new Error('Check the previous decision before submitting another one.');
  }
  storage.setItem(storageKey(scope), JSON.stringify(decision));
  const retained = readCostDecision(storage, scope);
  if (!retained || !sameDecision(retained, decision)) {
    throw new Error('The decision could not be saved for recovery.');
  }
}

export function isReceiptForCostDecision(
  receipt: EstimatedCostDecisionReceipt,
  decision: EstimatedCostDecision,
): boolean {
  if (
    receipt.decisionId !== decision.decisionId ||
    receipt.operationId !== decision.operationId ||
    receipt.quoteId !== decision.quoteId
  )
    return false;
  if (receipt.status === 'stale') return true;
  if (receipt.status === 'declined') return decision.decision === 'decline';
  return (
    receipt.status === 'approved' &&
    decision.decision === 'approve' &&
    Number.isSafeInteger(receipt.allowanceMicros) &&
    receipt.allowanceMicros > 0 &&
    Number.isFinite(Date.parse(receipt.expiresAt))
  );
}

/** A generic refresh or a different device's receipt cannot clear this intent. */
export function clearCostDecisionAfterReceipt(
  storage: CostDecisionStorage,
  scope: CostDecisionScope,
  decision: EstimatedCostDecision,
  receipt: EstimatedCostDecisionReceipt,
): boolean {
  if (!isReceiptForCostDecision(receipt, decision)) return false;
  const current = readCostDecision(storage, scope);
  if (!current || !sameDecision(current, decision)) return false;
  storage.removeItem(storageKey(scope));
  if (storage.getItem(storageKey(scope)) !== null)
    throw new Error('The decision result could not be saved for recovery.');
  return true;
}
