import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Db = ReturnType<typeof import('./server').getDb>;

const ports = vi.hoisted(() => {
  const config = {
    PERSISTENCE_DRIVER: 'postgres' as const,
    DATABASE_URL: 'postgres://guard:guard@127.0.0.1:1/memory_browse_guard_test',
    DB_POOL_MAX: 1,
    DB_IDLE_TIMEOUT_SECONDS: 1,
    DB_CONNECT_TIMEOUT_SECONDS: 1,
    DB_STATEMENT_TIMEOUT_MS: 100,
    POSTGRES_SOURCE_WRITES_FENCED: false,
    RESTORE_REHEARSAL: false,
  };
  return {
    config,
    db: Object.freeze({ syntheticConfiguredDatabase: true }) as unknown as Db,
    tx: Object.freeze({ syntheticTransaction: true }) as unknown as Db,
    ownerId: '11111111-1111-4111-8111-111111111111',
    events: [] as string[],
    insideFence: false,
    createDb: vi.fn<(...args: unknown[]) => Db>(),
    owner: vi.fn<(db: Db, expectedAgentId?: string) => Promise<string>>(),
    fence:
      vi.fn<(db: Db, ownerId: string, read: (tx: Db) => Promise<unknown>) => Promise<unknown>>(),
    loadConfig: vi.fn(() => config),
    restoreProblems: vi.fn(() => [] as string[]),
  };
});

// Only these database ports are replaced. The composition under test is the
// real server export, not a copied guard or a mocked server module.
vi.mock('@assistant/db', async (original) => ({
  ...(await original<typeof import('@assistant/db')>()),
  createDb: ports.createDb,
  assertPostgresInstallationOwner: ports.owner,
  withPostgresPrivacyObservationFence: ports.fence,
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

const cache = globalThis as typeof globalThis & { __assistantDb?: Db };
let previousDb: PropertyDescriptor | undefined;
let isolatedCache = false;

beforeEach(() => {
  previousDb = Object.getOwnPropertyDescriptor(cache, '__assistantDb');
  isolatedCache = false;
  if (previousDb && !previousDb.configurable)
    throw new Error('Cannot isolate a non-configurable pre-existing database cache');
  delete cache.__assistantDb;
  isolatedCache = true;
  vi.resetAllMocks();
  ports.events.length = 0;
  ports.insideFence = false;
  ports.loadConfig.mockReturnValue(ports.config);
  ports.restoreProblems.mockReturnValue([]);
  ports.createDb.mockImplementation(() => {
    ports.events.push('createDb');
    return ports.db;
  });
  ports.owner.mockResolvedValue(ports.ownerId);
  ports.fence.mockImplementation(async (_db, _ownerId, read) => {
    ports.events.push('fence:enter');
    ports.insideFence = true;
    try {
      return await read(ports.tx);
    } finally {
      ports.insideFence = false;
      ports.events.push('fence:exit');
    }
  });
});

afterEach(() => {
  if (!isolatedCache) return;
  if (previousDb) Object.defineProperty(cache, '__assistantDb', previousDb);
  else delete cache.__assistantDb;
  isolatedCache = false;
});

describe('actual PostgreSQL memory browse composition with isolated database ports', () => {
  it('uses the configured DB and brackets the callback with owner checks inside the fence', async () => {
    ports.owner.mockImplementation(async (db, expectedOwner) => {
      expect(db).toBe(expectedOwner === undefined ? ports.db : ports.tx);
      expect(ports.insideFence).toBe(expectedOwner !== undefined);
      ports.events.push(expectedOwner === undefined ? 'owner:discover' : 'owner:recheck');
      return ports.ownerId;
    });
    const result = Object.freeze({ content: 'synthetic saved note' });
    const read = vi.fn(async (db: Db) => {
      expect(db).toBe(ports.tx);
      expect(ports.insideFence).toBe(true);
      ports.events.push('read');
      return result;
    });

    expect(await withPostgresMemoryBrowseRead(read)).toBe(result);
    expect(ports.createDb).toHaveBeenCalledTimes(1);
    expect(ports.createDb).toHaveBeenCalledWith(ports.config.DATABASE_URL, {
      max: 1,
      idleTimeoutSeconds: 1,
      connectTimeoutSeconds: 1,
      statementTimeoutMs: 100,
      sourceWritesFenced: false,
      readOnly: false,
    });
    expect(ports.fence).toHaveBeenCalledTimes(1);
    expect(ports.fence).toHaveBeenCalledWith(ports.db, ports.ownerId, expect.any(Function));
    expect(ports.owner.mock.calls).toEqual([
      [ports.db],
      [ports.tx, ports.ownerId],
      [ports.tx, ports.ownerId],
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(ports.tx);
    expect(ports.events).toEqual([
      'createDb',
      'owner:discover',
      'fence:enter',
      'owner:recheck',
      'read',
      'owner:recheck',
      'fence:exit',
    ]);
  });

  it.each(['wrong configured owner', 'duplicate installation owners'])(
    'propagates initial owner-port rejection for %s without entering the fence or callback',
    async (reason) => {
      const error = new Error(reason);
      ports.owner.mockRejectedValueOnce(error);
      const read = vi.fn(async () => 'must not be read');

      await expect(withPostgresMemoryBrowseRead(read)).rejects.toBe(error);
      expect(ports.owner).toHaveBeenCalledTimes(1);
      expect(ports.owner).toHaveBeenCalledWith(ports.db);
      expect(ports.fence).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('does not invoke the callback when the erasure-fence port rejects before observation', async () => {
    const error = new Error('Privacy erasure is in progress');
    ports.fence.mockRejectedValueOnce(error);
    const read = vi.fn(async () => 'must not be read');

    await expect(withPostgresMemoryBrowseRead(read)).rejects.toBe(error);
    expect(ports.owner).toHaveBeenCalledTimes(1);
    expect(ports.owner).toHaveBeenCalledWith(ports.db);
    expect(ports.fence).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects an owner change after the callback without publishing its result', async () => {
    const error = new Error('Configured installation owner changed');
    ports.owner
      .mockResolvedValueOnce(ports.ownerId)
      .mockResolvedValueOnce(ports.ownerId)
      .mockRejectedValueOnce(error);
    const read = vi.fn(async (db: Db) => {
      expect(db).toBe(ports.tx);
      expect(ports.insideFence).toBe(true);
      return { content: 'must not be published' };
    });
    let published = false;
    const result = withPostgresMemoryBrowseRead(read).then((value) => {
      published = true;
      return value;
    });

    await expect(result).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(ports.tx);
    expect(ports.owner.mock.calls).toEqual([
      [ports.db],
      [ports.tx, ports.ownerId],
      [ports.tx, ports.ownerId],
    ]);
    expect(published).toBe(false);
    expect(ports.insideFence).toBe(false);
  });

  it('propagates callback errors instead of returning empty or fallback data', async () => {
    const error = new Error('Synthetic retained-read failure');
    const read = vi.fn(async () => {
      throw error;
    });

    await expect(withPostgresMemoryBrowseRead(read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(ports.tx);
    expect(ports.owner.mock.calls).toEqual([[ports.db], [ports.tx, ports.ownerId]]);
    expect(ports.insideFence).toBe(false);
    expect(ports.events).toEqual(['createDb', 'fence:enter', 'fence:exit']);
  });
});
