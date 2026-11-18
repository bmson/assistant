import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpOAuthCallback, mcpOAuthManagement } from './mcp-oauth-http';
import type { McpOAuthManagementService } from './mcp-oauth-wire';

const auth = vi.hoisted(() => ({ browser: vi.fn(), bearer: vi.fn(), owner: vi.fn() }));
vi.mock('@/auth', () => ({ isAuthed: auth.browser }));
vi.mock('@assistant/config', () => ({
  loadConfig: () => ({ AUTH_URL: 'https://assistant.example' }),
}));
vi.mock('@/mobile-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/mobile-auth')>()),
  authenticateMobileBearer: auth.bearer,
  resolveAuthenticatedInstallationOwner: auth.owner,
}));

const id = '8e312c66-b173-4683-9655-0372da2dd93d';
const flowId = 'f27992bd-3057-4282-9ede-1e7c5755c8c4';
const context = { params: Promise.resolve({ id }) };
const endpoint = `https://assistant.example/api/mobile/v1/mcp/${id}/oauth`;
const callback = 'https://assistant.example/api/oauth/mcp/callback';
const service = {
  start: vi.fn<McpOAuthManagementService['start']>(),
  status: vi.fn<McpOAuthManagementService['status']>(),
  verifyProvider: vi.fn<McpOAuthManagementService['verifyProvider']>(),
  disconnect: vi.fn<McpOAuthManagementService['disconnect']>(),
  flow: vi.fn<McpOAuthManagementService['flow']>(),
  callback: vi.fn<McpOAuthManagementService['callback']>(),
};
const getService = vi.fn<() => McpOAuthManagementService | null>();
const router = mcpOAuthManagement(getService);

beforeEach(() => {
  vi.resetAllMocks();
  auth.browser.mockResolvedValue({});
  auth.bearer.mockResolvedValue({ principal: 'test' });
  auth.owner.mockResolvedValue({ ok: true, ownerId: 'owner' });
  getService.mockReturnValue(service);
  service.start.mockResolvedValue({
    connectionId: id,
    flowId,
    authorizationUrl: 'https://provider.example/authorize',
    expiresAt: '2099-01-01T00:00:00Z',
  });
  service.status.mockResolvedValue({ connectionId: id, signInAvailable: true, grant: 'none' });
  service.callback.mockResolvedValue({ client: 'web', flowId });
});

function start(headers: Record<string, string>, body = '{}') {
  return new Request(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('MCP OAuth management and callback', () => {
  it('starts cookie flows only from the configured owner origin', async () => {
    for (const origin of [undefined, 'https://other.example']) {
      const response = await router.connection(start(origin ? { origin } : {}), context);
      expect(response.status).toBe(403);
    }
    expect(getService).not.toHaveBeenCalled();
    const response = await router.connection(
      start({ origin: 'https://assistant.example' }),
      context,
    );
    expect(response.status).toBe(200);
    expect(service.start).toHaveBeenCalledExactlyOnceWith('owner', id, 'web');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('uses native bearer without falling back to an owner session on invalid bearer', async () => {
    auth.bearer.mockResolvedValueOnce(null);
    const request = () => start({ authorization: 'Bearer native' });
    expect((await router.connection(request(), context)).status).toBe(401);
    expect(auth.browser).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    expect((await router.connection(request(), context)).status).toBe(200);
    expect(service.start).toHaveBeenCalledExactlyOnceWith('owner', id, 'ios');
  });

  it('rejects request-supplied redirect or duplicate flow IDs before any mutation', async () => {
    expect(
      (
        await router.connection(
          start({ origin: 'https://assistant.example' }, '{"returnTo":"https://other.example"}'),
          context,
        )
      ).status,
    ).toBe(400);
    const duplicate = `${endpoint}/flow?flowId=${flowId}&flowId=${flowId}`;
    const response = await router.flow(
      new Request(duplicate, { method: 'DELETE', headers: { authorization: 'Bearer native' } }),
      context,
    );
    expect(response.status).toBe(400);
    expect(getService).not.toHaveBeenCalled();
  });

  it('scopes status, cancellation and disconnect to the authenticated owner and connection', async () => {
    service.flow.mockResolvedValue({ connectionId: id, flowId, outcome: 'cancelled' });
    service.disconnect.mockResolvedValue({
      connectionId: id,
      signInAvailable: true,
      grant: 'none',
    });
    const headers = { authorization: 'Bearer native' };
    expect((await router.connection(new Request(endpoint, { headers }), context)).status).toBe(200);
    expect(
      (
        await router.flow(
          new Request(`${endpoint}/flow?flowId=${flowId}`, { method: 'DELETE', headers }),
          context,
        )
      ).status,
    ).toBe(200);
    expect(
      (await router.connection(new Request(endpoint, { method: 'DELETE', headers }), context))
        .status,
    ).toBe(200);
    expect(service.status).toHaveBeenCalledExactlyOnceWith('owner', id);
    expect(service.flow).toHaveBeenCalledExactlyOnceWith('owner', id, flowId, true);
    expect(service.disconnect).toHaveBeenCalledExactlyOnceWith('owner', id);
  });

  it('checks provider availability only on an explicit owner read', async () => {
    service.verifyProvider.mockResolvedValue({
      connectionId: id,
      signInAvailable: true,
      grant: 'none',
      providerAvailable: true,
    });
    const url = `${endpoint}?verify=provider`;
    expect((await router.connection(new Request(url), context)).status).toBe(200);
    expect(service.verifyProvider).toHaveBeenCalledExactlyOnceWith('owner', id);
    expect(service.status).not.toHaveBeenCalled();
    const denied = await router.connection(
      new Request(url, { method: 'DELETE', headers: { origin: 'https://assistant.example' } }),
      context,
    );
    expect(denied.status).toBe(400);
    expect(service.disconnect).not.toHaveBeenCalled();
  });

  it('stops before service calls when unconfigured and keeps malformed callback data private', async () => {
    getService.mockReturnValue(null);
    expect((await router.connection(new Request(endpoint), context)).status).toBe(503);
    const handle = mcpOAuthCallback(getService);
    const response = await handle(new Request(`${callback}?state=one&state=two&code=secret`));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('secret');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(service.callback).not.toHaveBeenCalled();
  });

  it('returns only to fixed destinations even if provider parameters request a different return URL', async () => {
    const handle = mcpOAuthCallback(getService);
    const url = `${callback}?state=state&code=private&iss=https%3A%2F%2Fprovider.example&returnTo=https%3A%2F%2Fother.example`;
    const response = await handle(new Request(url));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/settings#connected-tools');
    expect(response.headers.get('cache-control')).toBe('no-store');
    service.callback.mockResolvedValueOnce({ client: 'ios', flowId });
    const native = await handle(new Request(url));
    expect(native.headers.get('location')).toBe(`assistant-oauth://mcp/callback?flowId=${flowId}`);
    expect(auth.browser).not.toHaveBeenCalled();
    expect(auth.bearer).not.toHaveBeenCalled();
  });
});
