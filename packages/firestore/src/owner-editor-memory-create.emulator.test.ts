/** Actual Firestore SDK transaction proof; requires an explicitly allocated local demo database. */
import { createHash, randomUUID } from 'node:crypto';
import {
  embeddingSpaceIdentityKey,
  type OwnerEditorScope,
  ownerEditorOperationId,
} from '@assistant/persistence';
import { type DocumentReference, Firestore, type Transaction } from '@google-cloud/firestore';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerEditorEmulatorAuth } from './owner-editor-emulator-auth.js';
import { buildFirestoreOwnerEditorEpochRecord } from './owner-editor-epoch-record.js';
import { readFirestoreOwnerEditorContact } from './owner-editor-graph.js';
import {
  commitFirestoreOwnerMemoryCreation,
  readFirestoreOwnerMemoryCreationTarget,
} from './owner-editor-memory-create.js';
import { createFirestoreOwnerEditorOperationRepository } from './owner-editor-repository.js';
import { InstallationStore } from './store.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectGate = process.env.OWNER_EDITOR_CREATE_EMULATOR_PROJECT;
const enabled =
  !!host &&
  /^(127\.0\.0\.1|localhost):\d+$/.test(host) &&
  projectGate === 'demo-owner-memory-create';
if (host && !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
  throw new Error('Local Firestore emulator required');
const space = { provider: 'test', model: 'unit', dimensions: 3, revision: '1' };
const content = 'Emulator owner memory creation proof.';
const contentHash = createHash('sha256').update(content).digest('hex');
type TransactionRunner = (
  updateFunction: (transaction: Transaction) => Promise<unknown>,
) => Promise<unknown>;

async function withReceiptStageFailure<T>(
  store: InstallationStore,
  receiptPath: string,
  runWrite: () => Promise<T>,
): Promise<T> {
  const client = store.db as unknown as { runTransaction: TransactionRunner };
  const original = client.runTransaction.bind(store.db);
  client.runTransaction = (updateFunction) =>
    original((transaction) =>
      updateFunction(
        new Proxy(transaction, {
          get(target, property) {
            if (property === 'set')
              return (...args: Parameters<Transaction['set']>) => {
                const ref = args[0] as DocumentReference;
                if (ref.path === receiptPath)
                  throw new Error('Injected owner-editor receipt staging failure');
                return target.set(...args);
              };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      ),
    );
  try {
    return await runWrite();
  } finally {
    client.runTransaction = original;
  }
}

async function withLostTransactionResponse<T>(
  store: InstallationStore,
  runWrite: () => Promise<T>,
): Promise<T> {
  const client = store.db as unknown as { runTransaction: TransactionRunner };
  const original = client.runTransaction.bind(store.db);
  client.runTransaction = async (updateFunction) => {
    await original(updateFunction);
    throw new Error('Synthetic client response lost after Firestore commit');
  };
  try {
    return await runWrite();
  } finally {
    client.runTransaction = original;
  }
}

describe.skipIf(!enabled)('Firestore owner memory creation on actual SDK emulator', () => {
  let store: InstallationStore | undefined;
  let cleanup: DocumentReference[] = [];

  afterEach(async () => {
    if (!store) return;
    try {
      if (cleanup.length > 48) throw new Error('Owner memory emulator cleanup bound exceeded');
      const batch = store.db.batch();
      for (const ref of cleanup) batch.delete(ref);
      await batch.commit();
    } finally {
      await store.db.terminate();
      store = undefined;
      cleanup = [];
    }
  });

  it('atomically writes owner note, hash, invalidated card, and replayable receipt', async () => {
    if (!host || !enabled) throw new Error('Allocated local demo Firestore emulator required');
    const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
    const projectId = `demo-owner-memory-create-${nonce}`;
    const databaseId = `owner-memory-create-${nonce}-test`;
    const db = new Firestore({
      projectId,
      databaseId,
      host,
      ssl: false,
      universeDomain: 'googleapis.com',
      preferRest: true,
      authClient: ownerEditorEmulatorAuth(host),
    } as ConstructorParameters<typeof Firestore>[0]);
    store = new InstallationStore(
      db,
      `owner-memory-create-test-${nonce}`,
      undefined,
      projectId,
      databaseId,
    );
    const currentStore: InstallationStore = store;
    const ownerId = randomUUID();
    const subjectContactId = randomUUID();
    const memoryId = randomUUID();
    const epochName = `owner-editor-epoch:${ownerId}`;
    const operationId = randomUUID();
    const secondMemoryId = randomUUID();
    const failureMemoryId = randomUUID();
    const forgottenMemoryId = randomUUID();
    const changedSubjectMemoryId = randomUUID();
    const lostMemoryId = randomUUID();
    const expiredMemoryId = randomUUID();
    const privateMemoryId = randomUUID();
    const ownerRaceMemoryId = randomUUID();
    const otherOwnerId = randomUUID();
    const ownerContactMemoryId = randomUUID();
    const lostContent = 'A second note for the emulator.';
    const lostContentHash = createHash('sha256').update(lostContent).digest('hex');
    const expiredContent = 'A lease-bound note for the emulator.';
    const expiredContentHash = createHash('sha256').update(expiredContent).digest('hex');
    const privateContent = 'A privacy-bound note for the emulator.';
    const privateContentHash = createHash('sha256').update(privateContent).digest('hex');
    const ownerRaceContent = 'An owner-bound note for the emulator.';
    const ownerRaceHash = createHash('sha256').update(ownerRaceContent).digest('hex');
    const ownerContactContent = 'A forbidden owner-contact note.';
    const ownerContactHash = createHash('sha256').update(ownerContactContent).digest('hex');
    const now = new Date();
    const scope: OwnerEditorScope = {
      ownerId,
      epoch: randomUUID(),
      privacyGeneration: null,
      command: 'create_owner_memory',
      operationId,
      targetId: subjectContactId,
      sessionDigest: 'd'.repeat(64),
      nonce: randomUUID(),
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 600_000,
    };
    const secondScope: OwnerEditorScope = {
      ...scope,
      operationId: randomUUID(),
      nonce: randomUUID(),
    };
    const failureScope: OwnerEditorScope = {
      ...scope,
      operationId: randomUUID(),
      nonce: randomUUID(),
    };
    const forgottenScope: OwnerEditorScope = {
      ...scope,
      operationId: randomUUID(),
      nonce: randomUUID(),
    };
    const changedSubjectScope: OwnerEditorScope = {
      ...scope,
      operationId: randomUUID(),
      nonce: randomUUID(),
    };
    const lostScope: OwnerEditorScope = {
      ...scope,
      operationId: randomUUID(),
      nonce: randomUUID(),
    };
    const expiredScope: OwnerEditorScope = {
      ...scope,
      operationId: randomUUID(),
      nonce: randomUUID(),
    };
    const privacyScope: OwnerEditorScope = {
      ...scope,
      operationId: randomUUID(),
      nonce: randomUUID(),
    };
    const ownerRaceScope: OwnerEditorScope = {
      ...scope,
      operationId: randomUUID(),
      nonce: randomUUID(),
    };
    const ownerContactScope: OwnerEditorScope = {
      ...scope,
      operationId: randomUUID(),
      nonce: randomUUID(),
    };
    const names = [
      ['agents', ownerId],
      ['agents', otherOwnerId],
      ['maintenanceCursors', epochName],
      ['contacts', subjectContactId],
      ['memories', memoryId],
      ['memories', secondMemoryId],
      ['memories', failureMemoryId],
      ['memories', forgottenMemoryId],
      ['memories', changedSubjectMemoryId],
      ['memories', lostMemoryId],
      ['memories', expiredMemoryId],
      ['memories', privateMemoryId],
      ['memories', ownerRaceMemoryId],
      ['memories', ownerContactMemoryId],
      ['memoryContentHashes', contentHash],
      ['memoryContentHashes', lostContentHash],
      ['memoryContentHashes', expiredContentHash],
      ['memoryContentHashes', privateContentHash],
      ['memoryContentHashes', ownerRaceHash],
      ['memoryContentHashes', ownerContactHash],
      ['memoryTombstones', contentHash],
      ['memoryTombstones', lostContentHash],
      ['memoryTombstones', expiredContentHash],
      ['memoryTombstones', privateContentHash],
      ['memoryTombstones', ownerRaceHash],
      ['memoryTombstones', ownerContactHash],
      ['ownerCards', ownerId],
      ['ownerEditorOperations', ownerEditorOperationId(scope)],
      ['ownerEditorOperations', ownerEditorOperationId(secondScope)],
      ['ownerEditorOperations', ownerEditorOperationId(failureScope)],
      ['ownerEditorOperations', ownerEditorOperationId(forgottenScope)],
      ['ownerEditorOperations', ownerEditorOperationId(changedSubjectScope)],
      ['ownerEditorOperations', ownerEditorOperationId(lostScope)],
      ['ownerEditorOperations', ownerEditorOperationId(expiredScope)],
      ['ownerEditorOperations', ownerEditorOperationId(privacyScope)],
      ['ownerEditorOperations', ownerEditorOperationId(ownerRaceScope)],
      ['ownerEditorOperations', ownerEditorOperationId(ownerContactScope)],
      ['privacyErasureJobs', ownerId],
    ] as const;
    cleanup = names.map(([table, id]) => currentStore.doc(table, id));
    await store.doc('agents', ownerId).set({ id: ownerId });
    await store.doc('maintenanceCursors', epochName).set(
      buildFirestoreOwnerEditorEpochRecord({
        ownerId,
        epoch: scope.epoch,
        ready: true,
        privacyGeneration: null,
        updatedAt: now,
      }),
    );
    await store.doc('contacts', subjectContactId).set({
      id: subjectContactId,
      agentId: ownerId,
      name: 'Emulator subject',
      aliases: [],
      trust: 'known',
    });
    const target = await readFirestoreOwnerMemoryCreationTarget(
      store,
      ownerId,
      subjectContactId,
      contentHash,
      scope,
    );
    expect(target).toMatchObject({ status: 'eligible', ownerId, subjectContactId });
    if (!target) throw new Error('Memory target was not available');
    const operations = createFirestoreOwnerEditorOperationRepository(store, ownerId);
    const makePrepared = (
      id: string,
      expectedSubjectRevision: string,
      note = content,
      noteHash = contentHash,
    ) => ({
      memoryId: id,
      retrievalRevision: randomUUID(),
      subjectContactId,
      expectedSubjectRevision,
      content: note,
      contentHash: noteHash,
      domain: 'home',
      importance: 3,
      pinned: false,
      embedding: [1, 0, 0],
      embeddingSpaceKey: embeddingSpaceIdentityKey(space),
    });

    const failureReservation = await operations.reserve(failureScope, 'a'.repeat(64), now);
    if (failureReservation.kind !== 'claimed')
      throw new Error('Failure-test claim was not admitted');
    const failurePrepared = makePrepared(failureMemoryId, target.subjectRevision);
    const failurePath = store.doc(
      'ownerEditorOperations',
      ownerEditorOperationId(failureScope),
    ).path;
    await expect(
      withReceiptStageFailure(currentStore, failurePath, () =>
        commitFirestoreOwnerMemoryCreation(
          currentStore,
          space,
          failureReservation.claim,
          failurePrepared,
          now,
        ),
      ),
    ).rejects.toThrow('Injected owner-editor receipt staging failure');
    expect((await store.doc('memories', failureMemoryId).get()).exists).toBe(false);
    expect((await store.doc('memoryContentHashes', contentHash).get()).exists).toBe(false);
    expect((await store.doc('ownerCards', ownerId).get()).exists).toBe(false);
    expect(
      (await store.doc('ownerEditorOperations', ownerEditorOperationId(failureScope)).get()).get(
        'status',
      ),
    ).toBe('preparing');

    const forgottenReservation = await operations.reserve(forgottenScope, 'b'.repeat(64), now);
    if (forgottenReservation.kind !== 'claimed')
      throw new Error('Forgotten-hash claim was not admitted');
    await store.doc('memoryTombstones', contentHash).create({ contentHash });
    const forgotten = await commitFirestoreOwnerMemoryCreation(
      store,
      space,
      forgottenReservation.claim,
      makePrepared(forgottenMemoryId, target.subjectRevision),
      now,
    );
    expect(forgotten).toMatchObject({ outcome: 'conflict' });
    expect((await store.doc('memories', forgottenMemoryId).get()).exists).toBe(false);
    await store.doc('memoryTombstones', contentHash).delete();

    const subjectReservation = await operations.reserve(changedSubjectScope, 'c'.repeat(64), now);
    if (subjectReservation.kind !== 'claimed')
      throw new Error('Subject-race claim was not admitted');
    await store.doc('contacts', subjectContactId).update({ name: 'Emulator subject changed' });
    const changedSubject = await commitFirestoreOwnerMemoryCreation(
      store,
      space,
      subjectReservation.claim,
      makePrepared(changedSubjectMemoryId, target.subjectRevision),
      now,
    );
    expect(changedSubject).toMatchObject({ outcome: 'conflict' });
    const currentTarget = await readFirestoreOwnerMemoryCreationTarget(
      store,
      ownerId,
      subjectContactId,
      contentHash,
      scope,
    );
    expect(currentTarget).toMatchObject({ status: 'eligible' });
    if (!currentTarget) throw new Error('Changed contact target was not available');

    const reservation = await operations.reserve(scope, 'e'.repeat(64), now);
    if (reservation.kind !== 'claimed') throw new Error('Owner editor claim was not admitted');
    const secondReservation = await operations.reserve(secondScope, 'f'.repeat(64), now);
    if (secondReservation.kind !== 'claimed')
      throw new Error('Second owner editor claim was not admitted');
    const samePrepared = makePrepared(memoryId, currentTarget.subjectRevision);
    const [first, firstReplay, second] = await Promise.all([
      commitFirestoreOwnerMemoryCreation(store, space, reservation.claim, samePrepared, now),
      commitFirestoreOwnerMemoryCreation(store, space, reservation.claim, samePrepared, now),
      commitFirestoreOwnerMemoryCreation(
        store,
        space,
        secondReservation.claim,
        makePrepared(secondMemoryId, currentTarget.subjectRevision),
        now,
      ),
    ]);
    expect(firstReplay).toEqual(first);
    const saved = first.outcome === 'saved' ? first : second.outcome === 'saved' ? second : null;
    const savedScope = first.outcome === 'saved' ? scope : secondScope;
    expect([first.outcome, second.outcome].sort()).toEqual(['conflict', 'saved']);
    expect(saved).toMatchObject({ outcome: 'saved', refreshPending: true });
    if (!saved?.ids.memoryId) throw new Error('No saved memory ID');
    const [memory, hashRow, card, receipt] = await Promise.all([
      store.doc('memories', saved.ids.memoryId).get(),
      store.doc('memoryContentHashes', contentHash).get(),
      store.doc('ownerCards', ownerId).get(),
      store.doc('ownerEditorOperations', ownerEditorOperationId(savedScope)).get(),
    ]);
    expect(memory.data()).toMatchObject({
      id: saved.ids.memoryId,
      agentId: ownerId,
      subjectContactId,
      content,
      contentHash,
      source: 'manual',
      originTrust: 'owner',
      ownerConfirmed: true,
    });
    expect(memory.get('retrievalRevision')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(hashRow.get('memoryId')).toBe(saved.ids.memoryId);
    expect(card.get('content')).toBe('');
    expect(receipt.get('result')).toMatchObject({ outcome: 'saved', refreshPending: true });
    expect((await operations.lookup(savedScope, new Date())).reply).toEqual(saved);
    const tombstone = await store.doc('memoryTombstones', contentHash).get();
    expect(tombstone.exists).toBe(false);

    const lostTarget = await readFirestoreOwnerMemoryCreationTarget(
      store,
      ownerId,
      subjectContactId,
      lostContentHash,
      lostScope,
    );
    if (!lostTarget) throw new Error('Lost-response target was not available');
    const lostReservation = await operations.reserve(lostScope, '9'.repeat(64), now);
    if (lostReservation.kind !== 'claimed') throw new Error('Lost-response claim was not admitted');
    await expect(
      withLostTransactionResponse(currentStore, () =>
        commitFirestoreOwnerMemoryCreation(
          currentStore,
          space,
          lostReservation.claim,
          makePrepared(lostMemoryId, lostTarget.subjectRevision, lostContent, lostContentHash),
          now,
        ),
      ),
    ).rejects.toThrow('Synthetic client response lost after Firestore commit');
    const recovered = (await operations.lookup(lostScope, new Date())).reply;
    expect(recovered).toMatchObject({ outcome: 'saved', refreshPending: true });
    expect((await store.doc('memories', lostMemoryId).get()).get('content')).toBe(lostContent);

    const expiredTarget = await readFirestoreOwnerMemoryCreationTarget(
      store,
      ownerId,
      subjectContactId,
      expiredContentHash,
      expiredScope,
    );
    if (!expiredTarget) throw new Error('Expired-claim target was not available');
    const expiredReservation = await operations.reserve(expiredScope, '8'.repeat(64), now);
    if (expiredReservation.kind !== 'claimed') throw new Error('Expired claim was not admitted');
    const expired = await commitFirestoreOwnerMemoryCreation(
      store,
      space,
      expiredReservation.claim,
      makePrepared(
        expiredMemoryId,
        expiredTarget.subjectRevision,
        expiredContent,
        expiredContentHash,
      ),
      new Date(expiredReservation.claim.claimExpiresAt.getTime() + 1),
    );
    expect(expired.outcome).not.toBe('saved');
    expect((await store.doc('memories', expiredMemoryId).get()).exists).toBe(false);

    const privacyTarget = await readFirestoreOwnerMemoryCreationTarget(
      store,
      ownerId,
      subjectContactId,
      privateContentHash,
      privacyScope,
    );
    if (!privacyTarget) throw new Error('Privacy target was not available');
    const privacyReservation = await operations.reserve(privacyScope, '7'.repeat(64), now);
    if (privacyReservation.kind !== 'claimed') throw new Error('Privacy claim was not admitted');
    await store.doc('privacyErasureJobs', ownerId).set({
      agentId: ownerId,
      generation: randomUUID(),
      status: 'complete',
    });
    const retired = await commitFirestoreOwnerMemoryCreation(
      store,
      space,
      privacyReservation.claim,
      makePrepared(
        privateMemoryId,
        privacyTarget.subjectRevision,
        privateContent,
        privateContentHash,
      ),
      now,
    );
    expect(retired).toMatchObject({ authority: 'scope_retirement', outcome: 'voided' });
    expect((await store.doc('memories', privateMemoryId).get()).exists).toBe(false);
    await store.doc('privacyErasureJobs', ownerId).delete();

    const ownerContactTarget = await readFirestoreOwnerMemoryCreationTarget(
      store,
      ownerId,
      subjectContactId,
      ownerContactHash,
      ownerContactScope,
    );
    if (!ownerContactTarget) throw new Error('Owner-contact preflight target was not available');
    await store.doc('contacts', subjectContactId).update({ trust: 'owner' });
    expect(
      await readFirestoreOwnerMemoryCreationTarget(
        store,
        ownerId,
        subjectContactId,
        ownerContactHash,
        ownerContactScope,
      ),
    ).toBeNull();
    const selfTarget = await readFirestoreOwnerMemoryCreationTarget(
      store,
      ownerId,
      ownerId,
      ownerContactHash,
      { ...ownerContactScope, targetId: ownerId },
    );
    expect(selfTarget).toBeNull();
    const ownerContact = await readFirestoreOwnerEditorContact(store, ownerId, subjectContactId);
    if (!ownerContact) throw new Error('Owner-contact revision unavailable');
    const ownerContactReservation = await operations.reserve(
      ownerContactScope,
      '5'.repeat(64),
      now,
    );
    if (ownerContactReservation.kind !== 'claimed')
      throw new Error('Owner-contact claim was not admitted');
    const cardBeforeOwnerConflict = await store.doc('ownerCards', ownerId).get();
    expect(
      await commitFirestoreOwnerMemoryCreation(
        store,
        space,
        ownerContactReservation.claim,
        makePrepared(
          ownerContactMemoryId,
          ownerContact.revision,
          ownerContactContent,
          ownerContactHash,
        ),
        now,
      ),
    ).toMatchObject({ outcome: 'conflict' });
    expect((await store.doc('memories', ownerContactMemoryId).get()).exists).toBe(false);
    expect((await store.doc('memoryContentHashes', ownerContactHash).get()).exists).toBe(false);
    expect((await store.doc('ownerCards', ownerId).get()).updateTime).toEqual(
      cardBeforeOwnerConflict.updateTime,
    );
    await store.doc('contacts', subjectContactId).update({ trust: 'known' });

    const ownerRaceTarget = await readFirestoreOwnerMemoryCreationTarget(
      store,
      ownerId,
      subjectContactId,
      ownerRaceHash,
      ownerRaceScope,
    );
    if (!ownerRaceTarget) throw new Error('Owner-race target was not available');
    const ownerRaceReservation = await operations.reserve(ownerRaceScope, '6'.repeat(64), now);
    if (ownerRaceReservation.kind !== 'claimed')
      throw new Error('Owner-race claim was not admitted');
    await store.doc('agents', otherOwnerId).set({ id: otherOwnerId });
    await expect(
      commitFirestoreOwnerMemoryCreation(
        store,
        space,
        ownerRaceReservation.claim,
        makePrepared(
          ownerRaceMemoryId,
          ownerRaceTarget.subjectRevision,
          ownerRaceContent,
          ownerRaceHash,
        ),
        now,
      ),
    ).rejects.toThrow('Editor owner is unavailable');
    expect((await store.doc('memories', ownerRaceMemoryId).get()).exists).toBe(false);
  });
});
