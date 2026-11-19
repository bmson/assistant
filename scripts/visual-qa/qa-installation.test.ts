import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resetConfigForTest } from '@assistant/config';
import { type BrowserContext, type Route, request } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../apps/web/app/api/health/route.js';
import { mobileSmokeRequest } from '../mobile-smoke-server.js';
import {
  assertQaWebInstallation,
  openQaInstallation,
  requireQaOrigin,
  restrictQaBrowserContext,
} from './qa-installation.js';

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

async function startFixtureServer(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  return `http://127.0.0.1:${address.port}`;
}

it('refuses a caller-supplied owner-like loopback listener before any request', async () => {
  const ownerRequest = vi.fn();
  const owner = createServer((_request, response) => {
    ownerRequest();
    response.end('synthetic owner installation');
  });
  const origin = await startFixtureServer(owner);
  try {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('../mobile-smoke.ts', import.meta.url))],
      {
        env: { ...process.env, SMOKE_BASE_URL: origin },
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 10_000,
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const [code] = await once(child, 'close');
    expect(code).toBe(1);
    expect(stderr).toContain('Mobile smoke launches its own disposable server');
    expect(ownerRequest).not.toHaveBeenCalled();
  } finally {
    owner.close();
  }
});

it('keeps actual Playwright mutation probes on the owned origin without following redirects', async () => {
  const otherRequest = vi.fn();
  const other = createServer((_request, response) => {
    otherRequest();
    response.end();
  });
  const otherOrigin = await startFixtureServer(other);
  const ownedRequest = vi.fn();
  const owned = createServer((incoming, response) => {
    ownedRequest(incoming.method, incoming.url);
    response.writeHead(307, { Location: otherOrigin }).end();
  });
  const origin = await startFixtureServer(owned);
  const context = await request.newContext();
  try {
    const probe = mobileSmokeRequest(context, origin);
    expect(() => probe(otherOrigin, { method: 'POST' })).toThrow(/left its private origin/);
    const response = await probe('/fixture', { method: 'POST', maxRedirects: 5 });
    expect(response.status()).toBe(307);
    expect(ownedRequest).toHaveBeenCalledExactlyOnceWith('POST', '/fixture');
    expect(otherRequest).not.toHaveBeenCalled();
  } finally {
    await context.dispose();
    owned.close();
    other.close();
  }
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

it('blocks even a same-origin redirect before a browser can follow the chain', async () => {
  const base = 'http://127.0.0.1:3107';
  const registerRoute =
    vi.fn<(pattern: string, handler: (route: Route) => Promise<void>) => void>();
  await restrictQaBrowserContext(
    { route: registerRoute, routeWebSocket: vi.fn() } as unknown as BrowserContext,
    base,
  );
  const handler = registerRoute.mock.calls[0][1];
  const response = {
    status: () => 302,
    headers: () => ({ location: '/second-hop' }),
    dispose: vi.fn(),
  };
  const route = {
    request: () => ({ url: () => `${base}/first-hop`, method: () => 'GET' }),
    fetch: vi.fn(async () => response),
    abort: vi.fn(),
    fulfill: vi.fn(),
  };
  await handler(route as unknown as Route);
  expect(route.fetch).toHaveBeenCalledWith({ maxRedirects: 0 });
  expect(route.abort).toHaveBeenCalledOnce();
  expect(route.fulfill).not.toHaveBeenCalled();
  expect(response.dispose).toHaveBeenCalledOnce();
});
