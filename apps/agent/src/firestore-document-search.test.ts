import { randomUUID } from 'node:crypto';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import type { ExecutionPersistence } from '@assistant/persistence';
import { registerDriveTools, type ToolContext, ToolRegistry } from '@assistant/tools';
import { registerDocumentTools } from '@assistant/tools/documents';
import { FieldValue } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embeddingSpaceKey } from '../../../packages/firestore/src/memory.js';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const SPACE = { provider: 'synthetic', model: 'doc-fixture', dimensions: 1536, revision: '1' };

function axis(index: number, weight = 1): number[] {
  const vector = new Array(1536).fill(0);
  vector[index] = weight;
  vector[1535] = Math.sqrt(1 - weight * weight) || 0;
  return vector;
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore document search and Drive ingest',
  () => {
    const agentId = randomUUID();
    let store: InstallationStore;
    let persistence: ExecutionPersistence;
    const db = new Proxy({} as Db, {
      get: (_target, property) => {
        throw new Error(`PostgreSQL access in Firestore test: ${String(property)}`);
      },
    });

    beforeEach(async () => {
      store = emulatorStore();
      persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
      await store.doc('agents', agentId).set({ id: agentId, name: 'Ada', timezone: 'UTC' });
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    const ctx = (): ToolContext => ({
      taskId: randomUUID(),
      agentId,
      trust: 'owner',
      tainted: false,
      db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
    });

    async function document(title: string, status = 'ready') {
      const id = randomUUID();
      await store.doc('documents', id).set(
        encodeRecord({
          id,
          agentId,
          fileId: randomUUID(),
          title,
          mime: 'text/plain',
          source: 'upload',
          sourceRef: '',
          trust: 'owner',
          sha256: randomUUID(),
          status,
          extractor: 'text',
          chunkCount: 1,
          charCount: 10,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      return id;
    }

    async function chunk(documentId: string, text: string, vector: number[], space = SPACE) {
      const id = `${documentId}:${text.length}`;
      await store.doc('documentChunks', id).set({
        ...encodeRecord({ id, agentId, documentId, chunkIndex: 0, text, createdAt: new Date() }),
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
      });
    }

    it('returns the nearest passages of ready documents in the configured space', async () => {
      const lease = await document('Lease');
      const draft = await document('Draft', 'extracting');
      const insurance = await document('Insurance');
      await chunk(lease, 'The rent is due on the first.', axis(1, 0.99));
      await chunk(insurance, 'Deductible is 500.', axis(1, 0.8));
      await chunk(draft, 'Not ready yet', axis(1, 1));
      await chunk(lease, 'Old model vector', axis(1, 1), { ...SPACE, revision: '2' });

      const registry = registerDocumentTools(new ToolRegistry(), {
        embed: async () => ({
          embeddings: [axis(1, 1)],
          embeddingSpaceKey: embeddingSpaceKey(SPACE),
        }),
        ...(persistence.documentSearch ? { search: persistence.documentSearch } : {}),
      });
      const tool = registry.get('documents.search')?.tool;
      const result = (await tool?.execute({ query: 'when is rent due', limit: 5 }, ctx())) as {
        passages: Array<{ document: string; snippet: string }>;
      };
      expect(result.passages.map((p) => [p.document, p.snippet])).toEqual([
        ['Lease', 'The rent is due on the first.'],
        ['Insurance', 'Deductible is 500.'],
      ]);

      const only = await persistence.documentSearch?.search({
        agentId,
        embedding: axis(1, 1),
        embeddingSpaceKey: embeddingSpaceKey(SPACE),
        limit: 5,
        documentId: insurance,
        minSimilarity: 0.7,
      });
      expect(only?.map((hit) => hit.title)).toEqual(['Insurance']);
      await expect(
        persistence.documentSearch?.search({
          agentId: randomUUID(),
          embedding: axis(1, 1),
          embeddingSpaceKey: embeddingSpaceKey(SPACE),
          limit: 5,
          minSimilarity: 0.7,
        }),
      ).rejects.toThrow('outside the configured owner');
    });

    it('files a Drive file into the Firestore catalog once, with its extraction task', async () => {
      const writes: string[] = [];
      const deletes: string[] = [];
      const client = {
        api: async () => ({ id: 'drive-1', name: 'Notes', mimeType: 'text/plain', size: '12' }),
        apiBytes: async () => ({ body: Buffer.from('Meeting notes'), contentType: 'text/plain' }),
      };
      const registry = registerDriveTools(new ToolRegistry(), {
        client: client as never,
        workspace: {
          writeBytes: async (path: string) => {
            writes.push(path);
          },
          delete: async (path: string) => {
            deletes.push(path);
          },
        } as never,
        ...(persistence.documentCatalog ? { catalog: persistence.documentCatalog } : {}),
      });
      const ingest = registry.get('drive.ingest')?.tool;
      const first = (await ingest?.execute({ fileId: 'drive-1' }, ctx())) as {
        documentId: string;
        duplicate: boolean;
        stagedWorkspacePath: string;
      };
      expect(first.duplicate).toBe(false);
      const row = (await store.doc('documents', first.documentId).get()).data();
      expect([row?.source, row?.sourceRef, row?.trust, row?.status]).toEqual([
        'drive',
        'drive-1',
        'known',
        'pending',
      ]);
      const tasks = await store
        .collection('tasks')
        .where('trigger.payload.documentId', '==', first.documentId)
        .get();
      expect(tasks.docs.map((doc) => doc.get('trigger').payload.job)).toEqual([
        'documents.extract',
      ]);

      const again = (await ingest?.execute({ fileId: 'drive-1' }, ctx())) as {
        duplicate: boolean;
        stagedWorkspacePath: string;
      };
      expect(again.duplicate).toBe(true);
      expect(again.stagedWorkspacePath).toBe(first.stagedWorkspacePath);
      expect(writes).toEqual([first.stagedWorkspacePath, first.stagedWorkspacePath]);
      expect(deletes).toEqual([]);
      const stillOneExtraction = await store
        .collection('tasks')
        .where('trigger.payload.documentId', '==', first.documentId)
        .get();
      expect(stillOneExtraction.size).toBe(1);
    });
  },
);
