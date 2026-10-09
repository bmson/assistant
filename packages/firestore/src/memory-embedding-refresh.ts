import { createHash, randomUUID } from 'node:crypto';
import type {
  MemoryEmbeddingRefreshRepository,
  Records,
  RefreshClaim,
} from '@assistant/persistence';
import { FieldPath, FieldValue } from '@google-cloud/firestore';
import {
  assertPrivacyErasureFenceUnchanged,
  assertPrivacyErasureInactiveInTransaction,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const KEY = /^[a-f0-9]{64}$/;
const receiptIdentity = (agentId: string, memoryId: string, target: string, hash: string) =>
  createHash('sha256').update([agentId, memoryId, target, hash].join('\0')).digest('hex');
const cursorId = (agentId: string, target: string) =>
  createHash('sha256').update(`${agentId}\0${target}`).digest('hex');

function validReceipt(row: Records['memoryEmbeddingRefreshes'], docId: string): boolean {
  return Boolean(
    row.id &&
      documentKey(row.id) === docId &&
      row.agentId &&
      row.memoryId &&
      KEY.test(row.sourceHash) &&
      KEY.test(row.targetSpaceKey) &&
      Number.isInteger(row.targetDimensions) &&
      row.targetDimensions > 0 &&
      row.targetDimensions <= 2048 &&
      (row.observedSpaceKey === null || KEY.test(row.observedSpaceKey)) &&
      [
        'dispatching',
        'prepared',
        'unknown',
        'retry_authorized',
        'completed',
        'stale',
        'abandoned',
      ].includes(row.status) &&
      (row.preparedVector === null ||
        (Array.isArray(row.preparedVector) &&
          row.preparedVector.length === row.targetDimensions &&
          row.preparedVector.every(Number.isFinite) &&
          row.preparedVector.some((value) => value !== 0))) &&
      (row.privacyGeneration === null || typeof row.privacyGeneration === 'string') &&
      (row.claimToken === null || typeof row.claimToken === 'string') &&
      (row.leaseUntil === null || row.leaseUntil instanceof Date) &&
      row.createdAt instanceof Date &&
      row.updatedAt instanceof Date,
  );
}

export class FirestoreMemoryEmbeddingRefreshRepository implements MemoryEmbeddingRefreshRepository {
  readonly kind = 'memory-embedding-refresh-repository' as const;
  constructor(readonly store: InstallationStore) {}

  async getCursor(agentId: string, targetSpaceKey: string): Promise<string | null> {
    if (!agentId || !KEY.test(targetSpaceKey)) throw new Error('Invalid refresh cursor identity');
    const snap = await this.store
      .doc('memoryEmbeddingRefreshCursors', cursorId(agentId, targetSpaceKey))
      .get();
    if (!snap.exists) return null;
    const row = decodeRecord<Record<string, unknown>>(snap.data());
    if (
      typeof row.id !== 'string' ||
      documentKey(row.id) !== snap.id ||
      row.agentId !== agentId ||
      row.targetSpaceKey !== targetSpaceKey ||
      (row.cursor !== null && typeof row.cursor !== 'string')
    )
      throw new Error('Memory refresh cursor ownership mismatch');
    return row.cursor as string | null;
  }

  async saveCursor(agentId: string, targetSpaceKey: string, cursor: string | null): Promise<void> {
    if (!agentId || !KEY.test(targetSpaceKey) || (cursor !== null && typeof cursor !== 'string'))
      throw new Error('Invalid refresh cursor');
    const ref = this.store.doc('memoryEmbeddingRefreshCursors', cursorId(agentId, targetSpaceKey));
    const fence = await readPrivacyErasureFence(this.store, agentId);
    await this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      tx.set(
        ref,
        encodeRecord({
          id: cursorId(agentId, targetSpaceKey),
          agentId,
          targetSpaceKey,
          cursor,
          updatedAt: this.store.now(),
        }),
      );
    });
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
  }

  async listCandidates(input: {
    agentId: string;
    targetSpaceKey: string;
    afterId: string | null;
    limit: number;
  }) {
    if (
      !input.agentId ||
      !KEY.test(input.targetSpaceKey) ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new Error('Invalid memory embedding refresh page');
    const fence = await readPrivacyErasureFence(this.store, input.agentId);
    let query = this.store
      .collection('memories')
      .where('agentId', '==', input.agentId)
      .orderBy(FieldPath.documentId())
      .limit(input.limit + 1);
    if (input.afterId) query = query.startAfter(documentKey(input.afterId));
    const snapshot = await query.get();
    const scanned = snapshot.docs.slice(0, input.limit);
    const rows = [];
    for (const doc of scanned) {
      const row = decodeRecord<Record<string, unknown>>(doc.data());
      if (
        row.agentId !== input.agentId ||
        typeof row.id !== 'string' ||
        documentKey(row.id) !== doc.id ||
        typeof row.content !== 'string' ||
        typeof row.contentHash !== 'string' ||
        !KEY.test(row.contentHash)
      )
        throw new Error('Memory refresh source ownership or identity mismatch');
      const key = row.embeddingSpace;
      if (key !== null && key !== undefined && (typeof key !== 'string' || !KEY.test(key)))
        throw new Error('Memory refresh source space is malformed');
      if (!row.embedding || key === input.targetSpaceKey) continue;
      rows.push({
        id: row.id,
        agentId: input.agentId,
        content: row.content,
        contentHash: row.contentHash,
        embeddingSpaceKey: (key as string | null | undefined) ?? null,
      });
    }
    await assertPrivacyErasureFenceUnchanged(this.store, input.agentId, fence);
    const hasMore = snapshot.size > input.limit;
    const nextCursor = hasMore ? ((scanned.at(-1)?.get('id') as string | undefined) ?? null) : null;
    return { rows, nextCursor };
  }

  async claim(
    input: Parameters<MemoryEmbeddingRefreshRepository['claim']>[0],
  ): Promise<RefreshClaim> {
    if (
      !input.agentId ||
      !input.memoryId ||
      !KEY.test(input.sourceHash) ||
      !KEY.test(input.targetSpaceKey) ||
      !Number.isInteger(input.targetDimensions) ||
      input.targetDimensions < 1 ||
      input.targetDimensions > 2048
    )
      throw new Error('Invalid memory embedding refresh claim');
    const fence = await readPrivacyErasureFence(this.store, input.agentId);
    const sourceRef = this.store.doc('memories', input.memoryId);
    const tombstoneRef = this.store.doc('memoryTombstones', input.sourceHash);
    const identityKey = receiptIdentity(
      input.agentId,
      input.memoryId,
      input.targetSpaceKey,
      input.sourceHash,
    );
    const result = await this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const source = await tx.get(sourceRef);
      const tombstone = await tx.get(tombstoneRef);
      if (
        !source.exists ||
        source.get('agentId') !== input.agentId ||
        source.get('contentHash') !== input.sourceHash ||
        tombstone.exists
      )
        return { kind: 'stale' } as const;
      const storedSpace = source.get('embeddingSpace') ?? null;
      if (storedSpace === input.targetSpaceKey) return { kind: 'current' } as const;
      const existing = await tx.get(
        this.store.collection('memoryEmbeddingRefreshes').where('identityKey', '==', identityKey),
      );
      const priorDocs = existing.docs.sort(
        (a, b) => (b.updateTime?.toMillis() ?? 0) - (a.updateTime?.toMillis() ?? 0),
      );
      const priorDoc = priorDocs[0];
      if (priorDoc) {
        const prior = decodeRecord<Records['memoryEmbeddingRefreshes']>(priorDoc.data());
        if (
          !validReceipt(prior, priorDoc.id) ||
          prior.agentId !== input.agentId ||
          prior.memoryId !== input.memoryId ||
          prior.sourceHash !== input.sourceHash ||
          prior.targetSpaceKey !== input.targetSpaceKey
        )
          throw new Error('Memory refresh receipt ownership mismatch');
        if (prior.status === 'prepared') return { kind: 'prepared', receipt: prior } as const;
        if (prior.status === 'unknown') return { kind: 'unknown', receipt: prior } as const;
        if (prior.status === 'abandoned') return { kind: 'stale' } as const;
        if (prior.status === 'retry_authorized') {
          tx.update(
            priorDoc.ref,
            encodeRecord({
              status: 'abandoned',
              unknownReason: 'owner_retry_consumed',
              updatedAt: input.now,
            }),
          );
        }
        if (prior.status === 'dispatching') {
          if (prior.leaseUntil && prior.leaseUntil > input.now) return { kind: 'busy' } as const;
          const changed = {
            ...prior,
            status: 'unknown' as const,
            unknownReason: 'expired_dispatch_lease',
            claimToken: null,
            updatedAt: input.now,
          };
          tx.update(priorDoc.ref, encodeRecord(changed));
          return { kind: 'unknown', receipt: changed } as const;
        }
      }
      const now = input.now;
      const id = `${identityKey}:${randomUUID()}`;
      const token = randomUUID();
      const row: Records['memoryEmbeddingRefreshes'] & { identityKey: string } = {
        id,
        identityKey,
        agentId: input.agentId,
        memoryId: input.memoryId,
        sourceHash: input.sourceHash,
        targetSpaceKey: input.targetSpaceKey,
        targetDimensions: input.targetDimensions,
        observedSpaceKey: storedSpace as string | null,
        status: 'dispatching',
        preparedVector: null,
        privacyGeneration: fence?.toDate().toISOString() ?? null,
        claimToken: token,
        leaseUntil: input.leaseUntil,
        unknownReason: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.create(this.store.doc('memoryEmbeddingRefreshes', id), encodeRecord(row));
      return { kind: 'claimed', receipt: row } as const;
    });
    await assertPrivacyErasureFenceUnchanged(this.store, input.agentId, fence);
    return result;
  }

  async savePrepared(
    input: Parameters<MemoryEmbeddingRefreshRepository['savePrepared']>[0],
  ): Promise<boolean> {
    if (
      !Array.isArray(input.vector) ||
      !input.vector.length ||
      input.vector.length > 2048 ||
      !input.vector.every(Number.isFinite) ||
      !input.vector.some((value) => value !== 0)
    )
      throw new Error('Invalid prepared embedding vector');
    const ref = this.store.doc('memoryEmbeddingRefreshes', input.receiptId);
    const fence = await readPrivacyErasureFence(this.store, input.agentId);
    const jobRef = this.store.doc('privacyErasureJobs', input.agentId);
    const saved = await this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const row = decodeRecord<Records['memoryEmbeddingRefreshes']>(snap.data());
      if (!validReceipt(row, snap.id) || row.agentId !== input.agentId)
        throw new Error('Memory refresh receipt ownership mismatch');
      if (
        row.status !== 'dispatching' ||
        row.claimToken !== input.claimToken ||
        !row.leaseUntil ||
        row.leaseUntil <= input.now ||
        input.vector.length !== row.targetDimensions
      )
        return false;
      const [memory, tombstone, job] = await tx.getAll(
        this.store.doc('memories', row.memoryId),
        this.store.doc('memoryTombstones', row.sourceHash),
        jobRef,
      );
      const currentGeneration = !job?.exists
        ? null
        : (job.updateTime?.toDate().toISOString() ?? null);
      const sourceStillCurrent =
        Boolean(memory?.exists) &&
        memory?.get('agentId') === input.agentId &&
        memory?.get('contentHash') === row.sourceHash &&
        (memory?.get('embeddingSpace') ?? null) === row.observedSpaceKey &&
        !tombstone?.exists;
      if (!sourceStillCurrent || currentGeneration !== row.privacyGeneration) {
        tx.update(
          ref,
          encodeRecord({
            status: 'stale',
            preparedVector: null,
            claimToken: null,
            leaseUntil: null,
            updatedAt: input.now,
          }),
        );
        return false;
      }
      tx.update(
        ref,
        encodeRecord({
          status: 'prepared',
          preparedVector: input.vector,
          claimToken: null,
          leaseUntil: null,
          updatedAt: input.now,
        }),
      );
      return true;
    });
    await assertPrivacyErasureFenceUnchanged(this.store, input.agentId, fence);
    return saved;
  }

  async applyPrepared(
    input: Parameters<MemoryEmbeddingRefreshRepository['applyPrepared']>[0],
  ): Promise<'applied' | 'stale' | 'privacy-fenced'> {
    const fence = await readPrivacyErasureFence(this.store, input.agentId);
    const receiptRef = this.store.doc('memoryEmbeddingRefreshes', input.receiptId);
    const memoryRef = this.store.doc('memories', input.memoryId);
    const tombstoneRef = this.store.doc('memoryTombstones', input.sourceHash);
    const result = await this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const [receiptSnap, memorySnap, tombstone] = await tx.getAll(
        receiptRef,
        memoryRef,
        tombstoneRef,
      );
      if (!receiptSnap?.exists || !memorySnap?.exists) return 'stale' as const;
      const receipt = decodeRecord<Records['memoryEmbeddingRefreshes']>(receiptSnap.data());
      if (
        !validReceipt(receipt, receiptSnap.id) ||
        receipt.agentId !== input.agentId ||
        receipt.status !== 'prepared' ||
        receipt.memoryId !== input.memoryId ||
        receipt.sourceHash !== input.sourceHash ||
        receipt.targetSpaceKey !== input.targetSpaceKey ||
        memorySnap.get('agentId') !== input.agentId ||
        memorySnap.get('contentHash') !== input.sourceHash ||
        (memorySnap.get('embeddingSpace') ?? null) !== receipt.observedSpaceKey ||
        !receipt.preparedVector ||
        tombstone?.exists
      ) {
        tx.update(
          receiptRef,
          encodeRecord({ status: 'stale', preparedVector: null, updatedAt: input.now }),
        );
        return 'stale' as const;
      }
      const observed = fence?.toDate().toISOString() ?? null;
      if (observed !== receipt.privacyGeneration) {
        tx.update(
          receiptRef,
          encodeRecord({ status: 'stale', preparedVector: null, updatedAt: input.now }),
        );
        return 'privacy-fenced' as const;
      }
      tx.update(memoryRef, {
        embedding: FieldValue.vector(receipt.preparedVector),
        embeddingSpace: input.targetSpaceKey,
        retrievalRevision: randomUUID(),
      });
      tx.update(
        receiptRef,
        encodeRecord({ status: 'completed', preparedVector: null, updatedAt: input.now }),
      );
      return 'applied' as const;
    });
    await assertPrivacyErasureFenceUnchanged(this.store, input.agentId, fence);
    return result;
  }

  async markUnknown(
    input: Parameters<MemoryEmbeddingRefreshRepository['markUnknown']>[0],
  ): Promise<void> {
    const ref = this.store.doc('memoryEmbeddingRefreshes', input.receiptId);
    await this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const row = decodeRecord<Records['memoryEmbeddingRefreshes']>(snap.data());
      if (!validReceipt(row, snap.id) || row.agentId !== input.agentId)
        throw new Error('Memory refresh receipt ownership mismatch');
      if (row.status === 'dispatching' && row.claimToken === input.claimToken)
        tx.update(
          ref,
          encodeRecord({
            status: 'unknown',
            unknownReason:
              input.reason.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'unknown_failure',
            claimToken: null,
            leaseUntil: null,
            updatedAt: input.now,
          }),
        );
    });
  }

  async listUnknown(
    agentId: string,
    limit: number,
  ): Promise<Records['memoryEmbeddingRefreshes'][]> {
    if (!agentId || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid refresh review limit');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const page = await this.store
      .collection('memoryEmbeddingRefreshes')
      .where('agentId', '==', agentId)
      .where('status', '==', 'unknown')
      .limit(limit)
      .get();
    const rows = page.docs.map((doc) => {
      const row = decodeRecord<Records['memoryEmbeddingRefreshes']>(doc.data());
      if (!validReceipt(row, doc.id) || row.agentId !== agentId)
        throw new Error('Memory refresh receipt ownership mismatch');
      return row;
    });
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return rows;
  }

  async resolveUnknown(input: Parameters<MemoryEmbeddingRefreshRepository['resolveUnknown']>[0]) {
    const ref = this.store.doc('memoryEmbeddingRefreshes', input.receiptId);
    const authorized = await this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const row = decodeRecord<Records['memoryEmbeddingRefreshes']>(snap.data());
      if (
        !validReceipt(row, snap.id) ||
        row.agentId !== input.agentId ||
        row.status !== 'unknown' ||
        row.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
      )
        return false;
      tx.update(
        ref,
        encodeRecord({
          status: input.action === 'authorize_retry' ? 'retry_authorized' : 'abandoned',
          unknownReason: `owner_${input.action}`,
          updatedAt: input.now,
        }),
      );
      return true;
    });
    return authorized
      ? {
          authorized: true,
          ...(input.action === 'authorize_retry' ? { retryKey: input.receiptId } : {}),
        }
      : { authorized: false };
  }
}
