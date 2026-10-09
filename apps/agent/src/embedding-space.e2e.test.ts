import { randomUUID } from 'node:crypto';
import { loadConfig, resetConfigForTest } from '@assistant/config';
import { ModelRouter } from '@assistant/core';
import { agents, memories, modelCalls, modelRoles, models } from '@assistant/db';
import type { InstallationStore } from '@assistant/firestore';
import { type EmbeddingSpace, embeddingSpaceIdentityKey } from '@assistant/persistence';
import type { ToolContext } from '@assistant/tools';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Replace only the provider factory. Configuration, composition, routing,
// metering, tool implementation and persistence are the shipped components.
const fake = vi.hoisted(() => ({
  dimensions: 1536,
  invalid: '' as '' | 'width' | 'count' | 'nonfinite',
  calls: [] as string[][],
}));
vi.mock('@assistant/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/core')>()),
  createConnectedModelProviders: () => ({
    kind: 'model-provider-set',
    refresh: async () => {},
    resolve: () => ({
      kind: 'openrouter',
      embeddingDimensions: fake.dimensions,
      assertModelId: (id: string) => {
        if (id !== 'synthetic/embedding') throw new Error('Unexpected synthetic model');
      },
      chat: () => {
        throw new Error('This qualification must not generate chat');
      },
      textEmbeddingModel: (modelId: string) => ({
        specificationVersion: 'v4',
        provider: 'synthetic',
        modelId,
        supportsParallelCalls: false,
        doEmbed: async ({ values }: { values: string[] }) => {
          fake.calls.push([...values]);
          return {
            embeddings:
              fake.invalid === 'count'
                ? []
                : values.map(() => [
                    fake.invalid === 'nonfinite' ? Number.NaN : 1,
                    ...Array(fake.dimensions - (fake.invalid === 'width' ? 2 : 1)).fill(0),
                  ]),
            usage: { tokens: 4 },
          };
        },
      }),
      optionsFor: () => undefined,
      embeddingOptions: () => undefined,
      cacheHint: () => undefined,
      normalizeUsage: () => ({ inputTokens: 4, outputTokens: 0, costUsd: 0.000004 }),
    }),
  }),
}));

const { buildDeps, composeFirestoreAgent } = await import('./deps.js');
type Deps = ReturnType<typeof buildDeps>;
const modelId = 'synthetic/embedding';
const revision = new Date('2026-10-07T12:00:00.000Z');
const model = {
  id: modelId,
  label: 'Synthetic embedding qualification',
  capabilities: { embedding: true },
  enabled: true,
  promptCostPerMTok: '1',
  completionCostPerMTok: '0',
  latencyClass: 'fast',
  createdAt: revision,
  updatedAt: revision,
};
const role = {
  role: 'embed',
  primaryModel: modelId,
  fallbackModel: modelId,
  params: {},
  updatedAt: revision,
};

async function context(deps: Deps, agentId: string): Promise<ToolContext> {
  if (!deps.persistence) throw new Error('Missing composed persistence');
  const { task } = await deps.persistence.tasks.createTask({
    agentId,
    type: 'chat_turn',
    trust: 'owner',
    trigger: {},
    budgetUsdLimit: '1.00',
    externalEventId: randomUUID(),
  });
  return {
    taskId: task.id,
    agentId,
    trust: 'owner',
    tainted: false,
    db: deps.db,
    now: () => new Date(),
    signal: new AbortController().signal,
    log: async () => {},
  };
}

async function execute(deps: Deps, name: string, args: unknown, ctx: ToolContext) {
  const tool = deps.registry.get(name)?.tool;
  if (!tool) throw new Error(`${name} missing from the actual composition`);
  return tool.execute(tool.inputSchema.parse(args), ctx);
}

function firestore(deps: Deps): InstallationStore {
  if (!deps.firestoreStore) throw new Error('Missing composed Firestore store');
  return deps.firestoreStore;
}

function save(deps: Deps, ctx: ToolContext, content = 'Synthetic glacier observation') {
  return execute(deps, 'memory.save', { content, category: 'experience', kind: 'episode' }, ctx);
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'configured Firestore memory tools through the actual router',
  () => {
    let deps: Deps;
    let cleanupStore: InstallationStore | undefined;
    let ctx: ToolContext;
    let space: EmbeddingSpace;
    beforeEach(() => {
      const host = process.env.FIRESTORE_EMULATOR_HOST;
      if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
        throw new Error('Only a loopback emulator is eligible');
      resetConfigForTest();
      fake.calls = [];
      fake.invalid = '';
      cleanupStore = undefined;
    });
    afterEach(async () => {
      if (cleanupStore) {
        await cleanupStore.db.recursiveDelete(cleanupStore.root);
        await cleanupStore.db.terminate();
      }
      resetConfigForTest();
    });

    async function compose(dimensions: number) {
      fake.dimensions = dimensions;
      const agentId = randomUUID();
      space = { provider: 'openrouter', model: modelId, dimensions, revision: 'r7' };
      deps = composeFirestoreAgent(
        loadConfig({
          PERSISTENCE_DRIVER: 'firestore',
          ASSISTANT_MODULES: 'minimal',
          ASSISTANT_WORKSPACE_ID: `embedding-e2e-${randomUUID()}`,
          FIRESTORE_AGENT_ID: agentId,
          FIRESTORE_EMBEDDING_SPACE: JSON.stringify(space),
          GCP_PROJECT: 'demo-assistant-test',
          QUEUE_DRIVER: 'local',
          FILES_DRIVER: 'local',
          OPENROUTER_API_KEY: '',
        }),
      );
      const store = deps.firestoreStore;
      if (!store) throw new Error('Missing actual Firestore store');
      cleanupStore = store;
      await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
      await store.doc('models', modelId).set(model);
      await store.doc('modelRoles', 'embed').set(role);
      await store.doc('coordination', 'budget-policy').set({
        dailyLimitMicros: 1_000_000,
        monthlyLimitMicros: 10_000_000,
        softPct: 80,
      });
      ctx = await context(deps, agentId);
      expect(deps.router).toBeInstanceOf(ModelRouter);
      expect(() => deps.db.select).toThrow('PostgreSQL access is unavailable');
    }

    it.each([384, 768, 1536, 2048])(
      'persists and recalls the exact %i-wide space and skips duplicate paid work',
      async (dimensions) => {
        await compose(dimensions);
        expect(await deps.router.embeddingSpace()).toEqual(space);
        expect(await save(deps, ctx)).toMatchObject({ saved: true, duplicate: false });
        expect(fake.calls).toHaveLength(1);
        expect(await save(deps, ctx)).toMatchObject({ saved: false, duplicate: true });
        expect(fake.calls).toHaveLength(1);
        const store = firestore(deps);
        const rows = await store.collection('memories').get();
        expect(rows.docs).toHaveLength(1);
        const row = rows.docs[0];
        if (!row) throw new Error('No saved memory');
        expect(row.get('embeddingSpaceKey')).toBe(embeddingSpaceIdentityKey(space));
        expect(row.get('embedding').toArray()).toHaveLength(dimensions);
        expect(
          await execute(deps, 'memory.recall', { query: 'unrelated semantic query' }, ctx),
        ).toMatchObject({ memories: [{ content: 'Synthetic glacier observation' }] });
        expect(fake.calls).toHaveLength(2);
        expect((await store.collection('modelCalls').get()).size).toBe(2);
        // Equal width does not make a different revision compatible.
        const foreign = embeddingSpaceIdentityKey({ ...space, revision: 'r8' });
        await row.ref.update({ embeddingSpaceKey: foreign, embeddingSpace: foreign });
        expect(
          await execute(deps, 'memory.recall', { query: 'unrelated semantic query' }, ctx),
        ).toEqual({ memories: [] });
      },
    );

    it('rejects a changed selected model before reservation, dispatch or a memory write', async () => {
      await compose(768);
      const store = firestore(deps);
      await store.doc('modelRoles', 'embed').update({ primaryModel: 'synthetic/foreign' });
      await expect(save(deps, ctx)).rejects.toThrow('embedding role must use');
      expect(fake.calls).toHaveLength(0);
      expect((await store.collection('memories').get()).size).toBe(0);
      expect((await store.collection('modelCalls').get()).size).toBe(0);
      expect((await store.doc('coordination', 'budget-holds').get()).exists).toBe(false);
    });

    it('rejects a disabled model and a same-width revision mismatch before paid work', async () => {
      await compose(1536);
      const store = firestore(deps);
      await store.doc('models', modelId).update({ enabled: false });
      await expect(save(deps, ctx)).rejects.toThrow('disabled');
      await store.doc('models', modelId).update({ enabled: true });
      await expect(
        deps.router.embedWithIdentity(['stale revision'], {
          expectedSpace: { ...space, revision: 'r8' },
        }),
      ).rejects.toThrow('identity');
      expect(fake.calls).toHaveLength(0);
      expect((await store.collection('memories').get()).size).toBe(0);
      expect((await store.collection('modelCalls').get()).size).toBe(0);
      expect((await store.doc('coordination', 'budget-holds').get()).exists).toBe(false);
    });

    it.each([
      { dimensions: 768, invalid: 'width' },
      { dimensions: 1536, invalid: 'width' },
      { dimensions: 768, invalid: 'count' },
      { dimensions: 1536, invalid: 'count' },
      { dimensions: 768, invalid: 'nonfinite' },
      { dimensions: 1536, invalid: 'nonfinite' },
    ] as const)(
      'meters malformed $dimensions-wide $invalid results once without storing them',
      async ({ dimensions, invalid }) => {
        await compose(dimensions);
        fake.invalid = invalid;
        await expect(save(deps, ctx)).rejects.toThrow(
          invalid === 'count' ? 'Expected 1 embeddings, but received 0' : 'invalid vector',
        );
        expect(fake.calls).toHaveLength(1);
        const store = firestore(deps);
        expect((await store.collection('memories').get()).size).toBe(0);
        expect((await store.collection('modelCalls').get()).size).toBe(1);
      },
    );
  },
);

describe('PostgreSQL composition keeps fixed width and exact catalog revision', () => {
  let deps: Deps;
  let ctx: ToolContext;
  let priorRole: typeof modelRoles.$inferSelect | undefined;
  beforeEach(async () => {
    fake.dimensions = 1536;
    fake.invalid = '';
    fake.calls = [];
    resetConfigForTest();
    vi.stubEnv('PERSISTENCE_DRIVER', 'postgres');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('FILES_DRIVER', 'local');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    deps = buildDeps();
    [priorRole] = await deps.db.select().from(modelRoles).where(eq(modelRoles.role, 'embed'));
    await deps.db
      .insert(models)
      .values(model)
      .onConflictDoUpdate({ target: models.id, set: model });
    await deps.db
      .insert(modelRoles)
      .values(role)
      .onConflictDoUpdate({ target: modelRoles.role, set: role });
    const [owner] = await deps.db.select().from(agents).limit(1);
    if (!owner) throw new Error('Missing allocated test owner');
    ctx = await context(deps, owner.id);
    expect(deps.router).toBeInstanceOf(ModelRouter);
  });
  afterEach(async () => {
    if (priorRole)
      await deps.db.update(modelRoles).set(priorRole).where(eq(modelRoles.role, 'embed'));
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('writes and recalls a 1536-wide catalog identity through the shipped composition', async () => {
    const space = await deps.router.embeddingSpace();
    expect(space).toEqual({
      provider: 'openrouter',
      model: modelId,
      dimensions: 1536,
      revision: revision.toISOString(),
    });
    const content = `Synthetic tundra observation ${randomUUID()}`;
    expect(await save(deps, ctx, content)).toMatchObject({ saved: true });
    const [row] = await deps.db.select().from(memories).where(eq(memories.content, content));
    expect(row?.embedding).toHaveLength(1536);
    expect(row?.embeddingSpaceKey).toBe(embeddingSpaceIdentityKey(space));
    expect(
      await execute(deps, 'memory.recall', { query: 'unrelated semantic query' }, ctx),
    ).toMatchObject({ memories: expect.arrayContaining([expect.objectContaining({ content })]) });
    expect(fake.calls).toHaveLength(2);
    const calls = await deps.db.select().from(modelCalls).where(eq(modelCalls.model, modelId));
    expect(calls).toHaveLength(2);
    const changed = { ...space, revision: 'different-revision' };
    await expect(
      deps.router.embedWithIdentity(['refuse revision'], { expectedSpace: changed }),
    ).rejects.toThrow('revision');
    const before = fake.calls.length;
    fake.dimensions = 768;
    await expect(save(deps, ctx, 'Synthetic incompatible width')).rejects.toThrow('dimensions');
    expect(fake.calls).toHaveLength(before);
  });
});
