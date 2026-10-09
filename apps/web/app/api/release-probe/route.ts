import { loadConfig } from '@assistant/config';
import { createCloudRunAgentReadinessSource } from '@/lib/agent-readiness-source';
import { getCapabilityDiagnostics } from '@/lib/capabilities';

export const dynamic = 'force-dynamic';

/**
 * Secret-safe release canary: this follows the selected storage composition's
 * actual web-to-agent readiness path. It returns no
 * provider names, configuration values, or diagnostic details.
 */
export async function GET(): Promise<Response> {
  let ready = false;
  let writesPaused = true;
  try {
    const config = loadConfig();
    writesPaused = config.ASSISTANT_RELEASE_WRITES_PAUSED;
    if (config.PERSISTENCE_DRIVER === 'firestore') {
      const agent = await createCloudRunAgentReadinessSource(config).read(
        config.FIRESTORE_AGENT_ID,
      );
      ready =
        typeof agent === 'object' && agent !== null && 'ready' in agent && agent.ready === true;
    } else {
      const capabilities = await getCapabilityDiagnostics();
      ready = capabilities.statusAvailable;
    }
  } catch {
    ready = false;
  }
  return Response.json(
    { ready, apiContract: 1, writesPaused },
    { status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
