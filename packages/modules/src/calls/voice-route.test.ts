import type { ExecutionPersistence, Records } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { resolveSessionVoiceRoute, selectVoiceRoute } from './voice-route.js';

const config = { VERTEX_PROJECT: 'project-a', VERTEX_LOCATION: 'us-central1' };

function voiceModel(id: string, audioInputPerMTok: number): Records['models'] {
  return {
    id,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    enabled: true,
    label: id,
    capabilities: {
      realtime: true,
      audioInputPerMTok,
      audioOutputPerMTok: 12,
      voice: 'Aoede',
    },
    promptCostPerMTok: '3',
    completionCostPerMTok: '7',
    latencyClass: 'fast',
  };
}

function persistence(models: Map<string, Records['models']>, voiceRole: () => string) {
  return {
    modelRouting: {
      role: async () => ({ primaryModel: voiceRole() }),
      model: async (id: string) => models.get(id) ?? null,
    },
    modelConnections: { list: async () => [] },
  } as unknown as ExecutionPersistence;
}

describe('saved live voice route', () => {
  it('continues with the placed model after the mutable voice role changes', async () => {
    const a = voiceModel('vertex:model-a', 11);
    const b = voiceModel('vertex:model-b', 22);
    const models = new Map([
      [a.id, a],
      [b.id, b],
    ]);
    let role = a.id;
    const store = persistence(models, () => role);
    const placed = await selectVoiceRoute(store, config);
    role = b.id;

    const resolved = await resolveSessionVoiceRoute({ voiceRoute: placed.route }, store, config);
    expect(placed.route.modelId).toBe(a.id);
    expect(placed.route.rates.audioInputPerMTok).toBe(11);
    expect(resolved.model).toBe('model-a');
    expect(resolved.rates.audioInputPerMTok).toBe(11);
    expect(JSON.stringify(placed.route)).not.toMatch(/credential|apiKey|secret/i);
  });

  it('fails closed when the placed model is revoked or its rates drift', async () => {
    const a = voiceModel('vertex:model-a', 11);
    const models = new Map([[a.id, a]]);
    const store = persistence(models, () => a.id);
    const placed = await selectVoiceRoute(store, config);

    models.set(a.id, { ...a, enabled: false });
    await expect(
      resolveSessionVoiceRoute({ voiceRoute: placed.route }, store, config),
    ).rejects.toThrow(/no voice model is set up/i);

    models.set(a.id, {
      ...a,
      capabilities: { ...(a.capabilities as object), audioInputPerMTok: 99 },
    });
    await expect(
      resolveSessionVoiceRoute({ voiceRoute: placed.route }, store, config),
    ).rejects.toThrow(/changed after this call was placed/i);
  });

  it('fails closed when the endpoint moves or a legacy session has no snapshot', async () => {
    const a = voiceModel('vertex:model-a', 11);
    const models = new Map([[a.id, a]]);
    const store = persistence(models, () => a.id);
    const placed = await selectVoiceRoute(store, config);
    await expect(
      resolveSessionVoiceRoute({ voiceRoute: placed.route }, store, {
        ...config,
        VERTEX_LOCATION: 'europe-west4',
      }),
    ).rejects.toThrow(/changed after this call was placed/i);
    await expect(resolveSessionVoiceRoute({ voiceRoute: null }, store, config)).rejects.toThrow(
      /no saved voice route/i,
    );
  });
});
