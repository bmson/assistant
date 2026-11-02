import {
  type OwnerEditorRecoveryMaintenanceState,
  type OwnerEditorScope,
  type OwnerEditorSessionView,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  parseOwnerEditorOperationRecord,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { readerFixtures } from '../../persistence/src/owner-editor-reader-fixtures.test-support.js';
import { createFirestoreOwnerEditorRecoveryStorage } from './owner-editor-recovery.js';
import { ownerEditorTestStore } from './owner-editor-test-store.js';
import { decodeRecord } from './store.js';

const ownerId = '10000000-0000-4000-8000-000000000001';
const epochId = '20000000-0000-4000-8000-000000000002';
const maintenance: OwnerEditorRecoveryMaintenanceState = {
  driver: 'firestore',
  releaseWritesPaused: false,
  restoreRehearsal: false,
  postgresSourceWritesFenced: false,
};

function fixture() {
  const fake = ownerEditorTestStore();
  const now = fake.store.now();
  const session: OwnerEditorSessionView = {
    ownerId,
    formSessionScope: 'recovery-storage-session-0123456789',
  };
  const reader = readerFixtures({ ownerId, epoch: epochId, now, privacyGeneration: null });
  const item = reader.createOwnerMemory.expiredPreparing;
  const claimToken = item.record.claimToken;
  const claimExpiresAt = item.record.claimExpiresAt;
  if (!claimToken || !claimExpiresAt) throw new Error('Expired preparing fixture lacks its claim');
  const epochName = `owner-editor-epoch:${ownerId}`;
  fake.seed('agents', ownerId, { id: ownerId });
  fake.seed('maintenanceCursors', epochName, {
    name: epochName,
    cursor: JSON.stringify({
      ownerId,
      epoch: epochId,
      ready: true,
      privacyGenerationDigest: ownerEditorPrivacyDigest(null),
    }),
  });
  fake.seed(
    'ownerEditorOperations',
    item.record.id,
    item.record as unknown as Record<string, unknown>,
  );

  let clock = now;
  let currentMaintenance: unknown = maintenance;
  const readMaintenance = vi.fn(async () => currentMaintenance);
  const authorize = vi.fn(
    async (scope: OwnerEditorScope, expectedSession?: OwnerEditorSessionView) =>
      scope.ownerId === ownerId &&
      scope.operationId === item.scope.operationId &&
      (!expectedSession ||
        (expectedSession.ownerId === ownerId &&
          expectedSession.formSessionScope === session.formSessionScope)),
  );
  const storage = createFirestoreOwnerEditorRecoveryStorage(fake.store, {
    readMaintenance,
    authorize,
    now: () => clock,
  });
  const expected = {
    scope: item.scope,
    session,
    requestHash: item.record.requestHash,
    claimToken,
    claimExpiresAt: new Date(claimExpiresAt),
    statusVersion: item.record.statusVersion,
    now: new Date(now),
    proofExpiresAt: new Date(now.getTime() + 120_000),
    replayExpiresAt: new Date(item.scope.issuedAt + 24 * 60 * 60_000),
    maintenance,
  };

  return {
    fake,
    now,
    clock,
    setClock(value: Date) {
      clock = value;
    },
    setMaintenance(value: unknown) {
      currentMaintenance = value;
    },
    item,
    session,
    storage,
    authorize,
    readMaintenance,
    expected,
    async readFresh() {
      return storage.withRecoveryTransaction(item.scope, (transaction) => transaction.readFresh());
    },
    async abandon(changes: Partial<typeof expected> = {}) {
      return storage.withRecoveryTransaction(item.scope, async (transaction) => {
        await transaction.readFresh();
        return transaction.abandonExpiredOriginal({ ...expected, ...changes });
      });
    },
    getRecord() {
      const raw = fake.rows('ownerEditorOperations')[0];
      return raw ? parseOwnerEditorOperationRecord(decodeRecord(raw)) : null;
    },
  };
}

describe('Firestore owner-editor recovery storage', () => {
  it('reads one exact owner, epoch, privacy state and journal row using native timestamps', async () => {
    const f = fixture();
    const snapshot = await f.readFresh();
    expect(snapshot.current).toEqual({
      ownerId,
      epoch: epochId,
      privacyGeneration: null,
      ready: true,
    });
    expect(snapshot.maintenance).toEqual(maintenance);
    expect(snapshot.operation).toMatchObject({
      id: ownerEditorOperationId(f.item.scope),
      status: 'preparing',
      requestHash: f.item.record.requestHash,
    });
    expect((snapshot.operation as { formIssuedAt: unknown }).formIssuedAt).toBeInstanceOf(Date);
    expect(f.fake.stats.unboundedQueries).toEqual([]);
    expect(f.fake.stats.writes).toEqual([]);
    expect(f.fake.stats.readsAfterWrites).toBe(0);
  });

  it('updates only the exact expired claim once and preserves Firestore date decoding', async () => {
    const f = fixture();
    const updated = await f.abandon();
    expect(updated).toMatchObject({
      id: ownerEditorOperationId(f.item.scope),
      ownerId,
      operationId: f.item.scope.operationId,
      requestHash: f.item.record.requestHash,
      status: 'abandoned',
      statusVersion: f.item.record.statusVersion + 1,
      claimToken: null,
      claimExpiresAt: null,
      result: { outcome: 'not_applied', reason: 'claim_abandoned' },
    });
    expect((updated as { updatedAt: unknown }).updatedAt).toBeInstanceOf(Date);
    expect(f.getRecord()).toMatchObject({
      status: 'abandoned',
      statusVersion: f.item.record.statusVersion + 1,
    });
    expect(f.fake.stats.writes).toEqual(['ownerEditorOperations']);
    expect(f.fake.stats.readsAfterWrites).toBe(0);
    expect(f.authorize).toHaveBeenCalledWith(f.item.scope, f.session);
  });

  it.each([
    ['wrong request hash', { requestHash: 'f'.repeat(64) }],
    ['wrong claim token', { claimToken: '70000000-0000-4000-8000-000000000009' }],
    ['wrong status version', { statusVersion: 99 }],
    [
      'wrong session owner',
      { session: { ownerId: '30000000-0000-4000-8000-000000000003', formSessionScope: 'other' } },
    ],
    ['claim expiry changed', { claimExpiresAt: new Date('2030-01-01T00:00:00.000Z') }],
    ['proof already expired', { proofExpiresAt: new Date('2000-01-01T00:00:00.000Z') }],
    ['replay deadline changed', { replayExpiresAt: new Date('2030-01-01T00:00:00.000Z') }],
  ] as const)('refuses %s without a journal write', async (_name, changes) => {
    const f = fixture();
    await expect(f.abandon(changes)).resolves.toBeNull();
    expect(f.fake.stats.writes).toEqual([]);
    expect(f.fake.stats.readsAfterWrites).toBe(0);
  });

  it('rechecks readiness, current epoch/privacy and request authorization before update', async () => {
    const f = fixture();
    f.fake.seed('maintenanceCursors', `owner-editor-epoch:${ownerId}`, {
      name: `owner-editor-epoch:${ownerId}`,
      cursor: JSON.stringify({
        ownerId,
        epoch: epochId,
        ready: false,
        privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      }),
    });
    await expect(f.abandon()).resolves.toBeNull();
    expect(f.fake.stats.writes).toEqual([]);

    const denied = fixture();
    denied.authorize.mockImplementation(async (_scope, expectedSession) => !expectedSession);
    await expect(denied.abandon()).resolves.toBeNull();
    expect(denied.fake.stats.writes).toEqual([]);
  });

  it('does not apply the PostgreSQL-only source-write fence to a Firestore driver', async () => {
    const f = fixture();
    const fencedState = { ...maintenance, postgresSourceWritesFenced: true };
    f.setMaintenance(fencedState);
    const updated = await f.storage.withRecoveryTransaction(f.item.scope, async (transaction) => {
      await transaction.readFresh();
      return transaction.abandonExpiredOriginal({ ...f.expected, maintenance: fencedState });
    });
    expect(updated).toMatchObject({ status: 'abandoned' });
    expect(f.fake.stats.writes).toEqual(['ownerEditorOperations']);
  });

  it('rechecks clock and maintenance after authorization immediately before the update', async () => {
    const late = fixture();
    let clockCalls = 0;
    const storage = createFirestoreOwnerEditorRecoveryStorage(late.fake.store, {
      readMaintenance: late.readMaintenance,
      authorize: late.authorize,
      now: () => {
        clockCalls += 1;
        if (clockCalls === 1) return late.now;
        if (clockCalls === 2) return new Date(late.now.getTime() + 119_999);
        return new Date(late.now.getTime() + 120_000);
      },
    });
    const result = await storage.withRecoveryTransaction(late.item.scope, async (transaction) => {
      await transaction.readFresh();
      return transaction.abandonExpiredOriginal(late.expected);
    });
    expect(result).toBeNull();
    expect(clockCalls).toBe(3);
    expect(late.fake.stats.writes).toEqual([]);

    const held = fixture();
    held.readMaintenance
      .mockImplementationOnce(async () => maintenance)
      .mockImplementationOnce(async () => maintenance)
      .mockImplementationOnce(async () => ({ ...maintenance, restoreRehearsal: true }));
    await expect(held.abandon()).resolves.toBeNull();
    expect(held.fake.stats.writes).toEqual([]);
  });

  it('re-reads state, auth and clock after a bounded transaction conflict', async () => {
    const f = fixture();
    const database = f.fake.store.db as unknown as {
      runTransaction<T>(
        run: (tx: unknown) => Promise<T>,
        options?: { maxAttempts?: number },
      ): Promise<T>;
    };
    const original = database.runTransaction.bind(database);
    let callbacks = 0;
    let abortedFirstUpdate = false;
    let seenMaxAttempts: number | undefined;
    database.runTransaction = async (run, options) => {
      seenMaxAttempts = options?.maxAttempts;
      for (;;) {
        try {
          return await original(async (rawTx) => {
            callbacks += 1;
            const tx = rawTx as {
              get: (...args: unknown[]) => Promise<unknown>;
              getAll: (...args: unknown[]) => Promise<unknown[]>;
              update: (...args: unknown[]) => void;
            };
            return run({
              get: (...args: unknown[]) => tx.get(...args),
              getAll: (...args: unknown[]) => tx.getAll(...args),
              update: (...args: unknown[]) => {
                if (!abortedFirstUpdate) {
                  abortedFirstUpdate = true;
                  f.fake.seed('ownerEditorOperations', f.item.record.id, {
                    ...f.item.record,
                    claimToken: '70000000-0000-4000-8000-000000000009',
                    claimExpiresAt: new Date(f.now.getTime() + 60_000),
                    statusVersion: f.item.record.statusVersion + 1,
                    updatedAt: new Date(f.now.getTime() + 1),
                  } as unknown as Record<string, unknown>);
                  throw new Error('synthetic Firestore transaction conflict');
                }
                tx.update(...args);
              },
            });
          }, options);
        } catch (error) {
          if (!abortedFirstUpdate || callbacks < 1) throw error;
          if (f.fake.stats.writes.length) throw error;
          if (callbacks > 1) throw error;
        }
      }
    };
    let clockCalls = 0;
    const storage = createFirestoreOwnerEditorRecoveryStorage(f.fake.store, {
      readMaintenance: f.readMaintenance,
      authorize: f.authorize,
      now: () => {
        clockCalls += 1;
        return new Date(f.now.getTime() + clockCalls);
      },
    });
    const updated = await storage.withRecoveryTransaction(f.item.scope, async (transaction) => {
      await transaction.readFresh();
      return transaction.abandonExpiredOriginal({
        ...f.expected,
        now: new Date(f.now.getTime() + 1),
        proofExpiresAt: new Date(f.now.getTime() + 120_001),
      });
    });
    expect(seenMaxAttempts).toBe(3);
    expect(callbacks).toBe(2);
    expect(clockCalls).toBe(5);
    expect(f.authorize).toHaveBeenCalledTimes(3);
    expect(updated).toBeNull();
    expect(f.getRecord()).toMatchObject({
      claimToken: '70000000-0000-4000-8000-000000000009',
      status: 'preparing',
      statusVersion: f.item.record.statusVersion + 1,
    });
    expect(f.fake.stats.writes).toEqual([]);
    expect(f.fake.stats.readsAfterWrites).toBe(0);
  });

  it('fails closed for malformed or held maintenance state before starting a transaction', async () => {
    for (const state of [
      { ...maintenance, releaseWritesPaused: true },
      { ...maintenance, restoreRehearsal: true },
      { ...maintenance, extra: true },
      { ...maintenance, driver: 'postgres' },
    ]) {
      const f = fixture();
      f.setMaintenance(state);
      await expect(f.readFresh()).rejects.toThrow('Recovery maintenance hold is active');
      expect(f.fake.stats.writes).toEqual([]);
      expect(f.fake.stats.requests).toBe(0);
    }
  });
});
