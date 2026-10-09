import type {
  ImportCommandRepository,
  ImportOverviewRepository,
  OwnerCardCompilationRepository,
  Records,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import {
  deleteImportedSource,
  getImportOverview,
  type ImportCommandPersistence,
} from './imports.js';
import type { WorkspacePort } from './workspace.js';

const now = new Date('2026-09-22T12:00:00Z');

function source(
  id: string,
  name: string,
  workspacePath: string,
  updatedAt: Date,
): Records['importSources'] {
  return {
    id,
    agentId: 'owner',
    createdAt: now,
    updatedAt,
    source: name,
    workspacePath,
    kind: 'text',
    status: 'done',
    taskId: null,
    itemsTotal: 1,
    itemsProcessed: 1,
    memoriesSaved: 1,
    memoriesQuarantined: 0,
    parseDiagnostics: null,
    error: null,
  };
}

describe('import overview application seam', () => {
  it('preserves source ordering, voice filtering, per-source counts, and unstarted files', async () => {
    const latest = source('latest', 'takeout-mail', 'import/latest.txt', now);
    const voice = source('voice', 'voice-samples-upload', 'import/voice.txt', new Date(1));
    const repository: ImportOverviewRepository = {
      kind: 'import-overview-repository',
      listPage: vi.fn().mockResolvedValue({
        sources: [voice, latest],
        quarantineBySource: { 'takeout-mail': 2, 'voice-samples-upload': 1 },
        hasMore: false,
        nextCursor: null,
      }),
      trackedWorkspacePaths: vi.fn().mockResolvedValue(['import/latest.txt', 'import/voice.txt']),
    };
    const workspace = {
      listPage: vi.fn().mockResolvedValue({
        items: [
          { name: 'latest.txt', dir: false },
          { name: 'voice.txt', dir: false },
          { name: 'new.txt', dir: false },
          { name: 'folder', dir: true },
        ],
        hasMore: true,
        nextCursor: 'files-next',
        consistency: 'process-snapshot',
      }),
    } as unknown as WorkspacePort;

    await expect(getImportOverview(repository, workspace)).resolves.toEqual({
      sources: [latest],
      quarantineBySource: { 'takeout-mail': 2 },
      unstartedFiles: [{ name: 'new.txt', dir: false }],
      sourcePagination: { consistency: 'live-keyset', hasMore: false, nextCursor: null },
      filesPagination: { consistency: 'process-snapshot', hasMore: true, nextCursor: 'files-next' },
      sourceAvailability: { status: 'available', version: 1 },
      filesAvailability: { status: 'available', version: 1 },
    });
    expect(repository.listPage).toHaveBeenCalledOnce();
    expect(repository.listPage).toHaveBeenCalledWith({
      limit: 50,
      excludeSourcePrefix: 'voice-samples',
    });
    expect(workspace.listPage).toHaveBeenCalledWith('import', { cursor: null, limit: 50 });
  });

  it('marks a failed workspace stream unavailable instead of reporting an empty successful list', async () => {
    const row = source('known', 'source', 'import/known.txt', now);
    const repository: ImportOverviewRepository = {
      kind: 'import-overview-repository',
      listPage: vi.fn().mockResolvedValue({
        sources: [row],
        quarantineBySource: {},
        hasMore: false,
        nextCursor: null,
      }),
      trackedWorkspacePaths: vi.fn().mockResolvedValue([]),
    };
    const workspace = {
      listPage: vi.fn().mockRejectedValue(new Error('offline')),
    } as unknown as WorkspacePort;

    await expect(getImportOverview(repository, workspace)).resolves.toEqual({
      sources: [row],
      quarantineBySource: {},
      unstartedFiles: [],
      sourcePagination: { consistency: 'live-keyset', hasMore: false, nextCursor: null },
      filesPagination: { consistency: 'unavailable', hasMore: false, nextCursor: null },
      sourceAvailability: { status: 'available', version: 1 },
      filesAvailability: {
        status: 'unavailable',
        version: 1,
        message: 'Workspace files are unavailable. Retry to reload them.',
      },
    });
  });
});

describe('import deletion application seam', () => {
  it('reports a failed portable workspace delete as pending instead of complete', async () => {
    const imports = {
      kind: 'import-command-repository',
      remove: vi.fn().mockResolvedValue({
        agentId: 'owner',
        purgedMemories: 2,
        cleanupReady: true,
      }),
      pendingDeletionAssets: vi
        .fn()
        .mockResolvedValue([{ id: 'asset-1', workspacePath: 'import/private.txt' }]),
      assetDeleted: vi.fn().mockResolvedValue(undefined),
      completeDeletion: vi.fn().mockResolvedValue(undefined),
    } as unknown as ImportCommandRepository;
    const ownerCards = {
      kind: 'owner-card-compilation-repository',
      compile: vi.fn().mockResolvedValue(''),
    } as unknown as OwnerCardCompilationRepository;
    const persistence = {
      kind: 'import-command-persistence',
      imports,
      ownerCards,
    } as ImportCommandPersistence;
    const workspace = {
      delete: vi.fn().mockRejectedValue(new Error('private workspace failure')),
    } as unknown as WorkspacePort;

    await expect(deleteImportedSource(persistence, workspace, 'source')).resolves.toEqual({
      purgedMemories: 2,
      pendingAssets: true,
    });
    expect(workspace.delete).toHaveBeenCalledWith('import/private.txt');
    expect(imports.assetDeleted).not.toHaveBeenCalled();
  });
});
