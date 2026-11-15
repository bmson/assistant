import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { firestoreEstimatedCostSourceBinding } from './estimated-cost-binding.js';
import type { InstallationStore } from './store.js';
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
  },
);
