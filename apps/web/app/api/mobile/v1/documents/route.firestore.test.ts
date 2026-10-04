import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import {
  createInstallationStore,
  FirestoreDocumentReadRepository,
  wakeIntentId,
} from '@assistant/firestore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  mobile: vi.fn(),
  store: null as unknown,
  workspace: null as unknown,
}));
vi.mock('@/lib/server', () => ({
  getFirestoreInstallationStore: () => auth.store,
  getWorkspace: () => auth.workspace,
  getDb: () => {
    throw new Error('PostgreSQL-backed web surface is unavailable');
  },
  getApplication: () => {
    throw new Error('PostgreSQL-backed web surface is unavailable');
  },
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) =>
    Response.json(body, { ...init, headers: { 'cache-control': 'no-store' } }),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');

describe.skipIf(!emulator)('Firestore mobile Documents with PostgreSQL offline', () => {
  const installationId = `mobile-documents-${randomUUID()}`;
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const documentId = randomUUID();
  const foreignDocumentId = randomUUID();
  const primaryConversationId = randomUUID();
  const fileId = randomUUID();
  const otherFileId = randomUUID();
  let uploadedDocumentId: string | undefined;
  let uploadedTaskId: string | undefined;
  const store = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId,
    databaseId: 'assistant-mobile-documents-test',
  });
  const staged = new Map<string, Buffer>();
  const workspace = {
    async writeBytes(path: string, bytes: Buffer) {
      staged.set(path, Buffer.from(bytes));
      return { bytes: bytes.length };
    },
    async delete(path: string) {
      staged.delete(path);
    },
  };
  const now = new Date('2026-09-20T10:00:00.000Z');
  const url = 'http://localhost/api/mobile/v1/documents';

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"test","dimensions":768,"revision":"v1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'documents');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    auth.mobile.mockResolvedValue(true);
    auth.store = store;
    auth.workspace = workspace;
    staged.clear();
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('conversations', primaryConversationId).set({
        id: primaryConversationId,
        agentId,
        channel: 'chat',
        title: '',
        trust: 'owner',
        modelOverride: null,
        isPrimary: true,
        metadata: {},
        archivedAt: null,
        lastReadAt: null,
        createdAt: now,
        updatedAt: now,
      }),
      store.doc('files', fileId).set({ id: fileId, agentId, bytes: 456 }),
      store.doc('files', otherFileId).set({ id: otherFileId, agentId: otherAgentId, bytes: 99 }),
      store.doc('documents', documentId).set({
        id: documentId,
        agentId,
        fileId,
        title: 'Owner handbook',
        mime: 'application/pdf',
        source: 'upload',
        trust: 'owner',
        status: 'ready',
        extractor: 'pdf',
        chunkCount: 2,
        charCount: 27,
        error: null,
        createdAt: now,
      }),
      store.doc('documents', foreignDocumentId).set({
        id: foreignDocumentId,
        agentId: otherAgentId,
        fileId: otherFileId,
        title: 'Private foreign doc',
        mime: 'text/plain',
        source: 'upload',
        trust: 'owner',
        status: 'pending',
        extractor: '',
        chunkCount: 1,
        charCount: 9,
        createdAt: new Date(now.getTime() + 1000),
      }),
      store.doc('documentChunks', 'owner-a').set({
        id: 'owner-a',
        agentId,
        documentId,
        chunkIndex: 0,
        text: 'First passage',
        charCount: 13,
      }),
      store.doc('documentChunks', 'owner-b').set({
        id: 'owner-b',
        agentId,
        documentId,
        chunkIndex: 1,
        text: 'Second passage',
        charCount: 14,
      }),
      store.doc('documentChunks', 'foreign').set({
        id: 'foreign',
        agentId: otherAgentId,
        documentId,
        chunkIndex: 2,
        text: 'Foreign passage',
        charCount: 15,
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('returns the list DTO, owner-scoped stats, and detail passages without PostgreSQL', async () => {
    const { GET } = await import('./route.js');
    const { GET: getDetail } = await import('./[id]/route.js');
    const { getDb } = await import('@/lib/server');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');

    const listResponse = await GET(new Request(url));
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get('cache-control')).toBe('no-store');
    const list = await listResponse.json();
    expect(list.documents).toEqual([
      {
        id: documentId,
        title: 'Owner handbook',
        mime: 'application/pdf',
        source: 'upload',
        trust: 'owner',
        status: 'ready',
        extractor: 'pdf',
        chunkCount: 2,
        charCount: 27,
        bytes: 456,
        error: null,
        createdAt: now.toISOString(),
      },
    ]);
    expect(list.stats).toEqual({ total: 1, ready: 1, pending: 0, chunks: 2 });
    expect(list.primaryConversationId).toBe(primaryConversationId);
    expect(JSON.stringify(list)).not.toContain('Private foreign doc');

    const detailResponse = await getDetail(new Request(`${url}/${documentId}`), {
      params: Promise.resolve({ id: documentId }),
    });
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toEqual({
      document: list.documents[0],
      chunks: [
        { chunkIndex: 0, text: 'First passage', charCount: 13 },
        { chunkIndex: 1, text: 'Second passage', charCount: 14 },
      ],
    });
    const foreignResponse = await getDetail(new Request(`${url}/${foreignDocumentId}`), {
      params: Promise.resolve({ id: foreignDocumentId }),
    });
    expect(foreignResponse.status).toBe(404);
  });

  it('authenticates first and validates Firestore document writes', async () => {
    const { GET, POST } = await import('./route.js');
    const { DELETE } = await import('./[id]/route.js');
    const { proxy } = await import('../../../../../proxy.js');
    const { NextRequest } = await import('next/server');
    for (const [path, method] of [
      ['/documents', 'GET'],
      ['/documents', 'POST'],
      ['/api/documents/upload', 'POST'],
      [`/api/mobile/v1/documents/${documentId}`, 'DELETE'],
    ])
      expect(proxy(new NextRequest(`http://localhost${path}`, { method })).status).toBe(
        path.startsWith('/api/') ? 200 : method === 'GET' ? 307 : 410,
      );
    auth.mobile.mockResolvedValueOnce(false);
    expect((await GET(new Request(url))).status).toBe(401);
    expect((await POST(new Request(url, { method: 'POST' }))).status).toBe(400);
    auth.mobile.mockResolvedValueOnce(false);
    const params = { params: Promise.resolve({ id: documentId }) };
    expect(
      (await DELETE(new Request(`${url}/${documentId}`, { method: 'DELETE' }), params)).status,
    ).toBe(401);
    expect(
      (
        await DELETE(new Request(`${url}/not-a-uuid`, { method: 'DELETE' }), {
          params: Promise.resolve({ id: 'not-a-uuid' }),
        })
      ).status,
    ).toBe(400);
  });

  it('stages and catalogs owner text atomically with its extraction wake while PostgreSQL is offline', async () => {
    const { POST } = await import('./route.js');
    const bytes = Buffer.from('The owner has a text document.');
    const form = new FormData();
    form.set('file', new File([bytes], 'owner-notes.txt', { type: 'text/plain' }));
    form.set('title', '  Owner notes  ');
    const response = await POST(new Request(url, { method: 'POST', body: form }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, duplicate: false });

    const docs = await store.collection('documents').where('agentId', '==', agentId).get();
    const snapshot = docs.docs.find((row) => row.get('title') === 'Owner notes');
    expect(snapshot).toBeDefined();
    const documentIdFromRecord = String(snapshot?.get('id'));
    uploadedDocumentId = documentIdFromRecord;
    const document = snapshot?.data();
    expect(document).toMatchObject({
      agentId,
      title: 'Owner notes',
      source: 'upload',
      trust: 'owner',
      mime: 'text/plain',
      status: 'pending',
      extractor: 'text',
      chunkCount: 0,
      charCount: 0,
    });
    const file = await store.doc('files', String(document?.fileId)).get();
    const workspacePath = String(file.get('workspacePath'));
    expect(staged.get(workspacePath)).toEqual(bytes);
    expect(file.get('sha256')).toBe(document?.sha256);

    const tasks = await store
      .collection('tasks')
      .where('trigger.payload.documentId', '==', documentIdFromRecord)
      .get();
    expect(tasks.size).toBe(1);
    const task = tasks.docs[0];
    if (!task) throw new Error('document task was not persisted');
    expect(task?.get('trigger.payload.job')).toBe('documents.extract');
    // The Firestore document key is an encoding of the record id; the wake
    // intent is keyed by the task record id.
    const taskId = String(task.get('id'));
    uploadedTaskId = taskId;
    const wake = await store
      .doc('outbox', wakeIntentId(taskId, Number(task.get('queueGeneration'))))
      .get();
    expect(wake.exists).toBe(true);
    expect(wake.get('status')).toBe('pending');
    const duplicateForm = new FormData();
    duplicateForm.set('file', new File([bytes], 'duplicate.txt', { type: 'text/plain' }));
    const duplicateResponse = await POST(new Request(url, { method: 'POST', body: duplicateForm }));
    expect(duplicateResponse.status).toBe(201);
    expect(await duplicateResponse.json()).toEqual({ ok: true, duplicate: true });
    expect(staged.size).toBe(1);
    expect((await store.collection('documents').where('agentId', '==', agentId).get()).size).toBe(
      2,
    );
    expect(
      (
        await store
          .collection('tasks')
          .where('trigger.payload.documentId', '==', documentIdFromRecord)
          .get()
      ).size,
    ).toBe(1);
  });

  it('cleans staged bytes when the erasure fence rejects commit', async () => {
    const { POST } = await import('./route.js');
    const stagedBaseline = staged.size;
    const documentsBaseline = (await store.collection('documents').get()).size;
    const filesBaseline = (await store.collection('files').get()).size;
    const tasksBaseline = (await store.collection('tasks').get()).size;
    const outboxBaseline = (await store.collection('outbox').get()).size;
    expect(staged.size).toBe(stagedBaseline);

    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    const form = new FormData();
    form.set('file', new File(['private text'], 'private.txt', { type: 'text/plain' }));
    const response = await POST(new Request(url, { method: 'POST', body: form }));
    expect(response.status).toBe(409);
    expect(staged.size).toBe(stagedBaseline);
    expect((await store.collection('documents').get()).size).toBe(documentsBaseline);
    expect((await store.collection('files').get()).size).toBe(filesBaseline);
    expect((await store.collection('tasks').get()).size).toBe(tasksBaseline);
    expect((await store.collection('outbox').get()).size).toBe(outboxBaseline);
    await store.doc('privacyErasureJobs', agentId).delete();
  });

  it('supplies the overview Documents panel from Firestore', async () => {
    const { GET } = await import('../overview/route.js');
    const response = await GET(new Request('http://localhost/api/mobile/v1/overview'));
    expect(response.status).toBe(200);
    const overview = await response.json();
    expect(overview.documents.documents.map((document: { id: string }) => document.id)).toEqual(
      expect.arrayContaining([documentId, uploadedDocumentId]),
    );
    expect(overview.documents.stats).toEqual({ total: 2, ready: 1, pending: 1, chunks: 2 });
    // The extraction task queued by the text upload above is ordinary activity.
    expect(overview.activity).toMatchObject({
      items: [{ id: uploadedTaskId, status: 'pending', type: 'adhoc', trust: 'assistant' }],
      archivedCount: 0,
    });
    expect(overview.goals).toEqual({ items: [], archivedCount: 0 });
    expect(overview.approvals).toEqual({ pending: [], resolved: [] });
  });

  it('files PDFs and processor documents with the job each one needs', async () => {
    const { POST } = await import('./route.js');
    const jobFor = async (name: string, type: string, body: string) => {
      const form = new FormData();
      form.set('file', new File([body], name, { type }));
      const response = await POST(new Request(url, { method: 'POST', body: form }));
      expect(response.status).toBe(201);
      const docs = await store.collection('documents').where('title', '==', name).get();
      const record = docs.docs[0];
      const tasks = await store
        .collection('tasks')
        .where('trigger.payload.documentId', '==', String(record?.get('id')))
        .get();
      return [record?.get('extractor'), tasks.docs[0]?.get('trigger.payload.job')];
    };
    expect(await jobFor('statement.pdf', 'application/pdf', '%PDF-1.4 statement')).toEqual([
      'pdf',
      'documents.extract',
    ]);
    expect(await jobFor('receipt.png', 'image/png', 'png bytes')).toEqual([
      'pending_processor',
      'documents.process',
    ]);
  });

  it('deletes a document with its chunks, file, claim, queued job and bytes', async () => {
    const { POST } = await import('./route.js');
    const { DELETE } = await import('./[id]/route.js');
    const bytes = Buffer.from('A document the owner no longer wants.');
    const upload = async () => {
      const form = new FormData();
      form.set('file', new File([bytes], 'unwanted.txt', { type: 'text/plain' }));
      const response = await POST(new Request(url, { method: 'POST', body: form }));
      expect(response.status).toBe(201);
      return (await response.json()) as { duplicate: boolean };
    };
    await upload();
    const [record] = (
      await store.collection('documents').where('title', '==', 'unwanted.txt').get()
    ).docs;
    const id = String(record?.get('id'));
    const fileRef = store.doc('files', String(record?.get('fileId')));
    const workspacePath = String((await fileRef.get()).get('workspacePath'));
    await store.doc('documentChunks', randomUUID()).set({
      agentId,
      documentId: id,
      chunkIndex: 0,
      text: 'A document the owner no longer wants.',
    });
    const [task] = (
      await store.collection('tasks').where('trigger.payload.documentId', '==', id).get()
    ).docs;
    expect(staged.has(workspacePath)).toBe(true);

    const response = await DELETE(new Request(`${url}/${id}`, { method: 'DELETE' }), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(200);
    expect((await store.doc('documents', id).get()).exists).toBe(false);
    expect((await fileRef.get()).exists).toBe(false);
    expect(
      (await store.collection('documentChunks').where('documentId', '==', id).get()).empty,
    ).toBe(true);
    expect((await task?.ref.get())?.get('status')).toBe('cancelled');
    expect(staged.has(workspacePath)).toBe(false);
    // The deduplication claim went with it, so the same bytes file afresh.
    expect(await upload()).toEqual({ ok: true, duplicate: false });
  });

  it('keeps the Documents module gate when Firestore is selected', async () => {
    vi.stubEnv('ASSISTANT_MODULES', 'reminders');
    resetConfigForTest();
    try {
      const { GET } = await import('./route.js');
      const { GET: overviewGet } = await import('../overview/route.js');
      expect((await GET(new Request(url))).status).toBe(404);
      const response = await overviewGet(new Request('http://localhost/api/mobile/v1/overview'));
      expect(response.status).toBe(200);
      expect((await response.json()).documents).toEqual({
        documents: [],
        stats: { total: 0, ready: 0, pending: 0, chunks: 0 },
        primaryConversationId: null,
      });
    } finally {
      vi.stubEnv('ASSISTANT_MODULES', 'documents');
      resetConfigForTest();
    }
  });

  it('refuses an invalid Firestore configuration instead of bypassing validation', async () => {
    vi.stubEnv('CANARY_ENABLED', 'true');
    resetConfigForTest();
    try {
      const { GET } = await import('./route.js');
      const response = await GET(new Request(url));
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain('CANARY_ENABLED must be false');
    } finally {
      vi.stubEnv('CANARY_ENABLED', 'false');
      resetConfigForTest();
    }
  });

  it('fails explicitly when the owner document scan exceeds its bound', async () => {
    const ids: string[] = [];
    for (let offset = 0; offset < 5_000; offset += 500) {
      const batch = store.db.batch();
      for (let index = offset; index < Math.min(offset + 500, 5_000); index++) {
        const id = randomUUID();
        ids.push(id);
        batch.set(store.doc('documents', id), {
          id,
          agentId,
          fileId: randomUUID(),
          title: 'Bound fixture',
          mime: 'text/plain',
          source: 'upload',
          trust: 'owner',
          status: 'ready',
          extractor: 'text',
          chunkCount: 0,
          charCount: 0,
          error: null,
          createdAt: now,
        });
      }
      await batch.commit();
    }
    try {
      await expect(
        new FirestoreDocumentReadRepository(store, agentId).list(agentId),
      ).rejects.toThrow('bounded owner scan limit');
    } finally {
      for (let offset = 0; offset < ids.length; offset += 500) {
        const batch = store.db.batch();
        for (const id of ids.slice(offset, offset + 500)) batch.delete(store.doc('documents', id));
        await batch.commit();
      }
    }
    // Creating and removing 5,000 emulator records is fixture setup, not a
    // request-latency assertion. Keep the same overflow check under load.
  }, 30_000);

  it('fails explicitly when a document detail exceeds its chunk bound', async () => {
    const chunkIds: string[] = [];
    for (let offset = 0; offset < 1_001; offset += 500) {
      const batch = store.db.batch();
      for (let index = offset; index < Math.min(offset + 500, 1_001); index++) {
        const id = `overflow-${index}`;
        chunkIds.push(id);
        batch.set(store.doc('documentChunks', id), {
          id,
          agentId,
          documentId,
          chunkIndex: index,
          text: 'overflow fixture',
          charCount: 16,
        });
      }
      await batch.commit();
    }
    try {
      await expect(
        new FirestoreDocumentReadRepository(store, agentId).get(agentId, documentId),
      ).rejects.toThrow('bounded chunk limit');
    } finally {
      for (let offset = 0; offset < chunkIds.length; offset += 500) {
        const batch = store.db.batch();
        for (const id of chunkIds.slice(offset, offset + 500))
          batch.delete(store.doc('documentChunks', id));
        await batch.commit();
      }
    }
  });
});
