import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeState = vi.hoisted(() => ({
  bearer: vi.fn(),
  owner: vi.fn(),
  read: vi.fn(),
}));

vi.mock('@/mobile-auth', () => ({
  authenticateMobileBearer: routeState.bearer,
  resolveMobileOwner: routeState.owner,
  mobileUnauthorized: () =>
    Response.json(
      { error: 'unauthorized' },
      {
        status: 401,
        headers: {
          'cache-control': 'no-store',
          'www-authenticate': 'Bearer realm="Assistant iOS"',
        },
      },
    ),
  mobileJson: (value: unknown, init?: ResponseInit) => {
    const headers = new Headers(init?.headers);
    headers.set('cache-control', 'no-store');
    return Response.json(value, { ...init, headers });
  },
}));
vi.mock('@/lib/server', () => ({ loadOwnerMemorySnapshot: routeState.read }));

import { GET } from './route';

const memoryId = '11d2bd56-7f8a-4c9a-8b37-51087601945c';
const principal = { kind: 'configured_installation_bearer' as const };
const ownerId = '11111111-1111-4111-8111-111111111111';
const snapshot = {
  memoryId,
  ownerId,
  content: 'The saved note.',
  contentHash: 'a'.repeat(64),
  revision: 'b'.repeat(64),
  ownerCorrection: null,
  sourceLabel: 'Saved manual note',
  eligible: true,
};

function request(url = `https://assistant.example.com/api/mobile/v1/memory/${memoryId}/snapshot`) {
  return new Request(url, { headers: { authorization: 'Bearer installation-token' } });
}

function context(id = memoryId) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  routeState.bearer.mockReset().mockResolvedValue(principal);
  routeState.owner.mockReset().mockResolvedValue({ ok: true, ownerId });
  routeState.read.mockReset().mockResolvedValue(snapshot);
});

describe('native saved-note snapshot GET', () => {
  it('requires bearer auth and never falls back to a cookie session', async () => {
    routeState.bearer.mockResolvedValue(null);

    const response = await GET(request(), context());

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="Assistant iOS"');
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(routeState.owner).not.toHaveBeenCalled();
    expect(routeState.read).not.toHaveBeenCalled();
  });

  it('rejects malformed ids before resolving owner or reading storage', async () => {
    const response = await GET(request(), context('not-a-uuid'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid memory id' });
    expect(routeState.owner).not.toHaveBeenCalled();
    expect(routeState.read).not.toHaveBeenCalled();
  });

  it('uses only server-resolved owner and returns a minimized exact snapshot', async () => {
    const response = await GET(
      request(
        `https://assistant.example.com/api/mobile/v1/memory/${memoryId}/snapshot?ownerId=attacker`,
      ),
      context(),
    );

    expect(routeState.owner).toHaveBeenCalledWith(principal);
    expect(routeState.read).toHaveBeenCalledWith(ownerId, memoryId);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      memoryId,
      content: 'The saved note.',
      contentHash: 'a'.repeat(64),
      revision: 'b'.repeat(64),
      sourceLabel: 'Saved manual note',
      eligible: true,
      ownerCorrected: false,
    });
  });

  it('returns present but ineligible content with the stored hash claim and stable reason', async () => {
    routeState.read.mockResolvedValue({
      ...snapshot,
      content: 'Changed saved text.',
      contentHash: 'a'.repeat(64),
      eligible: false,
      readOnlyReason: 'memory_content_hash_mismatch',
      ownerCorrection: null,
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      content: 'Changed saved text.',
      contentHash: 'a'.repeat(64),
      eligible: false,
      readOnlyReason: 'memory_content_hash_mismatch',
      ownerCorrected: false,
    });
  });

  it('reduces verified correction attribution to a boolean', async () => {
    routeState.read.mockResolvedValue({
      ...snapshot,
      ownerCorrection: {
        version: 1,
        correctedByOwner: true,
        priorContentHash: 'c'.repeat(64),
        currentContentHash: 'a'.repeat(64),
        correctedAt: '2026-11-03T00:00:00.000Z',
      },
    });

    const response = await GET(request(), context());
    const body = await response.json();

    expect(body).toMatchObject({ ownerCorrected: true });
    expect(JSON.stringify(body)).not.toMatch(/priorContentHash|currentContentHash|correctedAt/);
    expect(JSON.stringify(body)).not.toContain('c'.repeat(64));
  });

  it('returns a null hash for a malformed stored hash without repairing it', async () => {
    routeState.read.mockResolvedValue({
      ...snapshot,
      contentHash: 'malformed-stored-hash',
      eligible: false,
      readOnlyReason: 'memory_content_hash_mismatch',
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      contentHash: null,
      eligible: false,
      readOnlyReason: 'memory_content_hash_mismatch',
    });
    expect(routeState.read).toHaveBeenCalledTimes(1);
  });

  it('maps unknown future read-only reasons to the stable unverified source reason', async () => {
    routeState.read.mockResolvedValue({
      ...snapshot,
      eligible: false,
      readOnlyReason: 'future_internal_classifier_detail',
    });

    const response = await GET(request(), context());

    expect(await response.json()).toMatchObject({
      eligible: false,
      readOnlyReason: 'unverified_source',
    });
  });

  it('does not distinguish a foreign-owner target from a missing note', async () => {
    const statuses: number[] = [];
    const payloads: unknown[] = [];
    for (const target of [memoryId, '22222222-2222-4222-8222-222222222222']) {
      routeState.read.mockResolvedValueOnce(null);
      const response = await GET(request(), context(target));
      statuses.push(response.status);
      payloads.push(await response.json());
    }

    expect(statuses).toEqual([404, 404]);
    expect(payloads).toEqual([{ error: 'not_found' }, { error: 'not_found' }]);
  });

  it('maps owner or persistence unavailability to a no-store service failure without details', async () => {
    routeState.owner.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const ownerFailure = await GET(request(), context());
    expect(ownerFailure.status).toBe(503);
    expect(await ownerFailure.json()).toEqual({ code: 'memory_unavailable' });
    expect(routeState.read).not.toHaveBeenCalled();

    routeState.owner.mockResolvedValue({ ok: true, ownerId });
    routeState.read.mockRejectedValue(new Error('private database connection string'));
    const storageFailure = await GET(request(), context());
    expect(storageFailure.status).toBe(503);
    expect(await storageFailure.json()).toEqual({ code: 'memory_unavailable' });
    expect(storageFailure.headers.get('cache-control')).toBe('no-store');
  });

  it('returns a fresh content hash and source revision on each read after a saved-note change', async () => {
    routeState.read.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({
      ...snapshot,
      content: 'A newer saved note.',
      contentHash: 'c'.repeat(64),
      revision: 'd'.repeat(64),
    });

    const first = await (await GET(request(), context())).json();
    const second = await (await GET(request(), context())).json();

    expect(first).toMatchObject({
      content: 'The saved note.',
      contentHash: 'a'.repeat(64),
      revision: 'b'.repeat(64),
    });
    expect(second).toMatchObject({
      content: 'A newer saved note.',
      contentHash: 'c'.repeat(64),
      revision: 'd'.repeat(64),
    });
    expect(routeState.read).toHaveBeenCalledTimes(2);
  });
});
