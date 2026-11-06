import { loadConfig, resetConfigForTest } from '@assistant/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

const admission = vi.hoisted(() => vi.fn());
const ownerReady = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@assistant/db', () => ({ assertPostgresInstallationOwner: ownerReady }));
vi.mock('@assistant/firestore', () => ({ assertFirestoreInstallationOwner: vi.fn() }));
vi.mock('@assistant/modules/meta', () => ({ moduleDiagnostics: () => ({}) }));
vi.mock('./deps.js', () => ({
  buildDeps: () => ({ db: {}, config: {} }),
  firestoreMaintenanceReady: vi.fn(),
}));
vi.mock('./routes/api.js', async () => {
  const { Hono } = await import('hono');
  return {
    api: new Hono().all('*', (c) => {
      admission();
      return c.json({ accepted: true });
    }),
  };
});
vi.mock('./routes/internal.js', async () => {
  const { Hono } = await import('hono');
  return {
    internal: new Hono().all('*', (c) => {
      admission();
      return c.json({ accepted: true });
    }),
  };
});
vi.mock('./routes/webhooks.js', async () => {
  const { Hono } = await import('hono');
  return {
    webhooks: new Hono().all('*', (c) => {
      admission();
      return c.json({ accepted: true });
    }),
  };
});
const { createApp } = await import('./app.js');

afterEach(() => {
  resetConfigForTest();
  loadConfig(process.env);
  vi.clearAllMocks();
});

describe('agent release pause admission', () => {
  it('rejects new work before runtime handlers, including GET and probe POSTs', async () => {
    resetConfigForTest();
    loadConfig({ NODE_ENV: 'test', ASSISTANT_RELEASE_WRITES_PAUSED: 'true' });
    const app = createApp();
    for (const [path, method] of [
      ['/internal/tasks/execute', 'POST'],
      ['/internal/sweep', 'POST'],
      ['/webhooks/gmail/pubsub', 'POST'],
      ['/webhooks/twilio/sms', 'POST'],
      ['/api/mobile/v1/profile', 'GET'],
      ['/health', 'POST'],
      ['/ready', 'POST'],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ code: 'updating' });
    }
    expect(admission).not.toHaveBeenCalled();
  });

  it('preserves GET/HEAD health and real readiness evaluation while paused', async () => {
    resetConfigForTest();
    loadConfig({ NODE_ENV: 'test', ASSISTANT_RELEASE_WRITES_PAUSED: 'true' });
    const app = createApp();
    for (const path of ['/health', '/ready']) {
      for (const method of ['GET', 'HEAD']) {
        expect((await app.request(path, { method })).status).toBe(200);
      }
    }
    expect(ownerReady).toHaveBeenCalledTimes(2);
    ownerReady.mockRejectedValueOnce(new Error('not ready'));
    const unavailable = await app.request('/ready');
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ ready: false, database: 'unavailable' });
  });

  it('retains runtime admission when release pause is false', async () => {
    resetConfigForTest();
    loadConfig({ NODE_ENV: 'test', ASSISTANT_RELEASE_WRITES_PAUSED: 'false' });
    const app = createApp();
    for (const path of ['/api/mobile/v1/profile', '/internal/sweep', '/webhooks/gmail/pubsub']) {
      expect((await app.request(path, { method: 'POST' })).status).toBe(200);
    }
    expect(admission).toHaveBeenCalledTimes(3);
  });
});
