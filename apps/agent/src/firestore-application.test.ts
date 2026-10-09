import { describe, it } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { firestoreApplicationSmoke } from '../../../scripts/firestore-application-smoke.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore application smoke', () => {
  it('exercises synthetic application and owner-card persistence', async () => {
    const store = emulatorStore();
    try {
      await firestoreApplicationSmoke(store);
    } finally {
      await disposeStore(store);
    }
  }, 30_000);
});
