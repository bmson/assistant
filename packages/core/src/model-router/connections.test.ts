import type { ModelRoutingRepository, Records } from '@assistant/persistence';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionIdForModel, createConnectedModelProviders } from './connections.js';
import { createOpenRouterModelProvider, gatewayModelId } from './provider.js';
import { ModelRouter } from './router.js';

const stubs = vi.hoisted(() => ({
  createOpenRouter: vi.fn(),
  createOpenAI: vi.fn(),
  createOpenAICompatible: vi.fn(),
  createVertex: vi.fn(),
}));

vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: stubs.createOpenRouter }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: stubs.createOpenAI }));
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: stubs.createOpenAICompatible,
}));
vi.mock('@ai-sdk/google-vertex', () => ({ createVertex: stubs.createVertex }));

const env = {
  LLM_PROVIDER: 'openrouter' as const,
  OPENROUTER_API_KEY: 'env-openrouter-key',
  VERTEX_PROJECT: '',
  VERTEX_LOCATION: '',
};

function connection(
  overrides: Partial<Records['modelConnections']> &
    Pick<Records['modelConnections'], 'id' | 'kind'>,
): Records['modelConnections'] {
  return {
    label: overrides.id,
    baseUrl: null,
    apiKeyEncrypted: 'sealed',
    vertexProject: null,
    vertexLocation: null,
    enabled: true,
    lastTestedAt: null,
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(1_000),
    ...overrides,
  };
}

const decrypt = (payload: string) => `plain:${payload}`;

beforeEach(() => {
  vi.clearAllMocks();
  stubs.createOpenRouter.mockImplementation(() => ({ chat: vi.fn(), textEmbeddingModel: vi.fn() }));
  stubs.createOpenAI.mockImplementation(() => ({
    chat: vi.fn((id: string) => ({ openaiModel: id })),
    embeddingModel: vi.fn(),
  }));
  stubs.createOpenAICompatible.mockImplementation(() => ({
    chatModel: vi.fn((id: string) => ({ gatewayModel: id })),
    embeddingModel: vi.fn(),
  }));
  stubs.createVertex.mockImplementation(() => ({
    languageModel: vi.fn(),
    embeddingModel: vi.fn(),
  }));
});

describe('model identity namespaces', () => {
  it('maps every identity to exactly one connection', () => {
    expect(connectionIdForModel('minimax/minimax-m2.7')).toBe('openrouter');
    expect(connectionIdForModel('openai/gpt-oss-120b')).toBe('openrouter');
    expect(connectionIdForModel('openai:gpt-5.1')).toBe('openai');
    expect(connectionIdForModel('vertex:gemini-2.5-flash')).toBe('vertex');
    expect(connectionIdForModel('vertex/gemini-2.5-flash')).toBe('vertex');
    expect(connectionIdForModel('gw:groq:llama-3.3-70b')).toBe('groq');
  });

  it('keeps direct-adapter identities away from OpenRouter', () => {
    const openrouter = createOpenRouterModelProvider('unused');
    expect(() => openrouter.assertModelId('openai/gpt-oss-120b')).not.toThrow();
    expect(() => openrouter.assertModelId('openai:gpt-5.1')).toThrow('identity');
    expect(() => openrouter.assertModelId('gw:groq:llama')).toThrow('identity');
  });

  it('reads the upstream name out of a gateway identity, including slashes', () => {
    expect(gatewayModelId('together', 'gw:together:meta-llama/Llama-4')).toBe('meta-llama/Llama-4');
    expect(() => gatewayModelId('together', 'gw:groq:llama')).toThrow('cannot serve');
    expect(() => gatewayModelId('together', 'gw:together:')).toThrow('cannot serve');
  });
});

describe('connected model providers', () => {
  it('falls back to the environment until the owner saves a connection', async () => {
    const providers = createConnectedModelProviders(env, async () => [], { decrypt });
    await providers.refresh();
    expect(providers.resolve('minimax/minimax-m2.7').kind).toBe('openrouter');
    expect(stubs.createOpenRouter).toHaveBeenCalledWith({ apiKey: 'env-openrouter-key' });
    expect(() => providers.resolve('openai:gpt-5.1')).toThrow('No model connection serves');
  });

  it('gives a Vertex installation no implicit OpenRouter connection', async () => {
    stubs.createVertex.mockReturnValue({ languageModel: vi.fn(), embeddingModel: vi.fn() });
    const providers = createConnectedModelProviders(
      {
        ...env,
        LLM_PROVIDER: 'vertex',
        VERTEX_PROJECT: 'bmson-assistant',
        VERTEX_LOCATION: 'global',
      },
      async () => [],
      { decrypt },
    );
    await providers.refresh();
    expect(providers.resolve('vertex:gemini-2.5-flash').kind).toBe('vertex');
    expect(() => providers.resolve('minimax/minimax-m2.7')).toThrow('No model connection serves');
  });

  it('serves each model from its own saved connection with the unsealed key', async () => {
    const providers = createConnectedModelProviders(
      env,
      async () => [
        connection({ id: 'openrouter', kind: 'openrouter', apiKeyEncrypted: 'or' }),
        connection({ id: 'openai', kind: 'openai', apiKeyEncrypted: 'oa' }),
        connection({
          id: 'groq',
          kind: 'openai_compatible',
          baseUrl: 'https://api.groq.com/openai/v1/',
          apiKeyEncrypted: 'gq',
        }),
      ],
      { decrypt },
    );
    await providers.refresh();

    expect(providers.resolve('minimax/minimax-m2.7').kind).toBe('openrouter');
    expect(stubs.createOpenRouter).toHaveBeenCalledWith({ apiKey: 'plain:or' });

    const openai = providers.resolve('openai:gpt-5.1');
    expect(openai.kind).toBe('openai');
    expect(stubs.createOpenAI).toHaveBeenCalledWith({ apiKey: 'plain:oa' });
    expect(openai.chat('openai:gpt-5.1')).toEqual({ openaiModel: 'gpt-5.1' });

    const groq = providers.resolve('gw:groq:llama-3.3-70b');
    expect(groq.kind).toBe('openai_compatible');
    expect(stubs.createOpenAICompatible).toHaveBeenCalledWith({
      name: 'groq',
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: 'plain:gq',
      includeUsage: true,
    });
    expect(groq.chat('gw:groq:llama-3.3-70b')).toEqual({ gatewayModel: 'llama-3.3-70b' });
  });

  it('refuses a model whose connection the owner turned off, even with an env key', async () => {
    const providers = createConnectedModelProviders(
      env,
      async () => [connection({ id: 'openrouter', kind: 'openrouter', enabled: false })],
      { decrypt },
    );
    await providers.refresh();
    expect(() => providers.resolve('minimax/minimax-m2.7')).toThrow('turned off');
  });

  it('reuses an adapter until its connection changes, and re-reads only after the TTL', async () => {
    let clock = 0;
    let rows = [connection({ id: 'openai', kind: 'openai', updatedAt: new Date(1) })];
    const load = vi.fn(async () => rows);
    const providers = createConnectedModelProviders(env, load, {
      decrypt,
      ttlMs: 1_000,
      now: () => clock,
    });

    await providers.refresh();
    const first = providers.resolve('openai:gpt-5.1');
    await providers.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    expect(providers.resolve('openai:gpt-5.1')).toBe(first);

    rows = [connection({ id: 'openai', kind: 'openai', updatedAt: new Date(2) })];
    clock = 1_000;
    await providers.refresh();
    expect(load).toHaveBeenCalledTimes(2);
    expect(providers.resolve('openai:gpt-5.1')).not.toBe(first);
  });

  it('fails closed after cold-load and expired-policy failures, and recovers', async () => {
    let clock = 0;
    const load = vi
      .fn<() => Promise<Records['modelConnections'][]>>()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce([connection({ id: 'openrouter', kind: 'openrouter' })])
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce([
        connection({ id: 'openrouter', kind: 'openrouter', enabled: false }),
      ]);
    const providers = createConnectedModelProviders(env, load, {
      decrypt,
      ttlMs: 1000,
      now: () => clock,
    });
    await expect(providers.refresh()).rejects.toThrow('policy is unavailable');
    expect(() => providers.resolve('minimax/minimax-m2.7')).toThrow('policy is unavailable');
    expect(stubs.createOpenRouter).not.toHaveBeenCalled();
    clock = 1000;
    await providers.refresh();
    expect(providers.resolve('minimax/minimax-m2.7').kind).toBe('openrouter');
    clock = 2000;
    await expect(providers.refresh()).rejects.toThrow('policy is unavailable');
    expect(() => providers.resolve('minimax/minimax-m2.7')).toThrow('expired');
    clock = 3000;
    await providers.refresh();
    expect(() => providers.resolve('minimax/minimax-m2.7')).toThrow('turned off');
  });

  it('rejects a gateway base URL carrying credentials', async () => {
    const providers = createConnectedModelProviders(
      env,
      async () => [
        connection({
          id: 'proxy',
          kind: 'openai_compatible',
          baseUrl: 'https://user:pass@proxy.example/v1',
        }),
      ],
      { decrypt },
    );
    await providers.refresh();
    expect(() => providers.resolve('gw:proxy:model')).toThrow('without embedded credentials');
  });
});

describe('effective draft route preflight', () => {
  const openAiId = 'openai:gpt-4.1-mini';
  const routerFallbackId = 'minimax/minimax-m2.7';

  function routedModel(id: string, price: string) {
    return {
      id,
      label: id,
      enabled: true,
      capabilities: { thinking: false },
      promptCostPerMTok: price,
      completionCostPerMTok: price,
      latencyClass: 'fast',
      updatedAt: new Date(1),
      createdAt: new Date(0),
    } as Records['models'];
  }

  function routeFixture(input: {
    primary: string;
    fallback: string;
    modelRows: Records['models'][];
    connections: Records['modelConnections'][];
    loadConnections?: () => Promise<Records['modelConnections'][]>;
    totals?: Partial<{
      dailySpentUsd: number;
      monthlySpentUsd: number;
      heldUsd: number;
      dailyLimitUsd: number;
      monthlyLimitUsd: number;
      softPct: number;
    }>;
  }) {
    const role = {
      role: 'draft',
      primaryModel: input.primary,
      fallbackModel: input.fallback,
      params: {},
      updatedAt: new Date(1),
    } as Records['modelRoles'];
    const costs = {
      kind: 'cost-repository',
      totals: vi.fn(async () => ({
        dailySpentUsd: 0,
        monthlySpentUsd: 0,
        heldUsd: 0,
        dailyLimitUsd: 100,
        monthlyLimitUsd: 100,
        softPct: 80,
        ...input.totals,
      })),
    };
    const persistence = {
      kind: 'model-routing-repository',
      costs,
      taskBudget: vi.fn(async () => null),
      conversationOverride: vi.fn(async () => null),
      role: vi.fn(async () => role),
      model: vi.fn(async (id: string) => input.modelRows.find((row) => row.id === id) ?? null),
      recordCall: vi.fn(async () => 'call-1'),
      recordAudit: vi.fn(async () => {}),
    } as unknown as ModelRoutingRepository;
    const providers = createConnectedModelProviders(
      { ...env, OPENROUTER_API_KEY: '' },
      input.loadConnections ?? (async () => input.connections),
      { decrypt },
    );
    return new ModelRouter(persistence, 'unused', 'off', providers);
  }

  it('routes a saved OpenAI primary without requiring its unavailable OpenRouter fallback', async () => {
    const router = routeFixture({
      primary: openAiId,
      fallback: routerFallbackId,
      modelRows: [routedModel(openAiId, '1'), routedModel(routerFallbackId, '1')],
      connections: [connection({ id: 'openai', kind: 'openai', apiKeyEncrypted: 'saved-openai' })],
    });

    const route = await router.route('draft');

    expect(route.ok).toBe(true);
    if (route.ok) expect(route.modelId).toBe(openAiId);
    expect(stubs.createOpenAI).toHaveBeenCalledWith({ apiKey: 'plain:saved-openai' });
    expect(stubs.createOpenRouter).not.toHaveBeenCalled();
  });

  it('honors a valid conversation override when the role primary is unavailable', async () => {
    const router = routeFixture({
      primary: routerFallbackId,
      fallback: routerFallbackId,
      modelRows: [routedModel(openAiId, '1'), routedModel(routerFallbackId, '1')],
      connections: [connection({ id: 'openai', kind: 'openai', apiKeyEncrypted: 'saved-openai' })],
    });

    const route = await router.route('draft', {
      modelOverride: openAiId,
      modelOverrideResolved: true,
    });

    expect(route.ok).toBe(true);
    if (route.ok) expect(route.modelId).toBe(openAiId);
    expect(stubs.createOpenRouter).not.toHaveBeenCalled();
  });

  it('uses an available budget fallback when soft spend selects the cheaper route', async () => {
    const router = routeFixture({
      primary: openAiId,
      fallback: routerFallbackId,
      modelRows: [routedModel(openAiId, '10'), routedModel(routerFallbackId, '1')],
      connections: [
        connection({ id: 'openai', kind: 'openai', apiKeyEncrypted: 'saved-openai' }),
        connection({ id: 'openrouter', kind: 'openrouter', apiKeyEncrypted: 'saved-openrouter' }),
      ],
      totals: { dailySpentUsd: 85 },
    });

    const route = await router.route('draft');

    expect(route.ok).toBe(true);
    if (route.ok) {
      expect(route.modelId).toBe(routerFallbackId);
      expect(route.degraded).toBe(true);
    }
    expect(stubs.createOpenRouter).toHaveBeenCalledWith({ apiKey: 'plain:saved-openrouter' });
  });

  it('fails closed when the stored provider policy cannot be read', async () => {
    const router = routeFixture({
      primary: openAiId,
      fallback: openAiId,
      modelRows: [routedModel(openAiId, '1')],
      connections: [],
      loadConnections: async () => {
        throw new Error('storage detail must not reach the owner response');
      },
    });

    await expect(router.route('draft')).rejects.toThrow('policy is unavailable');
    expect(stubs.createOpenAI).not.toHaveBeenCalled();
  });

  it('rejects an unavailable legacy route when no selected saved provider can serve it', async () => {
    const router = routeFixture({
      primary: routerFallbackId,
      fallback: routerFallbackId,
      modelRows: [routedModel(routerFallbackId, '1')],
      connections: [],
    });

    await expect(router.route('draft')).rejects.toThrow('No model connection serves');
    expect(stubs.createOpenRouter).not.toHaveBeenCalled();
  });
});
