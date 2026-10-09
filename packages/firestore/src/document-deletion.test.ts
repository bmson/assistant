import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FirestoreDocumentDeletionRepository } from './document-deletion.js';
import { FirestoreDocumentProcessorRepository } from './document-processor.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore document deletion', () => {
  const stores: ReturnType<typeof emulatorStore>[] = [];
  afterEach(async () => Promise.all(stores.splice(0).map(disposeStore)));

  it('retains failed original and processed blob work until a retry deletes it', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    const documentId = randomUUID();
    const fileId = randomUUID();
    const sourcePath = `documents/uploads/${fileId}.txt`;
    const processedPath = `documents/processed/${documentId}.txt`;
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('files', fileId).set({
        id: fileId,
        agentId,
        workspacePath: sourcePath,
        sha256: 'a'.repeat(64),
      }),
      store.doc('documents', documentId).set({
        id: documentId,
        agentId,
        fileId,
        sha256: 'a'.repeat(64),
        processedTextPath: processedPath,
      }),
      store.doc('documentChunks', randomUUID()).set({ id: randomUUID(), agentId, documentId }),
    ]);
    const repository = new FirestoreDocumentDeletionRepository(store, agentId);
    await expect(repository.purge(agentId, documentId)).resolves.toEqual({ deleted: true });
    expect((await store.doc('documents', documentId).get()).exists).toBe(false);

    const deletedPaths: string[] = [];
    let failOriginal = true;
    for (const asset of await repository.pendingAssets(agentId, documentId)) {
      try {
        if (asset.workspacePath === sourcePath && failOriginal) {
          failOriginal = false;
          throw new Error('temporary workspace failure');
        }
        deletedPaths.push(asset.workspacePath);
        await repository.assetDeleted(agentId, asset.id);
      } catch {
        // Simulate process interruption/failure; the asset remains durable.
      }
    }
    expect(deletedPaths).toContain(processedPath);
    await expect(repository.pendingAssets(agentId, documentId)).resolves.toEqual([
      expect.objectContaining({ workspacePath: sourcePath }),
    ]);
    for (const asset of await repository.pendingAssets(agentId, documentId)) {
      deletedPaths.push(asset.workspacePath);
      await repository.assetDeleted(agentId, asset.id);
    }
    expect(deletedPaths).toEqual(expect.arrayContaining([sourcePath, processedPath]));
    await expect(repository.pendingAssets(agentId, documentId)).resolves.toEqual([]);
  });

  it('keeps an unresolved worker marker and cleans a verified late callback output', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    const documentId = randomUUID();
    const fileId = randomUUID();
    const tokenHash = 'stable-token-hash';
    const outputPath = `documents/${documentId}/extracted.txt`;
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('files', fileId).set({
        id: fileId,
        agentId,
        workspacePath: `documents/uploads/${fileId}.png`,
      }),
      store.doc('documents', documentId).set({
        id: documentId,
        agentId,
        fileId,
        sha256: 'b'.repeat(64),
        processorTokenHash: tokenHash,
      }),
    ]);
    const deletion = new FirestoreDocumentDeletionRepository(store, agentId);
    const processor = new FirestoreDocumentProcessorRepository(store, agentId);
    await expect(deletion.purge(agentId, documentId)).resolves.toEqual({ deleted: true });
    const marker = (await deletion.pendingAssets(agentId, documentId)).find((asset) =>
      asset.id.startsWith('document-delete-worker:'),
    );
    expect(marker?.workspacePath).toBe(outputPath);
    if (!marker) throw new Error('expected unresolved worker marker');
    await expect(deletion.assetDeleted(agentId, marker.id)).rejects.toThrow(
      'callback remains unresolved',
    );

    const late = await processor.recordResult({
      documentId,
      tokenHash,
      resultDigest: 'a'.repeat(64),
      tokenMatches: (stored) => stored === tokenHash,
      ok: true,
      unsupported: false,
      error: '',
      processedTextPath: outputPath,
      now: new Date(),
    });
    expect(late).toMatchObject({ ok: false, status: 410, cleanupPath: outputPath });
    await expect(
      processor.resolveDeletedCallback({
        documentId,
        tokenMatches: (stored) => stored === tokenHash,
        processedTextPath: outputPath,
      }),
    ).resolves.toBe(true);
    expect(
      (await deletion.pendingAssets(agentId, documentId)).some((asset) => asset.id === marker.id),
    ).toBe(false);
    await expect(
      processor.resolveDeletedCallback({
        documentId,
        tokenMatches: (stored) => stored === tokenHash,
        processedTextPath: outputPath,
      }),
    ).resolves.toBe(false);
  });

  it('advances past more than one page of foreign chunks without deleting them', async () => {
    const store = emulatorStore();
    stores.push(store);
    const agentId = randomUUID();
    const foreignAgentId = randomUUID();
    const documentId = randomUUID();
    const fileId = randomUUID();
    const digest = createHash('sha256').update('source').digest('hex');
    await store.doc('agents', agentId).set({ id: agentId });
    await store.doc('files', fileId).set({
      id: fileId,
      createdAt: new Date(),
      agentId,
      taskId: null,
      workspacePath: `documents/uploads/${fileId}.txt`,
      mime: 'text/plain',
      bytes: 6,
      sha256: digest,
      objectGeneration: null,
      emailAttachmentCustodyId: null,
    });
    await store.doc('documents', documentId).set({
      id: documentId,
      createdAt: new Date(),
      updatedAt: new Date(),
      agentId,
      fileId,
      title: 'source.txt',
      mime: 'text/plain',
      bytes: 6,
      sha256: digest,
      source: 'upload',
      sourceRef: null,
      trust: 'trusted',
      processedTextPath: null,
      processorTokenHash: null,
    });
    const foreignChunks = Array.from({ length: 405 }, (_, index) => {
      const id = `chunk-${String(index).padStart(3, '0')}`;
      return store.doc('documentChunks', id).set({
        id,
        agentId: foreignAgentId,
        documentId,
        text: 'foreign private content',
      });
    });
    await Promise.all([
      ...foreignChunks,
      store.doc('documentChunks', 'z-owned').set({
        id: 'z-owned',
        agentId,
        documentId,
        text: 'owner content',
      }),
    ]);

    const deletion = new FirestoreDocumentDeletionRepository(store, agentId);
    await expect(deletion.purge(agentId, documentId)).resolves.toEqual({ deleted: true });
    const remaining = await store
      .collection('documentChunks')
      .where('documentId', '==', documentId)
      .get();
    expect(remaining.size).toBe(405);
    expect(remaining.docs.every((doc) => doc.get('agentId') === foreignAgentId)).toBe(true);
    expect((await store.doc('documentChunks', 'z-owned').get()).exists).toBe(false);
  });
});
