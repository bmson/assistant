import { randomUUID } from 'node:crypto';
import { type OwnerEditorOperationRecord, ownerEditorPrivacyDigest } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { readerFixtures } from '../../persistence/src/owner-editor-reader-fixtures.test-support.js';
import { createFirestoreOwnerEditorOperationRepository } from './owner-editor-repository.js';
import { ownerEditorTestStore } from './owner-editor-test-store.js';
import { decodeRecord } from './store.js';

function seedOwner(f: ReturnType<typeof ownerEditorTestStore>, ownerId: string, epoch: string) {
  f.seed('agents', ownerId, { id: ownerId });
  const name = `owner-editor-epoch:${ownerId}`;
  f.seed('maintenanceCursors', name, {
    name,
    cursor: JSON.stringify({
      ownerId,
      epoch,
      ready: true,
      privacyGenerationDigest: ownerEditorPrivacyDigest(null),
    }),
  });
}

function seedOperation(
  f: ReturnType<typeof ownerEditorTestStore>,
  record: OwnerEditorOperationRecord,
  physicalId = record.id,
) {
  f.seed('ownerEditorOperations', physicalId, record as unknown as Record<string, unknown>);
}

describe('Firestore strict reader compatibility qualification with fake transactions', () => {
  it('reads the five legacy terminal commands and every valid create receipt state', async () => {
    const f = ownerEditorTestStore();
    const now = new Date();
    const ownerId = randomUUID();
    const epoch = randomUUID();
    const fixtures = readerFixtures({ ownerId, epoch, now, privacyGeneration: null });
    seedOwner(f, ownerId, epoch);
    const all = [
      ...fixtures.oldSaved,
      fixtures.createOwnerMemory.preparing,
      fixtures.createOwnerMemory.expiredPreparing,
      fixtures.createOwnerMemory.savedRefresh,
      fixtures.createOwnerMemory.savedNoRefresh,
      fixtures.createOwnerMemory.conflict,
      fixtures.createOwnerMemory.invalid,
      fixtures.createOwnerMemory.unavailable,
      ...fixtures.createOwnerMemory.notApplied,
    ];
    for (const { record } of all) seedOperation(f, record);

    const repository = createFirestoreOwnerEditorOperationRepository(f.store, ownerId);
    for (const { scope, record } of fixtures.oldSaved) {
      const found = await repository.lookup(scope, now);
      expect(found.reply).toMatchObject({
        authority: 'operation_receipt',
        command: record.command,
        operationId: record.operationId,
        outcome: 'saved',
      });
    }

    const create = fixtures.createOwnerMemory;
    for (const item of [
      create.savedRefresh,
      create.savedNoRefresh,
      create.conflict,
      create.invalid,
      create.unavailable,
      ...create.notApplied,
    ]) {
      const found = await repository.lookup(item.scope, now);
      expect(found.reply).toMatchObject({
        authority: 'operation_receipt',
        command: 'create_owner_memory',
        operationId: item.record.operationId,
        outcome: item.record.result?.outcome,
      });
      await expect(
        repository.reconcile(
          {
            scope: item.scope,
            requestHash: item.record.requestHash,
            claimIdentityDigest: 'd'.repeat(64),
            statusVersion: item.record.statusVersion,
            issuedAt: now.getTime(),
            expiresAt: now.getTime() + 60_000,
          },
          now,
        ),
      ).resolves.toMatchObject({
        operationId: item.record.operationId,
        outcome: item.record.result?.outcome,
      });
    }

    const live = await repository.lookup(create.preparing.scope, now);
    expect(live.reply).toMatchObject({ authority: 'unresolved', reason: 'preparing' });
    await expect(repository.reconcile(create.preparing.proof, now)).resolves.toMatchObject({
      authority: 'unresolved',
      reason: 'preparing',
    });
    await expect(repository.lookup(create.expiredPreparing.scope, now)).resolves.toMatchObject({
      reply: { authority: 'unresolved', reason: 'preparing' },
    });
    expect(f.stats.writes).toEqual([]);

    const staleProof = { ...create.expiredPreparing.proof, expiresAt: now.getTime() - 1 };
    await expect(repository.reconcile(staleProof, now)).resolves.toMatchObject({
      authority: 'unresolved',
      reason: 'proof_changed',
    });
    await expect(repository.reconcile(create.expiredPreparing.proof, now)).resolves.toMatchObject({
      authority: 'operation_receipt',
      command: 'create_owner_memory',
      operationId: create.expiredPreparing.record.operationId,
      outcome: 'not_applied',
      reason: 'claim_abandoned',
    });
    expect(f.stats.readsAfterWrites).toBe(0);
  });

  it('round-trips Firestore-native timestamps without turning them into strings or numbers', () => {
    const f = ownerEditorTestStore();
    const now = new Date('2026-10-31T23:59:59.123Z');
    const ownerId = randomUUID();
    const epoch = randomUUID();
    const { createOwnerMemory } = readerFixtures({
      ownerId,
      epoch,
      now,
      privacyGeneration: null,
    });
    seedOperation(f, createOwnerMemory.preparing.record);
    const stored = f.rows('ownerEditorOperations')[0];
    const decoded = decodeRecord<OwnerEditorOperationRecord>(stored);
    expect(decoded.formIssuedAt).toBeInstanceOf(Date);
    expect(decoded.formExpiresAt).toBeInstanceOf(Date);
    expect(decoded.claimExpiresAt).toBeInstanceOf(Date);
    expect(decoded.createdAt).toBeInstanceOf(Date);
    expect(decoded.formIssuedAt.toISOString()).toBe(
      createOwnerMemory.preparing.record.formIssuedAt.toISOString(),
    );
  });

  it('keeps a saved create receipt unresolved while the matching epoch is not ready', async () => {
    const f = ownerEditorTestStore();
    const now = new Date();
    const ownerId = randomUUID();
    const epoch = randomUUID();
    const fixture = readerFixtures({ ownerId, epoch, now, privacyGeneration: null })
      .createOwnerMemory.savedNoRefresh;
    f.seed('agents', ownerId, { id: ownerId });
    const name = `owner-editor-epoch:${ownerId}`;
    f.seed('maintenanceCursors', name, {
      name,
      cursor: JSON.stringify({
        ownerId,
        epoch,
        ready: false,
        privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      }),
    });
    seedOperation(f, fixture.record);
    const repository = createFirestoreOwnerEditorOperationRepository(f.store, ownerId);
    await expect(repository.lookup(fixture.scope, now)).resolves.toMatchObject({
      reply: { authority: 'unresolved', outcome: 'outcome_unknown' },
    });
    expect(f.stats.writes).toEqual([]);
  });

  it('rejects a foreign-owner receipt at the expected physical document key', async () => {
    const f = ownerEditorTestStore();
    const now = new Date();
    const ownerId = randomUUID();
    const epoch = randomUUID();
    const fixture = readerFixtures({ ownerId, epoch, now, privacyGeneration: null })
      .createOwnerMemory.savedNoRefresh;
    seedOwner(f, ownerId, epoch);
    seedOperation(f, { ...fixture.record, ownerId: randomUUID() });
    const repository = createFirestoreOwnerEditorOperationRepository(f.store, ownerId);
    await expect(repository.lookup(fixture.scope, now)).resolves.toMatchObject({
      reply: { authority: 'request_rejection', reason: 'request_binding_mismatch' },
    });
  });
});
