import { createHash, randomUUID } from 'node:crypto';
import type { Config } from '@assistant/config';
import type {
  DocumentDeletionRepository,
  EmailObserverClaim,
  EmailObserverSource,
  ExecutionPersistence,
} from '@assistant/persistence';
import {
  emailAttachmentCustodyCleanupIntentId,
  emailAttachmentManifestDigest,
  emailObserverWorkId,
} from '@assistant/persistence';
import type { GoogleClient } from '@assistant/tools/modules/google';
import type { EmailAttachmentCustodyStore } from '@assistant/tools/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEmailContentProvenance } from '../../core/src/email-provenance.js';
import { purgeDocument } from '../../core/src/memory/document-catalog.js';
import { sweepEmailAttachmentCustodyCleanup } from '../../modules/src/google/email-attachment-cleanup.js';
import {
  fileEmailAttachmentsForObserver,
  preparedEmailAttachmentManifest,
} from '../../modules/src/google/email-sync.js';
import type { ModuleServices } from '../../modules/src/platform.js';
import { FirestoreDocumentDeletionRepository } from './document-deletion.js';
import { FirestoreEmailAttachmentCustodyRepository } from './email-attachment-custody.js';
import { emailAttachmentCustodySourceIndexId } from './email-attachment-source.js';
import { FirestorePrivacyErasureRepository } from './privacy-erasure.js';
import { decodeRecord, documentKey } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const { notifyTask } = vi.hoisted(() => ({ notifyTask: vi.fn() }));

vi.mock('@assistant/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/core')>()),
  getQueueNotifier: () => ({ notify: notifyTask }),
}));

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore email attachment custody cleanup',
  () => {
    const stores: ReturnType<typeof emulatorStore>[] = [];
    afterEach(async () => Promise.all(stores.splice(0).map(disposeStore)));

    it('files a prepared attachment through the module and commits its extraction task wake', async () => {
      notifyTask.mockClear();
      const store = emulatorStore();
      stores.push(store);
      const agentId = randomUUID();
      const providerMessageId = 'producer-message-1';
      const channelMessageId = `gmail:${providerMessageId}`;
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const observerWorkId = emailObserverWorkId(
        agentId,
        channelMessageId,
        'google.email-attachments',
        3,
      );
      const body = 'Please review the attached PDF.';
      const fromEmail = 'sender@example.test';
      const subject = 'Producer flow';
      const prefix = `From: ${fromEmail}\nSubject: ${subject}\n\n`;
      const payload = {
        mimeType: 'multipart/mixed',
        parts: [
          {
            filename: 'receipt.pdf',
            mimeType: 'application/pdf',
            body: { attachmentId: 'provider-attachment-pdf', size: 8 },
          },
        ],
      };
      const prepared = preparedEmailAttachmentManifest(payload);
      const provenance = buildEmailContentProvenance({
        subject,
        fullBody: body,
        storedBody: body,
        messagePrefix: prefix,
        authenticated: true,
        mode: 'direct',
        parts: [{ path: '0', mimeType: 'text/plain', quoteMarkup: false, replyHeaders: false }],
      });
      const observerRegistrySnapshot = [
        { key: 'google.email-attachments', version: 3, workClass: 'idempotent_db' },
      ];
      const observerRegistryHash = createHash('sha256')
        .update(JSON.stringify(observerRegistrySnapshot))
        .digest('hex');
      const ingestHex = createHash('sha256')
        .update(JSON.stringify(['email-ingest', channelMessageId]))
        .digest('hex');
      const variant = ((Number.parseInt(ingestHex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
      const ingestId = `${ingestHex.slice(0, 8)}-${ingestHex.slice(8, 12)}-5${ingestHex.slice(13, 16)}-${variant}${ingestHex.slice(17, 20)}-${ingestHex.slice(20, 32)}`;
      const claimToken = 'producer-claim-token';
      const leaseExpiresAt = new Date(Date.now() + 60_000);
      const claim = {
        id: observerWorkId,
        agentId,
        sourceKey: channelMessageId,
        sourceKind: 'message',
        channelMessageId,
        observerKey: 'google.email-attachments',
        observerVersion: 3,
        workClass: 'idempotent_db',
        status: 'prepared',
        claimToken,
        claimGeneration: 1,
        privacyGeneration: null,
        leaseExpiresAt,
        preparedResult: {
          messageId: providerMessageId,
          manifestDigest: prepared.digest,
          entries: prepared.entries,
        },
      } as EmailObserverClaim;
      const source: EmailObserverSource = {
        agentId,
        messageId,
        sourceId: channelMessageId,
        from: fromEmail,
        subject,
        body,
        authenticated: true,
        origin: 'unknown',
        contentTrust: 'unknown',
        directRouting: 'email_triage',
        emailContentProvenance: provenance,
        ingestMode: 'direct',
        sourceVerification: 'authenticated',
        hasExternalOrUnknown: provenance.hasExternalOrUnknown,
      };
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('conversations', conversationId).set({ id: conversationId, agentId });
      await store.doc('messages', messageId).set({
        id: messageId,
        conversationId,
        channelMessageId,
        role: 'user',
        origin: 'unknown',
        text: `${prefix}${body}`,
        parts: [{ type: 'text', text: body }],
        hiddenAt: null,
      });
      await store.doc('messageChannelIds', channelMessageId).set({ messageId, conversationId });
      await store.doc('emailIngest', ingestId).set({
        id: ingestId,
        agentId,
        providerMessageId,
        channelMessageId,
        conversationId,
        fromEmail,
        fromName: null,
        subject,
        contentTrust: 'unknown',
        authenticated: true,
        ingestMode: 'direct',
        hasExternalOrUnknown: provenance.hasExternalOrUnknown,
        admittedSourceKind: 'message',
        admittedSourceId: messageId,
        observerRegistrySnapshot,
        observerRegistryHash,
        emailContentProvenance: provenance,
      });
      await store.doc('emailObserverWork', observerWorkId).set({
        ...claim,
        createdAt: new Date(),
        updatedAt: new Date(),
        attemptCount: 1,
        lastErrorCode: null,
        claimedAt: new Date(),
        completedAt: null,
      });

      const custodyRepository = new FirestoreEmailAttachmentCustodyRepository(store, agentId);
      const bytes = Buffer.from('pdf-data');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      let object: {
        generation: string;
        custodyId: string;
        state: 'marker' | 'content';
        sha256: string | null;
      } | null = null;
      const objectStore: EmailAttachmentCustodyStore = {
        createEmailAttachmentMarker: async (custodyId) => {
          object = { generation: 'marker-producer', custodyId, state: 'marker', sha256: null };
          return { generation: object.generation };
        },
        replaceEmailAttachmentMarker: async ({ custodyId, markerGeneration, sha256: digest }) => {
          if (object?.generation !== markerGeneration) throw new Error('marker changed');
          object = { generation: 'content-producer', custodyId, state: 'content', sha256: digest };
          return { generation: object.generation };
        },
        inspectEmailAttachmentObject: async () => object,
        deleteOwnedEmailAttachment: async () => 'missing',
      };
      const googleClient = {
        api: async <T>(path: string) =>
          (path.includes('/attachments/')
            ? { data: bytes.toString('base64url') }
            : { payload }) as T,
      } as unknown as GoogleClient;
      const config = {
        ASSISTANT_MODULES: ['google'],
        GMAIL_SYNC_ENABLED: 'true',
      } as Config;
      await fileEmailAttachmentsForObserver(
        {
          config,
          db: {} as never,
          persistence: {
            emailAttachmentCustody: custodyRepository,
          } as unknown as ExecutionPersistence,
          router: {} as never,
          workspace: { emailAttachmentCustody: objectStore } as never,
        } as unknown as ModuleServices,
        googleClient,
        source,
        claim,
        {
          messageId: providerMessageId,
          manifestDigest: prepared.digest,
          entries: prepared.entries,
        },
      );

      expect(object).toMatchObject({ state: 'content', sha256 });
      const files = await store.collection('files').where('agentId', '==', agentId).get();
      expect(files.size).toBe(1);
      const file = files.docs[0];
      if (!file) throw new Error('Producer did not publish a file row');
      const documents = await store
        .collection('documents')
        .where('fileId', '==', file.get('id'))
        .get();
      expect(documents.size).toBe(1);
      const tasks = await store.collection('tasks').where('agentId', '==', agentId).get();
      const task = tasks.docs.find(
        (item) => item.get('trigger')?.payload?.job === 'documents.extract',
      );
      expect(task).toBeDefined();
      if (!task) throw new Error('Producer did not create the extraction task');
      expect(notifyTask).toHaveBeenCalledWith(task.get('id'), task.get('queueGeneration'));
      const wakes = await store.collection('outbox').where('taskId', '==', task.get('id')).get();
      expect(wakes.size).toBe(1);
    });

    it('binds prepared provider ID to its exact channel source through catalog publication', async () => {
      const store = emulatorStore();
      stores.push(store);
      const agentId = randomUUID();
      const custodyId = randomUUID();
      const providerMessageId = 'provider-message-1';
      const channelMessageId = `gmail:${providerMessageId}`;
      const observerWorkId = emailObserverWorkId(
        agentId,
        channelMessageId,
        'google.email-attachments',
        3,
      );
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const fromEmail = 'sender@example.test';
      const subject = 'Attachment source';
      const body = 'Please file the attached document.';
      const prefix = `From: ${fromEmail}\nSubject: ${subject}\n\n`;
      const emailContentProvenance = buildEmailContentProvenance({
        subject,
        fullBody: body,
        storedBody: body,
        messagePrefix: prefix,
        authenticated: true,
        mode: 'direct',
        parts: [{ path: '0', mimeType: 'text/plain', quoteMarkup: false, replyHeaders: false }],
      });
      const observerRegistrySnapshot = [
        { key: 'google.email-attachments', version: 3, workClass: 'idempotent_db' },
      ];
      const observerRegistryHash = createHash('sha256')
        .update(JSON.stringify(observerRegistrySnapshot))
        .digest('hex');
      const ingestId = (() => {
        const hex = createHash('sha256')
          .update(JSON.stringify(['email-ingest', channelMessageId]))
          .digest('hex');
        const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      })();
      const bytes = Buffer.from('pdf', 'utf8');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const entry = {
        providerAttachmentId: 'provider-attachment-1',
        ordinal: 0,
        filename: 'attachment.bin',
        mime: 'application/octet-stream',
        advertisedBytes: bytes.length,
      };
      const duplicateEntry = {
        ...entry,
        providerAttachmentId: 'provider-attachment-2',
        ordinal: 1,
      };
      const manifestDigest = emailAttachmentManifestDigest([entry, duplicateEntry]);
      if (!manifestDigest) throw new Error('test attachment manifest is invalid');
      const claimToken = 'prepared-claim-token';
      const now = new Date();
      const fence = {
        id: observerWorkId,
        agentId,
        claimToken,
        claimGeneration: 1,
        expectedPrivacyGeneration: null,
      };
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('conversations', conversationId).set({ id: conversationId, agentId });
      await store.doc('messages', messageId).set({
        id: messageId,
        conversationId,
        channelMessageId,
        role: 'user',
        origin: 'unknown',
        text: `${prefix}${body}`,
        parts: [{ type: 'text', text: body }],
        hiddenAt: null,
      });
      await store.doc('messageChannelIds', channelMessageId).set({
        messageId,
        conversationId,
      });
      await store.doc('emailIngest', ingestId).set({
        id: ingestId,
        agentId,
        providerMessageId,
        channelMessageId,
        conversationId,
        fromEmail,
        fromName: null,
        subject,
        contentTrust: 'unknown',
        authenticated: true,
        ingestMode: 'direct',
        hasExternalOrUnknown: emailContentProvenance.hasExternalOrUnknown,
        admittedSourceKind: 'message',
        admittedSourceId: messageId,
        observerRegistrySnapshot,
        observerRegistryHash,
        emailContentProvenance,
      });
      await store.doc('emailObserverWork', observerWorkId).set({
        id: observerWorkId,
        agentId,
        sourceKey: channelMessageId,
        channelMessageId,
        sourceKind: 'message',
        observerKey: 'google.email-attachments',
        observerVersion: 3,
        workClass: 'idempotent_db',
        status: 'prepared',
        claimToken,
        claimGeneration: fence.claimGeneration,
        privacyGeneration: null,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        preparedResult: {
          messageId: providerMessageId,
          manifestDigest,
          entries: [entry, duplicateEntry],
        },
      });

      const repository = new FirestoreEmailAttachmentCustodyRepository(store, agentId);
      const invalidCustodyId = randomUUID();
      await expect(
        repository.beginEmailAttachmentCustody({
          fence,
          observerWorkId,
          channelMessageId: 'gmail:some-other-message',
          providerMessageId,
          manifestDigest,
          entry,
          actualBytes: bytes.length,
          sha256,
          custodyId: invalidCustodyId,
          workspacePath: `email-attachments/custody/${invalidCustodyId}`,
        }),
      ).rejects.toThrow('outside the prepared observer manifest');
      await expect(
        store.doc('emailAttachmentCustodies', invalidCustodyId).get(),
      ).resolves.toMatchObject({
        exists: false,
      });

      const attempt = (candidateId = randomUUID()) =>
        repository.beginEmailAttachmentCustody({
          fence,
          observerWorkId,
          channelMessageId,
          providerMessageId,
          manifestDigest,
          entry,
          actualBytes: bytes.length,
          sha256,
          custodyId: candidateId,
          workspacePath: `email-attachments/custody/${candidateId}`,
        });
      await store.doc('emailObserverWork', observerWorkId).update({ observerKey: 'google.other' });
      await expect(attempt()).rejects.toThrow();
      await store.doc('emailObserverWork', observerWorkId).update({
        observerKey: 'google.email-attachments',
      });
      await store.doc('messages', messageId).update({ hiddenAt: new Date() });
      await expect(attempt()).rejects.toThrow('canonical source is missing or changed');
      await store.doc('messages', messageId).update({ hiddenAt: null });
      await store.doc('conversations', conversationId).update({ agentId: randomUUID() });
      await expect(attempt()).rejects.toThrow('canonical source is missing or changed');
      await store.doc('conversations', conversationId).update({ agentId });
      await store.doc('messages', messageId).update({ origin: 'owner' });
      await expect(attempt()).rejects.toThrow('canonical source is missing or changed');
      await store.doc('messages', messageId).update({ origin: 'unknown' });
      await store.doc('emailIngest', ingestId).update({ emailContentProvenance: null });
      await expect(attempt()).rejects.toThrow('canonical source is missing or changed');
      await store.doc('emailIngest', ingestId).update({ emailContentProvenance });
      await store.doc('messages', messageId).update({ text: `${prefix}tampered display text` });
      await expect(attempt()).rejects.toThrow('canonical source is missing or changed');
      await store.doc('messages', messageId).update({ text: `${prefix}${body}` });
      await store.doc('emailIngest', ingestId).update({
        emailContentProvenance: { ...emailContentProvenance, spans: [] },
      });
      await expect(attempt()).rejects.toThrow('canonical source is missing or changed');
      await store.doc('emailIngest', ingestId).update({ emailContentProvenance });

      const competingCustodyIds = [custodyId, randomUUID()];
      const competing = await Promise.all(
        competingCustodyIds.map((candidateId) =>
          repository.beginEmailAttachmentCustody({
            fence,
            observerWorkId,
            channelMessageId,
            providerMessageId,
            manifestDigest,
            entry,
            actualBytes: bytes.length,
            sha256,
            custodyId: candidateId,
            workspacePath: `email-attachments/custody/${candidateId}`,
          }),
        ),
      );
      const firstCustody = competing[0];
      if (!firstCustody) throw new Error('Concurrent custody begin returned no result');
      const actualCustodyId = firstCustody.id;
      const actualWorkspacePath = `email-attachments/custody/${actualCustodyId}`;
      expect(competing.map((row) => row.id)).toEqual([actualCustodyId, actualCustodyId]);
      expect(competing.every((row) => row.status === 'marker_pending')).toBe(true);
      const nextFence = { ...fence, claimToken: 'prepared-claim-token-2', claimGeneration: 2 };
      await store.doc('emailObserverWork', observerWorkId).update({
        claimToken: nextFence.claimToken,
        claimGeneration: nextFence.claimGeneration,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      const replayCustodyId = randomUUID();
      const replay = await repository.beginEmailAttachmentCustody({
        fence: nextFence,
        observerWorkId,
        channelMessageId,
        providerMessageId,
        manifestDigest,
        entry,
        actualBytes: bytes.length,
        sha256,
        custodyId: replayCustodyId,
        workspacePath: `email-attachments/custody/${replayCustodyId}`,
      });
      expect(replay).toMatchObject({
        id: actualCustodyId,
        claimToken: nextFence.claimToken,
        claimGeneration: 2,
      });
      const custodyRows = await store
        .collection('emailAttachmentCustodies')
        .where('observerWorkId', '==', observerWorkId)
        .get();
      expect(custodyRows.size).toBe(1);
      await expect(
        store
          .doc(
            'emailAttachmentCustodyKeys',
            emailAttachmentCustodySourceIndexId(
              agentId,
              observerWorkId,
              entry.providerAttachmentId,
            ),
          )
          .get(),
      ).resolves.toMatchObject({ exists: true });
      await expect(
        repository.recordEmailAttachmentMarker({
          agentId,
          custodyId: actualCustodyId,
          generation: 'marker-1',
        }),
      ).resolves.toBe(true);
      await expect(
        repository.authorizeEmailAttachmentContent({
          fence: nextFence,
          custodyId: actualCustodyId,
          markerGeneration: 'marker-1',
          actualBytes: bytes.length,
          sha256,
          mime: entry.mime,
        }),
      ).resolves.toBe(true);
      await expect(
        repository.recordEmailAttachmentObject({
          agentId,
          custodyId: actualCustodyId,
          generation: 'content-1',
          bytes: bytes.length,
          sha256,
        }),
      ).resolves.toBe(true);

      const fileId = randomUUID();
      const documentId = randomUUID();
      const timestamp = new Date();
      const publication = {
        fence: nextFence,
        custodyId: actualCustodyId,
        file: {
          id: fileId,
          createdAt: timestamp,
          agentId,
          taskId: null,
          workspacePath: actualWorkspacePath,
          mime: entry.mime,
          bytes: bytes.length,
          sha256,
          objectGeneration: 'content-1',
          emailAttachmentCustodyId: actualCustodyId,
        },
        document: {
          id: documentId,
          createdAt: timestamp,
          updatedAt: timestamp,
          agentId,
          title: entry.filename,
          status: 'unsupported',
          trust: 'unknown',
          error: null,
          source: 'email',
          sourceRef: channelMessageId,
          mime: entry.mime,
          sha256,
          fileId,
          extractor: 'unsupported',
          chunkCount: 0,
          charCount: 0,
          processorTokenHash: null,
          processorStartedAt: null,
          processorAttempts: 0,
          processedTextPath: null,
          extractionMetadata: null,
        },
      };
      const invalidPublications = [
        {
          ...publication,
          file: { ...publication.file, objectGeneration: 'different-generation' },
        },
        {
          ...publication,
          document: { ...publication.document, title: 'renamed.pdf' },
        },
        {
          ...publication,
          document: { ...publication.document, trust: 'known' as const },
        },
        {
          ...publication,
          document: {
            ...publication.document,
            status: 'pending' as const,
            extractor: 'pdf' as const,
          },
        },
      ];
      for (const invalid of invalidPublications) {
        await expect(repository.finalizeEmailAttachmentCatalog(invalid)).rejects.toThrow(
          'publication custody fence is stale',
        );
        await expect(store.doc('files', invalid.file.id).get()).resolves.toMatchObject({
          exists: false,
        });
        await expect(store.doc('documents', invalid.document.id).get()).resolves.toMatchObject({
          exists: false,
        });
      }
      await expect(
        store.collection('tasks').where('agentId', '==', agentId).get(),
      ).resolves.toMatchObject({
        size: 0,
      });
      await store.doc('messages', messageId).update({
        parts: [{ type: 'text', text: 'mutated after attachment review' }],
      });
      await expect(repository.finalizeEmailAttachmentCatalog(publication)).rejects.toThrow(
        'publication custody fence is stale',
      );
      await store.doc('messages', messageId).update({ parts: [{ type: 'text', text: body }] });
      const published = await repository.finalizeEmailAttachmentCatalog(publication);
      expect(published).toMatchObject({ published: true, duplicate: false, task: null });
      await expect(
        store.doc('emailAttachmentCustodies', actualCustodyId).get(),
      ).resolves.toMatchObject({ exists: true });
      await expect(store.doc('files', fileId).get()).resolves.toMatchObject({ exists: true });
      await expect(store.doc('documents', documentId).get()).resolves.toMatchObject({
        exists: true,
      });

      // Content-hash deduplication can point at an already-owned Drive document;
      // a terminal receipt must bind that target by owner/id/hash, not require an
      // email source label that the existing catalog row does not have.
      await store.doc('documents', documentId).update({
        source: 'drive',
        sourceRef: 'drive:existing-document',
      });

      const duplicateCustodyId = randomUUID();
      const duplicateWorkspacePath = `email-attachments/custody/${duplicateCustodyId}`;
      await repository.beginEmailAttachmentCustody({
        fence: nextFence,
        observerWorkId,
        channelMessageId,
        providerMessageId,
        manifestDigest,
        entry: duplicateEntry,
        actualBytes: bytes.length,
        sha256,
        custodyId: duplicateCustodyId,
        workspacePath: duplicateWorkspacePath,
      });
      await repository.recordEmailAttachmentMarker({
        agentId,
        custodyId: duplicateCustodyId,
        generation: 'duplicate-marker',
      });
      await expect(
        repository.authorizeEmailAttachmentContent({
          fence: nextFence,
          custodyId: duplicateCustodyId,
          markerGeneration: 'duplicate-marker',
          actualBytes: bytes.length,
          sha256,
          mime: duplicateEntry.mime,
        }),
      ).resolves.toBe(true);
      await repository.recordEmailAttachmentObject({
        agentId,
        custodyId: duplicateCustodyId,
        generation: 'duplicate-content',
        bytes: bytes.length,
        sha256,
      });
      const duplicateFileId = randomUUID();
      const duplicateDocumentId = randomUUID();
      const duplicateResult = await repository.finalizeEmailAttachmentCatalog({
        fence: nextFence,
        custodyId: duplicateCustodyId,
        file: {
          id: duplicateFileId,
          createdAt: timestamp,
          agentId,
          taskId: null,
          workspacePath: duplicateWorkspacePath,
          mime: duplicateEntry.mime,
          bytes: bytes.length,
          sha256,
          objectGeneration: 'duplicate-content',
          emailAttachmentCustodyId: duplicateCustodyId,
        },
        document: {
          ...publication.document,
          id: duplicateDocumentId,
          createdAt: timestamp,
          updatedAt: timestamp,
          title: duplicateEntry.filename,
          fileId: duplicateFileId,
        },
      });
      expect(duplicateResult).toMatchObject({ duplicate: true, published: false, task: null });
      const changedReceiptCustodyId = randomUUID();
      await expect(
        repository.beginEmailAttachmentCustody({
          fence: nextFence,
          observerWorkId,
          channelMessageId,
          providerMessageId,
          manifestDigest,
          entry: duplicateEntry,
          actualBytes: bytes.length,
          sha256: '0'.repeat(64),
          custodyId: changedReceiptCustodyId,
          workspacePath: `email-attachments/custody/${changedReceiptCustodyId}`,
        }),
      ).rejects.toThrow('Email attachment custody replay changed its immutable source');
      await expect(
        repository.markEmailAttachmentCustodyErased({
          agentId,
          custodyId: duplicateCustodyId,
          deletedGeneration: 'duplicate-content',
        }),
      ).resolves.toBe(true);
      const duplicatePendingSnapshot = await store
        .doc('emailAttachmentCustodies', duplicateCustodyId)
        .get();
      expect(duplicatePendingSnapshot.data()).toMatchObject({ status: 'cleanup_pending' });
      await expect(
        repository.markEmailAttachmentCustodyErased({
          agentId,
          custodyId: duplicateCustodyId,
          deletedGeneration: 'duplicate-marker',
        }),
      ).resolves.toBe(true);
      const retryCustodyId = randomUUID();
      const retryReceipt = await repository.beginEmailAttachmentCustody({
        fence: nextFence,
        observerWorkId,
        channelMessageId,
        providerMessageId,
        manifestDigest,
        entry: duplicateEntry,
        actualBytes: bytes.length,
        sha256,
        custodyId: retryCustodyId,
        workspacePath: `email-attachments/custody/${retryCustodyId}`,
      });
      expect(retryReceipt).toMatchObject({
        id: duplicateCustodyId,
        status: 'duplicate_cleaned',
        duplicateDocumentId: documentId,
      });
    });

    it('CASes one exact generation, preserves erased tombstones, and discovers late marker receipts', async () => {
      const store = emulatorStore();
      stores.push(store);
      const agentId = randomUUID();
      const custodyId = randomUUID();
      const workspacePath = `email-attachments/custody/${custodyId}`;
      await store.doc('agents', agentId).set({ id: agentId });
      const row = {
        id: custodyId,
        agentId,
        observerWorkId: null,
        claimToken: null,
        claimGeneration: 4,
        privacyGeneration: null,
        channelMessageId: null,
        providerMessageId: null,
        providerAttachmentId: null,
        manifestDigest: null,
        attachmentOrdinal: 0,
        workspacePath,
        filename: null,
        mime: null,
        advertisedBytes: 0,
        actualBytes: null,
        sha256: null,
        markerGeneration: 'marker-1',
        objectGeneration: null,
        status: 'erased',
        fileId: null,
        documentId: null,
        duplicateDocumentId: null,
        leaseExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await store.doc('emailAttachmentCustodies', custodyId).set(row);
      const staleId = emailAttachmentCustodyCleanupIntentId(custodyId, 'marker-1');
      const stale = {
        kind: 'email_attachment_custody',
        id: staleId,
        sourceId: staleId,
        agentId,
        workspacePath,
        custodyId,
        generation: 'marker-1',
        objectState: 'marker',
        createdAt: new Date(),
      };
      await store.doc('privacyErasureAssets', staleId).set(stale);

      const privacy = new FirestorePrivacyErasureRepository(store);
      const custody = new FirestoreEmailAttachmentCustodyRepository(store, agentId);
      await expect(privacy.pendingAssets()).resolves.toEqual([
        {
          kind: 'email_attachment_custody',
          id: staleId,
          workspacePath,
          custodyId,
          generation: 'marker-1',
          objectState: 'marker',
        },
      ]);
      await expect(
        privacy.assetDeleted({
          kind: 'email_attachment_custody',
          id: staleId,
          workspacePath,
          custodyId,
          generation: 'other-generation',
          objectState: 'marker',
        }),
      ).rejects.toThrow('changed before acknowledgment');
      await expect(store.doc('privacyErasureAssets', staleId).get()).resolves.toMatchObject({
        exists: true,
      });

      await expect(
        custody.recordEmailAttachmentMarker({
          agentId,
          custodyId,
          generation: 'marker-2',
        }),
      ).resolves.toBe(false);
      const currentId = emailAttachmentCustodyCleanupIntentId(custodyId, 'marker-2');
      const current = {
        kind: 'email_attachment_custody' as const,
        id: currentId,
        workspacePath,
        custodyId,
        generation: 'marker-2',
        objectState: 'marker' as const,
      };
      await privacy.refreshEmailAttachmentCustodyCleanupIntent(
        {
          kind: 'email_attachment_custody',
          id: staleId,
          workspacePath,
          custodyId,
          generation: 'marker-1',
          objectState: 'marker',
        },
        { generation: 'marker-2', objectState: 'marker' },
      );
      await expect(store.doc('privacyErasureAssets', staleId).get()).resolves.toMatchObject({
        exists: false,
      });
      await expect(store.doc('privacyErasureAssets', currentId).get()).resolves.toMatchObject({
        exists: true,
      });

      await privacy.assetDeleted(current);
      const tombstone = decodeRecord<Record<string, unknown>>(
        (await store.doc('emailAttachmentCustodies', custodyId).get()).data(),
      );
      expect(tombstone).toMatchObject({
        id: custodyId,
        agentId,
        workspacePath,
        status: 'erased',
        markerGeneration: 'marker-2',
        objectGeneration: null,
        filename: null,
        mime: null,
        sha256: null,
        providerMessageId: null,
        providerAttachmentId: null,
      });
      expect(documentKey(custodyId)).not.toBe(custodyId);
      await expect(privacy.pendingAssets()).resolves.toEqual([]);
    });

    it('drains more than one cleanup page by each asset generation', async () => {
      const store = emulatorStore();
      stores.push(store);
      const agentId = randomUUID();
      await store.doc('agents', agentId).set({ id: agentId });
      const objects = new Map<
        string,
        { custodyId: string; generation: string; state: 'marker' | 'content' }
      >();
      const rows = Array.from({ length: 55 }, (_, index) => {
        const custodyId = randomUUID();
        const generation = `old-${String(index).padStart(2, '0')}`;
        const workspacePath = `email-attachments/custody/${custodyId}`;
        const assetId = emailAttachmentCustodyCleanupIntentId(custodyId, generation);
        return { custodyId, generation, workspacePath, assetId };
      });
      for (const row of rows) {
        await store.doc('emailAttachmentCustodies', row.custodyId).set({
          id: row.custodyId,
          agentId,
          observerWorkId: null,
          claimToken: null,
          claimGeneration: 1,
          privacyGeneration: null,
          channelMessageId: null,
          providerMessageId: null,
          providerAttachmentId: null,
          manifestDigest: null,
          attachmentOrdinal: 0,
          workspacePath: row.workspacePath,
          filename: null,
          mime: null,
          advertisedBytes: 0,
          actualBytes: null,
          sha256: null,
          markerGeneration: row.generation,
          objectGeneration: null,
          status: 'erased',
          fileId: null,
          documentId: null,
          duplicateDocumentId: null,
          leaseExpiresAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await store.doc('privacyErasureAssets', row.assetId).set({
          id: row.assetId,
          sourceId: row.assetId,
          kind: 'email_attachment_custody',
          agentId,
          workspacePath: row.workspacePath,
          custodyId: row.custodyId,
          generation: row.generation,
          objectState: 'marker',
          createdAt: new Date(),
        });
        objects.set(row.custodyId, {
          custodyId: row.custodyId,
          generation: row.generation,
          state: 'marker',
        });
      }
      const repository = new FirestoreEmailAttachmentCustodyRepository(store, agentId);
      const workspace: EmailAttachmentCustodyStore = {
        createEmailAttachmentMarker: async () => ({ generation: 'unused' }),
        replaceEmailAttachmentMarker: async () => ({ generation: 'unused' }),
        inspectEmailAttachmentObject: async (custodyId, generation) => {
          const current = objects.get(custodyId);
          if (!current || (generation && current.generation !== generation)) return null;
          return {
            generation: current.generation,
            custodyId: current.custodyId,
            state: current.state,
            sha256: null,
          };
        },
        deleteOwnedEmailAttachment: async ({ custodyId, expectedGeneration }) => {
          const current = objects.get(custodyId);
          if (!current || current.generation !== expectedGeneration) return 'missing';
          objects.delete(custodyId);
          return 'deleted';
        },
      };

      const first = await sweepEmailAttachmentCustodyCleanup(repository, workspace, agentId);
      const second = await sweepEmailAttachmentCustodyCleanup(repository, workspace, agentId);
      expect(first).toBe(50);
      expect(second).toBe(5);
      expect(await new FirestorePrivacyErasureRepository(store).pendingAssets()).toEqual([]);
      expect(objects.size).toBe(0);
    });

    it('keeps refreshed cleanup generations visible to document deletion', async () => {
      const store = emulatorStore();
      stores.push(store);
      const agentId = randomUUID();
      const custodyId = randomUUID();
      const documentId = randomUUID();
      const workspacePath = `email-attachments/custody/${custodyId}`;
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('emailAttachmentCustodies', custodyId).set({
        id: custodyId,
        agentId,
        workspacePath,
        status: 'cleanup_pending',
        fileId: null,
        markerGeneration: 'marker-1',
        objectGeneration: 'content-2',
        documentId,
        duplicateDocumentId: null,
      });
      const oldId = emailAttachmentCustodyCleanupIntentId(custodyId, 'content-1');
      await store.doc('privacyErasureAssets', oldId).set({
        id: oldId,
        sourceId: oldId,
        kind: 'email_attachment_custody',
        agentId,
        documentId,
        workspacePath,
        custodyId,
        generation: 'content-1',
        objectState: 'content',
        createdAt: new Date(),
      });

      const privacy = new FirestorePrivacyErasureRepository(store);
      await privacy.refreshEmailAttachmentCustodyCleanupIntent(
        {
          kind: 'email_attachment_custody',
          id: oldId,
          workspacePath,
          custodyId,
          documentId,
          generation: 'content-1',
          objectState: 'content',
        },
        { generation: 'content-2', objectState: 'content' },
      );

      const refreshedId = emailAttachmentCustodyCleanupIntentId(custodyId, 'content-2');
      const deletion = new FirestoreDocumentDeletionRepository(store, agentId);
      await expect(deletion.pendingAssets(agentId, documentId)).resolves.toEqual([
        {
          kind: 'email_attachment_custody',
          id: refreshedId,
          workspacePath,
          custodyId,
          documentId,
          generation: 'content-2',
          objectState: 'content',
        },
      ]);
    });

    it('routes linked document custody through exact-generation cleanup, never raw path deletion', async () => {
      const store = emulatorStore();
      stores.push(store);
      const agentId = randomUUID();
      const custodyId = randomUUID();
      const documentId = randomUUID();
      const fileId = randomUUID();
      const workspacePath = `email-attachments/custody/${custodyId}`;
      const sha256 = createHash('sha256').update('attachment').digest('hex');
      const now = new Date();
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('files', fileId).set({
        id: fileId,
        createdAt: now,
        agentId,
        taskId: null,
        workspacePath,
        mime: 'application/pdf',
        bytes: 10,
        sha256,
        objectGeneration: 'content-1',
        emailAttachmentCustodyId: custodyId,
      });
      await store.doc('documents', documentId).set({
        id: documentId,
        createdAt: now,
        updatedAt: now,
        agentId,
        fileId,
        title: 'statement.pdf',
        mime: 'application/pdf',
        bytes: 10,
        sha256,
        source: 'email',
        sourceRef: 'gmail:provider-message',
        trust: 'untrusted',
        processedTextPath: null,
        processorTokenHash: null,
      });
      await store.doc('emailAttachmentCustodies', custodyId).set({
        id: custodyId,
        agentId,
        observerWorkId: randomUUID(),
        claimToken: randomUUID(),
        claimGeneration: 1,
        privacyGeneration: null,
        channelMessageId: 'gmail:provider-message',
        providerMessageId: 'provider-message',
        providerAttachmentId: 'attachment-1',
        manifestDigest: 'a'.repeat(64),
        attachmentOrdinal: 0,
        workspacePath,
        filename: 'statement.pdf',
        mime: 'application/pdf',
        advertisedBytes: 10,
        actualBytes: 10,
        sha256,
        markerGeneration: 'marker-1',
        objectGeneration: 'content-1',
        status: 'catalogued',
        fileId,
        documentId,
        duplicateDocumentId: null,
        leaseExpiresAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const deletion = new FirestoreDocumentDeletionRepository(store, agentId);
      const custodyRepository = new FirestoreEmailAttachmentCustodyRepository(store, agentId);
      const repository: DocumentDeletionRepository = {
        kind: deletion.kind,
        purge: async (ownerId, id) => {
          const result = await deletion.purge(ownerId, id);
          if (result.deleted) {
            await custodyRepository.recordEmailAttachmentObject({
              agentId: ownerId,
              custodyId,
              generation: 'content-2',
              bytes: 10,
              sha256,
            });
            const pending = await deletion.pendingAssets(ownerId, id);
            const linked = pending.find((asset) => asset.kind === 'email_attachment_custody');
            if (linked?.kind !== 'email_attachment_custody')
              throw new Error('expected linked document cleanup intent');
            await expect(
              deletion.assetDeleted(ownerId, { ...linked, documentId: randomUUID() }),
            ).rejects.toThrow('generation changed before acknowledgment');
            await expect(
              deletion.assetDeleted(ownerId, { ...linked, generation: 'other-generation' }),
            ).rejects.toThrow('generation changed before acknowledgment');
          }
          return result;
        },
        pendingAssets: (ownerId, id) => deletion.pendingAssets(ownerId, id),
        assetDeleted: (ownerId, asset) => deletion.assetDeleted(ownerId, asset),
        refreshEmailAttachmentCustodyCleanupIntent: (ownerId, asset, observed) =>
          deletion.refreshEmailAttachmentCustodyCleanupIntent(ownerId, asset, observed),
      };
      const objectGenerations = new Map([
        ['marker-1', 'marker'],
        ['content-1', 'content'],
        ['content-2', 'content'],
      ]);
      const rawDeletes: string[] = [];
      const exactDeletes: string[] = [];
      const workspace = {
        delete: async (path: string) => {
          rawDeletes.push(path);
        },
        emailAttachmentCustody: {
          inspectEmailAttachmentObject: async (requestedCustodyId: string, generation?: string) => {
            if (requestedCustodyId !== custodyId || !generation) return null;
            const state = objectGenerations.get(generation);
            return state
              ? {
                  custodyId,
                  generation,
                  state: state as 'marker' | 'content',
                  sha256: state === 'content' ? sha256 : null,
                }
              : null;
          },
          deleteOwnedEmailAttachment: async ({
            custodyId: requestedCustodyId,
            expectedGeneration,
          }: {
            custodyId: string;
            expectedGeneration?: string;
          }) => {
            if (requestedCustodyId !== custodyId || !expectedGeneration) return 'changed' as const;
            if (!objectGenerations.has(expectedGeneration)) return 'missing' as const;
            exactDeletes.push(expectedGeneration);
            objectGenerations.delete(expectedGeneration);
            return 'deleted' as const;
          },
        },
      };

      const result = await purgeDocument(repository, agentId, documentId, workspace);
      expect(result).toEqual({ deleted: true, pendingAssets: false });
      expect(exactDeletes.sort()).toEqual(['content-1', 'content-2', 'marker-1']);
      expect(objectGenerations.size).toBe(0);
      expect(rawDeletes).not.toContain(workspacePath);
      expect(rawDeletes).toEqual([`documents/${documentId}/extracted.txt`]);
      const tombstone = decodeRecord<Record<string, unknown>>(
        (await store.doc('emailAttachmentCustodies', custodyId).get()).data(),
      );
      expect(tombstone).toMatchObject({
        status: 'erased',
        fileId: null,
        documentId: null,
        filename: null,
        mime: null,
        sha256: null,
      });
      await expect(deletion.pendingAssets(agentId, documentId)).resolves.toEqual([]);
    });

    it('scrubs live custody during the owner erasure and follows late object generations through document cleanup', async () => {
      const store = emulatorStore();
      stores.push(store);
      const agentId = randomUUID();
      const custodyId = randomUUID();
      const documentId = randomUUID();
      const fileId = randomUUID();
      const workspacePath = `email-attachments/custody/${custodyId}`;
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('files', fileId).set({
        id: fileId,
        agentId,
        taskId: null,
        workspacePath,
        mime: 'application/pdf',
        bytes: 3,
        sha256: createHash('sha256').update('pdf').digest('hex'),
        objectGeneration: 'content-1',
        emailAttachmentCustodyId: custodyId,
      });
      await store.doc('documents', documentId).set({
        id: documentId,
        agentId,
        fileId,
        source: 'email',
        sourceRef: 'gmail:provider-message-erase',
        mime: 'application/pdf',
        sha256: createHash('sha256').update('pdf').digest('hex'),
        processedTextPath: null,
        processorTokenHash: null,
      });
      const chunkId = randomUUID();
      await store.doc('documentChunks', chunkId).set({
        id: chunkId,
        agentId,
        documentId,
        text: 'private extracted text',
      });
      await store.doc('emailAttachmentCustodies', custodyId).set({
        id: custodyId,
        agentId,
        observerWorkId: randomUUID(),
        claimToken: 'private-claim',
        claimGeneration: 1,
        privacyGeneration: null,
        channelMessageId: 'gmail:provider-message-erase',
        providerMessageId: 'provider-message-erase',
        providerAttachmentId: 'private-attachment-id',
        manifestDigest: 'a'.repeat(64),
        attachmentOrdinal: 0,
        workspacePath,
        filename: 'private-statement.pdf',
        mime: 'application/pdf',
        advertisedBytes: 3,
        actualBytes: 3,
        sha256: createHash('sha256').update('pdf').digest('hex'),
        markerGeneration: 'marker-1',
        objectGeneration: 'content-1',
        status: 'catalogued',
        fileId,
        documentId,
        duplicateDocumentId: documentId,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await store.doc('emailAttachmentCustodyKeys', 'source-index-private').set({
        id: documentKey('source-index-private'),
        agentId,
        custodyId,
        observerWorkId: randomUUID(),
        providerAttachmentId: 'private-attachment-id',
      });

      const privacy = new FirestorePrivacyErasureRepository(store);
      await privacy.erase();
      const erased = decodeRecord<Record<string, unknown>>(
        (await store.doc('emailAttachmentCustodies', custodyId).get()).data(),
      );
      expect(erased).toMatchObject({
        id: custodyId,
        agentId,
        workspacePath,
        status: 'erased',
        markerGeneration: 'marker-1',
        objectGeneration: 'content-1',
        filename: null,
        mime: null,
        sha256: null,
        providerMessageId: null,
        providerAttachmentId: null,
        duplicateDocumentId: null,
      });
      expect((await store.doc('files', fileId).get()).exists).toBe(false);
      expect((await store.doc('documents', documentId).get()).exists).toBe(false);
      expect(
        (await store.doc('emailAttachmentCustodyKeys', 'source-index-private').get()).exists,
      ).toBe(false);
      expect(
        (await store.collection('documentChunks').where('documentId', '==', documentId).get()).size,
      ).toBe(0);

      const custody = new FirestoreEmailAttachmentCustodyRepository(store, agentId);
      await expect(
        custody.recordEmailAttachmentMarker({
          agentId,
          custodyId,
          generation: 'marker-late',
        }),
      ).resolves.toBe(false);
      await expect(
        custody.recordEmailAttachmentObject({
          agentId,
          custodyId,
          generation: 'content-2',
          bytes: 3,
          sha256: createHash('sha256').update('pdf').digest('hex'),
        }),
      ).resolves.toBe(false);
      const deletion = new FirestoreDocumentDeletionRepository(store, agentId);
      const pending = await deletion.pendingAssets(agentId, documentId);
      expect(pending).toContainEqual(
        expect.objectContaining({
          kind: 'workspace_path',
          workspacePath: `documents/${documentId}/extracted.txt`,
        }),
      );
      const knownAndLateGenerations = new Map([
        ['marker-1', { state: 'marker' as const, sha256: null }],
        [
          'content-1',
          { state: 'content' as const, sha256: createHash('sha256').update('pdf').digest('hex') },
        ],
        ['marker-late', { state: 'marker' as const, sha256: null }],
        [
          'content-2',
          { state: 'content' as const, sha256: createHash('sha256').update('pdf').digest('hex') },
        ],
      ]);
      const swept = await sweepEmailAttachmentCustodyCleanup(
        custody,
        {
          createEmailAttachmentMarker: async () => ({ generation: 'unused' }),
          replaceEmailAttachmentMarker: async () => ({ generation: 'unused' }),
          inspectEmailAttachmentObject: async (requestedCustodyId, generation) => {
            if (requestedCustodyId !== custodyId || !generation) return null;
            const object = knownAndLateGenerations.get(generation);
            return object
              ? { generation, custodyId, state: object.state, sha256: object.sha256 }
              : null;
          },
          deleteOwnedEmailAttachment: async ({
            custodyId: requestedCustodyId,
            expectedGeneration,
            expectedSha256,
          }) => {
            if (requestedCustodyId !== custodyId || !expectedGeneration) return 'changed';
            const object = knownAndLateGenerations.get(expectedGeneration);
            if (!object) return 'missing';
            if (object.sha256 && object.sha256 !== expectedSha256) return 'changed';
            knownAndLateGenerations.delete(expectedGeneration);
            return 'deleted';
          },
        },
        agentId,
      );
      expect(swept).toBe(4);
      expect(knownAndLateGenerations.size).toBe(0);
      await expect(privacy.pendingAssets()).resolves.not.toContainEqual(
        expect.objectContaining({ custodyId }),
      );
      expect(
        decodeRecord<Record<string, unknown>>(
          (await store.doc('emailAttachmentCustodies', custodyId).get()).data(),
        ),
      ).toMatchObject({
        status: 'erased',
        markerGeneration: 'marker-late',
        objectGeneration: 'content-2',
      });
    });
    it('resumes a bounded attachment-erasure page after a later row fails validation', async () => {
      const store = emulatorStore();
      stores.push(store);
      const agentId = randomUUID();
      await store.doc('agents', agentId).set({ id: agentId });
      const rows = Array.from({ length: 6 }, (_, index) => {
        const suffix = String(index + 1).padStart(12, '0');
        const id = `00000000-0000-4000-8000-${suffix}`;
        return { id, docId: documentKey(id) };
      }).sort((left, right) => left.docId.localeCompare(right.docId));
      const invalid = rows.at(-1);
      if (!invalid) throw new Error('Erasure fixture did not create custody rows');
      for (const row of rows) {
        await store.doc('emailAttachmentCustodies', row.id).set({
          id: row.id,
          agentId,
          workspacePath:
            row.id === invalid.id
              ? 'email-attachments/custody/mismatched'
              : `email-attachments/custody/${row.id}`,
          status: 'catalogued',
          markerGeneration: null,
          objectGeneration: null,
          fileId: null,
          documentId: null,
          duplicateDocumentId: null,
          filename: 'private-name.pdf',
          mime: 'application/pdf',
          sha256: 'private-digest',
          providerAttachmentId: 'private-provider-id',
        });
      }

      const privacy = new FirestorePrivacyErasureRepository(store);
      await expect(privacy.erase()).rejects.toThrow(
        'Email attachment custody ownership or path mismatch',
      );
      for (const row of rows.slice(0, -1))
        expect(
          decodeRecord<Record<string, unknown>>(
            (await store.doc('emailAttachmentCustodies', row.id).get()).data(),
          ),
        ).toMatchObject({ status: 'erased', filename: null, sha256: null });
      await expect(store.doc('emailAttachmentCustodies', invalid.id).get()).resolves.toMatchObject({
        exists: true,
      });

      await store.doc('emailAttachmentCustodies', invalid.id).update({
        workspacePath: `email-attachments/custody/${invalid.id}`,
      });
      await privacy.erase();
      for (const row of rows)
        expect(
          decodeRecord<Record<string, unknown>>(
            (await store.doc('emailAttachmentCustodies', row.id).get()).data(),
          ),
        ).toMatchObject({ status: 'erased', filename: null, sha256: null });
    });
  },
);
