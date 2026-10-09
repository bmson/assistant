import { describe, expect, it } from 'vitest';
import { FirestoreModelRoutingRepository } from './model-routing.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore model-call money bounds', () => {
  it('uses the common numeric(10,6) bound and validates persisted task budget precision', async () => {
    const store = emulatorStore();
    try {
      const repository = new FirestoreModelRoutingRepository(store, 'owner');
      const base = {
        role: 'draft',
        model: 'fixture/model',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: '9999.999999',
      };
      const id = await repository.recordCall(base);
      const stored = await store.doc('modelCalls', id).get();
      expect(stored.get('costUsd')).toBe('9999.999999');
      await expect(repository.recordCall({ ...base, costUsd: '10000.000000' })).rejects.toThrow(
        'numeric(10,6)',
      );
      expect((await store.collection('modelCalls').get()).size).toBe(1);

      await store.doc('tasks', 'task').set({
        id: 'task',
        agentId: 'owner',
        type: 'chat_turn',
        budgetUsdLimit: '9999.9999',
        spentUsd: '9999.999999',
      });
      await expect(repository.taskBudget('task')).resolves.toEqual({
        limit: '9999.9999',
        spent: '9999.999999',
      });
      await store.doc('tasks', 'task').update({ budgetUsdLimit: '10000.0000' });
      await expect(repository.taskBudget('task')).rejects.toThrow('numeric(8,4)');
      await store.doc('tasks', 'task').update({ budgetUsdLimit: '1.00001' });
      await expect(repository.taskBudget('task')).rejects.toThrow('numeric(8,4)');
      await store
        .doc('tasks', 'task')
        .update({ budgetUsdLimit: '9999.9999', spentUsd: '10000.000000' });
      await expect(repository.taskBudget('task')).rejects.toThrow('numeric(10,6)');
    } finally {
      await disposeStore(store);
    }
  });
});
