import { createHash, randomUUID } from 'node:crypto';
import {
  type EmailAttachmentManifestEntry,
  type EmailObserverEffectFence,
  emailAttachmentCustodyCleanupIntentId,
  emailAttachmentManifestDigest,
  emailObserverWorkId,
  type Records,
} from '@assistant/persistence';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEmailContentProvenance } from '../../core/src/email-provenance.js';
import { createDb, type Db } from './client.js';
import { createPostgresEmailAttachmentCustodyRepository } from './email-attachment-custody-repository.js';
import {
  agents,
  conversations,
  documentChunks,
  documents,
  emailAttachmentCustodies,
  emailIngest,
  emailObserverWork,
  files,
  maintenanceCursors,
  messages,
  tasks,
} from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
function testUrl() {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

const objectHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('PostgreSQL email attachment custody', () => {
  let db: Db;
  let agentId: string;
  let observerWorkId: string;
  let conversationId: string;
  let messageId: string;
  let providerMessageId: string;
  let channelMessageId: string;
  let fence: EmailObserverEffectFence;
  let prepared: {
    messageId: string;
    manifestDigest: string;
    entries: EmailAttachmentManifestEntry[];
  };
  let entry: EmailAttachmentManifestEntry;
  let bodyBytes: Buffer;

  beforeEach(async () => {
    db = createDb(testUrl());
    agentId = randomUUID();
    conversationId = randomUUID();
    messageId = randomUUID();
    providerMessageId = randomUUID();
    channelMessageId = `gmail:${providerMessageId}`;
    observerWorkId = emailObserverWorkId(agentId, channelMessageId, 'google.email-attachments', 3);
    bodyBytes = Buffer.from('synthetic attachment bytes', 'utf8');
    entry = {
      providerAttachmentId: `part-${randomUUID()}`,
      ordinal: 0,
      filename: 'statement.pdf',
      mime: 'application/pdf',
      advertisedBytes: bodyBytes.length,
    };
    prepared = {
      messageId: providerMessageId,
      manifestDigest: emailAttachmentManifestDigest([entry]) ?? '',
      entries: [entry],
    };
    fence = {
      id: observerWorkId,
      agentId,
      claimToken: randomUUID(),
      claimGeneration: 1,
      expectedPrivacyGeneration: null,
    };
    await db.insert(agents).values({
      id: agentId,
      name: 'email-attachment-custody-test',
      email: `${agentId}@attachment-custody.invalid`,
      workspacePrefix: `attachment-custody/${agentId}`,
    });
    await db.insert(conversations).values({
      id: conversationId,
      agentId,
      channel: 'email',
      trust: 'unknown',
      title: 'Attachment source',
    });
    const fromEmail = 'sender@example.test';
    const subject = 'Attachment source';
    const body = 'Please file the attached document.';
    const prefix = `From: ${fromEmail}\nSubject: ${subject}\n\n`;
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
      fromEmail,
      subject,
      contentTrust: 'unknown',
      authenticated: true,
      ingestMode: 'direct',
      hasExternalOrUnknown: provenance.hasExternalOrUnknown,
      providerMessageId,
      providerThreadId: randomUUID(),
      sourceMessageId: `<${providerMessageId}@example.test>`,
      messagePersisted: true,
      admittedSourceKind: 'message',
      admittedSourceId: messageId,
      emailContentProvenance: provenance,
      observerRegistrySnapshot,
      observerRegistryHash,
    });
    await db.insert(emailObserverWork).values({
      id: observerWorkId,
      agentId,
      sourceKey: channelMessageId,
      channelMessageId,
      sourceKind: 'message',
      observerKey: 'google.email-attachments',
      observerVersion: 3,
      workClass: 'idempotent_db',
      status: 'prepared',
      attemptCount: 1,
      claimToken: fence.claimToken,
      claimGeneration: fence.claimGeneration,
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
      privacyGeneration: null,
      preparedResult: prepared,
    });
  });

  afterEach(async () => {
    await db.delete(documentChunks).where(eq(documentChunks.agentId, agentId));
    await db.delete(documents).where(eq(documents.agentId, agentId));
    await db.delete(files).where(eq(files.agentId, agentId));
    await db.delete(emailAttachmentCustodies).where(eq(emailAttachmentCustodies.agentId, agentId));
    await db.delete(tasks).where(eq(tasks.agentId, agentId));
    await db.delete(emailObserverWork).where(eq(emailObserverWork.agentId, agentId));
    await db.delete(emailIngest).where(eq(emailIngest.agentId, agentId));
    await db.delete(messages).where(eq(messages.conversationId, conversationId));
    await db.delete(conversations).where(eq(conversations.agentId, agentId));
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${agentId}`));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.$client.end();
  });

  function intent(custodyId: string = randomUUID()) {
    return {
      fence,
      observerWorkId,
      channelMessageId,
      providerMessageId,
      manifestDigest: prepared.manifestDigest,
      entry,
      actualBytes: bodyBytes.length,
      sha256: objectHash(bodyBytes),
      custodyId,
      workspacePath: `email-attachments/custody/${custodyId}`,
    };
  }

  async function begin() {
    return createPostgresEmailAttachmentCustodyRepository(db).beginEmailAttachmentCustody(intent());
  }

  it('binds the custody intent to the prepared manifest and replays the canonical path under the same source key', async () => {
    const repository = createPostgresEmailAttachmentCustodyRepository(db);
    const first = await repository.beginEmailAttachmentCustody(intent());
    const replay = await repository.beginEmailAttachmentCustody(intent());
    expect(replay.id).toBe(first.id);
    expect(replay.workspacePath).toBe(first.workspacePath);
    expect(first).toMatchObject({
      status: 'marker_pending',
      actualBytes: bodyBytes.length,
      sha256: objectHash(bodyBytes),
    });

    await expect(
      repository.beginEmailAttachmentCustody({
        ...intent(),
        entry: { ...entry, filename: 'changed.pdf' },
      }),
    ).rejects.toThrow();
    expect(
      await db
        .select()
        .from(emailAttachmentCustodies)
        .where(eq(emailAttachmentCustodies.agentId, agentId)),
    ).toHaveLength(1);
  });

  it('rejects hidden, orphaned, mutated, and cross-owner canonical sources without custody writes', async () => {
    const repository = createPostgresEmailAttachmentCustodyRepository(db);
    const expectRejectedWithoutWrites = async () => {
      await expect(repository.beginEmailAttachmentCustody(intent())).rejects.toThrow();
      expect(
        await db
          .select()
          .from(emailAttachmentCustodies)
          .where(eq(emailAttachmentCustodies.agentId, agentId)),
      ).toHaveLength(0);
    };

    const validProvenance = buildEmailContentProvenance({
      subject: 'Attachment source',
      fullBody: 'Please file the attached document.',
      storedBody: 'Please file the attached document.',
      messagePrefix: 'From: sender@example.test\nSubject: Attachment source\n\n',
      authenticated: true,
      mode: 'direct',
      parts: [{ path: '0', mimeType: 'text/plain', quoteMarkup: false, replyHeaders: false }],
    });
    await db
      .update(emailIngest)
      .set({
        emailContentProvenance: { ...validProvenance, sourceHash: 'f'.repeat(64) },
      })
      .where(eq(emailIngest.channelMessageId, channelMessageId));
    await expectRejectedWithoutWrites();
    await db
      .update(emailIngest)
      .set({ emailContentProvenance: null })
      .where(eq(emailIngest.channelMessageId, channelMessageId));
    await expectRejectedWithoutWrites();
    const frozenAttachmentRegistry = [
      { key: 'google.email-attachments', version: 3, workClass: 'idempotent_db' },
    ];
    const frozenAttachmentRegistryHash = createHash('sha256')
      .update(JSON.stringify(frozenAttachmentRegistry))
      .digest('hex');
    const unrelatedRegistry = [
      { key: 'google.email-match', version: 1, workClass: 'idempotent_db' },
    ];
    await db
      .update(emailIngest)
      .set({
        emailContentProvenance: validProvenance,
        observerRegistrySnapshot: unrelatedRegistry,
        observerRegistryHash: createHash('sha256')
          .update(JSON.stringify(unrelatedRegistry))
          .digest('hex'),
      })
      .where(eq(emailIngest.channelMessageId, channelMessageId));
    await expectRejectedWithoutWrites();
    await db
      .update(emailIngest)
      .set({
        observerRegistrySnapshot: frozenAttachmentRegistry,
        observerRegistryHash: 'c'.repeat(64),
      })
      .where(eq(emailIngest.channelMessageId, channelMessageId));
    await expectRejectedWithoutWrites();
    await db
      .update(emailIngest)
      .set({ observerRegistryHash: frozenAttachmentRegistryHash })
      .where(eq(emailIngest.channelMessageId, channelMessageId));
    const forgedWorkId = randomUUID();
    await db
      .update(emailObserverWork)
      .set({ id: forgedWorkId })
      .where(eq(emailObserverWork.id, observerWorkId));
    await expectRejectedWithoutWrites();
    await db
      .update(emailObserverWork)
      .set({ id: observerWorkId })
      .where(eq(emailObserverWork.id, forgedWorkId));
    await db
      .update(emailObserverWork)
      .set({ sourceKey: `gmail:${randomUUID()}` })
      .where(eq(emailObserverWork.id, observerWorkId));
    await expectRejectedWithoutWrites();
    await db
      .update(emailObserverWork)
      .set({ sourceKey: channelMessageId })
      .where(eq(emailObserverWork.id, observerWorkId));

    await db.update(messages).set({ hiddenAt: new Date() }).where(eq(messages.id, messageId));
    await expectRejectedWithoutWrites();
    await db.update(messages).set({ hiddenAt: null }).where(eq(messages.id, messageId));

    const orphanedSourceId = randomUUID();
    await db
      .update(emailIngest)
      .set({ admittedSourceId: orphanedSourceId })
      .where(eq(emailIngest.channelMessageId, channelMessageId));
    await expectRejectedWithoutWrites();
    await db
      .update(emailIngest)
      .set({ admittedSourceId: messageId })
      .where(eq(emailIngest.channelMessageId, channelMessageId));

    await db
      .update(emailIngest)
      .set({ subject: 'Changed after admission' })
      .where(eq(emailIngest.channelMessageId, channelMessageId));
    await expectRejectedWithoutWrites();
    await db
      .update(emailIngest)
      .set({ subject: 'Attachment source' })
      .where(eq(emailIngest.channelMessageId, channelMessageId));

    const foreignAgentId = randomUUID();
    const foreignConversationId = randomUUID();
    const foreignMessageId = randomUUID();
    try {
      await db.insert(agents).values({
        id: foreignAgentId,
        name: 'foreign attachment source',
        email: `${foreignAgentId}@attachment-custody.invalid`,
        workspacePrefix: `attachment-custody/${foreignAgentId}`,
      });
      await db.insert(conversations).values({
        id: foreignConversationId,
        agentId: foreignAgentId,
        channel: 'email',
        trust: 'unknown',
        title: 'Foreign source',
      });
      await db.insert(messages).values({
        id: foreignMessageId,
        conversationId: foreignConversationId,
        channelMessageId: `gmail:${randomUUID()}`,
        role: 'user',
        origin: 'unknown',
        text: 'From: sender@example.test\nSubject: Attachment source\n\nPlease file the attached document.',
        parts: [{ type: 'text', text: 'Please file the attached document.' }],
      });
      await db
        .update(emailIngest)
        .set({ conversationId: foreignConversationId, admittedSourceId: foreignMessageId })
        .where(eq(emailIngest.channelMessageId, channelMessageId));
      await expectRejectedWithoutWrites();
    } finally {
      await db
        .update(emailIngest)
        .set({ conversationId, admittedSourceId: messageId })
        .where(eq(emailIngest.channelMessageId, channelMessageId));
      await db.delete(messages).where(eq(messages.id, foreignMessageId));
      await db.delete(conversations).where(eq(conversations.id, foreignConversationId));
      await db.delete(agents).where(eq(agents.id, foreignAgentId));
    }
  });

  it('accepts a frozen forwarded source with unknown trust without inventing authenticated authorship', async () => {
    const subject = 'Attachment source';
    const body = 'Please file the attached document.';
    const provenance = buildEmailContentProvenance({
      subject,
      fullBody: body,
      storedBody: body,
      messagePrefix: `From: sender@example.test\nSubject: ${subject}\n\n`,
      authenticated: false,
      mode: 'forwarded',
      parts: [{ path: '0', mimeType: 'text/plain', quoteMarkup: false, replyHeaders: false }],
    });
    await db
      .update(emailIngest)
      .set({
        ingestMode: 'forwarded',
        authenticated: false,
        hasExternalOrUnknown: provenance.hasExternalOrUnknown,
        emailContentProvenance: provenance,
      })
      .where(eq(emailIngest.channelMessageId, channelMessageId));
    const result = await begin();
    expect(result).toMatchObject({ status: 'marker_pending', workspacePath: expect.any(String) });
  });

  it('requires marker receipt, exact prepared claim, and actual byte facts before authorization and catalog', async () => {
    const repository = createPostgresEmailAttachmentCustodyRepository(db);
    const custody = await begin();
    expect(
      await repository.recordEmailAttachmentMarker({
        agentId,
        custodyId: custody.id,
        generation: '41',
      }),
    ).toBe(true);
    expect(
      await repository.authorizeEmailAttachmentContent({
        fence,
        custodyId: custody.id,
        markerGeneration: '41',
        actualBytes: bodyBytes.length,
        sha256: objectHash(bodyBytes),
        mime: entry.mime,
      }),
    ).toBe(true);
    expect(
      await repository.recordEmailAttachmentObject({
        agentId,
        custodyId: custody.id,
        generation: '42',
        bytes: bodyBytes.length,
        sha256: objectHash(bodyBytes),
      }),
    ).toBe(true);
    const now = new Date();
    const file: Records['files'] = {
      id: randomUUID(),
      createdAt: now,
      agentId,
      taskId: null,
      workspacePath: custody.workspacePath,
      mime: entry.mime,
      bytes: bodyBytes.length,
      sha256: objectHash(bodyBytes),
      objectGeneration: '42',
      emailAttachmentCustodyId: custody.id,
    };
    const document: Records['documents'] = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      agentId,
      title: entry.filename,
      fileId: file.id,
      mime: entry.mime,
      source: 'email',
      sourceRef: `gmail:${providerMessageId}`,
      trust: 'unknown',
      sha256: objectHash(bodyBytes),
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
    };
    await expect(
      repository.finalizeEmailAttachmentCatalog({
        fence,
        custodyId: custody.id,
        file,
        document: { ...document, status: 'unsupported', extractor: 'unsupported' },
      }),
    ).rejects.toThrow('Email attachment catalog input differs from verified custody metadata');
    expect(await db.select().from(documents).where(eq(documents.agentId, agentId))).toHaveLength(0);
    expect(await db.select().from(tasks).where(eq(tasks.agentId, agentId))).toHaveLength(0);
    await db.insert(files).values({
      ...file,
      workspacePath: `other/${randomUUID()}`,
      emailAttachmentCustodyId: null,
    });
    await expect(
      repository.finalizeEmailAttachmentCatalog({ fence, custodyId: custody.id, file, document }),
    ).rejects.toThrow();
    expect(await db.select().from(tasks).where(eq(tasks.agentId, agentId))).toHaveLength(0);
    expect(await db.select().from(documents).where(eq(documents.agentId, agentId))).toHaveLength(0);
    await db.delete(files).where(eq(files.id, file.id));

    const [finalized, concurrentReplay] = await Promise.all([
      repository.finalizeEmailAttachmentCatalog({ fence, custodyId: custody.id, file, document }),
      repository.finalizeEmailAttachmentCatalog({ fence, custodyId: custody.id, file, document }),
    ]);
    expect(finalized).toMatchObject({
      duplicate: false,
      published: true,
      task: { id: expect.any(String), queueGeneration: expect.any(Number) },
    });
    expect(
      await db.select().from(files).where(eq(files.emailAttachmentCustodyId, custody.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(documents).where(eq(documents.id, finalized.document.id)),
    ).toHaveLength(1);
    expect(concurrentReplay).toMatchObject({
      duplicate: false,
      published: true,
      task: null,
      document: { id: finalized.document.id },
    });
    expect(await db.select().from(tasks).where(eq(tasks.agentId, agentId))).toHaveLength(1);
  });

  it('rejects an expired lease before sending content or publishing inventory', async () => {
    const repository = createPostgresEmailAttachmentCustodyRepository(db);
    const custody = await begin();
    await db
      .update(emailObserverWork)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailObserverWork.id, observerWorkId));
    expect(
      await repository.recordEmailAttachmentMarker({
        agentId,
        custodyId: custody.id,
        generation: '55',
      }),
    ).toBe(false);
    expect(
      await repository.authorizeEmailAttachmentContent({
        fence,
        custodyId: custody.id,
        markerGeneration: '55',
        actualBytes: bodyBytes.length,
        sha256: objectHash(bodyBytes),
        mime: entry.mime,
      }),
    ).toBe(false);
    const [stored] = await db
      .select()
      .from(emailAttachmentCustodies)
      .where(eq(emailAttachmentCustodies.id, custody.id));
    expect(stored).toMatchObject({
      status: 'marker_ready',
      observerWorkId,
      filename: entry.filename,
      actualBytes: bodyBytes.length,
      markerGeneration: '55',
    });
    expect(await db.select().from(files).where(eq(files.agentId, agentId))).toHaveLength(0);
  });

  it('serializes concurrent duplicate begin calls and persists only one canonical intent', async () => {
    const repository = createPostgresEmailAttachmentCustodyRepository(db);
    const [left, right] = await Promise.all([
      repository.beginEmailAttachmentCustody(intent()),
      repository.beginEmailAttachmentCustody(intent()),
    ]);
    expect(left.id).toBe(right.id);
    expect(left.workspacePath).toBe(right.workspacePath);
    expect(
      await db
        .select()
        .from(emailAttachmentCustodies)
        .where(eq(emailAttachmentCustodies.agentId, agentId)),
    ).toHaveLength(1);
  });

  it('quarantines a byte-identical catalog duplicate with an exact cleanup asset', async () => {
    const repository = createPostgresEmailAttachmentCustodyRepository(db);
    const custody = await begin();
    const now = new Date();
    const existingFileId = randomUUID();
    const existingDocumentId = randomUUID();
    const sha256 = objectHash(bodyBytes);
    const existingFile: Records['files'] = {
      id: existingFileId,
      createdAt: now,
      agentId,
      taskId: null,
      workspacePath: `documents/existing/${randomUUID()}`,
      mime: entry.mime,
      bytes: bodyBytes.length,
      sha256,
      objectGeneration: null,
      emailAttachmentCustodyId: null,
    };
    const existingDocument: Records['documents'] = {
      id: existingDocumentId,
      createdAt: now,
      updatedAt: now,
      agentId,
      title: 'First copy.pdf',
      fileId: existingFileId,
      mime: entry.mime,
      source: 'upload',
      sourceRef: '',
      trust: 'unknown',
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
    };
    await db.insert(files).values(existingFile);
    await db.insert(documents).values(existingDocument);
    await repository.recordEmailAttachmentMarker({
      agentId,
      custodyId: custody.id,
      generation: '51',
    });
    await repository.authorizeEmailAttachmentContent({
      fence,
      custodyId: custody.id,
      markerGeneration: '51',
      actualBytes: bodyBytes.length,
      sha256,
      mime: entry.mime,
    });
    await repository.recordEmailAttachmentObject({
      agentId,
      custodyId: custody.id,
      generation: '52',
      bytes: bodyBytes.length,
      sha256,
    });
    const file: Records['files'] = {
      ...existingFile,
      id: randomUUID(),
      workspacePath: custody.workspacePath,
      objectGeneration: '52',
      emailAttachmentCustodyId: custody.id,
    };
    const document: Records['documents'] = {
      ...existingDocument,
      id: randomUUID(),
      title: entry.filename,
      fileId: file.id,
      source: 'email',
      sourceRef: `gmail:${providerMessageId}`,
    };
    const result = await repository.finalizeEmailAttachmentCatalog({
      fence,
      custodyId: custody.id,
      file,
      document,
    });
    expect(result).toMatchObject({ published: false, duplicate: true, task: null });
    expect(result.document.id).toBe(existingDocumentId);
    const [pending] = await db
      .select()
      .from(emailAttachmentCustodies)
      .where(eq(emailAttachmentCustodies.id, custody.id));
    expect(pending).toMatchObject({
      status: 'cleanup_pending',
      objectGeneration: '52',
      duplicateDocumentId: existingDocumentId,
    });
    const page = await repository.listEmailAttachmentCustodyCleanup({
      agentId,
      cursor: null,
      limit: 10,
    });
    expect(
      page.items.filter((item) => item.custody.id === custody.id).map((item) => item.asset),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ generation: '51', objectState: 'marker' }),
        expect.objectContaining({ generation: '52', objectState: 'content' }),
      ]),
    );
    expect(
      await repository.markEmailAttachmentCustodyErased({
        agentId,
        custodyId: custody.id,
        deletedGeneration: '52',
      }),
    ).toBe(true);
    const stillPending = await db
      .select()
      .from(emailAttachmentCustodies)
      .where(eq(emailAttachmentCustodies.id, custody.id));
    expect(stillPending[0]).toMatchObject({
      status: 'cleanup_pending',
      duplicateDocumentId: existingDocumentId,
    });
    expect(
      await repository.markEmailAttachmentCustodyErased({
        agentId,
        custodyId: custody.id,
        deletedGeneration: '51',
      }),
    ).toBe(true);
    const completedDuplicate = await db
      .select()
      .from(emailAttachmentCustodies)
      .where(eq(emailAttachmentCustodies.id, custody.id));
    expect(completedDuplicate[0]).toMatchObject({
      status: 'duplicate_cleaned',
      duplicateDocumentId: existingDocumentId,
    });
    const replayIntent = await repository.beginEmailAttachmentCustody(intent(custody.id));
    expect(replayIntent).toMatchObject({
      id: custody.id,
      status: 'duplicate_cleaned',
      duplicateDocumentId: existingDocumentId,
    });
    const replayResult = await repository.finalizeEmailAttachmentCatalog({
      fence,
      custodyId: custody.id,
      file,
      document,
    });
    expect(replayResult).toMatchObject({
      published: false,
      duplicate: true,
      task: null,
      document: { id: existingDocumentId },
    });
    expect(await db.select().from(documents).where(eq(documents.id, existingDocumentId))).toEqual([
      expect.objectContaining({ title: 'First copy.pdf', fileId: existingFileId }),
    ]);
    await db.delete(documents).where(eq(documents.id, existingDocumentId));
    await expect(repository.beginEmailAttachmentCustody(intent(custody.id))).rejects.toThrow(
      'Duplicate email attachment receipt target changed',
    );
    expect(await db.select().from(files).where(eq(files.id, existingFileId))).toHaveLength(1);
    expect(await db.select().from(tasks).where(eq(tasks.agentId, agentId))).toHaveLength(0);
    expect(
      (await repository.listEmailAttachmentCustodyCleanup({ agentId, cursor: null, limit: 10 }))
        .items,
    ).toEqual([]);
  });

  it('keeps erased tombstones private while a late generation receipt creates opaque cleanup metadata', async () => {
    const repository = createPostgresEmailAttachmentCustodyRepository(db);
    const custody = await begin();
    expect(
      await repository.recordEmailAttachmentMarker({
        agentId,
        custodyId: custody.id,
        generation: '61',
      }),
    ).toBe(true);
    expect(
      await repository.markEmailAttachmentCustodyErased({ agentId, custodyId: custody.id }),
    ).toBe(true);
    expect(
      await repository.recordEmailAttachmentObject({
        agentId,
        custodyId: custody.id,
        generation: '62',
        bytes: bodyBytes.length,
        sha256: objectHash(bodyBytes),
      }),
    ).toBe(false);

    const [tombstone] = await db
      .select()
      .from(emailAttachmentCustodies)
      .where(eq(emailAttachmentCustodies.id, custody.id));
    expect(tombstone).toMatchObject({
      status: 'erased',
      observerWorkId: null,
      claimToken: null,
      channelMessageId: null,
      providerMessageId: null,
      providerAttachmentId: null,
      manifestDigest: null,
      filename: null,
      mime: null,
      advertisedBytes: 0,
      actualBytes: null,
      sha256: null,
      markerGeneration: '61',
      objectGeneration: '62',
    });
    const [asset] = await db
      .select({ cursor: maintenanceCursors.cursor })
      .from(maintenanceCursors)
      .where(
        eq(
          maintenanceCursors.name,
          `privacy-erasure-asset:${agentId}:${emailAttachmentCustodyCleanupIntentId(custody.id, '62')}`,
        ),
      );
    expect(asset?.cursor).toContain('"kind":"email_attachment_custody"');
    expect(asset?.cursor).toContain('"generation":"62"');
    expect(asset?.cursor).not.toContain(entry.filename);
    expect(asset?.cursor).not.toContain(objectHash(bodyBytes));
  });

  it('pages exact pending generations past tombstones and acknowledges late old markers independently', async () => {
    const repository = createPostgresEmailAttachmentCustodyRepository(db);
    const contentCustodyId = randomUUID();
    const markerCustodyId = randomUUID();
    const tombstoneIds = Array.from({ length: 70 }, () => randomUUID());
    const now = new Date();
    const tombstone = (
      id: string,
      markerGeneration: string | null,
      objectGeneration: string | null,
    ) => ({
      id,
      agentId,
      claimGeneration: 1,
      attachmentOrdinal: 0,
      workspacePath: `email-attachments/custody/${id}`,
      advertisedBytes: 0,
      markerGeneration,
      objectGeneration,
      status: 'erased' as const,
      createdAt: now,
      updatedAt: now,
    });
    const contentAsset = {
      kind: 'email_attachment_custody',
      id: emailAttachmentCustodyCleanupIntentId(contentCustodyId, '2'),
      custodyId: contentCustodyId,
      workspacePath: `email-attachments/custody/${contentCustodyId}`,
      generation: '2',
      objectState: 'content',
    } as const;
    const markerAsset = {
      kind: 'email_attachment_custody',
      id: emailAttachmentCustodyCleanupIntentId(markerCustodyId, '7'),
      custodyId: markerCustodyId,
      workspacePath: `email-attachments/custody/${markerCustodyId}`,
      generation: '7',
      objectState: 'marker',
    } as const;
    const assetCursor = (asset: typeof contentAsset | typeof markerAsset) => JSON.stringify(asset);
    const contentAssetName = `privacy-erasure-asset:${agentId}:${contentAsset.id}`;
    const markerAssetName = `privacy-erasure-asset:${agentId}:${markerAsset.id}`;
    try {
      await db
        .insert(emailAttachmentCustodies)
        .values([
          ...tombstoneIds.map((id) => tombstone(id, null, null)),
          tombstone(contentCustodyId, '1', '2'),
          tombstone(markerCustodyId, '7', null),
        ]);
      await db.insert(maintenanceCursors).values([
        { name: contentAssetName, cursor: assetCursor(contentAsset) },
        { name: markerAssetName, cursor: assetCursor(markerAsset) },
      ]);

      const collected: Array<{
        custody: { id: string };
        asset: { id: string; generation: string };
      }> = [];
      let cursor: string | null = null;
      do {
        const page = await repository.listEmailAttachmentCustodyCleanup({
          agentId,
          cursor,
          limit: 1,
        });
        collected.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      expect(collected).toHaveLength(2);
      expect(collected.map((item) => item.asset.id).sort()).toEqual(
        [contentAsset.id, markerAsset.id].sort(),
      );
      expect(collected.find((item) => item.custody.id === contentCustodyId)?.asset).toMatchObject({
        generation: '2',
        objectState: 'content',
      });

      expect(
        await repository.markEmailAttachmentCustodyErased({
          agentId,
          custodyId: contentCustodyId,
          deletedGeneration: '2',
        }),
      ).toBe(true);
      expect(
        await repository.recordEmailAttachmentMarker({
          agentId,
          custodyId: contentCustodyId,
          generation: '1',
        }),
      ).toBe(false);
      const lateMarkerPage = await repository.listEmailAttachmentCustodyCleanup({
        agentId,
        cursor: null,
        limit: 100,
      });
      expect(
        lateMarkerPage.items.find((item) => item.custody.id === contentCustodyId)?.asset,
      ).toMatchObject({
        generation: '1',
        objectState: 'marker',
      });
      expect(
        await repository.markEmailAttachmentCustodyErased({
          agentId,
          custodyId: contentCustodyId,
          deletedGeneration: '1',
        }),
      ).toBe(true);
      const [preservedTombstone] = await db
        .select()
        .from(emailAttachmentCustodies)
        .where(eq(emailAttachmentCustodies.id, contentCustodyId));
      expect(preservedTombstone).toMatchObject({
        status: 'erased',
        markerGeneration: '1',
        objectGeneration: '2',
      });
      const finalPage = await repository.listEmailAttachmentCustodyCleanup({
        agentId,
        cursor: null,
        limit: 100,
      });
      expect(finalPage.items.map((item) => item.custody.id)).toEqual([markerCustodyId]);
    } finally {
      await db
        .delete(maintenanceCursors)
        .where(inArray(maintenanceCursors.name, [contentAssetName, markerAssetName]));
      await db
        .delete(maintenanceCursors)
        .where(
          eq(
            maintenanceCursors.name,
            `privacy-erasure-asset:${agentId}:${emailAttachmentCustodyCleanupIntentId(contentCustodyId, '1')}`,
          ),
        );
      await db
        .delete(emailAttachmentCustodies)
        .where(
          inArray(emailAttachmentCustodies.id, [
            ...tombstoneIds,
            contentCustodyId,
            markerCustodyId,
          ]),
        );
    }
  });
});
