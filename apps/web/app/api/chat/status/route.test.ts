import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAuthed: vi.fn(),
  isValidChatCursor: vi.fn(() => true),
  getChatUpdates: vi.fn(),
}));
vi.mock('@/auth', () => ({ isAuthed: mocks.isAuthed }));
vi.mock('@/lib/server', () => ({
  getChatApplication: () => ({
    isValidChatCursor: mocks.isValidChatCursor,
    getChatUpdates: mocks.getChatUpdates,
  }),
}));

import { GET } from './route';

describe('browser chat status route authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthed.mockResolvedValue(null);
  });

  it('rejects unauthenticated requests before opening the chat application', async () => {
    const response = await GET(
      new Request(
        'https://assistant.example/api/chat/status?conversationId=11111111-1111-4111-8111-111111111111',
      ),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(mocks.getChatUpdates).not.toHaveBeenCalled();
  });

  it('returns current-task updates for an authenticated owner session', async () => {
    const updates = { messages: [{ id: 'assistant-message' }], cursor: 'next-cursor' };
    mocks.isAuthed.mockResolvedValue({ user: { email: 'owner@example.test' } });
    mocks.getChatUpdates.mockResolvedValue(updates);

    const response = await GET(
      new Request(
        'https://assistant.example/api/chat/status?conversationId=11111111-1111-4111-8111-111111111111&taskId=22222222-2222-4222-8222-222222222222&cursor=prior-cursor&wait=0',
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(updates);
    expect(mocks.getChatUpdates).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '11111111-1111-4111-8111-111111111111',
        taskId: '22222222-2222-4222-8222-222222222222',
        cursor: 'prior-cursor',
        waitMs: 0,
      }),
    );
  });
});
