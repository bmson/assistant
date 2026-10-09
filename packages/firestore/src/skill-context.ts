import {
  type EmbeddingSpace,
  MAX_SKILL_RECALL_LIMIT,
  type Records,
  type SkillContextMatch,
  type SkillContextRepository,
  skillRecallBounds,
  snapshotEmbeddingSpace,
  validateEmbedding,
  validateSkillEmbeddingSpace,
} from '@assistant/persistence';
import { embeddingSpaceKey } from './memory.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

/** Executor-facing learned-skill retrieval and lifecycle counters for Firestore. */
export class FirestoreSkillContextRepository implements SkillContextRepository {
  readonly kind = 'skill-context-repository' as const;
  readonly space: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    space: EmbeddingSpace,
  ) {
    this.space = snapshotEmbeddingSpace(space);
    validateSkillEmbeddingSpace(this.space);
  }

  async recall(
    input: Parameters<SkillContextRepository['recall']>[0],
  ): Promise<SkillContextMatch[]> {
    validateEmbedding(this.space, input.embedding);
    if (input.embeddingSpaceKey !== embeddingSpaceKey(this.space))
      throw new Error('Learned-skill query embedding space does not match the configured space');
    const { limit, minSimilarity } = skillRecallBounds(input);
    const candidateLimit = Math.min(MAX_SKILL_RECALL_LIMIT, limit * 4);
    const candidates = await this.store
      .collection('skills')
      .where('agentId', '==', input.agentId)
      .where('deprecated', '==', false)
      .where('embeddingSpace', '==', embeddingSpaceKey(this.space))
      .findNearest({
        vectorField: 'embedding',
        queryVector: input.embedding,
        distanceMeasure: 'COSINE',
        limit: candidateLimit,
        distanceResultField: 'vectorDistance',
      })
      .get();
    if (candidates.empty) return [];

    // Re-read the candidates together so a concurrent deprecation or owner change
    // cannot leak a stale vector-query hit into the executor prompt.
    return this.store.db.runTransaction(
      async (tx) => {
        const snapshots = await tx.getAll(...candidates.docs.map((candidate) => candidate.ref));
        return snapshots
          .flatMap((snapshot, index) => {
            const candidate = candidates.docs[index];
            if (
              !snapshot.exists ||
              !candidate?.updateTime ||
              !snapshot.updateTime ||
              !candidate.updateTime.isEqual(snapshot.updateTime) ||
              snapshot.get('agentId') !== input.agentId ||
              snapshot.get('deprecated') !== false ||
              snapshot.get('embeddingSpace') !== embeddingSpaceKey(this.space)
            )
              return [];
            const similarity = 1 - Number(candidate.get('vectorDistance'));
            if (!Number.isFinite(similarity) || similarity < minSimilarity) return [];
            const row = decodeRecord<
              Records['skills'] & { embeddingSpace?: string; vectorDistance?: number }
            >(snapshot.data());
            const {
              embedding: _embedding,
              embeddingSpace: _space,
              vectorDistance: _distance,
              ...skill
            } = row;
            if (
              skill.id !== snapshot.get('id') ||
              candidate.ref.id !== documentKey(skill.id) ||
              skill.agentId !== input.agentId
            )
              return [];
            try {
              validateEmbedding(this.space, row.embedding ?? []);
            } catch {
              return [];
            }
            return [{ skill, similarity }];
          })
          .sort(
            (left, right) =>
              right.similarity - left.similarity ||
              String(left.skill.id).localeCompare(String(right.skill.id)),
          )
          .slice(0, limit);
      },
      { readOnly: true },
    );
  }

  async bumpUse(input: Parameters<SkillContextRepository['bumpUse']>[0]): Promise<void> {
    const ids = [...new Set(input.ids)];
    if (ids.length === 0) return;
    if (ids.length > MAX_SKILL_RECALL_LIMIT) throw new Error('Too many learned skills to update');
    await this.store.db.runTransaction(async (tx) => {
      const refs = ids.map((id) => this.store.doc('skills', id));
      const snapshots = await tx.getAll(...refs);
      for (let index = 0; index < snapshots.length; index++) {
        const snapshot = snapshots[index];
        const ref = refs[index];
        if (
          !snapshot?.exists ||
          !ref ||
          snapshot.get('id') !== ids[index] ||
          snapshot.get('agentId') !== input.agentId
        )
          continue;
        const useCount = Number(snapshot.get('useCount'));
        if (!Number.isSafeInteger(useCount) || useCount < 0)
          throw new Error('Invalid learned-skill use count');
        tx.update(ref, { useCount: useCount + 1 });
      }
    });
  }

  async recordOutcome(
    input: Parameters<SkillContextRepository['recordOutcome']>[0],
  ): Promise<void> {
    const ref = this.store.doc('skills', input.id);
    await this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (
        !snapshot.exists ||
        snapshot.get('id') !== input.id ||
        snapshot.get('agentId') !== input.agentId
      )
        return;
      if (input.success) {
        const successCount = Number(snapshot.get('successCount'));
        if (!Number.isSafeInteger(successCount) || successCount < 0)
          throw new Error('Invalid learned-skill success count');
        tx.update(ref, { successCount: successCount + 1, lastVerifiedAt: this.store.now() });
        return;
      }
      const failureCount = Number(snapshot.get('failureCount'));
      if (!Number.isSafeInteger(failureCount) || failureCount < 0)
        throw new Error('Invalid learned-skill failure count');
      const nextFailureCount = failureCount + 1;
      tx.update(ref, { failureCount: nextFailureCount, deprecated: nextFailureCount >= 3 });
    });
  }
}
