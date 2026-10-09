import {
  type EmbeddingSpace,
  MAX_SUPERSEDE_CANDIDATES,
  type MemorySupersedeRepository,
  type Records,
  SUPERSEDE_SIMILARITY_FLOOR,
  type SupersedeFact,
  snapshotEmbeddingSpace,
  validateEmbedding,
} from '@assistant/persistence';
import type { DocumentSnapshot, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import { decodeMemoryRecord } from './memory-record.js';
import { documentKey, encodeRecord, type InstallationStore } from './store.js';

const VECTOR_CANDIDATE_LIMIT = MAX_SUPERSEDE_CANDIDATES * 4;

type Memory = Records['memories'];

function live(row: Memory, now: Date): boolean {
  return !row.supersededById && (!row.expiresAt || row.expiresAt > now);
}

function sameSnapshot(source: QueryDocumentSnapshot, reread: DocumentSnapshot): boolean {
  return Boolean(
    reread.exists &&
      source.updateTime &&
      reread.updateTime &&
      source.updateTime.isEqual(reread.updateTime),
  );
}

function fact(row: Memory): SupersedeFact {
  return {
    id: row.id,
    content: row.content,
    confidence: row.confidence,
    ownerConfirmed: row.ownerConfirmed,
    createdAt: row.createdAt,
  };
}

/** Firestore storage half of bounded, write-time memory supersession. */
export class FirestoreMemorySupersedeRepository implements MemorySupersedeRepository {
  readonly kind = 'memory-supersede-repository' as const;
  readonly space: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    space: EmbeddingSpace,
  ) {
    this.space = snapshotEmbeddingSpace(space);
  }

  async writtenFact(input: { agentId: string; id: string }) {
    if (!input.agentId || !input.id) return null;
    const ref = this.store.doc('memories', input.id);
    return this.store.db.runTransaction(
      async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) return null;
        const row = decodeMemoryRecord(snapshot.data());
        const tombstone = await tx.get(this.store.doc('memoryTombstones', row.contentHash));
        const now = this.store.now();
        if (
          tombstone.exists ||
          row.id !== input.id ||
          documentKey(row.id) !== snapshot.id ||
          row.agentId !== input.agentId ||
          row.category !== 'knowledge' ||
          row.quarantined ||
          !live(row, now) ||
          (row.embedding && snapshot.get('embeddingSpace') !== embeddingSpaceKey(this.space))
        )
          return null;
        if (row.embedding) validateEmbedding(this.space, row.embedding);
        return {
          ...fact(row),
          subjectContactId: row.subjectContactId,
          embedding: row.embedding,
        };
      },
      { readOnly: true },
    );
  }

  async candidates(input: {
    agentId: string;
    newFactId: string;
    embedding: number[];
    subjectContactId: string | null;
  }) {
    if (!input.agentId || !input.newFactId) throw new Error('Invalid supersession candidate query');
    validateEmbedding(this.space, input.embedding);
    const snapshots = await this.store
      .collection('memories')
      .where('agentId', '==', input.agentId)
      .where('category', '==', 'knowledge')
      .where('quarantined', '==', false)
      .where('supersededById', '==', null)
      .where('subjectContactId', '==', input.subjectContactId)
      .where('embeddingSpace', '==', embeddingSpaceKey(this.space))
      .findNearest({
        vectorField: 'embedding',
        queryVector: input.embedding,
        distanceMeasure: 'COSINE',
        limit: VECTOR_CANDIDATE_LIMIT,
        distanceResultField: 'vectorDistance',
      })
      .get();
    if (snapshots.empty) return [];
    return this.store.db.runTransaction(
      async (tx) => {
        const records = await tx.getAll(
          ...snapshots.docs.flatMap((snapshot) => [
            snapshot.ref,
            this.store.doc('memoryTombstones', snapshot.get('contentHash')),
          ]),
        );
        const now = this.store.now();
        const candidates: Array<SupersedeFact & { similarity: number }> = [];
        for (let index = 0; index < snapshots.docs.length; index++) {
          const source = snapshots.docs[index];
          const snapshot = records[index * 2];
          const tombstone = records[index * 2 + 1];
          if (!source || !snapshot || !sameSnapshot(source, snapshot) || tombstone?.exists)
            continue;
          const row = decodeMemoryRecord(snapshot.data());
          const similarity = 1 - Number(source.get('vectorDistance'));
          if (
            row.id === input.newFactId ||
            documentKey(row.id) !== snapshot.id ||
            row.agentId !== input.agentId ||
            row.category !== 'knowledge' ||
            row.quarantined ||
            row.subjectContactId !== input.subjectContactId ||
            !live(row, now) ||
            snapshot.get('embeddingSpace') !== embeddingSpaceKey(this.space) ||
            !Number.isFinite(similarity) ||
            similarity < SUPERSEDE_SIMILARITY_FLOOR
          )
            continue;
          candidates.push({ ...fact(row), similarity });
          if (candidates.length === MAX_SUPERSEDE_CANDIDATES) break;
        }
        return candidates;
      },
      { readOnly: true },
    );
  }

  async retire(input: { agentId: string; replacementId: string; ids: string[] }) {
    const ids = [...new Set(input.ids)].filter((id) => id && id !== input.replacementId);
    if (!input.agentId || !input.replacementId || ids.length > MAX_SUPERSEDE_CANDIDATES)
      throw new Error('Invalid supersession retirement');
    if (ids.length === 0) return [];
    return this.store.db.runTransaction(async (tx) => {
      const replacementRef = this.store.doc('memories', input.replacementId);
      const replacementSnapshot = await tx.get(replacementRef);
      if (!replacementSnapshot.exists) return [];
      const replacement = decodeMemoryRecord(replacementSnapshot.data());
      const replacementTombstone = await tx.get(
        this.store.doc('memoryTombstones', replacement.contentHash),
      );
      const targetRefs = ids.map((id) => this.store.doc('memories', id));
      const targetSnapshots = await tx.getAll(...targetRefs);
      const tombstones = await tx.getAll(
        ...targetSnapshots.map((snapshot) =>
          this.store.doc(
            'memoryTombstones',
            snapshot.exists ? snapshot.get('contentHash') : `missing-${snapshot.id}`,
          ),
        ),
      );
      const now = this.store.now();
      if (
        replacementTombstone.exists ||
        replacement.id !== input.replacementId ||
        documentKey(replacement.id) !== replacementSnapshot.id ||
        replacement.agentId !== input.agentId ||
        replacement.category !== 'knowledge' ||
        replacement.quarantined ||
        replacementSnapshot.get('embeddingSpace') !== embeddingSpaceKey(this.space) ||
        !live(replacement, now)
      )
        return [];

      const retired: string[] = [];
      for (let index = 0; index < targetSnapshots.length; index++) {
        const snapshot = targetSnapshots[index];
        if (!snapshot?.exists || tombstones[index]?.exists) continue;
        const row = decodeMemoryRecord(snapshot.data());
        if (
          row.id !== ids[index] ||
          documentKey(row.id) !== snapshot.id ||
          row.agentId !== input.agentId ||
          row.category !== 'knowledge' ||
          row.quarantined ||
          row.subjectContactId !== replacement.subjectContactId ||
          snapshot.get('embeddingSpace') !== embeddingSpaceKey(this.space) ||
          !live(row, now)
        )
          continue;
        tx.update(snapshot.ref, encodeRecord({ expiresAt: now, supersededById: replacement.id }));
        retired.push(row.id);
      }
      if (retired.length > 0) {
        tx.set(
          this.store.doc('ownerCards', input.agentId),
          encodeRecord({
            agentId: input.agentId,
            content: '',
            compiledAt: now,
            invalidatedAt: now,
          }),
        );
      }
      return retired;
    });
  }
}
