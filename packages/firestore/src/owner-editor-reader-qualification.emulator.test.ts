/** Actual Firestore SDK reader/retention proof; root-supervised loopback allocation only. */
import { randomUUID } from 'node:crypto';
import {
  checksumV3,
  MIGRATION_TABLES,
  type MigrationBundle,
  type MigrationRecord,
  migrationBundleChecksum,
  OWNER_EDITOR_RUNTIME_EXCLUSIONS_V1,
  type OwnerEditorOperationRecord,
  type OwnerEditorScope,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
} from '@assistant/persistence';
import { type DocumentReference, Firestore, Timestamp } from '@google-cloud/firestore';
import { afterEach, describe, expect, it } from 'vitest';
import { readerFixtures } from '../../persistence/src/owner-editor-reader-fixtures.test-support.js';
import { ownerEditorEmulatorAuth } from './owner-editor-emulator-auth.js';
import { createFirestoreOwnerEditorOperationRepository } from './owner-editor-repository.js';
import { pruneExpiredFirestoreOwnerEditorReceipts } from './owner-editor-retention.js';
import { decodeRecord, encodeRecord, InstallationStore } from './store.js';
import { importWorkspaceBundle } from './workspace-migration.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
const enabled =
  Boolean(host) &&
  /^(127\.0\.0\.1|localhost):\d+$/.test(host ?? '') &&
  process.env.OWNER_EDITOR_READER_QUALIFICATION_PROJECT ===
    'demo-owner-editor-reader-qualification';
if (host && !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
  throw new Error('Local Firestore emulator required');
const replayMs = 24 * 60 * 60 * 1000;
let totalTrackedRefs = 0;

function ownerOnlyBundle(target: MigrationBundle['manifest']['target'], agentId: string) {
  const agentData = {
    id: agentId,
    name: 'Qualification owner',
    email: 'owner@example.test',
    workspacePrefix: 'workspace/qualification',
  };
  const record: MigrationRecord = {
    table: 'agents',
    collection: 'agents',
    id: agentId,
    data: agentData,
    checksum: checksumV3(agentData),
  };
  const records: MigrationRecord[] = [record];
  const tables = Object.fromEntries(
    MIGRATION_TABLES.map(({ table, collection }) => [
      table,
      { collection, count: 0, checksum: checksumV3([]) },
    ]),
  ) as MigrationBundle['manifest']['tables'];
  tables.agents = {
    collection: 'agents',
    count: 1,
    checksum: checksumV3(records),
  };
  return {
    manifest: {
      format: 'assistant-workspace-migration' as const,
      formatVersion: 3 as const,
      mode: 'export' as const,
      source: {
        kind: 'postgresql' as const,
        agentId,
        scope: 'installation' as const,
        snapshot: '1-1-1',
        exportedAt: '2026-11-01T00:00:00.000000Z',
      },
      target,
      tables,
      coverage: {
        complete: true,
        supportedTables: MIGRATION_TABLES.map(({ table }) => table),
        omittedTables: [],
        runtimeExclusions: OWNER_EDITOR_RUNTIME_EXCLUSIONS_V1,
      },
      recordCount: records.length,
      bundleChecksum: migrationBundleChecksum(records, 3, OWNER_EDITOR_RUNTIME_EXCLUSIONS_V1),
      unsupportedTables: [],
    },
    records,
  } satisfies MigrationBundle;
}

describe.skipIf(!enabled)('Firestore reader qualification on actual SDK emulator', () => {
  let store: InstallationStore | undefined;
  let cleanup: DocumentReference[] = [];

  function freshStore() {
    if (!host || !enabled) throw new Error('Root-supervised local reader emulator required');
    const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
    const projectId = `demo-owner-editor-reader-qualification-${nonce}`;
    const databaseId = `owner-editor-reader-${nonce}-test`;
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
      `owner-editor-reader-qualification-${nonce}`,
      undefined,
      projectId,
      databaseId,
    );
    return store;
  }

  function track(ref: DocumentReference) {
    cleanup.push(ref);
    totalTrackedRefs += 1;
    if (cleanup.length > 192 || totalTrackedRefs > 192)
      throw new Error('Reader qualification cleanup bound exceeded');
    return ref;
  }

  afterEach(async () => {
    if (!store) return;
    try {
      if (cleanup.length > 192 || totalTrackedRefs > 192)
        throw new Error('Reader qualification cleanup bound exceeded');
      for (let index = 0; index < cleanup.length; index += 190) {
        const batch = store.db.batch();
        for (const ref of cleanup.slice(index, index + 190)) batch.delete(ref);
        await batch.commit();
      }
    } finally {
      await store.db.terminate();
      store = undefined;
      cleanup = [];
    }
  });

  it('reads mixed legacy/create receipts and preserves native timestamp types', async () => {
    const currentStore = freshStore();
    const now = new Date();
    const ownerId = randomUUID();
    const epoch = randomUUID();
    const fixtures = readerFixtures({ ownerId, epoch, now, privacyGeneration: null });
    const ownerRef = track(currentStore.doc('agents', ownerId));
    const epochName = `owner-editor-epoch:${ownerId}`;
    const epochRef = track(currentStore.doc('maintenanceCursors', epochName));
    await ownerRef.create(encodeRecord({ id: ownerId }));
    await epochRef.create(
      encodeRecord({
        name: epochName,
        cursor: JSON.stringify({
          ownerId,
          epoch,
          ready: true,
          privacyGenerationDigest: ownerEditorPrivacyDigest(null),
        }),
      }),
    );

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
    for (const { record } of all) {
      const ref = track(currentStore.doc('ownerEditorOperations', record.id));
      await ref.create(encodeRecord(record));
    }

    const committedRef = currentStore.doc(
      'ownerEditorOperations',
      fixtures.createOwnerMemory.savedRefresh.record.id,
    );
    const native = await committedRef.get();
    expect(native.get('formIssuedAt')).toBeInstanceOf(Timestamp);
    const decoded = decodeRecord<OwnerEditorOperationRecord>(native.data());
    expect(decoded.formIssuedAt).toBeInstanceOf(Date);
    expect(decoded.formIssuedAt.toISOString()).toBe(
      fixtures.createOwnerMemory.savedRefresh.record.formIssuedAt.toISOString(),
    );

    const repository = createFirestoreOwnerEditorOperationRepository(currentStore, ownerId);
    for (const { scope, record } of fixtures.oldSaved) {
      await expect(repository.lookup(scope, now)).resolves.toMatchObject({
        reply: { authority: 'operation_receipt', command: record.command, outcome: 'saved' },
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
      await expect(repository.lookup(item.scope, now)).resolves.toMatchObject({
        reply: {
          authority: 'operation_receipt',
          command: 'create_owner_memory',
          operationId: item.record.operationId,
          outcome: item.record.result?.outcome,
        },
      });
    }
    await expect(repository.lookup(create.preparing.scope, now)).resolves.toMatchObject({
      reply: { authority: 'unresolved', reason: 'preparing' },
    });
    await expect(repository.reconcile(create.preparing.proof, now)).resolves.toMatchObject({
      authority: 'unresolved',
      reason: 'preparing',
    });
    await expect(repository.lookup(create.expiredPreparing.scope, now)).resolves.toMatchObject({
      reply: { authority: 'unresolved', reason: 'preparing' },
    });
    await expect(
      repository.reconcile({ ...create.expiredPreparing.proof, expiresAt: now.getTime() - 1 }, now),
    ).resolves.toMatchObject({ authority: 'unresolved', reason: 'proof_changed' });
    await expect(repository.reconcile(create.expiredPreparing.proof, now)).resolves.toMatchObject({
      authority: 'operation_receipt',
      command: 'create_owner_memory',
      operationId: create.expiredPreparing.record.operationId,
      outcome: 'not_applied',
      reason: 'claim_abandoned',
    });
  });

  it('refuses to adopt an unbundled create receipt as portable content', async () => {
    const currentStore = freshStore();
    const ownerId = randomUUID();
    const now = new Date();
    const receipt = readerFixtures({
      ownerId,
      epoch: randomUUID(),
      now,
      privacyGeneration: null,
    }).createOwnerMemory.savedNoRefresh.record;
    const target = {
      projectId: currentStore.projectId ?? '',
      databaseId: currentStore.databaseId,
      installationId: currentStore.installationId,
    };
    const source = ownerOnlyBundle(target, ownerId);
    const receiptRef = track(currentStore.doc('ownerEditorOperations', receipt.id));
    expect(source.records.map((record) => String(record.table))).not.toContain(
      'owner_editor_operations',
    );
    await receiptRef.create(encodeRecord(receipt));
    await expect(
      importWorkspaceBundle(currentStore, source, {
        sourceAgentId: ownerId,
        target,
        mode: 'write',
      }),
    ).rejects.toThrow('not empty');
    expect((await receiptRef.get()).exists).toBe(true);
    expect((await currentStore.doc('agents', ownerId).get()).exists).toBe(false);
  });

  it('prunes at the 50-row boundary and aborts a malformed physical-identity page before deletion', async () => {
    const currentStore = freshStore();
    const now = new Date();
    const ownerId = randomUUID();
    const epoch = randomUUID();
    const fixtures = readerFixtures({ ownerId, epoch, now, privacyGeneration: null });
    const ownerRef = track(currentStore.doc('agents', ownerId));
    const epochName = `owner-editor-epoch:${ownerId}`;
    const epochRef = track(currentStore.doc('maintenanceCursors', epochName));
    await ownerRef.create(encodeRecord({ id: ownerId }));
    await epochRef.create(
      encodeRecord({
        name: epochName,
        cursor: JSON.stringify({
          ownerId,
          epoch,
          ready: false,
          privacyGenerationDigest: ownerEditorPrivacyDigest(null),
        }),
      }),
    );

    const insertReceipt = async (base: OwnerEditorOperationRecord, issuedAt: Date) => {
      if (base.result?.outcome !== 'saved')
        throw new Error('Retention fixture must start from a saved receipt');
      const operationId = randomUUID();
      const scope: OwnerEditorScope = {
        ownerId,
        epoch,
        command: base.command,
        operationId,
        targetId: base.command === 'create_person' ? null : randomUUID(),
        privacyGeneration: null,
        sessionDigest: 'a'.repeat(64),
        nonce: randomUUID(),
        issuedAt: issuedAt.getTime(),
        expiresAt: issuedAt.getTime() + 600_000,
      };
      const record: OwnerEditorOperationRecord = {
        ...base,
        id: ownerEditorOperationId(scope),
        ownerId,
        epoch,
        operationId,
        scopeDigest: ownerEditorScopeDigest(scope),
        formIssuedAt: issuedAt,
        formExpiresAt: new Date(scope.expiresAt),
        claimToken: null,
        claimExpiresAt: null,
        status: 'committed',
        statusVersion: 2,
        createdAt: issuedAt,
        updatedAt: issuedAt,
        result: {
          ...base.result,
          ids:
            base.command === 'create_owner_memory'
              ? { memoryId: randomUUID() }
              : { ...base.result.ids },
        },
      };
      const ref = track(currentStore.doc('ownerEditorOperations', record.id));
      await ref.create(encodeRecord(record));
      return ref;
    };
    const oldRecords = fixtures.oldSaved;
    const expiredAt = new Date(now.getTime() - replayMs - 60_000);
    const expiredRefs: DocumentReference[] = [];
    for (let index = 0; index < 51; index++) {
      const legacy = oldRecords[index % oldRecords.length];
      if (!legacy) throw new Error('Reader fixture lacks a legacy command');
      const base =
        index % 2 === 0 ? fixtures.createOwnerMemory.savedNoRefresh.record : legacy.record;
      expiredRefs.push(await insertReceipt(base, new Date(expiredAt.getTime() + index)));
    }
    const recentRef = await insertReceipt(
      fixtures.createOwnerMemory.savedNoRefresh.record,
      new Date(now.getTime() - 60_000),
    );
    expect(await pruneExpiredFirestoreOwnerEditorReceipts(currentStore, ownerId, now)).toBe(50);
    expect(await pruneExpiredFirestoreOwnerEditorReceipts(currentStore, ownerId, now)).toBe(1);
    expect((await recentRef.get()).exists).toBe(true);
    expect(
      (await Promise.all(expiredRefs.map((ref) => ref.get()))).every(
        (snapshot) => !snapshot.exists,
      ),
    ).toBe(true);

    const validAgain = await insertReceipt(
      fixtures.createOwnerMemory.savedNoRefresh.record,
      new Date(now.getTime() - replayMs - 2),
    );
    const malformedBase = fixtures.createOwnerMemory.savedNoRefresh.record;
    const malformedId = randomUUID();
    const malformedScope: OwnerEditorScope = {
      ...fixtures.createOwnerMemory.savedNoRefresh.scope,
      operationId: malformedId,
      nonce: randomUUID(),
      issuedAt: now.getTime() - replayMs - 3,
      expiresAt: now.getTime() - replayMs - 3 + 600_000,
    };
    const malformed: OwnerEditorOperationRecord = {
      ...malformedBase,
      id: ownerEditorOperationId(malformedScope),
      ownerId,
      epoch,
      operationId: malformedId,
      scopeDigest: ownerEditorScopeDigest(malformedScope),
      formIssuedAt: new Date(malformedScope.issuedAt),
      formExpiresAt: new Date(malformedScope.expiresAt),
      result: { outcome: 'saved', ids: { memoryId: randomUUID() }, revision: 'd'.repeat(64) },
      claimToken: null,
      claimExpiresAt: null,
      status: 'committed',
      statusVersion: 2,
    };
    const wrongPhysical = track(
      currentStore.collection('ownerEditorOperations').doc('wrong-physical-key'),
    );
    await wrongPhysical.create(encodeRecord(malformed));
    await expect(
      pruneExpiredFirestoreOwnerEditorReceipts(currentStore, ownerId, now),
    ).rejects.toThrow();
    expect((await validAgain.get()).exists).toBe(true);
    expect((await wrongPhysical.get()).exists).toBe(true);
  });
});
