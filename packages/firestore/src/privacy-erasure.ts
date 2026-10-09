import { createHash, randomUUID } from 'node:crypto';
import type {
  PrivacyErasureAsset,
  PrivacyErasureCounts,
  PrivacyErasureRepository,
  Records,
} from '@assistant/persistence';
import {
  emailAttachmentCustodyCleanupIntentId,
  notificationDashboardMessageId,
} from '@assistant/persistence';
import {
  type DocumentSnapshot,
  FieldPath,
  FieldValue,
  type Query,
  type Timestamp,
  type Transaction,
} from '@google-cloud/firestore';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const PAGE_SIZE = 50;
const ATTACHMENT_ERASURE_PAGE_SIZE = 5;
const IMPORT_SOURCE_TAG = /^[a-z0-9._-]{2,80}$/;
type CountKey = keyof PrivacyErasureCounts;
type Job = {
  agentId: string;
  generation: string;
  status: 'active' | 'content-erased' | 'complete';
  counts: PrivacyErasureCounts;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function importSourceKeyId(agentId: string, source: string): string {
  return sha256(`${agentId}\0${source}`);
}

function importDeletionJobId(agentId: string, source: string): string {
  return sha256(`import-delete\0${agentId}\0${source}`);
}

function importCleanupId(agentId: string, sourceId: string, path: string): string {
  return `privacy-import:${sha256(`${agentId}\0${sourceId}\0${path}`)}`;
}

function validImportSourcePath(path: unknown): path is string {
  if (
    typeof path !== 'string' ||
    !path.startsWith('import/') ||
    path.startsWith('/') ||
    path.includes('\\')
  )
    return false;
  const parts = path.split('/');
  return !parts.some((part) => !part || part === '.' || part === '..');
}

function validImportSnapshotPath(path: unknown, source: string, taskId: string): path is string {
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\')) return false;
  const parts = path.split('/');
  const prefix = `.assistant/imports/${source}/${taskId}/`;
  return (
    path.startsWith(prefix) &&
    !parts.some((part) => !part || part === '.' || part === '..') &&
    /^(?:manifest\.json|windows-\d{6}\.json)$/.test(path.slice(prefix.length))
  );
}

export function privacyErasureIsActive(status: unknown): boolean {
  // A malformed durable fence must never re-enable recall or writes.
  return status !== 'complete';
}

/** Check the erasure write fence inside the same transaction as an owner mutation. */
export async function assertPrivacyErasureInactiveInTransaction(
  tx: Transaction,
  store: InstallationStore,
  agentId: string,
): Promise<void> {
  const job = await tx.get(store.doc('privacyErasureJobs', agentId));
  if (job.exists && (job.get('agentId') !== agentId || privacyErasureIsActive(job.get('status'))))
    throw new Error('Privacy erasure is in progress');
}

/** Exact commit token; completed erasure still invalidates older source work. */
export function privacyErasureGeneration(
  snapshot: DocumentSnapshot,
  agentId: string,
): string | null {
  if (!snapshot.exists) return null;
  if (
    snapshot.get('agentId') !== agentId ||
    privacyErasureIsActive(snapshot.get('status')) ||
    !snapshot.updateTime
  )
    throw new Error('Privacy erasure is in progress');
  return `${snapshot.updateTime.seconds}:${snapshot.updateTime.nanoseconds}`;
}

export async function assertPrivacyErasureGenerationInTransaction(
  tx: Transaction,
  store: InstallationStore,
  agentId: string,
  observed: string | null,
): Promise<void> {
  const current = privacyErasureGeneration(
    await tx.get(store.doc('privacyErasureJobs', agentId)),
    agentId,
  );
  if (current !== observed)
    throw new Error('Privacy erasure changed during memory source observation');
}

/** Read-side token: a completed erasure must still invalidate a read started before it. */
export async function readPrivacyErasureFence(
  store: InstallationStore,
  agentId: string,
): Promise<Timestamp | null> {
  const job = await store.doc('privacyErasureJobs', agentId).get();
  if (!job.exists) return null;
  if (
    job.get('agentId') !== agentId ||
    privacyErasureIsActive(job.get('status')) ||
    !job.updateTime
  )
    throw new Error('Privacy erasure is in progress');
  return job.updateTime;
}

export async function assertPrivacyErasureFenceUnchanged(
  store: InstallationStore,
  agentId: string,
  before: Timestamp | null,
): Promise<void> {
  const after = await readPrivacyErasureFence(store, agentId);
  if (before === null ? after !== null : !after?.isEqual(before))
    throw new Error('Privacy erasure changed during read');
}

function validJob(job: Job): boolean {
  return (
    typeof job.generation === 'string' &&
    !!job.generation &&
    ['active', 'content-erased', 'complete'].includes(job.status) &&
    [
      job.counts?.memories,
      job.counts?.graphRelations,
      job.counts?.writingSamples,
      job.counts?.securityIncidents ?? 0,
    ].every((count) => Number.isSafeInteger(count) && count >= 0)
  );
}

/** Each page is transactional; an incomplete job stays fenced and restarts from remaining rows. */
export class FirestorePrivacyErasureRepository implements PrivacyErasureRepository {
  readonly kind = 'privacy-erasure-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId?: string,
  ) {}

  private async soleOwner(): Promise<string> {
    const snapshot = await this.store.collection('agents').limit(2).get();
    const doc = snapshot.docs[0];
    const id = doc?.get('id');
    if (
      snapshot.size !== 1 ||
      !doc ||
      typeof id !== 'string' ||
      !id ||
      documentKey(id) !== doc.id ||
      (this.configuredAgentId !== undefined && id !== this.configuredAgentId)
    )
      throw new Error('Privacy erasure requires exactly one configured owner');
    return id;
  }

  private async begin(agentId: string): Promise<Job> {
    const jobRef = this.store.doc('privacyErasureJobs', agentId);
    const cardRef = this.store.doc('ownerCards', agentId);
    return this.store.db.runTransaction(async (tx) => {
      const ownerQuery = await tx.get(this.store.collection('agents').limit(2));
      if (
        ownerQuery.size !== 1 ||
        ownerQuery.docs[0]?.get('id') !== agentId ||
        documentKey(agentId) !== ownerQuery.docs[0]?.id
      )
        throw new Error('Privacy erasure owner changed');
      const [jobSnapshot, card] = await tx.getAll(jobRef, cardRef);
      if (card?.exists && card.get('agentId') !== agentId)
        throw new Error('Owner card belongs to another agent');
      const current = jobSnapshot?.exists ? decodeRecord<Job>(jobSnapshot.data()) : null;
      if (current && current.agentId !== agentId)
        throw new Error('Privacy erasure job owner mismatch');
      if (current && !validJob(current)) throw new Error('Privacy erasure job is malformed');
      const job: Job =
        current && privacyErasureIsActive(current.status)
          ? { ...current, status: 'active' }
          : {
              agentId,
              generation: randomUUID(),
              status: 'active',
              counts: { memories: 0, graphRelations: 0, writingSamples: 0, securityIncidents: 0 },
            };
      const now = this.store.now();
      tx.set(jobRef, encodeRecord({ ...job, updatedAt: now }));
      tx.set(cardRef, encodeRecord({ agentId, content: '', compiledAt: now, invalidatedAt: now }));
      return job;
    });
  }

  private async activeJob(tx: Transaction, agentId: string, generation: string) {
    const ref = this.store.doc('privacyErasureJobs', agentId);
    const snapshot = await tx.get(ref);
    if (
      !snapshot.exists ||
      snapshot.get('agentId') !== agentId ||
      snapshot.get('generation') !== generation ||
      snapshot.get('status') !== 'active'
    )
      throw new Error('Privacy erasure fence changed');
    return ref;
  }

  private async deleteOwned(
    agentId: string,
    generation: string,
    collection: string,
    countKey?: CountKey,
  ): Promise<void> {
    for (;;) {
      const removed = await this.store.db.runTransaction(async (tx) => {
        const jobRef = await this.activeJob(tx, agentId, generation);
        const page = await tx.get(
          this.store.collection(collection).where('agentId', '==', agentId).limit(PAGE_SIZE),
        );
        for (const doc of page.docs) {
          if (
            doc.get('agentId') !== agentId ||
            typeof doc.get('id') !== 'string' ||
            documentKey(doc.get('id')) !== doc.id
          )
            throw new Error(`${collection} document ownership or identity mismatch`);
          tx.delete(doc.ref);
        }
        if (countKey && page.size)
          tx.update(jobRef, { [`counts.${countKey}`]: FieldValue.increment(page.size) });
        return page.size;
      });
      if (removed === 0) return;
    }
  }

  private async eraseMemories(agentId: string, generation: string): Promise<void> {
    for (;;) {
      const removed = await this.store.db.runTransaction(async (tx) => {
        const jobRef = await this.activeJob(tx, agentId, generation);
        const page = await tx.get(
          this.store.collection('memories').where('agentId', '==', agentId).limit(PAGE_SIZE),
        );
        const refs = page.docs.flatMap((doc) => {
          const hash = doc.get('contentHash');
          const id = doc.get('id');
          if (
            doc.get('agentId') !== agentId ||
            typeof id !== 'string' ||
            documentKey(id) !== doc.id ||
            typeof hash !== 'string' ||
            !hash
          )
            throw new Error('Memory document ownership or identity mismatch');
          return [
            this.store.doc('memoryContentHashes', hash),
            this.store.doc('memoryTombstones', hash),
            this.store.doc('knowledgeGraphSources', id),
            this.store.doc('graphDeletionIntents', id),
          ];
        });
        const related = refs.length ? await tx.getAll(...refs) : [];
        for (let index = 0; index < page.docs.length; index += 1) {
          const doc = page.docs[index];
          if (!doc) continue;
          const id = String(doc.get('id'));
          const hash = String(doc.get('contentHash'));
          const [hashDoc, tombstone, source, intent] = related.slice(index * 4, index * 4 + 4);
          if (hashDoc?.exists && hashDoc.get('memoryId') !== id)
            throw new Error('Memory hash points to another record');
          if (source?.exists && source.get('memoryId') !== id)
            throw new Error('Graph source points to another memory');
          if (
            intent?.exists &&
            (intent.get('memoryId') !== id || intent.get('agentId') !== agentId)
          )
            throw new Error('Graph deletion intent belongs to another owner');
          if (!tombstone?.exists)
            tx.create(this.store.doc('memoryTombstones', hash), {
              id: hash,
              contentHash: hash,
              reason: 'owner_forget',
              createdAt: this.store.now(),
            });
          if (hashDoc?.exists) tx.delete(hashDoc.ref);
          if (source?.exists) tx.delete(source.ref);
          if (intent?.exists) tx.delete(intent.ref);
          tx.delete(doc.ref);
        }
        if (page.size) tx.update(jobRef, { 'counts.memories': FieldValue.increment(page.size) });
        return page.size;
      });
      if (removed === 0) return;
    }
  }

  /**
   * Erase imported source-unit provenance before deleting its target rows. New
   * lineage records carry agentId; legacy records are attributed only through
   * their still-present, owner-validated memory/occasion target.
   */
  private async eraseImportLineage(
    agentId: string,
    generation: string,
    collection: 'memoryImportLineage' | 'occasionImportLineage',
    targetField: 'memoryId' | 'occasionId',
    targetCollection: 'memories' | 'occasions',
  ): Promise<void> {
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      const page = await this.store.db.runTransaction(async (tx) => {
        await this.activeJob(tx, agentId, generation);
        let query: Query = this.store
          .collection(collection)
          .orderBy(FieldPath.documentId())
          .limit(PAGE_SIZE);
        if (cursor) query = query.startAfter(cursor);
        const snapshot = await tx.get(query);
        const identities = snapshot.docs.map((doc) => {
          const source = doc.get('source');
          const targetId = doc.get(targetField);
          if (
            typeof source !== 'string' ||
            !source ||
            typeof targetId !== 'string' ||
            !targetId ||
            doc.id !==
              documentKey(
                createHash('sha256')
                  .update(JSON.stringify([source, targetId]))
                  .digest('hex'),
              )
          )
            throw new Error(`${collection} source lineage identity mismatch`);
          return {
            doc,
            source,
            targetId,
            owner: doc.get('agentId'),
            targetRef: this.store.doc(targetCollection, targetId),
          };
        });
        const targets = identities.length
          ? await tx.getAll(...identities.map((entry) => entry.targetRef))
          : [];
        for (let index = 0; index < identities.length; index += 1) {
          const entry = identities[index];
          const target = targets[index];
          if (!entry || !target) continue;
          const targetOwned =
            target.exists &&
            target.get('agentId') === agentId &&
            target.get('id') === entry.targetId &&
            documentKey(entry.targetId) === target.id;
          if (entry.owner != null && (typeof entry.owner !== 'string' || !entry.owner.trim()))
            throw new Error(`${collection} owner identity is malformed`);
          if (entry.owner === agentId && target?.exists && !targetOwned)
            throw new Error(`${collection} target identity disagrees with its owner`);
          if (typeof entry.owner === 'string' && entry.owner !== agentId && targetOwned)
            throw new Error(`${collection} owner disagrees with its target`);
          if (entry.owner === agentId || (entry.owner == null && targetOwned))
            tx.delete(entry.doc.ref);
        }
        return snapshot;
      });
      if (page.size < PAGE_SIZE) return;
      cursor = page.docs.at(-1);
    }
  }

  private async eraseOccasions(agentId: string, generation: string): Promise<void> {
    for (;;) {
      const removed = await this.store.db.runTransaction(async (tx) => {
        const jobRef = await this.activeJob(tx, agentId, generation);
        const page = await tx.get(
          this.store.collection('occasions').where('agentId', '==', agentId).limit(PAGE_SIZE),
        );
        for (const doc of page.docs) {
          if (
            doc.get('agentId') !== agentId ||
            typeof doc.get('id') !== 'string' ||
            documentKey(doc.get('id')) !== doc.id
          )
            throw new Error('Occasion ownership or identity mismatch');
          tx.delete(doc.ref);
        }
        if (page.size) tx.update(jobRef, { updatedAt: this.store.now() });
        return page.size;
      });
      if (removed === 0) return;
    }
  }

  private async eraseSecurityEvidence(agentId: string, generation: string): Promise<void> {
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      const page = await this.store.db.runTransaction(async (tx) => {
        await this.activeJob(tx, agentId, generation);
        let query: Query = this.store
          .collection('emailIngest')
          .where('agentId', '==', agentId)
          .orderBy(FieldPath.documentId())
          .limit(PAGE_SIZE);
        if (cursor) query = query.startAfter(cursor);
        const snapshot = await tx.get(query);
        for (const doc of snapshot.docs) {
          if (
            doc.get('agentId') !== agentId ||
            typeof doc.get('id') !== 'string' ||
            documentKey(doc.get('id')) !== doc.id
          )
            throw new Error('Security evidence ownership or identity mismatch');
          if (
            doc.get('securityEvidence') != null ||
            doc.get('securityIncidentId') != null ||
            doc.get('preparedExtraction') != null ||
            doc.get('emailContentProvenance') != null ||
            doc.get('directRouting') != null ||
            doc.get('directRecoveryReason') != null ||
            doc.get('preparedClassification') != null ||
            doc.get('classificationClaimToken') != null
          )
            tx.update(doc.ref, {
              securityEvidence: null,
              securityIncidentId: null,
              preparedExtraction: null,
              emailContentProvenance: null,
              directRouting: null,
              directRecoveryReason: null,
              preparedClassification: null,
              classificationClaimToken: null,
              classificationStatus:
                doc.get('classificationStatus') === 'in_progress'
                  ? 'unknown'
                  : (doc.get('classificationStatus') ?? 'not_required'),
            });
        }
        return snapshot;
      });
      if (page.size === 0) return;
      cursor = page.docs.at(-1);
      if (page.size < PAGE_SIZE) return;
    }
  }

  private async eraseEmailObservers(agentId: string, generation: string): Promise<void> {
    let workCursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      const page = await this.store.db.runTransaction(async (tx) => {
        await this.activeJob(tx, agentId, generation);
        let query: Query = this.store
          .collection('emailObserverWork')
          .where('agentId', '==', agentId)
          .orderBy(FieldPath.documentId())
          .limit(PAGE_SIZE);
        if (workCursor) query = query.startAfter(workCursor);
        const rows = await tx.get(query);
        for (const doc of rows.docs) {
          const row = decodeRecord<Records['emailObserverWork']>(doc.data());
          if (
            row.agentId !== agentId ||
            typeof row.id !== 'string' ||
            documentKey(row.id) !== doc.id
          )
            throw new Error('Email observer work ownership or identity mismatch');
          const status =
            row.status === 'pending' || row.status === 'retryable_failed'
              ? 'skipped_erased'
              : row.status === 'claimed' || row.status === 'prepared'
                ? 'unknown'
                : row.status;
          tx.update(
            doc.ref,
            encodeRecord({
              status,
              privacyGeneration: generation,
              preparedResult: null,
              deliveryKey: null,
              claimToken: null,
              leaseExpiresAt: null,
              lastErrorCode: 'privacy_erased',
              updatedAt: this.store.now(),
            }),
          );
        }
        return rows;
      });
      if (page.size === 0) break;
      for (const doc of page.docs) {
        const row = decodeRecord<Records['emailObserverWork']>(doc.data());
        await this.eraseEmailObserverNotices(agentId, generation, row.id);
      }
      workCursor = page.docs.at(-1);
      if (page.size < PAGE_SIZE) break;
    }
    for (;;) {
      const removed = await this.store.db.runTransaction(async (tx) => {
        await this.activeJob(tx, agentId, generation);
        const page = await tx.get(
          this.store
            .collection('emailObserverSources')
            .where('agentId', '==', agentId)
            .limit(PAGE_SIZE),
        );
        for (const doc of page.docs) {
          const row = decodeRecord<Records['emailObserverSources']>(doc.data());
          if (
            row.agentId !== agentId ||
            typeof row.id !== 'string' ||
            documentKey(row.id) !== doc.id
          )
            throw new Error('Email observer source ownership or identity mismatch');
          tx.delete(doc.ref);
        }
        return page.size;
      });
      if (removed === 0) break;
    }
  }

  private async eraseEmailAttachmentCustodies(agentId: string, generation: string): Promise<void> {
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      const page = await this.store.db.runTransaction(async (tx) => {
        await this.activeJob(tx, agentId, generation);
        let query: Query = this.store
          .collection('emailAttachmentCustodies')
          .where('agentId', '==', agentId)
          .orderBy(FieldPath.documentId())
          .limit(ATTACHMENT_ERASURE_PAGE_SIZE);
        if (cursor) query = query.startAfter(cursor);
        return tx.get(query);
      });
      if (!page.size) return;

      for (const custodyDoc of page.docs) {
        const initial = decodeRecord<Records['emailAttachmentCustodies']>(custodyDoc.data());
        if (
          initial.agentId !== agentId ||
          typeof initial.id !== 'string' ||
          documentKey(initial.id) !== custodyDoc.id ||
          initial.workspacePath !== `email-attachments/custody/${initial.id}`
        )
          throw new Error('Email attachment custody ownership or path mismatch');

        if (initial.documentId) {
          for (;;) {
            const removed = await this.store.db.runTransaction(async (tx) => {
              await this.activeJob(tx, agentId, generation);
              const chunks = await tx.get(
                this.store
                  .collection('documentChunks')
                  .where('documentId', '==', initial.documentId)
                  .limit(400),
              );
              for (const chunk of chunks.docs) {
                if (
                  chunk.get('agentId') !== agentId ||
                  chunk.get('documentId') !== initial.documentId
                )
                  throw new Error('Email attachment chunks belong to another owner');
                tx.delete(chunk.ref);
              }
              return chunks.size;
            });
            if (removed < 400) break;
          }
        }

        await this.store.db.runTransaction(async (tx) => {
          const jobRef = await this.activeJob(tx, agentId, generation);
          const custodyRef = this.store.doc('emailAttachmentCustodies', initial.id);
          const current = await tx.get(custodyRef);
          if (
            !current.exists ||
            current.get('agentId') !== agentId ||
            current.get('id') !== initial.id
          )
            throw new Error('Email attachment custody changed during privacy erasure');
          const row = decodeRecord<Records['emailAttachmentCustodies']>(current.data());
          const documentId = typeof row.documentId === 'string' ? row.documentId : null;
          const fileRef = row.fileId ? this.store.doc('files', row.fileId) : null;
          const documentRef = documentId ? this.store.doc('documents', documentId) : null;
          const dedupRef =
            documentId && row.sha256
              ? this.store.doc(
                  'documentDedupKeys',
                  createHash('sha256').update(`${agentId}\0${row.sha256}`).digest('hex'),
                )
              : null;
          const indexQuery = this.store
            .collection('emailAttachmentCustodyKeys')
            .where('agentId', '==', agentId)
            .where('custodyId', '==', row.id)
            .limit(2);
          const docTaskQuery = documentId
            ? this.store
                .collection('tasks')
                .where('agentId', '==', agentId)
                .where('trigger.payload.documentId', '==', documentId)
                .limit(51)
            : null;
          const refs = [
            ...(fileRef ? [fileRef] : []),
            ...(documentRef ? [documentRef] : []),
            ...(dedupRef ? [dedupRef] : []),
          ];
          const snapshots = refs.length ? await tx.getAll(...refs) : [];
          const [file, document, dedup] = snapshots;
          const indexes = await tx.get(indexQuery);
          const tasks = docTaskQuery ? await tx.get(docTaskQuery) : null;
          if (indexes.size > 1) throw new Error('Email attachment source index is not unique');
          const index = indexes.docs[0];
          if (
            index &&
            (index.get('agentId') !== agentId ||
              index.get('custodyId') !== row.id ||
              index.get('id') !== index.id)
          )
            throw new Error('Email attachment source index ownership mismatch');
          if (tasks && tasks.size > 50)
            throw new Error('Email attachment document tasks exceed the erasure bound');
          if (
            fileRef &&
            file?.exists &&
            (file.get('agentId') !== agentId || file.get('id') !== row.fileId)
          )
            throw new Error('Email attachment file ownership mismatch');
          if (
            documentRef &&
            document?.exists &&
            (document.get('agentId') !== agentId || document.get('id') !== row.documentId)
          )
            throw new Error('Email attachment document ownership mismatch');
          if (dedupRef && dedup?.exists && dedup.get('documentId') !== row.documentId)
            throw new Error('Email attachment deduplication claim changed');

          const now = this.store.now();
          const attachmentGenerations = [
            ...(row.markerGeneration
              ? [{ generation: row.markerGeneration, objectState: 'marker' as const }]
              : []),
            ...(row.objectGeneration
              ? [{ generation: row.objectGeneration, objectState: 'content' as const }]
              : []),
          ].filter(
            (item, index, values) =>
              values.findIndex((candidate) => candidate.generation === item.generation) === index,
          );
          const cleanupAssets = attachmentGenerations.map((item) => {
            const id = emailAttachmentCustodyCleanupIntentId(row.id, item.generation);
            return {
              id,
              generation: item.generation,
              objectState: item.objectState,
              ref: this.store.doc('privacyErasureAssets', id),
            };
          });
          const documentPaths =
            document?.exists && documentId
              ? new Set([
                  `documents/${documentId}/extracted.txt`,
                  ...(typeof document.get('processedTextPath') === 'string' &&
                  document.get('processedTextPath')
                    ? [String(document.get('processedTextPath'))]
                    : []),
                ])
              : new Set<string>();
          const documentAssets = [...documentPaths].map((workspacePath) => {
            const assetId = `document-delete:${row.documentId}:${sha256(workspacePath)}`;
            return {
              assetId,
              workspacePath,
              ref: this.store.doc('privacyErasureAssets', assetId),
            };
          });
          const supplementalRefs = [
            ...cleanupAssets.map((asset) => asset.ref),
            ...documentAssets.map((asset) => asset.ref),
          ];
          const supplemental = supplementalRefs.length ? await tx.getAll(...supplementalRefs) : [];
          for (let cleanupIndex = 0; cleanupIndex < cleanupAssets.length; cleanupIndex += 1) {
            const cleanup = cleanupAssets[cleanupIndex];
            const existing = supplemental[cleanupIndex];
            if (
              !cleanup ||
              (existing?.exists &&
                (existing.get('agentId') !== agentId ||
                  existing.get('sourceId') !== cleanup.id ||
                  existing.get('custodyId') !== row.id ||
                  existing.get('generation') !== cleanup.generation ||
                  existing.get('objectState') !== cleanup.objectState ||
                  existing.get('workspacePath') !== row.workspacePath))
            )
              throw new Error('Email attachment cleanup identity collision');
          }
          const assetOffset = cleanupAssets.length;
          for (let assetIndex = 0; assetIndex < documentAssets.length; assetIndex += 1) {
            const asset = documentAssets[assetIndex];
            const existingAsset = supplemental[assetOffset + assetIndex];
            if (!asset) continue;
            if (
              existingAsset?.exists &&
              (existingAsset.get('agentId') !== agentId ||
                existingAsset.get('sourceId') !== asset.assetId ||
                existingAsset.get('documentId') !== row.documentId ||
                existingAsset.get('workspacePath') !== asset.workspacePath)
            )
              throw new Error('Email attachment document cleanup identity mismatch');
          }

          for (let cleanupIndex = 0; cleanupIndex < cleanupAssets.length; cleanupIndex += 1) {
            const cleanup = cleanupAssets[cleanupIndex];
            if (!cleanup || supplemental[cleanupIndex]?.exists) continue;
            tx.create(cleanup.ref, {
              id: cleanup.id,
              sourceId: cleanup.id,
              kind: 'email_attachment_custody',
              agentId,
              workspacePath: row.workspacePath,
              ...(row.documentId ? { documentId: row.documentId } : {}),
              custodyId: row.id,
              generation: cleanup.generation,
              objectState: cleanup.objectState,
              createdAt: now,
            });
          }
          for (let assetIndex = 0; assetIndex < documentAssets.length; assetIndex += 1) {
            const asset = documentAssets[assetIndex];
            if (!asset) continue;
            if (supplemental[assetOffset + assetIndex]?.exists) continue;
            tx.create(asset.ref, {
              id: asset.assetId,
              sourceId: asset.assetId,
              agentId,
              documentId,
              workspacePath: asset.workspacePath,
              createdAt: now,
            });
          }
          if (document?.exists && documentId) {
            const processorTokenHash = document.get('processorTokenHash');
            if (typeof processorTokenHash === 'string' && processorTokenHash) {
              const outputPath = `documents/${documentId}/extracted.txt`;
              tx.set(this.store.doc('documentDeletionTombstones', documentId), {
                agentId,
                documentId,
                processorTokenHash,
                outputPath,
                createdAt: now,
              });
              const workerAssetId = `document-delete-worker:${documentId}`;
              tx.set(this.store.doc('privacyErasureAssets', workerAssetId), {
                id: workerAssetId,
                sourceId: workerAssetId,
                documentId,
                agentId,
                workspacePath: outputPath,
                workerPending: true,
                createdAt: now,
              });
            }
          }
          for (const task of tasks?.docs ?? []) {
            if (task.get('agentId') !== agentId)
              throw new Error('Email attachment document task belongs to another owner');
            const jobName = task.get('trigger')?.payload?.job;
            if (
              ['documents.extract', 'documents.process'].includes(String(jobName)) &&
              ['pending', 'sleeping', 'running', 'needs_attention'].includes(
                String(task.get('status')),
              )
            )
              tx.update(task.ref, {
                status: 'cancelled',
                lockedUntil: null,
                leaseToken: null,
                runAfter: null,
                updatedAt: now,
              });
          }
          if (file?.exists) tx.delete(file.ref);
          if (document?.exists) tx.delete(document.ref);
          if (dedup?.exists) tx.delete(dedup.ref);
          if (index) tx.delete(index.ref);
          tx.update(custodyRef, {
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
            updatedAt: now,
          });
          tx.update(jobRef, { updatedAt: now });
        });
      }
      cursor = page.docs.at(-1);
      if (page.size < ATTACHMENT_ERASURE_PAGE_SIZE) return;
    }
  }

  /**
   * Remove dashboard messages emitted by one observer while the erasure job
   * still fences owner writes. Each bounded outbox page, channel-id mapping,
   * and raw message document is read and deleted in one transaction.
   */
  private async eraseEmailObserverNotices(
    agentId: string,
    generation: string,
    workId: string,
  ): Promise<void> {
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      const page = await this.store.db.runTransaction(async (tx) => {
        await this.activeJob(tx, agentId, generation);
        const workSnapshot = await tx.get(this.store.doc('emailObserverWork', workId));
        if (!workSnapshot.exists)
          throw new Error('Email observer notice erasure lost its work row');
        const work = decodeRecord<Records['emailObserverWork']>(workSnapshot.data());
        if (
          work.id !== workId ||
          documentKey(work.id) !== workSnapshot.id ||
          work.agentId !== agentId
        )
          throw new Error('Email observer notice erasure found a cross-owner work row');
        let query: Query = this.store
          .collection('notificationOutbox')
          .where('producerWorkId', '==', workId)
          .orderBy(FieldPath.documentId())
          .limit(PAGE_SIZE);
        if (cursor) query = query.startAfter(cursor);
        const outboxPage = await tx.get(query);
        const outbox = outboxPage.docs.map((doc) => ({
          doc,
          row: decodeRecord<Records['notificationOutbox']>(doc.data()),
        }));
        for (const { doc, row } of outbox) {
          if (
            documentKey(row.id) !== doc.id ||
            row.agentId !== agentId ||
            row.producerWorkId !== workId ||
            !row.deliveryKey ||
            !row.legKey
          )
            throw new Error('Email observer notice outbox ownership or identity mismatch');
        }
        const dashboardRows = outbox.filter(({ row }) => row.adapter === 'dashboard');
        const channelIds = dashboardRows.map(({ row }) =>
          notificationDashboardMessageId(agentId, row.deliveryKey, row.legKey),
        );
        const channelRefs = channelIds.map((id) => this.store.doc('messageChannelIds', id));
        const channelRows = channelRefs.length ? await tx.getAll(...channelRefs) : [];
        const matchingMessageQueries = await Promise.all(
          channelIds.map((id) =>
            tx.get(this.store.collection('messages').where('channelMessageId', '==', id).limit(2)),
          ),
        );
        const messages = matchingMessageQueries.flatMap((snapshot, index) => {
          if (snapshot.size > 1)
            throw new Error('Email observer dashboard identity maps to multiple messages');
          const channelId = channelIds[index];
          if (!channelId) throw new Error('Email observer dashboard identity is missing');
          return snapshot.docs.map((doc) => ({ channelId, doc }));
        });
        const conversationsById = new Map<string, FirebaseFirestore.DocumentReference>();
        for (const { doc } of messages) {
          const conversationId = doc.get('conversationId');
          if (typeof conversationId !== 'string' || !conversationId)
            throw new Error('Email observer dashboard message has no conversation identity');
          conversationsById.set(conversationId, this.store.doc('conversations', conversationId));
        }
        for (const channel of channelRows) {
          if (!channel?.exists) continue;
          const conversationId = channel.get('conversationId');
          if (typeof conversationId !== 'string' || !conversationId)
            throw new Error(
              'Email observer dashboard channel mapping has no conversation identity',
            );
          conversationsById.set(conversationId, this.store.doc('conversations', conversationId));
        }
        const conversations = conversationsById.size
          ? await tx.getAll(...conversationsById.values())
          : [];
        const ownerByConversation = new Map<string, string | undefined>();
        for (const [id, ref] of conversationsById) {
          const snapshot = conversations.find((candidate) => candidate.ref.path === ref.path);
          ownerByConversation.set(id, snapshot?.get('agentId'));
        }
        for (let index = 0; index < channelRows.length; index++) {
          const channel = channelRows[index];
          if (!channel) throw new Error('Email observer dashboard channel mapping is missing');
          const matching = messages.find(({ channelId }) => channelId === channelIds[index]);
          if (!channel.exists) continue;
          const messageId = channel.get('messageId');
          const conversationId = channel.get('conversationId');
          if (typeof messageId !== 'string' || typeof conversationId !== 'string')
            throw new Error('Email observer dashboard channel mapping is malformed');
          if (
            matching &&
            (matching.doc.id !== documentKey(messageId) ||
              matching.doc.get('conversationId') !== conversationId)
          )
            throw new Error('Email observer dashboard raw message mapping is inconsistent');
          if (ownerByConversation.get(conversationId) !== agentId)
            throw new Error(
              'Email observer dashboard notice points outside its owner conversation',
            );
        }
        for (const { doc } of messages) {
          const row = decodeRecord<Records['messages']>(doc.data());
          if (
            documentKey(row.id) !== doc.id ||
            row.channelMessageId !== messages.find((item) => item.doc.id === doc.id)?.channelId ||
            ownerByConversation.get(row.conversationId) !== agentId
          )
            throw new Error('Email observer dashboard message ownership or identity mismatch');
        }
        const now = this.store.now();
        for (const { doc, row } of outbox) {
          const status =
            row.status === 'sending'
              ? 'unknown'
              : row.status === 'pending' || row.status === 'failed'
                ? 'skipped'
                : row.status;
          tx.update(
            doc.ref,
            encodeRecord({
              status,
              retryable: false,
              destination: null,
              payload: null,
              leaseToken: null,
              leaseUntil: null,
              result: null,
              finishedAt: row.finishedAt ?? now,
              updatedAt: now,
            }),
          );
        }
        for (const channel of channelRows) if (channel.exists) tx.delete(channel.ref);
        for (const { doc } of messages) tx.delete(doc.ref);
        return { last: outboxPage.docs.at(-1), size: outboxPage.size };
      });
      if (!page.last || page.size === 0) return;
      cursor = page.last;
      if (page.size < PAGE_SIZE) return;
    }
  }

  private async eraseImports(agentId: string, generation: string): Promise<void> {
    for (;;) {
      const removed = await this.store.db.runTransaction(async (tx) => {
        await this.activeJob(tx, agentId, generation);
        const page = await tx.get(
          this.store.collection('importSources').where('agentId', '==', agentId).limit(1),
        );
        const doc = page.docs[0];
        if (!doc) return 0;
        const id = doc.get('id');
        const path = doc.get('workspacePath');
        const source = doc.get('source');
        const taskId = doc.get('taskId');
        if (
          doc.get('agentId') !== agentId ||
          typeof id !== 'string' ||
          documentKey(id) !== doc.id ||
          typeof source !== 'string' ||
          !/^[a-z0-9._-]{2,80}$/.test(source) ||
          typeof path !== 'string' ||
          !validImportSourcePath(path) ||
          (taskId !== null && taskId !== undefined && typeof taskId !== 'string')
        )
          throw new Error('Import ownership, identity, or path mismatch');

        const snapshots = await tx.get(
          this.store
            .collection('importSnapshotAssets')
            .where('sourceId', '==', id)
            .limit(PAGE_SIZE),
        );
        if (snapshots.size) {
          const parsed = snapshots.docs.map((asset) => {
            const assetId = asset.get('id');
            const owner = asset.get('agentId');
            const assetSource = asset.get('source');
            const assetTask = asset.get('taskId');
            const assetPath = asset.get('workspacePath');
            if (
              owner !== agentId ||
              typeof assetId !== 'string' ||
              documentKey(assetId) !== asset.id ||
              asset.get('sourceId') !== id ||
              assetSource !== source ||
              typeof assetTask !== 'string' ||
              !validImportSnapshotPath(assetPath, source, assetTask)
            )
              throw new Error('Import snapshot ownership, identity, or path mismatch');
            const cleanupId = importCleanupId(agentId, id, assetPath);
            return {
              asset,
              ref: this.store.doc('privacyErasureAssets', cleanupId),
              cleanupId,
              workspacePath: assetPath,
              taskId: assetTask,
            };
          });
          const priorAssets = await tx.getAll(...parsed.map((entry) => entry.ref));
          for (let index = 0; index < parsed.length; index += 1) {
            const entry = parsed[index];
            const prior = priorAssets[index];
            if (!entry) continue;
            if (
              prior?.exists &&
              (prior.get('agentId') !== agentId ||
                prior.get('id') !== entry.cleanupId ||
                prior.get('workspacePath') !== entry.workspacePath)
            )
              throw new Error('Import snapshot cleanup identity mismatch');
            if (!prior?.exists)
              tx.create(entry.ref, {
                id: entry.cleanupId,
                sourceId: entry.cleanupId,
                agentId,
                assetKind: 'snapshot',
                taskId: entry.taskId,
                workspacePath: entry.workspacePath,
                createdAt: this.store.now(),
              });
            tx.delete(entry.asset.ref);
          }
          return snapshots.size;
        }

        const [task, existingAsset, claim, deletion] = await Promise.all([
          typeof taskId === 'string' && taskId ? tx.get(this.store.doc('tasks', taskId)) : null,
          tx.get(this.store.doc('privacyErasureAssets', importCleanupId(agentId, id, path))),
          tx.get(this.store.doc('importSourceKeys', importSourceKeyId(agentId, source))),
          tx.get(this.store.doc('importSourceDeletionJobs', importDeletionJobId(agentId, source))),
        ]);
        if (task?.exists) {
          if (task.get('agentId') !== agentId || task.get('id') !== taskId)
            throw new Error('Import task belongs to another agent');
          if (
            ['pending', 'sleeping', 'running', 'needs_attention'].includes(
              String(task.get('status')),
            )
          )
            tx.update(task.ref, {
              status: 'cancelled',
              lockedUntil: null,
              runAfter: null,
              updatedAt: this.store.now(),
            });
        }
        const cleanupId = importCleanupId(agentId, id, path);
        if (
          existingAsset?.exists &&
          (existingAsset.get('agentId') !== agentId ||
            existingAsset.get('id') !== cleanupId ||
            existingAsset.get('workspacePath') !== path)
        )
          throw new Error('Import source cleanup identity mismatch');
        if (!existingAsset?.exists)
          tx.create(this.store.doc('privacyErasureAssets', cleanupId), {
            id: cleanupId,
            sourceId: cleanupId,
            agentId,
            assetKind: 'source',
            workspacePath: path,
            createdAt: this.store.now(),
          });
        if (claim?.exists) {
          if (claim.get('agentId') !== agentId || claim.get('source') !== source)
            throw new Error('Import source claim belongs to another owner');
          tx.delete(claim.ref);
        }
        if (deletion?.exists) {
          if (
            deletion.get('agentId') !== agentId ||
            deletion.get('sourceHash') !== sha256(source) ||
            deletion.get('id') !== importDeletionJobId(agentId, source)
          )
            throw new Error('Import deletion receipt belongs to another owner');
          tx.delete(deletion.ref);
        }
        tx.delete(doc.ref);
        return 1;
      });
      if (removed === 0) return;
    }
  }

  private async eraseOrphanImportSnapshots(agentId: string, generation: string): Promise<void> {
    for (;;) {
      const removed = await this.store.db.runTransaction(async (tx) => {
        await this.activeJob(tx, agentId, generation);
        const page = await tx.get(
          this.store
            .collection('importSnapshotAssets')
            .where('agentId', '==', agentId)
            .limit(PAGE_SIZE),
        );
        if (!page.size) return 0;
        const entries = page.docs.map((doc) => {
          const id = doc.get('id');
          const sourceId = doc.get('sourceId');
          const source = doc.get('source');
          const taskId = doc.get('taskId');
          const path = doc.get('workspacePath');
          if (
            doc.get('agentId') !== agentId ||
            typeof id !== 'string' ||
            documentKey(id) !== doc.id ||
            typeof sourceId !== 'string' ||
            documentKey(sourceId).length === 0 ||
            typeof source !== 'string' ||
            !IMPORT_SOURCE_TAG.test(source) ||
            typeof taskId !== 'string' ||
            !validImportSnapshotPath(path, source, taskId)
          )
            throw new Error('Import snapshot ownership, identity, or path mismatch');
          const cleanupId = importCleanupId(agentId, sourceId, path);
          return {
            doc,
            ref: this.store.doc('privacyErasureAssets', cleanupId),
            cleanupId,
            path,
            taskId,
          };
        });
        const priorAssets = await tx.getAll(...entries.map((entry) => entry.ref));
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index];
          const prior = priorAssets[index];
          if (!entry) continue;
          if (
            prior?.exists &&
            (prior.get('agentId') !== agentId ||
              prior.get('id') !== entry.cleanupId ||
              prior.get('workspacePath') !== entry.path)
          )
            throw new Error('Import snapshot cleanup identity mismatch');
          if (!prior?.exists)
            tx.create(entry.ref, {
              id: entry.cleanupId,
              sourceId: entry.cleanupId,
              agentId,
              assetKind: 'snapshot',
              taskId: entry.taskId,
              workspacePath: entry.path,
              createdAt: this.store.now(),
            });
          tx.delete(entry.doc.ref);
        }
        return page.size;
      });
      if (!removed) return;
    }
  }

  private async eraseImportSourceKeys(agentId: string, generation: string): Promise<void> {
    for (;;) {
      const removed = await this.store.db.runTransaction(async (tx) => {
        await this.activeJob(tx, agentId, generation);
        const page = await tx.get(
          this.store
            .collection('importSourceKeys')
            .where('agentId', '==', agentId)
            .limit(PAGE_SIZE),
        );
        for (const doc of page.docs) {
          const source = doc.get('source');
          const sourceId = doc.get('sourceId');
          if (
            doc.get('agentId') !== agentId ||
            typeof source !== 'string' ||
            !IMPORT_SOURCE_TAG.test(source) ||
            typeof sourceId !== 'string' ||
            doc.id !== documentKey(importSourceKeyId(agentId, source))
          )
            throw new Error('Import source claim ownership or identity mismatch');
          tx.delete(doc.ref);
        }
        return page.size;
      });
      if (!removed) return;
    }
  }

  private async eraseSituationPacks(agentId: string, generation: string): Promise<void> {
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query: Query = this.store
        .collection('situationPacks')
        .where('agentId', '==', agentId)
        .orderBy(FieldPath.documentId())
        .limit(PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const pack of page.docs) {
        const id = pack.get('id');
        if (
          pack.get('agentId') !== agentId ||
          typeof id !== 'string' ||
          documentKey(id) !== pack.id
        )
          throw new Error('Situation pack ownership or identity mismatch');
        for (;;) {
          const removed = await this.store.db.runTransaction(async (tx) => {
            await this.activeJob(tx, agentId, generation);
            const current = await tx.get(pack.ref);
            if (!current.exists || current.get('agentId') !== agentId || current.get('id') !== id)
              throw new Error('Situation pack owner changed');
            const previews = await tx.get(
              this.store.collection('situationPreviews').where('packId', '==', id).limit(PAGE_SIZE),
            );
            for (const preview of previews.docs) {
              if (
                preview.get('packId') !== id ||
                typeof preview.get('id') !== 'string' ||
                documentKey(preview.get('id')) !== preview.id
              )
                throw new Error('Situation preview belongs to another pack');
              tx.delete(preview.ref);
            }
            return previews.size;
          });
          if (removed === 0) break;
        }
        await this.store.db.runTransaction(async (tx) => {
          await this.activeJob(tx, agentId, generation);
          const current = await tx.get(pack.ref);
          if (!current.exists || current.get('agentId') !== agentId || current.get('id') !== id)
            throw new Error('Situation pack owner changed');
          if (current.get('privacyErasureGeneration') === generation) return;
          const data = decodeRecord<Record<string, unknown>>(current.get('data'));
          if (!data || typeof data !== 'object' || Array.isArray(data))
            throw new Error('Invalid situation pack data');
          tx.update(pack.ref, {
            data: encodeRecord({ ...data, decisions: [] }),
            version: Number(current.get('version')) + 1,
            privacyErasureGeneration: generation,
            updatedAt: this.store.now(),
          });
        });
      }
      if (page.size < PAGE_SIZE) break;
      cursor = page.docs.at(-1);
    }
  }

  private async assertWritingSamplesOwned(agentId: string): Promise<void> {
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query: Query = this.store
        .collection('writingSamples')
        .orderBy(FieldPath.documentId())
        .limit(PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const id = doc.get('id');
        if (doc.get('agentId') !== agentId || typeof id !== 'string' || documentKey(id) !== doc.id)
          throw new Error('Writing sample ownership or identity mismatch');
      }
      if (page.size < PAGE_SIZE) return;
      cursor = page.docs.at(-1);
    }
  }

  private async eraseMissionReportText(agentId: string, generation: string): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
      const next = await this.store.db.runTransaction(async (tx) => {
        await this.activeJob(tx, agentId, generation);
        let query = this.store
          .collection('missionReports')
          .where('agentId', '==', agentId)
          .orderBy(FieldPath.documentId())
          .limit(PAGE_SIZE);
        if (cursor) query = query.startAfter(cursor);
        const page = await tx.get(query);
        for (const doc of page.docs) {
          if (
            doc.get('agentId') !== agentId ||
            typeof doc.get('id') !== 'string' ||
            documentKey(doc.get('id')) !== doc.id
          )
            throw new Error('Mission report ownership or identity mismatch');
          const patch: Record<string, unknown> = { text: '' };
          for (const key of ['chatStatus', 'ownerStatus', 'mirrorStatus']) {
            if (['pending', 'failed'].includes(doc.get(key))) patch[key] = 'skipped';
          }
          tx.update(doc.ref, patch);
        }
        return page.docs.at(-1)?.id ?? null;
      });
      if (!next) break;
      cursor = next;
    }
  }

  private async eraseNotificationOutbox(agentId: string, generation: string): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
      const next = await this.store.db.runTransaction(async (tx) => {
        await this.activeJob(tx, agentId, generation);
        let query = this.store
          .collection('notificationOutbox')
          .where('agentId', '==', agentId)
          .orderBy(FieldPath.documentId())
          .limit(PAGE_SIZE);
        if (cursor) query = query.startAfter(cursor);
        const page = await tx.get(query);
        const now = this.store.now();
        for (const doc of page.docs) {
          const id = doc.get('id');
          if (
            doc.get('agentId') !== agentId ||
            typeof id !== 'string' ||
            documentKey(id) !== doc.id
          )
            throw new Error('Notification outbox ownership or identity mismatch');
          const status = doc.get('status');
          const terminal = status === 'delivered' || status === 'unknown';
          tx.update(doc.ref, {
            destination: null,
            payload: null,
            status:
              status === 'sending'
                ? 'unknown'
                : status === 'pending' || status === 'failed'
                  ? 'skipped'
                  : status,
            retryable: false,
            leaseToken: null,
            leaseUntil: null,
            result: null,
            finishedAt: terminal && doc.get('finishedAt') ? doc.get('finishedAt') : now,
            updatedAt: now,
          });
        }
        return page.docs.at(-1)?.id ?? null;
      });
      if (!next) break;
      cursor = next;
    }
  }

  async erase(): Promise<PrivacyErasureCounts> {
    const agentId = await this.soleOwner();
    // Do not begin the durable erase fence until every sample has explicit,
    // matching ownership. Legacy installation-wide rows need a verified
    // owner backfill before any owner-scoped destructive operation can run.
    await this.assertWritingSamplesOwned(agentId);
    const job = await this.begin(agentId);
    await this.deleteOwned(agentId, job.generation, 'watchFireEffects');
    await this.deleteOwned(agentId, job.generation, 'watchFires');
    await this.eraseSecurityEvidence(agentId, job.generation);
    await this.eraseEmailAttachmentCustodies(agentId, job.generation);
    await this.eraseEmailObservers(agentId, job.generation);
    await this.deleteOwned(agentId, job.generation, 'securityIncidentAttention');
    await this.deleteOwned(agentId, job.generation, 'securityIncidentSources');
    await this.deleteOwned(agentId, job.generation, 'securityIncidents', 'securityIncidents');
    await this.eraseImports(agentId, job.generation);
    await this.eraseOrphanImportSnapshots(agentId, job.generation);
    await this.eraseImportSourceKeys(agentId, job.generation);
    await this.deleteOwned(agentId, job.generation, 'importSourceDeletionJobs');
    await this.deleteOwned(agentId, job.generation, 'toolCallReceipts');
    await this.deleteOwned(agentId, job.generation, 'toolCallReceiptKeys');
    await this.eraseSituationPacks(agentId, job.generation);
    await this.deleteOwned(agentId, job.generation, 'selfRepairIssues');
    await this.eraseMissionReportText(agentId, job.generation);
    await this.eraseNotificationOutbox(agentId, job.generation);
    await this.deleteOwned(agentId, job.generation, 'recallSurfaces');
    await this.deleteOwned(agentId, job.generation, 'memoryEmbeddingRefreshes');
    await this.deleteOwned(agentId, job.generation, 'memoryEmbeddingRefreshCursors');
    await this.deleteOwned(agentId, job.generation, 'preparedMemoryExtractions');
    await this.deleteOwned(agentId, job.generation, 'occasionDateKeys');
    await this.eraseImportLineage(
      agentId,
      job.generation,
      'memoryImportLineage',
      'memoryId',
      'memories',
    );
    await this.eraseImportLineage(
      agentId,
      job.generation,
      'occasionImportLineage',
      'occasionId',
      'occasions',
    );
    await this.eraseOccasions(agentId, job.generation);
    await this.deleteOwned(agentId, job.generation, 'knowledgeGraphAssertionEvidence');
    await this.deleteOwned(agentId, job.generation, 'knowledgeGraphAssertions');
    await this.deleteOwned(agentId, job.generation, 'knowledgeGraphRelations', 'graphRelations');
    await this.deleteOwned(agentId, job.generation, 'knowledgeGraphEntityAliases');
    await this.deleteOwned(agentId, job.generation, 'knowledgeGraphEntities');
    await this.eraseMemories(agentId, job.generation);
    for (;;) {
      const removed = await this.store.db.runTransaction(async (tx) => {
        const jobRef = await this.activeJob(tx, agentId, job.generation);
        const page = await tx.get(
          this.store.collection('writingSamples').where('agentId', '==', agentId).limit(PAGE_SIZE),
        );
        for (const doc of page.docs) {
          if (
            doc.get('agentId') !== agentId ||
            typeof doc.get('id') !== 'string' ||
            documentKey(doc.get('id')) !== doc.id
          )
            throw new Error('Writing sample ownership or identity mismatch');
          tx.delete(doc.ref);
        }
        if (page.size)
          tx.update(jobRef, { 'counts.writingSamples': FieldValue.increment(page.size) });
        return page.size;
      });
      if (removed === 0) break;
    }
    const jobRef = this.store.doc('privacyErasureJobs', agentId);
    return this.store.db.runTransaction(async (tx) => {
      await this.activeJob(tx, agentId, job.generation);
      const voiceRef = this.store.doc('voiceProfile', '1');
      const [voice, current] = await tx.getAll(voiceRef, jobRef);
      if (!voice || !current) throw new Error('Privacy erasure singleton read is incomplete');
      if (voice.exists && voice.get('id') !== 1) throw new Error('Voice profile identity mismatch');
      const now = this.store.now();
      tx.set(voiceRef, {
        id: 1,
        description: '',
        dos: [],
        donts: [],
        signature: '',
        updatedAt: now,
      });
      tx.update(jobRef, { status: 'content-erased', updatedAt: now });
      const counts = decodeRecord<Job>(current?.data()).counts;
      return { ...counts, securityIncidents: counts.securityIncidents ?? 0 };
    });
  }

  async pendingAssets(): Promise<PrivacyErasureAsset[]> {
    const agentId = await this.soleOwner();
    const page = await this.store
      .collection('privacyErasureAssets')
      .where('agentId', '==', agentId)
      .limit(100)
      .get();
    return page.docs.map((doc) => {
      const id = doc.get('sourceId');
      const path = doc.get('workspacePath');
      if (
        doc.get('agentId') !== agentId ||
        typeof id !== 'string' ||
        documentKey(id) !== doc.id ||
        typeof path !== 'string' ||
        !path
      )
        throw new Error('Privacy asset ownership or identity mismatch');
      if (doc.get('kind') === 'email_attachment_custody') {
        const custodyId = doc.get('custodyId');
        const generation = doc.get('generation');
        const objectState = doc.get('objectState');
        const documentId = doc.get('documentId');
        if (
          typeof custodyId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            custodyId,
          ) ||
          typeof generation !== 'string' ||
          !generation ||
          (objectState !== 'marker' && objectState !== 'content') ||
          (documentId !== undefined && (typeof documentId !== 'string' || !documentId)) ||
          id !== emailAttachmentCustodyCleanupIntentId(custodyId, generation)
        )
          throw new Error('Email attachment cleanup identity is malformed');
        return {
          kind: 'email_attachment_custody',
          id,
          workspacePath: path,
          custodyId,
          ...(typeof documentId === 'string' ? { documentId } : {}),
          generation,
          objectState,
        };
      }
      if (doc.get('kind') !== undefined && doc.get('kind') !== 'workspace_path')
        throw new Error('Privacy asset kind is malformed');
      return { kind: 'workspace_path', id, workspacePath: path };
    });
  }

  async assetDeleted(requested: PrivacyErasureAsset | string) {
    const agentId = await this.soleOwner();
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
      const refs = custodyRef ? [ref, custodyRef] : [ref];
      const snapshots = await tx.getAll(...refs);
      const stored = snapshots[0];
      if (!stored?.exists) return;
      if (
        stored.get('agentId') !== agentId ||
        stored.get('sourceId') !== id ||
        (typeof requested !== 'string' && stored.get('workspacePath') !== requested.workspacePath)
      )
        throw new Error('Privacy asset belongs to another agent');
      if (typeof requested !== 'string' && requested.kind === 'email_attachment_custody') {
        if (
          stored.get('kind') !== requested.kind ||
          stored.get('custodyId') !== requested.custodyId ||
          stored.get('generation') !== requested.generation ||
          stored.get('objectState') !== requested.objectState
        )
          throw new Error('Email attachment cleanup intent changed before acknowledgment');
        const custody = snapshots[1];
        if (
          !custody?.exists ||
          custody.get('agentId') !== agentId ||
          custody.get('id') !== requested.custodyId ||
          custody.get('workspacePath') !== requested.workspacePath ||
          !['cleanup_pending', 'duplicate_cleaned', 'erased'].includes(
            String(custody.get('status')),
          )
        )
          throw new Error('Email attachment cleanup tombstone changed before acknowledgment');
        if (
          custody.get('duplicateDocumentId') &&
          ['cleanup_pending', 'duplicate_cleaned'].includes(String(custody.get('status')))
        ) {
          const remaining = await tx.get(
            this.store
              .collection('privacyErasureAssets')
              .where('kind', '==', 'email_attachment_custody')
              .where('custodyId', '==', requested.custodyId)
              .limit(1000),
          );
          const hasOtherPending = remaining.docs.some((doc) => doc.id !== ref.id);
          tx.delete(ref);
          tx.update(custody.ref, {
            status: hasOtherPending ? 'cleanup_pending' : 'duplicate_cleaned',
            updatedAt: this.store.now(),
          });
          return;
        }
        if (custody.get('status') === 'cleanup_pending') {
          const requestedDocumentId = requested.documentId;
          if (
            typeof requestedDocumentId !== 'string' ||
            !requestedDocumentId ||
            stored.get('documentId') !== requestedDocumentId ||
            custody.get('fileId') !== null ||
            custody.get('documentId') !== requestedDocumentId
          )
            throw new Error('Email attachment cleanup generation changed before acknowledgment');
          const siblings = await tx.get(
            this.store
              .collection('privacyErasureAssets')
              .where('custodyId', '==', requested.custodyId)
              .limit(100),
          );
          if (siblings.size >= 100)
            throw new Error('Email attachment cleanup intent count exceeds its bound');
          for (const sibling of siblings.docs) {
            if (
              sibling.id !== ref.id &&
              (sibling.get('agentId') !== agentId ||
                sibling.get('kind') !== 'email_attachment_custody' ||
                sibling.get('custodyId') !== requested.custodyId)
            )
              throw new Error('Email attachment cleanup sibling identity changed');
          }
          const hasOtherIntent = siblings.docs.some((doc) => doc.id !== ref.id);
          tx.delete(ref);
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
          return;
        }
        if (custody.get('status') === 'cleanup_pending')
          throw new Error('Unlinked email attachment cleanup cannot be acknowledged');
      } else if (stored.get('kind') !== undefined && stored.get('kind') !== 'workspace_path') {
        throw new Error('Privacy asset kind changed before acknowledgment');
      }
      if (stored.get('workerPending') === true)
        throw new Error('Document processor callback remains unresolved');
      tx.delete(ref);
    });
  }

  async refreshEmailAttachmentCustodyCleanupIntent(
    asset: Extract<PrivacyErasureAsset, { kind: 'email_attachment_custody' }>,
    observed: { generation: string; objectState: 'marker' | 'content' },
  ) {
    const agentId = await this.soleOwner();
    const rowRef = this.store.doc('emailAttachmentCustodies', asset.custodyId);
    const oldRef = this.store.doc('privacyErasureAssets', asset.id);
    const nextId = emailAttachmentCustodyCleanupIntentId(asset.custodyId, observed.generation);
    const nextRef = this.store.doc('privacyErasureAssets', nextId);
    await this.store.db.runTransaction(async (tx) => {
      const [row, old, next] = await tx.getAll(rowRef, oldRef, nextRef);
      if (
        !row?.exists ||
        row.get('agentId') !== agentId ||
        row.get('id') !== asset.custodyId ||
        row.get('workspacePath') !== asset.workspacePath ||
        !['erased', 'cleanup_pending', 'duplicate_cleaned'].includes(String(row.get('status')))
      )
        throw new Error('Email attachment cleanup tombstone is unavailable');
      if (
        !old?.exists ||
        old.get('agentId') !== agentId ||
        old.get('sourceId') !== asset.id ||
        old.get('kind') !== 'email_attachment_custody' ||
        old.get('custodyId') !== asset.custodyId ||
        old.get('generation') !== asset.generation ||
        old.get('objectState') !== asset.objectState ||
        (typeof asset.documentId === 'string' && old.get('documentId') !== asset.documentId) ||
        old.get('workspacePath') !== asset.workspacePath
      )
        throw new Error('Email attachment cleanup intent changed before refresh');
      const generationField =
        observed.objectState === 'content' ? 'objectGeneration' : 'markerGeneration';
      const expectedCurrent = row.get(generationField);
      if (typeof expectedCurrent !== 'string' || !expectedCurrent)
        throw new Error('Observed email attachment state has no current generation');
      if (asset.objectState !== observed.objectState)
        throw new Error('Observed email attachment state does not match the cleanup intent');
      if (nextId === asset.id && observed.generation === asset.generation) return;
      if (row.get('status') === 'cleanup_pending') {
        const linkedDocumentId = asset.documentId;
        if (
          typeof linkedDocumentId === 'string'
            ? row.get('fileId') !== null || row.get('documentId') !== linkedDocumentId
            : !row.get('duplicateDocumentId')
        )
          throw new Error('Cleanup-pending custody is not linked to this exact cleanup flow');
      }
      if (next?.exists) {
        const oldDocumentId = old.get('documentId');
        const nextDocumentId = next.get('documentId');
        if (
          next.get('agentId') !== agentId ||
          next.get('sourceId') !== nextId ||
          next.get('custodyId') !== asset.custodyId ||
          next.get('generation') !== observed.generation ||
          next.get('objectState') !== observed.objectState ||
          next.get('workspacePath') !== asset.workspacePath ||
          (typeof nextDocumentId === 'string' && nextDocumentId !== oldDocumentId)
        )
          throw new Error('Email attachment cleanup intent identity collision');
        if (typeof oldDocumentId === 'string' && !nextDocumentId)
          tx.update(nextRef, { documentId: oldDocumentId });
      } else {
        const documentId = old.get('documentId');
        tx.create(nextRef, {
          id: nextId,
          sourceId: nextId,
          kind: 'email_attachment_custody',
          agentId,
          workspacePath: asset.workspacePath,
          ...(typeof documentId === 'string' &&
          documentId &&
          row.get('status') === 'cleanup_pending'
            ? { documentId }
            : {}),
          custodyId: asset.custodyId,
          generation: observed.generation,
          objectState: observed.objectState,
          createdAt: this.store.now(),
        });
      }
      if (expectedCurrent !== observed.generation)
        tx.update(row.ref, { [generationField]: observed.generation, updatedAt: this.store.now() });
      tx.delete(oldRef);
    });
  }

  async complete() {
    const agentId = await this.soleOwner();
    await this.store.db.runTransaction(async (tx) => {
      const jobRef = this.store.doc('privacyErasureJobs', agentId);
      const job = await tx.get(jobRef);
      if (!job.exists || job.get('agentId') !== agentId || job.get('status') !== 'content-erased')
        throw new Error('Privacy erasure data phase is incomplete');
      const pending = await tx.get(
        this.store.collection('privacyErasureAssets').where('agentId', '==', agentId).limit(1),
      );
      if (!pending.empty) throw new Error('Privacy erasure assets remain');
      tx.update(jobRef, { status: 'complete', updatedAt: this.store.now() });
    });
  }
}
