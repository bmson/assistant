import type { CalendarAccount, CalendarAccountRepository } from '@assistant/persistence';
import { OAuth2Client } from 'google-auth-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginCalendarConnection,
  CALENDAR_READ_SCOPE,
  type CalendarAccountPorts,
  calendarAccountsOverview,
  calendarCallbackURL,
  completeCalendarConnection,
  verifyCalendarConnectionState,
} from './calendar-accounts.js';

describe('calendar account consent', () => {
  let saved: CalendarAccount[];
  let ports: CalendarAccountPorts;
  beforeEach(() => {
    saved = [];
    ports = {
      config: {
        GOOGLE_OAUTH_CLIENT_ID: 'calendar-client',
        GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
        MCP_ENC_KEY: 'aa'.repeat(32),
        AUTH_URL: 'https://assistant.test',
        ASSISTANT_MODULES: ['calendar'],
      },
      accounts: {
        list: async () => saved,
        save: async (row) => {
          saved = [row];
        },
      } as CalendarAccountRepository,
      seal: (value) => Buffer.from(value).toString('base64url'),
      open: (value) => Buffer.from(value, 'base64url').toString(),
    };
  });
  afterEach(() => vi.restoreAllMocks());

  it('requests separate read-only calendar consent with PKCE and offline access', async () => {
    const start = await beginCalendarConnection(ports, 'browser-session');
    const url = new URL(start.url);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'openid',
      'email',
      CALENDAR_READ_SCOPE,
    ]);
    expect(url.searchParams.get('prompt')).toBe('select_account consent');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://assistant.test/api/calendar-accounts/callback',
    );
    const state = url.searchParams.get('state') ?? '';
    expect(
      verifyCalendarConnectionState(ports, start.cookie, state, 'browser-session').verifier.length,
    ).toBeGreaterThan(43);
    expect(() =>
      verifyCalendarConnectionState(ports, start.cookie, state, 'another-login'),
    ).toThrow();
    expect(() =>
      verifyCalendarConnectionState(ports, start.cookie, 'wrong', 'browser-session'),
    ).toThrow();
    const expired = JSON.parse(ports.open(start.cookie));
    expired.issuedAt -= 16 * 60_000;
    expect(() =>
      verifyCalendarConnectionState(
        ports,
        ports.seal(JSON.stringify(expired)),
        state,
        'browser-session',
      ),
    ).toThrow();
  });

  it('reuses the registered owner callback only for the same Google client', async () => {
    ports.config.AUTH_GOOGLE_ID = 'calendar-client';
    const start = await beginCalendarConnection(ports, 'browser-session');
    const url = new URL(start.url);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://assistant.test/api/auth/callback/google',
    );
    const state = url.searchParams.get('state') ?? '';
    expect(state).toMatch(/^calendar\./);
    expect(
      verifyCalendarConnectionState(ports, start.cookie, state, 'browser-session').redirectUri,
    ).toContain('/api/auth/callback/google');
    ports.config.AUTH_GOOGLE_ID = 'different-owner-client';
    await expect(
      completeCalendarConnection(ports, {
        cookie: start.cookie,
        state,
        sessionScope: 'browser-session',
        code: 'code',
      }),
    ).rejects.toThrow();
  });

  it('rejects insecure remote callback origins and credentials in URLs', () => {
    expect(() => calendarCallbackURL('http://assistant.test')).toThrow();
    expect(() => calendarCallbackURL('https://user:pass@assistant.test')).toThrow();
    expect(calendarCallbackURL('http://localhost:3000')).toContain('localhost:3000');
  });

  async function connection() {
    const start = await beginCalendarConnection(ports, 'session');
    return {
      cookie: start.cookie,
      state: new URL(start.url).searchParams.get('state') ?? '',
      code: 'code',
      sessionScope: 'session',
    };
  }
  function tokens(scope = `openid email ${CALENDAR_READ_SCOPE}`, verified = true) {
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: { id_token: 'signed-id', refresh_token: 'private-work-refresh', scope },
      res: null,
    } as never);
    vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
      getPayload: () => ({
        sub: 'work-subject',
        email: 'work@example.test',
        email_verified: verified,
      }),
    } as never);
  }

  it('verifies the Google identity and seals the grant without returning credentials to Settings', async () => {
    tokens();
    await completeCalendarConnection(ports, await connection());
    expect(saved[0]).toMatchObject({
      id: 'work-subject',
      email: 'work@example.test',
      clientId: 'calendar-client',
      lastError: null,
    });
    expect(saved[0]?.refreshTokenEncrypted).not.toContain('private-work-refresh');
    expect(ports.open(saved[0]?.refreshTokenEncrypted ?? '')).toBe('private-work-refresh');
    expect(JSON.stringify(await calendarAccountsOverview(ports))).not.toMatch(
      /private-work-refresh|refreshTokenEncrypted|signed-id/,
    );
    expect(OAuth2Client.prototype.getToken).toHaveBeenCalledWith(
      expect.objectContaining({
        codeVerifier: expect.any(String),
        redirect_uri: 'https://assistant.test/api/calendar-accounts/callback',
      }),
    );
  });

  it.each(['openid email', CALENDAR_READ_SCOPE])(
    'rejects denied scopes or an unverified identity (%s)',
    async (scope) => {
      tokens(scope, false);
      await expect(completeCalendarConnection(ports, await connection())).rejects.toThrow();
      expect(saved).toEqual([]);
    },
  );

  it('does not exchange codes when the callback belongs to a different login', async () => {
    tokens();
    await expect(
      completeCalendarConnection(ports, { ...(await connection()), sessionScope: 'attacker' }),
    ).rejects.toThrow();
    expect(OAuth2Client.prototype.getToken).not.toHaveBeenCalled();
  });
});
