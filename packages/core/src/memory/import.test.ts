import { createHash, randomUUID } from 'node:crypto';
import {
  agents,
  contacts,
  createDb,
  type Db,
  importSources,
  maintenanceCursors,
  memories,
  memoryImportLineage,
  occasions,
  tasks,
} from '@assistant/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import type { DispatcherPort } from '../workflow/executor.js';
import { executeTask } from '../workflow/executor.js';
import {
  deleteImportSource,
  purgeImportSource,
  reviewImportSource,
  startImport,
  type WorkspaceReader,
} from './import.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

const SOURCE = 'xtest-import-archive';
const MARKER = 'xtest-import';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];

// Three windows' worth of content (windowsPerRun=1 forces three runs).
// Fillers stay under the 2000-char unit cap so each paragraph is exactly one
// unit — longer paragraphs now chunk into multiple units instead of truncating.
const ARCHIVE = [
  `In 2019 I lived on Laugavegur in Reykjavik. ${'a'.repeat(1500)}`,
  `My cousin Ragnar Importsson fixes my car every spring. ${'b'.repeat(1500)}`,
  `I have always preferred window seats on flights. ${'c'.repeat(1500)}`,
].join('\n\n');

/** One distinct fact per window, keyed off the window's leading content. */
const fakeRouter = {
  async embeddingSpace() {
    return { provider: 'test', model: 'import', dimensions: 1536, revision: '1' };
  },
  async object(_role: string, opts: { prompt?: string }) {
    const prompt = opts.prompt ?? '';
    const fact = prompt.includes('Laugavegur')
      ? {
          content: `${MARKER}: lived on Laugavegur in Reykjavik until 2019`,
          subject: 'owner',
          domain: 'home',
          validFrom: '2019',
        }
      : prompt.includes('Ragnar')
        ? {
            content: `${MARKER}: Ragnar Importsson is his cousin and fixes his car`,
            subject: 'Ragnar Importsson',
            relationship: 'cousin',
            domain: 'relationships',
            validFrom: '',
          }
        : prompt.includes('window seats')
          ? {
              content: `${MARKER}: prefers window seats on flights`,
              subject: 'owner',
              domain: 'preferences',
              validFrom: '',
            }
          : null;
    return {
      ok: true,
      modelId: 'fake',
      degraded: false,
      object: {
        facts: fact
          ? [
              {
                kind: 'fact',
                category: 'knowledge',
                relationship: '',
                importance: 3,
                confidence: 0.8,
                ...fact,
              },
            ]
          : [],
        occasions: prompt.includes('Laugavegur')
          ? [
              {
                subject: 'owner',
                kind: 'birthday',
                label: '',
                month: 5,
                day: 14,
                year: null,
                notes: 'import note',
              },
            ]
          : [],
      },
    };
  },
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.01));
  },
} as unknown as ModelRouter;

const workspaceFiles = new Map<string, string>();
let sourceArchiveReads = 0;

const fakeWorkspace: WorkspaceReader & { delete(relPath: string): Promise<void> } = {
  async read(relPath: string) {
    if (relPath === 'import/archive.txt') {
      sourceArchiveReads += 1;
      return ARCHIVE;
    }
    const content = workspaceFiles.get(relPath);
    if (content === undefined) throw new Error(`no such file: ${relPath}`);
    return content;
  },
  async write(relPath: string, content: string) {
    workspaceFiles.set(relPath, content);
  },
  async list(relPath = '.') {
    const prefix = relPath === '.' ? '' : `${relPath.replace(/\/$/, '')}/`;
    const children = new Map<string, boolean>();
    for (const file of workspaceFiles.keys()) {
      if (!file.startsWith(prefix)) continue;
      const tail = file.slice(prefix.length);
      if (!tail) continue;
      const [name, ...rest] = tail.split('/');
      if (name) children.set(name, rest.length > 0 || children.get(name) === true);
    }
    return [...children].map(([name, dir]) => ({ name, dir }));
  },
  async delete(relPath: string) {
    for (const path of workspaceFiles.keys())
      if (path === relPath || path.startsWith(`${relPath}/`)) workspaceFiles.delete(path);
  },
};

const noopDispatcher: DispatcherPort = {
  toolDefs: () => {
    throw new Error('import job must not build tools');
  },
  resultIsUntrusted: () => false,
  dispatch: async () => {
    throw new Error('import job must not dispatch tools');
  },
  executeApproved: async () => {
    throw new Error('import job must not execute approvals');
  },
};

async function cleanup() {
  await db.delete(memories).where(sql`${memories.content} LIKE ${`${MARKER}%`}`);
  await db.delete(importSources).where(eq(importSources.source, SOURCE));
  await db.delete(contacts).where(eq(contacts.name, 'Ragnar Importsson'));
  if (createdTaskIds.length) await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
}

beforeAll(async () => {
  workspaceFiles.clear();
  sourceArchiveReads = 0;
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
    await db.delete(memories).where(sql`${memories.content} LIKE ${`${MARKER}%`}`);
    await db.delete(importSources).where(eq(importSources.source, SOURCE));
    await db.delete(contacts).where(eq(contacts.name, 'Ragnar Importsson'));
  } catch {
    console.warn('import.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) await cleanup();
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('backstory import (integration)', () => {
  it('removes forward replacement descendants while preserving unrelated predecessors', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const source = `${SOURCE}-successor-${randomUUID().slice(0, 8)}`;
    const { taskId } = await startImport(db, {
      agentId,
      source,
      workspacePath: `import/${source}.txt`,
      kind: 'text',
      windowsPerRun: 1,
      windowChars: 2000,
    });
    createdTaskIds.push(taskId);

    const fixtureMarker = `hm05-lineage-${randomUUID()}`;
    const predecessorContent = `${fixtureMarker}: independent owner fact before import`;
    const sourceContent = `${fixtureMarker}: source-backed fact`;
    const successorContent = `${fixtureMarker}: derived replacement without legacy lineage`;
    const hashes = [predecessorContent, sourceContent, successorContent].map((content) =>
      createHash('sha256').update(content).digest('hex'),
    );
    const [predecessor, sourceFact, successor] = await db
      .insert(memories)
      .values([
        {
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: predecessorContent,
          contentHash: hashes[0] as string,
          originTrust: 'owner',
        },
        {
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: sourceContent,
          contentHash: hashes[1] as string,
          originTrust: 'owner',
          source,
        },
        {
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: successorContent,
          contentHash: hashes[2] as string,
          originTrust: 'assistant',
        },
      ])
      .returning({ id: memories.id });
    const predecessorId = predecessor?.id;
    const sourceFactId = sourceFact?.id;
    const successorId = successor?.id;
    if (!predecessorId || !sourceFactId || !successorId)
      throw new Error('Expected import lineage fixtures');
    await db
      .update(memories)
      .set({ supersededById: sourceFactId, expiresAt: new Date() })
      .where(eq(memories.id, predecessorId));
    await db
      .update(memories)
      .set({ supersededById: successorId, expiresAt: new Date() })
      .where(eq(memories.id, sourceFactId));

    await deleteImportSource(db, source, { delete: async () => {} });
    const rows = await db
      .select({ id: memories.id, content: memories.content, expiresAt: memories.expiresAt })
      .from(memories)
      .where(inArray(memories.id, [predecessorId, sourceFactId, successorId]));
    expect(rows.map((row) => row.id)).toContain(predecessorId);
    expect(rows.find((row) => row.id === predecessorId)?.expiresAt).toBeNull();
    expect(rows.map((row) => row.id)).not.toContain(sourceFactId);
    expect(rows.map((row) => row.id)).not.toContain(successorId);
  });

  it('imports resumably across runs, attributes/quarantines, dedupes on re-run, purges by source', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const deps = { db, router: fakeRouter, dispatcher: noopDispatcher, workspace: fakeWorkspace };

    const { taskId } = await startImport(db, {
      agentId,
      source: SOURCE,
      workspacePath: 'import/archive.txt',
      kind: 'text',
      windowsPerRun: 1,
      windowChars: 2000, // one unit per window → three windows
    });
    createdTaskIds.push(taskId);

    // Run 1: one window processed, task sleeps with a checkpoint — resumable, not restarted
    const run1 = await executeTask(deps, taskId);
    expect(run1.outcome).toBe('sleeping');
    let [src] = await db.select().from(importSources).where(eq(importSources.source, SOURCE));
    expect(src?.status).toBe('running');
    expect(src?.itemsProcessed).toBe(1);
    expect(src?.itemsTotal).toBe(3);

    // Simulate the interruption/wake cycle: clear runAfter and run again (twice)
    for (let i = 0; i < 2; i++) {
      await db
        .update(tasks)
        .set({ runAfter: sql`now() - interval '1 second'` })
        .where(eq(tasks.id, taskId));
      await executeTask(deps, taskId);
    }

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task?.status).toBe('done');
    expect(sourceArchiveReads).toBe(1); // resumes read the manifest + current shard, not the archive
    const taskState = task?.state as { plannerState?: { import?: unknown } } | undefined;
    const importCheckpoint = taskState?.plannerState?.import as
      | { manifestPath?: string; manifestHash?: string }
      | undefined;
    expect(importCheckpoint?.manifestPath).toMatch(/\.assistant\/imports\/.+\/manifest\.json$/);
    expect(importCheckpoint?.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(workspaceFiles.has(importCheckpoint?.manifestPath ?? '')).toBe(true);
    [src] = await db.select().from(importSources).where(eq(importSources.source, SOURCE));
    expect(src?.status).toBe('done');
    expect(src?.memoriesSaved).toBe(3);
    expect(src?.parseDiagnostics).toMatchObject({
      format: 'text',
      acceptedUnits: 3,
      rejectedUnits: 0,
      partial: false,
      issues: [],
    });

    const saved = await db
      .select()
      .from(memories)
      .where(sql`${memories.content} LIKE ${`${MARKER}%`}`);
    expect(saved).toHaveLength(3);
    const sourceLineage = await db
      .select()
      .from(memoryImportLineage)
      .where(eq(memoryImportLineage.source, SOURCE));
    expect(sourceLineage).toHaveLength(3);
    expect(sourceLineage.every((lineage) => lineage.sourceUnitProvenance.length === 1)).toBe(true);
    expect(
      sourceLineage.some((lineage) =>
        lineage.sourceUnitProvenance.some(
          (unit) =>
            unit.sourceOffset === 0 &&
            unit.unitOffset === 0 &&
            unit.observedAt === null &&
            unit.authorEmail === null &&
            unit.hasQuotedContent === false &&
            /^[a-f0-9]{64}$/.test(unit.unitTextHash),
        ),
      ),
    ).toBe(true);

    // provenance + owner-archive trust rules
    for (const m of saved) {
      expect(m.source).toBe(SOURCE);
      expect(m.originTrust).toBe('owner');
    }
    const ownerFacts = saved.filter((m) => !m.content.includes('Ragnar'));
    const thirdParty = saved.find((m) => m.content.includes('Ragnar'));
    expect(ownerFacts.every((m) => !m.quarantined)).toBe(true);
    expect(thirdParty?.quarantined).toBe(true); // third-party facts wait for review

    // auto-created contact + entity link
    const [ragnar] = await db.select().from(contacts).where(eq(contacts.name, 'Ragnar Importsson'));
    expect(ragnar?.trust).toBe('unknown');
    expect(thirdParty?.subjectContactId).toBe(ragnar?.id);

    // age-scaled confidence: dated 2019 window fact is lower than base 0.8
    const laugavegur = saved.find((m) => m.content.includes('Laugavegur'));
    expect(laugavegur?.validFrom?.getUTCFullYear()).toBe(2019);

    // batch review by source: approve releases the quarantined fact
    const review = await reviewImportSource(db, SOURCE, 'approve');
    expect(review.reviewed).toBe(1);
    const [released] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, (thirdParty as NonNullable<typeof thirdParty>).id));
    expect(released?.quarantined).toBe(false);

    // re-run: hash dedupe means nothing new
    const rerun = await startImport(db, {
      agentId,
      source: SOURCE,
      workspacePath: 'import/archive.txt',
      kind: 'text',
      windowsPerRun: 10,
    });
    createdTaskIds.push(rerun.taskId);
    const rerunResult = await executeTask(deps, rerun.taskId);
    expect(rerunResult.outcome).toBe('done');
    const afterRerun = await db
      .select()
      .from(memories)
      .where(sql`${memories.content} LIKE ${`${MARKER}%`}`);
    expect(afterRerun).toHaveLength(3); // no duplicates
    const importedOccasions = await db
      .select({ id: occasions.id, source: occasions.source })
      .from(occasions)
      .where(eq(occasions.source, SOURCE));
    expect(importedOccasions).toHaveLength(1);

    // purge-by-source removes exactly this source's memories
    const marker2 = `${MARKER}-other: unrelated fact that must survive the purge`;
    await db.insert(memories).values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content: marker2,
      contentHash: `hash-${MARKER}-other`,
      originTrust: 'owner',
    });
    const [direct] = await db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.source, SOURCE))
      .limit(1);
    const derivedHash = `hash-${MARKER}-derived`;
    const [derived] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER}: consolidated derived fact`,
        contentHash: derivedHash,
        originTrust: 'assistant',
      })
      .returning({ id: memories.id });
    if (direct && derived)
      await db.insert(memoryImportLineage).values({ source: SOURCE, memoryId: derived.id });
    const [priorFact] = derived
      ? await db
          .insert(memories)
          .values({
            agentId,
            category: 'knowledge',
            kind: 'fact',
            content: `${MARKER}: unrelated prior fact replaced by imported consolidation`,
            contentHash: `hash-${MARKER}-legacy-child`,
            originTrust: 'owner',
            supersededById: derived.id,
          })
          .returning({ id: memories.id })
      : [];
    const purge = await purgeImportSource(db, SOURCE);
    expect(purge.purged).toBe(4);
    expect((await db.select().from(occasions).where(eq(occasions.source, SOURCE))).length).toBe(0);
    expect(
      (await db.select().from(memoryImportLineage).where(eq(memoryImportLineage.source, SOURCE)))
        .length,
    ).toBe(0);
    expect(
      [...workspaceFiles.keys()].filter((path) => path.startsWith('.assistant/imports/')).length,
    ).toBeGreaterThan(0);
    const remaining = await db
      .select()
      .from(memories)
      .where(sql`${memories.content} LIKE ${`${MARKER}%`}`);
    expect(remaining.map((m) => m.content).sort()).toEqual(
      [marker2, `${MARKER}: unrelated prior fact replaced by imported consolidation`].sort(),
    );
    if (priorFact?.id) {
      expect(remaining.find((row) => row.id === priorFact.id)).toMatchObject({
        expiresAt: null,
        supersededById: null,
      });
    }
    [src] = await db.select().from(importSources).where(eq(importSources.source, SOURCE));
    expect(src?.status).toBe('purged');

    // delete removes the source row AND the uploaded archive — no husk left
    const deletedPaths: string[] = [];
    const result = await deleteImportSource(db, SOURCE, {
      delete: async (relPath: string) => {
        deletedPaths.push(relPath);
        await fakeWorkspace.delete(relPath);
      },
    });
    expect(result.purgedMemories).toBe(0); // already purged above
    expect(result.pendingAssets).toBe(false);
    expect(deletedPaths).toContain('import/archive.txt');
    expect(deletedPaths.some((path) => path.endsWith('/manifest.json'))).toBe(true);
    expect(deletedPaths.filter((path) => path.endsWith('.json')).length).toBeGreaterThan(2);
    const [gone] = await db.select().from(importSources).where(eq(importSources.source, SOURCE));
    expect(gone).toBeUndefined();
    // The unrelated memory and predecessor restored above still survive.
    const survivors = await db
      .select()
      .from(memories)
      .where(sql`${memories.content} LIKE ${`${MARKER}%`}`);
    expect(survivors.map((m) => m.content).sort()).toEqual(
      [marker2, `${MARKER}: unrelated prior fact replaced by imported consolidation`].sort(),
    );
  });

  it('keeps failed source and snapshot blob deletions retryable without exposing paths', async () => {
    const source = `${SOURCE}-retry`;
    const [sourceRow] = await db
      .insert(importSources)
      .values({ agentId, source, workspacePath: `import/${source}.txt`, kind: 'text' })
      .returning({ id: importSources.id });
    if (!sourceRow) throw new Error('failed to create import source fixture');
    const snapshotPath = `.assistant/imports/${source}/test-task/manifest.json`;
    await db.insert(maintenanceCursors).values({
      name: `import-snapshot-asset:${sourceRow.id}:${createHash('sha256').update(snapshotPath).digest('hex')}`,
      cursor: snapshotPath,
    });
    const result = await deleteImportSource(db, source, {
      delete: async () => {
        throw new Error('private workspace backend unavailable');
      },
    });
    expect(result).toEqual({ purgedMemories: 0, pendingAssets: true });
    const retriedPaths: string[] = [];
    await expect(
      deleteImportSource(db, source, {
        delete: async (path) => {
          retriedPaths.push(path);
        },
      }),
    ).resolves.toEqual({ purgedMemories: 0, pendingAssets: false });
    expect(retriedPaths).toContain(`import/${source}.txt`);
    expect(retriedPaths).toContain(snapshotPath);
  });

  it('resumes a paged source deletion after interruption and restores an external predecessor', async () => {
    if (!dbUp) throw new Error('Local PostgreSQL qualification database is required');
    const source = `${SOURCE}-paged-delete`;
    const taskId = randomUUID();
    const [sourceRow] = await db
      .insert(importSources)
      .values({
        agentId,
        source,
        workspacePath: `import/${source}.txt`,
        kind: 'text',
        status: 'done',
      })
      .returning({ id: importSources.id });
    if (!sourceRow) throw new Error('failed to create paged deletion source');
    const sourceIds = Array.from({ length: 55 }, () => randomUUID()).sort();
    const sourceRows = await db
      .insert(memories)
      .values(
        sourceIds.map((id, index) => {
          const content = `${MARKER}: ${source} unit ${index}`;
          return {
            id,
            agentId,
            category: 'knowledge' as const,
            kind: 'fact' as const,
            content,
            contentHash: createHash('sha256').update(content).digest('hex'),
            originTrust: 'owner' as const,
            source,
          };
        }),
      )
      .returning({ id: memories.id });
    await db
      .insert(memoryImportLineage)
      .values(sourceRows.map((row) => ({ source, memoryId: row.id })));
    for (let index = 0; index < sourceIds.length - 1; index += 1) {
      const id = sourceIds[index];
      const successor = sourceIds[index + 1];
      if (!id || !successor) continue;
      await db
        .update(memories)
        .set({ supersededById: successor, expiresAt: new Date() })
        .where(eq(memories.id, id));
    }
    const predecessorContent = `${MARKER}: ${source} unrelated predecessor`;
    const [predecessor] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: predecessorContent,
        contentHash: createHash('sha256').update(predecessorContent).digest('hex'),
        originTrust: 'owner',
        expiresAt: new Date(),
        supersededById: sourceIds[0],
      })
      .returning({ id: memories.id });
    if (!predecessor) throw new Error('failed to create external predecessor');

    const snapshotPaths = Array.from({ length: 55 }, (_, index) => {
      const filename =
        index === 0 ? 'manifest.json' : `windows-${String(index).padStart(6, '0')}.json`;
      return `.assistant/imports/${source}/${taskId}/${filename}`;
    });
    await db.insert(maintenanceCursors).values(
      snapshotPaths.map((path) => ({
        name: `import-snapshot-asset:${sourceRow.id}:${createHash('sha256').update(path).digest('hex')}`,
        cursor: path,
      })),
    );

    let transactions = 0;
    const transaction = db.transaction.bind(db);
    const interruptedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction')
          return (...args: Parameters<Db['transaction']>) => {
            transactions += 1;
            if (transactions === 20) throw new Error('simulated process interruption');
            return transaction(...args);
          };
        return Reflect.get(target, property, receiver);
      },
    }) as Db;
    await expect(deleteImportSource(interruptedDb, source)).rejects.toThrow(
      'simulated process interruption',
    );
    const jobName = `import-source-delete-job:${agentId}:${createHash('sha256').update(source).digest('hex')}`;
    const [progress] = await db
      .select({ cursor: maintenanceCursors.cursor })
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, jobName));
    expect(JSON.parse(progress?.cursor ?? '{}')).toMatchObject({
      phase: 'detach',
      detachNodeCursor: expect.any(String),
    });

    const restartedDb = createDb(DATABASE_URL as string);
    try {
      const deletedPaths: string[] = [];
      const workspace = { delete: async (path: string) => void deletedPaths.push(path) };
      await expect(deleteImportSource(restartedDb, source, workspace)).resolves.toEqual({
        purgedMemories: 55,
        pendingAssets: true,
      });
      await expect(deleteImportSource(restartedDb, source, workspace)).resolves.toEqual({
        purgedMemories: 55,
        pendingAssets: false,
      });
      expect(deletedPaths).toHaveLength(56);
      expect(deletedPaths).toContain(`import/${source}.txt`);
      expect(deletedPaths).toEqual(expect.arrayContaining(snapshotPaths));
      expect(
        await restartedDb.select().from(memories).where(inArray(memories.id, sourceIds)),
      ).toHaveLength(0);
      expect(
        await restartedDb
          .select()
          .from(memoryImportLineage)
          .where(eq(memoryImportLineage.source, source)),
      ).toHaveLength(0);
      expect(
        (await restartedDb.select().from(memories).where(eq(memories.id, predecessor.id)))[0],
      ).toMatchObject({ expiresAt: null, supersededById: null });
    } finally {
      await restartedDb.$client.end();
    }
  });

  it('purges a deep import closure in bounded resumable pages while retaining raw assets', async () => {
    if (!dbUp) throw new Error('Local PostgreSQL qualification database is required');
    const source = `${SOURCE}-paged-purge-${randomUUID().slice(0, 8)}`;
    const taskId = randomUUID();
    const snapshotPath = `.assistant/imports/${source}/${taskId}/manifest.json`;
    const [sourceRow] = await db
      .insert(importSources)
      .values({
        agentId,
        source,
        workspacePath: `import/${source}.txt`,
        kind: 'text',
        status: 'done',
      })
      .returning({ id: importSources.id });
    if (!sourceRow) throw new Error('failed to create paged purge source');

    const ids = Array.from({ length: 60 }, () => randomUUID()).sort();
    const contents = ids.map((_, index) => `${MARKER}: ${source} chained fact ${index}`);
    await db.insert(memories).values(
      ids.map((id, index) => ({
        id,
        agentId,
        category: 'knowledge' as const,
        kind: 'fact' as const,
        content: contents[index] as string,
        contentHash: createHash('sha256')
          .update(contents[index] as string)
          .digest('hex'),
        originTrust: 'owner' as const,
        source: index === 0 ? source : null,
        supersededById: ids[index + 1] ?? null,
      })),
    );
    await db.insert(memoryImportLineage).values({ source, memoryId: ids[0] as string });
    const predecessorContent = `${MARKER}: ${source} independent predecessor`;
    const [predecessor] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: predecessorContent,
        contentHash: createHash('sha256').update(predecessorContent).digest('hex'),
        originTrust: 'owner',
        expiresAt: new Date(),
        supersededById: ids[0] as string,
      })
      .returning({ id: memories.id });
    if (!predecessor) throw new Error('failed to create independent predecessor');
    await db.insert(maintenanceCursors).values({
      name: `import-snapshot-asset:${sourceRow.id}:${createHash('sha256').update(snapshotPath).digest('hex')}`,
      cursor: snapshotPath,
    });

    try {
      let transactions = 0;
      const transaction = db.transaction.bind(db);
      const interruptedDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property === 'transaction')
            return (...args: Parameters<Db['transaction']>) => {
              transactions += 1;
              if (transactions === 20) throw new Error('simulated purge interruption');
              return transaction(...args);
            };
          return Reflect.get(target, property, receiver);
        },
      }) as Db;
      await expect(purgeImportSource(interruptedDb, source)).rejects.toThrow(
        'simulated purge interruption',
      );
      const purgeHash = createHash('sha256').update(source).digest('hex');
      const purgeJobName = `import-source-purge-job:${agentId}:${purgeHash}`;
      const [progress] = await db
        .select({ cursor: maintenanceCursors.cursor })
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, purgeJobName));
      expect(JSON.parse(progress?.cursor ?? '{}')).toMatchObject({
        operation: 'purge',
        phase: expect.any(String),
      });
      await expect(
        startImport(db, {
          agentId,
          source,
          workspacePath: `import/${source}.txt`,
          kind: 'text',
        }),
      ).rejects.toThrow('is being removed');
      await expect(deleteImportSource(db, source)).rejects.toThrow('already in progress');

      const restartedDb = createDb(DATABASE_URL as string);
      try {
        await expect(purgeImportSource(restartedDb, source)).resolves.toEqual({ purged: 60 });
        await expect(purgeImportSource(restartedDb, source)).resolves.toEqual({ purged: 60 });
        const [retained] = await restartedDb
          .select({
            id: importSources.id,
            status: importSources.status,
            workspacePath: importSources.workspacePath,
          })
          .from(importSources)
          .where(eq(importSources.source, source));
        expect(retained).toEqual({
          id: sourceRow.id,
          status: 'purged',
          workspacePath: `import/${source}.txt`,
        });
        expect(
          await restartedDb
            .select({ name: maintenanceCursors.name, cursor: maintenanceCursors.cursor })
            .from(maintenanceCursors)
            .where(
              eq(
                maintenanceCursors.name,
                `import-snapshot-asset:${sourceRow.id}:${createHash('sha256').update(snapshotPath).digest('hex')}`,
              ),
            ),
        ).toEqual([
          {
            name: `import-snapshot-asset:${sourceRow.id}:${createHash('sha256').update(snapshotPath).digest('hex')}`,
            cursor: snapshotPath,
          },
        ]);
        expect(
          await restartedDb.select().from(memories).where(inArray(memories.id, ids)),
        ).toHaveLength(0);
        expect(
          await restartedDb
            .select()
            .from(memoryImportLineage)
            .where(eq(memoryImportLineage.source, source)),
        ).toHaveLength(0);
        expect(
          (await restartedDb.select().from(memories).where(eq(memories.id, predecessor.id)))[0],
        ).toMatchObject({ expiresAt: null, supersededById: null });
      } finally {
        await restartedDb.$client.end();
      }
    } finally {
      await db.delete(memoryImportLineage).where(eq(memoryImportLineage.source, source));
      await db.delete(memories).where(inArray(memories.id, [...ids, predecessor.id]));
      await db
        .delete(maintenanceCursors)
        .where(sql`${maintenanceCursors.name} LIKE ${`import-snapshot-asset:${sourceRow.id}:%`}`);
      await db
        .delete(maintenanceCursors)
        .where(
          sql`${maintenanceCursors.name} LIKE ${`import-source-purge-%:${agentId}:${createHash('sha256').update(source).digest('hex')}`}`,
        );
      await db.delete(importSources).where(eq(importSources.id, sourceRow.id));
    }
  });

  it('fails closed on ambiguous owner identity and malformed archive paths before purge writes', async () => {
    if (!dbUp) throw new Error('Local PostgreSQL qualification database is required');
    const source = `${SOURCE}-purge-owner-${randomUUID().slice(0, 8)}`;
    const factContent = `${MARKER}: ${source} must remain`;
    const [sourceRow] = await db
      .insert(importSources)
      .values({
        agentId,
        source,
        workspacePath: `../private/${source}.txt`,
        kind: 'text',
        status: 'done',
      })
      .returning({ id: importSources.id });
    const [factRow] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: factContent,
        contentHash: createHash('sha256').update(factContent).digest('hex'),
        originTrust: 'owner',
        source,
      })
      .returning({ id: memories.id });
    if (!sourceRow || !factRow) throw new Error('failed to create malformed purge fixture');
    try {
      await expect(purgeImportSource(db, source)).rejects.toThrow(
        'Import source archive path is invalid',
      );
      expect((await db.select().from(memories).where(eq(memories.id, factRow.id)))[0]).toBeTruthy();
      expect(
        (await db.select().from(importSources).where(eq(importSources.id, sourceRow.id)))[0]
          ?.status,
      ).toBe('done');
    } finally {
      await db.delete(memories).where(eq(memories.id, factRow.id));
      await db.delete(importSources).where(eq(importSources.id, sourceRow.id));
    }

    const secondOwner = randomUUID();
    const secondSource = `${SOURCE}-ambiguous-owner-${randomUUID().slice(0, 8)}`;
    const secondContent = `${MARKER}: ${secondSource} must remain`;
    const [ambiguousSource] = await db
      .insert(importSources)
      .values({
        agentId,
        source: secondSource,
        workspacePath: `import/${secondSource}.txt`,
        kind: 'text',
        status: 'done',
      })
      .returning({ id: importSources.id });
    const [ambiguousFact] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: secondContent,
        contentHash: createHash('sha256').update(secondContent).digest('hex'),
        originTrust: 'owner',
        source: secondSource,
      })
      .returning({ id: memories.id });
    await db.insert(agents).values({
      id: secondOwner,
      name: 'Fixture secondary owner',
      email: `fixture-${secondOwner}@example.invalid`,
      workspacePrefix: `fixture/${secondOwner}`,
    });
    try {
      await expect(purgeImportSource(db, secondSource)).rejects.toThrow(
        'Import deletion requires one configured owner',
      );
      expect(
        (
          await db
            .select()
            .from(memories)
            .where(eq(memories.id, ambiguousFact?.id ?? ''))
        )[0],
      ).toBeTruthy();
      expect(
        (
          await db
            .select()
            .from(importSources)
            .where(eq(importSources.id, ambiguousSource?.id ?? ''))
        )[0]?.status,
      ).toBe('done');
    } finally {
      await db.delete(agents).where(eq(agents.id, secondOwner));
      if (ambiguousFact) await db.delete(memories).where(eq(memories.id, ambiguousFact.id));
      if (ambiguousSource)
        await db.delete(importSources).where(eq(importSources.id, ambiguousSource.id));
    }
  });

  it('blocks a model result that resumes after its import source is deleted', async () => {
    const source = `${SOURCE}-late-writer`;
    let announceEmbedding!: () => void;
    let releaseEmbedding!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => {
      announceEmbedding = resolve;
    });
    const embeddingGate = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    const delayedRouter = {
      ...fakeRouter,
      async embed(texts: string[]) {
        announceEmbedding();
        await embeddingGate;
        return texts.map(() => new Array(1536).fill(0.01));
      },
    } as unknown as ModelRouter;
    const started = await startImport(db, {
      agentId,
      source,
      workspacePath: 'import/archive.txt',
      kind: 'text',
      windowsPerRun: 1,
    });
    createdTaskIds.push(started.taskId);
    const run = executeTask(
      { db, router: delayedRouter, workspace: fakeWorkspace, dispatcher: noopDispatcher },
      started.taskId,
    );
    await embeddingStarted;
    const removed = await deleteImportSource(db, source, fakeWorkspace);
    expect(removed.pendingAssets).toBe(false);
    releaseEmbedding();
    await run;
    expect((await db.select().from(memories).where(eq(memories.source, source))).length).toBe(0);
    expect((await db.select().from(occasions).where(eq(occasions.source, source))).length).toBe(0);
    expect([...workspaceFiles.keys()].some((path) => path.includes(`/imports/${source}/`))).toBe(
      false,
    );
  });
});
