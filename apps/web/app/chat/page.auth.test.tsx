import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  getPrimaryConversationId: vi.fn(),
  getChatConversation: vi.fn(),
}));
vi.mock('@/auth', () => ({ requireOwner: mocks.requireOwner }));
vi.mock('@/lib/server', () => ({
  getChatApplication: () => ({
    getPrimaryConversationId: mocks.getPrimaryConversationId,
    getChatConversation: mocks.getChatConversation,
  }),
}));

import { renderChatConversation } from './conversation-page';
import ChatIndexPage from './page';

describe('browser chat owner page guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires the owner before resolving the primary conversation', async () => {
    mocks.requireOwner.mockRejectedValue(new Error('owner auth required'));

    await expect(ChatIndexPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'owner auth required',
    );
    expect(mocks.getPrimaryConversationId).not.toHaveBeenCalled();
  });

  it('requires the owner before reading a conversation URL', async () => {
    mocks.requireOwner.mockRejectedValue(new Error('owner auth required'));

    await expect(
      renderChatConversation('11111111-1111-4111-8111-111111111111', {}),
    ).rejects.toThrow('owner auth required');
    expect(mocks.getChatConversation).not.toHaveBeenCalled();
  });

  it('loads the primary owner conversation and passes the verified session scope to ChatClient', async () => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const messages = [{ id: 'owner-message', role: 'user', content: 'Hello' }];
    const models = [{ id: 'model-1', label: 'Assistant model' }];
    mocks.requireOwner.mockResolvedValue({
      user: { email: 'owner@example.test' },
      formSessionScope: 'verified-browser-session',
    });
    mocks.getPrimaryConversationId.mockResolvedValue(conversationId);
    mocks.getChatConversation.mockResolvedValue({
      conversation: {
        id: conversationId,
        title: 'Primary conversation',
        modelOverride: null,
        archivedAt: null,
        isPrimary: true,
      },
      messages,
      models,
      agentName: 'Assistant',
      agentTimezone: 'America/Los_Angeles',
      goalTitle: null,
      canArchive: false,
      asyncTurn: null,
      cursor: 'owner-cursor',
    });

    const page = await ChatIndexPage({ searchParams: Promise.resolve({}) });

    expect(mocks.requireOwner).toHaveBeenCalledTimes(2);
    expect(mocks.getPrimaryConversationId).toHaveBeenCalledOnce();
    expect(mocks.getChatConversation).toHaveBeenCalledWith(conversationId, {
      taskId: undefined,
      cursor: undefined,
    });
    expect(page.props).toMatchObject({
      conversationId,
      formSessionScope: 'verified-browser-session',
      title: 'Primary conversation',
      agentName: 'Assistant',
      agentTimezone: 'America/Los_Angeles',
      initialMessages: messages,
      models,
      modelOverride: null,
      archived: false,
      isPrimary: true,
      canArchive: false,
      initialAsyncTurn: null,
      initialCursor: 'owner-cursor',
    });
  });
});
