import { createHash, randomUUID } from 'node:crypto';
import {
  type DocumentCatalogRepository,
  type EmailObserverEffectFence,
  emailAttachmentCustodyCleanupIntentId,
  extractorFor,
  matchesPreparedEmailObserverClaim,
  newTaskRecord,
  type Records,
} from '@assistant/persistence';
import {
  exactPreparedEntry,
  readCanonicalEmailAttachmentSource,
} from './email-attachment-source.js';
import { isEmulatorClosedTransaction } from './emulator-transaction.js';
import { createWakeIntent } from './outbox.js';
import {
  assertPrivacyErasureGenerationInTransaction,
  privacyErasureIsActive,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type DocumentRow = Records['documents'];
type FileRow = Records['files'];
type DedupClaim = {
  id: string;
  agentId: string;
  sha256: string;
  documentId: string;
};

export function dedupClaimId(agentId: string, sha256: string): string {
  return createHash('sha256').update(`${agentId}\0${sha256}`).digest('hex');
}

function assertInput(file: FileRow, document: DocumentRow, configuredAgentId: string): void {
  if (
    !configuredAgentId ||
    file.agentId !== configuredAgentId ||
    document.agentId !== configuredAgentId
  )
    throw new Error('Document catalog write is outside the configured owner');
  if (!file.id || !document.id || document.fileId !== file.id)
    throw new Error('Document catalog record identity is invalid');
  documentKey(file.id);
  documentKey(document.id);
  if (file.taskId !== null) throw new Error('Document catalog files cannot belong to a task');
  if (
    !/^[0-9a-f]{64}$/.test(file.sha256 ?? '') ||
    file.sha256 !== document.sha256 ||
    file.mime !== document.mime ||
    !file.workspacePath ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0
  )
    throw new Error('Document catalog file metadata is invalid');
  if (
    !document.title ||
    document.title.length > 300 ||
    !document.mime ||
    !['upload', 'email', 'drive'].includes(document.source) ||
    !['owner', 'known', 'unknown', 'assistant'].includes(document.trust) ||
    !['pending', 'unsupported'].includes(document.status) ||
    !['text', 'pdf', 'pending_processor', 'unsupported'].includes(document.extractor) ||
    (document.extractor === 'unsupported') !== (document.status === 'unsupported') ||
    document.chunkCount !== 0 ||
    document.charCount !== 0 ||
    document.processorTokenHash !== null ||
    document.processorStartedAt !== null ||
    document.processedTextPath !== null ||
    document.processorAttempts !== 0 ||
    !(document.createdAt instanceof Date) ||
    !Number.isFinite(document.createdAt.getTime()) ||
    !(document.updatedAt instanceof Date) ||
    !Number.isFinite(document.updatedAt.getTime()) ||
    !(file.createdAt instanceof Date) ||
    !Number.isFinite(file.createdAt.getTime())
  )
    throw new Error('Document catalog input must describe an unprocessed document');
}

function validDocument(snapshot: FirebaseFirestore.DocumentSnapshot, agentId: string): DocumentRow {
  const row = decodeRecord<DocumentRow>(snapshot.data());
  if (!row.id || documentKey(row.id) !== snapshot.id || row.agentId !== agentId)
    throw new Error('Document catalog found an invalid document record');
  return row;
}

function validFile(
  snapshot: FirebaseFirestore.DocumentSnapshot,
  agentId: string,
  expectedSha256: string,
): FileRow {
  const row = decodeRecord<FileRow>(snapshot.data());
  if (
    !row.id ||
    documentKey(row.id) !== snapshot.id ||
    row.agentId !== agentId ||
    row.sha256 !== expectedSha256
  )
    throw new Error('Document catalog found a file with invalid owner, identity, or content hash');
  return row;
}

/**
 * Atomic Firestore record boundary for document ingest. The file inventory,
 * document row, dedup claim, processing task, and durable wake intent commit
 * together. Callers remain responsible for rolling back staged blob bytes.
 */
export class FirestoreDocumentCatalogRepository implements DocumentCatalogRepository {
  readonly kind = 'document-catalog-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async createDocumentCatalog(input: { file: FileRow; document: DocumentRow }): Promise<{
    document: DocumentRow;
    duplicate: boolean;
    task: { id: string; queueGeneration: number } | null;
  }> {
    const result = await this.createCatalog(input);
    return { document: result.document, duplicate: result.duplicate, task: result.task };
  }

  async createEmailAttachmentCatalog(input: {
    file: FileRow;
    document: DocumentRow;
    custodyId: string;
    fence: EmailObserverEffectFence;
  }): Promise<{
    document: DocumentRow;
    duplicate: boolean;
    task: { id: string; queueGeneration: number } | null;
    published: boolean;
  }> {
    const result = await this.createCatalog(input);
    return {
      document: result.document,
      duplicate: result.duplicate,
      task: result.task,
      published: result.published ?? false,
    };
  }

  private async createCatalog(input: {
    file: FileRow;
    document: DocumentRow;
    custodyId?: string;
    fence?: EmailObserverEffectFence;
  }): Promise<{
    document: DocumentRow;
    duplicate: boolean;
    task: { id: string; queueGeneration: number } | null;
    published?: boolean;
  }> {
    assertInput(input.file, input.document, this.configuredAgentId);
    if ((input.custodyId === undefined) !== (input.fence === undefined))
      throw new Error('Email attachment catalog fence is incomplete');
    if (input.custodyId && input.file.emailAttachmentCustodyId !== input.custodyId)
      throw new Error('Email attachment file lost its custody identity');
    const { agentId } = input.document;
    const job =
      input.document.extractor === 'text' || input.document.extractor === 'pdf'
        ? 'documents.extract'
        : input.document.extractor === 'pending_processor'
          ? 'documents.process'
          : null;
    const taskId = job ? randomUUID() : null;
    const claimId = dedupClaimId(agentId, input.document.sha256);
    const claimRef = this.store.doc('documentDedupKeys', claimId);
    const fileRef = this.store.doc('files', input.file.id);
    const documentRef = this.store.doc('documents', input.document.id);
    const custodyRef = input.custodyId
      ? this.store.doc('emailAttachmentCustodies', input.custodyId)
      : null;
    const observerRef = input.fence ? this.store.doc('emailObserverWork', input.fence.id) : null;

    // The dedup claim makes a retry return the committed winner as a duplicate.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.store.db.runTransaction(async (tx) => {
          const owners = await tx.get(this.store.collection('agents').limit(2));
          const owner = owners.docs[0];
          if (
            owners.size !== 1 ||
            !owner ||
            owner.id !== documentKey(agentId) ||
            owner.get('id') !== agentId
          )
            throw new Error('Documents require exactly one configured agent');

          const initialRefs = [
            this.store.doc('privacyErasureJobs', agentId),
            claimRef,
            fileRef,
            documentRef,
          ];
          if (custodyRef) initialRefs.push(custodyRef);
          if (observerRef) initialRefs.push(observerRef);
          const initial = await tx.getAll(...initialRefs);
          const [erasure, claim, candidateFile, candidateDocument] = initial;
          const custodySnapshot = custodyRef ? initial[4] : undefined;
          const observerSnapshot = observerRef ? initial[5] : undefined;
          if (
            erasure?.exists &&
            (erasure.get('agentId') !== agentId || privacyErasureIsActive(erasure.get('status')))
          )
            throw new Error('Privacy erasure is in progress');

          if (input.fence && input.custodyId) {
            await assertPrivacyErasureGenerationInTransaction(
              tx,
              this.store,
              agentId,
              input.fence.expectedPrivacyGeneration,
            );
            if (!custodySnapshot?.exists || !observerSnapshot?.exists)
              throw new Error('Email attachment custody or observer work is missing');
            const custody = decodeRecord<Records['emailAttachmentCustodies']>(
              custodySnapshot.data(),
            );
            const observer = decodeRecord<Records['emailObserverWork']>(observerSnapshot.data());
            const now = this.store.now();
            const canonicalSource = await readCanonicalEmailAttachmentSource(
              tx,
              this.store,
              agentId,
              custody.channelMessageId as string,
              custody.providerMessageId as string,
              custody.observerWorkId as string,
            );
            const canonicalTrust =
              canonicalSource?.ingest.ingestMode === 'forwarded'
                ? 'unknown'
                : canonicalSource?.ingest.contentTrust;
            if (
              custody.id !== input.custodyId ||
              custody.agentId !== agentId ||
              custody.status !== 'object_written' ||
              custody.objectGeneration === null ||
              custody.fileId !== null ||
              custody.documentId !== null ||
              custody.workspacePath !== input.file.workspacePath ||
              input.file.objectGeneration !== custody.objectGeneration ||
              custody.sha256 !== input.file.sha256 ||
              custody.actualBytes !== input.file.bytes ||
              custody.mime !== input.file.mime ||
              custody.observerWorkId !== input.fence.id ||
              custody.claimToken !== input.fence.claimToken ||
              custody.claimGeneration !== input.fence.claimGeneration ||
              custody.privacyGeneration !== input.fence.expectedPrivacyGeneration ||
              !canonicalSource ||
              input.document.title !== custody.filename ||
              input.document.trust !== canonicalTrust ||
              input.document.extractor !== extractorFor(custody.mime, custody.filename) ||
              !exactPreparedEntry(
                input.fence,
                {
                  providerAttachmentId: custody.providerAttachmentId as string,
                  ordinal: custody.attachmentOrdinal,
                  filename: custody.filename as string,
                  mime: custody.mime as string,
                  advertisedBytes: custody.advertisedBytes,
                },
                custody.manifestDigest as string,
                custody.channelMessageId as string,
                custody.providerMessageId as string,
                observer,
                now,
              ) ||
              input.document.source !== 'email' ||
              input.document.sourceRef !== `gmail:${custody.providerMessageId}` ||
              !matchesPreparedEmailObserverClaim(observer, input.fence, now)
            )
              throw new Error('Email attachment publication custody fence is stale');
          }

          if (claim?.exists) {
            const key = decodeRecord<DedupClaim>(claim.data());
            if (
              documentKey(key.id) !== claim.id ||
              key.id !== dedupClaimId(agentId, input.document.sha256) ||
              key.agentId !== agentId ||
              key.sha256 !== input.document.sha256 ||
              !key.documentId
            )
              throw new Error('Document deduplication claim is malformed');
            const existingRef = this.store.doc('documents', key.documentId);
            const existingSnapshot = await tx.get(existingRef);
            if (!existingSnapshot.exists) throw new Error('Document deduplication claim is stale');
            const existing = validDocument(existingSnapshot, agentId);
            if (existing.agentId !== agentId || existing.sha256 !== input.document.sha256)
              throw new Error('Document deduplication claim points outside its owner or hash');
            const existingFileSnapshot = await tx.get(this.store.doc('files', existing.fileId));
            if (!existingFileSnapshot.exists) throw new Error('Duplicate document file is missing');
            validFile(existingFileSnapshot, agentId, input.document.sha256);
            if (custodyRef && custodySnapshot?.exists && input.custodyId) {
              const custody = decodeRecord<Records['emailAttachmentCustodies']>(
                custodySnapshot.data(),
              );
              this.queueCustodyCleanup(tx, custody, existing.id);
            }
            return { document: existing, duplicate: true, task: null, published: false };
          }

          // Older imported catalogs predate claim documents. A single-field hash
          // query adopts the existing row without a migration-time claim backfill.
          const existingRows = await tx.get(
            this.store
              .collection('documents')
              .where('sha256', '==', input.document.sha256)
              .limit(2),
          );
          if (existingRows.size > 1)
            throw new Error(
              'Document catalog contains multiple records with the same content hash',
            );
          for (const snapshot of existingRows.docs) {
            const existing = validDocument(snapshot, agentId);
            if (documentKey(existing.id) !== snapshot.id || existing.agentId !== agentId)
              throw new Error('Document catalog contains an invalid owner record');
            if (existing.sha256 !== input.document.sha256) continue;
            const existingFileSnapshot = await tx.get(this.store.doc('files', existing.fileId));
            if (!existingFileSnapshot.exists) throw new Error('Duplicate document file is missing');
            validFile(existingFileSnapshot, agentId, input.document.sha256);
            const key: DedupClaim = {
              id: claimId,
              agentId,
              sha256: input.document.sha256,
              documentId: existing.id,
            };
            tx.create(claimRef, encodeRecord(key));
            if (custodyRef && custodySnapshot?.exists && input.custodyId) {
              const custody = decodeRecord<Records['emailAttachmentCustodies']>(
                custodySnapshot.data(),
              );
              this.queueCustodyCleanup(tx, custody, existing.id);
            }
            return { document: existing, duplicate: true, task: null, published: false };
          }

          if (candidateFile?.exists || candidateDocument?.exists)
            throw new Error('Document catalog record ID collision');

          const key: DedupClaim = {
            id: claimId,
            agentId,
            sha256: input.document.sha256,
            documentId: input.document.id,
          };
          tx.create(fileRef, encodeRecord(input.file));
          tx.create(documentRef, encodeRecord(input.document));
          tx.create(claimRef, encodeRecord(key));
          if (custodyRef && input.custodyId) {
            tx.update(custodyRef, {
              status: 'catalogued',
              fileId: input.file.id,
              documentId: input.document.id,
              updatedAt: this.store.now(),
            });
          }
          let task: Records['tasks'] | null = null;
          if (job && taskId) {
            const now = this.store.now();
            task = newTaskRecord(
              {
                agentId,
                type: 'adhoc',
                trust: 'assistant',
                trigger: {
                  source: 'internal',
                  payload: { job, documentId: input.document.id },
                },
                budgetUsdLimit: job === 'documents.process' ? '0.05' : '0.50',
              },
              taskId,
              now,
            );
            tx.create(this.store.doc('tasks', task.id), encodeRecord(task));
            createWakeIntent(tx, this.store, {
              taskId: task.id,
              generation: task.queueGeneration,
              availableAt: task.runAfter ?? now,
            });
          }
          return {
            document: input.document,
            duplicate: false,
            task: task ? { id: task.id, queueGeneration: task.queueGeneration } : null,
            published: true,
          };
        });
      } catch (error) {
        if (!isEmulatorClosedTransaction(error) || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }

  private queueCustodyCleanup(
    tx: FirebaseFirestore.Transaction,
    custody: Records['emailAttachmentCustodies'],
    duplicateDocumentId: string,
  ) {
    if (
      custody.agentId !== this.configuredAgentId ||
      !custody.objectGeneration ||
      !duplicateDocumentId
    )
      throw new Error('Duplicate email attachment has no exact object generation');
    tx.update(this.store.doc('emailAttachmentCustodies', custody.id), {
      status: 'cleanup_pending',
      duplicateDocumentId,
      updatedAt: this.store.now(),
    });
    const generations = [
      ...(custody.markerGeneration
        ? [{ generation: custody.markerGeneration, state: 'marker' as const }]
        : []),
      { generation: custody.objectGeneration, state: 'content' as const },
    ];
    for (const { generation, state } of generations) {
      const id = emailAttachmentCustodyCleanupIntentId(custody.id, generation);
      tx.set(
        this.store.doc('privacyErasureAssets', id),
        {
          id,
          sourceId: id,
          kind: 'email_attachment_custody',
          agentId: custody.agentId,
          workspacePath: custody.workspacePath,
          custodyId: custody.id,
          generation,
          objectState: state,
          createdAt: this.store.now(),
        },
        { merge: true },
      );
    }
  }
}
