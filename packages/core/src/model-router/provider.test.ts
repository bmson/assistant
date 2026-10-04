import type { Db } from '@assistant/db';
import type { EmbeddingModel, LanguageModel } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConfiguredModelProvider,
  createOpenRouterModelProvider,
  type ModelProvider,
  normalizeOpenRouterUsage,
} from './provider.js';
import { EMBEDDING_DIMENSIONS, ModelRouter } from './router.js';

const stubs = vi.hoisted(() => ({
  openRouterChat: vi.fn(),
  createVertex: vi.fn(),
  embedMany: vi.fn(),
  generateObject: vi.fn(),
  generateText: vi.fn(),
  reconcileReservation: vi.fn(async () => {}),
  releaseReservation: vi.fn(async () => {}),
  reserveCost: vi.fn(async () => ({ ok: true as const, reservationId: 'reservation-1' })),
}));

vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => ({ chat: stubs.openRouterChat, textEmbeddingModel: vi.fn() }),
}));

vi.mock('@ai-sdk/google-vertex', () => ({
  createVertex: stubs.createVertex,
}));

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  embedMany: stubs.embedMany,
  generateObject: stubs.generateObject,
  generateText: stubs.generateText,
}));

vi.mock('../cost.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cost.js')>()),
  reconcileReservation: stubs.reconcileReservation,
  releaseReservation: stubs.releaseReservation,
  reserveCost: stubs.reserveCost,
}));

function provider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    kind: 'vertex',
    assertModelId: vi.fn(),
    chat: vi.fn(() => ({}) as LanguageModel),
    textEmbeddingModel: vi.fn(() => ({}) as EmbeddingModel),
    optionsFor: vi.fn(() => ({ vertex: { thinking: { budget: 1 } } })),
    embeddingOptions: vi.fn(() => undefined),
    cacheHint: vi.fn(() => undefined),
    normalizeUsage: vi.fn(() => ({})),
    ...overrides,
  };
}

function routerWithProvider(
  modelProvider: ModelProvider,
  db: Db = {
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'call-1' }] }) }),
  } as unknown as Db,
) {
  const router = new ModelRouter(db, 'unused', 'off', modelProvider);
  vi.spyOn(router, 'route').mockResolvedValue({
    ok: true,
    model: {} as LanguageModel,
    modelId: 'vertex/gemini-test',
    degraded: false,
    thinking: true,
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
});

describe('injected model providers', () => {
  it('adds evaluation price ceilings without changing normal provider routing', () => {
    const normal = createOpenRouterModelProvider('unused');
    normal.chat('openai/gpt-6.1-sol', { interactive: true });
    expect(stubs.openRouterChat).toHaveBeenLastCalledWith('openai/gpt-6.1-sol', {
      provider: { require_parameters: true, sort: 'latency' },
    });
    const evaluation = createOpenRouterModelProvider('unused', {
      maxPrice: { prompt: 2, completion: 10, request: 0 },
    });
    evaluation.chat('openai/gpt-6.1-sol');
    expect(stubs.openRouterChat).toHaveBeenLastCalledWith('openai/gpt-6.1-sol', {
      provider: { require_parameters: true, max_price: { prompt: 2, completion: 10, request: 0 } },
    });
    expect(() =>
      createOpenRouterModelProvider('unused', { maxPrice: { prompt: NaN, completion: 10 } }),
    ).toThrow('price ceilings');
  });
  it('composes only the explicitly selected application provider', () => {
    const config = {
      LLM_PROVIDER: 'openrouter' as const,
      OPENROUTER_API_KEY: 'fake',
      VERTEX_PROJECT: '',
      VERTEX_LOCATION: '',
    };
    expect(createConfiguredModelProvider(config).kind).toBe('openrouter');
    expect(stubs.createVertex).not.toHaveBeenCalled();
    expect(() => createConfiguredModelProvider({ ...config, LLM_PROVIDER: 'vertex' })).toThrow(
      'project',
    );
    stubs.createVertex.mockReturnValue({ languageModel: vi.fn(), embeddingModel: vi.fn() });
    expect(
      createConfiguredModelProvider({
        ...config,
        LLM_PROVIDER: 'vertex',
        VERTEX_PROJECT: 'customer-project',
        VERTEX_LOCATION: 'global',
      }).kind,
    ).toBe('vertex');
    expect(stubs.createVertex).toHaveBeenCalledWith({
      project: 'customer-project',
      location: 'global',
      apiKey: '',
    });
    expect(
      createConfiguredModelProvider({
        ...config,
        LLM_PROVIDER: 'vertex',
        VERTEX_PROJECT: 'customer-project',
        VERTEX_LOCATION: 'global',
        FIRESTORE_EMBEDDING_SPACE:
          '{"provider":"vertex","model":"gemini-embedding-001","dimensions":768,"revision":"v1"}',
      }).embeddingOptions(),
    ).toEqual({ vertex: { outputDimensionality: 768 } });
    expect(() =>
      createConfiguredModelProvider({
        ...config,
        LLM_PROVIDER: 'vertex',
        VERTEX_PROJECT: 'customer-project',
        VERTEX_LOCATION: 'global',
        FIRESTORE_EMBEDDING_SPACE:
          '{"provider":"openrouter","model":"other","dimensions":768,"revision":"v1"}',
      }),
    ).toThrow('Vertex Firestore embedding space');
  });

  it('does not record Vertex request IDs as OpenRouter generation IDs', async () => {
    const values = vi.fn(() => ({ returning: async () => [{ id: 'call-1' }] }));
    const db = { insert: () => ({ values }) } as unknown as Db;
    const router = routerWithProvider(
      provider({
        normalizeUsage: () => ({ inputTokens: 2, outputTokens: 1, generationId: 'vertex-call' }),
      }),
      db,
    );
    stubs.generateText.mockResolvedValue({ text: 'answer', response: { id: 'vertex-call' } });
    await router.generate('draft', { prompt: 'hello' });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ openrouterGenerationId: null }));
  });

  it('does not confuse OpenRouter google models with future Vertex identities', () => {
    const openrouter = createOpenRouterModelProvider('unused');
    expect(() => openrouter.assertModelId('google/gemini-3.8-flash')).not.toThrow();
    expect(() => openrouter.assertModelId('vertex/gemini-2.5')).toThrow('identity');
  });

  it('creates Vertex only with explicit ADC project and location, and keeps identities qualified', async () => {
    const vertexModel = { modelId: 'gemini-2.5-flash' } as LanguageModel;
    const embeddingModel = { modelId: 'text-embedding-005' } as EmbeddingModel;
    stubs.createVertex.mockReturnValue({
      languageModel: vi.fn(() => vertexModel),
      embeddingModel: vi.fn(() => embeddingModel),
    });

    const { createVertexModelProvider } = await import('./provider.js');
    const vertex = createVertexModelProvider({
      project: 'assistant-prod',
      location: 'us-central1',
    });

    expect(stubs.createVertex).toHaveBeenCalledWith({
      project: 'assistant-prod',
      location: 'us-central1',
      apiKey: '',
    });
    expect(vertex.chat('vertex:gemini-2.5-flash')).toBe(vertexModel);
    expect(vertex.textEmbeddingModel('vertex:text-embedding-005')).toBe(embeddingModel);
    expect(vertex.optionsFor({ reasoning: 'enabled' })).toEqual({
      vertex: { thinkingConfig: { thinkingBudget: 4_096 } },
    });
    // A capable model is told explicitly to stay quiet; silence would leave
    // Vertex's own default (think freely) in charge.
    expect(vertex.optionsFor({ reasoning: 'disabled' })).toEqual({
      vertex: { thinkingConfig: { thinkingBudget: 0 } },
    });
    expect(vertex.optionsFor({ reasoning: 'unsupported' })).toBeUndefined();
    expect(
      vertex.optionsFor({ reasoning: 'enabled', modelId: 'vertex/gemini-3.1-flash-lite' }),
    ).toEqual({ vertex: { thinkingConfig: { thinkingLevel: 'high' } } });
    expect(
      vertex.optionsFor({ reasoning: 'disabled', modelId: 'vertex/gemini-3.1-flash-lite' }),
    ).toEqual({ vertex: { thinkingConfig: { thinkingLevel: 'minimal' } } });
    expect(vertex.embeddingOptions()).toEqual({ vertex: { outputDimensionality: 1_536 } });
    expect(() => vertex.assertModelId('vertex:gemini-3.8-flash')).not.toThrow();
    expect(() => vertex.assertModelId('vertex:text-embedding-005')).not.toThrow();
    expect(() => vertex.assertModelId('vertex:unknown-vendor/model')).toThrow('bare');
    expect(() => vertex.assertModelId('vertex:https://example.test/model')).toThrow('bare');
    expect(() => vertex.assertModelId('vertex:gemini 3.8')).toThrow('bare');
    expect(() => vertex.assertModelId('google/gemini-3.8-flash')).toThrow('vertex-qualified');
  });

  it('caps gemini-embedding-001 at one input so SDK batching makes single-input requests', async () => {
    const calls: string[][] = [];
    const rawModel = {
      modelId: 'gemini-embedding-001',
      specificationVersion: 'v4',
      provider: 'vertex',
      maxEmbeddingsPerCall: 250,
      supportsParallelCalls: false,
      doEmbed: async ({ values }: { values: string[] }) => {
        calls.push(values);
        return {
          embeddings: values.map(() => new Array(1_536).fill(0.01)),
          usage: { tokens: values.length },
        };
      },
    } as unknown as EmbeddingModel & { maxEmbeddingsPerCall?: number };
    stubs.createVertex.mockReturnValue({
      languageModel: vi.fn(),
      embeddingModel: vi.fn(() => rawModel),
    });
    const { createVertexModelProvider } = await import('./provider.js');
    const vertex = createVertexModelProvider({
      project: 'assistant-prod',
      location: 'us-central1',
    });
    const model = vertex.textEmbeddingModel('vertex:gemini-embedding-001') as EmbeddingModel & {
      maxEmbeddingsPerCall: number;
      doEmbed: (input: { values: string[] }) => Promise<{ embeddings: number[][] }>;
    };
    const actual = await vi.importActual<typeof import('ai')>('ai');
    const { embeddings } = await actual.embedMany({ model, values: ['first', 'second'] });
    expect(calls).toEqual([['first'], ['second']]);
    expect(embeddings).toHaveLength(2);
    expect(embeddings.every((value) => value.length === 1_536)).toBe(true);
  });

  it('validates explicit project and location formats while allowing global', async () => {
    const { createVertexModelProvider } = await import('./provider.js');
    expect(() => createVertexModelProvider({ project: 'short', location: 'us-central1' })).toThrow(
      'project ID',
    );
    expect(() =>
      createVertexModelProvider({ project: 'assistant-prod', location: 'default' }),
    ).toThrow('location');
    expect(() =>
      createVertexModelProvider({ project: 'assistant-prod', location: 'global' }),
    ).not.toThrow();
    expect(() =>
      createVertexModelProvider({
        project: 'assistant-prod',
        location: 'global',
        embeddingDimensions: 0,
      }),
    ).toThrow('embedding dimensions');
  });

  it('forces ADC even when the Vertex API-key environment setting exists', async () => {
    const { createVertexModelProvider } = await import('./provider.js');
    vi.stubEnv('GOOGLE_VERTEX_API_KEY', 'test-only-secret');
    try {
      createVertexModelProvider({ project: 'assistant-prod', location: 'us-central1' });
      expect(stubs.createVertex).toHaveBeenLastCalledWith({
        project: 'assistant-prod',
        location: 'us-central1',
        apiKey: '',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('preserves an explicitly reported zero USD cost', async () => {
    const modelProvider = provider({
      normalizeUsage: vi.fn(() => ({ inputTokens: 3, outputTokens: 2, costUsd: 0 })),
    });
    const router = routerWithProvider(modelProvider);
    const meter = (
      router as unknown as {
        meter(input: {
          role: string;
          modelId: string;
          latencyMs: number;
          event: Record<string, never>;
          reservationId: string;
          estimatedUsd: number;
          promptCostPerMTok: number;
          completionCostPerMTok: number;
        }): Promise<void>;
      }
    ).meter.bind(router);

    await meter({
      role: 'draft',
      modelId: 'vertex:gemini-test',
      latencyMs: 10,
      event: {},
      reservationId: 'reservation-1',
      estimatedUsd: 0.012345,
      promptCostPerMTok: 100,
      completionCostPerMTok: 100,
    });

    expect(stubs.reconcileReservation).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      expect.objectContaining({
        usd: 0,
        quantity: 5,
        evidence: expect.objectContaining({ basis: 'provider_reported', provider: 'vertex' }),
      }),
    );
  });

  it('falls through empty root metadata to final-step provider metadata', () => {
    expect(
      normalizeOpenRouterUsage({
        usage: { inputTokens: 2, outputTokens: 3 },
        providerMetadata: { openrouter: { usage: {} } },
        finalStep: {
          providerMetadata: { openrouter: { usage: { cost: 0.004 } } },
        },
      }).costUsd,
    ).toBe(0.004);
    expect(
      normalizeOpenRouterUsage({
        usage: { inputTokens: 2, outputTokens: 3 },
        providerMetadata: { openrouter: { usage: { cost: 0 } } },
        finalStep: {
          providerMetadata: { openrouter: { usage: { cost: 0.004 } } },
        },
      }).costUsd,
    ).toBe(0);
  });

  it.each([Number.NaN, 1.5, -1, 2_147_483_648])(
    'fails closed for invalid token telemetry (%s)',
    async (invalidInputTokens) => {
      const router = routerWithProvider(
        provider({
          normalizeUsage: vi.fn(() => ({ inputTokens: invalidInputTokens, outputTokens: 1 })),
        }),
      );
      const meter = (
        router as unknown as {
          meter(input: {
            role: string;
            modelId: string;
            latencyMs: number;
            event: Record<string, never>;
            reservationId: string;
            estimatedUsd: number;
            promptCostPerMTok: number;
            completionCostPerMTok: number;
          }): Promise<void>;
        }
      ).meter.bind(router);

      await meter({
        role: 'draft',
        modelId: 'vertex:gemini-test',
        latencyMs: 10,
        event: {},
        reservationId: 'reservation-1',
        estimatedUsd: 0.012345,
        promptCostPerMTok: 1,
        completionCostPerMTok: 1,
      });

      expect(stubs.reconcileReservation).toHaveBeenCalledWith(
        expect.anything(),
        'reservation-1',
        expect.objectContaining({ usd: 0.012345 }),
      );
      expect((stubs.reconcileReservation.mock.calls as unknown[][])[0]?.[2]).not.toHaveProperty(
        'quantity',
      );
    },
  );

  it('omits zero token quantity when an all-zero response uses the estimate', async () => {
    const router = routerWithProvider({
      ...provider(),
      normalizeUsage: vi.fn(() => ({ inputTokens: 0, outputTokens: 0 })),
    });
    const meter = (
      router as unknown as {
        meter(input: {
          role: string;
          modelId: string;
          latencyMs: number;
          event: Record<string, never>;
          reservationId: string;
          estimatedUsd: number;
          promptCostPerMTok: number;
          completionCostPerMTok: number;
        }): Promise<void>;
      }
    ).meter.bind(router);
    await meter({
      role: 'draft',
      modelId: 'vertex:gemini-test',
      latencyMs: 10,
      event: {},
      reservationId: 'reservation-1',
      estimatedUsd: 0.012345,
      promptCostPerMTok: 1,
      completionCostPerMTok: 1,
    });
    expect((stubs.reconcileReservation.mock.calls as unknown[][])[0]?.[2]).toEqual(
      expect.objectContaining({ usd: 0.012345 }),
    );
    expect((stubs.reconcileReservation.mock.calls as unknown[][])[0]?.[2]).not.toHaveProperty(
      'quantity',
    );
  });

  it('meters authoritative embedding provider metadata and does not invent usage', async () => {
    const normalizeUsage = vi.fn(() => ({ costUsd: 0.006 }));
    const modelProvider = provider({ normalizeUsage });
    let selectCount = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            selectCount += 1;
            return selectCount === 1
              ? [{ role: 'embed', primaryModel: 'vertex/text-embedding' }]
              : [{ id: 'vertex/text-embedding', promptCostPerMTok: '1' }];
          },
        }),
      }),
      insert: () => ({
        values: () => ({ returning: async () => [{ id: 'call-1' }] }),
      }),
    } as unknown as Db;
    const router = new ModelRouter(db, 'unused', 'off', modelProvider);
    (
      router as unknown as { meterWithoutRepeatingProviderWork: (input: unknown) => Promise<void> }
    ).meterWithoutRepeatingProviderWork = async (input) => {
      await (router as unknown as { meter(input: unknown): Promise<void> }).meter(input);
    };
    stubs.embedMany.mockResolvedValue({
      embeddings: [new Array(EMBEDDING_DIMENSIONS).fill(0)],
      providerMetadata: { vertex: { usage: { costUsd: 0.006 } } },
    });

    await router.embed(['hello']);
    expect(normalizeUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMetadata: { vertex: { usage: { costUsd: 0.006 } } },
        usage: undefined,
      }),
    );
    expect(stubs.reconcileReservation).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      expect.objectContaining({ usd: 0.006 }),
    );
  });

  it('does not use last-chunk provider cost for a multi-response embedding batch', async () => {
    const router = routerWithProvider(
      provider({
        normalizeUsage: vi.fn(() => ({ inputTokens: 10, outputTokens: 0, costUsd: 0.006 })),
      }),
    );
    const meter = (
      router as unknown as {
        meter(input: {
          role: string;
          modelId: string;
          latencyMs: number;
          event: { usage: { inputTokens: number; outputTokens: number }; responses: unknown[] };
          reservationId: string;
          estimatedUsd: number;
          promptCostPerMTok: number;
          completionCostPerMTok: number;
        }): Promise<void>;
      }
    ).meter.bind(router);

    await meter({
      role: 'embed',
      modelId: 'vertex:text-embedding-005',
      latencyMs: 10,
      event: { usage: { inputTokens: 10, outputTokens: 0 }, responses: [{}, {}] },
      reservationId: 'reservation-1',
      estimatedUsd: 0.012345,
      promptCostPerMTok: 1,
      completionCostPerMTok: 0,
    });

    expect(stubs.reconcileReservation).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      expect.objectContaining({
        usd: 0.00001,
        quantity: 10,
        evidence: expect.objectContaining({
          basis: 'token_rate',
          provider: 'vertex',
          model: 'vertex:text-embedding-005',
        }),
      }),
    );
  });

  it('meters a paid NoObjectGeneratedError before retry handling', async () => {
    const modelProvider = provider({
      normalizeUsage: vi.fn((event) => ({
        inputTokens: event && typeof event === 'object' && 'usage' in event ? 12 : undefined,
        outputTokens: event && typeof event === 'object' && 'usage' in event ? 3 : undefined,
        costUsd: 0.02,
      })),
    });
    const router = routerWithProvider(modelProvider);
    const error = new Error('no object generated') as Error & {
      usage: { inputTokens: number; outputTokens: number };
    };
    error.name = 'AI_NoObjectGeneratedError';
    error.usage = { inputTokens: 12, outputTokens: 3 };
    stubs.generateObject.mockRejectedValue(error);
    const { z } = await import('zod');

    await expect(
      router.object('draft', {
        prompt: 'hello',
        schema: z.object({ answer: z.string() }),
        forceFallback: true,
      }),
    ).rejects.toBe(error);
    expect(stubs.releaseReservation).not.toHaveBeenCalled();
    expect(stubs.reconcileReservation).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      expect.objectContaining({ usd: 0.02, quantity: 15 }),
    );
  });

  it('keeps provider-specific options and cache hints isolated', async () => {
    const modelProvider = provider();
    const router = routerWithProvider(modelProvider);
    stubs.generateText.mockResolvedValue({
      text: 'answer',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 1 },
    });

    const outcome = await router.generate('reason', {
      system: 'system',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(outcome.ok).toBe(true);
    const args = stubs.generateText.mock.calls[0]?.[0] as {
      providerOptions?: Record<string, unknown>;
      system?: string;
      messages?: unknown[];
    };
    expect(args.providerOptions).toEqual({ vertex: { thinking: { budget: 1 } } });
    expect(args.system).toBe('system');
    expect(args.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(JSON.stringify(args)).not.toContain('openrouter');
  });

  it('reconciles unknown successful usage to the positive estimate', async () => {
    const modelProvider = provider({ normalizeUsage: vi.fn(() => ({})) });
    const router = routerWithProvider(modelProvider);
    const meter = (
      router as unknown as {
        meter(input: {
          role: string;
          modelId: string;
          latencyMs: number;
          event: Record<string, never>;
          reservationId: string;
          estimatedUsd: number;
          promptCostPerMTok: number;
          completionCostPerMTok: number;
        }): Promise<void>;
      }
    ).meter.bind(router);

    await meter({
      role: 'draft',
      modelId: 'vertex/gemini-test',
      latencyMs: 10,
      event: {},
      reservationId: 'reservation-1',
      estimatedUsd: 0.012345,
      promptCostPerMTok: 1,
      completionCostPerMTok: 1,
    });

    expect(stubs.reconcileReservation).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      expect.objectContaining({
        usd: 0.012345,
        description: 'draft:vertex/gemini-test estimated: provider usage unavailable',
        evidence: expect.objectContaining({ basis: 'preflight_estimate' }),
      }),
    );
  });

  it('does not derive cost from partial token usage', async () => {
    const modelProvider = provider({ normalizeUsage: vi.fn(() => ({ inputTokens: 100 })) });
    const router = routerWithProvider(modelProvider);
    const meter = (
      router as unknown as {
        meter(input: {
          role: string;
          modelId: string;
          latencyMs: number;
          event: Record<string, never>;
          reservationId: string;
          estimatedUsd: number;
          promptCostPerMTok: number;
          completionCostPerMTok: number;
        }): Promise<void>;
      }
    ).meter.bind(router);

    await meter({
      role: 'draft',
      modelId: 'vertex/gemini-test',
      latencyMs: 10,
      event: {},
      reservationId: 'reservation-1',
      estimatedUsd: 0.012345,
      promptCostPerMTok: 1,
      completionCostPerMTok: 1,
    });

    const actual = (stubs.reconcileReservation.mock.calls as unknown[][])[0]?.[2] as {
      usd?: number;
      quantity?: number;
    };
    expect(actual.usd).toBe(0.012345);
    expect(actual).not.toHaveProperty('quantity');
  });

  it('validates embedding shape after provider success and retains the reservation', async () => {
    const modelProvider = provider();
    let selectCount = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            selectCount += 1;
            return selectCount === 1
              ? [{ role: 'embed', primaryModel: 'vertex/text-embedding' }]
              : [{ id: 'vertex/text-embedding', promptCostPerMTok: '1' }];
          },
        }),
      }),
    } as unknown as Db;
    const router = new ModelRouter(db, 'unused', 'off', modelProvider);
    const meter = vi.fn(async () => {});
    (
      router as unknown as { meterWithoutRepeatingProviderWork: typeof meter }
    ).meterWithoutRepeatingProviderWork = meter;
    stubs.embedMany.mockResolvedValue({
      embeddings: [[0, 1]],
      usage: { tokens: 1 },
    });

    await expect(router.embed(['hello'])).rejects.toThrow('invalid vector');
    expect(meter).toHaveBeenCalledOnce();
    expect(stubs.releaseReservation).not.toHaveBeenCalled();
    expect(EMBEDDING_DIMENSIONS).toBe(1536);
  });

  it.each([
    ['null', null],
    ['non-array', { embeddings: 'wrong' }],
  ])('meters malformed %s embedding results before rejecting', async (_label, result) => {
    const modelProvider = provider();
    let selectCount = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            selectCount += 1;
            return selectCount === 1
              ? [{ role: 'embed', primaryModel: 'vertex/text-embedding' }]
              : [{ id: 'vertex/text-embedding', promptCostPerMTok: '1' }];
          },
        }),
      }),
    } as unknown as Db;
    const router = new ModelRouter(db, 'unused', 'off', modelProvider);
    const meter = vi.fn(async () => {});
    (
      router as unknown as { meterWithoutRepeatingProviderWork: typeof meter }
    ).meterWithoutRepeatingProviderWork = meter;
    stubs.embedMany.mockResolvedValue(result === null ? { embeddings: null } : result);

    await expect(router.embed(['hello'])).rejects.toThrow('non-array');
    expect(meter).toHaveBeenCalledOnce();
    expect(stubs.releaseReservation).not.toHaveBeenCalled();
  });

  it('rejects sparse vectors after metering the successful call', async () => {
    const modelProvider = provider();
    let selectCount = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            selectCount += 1;
            return selectCount === 1
              ? [{ role: 'embed', primaryModel: 'vertex/text-embedding' }]
              : [{ id: 'vertex/text-embedding', promptCostPerMTok: '1' }];
          },
        }),
      }),
    } as unknown as Db;
    const router = new ModelRouter(db, 'unused', 'off', modelProvider);
    const meter = vi.fn(async () => {});
    (
      router as unknown as { meterWithoutRepeatingProviderWork: typeof meter }
    ).meterWithoutRepeatingProviderWork = meter;
    const sparse = new Array<number>(EMBEDDING_DIMENSIONS);
    sparse.fill(0);
    delete sparse[17];
    stubs.embedMany.mockResolvedValue({ embeddings: [sparse] });

    await expect(router.embed(['hello'])).rejects.toThrow('invalid vector');
    expect(meter).toHaveBeenCalledOnce();
    expect(stubs.releaseReservation).not.toHaveBeenCalled();
  });

  it('forwards an already-aborted embedding signal to the provider call', async () => {
    const modelProvider = provider();
    let selectCount = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            selectCount += 1;
            return selectCount === 1
              ? [{ role: 'embed', primaryModel: 'vertex/text-embedding' }]
              : [{ id: 'vertex/text-embedding', promptCostPerMTok: '1' }];
          },
        }),
      }),
    } as unknown as Db;
    const router = new ModelRouter(db, 'unused', 'off', modelProvider);
    (
      router as unknown as { meterWithoutRepeatingProviderWork: () => Promise<void> }
    ).meterWithoutRepeatingProviderWork = async () => {};
    stubs.embedMany.mockResolvedValue({
      embeddings: [new Array(EMBEDDING_DIMENSIONS).fill(0)],
      usage: { tokens: 1 },
    });
    const controller = new AbortController();
    controller.abort();

    await router.embed(['hello'], { abortSignal: controller.signal });
    expect(stubs.embedMany.mock.calls[0]?.[0].abortSignal.aborted).toBe(true);
  });
});
