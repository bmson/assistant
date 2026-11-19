import { loadConfig } from '@assistant/config';
import { createCloudRunAgentReadinessSource } from '@/lib/agent-readiness-source';
import { getCapabilityDiagnostics } from '@/lib/capabilities';

export const dynamic = 'force-dynamic';

/**
 * Secret-safe release canary: this follows the selected storage composition's
 * actual web-to-agent readiness path. It returns no
 * provider names, configuration values, or diagnostic details.
 */
export async function GET(request: Request): Promise<Response> {
  let ready = false;
  let writesPaused = true;
  try {
    const config = loadConfig();
    writesPaused = config.ASSISTANT_RELEASE_WRITES_PAUSED;
    const peer = new URL(request.url).searchParams.get('peer');
    const staged = peer === 'staged';
    let candidateTag: string | undefined;
    let expectedRelease:
      | {
          service: string;
          revision: string;
          source: string;
          manifest: string;
          writesPaused: boolean;
          mcpOAuthEnabled: boolean;
        }
      | undefined;
    if (staged || peer === 'canonical') {
      const run = process.env.ASSISTANT_RELEASE_WORKFLOW_RUN_ID;
      const source = process.env.ASSISTANT_RELEASE_SOURCE_SHA;
      const manifest = process.env.ASSISTANT_RELEASE_MANIFEST;
      if (
        !writesPaused ||
        config.MCP_OAUTH_ENABLED !== false ||
        config.PERSISTENCE_DRIVER !== 'firestore' ||
        process.env.ASSISTANT_RELEASE_API_CONTRACT !== '3' ||
        process.env.ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT !== '1' ||
        !run ||
        !/^[1-9][0-9]{0,19}$/.test(run) ||
        !source ||
        !/^[a-f0-9]{40}$/.test(source) ||
        !manifest ||
        !/^[a-f0-9]{64}$/.test(manifest)
      )
        throw new Error('Bound peer probe is unavailable');
      if (staged) candidateTag = `candidate-${run}-1`;
      expectedRelease = {
        service: 'assistant-agent',
        revision: `assistant-agent-${staged ? 'p' : 'r'}-${run}-1-${source.slice(0, 8)}`,
        source,
        manifest,
        writesPaused: staged,
        mcpOAuthEnabled: false,
      };
    }
    if (config.PERSISTENCE_DRIVER === 'firestore') {
      const agent = await createCloudRunAgentReadinessSource(
        config,
        undefined,
        candidateTag,
        expectedRelease !== undefined,
      ).read(config.FIRESTORE_AGENT_ID);
      ready =
        typeof agent === 'object' && agent !== null && 'ready' in agent && agent.ready === true;
      if (ready && expectedRelease) {
        const release = (agent as { release?: unknown }).release;
        ready =
          typeof release === 'object' &&
          release !== null &&
          Object.entries(expectedRelease).every(
            ([key, value]) => (release as Record<string, unknown>)[key] === value,
          );
      }
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
