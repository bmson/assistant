import type {
  ModelCatalogRepository,
  ModelConnectionRepository,
  ModelRoleAssignment,
  Records,
} from '@assistant/persistence';
import { isRoutableModel } from '@assistant/persistence';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addCatalogModel,
  addVoicePreset,
  chooseTextModels,
  chooseVoiceModel,
  getModelProviderSettings,
  type ModelProviderPorts,
  removeModelConnection,
  saveModelConnection,
  setModelConnectionEnabled,
  testModelConnection,
} from './model-providers.js';

type Connection = Records['modelConnections'];
type Model = Records['models'];
type Role = Records['modelRoles'];

function memoryConnections(): ModelConnectionRepository & { rows: Map<string, Connection> } {
  const rows = new Map<string, Connection>();
  return {
    kind: 'model-connection-repository',
    rows,
    list: async () => [...rows.values()],
    async upsert(input) {
      const existing = rows.get(input.id);
      const row: Connection = {
        ...input,
        apiKeyEncrypted:
          input.apiKeyEncrypted !== undefined
            ? input.apiKeyEncrypted
            : (existing?.apiKeyEncrypted ?? null),
        lastTestedAt: existing?.lastTestedAt ?? null,
        lastError: null,
        createdAt: existing?.createdAt ?? new Date(0),
        updatedAt: new Date(),
      };
      rows.set(input.id, row);
      return row;
    },
    async setEnabled(id, enabled) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, enabled });
      return Boolean(row);
    },
    async recordTest(id, result) {
      const row = rows.get(id);
      if (row)
        rows.set(id, {
          ...row,
          lastTestedAt: new Date(),
          lastError: result.ok ? null : (result.error ?? 'failed'),
        });
      return Boolean(row);
    },
    remove: async (id) => rows.delete(id),
  };
}

function model(id: string, overrides: Partial<Model> = {}): Model {
  return {
    id,
    label: id,
    capabilities: { tools: true },
    promptCostPerMTok: '1.0000',
    completionCostPerMTok: '2.0000',
    latencyClass: 'medium',
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function memoryCatalog(): ModelCatalogRepository & {
  models: Map<string, Model>;
  roles: Map<string, Role>;
} {
  const models = new Map<string, Model>();
  const roles = new Map<string, Role>();
  return {
    kind: 'model-catalog-repository',
    models,
    roles,
    listModels: async () => [...models.values()],
    listRoles: async () => [...roles.values()],
    listRoleRevisions: async () => [],
    rollbackRoleRevision: async () => false,
    async upsertModel(input) {
      models.set(input.id, {
        ...input,
        createdAt: models.get(input.id)?.createdAt ?? new Date(0),
        updatedAt: new Date(),
      });
    },
    async setVoiceModel(modelId: string) {
      if (!isRoutableModel(models.get(modelId))) throw new Error(`Model ${modelId} not routable`);
      roles.set('voice', {
        role: 'voice',
        primaryModel: modelId,
        fallbackModel: modelId,
        params: {},
        updatedAt: new Date(),
      });
    },
    async assignRoles(assignments: readonly ModelRoleAssignment[]) {
      for (const a of assignments) {
        for (const id of [a.primaryModel, a.fallbackModel])
          if (!isRoutableModel(models.get(id))) throw new Error(`Model ${id} not routable`);
        if (!roles.has(a.role)) throw new Error(`Unknown model role: ${a.role}`);
      }
      for (const a of assignments)
        roles.set(a.role, { ...(roles.get(a.role) as Role), ...a, updatedAt: new Date() });
    },
  };
}

const ROLES = ['plan', 'classify', 'extract', 'draft', 'reason', 'rewrite', 'embed', 'batch'];

let connections: ReturnType<typeof memoryConnections>;
let catalog: ReturnType<typeof memoryCatalog>;
let ports: ModelProviderPorts;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  connections = memoryConnections();
  catalog = memoryCatalog();
  catalog.models.set('minimax/minimax-m2.7', model('minimax/minimax-m2.7'));
  catalog.models.set('openai/gpt-oss-120b', model('openai/gpt-oss-120b'));
  catalog.models.set(
    'openai/text-embedding-3-small',
    model('openai/text-embedding-3-small', { capabilities: { embedding: true } }),
  );
  for (const role of ROLES)
    catalog.roles.set(role, {
      role,
      primaryModel: role === 'embed' ? 'openai/text-embedding-3-small' : 'minimax/minimax-m2.7',
      fallbackModel: role === 'embed' ? 'openai/text-embedding-3-small' : 'openai/gpt-oss-120b',
      params: {},
      updatedAt: new Date(0),
    });
  fetchMock = vi.fn();
  ports = {
    connections,
    catalog,
    config: {
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'env-key',
      VERTEX_PROJECT: '',
      VERTEX_LOCATION: '',
    },
    seal: (plaintext) => `sealed(${plaintext})`,
    open: (sealed) => sealed.replace(/^sealed\((.*)\)$/, '$1'),
    fetch: fetchMock as unknown as typeof fetch,
  };
});

describe('AI provider settings', () => {
  it('replaces non-text failover and refuses missing provider connections', async () => {
    catalog.roles.get('reason')!.fallbackModel = 'openai/text-embedding-3-small';
    expect(
      await chooseTextModels(ports, {
        mainModel: 'minimax/minimax-m2.7',
        fastModel: 'openai/gpt-oss-120b',
      }),
    ).toEqual({ ok: true });
    expect(catalog.roles.get('reason')?.fallbackModel).toBe('minimax/minimax-m2.7');
    catalog.models.set('openai:disconnected', model('openai:disconnected'));
    expect(
      await chooseTextModels(ports, {
        mainModel: 'openai:disconnected',
        fastModel: 'openai/gpt-oss-120b',
      }),
    ).toEqual({ ok: false, error: expect.stringContaining('connection') });
    catalog.models.set(
      'openai/gpt-oss-120b',
      model('openai/gpt-oss-120b', { capabilities: { realtime: true } }),
    );
    catalog.roles.get('reason')!.fallbackModel = 'openai/gpt-oss-120b';
    expect(
      await chooseTextModels(ports, {
        mainModel: 'minimax/minimax-m2.7',
        fastModel: 'minimax/minimax-m2.7',
      }),
    ).toEqual({ ok: true });
    expect(catalog.roles.get('reason')?.fallbackModel).toBe('minimax/minimax-m2.7');
  });

  it('shows the environment connection until the owner saves one, and never a key', async () => {
    const settings = await getModelProviderSettings(ports);
    expect(settings.connections).toEqual([
      expect.objectContaining({ id: 'openrouter', source: 'environment', hasApiKey: true }),
    ]);
    expect(settings.mainModel).toBe('minimax/minimax-m2.7');

    await saveModelConnection(ports, { kind: 'openai', apiKey: 'sk-live' });
    const saved = await getModelProviderSettings(ports);
    expect(saved.connections.map((c) => [c.id, c.source])).toEqual([
      ['openai', 'saved'],
      ['openrouter', 'environment'],
    ]);
    expect(JSON.stringify(saved)).not.toContain('sk-live');
    expect(connections.rows.get('openai')?.apiKeyEncrypted).toBe('sealed(sk-live)');
  });

  it('validates what each provider type needs', async () => {
    expect(await saveModelConnection(ports, { kind: 'openai' })).toEqual({
      ok: false,
      error: expect.stringContaining('API key'),
    });
    expect(await saveModelConnection(ports, { kind: 'openai', apiKey: 'sk has space' })).toEqual({
      ok: false,
      error: expect.stringContaining('spaces'),
    });
    expect(
      await saveModelConnection(ports, {
        kind: 'openai_compatible',
        id: 'openai',
        baseUrl: 'https://x.test/v1',
      }),
    ).toEqual({ ok: false, error: expect.stringContaining('short id') });
    expect(
      await saveModelConnection(ports, {
        kind: 'openai_compatible',
        id: 'meta',
        baseUrl: 'http://169.254.169.254/v1',
      }),
    ).toEqual({ ok: false, error: expect.stringContaining('base URL') });
    expect(await saveModelConnection(ports, { kind: 'vertex' })).toEqual({
      ok: false,
      error: expect.stringContaining('project and location'),
    });
    expect(
      await saveModelConnection(ports, {
        kind: 'openai_compatible',
        id: 'groq',
        label: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1/',
        apiKey: 'gsk',
      }),
    ).toEqual({ ok: true, id: 'groq' });
    expect(connections.rows.get('groq')?.baseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('keeps the stored key when the owner edits a connection without retyping it', async () => {
    await saveModelConnection(ports, { kind: 'openai', apiKey: 'sk-1' });
    await saveModelConnection(ports, { kind: 'openai', label: 'OpenAI personal' });
    expect(connections.rows.get('openai')).toMatchObject({
      label: 'OpenAI personal',
      apiKeyEncrypted: 'sealed(sk-1)',
    });
  });

  it('adds priced models under the connection namespace and switches roles in one save', async () => {
    await saveModelConnection(ports, { kind: 'openai', apiKey: 'sk-1' });
    expect(
      await addCatalogModel(ports, {
        connectionId: 'openai',
        model: 'gpt-5.1',
        promptCostPerMTok: '',
        completionCostPerMTok: '10',
      }),
    ).toEqual({ ok: false, error: expect.stringContaining('price') });
    expect(
      await addCatalogModel(ports, {
        connectionId: 'openai',
        model: 'gpt-5.1',
        promptCostPerMTok: '1.25',
        completionCostPerMTok: 10,
      }),
    ).toEqual({ ok: true, id: 'openai:gpt-5.1' });
    await addCatalogModel(ports, {
      connectionId: 'openai',
      model: 'gpt-5-mini',
      promptCostPerMTok: '0.25',
      completionCostPerMTok: '2',
    });

    expect(
      await chooseTextModels(ports, {
        mainModel: 'openai:gpt-5.1',
        fastModel: 'openai/text-embedding-3-small',
      }),
    ).toEqual({ ok: false, error: expect.stringContaining('chat model') });
    expect(
      await chooseTextModels(ports, {
        mainModel: 'openai:gpt-5.1',
        fastModel: 'openai:gpt-5-mini',
      }),
    ).toEqual({ ok: true });

    expect(catalog.roles.get('reason')).toMatchObject({
      primaryModel: 'openai:gpt-5.1',
      // OpenRouter stays behind OpenAI as the fallback.
      fallbackModel: 'openai/gpt-oss-120b',
    });
    expect(catalog.roles.get('classify')?.primaryModel).toBe('openai:gpt-5-mini');
    expect(catalog.roles.get('embed')?.primaryModel).toBe('openai/text-embedding-3-small');
    const settings = await getModelProviderSettings(ports);
    expect([settings.mainModel, settings.fastModel]).toEqual([
      'openai:gpt-5.1',
      'openai:gpt-5-mini',
    ]);
  });

  it('refuses to turn off or remove a connection a role still uses', async () => {
    expect(await setModelConnectionEnabled(ports, 'openrouter', false)).toEqual({
      ok: false,
      error: expect.stringContaining('still used by'),
    });
    await saveModelConnection(ports, { kind: 'openai', apiKey: 'sk-1' });
    expect(await setModelConnectionEnabled(ports, 'openai', false)).toEqual({ ok: true });
    expect(connections.rows.get('openai')?.enabled).toBe(false);
    expect(await removeModelConnection(ports, 'openai')).toEqual({ ok: true });
    expect(await removeModelConnection(ports, 'openrouter')).toEqual({
      ok: false,
      error: expect.stringContaining('saved in the app'),
    });
  });

  it('tests a key by listing models, converting OpenRouter prices to per-million', async () => {
    await saveModelConnection(ports, { kind: 'openrouter', apiKey: 'or-key' });
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/models')
        ? Response.json({
            data: [
              {
                id: 'openai/gpt-5.1',
                name: 'GPT-5.1',
                pricing: { prompt: '0.00000125', completion: '0.00001' },
                supported_parameters: ['tools', 'reasoning'],
              },
            ],
          })
        : Response.json({ data: {} }),
    );
    const result = await testModelConnection(ports, 'openrouter');
    expect(result).toEqual({
      ok: true,
      models: [
        {
          model: 'openai/gpt-5.1',
          label: 'GPT-5.1',
          promptCostPerMTok: '1.2500',
          completionCostPerMTok: '10.0000',
          thinking: true,
          supportedParameters: ['tools', 'reasoning'],
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/key',
      expect.objectContaining({ headers: { authorization: 'Bearer or-key' } }),
    );
  });

  it('persists only freshly rechecked OpenRouter request parameters for a selected model', async () => {
    await saveModelConnection(ports, { kind: 'openrouter', apiKey: 'or-key' });
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          {
            id: 'openai/gpt-5.1',
            supported_parameters: ['tools', 'tool_choice', 'structured_outputs', 'reasoning'],
          },
        ],
      }),
    );
    expect(
      await addCatalogModel(ports, {
        connectionId: 'openrouter',
        model: 'openai/gpt-5.1',
        promptCostPerMTok: 1.25,
        completionCostPerMTok: 10,
      }),
    ).toEqual({ ok: true, id: 'openai/gpt-5.1' });
    expect(catalog.models.get('openai/gpt-5.1')?.capabilities).toEqual(
      expect.objectContaining({
        supportedParameters: ['tools', 'tool_choice', 'structured_outputs', 'reasoning'],
        capabilitySource: 'openrouter-model-catalog',
        checkedAt: expect.any(String),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ headers: { authorization: 'Bearer or-key' } }),
    );
  });

  it('records a rejected key on the connection without echoing the provider body', async () => {
    await saveModelConnection(ports, { kind: 'openai', apiKey: 'sk-bad' });
    fetchMock.mockResolvedValue(new Response('{"error":"secret detail"}', { status: 401 }));
    expect(await testModelConnection(ports, 'openai')).toEqual({
      ok: false,
      error: 'The provider rejected the API key.',
    });
    expect(connections.rows.get('openai')?.lastError).toBe('The provider rejected the API key.');
  });

  it('offers voice presets for connected providers and routes calls to the chosen one', async () => {
    expect((await getModelProviderSettings(ports)).voicePresets).toEqual([]);
    await saveModelConnection(ports, { kind: 'openai', apiKey: 'sk-1' });
    const offered = (await getModelProviderSettings(ports)).voicePresets.map((p) => p.model);
    expect(offered).toEqual(['gpt-realtime-2.1', 'gpt-realtime-2.1-mini']);

    expect(
      await addVoicePreset(ports, { connectionId: 'openai', model: 'gpt-realtime-2.1' }),
    ).toEqual({ ok: true, id: 'openai:gpt-realtime-2.1' });
    expect(catalog.models.get('openai:gpt-realtime-2.1')).toMatchObject({
      promptCostPerMTok: '4.0000',
      completionCostPerMTok: '24.0000',
      capabilities: {
        realtime: true,
        audioInputPerMTok: 32,
        audioOutputPerMTok: 64,
        voice: 'marin',
      },
    });

    // A live voice model is never a chat model, and a chat model is never a voice.
    expect(
      await chooseTextModels(ports, {
        mainModel: 'openai:gpt-realtime-2.1',
        fastModel: 'minimax/minimax-m2.7',
      }),
    ).toEqual({ ok: false, error: expect.stringContaining('chat model') });
    expect(await chooseVoiceModel(ports, 'minimax/minimax-m2.7')).toEqual({
      ok: false,
      error: expect.stringContaining('live voice model'),
    });
    expect(await chooseVoiceModel(ports, 'openai:gpt-realtime-2.1')).toEqual({ ok: true });
    const settings = await getModelProviderSettings(ports);
    expect(settings.voiceModel).toBe('openai:gpt-realtime-2.1');
    expect(settings.voicePresets.map((p) => p.model)).toEqual(['gpt-realtime-2.1-mini']);
    expect(settings.models.find((m) => m.id === 'openai:gpt-realtime-2.1')).toMatchObject({
      realtime: true,
      audioInputPerMTok: 32,
    });
  });

  it('only accepts live voice models from OpenAI or Vertex', async () => {
    await saveModelConnection(ports, {
      kind: 'openai_compatible',
      id: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk',
    });
    expect(
      await addCatalogModel(ports, {
        connectionId: 'groq',
        model: 'voice',
        promptCostPerMTok: 1,
        completionCostPerMTok: 1,
        realtime: { audioInputPerMTok: 1, audioOutputPerMTok: 1 },
      }),
    ).toEqual({ ok: false, error: expect.stringContaining('OpenAI') });
  });
});
