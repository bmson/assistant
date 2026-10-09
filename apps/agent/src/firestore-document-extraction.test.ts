import { createHash, randomUUID } from 'node:crypto';
import type { ExecutorDeps } from '@assistant/core';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  createInstallationStore,
  FirestoreDocumentCatalogRepository,
  FirestoreDocumentExtractionRepository,
} from '@assistant/firestore';
import {
  type DocumentExtractionRepository,
  embeddingSpaceIdentityKey,
} from '@assistant/persistence';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeRecord } from '../../../packages/firestore/src/store.js';
import type { AgentDeps } from './deps.js';
import { executeAgentTask } from './task-runner.js';

const emulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');

describe.skipIf(!emulator)('Firestore document extraction worker composition', () => {
  const agentId = randomUUID();
  const store = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId: `document-extraction-worker-${randomUUID()}`,
    databaseId: 'assistant-document-worker-test',
  });
  const catalog = new FirestoreDocumentCatalogRepository(store, agentId);
  const DOCUMENT_SPACE = {
    provider: 'synthetic',
    model: 'document-extraction-fixture',
    dimensions: 1536,
    revision: '1',
  } as const;
  const documentExtractionRepository = new FirestoreDocumentExtractionRepository(
    store,
    agentId,
    DOCUMENT_SPACE,
  );
  const persistence = createFirestoreExecutionPersistence(store, agentId, DOCUMENT_SPACE);
  const content = `Quarterly planning notes.\n\n${'Milestone and owner details. '.repeat(4)}`;
  const workspace = {
    async read() {
      return content;
    },
    async readBytes() {
      return Buffer.from(content, 'utf8');
    },
    async write() {
      return { bytes: 0 };
    },
    async list() {
      return [];
    },
  };
  const router = {
    embeddingSpace: vi.fn(async () => DOCUMENT_SPACE),
    embeddingSpaceKey: vi.fn(async () => embeddingSpaceIdentityKey(DOCUMENT_SPACE)),
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Array(1536).fill(0.125))),
  } as unknown as ExecutorDeps['router'];
  const unavailable = new Proxy(
    {},
    {
      get: (_target, property) => {
        throw new Error(`Unexpected SQL or model dependency access: ${String(property)}`);
      },
    },
  );
  let deps: AgentDeps;

  beforeAll(async () => {
    await store.doc('agents', agentId).set({ id: agentId, name: 'Document extraction owner' });
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
  });

  it('claims the real task lease, renews it, and checkpoints/finalizes without SQL', async () => {
    const documentId = randomUUID();
    const fileId = randomUUID();
    const sha256 = createHash('sha256').update(content).digest('hex');
    const created = await catalog.createDocumentCatalog({
      file: {
        id: fileId,
        createdAt: new Date(),
        agentId,
        taskId: null,
        workspacePath: `documents/uploads/${fileId}.txt`,
        mime: 'text/plain',
        bytes: Buffer.byteLength(content),
        sha256,
        objectGeneration: null,
        emailAttachmentCustodyId: null,
      },
      document: {
        id: documentId,
        createdAt: new Date(),
        updatedAt: new Date(),
        agentId,
        title: 'Quarterly planning notes',
        status: 'pending',
        trust: 'owner',
        error: null,
        source: 'upload',
        sourceRef: '',
        mime: 'text/plain',
        sha256,
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
    if (!created.task) throw new Error('catalog did not create the extraction task');

    let renewalsWithRotatedToken = 0;
    const originalRenew = persistence.tasks.renew.bind(persistence.tasks);
    vi.spyOn(persistence.tasks, 'renew').mockImplementation(async (lease) => {
      const oldToken = lease.leaseToken;
      const renewed = await originalRenew(lease);
      if (renewed && lease.leaseToken !== oldToken) renewalsWithRotatedToken += 1;
      return renewed;
    });

    const modules = {
      channels: [],
      emailObservers: [],
      jobUnavailable: () => null,
      channelUnavailable: () => null,
      taskKindUnavailable: () => null,
      taskHandlerFor: () => undefined,
    };
    deps = {
      config: {
        PERSISTENCE_DRIVER: 'firestore',
        FIRESTORE_AGENT_ID: agentId,
      },
      db: unavailable as Db,
      router,
      dispatcher: unavailable as ExecutorDeps['dispatcher'],
      firestoreStore: store,
      persistence,
      documentExtractionRepository: documentExtractionRepository as DocumentExtractionRepository,
      workspace,
      modules,
      registry: unavailable as AgentDeps['registry'],
      outOfBandNotifier: unavailable as AgentDeps['outOfBandNotifier'],
    } as unknown as AgentDeps;

    const outcome = await executeAgentTask(deps, created.task.id, created.task.queueGeneration);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ outcome: 'done' });
    expect(renewalsWithRotatedToken).toBeGreaterThanOrEqual(3);
    expect(router.embed).toHaveBeenCalledOnce();

    const storedDocument = decodeRecord<Record<string, unknown>>(
      (await store.doc('documents', documentId).get()).data(),
    );
    const storedTask = decodeRecord<Record<string, unknown>>(
      (await store.doc('tasks', created.task.id).get()).data(),
    );
    const chunks = await store
      .collection('documentChunks')
      .where('documentId', '==', documentId)
      .get();
    expect(storedDocument).toMatchObject({ status: 'ready', chunkCount: 1 });
    expect(storedTask.status).toBe('done');
    expect(storedTask.state).toMatchObject({
      plannerState: { documentExtract: { index: 1, total: 1 } },
    });
    expect(chunks.size).toBe(1);
  });
});
