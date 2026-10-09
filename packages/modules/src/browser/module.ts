import { jobCallbackIdempotencyKey, planBrowse, recordBrowserJobResult } from '@assistant/core';
import {
  type BrowserJobLauncher,
  CloudRunJobLauncher,
  LocalProcessLauncher,
  registerBrowserTools,
} from '@assistant/tools/browser';
import { defineModule } from '../platform.js';
import { browserMeta } from './meta.js';

export const browserModule = defineModule<BrowserJobLauncher | undefined>({
  meta: browserMeta,
  create: ({ config, registry, router, repoRoot, workspacePrefix, workspaceRoot }) => {
    const launcher =
      config.BROWSER_DRIVER === 'cloudrun'
        ? new CloudRunJobLauncher({
            project: config.GCP_PROJECT,
            location: config.GCP_LOCATION,
            jobName: config.BROWSER_JOB_NAME,
            storage: {
              driver: 'gcs',
              bucket: config.WORKSPACE_BUCKET,
              prefix: workspacePrefix,
              ...(config.TRACES_BUCKET
                ? {
                    tracesBucket: config.TRACES_BUCKET,
                    tracesPrefix: config.ASSISTANT_WORKSPACE_ID,
                  }
                : {}),
            },
          })
        : new LocalProcessLauncher({
            repoRoot,
            workspaceRoot,
            profileEncKey: config.PROFILE_ENC_KEY,
          });
    registerBrowserTools(registry, {
      plan: (input) => planBrowse(router, input),
      launcher,
      callbackUrl: `${config.PUBLIC_URL}/webhooks/browser/callback`,
    });
    return {
      exports: launcher,
      hooks: {
        /**
         * Browser-job result callback. Auth is the per-launch one-shot token
         * minted by browser.execute and checkpointed in the task state — the
         * job carries no shared secrets, so a leaked job env can wake exactly
         * one task, once.
         */
        webhooks: [
          {
            path: '/browser/callback',
            handler: async (services, request) => {
              const body = await request.json<{
                taskId?: string;
                token?: string;
                result?: Record<string, unknown>;
              }>();
              if (!body?.taskId || !body?.token)
                return { status: 400, json: { error: 'bad request' } };
              const outcome = await recordBrowserJobResult(services.persistence.executionJobs, {
                taskId: body.taskId,
                token: body.token,
                result: body.result ?? { ok: false, error: 'job reported no result' },
                idempotencyKey: jobCallbackIdempotencyKey('browser', body.taskId, body.token),
              });
              if (!outcome.ok) return { status: outcome.status, json: { error: outcome.error } };
              return { status: 200, json: { ok: true } };
            },
          },
        ],
      },
    };
  },
});
