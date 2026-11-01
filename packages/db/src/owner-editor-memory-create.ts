import { createHash } from 'node:crypto';
import {
  type OwnerEditorClaim,
  type OwnerEditorReply,
  type OwnerEditorScope,
  type OwnerMemoryCreationTarget,
  ownerEditorCommitRevision,
  type PreparedOwnerMemoryCreation,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { postgresOwnerEditorContact } from './owner-editor-people.js';
import {
  beginPostgresOwnerEditorWrite,
  completePostgresOwnerEditorWrite,
  readPostgresOwnerEditorIssuanceContext,
} from './owner-editor-repository.js';
import {
  createPostgresProfileMemoryInTransaction,
  invalidatePostgresProfileOwnerCard,
} from './profile-memory-management-repository.js';
import { memories, memoryTombstones } from './schema.js';

export async function readPostgresOwnerMemoryCreationTarget(
  db: Db,
  ownerId: string,
  subjectContactId: string,
  contentHash: string,
  scope: OwnerEditorScope,
): Promise<OwnerMemoryCreationTarget | null> {
  if (
    scope.ownerId !== ownerId ||
    scope.command !== 'create_owner_memory' ||
    scope.targetId !== subjectContactId
  )
    return null;
  return db.transaction(async (tx) => {
    const issuance = await readPostgresOwnerEditorIssuanceContext(tx, ownerId);
    if (
      !issuance ||
      issuance.epoch !== scope.epoch ||
      issuance.privacyGeneration !== scope.privacyGeneration
    )
      return null;
    const subject = await postgresOwnerEditorContact(tx, ownerId, subjectContactId);
    if (!subject || subject.trust === 'owner' || subjectContactId === ownerId) return null;
    const [tombstone] = await tx
      .select({ id: memoryTombstones.id })
      .from(memoryTombstones)
      .where(eq(memoryTombstones.contentHash, contentHash))
      .limit(1);
    if (tombstone)
      return {
        ownerId,
        subjectContactId,
        subjectRevision: subject.revision,
        subjectTrust: subject.trust,
        status: 'tombstoned',
      };
    const [duplicate] = await tx
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.contentHash, contentHash))
      .limit(1);
    return {
      ownerId,
      subjectContactId,
      subjectRevision: subject.revision,
      subjectTrust: subject.trust,
      status: duplicate ? 'duplicate' : 'eligible',
    };
  });
}

export function commitPostgresOwnerMemoryCreation(
  db: Db,
  claim: OwnerEditorClaim,
  prepared: PreparedOwnerMemoryCreation,
  now: Date,
): Promise<OwnerEditorReply> {
  const claimExpiresAt = new Date(claim.claimExpiresAt.getTime());
  const sealedClaim = Object.freeze({
    ...claim,
    claimExpiresAt,
    scope: Object.freeze({ ...claim.scope }),
  });
  const sealed = Object.freeze({
    ...prepared,
    embedding: Object.freeze([...prepared.embedding]) as unknown as number[],
  });
  const sealedNow = new Date(now.getTime());
  if (
    !Number.isFinite(sealedNow.getTime()) ||
    !Number.isFinite(claimExpiresAt.getTime()) ||
    !Number.isFinite(sealedClaim.scope.issuedAt) ||
    !Number.isFinite(sealedClaim.scope.expiresAt) ||
    sealedClaim.scope.command !== 'create_owner_memory' ||
    sealedClaim.scope.targetId !== sealed.subjectContactId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      sealed.memoryId,
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      sealed.subjectContactId,
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      sealed.retrievalRevision,
    ) ||
    !/^[a-f0-9]{64}$/.test(sealed.expectedSubjectRevision) ||
    !/^[a-f0-9]{64}$/.test(sealed.contentHash) ||
    createHash('sha256').update(sealed.content).digest('hex') !== sealed.contentHash ||
    sealed.content.length < 3 ||
    sealed.content.length > 4000 ||
    sealed.content !== sealed.content.trim() ||
    !['identity', 'work', 'home', 'relationships', 'preferences', 'health', 'other'].includes(
      sealed.domain,
    ) ||
    !Number.isInteger(sealed.importance) ||
    sealed.importance < 1 ||
    sealed.importance > 5 ||
    typeof sealed.pinned !== 'boolean' ||
    sealed.embedding.length !== 1536 ||
    !sealed.embedding.every(Number.isFinite) ||
    !sealed.embedding.some((value) => value !== 0) ||
    !/^[a-f0-9]{64}$/.test(sealed.embeddingSpaceKey)
  )
    return Promise.reject(new Error('Prepared memory creation failed validation'));
  return db.transaction(
    async (tx) => {
      const admitted = await beginPostgresOwnerEditorWrite(tx, sealedClaim, sealedNow);
      if (admitted.kind === 'reply') return admitted.reply;
      const finish = (result: Parameters<typeof completePostgresOwnerEditorWrite>[2]) =>
        completePostgresOwnerEditorWrite(tx, admitted, result, sealedNow);
      if (sealedClaim.scope.targetId !== sealed.subjectContactId)
        throw new Error('Prepared memory creation does not match its claim');
      const subject = await postgresOwnerEditorContact(
        tx,
        sealedClaim.scope.ownerId,
        sealed.subjectContactId,
        true,
      );
      if (!subject) return finish({ outcome: 'conflict', reason: 'subject_changed' });
      if (subject.trust === 'owner' || sealed.subjectContactId === sealedClaim.scope.ownerId)
        return finish({ outcome: 'conflict', reason: 'person_note_requires_non_owner_subject' });
      if (subject.revision !== sealed.expectedSubjectRevision)
        return finish({ outcome: 'conflict', reason: 'subject_changed' });
      const created = await createPostgresProfileMemoryInTransaction(
        tx as unknown as Db,
        sealedClaim.scope.ownerId,
        {
          memoryId: sealed.memoryId,
          content: sealed.content,
          contentHash: sealed.contentHash,
          embedding: sealed.embedding,
          embeddingSpaceKey: sealed.embeddingSpaceKey,
          importance: sealed.importance,
          pinned: sealed.pinned,
          subjectContactId: sealed.subjectContactId,
          domain: sealed.domain,
        },
      );
      if (created.status !== 'updated') {
        const reason =
          created.status === 'tombstoned'
            ? 'memory_forgotten'
            : created.status === 'duplicate'
              ? 'memory_duplicate'
              : 'subject_changed';
        return finish({ outcome: 'conflict', reason });
      }
      await invalidatePostgresProfileOwnerCard(tx);
      const ids = { memoryId: sealed.memoryId };
      return finish({
        outcome: 'saved',
        ids,
        revision: ownerEditorCommitRevision(claim, ids),
        refreshPending: true,
      });
    },
    { isolationLevel: 'serializable' },
  );
}
