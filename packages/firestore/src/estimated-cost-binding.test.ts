import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { firestoreEstimatedCostSourceBinding } from './estimated-cost-binding.js';
import { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore estimated cost source binding',
  () => {
    let store: InstallationStore;
    beforeEach(async () => {
      store = emulatorStore();
      await Promise.all([
        store
          .doc('tasks', 'task')
          .set({ id: 'task', agentId: 'owner', conversationId: 'conversation' }),
        store
          .doc('conversations', 'conversation')
          .set({ id: 'conversation', agentId: 'owner', modelOverride: null }),
        store.doc('modelRoles', 'draft').set({
          role: 'draft',
          primaryModel: 'openai:one',
          fallbackModel: 'other/model',
          params: {},
        }),
        store
          .doc('models', 'openai:one')
          .set({ id: 'openai:one', enabled: true, promptCostPerMTok: '1.0000' }),
        store
          .doc('models', 'other/model')
          .set({ id: 'other/model', enabled: true, promptCostPerMTok: '0.5000' }),
        store.doc('modelConnections', 'openai').set({
          id: 'openai',
          kind: 'openai',
          apiKeyEncrypted: 'synthetic',
          enabled: true,
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        }),
        store.doc('modelConnections', 'openrouter').set({
          id: 'openrouter',
          kind: 'openrouter',
          apiKeyEncrypted: 'synthetic',
          enabled: true,
        }),
        store
          .doc('coordination', 'budget-policy')
          .set({ dailyLimitMicros: 1_000_000, monthlyLimitMicros: 10_000_000, softPct: 80 }),
      ]);
    });
    afterEach(async () => {
      await disposeStore(store);
    });
    it('binds every configured model and connection, and changes when a source changes', async () => {
      const input = {
        actor: { installationId: store.installationId, ownerId: 'owner' },
        taskId: 'task',
        role: 'draft',
        selectedModelId: 'openai:one',
        routingDigest: 'a'.repeat(64),
        critical: true,
      };
      const read = () =>
        store.db.runTransaction((tx) => firestoreEstimatedCostSourceBinding(tx, store, input), {
          readOnly: true,
        });
      const first = await read();
      expect(first).toMatchObject({
        role: 'draft',
        critical: true,
        selectedModelId: 'openai:one',
        privacyGeneration: null,
      });
      expect(first.modelRows.map((row) => row.id)).toEqual(['openai:one', 'other/model']);
      expect(first.connectionRows.map((row) => row.id)).toEqual(['openai', 'openrouter']);
      expect(await read()).toEqual(first);
      await store.doc('models', 'other/model').update({ promptCostPerMTok: '0.6000' });
      expect((await read()).modelRows).not.toEqual(first.modelRows);
      await store.doc('modelConnections', 'openai').update({ enabled: false });
      await expect(read()).rejects.toThrow('Unproven model connection');
      await expect(
        store.db.runTransaction(
          (tx) =>
            firestoreEstimatedCostSourceBinding(tx, store, {
              ...input,
              actor: { ...input.actor, installationId: 'other' },
            }),
          { readOnly: true },
        ),
      ).rejects.toThrow('Installation scope');
    });

    it('binds a qualified pinned environment source only when the stored connection is absent', async () => {
      await store.doc('modelConnections', 'openrouter').delete();
      const input = {
        actor: { installationId: store.installationId, ownerId: 'owner' },
        taskId: 'task',
        role: 'draft',
        selectedModelId: 'openai:one',
        routingDigest: 'a'.repeat(64),
        critical: true,
      };
      const manifest = {
        provider: 'openrouter' as const,
        endpoint: 'https://openrouter.ai/api/v1' as const,
        installationId: store.installationId,
        projectId: 'demo-assistant-test',
        secretVersion: 'projects/demo-assistant-test/secrets/openrouter-api-key/versions/7',
        sourceRelease: 'a'.repeat(40),
      };
      const configured = (source: typeof manifest) =>
        new InstallationStore(
          store.db,
          store.installationId,
          store.now,
          'demo-assistant-test',
          '(default)',
          source,
        );
      const read = (target: InstallationStore) =>
        target.db.runTransaction((tx) => firestoreEstimatedCostSourceBinding(tx, target, input), {
          readOnly: true,
        });
      await expect(read(store)).rejects.toThrow('Unproven model connection');
      const first = await read(configured(manifest));
      expect(first.connectionRows.map((row) => row.id)).toEqual(['openai', 'openrouter']);
      expect(
        (
          await read(
            configured({ ...manifest, secretVersion: manifest.secretVersion.replace('/7', '/8') }),
          )
        ).connectionRows,
      ).not.toEqual(first.connectionRows);
      expect(() =>
        configured({ ...manifest, secretVersion: manifest.secretVersion.replace('/7', '/latest') }),
      ).toThrow('Invalid estimated cost runtime provider source');
      expect(() => configured({ ...manifest, installationId: 'another' })).toThrow(
        'scope mismatch',
      );
      await store
        .doc('modelConnections', 'openrouter')
        .set({ id: 'openrouter', kind: 'openrouter', enabled: false });
      await expect(read(configured(manifest))).rejects.toThrow('Unproven model connection');
    });
  },
);
