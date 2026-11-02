import {
  type OwnerEditorExpiredClaimExpectation,
  type OwnerEditorRecoveryMaintenanceState,
  ownerEditorPrivacyDigest,
} from '@assistant/persistence';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { readerFixtures } from '../../persistence/src/owner-editor-reader-fixtures.test-support.js';
import type { Db } from './client.js';
import { createPostgresOwnerEditorRecoveryStorage } from './owner-editor-recovery.js';
import { agents, maintenanceCursors, ownerEditorOperations } from './schema.js';

const ownerId = '40000000-0000-4000-8000-000000000001';
const epoch = '40000000-0000-4000-8000-000000000002';
const now = new Date('2026-11-01T12:00:00.000Z');
const maintenance: OwnerEditorRecoveryMaintenanceState = {
  driver: 'postgres',
  releaseWritesPaused: false,
  restoreRehearsal: false,
  postgresSourceWritesFenced: false,
};

vi.mock('./privacy-erasure-repository.js', () => ({
  lockPostgresPrivacyObservationFence: vi.fn(async () => null),
}));

class Awaitable<T> implements PromiseLike<T> {
  constructor(private readonly get: () => T) {}
  // biome-ignore lint/suspicious/noThenProperty: this test double models Drizzle's lazy thenable.
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(this.get)
      .then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}

interface SelectBuilder extends PromiseLike<unknown[]> {
  from(value: unknown): SelectBuilder;
  where(value: unknown): SelectBuilder;
  limit(value: number): SelectBuilder;
  for(value: string): SelectBuilder;
}

interface UpdateBuilder {
  set(value: Record<string, unknown>): UpdateBuilder;
  where(value: unknown): UpdateBuilder;
  returning(): Promise<unknown[]>;
}

interface FakeDb {
  select(): SelectBuilder;
  update(table: unknown): UpdateBuilder;
  transaction<T>(run: (tx: FakeDb) => Promise<T>): Promise<T>;
}

function fixture() {
  const set = readerFixtures({ ownerId, epoch, now, privacyGeneration: null });
  const original = set.createOwnerMemory.expiredPreparing;
  const state = {
    owner: { id: ownerId },
    cursor: {
      name: `owner-editor-epoch:${ownerId}`,
      cursor: JSON.stringify({
        ownerId,
        epoch,
        ready: true,
        privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      }),
    },
    operation: original.record,
    updateAllowed: true,
    writes: 0,
    updateSql: '',
    updateParams: [] as unknown[],
  };
  const db: FakeDb = {
    select() {
      let table: unknown;
      const q = new Awaitable<unknown[]>(() => {
        if (table === agents) return [state.owner];
        if (table === maintenanceCursors) return [state.cursor];
        if (table === ownerEditorOperations) return state.operation ? [state.operation] : [];
        return [];
      }) as unknown as SelectBuilder;
      q.from = (value) => {
        table = value;
        return q;
      };
      q.where = () => q;
      q.limit = () => q;
      q.for = () => q;
      return q;
    },
    update() {
      let changes: Record<string, unknown> = {};
      let condition: unknown;
      const q: UpdateBuilder = {
        set(value) {
          changes = value;
          return q;
        },
        where(value) {
          condition = value;
          return q;
        },
        async returning() {
          const query = new PgDialect().sqlToQuery(
            condition as Parameters<PgDialect['sqlToQuery']>[0],
          );
          state.updateSql = query.sql;
          state.updateParams = query.params;
          if (!state.updateAllowed || !state.operation) return [];
          state.writes += 1;
          const updated = { ...state.operation, ...changes };
          if (updated.updatedAt && typeof updated.updatedAt === 'object')
            updated.updatedAt = new Date(now);
          state.operation = updated;
          return [state.operation];
        },
      };
      return q;
    },
    async transaction<T>(run: (tx: FakeDb) => Promise<T>) {
      return run(db);
    },
  };
  const claimToken = original.record.claimToken;
  const claimExpiresAt = original.record.claimExpiresAt;
  if (!claimToken || !claimExpiresAt) throw new Error('Fixture must be preparing');
  const expected: OwnerEditorExpiredClaimExpectation = {
    scope: original.scope,
    session: { ownerId, formSessionScope: 'session-scope' },
    requestHash: original.record.requestHash,
    claimToken,
    claimExpiresAt: new Date(claimExpiresAt),
    statusVersion: original.record.statusVersion,
    now,
    proofExpiresAt: new Date(now.getTime() + 60_000),
    replayExpiresAt: new Date(original.scope.issuedAt + 24 * 60 * 60_000),
    maintenance,
  };
  return { db, state, scope: original.scope, expected };
}

function storage(
  db: FakeDb,
  overrides: {
    authorize?: () => Promise<boolean>;
    readMaintenance?: () => Promise<unknown>;
  } = {},
) {
  return createPostgresOwnerEditorRecoveryStorage(db as unknown as Db, {
    authorize: overrides.authorize ?? (async () => true),
    readMaintenance: overrides.readMaintenance ?? (async () => maintenance),
  });
}

describe('PostgreSQL dormant owner-editor recovery storage', () => {
  it('reads terminal receipts while the epoch is not ready without writing', async () => {
    const f = fixture();
    f.state.cursor.cursor = JSON.stringify({
      ownerId,
      epoch,
      ready: false,
      privacyGenerationDigest: ownerEditorPrivacyDigest(null),
    });
    f.state.operation = readerFixtures({
      ownerId,
      epoch,
      now,
      privacyGeneration: null,
    }).createOwnerMemory.savedRefresh.record;
    const result = await storage(f.db).withRecoveryTransaction(f.scope, async (tx) =>
      tx.readFresh(),
    );
    expect(result.current.ready).toBe(false);
    expect(result.operation).toMatchObject({ status: 'committed' });
    expect(f.state.writes).toBe(0);
  });

  it('abandons only the exact expired original row with a database-clock guarded CAS', async () => {
    const f = fixture();
    const result = await storage(f.db).withRecoveryTransaction(f.scope, async (tx) =>
      tx.abandonExpiredOriginal(f.expected),
    );
    expect(result).toMatchObject({
      status: 'abandoned',
      statusVersion: f.expected.statusVersion + 1,
      claimToken: null,
      result: { outcome: 'not_applied', reason: 'claim_abandoned' },
    });
    expect(f.state.writes).toBe(1);
    expect(f.state.updateSql).toContain('clock_timestamp()');
    expect(f.state.updateSql).toContain('claim_expires_at');
    expect(f.state.updateSql).toContain('<=');
    expect(f.state.updateSql).toContain('status_version');
    expect(f.state.updateSql).toContain('request_hash');
    expect(f.state.updateSql).toContain('form_issued_at');
    expect(f.state.updateSql).toContain('form_expires_at');
    expect(f.state.updateSql.match(/clock_timestamp\(\) < \$\d+/g)).toHaveLength(2);
    expect(f.state.updateParams).toContainEqual(f.expected.proofExpiresAt);
    expect(f.state.updateParams).toContainEqual(f.expected.replayExpiresAt);
    for (const column of [
      'id',
      'agent_id',
      'epoch',
      'privacy_generation_digest',
      'operation_id',
      'command',
      'scope_digest',
      'protocol_version',
      'status',
      'claim_token',
    ]) {
      expect(f.state.updateSql).toContain(`"${column}"`);
    }
  });

  it('does not issue a CAS when authorization, configured holds, or caller time bounds fail', async () => {
    const denied = fixture();
    await expect(
      storage(denied.db, { authorize: async () => false }).withRecoveryTransaction(
        denied.scope,
        (tx) => tx.abandonExpiredOriginal(denied.expected),
      ),
    ).rejects.toThrow('authorization');
    expect(denied.state.writes).toBe(0);

    const held = fixture();
    await expect(
      storage(held.db, {
        readMaintenance: async () => ({ ...maintenance, releaseWritesPaused: true }),
      }).withRecoveryTransaction(held.scope, (tx) => tx.abandonExpiredOriginal(held.expected)),
    ).rejects.toThrow('unavailable');
    expect(held.state.writes).toBe(0);

    const expired = fixture();
    expired.expected.proofExpiresAt = new Date(now.getTime());
    const result = await storage(expired.db).withRecoveryTransaction(expired.scope, (tx) =>
      tx.abandonExpiredOriginal(expired.expected),
    );
    expect(result).toBeNull();
    expect(expired.state.writes).toBe(0);

    const lateDenied = fixture();
    let authorizationCalls = 0;
    await expect(
      storage(lateDenied.db, {
        authorize: async () => {
          authorizationCalls += 1;
          return authorizationCalls === 1;
        },
      }).withRecoveryTransaction(lateDenied.scope, (tx) =>
        tx.abandonExpiredOriginal(lateDenied.expected),
      ),
    ).rejects.toThrow('authorization');
    expect(authorizationCalls).toBe(2);
    expect(lateDenied.state.writes).toBe(0);

    const lateHeld = fixture();
    let maintenanceReads = 0;
    await expect(
      storage(lateHeld.db, {
        readMaintenance: async () => {
          maintenanceReads += 1;
          return maintenanceReads === 1
            ? maintenance
            : { ...maintenance, postgresSourceWritesFenced: true };
        },
      }).withRecoveryTransaction(lateHeld.scope, (tx) =>
        tx.abandonExpiredOriginal(lateHeld.expected),
      ),
    ).rejects.toThrow('unavailable');
    expect(maintenanceReads).toBe(2);
    expect(lateHeld.state.writes).toBe(0);
  });

  it('refuses a changed epoch or non-PostgreSQL storage state without CAS or terminal reread', async () => {
    const stale = fixture();
    stale.state.cursor.cursor = JSON.stringify({
      ownerId,
      epoch: '40000000-0000-4000-8000-000000000003',
      ready: true,
      privacyGenerationDigest: ownerEditorPrivacyDigest(null),
    });
    const staleResult = await storage(stale.db).withRecoveryTransaction(stale.scope, (tx) =>
      tx.abandonExpiredOriginal(stale.expected),
    );
    expect(staleResult).toBeNull();
    expect(stale.state.writes).toBe(0);

    const wrongDriver = fixture();
    await expect(
      storage(wrongDriver.db, {
        readMaintenance: async () => ({ ...maintenance, driver: 'firestore' }),
      }).withRecoveryTransaction(wrongDriver.scope, (tx) => tx.readFresh()),
    ).rejects.toThrow('unavailable');
    expect(wrongDriver.state.writes).toBe(0);

    for (const hold of ['releaseWritesPaused', 'restoreRehearsal'] as const) {
      const held = fixture();
      await expect(
        storage(held.db, {
          readMaintenance: async () => ({ ...maintenance, [hold]: true }),
        }).withRecoveryTransaction(held.scope, (tx) => tx.readFresh()),
      ).rejects.toThrow('unavailable');
      expect(held.state.writes).toBe(0);
    }
  });

  it('returns the current exact row after a missed CAS and propagates transaction failures', async () => {
    const raced = fixture();
    raced.state.updateAllowed = false;
    const latest = await storage(raced.db).withRecoveryTransaction(raced.scope, (tx) =>
      tx.abandonExpiredOriginal(raced.expected),
    );
    expect(latest).toMatchObject({ status: 'preparing' });
    expect(raced.state.writes).toBe(0);

    const broken = fixture();
    broken.db.transaction = async () => {
      throw new Error('serialization failure');
    };
    await expect(
      storage(broken.db).withRecoveryTransaction(broken.scope, async () => 'unexpected'),
    ).rejects.toThrow('serialization failure');
  });
});
