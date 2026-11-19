/** Fixed production metadata GETs only. This transport cannot read secret
 * payloads, query billing, change delivery, or dispatch provider requests. */
import { boundedResponseJson } from './owner-web-release-operator-hold.js';

const root = 'projects/bmson-assistant/locations/us-west1';
const tokenPattern = /^[A-Za-z0-9._~-]{20,8192}$/;
export function estimatedCostMetadataUrl(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.href !== input
  )
    throw new Error('Estimated cost metadata target held');
  const paths: Record<string, RegExp> = {
    'run.googleapis.com': new RegExp(
      `^/v2/${root}/(?:services/assistant-(?:web|agent)(?:/revisions/assistant-(?:web|agent)-[a-z0-9-]{1,63})?|jobs/assistant-(?:browser|code|processor)(?:/executions)?)$`,
    ),
    'cloudtasks.googleapis.com': new RegExp(`^/v2/${root}/queues/agent-steps(?:/tasks)?$`),
    'cloudscheduler.googleapis.com': new RegExp(
      `^/v1/${root}/jobs/assistant-(?:sweep|gmail-sync|gmail-watch)$`,
    ),
    'pubsub.googleapis.com': /^\/v1\/projects\/bmson-assistant\/subscriptions\/gmail-events-push$/,
    'secretmanager.googleapis.com':
      /^\/v1\/projects\/bmson-assistant\/secrets\/[A-Za-z0-9_-]{1,255}\/versions\/[1-9][0-9]*$/,
    'cloudresourcemanager.googleapis.com': /^\/v3\/projects\/bmson-assistant$/,
  };
  if (!paths[url.hostname]?.test(url.pathname))
    throw new Error('Estimated cost metadata target held');
  const paginated = url.pathname.endsWith('/tasks') || url.pathname.endsWith('/executions');
  if (url.search && !paginated) throw new Error('Estimated cost metadata query held');
  for (const [key, value] of url.searchParams) {
    if (url.searchParams.getAll(key).length !== 1)
      throw new Error('Estimated cost metadata query held');
    if (key === 'pageSize' && value === '100') continue;
    if (key === 'responseView' && value === 'BASIC' && url.pathname.endsWith('/tasks')) continue;
    if (
      key === 'pageToken' &&
      value.length > 0 &&
      value.length <= 2048 &&
      !Array.from(value).some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      continue;
    throw new Error('Estimated cost metadata query held');
  }
  return url.href;
}

export function estimatedCostMetadataRead(
  token: string,
  deadline: number,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): (url: string) => Promise<unknown> {
  if (!tokenPattern.test(token)) throw new Error('Estimated cost credential held');
  let requests = 0;
  let bytes = 0;
  return async (input) => {
    const url = estimatedCostMetadataUrl(input);
    const remaining = deadline - now();
    if (remaining <= 0 || ++requests > 256) throw new Error('Estimated cost metadata bound');
    const timeout = Math.min(15000, remaining);
    const response = await fetcher(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('Estimated cost metadata read unavailable');
    }
    const value = await boundedResponseJson(response, 2 * 1024 * 1024, timeout);
    bytes += Buffer.byteLength(JSON.stringify(value));
    if (now() >= deadline || bytes > 32 * 1024 * 1024)
      throw new Error('Estimated cost metadata bound');
    return value;
  };
}
