import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  hide: vi.fn(),
  unhide: vi.fn(),
  delivered: vi.fn(),
}));
vi.mock('@/lib/server', () => ({
  getChatApplication: () => ({
    hideChatMessage: mocks.hide,
    unhideChatMessage: mocks.unhide,
    acknowledgeMessageDelivery: mocks.delivered,
  }),
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { POST } from './route';

const CHAT_ID = '11111111-1111-1111-1111-111111111111';
const MESSAGE_ID = '22222222-2222-2222-2222-222222222222';

const post = (id: string, messageId: string, body: unknown, authorization?: string) =>
  POST(
    new Request(`https://example.com/api/mobile/v1/chats/${id}/messages/${messageId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id, messageId }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(true);
});

describe('native chat message visibility', () => {
  it('requires authentication before touching anything', async () => {
    mocks.auth.mockResolvedValue(false);
    const response = await post(CHAT_ID, MESSAGE_ID, { action: 'hide' });
    expect(response.status).toBe(401);
    expect(mocks.hide).not.toHaveBeenCalled();
  });

  it('rejects a malformed chat id', async () => {
    const response = await post('not-a-uuid', MESSAGE_ID, { action: 'hide' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid chat id');
    expect(mocks.hide).not.toHaveBeenCalled();
  });

  it('rejects a malformed message id', async () => {
    const response = await post(CHAT_ID, 'not-a-uuid', { action: 'hide' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid message id');
    expect(mocks.hide).not.toHaveBeenCalled();
  });

  it('rejects a missing action', async () => {
    const response = await post(CHAT_ID, MESSAGE_ID, {});
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'action must be hide, unhide, or delivered',
    );
  });

  it('rejects an unknown action', async () => {
    const response = await post(CHAT_ID, MESSAGE_ID, { action: 'delete' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'action must be hide, unhide, or delivered',
    );
  });

  it('hides a message', async () => {
    mocks.hide.mockResolvedValue(true);
    const response = await post(CHAT_ID, MESSAGE_ID, { action: 'hide' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.hide).toHaveBeenCalledWith(CHAT_ID, MESSAGE_ID);
    expect(mocks.unhide).not.toHaveBeenCalled();
  });

  it('unhides a message', async () => {
    mocks.unhide.mockResolvedValue(true);
    const response = await post(CHAT_ID, MESSAGE_ID, { action: 'unhide' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.unhide).toHaveBeenCalledWith(CHAT_ID, MESSAGE_ID);
    expect(mocks.hide).not.toHaveBeenCalled();
  });

  it('reports 404 when the command finds no such message', async () => {
    mocks.hide.mockResolvedValue(false);
    const response = await post(CHAT_ID, MESSAGE_ID, { action: 'hide' });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe('message not found');
  });

  it('reports 409 when the command throws (e.g. chat not owned)', async () => {
    mocks.hide.mockRejectedValue(new Error('chat not found'));
    const response = await post(CHAT_ID, MESSAGE_ID, { action: 'hide' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('chat not found');
  });

  it('requires an authenticated bearer device and a bounded client ID for delivery receipts', async () => {
    const noBearer = await post(CHAT_ID, MESSAGE_ID, {
      action: 'delivered',
      clientId: '33333333-3333-4333-8333-333333333333',
    });
    expect(noBearer.status).toBe(401);
    expect(mocks.delivered).not.toHaveBeenCalled();

    const malformed = await post(
      CHAT_ID,
      MESSAGE_ID,
      { action: 'delivered', clientId: 'not-a-uuid' },
      'Bearer synthetic-device-token',
    );
    expect(malformed.status).toBe(400);
    expect(mocks.delivered).not.toHaveBeenCalled();

    const extra = await post(
      CHAT_ID,
      MESSAGE_ID,
      {
        action: 'delivered',
        clientId: '33333333-3333-4333-8333-333333333333',
        taskId: 'forged',
      },
      'Bearer synthetic-device-token',
    );
    expect(extra.status).toBe(400);
    expect(mocks.delivered).not.toHaveBeenCalled();
  });

  it('records the matching client delivery acknowledgement and keeps not-ready replies retryable', async () => {
    const clientId = '33333333-3333-4333-8333-333333333333';
    mocks.delivered.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const request = () =>
      post(CHAT_ID, MESSAGE_ID, { action: 'delivered', clientId }, 'Bearer synthetic-device-token');
    expect((await request()).status).toBe(409);
    expect(await (await request()).json()).toEqual({ ok: true });
    expect(mocks.delivered).toHaveBeenNthCalledWith(1, CHAT_ID, MESSAGE_ID, clientId);
    expect(mocks.delivered).toHaveBeenNthCalledWith(2, CHAT_ID, MESSAGE_ID, clientId);
  });
});
