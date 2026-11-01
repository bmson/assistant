import { createHash } from 'node:crypto';
import {
  type EmbeddingSpace,
  type OwnerEditorClaim,
  type OwnerEditorReply,
  type OwnerEditorScope,
  type OwnerMemoryCreationTarget,
  ownerEditorCommitRevision,
  type PreparedOwnerMemoryCreation,
  validateEmbedding,
} from '@assistant/persistence';
import { embeddingSpaceKey } from './memory.js';
import { readFirestoreOwnerEditorContact } from './owner-editor-graph.js';
import {
  beginFirestoreOwnerEditorWrite,
  completeFirestoreOwnerEditorWrite,
  readFirestoreOwnerEditorIssuanceContext,
} from './owner-editor-repository.js';
import { FirestoreProfileMemoryManagementRepository } from './profile-memory-management.js';
import type { InstallationStore } from './store.js';

const ownerMemoryDomains: readonly string[] = [
  'identity',
  'work',
  'home',
  'relationships',
  'preferences',
  'health',
  'other',
];

/** Bounded pre-provider eligibility check; no writes or authority are issued here. */
export async function readFirestoreOwnerMemoryCreationTarget(
  store: InstallationStore,
  ownerId: string,
  subjectContactId: string,
  contentHash: string,
  scope: OwnerEditorScope,
): Promise<OwnerMemoryCreationTarget | null> {
  if (
    scope.ownerId !== ownerId ||
    scope.command !== 'create_owner_memory' ||
    scope.targetId !== subjectContactId ||
    subjectContactId === ownerId ||
    !/^[a-f0-9]{64}$/.test(contentHash)
  )
    return null;
  return store.db.runTransaction(async (tx) => {
    const context = await readFirestoreOwnerEditorIssuanceContext(store, ownerId, tx);
    if (
      !context ||
      context.epoch !== scope.epoch ||
      context.privacyGeneration !== scope.privacyGeneration
    )
      return null;
    const contact = await readFirestoreOwnerEditorContact(store, ownerId, subjectContactId, tx);
    if (!contact || contact.trust === 'owner') return null;
    const [tombstone, hash] = await tx.getAll(
      store.doc('memoryTombstones', contentHash),
      store.doc('memoryContentHashes', contentHash),
    );
    if (!tombstone || !hash) throw new Error('Memory creation hash proof is incomplete');
    return {
      ownerId,
      subjectContactId,
      subjectRevision: contact.revision,
      subjectTrust: contact.trust,
      status: tombstone.exists ? 'tombstoned' : hash.exists ? 'duplicate' : 'eligible',
    };
  });
}

/** One native transaction for claim, target recheck, note/hash/card writes and receipt. */
export function commitFirestoreOwnerMemoryCreation(
  store: InstallationStore,
  embeddingSpace: EmbeddingSpace,
  claim: OwnerEditorClaim,
  prepared: PreparedOwnerMemoryCreation,
  now: Date,
): Promise<OwnerEditorReply> {
  const stableClaim = Object.freeze({
    ...claim,
    scope: Object.freeze({ ...claim.scope }),
    claimExpiresAt: new Date(claim.claimExpiresAt),
  });
  const stablePrepared: PreparedOwnerMemoryCreation = Object.freeze({
    ...prepared,
    embedding: Object.freeze([...prepared.embedding]) as unknown as number[],
  });
  const stableNow = new Date(now);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    stableClaim.scope.command !== 'create_owner_memory' ||
    !uuid.test(stableClaim.scope.ownerId) ||
    !uuid.test(stableClaim.scope.epoch) ||
    !uuid.test(stableClaim.scope.operationId) ||
    !uuid.test(stableClaim.scope.nonce) ||
    !/^[a-f0-9]{64}$/.test(stableClaim.scope.sessionDigest) ||
    !/^[a-f0-9]{64}$/.test(stableClaim.requestHash) ||
    !uuid.test(stableClaim.claimToken) ||
    !Number.isInteger(stableClaim.statusVersion) ||
    stableClaim.statusVersion < 1 ||
    !Number.isFinite(stableClaim.scope.issuedAt) ||
    !Number.isFinite(stableClaim.scope.expiresAt) ||
    stableClaim.scope.expiresAt <= stableClaim.scope.issuedAt ||
    !Number.isFinite(stableNow.getTime()) ||
    !Number.isFinite(stableClaim.claimExpiresAt.getTime()) ||
    stableClaim.claimExpiresAt.getTime() <= stableClaim.scope.issuedAt ||
    stableClaim.claimExpiresAt.getTime() > stableClaim.scope.expiresAt ||
    !stablePrepared.memoryId ||
    !uuid.test(stablePrepared.memoryId) ||
    !uuid.test(stablePrepared.retrievalRevision) ||
    !stablePrepared.subjectContactId ||
    !uuid.test(stablePrepared.subjectContactId) ||
    !/^[a-f0-9]{64}$/.test(stablePrepared.expectedSubjectRevision) ||
    !stablePrepared.content ||
    stablePrepared.content.length < 3 ||
    stablePrepared.content.length > 4000 ||
    stablePrepared.content !== stablePrepared.content.trim() ||
    !stablePrepared.contentHash ||
    !/^[a-f0-9]{64}$/.test(stablePrepared.contentHash) ||
    !ownerMemoryDomains.includes(stablePrepared.domain) ||
    !Number.isInteger(stablePrepared.importance) ||
    stablePrepared.importance < 1 ||
    stablePrepared.importance > 5 ||
    typeof stablePrepared.pinned !== 'boolean'
  )
    throw new Error('Prepared memory creation failed validation');
  if (stableClaim.scope.targetId !== stablePrepared.subjectContactId)
    throw new Error('Memory creation claim target mismatch');
  if (
    createHash('sha256').update(stablePrepared.content).digest('hex') !== stablePrepared.contentHash
  )
    throw new Error('Prepared memory content hash mismatch');
  const repository = new FirestoreProfileMemoryManagementRepository(store, embeddingSpace);
  validateEmbedding(repository.embeddingSpace, stablePrepared.embedding);
  if (stablePrepared.embeddingSpaceKey !== embeddingSpaceKey(repository.embeddingSpace))
    throw new Error('Memory embedding space changed');
  return store.db.runTransaction(async (tx) => {
    const admitted = await beginFirestoreOwnerEditorWrite(store, tx, stableClaim, stableNow);
    if (admitted.kind === 'reply') return admitted.reply;
    const finish = (result: Parameters<typeof completeFirestoreOwnerEditorWrite>[3]) =>
      completeFirestoreOwnerEditorWrite(store, tx, admitted, result, stableNow);
    // Every read is complete before createRecordInTransaction stages the first write.
    const contact = await readFirestoreOwnerEditorContact(
      store,
      stableClaim.scope.ownerId,
      stablePrepared.subjectContactId,
      tx,
    );
    const memoryRef = store.doc('memories', stablePrepared.memoryId);
    const hashRef = store.doc('memoryContentHashes', stablePrepared.contentHash);
    const tombstoneRef = store.doc('memoryTombstones', stablePrepared.contentHash);
    const [memory, hash, tombstone] = await tx.getAll(memoryRef, hashRef, tombstoneRef);
    if (!memory || !hash || !tombstone)
      throw new Error('Memory creation target proof is incomplete');
    if (
      !contact ||
      contact.id !== stablePrepared.subjectContactId ||
      contact.revision !== stablePrepared.expectedSubjectRevision
    )
      return finish({ outcome: 'conflict', reason: 'memory_subject_changed' });
    if (stablePrepared.subjectContactId === stableClaim.scope.ownerId || contact.trust === 'owner')
      return finish({ outcome: 'conflict', reason: 'memory_subject_not_person' });
    if (tombstone.exists)
      return finish({ outcome: 'conflict', reason: 'memory_content_tombstoned' });
    if (hash.exists) return finish({ outcome: 'conflict', reason: 'memory_content_duplicate' });
    if (memory.exists) return finish({ outcome: 'conflict', reason: 'memory_target_exists' });

    const created = repository.createRecordInTransaction(
      tx,
      stableClaim.scope.ownerId,
      stablePrepared,
      stableNow,
    );
    if (created.status !== 'updated')
      return finish({ outcome: 'conflict', reason: 'memory_creation_rejected' });
    const ids = { memoryId: stablePrepared.memoryId };
    return finish({
      outcome: 'saved',
      ids,
      revision: ownerEditorCommitRevision(stableClaim, ids),
      refreshPending: true,
    });
  });
}
