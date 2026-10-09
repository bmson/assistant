import { loadConfig, resetConfigForTest } from '@assistant/config';
import type { ModelRouter } from '@assistant/core/model-router';
import type {
  ApplicationChatPersistence,
  CardRefreshRepository,
  ExecutionPersistence,
} from '@assistant/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleChatTurn } from './chat-turn.js';

afterEach(() => resetConfigForTest());

describe('saved-card refresh chat routing', () => {
  it('routes a Firestore-backed command without requiring SQL', async () => {
    const agentId = '11111111-1111-4111-8111-111111111111';
    const conversationId = '22222222-2222-4222-8222-222222222222';
    const cardId = '33333333-3333-4333-8333-333333333333';
    const taskId = '44444444-4444-4444-8444-444444444444';
    const operationId = '99999999-9999-4999-8999-999999999999';
    const now = new Date('2026-09-19T00:00:00.000Z');
    const requestRefresh = vi.fn(async () => ({
      ok: true as const,
      taskId,
      queueGeneration: 0,
      created: true,
      dispatch: 'outbox' as const,
      refreshState: 'refreshing' as const,
    }));
    const cardRefresh = {
      kind: 'card-refresh-repository' as const,
      request: requestRefresh,
    } satisfies CardRefreshRepository;
    const conversation = {
      id: conversationId,
      agentId,
      channel: 'chat',
      title: 'Saved card',
      trust: 'owner',
      modelOverride: null,
      isPrimary: true,
      metadata: {},
      archivedAt: null,
      lastReadAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const chat = {
      resolveAgent: vi.fn(async () => ({ id: agentId })),
      getConversation: vi.fn(async () => conversation),
      admitChatTurn: vi.fn(async (input) => {
        const task = {
          id: 'admitted-task',
          agentId,
          conversationId,
          status: 'running',
          trigger: { source: 'chat', payload: { text: input.text } },
        };
        return {
          created: true,
          task,
          lease: { ...task, leaseToken: 'lease', lockedUntil: new Date(now.getTime() + 60_000) },
          message: {
            id: '55555555-5555-4555-8555-555555555555',
            conversationId,
            taskId: task.id,
            role: 'user',
            origin: 'owner',
            parts: [{ type: 'text', text: input.text }],
            text: input.text,
            channelMessageId: null,
            embedding: null,
            hiddenAt: null,
            createdAt: now,
          },
        };
      }),
      appendOwned: vi.fn(async (_agentId, input) => ({
        id: '55555555-5555-4555-8555-555555555555',
        ...input,
        taskId: null,
        channelMessageId: null,
        embedding: null,
        hiddenAt: null,
        createdAt: now,
      })),
      completeDirectChatTask: vi.fn(async () => true),
    } as unknown as ApplicationChatPersistence;
    const request = new Request('https://assistant.example/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        conversationId,
        clientOperationId: operationId,
        messages: [
          {
            id: operationId,
            role: 'user',
            parts: [{ type: 'text', text: `Refresh saved card ${cardId}` }],
          },
        ],
      }),
    });
    const response = await handleChatTurn(request, {
      config: loadConfig({ OPENROUTER_API_KEY: 'test-key' }),
      router: {
        route: vi.fn(async () => ({ ok: true, modelId: 'test/model' })),
      } as unknown as ModelRouter,
      chat,
      persistence: { cardRefresh } as unknown as ExecutionPersistence & {
        cardRefresh: CardRefreshRepository;
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-async-task')).toBe('admitted-task');
    expect(requestRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ agentId, cardId, conversationId, operationId }),
    );
  });
});
