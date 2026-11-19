import { resetConfigForTest } from '@assistant/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../apps/web/app/api/health/route.js';
import { assertQaWebInstallation, openQaInstallation, requireQaOrigin } from './qa-installation.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetConfigForTest();
});

describe('dedicated QA origin', () => {
  const origin = 'http://127.0.0.1:3107';

  it('uses only the explicitly configured loopback origin', () => {
    expect(requireQaOrigin(undefined, origin)).toBe(origin);
    expect(requireQaOrigin(origin, origin)).toBe(origin);
    expect(() => requireQaOrigin('http://127.0.0.1:3000', origin)).toThrow(/does not match/);
    expect(() => requireQaOrigin(origin, undefined)).toThrow(/dedicated local QA server/);
  });

  it.each([
    'https://assistant.example',
    'http://localhost:3107',
    'http://secret@example.test:3107',
    'http://127.0.0.1:3107/private',
    'http://127.0.0.1:3107?token=secret',
    'http://127.1:3107',
    'http://127.0.0.1',
  ])('refuses an origin outside the exact loopback contract (%s)', (value) => {
    expect(() => requireQaOrigin(undefined, value)).toThrow(/literal loopback HTTP origin/);
  });
});

describe('web installation proof', () => {
  it('accepts the server only when its allocator target matches the harness', async () => {
    const target = {
      databaseUrl: 'postgres://assistant@127.0.0.1:5432/assistant_0123456789abcdef01234567_test',
      databaseName: 'assistant_0123456789abcdef01234567_test',
      token: '0123456789abcdef01234567',
      kind: 'standard' as const,
    };
    const origin = 'http://127.0.0.1:3107';
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AUTH_DEV_BYPASS', 'true');
    vi.stubEnv('AUTH_URL', origin);
    vi.stubEnv('ASSISTANT_TEST_TARGET_TOKEN', target.token);
    vi.stubEnv('DATABASE_URL', target.databaseUrl);
    vi.stubEnv('TEST_DATABASE_URL', target.databaseUrl);
    vi.stubEnv('PERSISTENCE_DRIVER', 'postgres');
    vi.stubEnv('RESTORE_REHEARSAL', 'false');
    resetConfigForTest();
    vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => {
      const headers = new Headers(options.headers);
      headers.set('host', url.host);
      return GET(new Request(`http://localhost:${url.port}${url.pathname}`, { headers }));
    });

    await expect(assertQaWebInstallation(origin, target)).resolves.toBeUndefined();
    await expect(assertQaWebInstallation('http://127.0.0.1:3108', target)).rejects.toThrow(
      /did not prove/,
    );
    await expect(
      assertQaWebInstallation(origin, {
        ...target,
        databaseUrl: `${target.databaseUrl}?sslmode=disable`,
      }),
    ).rejects.toThrow(/did not prove/);

    vi.stubEnv('NODE_ENV', 'production');
    await expect(assertQaWebInstallation(origin, target)).rejects.toThrow(/did not prove/);
  });
});

it.each(['host=localhost', 'port=5432', 'options=fixture'])(
  'rejects database routing or session overrides before verifying a marker (%s)',
  async (query) => {
    await expect(
      openQaInstallation({ DATABASE_URL: `postgres://127.0.0.1/assistant_test?${query}` }),
    ).rejects.toThrow(/cannot override/);
  },
);
