import { jobCallbackIdempotencyKey, recordCodeJobResult } from '@assistant/core';
import {
  CloudRunCodeJobLauncher,
  type CodeJobLauncher,
  LocalCodeProcessLauncher,
  registerCodeTools,
} from '@assistant/tools/code';
import { defineModule } from '../platform.js';
import { codeMeta } from './meta.js';

export const codeModule = defineModule<CodeJobLauncher>({
  meta: codeMeta,
  create: ({ config, registry, repoRoot, workspacePrefix, workspaceRoot }) => {
    const launcher: CodeJobLauncher =
      config.CODE_DRIVER === 'cloudrun'
        ? new CloudRunCodeJobLauncher({
            project: config.GCP_PROJECT,
            location: config.GCP_LOCATION,
            jobName: config.CODE_JOB_NAME,
            storage: {
              driver: 'gcs',
              bucket: config.WORKSPACE_BUCKET,
              prefix: workspacePrefix,
            },
          })
        : new LocalCodeProcessLauncher({ repoRoot, workspaceRoot });
    registerCodeTools(registry, {
      launcher,
      callbackUrl: `${config.PUBLIC_URL}/webhooks/code/callback`,
      isolated: config.CODE_DRIVER === 'cloudrun',
    });
    return {
      exports: launcher,
      hooks: {
        /**
         * Code-job result callback. Same one-shot-token auth as the browser
         * callback: the per-launch token minted by code.execute and
         * checkpointed in the task state is the only credential the
         * credential-free job carries.
         */
        webhooks: [
          {
            path: '/code/callback',
            handler: async (services, request) => {
              const body = await request.json<{
                taskId?: string;
                token?: string;
                result?: Record<string, unknown>;
              }>();
              if (!body?.taskId || !body?.token)
                return { status: 400, json: { error: 'bad request' } };
              const outcome = await recordCodeJobResult(services.persistence.executionJobs, {
                taskId: body.taskId,
                token: body.token,
                result: body.result ?? { ok: false, error: 'job reported no result' },
                idempotencyKey: jobCallbackIdempotencyKey('code', body.taskId, body.token),
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
