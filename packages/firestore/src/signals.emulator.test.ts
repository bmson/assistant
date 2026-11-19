import { describe } from 'vitest';
import { signalContract } from '../../persistence/src/signal-test-scenarios.js';
import { createFirestoreSignalRepository } from './signals.js';
import { encodeRecord } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore producer signal contract', () => {
  signalContract(async (run) => {
    const store = emulatorStore();
    try {
      await run({
        repository: createFirestoreSignalRepository(store),
        async seedOwner(agentId) {
          await store.doc('agents', agentId).set({ id: agentId, email: `${agentId}@example.test` });
        },
        async seedSource(row) {
          await store.doc('emailIngest', row.id).set(encodeRecord(row));
        },
      });
    } finally {
      await disposeStore(store);
    }
  });
});
