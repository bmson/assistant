import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import type { EstimatedCostOverviewResponse } from '@assistant/persistence';
import {
  assertPostgresInstallationOwner,
  getDb,
  getEstimatedCostApprovalService,
} from '@/lib/server';

/** Called only by owner-authenticated pages; failure stays unavailable, never empty. */
export async function getOwnerEstimatedCostOverview(): Promise<EstimatedCostOverviewResponse | null> {
  try {
    const config = loadConfig();
    if (!config.ASSISTANT_WORKSPACE_ID) return null;
    const ownerId =
      config.PERSISTENCE_DRIVER === 'firestore'
        ? validateAgentPersistenceConfig(config).length
          ? null
          : config.FIRESTORE_AGENT_ID
        : await assertPostgresInstallationOwner(getDb());
    if (!ownerId) return null;
    const service = getEstimatedCostApprovalService();
    return (
      (await service.getOverview?.({ installationId: config.ASSISTANT_WORKSPACE_ID, ownerId })) ??
      null
    );
  } catch {
    return null;
  }
}
