import type { DocumentSearchRepository } from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { documentChunks, documents } from './schema.js';

/** pgvector passage search over ready documents, as `documents.search` has always run it. */
export function createPostgresDocumentSearchRepository(db: Db): DocumentSearchRepository {
  return {
    kind: 'document-search-repository',
    async search(input) {
      const vec = JSON.stringify(input.embedding);
      const filters = [
        eq(documentChunks.agentId, input.agentId),
        eq(documentChunks.embeddingSpaceKey, input.embeddingSpaceKey),
        eq(documents.status, 'ready'),
        sql`1 - (${documentChunks.embedding} <=> ${vec}::vector) >= ${input.minSimilarity}`,
      ];
      if (input.documentId) filters.push(eq(documentChunks.documentId, input.documentId));
      return db
        .select({
          documentId: documentChunks.documentId,
          title: documents.title,
          source: documents.source,
          trust: documents.trust,
          chunkIndex: documentChunks.chunkIndex,
          text: documentChunks.text,
          similarity: sql<number>`1 - (${documentChunks.embedding} <=> ${vec}::vector)`,
        })
        .from(documentChunks)
        .innerJoin(documents, eq(documents.id, documentChunks.documentId))
        .where(and(...filters))
        .orderBy(sql`${documentChunks.embedding} <=> ${vec}::vector`)
        .limit(input.limit);
    },
  };
}
