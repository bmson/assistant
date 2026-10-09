import { createHash } from 'node:crypto';
import {
  type DocumentDeletionRepository,
  emailAttachmentCustodyCleanupIntentId,
  type PrivacyErasureAsset,
  type Records,
} from '@assistant/persistence';
import { FieldPath, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { dedupClaimId } from './document-catalog.js';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const ACTIVE_TASK_STATUSES = ['pending', 'sleeping', 'running', 'needs_attention'];
const DOCUMENT_JOBS = ['documents.extract', 'documents.process'];
/** Deletes per transaction, under Firestore's 500-write commit limit. */
const PAGE = 400;
const TASK_LIMIT = 50;

/**
 * Document deletion on Firestore. PostgreSQL deletes everything in one
 * transaction; here the document's jobs are cancelled first so no chunk lands
 * afterwards, the chunks go in bounded pages, and the catalog record, file row
 * and deduplication claim are removed together last, so a half-finished
 * delete leaves a visible document that a retry completes.
 */
export class FirestoreDocumentDeletionRepository implements DocumentDeletionRepository {
  readonly kind = 'document-deletion-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async purge(agentId: string, documentId: string): Promise<{ deleted: boolean }> {
    if (agentId !== this.configuredAgentId)
      throw new Error('Document deletion is outside the configured owner');
    const documentRef = this.store.doc('documents', documentId);
    const snapshot = await documentRef.get();
    if (!snapshot.exists) return { deleted: false };
    const document = decodeRecord<Records['documents']>(snapshot.data());
    if (document.agentId !== agentId || document.id !== documentId) return { deleted: false };

    const jobs = await this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('trigger.payload.documentId', '==', documentId)
      .limit(TASK_LIMIT + 1)
      .get();
    if (jobs.size > TASK_LIMIT) throw new Error('Document tasks exceed the deletion bound');
    await this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const fresh = jobs.docs.length ? await tx.getAll(...jobs.docs.map((doc) => doc.ref)) : [];
      const now = this.store.now();
      for (const task of fresh) {
        const job = task.get('trigger')?.payload?.job;
        if (
          task.exists &&
          DOCUMENT_JOBS.includes(job) &&
          ACTIVE_TASK_STATUSES.includes(String(task.get('status')))
        )
          tx.update(task.ref, {
            status: 'cancelled',
            lockedUntil: null,
            runAfter: null,
            leaseToken: null,
            updatedAt: now,
          });
      }
    });

    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let page = this.store
        .collection('documentChunks')
        .where('documentId', '==', documentId)
        .orderBy(FieldPath.documentId())
        .limit(PAGE);
      if (cursor) page = page.startAfter(cursor);
      const result = await this.store.db.runTransaction(async (tx) => {
        await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
        const rows = await tx.get(page);
        for (const doc of rows.docs)
          if (doc.get('agentId') === agentId || doc.get('agentId') === undefined)
            tx.delete(doc.ref);
        return { size: rows.size, last: rows.docs.at(-1) };
      });
      if (result.size < PAGE) break;
      cursor = result.last;
    }

    const fileRef = this.store.doc('files', document.fileId);
    const claimRef = this.store.doc('documentDedupKeys', dedupClaimId(agentId, document.sha256));
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const [current, file, claim] = await tx.getAll(documentRef, fileRef, claimRef);
      if (
        !current?.exists ||
        current.get('agentId') !== agentId ||
        current.get('fileId') !== document.fileId ||
        current.get('sha256') !== document.sha256
      )
        return { deleted: false };
      if (!file?.exists || file.get('agentId') !== agentId || file.get('id') !== document.fileId)
        throw new Error('Document file inventory is missing; deletion remains incomplete');
      const fileRecord = decodeRecord<Records['files']>(file.data());
      const custodyRef = fileRecord.emailAttachmentCustodyId
        ? this.store.doc('emailAttachmentCustodies', fileRecord.emailAttachmentCustodyId)
        : null;
      const custody = custodyRef ? await tx.get(custodyRef) : null;
      if (custodyRef) {
        if (
          !custody?.exists ||
          custody.get('agentId') !== agentId ||
          custody.get('id') !== fileRecord.emailAttachmentCustodyId ||
          custody.get('status') !== 'catalogued' ||
          custody.get('fileId') !== fileRecord.id ||
          custody.get('documentId') !== documentId ||
          custody.get('workspacePath') !== fileRecord.workspacePath ||
          typeof custody.get('objectGeneration') !== 'string' ||
          !custody.get('objectGeneration') ||
          custody.get('objectGeneration') !== fileRecord.objectGeneration
        )
          throw new Error(
            'Email attachment custody is missing or changed; deletion remains incomplete',
          );
      }
      const paths: string[] = [];
      const path = file.get('workspacePath');
      if (!custodyRef && typeof path === 'string' && path) paths.push(path);
      const processed = current.get('processedTextPath');
      if (typeof processed === 'string' && processed) paths.push(processed);
      paths.push(`documents/${documentId}/extracted.txt`);
      // Persist every blob identity in the same transaction that removes its
      // catalog references. Privacy erasure drains this same durable outbox.
      for (const workspacePath of new Set(paths)) {
        const id = documentDeletionAssetId(documentId, workspacePath);
        tx.set(this.store.doc('privacyErasureAssets', id), {
          id,
          sourceId: id,
          documentId,
          agentId,
          workspacePath,
          createdAt: this.store.now(),
        });
      }
      if (custodyRef && custody?.exists) {
        const custodyId = String(custody.get('id'));
        const generations = [
          ...(typeof custody.get('markerGeneration') === 'string'
            ? [
                {
                  generation: String(custody.get('markerGeneration')),
                  objectState: 'marker' as const,
                },
              ]
            : []),
          ...(typeof custody.get('objectGeneration') === 'string'
            ? [
                {
                  generation: String(custody.get('objectGeneration')),
                  objectState: 'content' as const,
                },
              ]
            : []),
        ];
        if (
          !generations.length ||
          generations.some(({ generation }) => !generation) ||
          new Set(generations.map(({ generation }) => generation)).size !== generations.length
        )
          throw new Error(
            'Email attachment custody has no owned generation; deletion remains incomplete',
          );
        tx.update(custodyRef, {
          status: 'cleanup_pending',
          fileId: null,
          updatedAt: this.store.now(),
        });
        for (const { generation, objectState } of generations) {
          const id = emailAttachmentCustodyCleanupIntentId(custodyId, generation);
          tx.set(
            this.store.doc('privacyErasureAssets', id),
            {
              id,
              sourceId: id,
              kind: 'email_attachment_custody',
              agentId,
              documentId,
              workspacePath: fileRecord.workspacePath,
              custodyId,
              generation,
              objectState,
              createdAt: this.store.now(),
            },
            { merge: true },
          );
        }
      }
      const processorTokenHash = current.get('processorTokenHash');
      if (typeof processorTokenHash === 'string' && processorTokenHash) {
        const outputPath = `documents/${documentId}/extracted.txt`;
        const tombstone = this.store.doc('documentDeletionTombstones', documentId);
        const workerAssetId = `document-delete-worker:${documentId}`;
        tx.set(tombstone, {
          agentId,
          documentId,
          processorTokenHash,
          outputPath,
          createdAt: this.store.now(),
        });
        tx.set(this.store.doc('privacyErasureAssets', workerAssetId), {
          id: workerAssetId,
          sourceId: workerAssetId,
          documentId,
          agentId,
          workspacePath: outputPath,
          workerPending: true,
          createdAt: this.store.now(),
        });
      }
      // A claim that points here would make a re-upload find a stale claim.
      if (claim?.exists && claim.get('documentId') === documentId) tx.delete(claim.ref);
      tx.delete(file.ref);
      if (documentKey(documentId) === current.id) tx.delete(current.ref);
      return { deleted: true };
    });
  }

  async pendingAssets(agentId: string, documentId: string): Promise<PrivacyErasureAsset[]> {
    if (agentId !== this.configuredAgentId)
      throw new Error('Document deletion is outside the configured owner');
    const assets = await this.store
      .collection('privacyErasureAssets')
      .where('agentId', '==', agentId)
      .where('documentId', '==', documentId)
      .limit(100)
      .get();
    const pending: PrivacyErasureAsset[] = [];
    for (const doc of assets.docs) {
      const id = doc.get('sourceId');
      const path = doc.get('workspacePath');
      if (
        doc.get('agentId') !== agentId ||
        doc.get('documentId') !== documentId ||
        typeof id !== 'string' ||
        documentKey(id) !== doc.id ||
        typeof path !== 'string' ||
        !path
      )
        throw new Error('Document deletion asset ownership or identity mismatch');
      if (doc.get('kind') === 'email_attachment_custody') {
        const custodyId = doc.get('custodyId');
        const generation = doc.get('generation');
        const objectState = doc.get('objectState');
        if (
          typeof custodyId !== 'string' ||
          doc.get('documentId') !== documentId ||
          typeof generation !== 'string' ||
          !generation ||
          (objectState !== 'marker' && objectState !== 'content') ||
          id !== emailAttachmentCustodyCleanupIntentId(custodyId, generation)
        )
          throw new Error('Document deletion custody asset is malformed');
        const custody = await this.store.doc('emailAttachmentCustodies', custodyId).get();
        if (
          !custody.exists ||
          custody.get('agentId') !== agentId ||
          custody.get('id') !== custodyId ||
          custody.get('workspacePath') !== path
        )
          throw new Error('Document deletion custody linkage is no longer valid');
        // Owner erasure owns cleanup for its permanent erased tombstones; they
        // remain discoverable through the global privacy-asset worker instead.
        if (custody.get('status') === 'erased') continue;
        if (
          custody.get('status') !== 'cleanup_pending' ||
          custody.get('fileId') !== null ||
          custody.get('documentId') !== documentId
        )
          throw new Error('Document deletion custody linkage is no longer valid');
        pending.push({
          kind: 'email_attachment_custody',
          id,
          workspacePath: path,
          custodyId,
          documentId,
          generation,
          objectState,
        });
        continue;
      }
      if (doc.get('kind') !== undefined && doc.get('kind') !== 'workspace_path')
        throw new Error('Document deletion asset kind is malformed');
      pending.push({ kind: 'workspace_path', id, workspacePath: path });
    }
    return pending;
  }

  async assetDeleted(agentId: string, requested: PrivacyErasureAsset | string) {
    if (agentId !== this.configuredAgentId)
      throw new Error('Document deletion is outside the configured owner');
    const id = typeof requested === 'string' ? requested : requested.id;
    const ref = this.store.doc('privacyErasureAssets', id);
    await this.store.db.runTransaction(async (tx) => {
      const custodyRequested =
        typeof requested !== 'string' && requested.kind === 'email_attachment_custody'
          ? requested
          : null;
      const custodyRef = custodyRequested
        ? this.store.doc('emailAttachmentCustodies', custodyRequested.custodyId)
        : null;
      const snapshots = await tx.getAll(...(custodyRef ? [ref, custodyRef] : [ref]));
      const asset = snapshots[0];
      if (!asset?.exists) return;
      if (
        asset.get('agentId') !== agentId ||
        asset.get('sourceId') !== id ||
        (typeof requested !== 'string' && asset.get('workspacePath') !== requested.workspacePath)
      )
        throw new Error('Document deletion asset belongs to another owner');
      if (typeof requested === 'string' && asset.get('kind') === 'email_attachment_custody')
        throw new Error('Email attachment cleanup requires its exact linked intent');
      if (custodyRequested) {
        const custody = snapshots[1];
        if (
          asset.get('kind') !== 'email_attachment_custody' ||
          asset.get('custodyId') !== custodyRequested.custodyId ||
          asset.get('documentId') !== custodyRequested.documentId ||
          typeof custodyRequested.documentId !== 'string' ||
          asset.get('generation') !== custodyRequested.generation ||
          asset.get('objectState') !== custodyRequested.objectState ||
          !custody?.exists ||
          custody.get('agentId') !== agentId ||
          custody.get('status') !== 'cleanup_pending' ||
          custody.get('fileId') !== null ||
          custody.get('documentId') !== custodyRequested.documentId ||
          custody.get('workspacePath') !== custodyRequested.workspacePath
        )
          throw new Error('Document deletion custody generation changed before acknowledgment');
        const otherIntents = await tx.get(
          this.store
            .collection('privacyErasureAssets')
            .where('custodyId', '==', custodyRequested.custodyId)
            .limit(100),
        );
        if (otherIntents.size >= 100)
          throw new Error('Email attachment cleanup intent count exceeds its bound');
        for (const other of otherIntents.docs) {
          if (
            other.id !== id &&
            (other.get('agentId') !== agentId ||
              other.get('kind') !== 'email_attachment_custody' ||
              other.get('custodyId') !== custodyRequested.custodyId)
          )
            throw new Error('Email attachment cleanup sibling identity changed');
        }
        const hasOtherIntent = otherIntents.docs.some((doc) => doc.id !== ref.id);
        if (!hasOtherIntent)
          tx.update(custody.ref, {
            observerWorkId: null,
            claimToken: null,
            privacyGeneration: null,
            channelMessageId: null,
            providerMessageId: null,
            providerAttachmentId: null,
            manifestDigest: null,
            filename: null,
            mime: null,
            advertisedBytes: 0,
            actualBytes: null,
            sha256: null,
            status: 'erased',
            fileId: null,
            documentId: null,
            duplicateDocumentId: null,
            leaseExpiresAt: null,
            updatedAt: this.store.now(),
          });
      }
      if (asset.get('workerPending') === true)
        throw new Error('Document processor callback remains unresolved');
      tx.delete(ref);
    });
  }

  async refreshEmailAttachmentCustodyCleanupIntent(
    agentId: string,
    asset: Extract<PrivacyErasureAsset, { kind: 'email_attachment_custody' }>,
    observed: { generation: string; objectState: 'marker' | 'content' },
  ) {
    if (agentId !== this.configuredAgentId)
      throw new Error('Document deletion is outside the configured owner');
    const rowRef = this.store.doc('emailAttachmentCustodies', asset.custodyId);
    const oldRef = this.store.doc('privacyErasureAssets', asset.id);
    const nextId = emailAttachmentCustodyCleanupIntentId(asset.custodyId, observed.generation);
    const nextRef = this.store.doc('privacyErasureAssets', nextId);
    await this.store.db.runTransaction(async (tx) => {
      const [row, old, next] = await tx.getAll(rowRef, oldRef, nextRef);
      if (
        !row?.exists ||
        row.get('agentId') !== agentId ||
        row.get('workspacePath') !== asset.workspacePath ||
        row.get('status') !== 'cleanup_pending' ||
        row.get('fileId') !== null ||
        typeof asset.documentId !== 'string' ||
        !asset.documentId ||
        row.get('documentId') !== asset.documentId
      )
        throw new Error('Document deletion custody tombstone changed before refresh');
      if (
        !old?.exists ||
        old.get('agentId') !== agentId ||
        old.get('sourceId') !== asset.id ||
        old.get('kind') !== 'email_attachment_custody' ||
        old.get('documentId') !== asset.documentId ||
        old.get('generation') !== asset.generation ||
        old.get('objectState') !== asset.objectState ||
        old.get('workspacePath') !== asset.workspacePath ||
        old.get('custodyId') !== asset.custodyId
      )
        throw new Error('Document deletion cleanup intent changed before refresh');
      if (asset.objectState !== observed.objectState)
        throw new Error('Observed custody generation changed state');
      const generationField =
        observed.objectState === 'content' ? 'objectGeneration' : 'markerGeneration';
      const current = row.get(generationField);
      if (typeof current !== 'string' || !current)
        throw new Error('Observed custody state has no linked generation');
      if (nextId === asset.id && observed.generation === asset.generation) return;
      if (
        next?.exists &&
        (next.get('agentId') !== agentId ||
          next.get('documentId') !== asset.documentId ||
          next.get('kind') !== 'email_attachment_custody' ||
          next.get('workspacePath') !== asset.workspacePath ||
          next.get('custodyId') !== asset.custodyId ||
          next.get('generation') !== observed.generation ||
          next.get('objectState') !== observed.objectState)
      )
        throw new Error('Document deletion cleanup identity collision');
      if (!next?.exists)
        tx.create(nextRef, {
          id: nextId,
          sourceId: nextId,
          kind: 'email_attachment_custody',
          agentId,
          documentId: old.get('documentId'),
          workspacePath: asset.workspacePath,
          custodyId: asset.custodyId,
          generation: observed.generation,
          objectState: observed.objectState,
          createdAt: this.store.now(),
        });
      if (current !== observed.generation)
        tx.update(row.ref, { [generationField]: observed.generation, updatedAt: this.store.now() });
      tx.delete(oldRef);
    });
  }
}

function documentDeletionAssetId(documentId: string, path: string): string {
  return `document-delete:${documentId}:${createHash('sha256').update(path).digest('hex')}`;
}
