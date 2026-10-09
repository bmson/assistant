import { afterEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  GCP_PROJECT: 'test-project',
  MOBILE_API_TOKEN: 'startup-token',
  MOBILE_API_TOKEN_SECRET_NAME: '',
  MOBILE_API_TOKEN_ROTATION_ENABLED: false,
  OWNER_AUTH_MODE: 'google',
}));
vi.mock('@assistant/config', () => ({ loadConfig: () => config }));

import {
  clearMobileAccessTokenCache,
  getMobileAccessToken,
  hasMobileTokenRotationCapability,
} from './mobile-access-token';

afterEach(() => {
  config.OWNER_AUTH_MODE = 'google';
  config.MOBILE_API_TOKEN_SECRET_NAME = '';
  config.MOBILE_API_TOKEN_ROTATION_ENABLED = false;
  clearMobileAccessTokenCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('mobile token refresh across Cloud Run instances', () => {
  it('uses the local configured token outside Cloud Run', async () => {
    vi.stubEnv('K_SERVICE', '');
    expect(await getMobileAccessToken()).toBe('startup-token');
  });
  it('preserves installation-specific legacy tokens alongside passkey device keys', async () => {
    vi.stubEnv('K_SERVICE', 'customer-web');
    config.OWNER_AUTH_MODE = 'passkey';
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await getMobileAccessToken()).toBe('startup-token');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves immutable injected secrets without attempting a global Secret Manager read', async () => {
    vi.stubEnv('K_SERVICE', 'customer-web');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await getMobileAccessToken()).toBe('startup-token');
    expect(hasMobileTokenRotationCapability()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('only exposes rotation when an installation names an explicitly writable secret', () => {
    config.MOBILE_API_TOKEN_SECRET_NAME = 'installation-mobile-key';
    expect(hasMobileTokenRotationCapability()).toBe(false);
    config.MOBILE_API_TOKEN_ROTATION_ENABLED = true;
    expect(hasMobileTokenRotationCapability()).toBe(true);
  });
  it('refreshes the latest secret on another instance after rotation', async () => {
    vi.stubEnv('K_SERVICE', 'assistant-web');
    config.MOBILE_API_TOKEN_SECRET_NAME = 'installation-mobile-key';
    let current = 'old-token';
    const fetcher = vi.fn(async (url: string) =>
      url.includes('metadata.google.internal')
        ? Response.json({ access_token: 'metadata-token' })
        : Response.json({ payload: { data: Buffer.from(current).toString('base64') } }),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(await getMobileAccessToken()).toBe('old-token');
    current = 'new-token';
    expect(await getMobileAccessToken()).toBe('old-token');
    expect(await getMobileAccessToken(true)).toBe('new-token');
    expect(await getMobileAccessToken()).toBe('new-token');
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls[1]?.[0]).toContain('/secrets/installation-mobile-key/');
    expect(fetcher.mock.calls[1]?.[0]).not.toContain('/secrets/mobile-api-token/');
  });
  it('allows settings to load before a cloud token has been configured', async () => {
    vi.stubEnv('K_SERVICE', 'assistant-web');
    config.MOBILE_API_TOKEN_SECRET_NAME = 'installation-mobile-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('metadata.google.internal')
          ? Response.json({ access_token: 'metadata-token' })
          : new Response(null, { status: 404 }),
      ),
    );
    expect(await getMobileAccessToken()).toBe('');
  });
  it('does not fall back to a startup token when the secret read fails', async () => {
    vi.stubEnv('K_SERVICE', 'assistant-web');
    config.MOBILE_API_TOKEN_SECRET_NAME = 'installation-mobile-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    await expect(getMobileAccessToken()).rejects.toThrow('credentials unavailable');
  });
});
