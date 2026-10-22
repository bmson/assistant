import {
  type PhoneCalendarCompatibilityRepository,
  parsePhoneCalendarSharingState,
  phoneCalendarCacheKey,
  phoneCalendarSharingErasureTombstone,
} from '@assistant/persistence';
import type { Transaction } from '@google-cloud/firestore';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

async function sharingState(tx: Transaction, store: InstallationStore, ownerId: string) {
  const snapshot = await tx.get(store.doc('phoneCalendarSharing', ownerId));
  if (!snapshot.exists) return null;
  const row = decodeRecord<{ id: string; agentId: string; state: unknown }>(snapshot.data());
  const state = parsePhoneCalendarSharingState(row.state, ownerId);
  if (row.id !== ownerId || row.agentId !== ownerId || !state)
    throw new Error('Phone calendar sharing ownership or state is invalid');
  return state;
}

export function createFirestorePhoneCalendarCompatibilityRepository(
  store: InstallationStore,
): PhoneCalendarCompatibilityRepository {
  return {
    read: (ownerId) =>
      store.db.runTransaction(async (tx) => {
        await assertPrivacyErasureInactiveInTransaction(tx, store, ownerId);
        const state = await sharingState(tx, store, ownerId);
        return { schema: state ? 'sharing' : 'legacy', state };
      }),
  };
}

/** Caller establishes the active erasure generation before these atomic writes. */
export async function eraseFirestorePhoneCalendarSharing(
  tx: Transaction,
  store: InstallationStore,
  ownerId: string,
  now: Date,
) {
  const state = phoneCalendarSharingErasureTombstone(
    ownerId,
    await sharingState(tx, store, ownerId),
    now,
  );
  tx.set(
    store.doc('phoneCalendarSharing', ownerId),
    encodeRecord({ id: ownerId, agentId: ownerId, state, updatedAt: now }),
  );
  tx.delete(store.doc('toolCache', phoneCalendarCacheKey(ownerId)));
}
