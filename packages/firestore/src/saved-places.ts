import { type SavedPlacesRepository, savedPlaceRecord } from '@assistant/persistence';
import { privacyErasureGeneration } from './privacy-erasure.js';
import { documentKey, type InstallationStore } from './store.js';

export function createFirestoreSavedPlacesRepository(
  store: InstallationStore,
): SavedPlacesRepository {
  return {
    list(agentId) {
      return store.db.runTransaction(
        async (tx) => {
          const [owner, erasure, rows] = await Promise.all([
            tx.get(store.doc('agents', agentId)),
            tx.get(store.doc('privacyErasureJobs', agentId)),
            tx.get(store.collection('savedPlaces').where('agentId', '==', agentId)),
          ]);
          if (owner.get('id') !== agentId) throw new Error('Saved places owner unavailable');
          const generation = privacyErasureGeneration(erasure, agentId);
          return {
            generation,
            places: rows.docs.flatMap((doc) => {
              const {
                id,
                agentId: storedOwner,
                revision,
                details,
              } = savedPlaceRecord.parse(doc.data());
              if (storedOwner !== agentId || documentKey(id) !== doc.id)
                throw new Error('Saved place identity mismatch');
              return details ? [{ id, revision, details }] : [];
            }),
          };
        },
        { readOnly: true },
      );
    },
    read(agentId, id, observed) {
      return store.db.runTransaction(
        async (tx) => {
          const [owner, erasure, doc] = await tx.getAll(
            store.doc('agents', agentId),
            store.doc('privacyErasureJobs', agentId),
            store.doc('savedPlaces', id),
          );
          if (
            owner?.get('id') !== agentId ||
            !erasure ||
            privacyErasureGeneration(erasure, agentId) !== observed ||
            !doc?.exists ||
            doc.get('agentId') !== agentId
          )
            return null;
          const row = savedPlaceRecord.parse(doc.data());
          return row.id === id ? row : null;
        },
        { readOnly: true },
      );
    },
    change(agentId, { id, generation, expectedRevision, revision, details }) {
      return store.db.runTransaction(async (tx) => {
        const ref = store.doc('savedPlaces', id);
        const [owner, erasure, current] = await tx.getAll(
          store.doc('agents', agentId),
          store.doc('privacyErasureJobs', agentId),
          ref,
        );
        if (
          owner?.get('id') !== agentId ||
          !erasure ||
          !current ||
          privacyErasureGeneration(erasure, agentId) !== generation
        )
          return false;
        const data = { id, agentId, revision, details };
        if (expectedRevision === null) {
          if (current.exists) return false;
          tx.create(ref, data);
          return true;
        }
        if (
          current.get('id') !== id ||
          current.get('agentId') !== agentId ||
          current.get('revision') !== expectedRevision ||
          current.get('details') == null
        )
          return false;
        tx.set(ref, data);
        return true;
      });
    },
  };
}
