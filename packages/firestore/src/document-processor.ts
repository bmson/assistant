import { createHash, randomUUID } from 'node:crypto';
import {
  type DocumentProcessorRecordOutcome,
  type DocumentProcessorRepository,
  newTaskRecord,
  type ProcessableDocument,
  type Records,
} from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { createWakeIntent } from './outbox.js';
import {
  assertPrivacyErasureInactiveInTransaction,
  privacyErasureIsActive,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type DocumentRow = Records['documents'];

/** Pending heavy-format documents one owner has at once; the sweep reads at most this many. */
const PENDING_SCAN = 200;

/**
 * Recheck the imported installation's activation boundary in the same
 * transaction that accepts a durable processor callback. The route preflight
 * is intentionally not sufficient: activation can be withdrawn while the
 * callback is being dispatched.
 */
async function operationallyReadyInTransaction(
  tx: Transaction,
  store: InstallationStore,
  agentId: string,
): Promise<boolean> {
  const owners = await tx.get(store.collection('agents').limit(2));
  const owner = owners.docs[0];
  const ownerId = owner?.get('id');
  if (
    owners.size !== 1 ||
    !owner ||
    typeof ownerId !== 'string' ||
    ownerId !== agentId ||
    documentKey(ownerId) !== owner.id
  )
    return false;
  const migration = await tx.get(store.doc('coordination', 'migration'));
  return !migration.exists || migration.get('status') === 'active';
}

function owned(snapshot: DocumentSnapshot, agentId: string): DocumentRow | null {
  if (!snapshot.exists) return null;
  const row = decodeRecord<DocumentRow>(snapshot.data());
  return typeof row.id === 'string' &&
    documentKey(row.id) === snapshot.id &&
    row.agentId === agentId
    ? row
    : null;
}

function isClaimable(row: DocumentRow, staleBefore: Date): boolean {
  return (
    row.extractor === 'pending_processor' &&
    row.status === 'pending' &&
    !row.processedTextPath &&
    (!(row.processorStartedAt instanceof Date) || row.processorStartedAt < staleBefore)
  );
}

/**
 * The document processor lifecycle on Firestore. Every claim, release, and
 * callback rereads the document in its transaction, so overlapping sweeps and
 * a replayed callback resolve exactly as the PostgreSQL row updates do.
 */
export class FirestoreDocumentProcessorRepository implements DocumentProcessorRepository {
  readonly kind = 'document-processor-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  private pending() {
    return this.store
      .collection('documents')
      .where('agentId', '==', this.agentId)
      .where('extractor', '==', 'pending_processor')
      .where('status', '==', 'pending')
      .where('processedTextPath', '==', null)
      .limit(PENDING_SCAN);
  }

  async retireExhausted(maxAttempts: number, now: Date, staleBefore: Date): Promise<number> {
    const candidates = await this.pending().get();
    let retired = 0;
    for (const doc of candidates.docs) {
      const moved = await this.store.db.runTransaction(async (tx) => {
        const row = owned(await tx.get(doc.ref), this.agentId);
        if (
          !row ||
          row.extractor !== 'pending_processor' ||
          !isClaimable(row, staleBefore) ||
          row.processorAttempts < maxAttempts
        )
          return false;
        tx.update(
          doc.ref,
          encodeRecord({
            status: 'failed',
            processorTokenHash: null,
            error: `processor did not report back after ${maxAttempts} launches`,
            updatedAt: now,
          }),
        );
        return true;
      });
      if (moved) retired += 1;
    }
    return retired;
  }

  async claimable(input: {
    documentId?: string;
    staleBefore: Date;
    limit: number;
  }): Promise<ProcessableDocument[]> {
    const rows = input.documentId
      ? [owned(await this.store.doc('documents', input.documentId).get(), this.agentId)]
      : (await this.pending().get()).docs.map((doc) => owned(doc, this.agentId));
    const selected = rows
      .filter((row): row is DocumentRow => row !== null && isClaimable(row, input.staleBefore))
      .slice(0, input.limit);
    if (selected.length === 0) return [];
    const files = await this.store.db.getAll(
      ...selected.map((row) => this.store.doc('files', row.fileId)),
    );
    return selected.flatMap((row, i) => {
      const file = files[i];
      const workspacePath = file?.exists ? file.get('workspacePath') : null;
      if (typeof workspacePath !== 'string' || file?.get('agentId') !== this.agentId) return [];
      return [
        {
          id: row.id,
          agentId: row.agentId,
          title: row.title,
          mime: row.mime,
          extractor: row.extractor,
          workspacePath,
        },
      ];
    });
  }

  async claim(
    id: string,
    input: { tokenHash: string; now: Date; staleBefore: Date; maxAttempts: number },
  ): Promise<boolean> {
    const ref = this.store.doc('documents', id);
    return this.store.db.runTransaction(async (tx) => {
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', this.agentId));
      if (erasure.exists && privacyErasureIsActive(erasure.get('status'))) return false;
      const row = owned(await tx.get(ref), this.agentId);
      if (
        !row ||
        !isClaimable(row, input.staleBefore) ||
        row.processorAttempts >= input.maxAttempts
      )
        return false;
      tx.update(
        ref,
        encodeRecord({
          processorTokenHash: input.tokenHash,
          processorStartedAt: input.now,
          processorAttempts: row.processorAttempts + 1,
          updatedAt: input.now,
        }),
      );
      return true;
    });
  }

  async release(id: string, now: Date, expectedTokenHash: string): Promise<void> {
    const ref = this.store.doc('documents', id);
    await this.store.db.runTransaction(async (tx) => {
      const row = owned(await tx.get(ref), this.agentId);
      if (
        !row ||
        row.processorTokenHash !== expectedTokenHash ||
        row.processedTextPath ||
        row.status !== 'pending'
      )
        return;
      tx.update(
        ref,
        encodeRecord({ processorTokenHash: null, processorStartedAt: null, updatedAt: now }),
      );
    });
  }

  async recordResult(
    input: Parameters<DocumentProcessorRepository['recordResult']>[0],
  ): Promise<DocumentProcessorRecordOutcome> {
    const ref = this.store.doc('documents', input.documentId);
    return this.store.db.runTransaction(async (tx) => {
      const row = owned(await tx.get(ref), this.agentId);
      if (!row) {
        const tombstone = await tx.get(
          this.store.doc('documentDeletionTombstones', input.documentId),
        );
        if (!tombstone.exists) return { ok: false, status: 404, error: 'document not found' };
        if (
          tombstone.get('agentId') !== this.agentId ||
          tombstone.get('documentId') !== input.documentId ||
          typeof tombstone.get('processorTokenHash') !== 'string' ||
          typeof tombstone.get('outputPath') !== 'string'
        )
          return { ok: false, status: 404, error: 'document not found' };
        if (!input.tokenMatches(tombstone.get('processorTokenHash') as string))
          return { ok: false, status: 403, error: 'invalid token' };
        if (tombstone.get('outputPath') !== input.processedTextPath)
          return { ok: false, status: 409, error: 'deleted document output path mismatch' };
        return {
          ok: false,
          status: 410,
          error: 'document was deleted; worker output cleanup is required',
          cleanupPath: input.processedTextPath,
        };
      }
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, this.agentId);
      const externalEventId = `document-processor-result:${row.id}:${input.tokenHash}`;
      const eventRef = this.store.doc(
        'taskEventKeys',
        createHash('sha256').update(externalEventId).digest('hex'),
      );
      const event = await tx.get(eventRef);
      if (event.exists) {
        const prior = await tx.get(this.store.doc('tasks', String(event.get('taskId'))));
        const task = prior.exists ? decodeRecord<Records['tasks']>(prior.data()) : null;
        const payload = (
          task?.trigger as {
            payload?: { processorResultDigest?: string; job?: string; documentId?: string };
          } | null
        )?.payload;
        if (
          !task ||
          task.agentId !== this.agentId ||
          task.trust !== 'assistant' ||
          task.externalEventId !== externalEventId ||
          payload?.documentId !== row.id ||
          payload.processorResultDigest !== input.resultDigest
        )
          return {
            ok: false,
            status: 409,
            error: 'processor callback differs from its recorded receipt',
          };
        const extract = payload.job === 'documents.extract';
        return {
          ok: true,
          documentId: row.id,
          agentId: row.agentId,
          extract,
          replayed: true,
          ...(extract ? { wake: { id: task.id, queueGeneration: task.queueGeneration } } : {}),
        };
      }
      if (!row.processorTokenHash)
        return { ok: false, status: 409, error: 'no pending processor run' };
      if (!input.tokenMatches(row.processorTokenHash))
        return { ok: false, status: 403, error: 'invalid token' };
      if (!(await operationallyReadyInTransaction(tx, this.store, this.agentId)))
        return {
          ok: false,
          status: 503,
          error: 'Firestore installation is not operationally ready',
        };
      const task = newTaskRecord(
        {
          agentId: row.agentId,
          type: 'adhoc',
          trust: 'assistant',
          externalEventId,
          title: input.ok ? `Extract ${row.title}` : `Processor result for ${row.title}`,
          budgetUsdLimit: '0.50',
          trigger: {
            source: 'internal',
            externalEventId,
            payload: {
              job: input.ok ? 'documents.extract' : 'documents.processor_receipt',
              documentId: row.id,
              processorResultDigest: input.resultDigest,
            },
          },
        },
        randomUUID(),
        input.now,
      );
      if (!input.ok) {
        task.status = 'done';
        task.progress = input.unsupported
          ? 'Processor reported unsupported format'
          : 'Processor reported failure';
      }
      tx.create(this.store.doc('tasks', task.id), encodeRecord(task));
      tx.create(eventRef, { taskId: task.id, createdAt: input.now });
      if (input.ok)
        createWakeIntent(tx, this.store, {
          taskId: task.id,
          generation: 0,
          availableAt: input.now,
        });
      if (input.ok) {
        tx.update(
          ref,
          encodeRecord({
            processedTextPath: input.processedTextPath,
            extractionMetadata: input.extractionMetadata ?? null,
            processorTokenHash: null,
            error: null,
            updatedAt: input.now,
          }),
        );
        return {
          ok: true,
          documentId: row.id,
          agentId: row.agentId,
          extract: true,
          wake: { id: task.id, queueGeneration: task.queueGeneration },
        };
      }
      tx.update(
        ref,
        encodeRecord({
          status: input.unsupported ? 'unsupported' : 'failed',
          processorTokenHash: null,
          error: input.error.slice(0, 2000),
          updatedAt: input.now,
        }),
      );
      return { ok: true, documentId: row.id, agentId: row.agentId, extract: false };
    });
  }

  async resolveDeletedCallback(
    input: Parameters<DocumentProcessorRepository['resolveDeletedCallback']>[0],
  ): Promise<boolean> {
    const tombstoneRef = this.store.doc('documentDeletionTombstones', input.documentId);
    const workerAssetId = `document-delete-worker:${input.documentId}`;
    const outputAssetId = deletedOutputAssetId(input.documentId, input.processedTextPath);
    const workerRef = this.store.doc('privacyErasureAssets', workerAssetId);
    const outputRef = this.store.doc('privacyErasureAssets', outputAssetId);
    return this.store.db.runTransaction(async (tx) => {
      const [tombstone, workerAsset, outputAsset] = await tx.getAll(
        tombstoneRef,
        workerRef,
        outputRef,
      );
      if (!tombstone?.exists) return false;
      if (
        tombstone.get('agentId') !== this.agentId ||
        tombstone.get('documentId') !== input.documentId ||
        tombstone.get('outputPath') !== input.processedTextPath ||
        typeof tombstone.get('processorTokenHash') !== 'string'
      )
        throw new Error('Deleted document callback tombstone is invalid');
      if (!input.tokenMatches(tombstone.get('processorTokenHash') as string))
        throw new Error('Invalid deleted document callback token');
      if (workerAsset?.exists) {
        if (
          workerAsset.get('agentId') !== this.agentId ||
          workerAsset.get('sourceId') !== workerAssetId ||
          workerAsset.get('workerPending') !== true ||
          workerAsset.get('workspacePath') !== input.processedTextPath
        )
          throw new Error('Deleted document worker marker is invalid');
        tx.delete(workerAsset.ref);
      }
      if (outputAsset?.exists) {
        if (
          outputAsset.get('agentId') !== this.agentId ||
          outputAsset.get('sourceId') !== outputAssetId ||
          outputAsset.get('workspacePath') !== input.processedTextPath
        )
          throw new Error('Deleted document output asset is invalid');
        tx.delete(outputAsset.ref);
      }
      tx.delete(tombstoneRef);
      return true;
    });
  }
}

function deletedOutputAssetId(documentId: string, path: string): string {
  return `document-delete:${documentId}:${createHash('sha256').update(path).digest('hex')}`;
}
