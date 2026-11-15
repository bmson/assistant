import {
  createGoogleCalendarConnectionRepository,
  emptyGoogleCalendarConnection,
  type GoogleCalendarConnectionRepository,
  parseGoogleCalendarConnection,
} from '@assistant/persistence';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

export function createFirestoreGoogleCalendarConnectionRepository(
  store: InstallationStore,
): GoogleCalendarConnectionRepository {
  return createGoogleCalendarConnectionRepository({
    async read(ownerId) {
      const doc = await store.doc('googleCalendarConnections', ownerId).get();
      return doc.exists ? readState(doc.data(), ownerId) : null;
    },
    update: (ownerId, change) =>
      store.db.runTransaction(async (tx) => {
        const ref = store.doc('googleCalendarConnections', ownerId);
        const doc = await tx.get(ref);
        const { state, result } = change(
          doc.exists ? readState(doc.data(), ownerId) : emptyGoogleCalendarConnection(ownerId),
        );
        tx.set(
          ref,
          encodeRecord({
            agentId: ownerId,
            state: parseGoogleCalendarConnection(state, ownerId),
            updatedAt: store.now(),
          }),
        );
        return result;
      }),
  });
}

function readState(value: unknown, ownerId: string) {
  const row = decodeRecord<{ agentId?: unknown; state?: unknown }>(value);
  if (row?.agentId !== ownerId) throw new Error('Google Calendar owner mismatch');
  return parseGoogleCalendarConnection(row.state, ownerId);
}
