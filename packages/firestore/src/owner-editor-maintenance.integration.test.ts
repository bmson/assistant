import { randomUUID } from 'node:crypto';
import { ownerEditorPrivacyDigest } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inspectFirestoreOwnerEditorMaintenanceState,
  type OwnerEditorMaintenanceRequest,
  rotateFirestoreOwnerEditorEpochForMaintenance,
} from './owner-editor-maintenance.js';
import { createInstallationStore, encodeRecord, type InstallationStore } from './store.js';
import { disposeStore } from './test-store.js';

function isolatedMaintenanceEmulatorStore(): InstallationStore {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
    throw new Error('Maintenance Firestore tests require a loopback emulator');
  }
  return createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId: `owner-editor-maintenance-test-${randomUUID()}`,
    databaseId: '(default)',
  });
}

// Authored for ordinary isolated Firestore CI. Never a live-service target.
describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('maintenance native Firestore CAS', () => {
  let store: InstallationStore;
  let ownerId: string;
  beforeEach(async () => {
    store = isolatedMaintenanceEmulatorStore();
    ownerId = randomUUID();
    if (!store.projectId) throw new Error('Missing isolated fixture project');
    await store.doc('agents', ownerId).create({ id: ownerId });
    await store.doc('coordination', 'migration').create(
      encodeRecord({
        status: 'active',
        formatVersion: 3,
        sourceAgentId: ownerId,
        target: {
          projectId: store.projectId,
          databaseId: store.databaseId,
          installationId: store.installationId,
        },
        bundleChecksum: 'a'.repeat(64),
        completedWrites: 2,
        totalWrites: 2,
        activation: {
          sourceWriteFenceId: 'synthetic-fence',
          sourceWritesDrainedAt: new Date('2026-10-26T12:00:00Z'),
          snapshotUri: 'gs://synthetic/checkpoint',
          snapshotGeneration: '123',
          snapshotSha256: 'b'.repeat(64),
        },
      }),
    );
  });
  afterEach(async () => disposeStore(store));

  it('permits only one native transaction from the same absent epoch observation', async () => {
    const original = await inspectFirestoreOwnerEditorMaintenanceState(store, ownerId);
    const request = (): OwnerEditorMaintenanceRequest => ({
      ownerId,
      operationId: randomUUID(),
      requestDigest: randomUUID().replaceAll('-', '').repeat(2),
      action: 'provision-disabled',
      targetEpoch: randomUUID(),
      expectedEpochStateDigestOrAbsent: null,
      expectedEpochNativeVersionOrAbsent: null,
      expectedOwnerNativeVersion: original.ownerNativeVersion,
      expectedPrivacyDigest: ownerEditorPrivacyDigest(original.privacyGeneration),
      expectedLineageDigest: original.lineageDigest,
      expectedLineageNativeVersion: original.lineageNativeVersion,
    });
    const requests = [request(), request()];
    const results = await Promise.allSettled(
      requests.map((r) => rotateFirestoreOwnerEditorEpochForMaintenance(store, r)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winner = results.findIndex((r) => r.status === 'fulfilled');
    const winningRequest = requests[winner];
    if (!winningRequest) throw new Error('Missing winning native request');
    const actual = await inspectFirestoreOwnerEditorMaintenanceState(store, ownerId);
    expect(actual.cursor).toMatchObject({
      ready: false,
      epoch: requests[winner]?.targetEpoch,
      maintenanceBinder: { operationId: requests[winner]?.operationId },
    });
    expect(
      (await rotateFirestoreOwnerEditorEpochForMaintenance(store, winningRequest)).status,
    ).toBe('replayed');
  });
});
