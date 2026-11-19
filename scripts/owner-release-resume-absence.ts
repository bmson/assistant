import { estimatedCostMetadataUrl } from './estimated-cost-release-native-read.js';
import { type BootstrapReceipt, RUN_ROOT, SERVICE_ROOT } from './owner-release-current-snapshot.js';

const roles = ['agent', 'web'] as const;
const sourcePattern = /^[a-f0-9]{40}$/;
const runPattern = /^[1-9][0-9]{0,19}$/;
const tokenPattern = /^[A-Za-z0-9._~-]{20,8192}$/;
const requestTimeoutMs = 15_000;

function requireAbsence(value: unknown): asserts value {
  if (!value) throw new Error('Exact resume revision absence is unverified');
}

/** A successor detached from canonical routes still blocks pre-admission restoration. */
export async function assertResumeRevisionsAbsent(
  current: BootstrapReceipt,
  runId: string,
  token: string,
  deadline: number,
  request: typeof fetch = fetch,
): Promise<void> {
  const controller = new AbortController();
  try {
    requireAbsence(
      current.kind === 'disabled-bootstrap' &&
        sourcePattern.test(current.source) &&
        runPattern.test(runId) &&
        tokenPattern.test(token) &&
        Number.isSafeInteger(deadline),
    );
    const urls = roles.map((role) => {
      const service = current.services[role].service;
      requireAbsence(service === `${SERVICE_ROOT}${role}`);
      const name = `assistant-${role}-r-${runId}-1-${current.source.slice(0, 8)}`;
      return estimatedCostMetadataUrl(`${RUN_ROOT}${service}/revisions/${name}`);
    });
    const remaining = deadline - Date.now();
    requireAbsence(remaining > 0);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.min(remaining, requestTimeoutMs)),
    ]);
    await Promise.all(
      urls.map(async (url) => {
        const response = await request(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          redirect: 'error',
          cache: 'no-store',
          signal,
        });
        void response.body?.cancel().catch(() => undefined);
        requireAbsence(
          response.status === 404 &&
            response.url === url &&
            !response.redirected &&
            response.type !== 'opaqueredirect' &&
            !signal.aborted &&
            Date.now() < deadline,
        );
      }),
    );
  } catch {
    // A transport error is never proof, and can carry private request details.
    throw new Error('Exact resume revision absence is unverified');
  } finally {
    controller.abort();
  }
}
