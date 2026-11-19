import { randomUUID } from 'node:crypto';
import {
  applyFirestoreEstimatedCostBaseline,
  InstallationStore,
  inspectFirestoreEstimatedCostBaseline,
  prepareFirestoreEstimatedCostBaseline,
} from '@assistant/firestore';
import type {
  EstimatedCostBaselineContext,
  EstimatedCostBaselineWitness,
} from '@assistant/persistence';
import { afterEach, describe, expect, it } from 'vitest';
import { disposeStore, emulatorStore } from '../packages/firestore/src/test-store.js';
import { readBaselineReceiptForEnable } from './estimated-cost-baseline-operator.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'canonical baseline enable readback on local Firestore',
  () => {
    let store: InstallationStore;
    afterEach(async () => {
      if (store) await disposeStore(store);
    });
    it('returns exactly the original receipt without the packet, and rejects later native modifications', async () => {
      const initial = emulatorStore();
      store = new InstallationStore(
        initial.db,
        initial.installationId,
        () => new Date(),
        'demo-assistant-test',
        '(default)',
      );
      const ownerId = randomUUID(),
        id = randomUUID();
      const context: EstimatedCostBaselineContext = {
        ownerId,
        target: {
          driver: 'firestore',
          projectId: 'demo-assistant-test',
          databaseId: '(default)',
          installationId: store.installationId,
        },
        releaseSha: 'a'.repeat(40),
        now: () => new Date(),
      };
      await store.doc('agents', ownerId).set({ id: ownerId });
      await store.doc('coordination', 'budget-holds').set({ heldMicros: 5 });
      await store
        .doc('costReservations', id)
        .set({ id, estimatedUsd: '0.000005', status: 'unknown' });
      const { censusDigest } = await inspectFirestoreEstimatedCostBaseline(store, context);
      const now = Date.now();
      const witness: EstimatedCostBaselineWitness = {
        format: 1,
        operationId: randomUUID(),
        ownerId,
        target: context.target,
        releaseSha: context.releaseSha,
        cutoff: new Date(now).toISOString(),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
        sourceDigest: 'b'.repeat(64),
        drainDigest: 'c'.repeat(64),
        observedCensusDigest: censusDigest,
      };
      const proposal = await prepareFirestoreEstimatedCostBaseline(store, context, witness);
      const receipt = await applyFirestoreEstimatedCostBaseline(store, context, witness, proposal);
      expect(await readBaselineReceiptForEnable(store, context)).toEqual(receipt);
      await store
        .doc('estimatedCostBaselines', store.installationId)
        .update({ digest: 'f'.repeat(64) });
      await expect(readBaselineReceiptForEnable(store, context)).rejects.toThrow();
    });
  },
);
