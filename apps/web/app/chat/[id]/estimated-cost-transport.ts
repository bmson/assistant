import {
  ESTIMATED_COST_ROUTES,
  type EstimatedCostDecision,
  type EstimatedCostDecisionResponse,
  type EstimatedCostQuoteRequest,
  type EstimatedCostQuoteResponse,
} from '@assistant/persistence/estimated-cost-approval';
import { isCostQuotePayload } from './estimated-cost-decision';

export interface EstimatedCostTransport {
  read(operationId: string): Promise<EstimatedCostQuoteResponse>;
  refresh(request: EstimatedCostQuoteRequest): Promise<EstimatedCostQuoteResponse>;
  decide(decision: EstimatedCostDecision): Promise<EstimatedCostDecisionResponse>;
  receipt(operationId: string, decisionId: string): Promise<EstimatedCostDecisionResponse>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const outcomes = new Set([
  'invalid',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'unavailable',
  'unconfirmed',
]);

function validError(value: Record<string, unknown>, operationId: string): boolean {
  return (
    value.ok === false &&
    outcomes.has(String(value.outcome)) &&
    typeof value.message === 'string' &&
    (value.operationId === undefined || value.operationId === operationId)
  );
}

function quoteResponse(value: unknown, operationId: string): EstimatedCostQuoteResponse {
  if (!record(value)) throw new Error('The request could not be read.');
  if (validError(value, operationId)) return value as EstimatedCostQuoteResponse;
  if (value.ok !== true || !record(value.request) || value.request.operationId !== operationId) {
    throw new Error('The response does not match this request.');
  }
  const request = value.request;
  const status = request.status;
  if (
    ![
      'pending',
      'approved',
      'declined',
      'expired_or_needs_refresh',
      'cancelled',
      'unavailable',
    ].includes(String(status))
  ) {
    throw new Error('The request state is unavailable.');
  }
  if (
    request.quote !== undefined &&
    (!isCostQuotePayload(request.quote) || request.quote.operationId !== operationId)
  ) {
    throw new Error('The estimate does not match this request.');
  }
  if (!['cancelled', 'unavailable'].includes(String(status)) && request.quote === undefined) {
    throw new Error('The request has no current estimate.');
  }
  if (
    status === 'approved' &&
    (typeof request.grantExpiresAt !== 'string' ||
      !Number.isFinite(Date.parse(request.grantExpiresAt)))
  ) {
    throw new Error('The approved allowance could not be read.');
  }
  if (status === 'unavailable' && typeof request.reason !== 'string') {
    throw new Error('The request state is unavailable.');
  }
  return value as EstimatedCostQuoteResponse;
}

function decisionResponse(
  value: unknown,
  operationId: string,
  decisionId: string,
): EstimatedCostDecisionResponse {
  if (!record(value)) throw new Error('The decision could not be confirmed.');
  if (
    validError(value, operationId) &&
    (value.decisionId === undefined || value.decisionId === decisionId)
  ) {
    return value as EstimatedCostDecisionResponse;
  }
  if (value.ok !== true || !record(value.receipt))
    throw new Error('The decision could not be confirmed.');
  const receipt = value.receipt;
  if (
    receipt.operationId !== operationId ||
    receipt.decisionId !== decisionId ||
    typeof receipt.quoteId !== 'string'
  ) {
    throw new Error('The receipt does not match this decision.');
  }
  if (!['approved', 'declined', 'stale'].includes(String(receipt.status)))
    throw new Error('The decision state is unavailable.');
  if (
    receipt.status === 'approved' &&
    (typeof receipt.allowanceMicros !== 'number' ||
      !Number.isSafeInteger(receipt.allowanceMicros) ||
      receipt.allowanceMicros <= 0 ||
      typeof receipt.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(receipt.expiresAt)))
  )
    throw new Error('The approved allowance could not be confirmed.');
  return value as EstimatedCostDecisionResponse;
}

/** No mutation retry: ambiguous decisions are recovered through their exact receipt. */
export function createEstimatedCostTransport(
  fetcher: typeof fetch = fetch,
): EstimatedCostTransport {
  async function request(path: string, body?: unknown): Promise<unknown> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    try {
      const response = await fetcher(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: abort.signal,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // A durable stale receipt deliberately uses HTTP 409 with ok:true.
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
  const quote = ESTIMATED_COST_ROUTES.web.quote;
  const decision = ESTIMATED_COST_ROUTES.web.decision;
  return {
    async read(operationId) {
      return quoteResponse(
        await request(`${quote}?${new URLSearchParams({ operationId })}`),
        operationId,
      );
    },
    async refresh(input) {
      return quoteResponse(await request(quote, input), input.operationId);
    },
    async decide(input) {
      return decisionResponse(await request(decision, input), input.operationId, input.decisionId);
    },
    async receipt(operationId, decisionId) {
      return decisionResponse(
        await request(`${decision}?${new URLSearchParams({ operationId, decisionId })}`),
        operationId,
        decisionId,
      );
    },
  };
}
