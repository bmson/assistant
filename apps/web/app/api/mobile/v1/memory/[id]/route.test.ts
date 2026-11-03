import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeState = vi.hoisted(() => ({
  authenticated: vi.fn(),
  correctMemory: vi.fn(),
}));

vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: routeState.authenticated,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/server', () => ({
  getOwnerMemoryCommands: () => ({ correctMemory: routeState.correctMemory }),
}));

import { PATCH } from './route';

const memoryId = '11d2bd56-7f8a-4c9a-8b37-51087601945c';

function patchRequest(body: unknown): Request {
  return new Request(`https://assistant.example.com/api/mobile/v1/memory/${memoryId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  routeState.authenticated.mockReset().mockResolvedValue(true);
  routeState.correctMemory.mockReset().mockResolvedValue({});
});

describe('legacy native memory correction PATCH', () => {
  it('keeps the existing auth and direct correction command contract', async () => {
    const response = await PATCH(patchRequest({ content: 'Keep this correction.' }), {
      params: Promise.resolve({ id: memoryId }),
    });

    expect(routeState.authenticated).toHaveBeenCalledTimes(1);
    expect(routeState.correctMemory).toHaveBeenCalledWith(memoryId, 'Keep this correction.');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('does not call the correction command when legacy auth rejects the request', async () => {
    routeState.authenticated.mockResolvedValue(false);

    const response = await PATCH(patchRequest({ content: 'Keep this correction.' }), {
      params: Promise.resolve({ id: memoryId }),
    });

    expect(routeState.correctMemory).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });
});
