import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  readSourceSetting: vi.fn(),
  config: {
    PERSISTENCE_DRIVER: 'firestore',
    ASSISTANT_RELEASE_WRITES_PAUSED: false,
    RESTORE_REHEARSAL: false,
    AUTH_URL: 'https://example.com',
    WEB_APP_PREVIEW_ENABLED: false,
  },
  setSuppressed: vi.fn(),
  getRecallSurfacingPorts: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  getRecallSurfacingPorts: mocks.getRecallSurfacingPorts,
}));
vi.mock('@/auth', () => ({ isAuthed: mocks.auth }));
vi.mock('@assistant/config', () => ({ loadConfig: () => mocks.config }));

import { proxy } from '@/proxy';
import { GET, PATCH } from './route';

const sourceKey = 'a'.repeat(64);
const sourceRevision = 'b'.repeat(64);
const url = `https://example.com/api/recall/sources/${sourceKey}`;
const params = { params: Promise.resolve({ sourceKey }) };
function streamRequest(stream: ReadableStream<Uint8Array>): Request {
  return new Request(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.PERSISTENCE_DRIVER = 'firestore';
  mocks.config.ASSISTANT_RELEASE_WRITES_PAUSED = false;
  mocks.config.RESTORE_REHEARSAL = false;
  mocks.auth.mockResolvedValue(true);
  mocks.readSourceSetting.mockResolvedValue({ status: 'allowed' });
  mocks.setSuppressed.mockResolvedValue({ ok: true, version: 2 });
  mocks.getRecallSurfacingPorts.mockResolvedValue({
    agentId: 'owner-1',
    repository: { readSourceSetting: mocks.readSourceSetting, setSuppressed: mocks.setSuppressed },
  });
});

describe('web recall source controls', () => {
  it('reads source control state for the current revision', async () => {
    const response = await GET(new Request(`${url}?sourceRevision=${sourceRevision}`), params);
    expect(await response.json()).toEqual({ version: 1, status: 'allowed', suppressed: false });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.readSourceSetting).toHaveBeenCalledWith({
      agentId: 'owner-1',
      sourceKey,
      expectedSourceRevision: sourceRevision,
    });
  });

  it('rejects malformed revision filters before reading the ledger', async () => {
    expect((await GET(new Request(`${url}?sourceRevision=stale`), params)).status).toBe(400);
    expect(mocks.readSourceSetting).not.toHaveBeenCalled();
  });

  it('authenticates and validates the source key before reading a PATCH body', async () => {
    let bodyRead = false;
    const request = streamRequest(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            bodyRead = true;
            controller.enqueue(new TextEncoder().encode('{"suppressed":true}'));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
    );
    mocks.auth.mockResolvedValue(false);
    expect((await PATCH(request, params)).status).toBe(401);
    expect(bodyRead).toBe(false);
    expect(request.body?.locked).toBe(false);
    expect(mocks.setSuppressed).not.toHaveBeenCalled();
  });

  it('rejects streamed oversized PATCH bodies and unknown control fields', async () => {
    const oversized = streamRequest(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controller.enqueue(new Uint8Array(64 * 1024 + 1));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
    );
    const tooLarge = await PATCH(oversized, params);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ error: 'request body too large' });

    const unknown = await PATCH(
      new Request(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          suppressed: true,
          expectedSourceRevision: sourceRevision,
          extra: 'ignored fields must not be accepted',
        }),
      }),
      params,
    );
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: 'unknown control fields' });
    expect(mocks.setSuppressed).not.toHaveBeenCalled();
  });

  it('returns a bounded timeout for a stalled PATCH body', async () => {
    vi.useFakeTimers();
    try {
      const request = streamRequest(
        new ReadableStream<Uint8Array>(
          {
            pull() {},
            cancel() {
              return new Promise<void>(() => {});
            },
          },
          { highWaterMark: 0 },
        ),
      );
      const pending = PATCH(request, params);
      await vi.advanceTimersByTimeAsync(10_001);
      const response = await pending;
      expect(response.status).toBe(408);
      expect(await response.json()).toEqual({ error: 'request body took too long' });
      expect(mocks.setSuppressed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Compose the actual production proxy with the actual route handlers. Ports alone are faked. */
async function dispatchThroughProxy(request: NextRequest): Promise<Response> {
  const admission = proxy(request);
  if (admission.headers.get('x-middleware-next') !== '1') return admission;
  if (request.method === 'GET') return GET(request, params);
  if (request.method === 'PATCH') return PATCH(request, params);
  throw new Error('Fixture must not dispatch unsupported route methods');
}
function getRequest(query = `?sourceRevision=${sourceRevision}`): NextRequest {
  return new NextRequest(`${url}${query}`);
}
function patchRequest(expectedSourceRevision: string | null = sourceRevision): NextRequest {
  return new NextRequest(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ suppressed: true, expectedSourceRevision }),
  });
}

describe('production proxy and authenticated recall source route', () => {
  for (const driver of ['firestore', 'postgres']) {
    describe(driver, () => {
      beforeEach(() => {
        mocks.config.PERSISTENCE_DRIVER = driver;
      });
      it.each([
        [{ status: 'allowed' }, { version: 1, status: 'allowed', suppressed: false }],
        [{ status: 'suppressed' }, { version: 1, status: 'suppressed', suppressed: true }],
        [{ status: 'stale' }, { version: 1, status: 'stale', suppressed: null }],
        [
          { status: 'unavailable', reason: 'missing_record' },
          { version: 1, status: 'unavailable', suppressed: null },
        ],
        [
          { status: 'unavailable', reason: 'unversioned_legacy' },
          { version: 1, status: 'unavailable', suppressed: null },
        ],
      ])('returns only the versioned public status for %j', async (internal, wire) => {
        mocks.readSourceSetting.mockResolvedValue(internal);
        const response = await dispatchThroughProxy(getRequest());
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual(wire);
        expect(mocks.readSourceSetting).toHaveBeenCalledExactlyOnceWith({
          agentId: 'owner-1',
          sourceKey,
          expectedSourceRevision: sourceRevision,
        });
        expect(mocks.setSuppressed).not.toHaveBeenCalled();
      });
      it.each(['', '?sourceRevision=', '?sourceRevision=old', `?sourceRevision=${'A'.repeat(64)}`])(
        'requires the exact saved revision before ports: %s',
        async (query) => {
          const response = await dispatchThroughProxy(getRequest(query));
          expect(response.status).toBe(400);
          expect(mocks.getRecallSurfacingPorts).not.toHaveBeenCalled();
          expect(mocks.readSourceSetting).not.toHaveBeenCalled();
        },
      );
      it.each(['GET', 'PATCH'])(
        'authenticates %s before input validation and ports',
        async (method) => {
          mocks.auth.mockResolvedValue(false);
          const request = method === 'GET' ? getRequest('?sourceRevision=bad') : patchRequest();
          const response = await dispatchThroughProxy(request);
          expect(response.status).toBe(401);
          expect(await response.json()).toEqual({ error: 'unauthorized' });
          expect(mocks.getRecallSurfacingPorts).not.toHaveBeenCalled();
          expect(mocks.setSuppressed).not.toHaveBeenCalled();
        },
      );
      it('preserves explicit current writes and stale refusal', async () => {
        const saved = await dispatchThroughProxy(patchRequest());
        expect(saved.status).toBe(200);
        expect(await saved.json()).toEqual({ ok: true, version: 2 });
        expect(mocks.setSuppressed).toHaveBeenCalledExactlyOnceWith({
          agentId: 'owner-1',
          sourceKey,
          expectedSourceRevision: sourceRevision,
          suppressed: true,
        });
        mocks.setSuppressed.mockResolvedValue({ ok: false });
        const stale = await dispatchThroughProxy(patchRequest('c'.repeat(64)));
        expect(stale.status).toBe(409);
        expect(mocks.readSourceSetting).not.toHaveBeenCalled();
      });
      it.each(['composition', 'privacy', 'malformed row', 'storage'])(
        'keeps %s failures generic and unavailable',
        async (stage) => {
          const privateError = new Error('synthetic private diagnostic must not escape');
          if (stage === 'composition')
            mocks.getRecallSurfacingPorts.mockRejectedValue(privateError);
          else mocks.readSourceSetting.mockRejectedValue(privateError);
          const response = await dispatchThroughProxy(getRequest());
          expect(response.status).toBe(503);
          expect(await response.json()).toEqual({ error: 'recall controls are unavailable' });
          expect(mocks.setSuppressed).not.toHaveBeenCalled();
        },
      );
      it.each(['GET', 'PATCH'])('release pause retains precedence over %s', async (method) => {
        mocks.config.ASSISTANT_RELEASE_WRITES_PAUSED = true;
        const response = await dispatchThroughProxy(
          method === 'GET' ? getRequest() : patchRequest(),
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'updating' });
        expect(mocks.auth).not.toHaveBeenCalled();
        expect(mocks.getRecallSurfacingPorts).not.toHaveBeenCalled();
      });
      it.each(['GET', 'PATCH'])('restore rehearsal retains precedence over %s', async (method) => {
        mocks.config.RESTORE_REHEARSAL = true;
        const response = await dispatchThroughProxy(
          method === 'GET' ? getRequest() : patchRequest(),
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error:
            'Only health, readiness, and static assets are available during restore rehearsal.',
        });
        expect(mocks.auth).not.toHaveBeenCalled();
        expect(mocks.getRecallSurfacingPorts).not.toHaveBeenCalled();
      });
    });
  }
  it.each(['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'])(
    'does not admit new Firestore %s methods',
    (method) => {
      const response = proxy(new NextRequest(url, { method }));
      expect(response.status).toBe(503);
      expect(response.headers.get('x-middleware-next')).toBeNull();
      expect(mocks.auth).not.toHaveBeenCalled();
    },
  );
  it.each([
    `/api/recall/sources/${'A'.repeat(64)}`,
    `/api/recall/sources/${sourceKey}/extra`,
    `/api/recall/sources/${sourceKey}/`,
    `/api/recall/sources/${sourceKey}%2Fextra`,
    '/api/recall/sources',
    '/api/recall/other',
  ])('does not widen the Firestore route prefix: %s', (path) => {
    const response = proxy(new NextRequest(`https://example.com${path}`));
    expect(response.status).toBe(503);
    expect(response.headers.get('x-middleware-next')).toBeNull();
  });
  it.each([
    '/profile',
    '/people',
    '/profile/knowledge',
    '/profile/memories',
    '/people/123e4567-e89b-42d3-a456-426614174000',
  ])('admits exact owner-authenticated browse pages without write authority: %s', (path) => {
    for (const method of ['GET', 'HEAD']) {
      const response = proxy(new NextRequest(`https://example.com${path}?q=Ada`, { method }));
      expect(response.status).toBe(200);
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(response.headers.get('location')).toBeNull();
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = proxy(
        new NextRequest(`https://example.com${path}`, {
          method,
          headers: { 'next-action': 'synthetic-known-write-action' },
        }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get('x-middleware-next')).toBeNull();
    }
    // Proxy admission does not invoke recall ports or replace page-owner auth.
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.getRecallSurfacingPorts).not.toHaveBeenCalled();
  });
  it.each([
    '/profile/about',
    '/profile/memories/extra',
    '/profile/voice',
    '/profile/data',
    '/profile/knowledge/extra',
    '/people/not-a-uuid',
    '/people/123e4567-e89b-42d3-a456-426614174000/extra',
  ])('keeps retired pages and unapproved browse descendants closed: %s', (path) => {
    for (const method of ['GET', 'HEAD']) {
      const response = proxy(new NextRequest(`https://example.com${path}`, { method }));
      expect(response.status).toBe(307);
      expect(response.headers.get('x-middleware-next')).toBeNull();
      expect(response.headers.get('location')).toBe('https://example.com/settings');
    }
    expect(proxy(new NextRequest(`https://example.com${path}`, { method: 'POST' })).status).toBe(
      410,
    );
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.getRecallSurfacingPorts).not.toHaveBeenCalled();
  });
  it('preserves existing health, audit and mobile read admission', () => {
    for (const path of ['/api/health', '/audit', '/api/mobile/v1/people']) {
      expect(
        proxy(new NextRequest(`https://example.com${path}`)).headers.get('x-middleware-next'),
      ).toBe('1');
    }
    expect(mocks.getRecallSurfacingPorts).not.toHaveBeenCalled();
  });
});
