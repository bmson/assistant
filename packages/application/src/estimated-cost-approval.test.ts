import { expect, it } from 'vitest';
import { createUnavailableEstimatedCostApprovalService } from './estimated-cost-approval.js';

it('fails closed for quotes, decisions, and decision readback', async () => {
  const service = createUnavailableEstimatedCostApprovalService();
  const actor = { ownerId: 'owner', installationId: 'installation' };
  const identity = { operationId: 'operation', decisionId: 'decision' };
  const outcomes = await Promise.all([
    service.getQuote(actor, identity.operationId),
    service.requestQuote(actor, {
      operationId: identity.operationId,
      quoteRequestId: 'quote-request',
    }),
    service.decide(actor, {
      ...identity,
      quoteId: 'quote',
      quoteVersion: '1',
      decision: 'approve',
    }),
    service.getDecisionReceipt(actor, identity),
  ]);
  expect(outcomes).toHaveLength(4);
  for (const outcome of outcomes)
    expect(outcome).toMatchObject({ ok: false, outcome: 'unavailable' });
});
