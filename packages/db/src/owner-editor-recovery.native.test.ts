import { randomUUID } from 'node:crypto';
import {
  type OwnerEditorExpiredClaimExpectation,
  type OwnerEditorRecoveryMaintenanceState,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
} from '@assistant/persistence';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OwnerEditorPreparingReaderFixture } from '../../persistence/src/owner-editor-reader-fixtures.test-support.js';
import { readerFixtures } from '../../persistence/src/owner-editor-reader-fixtures.test-support.js';
import { createDb, type Db } from './client.js';
import { createPostgresOwnerEditorRecoveryStorage } from './owner-editor-recovery.js';
import {
  agents,
  maintenanceCursors,
  memories,
  ownerCard,
  ownerEditorOperations,
} from './schema.js';
import { assertAllocatedTestTarget } from './test-target.js';

const enabled = process.env.OWNER_EDITOR_RECOVERY_PG_QUALIFICATION === '1';
const replayWindowMs = 24 * 60 * 60_000;
const epochName = (ownerId: string) => `owner-editor-epoch:${ownerId}`;
const generationName = (ownerId: string) => `privacy-erasure-generation:${ownerId}`;
const maintenance: OwnerEditorRecoveryMaintenanceState = {
  driver: 'postgres',
  releaseWritesPaused: false,
  restoreRehearsal: false,
  postgresSourceWritesFenced: false,
};
const primarySnapshotLimit = 5_000;

describe.skipIf(!enabled)('PostgreSQL owner-editor V2 recovery adapter qualification', () => {
  let db: Db | undefined;
  let fencedDb: Db | undefined;
  let ownerId = '';
  let privacyGeneration: string | null = null;
  let priorEpoch: { cursor: string | null; updatedAt: Date } | null = null;
  let priorGeneration: { cursor: string | null; updatedAt: Date } | null = null;
  let priorMemoryIds: string[] = [];
  let priorCards: { id: number; content: string; compiledAt: Date }[] = [];
  const fixtureEpochs: string[] = [];
  const operationIds: string[] = [];

  beforeAll(async () => {
    if (process.env.ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS !== '1')
      throw new Error('Run this suite through the isolated test environment.');
    const databaseUrl = process.env.DATABASE_URL;
    assertAllocatedTestTarget({
      databaseUrl,
      testDatabaseUrl: process.env.TEST_DATABASE_URL,
      token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    });
    if (!databaseUrl) throw new Error('Allocated PostgreSQL test target is unavailable.');
    db = createDb(databaseUrl, { max: 6, statementTimeoutMs: 15_000 });
    const owners = await db.select({ id: agents.id }).from(agents).limit(2);
    if (owners.length !== 1 || !owners[0])
      throw new Error('Expected exactly one isolated test owner.');
    ownerId = owners[0].id;
    const [epoch, generation, cardsBefore] = await Promise.all([
      db
        .select({ cursor: maintenanceCursors.cursor, updatedAt: maintenanceCursors.updatedAt })
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, epochName(ownerId)))
        .limit(1),
      db
        .select({ cursor: maintenanceCursors.cursor, updatedAt: maintenanceCursors.updatedAt })
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, generationName(ownerId)))
        .limit(1),
      db
        .select({ id: ownerCard.id, content: ownerCard.content, compiledAt: ownerCard.compiledAt })
        .from(ownerCard)
        .where(eq(ownerCard.id, 1)),
    ]);
    priorEpoch = epoch[0] ?? null;
    priorGeneration = generation[0] ?? null;
    privacyGeneration = generation[0]?.cursor ?? null;
    priorMemoryIds = await memoryIdSnapshot(db);
    priorCards = cardsBefore;
  });

  afterAll(async () => {
    let cleanupFailure: unknown;
    try {
      if (db && ownerId) {
        if (operationIds.length)
          await db
            .delete(ownerEditorOperations)
            .where(
              and(
                eq(ownerEditorOperations.ownerId, ownerId),
                inArray(ownerEditorOperations.id, operationIds),
              ),
            );
        const leftoverRows = operationIds.length
          ? await db
              .select({ id: ownerEditorOperations.id })
              .from(ownerEditorOperations)
              .where(
                and(
                  eq(ownerEditorOperations.ownerId, ownerId),
                  inArray(ownerEditorOperations.id, operationIds),
                ),
              )
          : [];
        expect(leftoverRows).toEqual([]);
        if (fixtureEpochs.length) {
          if (priorEpoch)
            await db
              .insert(maintenanceCursors)
              .values({ name: epochName(ownerId), ...priorEpoch })
              .onConflictDoUpdate({ target: maintenanceCursors.name, set: priorEpoch });
          else
            await db
              .delete(maintenanceCursors)
              .where(eq(maintenanceCursors.name, epochName(ownerId)));
          if (priorGeneration)
            await db
              .insert(maintenanceCursors)
              .values({ name: generationName(ownerId), ...priorGeneration })
              .onConflictDoUpdate({ target: maintenanceCursors.name, set: priorGeneration });
          else
            await db
              .delete(maintenanceCursors)
              .where(eq(maintenanceCursors.name, generationName(ownerId)));
          const [finalEpoch] = await db
            .select({ cursor: maintenanceCursors.cursor, updatedAt: maintenanceCursors.updatedAt })
            .from(maintenanceCursors)
            .where(eq(maintenanceCursors.name, epochName(ownerId)))
            .limit(1);
          const [finalGeneration] = await db
            .select({ cursor: maintenanceCursors.cursor, updatedAt: maintenanceCursors.updatedAt })
            .from(maintenanceCursors)
            .where(eq(maintenanceCursors.name, generationName(ownerId)))
            .limit(1);
          expect(finalEpoch ?? null).toEqual(priorEpoch);
          expect(finalGeneration ?? null).toEqual(priorGeneration);
        }
        const finalPrimary = await snapshotPrimaryState();
        expect(finalPrimary.memoryIds).toEqual(priorMemoryIds);
        expect(finalPrimary.cards).toEqual(priorCards);
      }
    } catch (error) {
      cleanupFailure = error;
    }
    const closings = [
      ...(fencedDb ? [fencedDb.$client.end({ timeout: 5 })] : []),
      ...(db ? [db.$client.end({ timeout: 5 })] : []),
    ];
    const results = await Promise.allSettled(closings);
    const closeFailure = results.find((result) => result.status === 'rejected');
    if (cleanupFailure === undefined && closeFailure?.status === 'rejected')
      cleanupFailure = closeFailure.reason;
    if (cleanupFailure !== undefined) throw cleanupFailure;
  });

  async function context(ready = true) {
    if (!db) throw new Error('Allocated test database is unavailable.');
    const now = await databaseNow(db);
    const epoch = randomUUID();
    fixtureEpochs.push(epoch);
    const cursor = JSON.stringify({
      ownerId,
      epoch,
      ready,
      privacyGenerationDigest: ownerEditorPrivacyDigest(privacyGeneration),
    });
    await db
      .insert(maintenanceCursors)
      .values({ name: epochName(ownerId), cursor })
      .onConflictDoUpdate({ target: maintenanceCursors.name, set: { cursor, updatedAt: now } });
    return {
      epoch,
      now,
      fixtures: readerFixtures({ ownerId, epoch, now, privacyGeneration }),
    };
  }

  async function seed(...fixtures: OwnerEditorPreparingReaderFixture[]) {
    if (!db) throw new Error('Allocated test database is unavailable.');
    track(fixtures.map((entry) => entry.record.id));
    await db.insert(ownerEditorOperations).values(fixtures.map((fixture) => fixture.record));
  }

  function track(ids: readonly string[]) {
    const all = new Set([...operationIds, ...ids]);
    if (all.size > 64) throw new Error('Recovery qualification exceeds its 64-row receipt bound.');
    operationIds.splice(0, operationIds.length, ...all);
  }

  function expectation(fixture: OwnerEditorPreparingReaderFixture, now: Date, overrides = {}) {
    if (!fixture.record.claimToken || !fixture.record.claimExpiresAt)
      throw new Error('Expected a preparing reader fixture.');
    return {
      scope: fixture.scope,
      session: { ownerId, formSessionScope: 'native-test-session-scope' },
      requestHash: fixture.record.requestHash,
      claimToken: fixture.record.claimToken,
      claimExpiresAt: new Date(fixture.record.claimExpiresAt),
      statusVersion: fixture.record.statusVersion,
      now,
      proofExpiresAt: new Date(now.getTime() + 120_000),
      replayExpiresAt: new Date(fixture.scope.issuedAt + replayWindowMs),
      maintenance,
      ...overrides,
    } satisfies OwnerEditorExpiredClaimExpectation;
  }

  function storage(database: Db, overrides: { authorize?: () => Promise<boolean> } = {}) {
    return createPostgresOwnerEditorRecoveryStorage(database, {
      authorize: overrides.authorize ?? (async () => true),
      readMaintenance: async () => maintenance,
    });
  }

  async function stored(scope: OwnerEditorPreparingReaderFixture['scope']) {
    if (!db) throw new Error('Allocated test database is unavailable.');
    const [row] = await db
      .select()
      .from(ownerEditorOperations)
      .where(eq(ownerEditorOperations.id, ownerEditorOperationId(scope)))
      .limit(1);
    if (!row) throw new Error('Expected recovery journal row is missing.');
    return row;
  }

  async function databaseNow(database: Db): Promise<Date> {
    const [row] = await database.$client<{ now: Date | string }[]>`
      select clock_timestamp() as now
    `;
    if (!row) throw new Error('PostgreSQL clock is unavailable.');
    const value = row.now instanceof Date ? new Date(row.now) : new Date(row.now);
    if (!Number.isFinite(value.getTime())) throw new Error('PostgreSQL clock is invalid.');
    return value;
  }

  async function waitForRecoveryLockWait(database: Db, timeoutMs = 1_000): Promise<number> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const rows = await database.$client<{ pid: number }[]>`
        select pid from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and state = 'active' and wait_event_type = 'Lock'
          and query ilike '%owner_editor_operations%'
      `;
      const waiter = rows[0];
      if (waiter) return waiter.pid;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for the recovery query lock.');
  }

  async function snapshotPrimaryState() {
    if (!db) throw new Error('Allocated test database is unavailable.');
    const [memoryRows, cards] = await Promise.all([
      memoryIdSnapshot(db),
      db
        .select({ id: ownerCard.id, content: ownerCard.content, compiledAt: ownerCard.compiledAt })
        .from(ownerCard)
        .where(eq(ownerCard.id, 1)),
    ]);
    return { memoryIds: memoryRows, cards };
  }

  async function memoryIdSnapshot(database: Db): Promise<string[]> {
    const rows = await database
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.agentId, ownerId))
      .limit(primarySnapshotLimit + 1);
    if (rows.length > primarySnapshotLimit)
      throw new Error('Owner memory snapshot exceeds the qualification bound.');
    return rows.map((row) => row.id).sort();
  }

  it('reads mixed terminal rows with readiness false and leaves preparing rows unresolved', async () => {
    if (!db) throw new Error('Allocated test database is unavailable.');
    const { fixtures } = await context(false);
    const create = fixtures.createOwnerMemory;
    const terminal = [...fixtures.oldSaved, create.savedRefresh].map((entry) => entry.record);
    track([...terminal.map((record) => record.id), create.expiredPreparing.record.id]);
    await db.insert(ownerEditorOperations).values([...terminal, create.expiredPreparing.record]);
    const before = await snapshotPrimaryState();
    const adapter = storage(db);
    const terminalSnapshot = await adapter.withRecoveryTransaction(
      create.savedRefresh.scope,
      (tx) => tx.readFresh(),
    );
    expect(terminalSnapshot.current.ready).toBe(false);
    expect(terminalSnapshot.operation).toMatchObject({ status: 'committed' });
    const preparing = await adapter.withRecoveryTransaction(create.expiredPreparing.scope, (tx) =>
      tx.readFresh(),
    );
    expect(preparing.operation).toMatchObject({ status: 'preparing' });
    expect(preparing.current.ready).toBe(false);
    expect(await snapshotPrimaryState()).toEqual(before);
  });

  it('abandons the exact expired claim once and returns the same terminal row on replay', async () => {
    if (!db) throw new Error('Allocated test database is unavailable.');
    const { fixtures, now } = await context();
    const fixture = fixtures.createOwnerMemory.expiredPreparing;
    await seed(fixture);
    const before = await snapshotPrimaryState();
    const adapter = storage(db);
    const first = await adapter.withRecoveryTransaction(fixture.scope, (tx) =>
      tx.abandonExpiredOriginal(expectation(fixture, now)),
    );
    expect(first).toMatchObject({
      ownerId,
      operationId: fixture.scope.operationId,
      status: 'abandoned',
      statusVersion: fixture.record.statusVersion + 1,
      claimToken: null,
      result: { outcome: 'not_applied', reason: 'claim_abandoned' },
    });
    const replay = await adapter.withRecoveryTransaction(fixture.scope, (tx) =>
      tx.abandonExpiredOriginal(expectation(fixture, now)),
    );
    expect(replay).toEqual(first);
    expect((await stored(fixture.scope)).statusVersion).toBe(fixture.record.statusVersion + 1);
    expect(await snapshotPrimaryState()).toEqual(before);
  });

  it('serializes two same-operation clients to one terminal version without a retry', async () => {
    if (!db || !process.env.DATABASE_URL)
      throw new Error('Allocated test database is unavailable.');
    const { fixtures, now } = await context();
    const fixture = fixtures.createOwnerMemory.expiredPreparing;
    await seed(fixture);
    const secondDb = createDb(process.env.DATABASE_URL, { max: 2, statementTimeoutMs: 15_000 });
    try {
      const expectationValue = expectation(fixture, now);
      const [left, right] = await Promise.all([
        storage(db).withRecoveryTransaction(fixture.scope, (tx) =>
          tx.abandonExpiredOriginal(expectationValue),
        ),
        storage(secondDb).withRecoveryTransaction(fixture.scope, (tx) =>
          tx.abandonExpiredOriginal(expectationValue),
        ),
      ]);
      expect(left).toMatchObject({ status: 'abandoned', statusVersion: 2 });
      expect(right).toEqual(left);
      expect((await stored(fixture.scope)).statusVersion).toBe(2);
    } finally {
      await secondDb.$client.end({ timeout: 5 });
    }
  });

  it('rolls back the terminal transition when the surrounding transaction fails', async () => {
    if (!db) throw new Error('Allocated test database is unavailable.');
    const { fixtures, now } = await context();
    const fixture = fixtures.createOwnerMemory.expiredPreparing;
    await seed(fixture);
    await expect(
      storage(db).withRecoveryTransaction(fixture.scope, async (tx) => {
        await tx.abandonExpiredOriginal(expectation(fixture, now));
        throw new Error('rollback after adapter result');
      }),
    ).rejects.toThrow('rollback after adapter result');
    expect(await stored(fixture.scope)).toMatchObject({
      status: 'preparing',
      statusVersion: fixture.record.statusVersion,
      claimToken: fixture.record.claimToken,
    });
  });

  it('uses database time after the operation-row lock when proof expires while waiting', async () => {
    if (!db || !process.env.DATABASE_URL)
      throw new Error('Allocated test database is unavailable.');
    const { fixtures } = await context();
    const fixture = fixtures.createOwnerMemory.expiredPreparing;
    await seed(fixture);
    const blocker = createDb(process.env.DATABASE_URL, { max: 2, statementTimeoutMs: 15_000 });
    let releaseLock = () => {};
    let signalLocked = () => {};
    const lockedSignal = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const lockRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = blocker.transaction(async (tx) => {
      await tx
        .select({ id: ownerEditorOperations.id })
        .from(ownerEditorOperations)
        .where(eq(ownerEditorOperations.id, fixture.record.id))
        .for('update');
      signalLocked();
      await lockRelease;
    });
    let attempt: Promise<unknown> | undefined;
    try {
      await lockedSignal;
      const beforeWait = await databaseNow(db);
      const proofExpiry = new Date(beforeWait.getTime() + 1_300);
      const expected = expectation(fixture, beforeWait, { proofExpiresAt: proofExpiry });
      attempt = storage(db).withRecoveryTransaction(fixture.scope, (tx) =>
        tx.abandonExpiredOriginal(expected),
      );
      await waitForRecoveryLockWait(db);
      let dbNow = await databaseNow(db);
      const waitDeadline = performance.now() + 2_000;
      while (dbNow.getTime() <= proofExpiry.getTime() + 20 && performance.now() < waitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        dbNow = await databaseNow(db);
      }
      expect(dbNow.getTime()).toBeGreaterThan(proofExpiry.getTime());
      releaseLock();
      await holder;
      const afterDeadline = await attempt;
      expect(afterDeadline).toMatchObject({ status: 'preparing' });
      expect(await stored(fixture.scope)).toMatchObject({ status: 'preparing', statusVersion: 1 });
    } finally {
      releaseLock();
      try {
        await holder;
        if (attempt) await attempt.catch(() => undefined);
      } finally {
        await blocker.$client.end({ timeout: 5 });
      }
    }
  });

  it('propagates a cancelled lock wait without retrying or changing the original row', async () => {
    if (!db || !process.env.DATABASE_URL)
      throw new Error('Allocated test database is unavailable.');
    const { fixtures, now } = await context();
    const fixture = fixtures.createOwnerMemory.expiredPreparing;
    await seed(fixture);
    const blocker = createDb(process.env.DATABASE_URL, { max: 2, statementTimeoutMs: 15_000 });
    let releaseLock = () => {};
    let signalLocked = () => {};
    const lockedSignal = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const lockRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = blocker.transaction(async (tx) => {
      await tx
        .select({ id: ownerEditorOperations.id })
        .from(ownerEditorOperations)
        .where(eq(ownerEditorOperations.id, fixture.record.id))
        .for('update');
      signalLocked();
      await lockRelease;
    });
    let attempt: Promise<unknown> | undefined;
    let authorizeCalls = 0;
    try {
      await lockedSignal;
      attempt = storage(db, {
        authorize: async () => {
          authorizeCalls += 1;
          return true;
        },
      }).withRecoveryTransaction(fixture.scope, (tx) =>
        tx.abandonExpiredOriginal(expectation(fixture, now)),
      );
      const waitingPid = await waitForRecoveryLockWait(db);
      const cancelled = await db.$client<{ cancelled: boolean }[]>`
        select pg_cancel_backend(${waitingPid}) as cancelled
      `;
      expect(cancelled[0]?.cancelled).toBe(true);
      await expect(attempt).rejects.toThrow();
      expect(authorizeCalls).toBe(1);
    } finally {
      releaseLock();
      try {
        await holder;
        if (attempt) await attempt.catch(() => undefined);
      } finally {
        await blocker.$client.end({ timeout: 5 });
      }
    }
    expect(await stored(fixture.scope)).toMatchObject({
      status: 'preparing',
      statusVersion: 1,
      claimToken: fixture.record.claimToken,
    });
  });

  it('refuses changed scope, claim, or request hash without adopting another operation', async () => {
    if (!db) throw new Error('Allocated test database is unavailable.');
    const { fixtures, now } = await context();
    const fixture = fixtures.createOwnerMemory.expiredPreparing;
    await seed(fixture);
    const adapter = storage(db);
    const changedScope = {
      ...expectation(fixture, now),
      scope: { ...fixture.scope, nonce: randomUUID() },
    };
    expect(
      await adapter.withRecoveryTransaction(fixture.scope, (tx) =>
        tx.abandonExpiredOriginal(changedScope),
      ),
    ).toBeNull();
    expect(
      await adapter.withRecoveryTransaction(fixture.scope, (tx) =>
        tx.abandonExpiredOriginal({ ...expectation(fixture, now), requestHash: 'd'.repeat(64) }),
      ),
    ).toMatchObject({ status: 'preparing', requestHash: fixture.record.requestHash });
    expect(
      await adapter.withRecoveryTransaction(fixture.scope, (tx) =>
        tx.abandonExpiredOriginal({ ...expectation(fixture, now), claimToken: randomUUID() }),
      ),
    ).toMatchObject({ status: 'preparing', claimToken: fixture.record.claimToken });
    expect(await stored(fixture.scope)).toMatchObject({ status: 'preparing', statusVersion: 1 });
  });

  it('refuses readiness, epoch, and privacy changes before any terminal disclosure or CAS', async () => {
    if (!db) throw new Error('Allocated test database is unavailable.');
    const { epoch, fixtures, now } = await context();
    const fixture = fixtures.createOwnerMemory.expiredPreparing;
    await seed(fixture);
    const setEpoch = async (value: string, ready: boolean) => {
      const cursor = JSON.stringify({
        ownerId,
        epoch: value,
        ready,
        privacyGenerationDigest: ownerEditorPrivacyDigest(privacyGeneration),
      });
      await db
        ?.update(maintenanceCursors)
        .set({ cursor, updatedAt: new Date() })
        .where(eq(maintenanceCursors.name, epochName(ownerId)));
    };
    await setEpoch(epoch, false);
    expect(
      await storage(db).withRecoveryTransaction(fixture.scope, (tx) =>
        tx.abandonExpiredOriginal(expectation(fixture, now)),
      ),
    ).toBeNull();
    await setEpoch(randomUUID(), true);
    expect(
      await storage(db).withRecoveryTransaction(fixture.scope, (tx) =>
        tx.abandonExpiredOriginal(expectation(fixture, now)),
      ),
    ).toBeNull();
    await setEpoch(epoch, true);

    const changedGeneration = randomUUID();
    const changedEpochCursor = JSON.stringify({
      ownerId,
      epoch,
      ready: true,
      privacyGenerationDigest: ownerEditorPrivacyDigest(changedGeneration),
    });
    await db
      .insert(maintenanceCursors)
      .values({ name: generationName(ownerId), cursor: changedGeneration })
      .onConflictDoUpdate({
        target: maintenanceCursors.name,
        set: { cursor: changedGeneration, updatedAt: new Date() },
      });
    await db
      .update(maintenanceCursors)
      .set({ cursor: changedEpochCursor, updatedAt: new Date() })
      .where(eq(maintenanceCursors.name, epochName(ownerId)));
    try {
      expect(
        await storage(db).withRecoveryTransaction(fixture.scope, (tx) =>
          tx.abandonExpiredOriginal(expectation(fixture, now)),
        ),
      ).toBeNull();
    } finally {
      await db
        .update(maintenanceCursors)
        .set({
          cursor: JSON.stringify({
            ownerId,
            epoch,
            ready: true,
            privacyGenerationDigest: ownerEditorPrivacyDigest(privacyGeneration),
          }),
          updatedAt: new Date(),
        })
        .where(eq(maintenanceCursors.name, epochName(ownerId)));
      if (priorGeneration)
        await db
          .update(maintenanceCursors)
          .set(priorGeneration)
          .where(eq(maintenanceCursors.name, generationName(ownerId)));
      else
        await db
          .delete(maintenanceCursors)
          .where(eq(maintenanceCursors.name, generationName(ownerId)));
    }
    expect(await stored(fixture.scope)).toMatchObject({ status: 'preparing', statusVersion: 1 });
  });

  it('leaves live claims and expired proof or replay deadlines unresolved', async () => {
    if (!db) throw new Error('Allocated test database is unavailable.');
    const { fixtures, now } = await context();
    const live = fixtures.createOwnerMemory.preparing;
    const expired = fixtures.createOwnerMemory.expiredPreparing;
    await seed(live, expired);
    const adapter = storage(db);
    expect(
      await adapter.withRecoveryTransaction(live.scope, (tx) =>
        tx.abandonExpiredOriginal(expectation(live, now)),
      ),
    ).toMatchObject({ status: 'preparing', statusVersion: 1 });
    expect(
      await adapter.withRecoveryTransaction(expired.scope, (tx) =>
        tx.abandonExpiredOriginal(
          expectation(expired, now, { proofExpiresAt: new Date(now.getTime()) }),
        ),
      ),
    ).toBeNull();
    expect(
      await adapter.withRecoveryTransaction(expired.scope, (tx) =>
        tx.abandonExpiredOriginal(
          expectation(expired, now, { replayExpiresAt: new Date(now.getTime()) }),
        ),
      ),
    ).toBeNull();
    expect((await stored(live.scope)).status).toBe('preparing');
    expect((await stored(expired.scope)).status).toBe('preparing');
  });

  it('blocks the CAS through the real source-fenced Drizzle database wrapper', async () => {
    if (!db || !process.env.DATABASE_URL)
      throw new Error('Allocated test database is unavailable.');
    const { fixtures, now } = await context();
    const fixture = fixtures.createOwnerMemory.expiredPreparing;
    await seed(fixture);
    fencedDb = createDb(process.env.DATABASE_URL, {
      max: 2,
      statementTimeoutMs: 15_000,
      sourceWritesFenced: true,
    });
    // Deliberately pass clear test flags: this directly proves the actual DB
    // wrapper still denies a source write if an upstream caller is miswired.
    await expect(
      storage(fencedDb).withRecoveryTransaction(fixture.scope, (tx) =>
        tx.abandonExpiredOriginal(expectation(fixture, now)),
      ),
    ).rejects.toThrow(/fenced/i);
    expect(await stored(fixture.scope)).toMatchObject({ status: 'preparing', statusVersion: 1 });
  });
});
