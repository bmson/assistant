import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreGoalMutationRepository } from './goal-mutations.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'assignment-unaware Firestore recovery protection',
  () => {
    let store: InstallationStore;
    let owner: string;
    beforeEach(async () => {
      store = emulatorStore();
      owner = randomUUID();
      await store.doc('agents', owner).set({ id: owner, timezone: 'UTC' });
    });
    afterEach(async () => {
      await disposeStore(store);
    });
    it.each([false, 0, '', {}, { version: 1 }])(
      'blocks generic work and mutations for future assignment value %j',
      async (researchAssignment) => {
        const id = randomUUID();
        const goal = {
          id,
          agentId: owner,
          title: 'Synthetic held research',
          status: 'active',
          archivedAt: null,
          researchAssignment,
        };
        await store.doc('goals', id).set(goal);
        const repository = new FirestoreGoalMutationRepository(store, owner);
        await expect(
          repository.startWork(id, () => {
            throw new Error('must not prepare automation');
          }),
        ).rejects.toThrow('Research assignments');
        await expect(repository.setStatus(id, 'paused')).rejects.toThrow('Research assignments');
        await expect(repository.setAutonomy(id, true)).rejects.toThrow('Research assignments');
        await expect(repository.restore(id)).rejects.toThrow('Research assignments');
        expect((await store.doc('goals', id).get()).data()).toEqual(goal);
        expect((await store.collection('tasks').get()).empty).toBe(true);
        expect((await store.collection('schedules').get()).empty).toBe(true);
      },
    );
  },
);
