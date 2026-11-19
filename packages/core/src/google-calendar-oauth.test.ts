import { GOOGLE_CALENDAR_READ_SCOPE } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import {
  googleCalendarOAuthConfig,
  googleCalendarReadFailureReason,
  validGoogleCalendarScopes,
} from './google-calendar-oauth.js';

const config = {
  ASSISTANT_MODULES: ['calendar'] as ['calendar'],
  GOOGLE_OAUTH_CLIENT_ID: 'client',
  GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
  MCP_ENC_KEY: 'a'.repeat(64),
  GOOGLE_CALENDAR_OAUTH_CALLBACK_URL: 'https://example.invalid/api/oauth/google-calendar/callback',
};
describe('Calendar OAuth configuration and scope boundaries', () => {
  it('requires explicit callback, strong encryption and an installed Calendar/Google module', () => {
    expect(googleCalendarOAuthConfig(config)).not.toBeNull();
    expect(googleCalendarOAuthConfig({ ...config, ASSISTANT_MODULES: ['google'] })).not.toBeNull();
    for (const change of [
      { GOOGLE_CALENDAR_OAUTH_CALLBACK_URL: '' },
      {
        GOOGLE_CALENDAR_OAUTH_CALLBACK_URL:
          'http://example.invalid/api/oauth/google-calendar/callback',
      },
      {
        GOOGLE_CALENDAR_OAUTH_CALLBACK_URL:
          'https://example.invalid/api/oauth/google-calendar/callback?returnUrl=x',
      },
      { GOOGLE_CALENDAR_OAUTH_CALLBACK_URL: 'https://example.invalid/other' },
      { MCP_ENC_KEY: 'weak' },
      { ASSISTANT_MODULES: [] },
    ])
      expect(googleCalendarOAuthConfig({ ...config, ...change })).toBeNull();
  });
  it('accepts only identity plus Calendar readonly, including canonical email scope', () => {
    expect(validGoogleCalendarScopes(['openid', 'email', GOOGLE_CALENDAR_READ_SCOPE])).toBe(true);
    expect(
      validGoogleCalendarScopes([
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        GOOGLE_CALENDAR_READ_SCOPE,
      ]),
    ).toBe(true);
    expect(validGoogleCalendarScopes(['openid', 'email'])).toBe(false);
    expect(
      validGoogleCalendarScopes([
        'openid',
        'email',
        GOOGLE_CALENDAR_READ_SCOPE,
        'https://www.googleapis.com/auth/calendar',
      ]),
    ).toBe(false);
    expect(
      validGoogleCalendarScopes([
        'openid',
        'email',
        GOOGLE_CALENDAR_READ_SCOPE,
        'https://www.googleapis.com/auth/gmail.readonly',
      ]),
    ).toBe(false);
  });
});

describe('Calendar permission failures', () => {
  it('distinguishes Google RPC scope errors from quota and individual resource ACL failures', () => {
    expect(
      googleCalendarReadFailureReason(403, {
        error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] },
      }),
    ).toBe('missing_scope');
    expect(
      googleCalendarReadFailureReason(403, {
        error: { errors: [{ reason: 'userRateLimitExceeded' }] },
      }),
    ).toBe('provider_unavailable');
    expect(
      googleCalendarReadFailureReason(403, { error: { errors: [{ reason: 'forbidden' }] } }),
    ).toBeNull();
    expect(googleCalendarReadFailureReason(403, 'provider body')).toBeNull();
  });
});

describe('optional Calendar dashboard-client fallback', () => {
  const fallback = {
    ...config,
    GOOGLE_OAUTH_CLIENT_ID: '',
    GOOGLE_OAUTH_CLIENT_SECRET: '',
    AUTH_GOOGLE_ID: 'dashboard-client',
    AUTH_GOOGLE_SECRET: 'dashboard-secret',
  };
  it('uses only a complete pair, preferring explicit Workspace credentials', () => {
    expect(googleCalendarOAuthConfig(fallback)).toEqual({
      clientId: 'dashboard-client',
      clientSecret: 'dashboard-secret',
      callbackUrl: config.GOOGLE_CALENDAR_OAUTH_CALLBACK_URL,
    });
    expect(
      googleCalendarOAuthConfig({ ...fallback, GOOGLE_OAUTH_CLIENT_ID: 'half-workspace' }),
    ).toMatchObject({ clientId: 'dashboard-client', clientSecret: 'dashboard-secret' });
    expect(
      googleCalendarOAuthConfig({
        ...fallback,
        GOOGLE_OAUTH_CLIENT_SECRET: 'half-workspace-secret',
      }),
    ).toMatchObject({ clientId: 'dashboard-client', clientSecret: 'dashboard-secret' });
    expect(
      googleCalendarOAuthConfig({
        ...fallback,
        GOOGLE_OAUTH_CLIENT_ID: 'explicit-client',
        GOOGLE_OAUTH_CLIENT_SECRET: 'explicit-secret',
      }),
    ).toMatchObject({ clientId: 'explicit-client', clientSecret: 'explicit-secret' });
    expect(
      googleCalendarOAuthConfig({
        ...fallback,
        AUTH_GOOGLE_ID: '',
        GOOGLE_OAUTH_CLIENT_ID: 'half-workspace',
      }),
    ).toBeNull();
    expect(
      googleCalendarOAuthConfig({
        ...fallback,
        AUTH_GOOGLE_SECRET: '',
        GOOGLE_OAUTH_CLIENT_SECRET: 'half-workspace-secret',
      }),
    ).toBeNull();
    expect(
      googleCalendarOAuthConfig({ ...fallback, AUTH_GOOGLE_ID: '', AUTH_GOOGLE_SECRET: '' }),
    ).toBeNull();
  });
  it('keeps the explicit callback, module and encryption gates with dashboard credentials', () => {
    for (const change of [
      { GOOGLE_CALENDAR_OAUTH_CALLBACK_URL: '' },
      {
        GOOGLE_CALENDAR_OAUTH_CALLBACK_URL:
          'http://example.invalid/api/oauth/google-calendar/callback',
      },
      {
        GOOGLE_CALENDAR_OAUTH_CALLBACK_URL:
          'https://example.invalid/api/oauth/google-calendar/callback?returnUrl=x',
      },
      { GOOGLE_CALENDAR_OAUTH_CALLBACK_URL: 'https://example.invalid/other' },
      { ASSISTANT_MODULES: [] },
      { MCP_ENC_KEY: '' },
      { MCP_ENC_KEY: 'weak' },
    ])
      expect(googleCalendarOAuthConfig({ ...fallback, ...change })).toBeNull();
  });
});
