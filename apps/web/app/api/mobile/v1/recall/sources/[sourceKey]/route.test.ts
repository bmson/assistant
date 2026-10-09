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
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { GET, PATCH } from './route';

const sourceKey = 'a'.repeat(64);
const sourceRevision = 'b'.repeat(64);
const url = `https://example.com/api/mobile/v1/recall/sources/${sourceKey}`;
const params = { params: Promise.resolve({ sourceKey }) };
const patch = (body: unknown) =>
  PATCH(
    new Request(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(true);
  mocks.suppressed.mockResolvedValue(new Set());
  mocks.setSuppressed.mockResolvedValue({ ok: true, version: 2 });
  mocks.getRecallSurfacingPorts.mockResolvedValue({
    agentId: 'owner-1',
    repository: { suppressed: mocks.suppressed, setSuppressed: mocks.setSuppressed },
  });
});

describe('mobile recall source controls', () => {
  it('requires mobile authentication', async () => {
    mocks.auth.mockResolvedValue(false);
    expect((await GET(new Request(url), params)).status).toBe(401);
    expect((await patch({ suppressed: true, expectedSourceRevision: sourceRevision })).status).toBe(
      401,
    );
    expect(mocks.setSuppressed).not.toHaveBeenCalled();
  });

  it('reads only the configured owner source state', async () => {
    mocks.suppressed.mockResolvedValue(new Set([sourceKey]));
    const response = await GET(new Request(url), params);
    expect(await response.json()).toEqual({ suppressed: true });
    expect(mocks.suppressed).toHaveBeenCalledWith('owner-1', [sourceKey], undefined);
  });

  it('reads suppression for the exact source revision when supplied', async () => {
    mocks.suppressed.mockResolvedValue(new Set([sourceKey]));
    const response = await GET(new Request(`${url}?sourceRevision=${sourceRevision}`), params);
    expect(await response.json()).toEqual({ suppressed: true });
    expect(mocks.suppressed).toHaveBeenCalledWith('owner-1', [sourceKey], {
      [sourceKey]: sourceRevision,
    });
  });

  it('rejects an invalid source revision filter', async () => {
    expect((await GET(new Request(`${url}?sourceRevision=old`), params)).status).toBe(400);
    expect(mocks.suppressed).not.toHaveBeenCalled();
  });

  it('writes a revision-fenced hide or allow decision', async () => {
    const response = await patch({ suppressed: true, expectedSourceRevision: sourceRevision });
    expect(await response.json()).toEqual({ ok: true, version: 2 });
    expect(mocks.setSuppressed).toHaveBeenCalledWith({
      agentId: 'owner-1',
      sourceKey,
      expectedSourceRevision: sourceRevision,
      suppressed: true,
    });
  });

  it('rejects malformed controls and reports stale sources as conflicts', async () => {
    expect(
      (await patch({ suppressed: 'yes', expectedSourceRevision: sourceRevision })).status,
    ).toBe(400);
    mocks.setSuppressed.mockResolvedValue({ ok: false });
    expect(
      (await patch({ suppressed: false, expectedSourceRevision: sourceRevision })).status,
    ).toBe(409);
  });
});
