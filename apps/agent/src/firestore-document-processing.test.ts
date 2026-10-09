import { randomUUID } from 'node:crypto';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import type { ExecutionPersistence } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recordDocumentProcessorResult,
  runDocumentProcessing,
} from '../../../packages/core/src/memory/document-processor.js';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const SPACE = {
  provider: 'synthetic',
  model: 'processor-fixture',
  dimensions: 1536,
  revision: '1',
};

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore document processor lifecycle',
  { timeout: 30_000 },
  () => {
    const agentId = randomUUID();
    let store: InstallationStore;
    let persistence: ExecutionPersistence;
    let launches: Array<{ documentId: string; callbackToken: string; workspacePath: string }>;
    const db = new Proxy({} as Db, {
      get: (_target, property) => {
        throw new Error(`PostgreSQL access in Firestore test: ${String(property)}`);
      },
    });

    beforeEach(async () => {
      store = emulatorStore();
      persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
      launches = [];
      await store.doc('agents', agentId).set({ id: agentId, name: 'Ada', timezone: 'UTC' });
      await store.doc('rateLimits', 'task').set({
        scope: 'task',
        maxPerHour: null,
        maxPerDay: null,
        updatedAt: new Date(),
      });
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    async function pdf(extra: Record<string, unknown> = {}) {
      const id = randomUUID();
      const fileId = randomUUID();
      const now = new Date();
      await store.doc('files', fileId).set(
        encodeRecord({
          id: fileId,
          agentId,
          taskId: null,
          workspacePath: `documents/uploads/${fileId}-report.pdf`,
          mime: 'application/pdf',
          bytes: 100,
          sha256: randomUUID(),
          createdAt: now,
        }),
      );
      await store.doc('documents', id).set(
        encodeRecord({
          id,
          agentId,
          fileId,
          title: 'Report',
          mime: 'application/pdf',
          source: 'upload',
          sourceRef: '',
          trust: 'owner',
          sha256: randomUUID(),
          status: 'pending',
          extractor: 'pending_processor',
          chunkCount: 0,
          charCount: 0,
          error: null,
          processorTokenHash: null,
          processorStartedAt: null,
          processorAttempts: 0,
          processedTextPath: null,
          extractionMetadata: null,
          createdAt: now,
          updatedAt: now,
          ...extra,
        }),
      );
      return id;
    }

    function run(documentId?: string) {
      return runDocumentProcessing(
        {
          db,
          ...(persistence.documentProcessor
            ? { processorStore: persistence.documentProcessor }
            : {}),
          documentProcessor: {
            callbackUrl: 'https://agent.test/webhooks/document/callback',
            launcher: {
              launch: async (input: {
                documentId: string;
                callbackToken: string;
                source: { workspacePath: string };
              }) => {
                launches.push({
                  documentId: input.documentId,
                  callbackToken: input.callbackToken,
                  workspacePath: input.source.workspacePath,
                });
                return { executionName: 'run-1' };
              },
            },
          },
        },
        {
          trigger: { payload: documentId ? { job: 'documents.process', documentId } : {} },
        } as never,
      );
    }

    const callback = (
      documentId: string,
      token: string,
      result: { ok: boolean; kind?: string },
    ) => {
      const processor = persistence.documentProcessor;
      if (!processor) throw new Error('missing processor repository');
      return recordDocumentProcessorResult(
        { processor, tasks: persistence.tasks },
        { documentId, token, result },
      );
    };

    it('launches once, accepts the one-shot callback, and hands the text to extraction', async () => {
      const id = await pdf();
      expect((await run(id)).summary).toBe('document processor: 1 launched');
      expect((await run(id)).summary).toBe('document processor: 0 launched');
      const [launch] = launches;
      expect(launch?.workspacePath).toContain('-report.pdf');

      expect(await callback(id, 'wrong-token', { ok: true })).toEqual({
        ok: false,
        status: 403,
        error: 'invalid token',
      });
      expect(await callback(id, launch?.callbackToken ?? '', { ok: true })).toEqual({
        ok: true,
        documentId: id,
        enqueued: true,
      });
      expect(await callback(id, launch?.callbackToken ?? '', { ok: true })).toEqual({
        ok: true,
        documentId: id,
        enqueued: true,
      });
      const doc = (await store.doc('documents', id).get()).data();
      expect(doc?.processedTextPath).toBe(`documents/${id}/extracted.txt`);
      const extract = await store
        .collection('tasks')
        .where('trigger.payload.documentId', '==', id)
        .get();
      expect(extract.docs.map((task) => task.get('trigger').payload.job)).toEqual([
        'documents.extract',
      ]);
    });

    it('records an unsupported format, retires exhausted runs, and relaunches stale ones', async () => {
      const unsupported = await pdf();
      await run(unsupported);
      await callback(unsupported, launches[0]?.callbackToken ?? '', {
        ok: false,
        kind: 'unsupported',
      });
      expect((await store.doc('documents', unsupported).get()).get('status')).toBe('unsupported');

      const exhausted = await pdf({ processorAttempts: 3 });
      const stale = await pdf({
        processorAttempts: 1,
        processorStartedAt: new Date(Date.now() - 6 * 3_600_000),
        processorTokenHash: 'old',
      });
      launches = [];
      expect((await run()).summary).toBe('document processor: 1 launched');
      expect((await store.doc('documents', exhausted).get()).get('status')).toBe('failed');
      expect(launches.map((launch) => launch.documentId)).toEqual([stale]);
      expect((await store.doc('documents', stale).get()).get('processorAttempts')).toBe(2);
    });
    it('keeps the third live attempt valid and excludes accepted text from future launches', async () => {
      const id = await pdf({ processorAttempts: 2 });
      await run(id);
      await run(id);
      expect(launches).toHaveLength(1);
      expect((await store.doc('documents', id).get()).get('processorAttempts')).toBe(3);
      expect((await store.doc('documents', id).get()).get('status')).toBe('pending');
      expect((await callback(id, launches[0]?.callbackToken ?? '', { ok: true })).ok).toBe(true);
      await store
        .doc('documents', id)
        .update({ processorStartedAt: new Date(Date.now() - 86_400_000) });
      await run(id);
      expect(launches).toHaveLength(1);
      expect((await store.doc('documents', id).get()).get('status')).toBe('pending');
    });
    it('fences a stale release after a newer claim', async () => {
      const id = await pdf();
      const repository = persistence.documentProcessor;
      if (!repository) throw new Error('missing repository');
      const now = new Date();
      expect(
        await repository.claim(id, { tokenHash: 'first', now, staleBefore: now, maxAttempts: 3 }),
      ).toBe(true);
      expect(
        await repository.claim(id, {
          tokenHash: 'newer',
          now: new Date(now.getTime() + 16 * 60_000),
          staleBefore: new Date(now.getTime() + 60_000),
          maxAttempts: 3,
        }),
      ).toBe(true);
      await repository.release(id, new Date(), 'first');
      expect((await store.doc('documents', id).get()).get('processorTokenHash')).toBe('newer');
    });
    it('commits extraction wake and successful result together across failed settlement and replay', async () => {
      const id = await pdf();
      await run(id);
      const token = launches[0]?.callbackToken ?? '';
      const original = store.db.runTransaction.bind(store.db);
      const fault = vi.spyOn(store.db, 'runTransaction').mockImplementation((action) =>
        original(async (tx) =>
          action(
            new Proxy(tx, {
              get(target, key) {
                if (key === 'update')
                  return (ref: { path: string }, values: Record<string, unknown>) => {
                    if (values.processedTextPath) throw new Error('callback commit interrupted');
                    return Reflect.apply(target.update, target, [ref, values]);
                  };
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ),
        ),
      );
      try {
        await expect(callback(id, token, { ok: true })).rejects.toThrow(
          'callback commit interrupted',
        );
      } finally {
        fault.mockRestore();
      }
      expect((await store.doc('documents', id).get()).get('processedTextPath')).toBeNull();
      expect((await store.collection('tasks').get()).size).toBe(0);
      expect((await store.collection('outbox').get()).size).toBe(0);
      const outcome = await callback(id, token, { ok: true });
      // A fresh composition after process loss sees the same durable receipt.
      persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
      expect(await callback(id, token, { ok: true })).toEqual(outcome);
      expect((await store.collection('tasks').get()).size).toBe(1);
      expect((await store.collection('outbox').get()).size).toBe(1);
      expect(await callback(id, token, { ok: true, kind: 'text' })).toMatchObject({
        ok: false,
        status: 409,
      });
    });
  },
);
