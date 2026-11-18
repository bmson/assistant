import type {
  EstimatedCostActor,
  EstimatedCostApprovalRepository,
  EstimatedCostApprovalService,
  EstimatedCostDecision,
  EstimatedCostHttpError,
  EstimatedCostPreparedQuote,
  EstimatedCostQuotePreparer,
} from '@assistant/persistence';

type Dependencies = {
  repository: EstimatedCostApprovalRepository;
  preparer: EstimatedCostQuotePreparer;
  /** Explicit compatible rollout capability; absent or throwing means no new authority. */
  enabled?: () => boolean;
};

const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validActor = (actor: EstimatedCostActor) =>
  typeof actor?.ownerId === 'string' &&
  actor.ownerId.trim().length > 0 &&
  typeof actor?.installationId === 'string' &&
  actor.installationId.trim().length > 0;
const failure = (
  outcome: EstimatedCostHttpError['outcome'],
  operationId: string,
  decisionId?: string,
): EstimatedCostHttpError => ({
  ok: false,
  outcome,
  operationId,
  ...(decisionId ? { decisionId } : {}),
  message:
    outcome === 'invalid'
      ? 'Invalid request identity.'
      : outcome === 'unconfirmed'
        ? 'The decision could not be confirmed. Check its exact result.'
        : 'Estimated cost approval is unavailable.',
});

/** Application orchestration only. Transactions retain all financial and task authority. */
export function createEstimatedCostApprovalService(
  deps: Dependencies,
): EstimatedCostApprovalService {
  const enabled = () => {
    try {
      return deps.enabled?.() === true;
    } catch {
      return false;
    }
  };
  const valid = (actor: EstimatedCostActor, operationId: string) =>
    validActor(actor) && id(operationId);
  return {
    async getOverview(actor) {
      if (!validActor(actor) || !deps.repository.getOverview)
        return {
          ok: false,
          outcome: 'unavailable',
          message: 'Estimated cost approval is unavailable.',
        };
      try {
        return await deps.repository.getOverview(actor);
      } catch {
        return {
          ok: false,
          outcome: 'unavailable',
          message: 'Estimated cost approval is unavailable.',
        };
      }
    },
    async getQuote(actor, operationId) {
      if (!valid(actor, operationId)) return failure('invalid', operationId);
      try {
        return await deps.repository.getQuote(actor, operationId);
      } catch {
        return failure('unavailable', operationId);
      }
    },
    async requestQuote(actor, request) {
      if (!valid(actor, request.operationId) || !id(request.quoteRequestId))
        return failure('invalid', request.operationId);
      if (!enabled()) return failure('unavailable', request.operationId);
      try {
        const result = await deps.preparer.prepare(actor, request);
        if (!result.ok) return result;
        if (!preparedFor(result.prepared, actor, request))
          return failure('unavailable', request.operationId);
        // Recheck a revoked capability after asynchronous preparation. The store
        // must still revalidate current canonical bindings inside its transaction.
        if (!enabled()) return failure('unavailable', request.operationId);
        return await deps.repository.storePreparedQuote(result.prepared);
      } catch {
        return failure('unavailable', request.operationId);
      }
    },
    async decide(actor, decision) {
      if (!valid(actor, decision.operationId) || !validDecision(decision))
        return failure('invalid', decision.operationId, decision.decisionId);
      // Compatible OFF mode retains readback and decline, but mints no allowance.
      if (decision.decision === 'approve' && !enabled())
        return failure('unavailable', decision.operationId, decision.decisionId);
      try {
        return await deps.repository.decide(actor, decision);
      } catch {
        return failure('unconfirmed', decision.operationId, decision.decisionId);
      }
    },
    async getDecisionReceipt(actor, identity) {
      if (!valid(actor, identity.operationId) || !id(identity.decisionId))
        return failure('invalid', identity.operationId, identity.decisionId);
      try {
        return await deps.repository.getDecisionReceipt(actor, identity);
      } catch {
        return failure('unconfirmed', identity.operationId, identity.decisionId);
      }
    },
  };
}

function validDecision(value: EstimatedCostDecision) {
  return (
    id(value.quoteId) &&
    id(value.quoteVersion) &&
    id(value.decisionId) &&
    (value.decision === 'approve' || value.decision === 'decline')
  );
}

function preparedFor(
  prepared: EstimatedCostPreparedQuote,
  actor: EstimatedCostActor,
  request: { operationId: string; quoteRequestId: string },
): boolean {
  const quote = prepared?.quote;
  if (
    !quote ||
    prepared.actor?.ownerId !== actor.ownerId ||
    prepared.actor?.installationId !== actor.installationId ||
    prepared.quoteRequestId !== request.quoteRequestId ||
    quote.operationId !== request.operationId ||
    prepared.taskId !== quote.taskId ||
    !id(quote.taskId) ||
    !id(quote.quoteId) ||
    !id(quote.quoteVersion) ||
    quote.type !== 'estimated-cost-approval' ||
    typeof quote.requestText !== 'string' ||
    typeof quote.complete !== 'boolean' ||
    typeof quote.canApprove !== 'boolean' ||
    typeof prepared.critical !== 'boolean' ||
    typeof prepared.requestFingerprint !== 'string' ||
    !prepared.requestFingerprint ||
    typeof prepared.bindingDigest !== 'string' ||
    !prepared.bindingDigest ||
    (prepared.leaseToken !== null && !id(prepared.leaseToken)) ||
    typeof quote.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(quote.expiresAt)) ||
    !Array.isArray(prepared.baseline)
  )
    return false;
  const amounts = [
    quote.nextAttemptMicros,
    quote.allowanceMicros,
    quote.recordedDailyMicros,
    quote.recordedMonthlyMicros,
    quote.totalHeldMicros,
    quote.eligibleHistoricalUnknownMicros,
    quote.pendingApprovalMicros,
    quote.dailyCeilingMicros,
    quote.monthlyCeilingMicros,
    quote.dailyProjectedGrossMicros,
    quote.monthlyProjectedGrossMicros,
  ];
  if (!amounts.every((amount) => Number.isSafeInteger(amount) && amount >= 0)) return false;
  const ids = new Set<string>();
  for (const row of prepared.baseline) {
    if (
      !id(row?.reservationId) ||
      ids.has(row.reservationId) ||
      !Number.isSafeInteger(row.estimatedMicros) ||
      row.estimatedMicros <= 0
    )
      return false;
    ids.add(row.reservationId);
  }
  return true;
}

/** Fail-closed boundary until durable approval storage and rollout guards are installed. */
export function createUnavailableEstimatedCostApprovalService(): EstimatedCostApprovalService {
  const unavailable = (operationId: string, decisionId?: string): EstimatedCostHttpError => ({
    ok: false,
    outcome: 'unavailable',
    operationId,
    ...(decisionId ? { decisionId } : {}),
    message: 'Estimated cost approval is unavailable.',
  });
  return {
    async getQuote(_actor, operationId) {
      return unavailable(operationId);
    },
    async requestQuote(_actor, request) {
      return unavailable(request.operationId);
    },
    async decide(_actor, decision) {
      return unavailable(decision.operationId, decision.decisionId);
    },
    async getDecisionReceipt(_actor, identity) {
      return unavailable(identity.operationId, identity.decisionId);
    },
  };
}
