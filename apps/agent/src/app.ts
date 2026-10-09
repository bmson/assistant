import { loadConfig } from '@assistant/config';
import { assertPostgresInstallationOwner } from '@assistant/db';
import { assertFirestoreInstallationOwner } from '@assistant/firestore';
import { moduleDiagnostics } from '@assistant/modules/meta';
import { Hono } from 'hono';
import { buildDeps, firestoreMaintenanceReady } from './deps.js';
import { api } from './routes/api.js';
import { internal } from './routes/internal.js';
import { webhooks } from './routes/webhooks.js';

export function createApp() {
  const app = new Hono();

  if (loadConfig().RESTORE_REHEARSAL) {
    // The rehearsal exposes only health/readiness. Restored tasks, callbacks,
    // provider probes, and application APIs cannot be dispatched by request.
    app.use('*', async (c, next) => {
      if (
        (c.req.path === '/health' || c.req.path === '/ready') &&
        (c.req.method === 'GET' || c.req.method === 'HEAD')
      )
        return next();
      return c.json({ error: 'runtime endpoint disabled during restore rehearsal' }, 503);
    });
  }

  app.get('/health', (c) => c.json({ ok: true, service: 'agent' }));
  app.get('/ready', async (c) => {
    const deps = buildDeps();
    try {
      if (deps.firestoreStore) {
        await assertFirestoreInstallationOwner(deps.firestoreStore, deps.config.FIRESTORE_AGENT_ID);
        if (!(await firestoreMaintenanceReady(deps)))
          throw new Error('configured Firestore installation is not operationally ready');
      } else {
        await assertPostgresInstallationOwner(deps.db);
      }
      return c.json({
        ready: true,
        database: deps.firestoreStore ? 'firestore' : 'postgres',
        modules: moduleDiagnostics(deps.config),
      });
    } catch {
      return c.json({ ready: false, database: 'unavailable' }, 503);
    }
  });

  app.route('/webhooks', webhooks);
  app.route('/internal', internal);
  app.route('/api', api);

  /*
   * Hono's default handler console.errors a bare Error and returns 500, which
   * reaches Cloud Logging as an unattributed stack: you can see that something
   * threw, but not what was being served. Chasing 500s on /internal/tasks/execute
   * meant correlating stack traces against request logs by timestamp. Name the
   * route on the way out; the response body is unchanged.
   */
  app.onError((err, c) => {
    console.error(
      `unhandled error: ${c.req.method} ${new URL(c.req.url).pathname}`,
      err instanceof Error ? err.stack : err,
    );
    return c.text('Internal Server Error', 500);
  });

  return app;
}
