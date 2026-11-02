import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedTrafficFixture } from './fixtures/web-traffic-reconciliation.js';
import { nativeRetirementClient } from './owner-web-tag-native.js';
import { WEB_SERVICE } from './owner-web-tag-retirement.js';
import { planWebTrafficReconciliation } from './owner-web-traffic-reconciliation-model.js';
import { nativeWebTrafficReconciliationClient } from './owner-web-traffic-reconciliation-native.js';

const f = fixedTrafficFixture(),
  at = '2026-11-01T18:00:00.000Z',
  source = 'a'.repeat(40),
  token = 'PRIVATE_SYNTHETIC_TOKEN';
const body = planWebTrafficReconciliation(f.before, f.native, source, at).request.body;
const name = 'projects/bmson-assistant/locations/us-west1/operations/fixed';
const json = (v: unknown) =>
  new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());
describe('dedicated fixed two-target native transport with fake network only', () => {
  it('reads only exact service and pinned revisions; old retirement client still rejects two targets', async () => {
    const request = vi.fn<typeof fetch>(async () => json({})),
      c = nativeWebTrafficReconciliationClient(token, request);
    await c.readService(signal());
    for (const p of [f.old, f.current]) await c.readRevision(p.revision, signal());
    expect(request.mock.calls.map((v) => String(v[0]))).toEqual([
      `https://run.googleapis.com/v2/${WEB_SERVICE}`,
      `https://run.googleapis.com/v2/${WEB_SERVICE}/revisions/${f.old.revision}`,
      `https://run.googleapis.com/v2/${WEB_SERVICE}/revisions/${f.current.revision}`,
    ]);
    expect(() => c.readRevision('assistant-web-foreign', signal())).toThrow();
    expect(request).toHaveBeenCalledTimes(3);
    const retirement = nativeRetirementClient(token, request);
    expect(() => retirement.patchTraffic(body)).toThrow();
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('makes exactly one two-target traffic-only PATCH and polls only its own returned LRO', async () => {
    let mono = 0;
    const request = vi.fn<typeof fetch>(async (_url, init) =>
      json(
        init?.method === 'PATCH'
          ? { name, done: false }
          : { name, done: true, response: { name: WEB_SERVICE } },
      ),
    );
    const c = nativeWebTrafficReconciliationClient(
      token,
      request,
      async (ms) => {
        mono += ms;
      },
      () => mono,
    );
    const operation = await c.patchTraffic(body, { updateMask: 'traffic', signal: signal() });
    await c.waitOperation(operation, signal());
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[0]?.[0])).toBe(
      `https://run.googleapis.com/v2/${WEB_SERVICE}?updateMask=traffic`,
    );
    expect(request.mock.calls[0]?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual(body);
    expect(String(request.mock.calls[1]?.[0])).toBe(`https://run.googleapis.com/v2/${name}`);
    expect(request.mock.calls[1]?.[1]?.method).toBe('GET');
    for (const call of request.mock.calls) {
      expect(call[1]?.redirect).toBe('error');
      expect(new Headers(call[1]?.headers).get('authorization')).toBe(`Bearer ${token}`);
    }
    await expect(
      c.patchTraffic(body, { updateMask: 'traffic', signal: signal() }),
    ).rejects.toThrow();
    await expect(c.waitOperation(operation, signal())).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    'extra',
    'foreignService',
    'emptyEtag',
    'oneTarget',
    'activeOld',
    'newRevision',
    'newTag',
    'missingZero',
    'latestType',
    'template',
  ])('rejects forbidden patch shape %s before the request', async (kind) => {
    const b = structuredClone(body) as unknown as Record<string, unknown>;
    const rows = b.traffic as Array<Record<string, unknown>>;
    if (kind === 'extra') b.annotations = { PRIVATE: 'never' };
    if (kind === 'foreignService') b.name = 'projects/other/services/web';
    if (kind === 'emptyEtag') b.etag = '';
    if (kind === 'oneTarget') b.traffic = rows.slice(0, 1);
    if (kind === 'activeOld') Object.assign(rows[1] ?? {}, { percent: 1 });
    if (kind === 'newRevision') Object.assign(rows[0] ?? {}, { revision: 'assistant-web-foreign' });
    if (kind === 'newTag') Object.assign(rows[0] ?? {}, { tag: 'resume-foreign' });
    if (kind === 'missingZero') delete rows[1]?.percent;
    if (kind === 'latestType')
      Object.assign(rows[0] ?? {}, { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST' });
    if (kind === 'template') b.template = { containers: [] };
    const request = vi.fn<typeof fetch>(),
      c = nativeWebTrafficReconciliationClient(token, request);
    await expect(
      c.patchTraffic(b as unknown as typeof body, { updateMask: 'traffic', signal: signal() }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([412, 429, 503])(
    'never retries or permits a second PATCH after status %i',
    async (status) => {
      const request = vi.fn<typeof fetch>(async () => new Response('PRIVATE', { status })),
        c = nativeWebTrafficReconciliationClient(token, request);
      await expect(
        c.patchTraffic(body, { updateMask: 'traffic', signal: signal() }),
      ).rejects.toThrow();
      await expect(
        c.patchTraffic(body, { updateMask: 'traffic', signal: signal() }),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it('does not adopt an arbitrary same-region operation or issue a GET', async () => {
    const request = vi.fn<typeof fetch>(async () => json({ name, done: false })),
      c = nativeWebTrafficReconciliationClient(token, request);
    await c.patchTraffic(body, { updateMask: 'traffic', signal: signal() });
    await expect(
      c.waitOperation({ name: `${name}-other`, done: false }, signal()),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('caps same-LRO GETs at sixty even with a stalled clock', async () => {
    const request = vi.fn<typeof fetch>(async () => json({ name, done: false })),
      c = nativeWebTrafficReconciliationClient(
        token,
        request,
        async () => {},
        () => 0,
      );
    const operation = await c.patchTraffic(body, { updateMask: 'traffic', signal: signal() });
    await expect(c.waitOperation(operation, signal())).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(61);
    expect(request.mock.calls.filter((c) => c[1]?.method === 'PATCH')).toHaveLength(1);
    expect(new Set(request.mock.calls.slice(1).map((c) => String(c[0])))).toEqual(
      new Set([`https://run.googleapis.com/v2/${name}`]),
    );
  });
  it.each(['headers', 'body', 'cancel'])(
    'bounds stalled %s and does not wait for abort-ignoring cancellation',
    async (kind) => {
      vi.useFakeTimers();
      const request = vi.fn<typeof fetch>(async () =>
        kind === 'headers'
          ? new Promise<Response>(() => {})
          : new Response(
              new ReadableStream({
                start(c) {
                  if (kind === 'cancel') c.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
                },
                cancel() {
                  return new Promise(() => {});
                },
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
      );
      const c = nativeWebTrafficReconciliationClient(token, request),
        result = expect(c.readService(signal())).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15000);
      await result;
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it('stops after parent abort even if the sleep ignores it; no later operation GET', async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(async () => json({ name, done: false })),
      c = nativeWebTrafficReconciliationClient(token, request, async () => new Promise(() => {}));
    const operation = await c.patchTraffic(body, { updateMask: 'traffic', signal: signal() }),
      controller = new AbortController();
    const result = expect(c.waitOperation(operation, controller.signal)).rejects.toThrow();
    controller.abort();
    await result;
    await vi.advanceTimersByTimeAsync(180000);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    { name, done: true, error: { message: 'PRIVATE' } },
    { name, done: true, response: { name: 'projects/other/service' } },
    { name: `${name}-changed`, done: true, response: { name: WEB_SERVICE } },
  ])('rejects nonmatching/failed terminal operation without retry', async (terminal) => {
    const request = vi.fn<typeof fetch>(async (_u, init) =>
        json(init?.method === 'PATCH' ? { name, done: false } : terminal),
      ),
      c = nativeWebTrafficReconciliationClient(token, request, async () => {});
    const operation = await c.patchTraffic(body, { updateMask: 'traffic', signal: signal() });
    await expect(c.waitOperation(operation, signal())).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('bounds the full operation to180seconds including an ignored sleep', async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(async () => json({ name, done: false })),
      c = nativeWebTrafficReconciliationClient(token, request, async () => new Promise(() => {}));
    const operation = await c.patchTraffic(body, { updateMask: 'traffic', signal: signal() }),
      result = expect(c.waitOperation(operation, signal())).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(180000);
    await result;
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects a terminal response beyond the original180s deadline', async () => {
    let mono = 0;
    const request = vi.fn<typeof fetch>(async (_u, init) => {
      if (init?.method === 'PATCH') return json({ name, done: false });
      mono = 180001;
      return json({ name, done: true, response: { name: WEB_SERVICE } });
    });
    const c = nativeWebTrafficReconciliationClient(
      token,
      request,
      async (ms) => {
        mono += ms;
      },
      () => mono,
    );
    const operation = await c.patchTraffic(body, { updateMask: 'traffic', signal: signal() });
    await expect(c.waitOperation(operation, signal())).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('enforces the monotonic15s call boundary even before a queued timer can fire', async () => {
    let mono = 0;
    const request = vi.fn<typeof fetch>(async () => {
      mono = 15001;
      return json({});
    });
    const c = nativeWebTrafficReconciliationClient(
      token,
      request,
      async () => {},
      () => mono,
    );
    await expect(c.readService(signal())).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects corrupt/rollback monotonic clocks before further network calls', async () => {
    let mono = 10;
    const request = vi.fn<typeof fetch>(async () => json({})),
      c = nativeWebTrafficReconciliationClient(
        token,
        request,
        async () => {},
        () => mono,
      );
    await c.readService(signal());
    mono = 9;
    await expect(c.readService(signal())).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
