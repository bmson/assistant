/** Wire contract for one explicitly approved continuation of one owner request.
 * Amounts are integer microdollars; they are estimates, not a provider charge cap.
 */
export interface EstimatedCostQuote {
  type: 'estimated-cost-approval';
  operationId: string;
  taskId: string;
  requestText: string;
  quoteId: string;
  quoteVersion: string;
  expiresAt: string;
  nextAttemptMicros: number;
  allowanceMicros: number;
  recordedDailyMicros: number;
  recordedMonthlyMicros: number;
  activeHeldMicros: number;
  historicalUnknownMicros: number;
  pendingApprovalMicros: number;
  dailyCeilingMicros: number;
  monthlyCeilingMicros: number;
  dailyProjectedGrossMicros: number;
  monthlyProjectedGrossMicros: number;
  /** False means at least one amount is incomplete; no approval is offered. */
  complete: boolean;
  canApprove: boolean;
  unavailableReason?: string;
}

/** Explicit card actions only. The server derives all amounts from the quote. */
export interface EstimatedCostDecision {
  operationId: string;
  quoteId: string;
  quoteVersion: string;
  decisionId: string;
  decision: 'approve' | 'decline';
}

/** Web and mobile routes share the same JSON contract; authentication differs. */
export const ESTIMATED_COST_ROUTES = {
  web: {
    quote: '/api/chat/estimated-cost/quote',
    decision: '/api/chat/estimated-cost/decision',
  },
  mobile: {
    quote: '/api/mobile/v1/chat/estimated-cost/quote',
    decision: '/api/mobile/v1/chat/estimated-cost/decision',
  },
} as const;

/** GET quote?operationId=... returns the current durable quote. POST explicitly
 * requests a fresh quote without spending; quoteRequestId is stable on retry. */
export interface EstimatedCostQuoteRequest {
  operationId: string;
  quoteRequestId: string;
}

export type EstimatedCostQuoteResponse =
  | { ok: true; quote: EstimatedCostQuote }
  | EstimatedCostHttpError;

/** POST decision accepts EstimatedCostDecision; GET decision?operationId=...&decisionId=... reads its exact receipt. */
export type EstimatedCostDecisionResponse =
  | { ok: true; receipt: EstimatedCostDecisionReceipt }
  | EstimatedCostHttpError;

/** Status mapping: invalid=400, unauthorized=401, not_found=404, conflict=409,
 * unavailable=503, unconfirmed=503. An unconfirmed decision must be read back
 * with the same operationId and decisionId, never retried as a new decision.
 * A stale decision is a durable receipt returned with HTTP 409 and ok: true.
 */
export type EstimatedCostHttpError = {
  ok: false;
  outcome: 'invalid' | 'unauthorized' | 'not_found' | 'conflict' | 'unavailable' | 'unconfirmed';
  operationId?: string;
  decisionId?: string;
  message: string;
};

/** Supplied by trusted server authentication, never decoded from the request body. */
export interface EstimatedCostActor {
  installationId: string;
  ownerId: string;
}

/** Application boundary used by the web and mobile HTTP handlers.
 * Implementations own authorization, durable idempotency and all ledger decisions. */
export interface EstimatedCostApprovalService {
  getQuote(actor: EstimatedCostActor, operationId: string): Promise<EstimatedCostQuoteResponse>;
  requestQuote(
    actor: EstimatedCostActor,
    request: EstimatedCostQuoteRequest,
  ): Promise<EstimatedCostQuoteResponse>;
  decide(
    actor: EstimatedCostActor,
    decision: EstimatedCostDecision,
  ): Promise<EstimatedCostDecisionResponse>;
  getDecisionReceipt(
    actor: EstimatedCostActor,
    identity: { operationId: string; decisionId: string },
  ): Promise<EstimatedCostDecisionResponse>;
}

export const ESTIMATED_COST_QUOTE_LIFETIME_MS = 10 * 60_000;
export const ESTIMATED_COST_ALLOWANCE_LIFETIME_MS = 30 * 60_000;

/** A grant never crosses a UTC accounting period. */
export function estimatedCostAllowanceExpiry(decidedAt: Date): Date {
  const now = decidedAt.getTime();
  if (!Number.isFinite(now)) throw new Error('Invalid decision time');
  const nextDay = Date.UTC(
    decidedAt.getUTCFullYear(),
    decidedAt.getUTCMonth(),
    decidedAt.getUTCDate() + 1,
  );
  return new Date(Math.min(now + ESTIMATED_COST_ALLOWANCE_LIFETIME_MS, nextDay));
}

/** Read back by the same decision ID after an ambiguous response. */
export type EstimatedCostDecisionReceipt =
  | {
      decisionId: string;
      operationId: string;
      quoteId: string;
      status: 'approved';
      allowanceMicros: number;
      expiresAt: string;
    }
  | { decisionId: string; operationId: string; quoteId: string; status: 'declined' }
  | { decisionId: string; operationId: string; quoteId: string; status: 'stale' };

/** Inputs must come from one transactionally consistent, verified ledger snapshot. */
export interface EstimatedCostHeadroom {
  dailySpentMicros: number;
  monthlySpentMicros: number;
  heldMicros: number;
  historicalUnknownMicros: number;
  dailyCeilingMicros: number;
  monthlyCeilingMicros: number;
  taskSpentMicros: number;
  taskHeldMicros: number;
  taskCeilingMicros: number;
  nextAttemptMicros: number;
}

export interface HistoricalUnknownBaselineRow {
  reservationId: string;
  estimatedMicros: number;
}

/** Must be produced from canonical reservation records, not attempt metadata. */
export interface CurrentBaselineReservation extends HistoricalUnknownBaselineRow {
  status: string;
  provenance: 'proven-historical-unapproved' | 'grant-linked' | 'unrecognized';
}

/** Verify the exact frozen baseline before using it in a new quote or decision. */
export function verifiedHistoricalUnknownMicros(
  baseline: readonly HistoricalUnknownBaselineRow[],
  current: readonly CurrentBaselineReservation[],
  complete: boolean,
): number {
  if (!complete || baseline.length !== current.length)
    throw new Error('Incomplete unknown baseline');
  const rows = new Map<string, CurrentBaselineReservation>();
  for (const row of current) {
    if (!row.reservationId || rows.has(row.reservationId))
      throw new Error('Invalid unknown baseline');
    rows.set(row.reservationId, row);
  }
  const seen = new Set<string>();
  let total = 0;
  for (const expected of baseline) {
    const row = rows.get(expected.reservationId);
    if (
      !expected.reservationId ||
      seen.has(expected.reservationId) ||
      !Number.isSafeInteger(expected.estimatedMicros) ||
      expected.estimatedMicros <= 0 ||
      !row ||
      row.status !== 'unknown' ||
      row.provenance !== 'proven-historical-unapproved' ||
      row.estimatedMicros !== expected.estimatedMicros
    )
      throw new Error('Changed or unproven unknown baseline');
    seen.add(expected.reservationId);
    total += expected.estimatedMicros;
    if (!Number.isSafeInteger(total)) throw new Error('Unknown baseline overflow');
  }
  return total;
}

/** Computes the maximum additional allocation, never removing any existing hold. */
export function estimatedCostAllowance(input: EstimatedCostHeadroom): {
  allowanceMicros: number;
  canApprove: boolean;
} {
  for (const amount of Object.values(input)) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid budget snapshot');
  }
  if (input.nextAttemptMicros === 0 || input.historicalUnknownMicros > input.heldMicros) {
    throw new Error('Invalid budget snapshot');
  }
  const protectedHeld = input.heldMicros - input.historicalUnknownMicros;
  // Subtraction avoids unsafe addition of individually valid integer amounts.
  const headroom = (ceiling: number, spent: number, held: number) =>
    Math.max(0, ceiling - Math.min(ceiling, spent) - Math.min(ceiling, held));
  const allowanceMicros = Math.min(
    headroom(input.dailyCeilingMicros, input.dailySpentMicros, protectedHeld),
    headroom(input.monthlyCeilingMicros, input.monthlySpentMicros, protectedHeld),
    headroom(input.taskCeilingMicros, input.taskSpentMicros, input.taskHeldMicros),
  );
  return { allowanceMicros, canApprove: allowanceMicros >= input.nextAttemptMicros };
}
