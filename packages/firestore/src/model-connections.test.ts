import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FirestoreModelCatalogRepository,
  FirestoreModelConnectionRepository,
} from './model-connections.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore model connections', () => {
  let store: InstallationStore;
  let connections: FirestoreModelConnectionRepository;

  beforeEach(() => {
    store = emulatorStore();
    connections = new FirestoreModelConnectionRepository(store);
  });

  afterEach(async () => disposeStore(store));

  const openai = {
    id: 'openai',
    kind: 'openai',
    label: 'OpenAI',
    baseUrl: null,
    vertexProject: null,
    vertexLocation: null,
    enabled: true,
  };

  it('keeps the sealed key across edits that do not replace it', async () => {
    const created = await connections.upsert({ ...openai, apiKeyEncrypted: 'v2.sealed' });
    expect(created.apiKeyEncrypted).toBe('v2.sealed');

    const renamed = await connections.upsert({ ...openai, label: 'OpenAI (work)' });
    expect(renamed.apiKeyEncrypted).toBe('v2.sealed');
    expect(renamed.createdAt).toEqual(created.createdAt);

    const cleared = await connections.upsert({ ...openai, apiKeyEncrypted: null });
    expect(cleared.apiKeyEncrypted).toBeNull();
    expect(await connections.list()).toEqual([
      expect.objectContaining({ label: 'OpenAI', apiKeyEncrypted: null }),
    ]);
  });

  it('records a test result without touching the adapter version', async () => {
    const saved = await connections.upsert({ ...openai, apiKeyEncrypted: 'v2.sealed' });
    expect(await connections.recordTest('openai', { ok: false, error: '401 invalid key' })).toBe(
      true,
    );
    const [row] = await connections.list();
    expect(row?.lastError).toBe('401 invalid key');
    expect(row?.lastTestedAt).toBeInstanceOf(Date);
    expect(row?.updatedAt).toEqual(saved.updatedAt);
  });

  it('toggles and removes only existing connections', async () => {
    expect(await connections.setEnabled('openai', false)).toBe(false);
    await connections.upsert(openai);
    expect(await connections.setEnabled('openai', false)).toBe(true);
    expect((await connections.list())[0]?.enabled).toBe(false);
    expect(await connections.remove('openai')).toBe(true);
    expect(await connections.remove('openai')).toBe(false);
    expect(await connections.list()).toEqual([]);
  });
});

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore model catalog', () => {
  let store: InstallationStore;
  let catalog: FirestoreModelCatalogRepository;

  beforeEach(async () => {
    store = emulatorStore();
    catalog = new FirestoreModelCatalogRepository(store);
    await store.doc('models', 'minimax/minimax-m2.7').set({
      id: 'minimax/minimax-m2.7',
      label: 'Original',
      capabilities: { tools: true },
      promptCostPerMTok: '1.0000',
      completionCostPerMTok: '2.0000',
      latencyClass: 'medium',
      enabled: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await store.doc('modelRoles', 'reason').set({
      role: 'reason',
      primaryModel: 'minimax/minimax-m2.7',
      fallbackModel: 'minimax/minimax-m2.7',
      params: {},
      updatedAt: new Date(0),
    });
  });

  afterEach(async () => disposeStore(store));

  const priced = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    label: id,
    capabilities: { tools: true },
    promptCostPerMTok: '1.0000',
    completionCostPerMTok: '2.0000',
    latencyClass: 'medium',
    enabled: true,
    ...overrides,
  });

  it('points a role only at enabled, priced models', async () => {
    await catalog.upsertModel(priced('openai:gpt-5.1'));
    await catalog.upsertModel(priced('openai:unpriced', { promptCostPerMTok: null }));

    await expect(
      catalog.assignRoles([
        { role: 'reason', primaryModel: 'openai:gpt-5.1', fallbackModel: 'openai:unpriced' },
      ]),
    ).rejects.toThrow('not enabled with prices');
    await expect(
      catalog.assignRoles([
        { role: 'nope', primaryModel: 'openai:gpt-5.1', fallbackModel: 'openai:gpt-5.1' },
      ]),
    ).rejects.toThrow('Unknown model role');

    await catalog.assignRoles([
      { role: 'reason', primaryModel: 'openai:gpt-5.1', fallbackModel: 'openai:gpt-5.1' },
    ]);
    expect(await catalog.listRoles()).toEqual([
      expect.objectContaining({ role: 'reason', primaryModel: 'openai:gpt-5.1', params: {} }),
    ]);
    expect((await catalog.listModels()).map((row) => row.id)).toEqual(
      expect.arrayContaining(['minimax/minimax-m2.7', 'openai:gpt-5.1', 'openai:unpriced']),
    );
    const revisions = await catalog.listRoleRevisions();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      beforeState: {
        primaryModel: 'minimax/minimax-m2.7',
        fallbackModel: 'minimax/minimax-m2.7',
      },
      afterState: {
        primaryModel: 'openai:gpt-5.1',
        fallbackModel: 'openai:gpt-5.1',
      },
      baselineKnown: true,
    });
    const revisionId = revisions[0]?.id;
    if (!revisionId) throw new Error('Expected routing revision');
    expect(await catalog.rollbackRoleRevision(revisionId)).toBe(true);
    expect(await catalog.rollbackRoleRevision(revisionId)).toBe(false);
    expect(await catalog.listRoles()).toEqual([
      expect.objectContaining({
        role: 'reason',
        primaryModel: 'minimax/minimax-m2.7',
        fallbackModel: 'minimax/minimax-m2.7',
      }),
    ]);
  });
});
