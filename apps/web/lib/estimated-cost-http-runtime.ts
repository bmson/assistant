import { createEstimatedCostApprovalService } from '@assistant/application';
import {
  estimatedCostApprovalEnabled,
  loadConfig,
  validateAgentPersistenceConfig,
} from '@assistant/config';
import {
  createPostgresEstimatedCostApprovalRepository,
  createPostgresEstimatedCostQuotePreparer,
} from '@assistant/db';
import {
  createFirestoreEstimatedCostApprovalRepository,
  createFirestoreEstimatedCostQuotePreparer,
} from '@assistant/firestore';
import { isAuthed } from '@/auth';
import {
  assertPostgresInstallationOwner,
  getDb,
  getFirestoreInstallationStore,
} from '@/lib/server';
import { isMobileAuthed } from '@/mobile-auth';
import { handleEstimatedCostHttp } from './estimated-cost-http';

/** The same capability gates preparation and transactional mutation. OFF keeps
 * scoped durable readback and decline available without creating authority. */
function service() {
  const config = loadConfig();
  const enabled = () => estimatedCostApprovalEnabled(config);
  const options = { mutationsEnabled: enabled };
  const firestore = config.PERSISTENCE_DRIVER === 'firestore';
  return createEstimatedCostApprovalService({
    repository: firestore
      ? createFirestoreEstimatedCostApprovalRepository(getFirestoreInstallationStore(), options)
      : createPostgresEstimatedCostApprovalRepository(getDb(), options),
    preparer: firestore
      ? createFirestoreEstimatedCostQuotePreparer(getFirestoreInstallationStore(), options)
      : createPostgresEstimatedCostQuotePreparer(getDb(), options),
    enabled,
  });
}

export function estimatedCostHandler(
  request: Request,
  kind: 'quote' | 'decision',
  mobile: boolean,
): Promise<Response> {
  return handleEstimatedCostHttp(request, kind, {
    authenticate: async (input) => (mobile ? isMobileAuthed(input) : Boolean(await isAuthed())),
    checkOrigin: (input) => {
      if (mobile) return true; // isMobileAuthed applies origin checks to its cookie fallback.
      try {
        const config = loadConfig();
        return input.headers.get('origin') === new URL(config.AUTH_URL || config.PUBLIC_URL).origin;
      } catch {
        return false;
      }
    },
    actor: async () => {
      const config = loadConfig();
      if (!config.ASSISTANT_WORKSPACE_ID) throw new Error('Installation unavailable');
      if (config.PERSISTENCE_DRIVER === 'firestore') {
        if (validateAgentPersistenceConfig(config).length || !config.FIRESTORE_AGENT_ID)
          throw new Error('Owner unavailable');
        return {
          installationId: config.ASSISTANT_WORKSPACE_ID,
          ownerId: config.FIRESTORE_AGENT_ID,
        };
      }
      return {
        installationId: config.ASSISTANT_WORKSPACE_ID,
        ownerId: await assertPostgresInstallationOwner(getDb()),
      };
    },
    service,
  });
}
