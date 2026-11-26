import { type HouseholdHandoffRepository, householdHandoffRecord } from '@assistant/persistence';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import type { InstallationStore } from './store.js';

export function createFirestoreHouseholdHandoffRepository(
  store: InstallationStore,
): HouseholdHandoffRepository {
  return {
    read(agentId) {
      return store.db.runTransaction(
        async (tx) => {
          await assertPrivacyErasureInactiveInTransaction(tx, store, agentId);
          const doc = await tx.get(store.doc('householdHandoffs', agentId));
          if (!doc.exists) return null;
          const row = householdHandoffRecord.parse(doc.data());
          if (row.agentId !== agentId) throw new Error('Household plan owner mismatch');
          return row;
        },
        { readOnly: true },
      );
    },
    change(expected, input) {
      const next = householdHandoffRecord.parse(input);
      return store.db.runTransaction(async (tx) => {
        const ref = store.doc('householdHandoffs', next.agentId);
        await assertPrivacyErasureInactiveInTransaction(tx, store, next.agentId);
        const [owner, current] = await tx.getAll(store.doc('agents', next.agentId), ref);
        if (owner?.get('id') !== next.agentId || !current) return false;
        if (expected === null) {
          if (current.exists) return false;
        } else if (
          current.get('agentId') !== next.agentId ||
          current.get('revision') !== expected
        ) {
          return false;
        }
        tx.set(ref, next);
        return true;
      });
    },
  };
}
