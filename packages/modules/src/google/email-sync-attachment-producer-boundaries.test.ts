import { createHash, randomUUID } from 'node:crypto';
import {
  agents,
  conversations,
  createDb,
  createPostgresExecutionPersistence,
  createPostgresPrivacyErasureRepository,
  type Db,
  documentChunks,
  documents,
  emailAttachmentCustodies,
  emailIngest,
  emailObserverWork,
  files,
  maintenanceCursors,
  messages,
  tasks,
} from '@assistant/db';
import {
  type EmailAttachmentPreparedResult,
  type EmailObserverClaim,
  type EmailObserverSource,
  emailAttachmentManifestDigest,
  emailObserverWorkId,
} from '@assistant/persistence';
import type { GoogleClient } from '@assistant/tools/modules/google';
import {
  type EmailAttachmentCustodyStore,
  LocalWorkspaceStore,
  type WorkspaceStore,
} from '@assistant/tools/workspace';
import { eq, inArray, like, or } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEmailContentProvenance } from '../../../core/src/email-provenance.js';
import { fileEmailAttachmentsForObserver, preparedEmailAttachmentManifest } from './email-sync.js';

const DATABASE_URL = process.env.DATABASE_URL;
const attachmentBytes = Buffer.from('synthetic drive duplicate PDF bytes', 'utf8');
const sha256 = createHash('sha256').update(attachmentBytes).digest('hex');

function testUrl() {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface ProducerFixture {
  agentId: string;
  seededOwner: boolean;
  conversationId: string;
  messageId: string;
  providerMessageId: string;
  channelMessageId: string;
  workId: string;
  source: EmailObserverSource;
  claim: EmailObserverClaim;
  prepared: EmailAttachmentPreparedResult;
  persistence: ReturnType<typeof createPostgresExecutionPersistence>;
  gmailPayload: {
    mimeType: string;
    parts: Array<{
      mimeType: string;
      filename: string;
      body: { attachmentId: string; size: number };
    }>;
  };
}

async function createProducerFixture(db: Db, seededOwner = false): Promise<ProducerFixture> {
  let agentId: string;
  if (seededOwner) {
    const [owner] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!owner) throw new Error('Expected seeded installation owner');
    agentId = owner.id;
  } else {
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      name: 'email-attachment-boundary-test',
      email: `${agentId}@producer-boundary.invalid`,
      workspacePrefix: `email-attachment-boundary/${agentId}`,
    });
  }
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const providerMessageId = `provider-${randomUUID()}`;
  const channelMessageId = `gmail:${providerMessageId}`;
  const workId = emailObserverWorkId(agentId, channelMessageId, 'google.email-attachments', 3);
  const token = randomUUID();
  const subject = 'Quarterly statement';
  const from = 'sender@example.test';
  const body = 'Please keep the attached statement for review.';
  const prefix = `From: ${from}\nSubject: ${subject}\n\n`;
  const observerRegistrySnapshot = [
    { key: 'google.email-attachments', version: 3, workClass: 'idempotent_db' },
  ];
  const observerRegistryHash = createHash('sha256')
    .update(JSON.stringify(observerRegistrySnapshot))
    .digest('hex');
  const provenance = buildEmailContentProvenance({
    subject,
    fullBody: body,
    storedBody: body,
    messagePrefix: prefix,
    authenticated: true,
    mode: 'direct',
    parts: [{ path: '0', mimeType: 'text/plain', quoteMarkup: false, replyHeaders: false }],
  });
  const gmailPayload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'application/pdf',
        filename: 'quarterly-statement.pdf',
        body: { attachmentId: `part-${randomUUID()}`, size: attachmentBytes.length },
      },
    ],
  };
  const manifest = preparedEmailAttachmentManifest(gmailPayload);
  const prepared = {
    messageId: providerMessageId,
    manifestDigest: emailAttachmentManifestDigest(manifest.entries) ?? '',
    entries: manifest.entries,
  };
  const persistence = createPostgresExecutionPersistence(db);
  if (!persistence.emailSync?.privacyObservationFence || !persistence.emailAttachmentCustody)
    throw new Error('PostgreSQL persistence is missing email observer or custody ports');
  const privacyGeneration = (await persistence.emailSync.privacyObservationFence(agentId)) ?? null;
  await db.insert(conversations).values({
    id: conversationId,
    agentId,
    channel: 'email',
    trust: 'unknown',
    title: subject,
  });
  await db.insert(messages).values({
    id: messageId,
    conversationId,
    channelMessageId,
    role: 'user',
    origin: 'unknown',
    text: `${prefix}${body}`,
    parts: [{ type: 'text', text: body }],
  });
  await db.insert(emailIngest).values({
    id: randomUUID(),
    agentId,
    conversationId,
    channelMessageId,
    fromEmail: from,
    subject,
    contentTrust: 'unknown',
    authenticated: true,
    ingestMode: 'direct',
    hasExternalOrUnknown: provenance.hasExternalOrUnknown,
    providerMessageId,
    providerThreadId: `thread-${providerMessageId}`,
    sourceMessageId: `<${providerMessageId}@example.test>`,
    messagePersisted: true,
    admittedSourceKind: 'message',
    admittedSourceId: messageId,
    emailContentProvenance: provenance,
    observerRegistrySnapshot,
    observerRegistryHash,
  });
  await db.insert(emailObserverWork).values({
    id: workId,
    agentId,
    sourceKey: channelMessageId,
    channelMessageId,
    sourceKind: 'message',
    observerKey: 'google.email-attachments',
    observerVersion: 3,
    workClass: 'idempotent_db',
    status: 'prepared',
    attemptCount: 1,
    claimToken: token,
    claimGeneration: 1,
    leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
    privacyGeneration,
    preparedResult: prepared,
  });
  const [work] = await db.select().from(emailObserverWork).where(eq(emailObserverWork.id, workId));
  if (!work?.leaseExpiresAt || !work.claimToken) throw new Error('prepared work fixture missing');
  const claim = { ...work, status: 'prepared' } as unknown as EmailObserverClaim;
  const source = await persistence.emailSync.loadEmailObserverSource(claim);
  if (!source) throw new Error('canonical admitted source did not hydrate');
  return {
    agentId,
    seededOwner,
    conversationId,
    messageId,
    providerMessageId,
    channelMessageId,
    workId,
    source,
    claim,
    prepared,
    persistence,
    gmailPayload,
  };
}

function providerFor(fixture: ProducerFixture) {
  const api = vi.fn(async (path: string) => {
    if (path.includes('/attachments/')) return { data: attachmentBytes.toString('base64url') };
    return { payload: fixture.gmailPayload };
  });
  return { client: { configured: () => true, api } as unknown as GoogleClient, api };
}

function servicesFor(
  db: Db,
  persistence: ReturnType<typeof createPostgresExecutionPersistence>,
  workspace: WorkspaceStore,
) {
  return {
    config: { ASSISTANT_MODULES: ['google'], GMAIL_SYNC_ENABLED: 'true' },
    db,
    persistence,
    router: {},
    workspace,
  } as Parameters<typeof fileEmailAttachmentsForObserver>[0];
}

function objectStore(
  options: {
    replace?: (input: {
      custodyId: string;
      markerGeneration: string;
      content: Buffer;
      contentType: string;
      sha256: string;
    }) => Promise<{ generation: string }>;
  } = {},
) {
  const objects = new Map<
    string,
    { generation: string; custodyId: string; state: 'marker' | 'content'; sha256: string | null }
  >();
  let nextGeneration = 500;
  const createMarker = vi.fn(async (custodyId: string) => {
    const object = {
      generation: String(++nextGeneration),
      custodyId,
      state: 'marker' as const,
      sha256: null,
    };
    objects.set(custodyId, object);
    return { generation: object.generation };
  });
  const replace = vi.fn(
    async (input: {
      custodyId: string;
      markerGeneration: string;
      content: Buffer;
      contentType: string;
      sha256: string;
    }) => {
      if (options.replace) return options.replace(input);
      const current = objects.get(input.custodyId);
      if (!current || current.generation !== input.markerGeneration || current.state !== 'marker')
        throw new Error('marker changed');
      const object = {
        generation: String(++nextGeneration),
        custodyId: input.custodyId,
        state: 'content' as const,
        sha256: input.sha256,
      };
      objects.set(input.custodyId, object);
      return { generation: object.generation };
    },
  );
  const deleteOwned = vi.fn(async (input: { custodyId: string; expectedGeneration?: string }) => {
    const current = objects.get(input.custodyId);
    if (!current) return 'missing' as const;
    if (input.expectedGeneration && current.generation !== input.expectedGeneration)
      return 'changed' as const;
    objects.delete(input.custodyId);
    return 'deleted' as const;
  });
  const store: EmailAttachmentCustodyStore = {
    createEmailAttachmentMarker: createMarker,
    replaceEmailAttachmentMarker: replace,
    inspectEmailAttachmentObject: async (custodyId) => objects.get(custodyId) ?? null,
    deleteOwnedEmailAttachment: deleteOwned,
  };
  const workspace = {
    read: async () => '',
    write: async () => ({ bytes: 0 }),
    readBytes: async () => Buffer.alloc(0),
    writeBytes: async () => ({ bytes: 0 }),
    list: async () => [],
    delete: async () => {},
    emailAttachmentCustody: store,
  } as unknown as WorkspaceStore;
  return { store, workspace, objects, createMarker, replace, deleteOwned };
}

let activeDb: Db | undefined;
let activeFixture: ProducerFixture | undefined;
let eraseOwnsSeededOwner = false;
let erasedTestCustodyId: string | undefined;
let savedErasureCursors: Array<typeof maintenanceCursors.$inferSelect> = [];

function privacyErasureCursorFilter(agentId: string) {
  return or(
    inArray(maintenanceCursors.name, [
      `privacy-erasure-result:${agentId}`,
      `privacy-erasure-generation:${agentId}`,
      `privacy-erasure-active:${agentId}`,
    ]),
    like(maintenanceCursors.name, `privacy-erasure-asset:${agentId}:%`),
  );
}

afterEach(async () => {
  if (!activeDb) return;
  if (activeFixture) {
    const { agentId, conversationId, messageId, workId } = activeFixture;
    if (!eraseOwnsSeededOwner) {
      await activeDb.delete(documentChunks).where(eq(documentChunks.agentId, agentId));
      await activeDb.delete(documents).where(eq(documents.agentId, agentId));
      await activeDb.delete(files).where(eq(files.agentId, agentId));
      await activeDb.delete(tasks).where(eq(tasks.agentId, agentId));
      await activeDb
        .delete(emailAttachmentCustodies)
        .where(eq(emailAttachmentCustodies.agentId, agentId));
    } else if (erasedTestCustodyId) {
      await activeDb
        .delete(emailAttachmentCustodies)
        .where(eq(emailAttachmentCustodies.id, erasedTestCustodyId));
    }
    await activeDb.delete(emailObserverWork).where(eq(emailObserverWork.id, workId));
    await activeDb
      .delete(emailIngest)
      .where(eq(emailIngest.channelMessageId, `gmail:${activeFixture.providerMessageId}`));
    await activeDb.delete(messages).where(eq(messages.id, messageId));
    await activeDb.delete(conversations).where(eq(conversations.id, conversationId));
    if (!activeFixture.seededOwner) await activeDb.delete(agents).where(eq(agents.id, agentId));
    if (eraseOwnsSeededOwner) {
      await activeDb.delete(maintenanceCursors).where(privacyErasureCursorFilter(agentId));
      if (savedErasureCursors.length)
        await activeDb.insert(maintenanceCursors).values(savedErasureCursors);
      const restoredCursors = await activeDb
        .select({ name: maintenanceCursors.name, cursor: maintenanceCursors.cursor })
        .from(maintenanceCursors)
        .where(privacyErasureCursorFilter(agentId));
      expect(restoredCursors.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
        savedErasureCursors
          .map(({ name, cursor }) => ({ name, cursor }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    }
  }
  await activeDb.$client.end();
  activeDb = undefined;
  activeFixture = undefined;
  eraseOwnsSeededOwner = false;
  erasedTestCustodyId = undefined;
  savedErasureCursors = [];
});

describe('email attachment producer privacy and duplicate boundaries', () => {
  it('rejects a content receipt after owner erasure wins while the provider write is paused', async () => {
    activeDb = createDb(testUrl());
    activeFixture = await createProducerFixture(activeDb, true);
    eraseOwnsSeededOwner = true;
    const fixture = activeFixture;
    savedErasureCursors = await activeDb
      .select()
      .from(maintenanceCursors)
      .where(privacyErasureCursorFilter(fixture.agentId));
    const taskIdsBeforeProducer = new Set(
      (
        await activeDb
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.agentId, fixture.agentId))
      ).map(({ id }) => id),
    );
    const underlying = fixture.persistence.emailAttachmentCustody;
    if (!underlying) throw new Error('Missing custody repository');
    const finalized = vi.fn(underlying.finalizeEmailAttachmentCatalog.bind(underlying));
    const custody = new Proxy(underlying, {
      get(target, property, receiver) {
        if (property === 'finalizeEmailAttachmentCatalog') return finalized;
        return Reflect.get(target, property, receiver);
      },
    });
    const persistence = { ...fixture.persistence, emailAttachmentCustody: custody };
    const { client, api } = providerFor(fixture);
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const storage = objectStore({
      replace: async (input) => {
        const generation = String(Number(input.markerGeneration) + 1);
        const current = {
          generation,
          custodyId: input.custodyId,
          state: 'content' as const,
          sha256: input.sha256,
        };
        // The provider/object write is committed, but its completion response is paused.
        const marker = storage.objects.get(input.custodyId);
        if (!marker || marker.generation !== input.markerGeneration)
          throw new Error('marker changed');
        storage.objects.set(input.custodyId, current);
        writeStarted.resolve();
        await releaseWrite.promise;
        return { generation };
      },
    });
    const producer = fileEmailAttachmentsForObserver(
      servicesFor(activeDb, persistence, storage.workspace),
      client,
      fixture.source,
      fixture.claim,
      fixture.prepared,
    );
    await writeStarted.promise;
    const [startedCustody] = await activeDb
      .select({ id: emailAttachmentCustodies.id })
      .from(emailAttachmentCustodies)
      .where(eq(emailAttachmentCustodies.observerWorkId, fixture.workId));
    if (!startedCustody) throw new Error('Expected this producer’s in-flight custody');
    erasedTestCustodyId = startedCustody.id;
    const erasure = createPostgresPrivacyErasureRepository(activeDb);
    await erasure.erase();
    releaseWrite.resolve();
    await expect(producer).rejects.toThrow('email_attachment_object_record_failed');
    expect(finalized).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(2);
    const [custodyRow] = await activeDb
      .select()
      .from(emailAttachmentCustodies)
      .where(eq(emailAttachmentCustodies.id, startedCustody.id));
    if (!custodyRow) throw new Error('Expected erased custody row');
    expect(custodyRow).toMatchObject({
      status: 'erased',
      filename: null,
      mime: null,
      sha256: null,
      fileId: null,
      documentId: null,
      markerGeneration: '501',
      objectGeneration: '502',
    });
    expect(
      await activeDb.select().from(files).where(eq(files.agentId, fixture.agentId)),
    ).toHaveLength(0);
    expect(
      await activeDb.select().from(documents).where(eq(documents.agentId, fixture.agentId)),
    ).toHaveLength(0);
    const remainingTaskIds = await activeDb
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.agentId, fixture.agentId));
    expect(remainingTaskIds.filter(({ id }) => !taskIdsBeforeProducer.has(id))).toHaveLength(0);
    const pending = await erasure.pendingAssets();
    expect(pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'email_attachment_custody',
          custodyId: custodyRow?.id,
          generation: '501',
          objectState: 'marker',
        }),
        expect.objectContaining({
          kind: 'email_attachment_custody',
          custodyId: custodyRow?.id,
          generation: '502',
          objectState: 'content',
        }),
      ]),
    );
    const markerAsset = pending.find(
      (asset) =>
        asset.kind === 'email_attachment_custody' &&
        asset.custodyId === custodyRow?.id &&
        asset.generation === '501' &&
        asset.objectState === 'marker',
    );
    const contentAsset = pending.find(
      (asset) =>
        asset.kind === 'email_attachment_custody' &&
        asset.custodyId === custodyRow?.id &&
        asset.generation === '502' &&
        asset.objectState === 'content',
    );
    if (
      markerAsset?.kind !== 'email_attachment_custody' ||
      contentAsset?.kind !== 'email_attachment_custody'
    )
      throw new Error('Expected exact synthetic attachment cleanup intents');
    expect(await storage.deleteOwned({ custodyId: custodyRow.id, expectedGeneration: '501' })).toBe(
      'changed',
    );
    expect(storage.objects.get(custodyRow.id)).toMatchObject({
      generation: '502',
      state: 'content',
    });
    expect(await storage.deleteOwned({ custodyId: custodyRow.id, expectedGeneration: '502' })).toBe(
      'deleted',
    );
    await erasure.assetDeleted(contentAsset);
    expect(await storage.deleteOwned({ custodyId: custodyRow.id, expectedGeneration: '501' })).toBe(
      'missing',
    );
    await erasure.assetDeleted(markerAsset);
    expect(
      (await erasure.pendingAssets()).filter(
        (asset) => asset.kind === 'email_attachment_custody' && asset.custodyId === custodyRow.id,
      ),
    ).toHaveLength(0);
  }, 15_000);

  it('fails closed on LocalWorkspaceStore before Gmail or storage access', async () => {
    activeDb = createDb(testUrl());
    activeFixture = await createProducerFixture(activeDb);
    const fixture = activeFixture;
    const { client, api } = providerFor(fixture);
    const workspace = new LocalWorkspaceStore(`/tmp/attachment-unsupported-${randomUUID()}`);
    const localReads = vi.spyOn(workspace, 'read');
    const localWrites = vi.spyOn(workspace, 'write');
    const localByteReads = vi.spyOn(workspace, 'readBytes');
    const localByteWrites = vi.spyOn(workspace, 'writeBytes');
    const localDeletes = vi.spyOn(workspace, 'delete');
    await expect(
      fileEmailAttachmentsForObserver(
        servicesFor(activeDb, fixture.persistence, workspace),
        client,
        fixture.source,
        fixture.claim,
        fixture.prepared,
      ),
    ).rejects.toThrow('email_attachment_custody_unsupported');
    expect(api).not.toHaveBeenCalled();
    expect(localReads).not.toHaveBeenCalled();
    expect(localWrites).not.toHaveBeenCalled();
    expect(localByteReads).not.toHaveBeenCalled();
    expect(localByteWrites).not.toHaveBeenCalled();
    expect(localDeletes).not.toHaveBeenCalled();
    expect(
      await activeDb
        .select()
        .from(emailAttachmentCustodies)
        .where(eq(emailAttachmentCustodies.agentId, fixture.agentId)),
    ).toHaveLength(0);
    expect(
      await activeDb.select().from(files).where(eq(files.agentId, fixture.agentId)),
    ).toHaveLength(0);
  });

  it('replays a byte-identical Drive duplicate after exact cleanup without replacing its catalog or task', async () => {
    activeDb = createDb(testUrl());
    activeFixture = await createProducerFixture(activeDb);
    const fixture = activeFixture;
    const existingFileId = randomUUID();
    const existingDocumentId = randomUUID();
    const now = new Date();
    await activeDb.insert(files).values({
      id: existingFileId,
      createdAt: now,
      agentId: fixture.agentId,
      taskId: null,
      workspacePath: `drive/imports/${randomUUID()}.pdf`,
      mime: 'application/pdf',
      bytes: attachmentBytes.length,
      sha256,
      objectGeneration: null,
      emailAttachmentCustodyId: null,
    });
    await activeDb.insert(documents).values({
      id: existingDocumentId,
      createdAt: now,
      updatedAt: now,
      agentId: fixture.agentId,
      title: 'Existing Drive statement.pdf',
      fileId: existingFileId,
      mime: 'application/pdf',
      source: 'drive',
      sourceRef: 'drive:import-55',
      trust: 'owner',
      sha256,
      status: 'pending',
      extractor: 'pdf',
      chunkCount: 0,
      charCount: 0,
      error: null,
      processorTokenHash: null,
      processorStartedAt: null,
      processorAttempts: 0,
      processedTextPath: null,
      extractionMetadata: null,
    });
    const { client, api } = providerFor(fixture);
    const storage = objectStore();
    const services = servicesFor(activeDb, fixture.persistence, storage.workspace);
    await fileEmailAttachmentsForObserver(
      services,
      client,
      fixture.source,
      fixture.claim,
      fixture.prepared,
    );
    const [custodyRow] = await activeDb
      .select()
      .from(emailAttachmentCustodies)
      .where(eq(emailAttachmentCustodies.agentId, fixture.agentId));
    expect(custodyRow).toMatchObject({
      status: 'cleanup_pending',
      duplicateDocumentId: existingDocumentId,
      fileId: null,
    });
    const repository = fixture.persistence.emailAttachmentCustody;
    if (!repository) throw new Error('Missing custody repository');
    const pending = await repository.listEmailAttachmentCustodyCleanup({
      agentId: fixture.agentId,
      cursor: null,
      limit: 10,
    });
    const marker = pending.items.find(
      (item) => item.custody.id === custodyRow?.id && item.asset.objectState === 'marker',
    );
    expect(marker?.asset.generation).toBe(custodyRow?.markerGeneration);
    // The producer replaced the marker with this exact content generation and
    // already deleted the content after discovering the owned Drive duplicate.
    // A cleanup worker can now acknowledge only the separately retained marker.
    expect(
      await storage.deleteOwned({
        custodyId: custodyRow?.id ?? '',
        expectedGeneration: marker?.asset.generation,
      }),
    ).toBe('missing');
    expect(
      await repository.markEmailAttachmentCustodyErased({
        agentId: fixture.agentId,
        custodyId: custodyRow?.id ?? '',
        deletedGeneration: marker?.asset.generation,
      }),
    ).toBe(true);
    const [cleaned] = await activeDb
      .select()
      .from(emailAttachmentCustodies)
      .where(eq(emailAttachmentCustodies.agentId, fixture.agentId));
    expect(cleaned).toMatchObject({
      status: 'duplicate_cleaned',
      duplicateDocumentId: existingDocumentId,
    });

    await fileEmailAttachmentsForObserver(
      services,
      client,
      fixture.source,
      fixture.claim,
      fixture.prepared,
    );

    expect(api).toHaveBeenCalledTimes(4);
    expect(storage.createMarker).toHaveBeenCalledTimes(1);
    expect(storage.replace).toHaveBeenCalledTimes(1);
    expect(storage.deleteOwned).toHaveBeenCalledTimes(2);
    const catalogFiles = await activeDb
      .select()
      .from(files)
      .where(eq(files.agentId, fixture.agentId));
    expect(catalogFiles).toHaveLength(1);
    expect(catalogFiles[0]).toMatchObject({
      id: existingFileId,
      emailAttachmentCustodyId: null,
    });
    expect(catalogFiles[0]?.workspacePath).toMatch(/^drive\/imports\/.+\.pdf$/);
    const catalogDocuments = await activeDb
      .select()
      .from(documents)
      .where(eq(documents.agentId, fixture.agentId));
    expect(catalogDocuments).toHaveLength(1);
    expect(catalogDocuments[0]).toMatchObject({
      id: existingDocumentId,
      title: 'Existing Drive statement.pdf',
      source: 'drive',
      fileId: existingFileId,
    });
    expect(
      await activeDb.select().from(tasks).where(eq(tasks.agentId, fixture.agentId)),
    ).toHaveLength(0);
    expect(
      await activeDb
        .select()
        .from(emailAttachmentCustodies)
        .where(eq(emailAttachmentCustodies.agentId, fixture.agentId)),
    ).toHaveLength(1);
  });
});
