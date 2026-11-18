import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { isAuthed } from '@/auth';
import {
  assertPostgresInstallationOwner,
  getDb,
  getEstimatedCostApprovalService,
} from '@/lib/server';
import { isMobileAuthed } from '@/mobile-auth';
import { handleEstimatedCostHttp } from './estimated-cost-http';

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
    service: getEstimatedCostApprovalService,
  });
}
