import { isModuleEnabled, loadConfig } from '@assistant/config';
import {
  getAgent,
  LocationPingSchema,
  locationPingFresh,
  recordLocationPing,
  verifyLocationSignature,
} from '@assistant/core';
import { maybeEnqueueArrivalNudge } from '@assistant/core/proactive/arrival';
import type { ModuleWebhookRequest } from '@assistant/modules';
import { validateTwilioSignature } from '@assistant/tools';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { recordCanaryBrowserResult } from '../canaries.js';
import {
  agentServices,
  buildDeps,
  composedModuleMetas,
  firestoreMaintenanceReady,
} from '../deps.js';
import { verifyGoogleServiceAccountToken } from '../google-oidc.js';

/**
 * External ingress. Every route authenticates its caller before anything else:
 * Pub/Sub push → Google-signed OIDC JWT; Twilio → X-Twilio-Signature (Phase 4).
 */
export const webhooks = new Hono();

// These routes are internet-facing. Reject oversized bodies while they are
// streaming, before JSON/form parsing can become a memory-denial vector.
webhooks.use(
  '*',
  bodyLimit({
    maxSize: 512 * 1024,
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  }),
);

/**
 * Owner location ping (Phase 15). Authenticated by an HMAC-SHA256 signature
 * (hex, `X-Signature` header) over the exact raw body, keyed by the shared
 * LOCATION_PING_SECRET the owner's Shortcut holds. An unsigned or forged ping
 * is rejected 403; ingest is off entirely when no secret is configured.
 */
webhooks.post('/location', async (c) => {
  const config = loadConfig();
  if (!config.LOCATION_PING_SECRET) return c.json({ error: 'location ingest disabled' }, 404);
  const raw = await c.req.text();
  if (!verifyLocationSignature(config.LOCATION_PING_SECRET, raw, c.req.header('x-signature'))) {
    return c.json({ error: 'invalid signature' }, 403);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const parsed = LocationPingSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid ping' }, 400);
  // The signature has no expiry of its own; a stale capturedAt is the replay
  // signal. 409 (not 403) so the Shortcut can tell clock skew from a bad key.
  if (!locationPingFresh(parsed.data)) return c.json({ error: 'stale ping' }, 409);

  const deps = buildDeps();
  if (deps.config.PERSISTENCE_DRIVER === 'firestore' && !(await firestoreMaintenanceReady(deps))) {
    return c.json({ error: 'Firestore installation is not operationally ready' }, 503);
  }
  const agent = await getAgent(deps.db);
  const observation = await recordLocationPing(deps.db, agent.id, parsed.data);
  if (parsed.data.arrivalOptIn) {
    await maybeEnqueueArrivalNudge(deps.db, agent, {
      observationId: observation.id,
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      accuracyM: parsed.data.accuracyM,
      capturedAt: new Date(parsed.data.capturedAt ?? Date.now()),
    }).catch((err) => console.error('location: arrival hook failed', err));
  }
  return c.json({ ok: true });
});

/** Dedicated one-shot callback for browser canaries; no task/workflow state is exposed. */
webhooks.post('/canaries/browser', async (c) => {
  if (!isModuleEnabled(loadConfig(), 'browser')) {
    return c.json({ error: 'browser module disabled' }, 404);
  }
  const body = await c.req
    .json<{ taskId?: string; token?: string; result?: unknown }>()
    .catch(() => null);
  if (
    !body?.taskId ||
    !body.token ||
    !body.result ||
    typeof body.result !== 'object' ||
    Array.isArray(body.result)
  ) {
    return c.json({ error: 'bad request' }, 400);
  }
  const deps = buildDeps();
  if (deps.config.PERSISTENCE_DRIVER === 'firestore' && !(await firestoreMaintenanceReady(deps))) {
    return c.json({ error: 'Firestore installation is not operationally ready' }, 503);
  }
  const outcome = await recordCanaryBrowserResult(deps.db, {
    runId: body.taskId,
    token: body.token,
    result: body.result as Record<string, unknown>,
  });
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json({ ok: true, duplicate: outcome.duplicate });
});

/**
 * Module-declared webhooks. Mounting is static (Hono routes register at import
 * time), so declarations come from the composed metas; the enabled-guard and
 * auth run per request, and the handler is looked up from the installed set —
 * a module the configuration disables answers 404 without its code running.
 * Auth precedes the handler always: the closed union in the meta is what a
 * module CAN declare, and the mounter is the only place that applies it.
 */
for (const meta of composedModuleMetas) {
  for (const route of meta.webhooks ?? []) {
    webhooks.post(route.path, async (c) => {
      const config = loadConfig();
      if (!isModuleEnabled(config, meta.name)) {
        return c.json({ error: `${meta.name} module disabled` }, 404);
      }

      let form: Record<string, string> | undefined;
      if (route.auth.kind === 'googleOidc') {
        const authorization = c.req.header('authorization');
        if (!authorization) return c.json({ error: 'missing token' }, 401);
        const verified = await verifyGoogleServiceAccountToken(authorization, {
          audience: `${config.PUBLIC_URL}/webhooks${route.path}`,
          serviceAccount: String(config[route.auth.serviceAccountKey] ?? ''),
        });
        if (!verified) return c.json({ error: 'invalid token' }, 403);
      } else if (route.auth.kind === 'twilioSignature') {
        // A missing auth token returns the SAME 403 as a bad signature, not a
        // distinguishable 501: an unauthenticated caller must not be able to
        // probe whether TWILIO_AUTH_TOKEN is configured. The operator learns of
        // the missing token from `pnpm config:check` / /ready, not from here.
        const parsed = await c.req.parseBody();
        form = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string') form[key] = value;
        }
        const valid =
          Boolean(config.TWILIO_AUTH_TOKEN) &&
          validateTwilioSignature({
            authToken: config.TWILIO_AUTH_TOKEN,
            url: `${config.PUBLIC_URL}/webhooks${route.path}`,
            params: form,
            signature: c.req.header('x-twilio-signature') ?? '',
          });
        if (!valid) return c.text('invalid signature', 403);
      }
      // 'oneShotToken' routes authenticate inside the handler: the per-launch
      // token in the body is the credential, exactly as the hardcoded routes did.

      const deps = buildDeps();
      if (
        deps.config.PERSISTENCE_DRIVER === 'firestore' &&
        !(await firestoreMaintenanceReady(deps))
      ) {
        return c.json({ error: 'Firestore installation is not operationally ready' }, 503);
      }
      const handler = deps.modules.webhookHandler(route.path);
      if (!handler) return c.json({ error: `${meta.name} module disabled` }, 404);
      const request: ModuleWebhookRequest = {
        json: async <T>() => (await c.req.json().catch(() => null)) as T | null,
        form: async () => form ?? {},
        header: (name) => c.req.header(name),
      };
      const response = await handler(agentServices(deps), request);
      if ('json' in response) {
        return c.json(response.json as object, response.status as ContentfulStatusCode);
      }
      return c.text(
        response.text,
        response.status as ContentfulStatusCode,
        response.contentType ? { 'content-type': response.contentType } : undefined,
      );
    });
  }
}
