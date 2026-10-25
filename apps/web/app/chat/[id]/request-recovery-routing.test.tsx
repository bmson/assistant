import { getChatConversationView, getChatUpdates } from '@assistant/application/chat';
import type { ApplicationChatPersistence } from '@assistant/persistence';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  config: {
    PERSISTENCE_DRIVER: 'firestore',
    RESTORE_REHEARSAL: false,
    ASSISTANT_RELEASE_WRITES_PAUSED: false,
    AUTH_URL: 'https://assistant.test',
    WEB_APP_PREVIEW_ENABLED: false,
  },
  owner: vi.fn(),
  authenticated: vi.fn(),
  readView: vi.fn(),
  readUpdates: vi.fn(),
}));
vi.mock('@assistant/config', () => ({ loadConfig: () => dependencies.config }));
vi.mock('@/auth', () => ({
  requireOwner: dependencies.owner,
  isAuthed: dependencies.authenticated,
}));
vi.mock('@/lib/server', () => ({
  getChatApplication: () => ({
    getChatConversation: dependencies.readView,
    getChatUpdates: dependencies.readUpdates,
    isValidChatCursor: () => true,
  }),
}));
vi.mock('./chat-client', () => ({
  ChatClient: ({ conversationId }: { conversationId: string }) => (
    <div data-owner-conversation={conversationId} />
  ),
}));

import { proxy } from '../../../proxy';
import { GET } from '../../api/chat/status/route';
import { renderChatConversation } from '../conversation-page';
import { CANCELLED_REQUEST_NOTE } from './chat-request-recovery';
import { ChatTurnFeedback } from './chat-turn-feedback';

const ownerId = '00000000-0000-4000-8000-000000000001';
const conversationId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
function persistence(status: string | null = 'cancelled') {
  return {
    kind: 'application-chat-persistence',
    resolveAgent: vi.fn(async () => ({ id: ownerId })),
    getConversation: vi.fn(async () => ({
      id: conversationId,
      metadata: {},
      title: 'Saved chat',
      isPrimary: false,
      archivedAt: null,
    })),
    markConversationRead: vi.fn(),
    listMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
    getTaskStatus: vi.fn(async () => status),
    countActiveTasks: vi.fn(async () => 0),
    listEnabledModels: vi.fn(async () => []),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  dependencies.config.RESTORE_REHEARSAL = false;
  dependencies.config.ASSISTANT_RELEASE_WRITES_PAUSED = false;
  dependencies.owner.mockResolvedValue({ formSessionScope: 'owner-session' });
  dependencies.authenticated.mockResolvedValue(true);
});
describe.each(['postgres', 'firestore'])('real recovery path in %s routing mode', (driver) => {
  it('traverses real feedback href, unchanged proxy, owner page and owner-bound status application', async () => {
    dependencies.config.PERSISTENCE_DRIVER = driver;
    const store = persistence();
    dependencies.readView.mockImplementation((id, query) =>
      getChatConversationView(store as unknown as ApplicationChatPersistence, id, query),
    );
    dependencies.readUpdates.mockImplementation((input) =>
      getChatUpdates(store as unknown as ApplicationChatPersistence, input),
    );
    const html = renderToStaticMarkup(
      <ChatTurnFeedback
        conversationId={conversationId}
        showError={false}
        error={null}
        note={{ text: CANCELLED_REQUEST_NOTE, retryable: false, taskId }}
        pollTrouble={null}
        canRetry
        onRetry={vi.fn()}
      />,
    );
    const href = html.match(/href="([^"]+task=[^"]+)"/)?.[1];
    expect(href).toBeDefined();
    const url = new URL(href ?? '', 'https://assistant.test');
    const gate = proxy(new NextRequest(url));
    expect(gate.headers.get('x-middleware-next')).toBe('1');
    expect(gate.headers.get('location')).toBeNull();
    const view = await renderChatConversation(conversationId, {
      task: url.searchParams.get('task') ?? undefined,
    });
    expect(renderToStaticMarkup(view)).toContain(`data-owner-conversation="${conversationId}"`);
    expect(dependencies.owner).toHaveBeenCalledOnce();
    const statusUrl = `https://assistant.test/api/chat/status?conversationId=${conversationId}&taskId=${taskId}`;
    expect(proxy(new NextRequest(statusUrl)).headers.get('x-middleware-next')).toBe('1');
    const result = await GET(new Request(statusUrl));
    expect(result.status).toBe(200);
    expect((await result.json()).taskStatus).toBe('cancelled');
    expect(store.getTaskStatus).toHaveBeenCalledWith(ownerId, conversationId, taskId);
  });
  it('retains release/rehearsal and owner rejection before data reads', async () => {
    dependencies.config.PERSISTENCE_DRIVER = driver;
    const url = `https://assistant.test/chat/${conversationId}?task=${taskId}`;
    dependencies.config.ASSISTANT_RELEASE_WRITES_PAUSED = true;
    expect(proxy(new NextRequest(url)).status).toBe(503);
    dependencies.config.ASSISTANT_RELEASE_WRITES_PAUSED = false;
    dependencies.config.RESTORE_REHEARSAL = true;
    expect(proxy(new NextRequest(url)).status).toBe(503);
    dependencies.owner.mockRejectedValueOnce(new Error('owner required'));
    await expect(renderChatConversation(conversationId, { task: taskId })).rejects.toThrow(
      'owner required',
    );
    expect(dependencies.readView).not.toHaveBeenCalled();
    dependencies.authenticated.mockResolvedValueOnce(false);
    expect(
      (
        await GET(
          new Request(
            `https://assistant.test/api/chat/status?conversationId=${conversationId}&taskId=${taskId}`,
          ),
        )
      ).status,
    ).toBe(401);
    expect(dependencies.readUpdates).not.toHaveBeenCalled();
  });
});
it('missing or foreign authoritative task binding returns 404 before reading messages', async () => {
  const store = persistence(null);
  dependencies.readUpdates.mockImplementation((input) =>
    getChatUpdates(store as unknown as ApplicationChatPersistence, input),
  );
  const result = await GET(
    new Request(
      `https://assistant.test/api/chat/status?conversationId=${conversationId}&taskId=${taskId}`,
    ),
  );
  expect(result.status).toBe(404);
  expect(store.listMessages).not.toHaveBeenCalled();
  expect(store.getTaskStatus).toHaveBeenCalledWith(ownerId, conversationId, taskId);
});
