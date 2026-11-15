import type { EstimatedCostApprovalService, EstimatedCostHttpError } from '@assistant/persistence';

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
