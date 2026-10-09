import { isModuleEnabled, loadConfig } from '@assistant/config';
import { evaluateCanaryHealth } from '@assistant/core';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { latestCanaryRun, runCanaries } from '../canaries.js';
import {
  agentServices,
  buildDeps,
  composedModuleMetas,
  firestoreMaintenanceReady,
} from '../deps.js';
import { oidcAudienceForPath, verifyInternalAuthorization } from '../google-oidc.js';

/**
 * Queue-facing endpoints. Production accepts only a Google-signed ID token
 * from the configured internal invoker service account. Local development can
 * explicitly opt into a shared secret with INTERNAL_AUTH_MODE=shared-secret.
 */
export const internal = new Hono();

// Even though every route requires a valid invoker token, cap body size before
// JSON parsing so a compromised/misbehaving caller cannot make it a memory
// sink. Mirrors the internet-facing webhooks limit.
internal.use(
  '*',
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  }),
);

internal.use('*', async (c, next) => {
  const config = loadConfig();
  const authConfig =
    config.INTERNAL_AUTH_MODE === 'oidc'
      ? {
          ...config,
          INTERNAL_OIDC_AUDIENCE: oidcAudienceForPath(config.INTERNAL_OIDC_AUDIENCE, c.req.path),
        }
      : config;
  if (!(await verifyInternalAuthorization(c.req.header('authorization'), authConfig))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
});

internal.post('/tasks/execute', async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return c.json({ error: 'invalid task delivery' }, 400);
  const { taskId, generation } = body as { taskId?: unknown; generation?: unknown };
  if (typeof taskId !== 'string' || !taskId) return c.json({ error: 'taskId required' }, 400);
  if (
    generation !== undefined &&
    (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0)
  )
    return c.json({ error: 'invalid task generation' }, 400);
  const deps = buildDeps();
  // Cloud Tasks delivers here without the local poller's readiness fence. An
  // imported workspace awaiting activation (or a missing owner) answers 503,
  // so the provider retries later instead of running paused work.
  if (deps.config.PERSISTENCE_DRIVER === 'firestore') {
    const ready = await firestoreMaintenanceReady(deps).catch((err) => {
      console.error('Firestore task readiness check failed', err);
      return false;
    });
    if (!ready) return c.json({ error: 'Firestore installation is not ready for tasks' }, 503);
  }
  const { executeAgentTask } = await import('../task-runner.js');
  const result = await executeAgentTask(deps, taskId, generation as number | undefined);
  return c.json(result);
});

/**
 * Private, task-free provider smoke test for a customer-owned Firestore install.
 * The fixed prompt and hard call limits make this unsuitable as a general
 * inference endpoint. It is hidden unless explicitly enabled for rehearsal.
 */
internal.post('/model-probe/vertex', async (c) => {
  const config = loadConfig();
  if (
    !config.VERTEX_MODEL_PROBE_ENABLED ||
    config.PERSISTENCE_DRIVER !== 'firestore' ||
    config.LLM_PROVIDER !== 'vertex'
  )
    return c.json({ error: 'not found' }, 404);

  // Callers cannot submit a prompt, model, token limit, or other router option.
  if ((await c.req.text()).length > 0) return c.json({ error: 'request body must be empty' }, 400);

  try {
    const deps = buildDeps();
    if (!(await firestoreMaintenanceReady(deps)))
      return c.json({ error: 'Firestore installation is not operationally ready' }, 503);

    const outcome = await deps.router.generate('draft', {
      system: 'This is a bounded internal connectivity probe. Reply with exactly PROBE_OK.',
      prompt: 'Reply with exactly PROBE_OK.',
      temperature: 0,
      maxOutputTokens: 16,
      maxEstimatedCostUsd: 0.005,
      abortSignal: AbortSignal.timeout(8_000),
    });
    if (!outcome.ok) return c.json({ error: 'model probe blocked' }, 503);
    return c.json({
      ok: true,
      matched: outcome.text.trim() === 'PROBE_OK',
      modelId: outcome.modelId,
    });
  } catch {
    // Provider and IAM errors may contain request metadata; keep them in
    // protected service diagnostics, never in this endpoint response.
    console.error('Vertex model probe failed');
    return c.json({ error: 'model probe failed' }, 502);
  }
});

internal.post('/sweep', async (c) => {
  const deps = buildDeps();
  if (deps.config.PERSISTENCE_DRIVER === 'firestore') {
    const { runFirestoreSweep } = await import('../firestore-sweep.js');
    const result = await runFirestoreSweep(deps);
    if (!result.ready) return c.json({ error: result.error }, 503);
    return c.json(result.report);
  }
  const { runPostgresSweep } = await import('../postgres-sweep.js');
  return c.json(await runPostgresSweep(deps, { notifyDueTasks: true }));
});

/**
 * Module-declared internal routes — usually the targets of the modules' own
 * scheduler jobs, so the schedule and the handler live in one declaration.
 * The blanket invoker-auth middleware above applies before any of these run.
 */
for (const meta of composedModuleMetas) {
  for (const route of meta.internalRoutes ?? []) {
    internal.post(route.path, async (c) => {
      if (!isModuleEnabled(loadConfig(), meta.name)) {
        const off = route.whenDisabled ?? {
          status: 404,
          body: { error: `${meta.name} module disabled` },
        };
        return c.json(off.body, off.status as ContentfulStatusCode);
      }
      const deps = buildDeps();
      if (
        deps.config.PERSISTENCE_DRIVER === 'firestore' &&
        !(await firestoreMaintenanceReady(deps))
      ) {
        return c.json({ error: 'Firestore installation is not operationally ready' }, 503);
      }
      const handler = deps.modules.internalHandler(route.path);
      if (!handler) return c.json({ error: `${meta.name} module disabled` }, 404);
      const response = await handler(agentServices(deps));
      if ('json' in response) {
        return c.json(response.json as object, response.status as ContentfulStatusCode);
      }
      return c.text(response.text, response.status as ContentfulStatusCode);
    });
  }
}

internal.post('/canaries/run', async (c) => {
  const config = loadConfig();
  if (!config.CANARY_ENABLED) {
    return c.json({ error: 'canaries are disabled; set CANARY_ENABLED=true explicitly' }, 503);
  }
  const deps = buildDeps();
  if (deps.config.PERSISTENCE_DRIVER === 'firestore' && !(await firestoreMaintenanceReady(deps))) {
    return c.json({ error: 'Firestore installation is not operationally ready' }, 503);
  }
  const result = await runCanaries(deps);
  return c.json(result);
});

internal.get('/canaries/status', async (c) => {
  const deps = buildDeps();
  if (deps.firestoreStore)
    return c.json({ error: 'SQL canaries are unavailable in Firestore agent mode' }, 501);
  const latest = await latestCanaryRun(deps.db);
  return c.json({ latest });
});

/**
 * Which checks in a run actually failed, and what each said.
 *
 * The alert used to carry only the verdict — "The latest canary run failed." —
 * so every red hour began with a database query to learn anything at all. The
 * run row already holds the reason; this puts it in the log line. A skipped
 * check (Twilio unconfigured, say) is not a failure and is left out.
 */
export function failedCanaryChecks(
  latest: { checks?: Record<string, unknown> } | null | undefined,
): {
  failed: string[];
  reasons: Record<string, string>;
} {
  const failed: string[] = [];
  const reasons: Record<string, string> = {};
  for (const [name, value] of Object.entries(latest?.checks ?? {})) {
    if (!value || typeof value !== 'object') continue;
    const check = value as { ok?: unknown; skipped?: unknown; detail?: unknown };
    if (check.ok === true || check.skipped === true) continue;
    failed.push(name);
    if (typeof check.detail === 'string' && check.detail) {
      reasons[name] = check.detail.slice(0, 500);
    }
  }
  return { failed, reasons };
}

internal.on(['GET', 'POST'], '/canaries/health', async (c) => {
  const deps = buildDeps();
  if (deps.firestoreStore)
    return c.json({ error: 'SQL canaries are unavailable in Firestore agent mode' }, 501);
  const latest = await latestCanaryRun(deps.db);
  const health = evaluateCanaryHealth(latest);
  if (!health.ok) {
    const { failed, reasons } = failedCanaryChecks(latest);
    const line = JSON.stringify({
      msg: 'canary_alert',
      state: health.state,
      detail: health.detail,
      runId: latest?.runId,
      ...(latest?.error ? { runError: latest.error.slice(0, 500) } : {}),
      ...(failed.length > 0 ? { failed, reasons } : {}),
    });
    // A run still inside its 10-minute window is not yet news, but it used to
    // be logged NOWHERE while still answering 503 — an alert with no trace.
    if (health.state === 'running') console.warn(line);
    else console.error(line);
  }
  return c.json({ health, latest }, health.ok ? 200 : 503);
});
