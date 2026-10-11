import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ allowed: vi.fn(), repository: null as unknown }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: state.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/server', () => ({ getEmailObligationRepository: () => state.repository }));

describe('mobile security review list route', () => {
  it('requires authentication before reading incidents', async () => {
    state.allowed.mockResolvedValue(false);
    const route = await import('./route.js');
    const response = await route.GET(
      new Request('https://example.test/api/mobile/v1/security-reviews'),
    );
    expect(response.status).toBe(401);
  });

  it('validates the bound and returns only the application projection', async () => {
    state.allowed.mockResolvedValue(true);
    const repository = {
      mailbox: vi.fn().mockResolvedValue({ agentId: 'owner-id' }),
      listSecurityReviewItems: vi.fn().mockResolvedValue([
        {
          incidentId: 'incident-id',
          revision: 3,
          confidence: 'provider-reference',
          disposition: 'unreviewed',
          category: 'security',
          importance: 3,
          subject: 'New sign-in',
          fromName: 'Security',
          observedAt: new Date('2026-10-06T18:00:00Z'),
          materialChangeReason: null,
          evidence: { evidenceQuote: 'new sign-in evidence' },
          rawBody: 'must not be returned',
        },
      ]),
    };
    state.repository = repository;
    const route = await import('./route.js');
    const invalid = await route.GET(
      new Request('https://example.test/api/mobile/v1/security-reviews?limit=101'),
    );
    expect(invalid.status).toBe(400);
    expect(repository.listSecurityReviewItems).not.toHaveBeenCalled();

    const response = await route.GET(
      new Request('https://example.test/api/mobile/v1/security-reviews?limit=10'),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.items).toEqual([
      expect.objectContaining({
        incidentId: 'incident-id',
        revision: 3,
        observedAt: '2026-10-06T18:00:00.000Z',
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain('must not be returned');
    expect(repository.listSecurityReviewItems).toHaveBeenCalledWith('owner-id', 10);
  });
});
