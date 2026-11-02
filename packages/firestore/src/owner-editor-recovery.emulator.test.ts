import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type OwnerEditorRecoveryMaintenanceState,
  type OwnerEditorRecoveryStorageOptions,
  type OwnerEditorScope,
  type OwnerEditorSessionView,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  parseOwnerEditorOperationRecord,
} from '@assistant/persistence';
import { type DocumentReference, Firestore } from '@google-cloud/firestore';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readerFixtures } from '../../persistence/src/owner-editor-reader-fixtures.test-support.js';
import { ownerEditorEmulatorAuth } from './owner-editor-emulator-auth.js';
import { createFirestoreOwnerEditorRecoveryStorage } from './owner-editor-recovery.js';
import { decodeRecord, encodeRecord, InstallationStore } from './store.js';

const TARGET_PROJECT = 'demo-owner-editor-recovery-qualification';
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT_GATE = process.env.OWNER_EDITOR_RECOVERY_FS_QUALIFICATION_PROJECT;
const EXTERNAL_CREDENTIALS_DISABLED = process.env.ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS === '1';
const TMP_DIRECTORY = process.env.TMPDIR;
const loopbackHost = /^(127\.0\.0\.1|localhost):\d+$/.test(HOST ?? '');
if (HOST && !loopbackHost) throw new Error('Loopback Firestore emulator required');
if (HOST && PROJECT_GATE && PROJECT_GATE !== TARGET_PROJECT)
  throw new Error('Unexpected Firestore recovery qualification project gate');
if (HOST && PROJECT_GATE === TARGET_PROJECT && !EXTERNAL_CREDENTIALS_DISABLED)
  throw new Error('External credentials must be disabled for Firestore qualification');
if (HOST && PROJECT_GATE === TARGET_PROJECT && !TMP_DIRECTORY)
  throw new Error('TMPDIR is required for Firestore cleanup evidence');

const enabled =
  Boolean(HOST) &&
  loopbackHost &&
  PROJECT_GATE === TARGET_PROJECT &&
  EXTERNAL_CREDENTIALS_DISABLED &&
  Boolean(TMP_DIRECTORY);
const EXPECTED_TESTS = 9;
const MAX_TEST_REFS = 160;
const MAX_TOTAL_REFS = 160;
const MAX_CALLBACKS_PER_TRANSACTION = 9;
const REPLAY_WINDOW_MS = 24 * 60 * 60_000;
const cleanMaintenance: OwnerEditorRecoveryMaintenanceState = {
  driver: 'firestore',
  releaseWritesPaused: false,
  restoreRehearsal: false,
  postgresSourceWritesFenced: false,
};

let store: InstallationStore | undefined;
let cleanupRefs: DocumentReference[] = [];
let totalTrackedRefs = 0;
let completedCleanups = 0;
let clientsTerminated = 0;
let remainingRefs = 0;
const cleanupErrors: string[] = [];
let activeCase = 'unknown';
const cases: Array<{
  case: string;
  trackedRefs: number;
  remainingRefs: number;
  terminated: boolean;
}> = [];

function track(ref: DocumentReference): DocumentReference {
  if (cleanupRefs.some((current) => current.path === ref.path)) return ref;
  cleanupRefs.push(ref);
  totalTrackedRefs += 1;
  if (cleanupRefs.length > MAX_TEST_REFS || totalTrackedRefs > MAX_TOTAL_REFS)
    throw new Error('Firestore recovery cleanup reference bound exceeded');
  return ref;
}

function freshStore(caseName: string): InstallationStore {
  if (!HOST || !enabled) throw new Error('Root-supervised local recovery emulator required');
  activeCase = caseName;
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const projectId = `${TARGET_PROJECT}-${nonce}`;
  const databaseId = `owner-editor-recovery-${nonce}-test`;
  const db = new Firestore({
    projectId,
    databaseId,
    host: HOST,
    ssl: false,
    universeDomain: 'googleapis.com',
    preferRest: true,
    authClient: ownerEditorEmulatorAuth(HOST),
  } as ConstructorParameters<typeof Firestore>[0]);
  store = new InstallationStore(
    db,
    `owner-editor-recovery-qualification-${nonce}`,
    undefined,
    projectId,
    databaseId,
  );
  cleanupRefs = [];
  return store;
}

interface Fixture {
  store: InstallationStore;
  ownerId: string;
  epoch: string;
  epochName: string;
  scope: OwnerEditorScope;
  record: ReturnType<typeof parseOwnerEditorOperationRecord>;
  operationRef: DocumentReference;
  session: OwnerEditorSessionView;
  expected: {
    scope: OwnerEditorScope;
    session: OwnerEditorSessionView;
    requestHash: string;
    claimToken: string;
    claimExpiresAt: Date;
    statusVersion: number;
    now: Date;
    proofExpiresAt: Date;
    replayExpiresAt: Date;
    maintenance: OwnerEditorRecoveryMaintenanceState;
  };
  options: OwnerEditorRecoveryStorageOptions;
  setNow(value: Date): void;
  setMaintenance(value: unknown): void;
}

async function fixture(caseName: string): Promise<Fixture> {
  const currentStore = freshStore(caseName);
  const now = new Date();
  const ownerId = randomUUID();
  const epoch = randomUUID();
  const epochName = `owner-editor-epoch:${ownerId}`;
  const reader = readerFixtures({ ownerId, epoch, now, privacyGeneration: null });
  const item = reader.createOwnerMemory.expiredPreparing;
  const claimToken = item.record.claimToken;
  const claimExpiresAt = item.record.claimExpiresAt;
  if (!claimToken || !claimExpiresAt) throw new Error('Preparing fixture is missing its claim');
  const session: OwnerEditorSessionView = {
    ownerId,
    formSessionScope: `recovery-emulator-session-${randomUUID()}`,
  };
  const ownerRef = track(currentStore.doc('agents', ownerId));
  const epochRef = track(currentStore.doc('maintenanceCursors', epochName));
  const operationRef = track(currentStore.doc('ownerEditorOperations', item.record.id));
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
  await operationRef.create(encodeRecord(item.record as unknown as Record<string, unknown>));

  let clock = now;
  let currentMaintenance: unknown = cleanMaintenance;
  const options: OwnerEditorRecoveryStorageOptions = {
    readMaintenance: async () => currentMaintenance,
    authorize: async (scope, expectedSession) =>
      scope.ownerId === ownerId &&
      scope.operationId === item.scope.operationId &&
      scope.command === item.scope.command &&
      (!expectedSession ||
        (expectedSession.ownerId === session.ownerId &&
          expectedSession.formSessionScope === session.formSessionScope)),
    now: () => new Date(clock.getTime()),
  };
  const expected = {
    scope: item.scope,
    session,
    requestHash: item.record.requestHash,
    claimToken,
    claimExpiresAt: new Date(claimExpiresAt.getTime()),
    statusVersion: item.record.statusVersion,
    now: new Date(now.getTime()),
    proofExpiresAt: new Date(now.getTime() + 120_000),
    replayExpiresAt: new Date(item.scope.issuedAt + REPLAY_WINDOW_MS),
    maintenance: cleanMaintenance,
  };
  return {
    store: currentStore,
    ownerId,
    epoch,
    epochName,
    scope: item.scope,
    record: item.record,
    operationRef,
    session,
    expected,
    options,
    setNow(value) {
      clock = new Date(value.getTime());
    },
    setMaintenance(value) {
      currentMaintenance = value;
    },
  };
}

function storage(f: Fixture, options: OwnerEditorRecoveryStorageOptions = f.options) {
  return createFirestoreOwnerEditorRecoveryStorage(f.store, options);
}

async function readOperation(f: Fixture) {
  const snapshot = await f.operationRef.get();
  if (!snapshot.exists) throw new Error('Expected original operation row to remain present');
  return parseOwnerEditorOperationRecord(decodeRecord(snapshot.data()));
}

async function runAbandon(f: Fixture, expected = f.expected) {
  return storage(f).withRecoveryTransaction(f.scope, async (transaction) => {
    await transaction.readFresh();
    return transaction.abandonExpiredOriginal(expected);
  });
}

describe.skipIf(!enabled)('owner-editor recovery Firestore transaction qualification', () => {
  afterEach(async () => {
    const currentStore = store;
    const caseName = activeCase === 'unknown' ? `case-${cases.length + 1}` : activeCase;
    const trackedRefs = cleanupRefs.length;
    let caseRemainingRefs = 0;
    let failure = false;
    let terminated = currentStore === undefined;
    if (currentStore) {
      try {
        if (cleanupRefs.length > MAX_TEST_REFS || totalTrackedRefs > MAX_TOTAL_REFS) {
          cleanupErrors.push('reference-bound-exceeded');
          failure = true;
          caseRemainingRefs = 1;
        }
        for (let index = 0; index < cleanupRefs.length; index += 190) {
          try {
            const batch = currentStore.db.batch();
            for (const ref of cleanupRefs.slice(index, index + 190)) batch.delete(ref);
            await batch.commit();
          } catch {
            cleanupErrors.push('owned-reference-delete-failed');
            failure = true;
            caseRemainingRefs += 1;
          }
        }
        try {
          const readbacks = await Promise.all(cleanupRefs.map((ref) => ref.get()));
          caseRemainingRefs += readbacks.filter((snapshot) => snapshot.exists).length;
        } catch {
          cleanupErrors.push('owned-reference-absence-readback-failed');
          failure = true;
          caseRemainingRefs += Math.max(cleanupRefs.length, 1);
        }
        if (caseRemainingRefs > 0) {
          cleanupErrors.push('owned-references-remain');
          failure = true;
        }
      } catch {
        cleanupErrors.push('owned-reference-cleanup-failed');
        failure = true;
        caseRemainingRefs = Math.max(caseRemainingRefs, 1);
      } finally {
        try {
          await currentStore.db.terminate();
          terminated = true;
          clientsTerminated += 1;
        } catch {
          cleanupErrors.push('firestore-client-termination-failed');
          failure = true;
        }
        store = undefined;
        cleanupRefs = [];
      }
    }
    remainingRefs += caseRemainingRefs;
    if (!failure && terminated) completedCleanups += 1;
    cases.push({ case: caseName, trackedRefs, remainingRefs: caseRemainingRefs, terminated });
    activeCase = 'unknown';
    if (failure || !terminated) throw new Error('Firestore recovery owned cleanup failed');
  });

  afterAll(async () => {
    if (!enabled || !TMP_DIRECTORY) return;
    const receipt = {
      formatVersion: 1,
      expectedTests: EXPECTED_TESTS,
      completedCleanups,
      totalTrackedRefs,
      remainingRefs,
      terminatedClients: clientsTerminated,
      cleanupErrors,
      cases,
    };
    await writeFile(
      join(TMP_DIRECTORY, 'recovery-fs-cleanup.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      },
    );
  });

  it('reads exact owner, epoch and operation rows with native timestamp decoding and zero writes', async () => {
    const f = await fixture('read-only-exact-snapshot');
    const result = await storage(f).withRecoveryTransaction(f.scope, (transaction) =>
      transaction.readFresh(),
    );
    expect(result.current).toEqual({
      ownerId: f.ownerId,
      epoch: f.epoch,
      privacyGeneration: null,
      ready: true,
    });
    expect(result.operation).toMatchObject({
      id: ownerEditorOperationId(f.scope),
      requestHash: f.record.requestHash,
      status: 'preparing',
    });
    expect((result.operation as { formIssuedAt: unknown }).formIssuedAt).toBeInstanceOf(Date);
    expect((await f.store.doc('maintenanceCursors', f.epochName).get()).exists).toBe(true);
    expect((await readOperation(f)).status).toBe('preparing');
  }, 60_000);

  it('commits one exact abandoned transition and returns its durable readback', async () => {
    const f = await fixture('exact-expired-claim-commit');
    const result = await runAbandon(f);
    expect(result).toMatchObject({
      id: ownerEditorOperationId(f.scope),
      requestHash: f.record.requestHash,
      status: 'abandoned',
      statusVersion: f.record.statusVersion + 1,
      claimToken: null,
      claimExpiresAt: null,
      result: { outcome: 'not_applied', reason: 'claim_abandoned' },
    });
    expect(await readOperation(f)).toMatchObject({
      status: 'abandoned',
      statusVersion: f.record.statusVersion + 1,
      result: { outcome: 'not_applied', reason: 'claim_abandoned' },
    });
    expect((await f.store.doc('maintenanceCursors', f.epochName).get()).get('cursor')).toBe(
      JSON.stringify({
        ownerId: f.ownerId,
        epoch: f.epoch,
        ready: true,
        privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      }),
    );
    expect((await f.store.collection('memories').limit(1).get()).size).toBe(0);
    const duplicate = await runAbandon(f);
    expect(duplicate).toBeNull();
    expect(await readOperation(f)).toMatchObject({ statusVersion: f.record.statusVersion + 1 });
  }, 60_000);

  it('rolls back a queued receipt update when the transaction callback fails, then succeeds once for the same operation', async () => {
    const f = await fixture('rollback-then-same-operation-success');
    const dormant = storage(f);
    await expect(
      dormant.withRecoveryTransaction(f.scope, async (transaction) => {
        await transaction.readFresh();
        await transaction.abandonExpiredOriginal(f.expected);
        throw new Error('synthetic failure after update was queued');
      }),
    ).rejects.toThrow('synthetic failure after update was queued');
    expect(await readOperation(f)).toMatchObject({
      status: 'preparing',
      statusVersion: f.record.statusVersion,
      claimToken: f.record.claimToken,
    });

    const committed = await runAbandon(f);
    expect(committed).toMatchObject({
      operationId: f.scope.operationId,
      requestHash: f.record.requestHash,
      status: 'abandoned',
      statusVersion: f.record.statusVersion + 1,
    });
    const replay = await runAbandon(f);
    expect(replay).toBeNull();
    const row = await readOperation(f);
    expect(row.statusVersion).toBe(f.record.statusVersion + 1);
    expect(row.result).toEqual({ outcome: 'not_applied', reason: 'claim_abandoned' });
  }, 60_000);

  it('observes an actual concurrent claim change, retries the SDK callback and does not write stale abandonment', async () => {
    const f = await fixture('real-transaction-conflict-retry');
    let arrivals = 0;
    let releaseReaders: (() => void) | undefined;
    let barrierTimedOut = false;
    const bothRead = new Promise<void>((resolve) => {
      releaseReaders = resolve;
    });
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const callbacks = [0, 0];
    const runRacer = (index: number) =>
      storage(f).withRecoveryTransaction(f.scope, async (transaction) => {
        callbacks[index] = (callbacks[index] ?? 0) + 1;
        const snapshot = await transaction.readFresh();
        if (
          snapshot.operation &&
          parseOwnerEditorOperationRecord(snapshot.operation).status === 'preparing'
        ) {
          arrivals += 1;
          if (arrivals === 2) {
            if (fallback) clearTimeout(fallback);
            releaseReaders?.();
          }
          await bothRead;
        }
        return transaction.abandonExpiredOriginal(f.expected);
      });
    fallback = setTimeout(() => {
      barrierTimedOut = true;
      releaseReaders?.();
    }, 5_000);
    try {
      const results = await Promise.all([runRacer(0), runRacer(1)]);
      expect(barrierTimedOut).toBe(false);
      expect(arrivals).toBe(2);
      expect(callbacks.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(2);
      expect(callbacks.every((count) => count <= MAX_CALLBACKS_PER_TRANSACTION)).toBe(true);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await readOperation(f)).toMatchObject({
        status: 'abandoned',
        statusVersion: f.record.statusVersion + 1,
        requestHash: f.record.requestHash,
      });
    } finally {
      if (fallback) clearTimeout(fallback);
      releaseReaders?.();
    }
  }, 60_000);

  it('refuses to queue a journal write if the proof expires before the final update check', async () => {
    const f = await fixture('proof-expires-before-update');
    let clockReads = 0;
    const options = {
      ...f.options,
      now: () => {
        clockReads += 1;
        if (clockReads === 1) return new Date(f.expected.now);
        if (clockReads === 2) return new Date(f.expected.now.getTime() + 119_999);
        return new Date(f.expected.proofExpiresAt);
      },
    };
    const result = await storage(f, options).withRecoveryTransaction(
      f.scope,
      async (transaction) => {
        await transaction.readFresh();
        return transaction.abandonExpiredOriginal(f.expected);
      },
    );
    expect(result).toBeNull();
    expect(clockReads).toBe(3);
    expect(await readOperation(f)).toMatchObject({
      status: 'preparing',
      statusVersion: f.record.statusVersion,
    });
  }, 60_000);

  it('does not update when epoch readiness falls before reconciliation', async () => {
    const f = await fixture('readiness-falls-before-update');
    const epochRef = f.store.doc('maintenanceCursors', f.epochName);
    const row = await epochRef.get();
    const parsed = JSON.parse(String(row.get('cursor'))) as Record<string, unknown>;
    await epochRef.update({
      cursor: JSON.stringify({ ...parsed, ready: false }),
    });
    const snapshot = await storage(f).withRecoveryTransaction(f.scope, (transaction) =>
      transaction.readFresh(),
    );
    expect(snapshot.current.ready).toBe(false);
    const result = await runAbandon(f);
    expect(result).toBeNull();
    expect(await readOperation(f)).toMatchObject({ status: 'preparing' });
  }, 60_000);

  it('does not expose or mutate an operation while privacy erasure is incomplete', async () => {
    const f = await fixture('incomplete-privacy-generation');
    const privacyRef = track(f.store.doc('privacyErasureJobs', f.ownerId));
    await privacyRef.create(
      encodeRecord({ agentId: f.ownerId, status: 'running', generation: 'pending-generation' }),
    );
    await expect(
      storage(f).withRecoveryTransaction(f.scope, (transaction) => transaction.readFresh()),
    ).rejects.toThrow('Editor privacy state is unavailable');
    expect(await readOperation(f)).toMatchObject({ status: 'preparing' });
  }, 60_000);

  it('refuses a foreign installation owner before reading any journal row', async () => {
    const f = await fixture('foreign-installation-owner');
    const foreignScope = { ...f.scope, ownerId: randomUUID(), operationId: randomUUID() };
    const permissiveOptions = { ...f.options, authorize: async () => true };
    await expect(
      storage(f, permissiveOptions).withRecoveryTransaction(foreignScope, (transaction) =>
        transaction.readFresh(),
      ),
    ).rejects.toThrow('Recovery owner is unavailable');
    expect(await readOperation(f)).toMatchObject({ status: 'preparing' });
  }, 60_000);

  it('rechecks runtime holds before update while ignoring the PostgreSQL-only fence for Firestore', async () => {
    const f = await fixture('maintenance-and-postgres-fence');
    let calls = 0;
    const options: OwnerEditorRecoveryStorageOptions = {
      ...f.options,
      readMaintenance: async () => {
        calls += 1;
        if (calls === 1 || calls === 2) return cleanMaintenance;
        return { ...cleanMaintenance, restoreRehearsal: true };
      },
    };
    const blocked = await storage(f, options).withRecoveryTransaction(
      f.scope,
      async (transaction) => {
        await transaction.readFresh();
        return transaction.abandonExpiredOriginal(f.expected);
      },
    );
    expect(blocked).toBeNull();
    expect(await readOperation(f)).toMatchObject({ status: 'preparing' });

    const fenced = { ...cleanMaintenance, postgresSourceWritesFenced: true };
    f.setMaintenance(fenced);
    const allowedOptions = { ...f.options, readMaintenance: async () => fenced };
    const result = await storage(f, allowedOptions).withRecoveryTransaction(
      f.scope,
      async (transaction) => {
        await transaction.readFresh();
        return transaction.abandonExpiredOriginal({ ...f.expected, maintenance: fenced });
      },
    );
    expect(result).toMatchObject({ status: 'abandoned' });
    expect(await readOperation(f)).toMatchObject({ status: 'abandoned' });
  }, 60_000);
});
