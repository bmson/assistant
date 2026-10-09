import { createHash, randomUUID } from 'node:crypto';
import {
  agents,
  createDb,
  createPostgresDocumentProcessorRepository,
  createPostgresPrivacyErasureRepository,
  type Db,
  documentChunks,
  documents,
  emailAttachmentCustodies,
  files,
  maintenanceCursors,
  tasks,
} from '@assistant/db';
import { emailAttachmentManifestDigest, embeddingSpaceIdentityKey } from '@assistant/persistence';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashCallbackToken } from '../browse.js';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { enqueueTask } from '../workflow/machine.js';
import { extractedTextPath, recordDocumentProcessorResult } from './document-processor.js';
import {
  chunkText,
  documentStats,
  extractDocumentText,
  extractorFor,
  listDocuments,
  purgeDocument,
  runDocumentExtraction,
  searchDocumentChunks,
  startDocumentIngest,
} from './documents.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

/** In-memory workspace satisfying the reader shape the job needs. */
function fakeWorkspace() {
  const store = new Map<string, Buffer>();
  return {
    store,
    async read(p: string) {
      return (store.get(p) ?? Buffer.alloc(0)).toString('utf8');
    },
    async readBytes(p: string) {
      return store.get(p) ?? Buffer.alloc(0);
    },
    async write(p: string, c: string) {
      store.set(p, Buffer.from(c, 'utf8'));
      return { bytes: Buffer.byteLength(c) };
    },
    async list() {
      return [] as Array<{ name: string; dir: boolean }>;
    },
    async delete(p: string) {
      store.delete(p);
    },
  };
}

const fakeRouter = {
  async embeddingSpace() {
    return { provider: 'test', model: 'document-test', dimensions: 1536, revision: '1' };
  },
  async embed(texts: string[]) {
    // Deterministic non-zero vectors; content-agnostic (mechanics, not ranking).
    return texts.map((_, i) => new Array(1536).fill(0.01 + i * 0.0001));
  },
} as unknown as ModelRouter;

describe('document intelligence — pure helpers', () => {
  it('routes mimes/filenames to the right extractor', () => {
    expect(extractorFor('application/pdf', 'a.pdf')).toBe('pdf');
    expect(extractorFor('application/octet-stream', 'report.pdf')).toBe('pdf');
    expect(extractorFor('text/plain', 'notes.txt')).toBe('text');
    expect(extractorFor('text/markdown', 'x.md')).toBe('text');
    expect(extractorFor('application/json', 'data.json')).toBe('text');
    expect(extractorFor('application/octet-stream', 'main.ts')).toBe('text');
    expect(extractorFor('image/png', 'scan.png')).toBe('pending_processor');
    expect(
      extractorFor(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'x.docx',
      ),
    ).toBe('pending_processor');
    expect(extractorFor('application/x-tar', 'archive.tar')).toBe('unsupported');
  });

  it('chunks text with overlap and honors boundaries', () => {
    expect(() =>
      chunkText('abcdefghij', { size: 4, overlap: 0, max: 2, requireComplete: true }),
    ).toThrow('full document has not been indexed');
    expect(chunkText('abcdefgh', { size: 4, overlap: 0, max: 2, requireComplete: true })).toEqual([
      'abcd',
      'efgh',
    ]);
    expect(chunkText('')).toEqual([]);
    expect(chunkText('short note')).toEqual(['short note']);
    const long = `${'a'.repeat(700)}\n\n${'b'.repeat(700)}\n\n${'c'.repeat(700)}`;
    const chunks = chunkText(long, { size: 800, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk is within a reasonable bound of the target size.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(900);
    // Coverage: concatenated chunks contain all three blocks.
    const joined = chunks.join('');
    expect(joined).toContain('a'.repeat(50));
    expect(joined).toContain('c'.repeat(50));
  });

  it('extracts text and strips html', async () => {
    const plain = await extractDocumentText(
      'text',
      Buffer.from('hello world', 'utf8'),
      'text/plain',
    );
    expect(plain).toBe('hello world');
    const html = await extractDocumentText(
      'text',
      Buffer.from('<html><body><p>Hi</p><script>bad()</script><p>There</p></body></html>', 'utf8'),
      'text/html',
    );
    expect(html).toContain('Hi');
    expect(html).toContain('There');
    expect(html).not.toContain('bad()');
    expect(html).not.toContain('<p>');
  });
});

describe('document intelligence — extraction job', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  const ws = fakeWorkspace();
  // Delete only tasks this run created (by id) — a progress-`like` sweep could
  // hit an unrelated task that has model_calls and FK-block the delete.
  const createdTaskIds: string[] = [];

  async function cleanup() {
    const docs = await db
      .select({ id: documents.id })
      .from(documents)
      .where(like(documents.title, 'XTESTDOC%'));
    for (const d of docs) {
      await db.delete(documentChunks).where(eq(documentChunks.documentId, d.id));
    }
    if (docs.length) {
      await db.delete(documents).where(like(documents.title, 'XTESTDOC%'));
      await db.delete(files).where(like(files.workspacePath, 'xtestdoc/%'));
    }
    if (createdTaskIds.length) {
      await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
    }
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanup();
    } catch {
      console.warn('documents.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) await cleanup();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('files a text document, extracts+embeds chunks, searches, and purges', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const path = `xtestdoc/${Date.now()}-notes.txt`;
    const body = `The Reykjavik project kicked off in March.\n\n${'Detail line. '.repeat(120)}\n\nQuarterly revenue reached 4.2 million.`;
    await ws.write(path, body);
    const sha256 = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');

    const started = await startDocumentIngest(db, {
      agentId,
      title: 'XTESTDOC notes',
      workspacePath: path,
      mime: 'text/plain',
      bytes: Buffer.byteLength(body),
      sha256,
    });
    expect(started.duplicate).toBe(false);
    expect(started.taskId).toBeTruthy();
    if (started.taskId) createdTaskIds.push(started.taskId);
    expect(started.document.status).toBe('pending');
    expect(started.document.extractor).toBe('text');

    // Dedup: an identical re-file returns the same document, no new task.
    const again = await startDocumentIngest(db, {
      agentId,
      title: 'XTESTDOC notes dup',
      workspacePath: path,
      mime: 'text/plain',
      bytes: Buffer.byteLength(body),
      sha256,
    });
    expect(again.duplicate).toBe(true);
    expect(again.taskId).toBeNull();
    expect(again.document.id).toBe(started.document.id);

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, started.taskId ?? ''));
    if (!task) return ctx.skip();
    const outcome = await runDocumentExtraction({ db, router: fakeRouter, workspace: ws }, task);
    expect(outcome.done).toBe(true);

    const [doc] = await db.select().from(documents).where(eq(documents.id, started.document.id));
    expect(doc?.status).toBe('ready');
    expect(doc?.chunkCount).toBeGreaterThan(0);
    expect(doc?.charCount).toBeGreaterThan(0);

    const chunks = await db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.documentId, started.document.id));
    expect(chunks.length).toBe(doc?.chunkCount);

    const hits = await searchDocumentChunks(db, {
      agentId,
      embedding: new Array(1536).fill(0.01),
      embeddingSpaceKey: embeddingSpaceIdentityKey({
        provider: 'test',
        model: 'document-test',
        dimensions: 1536,
        revision: '1',
      }),
      limit: 3,
    });
    expect(hits.some((h) => h.documentId === started.document.id)).toBe(true);

    const stats = await documentStats(db, agentId);
    expect(stats.ready).toBeGreaterThanOrEqual(1);
    const listed = await listDocuments(db, agentId);
    expect(listed.some((d) => d.id === started.document.id)).toBe(true);

    const purged = await purgeDocument(db, agentId, started.document.id, ws);
    expect(purged.deleted).toBe(true);
    const after = await db.select().from(documents).where(eq(documents.id, started.document.id));
    expect(after.length).toBe(0);
    const afterChunks = await db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.documentId, started.document.id));
    expect(afterChunks.length).toBe(0);
  });

  it('does not resurrect chunks or success after deletion during embedding', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const path = `xtestdoc/${Date.now()}-deleted-during-embed.txt`;
    await ws.write(path, 'A document that the owner will delete during embedding.');
    const started = await startDocumentIngest(db, {
      agentId,
      title: 'XTESTDOC deleted during embed',
      workspacePath: path,
      mime: 'text/plain',
      bytes: 56,
      sha256: `delete-race-${Date.now()}`,
    });
    if (started.taskId) createdTaskIds.push(started.taskId);
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, started.taskId ?? ''));
    expect(task).toBeTruthy();
    if (!task) throw new Error('Extraction task missing');
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const router = {
      embeddingSpace: () => fakeRouter.embeddingSpace(),
      async embed(texts: string[]) {
        entered();
        await resumed;
        return texts.map(() => new Array(1536).fill(0.01));
      },
    } as unknown as ModelRouter;
    const running = runDocumentExtraction({ db, router, workspace: ws }, task);
    const rejected = expect(running).rejects.toThrow('Document was deleted during extraction');
    await waiting;
    expect((await purgeDocument(db, agentId, started.document.id, ws)).deleted).toBe(true);
    release();
    await rejected;
    expect(
      await db.select().from(documents).where(eq(documents.id, started.document.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(documentChunks)
        .where(eq(documentChunks.documentId, started.document.id)),
    ).toHaveLength(0);
    const [cancelled] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    if (!cancelled) throw new Error('Cancelled extraction task missing');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.state).toEqual(task.state);
  });

  it('hands an office document to the processor worker via a documents.process job', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const path = `xtestdoc/${Date.now()}-slides.pptx`;
    await ws.write(path, 'binary-ish');
    const sha256 = (await import('node:crypto'))
      .createHash('sha256')
      .update(`${path}`)
      .digest('hex');
    const started = await startDocumentIngest(db, {
      agentId,
      title: 'XTESTDOC slides',
      workspacePath: path,
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      bytes: 10,
      sha256,
    });
    expect(started.document.status).toBe('pending');
    expect(started.document.extractor).toBe('pending_processor');
    // Heavy formats no longer sit inert — they enqueue the out-of-process worker.
    expect(started.taskId).toBeTruthy();
    if (started.taskId) createdTaskIds.push(started.taskId);
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, started.taskId ?? ''));
    expect((task?.trigger as { payload?: { job?: string } })?.payload?.job).toBe(
      'documents.process',
    );
    await purgeDocument(db, agentId, started.document.id, ws);
  });

  it('embeds a processor-extracted document from its text blob and marks it ready', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const src = `xtestdoc/${Date.now()}-report.docx`;
    await ws.write(src, 'binary-docx');
    const sha256 = (await import('node:crypto'))
      .createHash('sha256')
      .update(`docx-${Date.now()}`)
      .digest('hex');
    const started = await startDocumentIngest(db, {
      agentId,
      title: 'XTESTDOC officedoc',
      workspacePath: src,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: 20,
      sha256,
    });
    if (started.taskId) createdTaskIds.push(started.taskId);
    expect(started.document.extractor).toBe('pending_processor');

    // Simulate the worker + callback: text uploaded, processedTextPath set.
    const textPath = extractedTextPath(started.document.id);
    const extracted = `Board minutes.\n\n${'Detail sentence. '.repeat(120)}\n\nAction items follow.`;
    await ws.write(textPath, extracted);
    await db
      .update(documents)
      .set({ processedTextPath: textPath })
      .where(eq(documents.id, started.document.id));

    // The callback enqueues a documents.extract job; run it against the text blob.
    const { task } = await enqueueTask(db, {
      event: {
        source: 'internal',
        agentId,
        trust: 'assistant',
        payload: { job: 'documents.extract', documentId: started.document.id },
      },
      type: 'adhoc',
      budgetUsdLimit: '0.50',
      deferNotification: true,
    });
    createdTaskIds.push(task.id);
    const outcome = await runDocumentExtraction({ db, router: fakeRouter, workspace: ws }, task);
    expect(outcome.done).toBe(true);

    const [doc] = await db.select().from(documents).where(eq(documents.id, started.document.id));
    expect(doc?.status).toBe('ready');
    expect(doc?.chunkCount).toBeGreaterThan(0);
    expect(doc?.charCount).toBeGreaterThan(0);

    await purgeDocument(db, agentId, started.document.id, ws);
  });

  it('keeps failed document blob deletion pending and drains it on a later retry', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const sourcePath = `xtestdoc/${Date.now()}-retry.txt`;
    const textPath = `documents/processed/${Date.now()}-retry.txt`;
    await ws.write(sourcePath, 'source bytes');
    await ws.write(textPath, 'processed private text');
    const sha256 = (await import('node:crypto'))
      .createHash('sha256')
      .update(sourcePath)
      .digest('hex');
    const started = await startDocumentIngest(db, {
      agentId,
      title: 'XTESTDOC retryable deletion',
      workspacePath: sourcePath,
      mime: 'text/plain',
      bytes: 12,
      sha256,
    });
    if (started.taskId) createdTaskIds.push(started.taskId);
    await db
      .update(documents)
      .set({ processedTextPath: textPath })
      .where(eq(documents.id, started.document.id));
    let failSourceOnce = true;
    const flakyWorkspace = {
      async delete(path: string) {
        if (path === sourcePath && failSourceOnce) {
          failSourceOnce = false;
          throw new Error('workspace unavailable');
        }
        await ws.delete(path);
      },
    };

    await expect(purgeDocument(db, agentId, started.document.id, flakyWorkspace)).resolves.toEqual({
      deleted: true,
      pendingAssets: true,
    });
    expect(
      (await db.select().from(documents).where(eq(documents.id, started.document.id))).length,
    ).toBe(0);
    expect(ws.store.has(sourcePath)).toBe(true);
    expect(ws.store.has(textPath)).toBe(false);
    expect(
      await db
        .select({ name: maintenanceCursors.name })
        .from(maintenanceCursors)
        .where(
          like(
            maintenanceCursors.name,
            `privacy-erasure-asset:${agentId}:document-delete:${started.document.id}:%`,
          ),
        ),
    ).toHaveLength(1);

    await expect(purgeDocument(db, agentId, started.document.id, ws)).resolves.toEqual({
      deleted: false,
      pendingAssets: false,
    });
    expect(ws.store.has(sourcePath)).toBe(false);
    expect(
      await db
        .select({ name: maintenanceCursors.name })
        .from(maintenanceCursors)
        .where(
          like(
            maintenanceCursors.name,
            `privacy-erasure-asset:${agentId}:document-delete:${started.document.id}:%`,
          ),
        ),
    ).toHaveLength(0);
  });

  it('retains a processor tombstone until a verified late callback deletes its output', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const sourcePath = `xtestdoc/${Date.now()}-worker.png`;
    await ws.write(sourcePath, 'image bytes');
    const sha256 = (await import('node:crypto'))
      .createHash('sha256')
      .update(sourcePath)
      .digest('hex');
    const started = await startDocumentIngest(db, {
      agentId,
      title: 'XTESTDOC deleted processor run',
      workspacePath: sourcePath,
      mime: 'image/png',
      bytes: 11,
      sha256,
    });
    if (started.taskId) createdTaskIds.push(started.taskId);
    const token = 'processor-token-for-deleted-document';
    await db
      .update(documents)
      .set({ processorTokenHash: hashCallbackToken(token) })
      .where(eq(documents.id, started.document.id));

    await expect(purgeDocument(db, agentId, started.document.id, ws)).resolves.toEqual({
      deleted: true,
      pendingAssets: true,
    });
    await expect(
      createPostgresPrivacyErasureRepository(db).assetDeleted(
        `document-delete-worker:${started.document.id}`,
      ),
    ).rejects.toThrow('callback remains unresolved');
    const outputPath = extractedTextPath(started.document.id);
    await ws.write(outputPath, 'late worker output');
    const callback = await recordDocumentProcessorResult(db, {
      documentId: started.document.id,
      token,
      result: { ok: true, kind: 'text' },
    });
    expect(callback).toMatchObject({
      ok: false,
      status: 410,
      cleanupPath: outputPath,
    });
    if (callback.ok || callback.status !== 410 || !callback.cleanupPath)
      throw new Error('Expected a verified deleted-worker callback cleanup request');
    await ws.delete(callback.cleanupPath);
    await expect(
      createPostgresDocumentProcessorRepository(db).resolveDeletedCallback({
        documentId: started.document.id,
        tokenMatches: (stored) => stored === hashCallbackToken(token),
        processedTextPath: callback.cleanupPath,
      }),
    ).resolves.toBe(true);
    expect(ws.store.has(outputPath)).toBe(false);
    await expect(purgeDocument(db, agentId, started.document.id, ws)).resolves.toEqual({
      deleted: false,
      pendingAssets: false,
    });
  });

  it('reports physical deletion pending when no workspace is available', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const path = `xtestdoc/${Date.now()}-no-workspace.txt`;
    await ws.write(path, 'private source');
    const sha256 = (await import('node:crypto')).createHash('sha256').update(path).digest('hex');
    const started = await startDocumentIngest(db, {
      agentId,
      title: 'XTESTDOC deletion without workspace',
      workspacePath: path,
      mime: 'text/plain',
      bytes: 14,
      sha256,
    });
    if (started.taskId) createdTaskIds.push(started.taskId);
    await expect(purgeDocument(db, agentId, started.document.id)).resolves.toEqual({
      deleted: true,
      pendingAssets: true,
    });
    expect(ws.store.has(path)).toBe(true);
    await expect(purgeDocument(db, agentId, started.document.id, ws)).resolves.toEqual({
      deleted: false,
      pendingAssets: false,
    });
    expect(ws.store.has(path)).toBe(false);
  });

  it('cancels only the document owner’s extraction task', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const foreignAgentId = randomUUID();
    const path = `xtestdoc/${Date.now()}-foreign-task.txt`;
    await db.insert(agents).values({
      id: foreignAgentId,
      name: 'foreign document task fixture',
      email: `${foreignAgentId}@document-delete.invalid`,
      workspacePrefix: `document-delete/${foreignAgentId}`,
    });
    const started = await startDocumentIngest(db, {
      agentId,
      title: 'XTESTDOC foreign task fixture',
      workspacePath: path,
      mime: 'text/plain',
      bytes: 6,
      sha256: createHash('sha256').update(path).digest('hex'),
    });
    const foreignTaskId = randomUUID();
    try {
      await db.insert(tasks).values({
        id: foreignTaskId,
        agentId: foreignAgentId,
        type: 'adhoc',
        trigger: { payload: { job: 'documents.process', documentId: started.document.id } },
      });
      await expect(purgeDocument(db, agentId, started.document.id, ws)).resolves.toEqual({
        deleted: true,
        pendingAssets: false,
      });
      expect(
        await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, foreignTaskId)),
      ).toHaveLength(1);
      if (started.taskId)
        expect(
          await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, started.taskId)),
        ).toMatchObject([{ status: 'cancelled' }]);
    } finally {
      if (started.taskId) await db.delete(tasks).where(eq(tasks.id, started.taskId));
      await db.delete(tasks).where(eq(tasks.id, foreignTaskId));
      await db.delete(agents).where(eq(agents.id, foreignAgentId));
    }
  });

  it('rolls back deletion instead of deleting another owner’s chunk', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const foreignAgentId = randomUUID();
    const path = `xtestdoc/${Date.now()}-foreign-chunk.txt`;
    await db.insert(agents).values({
      id: foreignAgentId,
      name: 'foreign document chunk fixture',
      email: `${foreignAgentId}@document-delete.invalid`,
      workspacePrefix: `document-delete/${foreignAgentId}`,
    });
    const started = await startDocumentIngest(db, {
      agentId,
      title: 'XTESTDOC foreign chunk fixture',
      workspacePath: path,
      mime: 'text/plain',
      bytes: 6,
      sha256: createHash('sha256').update(path).digest('hex'),
    });
    const foreignTaskId = randomUUID();
    const foreignChunkId = randomUUID();
    try {
      await db.insert(tasks).values({
        id: foreignTaskId,
        agentId: foreignAgentId,
        type: 'adhoc',
        trigger: { payload: { job: 'documents.process', documentId: started.document.id } },
      });
      await db.insert(documentChunks).values({
        id: foreignChunkId,
        documentId: started.document.id,
        agentId: foreignAgentId,
        chunkIndex: 0,
        text: 'foreign owner data',
        charCount: 18,
      });
      await expect(purgeDocument(db, agentId, started.document.id, ws)).rejects.toThrow();
      expect(
        await db
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.id, started.document.id)),
      ).toHaveLength(1);
      expect(
        await db
          .select({ id: documentChunks.id })
          .from(documentChunks)
          .where(eq(documentChunks.id, foreignChunkId)),
      ).toHaveLength(1);
      expect(
        await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, foreignTaskId)),
      ).toMatchObject([{ status: 'pending' }]);
      await db.delete(documentChunks).where(eq(documentChunks.id, foreignChunkId));
      await expect(purgeDocument(db, agentId, started.document.id, ws)).resolves.toEqual({
        deleted: true,
        pendingAssets: false,
      });
      expect(
        await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, foreignTaskId)),
      ).toHaveLength(1);
    } finally {
      await db.delete(documentChunks).where(eq(documentChunks.id, foreignChunkId));
      await db.delete(tasks).where(eq(tasks.id, foreignTaskId));
      if (
        await db
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.id, started.document.id))
          .then((rows) => rows.length)
      )
        await purgeDocument(db, agentId, started.document.id, ws);
      await db.delete(agents).where(eq(agents.id, foreignAgentId));
    }
  });

  it('routes catalog-owned file deletion through exact custody generations', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const custodyId = randomUUID();
    const custodyPath = `email-attachments/custody/${custodyId}`;
    const providerMessageId = randomUUID();
    const attachmentBytes = Buffer.from('private attachment');
    const sha256 = createHash('sha256').update(attachmentBytes).digest('hex');
    const filename = 'private-attachment.pdf';
    const mime = 'application/pdf';
    const entry = {
      providerAttachmentId: `attachment-${randomUUID()}`,
      ordinal: 0,
      filename,
      mime,
      advertisedBytes: attachmentBytes.length,
    };
    const started = await startDocumentIngest(db, {
      agentId,
      title: filename,
      workspacePath: custodyPath,
      mime,
      bytes: attachmentBytes.length,
      sha256,
      source: 'email',
      sourceRef: `gmail:${providerMessageId}`,
      trust: 'unknown',
    });
    if (started.taskId) createdTaskIds.push(started.taskId);
    const markerGeneration = '154';
    const contentGeneration = '155';
    const newerContentGeneration = '156';
    await ws.write(custodyPath, attachmentBytes.toString('utf8'));
    await db.insert(emailAttachmentCustodies).values({
      id: custodyId,
      agentId,
      observerWorkId: randomUUID(),
      claimToken: randomUUID(),
      claimGeneration: 1,
      privacyGeneration: null,
      channelMessageId: `gmail:${providerMessageId}`,
      providerMessageId,
      providerAttachmentId: entry.providerAttachmentId,
      manifestDigest: emailAttachmentManifestDigest([entry]) ?? '',
      attachmentOrdinal: 0,
      workspacePath: custodyPath,
      filename,
      mime,
      advertisedBytes: entry.advertisedBytes,
      actualBytes: attachmentBytes.length,
      sha256,
      markerGeneration,
      objectGeneration: contentGeneration,
      status: 'catalogued',
      fileId: started.document.fileId,
      documentId: started.document.id,
      duplicateDocumentId: null,
    });
    await db
      .update(files)
      .set({ emailAttachmentCustodyId: custodyId, objectGeneration: contentGeneration })
      .where(eq(files.id, started.document.fileId));
    const deletedPaths: string[] = [];
    const deletedVersions: string[] = [];
    const ownedObjects = new Map([
      [markerGeneration, 'marker' as const],
      [newerContentGeneration, 'content' as const],
    ]);
    const custodyWorkspace = ws as typeof ws & {
      emailAttachmentCustody: {
        inspectEmailAttachmentObject(custodyId: string): Promise<{
          generation: string;
          custodyId: string;
          state: 'marker' | 'content';
          sha256: string | null;
        } | null>;
        deleteOwnedEmailAttachment(input: {
          custodyId: string;
          expectedGeneration?: string;
        }): Promise<'deleted' | 'missing' | 'changed'>;
      };
    };
    custodyWorkspace.emailAttachmentCustody = {
      async inspectEmailAttachmentObject(requestedCustodyId) {
        if (requestedCustodyId !== custodyId) return null;
        const latest = [...ownedObjects.keys()].sort(
          (left, right) => Number(right) - Number(left),
        )[0];
        if (!latest) return null;
        return {
          generation: latest,
          custodyId,
          state: ownedObjects.get(latest) ?? 'content',
          sha256: ownedObjects.get(latest) === 'content' ? sha256 : null,
        };
      },
      async deleteOwnedEmailAttachment({ custodyId: requestedCustodyId, expectedGeneration }) {
        if (requestedCustodyId !== custodyId) return 'missing';
        if (!expectedGeneration || !ownedObjects.has(expectedGeneration)) {
          const latest = [...ownedObjects.keys()].sort(
            (left, right) => Number(right) - Number(left),
          )[0];
          return latest && expectedGeneration && Number(latest) > Number(expectedGeneration)
            ? 'changed'
            : 'missing';
        }
        ownedObjects.delete(expectedGeneration);
        deletedVersions.push(`${custodyPath}@${expectedGeneration}`);
        return 'deleted';
      },
    };
    const originalDelete = ws.delete.bind(ws);
    ws.delete = async (path: string) => {
      deletedPaths.push(path);
      await originalDelete(path);
    };
    try {
      await db
        .update(files)
        .set({ emailAttachmentCustodyId: null })
        .where(eq(files.id, started.document.fileId));
      await expect(
        purgeDocument(db, agentId, started.document.id, custodyWorkspace),
      ).rejects.toThrow('Email attachment custody identity is missing');
      expect(deletedPaths).not.toContain(custodyPath);
      expect(ownedObjects.size).toBe(2);
      await db
        .update(files)
        .set({ emailAttachmentCustodyId: custodyId })
        .where(eq(files.id, started.document.fileId));
      await expect(purgeDocument(db, agentId, started.document.id)).resolves.toEqual({
        deleted: true,
        pendingAssets: true,
      });
      const assets = await db
        .select({ name: maintenanceCursors.name, cursor: maintenanceCursors.cursor })
        .from(maintenanceCursors)
        .where(
          like(
            maintenanceCursors.name,
            `privacy-erasure-asset:${agentId}:email-attachment-custody:%`,
          ),
        );
      expect(assets.map(({ cursor }) => JSON.parse(cursor ?? '{}'))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            generation: markerGeneration,
            objectState: 'marker',
            documentId: started.document.id,
          }),
          expect.objectContaining({
            generation: contentGeneration,
            objectState: 'content',
            documentId: started.document.id,
          }),
        ]),
      );
      const unverifiableWorkspace = {
        ...custodyWorkspace,
        emailAttachmentCustody: {
          inspectEmailAttachmentObject: async () => null,
          deleteOwnedEmailAttachment: async () => 'changed' as const,
        },
      };
      await expect(
        purgeDocument(db, agentId, started.document.id, unverifiableWorkspace),
      ).rejects.toThrow('cleanup generation could not be confirmed missing');
      expect(deletedPaths).not.toContain(custodyPath);
      expect(
        (
          await db
            .select({ name: maintenanceCursors.name })
            .from(maintenanceCursors)
            .where(
              like(
                maintenanceCursors.name,
                `privacy-erasure-asset:${agentId}:email-attachment-custody:%`,
              ),
            )
        ).length,
      ).toBe(2);
      await expect(
        purgeDocument(db, agentId, started.document.id, custodyWorkspace),
      ).resolves.toEqual({ deleted: false, pendingAssets: true });
      expect(deletedPaths).not.toContain(custodyPath);
      expect(ws.store.has(custodyPath)).toBe(true);
      expect(deletedVersions).toEqual([`${custodyPath}@${markerGeneration}`]);
      expect(ownedObjects.has(newerContentGeneration)).toBe(true);
      const privacyRepository = createPostgresPrivacyErasureRepository(db);
      const custodyAssets = async () =>
        (await privacyRepository.pendingAssets()).filter(
          (asset) => asset.kind === 'email_attachment_custody' && asset.custodyId === custodyId,
        );
      const pendingCustodyAssets = await custodyAssets();
      expect(pendingCustodyAssets).toHaveLength(1);
      expect(pendingCustodyAssets[0]).toMatchObject({
        generation: newerContentGeneration,
        objectState: 'content',
        documentId: started.document.id,
      });
      expect(ownedObjects.has(newerContentGeneration)).toBe(true);
      expect(await custodyAssets()).toHaveLength(1);
      await expect(
        purgeDocument(db, agentId, started.document.id, custodyWorkspace),
      ).resolves.toEqual({
        deleted: false,
        pendingAssets: false,
      });
      expect(deletedVersions).toEqual([
        `${custodyPath}@${markerGeneration}`,
        `${custodyPath}@${newerContentGeneration}`,
      ]);
      expect(ownedObjects.size).toBe(0);
      expect(ws.store.has(custodyPath)).toBe(true);
      const [scrubbedCustody] = await db
        .select()
        .from(emailAttachmentCustodies)
        .where(eq(emailAttachmentCustodies.id, custodyId));
      expect(scrubbedCustody).toMatchObject({
        status: 'erased',
        observerWorkId: null,
        providerMessageId: null,
        providerAttachmentId: null,
        filename: null,
        mime: null,
        sha256: null,
        documentId: null,
        duplicateDocumentId: null,
      });
      await expect(
        purgeDocument(db, agentId, started.document.id, custodyWorkspace),
      ).resolves.toEqual({
        deleted: false,
        pendingAssets: false,
      });
    } finally {
      ws.delete = originalDelete;
      await db
        .delete(maintenanceCursors)
        .where(
          like(
            maintenanceCursors.name,
            `privacy-erasure-asset:${agentId}:email-attachment-custody:%`,
          ),
        );
      await db.delete(emailAttachmentCustodies).where(eq(emailAttachmentCustodies.id, custodyId));
      if (
        await db
          .select()
          .from(documents)
          .where(eq(documents.id, started.document.id))
          .then((r) => r.length)
      )
        await purgeDocument(db, agentId, started.document.id, ws);
      ws.store.delete(custodyPath);
    }
  });
});
