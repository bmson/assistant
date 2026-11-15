import { describe, expect, it, vi } from 'vitest';
import { GoogleClient } from './client.js';

const url = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';

describe('GoogleClient connected credentials', () => {
  it('rechecks authority for every request and stops after disconnect', async () => {
    const accessToken = vi
      .fn()
      .mockResolvedValueOnce('access')
      .mockRejectedValueOnce(new Error('Disconnected'));
    const fetch = vi.fn(async () => Response.json({ items: [] }));
    const client = new GoogleClient({
      clientId: '',
      clientSecret: '',
      refreshToken: '',
      tokenProvider: { accessToken, cursorSecret: 'identity-revision-secret' },
      fetch,
    });
    expect(client.configured()).toBe(true);
    await expect(client.api(url)).resolves.toEqual({ items: [] });
    await expect(client.api(url)).rejects.toThrow('Disconnected');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('requests one forced refresh after a rejected access token', async () => {
    const accessToken = vi.fn(async (force?: boolean) => (force ? 'fresh' : 'old'));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ items: [] }));
    const client = new GoogleClient({
      clientId: '',
      clientSecret: '',
      refreshToken: '',
      tokenProvider: { accessToken, cursorSecret: 'identity-revision-secret' },
      fetch,
    });
    await expect(client.api(url)).resolves.toEqual({ items: [] });
    expect(accessToken.mock.calls).toEqual([[false], [true, 'old']]);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer fresh',
    );
  });

  it('binds opaque cursors to the connected account revision', () => {
    const make = (cursorSecret: string) =>
      new GoogleClient({
        clientId: '',
        clientSecret: '',
        refreshToken: '',
        tokenProvider: { accessToken: async () => 'access', cursorSecret },
      });
    const first = make('account-one-revision-one-secret');
    const cursor = first.signOpaqueToken('private calendar cursor');
    expect(first.verifyOpaqueToken(cursor)).toBe('private calendar cursor');
    expect(make('account-one-revision-two-secret').verifyOpaqueToken(cursor)).toBeNull();
    expect(make('account-two-revision-one-secret').verifyOpaqueToken(cursor)).toBeNull();
  });
  it.each([401, 403])(
    'reports the final HTTP %s response with the token actually rejected',
    async (status) => {
      const requestFailed = vi.fn(async () => {});
      const accessToken = vi.fn(async (force?: boolean) => (force ? 'fresh' : 'old'));
      const body = JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } });
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, { status }));
      const client = new GoogleClient({
        clientId: '',
        clientSecret: '',
        refreshToken: '',
        tokenProvider: { accessToken, requestFailed, cursorSecret: 'secret' },
        fetch,
      });
      await expect(client.api(url)).rejects.toMatchObject({ status });
      expect(fetch).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
      expect(requestFailed).toHaveBeenCalledExactlyOnceWith({
        status,
        body,
        accessToken: status === 401 ? 'fresh' : 'old',
        url,
      });
    },
  );
  it('does not report an initial 401 that succeeds after one forced refresh', async () => {
    const requestFailed = vi.fn(async () => {});
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ items: [] }));
    const client = new GoogleClient({
      clientId: '',
      clientSecret: '',
      refreshToken: '',
      tokenProvider: {
        accessToken: async (force) => (force ? 'fresh' : 'old'),
        requestFailed,
        cursorSecret: 'secret',
      },
      fetch,
    });
    await expect(client.api(url)).resolves.toEqual({ items: [] });
    expect(requestFailed).not.toHaveBeenCalled();
  });
  it('reports the credential version captured for that request', async () => {
    const requestFailed = vi.fn(async () => {});
    const accessToken = vi.fn(async () => ({ accessToken: 'same-token', credentialVersion: 7 }));
    const body = JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } });
    const client = new GoogleClient({
      clientId: '',
      clientSecret: '',
      refreshToken: '',
      tokenProvider: { accessToken, requestFailed, cursorSecret: 'secret' },
      fetch: async () => new Response(body, { status: 403 }),
    });
    await expect(client.api(url)).rejects.toMatchObject({ status: 403 });
    expect(requestFailed).toHaveBeenCalledExactlyOnceWith({
      status: 403,
      body,
      accessToken: 'same-token',
      credentialVersion: 7,
      url,
    });
  });
  it('passes the token rejected by a late 401 after another request has advanced credentials', async () => {
    let current = 'old';
    let resolveOld: ((value: Response) => void) | undefined;
    const accessToken = vi.fn(async (_force?: boolean, _rejected?: string) => current);
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (new Headers(init?.headers).get('Authorization') === 'Bearer old')
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      return Response.json({ items: [] });
    });
    const client = new GoogleClient({
      clientId: '',
      clientSecret: '',
      refreshToken: '',
      tokenProvider: { accessToken, cursorSecret: 'secret' },
      fetch,
    });
    const first = client.api(url);
    await vi.waitFor(() => expect(resolveOld).toBeDefined());
    current = 'fresh';
    await expect(client.api(url)).resolves.toEqual({ items: [] });
    if (!resolveOld) throw new Error('Expected old request');
    resolveOld(new Response('', { status: 401 }));
    await expect(first).resolves.toEqual({ items: [] });
    expect(accessToken.mock.calls).toEqual([[false], [false], [true, 'old']]);
  });
});
