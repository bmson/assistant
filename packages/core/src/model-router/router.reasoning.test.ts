import type { Db } from '@assistant/db';
import type { CostRepository, ModelRoutingRepository } from '@assistant/persistence';
import type { EmbeddingModel, LanguageModel } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ModelProvider } from './provider.js';
import { createOpenRouterModelProvider } from './provider.js';
import { isInteractiveRole, ModelRouter, modelCallTimeoutMs } from './router.js';

const stubs = vi.hoisted(() => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
  streamText: vi.fn(),
  reconcileReservation: vi.fn(async () => {}),
  releaseReservation: vi.fn(async () => {}),
  reserveCost: vi.fn(async () => ({ ok: true as const, reservationId: 'reservation-1' })),
  beginCostAttempt: vi.fn(async () => true),
  markCostAttemptUnknown: vi.fn(async () => {}),
}));

vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => ({ chat: vi.fn(), textEmbeddingModel: vi.fn() }),
}));

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateObject: stubs.generateObject,
  generateText: stubs.generateText,
  streamText: stubs.streamText,
}));

vi.mock('../cost.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cost.js')>()),
  reconcileReservation: stubs.reconcileReservation,
  releaseReservation: stubs.releaseReservation,
  reserveCost: stubs.reserveCost,
  beginCostAttempt: stubs.beginCostAttempt,
  markCostAttemptUnknown: stubs.markCostAttemptUnknown,
}));

function provider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    kind: 'openrouter',
    assertModelId: vi.fn(),
    chat: vi.fn(() => ({}) as LanguageModel),
    textEmbeddingModel: vi.fn(() => ({}) as EmbeddingModel),
    canDisableReasoning: vi.fn(() => true),
    optionsFor: vi.fn(() => undefined),
    embeddingOptions: vi.fn(() => undefined),
    cacheHint: vi.fn(() => undefined),
    normalizeUsage: vi.fn(() => ({})),
    ...overrides,
  };
}

const db = {
  insert: () => ({ values: () => ({ returning: async () => [{ id: 'call-1' }] }) }),
} as unknown as Db;

/** A router whose routing decision is fixed, so only the call shape is under test. */
function routerWith(modelProvider: ModelProvider, thinking = true, modelId = 'vendor/model-test') {
  const router = new ModelRouter(db, 'unused', 'off', modelProvider);
  vi.spyOn(router, 'route').mockResolvedValue({
    ok: true,
    model: {} as LanguageModel,
    modelId,
    degraded: false,
    thinking,
    decision: { mode: 'primary' },
    params: {},
    promptCostPerMTok: 1,
    completionCostPerMTok: 1,
  });
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.reserveCost.mockResolvedValue({ ok: true, reservationId: 'reservation-1' });
  stubs.beginCostAttempt.mockResolvedValue(true);
  stubs.generateText.mockResolvedValue({ text: 'answer', toolCalls: [], toolResults: [] });
  stubs.generateObject.mockResolvedValue({ object: { needsAction: false } });
});

describe('reasoning is spent only where it earns its latency', () => {
  it('rejects two truncated structured responses instead of exposing a partial value', async () => {
    const router = routerWith(provider(), false);
    stubs.generateObject.mockResolvedValue({
      object: { needsAction: false },
      finishReason: 'length',
    });
    await expect(
      router.object('classify', {
        prompt: 'x',
        maxRetries: 0,
        schema: z.object({ needsAction: z.boolean() }),
      }),
    ).rejects.toMatchObject({ name: 'TruncatedObjectError' });
    expect(stubs.generateObject).toHaveBeenCalledTimes(2);
    expect(stubs.releaseReservation).not.toHaveBeenCalled();
  });
  it('preserves a transport error when retrying a schema-valid truncated object', async () => {
    const router = routerWith(provider(), false);
    const transportError = new Error('Provider connection failed');
    stubs.generateObject
      .mockResolvedValueOnce({ object: { needsAction: false }, finishReason: 'length' })
      .mockRejectedValueOnce(transportError);
    await expect(
      router.object('classify', {
        prompt: 'x',
        maxRetries: 0,
        schema: z.object({ needsAction: z.boolean() }),
      }),
    ).rejects.toBe(transportError);
    expect(stubs.generateObject).toHaveBeenCalledTimes(2);
    expect(stubs.releaseReservation).toHaveBeenCalledOnce();
  });
  it('reserves schema/tool overhead and disables implicit transport retries for screening', async () => {
    const router = routerWith(provider(), false);
    await router.generate('draft', {
      prompt: 'x',
      additionalInputTokens: 2_048,
      maxRetries: 0,
    });
    expect(stubs.generateText.mock.calls[0]?.[0].maxRetries).toBe(0);
    expect(stubs.reserveCost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ estimatedUsd: ((1 + 2_048 + 2_048) / 1_000_000) * 1.25 }),
    );
    await expect(
      router.generate('draft', { prompt: 'x', additionalInputTokens: -1 }),
    ).rejects.toThrow('additionalInputTokens');
    await expect(router.generate('draft', { prompt: 'x', maxRetries: 3 })).rejects.toThrow(
      'maxRetries',
    );
    expect(stubs.generateText).toHaveBeenCalledTimes(1);
  });
  it('adds structured schemas and tool schemas to the prepared input reservation', async () => {
    const router = routerWith(provider(), false);
    await router.object('classify', {
      prompt: 'x',
      maxRetries: 0,
      schema: z.object({ value: z.string() }),
    });
    const baselineObjectCall = stubs.reserveCost.mock.calls[0] as unknown as
      | [unknown, { estimatedUsd: number }]
      | undefined;
    const baselineObjectEstimate = baselineObjectCall?.[1].estimatedUsd ?? 0;
    stubs.reserveCost.mockClear();
    await router.object('classify', {
      prompt: 'x',
      maxRetries: 0,
      schema: z.object(
        Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`field${index}`, z.string()])),
      ),
    });
    const objectCall = stubs.reserveCost.mock.calls[0] as unknown as
      | [unknown, { estimatedUsd: number }]
      | undefined;
    const objectEstimate = objectCall?.[1].estimatedUsd;
    expect(objectEstimate).toBeGreaterThan(baselineObjectEstimate);

    stubs.reserveCost.mockClear();
    await router.step('draft', {
      prompt: 'x',
      maxRetries: 0,
      tools: {
        'large.lookup': {
          description: 'Lookup a record',
          inputSchema: z.object({ value: z.string() }),
        },
      } as never,
    });
    const baselineStepCall = stubs.reserveCost.mock.calls[0] as unknown as
      | [unknown, { estimatedUsd: number }]
      | undefined;
    const baselineStepEstimate = baselineStepCall?.[1].estimatedUsd ?? 0;
    stubs.reserveCost.mockClear();
    await router.step('draft', {
      prompt: 'x',
      maxRetries: 0,
      tools: {
        'large.lookup': {
          description: 'Lookup a record with a detailed input contract',
          inputSchema: z.object(
            Object.fromEntries(
              Array.from({ length: 18 }, (_, index) => [`field${index}`, z.string()]),
            ),
          ),
        },
      } as never,
    });
    const stepCall = stubs.reserveCost.mock.calls[0] as unknown as
      | [unknown, { estimatedUsd: number }]
      | undefined;
    expect(stepCall?.[1].estimatedUsd).toBeGreaterThan(baselineStepEstimate);
  });
  it('turns reasoning off for a classifier, and does not reserve headroom it will not use', async () => {
    const optionsFor = vi.fn(() => undefined);
    const router = routerWith(provider({ optionsFor }));

    await router.object('classify', {
      schema: z.object({ needsAction: z.boolean() }),
      prompt: 'x',
    });

    expect(optionsFor).toHaveBeenCalledWith({
      modelId: 'vendor/model-test',
      reasoning: 'disabled',
    });
    // classify's visible budget is 512; headroom would have made it 4608.
    expect(stubs.generateObject.mock.calls[0]?.[0].maxOutputTokens).toBe(512);
  });

  it('turns reasoning off for the streamed owner reply', async () => {
    const optionsFor = vi.fn(() => undefined);
    const router = routerWith(provider({ optionsFor }));
    stubs.streamText.mockReturnValue({ toUIMessageStream: vi.fn(), text: Promise.resolve('hi') });

    await router.stream('draft', { prompt: 'hello' });

    expect(optionsFor).toHaveBeenCalledWith({
      modelId: 'vendor/model-test',
      reasoning: 'disabled',
    });
    expect(stubs.streamText.mock.calls[0]?.[0].maxOutputTokens).toBe(2_048);
  });

  it('keeps reasoning for a tool-carrying step, whatever role it runs under', async () => {
    const optionsFor = vi.fn(() => undefined);
    const router = routerWith(provider({ optionsFor }));

    // 'draft' is what roleForTask returns for reply-shaped tasks, and those
    // still reach the executor with tools attached. Removing headroom here can
    // exhaust the budget before the tool call is emitted.
    await router.step('draft', { prompt: 'hello', tools: {} });

    expect(optionsFor).toHaveBeenCalledWith({ modelId: 'vendor/model-test', reasoning: 'enabled' });
    expect(stubs.generateText.mock.calls[0]?.[0].maxOutputTokens).toBe(2_048 + 4_096);
  });

  it('keeps reasoning for the deliberating roles even with no tools', async () => {
    const optionsFor = vi.fn(() => undefined);
    const router = routerWith(provider({ optionsFor }));

    await router.generate('reason', { prompt: 'think' });

    expect(optionsFor).toHaveBeenCalledWith({ modelId: 'vendor/model-test', reasoning: 'enabled' });
  });

  it('sends no reasoning parameter at all for a model that cannot reason', async () => {
    const optionsFor = vi.fn(() => undefined);
    const router = routerWith(provider({ optionsFor }), false);

    await router.generate('reason', { prompt: 'think' });

    // Not 'disabled': naming a parameter the upstream pool does not implement
    // narrows OpenRouter's provider choice under require_parameters.
    expect(optionsFor).toHaveBeenCalledWith({
      modelId: 'vendor/model-test',
      reasoning: 'unsupported',
    });
  });
});

describe('OpenRouter reasoning parameters', () => {
  it.each([
    'google/gemini-3.8-flash',
    'minimax/minimax-m2.7',
    'openai/gpt-oss-120b',
    'vendor/new-thinking-model',
    'moonshotai/kimi-k2-thinking',
  ])('keeps mandatory or unknown reasoning enabled for streamed replies on %s', async (modelId) => {
    const router = routerWith(createOpenRouterModelProvider('unused'), true, modelId);
    stubs.streamText.mockReturnValue({ toUIMessageStream: vi.fn(), text: Promise.resolve('hi') });

    await router.stream('draft', { prompt: 'hello' });

    expect(stubs.streamText.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 2_048 + 4_096,
      providerOptions: { openrouter: { reasoning: { max_tokens: 4_096 } } },
    });
    // Reservation must cover mandatory reasoning as well as the visible answer.
    expect(stubs.reserveCost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ estimatedUsd: ((2 + 2_048 + 4_096) / 1_000_000) * 1.25 }),
    );
  });

  it('preserves required reasoning in classification and retried queued replies', async () => {
    const router = routerWith(createOpenRouterModelProvider('unused'), true, 'openai/gpt-oss-120b');
    await router.object('classify', {
      prompt: 'classify',
      schema: z.object({ needsAction: z.boolean() }),
    });
    await router.generate('draft', { prompt: 'retry' });

    expect(stubs.generateObject.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 512 + 4_096,
      providerOptions: { openrouter: { reasoning: { max_tokens: 4_096 } } },
    });
    expect(stubs.generateText.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 2_048 + 4_096,
      providerOptions: { openrouter: { reasoning: { max_tokens: 4_096 } } },
    });
  });

  it.each([
    'deepseek/deepseek-v4-pro-0813',
    'deepseek/deepseek-v4-flash-0731',
    'moonshotai/kimi-k2.5',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k3',
    'openai/gpt-6-luna',
  ])('disables optional reasoning on lightweight calls to %s', async (modelId) => {
    const router = routerWith(createOpenRouterModelProvider('unused'), true, modelId);
    await router.generate('draft', { prompt: 'hello' });
    expect(stubs.generateText.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 2_048,
      providerOptions: { openrouter: { reasoning: { enabled: false } } },
    });
  });

  it.each(['openai/gpt-6.1-sol', 'openai/gpt-6-luna'])(
    'uses supported effort and bills reasoning headroom for tool calls on %s',
    async (modelId) => {
      const router = routerWith(createOpenRouterModelProvider('unused'), true, modelId);
      await router.step('reason', { prompt: 'check the calendar', tools: {} });
      expect(stubs.generateText.mock.calls[0]?.[0]).toMatchObject({
        providerOptions: { openrouter: { reasoning: { effort: 'medium' } } },
      });
      expect(stubs.generateText.mock.calls[0]?.[0].maxOutputTokens).toBeGreaterThan(4_096);
    },
  );

  it('never disables mandatory Sol reasoning for a lightweight reply', async () => {
    const openrouter = createOpenRouterModelProvider('unused');
    expect(openrouter.canDisableReasoning?.('openai/gpt-6.1-sol')).toBe(false);
    const router = routerWith(openrouter, true, 'openai/gpt-6.1-sol');
    await router.generate('draft', { prompt: 'hello' });
    expect(stubs.generateText.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 2_048 + 4_096,
      providerOptions: { openrouter: { reasoning: { effort: 'medium' } } },
    });
    expect(openrouter.canDisableReasoning?.('openai/gpt-6-luna:unknown-variant')).toBe(false);
  });

  it('keeps reasoning when a provider has not declared an off switch', async () => {
    const optionsFor = vi.fn(() => undefined);
    const router = routerWith(provider({ optionsFor, canDisableReasoning: undefined }));
    await router.generate('draft', { prompt: 'hello' });
    expect(optionsFor).toHaveBeenCalledWith({ modelId: 'vendor/model-test', reasoning: 'enabled' });
  });

  it('maps each mode to a distinct request, silence included', () => {
    const openrouter = createOpenRouterModelProvider('unused');
    expect(openrouter.optionsFor({ reasoning: 'enabled' })).toEqual({
      openrouter: { reasoning: { max_tokens: 4_096 } },
    });
    expect(openrouter.optionsFor({ reasoning: 'disabled' })).toEqual({
      openrouter: { reasoning: { enabled: false } },
    });
    expect(openrouter.optionsFor({ reasoning: 'unsupported' })).toBeUndefined();
  });
});

describe('per-call deadlines', () => {
  it('gives an interactive call a deadline a person would wait out', () => {
    expect(modelCallTimeoutMs('classify', false)).toBe(30_000);
    expect(modelCallTimeoutMs('draft', false)).toBe(60_000);
  });

  it('leaves the queued tool-calling path on the full budget it was tuned for', () => {
    // The 150s figure came from goal-session step prompts: long, unattended,
    // and observed succeeding at 97-118s upstream.
    expect(modelCallTimeoutMs('draft', true)).toBe(150_000);
    expect(modelCallTimeoutMs('classify', true)).toBe(150_000);
    expect(modelCallTimeoutMs('reason', false)).toBe(150_000);
    expect(modelCallTimeoutMs('plan', false)).toBe(150_000);
    expect(modelCallTimeoutMs(undefined, false)).toBe(150_000);
  });
});

const roleRow = {
  role: 'draft',
  primaryModel: 'vendor/model-test',
  fallbackModel: 'vendor/fallback',
  params: {},
  updatedAt: new Date(),
};
const modelRow = {
  id: 'vendor/model-test',
  label: 'Test',
  enabled: true,
  capabilities: { thinking: false },
  promptCostPerMTok: '1',
  completionCostPerMTok: '1',
  latencyClass: 'fast',
  updatedAt: new Date(),
};

function repository() {
  const role = vi.fn(async () => roleRow);
  const model = vi.fn(async () => modelRow);
  const totals = vi.fn(async () => ({
    dailySpentUsd: 0,
    monthlySpentUsd: 0,
    heldUsd: 0,
    dailyLimitUsd: 100,
    monthlyLimitUsd: 100,
    softPct: 0.8,
  }));
  const costs = { kind: 'cost-repository', totals } as unknown as CostRepository;
  const repo = {
    kind: 'model-routing-repository',
    costs,
    taskBudget: vi.fn(async () => null),
    conversationOverride: vi.fn(async () => null),
    role,
    model,
    recordCall: vi.fn(async () => 'call-1'),
    recordAudit: vi.fn(async () => {}),
  } as unknown as ModelRoutingRepository;
  return { repo, role, model, totals };
}

describe('routing configuration is never cached', () => {
  it('re-reads the role and model rows on every call', async () => {
    // Deliberate. These rows are a safety control as well as configuration:
    // route() refuses a disabled model so a retired provider is never billed,
    // and the owner expects a model switch to take on the next message. A TTL
    // makes both "eventually", and the router runs in more than one process,
    // so nothing in-process can invalidate a change made elsewhere.
    const { repo, role, model } = repository();
    const router = new ModelRouter(repo, 'unused', 'off', provider());

    await router.route('draft');
    await router.route('draft');
    await router.route('draft');

    expect(role).toHaveBeenCalledTimes(3);
    expect(model).toHaveBeenCalledTimes(3);
  });

  it('re-reads spend too, which the calls being routed are themselves changing', async () => {
    const { repo, totals } = repository();
    const router = new ModelRouter(repo, 'unused', 'off', provider());

    await router.route('draft');
    await router.route('draft');

    expect(totals).toHaveBeenCalledTimes(2);
  });

  it('does not re-read an override the caller already resolved', async () => {
    const { repo } = repository();
    const conversationOverride = repo.conversationOverride as ReturnType<typeof vi.fn>;
    const router = new ModelRouter(repo, 'unused', 'off', provider());

    await router.route('draft', { taskId: 'task-1', modelOverrideResolved: true });
    expect(conversationOverride).not.toHaveBeenCalled();

    await router.route('draft', { taskId: 'task-1' });
    expect(conversationOverride).toHaveBeenCalledTimes(1);
  });
});

describe('provider routing for calls a person is waiting on', () => {
  it('asks for a fast upstream on the interactive roles only', () => {
    expect(isInteractiveRole('draft')).toBe(true);
    expect(isInteractiveRole('classify')).toBe(true);
    // Queued work would rather have the cheapest upstream than the quickest.
    expect(isInteractiveRole('reason')).toBe(false);
    expect(isInteractiveRole('plan')).toBe(false);
    expect(isInteractiveRole('batch')).toBe(false);
    expect(isInteractiveRole('embed')).toBe(false);
  });

  it('passes that choice to the provider when routing', async () => {
    const chat = vi.fn(() => ({}) as LanguageModel);
    const { repo } = repository();
    const router = new ModelRouter(repo, 'unused', 'off', provider({ chat }));

    await router.route('draft');
    expect(chat).toHaveBeenCalledWith(
      'vendor/model-test',
      expect.objectContaining({ interactive: true }),
    );

    await router.route('batch');
    expect(chat).toHaveBeenLastCalledWith(
      'vendor/model-test',
      expect.objectContaining({ interactive: false }),
    );
  });
});
