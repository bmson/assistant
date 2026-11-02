import type {
  OwnerEditorRecoveryStorage,
  OwnerEditorRecoveryStorageOptions,
  OwnerEditorSessionView,
} from '@assistant/persistence';
import { z } from 'zod';
import { handleOwnerEditorRecoveryRequest } from './owner-editor-recovery-service';
import { ownerEditorSessionDigest } from './owner-editor-scope';

const runtimeSchema = z.strictObject({
  driver: z.enum(['postgres', 'firestore']),
  origin: z.string(),
  secret: z.string(),
  releaseWritesPaused: z.boolean(),
  restoreRehearsal: z.boolean(),
  postgresSourceWritesFenced: z.boolean(),
});
type RuntimeConfig = z.infer<typeof runtimeSchema>;
export interface OwnerEditorRecoveryRuntimeDependencies {
  config(): unknown;
  authenticate(request: Request): Promise<Pick<OwnerEditorSessionView, 'formSessionScope'> | null>;
  resolveOwner(driver: RuntimeConfig['driver']): Promise<string>;
  storage(
    driver: RuntimeConfig['driver'],
    options: OwnerEditorRecoveryStorageOptions,
  ): Promise<OwnerEditorRecoveryStorage>;
  now?: () => number;
}

const actual: OwnerEditorRecoveryRuntimeDependencies = {
  config() {
    // This retains existing cached configuration semantics; it is not a global
    // pause observation or a new release coordination mechanism.
    const config = requireConfig();
    return {
      driver: config.PERSISTENCE_DRIVER,
      origin: config.AUTH_URL,
      secret: config.AUTH_SECRET,
      releaseWritesPaused: config.ASSISTANT_RELEASE_WRITES_PAUSED,
      restoreRehearsal: config.RESTORE_REHEARSAL,
      postgresSourceWritesFenced: config.POSTGRES_SOURCE_WRITES_FENCED,
    };
  },
  async authenticate(_request) {
    const { isAuthed } = await import('@/auth');
    const session = await isAuthed();
    return session ? { formSessionScope: session.formSessionScope ?? '' } : null;
  },
  async resolveOwner(driver) {
    const server = await import('./server');
    if (driver === 'postgres') return server.assertPostgresInstallationOwner(server.getDb());
    const { validateAgentPersistenceConfig } = await import('@assistant/config');
    const config = requireConfig();
    if (validateAgentPersistenceConfig(config).length)
      throw new Error('Recovery owner unavailable');
    return config.FIRESTORE_AGENT_ID;
  },
  async storage(driver, options) {
    const server = await import('./server');
    if (driver === 'postgres') {
      const { createPostgresOwnerEditorRecoveryStorage } = await import('@assistant/db');
      return createPostgresOwnerEditorRecoveryStorage(server.getDb(), options);
    }
    const { createFirestoreOwnerEditorRecoveryStorage } = await import('@assistant/firestore');
    return createFirestoreOwnerEditorRecoveryStorage(
      server.getFirestoreInstallationStore(),
      options,
    );
  },
};

// Pure config loading has no provider or database construction.
import { loadConfig as requireConfig } from '@assistant/config';

/**
 * Unmounted composition seam. The mode is a server-owned qualification argument,
 * defaults off, and is never read from request data or registered as capability.
 * Native storage and real browser authentication remain separate proof gates.
 */
export async function handleDormantOwnerEditorRecoveryRequest(
  request: Request,
  options: { mode?: 'off' | 'lookup' | 'authorize' } = {},
  dependencies: OwnerEditorRecoveryRuntimeDependencies = actual,
): Promise<Response> {
  const mode = options.mode ?? 'off';
  if (mode === 'off') return Response.json({ error: 'Not found.' }, { status: 404 });
  if (mode !== 'lookup' && mode !== 'authorize')
    return Response.json({ error: 'Recovery unavailable.' }, { status: 503 });
  if (mode === 'lookup' && request.method !== 'GET')
    return Response.json({ error: 'Recovery authorization unavailable.' }, { status: 403 });
  try {
    const config = runtimeSchema.parse(dependencies.config());
    let ownerId: string | undefined;
    async function authenticate(): Promise<OwnerEditorSessionView | null> {
      const session = await dependencies.authenticate(request);
      if (!session) return null;
      // Resolve only after authentication, outside the leased storage callback.
      // Storage independently validates durable singleton owner identity.
      ownerId ??= await dependencies.resolveOwner(config.driver);
      return { ownerId, formSessionScope: session.formSessionScope };
    }
    const readMaintenance = async () => {
      const current = runtimeSchema.parse(dependencies.config());
      if (
        current.driver !== config.driver ||
        current.origin !== config.origin ||
        current.secret !== config.secret
      )
        throw new Error('Recovery runtime changed');
      return {
        driver: current.driver,
        releaseWritesPaused: current.releaseWritesPaused,
        restoreRehearsal: current.restoreRehearsal,
        postgresSourceWritesFenced: current.postgresSourceWritesFenced,
      };
    };
    const storageOptions: OwnerEditorRecoveryStorageOptions = {
      readMaintenance,
      async authorize(scope, expectedSession) {
        const session = await authenticate();
        return Boolean(
          session &&
            session.ownerId === scope.ownerId &&
            ownerEditorSessionDigest(session) === scope.sessionDigest &&
            (!expectedSession ||
              (session.ownerId === expectedSession.ownerId &&
                session.formSessionScope === expectedSession.formSessionScope)),
        );
      },
      now: dependencies.now ? () => new Date(dependencies.now?.() ?? Number.NaN) : undefined,
    };
    return await handleOwnerEditorRecoveryRequest(request, {
      authenticate,
      readMaintenance,
      origin: config.origin,
      secret: config.secret,
      now: dependencies.now,
      async withRecoveryTransaction(scope, run) {
        const storage = await dependencies.storage(config.driver, storageOptions);
        return storage.withRecoveryTransaction(scope, run);
      },
    });
  } catch {
    return Response.json({ error: 'Recovery unavailable.' }, { status: 503 });
  }
}
