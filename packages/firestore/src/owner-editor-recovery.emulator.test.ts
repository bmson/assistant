import { createHash, randomUUID } from 'node:crypto';
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
import { type DocumentReference, Firestore, Timestamp } from '@google-cloud/firestore';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readerFixtures } from '../../persistence/src/owner-editor-reader-fixtures.test-support.js';
import { ownerEditorEmulatorAuth } from './owner-editor-emulator-auth.js';
import { createFirestoreOwnerEditorRecoveryStorage } from './owner-editor-recovery.js';
import {
  MAX_RECOVERY_CONFLICT_CALLBACKS_PER_RACER,
  MAX_RECOVERY_CONFLICT_CALLBACKS_TOTAL,
  OwnerEditorRecoveryConflictBarrier,
} from './owner-editor-recovery-conflict.test-support.js';
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
const MAX_QUALIFICATION_TOTAL_REFS = 160;
const MAX_CLEANUP_TOTAL_REFS = 192;
const CONFLICT_COMPLETION_BOUND_MS = 10_000;
const REPLAY_WINDOW_MS = 24 * 60 * 60_000;
const cleanMaintenance: OwnerEditorRecoveryMaintenanceState = {
  driver: 'firestore',
  releaseWritesPaused: false,
  restoreRehearsal: false,
  postgresSourceWritesFenced: false,
};

let store: InstallationStore | undefined;
let cleanupRefs: DocumentReference[] = [];
let sentinelSnapshots: Array<{
  ref: DocumentReference;
  fields: readonly string[];
  baseline: SentinelSnapshot;
}> = [];
let primaryCollectionPaths: { memories: string[]; ownerCards: string[] } | undefined;
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

interface SentinelSnapshot {
  physicalPath: string;
  projectId: string;
  databaseId: string;
  createTime: { seconds: number; nanoseconds: number };
  updateTime: { seconds: number; nanoseconds: number };
  contentHash: string;
}

const MEMORY_SENTINEL_FIELDS = [
  'id',
  'agentId',
  'category',
  'kind',
  'content',
  'contentHash',
  'confidence',
  'importance',
  'originTrust',
  'sourceTaskId',
  'expiresAt',
  'embedding',
  'goalId',
  'quarantined',
  'subjectContactId',
  'domain',
  'validFrom',
  'validUntil',
  'supersededById',
  'ownerConfirmed',
  'pinned',
  'source',
  'embeddingSpaceKey',
  'lastAccessedAt',
  'lastConsolidatedAt',
  'createdAt',
] as const;
const OWNER_CARD_SENTINEL_FIELDS = ['agentId', 'content', 'compiledAt'] as const;

function canonicalValue(value: unknown): unknown {
  if (value instanceof Timestamp) return { seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object' && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  return value;
}

async function snapshotSentinel(
  currentStore: InstallationStore,
  ref: DocumentReference,
  fields: readonly string[],
): Promise<SentinelSnapshot> {
  const snapshot = await ref.get();
  if (
    !snapshot.exists ||
    snapshot.ref.path !== ref.path ||
    snapshot.id !== ref.id ||
    !snapshot.createTime ||
    !snapshot.updateTime
  )
    throw new Error('Sentinel physical identity or update time is unavailable');
  const data = snapshot.data();
  if (!data) throw new Error('Sentinel document content is unavailable');
  if (!currentStore.projectId || snapshot.ref.firestore !== currentStore.db)
    throw new Error('Sentinel namespace identity is unavailable');
  if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify([...fields].sort()))
    throw new Error('Sentinel field set changed');
  const selected = Object.fromEntries(fields.map((field) => [field, canonicalValue(data[field])]));
  const serialized = JSON.stringify(selected);
  if (Buffer.byteLength(serialized, 'utf8') > 16_384)
    throw new Error('Sentinel byte bound exceeded');
  return {
    physicalPath: snapshot.ref.path,
    projectId: currentStore.projectId,
    databaseId: currentStore.databaseId,
    createTime: {
      seconds: snapshot.createTime.seconds,
      nanoseconds: snapshot.createTime.nanoseconds,
    },
    updateTime: {
      seconds: snapshot.updateTime.seconds,
      nanoseconds: snapshot.updateTime.nanoseconds,
    },
    contentHash: createHash('sha256').update(serialized).digest('hex'),
  };
}

async function primaryCensus(
  currentStore: InstallationStore,
  memoryRefs: readonly DocumentReference[],
  ownerCardRefs: readonly DocumentReference[],
): Promise<{ memories: string[]; ownerCards: string[] }> {
  const [memories, ownerCards] = await Promise.all([
    currentStore
      .collection('memories')
      .limit(memoryRefs.length + 1)
      .get(),
    currentStore
      .collection('ownerCards')
      .limit(ownerCardRefs.length + 1)
      .get(),
  ]);
  return {
    memories: memories.docs.map((snapshot) => snapshot.ref.path).sort(),
    ownerCards: ownerCards.docs.map((snapshot) => snapshot.ref.path).sort(),
  };
}

function track(ref: DocumentReference): DocumentReference {
  if (cleanupRefs.some((current) => current.path === ref.path)) return ref;
  cleanupRefs.push(ref);
  totalTrackedRefs += 1;
  if (cleanupRefs.length > MAX_TEST_REFS || totalTrackedRefs > MAX_CLEANUP_TOTAL_REFS)
    throw new Error('Firestore recovery cleanup reference bound exceeded');
  if (totalTrackedRefs > MAX_QUALIFICATION_TOTAL_REFS)
    throw new Error('Firestore recovery qualification reference bound exceeded');
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
  const memoryRefs = [0, 1].map((index) => {
    const id = randomUUID();
    return { id, index, ref: track(currentStore.doc('memories', id)) };
  });
  const ownerCardRef = track(currentStore.doc('ownerCards', ownerId));
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
  for (const { id, index, ref } of memoryRefs) {
    await ref.create(
      encodeRecord({
        id,
        agentId: ownerId,
        category: 'knowledge',
        kind: 'fact',
        content: `Recovery qualification sentinel ${index}`,
        contentHash: createHash('sha256').update(`${ownerId}:${index}`).digest('hex'),
        confidence: '0.80',
        importance: 2,
        originTrust: 'owner',
        sourceTaskId: null,
        expiresAt: null,
        embedding: null,
        goalId: null,
        quarantined: false,
        subjectContactId: null,
        domain: 'other',
        validFrom: null,
        validUntil: null,
        supersededById: null,
        ownerConfirmed: true,
        pinned: false,
        source: 'test',
        embeddingSpaceKey: null,
        lastAccessedAt: null,
        lastConsolidatedAt: null,
        createdAt: now,
      }),
    );
  }
  await ownerCardRef.create(
    encodeRecord({
      agentId: ownerId,
      content: 'Recovery qualification sentinel card',
      compiledAt: now,
    }),
  );
  sentinelSnapshots = [
    ...(await Promise.all(
      memoryRefs.map(async ({ ref }) => ({
        ref,
        fields: MEMORY_SENTINEL_FIELDS,
        baseline: await snapshotSentinel(currentStore, ref, MEMORY_SENTINEL_FIELDS),
      })),
    )),
    {
      ref: ownerCardRef,
      fields: OWNER_CARD_SENTINEL_FIELDS,
      baseline: await snapshotSentinel(currentStore, ownerCardRef, OWNER_CARD_SENTINEL_FIELDS),
    },
  ];
  primaryCollectionPaths = {
    memories: memoryRefs.map(({ ref }) => ref.path).sort(),
    ownerCards: [ownerCardRef.path],
  };
  const seededPrimaryPaths = await primaryCensus(
    currentStore,
    memoryRefs.map(({ ref }) => ref),
    [ownerCardRef],
  );
  if (
    JSON.stringify(seededPrimaryPaths.memories) !==
      JSON.stringify(primaryCollectionPaths.memories) ||
    JSON.stringify(seededPrimaryPaths.ownerCards) !==
      JSON.stringify(primaryCollectionPaths.ownerCards)
  )
    throw new Error('Unexpected primary documents were present after sentinel seeding');

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

async function withinCompletionBound<T>(promise: Promise<T>, boundMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Conflict racers exceeded the ${boundMs}ms completion bound`)),
          boundMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
        if (
          cleanupRefs.length > MAX_TEST_REFS ||
          totalTrackedRefs > MAX_QUALIFICATION_TOTAL_REFS ||
          totalTrackedRefs > MAX_CLEANUP_TOTAL_REFS
        ) {
          cleanupErrors.push('reference-bound-exceeded');
          failure = true;
          caseRemainingRefs = 1;
        }
        try {
          if (!primaryCollectionPaths) throw new Error('Primary collection baseline unavailable');
          const currentPaths = await primaryCensus(
            currentStore,
            cleanupRefs.filter((ref) => ref.parent.id === 'memories'),
            cleanupRefs.filter((ref) => ref.parent.id === 'ownerCards'),
          );
          if (
            JSON.stringify(currentPaths.memories) !==
              JSON.stringify(primaryCollectionPaths.memories) ||
            JSON.stringify(currentPaths.ownerCards) !==
              JSON.stringify(primaryCollectionPaths.ownerCards)
          ) {
            cleanupErrors.push('untracked-primary-document-detected');
            failure = true;
            // Do not adopt or delete an unexpected primary row. The outer
            // owner of this isolated emulator database handles unknown state.
            caseRemainingRefs += 1;
          }
        } catch {
          cleanupErrors.push('primary-collection-census-failed');
          failure = true;
          caseRemainingRefs += 1;
        }
        for (const sentinel of sentinelSnapshots) {
          try {
            const current = await snapshotSentinel(currentStore, sentinel.ref, sentinel.fields);
            if (
              current.physicalPath !== sentinel.baseline.physicalPath ||
              current.projectId !== sentinel.baseline.projectId ||
              current.databaseId !== sentinel.baseline.databaseId ||
              current.createTime.seconds !== sentinel.baseline.createTime.seconds ||
              current.createTime.nanoseconds !== sentinel.baseline.createTime.nanoseconds ||
              current.updateTime.seconds !== sentinel.baseline.updateTime.seconds ||
              current.updateTime.nanoseconds !== sentinel.baseline.updateTime.nanoseconds ||
              current.contentHash !== sentinel.baseline.contentHash
            ) {
              cleanupErrors.push('domain-sentinel-changed');
              failure = true;
            }
          } catch {
            cleanupErrors.push('domain-sentinel-readback-failed');
            failure = true;
          }
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
        sentinelSnapshots = [];
        primaryCollectionPaths = undefined;
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
    const barrier = new OwnerEditorRecoveryConflictBarrier();
    const runRacer = (index: 0 | 1) =>
      storage(f).withRecoveryTransaction(f.scope, async (transaction) => {
        barrier.callbackStarted(index);
        const snapshot = await transaction.readFresh();
        if (
          snapshot.operation &&
          parseOwnerEditorOperationRecord(snapshot.operation).status === 'preparing'
        ) {
          const gate = await barrier.waitForBothPreparing(index);
          if (gate !== 'both-racers-preparing')
            throw new Error(`Conflict rendezvous ended with ${gate}`);
        }
        return transaction.abandonExpiredOriginal(f.expected);
      });
    const racers = [runRacer(0), runRacer(1)];
    const settledPromise = Promise.allSettled(racers);
    let settled = false;
    try {
      const boundedResults = await withinCompletionBound(
        settledPromise,
        CONFLICT_COMPLETION_BOUND_MS,
      );
      settled = true;
      barrier.dispose();
      const barrierResult = barrier.snapshot();

      const [operationDocumentResult, operationQueryResult] = await Promise.allSettled([
        f.operationRef.get(),
        f.store.collection('ownerEditorOperations').limit(2).get(),
      ]);
      const finalRecord =
        operationDocumentResult.status === 'fulfilled' &&
        operationDocumentResult.value.exists &&
        operationDocumentResult.value.data()
          ? (() => {
              try {
                return parseOwnerEditorOperationRecord(
                  decodeRecord(operationDocumentResult.value.data()),
                );
              } catch {
                return null;
              }
            })()
          : null;
      const operationDocumentCount =
        operationQueryResult.status === 'fulfilled' ? operationQueryResult.value.size : null;
      const exactDurableRow = Boolean(
        finalRecord &&
          operationDocumentCount === 1 &&
          finalRecord.id === f.record.id &&
          finalRecord.ownerId === f.record.ownerId &&
          finalRecord.epoch === f.record.epoch &&
          finalRecord.privacyGenerationDigest === f.record.privacyGenerationDigest &&
          finalRecord.operationId === f.record.operationId &&
          finalRecord.command === f.record.command &&
          finalRecord.scopeDigest === f.record.scopeDigest &&
          finalRecord.protocolVersion === f.record.protocolVersion &&
          finalRecord.requestHash === f.record.requestHash &&
          finalRecord.formIssuedAt.getTime() === f.record.formIssuedAt.getTime() &&
          finalRecord.formExpiresAt.getTime() === f.record.formExpiresAt.getTime() &&
          finalRecord.status === 'abandoned' &&
          finalRecord.statusVersion === f.record.statusVersion + 1 &&
          finalRecord.claimToken === null &&
          finalRecord.claimExpiresAt === null &&
          finalRecord.result?.outcome === 'not_applied' &&
          finalRecord.result.reason === 'claim_abandoned',
      );
      const successfulResults = boundedResults.filter(
        (result) => result.status === 'fulfilled' && Boolean(result.value),
      ).length;
      const receipt = {
        formatVersion: 1,
        case: 'real-transaction-conflict-retry',
        barrier: {
          timeoutMs: barrierResult.timeoutMs,
          timedOut: barrierResult.timedOut,
          firstAttemptClients: barrierResult.firstAttemptClients,
          preparingClients: barrierResult.distinctPreparingClients,
          callbackEntries: barrierResult.callbackEntries,
          preparingReads: barrierResult.preparingReads,
          totalCallbacks: barrierResult.totalCallbacks,
          totalPreparingReads: barrierResult.totalPreparingReads,
          disposed: barrierResult.disposed,
        },
        native: {
          sdkCallbackTotal: barrierResult.totalCallbacks,
          successfulResults,
          settledClients: boundedResults.length,
          fulfilledClients: boundedResults.filter((result) => result.status === 'fulfilled').length,
          rejectedClients: boundedResults.filter((result) => result.status === 'rejected').length,
          completionBoundMs: CONFLICT_COMPLETION_BOUND_MS,
          exactDurableRow,
          operationDocumentCount,
        },
      };
      if (!TMP_DIRECTORY) throw new Error('TMPDIR is required for conflict evidence');
      await writeFile(
        join(TMP_DIRECTORY, 'recovery-fs-conflict.json'),
        `${JSON.stringify(receipt, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );

      expect(barrierResult.timedOut).toBe(false);
      expect(barrierResult.firstAttemptClients).toEqual([0, 1]);
      expect(barrierResult.distinctPreparingClients).toEqual([0, 1]);
      expect(barrierResult.totalCallbacks).toBeGreaterThan(2);
      expect(barrierResult.totalCallbacks).toBeLessThanOrEqual(
        MAX_RECOVERY_CONFLICT_CALLBACKS_TOTAL,
      );
      expect(
        barrierResult.callbackEntries.every(
          (count) => count <= MAX_RECOVERY_CONFLICT_CALLBACKS_PER_RACER,
        ),
      ).toBe(true);
      expect(boundedResults.every((result) => result.status === 'fulfilled')).toBe(true);
      expect(successfulResults).toBe(1);
      expect(operationDocumentCount).toBe(1);
      expect(finalRecord).toMatchObject({
        id: f.record.id,
        ownerId: f.record.ownerId,
        epoch: f.record.epoch,
        privacyGenerationDigest: f.record.privacyGenerationDigest,
        operationId: f.record.operationId,
        command: f.record.command,
        scopeDigest: f.record.scopeDigest,
        protocolVersion: f.record.protocolVersion,
        requestHash: f.record.requestHash,
        status: 'abandoned',
        statusVersion: f.record.statusVersion + 1,
        claimToken: null,
        claimExpiresAt: null,
        result: { outcome: 'not_applied', reason: 'claim_abandoned' },
      });
      expect(exactDurableRow).toBe(true);
    } finally {
      barrier.dispose();
      if (!settled) {
        await withinCompletionBound(settledPromise, CONFLICT_COMPLETION_BOUND_MS);
      }
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
