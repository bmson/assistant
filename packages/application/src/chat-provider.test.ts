import { loadConfig, resetConfigForTest } from '@assistant/config';
import type { ModelRouter } from '@assistant/core/model-router';
import type { ApplicationChatPersistence } from '@assistant/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleChatTurn } from './chat-turn.js';

const AGENT = '00000000-0000-4000-8000-00000000000a';
const CONVERSATION = '00000000-0000-4000-8000-00000000000c';
const MESSAGE = '00000000-0000-4000-8000-00000000000d';

function request() {
  return new Request('https://assistant.example/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: CONVERSATION,
      messages: [{ id: MESSAGE, role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
    }),
  });
}

function dependencies(route: ReturnType<typeof vi.fn>, modelOverride: string | null = null) {
  const chat = {
    kind: 'application-chat-persistence',
    resolveAgent: async () => ({
      id: AGENT,
      name: 'Assistant',
      email: 'assistant@example.com',
      timezone: 'UTC',
    }),
    getConversation: async () => ({
      id: CONVERSATION,
      agentId: AGENT,
      title: 'Existing chat',
      archivedAt: null,
      metadata: {},
      modelOverride,
    }),
    admitChatTurn: vi.fn(async () => ({
      kind: 'cancelled_before_admission' as const,
      created: false,
      task: { id: '00000000-0000-4000-8000-000000000099', status: 'cancelled' },
      status: 'cancelled' as const,
      effectStatus: 'not_started' as const,
    })),
  } as unknown as ApplicationChatPersistence;
  const router = { route } as unknown as ModelRouter;
  return { router, chat };
}

afterEach(() => resetConfigForTest());

describe('chat provider preflight', () => {
  it('uses the selected model route instead of requiring the legacy Vertex environment fields', async () => {
    const route = vi.fn(async () => ({ ok: true as const, modelId: 'vertex:gemini-2.5-flash' }));
    const deps = dependencies(route);
    const config = loadConfig({
      LLM_PROVIDER: 'vertex',
      VERTEX_PROJECT: 'customer-project',
      VERTEX_LOCATION: 'global',
      OPENROUTER_API_KEY: '',
    });
    const response = await handleChatTurn(request(), { ...deps, config });
    expect(response.status).toBe(409);
    expect(route).toHaveBeenCalledWith('draft', {
      taskId: undefined,
      modelOverride: undefined,
      modelOverrideResolved: true,
    });
  });

  it('returns 503 before admission when the effective route cannot be resolved', async () => {
    const route = vi.fn(async () => {
      throw new Error('No model connection serves openrouter/legacy-model');
    });
    const deps = dependencies(route);
    const config = loadConfig({
      LLM_PROVIDER: 'vertex',
      VERTEX_PROJECT: '',
      VERTEX_LOCATION: '',
      OPENROUTER_API_KEY: 'irrelevant-key',
    });
    const response = await handleChatTurn(request(), { ...deps, config });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'not_configured' });
    expect(
      (deps.chat as unknown as { admitChatTurn: ReturnType<typeof vi.fn> }).admitChatTurn,
    ).not.toHaveBeenCalled();
  });

  it('returns a generic setup error when the legacy route has no configured connection', async () => {
    const route = vi.fn(async () => {
      throw new Error('No model connection serves minimax/minimax-m2.7');
    });
    const deps = dependencies(route);
    const config = loadConfig({ OPENROUTER_API_KEY: '' });
    const response = await handleChatTurn(request(), { ...deps, config });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body).toMatchObject({
      error: expect.stringContaining('selected model route could not be verified'),
      code: 'not_configured',
    });
    expect(body.error).not.toContain('OPENROUTER_API_KEY');
  });

  it('honors a valid conversation model override when the base legacy provider is absent', async () => {
    const route = vi.fn(async () => ({ ok: true as const, modelId: 'openai:gpt-4.1-mini' }));
    const deps = dependencies(route, 'openai:gpt-4.1-mini');
    const config = loadConfig({ OPENROUTER_API_KEY: '' });
    const response = await handleChatTurn(request(), { ...deps, config });
    expect(response.status).toBe(409);
    expect(route).toHaveBeenCalledWith('draft', {
      taskId: undefined,
      modelOverride: 'openai:gpt-4.1-mini',
      modelOverrideResolved: true,
    });
  });

  it('fails closed when stored provider policy cannot be refreshed without exposing secrets', async () => {
    const route = vi.fn(async () => {
      throw new Error('Model connection policy is unavailable; provider calls are paused');
    });
    const deps = dependencies(route);
    const config = loadConfig({ OPENROUTER_API_KEY: '' });
    const response = await handleChatTurn(request(), { ...deps, config });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body).toMatchObject({ code: 'not_configured' });
    expect(body.error).not.toContain('OPENROUTER_API_KEY');
    expect(body.error).toContain('selected model route');
  });

  it('preserves a budget outcome from the selected route instead of converting it to setup failure', async () => {
    const route = vi.fn(async () => ({
      ok: false as const,
      decision: { mode: 'block' as const, reason: 'daily budget exhausted' },
    }));
    const deps = dependencies(route);
    const config = loadConfig({ OPENROUTER_API_KEY: '' });
    const response = await handleChatTurn(request(), { ...deps, config });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'chat_turn_cancelled_before_admission' });
    expect(
      (deps.chat as unknown as { admitChatTurn: ReturnType<typeof vi.fn> }).admitChatTurn,
    ).toHaveBeenCalledTimes(1);
  });
});
