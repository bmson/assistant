/** Fixed Cloud Run v2 transport. No caller-selected hosts, credentials or retry policy. */
import { type RetirementPlan, WEB_SERVICE } from './owner-web-tag-retirement.js';

const ROOT = 'https://run.googleapis.com/v2/';
const OPERATION =
  /^projects\/bmson-assistant\/locations\/us-west1\/operations\/[A-Za-z0-9_-]{1,128}$/;
const LIMIT = 2 * 1024 * 1024;
type JsonObject = Record<string, unknown>;
export type RetainedTargetPolicy = 'tagged' | 'canonical-untagged';
function record(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid native response');
  return value as JsonObject;
}
export function operationName(value: unknown): string {
  const name = record(value).name;
  if (typeof name !== 'string' || !OPERATION.test(name))
    throw new Error('Untrusted native operation');
  return name;
}
/** Dependencies are injected by source/tests only; production CLI supplies fixed fetch and clock. */
export function nativeRetirementClient(
  token: string,
  request: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = Date.now,
  retainedTarget: RetainedTargetPolicy = 'tagged',
) {
  if (!/^[A-Za-z0-9._~-]{1,16384}$/.test(token)) throw new Error('Invalid native credential');
  if (!['tagged', 'canonical-untagged'].includes(retainedTarget))
    throw new Error('Invalid native retained-target policy');
  let calls = 0;
  async function json(
    path: string,
    body?: NonNullable<RetirementPlan['patch']>,
    deadline?: number,
  ) {
    if (++calls > 100) throw new Error('Native request bound exceeded');
    const remaining = deadline === undefined ? 15_000 : Math.min(15_000, deadline - now());
    if (remaining <= 0) throw new Error('Native operation deadline exceeded');
    let response: Response;
    try {
      response = await request(`${ROOT}${path}`, {
        method: body ? 'PATCH' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(remaining),
      });
    } catch {
      // Never expose request headers, provider response content or token-bearing exceptions.
      throw new Error(body ? 'Native PATCH outcome uncertain; do not retry' : 'Native read failed');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(body ? 'Native PATCH rejected; do not retry' : 'Native read rejected');
    }
    let stream: ReadableStreamDefaultReader<Uint8Array>;
    try {
      if (!response.body) throw new Error('Missing body');
      stream = response.body.getReader();
    } catch {
      throw new Error('Native response unreadable; do not retry mutation');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await stream.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > LIMIT) throw new Error('Native response bound exceeded');
        chunks.push(part.value);
      }
      return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      await stream.cancel().catch(() => undefined);
      throw new Error('Native response unreadable; do not retry mutation');
    }
  }
  return {
    readService: () => json(WEB_SERVICE),
    readRevision: (name: string) => {
      if (!/^assistant-web-[a-z0-9-]{1,63}$/.test(name))
        throw new Error('Untrusted native revision');
      return json(`${WEB_SERVICE}/revisions/${name}`);
    },
    patchTraffic: (body: NonNullable<RetirementPlan['patch']>) => {
      if (
        body.name !== WEB_SERVICE ||
        typeof body.etag !== 'string' ||
        !/^[ -~]{1,512}$/.test(body.etag) ||
        Object.keys(body).sort().join(',') !== 'etag,name,traffic' ||
        !Array.isArray(body.traffic) ||
        body.traffic.length !== 1
      )
        throw new Error('Invalid native traffic patch');
      // Planner produces the only permissible single retained target; enforce wire shape again.
      const row = record(body.traffic[0]);
      if (
        Object.keys(row).some((k) => !['type', 'revision', 'tag', 'percent'].includes(k)) ||
        row.type !== 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION' ||
        row.percent !== 100 ||
        typeof row.revision !== 'string' ||
        !/^assistant-web-[a-z0-9-]{1,63}$/.test(row.revision) ||
        (retainedTarget === 'canonical-untagged'
          ? row.tag !== undefined
          : typeof row.tag !== 'string' ||
            !/^(candidate|resume)-[0-9]{1,20}-[1-9][0-9]{0,5}$/.test(row.tag))
      )
        throw new Error('Invalid native retained target');
      return json(`${WEB_SERVICE}?updateMask=traffic`, body);
    },
    waitOperation: async (initial: unknown) => {
      const name = operationName(initial);
      let operation = record(initial);
      const deadline = now() + 180_000;
      // No mutation retry. Poll only the validated fixed-region operation, at most180s.
      for (let i = 0; i <= 60; i++) {
        if (operationName(operation) !== name) throw new Error('Native operation changed');
        if (operation.done === true) {
          if (operation.error !== undefined || operation.response === undefined)
            throw new Error('Native operation failed');
          return;
        }
        if (operation.done !== undefined && operation.done !== false)
          throw new Error('Invalid native operation status');
        if (i === 60 || deadline - now() <= 3000)
          throw new Error('Native operation unsettled; do not retry mutation');
        await sleep(3000);
        operation = await json(name, undefined, deadline);
      }
    },
    drain: async (seconds: 600) => {
      if (seconds !== 600) throw new Error('Invalid native drain bound');
      for (let elapsed = 0; elapsed < 600; elapsed += 30) await sleep(30_000);
    },
  };
}
