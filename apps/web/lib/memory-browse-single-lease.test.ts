import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Db = ReturnType<typeof import('./server').getDb>;
// Explicit test-port access keeps production persistence imports in server.ts.
// These are the real schemas and fence; only connection creation is replaced.
const { agents, maintenanceCursors, memories, withPostgresPrivacyObservationFence } =
  await vi.importActual<typeof import('@assistant/db')>('@assistant/db');

const ports = vi.hoisted(() => ({
  db: undefined as unknown as Db,
  config: {
    PERSISTENCE_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://single-lease/synthetic_test',
    DB_POOL_MAX: 1,
    DB_IDLE_TIMEOUT_SECONDS: 1,
    DB_CONNECT_TIMEOUT_SECONDS: 1,
    DB_STATEMENT_TIMEOUT_MS: 100,
    POSTGRES_SOURCE_WRITES_FENCED: false,
    RESTORE_REHEARSAL: false,
  },
  loadConfig: vi.fn(),
  restoreProblems: vi.fn(() => [] as string[]),
}));
vi.mock('@assistant/db', async (original) => ({
  ...(await original<typeof import('@assistant/db')>()),
  createDb: () => ports.db,
}));
// Avoid loading the real config index's .env file. Other configuration
// operations fail loudly; this guard needs only config and restore validation.
vi.mock('@assistant/config', async () => {
  const unexpected = () => {
    throw new Error('Unexpected configuration operation in memory browse guard test');
  };
  return {
    ...(await import('@assistant/config/modules')),
    repoRoot: '/synthetic-memory-browse-guard',
    envFile: '/synthetic-memory-browse-guard/.env',
    configKeyNames: [],
    FIRESTORE_PORTABLE_MODULES: [],
    loadConfig: ports.loadConfig,
    validateRestoreRehearsalConfig: ports.restoreProblems,
    parseFirestoreEmbeddingSpace: unexpected,
    modelProviderConfigProblems: unexpected,
    validateAgentPersistenceConfig: unexpected,
    validateProdConfig: unexpected,
    outboundEmailDomains: unexpected,
    outboundEmailAllowed: unexpected,
    reloadConfig: unexpected,
    resetConfigForTest: unexpected,
  };
});

import { withPostgresMemoryBrowseRead } from '@/lib/server';

function singleLeaseDatabase() {
  const owner = '11111111-1111-4111-8111-111111111111';
  const state = {
    leased: false,
    outerReads: 0,
    txReads: 0,
    locks: [] as string[],
    fenceReads: 0,
    ownerReads: 0,
    active: false,
    changed: false,
    ownerChanged: false,
    released: 0,
  };
  function select(inTransaction: boolean) {
    if (state.leased && !inTransaction)
      throw new Error('Single connection is leased: outer-pool query would deadlock');
    if (inTransaction && !state.leased) throw new Error('Transaction lease is not active');
    if (inTransaction) state.txReads++;
    else state.outerReads++;
    let table: unknown;
    const query = {
      from(value: unknown) {
        table = value;
        return query;
      },
      where() {
        return query;
      },
      limit() {
        return query;
      },
      for(mode: string) {
        state.locks.push(mode);
        return query;
      },
      // biome-ignore lint/suspicious/noThenProperty: The lease fake preserves Drizzle's awaitable query contract.
      then(resolve: (rows: unknown[]) => unknown, reject: (reason: unknown) => unknown) {
        let rows: unknown[] = [];
        if (table === agents) {
          state.ownerReads++;
          rows = [{ id: state.ownerChanged && state.ownerReads >= 4 ? 'foreign-owner' : owner }];
        } else if (table === maintenanceCursors) {
          state.fenceReads++;
          rows = state.active
            ? [{ name: `privacy-erasure-active:${owner}`, cursor: 'active' }]
            : [
                {
                  name: `privacy-erasure-generation:${owner}`,
                  cursor:
                    state.changed && state.fenceReads > 1
                      ? 'generation-new'
                      : 'generation-original',
                },
              ];
        } else if (table !== memories) throw new Error('Unexpected retained read table');
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return query;
  }
  const tx = { select: () => select(true) };
  const db = {
    select: () => select(false),
    async transaction<T>(read: (handle: typeof tx) => Promise<T>) {
      if (state.leased) throw new Error('Nested outer lease acquisition');
      state.leased = true;
      try {
        return await read(tx);
      } finally {
        state.leased = false;
        state.released++;
      }
    },
  } as unknown as Db;
  return { db, tx, owner, state };
}
const cache = globalThis as typeof globalThis & { __assistantDb?: Db };
let previous: PropertyDescriptor | undefined;
beforeEach(() => {
  previous = Object.getOwnPropertyDescriptor(cache, '__assistantDb');
  if (previous && !previous.configurable) throw new Error('Cannot isolate DB cache');
  delete cache.__assistantDb;
  ports.loadConfig.mockReturnValue(ports.config);
});
afterEach(() => {
  if (previous) Object.defineProperty(cache, '__assistantDb', previous);
  else delete cache.__assistantDb;
});

describe('actual browse composition and actual privacy fence on one leased connection', () => {
  it('executes owner checks and retained query on the distinct leased handle', async () => {
    const f = singleLeaseDatabase();
    ports.db = f.db;
    const read = vi.fn(async (db: Db) => {
      expect(db).toBe(f.tx);
      expect(() => f.db.select()).toThrow('outer-pool query would deadlock');
      return db.select().from(memories);
    });
    expect(await withPostgresMemoryBrowseRead(read)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(f.state.outerReads).toBe(1);
    expect(f.state.ownerReads).toBe(4);
    expect(f.state.fenceReads).toBe(2);
    expect(f.state.locks).toEqual(['no key update']);
    expect(f.state.released).toBe(1);
    expect(f.state.leased).toBe(false);
  });
  it.each(['active', 'generation', 'owner', 'callback'] as const)(
    'retains %s failure and releases the lease without publishing',
    async (failure) => {
      const f = singleLeaseDatabase();
      ports.db = f.db;
      f.state.active = failure === 'active';
      f.state.changed = failure === 'generation';
      f.state.ownerChanged = failure === 'owner';
      const read = vi.fn(async (db: Db) => {
        expect(db).toBe(f.tx);
        if (failure === 'callback') throw new Error('retained query failed');
        return db.select().from(memories);
      });
      await expect(withPostgresMemoryBrowseRead(read)).rejects.toThrow(
        failure === 'active'
          ? 'Privacy erasure is in progress'
          : failure === 'generation'
            ? 'Privacy erasure changed during observation'
            : failure === 'owner'
              ? 'exactly one owner'
              : 'retained query failed',
      );
      expect(read).toHaveBeenCalledTimes(failure === 'active' ? 0 : 1);
      expect(f.state.outerReads).toBe(1);
      expect(f.state.released).toBe(1);
      expect(f.state.leased).toBe(false);
    },
  );
  it('keeps the fence API compatible with zero-argument callbacks', async () => {
    const f = singleLeaseDatabase();
    expect(await withPostgresPrivacyObservationFence(f.db, f.owner, async () => 'metadata')).toBe(
      'metadata',
    );
    expect(f.state.fenceReads).toBe(2);
    expect(f.state.released).toBe(1);
  });
});
