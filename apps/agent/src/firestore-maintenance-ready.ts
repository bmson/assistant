import { assertFirestoreInstallationOwner, type InstallationStore } from '@assistant/firestore';

/** New installs are ready without a marker; imported workspaces must be activated first. */
export async function firestoreMaintenanceReady(
  store: InstallationStore | undefined,
  agentId: string,
): Promise<boolean> {
  if (!store) return false;
  try {
    await assertFirestoreInstallationOwner(store, agentId);
  } catch {
    return false;
  }
  const owner = await store.doc('agents', agentId).get();
  if (!owner.exists || owner.get('id') !== agentId) return false;
  const migration = await store.doc('coordination', 'migration').get();
  return !migration.exists || migration.get('status') === 'active';
}
