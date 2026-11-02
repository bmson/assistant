/** Dedicated fixed TWO-target transport. Never broadens the single-target retirement client. */
import { operationName } from './owner-web-tag-native.js';
import { HISTORICAL_WEB_TAGS, WEB_SERVICE } from './owner-web-tag-retirement.js';
import {
  type TrafficReconciliationIO,
  TrafficReconciliationStop,
} from './owner-web-traffic-reconciliation-model.js';

const ROOT = 'https://run.googleapis.com/v2/';
const LIMIT = 2 * 1024 * 1024;
type Obj = Record<string, unknown>;
export function nativeWebTrafficReconciliationClient(
  token: string,
  request: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  monotonic: () => number = () => performance.now(),
): TrafficReconciliationIO {
  if (!/^[A-Za-z0-9._~-]{1,16384}$/.test(token))
    throw new TrafficReconciliationStop('invalid_metadata');
  const [old, current] = HISTORICAL_WEB_TAGS;
  if (!old || !current) throw new TrafficReconciliationStop('invalid_metadata');
  const revisions = new Set([old.revision, current.revision]);
  let calls = 0,
    operationReads = 0,
    patchUsed = false,
    waitUsed = false,
    last = monotonic();
  let original: unknown, originalName: string | undefined, deadline: number | undefined;
  const fail = (
    reason: 'read_failed' | 'patch_unconfirmed' | 'operation_unconfirmed' | 'invalid_metadata',
  ): never => {
    throw new TrafficReconciliationStop(
      reason,
      patchUsed ? 'may_have_been_attempted' : 'not_attempted',
    );
  };
  const clock = () => {
    const n = monotonic();
    if (!Number.isFinite(n) || !Number.isFinite(last) || n < last)
      fail(patchUsed ? 'operation_unconfirmed' : 'read_failed');
    last = n;
    return n;
  };
  function object(v: unknown): Obj {
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail('invalid_metadata');
    return v as Obj;
  }
  async function bounded<T>(
    parent: AbortSignal,
    milliseconds: number,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (parent.aborted || milliseconds <= 0)
      fail(patchUsed ? 'operation_unconfirmed' : 'read_failed');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => {
        controller.abort();
        reject(
          new TrafficReconciliationStop(
            patchUsed ? 'operation_unconfirmed' : 'read_failed',
            patchUsed ? 'may_have_been_attempted' : 'not_attempted',
          ),
        );
      };
      timer = setTimeout(rejectAbort, milliseconds);
    });
    const cancel = () => rejectAbort?.();
    parent.addEventListener('abort', cancel, { once: true });
    if (parent.aborted) cancel();
    try {
      const result = await Promise.race([work(controller.signal), aborted]);
      if (controller.signal.aborted) fail(patchUsed ? 'operation_unconfirmed' : 'read_failed');
      return result;
    } catch (e) {
      if (e instanceof TrafficReconciliationStop) throw e;
      return fail(patchUsed ? 'operation_unconfirmed' : 'read_failed');
    } finally {
      clearTimeout(timer);
      parent.removeEventListener('abort', cancel);
      controller.abort();
    }
  }
  async function json(path: string, signal: AbortSignal, body?: unknown, end?: number) {
    if (calls >= 100) fail(patchUsed ? 'operation_unconfirmed' : 'read_failed');
    const at = clock();
    const remaining = end === undefined ? 15000 : Math.min(15000, end - at);
    const callEnd = at + remaining;
    return bounded(signal, remaining, async (callSignal) => {
      if (callSignal.aborted) fail(patchUsed ? 'operation_unconfirmed' : 'read_failed');
      calls++;
      const response = await request(`${ROOT}${path}`, {
        method: body === undefined ? 'GET' : 'PATCH',
        redirect: 'error',
        signal: callSignal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (
        response.status !== 200 ||
        !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') ||
        !response.body
      ) {
        try {
          void response.body?.cancel().catch(() => undefined);
        } catch {
          /* No response disclosure. */
        }
        return fail(patchUsed ? 'patch_unconfirmed' : 'read_failed');
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      callSignal.addEventListener('abort', cancel, { once: true });
      try {
        for (;;) {
          if (callSignal.aborted) fail(patchUsed ? 'operation_unconfirmed' : 'read_failed');
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > LIMIT) fail('invalid_metadata');
          chunks.push(part.value);
        }
        const parsed = object(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))),
        );
        if (callSignal.aborted || clock() >= callEnd)
          fail(patchUsed ? 'operation_unconfirmed' : 'read_failed');
        return parsed;
      } finally {
        callSignal.removeEventListener('abort', cancel);
        cancel();
      }
    });
  }
  return {
    readService: (signal) => json(WEB_SERVICE, signal),
    readRevision: (name, signal) => {
      if (!revisions.has(name)) fail('invalid_metadata');
      return json(`${WEB_SERVICE}/revisions/${name}`, signal);
    },
    patchTraffic: async (body, options) => {
      if (
        patchUsed ||
        options.updateMask !== 'traffic' ||
        body.name !== WEB_SERVICE ||
        typeof body.etag !== 'string' ||
        !/^[ -~]{1,512}$/.test(body.etag) ||
        Object.keys(body).sort().join(',') !== 'etag,name,traffic' ||
        !Array.isArray(body.traffic) ||
        body.traffic.length !== 2
      )
        fail('invalid_metadata');
      const wanted = [current, old].map((p, i) => ({
        type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
        revision: p.revision,
        tag: p.tag,
        percent: i === 0 ? 100 : 0,
      }));
      for (let i = 0; i < 2; i++) {
        const row = object(body.traffic[i]),
          expected = wanted[i];
        if (
          !expected ||
          Object.keys(row).sort().join(',') !== 'percent,revision,tag,type' ||
          Object.entries(expected).some(([k, v]) => row[k] !== v)
        )
          fail('invalid_metadata');
      }
      patchUsed = true; // Sticky before the only possible request, including uncertainty/abort.
      original = await json(`${WEB_SERVICE}?updateMask=traffic`, options.signal, body);
      try {
        originalName = operationName(original);
      } catch {
        fail('operation_unconfirmed');
      }
      deadline = clock() + 180000;
      return original;
    },
    waitOperation: async (initial, parent) => {
      const name = originalName,
        end = deadline;
      if (waitUsed || !patchUsed || initial !== original || !name || end === undefined)
        return fail('operation_unconfirmed');
      waitUsed = true;
      await bounded(parent, end - clock(), async (signal) => {
        let operation = object(initial);
        for (;;) {
          if (signal.aborted || clock() >= end) fail('operation_unconfirmed');
          if (operationName(operation) !== name) fail('operation_unconfirmed');
          if (operation.done === true) {
            if (operation.error !== undefined || object(operation.response).name !== WEB_SERVICE)
              fail('operation_unconfirmed');
            return;
          }
          if (
            (operation.done !== undefined && operation.done !== false) ||
            operation.error !== undefined ||
            operationReads >= 60 ||
            end - clock() <= 3000
          )
            fail('operation_unconfirmed');
          await bounded(signal, end - clock(), () => sleep(3000));
          if (signal.aborted || end - clock() <= 0) fail('operation_unconfirmed');
          operationReads++;
          operation = await json(name, signal, undefined, end);
        }
      });
    },
  };
}
