import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  auth: vi.fn(),
  service: {
    status: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn(),
    flow: vi.fn(),
    callback: vi.fn(),
  },
}));
vi.mock('@/mobile-auth', () => ({
  authenticateMobileOwner: state.auth,
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
  mobileJson: (body: unknown, init?: ResponseInit) =>
    Response.json(body, { ...init, headers: { 'Cache-Control': 'no-store' } }),
}));
vi.mock('@/lib/google-calendar-connection-runtime', () => ({
  getGoogleCalendarConnectionService: () => state.service,
}));

import { GET as callbackGET } from '../../../../oauth/google-calendar/callback/route';
import { POST } from './connect/route';
import { DELETE as flowDELETE, GET as flowGET } from './flow/route';
import { DELETE, GET } from './route';

const status = {
  configured: true,
  state: 'disconnected',
  account: null,
  capabilities: { calendarRead: false },
  flow: null,
};
const flowId = '11111111-1111-4111-8111-111111111111';
const request = (path = '', method = 'GET', body?: string) =>
  new Request(`https://example.invalid/api/mobile/v1/connections/google-calendar${path}`, {
    method,
    ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }),
  });
describe('personal Calendar mobile endpoints', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.auth.mockResolvedValue({ ownerId: 'owner' });
    state.service.status.mockResolvedValue(status);
    state.service.disconnect.mockResolvedValue(status);
    state.service.flow.mockResolvedValue(status);
  });
  it('requires owner authentication before any service call', async () => {
    state.auth.mockResolvedValue(null);
    for (const response of [
      await GET(request()),
      await DELETE(request('', 'DELETE')),
      await POST(request('/connect', 'POST', '{}')),
      await flowGET(request(`/flow?flowId=${flowId}`)),
      await flowDELETE(request(`/flow?flowId=${flowId}`, 'DELETE')),
    ])
      expect(response.status).toBe(401);
    expect(state.service.status).not.toHaveBeenCalled();
    expect(state.service.connect).not.toHaveBeenCalled();
    expect(state.service.disconnect).not.toHaveBeenCalled();
    expect(state.service.flow).not.toHaveBeenCalled();
  });
  it('binds status/disconnect to the authenticated owner', async () => {
    expect(await (await GET(request())).json()).toEqual(status);
    await DELETE(request('', 'DELETE'));
    expect(state.service.status).toHaveBeenCalledWith('owner');
    expect(state.service.disconnect).toHaveBeenCalledWith('owner');
  });
  it('rejects caller-supplied owner, scopes and return URLs', async () => {
    expect(
      (
        await POST(
          request(
            '/connect',
            'POST',
            JSON.stringify({ ownerId: 'other', returnUrl: 'https://evil.invalid' }),
          ),
        )
      ).status,
    ).toBe(400);
    expect(state.service.connect).not.toHaveBeenCalled();
    state.service.connect.mockResolvedValue({
      authorizationUrl: 'https://accounts.google.com/auth',
      flowId,
      expiresAt: '2026-11-14T13:00:00Z',
    });
    expect((await POST(request('/connect', 'POST', '{}'))).status).toBe(200);
    expect(state.service.connect).toHaveBeenCalledWith('owner');
  });
  it('starts only an explicit supported write upgrade for the authenticated owner', async () => {
    state.service.connect.mockResolvedValue({
      authorizationUrl: 'https://accounts.google.com/auth',
      flowId,
      expiresAt: '2026-11-14T13:00:00Z',
    });
    expect(
      (await POST(request('/connect', 'POST', JSON.stringify({ capability: 'calendarWrite' }))))
        .status,
    ).toBe(200);
    expect(state.service.connect).toHaveBeenCalledWith('owner', 'calendarWrite');
    state.service.connect.mockClear();
    for (const capability of ['calendar', 'read', true, null])
      expect((await POST(request('/connect', 'POST', JSON.stringify({ capability })))).status).toBe(
        400,
      );
    expect(state.service.connect).not.toHaveBeenCalled();
  });
  it('checks flow identity and cancellation, returning 404 for other flows', async () => {
    expect((await flowGET(request('/flow?flowId=bad'))).status).toBe(400);
    await flowDELETE(request(`/flow?flowId=${flowId}`, 'DELETE'));
    expect(state.service.flow).toHaveBeenCalledWith('owner', flowId, true);
    state.service.flow.mockResolvedValue(null);
    expect((await flowGET(request(`/flow?flowId=${flowId}`))).status).toBe(404);
  });
  it('sanitizes provider and storage errors', async () => {
    state.service.status.mockRejectedValue(Error('refresh-secret'));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('refresh-secret');
  });
  it('callback admits no arbitrary redirect and carries only opaque flow ID', async () => {
    state.service.callback.mockResolvedValue({ accepted: false, flowId });
    const response = await callbackGET(
      new Request(
        'https://example.invalid/api/oauth/google-calendar/callback?state=opaque&code=secret&returnUrl=https://evil.invalid',
      ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      `assistant-oauth://google-calendar/callback?flowId=${flowId}`,
    );
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('callback rejects invalid state without reflecting provider secrets', async () => {
    state.service.callback.mockResolvedValue({ accepted: false, flowId: null });
    const response = await callbackGET(
      new Request('https://example.invalid/api/oauth/google-calendar/callback?state=secret'),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('secret');
    expect(response.headers.get('Location')).toBeNull();
  });
});
