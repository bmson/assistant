import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ allowed: vi.fn(), repository: null as unknown }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: state.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/server', () => ({ getEmailObligationRepository: () => state.repository }));

describe('mobile security review decision route', () => {
  const id = 'a3128194-69b2-5f49-96fa-0e1fab70eef2';
  const post = async (route: typeof import('./route.js'), body: unknown, incidentId = id) =>
    route.POST(
      new Request(`https://example.test/api/mobile/v1/security-reviews/${incidentId}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: incidentId }) },
    );

  it('requires authentication before resolving the owner or decision repository', async () => {
    state.allowed.mockResolvedValue(false);
    const route = await import('./route.js');
    expect((await post(route, {})).status).toBe(401);
  });

  it('rejects invalid IDs, stale revisions, and unexpected decision fields', async () => {
    state.allowed.mockResolvedValue(true);
    const repository = {
      mailbox: vi.fn().mockResolvedValue({ agentId: 'owner-id' }),
      decideSecurityIncident: vi.fn().mockResolvedValue(false),
    };
    state.repository = repository;
    const route = await import('./route.js');
    expect((await post(route, {}, 'unknown')).status).toBe(400);
    expect(
      (
        await post(route, {
          expectedRevision: 2,
          disposition: 'dismissed',
          reason: 'reviewed',
          agentId: 'foreign-owner',
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(route, { expectedRevision: 2, disposition: 'dismissed', reason: 'reviewed' }))
        .status,
    ).toBe(409);
    expect(repository.decideSecurityIncident).toHaveBeenCalledWith({
      agentId: 'owner-id',
      incidentId: id,
      expectedRevision: 2,
      disposition: 'dismissed',
      reason: 'reviewed',
      now: expect.any(Date),
    });
  });

  it('rejects invalid decision data before repository access and accepts a current revision', async () => {
    state.allowed.mockResolvedValue(true);
    const repository = {
      mailbox: vi.fn().mockResolvedValue({ agentId: 'owner-id' }),
      decideSecurityIncident: vi.fn().mockResolvedValue(true),
    };
    state.repository = repository;
    const route = await import('./route.js');
    expect(
      (await post(route, { expectedRevision: 0, disposition: 'dismissed', reason: 'reviewed' }))
        .status,
    ).toBe(400);
    expect(
      (await post(route, { expectedRevision: -1, disposition: 'dismissed', reason: 'reviewed' }))
        .status,
    ).toBe(400);
    expect(repository.mailbox).not.toHaveBeenCalled();
    const response = await post(route, {
      expectedRevision: 1,
      disposition: 'expected',
      reason: 'owner recognizes this sign-in',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
