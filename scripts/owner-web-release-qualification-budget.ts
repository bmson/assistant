/** Single shared bounded transport for the future explicitly dispatched READ-ONLY probe. */
export type ProbeKind =
  | 'oidc'
  | 'discovery'
  | 'jwks'
  | 'github'
  | 'blob'
  | 'sts'
  | 'iam'
  | 'native';
export type ReadOnlyRequest = {
  kind: ProbeKind;
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  manualRedirect?: boolean;
};
export class QualificationHold extends Error {
  constructor(
    readonly reason:
      | 'context'
      | 'identity'
      | 'metadata'
      | 'artifact'
      | 'inventory'
      | 'native'
      | 'budget'
      | 'transport'
      | 'quiescence',
  ) {
    super(`Read-only qualification held: ${reason}`);
  }
}
export function qualificationRequire(
  value: unknown,
  reason: QualificationHold['reason'] = 'metadata',
): asserts value {
  if (!value) throw new QualificationHold(reason);
}
export interface QualificationClock {
  now: () => number;
  monotonic: () => number;
}
export function qualificationBudget(
  request: typeof fetch,
  clock: QualificationClock,
  allow: (r: ReadOnlyRequest) => boolean,
) {
  const began = clock.monotonic();
  qualificationRequire(Number.isFinite(began), 'budget');
  let calls = 0,
    nativeGets = 0,
    last = began;
  const counts: Partial<Record<ProbeKind, number>> = {};
  function remaining() {
    const current = clock.monotonic(),
      elapsed = current - began;
    qualificationRequire(
      Number.isFinite(current) && current >= last && elapsed >= 0 && elapsed < 120000,
      'budget',
    );
    last = current;
    return Math.min(15000, 120000 - elapsed);
  }
  async function bytes(
    r: ReadOnlyRequest,
    limit: number,
  ): Promise<{ bytes: Buffer; status: number; headers: Headers }> {
    qualificationRequire(allow(r), 'context');
    qualificationRequire(
      calls < 20 && Number.isSafeInteger(limit) && limit > 0 && limit <= 4 * 1024 * 1024,
      'budget',
    );
    if (r.kind === 'native') qualificationRequire(nativeGets < 3, 'budget');
    const milliseconds = remaining();
    calls++;
    if (r.kind === 'native') nativeGets++;
    counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new QualificationHold('budget'));
      }, milliseconds);
    });
    const run = async () => {
      const response = await request(r.url, {
        method: r.method,
        headers: r.headers,
        ...(r.body !== undefined ? { body: r.body } : {}),
        redirect: r.manualRedirect ? 'manual' : 'error',
        signal: controller.signal,
      });
      if (r.manualRedirect) {
        qualificationRequire(response.status === 302, 'artifact');
        try {
          void response.body?.cancel().catch(() => undefined);
        } catch {
          /* Never await stalled cancellation. */
        }
        return { bytes: Buffer.alloc(0), status: response.status, headers: response.headers };
      }
      if (response.status !== 200) {
        try {
          void response.body?.cancel().catch(() => undefined);
        } catch {
          /* No payload disclosure. */
        }
        throw new QualificationHold('transport');
      }
      qualificationRequire(response.body, 'transport');
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        for (;;) {
          qualificationRequire(!controller.signal.aborted, 'budget');
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          qualificationRequire(size <= limit, 'budget');
          chunks.push(part.value);
        }
        qualificationRequire(!controller.signal.aborted, 'budget');
        remaining();
        return {
          bytes: Buffer.concat(chunks, size),
          status: response.status,
          headers: response.headers,
        };
      } finally {
        controller.signal.removeEventListener('abort', cancel);
        cancel();
      }
    };
    try {
      return await Promise.race([run(), expired]);
    } catch (e) {
      if (e instanceof QualificationHold) throw e;
      throw new QualificationHold('transport');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return {
    bytes,
    assertWithin: remaining,
    async json(r: ReadOnlyRequest, limit = 512 * 1024) {
      const response = await bytes(r, limit);
      qualificationRequire(
        /^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? ''),
        'transport',
      );
      try {
        return {
          value: JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(response.bytes),
          ) as unknown,
          headers: response.headers,
        };
      } catch {
        throw new QualificationHold('transport');
      }
    },
    summary: () => ({ requests: calls, nativeGets, counts: { ...counts } }),
  };
}
