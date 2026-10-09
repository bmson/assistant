import {
  type DocumentSearchHit,
  type DocumentSearchRepository,
  type EmbeddingSpace,
  type Records,
  snapshotEmbeddingSpace,
  validateEmbedding,
  validateSkillEmbeddingSpace,
} from '@assistant/persistence';
import type { Query } from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

/** Nearest chunks read per search before ready-document and similarity filtering. */
const CANDIDATE_LIMIT = 50;

/**
 * `documents.search` on Firestore: a native vector search over the owner's
 * chunks in the installation's embedding space, rechecked against each
 * chunk's document (owned and ready) before any passage is returned.
 */
export class FirestoreDocumentSearchRepository implements DocumentSearchRepository {
  readonly kind = 'document-search-repository' as const;
  private readonly spaceKey: string;
  readonly space: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
    space: EmbeddingSpace,
  ) {
    this.space = snapshotEmbeddingSpace(space);
    validateSkillEmbeddingSpace(this.space);
    this.spaceKey = embeddingSpaceKey(this.space);
  }

  async search(
    input: Parameters<DocumentSearchRepository['search']>[0],
  ): Promise<DocumentSearchHit[]> {
    if (input.agentId !== this.agentId)
      throw new Error('Document search is outside the configured owner');
    if (input.embeddingSpaceKey !== this.spaceKey)
      throw new Error('Document query embedding space does not match the configured space');
    validateEmbedding(this.space, input.embedding);
    let query: Query = this.store
      .collection('documentChunks')
      .where('agentId', '==', input.agentId);
    if (input.documentId) query = query.where('documentId', '==', input.documentId);
    const nearest = await query
      .where('embeddingSpace', '==', this.spaceKey)
      .findNearest({
        vectorField: 'embedding',
        queryVector: input.embedding,
        distanceMeasure: 'COSINE',
        limit: Math.min(CANDIDATE_LIMIT, Math.max(input.limit * 4, input.limit)),
        distanceResultField: 'vectorDistance',
      })
      .get();
    const chunks = nearest.docs.flatMap((doc) => {
      const row = decodeRecord<Records['documentChunks']>(doc.data());
      const similarity = 1 - Number(doc.get('vectorDistance'));
      return row.agentId === input.agentId &&
        typeof row.documentId === 'string' &&
        typeof row.text === 'string' &&
        Number.isFinite(similarity) &&
        similarity >= input.minSimilarity
        ? [{ row, similarity }]
        : [];
    });
    if (chunks.length === 0) return [];
    const documentIds = [...new Set(chunks.map(({ row }) => row.documentId))];
    const parents = await this.store.db.getAll(
      ...documentIds.map((id) => this.store.doc('documents', id)),
    );
    const ready = new Map<string, Records['documents']>();
    for (const snapshot of parents) {
      if (!snapshot.exists) continue;
      const document = decodeRecord<Records['documents']>(snapshot.data());
      if (
        documentKey(document.id) === snapshot.id &&
        document.agentId === input.agentId &&
        document.status === 'ready'
      )
        ready.set(document.id, document);
    }
    return chunks
      .flatMap(({ row, similarity }) => {
        const document = ready.get(row.documentId);
        return document
          ? [
              {
                documentId: row.documentId,
                title: document.title,
                source: document.source,
                trust: document.trust,
                chunkIndex: row.chunkIndex,
                text: row.text,
                similarity,
              },
            ]
          : [];
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, input.limit);
  }
}
