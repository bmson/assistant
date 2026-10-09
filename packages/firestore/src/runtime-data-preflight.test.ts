import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFirestoreRuntimeData } from './runtime-data-preflight.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore runtime data preflight', () => {
  let store: InstallationStore;
  const agentId = 'configured-agent';
  const input = {
    agentId,
    provider: 'vertex' as const,
    embeddingSpace: {
      provider: 'vertex',
      model: 'gemini-embedding-001',
      dimensions: 1536,
      revision: '1',
    },
  };
  const roles = ['plan', 'classify', 'extract', 'draft', 'reason', 'rewrite', 'embed', 'batch'];

  beforeEach(() => {
    store = emulatorStore();
  });
  afterEach(async () => {
    await disposeStore(store);
  });

  async function seed() {
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' }),
      store.doc('coordination', 'budget-policy').set({
        dailyLimitMicros: 4_000_000,
        monthlyLimitMicros: 50_000_000,
        softPct: 80,
      }),
      ...roles.map((role) =>
        store.doc('modelRoles', role).set({
          role,
          primaryModel: role === 'embed' ? 'vertex/gemini-embedding-001' : 'vertex/gemini-chat',
          fallbackModel: role === 'embed' ? 'vertex/gemini-embedding-001' : 'vertex/gemini-chat',
          params: {},
        }),
      ),
      ...['vertex/gemini-embedding-001', 'vertex/gemini-chat'].map((id) =>
        store.doc('models', id).set({
          id,
          enabled: true,
          promptCostPerMTok: '0.1',
          completionCostPerMTok: '0.2',
        }),
      ),
    ]);
  }

  it('reports every missing required record without reading owner content', async () => {
    const result = await checkFirestoreRuntimeData(store, input);
    expect(result.ready).toBe(false);
    expect(result.issues).toEqual([
      { code: 'agent_missing', subject: 'configured-agent' },
      { code: 'budget_policy_missing', subject: 'budget-policy' },
      ...roles.map((role) => ({ code: 'role_missing', subject: role })),
    ]);
  });

  it('accepts a configured owner, budget, and complete Vertex model routing', async () => {
    await seed();
    expect(await checkFirestoreRuntimeData(store, input)).toEqual({ ready: true, issues: [] });
  });

  it('accepts vendor-qualified OpenRouter embedding model IDs', async () => {
    await seed();
    await Promise.all([
      ...roles.map((role) =>
        store.doc('modelRoles', role).update({
          primaryModel: role === 'embed' ? 'openai/text-embedding-3-small' : 'openai/gpt-oss-120b',
          fallbackModel: role === 'embed' ? 'openai/text-embedding-3-small' : 'openai/gpt-oss-120b',
        }),
      ),
      ...['openai/text-embedding-3-small', 'openai/gpt-oss-120b'].map((id) =>
        store.doc('models', id).set({
          id,
          enabled: true,
          promptCostPerMTok: '0.02',
          completionCostPerMTok: '0',
        }),
      ),
    ]);
    expect(
      await checkFirestoreRuntimeData(store, {
        agentId,
        provider: 'openrouter',
        embeddingSpace: {
          provider: 'openrouter',
          model: 'openai/text-embedding-3-small',
          dimensions: 1536,
          revision: 'legacy-postgres-text-embedding-3-small-1536',
        },
      }),
    ).toEqual({ ready: true, issues: [] });
  });

  it('rejects invalid embedding provenance without inferring a model mismatch', async () => {
    await seed();
    expect(
      (
        await checkFirestoreRuntimeData(store, {
          ...input,
          embeddingSpace: { ...input.embeddingSpace, provider: 'openai', dimensions: 0 },
        })
      ).issues,
    ).toEqual([{ code: 'embedding_space_invalid', subject: 'embedding-space' }]);
  });

  it('fails closed when valid embedding provenance disagrees with the configured embed role', async () => {
    await seed();
    expect(
      (
        await checkFirestoreRuntimeData(store, {
          ...input,
          embeddingSpace: { ...input.embeddingSpace, model: 'gemini-embedding-002', revision: '2' },
        })
      ).issues,
    ).toEqual([{ code: 'embedding_mismatch', subject: 'embed' }]);
  });

  it('rejects a foreign model, changed embedding role, and disabled catalog entry', async () => {
    await seed();
    await store.doc('modelRoles', 'draft').update({ fallbackModel: 'openai/gpt-4o' });
    await store.doc('modelRoles', 'embed').update({
      primaryModel: 'vertex/other-embedding',
      fallbackModel: 'vertex/other-embedding',
    });
    await store.doc('models', 'vertex/other-embedding').set({
      id: 'vertex/other-embedding',
      enabled: false,
      promptCostPerMTok: '0.1',
      completionCostPerMTok: '0',
    });
    expect((await checkFirestoreRuntimeData(store, input)).issues).toEqual([
      { code: 'role_invalid', subject: 'draft' },
      { code: 'embedding_mismatch', subject: 'embed' },
      { code: 'model_invalid', subject: 'vertex/other-embedding' },
    ]);
  });

  it('rejects corrupt identities, unusable budget, and missing referenced model', async () => {
    await seed();
    await store.doc('agents', agentId).update({ id: 'foreign-agent' });
    await store.doc('coordination', 'budget-policy').update({ dailyLimitMicros: 0 });
    await store.doc('modelRoles', 'plan').update({ primaryModel: 'vertex/missing' });
    expect((await checkFirestoreRuntimeData(store, input)).issues).toEqual([
      { code: 'agent_invalid', subject: 'configured-agent' },
      { code: 'budget_policy_invalid', subject: 'budget-policy' },
      { code: 'model_missing', subject: 'vertex/missing' },
    ]);
  });
});
