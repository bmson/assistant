import { createHash, randomUUID } from 'node:crypto';
import {
  agents,
  conversations,
  createDb,
  createPostgresExecutionPersistence,
  documentChunks,
  documents,
  emailAttachmentCustodies,
  emailIngest,
  emailObserverWork,
  files,
  messages,
  tasks,
} from '@assistant/db';
import {
  type EmailObserverClaim,
  emailAttachmentManifestDigest,
  emailObserverWorkId,
} from '@assistant/persistence';
import type { GoogleClient } from '@assistant/tools/modules/google';
import type { WorkspaceStore } from '@assistant/tools/workspace';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEmailContentProvenance } from '../../../core/src/email-provenance.js';
import { fileEmailAttachmentsForObserver, preparedEmailAttachmentManifest } from './email-sync.js';

const DATABASE_URL = process.env.DATABASE_URL;
function testUrl() {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

const bytes = Buffer.from('synthetic PDF attachment bytes', 'utf8');

describe('email attachment producer with PostgreSQL custody', () => {
  let db: ReturnType<typeof createDb>;
  let agentId: string;
  let conversationId: string;
  let messageId: string;
  let providerMessageId: string;
  let workId: string;

  afterEach(async () => {
    if (!db) return;
    await db.delete(documentChunks).where(eq(documentChunks.agentId, agentId));
    await db.delete(documents).where(eq(documents.agentId, agentId));
    await db.delete(files).where(eq(files.agentId, agentId));
    await db.delete(tasks).where(eq(tasks.agentId, agentId));
    await db.delete(emailAttachmentCustodies).where(eq(emailAttachmentCustodies.agentId, agentId));
    await db.delete(emailObserverWork).where(eq(emailObserverWork.agentId, agentId));
    await db.delete(emailIngest).where(eq(emailIngest.agentId, agentId));
    await db.delete(messages).where(eq(messages.conversationId, conversationId));
    await db.delete(conversations).where(eq(conversations.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.$client.end();
  });

  it('hydrates admitted source, recovers a lost object-write reply, and publishes one canonical catalog/task on replay', async () => {
    db = createDb(testUrl());
    agentId = randomUUID();
    conversationId = randomUUID();
    messageId = randomUUID();
    providerMessageId = `provider-${randomUUID()}`;
    const channelMessageId = `gmail:${providerMessageId}`;
    workId = emailObserverWorkId(agentId, channelMessageId, 'google.email-attachments', 3);
    const token = randomUUID();
    const now = new Date();
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
          body: { attachmentId: 'part-attachment-1', size: bytes.length },
        },
      ],
    };
    const manifest = preparedEmailAttachmentManifest(gmailPayload);
    const prepared = {
      messageId: providerMessageId,
      manifestDigest: emailAttachmentManifestDigest(manifest.entries) ?? '',
      entries: manifest.entries,
    };
    expect(prepared.manifestDigest).toBe(manifest.digest);

    await db.insert(agents).values({
      id: agentId,
      name: 'email-attachment-producer-test',
      email: `${agentId}@producer-test.invalid`,
      workspacePrefix: `email-attachment-producer/${agentId}`,
    });
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
      leaseExpiresAt: new Date(now.getTime() + 5 * 60_000),
      privacyGeneration: null,
      preparedResult: prepared,
    });

    const persistence = createPostgresExecutionPersistence(db);
    if (!persistence.emailSync || !persistence.emailAttachmentCustody)
      throw new Error('PostgreSQL persistence is missing email observer or custody ports');
    const [work] = await db
      .select()
      .from(emailObserverWork)
      .where(eq(emailObserverWork.id, workId));
    if (!work?.leaseExpiresAt || !work.claimToken) throw new Error('prepared work fixture missing');
    const claim = { ...work, status: 'prepared' } as unknown as EmailObserverClaim;
    const source = await persistence.emailSync.loadEmailObserverSource(claim);
    expect(source).toMatchObject({
      agentId,
      messageId,
      body,
      from,
      subject,
      authenticated: true,
      ingestMode: 'direct',
      sourceVerification: 'authenticated',
      contentTrust: 'unknown',
    });
    if (!source) throw new Error('canonical admitted source did not hydrate');

    const providerCall = vi.fn(async (path: string) => {
      if (path.includes('/attachments/')) return { data: bytes.toString('base64url') };
      return { payload: gmailPayload };
    });
    const googleClient = {
      configured: () => true,
      api: providerCall,
    } as unknown as GoogleClient;
    const objects = new Map<
      string,
      { generation: string; custodyId: string; state: 'marker' | 'content'; sha256: string | null }
    >();
    const createMarker = vi.fn(async (custodyId: string) => {
      const object = { generation: '401', custodyId, state: 'marker' as const, sha256: null };
      objects.set(custodyId, object);
      return { generation: object.generation };
    });
    let loseFirstContentReply = true;
    const replaceMarker = vi.fn(
      async (input: {
        custodyId: string;
        markerGeneration: string;
        content: Buffer;
        contentType: string;
        sha256: string;
      }) => {
        const current = objects.get(input.custodyId);
        if (!current || current.generation !== input.markerGeneration || current.state !== 'marker')
          throw new Error('marker changed');
        objects.set(input.custodyId, {
          generation: '402',
          custodyId: input.custodyId,
          state: 'content',
          sha256: input.sha256,
        });
        if (loseFirstContentReply) {
          loseFirstContentReply = false;
          throw new Error('synthetic lost content-write response');
        }
        return { generation: '402' };
      },
    );
    const custodyStore = {
      createEmailAttachmentMarker: createMarker,
      replaceEmailAttachmentMarker: replaceMarker,
      inspectEmailAttachmentObject: vi.fn(
        async (custodyId: string) => objects.get(custodyId) ?? null,
      ),
      deleteOwnedEmailAttachment: vi.fn(async () => 'deleted' as const),
    };
    const workspace = {
      read: async () => '',
      write: async () => ({ bytes: 0 }),
      readBytes: async () => Buffer.alloc(0),
      writeBytes: async () => ({ bytes: 0 }),
      list: async () => [],
      delete: async () => {},
      emailAttachmentCustody: custodyStore,
    } as unknown as WorkspaceStore;
    const services = {
      config: { ASSISTANT_MODULES: ['google'], GMAIL_SYNC_ENABLED: 'true' },
      db,
      persistence,
      router: {},
      workspace,
    } as Parameters<typeof fileEmailAttachmentsForObserver>[0];

    await fileEmailAttachmentsForObserver(services, googleClient, source, claim, prepared);
    await fileEmailAttachmentsForObserver(services, googleClient, source, claim, prepared);

    expect(providerCall).toHaveBeenCalledTimes(4);
    expect(createMarker).toHaveBeenCalledTimes(1);
    expect(replaceMarker).toHaveBeenCalledTimes(1);
    expect(objects.size).toBe(1);
    const [custody] = await db
      .select()
      .from(emailAttachmentCustodies)
      .where(eq(emailAttachmentCustodies.agentId, agentId));
    expect(custody).toMatchObject({
      status: 'catalogued',
      observerWorkId: workId,
      channelMessageId,
      providerMessageId,
      filename: 'quarterly-statement.pdf',
      mime: 'application/pdf',
      actualBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      markerGeneration: '401',
      objectGeneration: '402',
    });
    expect(custody?.workspacePath).toBe(`email-attachments/custody/${custody?.id}`);
    const catalogFiles = await db.select().from(files).where(eq(files.agentId, agentId));
    expect(catalogFiles).toHaveLength(1);
    expect(catalogFiles[0]).toMatchObject({
      emailAttachmentCustodyId: custody?.id,
      workspacePath: custody?.workspacePath,
      objectGeneration: '402',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const catalogDocuments = await db
      .select()
      .from(documents)
      .where(eq(documents.agentId, agentId));
    expect(catalogDocuments).toHaveLength(1);
    expect(catalogDocuments[0]).toMatchObject({
      fileId: catalogFiles[0]?.id,
      title: 'quarterly-statement.pdf',
      source: 'email',
      sourceRef: `gmail:${providerMessageId}`,
      trust: 'unknown',
      extractor: 'pdf',
      status: 'pending',
    });
    const extractionTask = await db.select().from(tasks).where(eq(tasks.agentId, agentId));
    expect(extractionTask).toHaveLength(1);
    expect(extractionTask[0]).toMatchObject({
      externalEventId: `email-attachment:${custody?.id}:documents.extract`,
      trigger: {
        source: 'internal',
        payload: { job: 'documents.extract', documentId: catalogDocuments[0]?.id },
      },
    });
  });
});
