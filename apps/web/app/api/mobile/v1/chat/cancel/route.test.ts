import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), cancel: vi.fn() }));
vi.mock('@/lib/server', () => ({ getChatApplication: () => ({ cancelChatTurn: mocks.cancel }) }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { POST } from './route';

const identity = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  clientOperationId: '22222222-2222-4222-8222-222222222222',
};
function request(body: unknown = identity) {
  return new Request('https://assistant.example/api/mobile/v1/chat/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('mobile stable-operation chat cancellation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(true);
  });

  it('authenticates before parsing or accessing the application', async () => {
    mocks.auth.mockResolvedValue(false);
    const response = await POST(request({ invalid: true }));
    expect(response.status).toBe(401);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('does not read the request body when mobile authentication fails', async () => {
    mocks.auth.mockResolvedValue(false);
    const req = new Request('https://assistant.example/api/mobile/v1/chat/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(identity),
      duplex: 'half',
    } as RequestInit);
    const response = await POST(req);
    expect(response.status).toBe(401);
    expect(req.bodyUsed).toBe(false);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('rejects oversize and malformed identities before cancellation lookup', async () => {
    const oversized = await POST(request({ ...identity, extra: 'x'.repeat(2048) }));
    expect(oversized.status).toBe(413);
    const malformed = await POST(request({ ...identity, clientOperationId: 'operation-1' }));
    expect(malformed.status).toBe(400);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('returns the stable pre-admission result without exposing marker task details', async () => {
    mocks.cancel.mockResolvedValue({
      kind: 'cancelled_before_admission',
      task: {
        id: '33333333-3333-4333-8333-333333333333',
        trigger: { payload: { text: 'private' } },
      },
      status: 'cancelled',
      transitioned: false,
      effectStatus: 'not_started',
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      outcome: 'cancelled_before_admission',
      ...identity,
      taskId: null,
      transitioned: false,
      effectStatus: 'not_started',
    });
    expect(JSON.stringify(body)).not.toContain('private');
  });

  it('does not claim an admitted effect was undone or a lost result was rejected', async () => {
    mocks.cancel.mockResolvedValueOnce({
      kind: 'admitted_task',
      task: { id: '33333333-3333-4333-8333-333333333333' },
      status: 'done',
      transitioned: false,
      effectStatus: 'unknown',
    });
    const terminal = await POST(request());
    expect(terminal.status).toBe(200);
    expect(await terminal.json()).toMatchObject({
      outcome: 'already_terminal',
      effectStatus: 'unknown',
    });

    mocks.cancel.mockRejectedValueOnce(new Error('lost response'));
    const uncertain = await POST(request());
    expect(uncertain.status).toBe(503);
    expect(await uncertain.json()).toMatchObject({
      outcome: 'unknown',
      code: 'cancellation_unconfirmed',
      ...identity,
      taskId: null,
      effectStatus: 'unknown',
    });
  });
});
