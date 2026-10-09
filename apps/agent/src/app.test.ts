import { loadConfig, resetConfigForTest } from '@assistant/config';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('agent app', () => {
  it('rejects malformed queue generations before building executor dependencies', async () => {
    resetConfigForTest();
    loadConfig({
      ...process.env,
      INTERNAL_AUTH_MODE: 'shared-secret',
      INTERNAL_API_SECRET: 'test-secret',
    });
    try {
      const app = createApp();
      for (const body of [
        null,
        [],
        { taskId: 2 },
        { taskId: 'task', generation: -1 },
        { taskId: 'task', generation: '1' },
        { taskId: 'task', generation: 0.1 },
      ]) {
        const result = await app.request('/internal/tasks/execute', {
          method: 'POST',
          headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(result.status).toBe(400);
      }
    } finally {
      resetConfigForTest();
      loadConfig(process.env);
    }
  });
  it('responds to /health', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'agent' });
  });

  it('keeps due task, reminder, approval, and callback ingress inert in restore rehearsal', async () => {
    resetConfigForTest();
    loadConfig({
      NODE_ENV: 'test',
      RESTORE_REHEARSAL: 'true',
      QUEUE_DRIVER: 'inert',
      PERSISTENCE_DRIVER: 'postgres',
      POSTGRES_SOURCE_WRITES_FENCED: 'true',
    });
    try {
      const app = createApp();
      const pendingWorkKinds = [
        ['/internal/tasks/execute', { taskId: 'due-task', generation: 1 }],
        ['/internal/sweep', {}],
        ['/webhooks/twilio/sms', {}],
        ['/api/mobile/v1/settings/reminders/due-reminder', { action: 'deliver' }],
        ['/api/mobile/v1/approvals/due-approval', { action: 'approve' }],
      ] as const;
      for (const [path, body] of pendingWorkKinds) {
        const result = await app.request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(result.status).toBe(503);
        expect(await result.json()).toEqual({
          error: 'runtime endpoint disabled during restore rehearsal',
        });
      }
      expect((await app.request('/health')).status).toBe(200);
    } finally {
      resetConfigForTest();
      loadConfig(process.env);
    }
  });

  it('rejects an unsigned Twilio webhook with the same 403 as a bad signature', async () => {
    // A missing TWILIO_AUTH_TOKEN must not answer with a distinguishable status
    // (it once returned 501). An unauthenticated caller gets a uniform 403
    // whether the token is unset or the signature is wrong, so the endpoint
    // cannot be used to probe whether Twilio is configured.
    const app = createApp();
    const twilio = await app.request('/webhooks/twilio/sms', { method: 'POST' });
    expect(twilio.status).toBe(403);
  });

  it('keeps disabled module entry points inactive', async () => {
    resetConfigForTest();
    loadConfig({ ASSISTANT_MODULES: 'minimal' });
    try {
      const app = createApp();
      const [gmail, sms, browser] = await Promise.all([
        app.request('/webhooks/gmail/pubsub', { method: 'POST' }),
        app.request('/webhooks/twilio/sms', { method: 'POST' }),
        app.request('/webhooks/browser/callback', { method: 'POST' }),
      ]);
      expect(gmail.status).toBe(404);
      expect(sms.status).toBe(404);
      expect(browser.status).toBe(404);
    } finally {
      resetConfigForTest();
      loadConfig(process.env);
    }
  });

  it('reports a 200 skip from /internal/gmail/sync when sync is off, never a 404', async () => {
    // The every-minute scheduler job must stay green when sync is disabled —
    // by the module being off OR by the sync setting. Both paths must produce
    // the same 200 skip body (meta.whenDisabled and the handler, respectively).
    const auth = { INTERNAL_AUTH_MODE: 'shared-secret', INTERNAL_API_SECRET: 'test-secret' };
    const headers = { authorization: 'Bearer test-secret' };
    try {
      resetConfigForTest();
      loadConfig({ ...process.env, ...auth, ASSISTANT_MODULES: 'minimal' });
      const disabledModule = await createApp().request('/internal/gmail/sync', {
        method: 'POST',
        headers,
      });
      expect(disabledModule.status).toBe(200);
      expect(await disabledModule.json()).toEqual({
        skipped: true,
        reason: 'gmail sync disabled by module or setting',
      });

      resetConfigForTest();
      loadConfig({ ...process.env, ...auth, GMAIL_SYNC_ENABLED: 'false' });
      const disabledSetting = await createApp().request('/internal/gmail/sync', {
        method: 'POST',
        headers,
      });
      expect(disabledSetting.status).toBe(200);
      expect(await disabledSetting.json()).toEqual({
        skipped: true,
        reason: 'gmail sync disabled by module or setting',
      });
    } finally {
      resetConfigForTest();
      loadConfig(process.env);
    }
  });

  it('rejects Pub/Sub pushes without a valid Google OIDC token', async () => {
    const app = createApp();
    const noToken = await app.request('/webhooks/gmail/pubsub', { method: 'POST' });
    expect(noToken.status).toBe(401);
    const badToken = await app.request('/webhooks/gmail/pubsub', {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(badToken.status).toBe(403);
  });

  it('rejects malformed browser canary callbacks before touching persistence', async () => {
    const app = createApp();
    const response = await app.request('/webhooks/canaries/browser', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'not-a-run', token: '', result: {} }),
    });
    expect(response.status).toBe(400);
  });

  it('keeps canary execution and status behind internal authentication', async () => {
    const app = createApp();
    const [run, status, health] = await Promise.all([
      app.request('/internal/canaries/run', { method: 'POST' }),
      app.request('/internal/canaries/status'),
      app.request('/internal/canaries/health'),
    ]);
    expect(run.status).toBe(401);
    expect(status.status).toBe(401);
    expect(health.status).toBe(401);
  });

  it('caps oversized bodies on internal routes before parsing (S8)', async () => {
    const app = createApp();
    const res = await app.request('/internal/tasks/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });
});

describe('unhandled errors', () => {
  it('names the route that threw, and still answers 500', async () => {
    // Hono's default handler logs a bare stack with no route on it, so a 500
    // in production could only be attributed by correlating timestamps against
    // the request log. The body must not change — only the log line.
    const app = createApp();
    app.get('/boom', () => {
      throw new Error('kaboom');
    });
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const res = await app.request('/boom');
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('Internal Server Error');
    } finally {
      console.error = original;
    }
    expect(logged.some((args) => String(args[0]).includes('unhandled error: GET /boom'))).toBe(
      true,
    );
    expect(logged.some((args) => String(args[1]).includes('kaboom'))).toBe(true);
  });
});
