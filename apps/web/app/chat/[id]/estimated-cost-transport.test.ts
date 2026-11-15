import { describe, expect, it, vi } from 'vitest';
import { createEstimatedCostTransport } from './estimated-cost-transport';

const decision = {
  operationId: 'operation-a',
  quoteId: 'quote-a',
  quoteVersion: 'v1',
  decisionId: 'decision-a',
  decision: 'approve' as const,
};

describe('estimated cost HTTP transport', () => {
  it('sends one exact intent and does not retry an ambiguous POST', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('Response lost');
    });
    await expect(createEstimatedCostTransport(fetcher).decide(decision)).rejects.toThrow(
      'Response lost',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/chat/estimated-cost/decision',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        body: JSON.stringify(decision),
      }),
    );
  });

  it('reads the same operation and decision without a mutation', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: false, outcome: 'not_found', message: 'Not confirmed' }, { status: 404 }),
    );
    const result = await createEstimatedCostTransport(fetcher).receipt('request:a', 'decision:a');
    expect(result.ok).toBe(false);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/chat/estimated-cost/decision?operationId=request%3Aa&decisionId=decision%3Aa',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });

  it('accepts a durable stale receipt on HTTP 409', async () => {
    const receipt = {
      operationId: decision.operationId,
      decisionId: decision.decisionId,
      quoteId: decision.quoteId,
      status: 'stale',
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, receipt }, { status: 409 }),
    );
    expect(await createEstimatedCostTransport(fetcher).decide(decision)).toEqual({
      ok: true,
      receipt,
    });
  });

  it('rejects a receipt for another operation or decision and malformed allowance amounts', async () => {
    const good = {
      ...decision,
      status: 'approved',
      allowanceMicros: 200_000,
      expiresAt: '2026-11-15T12:30:00Z',
    };
    for (const receipt of [
      { ...good, operationId: 'other' },
      { ...good, decisionId: 'other' },
      { ...good, allowanceMicros: -1 },
      { ...good, allowanceMicros: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, receipt }));
      await expect(createEstimatedCostTransport(fetcher).decide(decision)).rejects.toThrow();
    }
  });

  it('does not accept a quote for another request or an unrecognized lifecycle', async () => {
    for (const request of [
      { operationId: 'other', status: 'cancelled' },
      { operationId: 'operation-a', status: 'done' },
      { operationId: 'operation-a', status: 'pending' },
    ]) {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, request }));
      await expect(createEstimatedCostTransport(fetcher).read('operation-a')).rejects.toThrow();
    }
  });
});
