import { listOwnerSecurityReviews } from '@assistant/application/security-incidents';
import type { EmailSyncRepository } from '@assistant/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideSecurityReview,
  listSecurityReviews,
  SECURITY_REVIEW_REQUEST_TIMEOUT_MS,
} from './security-notice-review-client';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
    expect(fetch).toHaveBeenCalledWith(
      '/api/mobile/v1/security-reviews?limit=50',
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
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
    ['array disposition', [{ ...validItem, disposition: ['unreviewed'] }]],
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

  it('accepts the application projection for long emoji-heavy source text', async () => {
    const subject = '🧪'.repeat(180);
    const category = '🚀'.repeat(70);
    const fromName = '📬'.repeat(120);
    const repository = {
      listSecurityReviewItems: vi.fn().mockResolvedValue([
        {
          channelMessageId: 'private-source-key',
          incidentId: validItem.incidentId,
          revision: 2,
          confidence: 'high',
          disposition: 'unreviewed',
          decisionRevision: null,
          materialChangeReason: null,
          observedAt: new Date('2026-10-11T12:00:00.000Z'),
          category,
          importance: 8,
          subject,
          fromName,
          evidence: null,
          rawBody: 'private raw content',
        },
      ]),
    } as unknown as EmailSyncRepository;
    const [projected] = await listOwnerSecurityReviews(repository, 'owner');
    expect(projected?.subject.length).toBeLessThanOrEqual(300);
    expect(projected?.category.length).toBeLessThanOrEqual(120);
    expect(projected?.fromName?.length).toBeLessThanOrEqual(200);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ items: [projected] })),
    );

    await expect(listSecurityReviews()).resolves.toEqual([projected]);
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

  it('bounds a never-settling list and aborts its request at the deadline', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        requestSignal = init.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }),
    );
    const request = listSecurityReviews();
    const rejected = expect(request).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(SECURITY_REVIEW_REQUEST_TIMEOUT_MS);

    await rejected;
    expect(requestSignal?.aborted).toBe(true);
  });

  it('bounds response JSON parsing within the same list deadline', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        requestSignal = init.signal as AbortSignal;
        return Promise.resolve(
          new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
        );
      }),
    );
    const request = listSecurityReviews();
    const rejected = expect(request).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(SECURITY_REVIEW_REQUEST_TIMEOUT_MS);

    await rejected;
    expect(requestSignal?.aborted).toBe(true);
  });

  it('classifies a POST that reaches its deadline as uncertain and aborts it', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        requestSignal = init.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }),
    );
    const request = decideSecurityReview('incident-id', {
      expectedRevision: 2,
      disposition: 'dismissed',
      reason: 'Owner dismissed this notice.',
    });
    await vi.advanceTimersByTimeAsync(SECURITY_REVIEW_REQUEST_TIMEOUT_MS);

    await expect(request).resolves.toBe('uncertain');
    expect(requestSignal?.aborted).toBe(true);
  });

  it('aborts the bounded request promptly when its owner session is disposed', async () => {
    const ownerSignal = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        requestSignal = init.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }),
    );
    const request = listSecurityReviews(ownerSignal.signal);
    const rejected = expect(request).rejects.toBeTruthy();
    await Promise.resolve();
    await Promise.resolve();
    ownerSignal.abort();

    await rejected;
    expect(requestSignal?.aborted).toBe(true);
  });
});
