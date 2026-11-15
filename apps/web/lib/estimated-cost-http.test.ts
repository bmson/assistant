import { createUnavailableEstimatedCostApprovalService } from '@assistant/application';
import { describe, expect, it, vi } from 'vitest';
import { handleEstimatedCostHttp } from './estimated-cost-http';

const actor = { installationId: 'installation', ownerId: 'owner' };
const input = {
  operationId: 'operation',
  quoteId: 'quote',
  quoteVersion: 'version',
  decisionId: 'decision',
  decision: 'approve',
};
const post = (body: unknown) =>
  new Request('https://example.test/decision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const setup = () => ({
  authenticate: vi.fn(async () => true),
  checkOrigin: vi.fn(() => true),
  actor: vi.fn(async () => actor),
  service: vi.fn(() => createUnavailableEstimatedCostApprovalService()),
});

describe('estimated cost HTTP boundary', () => {
  it('rejects a foreign origin before authentication and validates exact body keys', async () => {
    const deps = setup();
    deps.checkOrigin.mockReturnValue(false);
    const blocked = await handleEstimatedCostHttp(post(input), 'decision', deps);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ ok: false, outcome: 'forbidden' });
    expect(deps.authenticate).not.toHaveBeenCalled();
    deps.checkOrigin.mockReturnValue(true);
    expect(
      (await handleEstimatedCostHttp(post({ ...input, allowanceMicros: 1 }), 'decision', deps))
        .status,
    ).toBe(400);
    expect(deps.actor).not.toHaveBeenCalled();
  });

  it('reads only the exact decision receipt and returns no-store', async () => {
    const deps = setup();
    const service = createUnavailableEstimatedCostApprovalService();
    const read = vi.spyOn(service, 'getDecisionReceipt');
    const decide = vi.spyOn(service, 'decide');
    deps.service.mockReturnValue(service);
    const response = await handleEstimatedCostHttp(
      new Request('https://example.test/decision?operationId=operation&decisionId=decision'),
      'decision',
      deps,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(read).toHaveBeenCalledWith(actor, { operationId: 'operation', decisionId: 'decision' });
    expect(decide).not.toHaveBeenCalled();
  });

  it('returns an unconfirmed identity if a decision commit response is uncertain', async () => {
    const deps = setup();
    const service = createUnavailableEstimatedCostApprovalService();
    vi.spyOn(service, 'decide').mockRejectedValue(new Error('lost response'));
    deps.service.mockReturnValue(service);
    const response = await handleEstimatedCostHttp(post(input), 'decision', deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      outcome: 'unconfirmed',
      operationId: 'operation',
      decisionId: 'decision',
    });
  });
});
