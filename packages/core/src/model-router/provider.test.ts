import type { Db } from '@assistant/db';
import type { EmbeddingModel, LanguageModel } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createConfiguredModelProvider,
  createOpenRouterModelProvider,
  type ModelProvider,
  normalizeOpenRouterUsage,
  providerErrorNodes,
  providerStatusCode,
} from './provider.js';
import {
  EMBEDDING_DIMENSIONS,
  isProviderCapabilityError,
  ModelFallbackAttemptError,
  ModelRouter,
} from './router.js';

const stubs = vi.hoisted(() => ({
  openRouterChat: vi.fn(),
  createVertex: vi.fn(),
  embedMany: vi.fn(),
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
  it('walks nested SDK errors by object depth, bounds cycles, and normalizes status codes', () => {
    const unsupported = Object.assign(new Error('response format json_schema is not supported'), {
      name: 'AI_APICallError',
      statusCode: '400',
    });
    const root = new Error('provider wrapper') as Error & { errors: unknown[]; cause?: unknown };
    root.errors = [undefined, null, { lastError: { cause: unsupported } }];
    root.cause = root;

    expect(isProviderCapabilityError(root)).toBe(true);
    expect(providerErrorNodes(root)).toHaveLength(4);
    expect(providerStatusCode('410')).toBe(410);
    expect(providerStatusCode(410)).toBe(410);
    expect(providerStatusCode('41x')).toBeUndefined();

    let tooDeep: unknown = unsupported;
    for (let index = 0; index < 12; index += 1) tooDeep = { cause: tooDeep };
    expect(
      providerErrorNodes(tooDeep).some(({ value }) => (value as unknown) === unsupported),
    ).toBe(false);
  });

  it('gives provider authentication errors priority over sibling capability errors', () => {
    const forbidden = Object.assign(new Error('forbidden'), {
      name: 'AI_APICallError',
      statusCode: 403,
    });
    const gone = Object.assign(new Error('model removed'), {
      name: 'AI_APICallError',
      statusCode: '410',
    });
    const wrapper = Object.assign(new Error('retry wrapper'), { errors: [gone, forbidden] });
    expect(isProviderCapabilityError(wrapper)).toBe(false);
    expect(isProviderCapabilityError(new Error('this feature is not supported'))).toBe(false);
  });

  it('adds evaluation price ceilings without changing normal provider routing', () => {
    const normal = createOpenRouterModelProvider('unused');
    normal.chat('openai/gpt-6.1-sol', { interactive: true });
    expect(stubs.openRouterChat).toHaveBeenLastCalledWith('openai/gpt-6.1-sol', {
      provider: { require_parameters: true, data_collection: 'deny', zdr: true },
    });
    normal.chat('openai/gpt-6.1-sol', {
      interactive: true,
      requestProfile: {
        tools: 'required',
        toolChoice: 'required',
        output: 'json_schema',
        streaming: false,
        reasoning: 'enabled',
        privacy: 'deny',
        maxPrice: { prompt: 1.5, completion: 4, request: 0.03 },
      },
    });
    expect(stubs.openRouterChat).toHaveBeenLastCalledWith('openai/gpt-6.1-sol', {
      provider: {
        require_parameters: true,
        sort: 'latency',
        data_collection: 'deny',
        zdr: true,
        max_price: { prompt: 1.5, completion: 4, request: 0.03 },
      },
    });
    normal.chat('openai/gpt-oss-120b', {
      interactive: true,
      requestProfile: {
        tools: 'required',
        toolChoice: 'required',
        output: 'json_schema',
        streaming: false,
        reasoning: 'enabled',
        privacy: 'deny',
        maxPrice: { prompt: 1.5, completion: 4, request: 0.03 },
      },
    });
    expect(stubs.openRouterChat).toHaveBeenLastCalledWith('openai/gpt-oss-120b', {
      provider: {
        require_parameters: true,
        sort: 'latency',
        data_collection: 'deny',
        zdr: true,
        max_price: { prompt: 1.5, completion: 4, request: 0.03 },
      },
    });
    const evaluation = createOpenRouterModelProvider('unused', {
      maxPrice: { prompt: 2, completion: 10, request: 0 },
    });
    evaluation.chat('openai/gpt-6.1-sol');
    expect(stubs.openRouterChat).toHaveBeenLastCalledWith('openai/gpt-6.1-sol', {
      provider: {
        require_parameters: true,
        data_collection: 'deny',
        zdr: true,
        max_price: { prompt: 2, completion: 10, request: 0 },
      },
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
    const configuredEmbeddingProvider = createConfiguredModelProvider({
      ...config,
      LLM_PROVIDER: 'vertex',
      VERTEX_PROJECT: 'customer-project',
      VERTEX_LOCATION: 'global',
      FIRESTORE_EMBEDDING_SPACE:
        '{"provider":"vertex","model":"gemini-embedding-001","dimensions":768,"revision":"v1"}',
    });
    expect(configuredEmbeddingProvider.embeddingOptions()).toEqual({
      vertex: { outputDimensionality: 768 },
    });
    expect(configuredEmbeddingProvider.embeddingDimensions).toBe(768);
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

  it('keeps tool-choice, schema, and streaming requirements in the router request profile', async () => {
    const router = routerWithProvider(provider());
    stubs.generateText.mockResolvedValue({ text: 'done', toolCalls: [] });
    await router.step('draft', {
      prompt: 'Find the source.',
      tools: {
        'docs.get': {
          description: 'Read a document',
          inputSchema: z.object({ documentId: z.string() }),
        },
      } as never,
      toolChoice: 'required',
    });
    expect(vi.mocked(router.route).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        requestProfile: {
          tools: 'required',
          toolChoice: 'required',
          output: 'text',
          streaming: false,
        },
      }),
    );
    expect(stubs.generateText).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolChoice: 'required',
        tools: {
          docs_get: expect.objectContaining({
            description: 'Read a document',
            inputSchema: expect.anything(),
          }),
        },
      }),
    );

    const schema = z.object({ ok: z.boolean() });
    stubs.generateObject.mockResolvedValue({ object: { ok: true }, finishReason: 'stop' });
    await router.object('classify', { prompt: 'Return a verdict.', schema });
    expect(vi.mocked(router.route).mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        requestProfile: { tools: 'none', output: 'json_schema', streaming: false },
      }),
    );
    expect(stubs.generateObject).toHaveBeenLastCalledWith(
      expect.objectContaining({ schema, prompt: 'Return a verdict.' }),
    );
    expect(stubs.generateObject).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerOptions: { vertex: { thinking: { budget: 1 } } } }),
    );

    const openAIProvider = provider({
      kind: 'openai',
      optionsFor: vi.fn(() => ({ openai: { reasoningEffort: 'low' } })),
    });
    const openAIRouter = routerWithProvider(openAIProvider);
    stubs.generateObject.mockResolvedValue({ object: { ok: true }, finishReason: 'stop' });
    await openAIRouter.object('classify', { prompt: 'Return a verdict.', schema });
    expect(stubs.generateObject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerOptions: { openai: { reasoningEffort: 'low', strictJsonSchema: false } },
      }),
    );

    stubs.streamText.mockReturnValue({
      text: Promise.resolve('answer'),
      toUIMessageStreamResponse: () => new Response(),
      toUIMessageStream: () => new ReadableStream({ start: (controller) => controller.close() }),
    });
    await router.stream('draft', { prompt: 'Say hello.' });
    expect(vi.mocked(router.route).mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        requestProfile: { tools: 'none', output: 'text', streaming: true },
      }),
    );
    expect(stubs.streamText).toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.anything(), prompt: 'Say hello.' }),
    );
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
          requestProfile?: {
            tools: 'none' | 'optional' | 'required';
            output: 'text' | 'json' | 'json_schema';
            streaming: boolean;
            reasoning: 'enabled' | 'disabled' | 'unsupported';
            privacy: 'deny';
            maxPrice: { prompt: number; completion: number };
          };
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
      requestProfile: {
        tools: 'none',
        output: 'text',
        streaming: false,
        reasoning: 'unsupported',
        privacy: 'deny',
        maxPrice: { prompt: 100, completion: 100 },
      },
    });

    expect(stubs.reconcileReservation).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      expect.objectContaining({
        usd: 0,
        quantity: 5,
        evidence: expect.objectContaining({
          basis: 'provider_reported',
          provider: 'vertex',
          request: expect.objectContaining({
            providerPriceCeilingPerMTok: { prompt: 100, completion: 100 },
            rateSource: 'model-row-catalog',
          }),
        }),
      }),
    );
  });

  it('falls through empty root metadata to final-step provider metadata', () => {
    expect(
      normalizeOpenRouterUsage({
        usage: { inputTokens: 2, outputTokens: 3 },
        providerMetadata: { openrouter: { provider_name: 'Example Endpoint', usage: {} } },
        finalStep: {
          providerMetadata: { openrouter: { usage: { cost: 0.004 } } },
        },
      }).costUsd,
    ).toBe(0.004);
    expect(
      normalizeOpenRouterUsage({
        providerMetadata: {
          openrouter: { provider_name: 'Example Endpoint', usage: { cost: 0.004 } },
        },
      }).endpointName,
    ).toBe('Example Endpoint');
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

      expect(stubs.markCostAttemptUnknown).toHaveBeenCalledWith(
        expect.anything(),
        'reservation-1',
        'provider returned without complete usage or authoritative cost',
        {},
      );
      expect(stubs.reconcileReservation).not.toHaveBeenCalled();
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
    expect(stubs.markCostAttemptUnknown).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      'provider returned without complete usage or authoritative cost',
      {},
    );
    expect(stubs.reconcileReservation).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled', { enabled: false, capabilities: { embedding: true } }, 'disabled'],
    ['wrong modality', { enabled: true, capabilities: { embedding: false } }, 'does not support'],
  ])(
    'rejects an embedding model that is %s before reserving cost or calling the provider',
    async (_label, model, message) => {
      const db = {
        select: () => ({
          from: () => ({
            where: async () =>
              selectCount++ === 0
                ? [{ role: 'embed', primaryModel: 'vertex/text-embedding' }]
                : [{ id: 'vertex/text-embedding', promptCostPerMTok: '1', ...model }],
          }),
        }),
      } as unknown as Db;
      let selectCount = 0;
      const modelProvider = provider();
      const router = new ModelRouter(db, 'unused', 'off', modelProvider);

      await expect(router.embed(['hello'])).rejects.toThrow(message);
      expect(stubs.reserveCost).not.toHaveBeenCalled();
      expect(modelProvider.textEmbeddingModel).not.toHaveBeenCalled();
    },
  );

  it('validates the configured 768-dimensional embedding space', async () => {
    let selectCount = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: async () =>
            selectCount++ === 0
              ? [{ role: 'embed', primaryModel: 'vertex/gemini-embedding-001' }]
              : [
                  {
                    id: 'vertex/gemini-embedding-001',
                    promptCostPerMTok: '1',
                    enabled: true,
                    capabilities: { embedding: true },
                  },
                ],
        }),
      }),
    } as unknown as Db;
    const modelProvider = provider({
      embeddingDimensions: 768,
      textEmbeddingModel: vi.fn(() => ({}) as EmbeddingModel),
    });
    const router = new ModelRouter(db, 'unused', 'off', modelProvider);
    (
      router as unknown as { meterWithoutRepeatingProviderWork: (input: unknown) => Promise<void> }
    ).meterWithoutRepeatingProviderWork = async () => {};
    stubs.embedMany.mockResolvedValue({ embeddings: [new Array(768).fill(0)] });

    await expect(router.embed(['hello'], { expectedDimensions: 768 })).resolves.toEqual([
      new Array(768).fill(0),
    ]);
    expect(modelProvider.textEmbeddingModel).toHaveBeenCalledOnce();
  });

  it('rejects a deterministic embedding-width mismatch before paid provider work', async () => {
    let selectCount = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: async () =>
            selectCount++ === 0
              ? [{ role: 'embed', primaryModel: 'vertex/gemini-embedding-001' }]
              : [
                  {
                    id: 'vertex/gemini-embedding-001',
                    promptCostPerMTok: '1',
                    enabled: true,
                    capabilities: { embedding: true },
                  },
                ],
        }),
      }),
    } as unknown as Db;
    const modelProvider = provider({ embeddingDimensions: 768 });
    const router = new ModelRouter(db, 'unused', 'off', modelProvider);

    await expect(router.embed(['hello'], { expectedDimensions: 1_536 })).rejects.toThrow(
      'do not match the configured embedding space',
    );
    expect(stubs.reserveCost).not.toHaveBeenCalled();
    expect(modelProvider.textEmbeddingModel).not.toHaveBeenCalled();
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
              : [
                  {
                    id: 'vertex/text-embedding',
                    promptCostPerMTok: '1',
                    enabled: true,
                    capabilities: { embedding: true },
                  },
                ];
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

  it('retains primary and fallback failures when the configured fallback also fails', async () => {
    const router = routerWithProvider(provider());
    vi.mocked(router.route).mockImplementation(
      async (_role, options) =>
        ({
          ok: true,
          model: {} as LanguageModel,
          modelId: options?.forceFallback ? 'vertex:fallback' : 'vertex:primary',
          degraded: options?.forceFallback === true,
          thinking: true,
          decision: { mode: 'primary' },
          params: {},
          promptCostPerMTok: 1,
          completionCostPerMTok: 1,
        }) as never,
    );
    const primary = Object.assign(new Error('model retired'), {
      name: 'AI_APICallError',
      statusCode: 410,
    });
    const fallback = Object.assign(new Error('temporary provider outage'), {
      name: 'AI_APICallError',
      statusCode: 503,
    });
    stubs.generateObject.mockRejectedValueOnce(primary).mockRejectedValueOnce(fallback);
    const { z } = await import('zod');

    let caught: unknown;
    try {
      await router.object('reason', {
        prompt: 'hello',
        schema: z.object({ answer: z.string() }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModelFallbackAttemptError);
    expect(caught).toMatchObject({
      name: 'ModelFallbackAttemptError',
      fallbackAttempted: true,
      attemptEvidence: {
        role: 'reason',
        primaryModelId: 'vertex:primary',
        fallbackModelId: 'vertex:fallback',
        primaryFailure: primary,
        fallbackFailure: fallback,
      },
    });
    expect((caught as ModelFallbackAttemptError).attemptEvidence.elapsedMs).toBeGreaterThanOrEqual(
      0,
    );
    expect(stubs.generateObject).toHaveBeenCalledTimes(2);
  });

  it('routes an opted-in transient failure through one fallback and returns degraded metadata', async () => {
    const router = routerWithProvider(provider());
    vi.mocked(router.route).mockImplementation(
      async (_role, options) =>
        ({
          ok: true,
          model: {} as LanguageModel,
          modelId: options?.forceFallback ? 'vertex:fallback' : 'vertex:primary',
          degraded: options?.forceFallback === true,
          thinking: true,
          decision: { mode: 'primary' },
          params: {},
          promptCostPerMTok: 1,
          completionCostPerMTok: 1,
        }) as never,
    );
    stubs.generateObject
      .mockRejectedValueOnce(
        Object.assign(new Error('temporary outage'), {
          name: 'AI_APICallError',
          statusCode: 503,
        }),
      )
      .mockResolvedValueOnce({ object: { answer: 'ok' }, finishReason: 'stop' });
    const { z } = await import('zod');

    const result = await router.object('reason', {
      prompt: 'hello',
      schema: z.object({ answer: z.string() }),
      fallbackOnTransientProviderError: true,
    });
    expect(result).toMatchObject({ ok: true, modelId: 'vertex:fallback', degraded: true });
    expect(stubs.generateObject).toHaveBeenCalledTimes(2);
  });

  it('gives a timeout fallback a fresh bounded signal after the primary deadline fires', async () => {
    const router = routerWithProvider(provider());
    vi.mocked(router.route).mockImplementation(
      async (_role, options) =>
        ({
          ok: true,
          model: {} as LanguageModel,
          modelId: options?.forceFallback ? 'vertex:fallback' : 'vertex:primary',
          degraded: options?.forceFallback === true,
          thinking: true,
          decision: { mode: 'primary' },
          params: {},
          promptCostPerMTok: 1,
          completionCostPerMTok: 1,
        }) as never,
    );
    stubs.generateObject
      .mockRejectedValueOnce(Object.assign(new Error('deadline'), { name: 'TimeoutError' }))
      .mockResolvedValueOnce({ object: { answer: 'recovered' }, finishReason: 'stop' });
    const { z } = await import('zod');
    const controller = new AbortController();
    controller.abort();

    const result = await router.object('reason', {
      prompt: 'hello',
      schema: z.object({ answer: z.string() }),
      abortSignal: controller.signal,
      fallbackOnTransientProviderError: true,
    });
    const primaryCall = stubs.generateObject.mock.calls[0]?.[0] as {
      abortSignal: AbortSignal;
    };
    const fallbackCall = stubs.generateObject.mock.calls[1]?.[0] as {
      abortSignal: AbortSignal;
    };
    expect(primaryCall.abortSignal.aborted).toBe(true);
    expect(fallbackCall.abortSignal.aborted).toBe(false);
    expect(result).toMatchObject({ ok: true, modelId: 'vertex:fallback', degraded: true });
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

  it('keeps successful provider calls with absent usage as unknown liabilities', async () => {
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

    expect(stubs.markCostAttemptUnknown).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      'provider returned without complete usage or authoritative cost',
      {},
    );
    expect(stubs.reconcileReservation).not.toHaveBeenCalled();
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

    expect(stubs.markCostAttemptUnknown).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      'provider returned without complete usage or authoritative cost',
      {},
    );
    expect(stubs.reconcileReservation).not.toHaveBeenCalled();
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
              : [
                  {
                    id: 'vertex/text-embedding',
                    promptCostPerMTok: '1',
                    enabled: true,
                    capabilities: { embedding: true },
                  },
                ];
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
              : [
                  {
                    id: 'vertex/text-embedding',
                    promptCostPerMTok: '1',
                    enabled: true,
                    capabilities: { embedding: true },
                  },
                ];
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
              : [
                  {
                    id: 'vertex/text-embedding',
                    promptCostPerMTok: '1',
                    enabled: true,
                    capabilities: { embedding: true },
                  },
                ];
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
              : [
                  {
                    id: 'vertex/text-embedding',
                    promptCostPerMTok: '1',
                    enabled: true,
                    capabilities: { embedding: true },
                  },
                ];
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
