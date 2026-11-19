import { type Config, loadConfig } from '@assistant/config';
import type { AgentReadinessSource } from '@assistant/persistence';

const metadataIdentityUrl =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

function cloudRunAudience(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.run.app') ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('AGENT_URL must be the HTTPS Cloud Run service URI');
  return url.origin;
}

/**
 * Cloud Run's own metadata server mints an ID token for the web service account.
 * The token audience is the agent service URI, not the /ready request path.
 */
export function createCloudRunAgentReadinessSource(
  config: Pick<Config, 'AGENT_URL' | 'FIRESTORE_AGENT_ID'>,
  fetcher: typeof fetch = fetch,
  candidateTag?: string,
  releaseProbe = false,
): AgentReadinessSource {
  return {
    async read(agentId) {
      if (!agentId || agentId !== config.FIRESTORE_AGENT_ID)
        throw new Error('Agent readiness owner does not match the installation');
      const audience = cloudRunAudience(config.AGENT_URL);
      const destination = new URL(audience);
      if (candidateTag !== undefined) {
        if (
          !/^candidate-[1-9][0-9]{0,19}-1$/.test(candidateTag) ||
          !/^assistant-agent-[a-z0-9]+-uw\.a\.run\.app$/.test(destination.hostname)
        )
          throw new Error('Staged agent readiness target is unavailable');
        destination.hostname = `${candidateTag}---${destination.hostname}`;
      }
      const metadataUrl = new URL(metadataIdentityUrl);
      metadataUrl.searchParams.set('audience', audience);
      const identity = await fetcher(metadataUrl, {
        method: 'GET',
        headers: { 'Metadata-Flavor': 'Google' },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (!identity.ok) throw new Error('Cloud Run identity token unavailable');
      const token = (await identity.text()).trim();
      if (token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
        throw new Error('Cloud Run identity token is malformed');

      const readiness = await fetcher(
        new URL(releaseProbe ? '/ready?release=probe' : '/ready', destination),
        {
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!readiness.ok) throw new Error(`Agent readiness returned ${readiness.status}`);
      return readiness.json();
    },
  };
}

/** Composition point for the customer-owned Firestore runtime. */
export function getAgentReadinessSource(): AgentReadinessSource {
  return createCloudRunAgentReadinessSource(loadConfig());
}
