import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideSecurityReview, listSecurityReviews } from './security-notice-review-client';

afterEach(() => vi.unstubAllGlobals());

describe('security notice review client', () => {
  const validItem = {
    incidentId: '4e95ac7f-d623-5c12-9c65-74b492a13e12',
    revision: 2,
    confidence: 'high',
    disposition: 'unreviewed',
    category: 'sign_in',
    importance: 8,
    subject: 'New sign-in',
    fromName: 'Account security',
    observedAt: '2026-10-11T12:00:00.000Z',
    materialChangeReason: null,
    evidence: { evidenceQuote: 'A sign-in was reported.' },
  };

  it('loads the bounded owner review projection without caching', async () => {
    const fetch = vi.fn(async () => Response.json({ items: [] }));
    vi.stubGlobal('fetch', fetch);

    await expect(listSecurityReviews()).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledWith('/api/mobile/v1/security-reviews?limit=50', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: undefined,
    });
  });

  it('rejects malformed or failed list responses instead of reporting an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ items: 'not-an-array' })),
    );
    await expect(listSecurityReviews()).rejects.toThrow('Invalid security review list');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(listSecurityReviews()).rejects.toThrow('Security review list failed (503)');
  });

  it.each([
    ['null row', [null]],
    ['missing revision', [{ ...validItem, revision: undefined }]],
    ['invalid identifier', [{ ...validItem, incidentId: 'private-id' }]],
    ['oversized text', [{ ...validItem, subject: 'x'.repeat(301) }]],
    ['duplicate ids', [validItem, validItem]],
    [
      'more than 50 rows',
      Array.from({ length: 51 }, (_, index) => ({
        ...validItem,
        incidentId: `4e95ac7f-d623-5c12-9c65-74b492a13e${String(index).padStart(2, '0')}`,
      })),
    ],
  ])('rejects malformed review rows (%s)', async (_label, items) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ items })),
    );
    await expect(listSecurityReviews()).rejects.toThrow('Invalid security review list');
  });

  it('reports saved only for an explicit success payload and separates stale from uncertain', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error('connection lost'));
    vi.stubGlobal('fetch', fetch);
    const body = {
      expectedRevision: 2,
      disposition: 'dismissed' as const,
      reason: 'Owner dismissed this notice.',
    };

    await expect(decideSecurityReview('incident-id', body)).resolves.toBe('saved');
    await expect(decideSecurityReview('incident-id', body)).resolves.toBe('stale');
    await expect(decideSecurityReview('incident-id', body)).resolves.toBe('uncertain');
    await expect(decideSecurityReview('incident-id', body)).resolves.toBe('uncertain');
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/mobile/v1/security-reviews/incident-id');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
  });
});
