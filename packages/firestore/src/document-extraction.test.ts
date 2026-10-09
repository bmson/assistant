import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FirestoreDocumentCatalogRepository } from './document-catalog.js';
import { FirestoreDocumentExtractionRepository } from './document-extraction.js';
import { embeddingSpaceKey } from './memory.js';
import { createInstallationStore, decodeRecord } from './store.js';
import { FirestoreTaskLeaseRepository } from './tasks.js';

const emulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');

describe.skipIf(!emulator)('Firestore document extraction lifecycle', () => {
  const installationId = `document-extraction-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId,
    databaseId: 'assistant-document-extraction-test',
  });
  const catalog = new FirestoreDocumentCatalogRepository(store, agentId);
  const embeddingSpace = {
    provider: 'test',
    model: 'document-extraction-fixture',
    dimensions: 1536,
    revision: '1',
  };
  const extraction = new FirestoreDocumentExtractionRepository(store, agentId, embeddingSpace);
  const leases = new FirestoreTaskLeaseRepository(store);
  const now = new Date('2026-09-22T12:00:00.000Z');
  const vector = (value: number) => new Array(1536).fill(value);
  const configuredEmbeddingSpaceKey = embeddingSpaceKey(embeddingSpace);

  beforeAll(async () => {
    await store.doc('agents', agentId).set({ id: agentId });
  });
  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
  });

  async function start() {
    const id = randomUUID();
    const fileId = randomUUID();
    const hash = randomUUID().replaceAll('-', '').padEnd(64, 'b').slice(0, 64);
    const created = await catalog.createDocumentCatalog({
      file: {
        id: fileId,
        createdAt: now,
        agentId,
        taskId: null,
        workspacePath: `documents/${fileId}.txt`,
        mime: 'text/plain',
        bytes: 12,
        sha256: hash,
        objectGeneration: null,
        emailAttachmentCustodyId: null,
      },
      document: {
        id,
        createdAt: now,
        updatedAt: now,
        agentId,
        title: 'Extraction test',
        status: 'pending',
        trust: 'owner',
        error: null,
        source: 'upload',
        sourceRef: '',
        mime: 'text/plain',
        sha256: hash,
        fileId,
        extractor: 'text',
        chunkCount: 0,
        charCount: 0,
        processorTokenHash: null,
        processorStartedAt: null,
        processorAttempts: 0,
        processedTextPath: null,
        extractionMetadata: null,
      },
    });
    if (!created.task) throw new Error('document ingest did not create extraction task');
    const lease = await leases.claim(created.task.id, created.task.queueGeneration);
    if (!lease) throw new Error('could not claim extraction task');
    const leaseToken = lease.leaseToken;
    if (!leaseToken) throw new Error('claimed extraction task has no lease token');
    return {
      documentId: id,
      taskId: created.task.id,
      lease,
      fence: {
        agentId,
        documentId: id,
        taskId: created.task.id,
        queueGeneration: created.task.queueGeneration,
        leaseToken,
      },
    };
  }

  it('commits each bounded chunk batch with its task cursor and supports exact retries', async () => {
    const run = await start();
    const initial = { index: 0, total: 2 };
    expect(await extraction.begin({ fence: run.fence, extractor: 'text', cursor: initial })).toBe(
      true,
    );
    const loaded = await extraction.load(run.fence);
    expect(loaded?.document).toMatchObject({ id: run.documentId, agentId, status: 'extracting' });
    expect(loaded?.file?.agentId).toBe(agentId);
    const state = { plannerState: { documentExtract: { index: 2, total: 2 } } };
    const chunks = [0, 1].map((chunkIndex) => ({
      id: randomUUID(),
      createdAt: now,
      agentId,
      documentId: run.documentId,
      chunkIndex,
      text: `content ${chunkIndex}`,
      charCount: 9,
      embedding: vector(chunkIndex + 0.25),
      embeddingSpaceKey: configuredEmbeddingSpaceKey,
    }));
    const batch = {
      fence: run.fence,
      chunks,
      cursor: { index: 2, total: 2 },
      state,
      progress: 'extract: 2/2',
      progressPercent: 100,
    };
    expect(await extraction.persistBatch(batch)).toBe(true);
    expect(await extraction.persistBatch(batch)).toBe(true);

    const task = decodeRecord<{ state: typeof state }>(
      (await store.doc('tasks', run.taskId).get()).data(),
    );
    const stored = await store
      .collection('documentChunks')
      .where('documentId', '==', run.documentId)
      .get();
    expect(task.state).toEqual(state);
    expect(stored.size).toBe(2);
    const storedChunk = decodeRecord<{ embedding: number[] }>(stored.docs[0]?.data());
    expect(storedChunk.embedding).toHaveLength(1536);
    expect(
      await extraction.finalize({
        fence: run.fence,
        extractor: 'text',
        chunkCount: 2,
        charCount: 18,
        state,
      }),
    ).toBe(true);
    expect((await store.doc('documents', run.documentId).get()).get('status')).toBe('ready');
  });

  it('does not checkpoint missing chunks or write after lease loss or an erasure fence', async () => {
    const run = await start();
    expect(
      await extraction.begin({
        fence: run.fence,
        extractor: 'text',
        cursor: { index: 0, total: 1 },
      }),
    ).toBe(true);
    const chunk = {
      id: randomUUID(),
      createdAt: now,
      agentId,
      documentId: run.documentId,
      chunkIndex: 0,
      text: 'safe content',
      charCount: 12,
      embedding: vector(0.5),
      embeddingSpaceKey: configuredEmbeddingSpaceKey,
    };
    const input = {
      fence: run.fence,
      chunks: [chunk],
      cursor: { index: 1, total: 1 },
      state: { plannerState: { documentExtract: { index: 1, total: 1 } } },
      progress: 'extract: 1/1',
      progressPercent: 100,
    };
    await store.doc('tasks', run.taskId).update({ queueGeneration: run.fence.queueGeneration + 1 });
    expect(await extraction.persistBatch(input)).toBe(false);
    expect(
      (await store.collection('documentChunks').where('documentId', '==', run.documentId).get())
        .size,
    ).toBe(0);

    const second = await start();
    expect(
      await extraction.begin({
        fence: second.fence,
        extractor: 'text',
        cursor: { index: 0, total: 1 },
      }),
    ).toBe(true);
    await store.doc('privacyErasureJobs', agentId).set({
      agentId,
      generation: 'test-generation',
      status: 'active',
      counts: {},
    });
    expect(
      await extraction.persistBatch({
        ...input,
        fence: second.fence,
        chunks: [{ ...chunk, documentId: second.documentId }],
      }),
    ).toBe(false);
    expect(
      (await store.collection('documentChunks').where('documentId', '==', second.documentId).get())
        .size,
    ).toBe(0);
    await store.doc('privacyErasureJobs', agentId).delete();
  });

  it('rejects a cursor checkpoint whose chunk is missing without partial writes', async () => {
    const run = await start();
    expect(
      await extraction.begin({
        fence: run.fence,
        extractor: 'text',
        cursor: { index: 0, total: 2 },
      }),
    ).toBe(true);
    await store
      .doc('tasks', run.taskId)
      .update({ state: { plannerState: { documentExtract: { index: 1, total: 2 } } } });
    const chunk = {
      id: randomUUID(),
      createdAt: now,
      agentId,
      documentId: run.documentId,
      chunkIndex: 0,
      text: 'first chunk',
      charCount: 11,
      embedding: null,
      embeddingSpaceKey: null,
    };
    await expect(
      extraction.persistBatch({
        fence: run.fence,
        chunks: [chunk],
        cursor: { index: 1, total: 2 },
        state: { plannerState: { documentExtract: { index: 1, total: 2 } } },
        progress: 'extract: 1/2',
        progressPercent: 50,
      }),
    ).rejects.toThrow('Document extraction cursor has missing chunk records');
    expect(
      (await store.collection('documentChunks').where('documentId', '==', run.documentId).get())
        .size,
    ).toBe(0);
    const task = decodeRecord<{ state: unknown }>(
      (await store.doc('tasks', run.taskId).get()).data(),
    );
    expect(task.state).toEqual({ plannerState: { documentExtract: { index: 1, total: 2 } } });
  });
});
