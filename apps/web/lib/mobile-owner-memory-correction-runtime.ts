import {
  applyOwnerEditorCommand,
  type OwnerEditorDomainPort,
} from '@assistant/application/owner-editor';
import {
  createOwnerEditorDomain,
  createPostgresOwnerEditorDomain,
  type PreparedOwnerEditor,
} from '@assistant/application/owner-editor-domain';
import { loadConfig, parseFirestoreEmbeddingSpace } from '@assistant/config';
import {
  createFirestoreOwnerEditorDomainStorage,
  createFirestoreOwnerEditorOperationRepository,
} from '@assistant/firestore';
import type { OwnerEditorScope } from '@assistant/persistence/owner-editor';
import { authenticateMobileBearer, resolveMobileOwner } from '@/mobile-auth';
import type { MobileOwnerMemoryCorrectionBackend } from './mobile-owner-memory-correction';
import { createMobileOwnerMemoryCorrectionHandlers } from './mobile-owner-memory-correction';
import {
  createPostgresOwnerEditorOperationRepository,
  getDb,
  getFirestoreInstallationStore,
  getRouter,
  loadOwnerMemoryCorrectionAuthorizationState,
} from './server';

export type MobileOwnerMemoryCorrectionAction = 'authorize' | 'apply' | 'status';

function lazyDomain(
  factory: () => Promise<OwnerEditorDomainPort<PreparedOwnerEditor>>,
): OwnerEditorDomainPort<PreparedOwnerEditor> {
  let pending: Promise<OwnerEditorDomainPort<PreparedOwnerEditor>> | undefined;
  const get = () => (pending ??= factory());
  return {
    prepare: async (request, scope) => (await get()).prepare(request, scope),
    commit: async (claim, prepared, now) => (await get()).commit(claim, prepared, now),
  };
}

function unavailable(status = 503): Response {
  return Response.json(
    { code: 'memory_unavailable' },
    {
      status,
      headers: { 'cache-control': 'no-store', ...(status === 503 ? { 'retry-after': '5' } : {}) },
    },
  );
}

/** Direct mobile routes retain the existing release/restore/source-write fences. */
export async function handleMobileOwnerMemoryCorrectionRequest(
  request: Request,
  action: MobileOwnerMemoryCorrectionAction,
  params: { memoryId: string; operationId?: string },
): Promise<Response> {
  const config = loadConfig();
  if (config.ASSISTANT_RELEASE_WRITES_PAUSED || config.RESTORE_REHEARSAL) return unavailable();
  const postgresWriteFenced =
    config.PERSISTENCE_DRIVER !== 'firestore' && config.POSTGRES_SOURCE_WRITES_FENCED;
  if (action !== 'status' && postgresWriteFenced) return unavailable();

  const handlers = createMobileOwnerMemoryCorrectionHandlers({
    authenticate: authenticateMobileBearer,
    resolveOwner: resolveMobileOwner,
    readAuthorizationState: loadOwnerMemoryCorrectionAuthorizationState,
    secret: () => config.AUTH_SECRET,
    now: Date.now,
    canReconcile: () => !postgresWriteFenced,
    async withBackend<T>(
      scope: OwnerEditorScope,
      run: (backend: MobileOwnerMemoryCorrectionBackend) => Promise<T>,
    ) {
      if (config.PERSISTENCE_DRIVER === 'firestore') {
        const store = getFirestoreInstallationStore();
        const operations = createFirestoreOwnerEditorOperationRepository(store, scope.ownerId);
        const domain = lazyDomain(async () =>
          createOwnerEditorDomain({
            storage: createFirestoreOwnerEditorDomainStorage(
              store,
              scope.ownerId,
              parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE),
            ),
            router: getRouter(),
          }),
        );
        return run({
          operations,
          apply: (applyRequest, currentScope) =>
            applyOwnerEditorCommand({
              request: applyRequest,
              scope: currentScope,
              operations,
              domain,
            }),
        });
      }

      const db = getDb();
      const operations = createPostgresOwnerEditorOperationRepository(db);
      const domain = lazyDomain(() => createPostgresOwnerEditorDomain({ db, router: getRouter() }));
      return run({
        operations,
        apply: (applyRequest, currentScope) =>
          applyOwnerEditorCommand({
            request: applyRequest,
            scope: currentScope,
            operations,
            domain,
          }),
      });
    },
  });

  if (action === 'authorize') return handlers.authorize(request, params.memoryId);
  if (action === 'apply') return handlers.apply(request, params.memoryId, params.operationId ?? '');
  return handlers.status(request, params.memoryId, params.operationId ?? '');
}
