import { describe, expect, it } from 'vitest';
import {
  assertBasic5ReceiptSequence,
  BASIC5_AUTH_COOKIE_NAME,
  BASIC5_BROWSER_ACTIONS,
  BASIC5_EMBEDDING_DIMENSIONS,
  BASIC5_READINESS_ATTEMPT_LIMIT,
  basic5BrowserLaunchOptions,
  basic5EmbeddingResponse,
  basic5IsolatedWebEnvironment,
  createBasic5AuthCookie,
  decodeBasic5AuthCookie,
  nextBasic5ReadinessAttempt,
} from './basic5-browser-acceptance-support.js';

const secret = 'basic5-offline-auth-cookie-secret-32-bytes';

describe('BASIC5 browser acceptance support', () => {
  it('pins CI to the installed Chrome channel without changing local launch defaults', () => {
    expect(basic5BrowserLaunchOptions(true)).toEqual({ headless: true, channel: 'chrome' });
    expect(basic5BrowserLaunchOptions(false)).toEqual({ headless: true });
  });

  it('bounds standalone readiness attempts independently of browser request limits', () => {
    expect(BASIC5_READINESS_ATTEMPT_LIMIT).toBe(451);
    expect(nextBasic5ReadinessAttempt(0)).toBe(1);
    expect(nextBasic5ReadinessAttempt(BASIC5_READINESS_ATTEMPT_LIMIT - 1)).toBe(
      BASIC5_READINESS_ATTEMPT_LIMIT,
    );
    expect(() => nextBasic5ReadinessAttempt(BASIC5_READINESS_ATTEMPT_LIMIT)).toThrow(
      'BASIC5 readiness attempt limit exceeded',
    );
    expect(() => nextBasic5ReadinessAttempt(-1)).toThrow('BASIC5 readiness attempt limit exceeded');
  });

  it('issues a bounded Auth.js cookie that the actual Auth.js JWT decoder accepts', async () => {
    const cookie = await createBasic5AuthCookie({
      email: 'owner@example.test',
      subject: '11111111-1111-4111-8111-111111111111',
      formSessionScope: 'basic5_fixture_session_scope',
      secret,
    });
    expect(cookie.name).toBe(BASIC5_AUTH_COOKIE_NAME);
    expect(cookie.value.length).toBeLessThan(3_936);
    await expect(decodeBasic5AuthCookie(cookie, secret)).resolves.toMatchObject({
      email: 'owner@example.test',
      sub: '11111111-1111-4111-8111-111111111111',
      assistantFormSessionScope: 'basic5_fixture_session_scope',
    });
  });

  it('rejects malformed synthetic claims and undersized signing secrets', async () => {
    await expect(
      createBasic5AuthCookie({
        email: 'not-an-email',
        subject: 'owner',
        formSessionScope: 'short',
        secret,
      }),
    ).rejects.toThrow('Invalid synthetic Auth.js session claims');
    await expect(
      createBasic5AuthCookie({
        email: 'owner@example.test',
        subject: 'owner',
        formSessionScope: 'basic5_fixture_session_scope',
        secret: 'too-short',
      }),
    ).rejects.toThrow('at least 32 bytes');
  });

  it('empties known provider credentials before Next can load dotenv files', () => {
    const env = basic5IsolatedWebEnvironment({
      source: {
        PATH: '/usr/bin',
        OPENROUTER_API_KEY: 'ambient-real-key',
        AUTH_GOOGLE_SECRET: 'ambient-real-secret',
        GOOGLE_OAUTH_CLIENT_SECRET: 'ambient-oauth-secret',
        BOT_GOOGLE_REFRESH_TOKEN: 'ambient-refresh-token',
        TWILIO_AUTH_TOKEN: 'ambient-twilio-token',
        GITHUB_TOKEN: 'ambient-github-token',
        MOBILE_API_TOKEN: 'ambient-mobile-token',
        AWS_SECRET_ACCESS_KEY: 'ambient-aws-secret',
        OWNER_NAME: 'Fixture Owner',
      },
      databaseUrl: 'postgres://assistant:assistant@127.0.0.1:55432/assistant_fixture_test',
      targetToken: '0123456789abcdef01234567',
      ownerEmail: 'owner@example.test',
      ownerName: 'Synthetic Test Owner',
      authSecret: secret,
      emptyHome: '/tmp/basic5-empty-home',
      authUrl: 'http://127.0.0.1:3107',
      embeddingBaseUrl: 'http://127.0.0.1:3108/v1',
      denyEgressPreloader: '/repo/scripts/deny-test-egress.mjs',
    });
    for (const key of [
      'OPENROUTER_API_KEY',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'BOT_GOOGLE_REFRESH_TOKEN',
      'TWILIO_AUTH_TOKEN',
      'GITHUB_TOKEN',
      'MOBILE_API_TOKEN',
    ])
      expect(env[key]).toBe('');
    expect(env.AUTH_SECRET).toBe(secret);
    expect(env.AUTH_GOOGLE_SECRET).toBe('synthetic-auth-cookie-only-secret');
    expect(env.AUTH_DEV_BYPASS).toBe('false');
    expect(env.OWNER_AUTH_MODE).toBe('google');
    expect(env.DATABASE_URL).toBe(env.TEST_DATABASE_URL);
    expect(env.ASSISTANT_TEST_TARGET_TOKEN).toBe('0123456789abcdef01234567');
    expect(env.ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS).toBe('1');
    expect(env.NODE_OPTIONS).toContain('--import=/repo/scripts/deny-test-egress.mjs');
    expect(env.OWNER_NAME).toBe('Synthetic Test Owner');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/tmp/basic5-empty-home');
    expect(env.NODE_ENV).toBe('production');
    expect(env.LLM_PROVIDER).toBe('vertex');
    expect(env.OWNER_NAME).toBe('Synthetic Test Owner');
    expect(env.ASSISTANT_NAME).toBe('Synthetic Test Owner');
    expect(env.ASSISTANT_EMAIL).toBe('owner@example.test');
    expect(env.OWNER_PHONE).toBe('');
  });

  it('returns bounded deterministic OpenAI-compatible vectors without echoing note text', () => {
    const reply = basic5EmbeddingResponse({ input: ['private note', 'private relation'] });
    expect(reply.data).toHaveLength(2);
    expect(reply.data[0]?.embedding).toHaveLength(BASIC5_EMBEDDING_DIMENSIONS);
    expect(reply.data[0]?.embedding[0]).toBe(1);
    expect(reply.data[0]?.embedding.slice(1).every((value) => value === 0)).toBe(true);
    expect(JSON.stringify(reply)).not.toContain('private');
    expect(() => basic5EmbeddingResponse({ input: [] })).toThrow('out of bounds');
    expect(() => basic5EmbeddingResponse({ input: Array(101).fill('x') })).toThrow('out of bounds');
  });

  it('requires exactly four distinct saved receipts in the approved command order', () => {
    const posts = BASIC5_BROWSER_ACTIONS.map((command, index) => ({
      command,
      operationId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      authority: 'operation_receipt',
      outcome: 'saved',
    }));
    expect(() => assertBasic5ReceiptSequence(posts)).not.toThrow();
    expect(() => assertBasic5ReceiptSequence(posts.slice(0, 3))).toThrow('four distinct');
    const duplicateOperation = posts.map((post, index) => ({
      ...post,
      operationId: index === 3 ? (posts[0]?.operationId ?? 'missing') : post.operationId,
    }));
    expect(() => assertBasic5ReceiptSequence(duplicateOperation)).toThrow('four distinct');
  });
});
