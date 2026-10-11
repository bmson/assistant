import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: {
    PERSISTENCE_DRIVER: 'firestore',
    ASSISTANT_RELEASE_WRITES_PAUSED: false,
    RESTORE_REHEARSAL: false,
    AUTH_URL: '',
    WEB_APP_PREVIEW_ENABLED: false,
  },
  authenticated: false,
  repository: null as unknown,
  getRepository: vi.fn(),
}));

vi.mock('@assistant/config', () => ({ loadConfig: () => state.config }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: async () => state.authenticated,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/server', () => ({
  getEmailObligationRepository: () => {
    state.getRepository();
    return state.repository;
  },
}));

import { proxy } from '../proxy.js';

const listPath = '/api/mobile/v1/security-reviews';
const incidentId = 'a3128194-69b2-5f49-96fa-0e1fab70eef2';

async function dispatch(request: NextRequest): Promise<Response> {
  const gate = proxy(request);
  if (gate.headers.get('x-middleware-next') !== '1') return gate;

  if (request.nextUrl.pathname === listPath && request.method === 'GET') {
    const route = await import('../app/api/mobile/v1/security-reviews/route.js');
    return route.GET(request);
  }
  const match = request.nextUrl.pathname.match(/^\/api\/mobile\/v1\/security-reviews\/([^/]+)$/);
  if (match && request.method === 'POST') {
    const route = await import('../app/api/mobile/v1/security-reviews/[id]/route.js');
    return route.POST(request, { params: Promise.resolve({ id: match[1] }) });
  }
  return Response.json({ error: 'No route handler' }, { status: 404 });
}

describe('Firestore mobile security review proxy and route composition', () => {
  beforeEach(() => {
    state.config.PERSISTENCE_DRIVER = 'firestore';
    state.config.ASSISTANT_RELEASE_WRITES_PAUSED = false;
    state.config.RESTORE_REHEARSAL = false;
    state.authenticated = false;
    state.repository = null;
    state.getRepository.mockClear();
  });

  it('allows only collection GET and strict UUIDv5 decision POST paths', () => {
    const status = (path: string, method = 'GET') =>
      proxy(new NextRequest(`https://assistant.test${path}`, { method })).status;

    expect(status(listPath)).toBe(200);
    expect(status(listPath, 'HEAD')).toBe(503);
    expect(status(listPath, 'POST')).toBe(503);
    expect(status(`${listPath}/${incidentId}`, 'POST')).toBe(200);
    expect(status(`${listPath}/a3128194-69b2-4f49-96fa-0e1fab70eef2`, 'POST')).toBe(503);
    expect(status(`${listPath}/not-a-uuid`, 'POST')).toBe(503);
    expect(status(`${listPath}/${incidentId}/nested`, 'POST')).toBe(503);
    expect(status(`${listPath}/${incidentId}`, 'GET')).toBe(503);
    expect(status(`${listPath}/${incidentId}`, 'DELETE')).toBe(503);
  });

  it('composes auth, bounded owner listing, invalid decisions, and stale decisions', async () => {
    const repository = {
      mailbox: vi.fn().mockResolvedValue({ agentId: 'configured-owner' }),
      listSecurityReviewItems: vi.fn().mockResolvedValue([
        {
          incidentId,
          revision: 4,
          confidence: 'provider-reference',
          disposition: 'unreviewed',
          category: 'security',
          importance: 3,
          subject: 'New sign-in',
          fromName: 'Security',
          observedAt: new Date('2026-10-11T18:00:00.000Z'),
          materialChangeReason: null,
          evidence: null,
        },
      ]),
      decideSecurityIncident: vi.fn(),
    };
    repository.decideSecurityIncident.mockImplementation(
      async (decision: { agentId: string; incidentId: string; expectedRevision: number }) =>
        decision.agentId === 'configured-owner' &&
        decision.incidentId === incidentId &&
        decision.expectedRevision === 4,
    );
    state.repository = repository;

    const unauthenticated = await dispatch(
      new NextRequest(`https://assistant.test${listPath}?limit=20`),
    );
    expect(unauthenticated.status).toBe(401);
    expect(state.getRepository).not.toHaveBeenCalled();

    const unauthenticatedDecision = await dispatch(
      new NextRequest(`https://assistant.test${listPath}/${incidentId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 4,
          disposition: 'dismissed',
          reason: 'owner reviewed the notice',
        }),
      }),
    );
    expect(unauthenticatedDecision.status).toBe(401);
    expect(state.getRepository).not.toHaveBeenCalled();

    state.authenticated = true;
    const invalidLimit = await dispatch(
      new NextRequest(`https://assistant.test${listPath}?limit=101`),
    );
    expect(invalidLimit.status).toBe(400);
    expect(repository.mailbox).not.toHaveBeenCalled();
    const listing = await dispatch(new NextRequest(`https://assistant.test${listPath}?limit=20`));
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({
      items: [expect.objectContaining({ incidentId, revision: 4, subject: 'New sign-in' })],
    });
    expect(repository.mailbox).toHaveBeenCalledOnce();
    expect(repository.listSecurityReviewItems).toHaveBeenCalledWith('configured-owner', 20);

    const invalid = await dispatch(
      new NextRequest(`https://assistant.test${listPath}/${incidentId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 0, disposition: 'dismissed', reason: 'reviewed' }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(repository.decideSecurityIncident).not.toHaveBeenCalled();

    const stale = await dispatch(
      new NextRequest(`https://assistant.test${listPath}/${incidentId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 3,
          disposition: 'dismissed',
          reason: 'owner reviewed the notice',
        }),
      }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).not.toHaveProperty('ok', true);
    expect(repository.decideSecurityIncident).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'configured-owner', incidentId, expectedRevision: 3 }),
    );

    const accepted = await dispatch(
      new NextRequest(`https://assistant.test${listPath}/${incidentId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 4,
          disposition: 'dismissed',
          reason: 'owner reviewed the notice',
        }),
      }),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true });
    expect(repository.decideSecurityIncident).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'configured-owner', incidentId, expectedRevision: 4 }),
    );
  });
});
