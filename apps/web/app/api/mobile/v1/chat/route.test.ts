import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), handle: vi.fn() }));
vi.mock('@/lib/server', () => ({ getChatApplication: () => ({ handleChatTurn: mocks.handle }) }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { POST } from './route';

describe('mobile chat owner admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(true);
  });
  it('forwards an authenticated send exactly once to the shared chat handler', async () => {
    const request = new Request('https://assistant.example/api/mobile/v1/chat', {
      method: 'POST',
      body: '{}',
    });
    const expected = new Response('ok');
    mocks.handle.mockResolvedValue(expected);
    expect(await POST(request)).toBe(expected);
    expect(mocks.auth).toHaveBeenCalledWith(request);
    expect(mocks.handle).toHaveBeenCalledOnce();
    expect(mocks.handle).toHaveBeenCalledWith(request);
  });
  it('does not forward an unauthenticated send', async () => {
    mocks.auth.mockResolvedValue(false);
    const request = new Request('https://assistant.example/api/mobile/v1/chat', {
      method: 'POST',
      body: '{}',
    });
    expect((await POST(request)).status).toBe(401);
    expect(mocks.handle).not.toHaveBeenCalled();
  });
});
