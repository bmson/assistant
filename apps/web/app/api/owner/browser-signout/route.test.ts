import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authUrl: 'https://assistant.example' as string,
  signOut: vi.fn(),
  clearOwnerSessionCookie: vi.fn(),
}));

async function loadRoute(mode: 'google' | 'passkey' | 'disabled' | 'dev-bypass') {
  vi.resetModules();
  vi.doMock('@assistant/config', () => ({ loadConfig: () => ({ AUTH_URL: mocks.authUrl }) }));
  vi.doMock('@/auth', () => ({ authMode: mode, signOut: mocks.signOut }));
  vi.doMock('@/lib/owner-auth/runtime', () => ({
    clearOwnerSessionCookie: mocks.clearOwnerSessionCookie,
  }));
  return import('./route');
}

function request(origin?: string, url = 'https://assistant.example/api/owner/browser-signout') {
  return new Request(url, {
    method: 'POST',
    headers: origin === undefined ? {} : { origin },
    referrer: 'https://assistant.example/audit',
  });
}

describe('browser sign-out endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authUrl = 'https://assistant.example';
    mocks.signOut.mockResolvedValue({ cookies: [] });
  });

  it('rejects missing and cross-origin requests before changing browser auth state', async () => {
    const route = await loadRoute('google');
    for (const origin of [
      undefined,
      'https://attacker.example',
      'http://assistant.example',
      'https://assistant.example:8443',
    ]) {
      const response = await route.POST(request(origin));
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.clearOwnerSessionCookie).not.toHaveBeenCalled();
  });

  it('delegates browser cookie invalidation to Auth.js and redirects to its fixed sign-in route', async () => {
    mocks.signOut.mockResolvedValue({
      cookies: [{ name: 'authjs.session-token', value: '', options: { maxAge: 0, path: '/' } }],
    });
    const route = await loadRoute('google');
    const response = await route.POST(request('https://assistant.example'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://assistant.example/api/auth/signin');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false });
    expect(mocks.clearOwnerSessionCookie).not.toHaveBeenCalled();
  });

  it('accepts the exact configured scheme and port, not a lookalike origin', async () => {
    mocks.authUrl = 'https://assistant.example:8443';
    const route = await loadRoute('google');
    const response = await route.POST(
      request(
        'https://assistant.example:8443',
        'https://assistant.example:8443/api/owner/browser-signout',
      ),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://assistant.example:8443/api/auth/signin');
  });

  it('clears only the current passkey cookie and redirects to the local sign-in page', async () => {
    const route = await loadRoute('passkey');
    const response = await route.POST(request('https://assistant.example'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://assistant.example/signin');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.clearOwnerSessionCookie).toHaveBeenCalledOnce();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'dev-bypass'] as const)('fails closed in %s mode', async (mode) => {
    const route = await loadRoute(mode);
    const response = await route.POST(request('https://assistant.example'));
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.clearOwnerSessionCookie).not.toHaveBeenCalled();
  });

  it('fails closed when the configured auth origin is invalid', async () => {
    mocks.authUrl = 'not-an-origin';
    const route = await loadRoute('google');
    const response = await route.POST(request('https://assistant.example'));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('does not redirect as though sign-out succeeded when the cookie operation fails', async () => {
    mocks.signOut.mockRejectedValue(new Error('synthetic sign-out failure'));
    const route = await loadRoute('google');
    const response = await route.POST(request('https://assistant.example'));
    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('fails closed if Auth.js does not return its cookie mutation result', async () => {
    mocks.signOut.mockResolvedValue(null);
    const route = await loadRoute('google');
    const response = await route.POST(request('https://assistant.example'));
    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('does not redirect as though passkey sign-out succeeded when cookie clearing fails', async () => {
    mocks.clearOwnerSessionCookie.mockRejectedValue(new Error('synthetic cookie failure'));
    const route = await loadRoute('passkey');
    const response = await route.POST(request('https://assistant.example'));
    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
