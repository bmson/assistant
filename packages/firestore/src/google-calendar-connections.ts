import {
  createGoogleCalendarConnectionRepository,
  emptyGoogleCalendarConnection,
  type GoogleCalendarConnectionRepository,
  parseGoogleCalendarConnection,
  readHouseholdCalendarSettings,
} from '@assistant/persistence';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

export function createFirestoreGoogleCalendarConnectionRepository(
  store: InstallationStore,
): GoogleCalendarConnectionRepository {
  return createGoogleCalendarConnectionRepository({
    async read(ownerId) {
      const [doc, settings] = await store.db.getAll(
        store.doc('googleCalendarConnections', ownerId),
        store.doc('googleHouseholdCalendarChoices', ownerId),
      );
      return doc?.exists ? readState(doc.data(), settings?.data(), ownerId) : null;
    },
    update: (ownerId, change) =>
      store.db.runTransaction(async (tx) => {
        const ref = store.doc('googleCalendarConnections', ownerId);
        const householdRef = store.doc('googleHouseholdCalendarChoices', ownerId);
        const [doc, settingsDoc] = await tx.getAll(ref, householdRef);
        const prior = doc?.exists ? readState(doc.data(), settingsDoc?.data(), ownerId) : null;
        const {
          state: { household, ...state },
          result,
        } = change(prior ?? emptyGoogleCalendarConnection(ownerId));
        tx.set(
          ref,
          encodeRecord({
            agentId: ownerId,
            state: parseGoogleCalendarConnection(state, ownerId),
            updatedAt: store.now(),
          }),
        );
        if (
          household &&
          state.connection &&
          (prior?.household !== household || prior.connection?.id !== state.connection.id)
        ) {
          tx.set(
            householdRef,
            encodeRecord({
              agentId: ownerId,
              settings: { ...household, connectionId: state.connection.id },
            }),
          );
        } else if (!state.connection && settingsDoc?.exists) {
          tx.delete(householdRef);
        }
        return result;
      }),
  });
}

function readState(value: unknown, settingsValue: unknown, ownerId: string) {
  const row = decodeRecord<{ agentId?: unknown; state?: unknown }>(value);
  if (row?.agentId !== ownerId) throw new Error('Google Calendar owner mismatch');
  const state = parseGoogleCalendarConnection(row.state, ownerId);
  const settings = decodeRecord<{ agentId?: unknown; settings?: unknown }>(settingsValue);
  if (settings && settings.agentId !== ownerId)
    throw new Error('Household Calendar owner mismatch');
  const household = readHouseholdCalendarSettings(settings?.settings, state.connection?.id);
  return { ...state, ...(household ? { household } : {}) };
}
