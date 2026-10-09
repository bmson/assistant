import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import { compileOwnerCard } from '@assistant/core/memory/consolidation';
import {
  deleteImportSource,
  purgeImportSource,
  reviewImportSource,
  startImport,
  startPortableImport,
} from '@assistant/core/memory/import';
import { detectKind } from '@assistant/core/memory/import-parsers';
import {
  isVoiceImportSource,
  isVoiceRegister,
  registerForFilename,
  startPortableVoiceIngest,
  startVoiceIngest,
  VOICE_IMPORT_SOURCE_PREFIX,
} from '@assistant/core/memory/voice-ingest';
import {
  type Db,
  importSources,
  memories,
  withPostgresPrivacyObservationFence,
} from '@assistant/db';
import {
  type ImportCommandRepository,
  type ImportOverviewData,
  type ImportOverviewRepository,
  isImportOverviewRepository,
  type OwnerCardCompilationRepository,
  type Records,
} from '@assistant/persistence';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { safeWorkspacePath, type WorkspacePort } from './workspace.js';

export type ImportSourceSnapshot = Records['importSources'];

/** Portable import commands: the source commands plus the owner card they invalidate. */
export interface ImportCommandPersistence {
  readonly kind: 'import-command-persistence';
  imports: ImportCommandRepository;
  ownerCards: OwnerCardCompilationRepository;
}

function isImportCommandPersistence(value: unknown): value is ImportCommandPersistence {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'import-command-persistence'
  );
}

async function recompileOwnerCard(persistence: ImportCommandPersistence, agentId: string) {
  await compileOwnerCard(persistence.ownerCards, agentId).catch((err) =>
    console.error('card recompile failed', err),
  );
}

export interface ImportOverview {
  sources: ImportSourceSnapshot[];
  quarantineBySource: Record<string, number>;
  unstartedFiles: Array<{ name: string; dir: boolean }>;
  sourcePagination: { consistency: 'live-keyset'; hasMore: boolean; nextCursor: string | null };
  filesPagination: {
    consistency: 'process-snapshot' | 'provider-token' | 'unavailable';
    hasMore: boolean;
    nextCursor: string | null;
  };
  sourceAvailability: { status: 'available' | 'unavailable'; version: 1; message?: string };
  filesAvailability: { status: 'available' | 'unavailable'; version: 1; message?: string };
}

const IMPORT_OVERVIEW_PAGE_SIZE = 50;

const sourceAvailable = { status: 'available' as const, version: 1 as const };
const filesAvailable = { status: 'available' as const, version: 1 as const };
const sourceUnavailable = {
  status: 'unavailable' as const,
  version: 1 as const,
  message: 'Import history is unavailable. Retry to reload it.',
};
const filesUnavailable = {
  status: 'unavailable' as const,
  version: 1 as const,
  message: 'Workspace files are unavailable. Retry to reload them.',
};

export function getImportOverview(
  db: Db,
  workspace: WorkspacePort,
  input?: { sourceCursor?: string | null; filesCursor?: string | null; limit?: number },
): Promise<ImportOverview>;
export function getImportOverview(
  repository: ImportOverviewRepository,
  workspace: WorkspacePort,
  input?: { sourceCursor?: string | null; filesCursor?: string | null; limit?: number },
): Promise<ImportOverview>;
export async function getImportOverview(
  source: Db | ImportOverviewRepository,
  workspace: WorkspacePort,
  input: { sourceCursor?: string | null; filesCursor?: string | null; limit?: number } = {},
): Promise<ImportOverview> {
  const limit = input.limit ?? IMPORT_OVERVIEW_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > IMPORT_OVERVIEW_PAGE_SIZE)
    throw new Error('Import page size must be between 1 and 50');
  const afterSource = input.sourceCursor ?? undefined;
  if (isImportOverviewRepository(source)) {
    const [sourceStream, filesStream] = await Promise.all([
      source
        .listPage({
          limit,
          excludeSourcePrefix: VOICE_IMPORT_SOURCE_PREFIX,
          ...(afterSource ? { afterSource } : {}),
        })
        .then((data) => ({ data, available: true as const }))
        .catch(() => ({ data: unavailableSourcesPage(), available: false as const })),
      listUnstartedFiles(
        workspace,
        (workspacePaths) => source.trackedWorkspacePaths({ workspacePaths }),
        input.filesCursor ?? null,
        limit,
      )
        .then((data) => ({ data, available: true as const }))
        .catch(() => ({
          data: {
            items: [],
            hasMore: false,
            nextCursor: null,
            consistency: 'unavailable' as const,
          },
          available: false as const,
        })),
    ]);
    return {
      sources: sourceStream.data.sources.filter((row) => !isVoiceImportSource(row.source)),
      quarantineBySource: Object.fromEntries(
        Object.entries(sourceStream.data.quarantineBySource).filter(
          ([source]) => !isVoiceImportSource(source),
        ),
      ),
      unstartedFiles: filesStream.data.items,
      sourcePagination: {
        consistency: 'live-keyset',
        hasMore: sourceStream.data.hasMore,
        nextCursor: sourceStream.data.nextCursor,
      },
      filesPagination: {
        consistency: filesStream.data.consistency,
        hasMore: filesStream.data.hasMore,
        nextCursor: filesStream.data.nextCursor,
      },
      sourceAvailability: sourceStream.available ? sourceAvailable : sourceUnavailable,
      filesAvailability: filesStream.available ? filesAvailable : filesUnavailable,
    };
  }

  const db = source as Db;
  const ownerId = (await getAgent(db)).id;
  return withPostgresPrivacyObservationFence(db, ownerId, async () => {
    const [sourceStream, filesStream] = await Promise.all([
      postgresImportSourcePage(db, ownerId, afterSource, limit, VOICE_IMPORT_SOURCE_PREFIX)
        .then((data) => ({ data, available: true as const }))
        .catch(() => ({ data: unavailableSourcesPage(), available: false as const })),
      listUnstartedFiles(
        workspace,
        async (workspacePaths) => {
          if (workspacePaths.length === 0) return [];
          const rows = await db
            .select({ workspacePath: importSources.workspacePath })
            .from(importSources)
            .where(
              and(
                eq(importSources.agentId, ownerId),
                inArray(importSources.workspacePath, workspacePaths),
              ),
            );
          return rows.map((row) => row.workspacePath);
        },
        input.filesCursor ?? null,
        limit,
      )
        .then((data) => ({ data, available: true as const }))
        .catch(() => ({
          data: {
            items: [],
            hasMore: false,
            nextCursor: null,
            consistency: 'unavailable' as const,
          },
          available: false as const,
        })),
    ]);
    return {
      sources: sourceStream.data.sources.filter((row) => !isVoiceImportSource(row.source)),
      quarantineBySource: Object.fromEntries(
        Object.entries(sourceStream.data.quarantineBySource).filter(
          ([source]) => !isVoiceImportSource(source),
        ),
      ),
      unstartedFiles: filesStream.data.items,
      sourcePagination: {
        consistency: 'live-keyset',
        hasMore: sourceStream.data.hasMore,
        nextCursor: sourceStream.data.nextCursor,
      },
      filesPagination: {
        consistency: filesStream.data.consistency,
        hasMore: filesStream.data.hasMore,
        nextCursor: filesStream.data.nextCursor,
      },
      sourceAvailability: sourceStream.available ? sourceAvailable : sourceUnavailable,
      filesAvailability: filesStream.available ? filesAvailable : filesUnavailable,
    };
  });
}

function unavailableSourcesPage(): ImportOverviewData {
  return { sources: [], quarantineBySource: {}, hasMore: false, nextCursor: null };
}

async function postgresImportSourcePage(
  db: Db,
  ownerId: string,
  afterSource: string | undefined,
  limit: number,
  excludeSourcePrefix: string,
): Promise<ImportOverviewData> {
  const scanLimit = 1_000;
  const rows = await db
    .select()
    .from(importSources)
    .where(
      and(
        eq(importSources.agentId, ownerId),
        afterSource ? gt(importSources.source, afterSource) : undefined,
      ),
    )
    .orderBy(asc(importSources.source))
    .limit(scanLimit + 1);
  const sources: ImportSourceSnapshot[] = [];
  let lastScannedSource: string | null = null;
  let foundVisibleOverflow = false;
  for (const row of rows.slice(0, scanLimit)) {
    if (row.source.startsWith(excludeSourcePrefix)) {
      lastScannedSource = row.source;
      continue;
    }
    if (sources.length === limit) {
      foundVisibleOverflow = true;
      break;
    }
    sources.push(row);
    lastScannedSource = row.source;
  }
  const sourceNames = sources.map((row) => row.source);
  const quarantineCounts = sourceNames.length
    ? await db
        .select({ source: memories.source, count: sql<number>`count(*)` })
        .from(memories)
        .where(
          and(
            eq(memories.agentId, ownerId),
            eq(memories.quarantined, true),
            inArray(memories.source, sourceNames),
          ),
        )
        .groupBy(memories.source)
    : [];
  const hasMore = foundVisibleOverflow || rows.length > scanLimit;
  return {
    sources,
    quarantineBySource: Object.fromEntries(
      quarantineCounts.map((row) => [row.source ?? '', Number(row.count)]),
    ),
    hasMore,
    nextCursor: hasMore ? lastScannedSource : null,
  };
}

async function listUnstartedFiles(
  workspace: WorkspacePort,
  trackedWorkspacePaths: (workspacePaths: string[]) => Promise<string[]>,
  cursor: string | null,
  limit: number,
): Promise<{
  items: Array<{ name: string; dir: boolean }>;
  hasMore: boolean;
  nextCursor: string | null;
  consistency: 'process-snapshot' | 'provider-token';
}> {
  if (!workspace.listPage) throw new Error('Workspace listing does not support pagination');
  const page = await workspace.listPage('import', { cursor, limit });
  const filePaths = page.items.filter((file) => !file.dir).map((file) => `import/${file.name}`);
  const known = new Set(await trackedWorkspacePaths(filePaths));
  return {
    items: page.items.filter((file) => !file.dir && !known.has(`import/${file.name}`)),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    consistency: page.consistency,
  };
}

export async function startWorkspaceImport(
  store: Db | ImportCommandPersistence,
  workspace: WorkspacePort,
  workspacePath: string,
  source: string,
): Promise<{ error?: string }> {
  try {
    const content = await workspace.read(workspacePath);
    const kind = detectKind(workspacePath, content.slice(0, 4000));
    if (isImportCommandPersistence(store)) {
      await startPortableImport(store.imports, { source, workspacePath, kind });
      return {};
    }
    const agent = await getAgent(store);
    await startImport(store, { agentId: agent.id, source, workspacePath, kind });
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function purgeImportedSource(
  store: Db | ImportCommandPersistence,
  source: string,
): Promise<{ purged: number }> {
  if (!isImportCommandPersistence(store)) return purgeImportSource(store, source);
  const result = await store.imports.purge(source);
  await recompileOwnerCard(store, result.agentId);
  return { purged: result.purged };
}

export async function deleteImportedSource(
  store: Db | ImportCommandPersistence,
  workspace: WorkspacePort,
  source: string,
): Promise<{ purgedMemories: number; pendingAssets: boolean }> {
  if (!isImportCommandPersistence(store)) return deleteImportSource(store, source, workspace);
  const result = await store.imports.remove(source);
  let pendingAssets = false;
  if (!result.cleanupReady) {
    pendingAssets = true;
  } else {
    for (;;) {
      let assets: Awaited<ReturnType<ImportCommandRepository['pendingDeletionAssets']>>;
      try {
        assets = await store.imports.pendingDeletionAssets(source);
      } catch {
        pendingAssets = true;
        break;
      }
      if (assets.length === 0) {
        try {
          await store.imports.completeDeletion(source);
        } catch {
          pendingAssets = true;
        }
        break;
      }
      if (!workspace) {
        pendingAssets = true;
        break;
      }
      let failed = false;
      for (const asset of assets) {
        try {
          await workspace.delete(asset.workspacePath);
          await store.imports.assetDeleted(source, asset.id, asset.workspacePath);
        } catch {
          // Keep the durable path intent so a fresh request can retry it.
          failed = true;
        }
      }
      if (failed) {
        pendingAssets = true;
        break;
      }
    }
  }
  await recompileOwnerCard(store, result.agentId);
  return { purgedMemories: result.purgedMemories, pendingAssets };
}

export async function reviewImportedSource(
  store: Db | ImportCommandPersistence,
  source: string,
  verdict: 'approve' | 'reject',
): Promise<{ reviewed: number }> {
  if (!isImportCommandPersistence(store)) return reviewImportSource(store, source, verdict);
  const result = await store.imports.review(source, verdict);
  if (result.reviewed > 0) await recompileOwnerCard(store, result.agentId);
  return { reviewed: result.reviewed };
}

type VoiceStart = Omit<Parameters<typeof startVoiceIngest>[1], 'agentId'>;
type BackstoryStart = Omit<Parameters<typeof startImport>[1], 'agentId'>;

function portableImportStarters(imports: ImportCommandRepository) {
  return {
    voice: async (input: VoiceStart) => {
      await startPortableVoiceIngest(imports, input);
    },
    backstory: async (input: BackstoryStart) => {
      await startPortableImport(imports, input);
    },
  };
}

async function postgresImportStarters(db: Db) {
  const agent = await getAgent(db);
  return {
    voice: async (input: VoiceStart) => {
      await startVoiceIngest(db, { ...input, agentId: agent.id });
    },
    backstory: async (input: BackstoryStart) => {
      await startImport(db, { ...input, agentId: agent.id });
    },
  };
}

function cleanImportName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'archive.txt';
}

export async function uploadImport(
  store: Db | ImportCommandPersistence,
  workspace: WorkspacePort,
  input: {
    fileName: string;
    content: string;
    source?: string;
    voice?: boolean;
    register?: string;
  },
): Promise<{ destination: '/profile/voice' | '/import' }> {
  const start = isImportCommandPersistence(store)
    ? portableImportStarters(store.imports)
    : await postgresImportStarters(store);
  const cleanName = cleanImportName(input.fileName);
  const workspacePath = safeWorkspacePath(`import/uploads/${randomUUID()}-${cleanName}`);
  const source = input.source?.trim() || cleanName.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  const kind = detectKind(cleanName, input.content.slice(0, 4000));
  await workspace.write(workspacePath, input.content);
  try {
    if (input.voice) {
      const requestedRegister = input.register ?? '';
      const register = isVoiceRegister(requestedRegister)
        ? requestedRegister
        : registerForFilename(input.fileName);
      await start.voice({
        source: input.source?.trim() || cleanName,
        workspacePath,
        kind,
        register,
        // Choosing the dedicated voice-sample upload is an explicit owner
        // assertion for raw text; message archives still require mailbox
        // identity and quote/forward checks.
        ownerConfirmedRawText: kind === 'text',
      });
      return { destination: '/profile/voice' };
    }
    await start.backstory({ source, workspacePath, kind });
    return { destination: '/import' };
  } catch (error) {
    await workspace.delete(workspacePath).catch(() => {});
    throw error;
  }
}
