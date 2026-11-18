import { randomUUID } from 'node:crypto';
import type {
  EstimatedCostBaselineContext,
  EstimatedCostBaselineWitness,
} from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyFirestoreEstimatedCostBaseline,
  inspectFirestoreEstimatedCostBaseline,
  prepareFirestoreEstimatedCostBaseline,
  readbackFirestoreEstimatedCostBaseline,
} from './estimated-cost-baseline-provision.js';
import { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (host && !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
  throw new Error('Local emulator required');
describe.skipIf(!host)('Firestore baseline provisioning on local emulator', () => {
  let store: InstallationStore, context: EstimatedCostBaselineContext, reservationId: string;
  beforeEach(async () => {
    const initial = emulatorStore();
    store = new InstallationStore(
      initial.db,
      initial.installationId,
      () => new Date(),
      'demo-assistant-test',
      '(default)',
    );
    const ownerId = randomUUID();
    reservationId = randomUUID();
    context = {
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
    await store.doc('coordination', 'budget-holds').set({ heldMicros: 100000 });
    await store.doc('costReservations', reservationId).set({
      id: reservationId,
      estimatedUsd: '0.100000',
      status: 'unknown',
      reservationKind: 'attempt',
      costGrantId: null,
    });
  });
  afterEach(async () => {
    await disposeStore(store);
  });
  async function prepared() {
    const { censusDigest } = await inspectFirestoreEstimatedCostBaseline(store, context);
    const t = Date.now(),
      witness: EstimatedCostBaselineWitness = {
        format: 1,
        operationId: randomUUID(),
        ownerId: context.ownerId,
        target: context.target,
        releaseSha: context.releaseSha,
        cutoff: new Date(t).toISOString(),
        issuedAt: new Date(t).toISOString(),
        expiresAt: new Date(t + 300000).toISOString(),
        sourceDigest: 'b'.repeat(64),
        drainDigest: 'c'.repeat(64),
        observedCensusDigest: censusDigest,
      };
    return {
      witness,
      proposal: await prepareFirestoreEstimatedCostBaseline(store, context, witness),
    };
  }
  it('creates once, reads back the same receipt, and preserves liabilities', async () => {
    const before = await store.doc('costReservations', reservationId).get();
    const { witness, proposal } = await prepared();
    expect(proposal.rows).toEqual([{ reservationId, estimatedMicros: 100000 }]);
    const receipt = await applyFirestoreEstimatedCostBaseline(store, context, witness, proposal);
    expect(await applyFirestoreEstimatedCostBaseline(store, context, witness, proposal)).toEqual(
      receipt,
    );
    expect(await readbackFirestoreEstimatedCostBaseline(store, context, witness, proposal)).toEqual(
      receipt,
    );
    const after = await store.doc('costReservations', reservationId).get();
    expect(after.data()).toEqual(before.data());
    expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
  });
  it('rejects version drift, new unknown, and conflicting baseline', async () => {
    const { witness, proposal } = await prepared();
    await store.doc('costReservations', reservationId).update({ description: 'changed' });
    await expect(
      applyFirestoreEstimatedCostBaseline(store, context, witness, proposal),
    ).rejects.toThrow();
    expect((await store.doc('estimatedCostBaselines', store.installationId).get()).exists).toBe(
      false,
    );
    const second = await prepared();
    const extra = randomUUID();
    await store
      .doc('costReservations', extra)
      .set({ id: extra, estimatedUsd: '0.010000', status: 'unknown' });
    await expect(
      applyFirestoreEstimatedCostBaseline(store, context, second.witness, second.proposal),
    ).rejects.toThrow();
    await store.doc('costReservations', extra).delete();
    const third = await prepared();
    await store.doc('estimatedCostBaselines', store.installationId).set({ digest: 'conflict' });
    await expect(
      applyFirestoreEstimatedCostBaseline(store, context, third.witness, third.proposal),
    ).rejects.toThrow();
  });
  it('rejects active reservations, wrong target and changed owner', async () => {
    const { witness, proposal } = await prepared();
    await expect(
      applyFirestoreEstimatedCostBaseline(
        store,
        { ...context, target: { ...context.target, projectId: 'wrong' } },
        witness,
        proposal,
      ),
    ).rejects.toThrow();
    const secondOwner = randomUUID();
    await store.doc('agents', secondOwner).set({ id: secondOwner });
    await expect(
      applyFirestoreEstimatedCostBaseline(store, context, witness, proposal),
    ).rejects.toThrow();
    await store.doc('agents', secondOwner).delete();
    await store.doc('costReservations', reservationId).update({ status: 'held' });
    await expect(
      applyFirestoreEstimatedCostBaseline(store, context, witness, proposal),
    ).rejects.toThrow();
  });
  it('keeps grant-linked unknowns protected and refuses active grant authority', async () => {
    const protectedId = randomUUID(),
      grantId = randomUUID();
    await store.doc('costReservations', protectedId).set({
      id: protectedId,
      estimatedUsd: '0.020000',
      status: 'unknown',
      reservationKind: 'attempt',
      costGrantId: grantId,
    });
    await store.doc('coordination', 'budget-holds').set({ heldMicros: 120000 });
    await store
      .doc('estimatedCostGrants', grantId)
      .set({ id: grantId, expiresAt: new Date(Date.now() + 60000) });
    await expect(inspectFirestoreEstimatedCostBaseline(store, context)).rejects.toThrow(
      'Active grant',
    );
    await store
      .doc('estimatedCostGrants', grantId)
      .update({ expiresAt: new Date(Date.now() - 60000) });
    const { proposal } = await prepared();
    expect(proposal.heldMicros).toBe(120000);
    expect(proposal.rows).toEqual([{ reservationId, estimatedMicros: 100000 }]);
  });
  it('rejects more than 500 eligible rows rather than truncating the baseline', async () => {
    for (let offset = 0; offset < 500; offset += 250) {
      const batch = store.db.batch();
      for (let i = offset; i < offset + 250; i++) {
        const id = `extra-${String(i).padStart(3, '0')}`;
        batch.create(store.doc('costReservations', id), {
          id,
          estimatedUsd: '0.000001',
          status: 'unknown',
        });
      }
      await batch.commit();
    }
    await store.doc('coordination', 'budget-holds').set({ heldMicros: 100500 });
    await expect(prepared()).rejects.toThrow('rows');
  });
  it('recovers the exact receipt after expiry and release change without authorizing another apply', async () => {
    const { witness, proposal } = await prepared();
    const receipt = await applyFirestoreEstimatedCostBaseline(store, context, witness, proposal);
    await store.doc('costReservations', reservationId).update({ status: 'held' });
    const later = {
      ...context,
      releaseSha: 'f'.repeat(40),
      now: () => new Date(Date.parse(witness.expiresAt) + 1000),
    };
    expect(await readbackFirestoreEstimatedCostBaseline(store, later, witness, proposal)).toEqual(
      receipt,
    );
    await expect(
      applyFirestoreEstimatedCostBaseline(store, later, witness, proposal),
    ).rejects.toThrow();
    await expect(prepareFirestoreEstimatedCostBaseline(store, later, witness)).rejects.toThrow();
    await expect(
      readbackFirestoreEstimatedCostBaseline(
        store,
        later,
        { ...witness, drainDigest: 'd'.repeat(64) },
        proposal,
      ),
    ).rejects.toThrow();
    await store
      .doc('privacyErasureJobs', context.ownerId)
      .set({ agentId: context.ownerId, status: 'running', generation: 'active' });
    await expect(
      readbackFirestoreEstimatedCostBaseline(store, later, witness, proposal),
    ).rejects.toThrow();
  });
  it('protects a reservation that becomes unknown after the witnessed cutoff', async () => {
    const ref = store.doc('costReservations', reservationId);
    await ref.update({ status: 'reconciled' });
    const before = await ref.get();
    const cutoff = new Date(before.updateTime!.toMillis() + 1).toISOString();
    await ref.update({ status: 'unknown' });
    const updated = await ref.get();
    expect(updated.updateTime!.toMillis()).toBeGreaterThan(Date.parse(cutoff));
    const { censusDigest } = await inspectFirestoreEstimatedCostBaseline(store, context);
    const t = Date.now();
    const witness: EstimatedCostBaselineWitness = {
      format: 1,
      operationId: randomUUID(),
      ownerId: context.ownerId,
      target: context.target,
      releaseSha: context.releaseSha,
      cutoff,
      issuedAt: new Date(t).toISOString(),
      expiresAt: new Date(t + 60000).toISOString(),
      sourceDigest: 'b'.repeat(64),
      drainDigest: 'c'.repeat(64),
      observedCensusDigest: censusDigest,
    };
    const proposal = await prepareFirestoreEstimatedCostBaseline(store, context, witness);
    expect(proposal.rows).toEqual([]);
    expect(proposal.heldMicros).toBe(100000);
    await applyFirestoreEstimatedCostBaseline(store, context, witness, proposal);
    expect((await ref.get()).get('status')).toBe('unknown');
  });
});
