import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  suppressed: vi.fn(),
  setSuppressed: vi.fn(),
  getRecallSurfacingPorts: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  getRecallSurfacingPorts: mocks.getRecallSurfacingPorts,
}));
vi.mock('@/auth', () => ({ isAuthed: mocks.auth }));

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
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(true);
  mocks.suppressed.mockResolvedValue(new Set());
  mocks.getRecallSurfacingPorts.mockResolvedValue({
    agentId: 'owner-1',
    repository: { suppressed: mocks.suppressed, setSuppressed: mocks.setSuppressed },
  });
});

describe('web recall source controls', () => {
  it('reads source control state for the current revision', async () => {
    const response = await GET(new Request(`${url}?sourceRevision=${sourceRevision}`), params);
    expect(await response.json()).toEqual({ suppressed: false });
    expect(mocks.suppressed).toHaveBeenCalledWith('owner-1', [sourceKey], {
      [sourceKey]: sourceRevision,
    });
  });

  it('rejects malformed revision filters before reading the ledger', async () => {
    expect((await GET(new Request(`${url}?sourceRevision=stale`), params)).status).toBe(400);
    expect(mocks.suppressed).not.toHaveBeenCalled();
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
