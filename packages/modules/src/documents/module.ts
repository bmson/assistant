import {
  CloudRunDocumentJobLauncher,
  type DocumentProcessorConfig,
  hashCallbackToken,
  LocalDocumentProcessLauncher,
  recordDocumentProcessorResult,
} from '@assistant/core';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import { registerDocumentTools } from '@assistant/tools/documents';
import { defineModule, type ModuleHooks } from '../platform.js';
import { documentsMeta } from './meta.js';

export const documentsModule = defineModule<DocumentProcessorConfig | undefined>({
  meta: documentsMeta,
  create: ({ config, registry, repoRoot, router, workspacePrefix, workspaceRoot, persistence }) => {
    registerDocumentTools(registry, {
      embed: async (texts) => {
        const space = await router.embeddingSpace();
        return {
          embeddings: await router.embed(texts, { expectedSpace: space }),
          embeddingSpaceKey: embeddingSpaceIdentityKey(space),
        };
      },
      ...(persistence.documentSearch ? { search: persistence.documentSearch } : {}),
    });

    const hooks: ModuleHooks = {
      /**
       * Document-processor result callback. Same one-shot-token auth as the
       * code/browser callbacks, but keyed on the document row rather than a
       * task: the per-launch token minted by the processor sweep and
       * checkpointed on the `documents` row is the only credential the
       * credential-free worker carries.
       */
      webhooks: [
        {
          path: '/document/callback',
          handler: async (services, request) => {
            const body = await request.json<{
              documentId?: string;
              token?: string;
              result?: { ok?: boolean; kind?: string; chars?: number; error?: string };
            }>();
            if (!body?.documentId || !body?.token) {
              return { status: 400, json: { error: 'bad request' } };
            }
            const r = body.result;
            const processor = services.persistence.documentProcessor;
            if (!processor)
              return {
                status: 503,
                json: { error: 'document processor persistence is unavailable' },
              };
            const outcome = await recordDocumentProcessorResult(
              { processor, tasks: services.persistence.tasks },
              {
                documentId: body.documentId,
                token: body.token,
                result: r
                  ? { ok: r.ok === true, kind: r.kind, chars: r.chars, error: r.error }
                  : { ok: false, error: 'job reported no result' },
              },
            );
            if (!outcome.ok && outcome.status === 410 && outcome.cleanupPath) {
              try {
                await services.workspace.delete(outcome.cleanupPath);
                await processor.resolveDeletedCallback({
                  documentId: body.documentId,
                  tokenMatches: (stored) => stored === hashCallbackToken(body.token as string),
                  processedTextPath: outcome.cleanupPath,
                });
              } catch {
                // Keep the tombstone and outbox so a replay can retry cleanup.
                return { status: 503, json: { error: 'deleted document cleanup is pending' } };
              }
              return { status: 200, json: { ok: true, deleted: true } };
            }
            if (!outcome.ok) return { status: outcome.status, json: { error: outcome.error } };
            return { status: 200, json: { ok: true } };
          },
        },
      ],
    };

    const callbackUrl = `${config.PUBLIC_URL}/webhooks/document/callback`;
    if (config.PROCESSOR_DRIVER === 'cloudrun') {
      return {
        exports: {
          launcher: new CloudRunDocumentJobLauncher({
            project: config.GCP_PROJECT,
            location: config.GCP_LOCATION,
            jobName: config.PROCESSOR_JOB_NAME,
            storage: {
              driver: 'gcs',
              bucket: config.WORKSPACE_BUCKET,
              prefix: workspacePrefix,
            },
          }),
          callbackUrl,
        },
        hooks,
      };
    }
    if (config.QUEUE_DRIVER === 'local') {
      return {
        exports: {
          launcher: new LocalDocumentProcessLauncher({ repoRoot, workspaceRoot }),
          callbackUrl,
        },
        hooks,
      };
    }
    // A cloud installation without a processor job has nowhere to run
    // extraction; document tools stay registered but produce no launches.
    // The callback still answers: a worker launched before a driver change
    // must be able to report its result.
    return { hooks };
  },
});
