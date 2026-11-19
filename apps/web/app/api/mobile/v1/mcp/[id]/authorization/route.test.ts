import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ auth: vi.fn(), diagnose: vi.fn() }));
vi.mock('@/lib/mcp-authorization-runtime', () => ({
  diagnoseOwnerMcpAuthorization: state.diagnose,
}));
vi.mock('@/lib/mcp-authorization-auth', () => ({ authenticateMcpAuthorizationRead: state.auth }));
vi.mock('@/mobile-auth', () => ({
  mobileJson: (body: unknown, init?: ResponseInit) =>
    Response.json(body, { ...init, headers: { 'Cache-Control': 'no-store' } }),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { GET } from './route';

const id = randomUUID();
const result = {
  connectionId: id,
  status: 'unsupported',
  authenticated: false,
  oauthConnectionSupported: false,
  transportProtocolVersion: '2025-11-25',
  resource: null,
  authorizationServers: [],
  reason: 'pkce_s256_required',
};
const request = (suffix = '') =>
  new Request(`https://assistant.example/api/mobile/v1/mcp/${id}/authorization${suffix}`);
const params = (value: string = id) => ({ params: Promise.resolve({ id: value }) });
beforeEach(() => {
  vi.clearAllMocks();
  state.auth.mockResolvedValue({ kind: 'authenticated', ownerId: 'owner' });
  state.diagnose.mockResolvedValue({ kind: 'diagnostic', diagnostic: result });
});

describe('owner-authenticated MCP authorization read', () => {
  it('authenticates before any lookup or outbound diagnostic', async () => {
    state.auth.mockResolvedValue({ kind: 'unauthenticated' });
    expect((await GET(request(), params())).status).toBe(401);
    expect(state.diagnose).not.toHaveBeenCalled();
  });
  it('accepts only a stored UUID, with no caller endpoint or discovery override', async () => {
    expect((await GET(request(), params('bad'))).status).toBe(400);
    expect((await GET(request('?endpoint=https://evil.example'), params())).status).toBe(400);
    expect(state.diagnose).not.toHaveBeenCalled();
  });
  it('returns a transient result bound to the authenticated owner and cancellation signal', async () => {
    const req = request();
    const response = await GET(req, params());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(result);
    expect(state.diagnose).toHaveBeenCalledWith('owner', id, req.signal);
  });
  it.each([
    ['not_found', 404],
    ['changed', 409],
  ] as const)('reports %s without connection metadata', async (kind, status) => {
    state.diagnose.mockResolvedValue({ kind });
    const response = await GET(request(), params());
    expect(response.status).toBe(status);
    expect(await response.json()).not.toHaveProperty('resource');
  });
  it('does not reflect local/provider errors or credentials', async () => {
    state.diagnose.mockRejectedValue(Error('provider-secret bearer-token'));
    const response = await GET(request(), params());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('provider-secret');
  });
});
