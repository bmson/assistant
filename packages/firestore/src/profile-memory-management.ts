import { randomUUID } from 'node:crypto';
import {
  type EmbeddingSpace,
  type ManagedMemory,
  type MemoryForgetReason,
  type MemoryMutation,
  type MemoryProminence,
  type ProfileMemoryManagementRepository,
  type Records,
  snapshotEmbeddingSpace,
  validateEmbedding,
} from '@assistant/persistence';
import { type DocumentSnapshot, FieldValue, type Transaction } from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Memory = Pick<Records['memories'], 'id' | 'agentId' | 'contentHash'> & {
  importance?: number;
};

function managed(row: Memory): ManagedMemory {
  return { id: row.id, agentId: row.agentId, contentHash: row.contentHash };
}

function validateCreate(input: Parameters<ProfileMemoryManagementRepository['create']>[0]): void {
  if (!input.content || !input.contentHash || !input.subjectContactId)
    throw new Error('Invalid profile memory');
  if (!Number.isInteger(input.importance) || input.importance < 1 || input.importance > 5)
    throw new Error('Invalid memory importance');
}

/** Transactional Firestore implementation of owner-facing profile fact mutations. */
export class FirestoreProfileMemoryManagementRepository
  implements ProfileMemoryManagementRepository
{
  readonly kind = 'profile-memory-management-repository' as const;
  readonly embeddingSpace: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    embeddingSpace: EmbeddingSpace,
  ) {
    this.embeddingSpace = snapshotEmbeddingSpace(embeddingSpace);
  }

  private async configuredAgentOrNull(tx: Transaction): Promise<string | null> {
    const configured = await tx.get(this.store.collection('agents').limit(2));
    if (configured.size !== 1 || !configured.docs[0]) return null;
    const snapshot = configured.docs[0];
    const id = snapshot.get('id');
    if (typeof id !== 'string' || !id || documentKey(id) !== snapshot.id)
      throw new Error('Configured agent record is malformed');
    const erasure = await tx.get(this.store.doc('privacyErasureJobs', id));
    if (erasure.exists && privacyErasureIsActive(erasure.get('status')))
      throw new Error('Privacy erasure is in progress');
    return id;
  }

  private async configuredAgent(tx: Transaction): Promise<string> {
    const agentId = await this.configuredAgentOrNull(tx);
    if (!agentId) throw new Error('Memory management requires exactly one configured agent');
    return agentId;
  }

  private owned(snapshot: DocumentSnapshot, agentId: string): Memory | null {
    if (!snapshot.exists) return null;
    const decoded = decodeRecord<unknown>(snapshot.data());
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    const row = decoded as Record<string, unknown>;
    if (
      typeof row.id !== 'string' ||
      documentKey(row.id) !== snapshot.id ||
      row.agentId !== agentId ||
      typeof row.contentHash !== 'string' ||
      !row.contentHash
    )
      return null;
    return {
      id: row.id,
      agentId,
      contentHash: row.contentHash,
      ...(typeof row.importance === 'number' && Number.isFinite(row.importance)
        ? { importance: row.importance }
        : {}),
    };
  }

  private invalidateOwnerCard(tx: Transaction, agentId: string, now: Date): void {
    tx.set(
      this.store.doc('ownerCards', agentId),
      encodeRecord({ agentId, content: '', compiledAt: now, invalidatedAt: now }),
    );
  }

  private async mutateExisting(
    memoryId: string,
    apply: (input: {
      tx: Transaction;
      row: Memory;
      snapshot: DocumentSnapshot;
      agentId: string;
      now: Date;
    }) => MemoryMutation | Promise<MemoryMutation>,
  ): Promise<MemoryMutation> {
    return this.store.db.runTransaction(async (tx) => {
      const agentId = await this.configuredAgent(tx);
      const snapshot = await tx.get(this.store.doc('memories', memoryId));
      const row = this.owned(snapshot, agentId);
      if (!row) return { status: 'not-found' };
      const tombstone = await tx.get(this.store.doc('memoryTombstones', row.contentHash));
      if (tombstone.exists) return { status: 'tombstoned' };
      return apply({ tx, row, snapshot, agentId, now: this.store.now() });
    });
  }

  async get(memoryId: string): Promise<ManagedMemory | null> {
    return this.store.db.runTransaction(
      async (tx) => {
        const agentId = await this.configuredAgentOrNull(tx);
        if (!agentId) return null;
        const snapshot = await tx.get(this.store.doc('memories', memoryId));
        const row = this.owned(snapshot, agentId);
        if (!row) return null;
        const tombstone = await tx.get(this.store.doc('memoryTombstones', row.contentHash));
        return tombstone.exists ? null : managed(row);
      },
      { readOnly: true },
    );
  }

  async confirm(memoryId: string): Promise<MemoryMutation> {
    return this.mutateExisting(memoryId, ({ tx, row, snapshot, agentId, now }) => {
      tx.update(snapshot.ref, {
        confidence: '1.00',
        ownerConfirmed: true,
        quarantined: false,
      });
      this.invalidateOwnerCard(tx, agentId, now);
      return { status: 'updated', memory: managed(row) };
    });
  }

  async restore(memoryId: string): Promise<MemoryMutation> {
    return this.mutateExisting(memoryId, ({ tx, row, snapshot, agentId, now }) => {
      tx.update(snapshot.ref, {
        expiresAt: null,
        supersededById: null,
        confidence: '1.00',
        ownerConfirmed: true,
        quarantined: false,
      });
      this.invalidateOwnerCard(tx, agentId, now);
      return { status: 'updated', memory: managed(row) };
    });
  }

  async correct(
    input: Parameters<ProfileMemoryManagementRepository['correct']>[0],
  ): Promise<MemoryMutation> {
    if (!input.content || !input.contentHash || !input.expectedContentHash)
      throw new Error('Invalid profile memory correction');
    validateEmbedding(this.embeddingSpace, input.embedding);
    if (input.embeddingSpaceKey !== embeddingSpaceKey(this.embeddingSpace))
      throw new Error('Memory embedding space changed');
    const retrievalRevision = randomUUID();
    return this.store.db.runTransaction(async (tx) => {
      const agentId = await this.configuredAgent(tx);
      const snapshot = await tx.get(this.store.doc('memories', input.memoryId));
      const row = this.owned(snapshot, agentId);
      if (!row) return { status: 'not-found' };
      if (row.contentHash !== input.expectedContentHash) return { status: 'stale' };

      const oldTombstoneRef = this.store.doc('memoryTombstones', row.contentHash);
      const newTombstoneRef = this.store.doc('memoryTombstones', input.contentHash);
      const oldHashRef = this.store.doc('memoryContentHashes', row.contentHash);
      const newHashRef = this.store.doc('memoryContentHashes', input.contentHash);
      const sameHash = input.contentHash === row.contentHash;
      const [oldTombstone, oldHash] = await tx.getAll(oldTombstoneRef, oldHashRef);
      const [newTombstone, newHash] = sameHash
        ? [oldTombstone, oldHash]
        : await tx.getAll(newTombstoneRef, newHashRef);
      if (oldTombstone?.exists || newTombstone?.exists) return { status: 'tombstoned' };
      if (newHash?.exists && (!sameHash || newHash.get('memoryId') !== row.id))
        return { status: 'duplicate' };

      const now = this.store.now();
      if (!sameHash) {
        tx.create(
          oldTombstoneRef,
          encodeRecord({
            id: row.contentHash,
            contentHash: row.contentHash,
            reason: 'owner_correct',
            createdAt: now,
          }),
        );
        if (oldHash?.exists && oldHash.get('memoryId') === row.id) tx.delete(oldHashRef);
        tx.create(newHashRef, { memoryId: row.id });
      } else if (!newHash?.exists) {
        tx.create(newHashRef, { memoryId: row.id });
      }
      tx.update(
        snapshot.ref,
        encodeRecord({
          content: input.content,
          contentHash: input.contentHash,
          embedding: FieldValue.vector(input.embedding),
          embeddingSpaceKey: embeddingSpaceKey(this.embeddingSpace),
          embeddingSpace: embeddingSpaceKey(this.embeddingSpace),
          retrievalRevision,
          confidence: '1.00',
          ownerConfirmed: true,
          originTrust: 'owner',
          quarantined: false,
        }),
      );
      this.invalidateOwnerCard(tx, agentId, now);
      return {
        status: 'updated',
        memory: { id: row.id, agentId, contentHash: input.contentHash },
      };
    });
  }

  async forget(memoryId: string, reason: MemoryForgetReason): Promise<MemoryMutation> {
    return this.store.db.runTransaction(async (tx) => {
      const agentId = await this.configuredAgent(tx);
      const intentRef = this.store.doc('graphDeletionIntents', memoryId);
      const [snapshot, existingIntent] = await tx.getAll(
        this.store.doc('memories', memoryId),
        intentRef,
      );
      if (!snapshot || !existingIntent) throw new Error('Memory deletion fence read is incomplete');
      const row = this.owned(snapshot, agentId);
      if (!row) {
        if (
          existingIntent.exists &&
          existingIntent.get('memoryId') === memoryId &&
          existingIntent.get('agentId') === agentId &&
          typeof existingIntent.get('contentHash') === 'string'
        )
          return {
            status: 'updated',
            memory: { id: memoryId, agentId, contentHash: existingIntent.get('contentHash') },
          };
        return { status: 'not-found' };
      }
      const tombstoneRef = this.store.doc('memoryTombstones', row.contentHash);
      const hashRef = this.store.doc('memoryContentHashes', row.contentHash);
      const [tombstone, hash] = await tx.getAll(tombstoneRef, hashRef);
      const now = this.store.now();
      if (!tombstone?.exists)
        tx.create(
          tombstoneRef,
          encodeRecord({
            id: row.contentHash,
            contentHash: row.contentHash,
            reason,
            createdAt: now,
          }),
        );
      if (hash?.exists && hash.get('memoryId') === row.id) tx.delete(hashRef);
      // This intent is the durable per-memory deletion fence. Every Firestore
      // graph projection writer must read it in the same transaction and refuse
      // writes while it exists; that writer port remains a cutover prerequisite.
      tx.set(
        intentRef,
        encodeRecord({
          memoryId: row.id,
          agentId,
          contentHash: row.contentHash,
          reason,
          createdAt: now,
          cleanupCompletedAt: null,
        }),
      );
      tx.delete(snapshot.ref);
      this.invalidateOwnerCard(tx, agentId, now);
      return {
        status: 'updated',
        memory: { id: row.id, agentId: row.agentId, contentHash: row.contentHash },
      };
    });
  }

  async setProminence(memoryId: string, level: MemoryProminence): Promise<MemoryMutation> {
    return this.mutateExisting(memoryId, ({ tx, row, snapshot, agentId, now }) => {
      const patch =
        level === 'always'
          ? { pinned: true }
          : level === 'minor'
            ? { pinned: false, importance: 1 }
            : { pinned: false, importance: (row.importance ?? 3) <= 1 ? 3 : (row.importance ?? 3) };
      tx.update(snapshot.ref, patch);
      this.invalidateOwnerCard(tx, agentId, now);
      return { status: 'updated', memory: managed(row) };
    });
  }

  async approveQuarantined(memoryId: string): Promise<MemoryMutation> {
    return this.mutateExisting(memoryId, ({ tx, row, snapshot, agentId, now }) => {
      tx.update(snapshot.ref, { quarantined: false });
      this.invalidateOwnerCard(tx, agentId, now);
      return { status: 'updated', memory: managed(row) };
    });
  }

  async create(
    input: Parameters<ProfileMemoryManagementRepository['create']>[0],
  ): Promise<MemoryMutation> {
    validateCreate(input);
    validateEmbedding(this.embeddingSpace, input.embedding);
    if (input.embeddingSpaceKey !== embeddingSpaceKey(this.embeddingSpace))
      throw new Error('Memory embedding space changed');
    const id = randomUUID();
    const retrievalRevision = randomUUID();
    return this.store.db.runTransaction(async (tx) => {
      const agentId = await this.configuredAgent(tx);
      const memoryRef = this.store.doc('memories', id);
      const hashRef = this.store.doc('memoryContentHashes', input.contentHash);
      const tombstoneRef = this.store.doc('memoryTombstones', input.contentHash);
      const contactRef = this.store.doc('contacts', input.subjectContactId);
      const [memorySnapshot, hash, tombstone, contact] = await tx.getAll(
        memoryRef,
        hashRef,
        tombstoneRef,
        contactRef,
      );
      if (tombstone?.exists) return { status: 'tombstoned' };
      if (!contact?.exists || contact.get('id') !== input.subjectContactId)
        return { status: 'not-found' };
      if (hash?.exists) {
        const duplicateId = hash.get('memoryId');
        if (typeof duplicateId === 'string' && duplicateId) {
          const duplicateSnapshot = await tx.get(this.store.doc('memories', duplicateId));
          const duplicate = this.owned(duplicateSnapshot, agentId);
          if (duplicate?.contentHash === input.contentHash)
            return { status: 'duplicate', memory: managed(duplicate) };
        }
        return { status: 'duplicate' };
      }
      if (memorySnapshot?.exists) return { status: 'duplicate' };

      const now = this.store.now();
      const row: Records['memories'] = {
        id,
        createdAt: now,
        agentId,
        expiresAt: null,
        embedding: input.embedding,
        embeddingSpaceKey: input.embeddingSpaceKey ?? null,
        sourceTaskId: null,
        kind: 'fact',
        confidence: '1.00',
        contentHash: input.contentHash,
        goalId: null,
        originTrust: 'owner',
        category: 'knowledge',
        content: input.content,
        importance: input.importance,
        quarantined: false,
        subjectContactId: input.subjectContactId,
        domain: input.domain ?? null,
        validFrom: null,
        validUntil: null,
        supersededById: null,
        ownerConfirmed: true,
        pinned: input.pinned,
        source: 'manual',
        lastAccessedAt: null,
        lastConsolidatedAt: null,
      };
      tx.create(
        memoryRef,
        encodeRecord({
          ...row,
          embedding: FieldValue.vector(input.embedding),
          embeddingSpaceKey: input.embeddingSpaceKey,
          embeddingSpace: embeddingSpaceKey(this.embeddingSpace),
          retrievalRevision,
        }),
      );
      tx.create(hashRef, { memoryId: id });
      this.invalidateOwnerCard(tx, agentId, now);
      return { status: 'updated', memory: managed(row) };
    });
  }
}
