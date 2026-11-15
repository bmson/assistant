/** Immutable review snapshot for one explicitly approved continuation of one owner request.
 * Amounts are integer microdollars; they are estimates, not a provider charge cap.
 * Financial fields describe the quote at its creation time, not live totals.
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
  /** All active held, dispatching and unknown estimates (H), including the subset below. */
  totalHeldMicros: number;
  /** Proven eligible historical unknown estimates, already included in totalHeldMicros. */
  eligibleHistoricalUnknownMicros: number;
  /** Sum of proposed allowances for all current pending approvals, including this quote once when pending.
   * Excludes approved, declined, cancelled and expired quotes. It is not a hold. */
  pendingApprovalMicros: number;
  dailyCeilingMicros: number;
  monthlyCeilingMicros: number;
  /** Server-calculated recordedDailyMicros + totalHeldMicros + pendingApprovalMicros. */
  dailyProjectedGrossMicros: number;
  /** Server-calculated recordedMonthlyMicros + totalHeldMicros + pendingApprovalMicros. */
  monthlyProjectedGrossMicros: number;
  /** False means at least one amount is incomplete; no approval is offered. */
  complete: boolean;
  canApprove: boolean;
  unavailableReason?: string;
}

/** Validate stored wire data before displaying or acting on it. */
export function parseEstimatedCostQuote(value: unknown): EstimatedCostQuote | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const strings = [
    'operationId',
    'taskId',
    'requestText',
    'quoteId',
    'quoteVersion',
    'expiresAt',
  ] as const;
  const amounts = [
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
  if (
    row.type !== 'estimated-cost-approval' ||
    strings.some((key) => typeof row[key] !== 'string' || !row[key]) ||
    amounts.some(
      (key) =>
        typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || (row[key] as number) < 0,
    ) ||
    typeof row.complete !== 'boolean' ||
    typeof row.canApprove !== 'boolean' ||
    (row.canApprove && !row.complete) ||
    (row.unavailableReason !== undefined && typeof row.unavailableReason !== 'string') ||
    !Number.isFinite(Date.parse(row.expiresAt as string))
  )
    return null;
  if ((row.eligibleHistoricalUnknownMicros as number) > (row.totalHeldMicros as number))
    return null;
  if (
    row.canApprove &&
    ((row.nextAttemptMicros as number) === 0 ||
      (row.allowanceMicros as number) < (row.nextAttemptMicros as number) ||
      (row.pendingApprovalMicros as number) < (row.allowanceMicros as number))
  )
    return null;
  if (row.complete) {
    const daily =
      (row.recordedDailyMicros as number) +
      (row.totalHeldMicros as number) +
      (row.pendingApprovalMicros as number);
    const monthly =
      (row.recordedMonthlyMicros as number) +
      (row.totalHeldMicros as number) +
      (row.pendingApprovalMicros as number);
    if (
      !Number.isSafeInteger(daily) ||
      !Number.isSafeInteger(monthly) ||
      row.dailyProjectedGrossMicros !== daily ||
      row.monthlyProjectedGrossMicros !== monthly
    )
      return null;
  }
  return {
    type: 'estimated-cost-approval',
    operationId: row.operationId as string,
    taskId: row.taskId as string,
    requestText: row.requestText as string,
    quoteId: row.quoteId as string,
    quoteVersion: row.quoteVersion as string,
    expiresAt: row.expiresAt as string,
    nextAttemptMicros: row.nextAttemptMicros as number,
    allowanceMicros: row.allowanceMicros as number,
    recordedDailyMicros: row.recordedDailyMicros as number,
    recordedMonthlyMicros: row.recordedMonthlyMicros as number,
    totalHeldMicros: row.totalHeldMicros as number,
    eligibleHistoricalUnknownMicros: row.eligibleHistoricalUnknownMicros as number,
    pendingApprovalMicros: row.pendingApprovalMicros as number,
    dailyCeilingMicros: row.dailyCeilingMicros as number,
    monthlyCeilingMicros: row.monthlyCeilingMicros as number,
    dailyProjectedGrossMicros: row.dailyProjectedGrossMicros as number,
    monthlyProjectedGrossMicros: row.monthlyProjectedGrossMicros as number,
    complete: row.complete,
    canApprove: row.canApprove,
    ...(typeof row.unavailableReason === 'string'
      ? { unavailableReason: row.unavailableReason }
      : {}),
  };
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

/** Canonical lifecycle for the original request, independent of any one client's decision. */
export type EstimatedCostRequestProjection =
  | { status: 'pending'; operationId: string; quote: EstimatedCostQuote }
  | { status: 'approved'; operationId: string; quote: EstimatedCostQuote; grantExpiresAt: string }
  | { status: 'declined'; operationId: string; quote: EstimatedCostQuote }
  | { status: 'expired_or_needs_refresh'; operationId: string; quote: EstimatedCostQuote }
  | { status: 'cancelled'; operationId: string; quote?: EstimatedCostQuote }
  | { status: 'unavailable'; operationId: string; quote?: EstimatedCostQuote; reason: string };

/** Current accounting, read independently of the immutable quote. Null means
 * unavailable or incomplete, never zero. All present values come from one
 * consistent read. totalHeld includes historicalUnknown as a subset and all
 * protected grant-linked unknowns. Pending sums current unexpired proposed
 * allowances once each and excludes approved/declined/cancelled/expired ones.
 * Planned exposure is recorded spend + total held + pending, per period.
 * Historical unknown may be supplied only when its exact unique eligible IDs
 * and current amounts are proven. GET does not create or revise a quote. */
export interface EstimatedCostBudgetTracking {
  observedAt: string;
  complete: boolean;
  recordedDailyMicros: number | null;
  recordedMonthlyMicros: number | null;
  totalHeldMicros: number | null;
  historicalUnknownMicros: number | null;
  pendingApprovalMicros: number | null;
  dailyPlannedExposureMicros: number | null;
  monthlyPlannedExposureMicros: number | null;
}

/** Project a canonical request and its explicitly quote-linked grant. */
export function projectEstimatedCostRequest(input: {
  operationId: string;
  taskId: string;
  state: string;
  quote: unknown;
  quoteExpired: boolean;
  grant?: { quoteId: string; expiresAt: string; expired: boolean };
}): EstimatedCostRequestProjection {
  const quote = parseEstimatedCostQuote(input.quote);
  if (!quote || quote.operationId !== input.operationId || quote.taskId !== input.taskId)
    throw new Error('Invalid stored estimated cost quote');
  if (input.state === 'pending')
    return input.quoteExpired
      ? { status: 'expired_or_needs_refresh', operationId: input.operationId, quote }
      : { status: 'pending', operationId: input.operationId, quote };
  if (input.state === 'approved') {
    if (
      !input.grant ||
      input.grant.quoteId !== quote.quoteId ||
      !Number.isFinite(Date.parse(input.grant.expiresAt))
    )
      throw new Error('Invalid stored estimated cost grant');
    return input.grant.expired
      ? { status: 'expired_or_needs_refresh', operationId: input.operationId, quote }
      : {
          status: 'approved',
          operationId: input.operationId,
          quote,
          grantExpiresAt: input.grant.expiresAt,
        };
  }
  if (input.state === 'declined')
    return { status: 'declined', operationId: input.operationId, quote };
  if (input.state === 'cancelled')
    return { status: 'cancelled', operationId: input.operationId, quote };
  if (input.state === 'expired_or_needs_refresh')
    return { status: 'expired_or_needs_refresh', operationId: input.operationId, quote };
  if (input.state === 'unavailable')
    return {
      status: 'unavailable',
      operationId: input.operationId,
      quote,
      reason: 'The estimate is unavailable.',
    };
  throw new Error('Unknown estimated cost request state');
}

export type EstimatedCostQuoteResponse =
  | {
      ok: true;
      request: EstimatedCostRequestProjection;
      tracking: EstimatedCostBudgetTracking | null;
    }
  | EstimatedCostHttpError;

/** POST decision accepts EstimatedCostDecision; GET decision?operationId=...&decisionId=... reads its exact receipt. */
export type EstimatedCostDecisionResponse =
  | { ok: true; receipt: EstimatedCostDecisionReceipt }
  | EstimatedCostHttpError;

/** Status mapping: invalid=400, unauthorized=401, forbidden=403, not_found=404, conflict=409,
 * unavailable=503, unconfirmed=503. An unconfirmed decision must be read back
 * with the same operationId and decisionId, never retried as a new decision.
 * A stale decision is a durable receipt returned with HTTP 409 and ok: true.
 * A 404 is not a decision receipt and does not prove an uncertain POST failed.
 * HTTP 503 is not the same as a successfully read 'unavailable' lifecycle state.
 */
export type EstimatedCostHttpError = {
  ok: false;
  outcome:
    | 'invalid'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'conflict'
    | 'unavailable'
    | 'unconfirmed';
  operationId?: string;
  decisionId?: string;
  message: string;
};

/** Supplied by trusted server authentication, never decoded from the request body. */
export interface EstimatedCostActor {
  installationId: string;
  ownerId: string;
}

/** Checks the exact owner chat admission before a parked task may be closed. */
export function matchesEstimatedCostParkedTask(
  task: {
    id: string;
    agentId: string;
    type: string;
    trust: string;
    status: string;
    trigger: unknown;
  },
  identity: {
    actor: EstimatedCostActor;
    taskId: string;
    operationId: string;
    requestFingerprint: string;
  },
): boolean {
  if (
    task.id !== identity.taskId ||
    task.agentId !== identity.actor.ownerId ||
    task.type !== 'chat_turn' ||
    task.trust !== 'owner' ||
    task.status !== 'waiting_estimated_cost'
  )
    return false;
  if (!task.trigger || typeof task.trigger !== 'object' || Array.isArray(task.trigger))
    return false;
  const payload = (task.trigger as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const admission = (payload as { chatAdmission?: unknown }).chatAdmission;
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)) return false;
  const row = admission as Record<string, unknown>;
  return (
    row.protocol === 'owner-chat-v1' &&
    row.clientOperationId === identity.operationId &&
    row.requestHash === identity.requestFingerprint
  );
}

/** Internal server-only draw against a single approved request; not an HTTP payload. */
export interface EstimatedCostGrantDraw {
  actor: EstimatedCostActor;
  operationId: string;
  grantId: string;
  bindingDigest: string;
  attemptId: string;
  taskId: string;
  source: import('./contracts.js').SpendSource;
  estimatedMicros: number;
  description: string;
}

export type EstimatedCostGrantDrawResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: 'unavailable' | 'expired' | 'exhausted' | 'closed' };

/** Internal dispatch fence, supplied only by the server's freshly priced route. */
export interface EstimatedCostGrantAttempt {
  actor: EstimatedCostActor;
  operationId: string;
  taskId: string;
  grantId: string;
  reservationId: string;
  leaseToken: string;
  role: string;
  critical: boolean;
  modelId: string;
  nextAttemptMicros: number;
  routingDigest: string;
  requestDigest: string;
  metadata: import('./contracts.js').CostAttemptMetadata;
}

/** Application boundary used by the web and mobile HTTP handlers.
 * Implementations own authorization, durable idempotency and all ledger decisions. */
export interface EstimatedCostApprovalService {
  getQuote(actor: EstimatedCostActor, operationId: string): Promise<EstimatedCostQuoteResponse>;
  requestQuote(
    actor: EstimatedCostActor,
    request: EstimatedCostQuoteRequest,
  ): Promise<EstimatedCostQuoteResponse>;
  /** Decline may close an expired quote only if it remains the current quote
   * for the same unchanged original request; it never creates an allowance.
   * Approval always requires a current, unexpired quote. */
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

export function estimatedCostQuoteExpiry(createdAt: Date): Date {
  const now = createdAt.getTime();
  if (!Number.isFinite(now)) throw new Error('Invalid quote time');
  const nextDay = Date.UTC(
    createdAt.getUTCFullYear(),
    createdAt.getUTCMonth(),
    createdAt.getUTCDate() + 1,
  );
  return new Date(Math.min(now + ESTIMATED_COST_QUOTE_LIFETIME_MS, nextDay));
}

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

/** Fail closed on malformed stored receipts; identity must match the requested operation. */
export function parseEstimatedCostReceipt(
  value: unknown,
  identity: { operationId: string; decisionId: string },
): EstimatedCostDecisionReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.operationId !== identity.operationId ||
    row.decisionId !== identity.decisionId ||
    typeof row.quoteId !== 'string' ||
    !row.quoteId
  )
    return null;
  if (row.status === 'declined' || row.status === 'stale')
    return {
      operationId: identity.operationId,
      decisionId: identity.decisionId,
      quoteId: row.quoteId,
      status: row.status,
    };
  if (
    row.status !== 'approved' ||
    typeof row.allowanceMicros !== 'number' ||
    !Number.isSafeInteger(row.allowanceMicros) ||
    row.allowanceMicros <= 0 ||
    typeof row.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(row.expiresAt))
  )
    return null;
  return {
    operationId: identity.operationId,
    decisionId: identity.decisionId,
    quoteId: row.quoteId,
    status: 'approved',
    allowanceMicros: row.allowanceMicros,
    expiresAt: row.expiresAt,
  };
}

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

/** Independently read current values required to accept a displayed quote. */
export interface EstimatedCostQuoteCheck extends EstimatedCostHeadroom {
  pendingOtherMicros: number;
}

/** A changed financial snapshot must receive a new quote and owner decision.
 * allowOrdinaryCapacity is valid only for a verified already-parked request's
 * explicit refresh or decision. Initial parking must still require historical pressure. */
export function estimatedCostQuoteMatches(
  quote: EstimatedCostQuote,
  current: EstimatedCostQuoteCheck,
  options: { allowOrdinaryCapacity?: boolean } = {},
): boolean {
  const { pendingOtherMicros, ...headroom } = current;
  if (!Number.isSafeInteger(pendingOtherMicros) || pendingOtherMicros < 0)
    throw new Error('Invalid pending estimate subtotal');
  const { allowanceMicros, canApprove } = estimatedCostAllowance(headroom);
  const pending = pendingOtherMicros + allowanceMicros;
  const daily = current.dailySpentMicros + current.heldMicros + pending;
  const monthly = current.monthlySpentMicros + current.heldMicros + pending;
  if (![pending, daily, monthly].every(Number.isSafeInteger))
    throw new Error('Estimated exposure overflow');
  const blockedByHistorical =
    current.historicalUnknownMicros > 0 &&
    (current.dailySpentMicros + current.heldMicros + current.nextAttemptMicros >
      current.dailyCeilingMicros ||
      current.monthlySpentMicros + current.heldMicros + current.nextAttemptMicros >
        current.monthlyCeilingMicros);
  return (
    quote.complete &&
    quote.canApprove &&
    canApprove &&
    (blockedByHistorical || options.allowOrdinaryCapacity === true) &&
    quote.recordedDailyMicros === current.dailySpentMicros &&
    quote.recordedMonthlyMicros === current.monthlySpentMicros &&
    quote.totalHeldMicros === current.heldMicros &&
    quote.eligibleHistoricalUnknownMicros === current.historicalUnknownMicros &&
    quote.nextAttemptMicros === current.nextAttemptMicros &&
    quote.allowanceMicros === allowanceMicros &&
    quote.dailyCeilingMicros === current.dailyCeilingMicros &&
    quote.monthlyCeilingMicros === current.monthlyCeilingMicros &&
    quote.pendingApprovalMicros === pending &&
    quote.dailyProjectedGrossMicros === daily &&
    quote.monthlyProjectedGrossMicros === monthly
  );
}

export interface HistoricalUnknownBaselineRow {
  reservationId: string;
  estimatedMicros: number;
}

/** Exact canonical frozen IDs and microdollar estimates, sorted by ID. The
 * stored digest is SHA-256 over UTF-8 JSON.stringify of the parsed rows. */
export function parseHistoricalUnknownBaseline(
  value: unknown,
): HistoricalUnknownBaselineRow[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const rows: HistoricalUnknownBaselineRow[] = [];
  let previous = '';
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (
      Object.keys(row).length !== 2 ||
      typeof row.reservationId !== 'string' ||
      !row.reservationId ||
      row.reservationId <= previous ||
      typeof row.estimatedMicros !== 'number' ||
      !Number.isSafeInteger(row.estimatedMicros) ||
      row.estimatedMicros <= 0
    )
      return null;
    previous = row.reservationId;
    rows.push({ reservationId: row.reservationId, estimatedMicros: row.estimatedMicros });
  }
  return rows;
}

/** Internal trusted preparation; never constructed from an HTTP request body. */
export interface EstimatedCostPreparedQuote {
  actor: EstimatedCostActor;
  quoteRequestId: string;
  taskId: string;
  /** Required for initial parking; null only for an already parked request refresh. */
  leaseToken: string | null;
  requestFingerprint: string;
  bindingDigest: string;
  /** Hashes of canonical source rows and the router's captured request digest. */
  sourceBinding: EstimatedCostSourceBinding;
  critical: boolean;
  quote: EstimatedCostQuote;
  baseline: HistoricalUnknownBaselineRow[];
}

export interface EstimatedCostSourceBinding {
  role: string;
  critical: boolean;
  selectedModelId: string;
  routingDigest: string;
  roleRowDigest: string;
  modelRows: { id: string; digest: string }[];
  connectionRows: { id: string; digest: string }[];
  /** Other configured roles this same request may use under its cumulative allowance.
   * These bind routing and prices, not the initial call's prompt digest. */
  additionalRoutes: {
    role: string;
    roleRowDigest: string;
    modelRows: { id: string; digest: string }[];
    connectionRows: { id: string; digest: string }[];
  }[];
  budgetRows: { scope: 'daily' | 'monthly'; digest: string }[];
  privacyGeneration: string | null;
}

/** Canonical JSON for hashing source rows. Only JSON values are accepted; no
 * undefined, NaN, Date objects or implicit coercion can change a binding. */
export function canonicalEstimatedCostJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEstimatedCostJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error('Invalid binding value');
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalEstimatedCostJson(object[key])}`)
    .join(',')}}`;
}

/** Must agree with the model router's configured connection selection. */
export function estimatedCostConnectionId(modelId: string): string {
  if (/^vertex[:/]/i.test(modelId)) return 'vertex';
  if (modelId.startsWith('openai:')) return 'openai';
  const gateway = /^gw:([^:]+):/.exec(modelId);
  return gateway?.[1] ?? 'openrouter';
}

/** Internal chat-turn boundary. The candidate is produced by the server router,
 * and park succeeds only after the quote and original leased task are committed. */
export interface EstimatedCostTurnParkInput {
  actor: EstimatedCostActor;
  operationId: string;
  conversationId: string;
  taskId: string;
  leaseToken: string;
  requestFingerprint: string;
  quoteRequestId: string;
  candidate: {
    role: string;
    critical: boolean;
    modelId: string;
    nextAttemptMicros: number;
    routingDigest: string;
    requestDigest: string;
  };
}

export type EstimatedCostTurnParkResult =
  | {
      ok: true;
      operationId: string;
      taskId: string;
      quoteId: string;
      quoteVersion: string;
      status: 'pending';
    }
  | EstimatedCostHttpError;

export interface EstimatedCostTurnParking {
  park(input: EstimatedCostTurnParkInput): Promise<EstimatedCostTurnParkResult>;
}

/** Nested at task.state.estimatedCostApproval; merge with the checkpoint.
 * This marker is a locator only: dispatch must revalidate the canonical grant. */
export interface EstimatedCostTaskMarker {
  operationId: string;
  quoteId: string;
  bindingDigest: string;
  status: 'pending' | 'approved';
  grantId?: string;
}

export type EstimatedCostPreparationResult =
  | { ok: true; prepared: EstimatedCostPreparedQuote }
  | EstimatedCostHttpError;

/** Server-side model/routing preparation must never dispatch provider work. */
export interface EstimatedCostQuotePreparer {
  prepare(
    actor: EstimatedCostActor,
    request: EstimatedCostQuoteRequest,
  ): Promise<EstimatedCostPreparationResult>;
}

/** Atomic persistence boundary. Implementations must recheck all canonical
 * identities, policy/pricing bindings, baseline and exposure in their transaction.
 * A successful initial store also parks the matching leased task without a hold.
 * A successful approve atomically creates its receipt and escrow, and resumes
 * only the original task. Replays must never allocate twice. */
export interface EstimatedCostApprovalRepository {
  getQuote(actor: EstimatedCostActor, operationId: string): Promise<EstimatedCostQuoteResponse>;
  storePreparedQuote(prepared: EstimatedCostPreparedQuote): Promise<EstimatedCostQuoteResponse>;
  decide(
    actor: EstimatedCostActor,
    decision: EstimatedCostDecision,
  ): Promise<EstimatedCostDecisionResponse>;
  getDecisionReceipt(
    actor: EstimatedCostActor,
    identity: { operationId: string; decisionId: string },
  ): Promise<EstimatedCostDecisionResponse>;
}

/** Server-prepared quote and checkpoint identity; never accepted from an HTTP body. */
export interface EstimatedCostParkInput {
  actor: EstimatedCostActor;
  taskId: string;
  leaseToken: string;
  requestFingerprint: string;
  bindingDigest: string;
  critical: boolean;
  quote: EstimatedCostQuote;
  baseline: HistoricalUnknownBaselineRow[];
}

/** Must be produced from canonical reservation records, not attempt metadata. */
export interface CurrentBaselineReservation extends HistoricalUnknownBaselineRow {
  status: string;
  provenance: 'proven-historical-unapproved' | 'grant-linked' | 'unrecognized';
}

/** Re-read every frozen row. Settled rows contribute zero; missing or changed
 * rows make the whole subtotal unavailable rather than creating credit. */
export function currentHistoricalUnknownMicros(
  baseline: readonly HistoricalUnknownBaselineRow[],
  current: readonly CurrentBaselineReservation[],
): number | null {
  if (baseline.length !== current.length) return null;
  const byId = new Map(current.map((row) => [row.reservationId, row]));
  if (byId.size !== current.length) return null;
  let total = 0;
  const seen = new Set<string>();
  for (const expected of baseline) {
    if (
      !expected.reservationId ||
      seen.has(expected.reservationId) ||
      !Number.isSafeInteger(expected.estimatedMicros) ||
      expected.estimatedMicros <= 0
    )
      return null;
    seen.add(expected.reservationId);
    const row = byId.get(expected.reservationId);
    if (
      row?.provenance !== 'proven-historical-unapproved' ||
      row.estimatedMicros !== expected.estimatedMicros
    )
      return null;
    if (row.status === 'reconciled' || row.status === 'released') continue;
    if (row.status !== 'unknown') return null;
    total += row.estimatedMicros;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
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
