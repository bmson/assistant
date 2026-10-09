import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FirestoreDocumentCatalogRepository } from './document-catalog.js';
import { wakeIntentId } from './outbox.js';
import { createInstallationStore, decodeRecord } from './store.js';

const emulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');

describe.skipIf(!emulator)('Firestore document catalog records', () => {
  const installationId = `document-catalog-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId,
    databaseId: 'assistant-documents-test',
  });
  const repository = new FirestoreDocumentCatalogRepository(store, agentId);
  const now = new Date('2026-09-22T12:00:00.000Z');
  const sha256 = 'a'.repeat(64);

  function input(options: { sha256?: string; agentId?: string; extractor?: string } = {}) {
    const id = randomUUID();
    const fileId = randomUUID();
    const owner = options.agentId ?? agentId;
    const hash = options.sha256 ?? sha256;
    const extractor = options.extractor ?? 'text';
    return {
      file: {
        id: fileId,
        createdAt: now,
        agentId: owner,
        taskId: null,
        workspacePath: `documents/uploads/${fileId}.txt`,
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
        agentId: owner,
        title: 'Owner notes',
        status: extractor === 'unsupported' ? 'unsupported' : 'pending',
        trust: 'owner',
        error: null,
        source: 'upload',
        sourceRef: '',
        mime: 'text/plain',
        sha256: hash,
        fileId,
        extractor,
        chunkCount: 0,
        charCount: 0,
        processorTokenHash: null,
        processorStartedAt: null,
        processorAttempts: 0,
        processedTextPath: null,
        extractionMetadata: null,
      },
    };
  }

  beforeAll(async () => {
    await store.doc('agents', agentId).set({ id: agentId });
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
  });

  async function tasksForDocument(documentId: string) {
    const snapshot = await store.collection('tasks').where('agentId', '==', agentId).get();
    return snapshot.docs.filter((doc) => {
      const task = decodeRecord<{ trigger: { payload?: { documentId?: string } } }>(doc.data());
      return task.trigger.payload?.documentId === documentId;
    });
  }

  function requireTaskId(task: { id: string; queueGeneration: number } | null): string {
    if (!task) throw new Error('expected a document processing task');
    return task.id;
  }

  it('creates file and document records atomically and deduplicates by owner hash', async () => {
    const first = input();
    const created = await repository.createDocumentCatalog(first);
    const taskId = requireTaskId(created.task);
    expect(created).toMatchObject({
      document: first.document,
      duplicate: false,
      task: { queueGeneration: 0 },
    });
    const storedFile = await store.doc('files', first.file.id).get();
    const storedDocument = await store.doc('documents', first.document.id).get();
    expect(decodeRecord(storedFile.data())).toMatchObject(first.file);
    expect(decodeRecord(storedDocument.data())).toMatchObject(first.document);
    const taskDoc = await store.doc('tasks', taskId).get();
    const task = decodeRecord<Record<string, unknown>>(taskDoc.data());
    expect(task).toMatchObject({
      id: taskId,
      agentId,
      status: 'pending',
      type: 'adhoc',
      trust: 'assistant',
      queueGeneration: 0,
      trigger: {
        source: 'internal',
        payload: { job: 'documents.extract', documentId: first.document.id },
      },
    });
    const wake = await store.doc('outbox', wakeIntentId(taskId, 0)).get();
    expect(wake.data()).toMatchObject({
      id: wakeIntentId(taskId, 0),
      taskId,
      generation: 0,
      status: 'pending',
    });

    const duplicate = input();
    const result = await repository.createDocumentCatalog(duplicate);
    expect(result).toEqual({ document: first.document, duplicate: true, task: null });
    expect((await store.doc('files', duplicate.file.id).get()).exists).toBe(false);
    expect((await store.doc('documents', duplicate.document.id).get()).exists).toBe(false);
    expect(await tasksForDocument(first.document.id)).toHaveLength(1);
  });

  it('serializes concurrent writes for the same owner hash', async () => {
    const candidates = [input({ sha256: 'b'.repeat(64) }), input({ sha256: 'b'.repeat(64) })];
    const results = await Promise.all(
      candidates.map((candidate) => repository.createDocumentCatalog(candidate)),
    );
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(results[0]?.document.id).toBe(results[1]?.document.id);
    expect(results.filter((result) => result.task)).toHaveLength(1);
    const documentId = results[0]?.document.id;
    expect(documentId).toBeDefined();
    if (!documentId) throw new Error('expected a deduplicated document result');
    expect(await tasksForDocument(documentId)).toHaveLength(1);
  });

  it('fails closed for a foreign owner and while privacy erasure is active', async () => {
    await expect(
      repository.createDocumentCatalog(input({ agentId: randomUUID() })),
    ).rejects.toThrow('outside the configured owner');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      const candidate = input({ sha256: 'c'.repeat(64) });
      await expect(repository.createDocumentCatalog(candidate)).rejects.toThrow(
        'Privacy erasure is in progress',
      );
      expect((await store.doc('files', candidate.file.id).get()).exists).toBe(false);
      expect((await store.doc('documents', candidate.document.id).get()).exists).toBe(false);
      expect(await tasksForDocument(candidate.document.id)).toHaveLength(0);
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });

  it('adopts matching legacy documents without creating another file record', async () => {
    const legacy = input({ sha256: 'd'.repeat(64) });
    await store.doc('files', legacy.file.id).set(legacy.file);
    await store.doc('documents', legacy.document.id).set(legacy.document);
    const duplicate = input({ sha256: 'd'.repeat(64) });
    const result = await repository.createDocumentCatalog(duplicate);
    expect(result).toEqual({ document: legacy.document, duplicate: true, task: null });
    expect((await store.doc('files', duplicate.file.id).get()).exists).toBe(false);
    const claim = await store.collection('documentDedupKeys').where('agentId', '==', agentId).get();
    expect(claim.docs.filter((snapshot) => snapshot.get('sha256') === 'd'.repeat(64)).length).toBe(
      1,
    );
  });

  it('rejects a deduplicated document whose linked file hash does not match', async () => {
    const original = input({ sha256: 'e'.repeat(64) });
    await repository.createDocumentCatalog(original);
    await store.doc('files', original.file.id).update({ sha256: 'f'.repeat(64) });
    await expect(
      repository.createDocumentCatalog(input({ sha256: 'e'.repeat(64) })),
    ).rejects.toThrow('invalid owner, identity, or content hash');
  });

  it('maps PDF and processor-required documents to jobs and unsupported documents to no task', async () => {
    const pdf = input({ sha256: '3'.repeat(64), extractor: 'pdf' });
    const extracted = await repository.createDocumentCatalog(pdf);
    const extractionTaskId = requireTaskId(extracted.task);
    expect(
      decodeRecord<Record<string, unknown>>(
        (await store.doc('tasks', extractionTaskId).get()).data(),
      ),
    ).toMatchObject({
      trigger: {
        payload: { job: 'documents.extract', documentId: pdf.document.id },
      },
    });

    const processor = input({ sha256: '1'.repeat(64), extractor: 'pending_processor' });
    const processed = await repository.createDocumentCatalog(processor);
    const processorTaskId = requireTaskId(processed.task);
    expect(processed.task).toMatchObject({ queueGeneration: 0 });
    const processorTask = decodeRecord<Record<string, unknown>>(
      (await store.doc('tasks', processorTaskId).get()).data(),
    );
    expect(processorTask).toMatchObject({
      budgetUsdLimit: '0.0500',
      trigger: {
        source: 'internal',
        payload: { job: 'documents.process', documentId: processor.document.id },
      },
    });
    expect((await store.doc('outbox', wakeIntentId(processorTaskId, 0)).get()).exists).toBe(true);

    const unsupported = input({ sha256: '2'.repeat(64), extractor: 'unsupported' });
    const filed = await repository.createDocumentCatalog(unsupported);
    expect(filed).toEqual({ document: unsupported.document, duplicate: false, task: null });
    expect(await tasksForDocument(unsupported.document.id)).toHaveLength(0);
  });
});
