import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  validateAgentPersistenceConfig: vi.fn(),
  getStore: vi.fn(),
  readFence: vi.fn(),
  assertFence: vi.fn(),
  profileLibraryQueries: vi.fn(),
  repository: vi.fn(),
}));

vi.mock('@assistant/application', () => ({
  knowledgeGraphCurationCommands: vi.fn(),
  knowledgeWorkspaceQueries: vi.fn(),
  legacyKnowledgeMapDisplayPolicy: vi.fn(),
}));
vi.mock('@assistant/application/profile', () => ({
  profileLibraryQueries: mocks.profileLibraryQueries,
}));
vi.mock('@assistant/config', () => ({
  loadConfig: mocks.loadConfig,
  parseFirestoreEmbeddingSpace: vi.fn(),
  validateAgentPersistenceConfig: mocks.validateAgentPersistenceConfig,
}));
vi.mock('@assistant/firestore', () => ({
  assertPrivacyErasureFenceUnchanged: mocks.assertFence,
  FirestoreKnowledgeGraphCurationRepository: vi.fn(),
  FirestoreKnowledgeWorkspaceReadRepository: vi.fn(),
  FirestoreProfileLibraryRepository: mocks.repository,
  readPrivacyErasureFence: mocks.readFence,
}));
vi.mock('@/lib/server', () => ({
  correctOwnerKnowledgeGraphFactForCurrentPersistence: vi.fn(),
  getFirestoreInstallationStore: mocks.getStore,
}));

import { loadFirestoreMemoryLibrary } from './firestore-knowledge.js';
import type { MemoryLibraryDiagnosticContext } from './memory-library-diagnostics.js';

const context: MemoryLibraryDiagnosticContext = {
  requestId: 'synthetic-server-generated-request-id',
  revision: 'synthetic-revision',
};

function setup(ownerMatches = true) {
  const ownerDoc = {
    id: 'configured-owner',
    get: (field: string) => (field === 'id' ? 'configured-owner' : null),
  };
  const store = {
    collection: vi.fn(() => ({
      limit: () => ({
        get: async () => ({ size: ownerMatches ? 1 : 0, docs: ownerMatches ? [ownerDoc] : [] }),
      }),
    })),
    doc: () => ({ id: 'configured-owner' }),
  };
  const libraryResult = { rows: [], total: 0, page: 1, totalPages: 1 };
  const filtersResult = { subjects: [], sources: [] };
  const list = vi.fn().mockResolvedValue(libraryResult);
  const listFilters = vi.fn().mockResolvedValue(filtersResult);

  mocks.loadConfig.mockReturnValue({
    PERSISTENCE_DRIVER: 'firestore',
    FIRESTORE_AGENT_ID: 'configured-owner',
  });
  mocks.validateAgentPersistenceConfig.mockReturnValue([]);
  mocks.getStore.mockReturnValue(store);
  mocks.readFence.mockResolvedValue({ generation: 1 });
  mocks.assertFence.mockResolvedValue(undefined);
  mocks.profileLibraryQueries.mockReturnValue({ list, listFilters });

  return { list, listFilters, libraryResult, filtersResult, store };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Firestore memory library diagnostic integration (synthetic, database-free)', () => {
  it('records successful fence, owner, list, and filter phases without logging result data', async () => {
    const { libraryResult, filtersResult } = setup();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(
      loadFirestoreMemoryLibrary(
        { state: 'in-use', filter: 'all', query: '', page: 1, connectivity: 'all' },
        context,
      ),
    ).resolves.toEqual([libraryResult, filtersResult]);

    const lines = info.mock.calls.map(([line]) => String(line));
    const phases = lines.map((line) => (JSON.parse(line) as { phase: string }).phase);
    expect(phases).toEqual(['config', 'pre_fence', 'owner_guard', 'list', 'filters', 'post_fence']);
    expect(lines.join('\n')).not.toContain('configured-owner');
    expect(lines.join('\n')).not.toContain('synthetic memory content');
  });

  it('logs owner validation failures at the owner guard and preserves the original failure', async () => {
    setup(false);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(
      loadFirestoreMemoryLibrary(
        { state: 'in-use', filter: 'all', query: '', page: 1, connectivity: 'all' },
        context,
      ),
    ).rejects.toThrow('Memory library requires one matching configured owner');

    const lines = info.mock.calls.map(([line]) => String(line));
    expect(lines.map((line) => (JSON.parse(line) as { phase: string }).phase)).toEqual([
      'config',
      'pre_fence',
      'owner_guard',
    ]);
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      outcome: 'error',
      errorCode: 'UNCLASSIFIED',
    });
    expect(lines.join('\n')).not.toContain('configured-owner');
    expect(mocks.profileLibraryQueries).not.toHaveBeenCalled();
  });

  it('does not return a partial library result when filters fail', async () => {
    const { list, listFilters } = setup();
    const failure = Object.assign(new Error('private row and query sentinel'), {
      code: 'FIRESTORE_PROFILE_READ_LIMIT',
    });
    listFilters.mockRejectedValue(failure);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(
      loadFirestoreMemoryLibrary(
        { state: 'in-use', filter: 'all', query: '', page: 1, connectivity: 'all' },
        context,
      ),
    ).rejects.toBe(failure);
    expect(list).toHaveBeenCalledOnce();

    const lines = info.mock.calls.map(([line]) => String(line));
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.find((event) => event.phase === 'filters')).toMatchObject({
      outcome: 'error',
      errorCode: 'FIRESTORE_PROFILE_READ_LIMIT',
    });
    expect(events.some((event) => event.phase === 'post_fence')).toBe(false);
    expect(lines.join('\n')).not.toContain('private row and query sentinel');
  });

  it('stops before owner validation when the pre-read erasure fence rejects', async () => {
    const { store } = setup();
    const failure = new Error('synthetic erasure fence failure');
    mocks.readFence.mockRejectedValue(failure);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(
      loadFirestoreMemoryLibrary(
        { state: 'in-use', filter: 'all', query: '', page: 1, connectivity: 'all' },
        context,
      ),
    ).rejects.toBe(failure);

    const lines = info.mock.calls.map(([line]) => String(line));
    expect(lines.map((line) => (JSON.parse(line) as { phase: string }).phase)).toEqual([
      'config',
      'pre_fence',
    ]);
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      outcome: 'error',
      errorCode: 'UNCLASSIFIED',
    });
    expect(store.collection).not.toHaveBeenCalled();
    expect(mocks.profileLibraryQueries).not.toHaveBeenCalled();
  });

  it('does not return loaded data when the post-read erasure fence rejects', async () => {
    const { list, listFilters } = setup();
    const failure = new Error('synthetic changed erasure fence');
    mocks.assertFence.mockRejectedValue(failure);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(
      loadFirestoreMemoryLibrary(
        { state: 'in-use', filter: 'all', query: '', page: 1, connectivity: 'all' },
        context,
      ),
    ).rejects.toBe(failure);
    expect(list).toHaveBeenCalledOnce();
    expect(listFilters).toHaveBeenCalledOnce();

    const lines = info.mock.calls.map(([line]) => String(line));
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.phase)).toEqual([
      'config',
      'pre_fence',
      'owner_guard',
      'list',
      'filters',
      'post_fence',
    ]);
    expect(events.at(-1)).toMatchObject({ outcome: 'error', errorCode: 'UNCLASSIFIED' });
  });
});
