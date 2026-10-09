import { documentKey, type InstallationStore } from './store.js';

/** Configuring an owner ID must never hide a second owner in the same installation. */
export async function assertFirestoreInstallationOwner(
  store: InstallationStore,
  expectedAgentId?: string,
  allowEmpty = false,
) {
  const snapshot = await store.collection('agents').limit(2).get();
  if (allowEmpty && snapshot.empty) return;
  const owner = snapshot.docs[0];
  const id = owner?.get('id');
  if (
    snapshot.size !== 1 ||
    !owner ||
    typeof id !== 'string' ||
    documentKey(id) !== owner.id ||
    (expectedAgentId && id !== expectedAgentId)
  )
    throw new Error(
      'This installation requires exactly one owner; review conflicting owner data before continuing',
    );
  return id;
}
