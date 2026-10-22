import type { PhoneCalendarSharingRepository, Records } from '@assistant/persistence';
import {
  parsePhoneCalendarSharingState,
  parsePhoneCalendarSnapshotCache,
  phoneCalendarCacheKey,
  phoneCalendarCacheRecord,
  transitionPhoneCalendarSharing,
} from '@assistant/persistence';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

function readSharingRecord(snapshot: { exists: boolean; data(): unknown }, ownerId: string) {
  if (!snapshot.exists) return null;
  const value = decodeRecord<Records['phoneCalendarSharing']>(snapshot.data());
  if (!value || value.id !== ownerId || value.agentId !== ownerId)
    throw new Error('Stored phone calendar sharing record is malformed');
  return value;
}

export function createFirestorePhoneCalendarSharingRepository(
  store: InstallationStore,
): PhoneCalendarSharingRepository {
  return {
    get: async (ownerId) =>
      store.db.runTransaction(async (tx) => {
        await assertPrivacyErasureInactiveInTransaction(tx, store, ownerId);
        const record = readSharingRecord(
          await tx.get(store.doc('phoneCalendarSharing', ownerId)),
          ownerId,
        );
        if (!record) return null;
        const state = parsePhoneCalendarSharingState(record.state, ownerId);
        if (!state) throw new Error('Stored phone calendar sharing state is malformed');
        return state;
      }),
    readSnapshot: async (ownerId, now = store.now()) =>
      store.db.runTransaction(async (tx) => {
        await assertPrivacyErasureInactiveInTransaction(tx, store, ownerId);
        const stateRef = store.doc('phoneCalendarSharing', ownerId);
        const cacheRef = store.doc('toolCache', phoneCalendarCacheKey(ownerId));
        const [stateSnapshot, cacheSnapshot] = await Promise.all([
          tx.get(stateRef),
          tx.get(cacheRef),
        ]);
        const record = readSharingRecord(stateSnapshot, ownerId);
        if (!record) return { state: null, snapshot: null };
        const state = parsePhoneCalendarSharingState(record.state, ownerId);
        if (!state) throw new Error('Stored phone calendar sharing state is malformed');
        const cached = cacheSnapshot.exists
          ? decodeRecord<{ result?: unknown; expiresAt?: unknown }>(cacheSnapshot.data())
          : null;
        return {
          state,
          snapshot: parsePhoneCalendarSnapshotCache(state, cached?.result, cached?.expiresAt, now),
        };
      }),
    apply: async (ownerId, command, now = store.now()) =>
      store.db.runTransaction(async (tx) => {
        await assertPrivacyErasureInactiveInTransaction(tx, store, ownerId);
        const stateRef = store.doc('phoneCalendarSharing', ownerId);
        const currentRecord = readSharingRecord(await tx.get(stateRef), ownerId);
        const current = currentRecord
          ? parsePhoneCalendarSharingState(currentRecord.state, ownerId)
          : null;
        if (currentRecord && !current)
          throw new Error('Stored phone calendar sharing state is malformed');
        const transition = transitionPhoneCalendarSharing(ownerId, current, command, now);
        if (!transition.result.ok) return transition.result;

        tx.set(
          stateRef,
          encodeRecord({
            id: ownerId,
            agentId: ownerId,
            state: transition.result.state,
            updatedAt: now,
          } satisfies Records['phoneCalendarSharing']),
        );
        if (transition.snapshot !== undefined) {
          const record = phoneCalendarCacheRecord(ownerId, transition.snapshot, now);
          tx.set(store.doc('toolCache', record.cacheKey), encodeRecord(record));
        }
        return transition.result;
      }),
  };
}
