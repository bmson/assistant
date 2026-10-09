import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  cancel: vi.fn(),
  config: { AUTH_URL: 'https://assistant.example', PUBLIC_URL: 'https://fallback.example' },
}));
vi.mock('@/auth', () => ({ isAuthed: mocks.auth }));
vi.mock('@assistant/config', () => ({ loadConfig: () => mocks.config }));
vi.mock('@/lib/server', () => ({ getChatApplication: () => ({ cancelChatTurn: mocks.cancel }) }));

import { POST } from './route';

const identity = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  clientOperationId: '22222222-2222-4222-8222-222222222222',
};

function request(body: unknown = identity, origin = 'https://assistant.example') {
  return new Request('https://assistant.example/api/chat/cancel', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('web stable-operation chat cancellation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { email: 'owner@example.test' } });
  });

  it('rejects a hostile origin before owner lookup, body parsing, or application access', async () => {
    const req = new Request('https://assistant.example/api/chat/cancel', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify(identity),
      duplex: 'half',
    } as RequestInit);
    const response = await POST(req);
    expect(response.status).toBe(403);
    expect(req.bodyUsed).toBe(false);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('rejects a missing origin before owner lookup', async () => {
    const req = new Request('https://assistant.example/api/chat/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(identity),
    });
    const response = await POST(req);
    expect(response.status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('requires an authenticated owner even at the configured origin', async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it.each([
    ['extra field', { ...identity, text: 'private prompt' }],
    [
      'wrong UUID version',
      { ...identity, clientOperationId: '22222222-2222-0222-8222-222222222222' },
    ],
    ['missing conversation', { clientOperationId: identity.clientOperationId }],
  ])('rejects %s before application access', async (_label, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('returns a content-free marker receipt with no task identity', async () => {
    mocks.cancel.mockResolvedValue({
      kind: 'cancelled_before_admission',
      task: {
        id: '33333333-3333-4333-8333-333333333333',
        trigger: { payload: { text: 'private' } },
      },
      status: 'cancelled',
      transitioned: true,
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
      transitioned: true,
      effectStatus: 'not_started',
    });
    expect(JSON.stringify(body)).not.toContain('private');
    expect(mocks.cancel).toHaveBeenCalledWith(identity);
  });

  it('keeps admitted cancellation effects unknown and identifies the real task', async () => {
    mocks.cancel.mockResolvedValue({
      kind: 'admitted_task',
      task: {
        id: '33333333-3333-4333-8333-333333333333',
        trigger: { payload: { text: 'private' } },
      },
      status: 'cancelled',
      transitioned: true,
      effectStatus: 'unknown',
    });
    const body = await (await POST(request())).json();
    expect(body).toMatchObject({
      outcome: 'cancelled',
      taskId: '33333333-3333-4333-8333-333333333333',
      taskStatus: 'cancelled',
      effectStatus: 'unknown',
    });
    expect(body).not.toHaveProperty('trigger');
  });

  it('reports an already-finished task without claiming it was stopped', async () => {
    mocks.cancel.mockResolvedValue({
      kind: 'admitted_task',
      task: { id: '33333333-3333-4333-8333-333333333333' },
      status: 'done',
      transitioned: false,
      effectStatus: 'unknown',
    });
    const body = await (await POST(request())).json();
    expect(body).toMatchObject({
      outcome: 'already_terminal',
      taskStatus: 'done',
      effectStatus: 'unknown',
    });
  });

  it('keeps a lost response explicitly unknown and retry-bound to the same identity', async () => {
    mocks.cancel.mockRejectedValue(new Error('connection reset after commit'));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      outcome: 'unknown',
      code: 'cancellation_unconfirmed',
      ...identity,
      taskId: null,
      effectStatus: 'unknown',
    });
    expect(mocks.cancel).toHaveBeenCalledWith(identity);
  });
});
