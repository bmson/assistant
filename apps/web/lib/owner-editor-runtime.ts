import {
  applyOwnerEditorCommand,
  type OwnerEditorDomainPort,
} from '@assistant/application/owner-editor';
import {
  createOwnerEditorDomain,
  createPostgresOwnerEditorDomain,
  type PreparedOwnerEditor,
} from '@assistant/application/owner-editor-domain';
import {
  loadConfig,
  parseFirestoreEmbeddingSpace,
  validateAgentPersistenceConfig,
} from '@assistant/config';
import {
  createFirestoreOwnerEditorDomainStorage,
  createFirestoreOwnerEditorOperationRepository,
} from '@assistant/firestore';
import { isAuthed } from '@/auth';
import { createOwnerEditorHttpHandlers } from './owner-editor-http';
import {
  assertPostgresInstallationOwner,
  createPostgresOwnerEditorOperationRepository,
  getDb,
  getFirestoreInstallationStore,
  getRouter,
} from './server';

export type OwnerEditorApiPath =
  | '/api/people/editor'
  | '/api/profile/knowledge/family'
  | '/api/profile/knowledge/memory';

/** Domain construction is deferred until AFTER durable reservation, including router access. */
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

/** Direct adapters retain maintenance fences even when invoked without the proxy. */
export async function handleOwnerEditorRequest(
  request: Request,
  path: OwnerEditorApiPath,
): Promise<Response> {
  const config = loadConfig();
  if (
    config.ASSISTANT_RELEASE_WRITES_PAUSED ||
    config.RESTORE_REHEARSAL ||
    (request.method === 'POST' &&
      config.PERSISTENCE_DRIVER !== 'firestore' &&
      config.POSTGRES_SOURCE_WRITES_FENCED)
  )
    return Response.json(
      { error: 'The editor is temporarily unavailable.' },
      {
        status: 503,
        headers: { 'cache-control': 'no-store', 'retry-after': '5' },
      },
    );
  const handlers = createOwnerEditorHttpHandlers(path, {
    authenticate: async () => {
      const session = await isAuthed();
      return session ? { formSessionScope: session.formSessionScope ?? '' } : null;
    },
    origin: config.AUTH_URL,
    secret: config.AUTH_SECRET,
    resolveOwnerId: async () => {
      if (config.PERSISTENCE_DRIVER !== 'firestore')
        return assertPostgresInstallationOwner(getDb());
      const problems = validateAgentPersistenceConfig(config);
      if (problems.length) throw new Error('Editor persistence is unavailable');
      return config.FIRESTORE_AGENT_ID;
    },
    async withBackend(scope, run) {
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
          apply: (request, currentScope) =>
            applyOwnerEditorCommand({ request, scope: currentScope, operations, domain }),
        });
      }
      const db = getDb();
      const operations = createPostgresOwnerEditorOperationRepository(db);
      const domain = lazyDomain(() => createPostgresOwnerEditorDomain({ db, router: getRouter() }));
      return run({
        operations,
        apply: (request, currentScope) =>
          applyOwnerEditorCommand({ request, scope: currentScope, operations, domain }),
      });
    },
  });
  return request.method === 'POST' ? handlers.POST(request) : handlers.GET(request);
}
