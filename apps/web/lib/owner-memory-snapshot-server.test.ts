import { beforeEach, describe, expect, it, vi } from 'vitest';

const readerState = vi.hoisted(() => ({
  config: {
    DATABASE_URL: 'postgres://fixture/assistant',
    DB_POOL_MAX: 1,
    DB_IDLE_TIMEOUT_SECONDS: 1,
    DB_CONNECT_TIMEOUT_SECONDS: 1,
    DB_STATEMENT_TIMEOUT_MS: 1000,
    POSTGRES_SOURCE_WRITES_FENCED: false,
    RESTORE_REHEARSAL: false,
    PERSISTENCE_DRIVER: 'postgres',
    FIRESTORE_AGENT_ID: '11111111-1111-4111-8111-111111111111',
    GCP_PROJECT: 'fixture-project',
    ASSISTANT_WORKSPACE_ID: 'fixture-installation',
    FIRESTORE_DATABASE_ID: '(default)',
  },
  postgresOwner: vi.fn(),
  privacyFence: vi.fn(),
  createDb: vi.fn(),
  postgresRead: vi.fn(),
  postgresContext: vi.fn(),
  firestoreRead: vi.fn(),
  firestoreContext: vi.fn(),
  createStore: vi.fn(),
  validatePersistence: vi.fn(),
  pgRoot: { kind: 'postgres-root' },
  pgLease: { kind: 'postgres-lease' },
  firestoreTx: { kind: 'firestore-transaction' },
  firestoreStore: { db: { runTransaction: vi.fn() } },
}));

vi.mock('@assistant/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/config')>()),
  loadConfig: () => readerState.config,
  validateAgentPersistenceConfig: readerState.validatePersistence,
}));
vi.mock('@assistant/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/db')>()),
  assertPostgresInstallationOwner: readerState.postgresOwner,
  withPostgresPrivacyObservationFence: readerState.privacyFence,
  createDb: readerState.createDb,
  readPostgresOwnerMemoryEditorSnapshot: readerState.postgresRead,
  readPostgresOwnerEditorIssuanceContext: readerState.postgresContext,
}));
vi.mock('@assistant/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/firestore')>()),
  createInstallationStore: readerState.createStore,
  readFirestoreOwnerMemoryEditorSnapshot: readerState.firestoreRead,
  readFirestoreOwnerEditorIssuanceContext: readerState.firestoreContext,
}));

import { loadOwnerMemorySnapshot } from './server';

const ownerId = '11111111-1111-4111-8111-111111111111';
const memoryId = '22222222-2222-4222-8222-222222222222';
const snapshot = {
  memoryId,
  ownerId,
  content: 'Saved note',
  contentHash: 'a'.repeat(64),
  revision: 'b'.repeat(64),
  ownerCorrection: null,
  sourceLabel: 'Saved manual note',
  eligible: true,
};

beforeEach(() => {
  readerState.config.PERSISTENCE_DRIVER = 'postgres';
  readerState.config.FIRESTORE_AGENT_ID = ownerId;
  readerState.postgresOwner.mockReset().mockResolvedValue(ownerId);
  readerState.privacyFence
    .mockReset()
    .mockImplementation(async (_db, _owner, read) => read(readerState.pgLease));
  readerState.createDb.mockReset().mockReturnValue(readerState.pgRoot);
  readerState.postgresRead.mockReset().mockResolvedValue(snapshot);
  readerState.postgresContext.mockReset().mockResolvedValue(null);
  readerState.firestoreRead.mockReset().mockResolvedValue(snapshot);
  readerState.firestoreContext.mockReset().mockResolvedValue(null);
  readerState.createStore.mockReset().mockReturnValue(readerState.firestoreStore);
  readerState.validatePersistence.mockReset().mockReturnValue([]);
  readerState.firestoreStore.db.runTransaction
    .mockReset()
    .mockImplementation((read) => read(readerState.firestoreTx));
  const globalCache = globalThis as typeof globalThis & {
    __assistantDb?: unknown;
    __assistantFirestoreStore?: unknown;
  };
  delete globalCache.__assistantDb;
  delete globalCache.__assistantFirestoreStore;
});

describe('no-grant exact saved-note server reader', () => {
  it('uses the leased Postgres privacy browse read and binds it to the resolved owner', async () => {
    const result = await loadOwnerMemorySnapshot(ownerId, memoryId);

    expect(readerState.privacyFence).toHaveBeenCalledWith(
      readerState.pgRoot,
      ownerId,
      expect.any(Function),
    );
    expect(readerState.postgresOwner).toHaveBeenNthCalledWith(1, readerState.pgRoot);
    expect(readerState.postgresOwner).toHaveBeenNthCalledWith(2, readerState.pgLease, ownerId);
    expect(readerState.postgresOwner).toHaveBeenNthCalledWith(3, readerState.pgLease);
    expect(readerState.postgresOwner).toHaveBeenNthCalledWith(4, readerState.pgLease, ownerId);
    expect(readerState.postgresRead).toHaveBeenCalledWith(readerState.pgLease, ownerId, memoryId);
    expect(result).toEqual(snapshot);
    expect(readerState.postgresContext).not.toHaveBeenCalled();
  });

  it('fails unavailable on a Postgres owner change inside the leased read before querying the target', async () => {
    readerState.postgresOwner
      .mockResolvedValueOnce(ownerId)
      .mockResolvedValueOnce(ownerId)
      .mockResolvedValueOnce('33333333-3333-4333-8333-333333333333');

    await expect(loadOwnerMemorySnapshot(ownerId, memoryId)).rejects.toThrow(
      'Installation owner changed',
    );
    expect(readerState.postgresRead).not.toHaveBeenCalled();
  });

  it('reads Firestore inside one transaction with the exact validated installation owner', async () => {
    readerState.config.PERSISTENCE_DRIVER = 'firestore';

    const result = await loadOwnerMemorySnapshot(ownerId, memoryId);

    expect(readerState.validatePersistence).toHaveBeenCalled();
    expect(readerState.createStore).toHaveBeenCalled();
    expect(readerState.firestoreStore.db.runTransaction).toHaveBeenCalledTimes(1);
    expect(readerState.firestoreRead).toHaveBeenCalledWith(
      readerState.firestoreStore,
      ownerId,
      memoryId,
      readerState.firestoreTx,
    );
    expect(readerState.firestoreContext).not.toHaveBeenCalled();
    expect(result).toEqual(snapshot);
  });

  it('fails unavailable on Firestore owner mismatch before opening a transaction', async () => {
    readerState.config.PERSISTENCE_DRIVER = 'firestore';
    readerState.config.FIRESTORE_AGENT_ID = '33333333-3333-4333-8333-333333333333';

    await expect(loadOwnerMemorySnapshot(ownerId, memoryId)).rejects.toThrow(
      'Memory persistence is unavailable',
    );
    expect(readerState.firestoreStore.db.runTransaction).not.toHaveBeenCalled();
    expect(readerState.firestoreRead).not.toHaveBeenCalled();
  });
});
