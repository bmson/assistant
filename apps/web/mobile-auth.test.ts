import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  config: {
    GCP_PROJECT: 'fixture-project',
    MOBILE_API_TOKEN_SECRET_NAME: 'fixture-mobile-token',
    MOBILE_API_TOKEN: 'startup-token',
    OWNER_AUTH_MODE: 'google',
    AUTH_URL: 'https://assistant.example.com',
    PUBLIC_URL: 'https://assistant.example.com',
  },
  cookie: vi.fn(),
  device: vi.fn(),
}));
vi.mock('@assistant/config', () => ({ loadConfig: () => authState.config }));
vi.mock('./auth', () => ({ isAuthed: authState.cookie }));
vi.mock('./lib/owner-auth/runtime', () => ({ verifyOwnerDeviceToken: authState.device }));

import { clearMobileAccessTokenCache } from './lib/mobile-access-token';
import { isMobileAuthed } from './mobile-auth';
import { secureTokenMatches } from './mobile-token';

beforeEach(() => {
  clearMobileAccessTokenCache();
  authState.cookie.mockReset().mockResolvedValue(false);
  authState.device.mockReset().mockResolvedValue(false);
  authState.config.OWNER_AUTH_MODE = 'google';
});
afterEach(() => {
  clearMobileAccessTokenCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('mobile bearer authentication', () => {
  it('accepts only the complete configured token', () => {
    const token = 'd8d42649c69262c8d50f937066c66bc64c12e12d8ff0c2e2b16ef8ea275891ef';
    expect(secureTokenMatches(token, token)).toBe(true);
    expect(secureTokenMatches(token, `${token}0`)).toBe(false);
    expect(secureTokenMatches(token, token.slice(0, -1))).toBe(false);
  });

  it('never treats an empty token as a credential', () => {
    expect(secureTokenMatches('', '')).toBe(false);
    expect(secureTokenMatches('configured', '')).toBe(false);
  });

  it('bounds sequential and concurrent invalid bearer refreshes and recognizes rotation after 30 seconds', async () => {
    vi.stubEnv('K_SERVICE', 'fixture-web');
    vi.useFakeTimers();
    let token = 'old-token';
    const fetcher = vi.fn(async (url: string) =>
      url.includes('metadata.google.internal')
        ? Response.json({ access_token: 'mock-metadata' })
        : Response.json({ payload: { data: Buffer.from(token).toString('base64') } }),
    );
    vi.stubGlobal('fetch', fetcher);
    const request = (value: string) =>
      new Request('https://assistant.example.com/api/mobile/v1/activity', {
        method: 'POST',
        headers: { authorization: `Bearer ${value}` },
      });
    for (let i = 0; i < 50; i++) expect(await isMobileAuthed(request(`invalid-${i}`))).toBe(false);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => isMobileAuthed(request(`overlap-${i}`))),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await isMobileAuthed(request('old-token'))).toBe(true);
    token = 'new-token';
    expect(await isMobileAuthed(request(token))).toBe(false);
    vi.advanceTimersByTime(30_001);
    expect(await isMobileAuthed(request(token))).toBe(true);
    expect(await isMobileAuthed(request('old-token'))).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('fails closed and bounds read attempts during secret-service outage', async () => {
    vi.stubEnv('K_SERVICE', 'fixture-web');
    const fetcher = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 10; i++)
      expect(
        await isMobileAuthed(
          new Request('https://assistant.example.com/api/mobile/v1/activity', {
            headers: { authorization: 'Bearer startup-token' },
          }),
        ),
      ).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it.each(['https://sibling.example.com', 'https://other.test', 'null', null])(
    'rejects cookie writes from %s before owner-session lookup',
    async (origin) => {
      vi.stubEnv('K_SERVICE', '');
      authState.cookie.mockResolvedValue(true);
      const headers = new Headers({
        'content-type': 'text/plain',
        authorization: 'Bearer invalid',
      });
      if (origin !== null) headers.set('origin', origin);
      expect(
        await isMobileAuthed(
          new Request('https://assistant.example.com/api/mobile/v1/memory/profile', {
            method: 'POST',
            headers,
            body: '{"action":"erase"}',
          }),
        ),
      ).toBe(false);
      expect(authState.cookie).not.toHaveBeenCalled();
    },
  );

  it('preserves exact-origin cookie writes, safe cookie reads, and originless authenticated device writes', async () => {
    vi.stubEnv('K_SERVICE', '');
    authState.cookie.mockResolvedValue(true);
    expect(
      await isMobileAuthed(
        new Request('https://assistant.example.com/api/mobile', {
          method: 'POST',
          headers: { origin: 'https://assistant.example.com' },
        }),
      ),
    ).toBe(true);
    expect(await isMobileAuthed(new Request('https://assistant.example.com/api/mobile'))).toBe(
      true,
    );
    expect(
      await isMobileAuthed(
        new Request('https://assistant.example.com/api/mobile', {
          method: 'DELETE',
          headers: { authorization: 'Bearer startup-token' },
        }),
      ),
    ).toBe(true);
    authState.config.OWNER_AUTH_MODE = 'passkey';
    authState.device.mockResolvedValue(true);
    expect(
      await isMobileAuthed(
        new Request('https://assistant.example.com/api/mobile', {
          method: 'POST',
          headers: { authorization: 'Bearer asd1_fixture' },
        }),
      ),
    ).toBe(true);
  });
});
