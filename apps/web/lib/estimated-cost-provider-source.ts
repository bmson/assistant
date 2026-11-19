import { type Config, estimatedCostApprovalEnabled } from '@assistant/config';
import { parseEstimatedCostRuntimeProviderSource } from '@assistant/persistence';

/** A configured manifest grants no authority unless it names this exact image. */
export function estimatedCostProviderSource(config: Config, buildSha: string | undefined) {
  if (!estimatedCostApprovalEnabled(config)) return undefined;
  return parseEstimatedCostRuntimeProviderSource(config.ESTIMATED_COST_PROVIDER_SOURCE_JSON, {
    installationId: config.ASSISTANT_WORKSPACE_ID,
    projectId: config.GCP_PROJECT,
    sourceRelease: buildSha,
  });
}
