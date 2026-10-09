import { createHash, randomUUID } from 'node:crypto';
import { documentExtractionMetadata } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { FirestoreDocumentProcessorRepository } from './document-processor.js';
import { FirestoreDocumentReadRepository } from './documents.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore processor structure coverage',
  () => {
    it.each(['cell-addresses', 'ordered-slides'] as const)(
      'retains %s coverage through callback and catalog reads',
      async (representation) => {
        const store = emulatorStore();
        const agentId = randomUUID();
        const documentId = randomUUID();
        const fileId = randomUUID();
        const now = new Date('2026-10-07T12:00:00Z');
        try {
          await store.doc('agents', agentId).set({ id: agentId });
          await store.doc('files', fileId).set({ id: fileId, agentId, bytes: 256 });
          await store.doc('documents', documentId).set({
            id: documentId,
            agentId,
            fileId,
            createdAt: now,
            updatedAt: now,
            title: 'Structural fixture',
            mime: 'application/octet-stream',
            source: 'upload',
            trust: 'owner',
            status: 'pending',
            extractor: 'pending_processor',
            chunkCount: 0,
            charCount: 0,
            error: null,
            processorTokenHash: 'token',
            processorStartedAt: now,
            processorAttempts: 1,
            processedTextPath: null,
            extractionMetadata: null,
          });
          const repository = new FirestoreDocumentProcessorRepository(store, agentId);
          const metadata = documentExtractionMetadata({
            chars: 23,
            structure: { complete: true, representation },
          });
          const input = {
            documentId,
            tokenHash: 'token',
            tokenMatches: (stored: string) => stored === 'token',
            resultDigest: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
            ok: true,
            unsupported: false,
            error: '',
            processedTextPath: `documents/${documentId}/extracted.txt`,
            extractionMetadata: metadata,
            now,
          };
          const outcome = await repository.recordResult(input);
          expect(outcome).toMatchObject({ ok: true, extract: true });
          expect(await repository.recordResult(input)).toMatchObject({ ok: true, replayed: true });
          const read = new FirestoreDocumentReadRepository(store, agentId);
          expect((await read.get(agentId, documentId))?.document.extractionMetadata).toEqual(
            metadata,
          );
          expect(
            (await read.list(agentId)).documents.find((row) => row.id === documentId)
              ?.extractionMetadata,
          ).toEqual(metadata);
          expect(
            await repository.recordResult({ ...input, resultDigest: 'different' }),
          ).toMatchObject({ ok: false, status: 409 });
          expect((await store.collection('tasks').where('agentId', '==', agentId).get()).size).toBe(
            1,
          );
        } finally {
          await disposeStore(store);
        }
      },
    );
  },
);
