import { afterAll, describe } from 'vitest';
import { signalContract } from '../../persistence/src/signal-test-scenarios.js';
import { createFirestoreSignalRepository } from './signals.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore producer signal contract', () => {
  let opened: InstallationStore | undefined;
  afterAll(async () => {
    if (opened) await disposeStore(opened);
  });

  signalContract(async () => {
    const store = emulatorStore();
    opened = store;
    return {
      repository: createFirestoreSignalRepository(store),
      async seedOwner(agentId) {
        await store.doc('agents', agentId).set({ id: agentId, email: `${agentId}@example.test` });
      },
      async seedSource(row) {
        await store.doc('emailIngest', row.id).set(encodeRecord(row));
      },
    };
  });
});
