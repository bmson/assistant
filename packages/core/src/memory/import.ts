import { createHash } from 'node:crypto';
import {
  addTombstone,
  agents,
  assertPostgresPrivacyObservationFence,
  type Db,
  type ImportSourceRow,
  importSources,
  isTombstoned,
  knowledgeGraphRelations,
  lockPostgresPrivacyObservationFence,
  maintenanceCursors,
  memories,
  memoryImportLineage,
  occasionImportLineage,
  occasions,
  resolveSubjectContact,
  type TaskRow,
  tasks,
} from '@assistant/db';
import {
  embeddingSpaceIdentityKey,
  type ImportCommandRepository,
  type ImportFactWrite,
  type ImportJobFence,
  type ImportJobRepository,
  type ImportOccasionWrite,
  type ImportUnitProvenance,
  type OwnerCardCompilationRepository,
  validateEmbedding,
} from '@assistant/persistence';
import { and, asc, eq, gt, inArray, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isUnparseableObjectError, type ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { getQueueNotifier } from '../queue.js';
import { enqueueTask } from '../workflow/machine.js';
import { compileOwnerCard } from './consolidation.js';
import { ExtractedFactSchema, ExtractedOccasionSchema, parseValidFrom } from './extraction.js';
import {
  ageScaledConfidence,
  type ImportKind,
  type ImportParseDiagnostics,
  parseArchiveDetailed,
  windowUnits,
} from './import-parsers.js';
import { isOccasionKind, saveOccasion, validMonthDay } from './occasions.js';

/**
 * Backstory import (Phase 22): batch-distill an archive from the workspace
 * import/ prefix into entity-linked memories through the same attribution
 * rules as nightly extraction. Resumable: the window cursor checkpoints into
 * tasks.state after every window — an interrupted 100k-email import resumes,
 * never restarts, and content-hash dedupe makes overlap harmless.
 *
 * Tiering by design: only distilled FACTS reach the database and embeddings;
 * resumability snapshots remain inside the private workspace. Facts about
 * third parties land quarantined until profile review; facts about the owner
 * are trusted (origin_trust 'owner', it's the owner's own archive). Confidence
 * scales down with source age.
 */

/** Minimal structural view of the workspace store (defined in @assistant/tools — no cycle). */
export interface WorkspaceReader {
  read(relPath: string): Promise<string>;
  write(relPath: string, content: string): Promise<unknown>;
  list(relPath: string): Promise<Array<{ name: string; dir: boolean }>>;
  /** Binary read — present on the real store; used by document extraction (PDFs). */
  readBytes?(relPath: string): Promise<Buffer>;
}

const ImportFactsSchema = z.object({
  facts: z.array(ExtractedFactSchema).max(20),
  occasions: z.array(ExtractedOccasionSchema).max(10).default([]),
});

const WINDOWS_PER_RUN = 6; // checkpoint granularity: one run ≈ one queue lease
const RESUME_DELAY_MS = 5_000;
const SNAPSHOT_LOCK_RETRY_MS = 30_000;
const SNAPSHOT_SLOT_TTL_MS = 15 * 60_000;
const BUDGET_RETRY_DELAY_MS = 6 * 3600 * 1000;
const SNAPSHOT_ASSET_PREFIX = 'import-snapshot-asset:';
const DELETE_ASSET_ID_PREFIX = 'import-delete:';
const PRIVACY_ASSET_PREFIX = 'privacy-erasure-asset:';
const IMPORT_DELETE_RESULT_PREFIX = 'import-source-delete-result:';
const IMPORT_DELETE_JOB_PREFIX = 'import-source-delete-job:';
const IMPORT_PURGE_RESULT_PREFIX = 'import-source-purge-result:';
const IMPORT_PURGE_JOB_PREFIX = 'import-source-purge-job:';
const IMPORT_DELETE_NODE_PREFIX = 'import-source-delete-node:';
const IMPORT_PURGE_NODE_PREFIX = 'import-source-purge-node:';
const IMPORT_DELETE_PAGE_SIZE = 50;
const MAX_IMPORT_DELETE_NODES = 100_000;

type ImportDeletePhase =
  | 'assets'
  | 'seed_direct'
  | 'seed_lineage'
  | 'discover'
  | 'detach'
  | 'delete'
  | 'occasions'
  | 'cleanup_nodes';

interface ImportDeleteProgress {
  version: 1;
  operation: 'delete' | 'purge';
  sourceId: string;
  sourceHash: string;
  phase: ImportDeletePhase;
  assetCursor: string | null;
  directCursor: string | null;
  lineageCursor: string | null;
  detachNodeCursor: string | null;
  detachPredecessorCursor: string | null;
  nodeRestoreCursor: string | null;
  predecessorCursor: string | null;
  occasionCursor: string | null;
  cleanupCursor: string | null;
  nodeCount: number;
  purgedMemories: number;
}

interface ImportCursor {
  windowIndex: number;
  saved: number;
  duplicates: number;
  tombstoned: number;
  quarantined: number;
  occasionsSaved: number;
  embeddingSpaceKey?: string;
  /** Durable parsed snapshot. Resumed leases never reopen the source archive. */
  manifestPath?: string;
  manifestHash?: string;
}

const IMPORT_SNAPSHOT_VERSION = 2;
const WINDOWS_PER_SHARD = 64;
const MIN_WINDOW_CHARS = 500;
const MAX_WINDOW_CHARS = 20_000;

const ImportShardSchema = z
  .array(
    z.object({
      date: z.string().datetime().nullable(),
      text: z.string().max(MAX_WINDOW_CHARS + 500),
      units: z
        .array(
          z.object({
            date: z.string().datetime().nullable(),
            header: z.string(),
            sourceOffset: z.number().int().nonnegative(),
            authorEmail: z.string().nullable(),
            hasQuotedContent: z.boolean(),
            unitOffset: z.number().int().nonnegative(),
            text: z.string(),
          }),
        )
        .default([]),
    }),
  )
  .max(WINDOWS_PER_SHARD);

const ImportManifestSchema = z.object({
  version: z.union([z.literal(1), z.literal(IMPORT_SNAPSHOT_VERSION)]),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  windowCount: z.number().int().nonnegative(),
  diagnostics: z
    .object({
      format: z.enum(['mbox', 'json', 'text']),
      supported: z.array(z.string()),
      acceptedUnits: z.number().int().nonnegative(),
      rejectedUnits: z.number().int().nonnegative(),
      partial: z.boolean(),
      issues: z.array(
        z.object({
          offset: z.number().int().nonnegative(),
          code: z.string(),
          message: z.string(),
        }),
      ),
    })
    .optional(),
  shards: z
    .array(
      z.object({
        path: z.string().min(1),
        start: z.number().int().nonnegative(),
        count: z.number().int().positive().max(WINDOWS_PER_SHARD),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(100_000),
});

type ImportManifest = z.infer<typeof ImportManifestSchema>;
type ImportShardWindow = z.infer<typeof ImportShardSchema>[number];

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function snapshotBasePath(source: string, taskId: string): string {
  // `source` is constrained by startImport and taskId is a UUID. Keeping
  // snapshots outside import/ prevents them from appearing as user uploads.
  return `.assistant/imports/${source}/${taskId}`;
}

async function createImportSnapshot(
  workspace: WorkspaceReader,
  payload: ImportPayload,
  taskId: string,
  registerAsset?: (path: string) => Promise<void>,
): Promise<{ manifest: ImportManifest; path: string; hash: string }> {
  const content = await workspace.read(payload.path);
  const parsed = await parseArchiveDetailed(payload.kind, content);
  const windows = windowUnits(parsed.units, payload.windowChars);
  const base = snapshotBasePath(payload.source, taskId);
  const shards: ImportManifest['shards'] = [];

  for (let start = 0; start < windows.length; start += WINDOWS_PER_SHARD) {
    const path = `${base}/windows-${String(start / WINDOWS_PER_SHARD).padStart(6, '0')}.json`;
    const shard = windows.slice(start, start + WINDOWS_PER_SHARD).map((window) => ({
      date: window.date?.toISOString() ?? null,
      text: window.text,
      units: window.units.map((unit) => ({
        date: unit.date?.toISOString() ?? null,
        header: unit.header,
        sourceOffset: unit.sourceOffset,
        authorEmail: unit.authorEmail,
        hasQuotedContent: unit.hasQuotedContent,
        unitOffset: unit.unitOffset,
        text: unit.text,
      })),
    }));
    const serialized = JSON.stringify(shard);
    await registerAsset?.(path);
    await workspace.write(path, serialized);
    shards.push({ path, start, count: shard.length, hash: sha256(serialized) });
  }

  const manifest: ImportManifest = {
    version: IMPORT_SNAPSHOT_VERSION,
    sourceHash: sha256(content),
    windowCount: windows.length,
    diagnostics: parsed.diagnostics,
    shards,
  };
  const serialized = JSON.stringify(manifest);
  const path = `${base}/manifest.json`;
  // Publish the manifest only after every referenced shard is durable. A
  // partial snapshot is therefore never mistaken for a resumable one.
  await registerAsset?.(path);
  await workspace.write(path, serialized);
  return { manifest, path, hash: sha256(serialized) };
}

/**
 * Snapshot parsing temporarily holds several representations of a large
 * archive. Serialize only that phase across instances so scaled Cloud Run
 * requests cannot multiply the peak memory footprint and OOM one another.
 */
async function tryCreateImportSnapshot(
  db: Db,
  workspace: WorkspaceReader,
  payload: ImportPayload,
  taskId: string,
  sourceId: string,
): Promise<Awaited<ReturnType<typeof createImportSnapshot>> | null> {
  const connection = await db.$client.reserve();
  let acquired = false;
  try {
    const [row] = await connection<[{ acquired: boolean }]>`
      select pg_try_advisory_lock(hashtext('assistant:import-snapshot')) as acquired
    `;
    acquired = row?.acquired === true;
    if (!acquired) return null;
    const [active] = await db
      .select({ sourceId: importSources.id })
      .from(importSources)
      .innerJoin(
        tasks,
        and(eq(tasks.id, importSources.taskId), eq(tasks.agentId, importSources.agentId)),
      )
      .where(
        and(
          eq(importSources.id, sourceId),
          eq(importSources.taskId, taskId),
          inArray(importSources.status, ['pending', 'running']),
          eq(tasks.status, 'running'),
        ),
      );
    if (!active) throw new Error(`import ${payload.source} was cancelled before snapshot creation`);
    return await createImportSnapshot(workspace, payload, taskId, async (path) => {
      const name = `${SNAPSHOT_ASSET_PREFIX}${sourceId}:${sha256(path)}`;
      await db
        .insert(maintenanceCursors)
        .values({ name, cursor: path })
        .onConflictDoUpdate({
          target: maintenanceCursors.name,
          set: { cursor: path, updatedAt: new Date() },
        });
    });
  } finally {
    if (acquired) {
      await connection`select pg_advisory_unlock(hashtext('assistant:import-snapshot'))`.catch(
        (error) => console.error('import: failed to release snapshot lock', error),
      );
    }
    connection.release();
  }
}

async function readImportManifest(
  workspace: WorkspaceReader,
  path: string,
  expectedHash: string,
  expectedBase: string,
): Promise<ImportManifest> {
  const serialized = await workspace.read(path);
  if (sha256(serialized) !== expectedHash) throw new Error('import snapshot manifest is corrupt');
  return validateManifestTopology(ImportManifestSchema.parse(JSON.parse(serialized)), expectedBase);
}

function validateManifestTopology(manifest: ImportManifest, expectedBase: string): ImportManifest {
  let nextStart = 0;
  for (let index = 0; index < manifest.shards.length; index++) {
    const shard = manifest.shards[index];
    const expectedPath = `${expectedBase}/windows-${String(index).padStart(6, '0')}.json`;
    if (!shard || shard.start !== nextStart || shard.path !== expectedPath) {
      throw new Error('import snapshot manifest has invalid shard topology');
    }
    nextStart += shard.count;
  }
  if (nextStart !== manifest.windowCount) {
    throw new Error('import snapshot manifest window count does not match its shards');
  }
  return manifest;
}

function missingWorkspaceFile(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return candidate.code === 'ENOENT' || candidate.message?.includes('no such file') === true;
}

async function readImportShard(
  workspace: WorkspaceReader,
  manifest: ImportManifest,
  windowIndex: number,
): Promise<{ start: number; windows: ImportShardWindow[] }> {
  const shard = manifest.shards.find(
    (candidate) =>
      windowIndex >= candidate.start && windowIndex < candidate.start + candidate.count,
  );
  if (!shard) throw new Error(`import snapshot has no shard for window ${windowIndex}`);
  const serialized = await workspace.read(shard.path);
  if (sha256(serialized) !== shard.hash) {
    throw new Error(`import snapshot shard is corrupt: ${shard.path}`);
  }
  const parsedWindows = ImportShardSchema.parse(JSON.parse(serialized));
  // Version 1 snapshots stored a group median, not individual observations.
  // Never reuse that date as the source age for a claim during a resumed job.
  const windows =
    manifest.version === 1
      ? parsedWindows.map((window) => ({ ...window, date: null }))
      : parsedWindows;
  if (windows.length !== shard.count) {
    throw new Error(`import snapshot shard has the wrong window count: ${shard.path}`);
  }
  return { start: shard.start, windows };
}

interface ImportPayload {
  job: string;
  source: string;
  path: string;
  kind: ImportKind;
  windowsPerRun?: number;
  windowChars?: number;
}

function importPayload(task: TaskRow): ImportPayload {
  const payload = (task.trigger as { payload?: Record<string, unknown> })?.payload ?? {};
  const source = String(payload.source ?? '');
  const path = String(payload.path ?? '');
  const kind = String(payload.kind ?? 'text') as ImportKind;
  if (!source || !path) throw new Error('import task payload needs source and path');
  if (kind !== 'mbox' && kind !== 'json' && kind !== 'text') {
    throw new Error(`unsupported import kind: ${kind}`);
  }
  const optionalInteger = (name: 'windowsPerRun' | 'windowChars', min: number, max: number) => {
    const value = payload[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`import task ${name} must be an integer from ${min} to ${max}`);
    }
    return value;
  };
  return {
    job: String(payload.job),
    source,
    path,
    kind,
    windowsPerRun: optionalInteger('windowsPerRun', 1, WINDOWS_PER_SHARD),
    windowChars: optionalInteger('windowChars', MIN_WINDOW_CHARS, MAX_WINDOW_CHARS),
  };
}

function importSystem(source: string, period: string): string {
  return [
    "You distill an ARCHIVE from the owner's digital past into lasting memories.",
    `Source: ${source}. Period: ${period}. The content may be years old — extract only`,
    'durable, biography-level information: who people are, where he lived/worked, lasting',
    'preferences, significant events. Skip logistics, newsletters, receipts, marketing,',
    'and anything trivially dated. Each fact must stand alone, in third person, with names',
    'spelled out. Use subject "owner" for the owner. Unit headers include source offsets,',
    'observation timestamps, and RFC mailbox claims when available. Those timestamps are',
    'observation dates, not proof a fact became true then. Include validFrom (ISO date)',
    'only when the source explicitly establishes that start date; never infer it from a',
    'window or neighboring message. Quoted/forwarded spans are marked: do not attribute',
    'them to the message author. If nothing is worth keeping, return an empty facts array.',
    'Also capture OCCASIONS in the separate occasions array: recurring dates for named',
    'people — birthdays, anniversaries, and other dated events — but only when a specific',
    'month and day are stated. Include the year only if given, and any gift ideas as notes.',
  ].join('\n');
}

export interface ImportRunResult {
  done: boolean;
  runAfter?: Date;
  summary: string;
}

type ImportSnapshot = Awaited<ReturnType<typeof createImportSnapshot>>;

function importUnitProvenance(units: readonly ImportShardWindow['units'][number][]) {
  return units.map(
    (unit): ImportUnitProvenance => ({
      sourceOffset: unit.sourceOffset,
      unitOffset: unit.unitOffset,
      observedAt: unit.date,
      authorEmail: unit.authorEmail,
      header: unit.header,
      hasQuotedContent: unit.hasQuotedContent,
      unitTextHash: sha256(unit.text),
    }),
  );
}

/**
 * The task's parsed snapshot: the checkpointed manifest, a manifest a worker
 * published before dying, or a fresh one. Null while another task holds the
 * bounded snapshot slot.
 */
async function resolveImportManifest(
  workspace: WorkspaceReader,
  payload: ImportPayload,
  taskId: string,
  cursor: ImportCursor,
  createSnapshot: () => Promise<ImportSnapshot | null>,
): Promise<{ manifest: ImportManifest; checkpointNeeded: boolean } | null> {
  const snapshotBase = snapshotBasePath(payload.source, taskId);
  if (cursor.manifestPath && cursor.manifestHash) {
    if (cursor.manifestPath !== `${snapshotBase}/manifest.json`) {
      throw new Error('import snapshot manifest path does not match this task');
    }
    const manifest = await readImportManifest(
      workspace,
      cursor.manifestPath,
      cursor.manifestHash,
      snapshotBase,
    );
    return { manifest, checkpointNeeded: false };
  }
  // If a worker died after publishing the manifest but before checkpointing
  // its path, reuse the completed snapshot instead of reopening the source.
  const publishedPath = `${snapshotBase}/manifest.json`;
  try {
    const serialized = await workspace.read(publishedPath);
    const manifest = validateManifestTopology(
      ImportManifestSchema.parse(JSON.parse(serialized)),
      snapshotBase,
    );
    cursor.manifestPath = publishedPath;
    cursor.manifestHash = sha256(serialized);
    return { manifest, checkpointNeeded: true };
  } catch (error) {
    if (!missingWorkspaceFile(error)) throw error;
    const snapshot = await createSnapshot();
    if (!snapshot) return null;
    cursor.manifestPath = snapshot.path;
    cursor.manifestHash = snapshot.hash;
    return { manifest: snapshot.manifest, checkpointNeeded: true };
  }
}

function waitingForSnapshot(source: string): ImportRunResult {
  return {
    done: false,
    runAfter: new Date(Date.now() + SNAPSHOT_LOCK_RETRY_MS),
    summary: `import ${source}: waiting for the bounded snapshot worker`,
  };
}

function importProgress(source: string, cursor: ImportCursor, windowCount: number) {
  return {
    progress: `import ${source}: window ${cursor.windowIndex}/${windowCount}, ${cursor.saved} memories`,
    progressPercent: windowCount
      ? Math.min(100, Math.round((cursor.windowIndex / windowCount) * 100))
      : 100,
  };
}

/**
 * Distill one window. Null when the model cannot structure it even on the
 * fallback: that must not fail the whole import into a dead-letter, so the
 * caller records the window as progress. Budget stops and other errors surface.
 */
async function distillWindow(
  router: ModelRouter,
  taskId: string,
  source: string,
  windowIndex: number,
  window: ImportShardWindow,
) {
  const windowDate = window.date ? new Date(window.date) : null;
  const period = windowDate ? windowDate.toISOString().slice(0, 10) : 'unknown';
  return router
    .object<z.infer<typeof ImportFactsSchema>>('extract', {
      taskId,
      schema: ImportFactsSchema,
      system: importSystem(source, period),
      prompt: window.text,
    })
    .catch((err) => {
      if (!isUnparseableObjectError(err)) throw err;
      console.error(
        `import ${source}: skipping window ${windowIndex} the model could not structure`,
        err,
      );
      return null;
    });
}

function completedSummary(
  source: string,
  cursor: ImportCursor,
  windowCount: number,
  parse: ImportParseDiagnostics | undefined,
): string {
  const parsing = parse
    ? `${parse.format} (${parse.supported.join('; ')}): ${parse.acceptedUnits} accepted, ${parse.rejectedUnits} rejected${parse.partial ? `; partial parse (${parse.issues.map((issue) => `${issue.code}@${issue.offset}`).join(', ') || 'unsupported content'})` : ''}`
    : 'legacy snapshot parse diagnostics unavailable';
  return `import ${source}: complete — ${cursor.saved} memories (${cursor.quarantined} quarantined for review), ${cursor.occasionsSaved} occasion(s), ${cursor.duplicates} duplicates, ${cursor.tombstoned} tombstoned, ${windowCount} windows; ${parsing}`;
}

export async function runImportJob(
  deps: {
    db: Db;
    router: ModelRouter;
    workspace?: WorkspaceReader;
    heartbeat?: () => Promise<void>;
    /** Portable persistence; without it the run keeps its PostgreSQL path. */
    imports?: ImportJobRepository;
    ownerCards?: OwnerCardCompilationRepository;
  },
  task: TaskRow,
): Promise<ImportRunResult> {
  const { db, router, workspace } = deps;
  if (!workspace) throw new Error('import job needs a workspace store (executor deps)');
  const payload = importPayload(task);
  const imports = deps.imports;
  if (imports)
    return withSpan('memory.import', { source: payload.source }, () =>
      runPortableImportJob({ ...deps, imports, workspace }, task, payload),
    );

  return withSpan('memory.import', { source: payload.source }, async () => {
    await deps.heartbeat?.();
    // The token is captured before source/task/snapshot reads. Each publication
    // rechecks it in its write transaction so a suspended model call cannot
    // recreate private derivatives after owner erasure commits.
    const observedPrivacyGeneration = await db.transaction((tx) =>
      lockPostgresPrivacyObservationFence(tx as unknown as Db, task.agentId),
    );
    const [sourceRow] = await db
      .select()
      .from(importSources)
      .where(eq(importSources.source, payload.source));
    if (!sourceRow) throw new Error(`unknown import source: ${payload.source}`);
    if (sourceRow.status === 'purged') {
      return { done: true, summary: `import ${payload.source}: source was purged — nothing to do` };
    }

    // Resume point: cursor lives in the task checkpoint
    const state = (task.state ?? {}) as Record<string, unknown>;
    const plannerState = (state.plannerState ?? {}) as Record<string, unknown>;
    const cursor: ImportCursor = {
      windowIndex: 0,
      saved: 0,
      duplicates: 0,
      tombstoned: 0,
      quarantined: 0,
      occasionsSaved: 0,
      ...((plannerState.import as Partial<ImportCursor>) ?? {}),
    };
    const embeddingSpace = await router.embeddingSpace();
    const embeddingSpaceKey = embeddingSpaceIdentityKey(embeddingSpace);
    if (cursor.embeddingSpaceKey && cursor.embeddingSpaceKey !== embeddingSpaceKey)
      throw new Error('Import embedding space changed; resume requires the original space');
    cursor.embeddingSpaceKey = embeddingSpaceKey;

    const resolved = await resolveImportManifest(workspace, payload, task.id, cursor, () =>
      tryCreateImportSnapshot(db, workspace, payload, task.id, sourceRow.id),
    );
    if (!resolved) return waitingForSnapshot(payload.source);
    const { manifest } = resolved;
    const manifestCheckpointNeeded = resolved.checkpointNeeded;
    await deps.heartbeat?.();

    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockPostgresPrivacyObservationFence(txDb, task.agentId);
      await assertPostgresPrivacyObservationFence(txDb, task.agentId, observedPrivacyGeneration);
      const [activeSource] = await tx
        .select({ status: importSources.status, taskId: importSources.taskId })
        .from(importSources)
        .where(eq(importSources.id, sourceRow.id))
        .for('update');
      const [activeTask] = await tx
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .for('update');
      if (
        !activeSource ||
        !['pending', 'running'].includes(activeSource.status) ||
        activeSource.taskId !== task.id ||
        activeTask?.status !== 'running'
      )
        throw new Error(`import ${payload.source} was cancelled while processing`);
      await tx
        .update(importSources)
        .set({
          status: 'running',
          taskId: task.id,
          itemsTotal: manifest.windowCount,
          parseDiagnostics: manifest.diagnostics ?? null,
          updatedAt: sql`now()`,
        })
        .where(eq(importSources.id, sourceRow.id));
      await assertPostgresPrivacyObservationFence(txDb, task.agentId, observedPrivacyGeneration);
    });

    const checkpoint = async () => {
      await deps.heartbeat?.();
      plannerState.import = cursor;
      state.plannerState = plannerState;
      await db
        .update(tasks)
        .set({
          state,
          ...importProgress(payload.source, cursor, manifest.windowCount),
          // Each window is proof of progress: clear the poison-pill reclaim
          // counter so a multi-hour import that survives a few mid-run worker
          // deaths is not falsely dead-lettered (matches checkpointTask, which
          // this raw update stands in for on the code-job path).
          reclaimCount: 0,
          updatedAt: sql`now()`,
        })
        .where(eq(tasks.id, task.id));
      await db
        .update(importSources)
        .set({
          itemsProcessed: cursor.windowIndex,
          memoriesSaved: cursor.saved,
          memoriesQuarantined: cursor.quarantined,
          updatedAt: sql`now()`,
        })
        .where(eq(importSources.id, sourceRow.id));
    };

    const perRun = payload.windowsPerRun ?? WINDOWS_PER_RUN;
    const stopAt = Math.min(cursor.windowIndex + perRun, manifest.windowCount);
    let loadedShard: Awaited<ReturnType<typeof readImportShard>> | undefined;

    // Persist snapshot identity before the first paid model call. This keeps a
    // retry after an executor crash on the cheap shard path.
    if (manifestCheckpointNeeded) await checkpoint();

    while (cursor.windowIndex < stopAt) {
      await deps.heartbeat?.();
      if (
        !loadedShard ||
        cursor.windowIndex < loadedShard.start ||
        cursor.windowIndex >= loadedShard.start + loadedShard.windows.length
      ) {
        loadedShard = await readImportShard(workspace, manifest, cursor.windowIndex);
      }
      const window = loadedShard.windows[cursor.windowIndex - loadedShard.start];
      if (!window) throw new Error(`import snapshot is missing window ${cursor.windowIndex}`);
      const windowDate = window.date ? new Date(window.date) : null;

      const outcome = await distillWindow(
        router,
        task.id,
        payload.source,
        cursor.windowIndex,
        window,
      );
      await deps.heartbeat?.();
      if (outcome === null) {
        // Advance past the unstructurable window and checkpoint so a resume
        // never re-blocks on it; its facts are simply not learned.
        cursor.windowIndex += 1;
        await checkpoint();
        continue;
      }
      if (!outcome.ok) {
        // A daily/monthly cap (mode 'block') frees itself when the period
        // resets, so checkpoint and come back later — never lose progress.
        // A task-budget stop (mode 'park') is a cumulative spent-vs-limit cap
        // that NEVER resets on its own: yielding on it would re-block on the
        // next wake and re-fire this job every 6h forever, with import_sources
        // stuck 'running' so the owner can't even restart it. Mark the source
        // failed (re-runnable) and throw, so the task reaches needs_attention —
        // exactly how the model step loop treats task-budget exhaustion.
        if (outcome.decision.mode === 'park') {
          await db
            .update(importSources)
            .set({
              status: 'failed',
              error: outcome.decision.reason.slice(0, 2000),
              updatedAt: sql`now()`,
            })
            .where(eq(importSources.id, sourceRow.id));
          throw new Error(
            `import ${payload.source} exceeded its task budget and cannot continue (${outcome.decision.reason})`,
          );
        }
        // budget guard said stop — checkpoint and come back later, never lose progress
        await checkpoint();
        return {
          done: false,
          runAfter: new Date(Date.now() + BUDGET_RETRY_DELAY_MS),
          summary: `import ${payload.source}: paused by budget at window ${cursor.windowIndex}/${manifest.windowCount} (${outcome.decision.reason})`,
        };
      }

      const facts = outcome.object.facts;
      if (facts.length > 0) {
        const embeddings = await router.embed(
          facts.map((f) => f.content),
          { taskId: task.id, expectedSpace: embeddingSpace },
        );
        await deps.heartbeat?.();
        await db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          await lockPostgresPrivacyObservationFence(txDb, task.agentId);
          await assertPostgresPrivacyObservationFence(
            txDb,
            task.agentId,
            observedPrivacyGeneration,
          );
          const [activeSource] = await tx
            .select({ status: importSources.status, taskId: importSources.taskId })
            .from(importSources)
            .where(eq(importSources.id, sourceRow.id))
            .for('update');
          const [activeTask] = await tx
            .select({ status: tasks.status })
            .from(tasks)
            .where(eq(tasks.id, task.id))
            .for('update');
          if (
            activeSource?.status !== 'running' ||
            activeSource.taskId !== task.id ||
            activeTask?.status !== 'running'
          ) {
            throw new Error(`import ${payload.source} was cancelled while processing`);
          }

          for (let i = 0; i < facts.length; i++) {
            const fact = facts[i];
            const embedding = embeddings[i];
            if (!fact || !embedding) continue;

            const contentHash = createHash('sha256').update(fact.content).digest('hex');
            if (await isTombstoned(txDb, contentHash)) {
              cursor.tombstoned += 1;
              continue;
            }
            const resolved = await resolveSubjectContact(txDb, {
              subject: fact.subject,
              relationship: fact.relationship,
            });
            // Owner's own archive → origin 'owner'; but facts ABOUT third parties
            // wait in quarantine until profile review.
            const aboutOwner = fact.subject.trim().toLowerCase() === 'owner';
            const confidence = ageScaledConfidence(fact.confidence, windowDate);

            const [row] = await tx
              .insert(memories)
              .values({
                agentId: task.agentId,
                category: 'knowledge',
                kind: fact.kind,
                content: fact.content,
                contentHash,
                embedding,
                embeddingSpaceKey,
                importance: Math.min(fact.importance, 3),
                confidence: confidence.toFixed(2),
                originTrust: 'owner',
                quarantined: !aboutOwner,
                subjectContactId: resolved?.contactId,
                domain: fact.domain,
                validFrom: parseValidFrom(fact.validFrom) ?? undefined,
                source: payload.source,
                sourceTaskId: task.id,
              })
              .onConflictDoNothing({ target: memories.contentHash })
              .returning({ id: memories.id });

            const [persisted] = row
              ? [{ id: row.id }]
              : await tx
                  .select({ id: memories.id })
                  .from(memories)
                  .where(eq(memories.contentHash, contentHash))
                  .limit(1);
            if (persisted)
              await tx
                .insert(memoryImportLineage)
                .values({
                  source: payload.source,
                  memoryId: persisted.id,
                  sourceUnitProvenance: importUnitProvenance(window.units),
                })
                .onConflictDoNothing();

            if (!row) cursor.duplicates += 1;
            else {
              cursor.saved += 1;
              if (!aboutOwner) cursor.quarantined += 1;
            }
          }
          await assertPostgresPrivacyObservationFence(
            txDb,
            task.agentId,
            observedPrivacyGeneration,
          );
        });
      }

      // Occasions stated in this window (birthdays, anniversaries) — saved
      // outside the fact transaction since saveOccasion is an idempotent upsert
      // that a resumed lease can safely re-run. Third-party occasions from the
      // owner's archive quarantine for review, mirroring third-party facts.
      for (const occ of outcome.object.occasions ?? []) {
        const resolvedContact = await resolveSubjectContact(db, { subject: occ.subject });
        if (!resolvedContact) continue;
        const occAboutOwner = occ.subject.trim().toLowerCase() === 'owner';
        try {
          const savedOccasion = await db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            await lockPostgresPrivacyObservationFence(txDb, task.agentId);
            await assertPostgresPrivacyObservationFence(
              txDb,
              task.agentId,
              observedPrivacyGeneration,
            );
            const [activeSource] = await tx
              .select({ status: importSources.status, taskId: importSources.taskId })
              .from(importSources)
              .where(eq(importSources.id, sourceRow.id))
              .for('update');
            const [activeTask] = await tx
              .select({ status: tasks.status })
              .from(tasks)
              .where(eq(tasks.id, task.id))
              .for('update');
            if (
              activeSource?.status !== 'running' ||
              activeSource.taskId !== task.id ||
              activeTask?.status !== 'running'
            ) {
              throw new Error(`import ${payload.source} was cancelled while processing`);
            }
            const result = await saveOccasion(
              txDb,
              {
                agentId: task.agentId,
                contactId: resolvedContact.contactId,
                kind: occ.kind,
                label: occ.label,
                month: occ.month,
                day: occ.day,
                year: occ.year,
                notes: occ.notes,
                originTrust: 'owner',
                quarantined: !occAboutOwner,
                source: payload.source,
              },
              { generation: observedPrivacyGeneration },
            );
            await tx
              .insert(occasionImportLineage)
              .values({ source: payload.source, occasionId: result.occasion.id })
              .onConflictDoNothing();
            return result;
          });
          if (savedOccasion.saved) cursor.occasionsSaved += 1;
        } catch (err) {
          if (
            err instanceof Error &&
            (err.message.includes('cancelled while processing') ||
              err.message.includes('Privacy erasure changed') ||
              err.message.includes('Privacy erasure is in progress'))
          )
            throw err;
          console.error(`import ${payload.source}: skipping unsavable occasion`, err);
        }
      }

      cursor.windowIndex += 1;
      await checkpoint();
    }

    if (cursor.windowIndex >= manifest.windowCount) {
      await db
        .update(importSources)
        .set({ status: 'done', error: null, updatedAt: sql`now()` })
        .where(eq(importSources.id, sourceRow.id));
      // the profile card must reflect what was just learned
      await compileOwnerCard(db).catch((err) => console.error('card recompile failed', err));
      return {
        done: true,
        summary: completedSummary(
          payload.source,
          cursor,
          manifest.windowCount,
          manifest.diagnostics,
        ),
      };
    }
    return {
      done: false,
      runAfter: new Date(Date.now() + RESUME_DELAY_MS),
      summary: `import ${payload.source}: ${cursor.windowIndex}/${manifest.windowCount} windows`,
    };
  });
}

/**
 * The import run on portable persistence. Each window's memories, occasions,
 * and advanced cursor commit in one lease-fenced write, so a retry or a
 * reclaimed lease resumes after the last committed window and never saves a
 * window twice. The snapshot is the same workspace artifact as on PostgreSQL.
 */
async function runPortableImportJob(
  deps: {
    imports: ImportJobRepository;
    ownerCards?: OwnerCardCompilationRepository;
    router: ModelRouter;
    workspace: WorkspaceReader;
    heartbeat?: () => Promise<void>;
  },
  task: TaskRow,
  payload: ImportPayload,
): Promise<ImportRunResult> {
  const { imports: repository, router, workspace } = deps;
  // Read the token at each call: every heartbeat rotates it on the lease.
  const fence = (): ImportJobFence => {
    if (!task.leaseToken) throw new Error('import task has no active lease token');
    return {
      agentId: task.agentId,
      source: payload.source,
      taskId: task.id,
      queueGeneration: task.queueGeneration,
      leaseToken: task.leaseToken,
    };
  };
  const lost = () => new Error(`import ${payload.source}: task lease or source link was lost`);

  await deps.heartbeat?.();
  const loaded = await repository.load(fence());
  if (!loaded) throw lost();
  if (loaded.source.status === 'purged') {
    return { done: true, summary: `import ${payload.source}: source was purged — nothing to do` };
  }
  if (loaded.source.taskId !== task.id) {
    return { done: true, summary: `import ${payload.source}: superseded by a newer run` };
  }
  const state = (loaded.state ?? {}) as Record<string, unknown>;
  const plannerState = (state.plannerState ?? {}) as Record<string, unknown>;
  const cursor: ImportCursor = {
    windowIndex: 0,
    saved: 0,
    duplicates: 0,
    tombstoned: 0,
    quarantined: 0,
    occasionsSaved: 0,
    ...((plannerState.import as Partial<ImportCursor>) ?? {}),
  };
  const embeddingSpace = repository.embeddingSpace;
  const embeddingSpaceKey = embeddingSpaceIdentityKey(embeddingSpace);
  if (cursor.embeddingSpaceKey && cursor.embeddingSpaceKey !== embeddingSpaceKey)
    throw new Error('Import embedding space changed; resume requires the original space');
  cursor.embeddingSpaceKey = embeddingSpaceKey;

  const resolved = await resolveImportManifest(workspace, payload, task.id, cursor, async () => {
    if (!(await repository.claimSnapshotSlot(fence(), SNAPSHOT_SLOT_TTL_MS))) return null;
    try {
      return await createImportSnapshot(workspace, payload, task.id, async (path) => {
        if (!(await repository.registerSnapshotAsset(fence(), path))) throw lost();
      });
    } finally {
      await repository
        .releaseSnapshotSlot(fence())
        .catch((error) => console.error('import: failed to release snapshot slot', error));
    }
  });
  if (!resolved) return waitingForSnapshot(payload.source);
  const { manifest } = resolved;
  await deps.heartbeat?.();
  const describe = (current: ImportCursor) =>
    importProgress(payload.source, current, manifest.windowCount);
  // Persist the source status and snapshot identity before the first paid
  // model call, so a retry after a crash stays on the cheap shard path.
  if (
    !(await repository.begin(fence(), {
      itemsTotal: manifest.windowCount,
      state: { ...state, plannerState: { ...plannerState, import: cursor } },
      parseDiagnostics: manifest.diagnostics ?? null,
      ...describe(cursor),
    }))
  )
    throw lost();

  const perRun = payload.windowsPerRun ?? WINDOWS_PER_RUN;
  const stopAt = Math.min(cursor.windowIndex + perRun, manifest.windowCount);
  let loadedShard: Awaited<ReturnType<typeof readImportShard>> | undefined;
  while (cursor.windowIndex < stopAt) {
    await deps.heartbeat?.();
    if (
      !loadedShard ||
      cursor.windowIndex < loadedShard.start ||
      cursor.windowIndex >= loadedShard.start + loadedShard.windows.length
    ) {
      loadedShard = await readImportShard(workspace, manifest, cursor.windowIndex);
    }
    const window = loadedShard.windows[cursor.windowIndex - loadedShard.start];
    if (!window) throw new Error(`import snapshot is missing window ${cursor.windowIndex}`);
    const windowDate = window.date ? new Date(window.date) : null;

    const outcome = await distillWindow(
      router,
      task.id,
      payload.source,
      cursor.windowIndex,
      window,
    );
    await deps.heartbeat?.();
    const facts: ImportFactWrite[] = [];
    const sourceUnitProvenance = importUnitProvenance(window.units);
    const occasions: ImportOccasionWrite[] = [];
    if (outcome && !outcome.ok) {
      // Same budget handling as the PostgreSQL run: a task-budget stop fails
      // the source and surfaces; a period cap yields. The cursor is durable.
      if (outcome.decision.mode === 'park') {
        await repository.finish(fence(), {
          status: 'failed',
          error: outcome.decision.reason,
        });
        throw new Error(
          `import ${payload.source} exceeded its task budget and cannot continue (${outcome.decision.reason})`,
        );
      }
      return {
        done: false,
        runAfter: new Date(Date.now() + BUDGET_RETRY_DELAY_MS),
        summary: `import ${payload.source}: paused by budget at window ${cursor.windowIndex}/${manifest.windowCount} (${outcome.decision.reason})`,
      };
    }
    if (outcome) {
      const extracted = outcome.object.facts;
      const embeddings = extracted.length
        ? await router.embed(
            extracted.map((fact) => fact.content),
            { taskId: task.id, expectedSpace: embeddingSpace },
          )
        : [];
      for (const embedding of embeddings) validateEmbedding(repository.embeddingSpace, embedding);
      await deps.heartbeat?.();
      const extractedOccasions = (outcome.object.occasions ?? []).filter((occasion) => {
        if (isOccasionKind(occasion.kind) && validMonthDay(occasion.month, occasion.day))
          return true;
        console.error(`import ${payload.source}: skipping unsavable occasion`, occasion);
        return false;
      });
      const contacts = await repository.resolveSubjects(fence(), [
        ...extracted.map((fact) => ({ subject: fact.subject, relationship: fact.relationship })),
        ...extractedOccasions.map((occasion) => ({ subject: occasion.subject })),
      ]);
      for (let index = 0; index < extracted.length; index++) {
        const fact = extracted[index];
        const embedding = embeddings[index];
        if (!fact || !embedding) continue;
        // Owner's own archive → origin 'owner'; but facts ABOUT third parties
        // wait in quarantine until profile review.
        const aboutOwner = fact.subject.trim().toLowerCase() === 'owner';
        facts.push({
          content: fact.content,
          contentHash: createHash('sha256').update(fact.content).digest('hex'),
          embedding,
          embeddingSpaceKey,
          kind: fact.kind,
          domain: fact.domain,
          importance: Math.min(fact.importance, 3),
          confidence: ageScaledConfidence(fact.confidence, windowDate).toFixed(2),
          quarantined: !aboutOwner,
          subjectContactId: contacts[index] ?? null,
          validFrom: parseValidFrom(fact.validFrom),
          sourceUnitProvenance,
        });
      }
      extractedOccasions.forEach((occasion, index) => {
        const contactId = contacts[extracted.length + index];
        if (!contactId) return;
        occasions.push({
          contactId,
          kind: occasion.kind,
          label: occasion.label,
          month: occasion.month,
          day: occasion.day,
          year: occasion.year,
          notes: occasion.notes,
          quarantined: occasion.subject.trim().toLowerCase() !== 'owner',
        });
      });
    }
    // An unstructurable window commits with nothing in it, so a resume never
    // re-blocks on it; its facts are simply not learned.
    const committed = await repository.commitImportWindow(fence(), {
      windowIndex: cursor.windowIndex,
      facts,
      occasions,
      describe,
    });
    if (!committed) throw lost();
    Object.assign(cursor, committed);
  }

  if (cursor.windowIndex >= manifest.windowCount) {
    if (!(await repository.finish(fence(), { status: 'done', error: null }))) throw lost();
    // the profile card must reflect what was just learned
    if (deps.ownerCards)
      await compileOwnerCard(deps.ownerCards, task.agentId).catch((err) =>
        console.error('card recompile failed', err),
      );
    return {
      done: true,
      summary: completedSummary(payload.source, cursor, manifest.windowCount, manifest.diagnostics),
    };
  }
  return {
    done: false,
    runAfter: new Date(Date.now() + RESUME_DELAY_MS),
    summary: `import ${payload.source}: ${cursor.windowIndex}/${manifest.windowCount} windows`,
  };
}

// ── Lifecycle (dashboard + CLI entry points) ─────────────────────────────────

const DEFAULT_IMPORT_BUDGET_USD = '0.50';

/** The normalized provenance tag an import source is stored and stamped under. */
function importSourceTag(label: string): string {
  const source = label.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9._-]{2,80}$/.test(source)) {
    throw new Error('source tag must be 2-80 chars of letters/digits/._-');
  }
  return source;
}

/** startImport on portable persistence: the source row and its task commit together. */
export function startPortableImport(
  repository: ImportCommandRepository,
  input: {
    source: string;
    workspacePath: string;
    kind: ImportKind;
    budgetUsdLimit?: string;
    windowsPerRun?: number;
    windowChars?: number;
  },
): Promise<{ sourceId: string; taskId: string }> {
  return repository.start({
    source: importSourceTag(input.source),
    workspacePath: input.workspacePath,
    kind: input.kind,
    job: 'import.run',
    payload: {
      ...(input.windowsPerRun ? { windowsPerRun: input.windowsPerRun } : {}),
      ...(input.windowChars ? { windowChars: input.windowChars } : {}),
    },
    budgetUsdLimit: input.budgetUsdLimit ?? DEFAULT_IMPORT_BUDGET_USD,
  });
}

/**
 * Register (or re-run) an import source and enqueue its resumable job task.
 * Re-running a done/failed source resets counters and relies on content-hash
 * dedupe — already-saved memories are skipped, not duplicated.
 */
export async function startImport(
  db: Db,
  input: {
    agentId: string;
    source: string;
    workspacePath: string;
    kind: ImportKind;
    budgetUsdLimit?: string;
    windowsPerRun?: number;
    windowChars?: number;
  },
): Promise<{ sourceRow: ImportSourceRow; taskId: string }> {
  const source = importSourceTag(input.source);

  const result = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`assistant:import-source:${source}`}))`,
    );
    const [existing] = await tx
      .select()
      .from(importSources)
      .where(eq(importSources.source, source))
      .for('update');
    const sourceHash = sha256(source);
    const [deletion] = await tx
      .select({ name: maintenanceCursors.name })
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, importDeletionJobName(input.agentId, sourceHash)))
      .for('update');
    const [purge] = await tx
      .select({ name: maintenanceCursors.name })
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, importDeletionJobName(input.agentId, sourceHash, 'purge')))
      .for('update');
    if (deletion || purge) throw new Error(`import "${source}" is being removed`);
    // A completed deletion receipt is only an idempotency response for the
    // old source incarnation. Clear it atomically when a new import starts.
    await tx
      .delete(maintenanceCursors)
      .where(
        inArray(maintenanceCursors.name, [
          importDeletionResultName(input.agentId, sourceHash, 'delete'),
          importDeletionResultName(input.agentId, sourceHash, 'purge'),
        ]),
      );
    if (existing?.status === 'running' || existing?.status === 'pending') {
      throw new Error(`import "${source}" is already ${existing.status}`);
    }

    const [sourceRow] = existing
      ? await tx
          .update(importSources)
          .set({
            workspacePath: input.workspacePath,
            kind: input.kind,
            status: 'pending',
            itemsProcessed: 0,
            memoriesSaved: 0,
            memoriesQuarantined: 0,
            error: null,
            updatedAt: sql`now()`,
          })
          .where(eq(importSources.id, existing.id))
          .returning()
      : await tx
          .insert(importSources)
          .values({
            agentId: input.agentId,
            source,
            workspacePath: input.workspacePath,
            kind: input.kind,
          })
          .returning();
    if (!sourceRow) throw new Error('import source upsert failed');

    const { task } = await enqueueTask(txDb, {
      event: {
        source: 'internal',
        agentId: input.agentId,
        trust: 'owner',
        payload: {
          job: 'import.run',
          source,
          path: input.workspacePath,
          kind: input.kind,
          ...(input.windowsPerRun ? { windowsPerRun: input.windowsPerRun } : {}),
          ...(input.windowChars ? { windowChars: input.windowChars } : {}),
        },
      },
      type: 'adhoc',
      budgetUsdLimit: input.budgetUsdLimit ?? DEFAULT_IMPORT_BUDGET_USD,
      deferNotification: true,
    });
    const [linkedSource] = await tx
      .update(importSources)
      .set({ taskId: task.id, updatedAt: sql`now()` })
      .where(eq(importSources.id, sourceRow.id))
      .returning();
    if (!linkedSource) throw new Error('failed to link import task');
    return { sourceRow: linkedSource, task };
  });

  getQueueNotifier().notify(result.task.id, result.task.queueGeneration);
  return { sourceRow: result.sourceRow, taskId: result.task.id };
}

/**
 * Purge removes learned projections but retains the uploaded archive and
 * parsed snapshot. It shares the durable bounded traversal with delete so a
 * crash cannot strand a partially removed graph or let a stale importer publish.
 */
export async function purgeImportSource(db: Db, source: string): Promise<{ purged: number }> {
  const initial = await beginImportDeletion(db, source, 'purge');
  let purged = initial.purgedMemories;
  if (purged === null) {
    let complete = false;
    while (!complete) {
      const page = await advanceImportDeletionPage(db, {
        agentId: initial.agentId,
        source,
        sourceId: initial.sourceId,
        sourceHash: initial.sourceHash,
        operation: 'purge',
      });
      complete = page.complete;
      purged = page.purgedMemories;
    }
  }
  if (purged === null) throw new Error('Import purge did not produce a result');
  await compileOwnerCard(db).catch((err) => console.error('card recompile failed', err));
  return { purged };
}

async function queueImportDeletionAssets(
  tx: Db,
  agentId: string,
  sourceId: string,
  paths: Array<string | null>,
): Promise<void> {
  const distinct = [...new Set(paths.filter((path): path is string => !!path))];
  if (distinct.length > IMPORT_DELETE_PAGE_SIZE)
    throw new Error('Import deletion asset page exceeded its bounded write limit');
  if (!distinct.length) return;
  await tx
    .insert(maintenanceCursors)
    .values(
      distinct.map((path) => ({
        name: `${PRIVACY_ASSET_PREFIX}${agentId}:${DELETE_ASSET_ID_PREFIX}${sourceId}:${sha256(path)}`,
        cursor: path,
      })),
    )
    .onConflictDoNothing({ target: maintenanceCursors.name });
}

function validImportSourceArchivePath(path: string): boolean {
  const parts = path.split('/');
  return (
    path.startsWith('import/') &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !parts.some((part) => !part || part === '.' || part === '..')
  );
}

function validImportSnapshotAsset(
  source: string,
  sourceId: string,
  assetName: string,
  path: string | null,
): path is string {
  if (!path || path.startsWith('/') || path.includes('\\')) return false;
  const parts = path.split('/');
  if (
    !path.startsWith(`.assistant/imports/${source}/`) ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(parts[3] ?? '') ||
    parts.length !== 5 ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    return false;
  const filename = parts[4];
  return (
    (filename === 'manifest.json' || /^windows-\d{6}\.json$/.test(filename ?? '')) &&
    assetName ===
      `${SNAPSHOT_ASSET_PREFIX}${sourceId}:${createHash('sha256').update(path).digest('hex')}`
  );
}

function importDeletionJobName(
  agentId: string,
  sourceHash: string,
  operation: 'delete' | 'purge' = 'delete',
): string {
  return `${operation === 'purge' ? IMPORT_PURGE_JOB_PREFIX : IMPORT_DELETE_JOB_PREFIX}${agentId}:${sourceHash}`;
}

function importDeletionNodePrefix(
  agentId: string,
  sourceHash: string,
  operation: 'delete' | 'purge' = 'delete',
): string {
  return `${operation === 'purge' ? IMPORT_PURGE_NODE_PREFIX : IMPORT_DELETE_NODE_PREFIX}${agentId}:${sourceHash}:`;
}

function importDeletionResultName(
  agentId: string,
  sourceHash: string,
  operation: 'delete' | 'purge',
): string {
  return `${operation === 'purge' ? IMPORT_PURGE_RESULT_PREFIX : IMPORT_DELETE_RESULT_PREFIX}${agentId}:${sourceHash}`;
}

function parseImportDeleteProgress(value: string | null): ImportDeleteProgress {
  if (!value || value.length > 2_000) throw new Error('Import deletion progress is malformed');
  const parsed = JSON.parse(value) as Partial<ImportDeleteProgress>;
  const phases: ImportDeletePhase[] = [
    'assets',
    'seed_direct',
    'seed_lineage',
    'discover',
    'detach',
    'delete',
    'occasions',
    'cleanup_nodes',
  ];
  const operation = parsed.operation ?? 'delete';
  if (
    parsed.version !== 1 ||
    (operation !== 'delete' && operation !== 'purge') ||
    typeof parsed.sourceId !== 'string' ||
    typeof parsed.sourceHash !== 'string' ||
    !phases.includes(parsed.phase as ImportDeletePhase) ||
    !Number.isSafeInteger(parsed.nodeCount) ||
    (parsed.nodeCount as number) < 0 ||
    !Number.isSafeInteger(parsed.purgedMemories) ||
    (parsed.purgedMemories as number) < 0
  )
    throw new Error('Import deletion progress is malformed');
  for (const cursor of [
    parsed.assetCursor,
    parsed.directCursor,
    parsed.lineageCursor,
    parsed.detachNodeCursor,
    parsed.detachPredecessorCursor,
    parsed.nodeRestoreCursor,
    parsed.predecessorCursor,
    parsed.occasionCursor,
    parsed.cleanupCursor,
  ])
    if (cursor !== null && typeof cursor !== 'string')
      throw new Error('Import deletion progress cursor is malformed');
  return { ...parsed, operation } as ImportDeleteProgress;
}

async function enqueueImportDeletionNodes(tx: Db, prefix: string, ids: string[]): Promise<number> {
  const names = [...new Set(ids)].map((id) => `${prefix}${id}`);
  if (!names.length) return 0;
  const inserted = await tx
    .insert(maintenanceCursors)
    .values(names.map((name) => ({ name, cursor: 'queued' })))
    .onConflictDoNothing({ target: maintenanceCursors.name })
    .returning({ name: maintenanceCursors.name });
  return inserted.length;
}

/**
 * Advance one bounded page of the PostgreSQL import-removal state machine.
 * Every private projection mutation and progress receipt update commits in the
 * same transaction; a process restart resumes from the durable cursor.
 */
async function advanceImportDeletionPage(
  db: Db,
  input: {
    agentId: string;
    source: string;
    sourceId: string;
    sourceHash: string;
    operation: 'delete' | 'purge';
  },
): Promise<{ complete: boolean; purgedMemories: number }> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await lockPostgresPrivacyObservationFence(txDb, input.agentId);
    const jobName = importDeletionJobName(input.agentId, input.sourceHash, input.operation);
    const [job] = await tx
      .select({ cursor: maintenanceCursors.cursor })
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, jobName))
      .for('update');
    if (!job) throw new Error('Import deletion progress is unavailable');
    const progress = parseImportDeleteProgress(job.cursor);
    if (
      progress.sourceId !== input.sourceId ||
      progress.sourceHash !== input.sourceHash ||
      progress.operation !== input.operation
    )
      throw new Error('Import deletion progress belongs to another source');
    const nodePrefix = importDeletionNodePrefix(input.agentId, input.sourceHash, input.operation);
    const [sourceRow] = await tx
      .select({
        id: importSources.id,
        agentId: importSources.agentId,
        status: importSources.status,
      })
      .from(importSources)
      .where(eq(importSources.id, input.sourceId))
      .for('share');
    if (!sourceRow || sourceRow.agentId !== input.agentId || sourceRow.status !== 'purged')
      throw new Error('Import source deletion fence is unavailable');

    const saveProgress = async (next: ImportDeleteProgress) => {
      await tx
        .update(maintenanceCursors)
        .set({ cursor: JSON.stringify(next), updatedAt: new Date() })
        .where(eq(maintenanceCursors.name, jobName));
    };
    const advance = async (next: ImportDeleteProgress) => {
      await saveProgress(next);
      return { complete: false, purgedMemories: next.purgedMemories };
    };

    if (progress.phase === 'assets') {
      // Purge deliberately retains the uploaded archive and parsed snapshots so
      // the owner can rerun the import. It still shares the bounded projection
      // cleanup state machine used by full deletion.
      if (input.operation === 'purge')
        return advance({ ...progress, phase: 'seed_direct', assetCursor: null });
      const assetPrefix = `${SNAPSHOT_ASSET_PREFIX}${input.sourceId}:`;
      const rows = await tx
        .select({ name: maintenanceCursors.name, path: maintenanceCursors.cursor })
        .from(maintenanceCursors)
        .where(
          and(
            like(maintenanceCursors.name, `${assetPrefix}%`),
            progress.assetCursor ? gt(maintenanceCursors.name, progress.assetCursor) : undefined,
          ),
        )
        .orderBy(asc(maintenanceCursors.name))
        .limit(IMPORT_DELETE_PAGE_SIZE);
      for (const row of rows) {
        if (!validImportSnapshotAsset(input.source, input.sourceId, row.name, row.path))
          throw new Error('Import snapshot cleanup path or identity is invalid');
      }
      await queueImportDeletionAssets(
        txDb,
        input.agentId,
        input.sourceId,
        rows.map((row) => row.path),
      );
      if (rows.length)
        await tx.delete(maintenanceCursors).where(
          inArray(
            maintenanceCursors.name,
            rows.map((row) => row.name),
          ),
        );
      if (rows.length === IMPORT_DELETE_PAGE_SIZE)
        return advance({ ...progress, assetCursor: rows.at(-1)?.name ?? null });
      return advance({ ...progress, phase: 'seed_direct', assetCursor: null });
    }

    if (progress.phase === 'seed_direct') {
      const rows = await tx
        .select({ id: memories.id, agentId: memories.agentId })
        .from(memories)
        .where(
          and(
            eq(memories.source, input.source),
            progress.directCursor ? gt(memories.id, progress.directCursor) : undefined,
          ),
        )
        .orderBy(asc(memories.id))
        .limit(IMPORT_DELETE_PAGE_SIZE);
      if (!rows.length) return advance({ ...progress, phase: 'seed_lineage' });
      if (rows.some((row) => row.agentId !== input.agentId))
        throw new Error('Import source memory belongs to another agent');
      const added = await enqueueImportDeletionNodes(
        txDb,
        nodePrefix,
        rows.map((row) => row.id),
      );
      const nodeCount = progress.nodeCount + added;
      if (nodeCount > MAX_IMPORT_DELETE_NODES)
        throw new Error('Import deletion exceeds its explicit 100000-memory limit');
      return advance({ ...progress, nodeCount, directCursor: rows.at(-1)?.id ?? null });
    }

    if (progress.phase === 'seed_lineage') {
      const rows = await tx
        .select({ memoryId: memoryImportLineage.memoryId })
        .from(memoryImportLineage)
        .where(
          and(
            eq(memoryImportLineage.source, input.source),
            progress.lineageCursor
              ? gt(memoryImportLineage.memoryId, progress.lineageCursor)
              : undefined,
          ),
        )
        .orderBy(asc(memoryImportLineage.memoryId))
        .limit(IMPORT_DELETE_PAGE_SIZE);
      if (!rows.length) return advance({ ...progress, phase: 'discover' });
      const linked = await tx
        .select({ id: memories.id, agentId: memories.agentId })
        .from(memories)
        .where(
          inArray(
            memories.id,
            rows.map((row) => row.memoryId),
          ),
        );
      const byId = new Map(linked.map((row) => [row.id, row.agentId]));
      if (rows.some((row) => byId.get(row.memoryId) !== input.agentId))
        throw new Error('Import memory lineage is missing or belongs to another agent');
      const added = await enqueueImportDeletionNodes(
        txDb,
        nodePrefix,
        rows.map((row) => row.memoryId),
      );
      const nodeCount = progress.nodeCount + added;
      if (nodeCount > MAX_IMPORT_DELETE_NODES)
        throw new Error('Import deletion exceeds its explicit 100000-memory limit');
      return advance({ ...progress, nodeCount, lineageCursor: rows.at(-1)?.memoryId ?? null });
    }

    if (progress.phase === 'discover') {
      const queued = await tx
        .select({ name: maintenanceCursors.name })
        .from(maintenanceCursors)
        .where(
          and(
            like(maintenanceCursors.name, `${nodePrefix}%`),
            eq(maintenanceCursors.cursor, 'queued'),
          ),
        )
        .orderBy(asc(maintenanceCursors.name))
        .limit(IMPORT_DELETE_PAGE_SIZE);
      if (!queued.length) return advance({ ...progress, phase: 'detach' });
      const ids = queued.map(({ name }) => {
        if (!name.startsWith(nodePrefix)) throw new Error('Import deletion node is malformed');
        return name.slice(nodePrefix.length);
      });
      if (ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id)))
        throw new Error('Import deletion node identity is malformed');
      const current = await tx
        .select({
          id: memories.id,
          agentId: memories.agentId,
          supersededById: memories.supersededById,
        })
        .from(memories)
        .where(inArray(memories.id, ids));
      if (current.some((row) => row.agentId !== input.agentId))
        throw new Error('Import deletion encountered a foreign-owned memory');
      const successors = current
        .map((row) => row.supersededById)
        .filter((id): id is string => Boolean(id));
      const successorRows = successors.length
        ? await tx
            .select({ id: memories.id, agentId: memories.agentId })
            .from(memories)
            .where(inArray(memories.id, [...new Set(successors)]))
        : [];
      if (successorRows.some((row) => row.agentId !== input.agentId))
        throw new Error('Import deletion successor is owned by another agent');
      const added = await enqueueImportDeletionNodes(
        txDb,
        nodePrefix,
        successorRows.map((row) => row.id),
      );
      const nodeCount = progress.nodeCount + added;
      if (nodeCount > MAX_IMPORT_DELETE_NODES)
        throw new Error('Import deletion exceeds its explicit 100000-memory limit');
      await tx
        .update(maintenanceCursors)
        .set({ cursor: 'expanded', updatedAt: new Date() })
        .where(
          inArray(
            maintenanceCursors.name,
            queued.map((row) => row.name),
          ),
        );
      return advance({ ...progress, nodeCount });
    }

    if (progress.phase === 'detach') {
      const nodeAfter = progress.detachNodeCursor ?? nodePrefix;
      const [node] = await tx
        .select({ name: maintenanceCursors.name })
        .from(maintenanceCursors)
        .where(
          and(
            like(maintenanceCursors.name, `${nodePrefix}%`),
            eq(maintenanceCursors.cursor, 'expanded'),
            gt(maintenanceCursors.name, nodeAfter),
          ),
        )
        .orderBy(asc(maintenanceCursors.name))
        .limit(1);
      if (!node) return advance({ ...progress, phase: 'delete' });
      const nodeId = node.name.slice(nodePrefix.length);
      const predecessorRows = await tx
        .select({ id: memories.id, agentId: memories.agentId })
        .from(memories)
        .where(
          and(
            eq(memories.supersededById, nodeId),
            progress.detachPredecessorCursor
              ? gt(memories.id, progress.detachPredecessorCursor)
              : undefined,
          ),
        )
        .orderBy(asc(memories.id))
        .limit(IMPORT_DELETE_PAGE_SIZE);
      if (predecessorRows.some((row) => row.agentId !== input.agentId))
        throw new Error('Import deletion predecessor is owned by another agent');
      if (predecessorRows.length) {
        const predecessorIds = predecessorRows.map((row) => row.id);
        const closureRows = await tx
          .select({ name: maintenanceCursors.name })
          .from(maintenanceCursors)
          .where(
            inArray(
              maintenanceCursors.name,
              predecessorIds.map((id) => `${nodePrefix}${id}`),
            ),
          );
        const closureNames = new Set(closureRows.map((row) => row.name));
        const externalIds = predecessorIds.filter((id) => !closureNames.has(`${nodePrefix}${id}`));
        if (externalIds.length)
          await tx
            .update(memories)
            .set({ supersededById: null, expiresAt: null })
            .where(
              and(
                eq(memories.agentId, input.agentId),
                eq(memories.supersededById, nodeId),
                inArray(memories.id, externalIds),
              ),
            );
        const closureIds = predecessorIds.filter((id) => closureNames.has(`${nodePrefix}${id}`));
        if (closureIds.length)
          await tx
            .update(memories)
            .set({ supersededById: null })
            .where(
              and(
                eq(memories.agentId, input.agentId),
                eq(memories.supersededById, nodeId),
                inArray(memories.id, closureIds),
              ),
            );
      }
      if (predecessorRows.length === IMPORT_DELETE_PAGE_SIZE)
        return advance({
          ...progress,
          detachPredecessorCursor: predecessorRows.at(-1)?.id ?? null,
        });
      return advance({
        ...progress,
        detachNodeCursor: node.name,
        detachPredecessorCursor: null,
      });
    }

    if (progress.phase === 'delete') {
      const expanded = await tx
        .select({ name: maintenanceCursors.name })
        .from(maintenanceCursors)
        .where(
          and(
            like(maintenanceCursors.name, `${nodePrefix}%`),
            eq(maintenanceCursors.cursor, 'expanded'),
          ),
        )
        .orderBy(asc(maintenanceCursors.name))
        .limit(IMPORT_DELETE_PAGE_SIZE);
      if (!expanded.length) return advance({ ...progress, phase: 'occasions' });
      const names = expanded.map((row) => row.name);
      const ids = names.map((name) => name.slice(nodePrefix.length));
      if (ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id)))
        throw new Error('Import deletion node identity is malformed');
      const rows = await tx
        .select({ id: memories.id, agentId: memories.agentId })
        .from(memories)
        .where(inArray(memories.id, ids));
      if (rows.some((row) => row.agentId !== input.agentId))
        throw new Error('Import deletion encountered a foreign-owned memory');
      await tx
        .delete(knowledgeGraphRelations)
        .where(inArray(knowledgeGraphRelations.sourceMemoryId, ids));
      const deleted = await tx
        .delete(memories)
        .where(and(eq(memories.agentId, input.agentId), inArray(memories.id, ids)))
        .returning({ id: memories.id });
      await tx
        .update(maintenanceCursors)
        .set({ cursor: 'deleted', updatedAt: new Date() })
        .where(inArray(maintenanceCursors.name, names));
      const purgedMemories = progress.purgedMemories + deleted.length;
      if (purgedMemories > MAX_IMPORT_DELETE_NODES)
        throw new Error('Import deletion exceeds its explicit 100000-memory limit');
      return advance({ ...progress, purgedMemories });
    }

    if (progress.phase === 'occasions') {
      const [direct, linked] = await Promise.all([
        tx
          .select({ id: occasions.id, agentId: occasions.agentId })
          .from(occasions)
          .where(
            and(
              eq(occasions.source, input.source),
              progress.occasionCursor ? gt(occasions.id, progress.occasionCursor) : undefined,
            ),
          )
          .orderBy(asc(occasions.id))
          .limit(IMPORT_DELETE_PAGE_SIZE),
        tx
          .select({ id: occasionImportLineage.occasionId })
          .from(occasionImportLineage)
          .where(
            and(
              eq(occasionImportLineage.source, input.source),
              progress.occasionCursor
                ? gt(occasionImportLineage.occasionId, progress.occasionCursor)
                : undefined,
            ),
          )
          .orderBy(asc(occasionImportLineage.occasionId))
          .limit(IMPORT_DELETE_PAGE_SIZE),
      ]);
      if (direct.some((row) => row.agentId !== input.agentId))
        throw new Error('Import source occasion belongs to another agent');
      const linkedRows = linked.length
        ? await tx
            .select({ id: occasions.id, agentId: occasions.agentId })
            .from(occasions)
            .where(
              inArray(
                occasions.id,
                linked.map((row) => row.id),
              ),
            )
        : [];
      const linkedOwners = new Map(linkedRows.map((row) => [row.id, row.agentId]));
      if (linked.some((row) => linkedOwners.get(row.id) !== input.agentId))
        throw new Error('Import deletion occasion lineage is missing or belongs to another agent');
      const ids = [...new Set([...direct.map((row) => row.id), ...linked.map((row) => row.id)])]
        .sort()
        .slice(0, IMPORT_DELETE_PAGE_SIZE);
      if (!ids.length) return advance({ ...progress, phase: 'cleanup_nodes' });
      await tx
        .delete(occasions)
        .where(and(eq(occasions.agentId, input.agentId), inArray(occasions.id, ids)));
      await tx
        .delete(occasionImportLineage)
        .where(
          and(
            eq(occasionImportLineage.source, input.source),
            inArray(occasionImportLineage.occasionId, ids),
          ),
        );
      return advance({ ...progress, occasionCursor: ids.at(-1) ?? null });
    }

    if (progress.phase === 'cleanup_nodes') {
      const rows = await tx
        .select({ name: maintenanceCursors.name })
        .from(maintenanceCursors)
        .where(
          and(
            like(maintenanceCursors.name, `${nodePrefix}%`),
            progress.cleanupCursor
              ? gt(maintenanceCursors.name, progress.cleanupCursor)
              : undefined,
          ),
        )
        .orderBy(asc(maintenanceCursors.name))
        .limit(IMPORT_DELETE_PAGE_SIZE);
      if (rows.length) {
        const names = rows.map((row) => row.name);
        await tx.delete(maintenanceCursors).where(inArray(maintenanceCursors.name, names));
        return advance({ ...progress, cleanupCursor: names.at(-1) ?? null });
      }
      // A final same-owner check catches a late writer or inconsistent index
      // before the source row and its retry fence are removed.
      const [remainingMemory] = await tx
        .select({ id: memories.id, agentId: memories.agentId })
        .from(memories)
        .where(eq(memories.source, input.source))
        .limit(1);
      if (remainingMemory && remainingMemory.agentId !== input.agentId)
        throw new Error('Import source memory belongs to another agent');
      const [remainingLineage] = await tx
        .select({ id: memoryImportLineage.memoryId })
        .from(memoryImportLineage)
        .where(eq(memoryImportLineage.source, input.source))
        .limit(1);
      const [remainingOccasion] = await tx
        .select({ id: occasions.id, agentId: occasions.agentId })
        .from(occasions)
        .where(eq(occasions.source, input.source))
        .limit(1);
      if (remainingOccasion && remainingOccasion.agentId !== input.agentId)
        throw new Error('Import source occasion belongs to another agent');
      const [remainingOccasionLineage] = await tx
        .select({ id: occasionImportLineage.occasionId })
        .from(occasionImportLineage)
        .where(eq(occasionImportLineage.source, input.source))
        .limit(1);
      if (remainingMemory || remainingLineage || remainingOccasion || remainingOccasionLineage)
        return advance({
          ...progress,
          phase: 'seed_direct',
          assetCursor: null,
          directCursor: null,
          lineageCursor: null,
          detachNodeCursor: null,
          detachPredecessorCursor: null,
          nodeRestoreCursor: null,
          predecessorCursor: null,
          occasionCursor: null,
          cleanupCursor: null,
        });
      if (input.operation === 'purge') {
        await tx
          .update(importSources)
          .set({
            status: 'purged',
            memoriesSaved: 0,
            memoriesQuarantined: 0,
            updatedAt: new Date(),
          })
          .where(
            and(eq(importSources.id, input.sourceId), eq(importSources.agentId, input.agentId)),
          );
      } else {
        await tx.delete(importSources).where(eq(importSources.id, input.sourceId));
      }
      await tx
        .insert(maintenanceCursors)
        .values({
          name: importDeletionResultName(input.agentId, input.sourceHash, input.operation),
          cursor: JSON.stringify({
            sourceId: input.sourceId,
            purgedMemories: progress.purgedMemories,
          }),
        })
        .onConflictDoUpdate({
          target: maintenanceCursors.name,
          set: {
            cursor: JSON.stringify({
              sourceId: input.sourceId,
              purgedMemories: progress.purgedMemories,
            }),
            updatedAt: new Date(),
          },
        });
      await tx.delete(maintenanceCursors).where(eq(maintenanceCursors.name, jobName));
      return { complete: true, purgedMemories: progress.purgedMemories };
    }

    throw new Error('Unknown import deletion phase');
  });
}

async function beginImportDeletion(
  db: Db,
  source: string,
  operation: 'delete' | 'purge' = 'delete',
): Promise<{
  agentId: string;
  sourceId: string;
  sourceHash: string;
  purgedMemories: number | null;
}> {
  const sourceHash = sha256(source);
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const owners = await tx.select({ id: agents.id }).from(agents).limit(2).for('no key update');
    if (owners.length !== 1 || !owners[0])
      throw new Error('Import deletion requires one configured owner');
    const agentId = owners[0].id;
    await lockPostgresPrivacyObservationFence(txDb, agentId);
    // Source starts, snapshot publication, and deletion use the same lock
    // order so a worker cannot publish a snapshot after the deletion fence.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('assistant:import-snapshot'))`);
    const jobName = importDeletionJobName(agentId, sourceHash, operation);
    const otherJobName = importDeletionJobName(
      agentId,
      sourceHash,
      operation === 'purge' ? 'delete' : 'purge',
    );
    const [otherJob] = await tx
      .select({ cursor: maintenanceCursors.cursor })
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, otherJobName))
      .for('update');
    if (otherJob) throw new Error('Another import source removal is already in progress');
    const [job] = await tx
      .select({ cursor: maintenanceCursors.cursor })
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, jobName))
      .for('update');
    if (job) {
      const progress = parseImportDeleteProgress(job.cursor);
      if (progress.sourceHash !== sourceHash || progress.operation !== operation)
        throw new Error('Import deletion progress belongs to another source');
      const [sourceRow] = await tx
        .select({
          id: importSources.id,
          agentId: importSources.agentId,
          status: importSources.status,
        })
        .from(importSources)
        .where(eq(importSources.id, progress.sourceId));
      if (!sourceRow || sourceRow.agentId !== agentId || sourceRow.status !== 'purged')
        throw new Error('Import deletion progress lost its source fence');
      return { agentId, sourceId: progress.sourceId, sourceHash, purgedMemories: null };
    }

    const [sourceRow] = await tx
      .select()
      .from(importSources)
      .where(and(eq(importSources.source, source), eq(importSources.agentId, agentId)))
      .for('update');

    const resultName = importDeletionResultName(agentId, sourceHash, operation);
    const [previous] = await tx
      .select({ cursor: maintenanceCursors.cursor })
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, resultName))
      .limit(1);
    if (previous?.cursor && (!sourceRow || operation === 'purge')) {
      if (previous.cursor.length > 500) throw new Error('Import deletion result is malformed');
      const parsed = JSON.parse(previous.cursor) as {
        sourceId?: unknown;
        purgedMemories?: unknown;
      };
      if (
        typeof parsed.sourceId !== 'string' ||
        !Number.isSafeInteger(parsed.purgedMemories) ||
        (parsed.purgedMemories as number) < 0
      )
        throw new Error('Import deletion result is malformed');
      if (!sourceRow || (sourceRow.id === parsed.sourceId && sourceRow.status === 'purged'))
        return {
          agentId,
          sourceId: parsed.sourceId,
          sourceHash,
          purgedMemories: parsed.purgedMemories as number,
        };
    }

    if (!sourceRow) throw new Error(`unknown import source: ${source}`);
    if (previous?.cursor)
      await tx.delete(maintenanceCursors).where(eq(maintenanceCursors.name, resultName));
    if (sourceRow.taskId) {
      await tx
        .update(tasks)
        .set({ status: 'cancelled', lockedUntil: null, runAfter: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(tasks.id, sourceRow.taskId),
            eq(tasks.agentId, agentId),
            inArray(tasks.status, ['pending', 'sleeping', 'running', 'needs_attention']),
          ),
        );
    }
    if (!validImportSourceArchivePath(sourceRow.workspacePath))
      throw new Error('Import source archive path is invalid');
    if (operation === 'delete')
      await queueImportDeletionAssets(txDb, agentId, sourceRow.id, [sourceRow.workspacePath]);
    await tx
      .update(importSources)
      .set({ status: 'purged', updatedAt: sql`now()` })
      .where(and(eq(importSources.id, sourceRow.id), eq(importSources.agentId, agentId)));
    const progress: ImportDeleteProgress = {
      version: 1,
      operation,
      sourceId: sourceRow.id,
      sourceHash,
      phase: 'assets',
      assetCursor: null,
      directCursor: null,
      lineageCursor: null,
      detachNodeCursor: null,
      detachPredecessorCursor: null,
      nodeRestoreCursor: null,
      predecessorCursor: null,
      occasionCursor: null,
      cleanupCursor: null,
      nodeCount: 0,
      purgedMemories: 0,
    };
    await tx.insert(maintenanceCursors).values({ name: jobName, cursor: JSON.stringify(progress) });
    return { agentId, sourceId: sourceRow.id, sourceHash, purgedMemories: null };
  });
}

/** Retry import deletion intents after restart; failures remain durable for Forget as well. */
export async function drainImportDeletionAssets(
  db: Db,
  workspace?: { delete(relPath: string): Promise<void> },
): Promise<boolean> {
  const owner = await db.select({ id: agents.id }).from(agents).limit(2);
  if (owner.length !== 1 || !owner[0])
    throw new Error('Import deletion requires one configured owner');
  const prefix = `${PRIVACY_ASSET_PREFIX}${owner[0].id}:${DELETE_ASSET_ID_PREFIX}%`;
  const assets = await db
    .select({ name: maintenanceCursors.name, path: maintenanceCursors.cursor })
    .from(maintenanceCursors)
    .where(like(maintenanceCursors.name, prefix))
    .orderBy(asc(maintenanceCursors.name))
    .limit(IMPORT_DELETE_PAGE_SIZE);
  if (!workspace) return assets.length > 0;
  for (const asset of assets) {
    if (!asset.path) continue;
    try {
      await workspace.delete(asset.path);
      await db.delete(maintenanceCursors).where(eq(maintenanceCursors.name, asset.name));
    } catch {
      // Keep the path private and retryable; the caller sees only pending=true.
    }
  }
  const remaining = await db
    .select({ name: maintenanceCursors.name })
    .from(maintenanceCursors)
    .where(like(maintenanceCursors.name, prefix))
    .limit(1);
  return remaining.length > 0;
}

/**
 * Delete an import source: atomically cancel its task, erase the source and
 * transitive derived projections, and persist every raw workspace path in the
 * owner erasure outbox before dropping the source row.
 */
export async function deleteImportSource(
  db: Db,
  source: string,
  workspace?: { delete(relPath: string): Promise<void> },
): Promise<{ purgedMemories: number; pendingAssets: boolean }> {
  const initial = await beginImportDeletion(db, source, 'delete');
  let purgedMemories = initial.purgedMemories;
  if (purgedMemories === null) {
    let complete = false;
    while (!complete) {
      const page = await advanceImportDeletionPage(db, {
        agentId: initial.agentId,
        source,
        sourceId: initial.sourceId,
        sourceHash: initial.sourceHash,
        operation: 'delete',
      });
      complete = page.complete;
      purgedMemories = page.purgedMemories;
    }
  }
  if (purgedMemories === null) throw new Error('Import deletion did not produce a result');
  const result = { agentId: initial.agentId, sourceId: initial.sourceId, purgedMemories };
  await drainImportDeletionAssets(db, workspace);
  const owner = await db.select({ id: agents.id }).from(agents).limit(2);
  if (owner.length !== 1 || !owner[0])
    throw new Error('Import deletion requires one configured owner');
  const pending = await db
    .select({ name: maintenanceCursors.name })
    .from(maintenanceCursors)
    .where(
      like(
        maintenanceCursors.name,
        `${PRIVACY_ASSET_PREFIX}${owner[0].id}:${DELETE_ASSET_ID_PREFIX}${result.sourceId}:%`,
      ),
    )
    .limit(1);
  const pendingAssets = pending.length > 0;
  await compileOwnerCard(db).catch((err) => console.error('card recompile failed', err));
  return { purgedMemories: result.purgedMemories, pendingAssets };
}

/**
 * Batch quarantine review by source: approve releases all quarantined facts
 * from this source; reject deletes them AND tombstones their hashes.
 */
export async function reviewImportSource(
  db: Db,
  source: string,
  verdict: 'approve' | 'reject',
): Promise<{ reviewed: number }> {
  const quarantined = await db
    .select({ id: memories.id, contentHash: memories.contentHash })
    .from(memories)
    .where(and(eq(memories.source, source), eq(memories.quarantined, true)));
  if (quarantined.length === 0) return { reviewed: 0 };

  if (verdict === 'approve') {
    await db
      .update(memories)
      .set({ quarantined: false })
      .where(and(eq(memories.source, source), eq(memories.quarantined, true)));
  } else {
    for (const row of quarantined) await addTombstone(db, row.contentHash, 'quarantine_reject');
    await db.delete(memories).where(
      inArray(
        memories.id,
        quarantined.map((r) => r.id),
      ),
    );
  }
  await db
    .update(importSources)
    .set({ memoriesQuarantined: 0, updatedAt: sql`now()` })
    .where(eq(importSources.source, source));
  await compileOwnerCard(db).catch((err) => console.error('card recompile failed', err));
  return { reviewed: quarantined.length };
}
