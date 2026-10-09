import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  identity: vi.fn(),
  getShellStatus: vi.fn(),
  getPrimaryConversationId: vi.fn(),
  getChatConversation: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  getAgentIdentity: mocks.identity,
  getChatApplication: () => ({
    getShellStatus: mocks.getShellStatus,
    getPrimaryConversationId: mocks.getPrimaryConversationId,
    getChatConversation: mocks.getChatConversation,
  }),
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(true);
  mocks.identity.mockResolvedValue({ id: 'agent-1', name: 'Assistant', avatarUrl: null });
  mocks.getShellStatus.mockResolvedValue({
    dashboard: { pendingApprovals: 2, needsAttention: 1, presence: 'attention' },
    memoryHealth: {
      totalUsable: 4,
      notYetOrganized: 1,
      awaitingReview: 3,
      ownerConfirmed: 2,
      lastOrganizedAt: null,
    },
  });
  mocks.getPrimaryConversationId.mockResolvedValue('conversation-1');
  mocks.getChatConversation.mockResolvedValue({ id: 'conversation-1', messages: [] });
});

describe('mobile bootstrap', () => {
  it('requires mobile authentication before reading owner state', async () => {
    mocks.auth.mockResolvedValue(false);
    const response = await GET(new Request('https://example.com/api/mobile/v1/bootstrap'));
    expect(response.status).toBe(401);
    expect(mocks.getShellStatus).not.toHaveBeenCalled();
    expect(mocks.getPrimaryConversationId).not.toHaveBeenCalled();
  });

  it('returns the exact bootstrap contract from the portable chat application', async () => {
    const response = await GET(new Request('https://example.com/api/mobile/v1/bootstrap'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generatedAt: expect.any(String),
      identity: { id: 'agent-1', name: 'Assistant', avatarUrl: null },
      shell: {
        dashboard: { pendingApprovals: 2, needsAttention: 1, presence: 'attention' },
        memoryHealth: {
          totalUsable: 4,
          notYetOrganized: 1,
          awaitingReview: 3,
          ownerConfirmed: 2,
          lastOrganizedAt: null,
        },
      },
      conversation: { id: 'conversation-1', messages: [] },
    });
    expect(mocks.getShellStatus).toHaveBeenCalledWith('agent-1');
    expect(mocks.getPrimaryConversationId).toHaveBeenCalledOnce();
    expect(mocks.getChatConversation).toHaveBeenCalledWith('conversation-1', {});
  });

  it('negotiates native card schema and preserves prose for older clients', async () => {
    const part = {
      type: 'data-card',
      data: {
        kind: 'generated-card',
        id: 'stable-card',
        spec: {
          version: 1,
          title: 'Trip',
          sourceLabel: 'Booking',
          accessibilityLabel: 'Trip details',
          facts: [{ id: 'flight', label: 'Flight', value: 'FI 614', source: 'mail' }],
          blocks: [{ type: 'facts', factIds: ['flight'] }],
          actions: [],
        },
      },
    };
    mocks.getChatConversation.mockResolvedValue({
      id: 'conversation-1',
      messages: [{ id: 'message-1', text: 'Your flight is FI 614.', parts: [part] }],
    });
    const legacy = await GET(new Request('https://example.com/api/mobile/v1/bootstrap'));
    const legacyBody = await legacy.json();
    expect(legacyBody.conversation.messages).toEqual([
      { id: 'message-1', text: 'Your flight is FI 614.', parts: [] },
    ]);

    const capable = await GET(
      new Request('https://example.com/api/mobile/v1/bootstrap', {
        headers: { 'x-assistant-card-schema': '1' },
      }),
    );
    const capableBody = await capable.json();
    expect(capableBody.conversation.messages[0].parts).toEqual([part]);
    expect(capableBody.conversation.messages[0].id).toBe('message-1');
  });

  it('does not invent an identity when the assistant is unconfigured', async () => {
    mocks.identity.mockResolvedValue({ id: '', name: 'Assistant', avatarUrl: null });
    const response = await GET(new Request('https://example.com/api/mobile/v1/bootstrap'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'assistant not configured' });
    expect(mocks.getShellStatus).not.toHaveBeenCalled();
  });
});
