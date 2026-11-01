import type { ProfileLibraryRepository } from '@assistant/persistence';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Db } from './client.js';
import { contacts, knowledgeGraphSources, memories } from './schema.js';

// Output/transport bound only: PostgreSQL still performs the grouped query.
export const PROFILE_LIBRARY_FILTER_MAX_ROWS = 1_000;
export class PostgresProfileLibraryFilterLimitError extends Error {
  readonly code = 'POSTGRES_PROFILE_LIBRARY_FILTER_LIMIT';
  constructor() {
    super('Library filters are unavailable because the bounded output limit was reached');
    this.name = 'PostgresProfileLibraryFilterLimitError';
  }
}

function activeConnections(agentId: string, extractionVersion: number): SQL<number> {
  return sql<number>`(
    SELECT count(*)::int
    FROM knowledge_graph_relations AS active_relation
    INNER JOIN memories AS active_memory ON active_memory.id = active_relation.source_memory_id
    INNER JOIN knowledge_graph_sources AS active_source ON active_source.memory_id = active_memory.id
    WHERE active_relation.agent_id = ${agentId}
      AND active_relation.source_memory_id = ${memories.id}
      AND active_relation.review_status <> 'rejected'
      AND active_memory.category = 'knowledge'
      AND active_memory.quarantined = false
      AND (active_memory.expires_at IS NULL OR active_memory.expires_at > now())
      AND active_memory.embedding IS NOT NULL
      AND active_source.status = 'ready'
      AND active_source.content_hash = active_memory.content_hash
      AND active_source.extraction_version >= ${extractionVersion}
      AND active_relation.evidence_quote IS NOT NULL
  )`;
}

export function createPostgresProfileLibraryRepository(db: Db): ProfileLibraryRepository {
  return {
    kind: 'profile-library-repository',
    async listFilters(agentId) {
      const [subjectRows, sourceRows] = await Promise.all([
        db
          .select({ id: contacts.id, label: contacts.name, trust: contacts.trust })
          .from(memories)
          .innerJoin(contacts, eq(memories.subjectContactId, contacts.id))
          .where(and(eq(memories.agentId, agentId), eq(memories.category, 'knowledge')))
          .groupBy(contacts.id, contacts.name, contacts.trust)
          .orderBy(asc(contacts.name), asc(contacts.id))
          .limit(PROFILE_LIBRARY_FILTER_MAX_ROWS + 1),
        db
          .select({ source: memories.source })
          .from(memories)
          .where(
            and(
              eq(memories.agentId, agentId),
              eq(memories.category, 'knowledge'),
              isNotNull(memories.source),
            ),
          )
          .groupBy(memories.source)
          .orderBy(asc(memories.source))
          .limit(PROFILE_LIBRARY_FILTER_MAX_ROWS + 1),
      ]);
      if (
        subjectRows.length > PROFILE_LIBRARY_FILTER_MAX_ROWS ||
        sourceRows.length > PROFILE_LIBRARY_FILTER_MAX_ROWS
      ) {
        throw new PostgresProfileLibraryFilterLimitError();
      }
      return {
        subjects: subjectRows,
        sources: sourceRows.flatMap((row) => (row.source ? [row.source] : [])),
      };
    },
    async list(agentId, input) {
      const connectionCount = activeConnections(agentId, input.extractionVersion);
      const stateCondition: SQL =
        input.state === 'review'
          ? eq(memories.quarantined, true)
          : input.filter === 'verified'
            ? sql<boolean>`${memories.quarantined} = false AND ${memories.ownerConfirmed} = true`
            : input.filter === 'untidied'
              ? sql<boolean>`${memories.quarantined} = false AND ${memories.lastConsolidatedAt} IS NULL`
              : eq(memories.quarantined, false);
      const filters = and(
        eq(memories.agentId, agentId),
        eq(memories.category, 'knowledge'),
        or(isNull(memories.expiresAt), gt(memories.expiresAt, input.now)),
        stateCondition,
        input.query
          ? ilike(
              memories.content,
              `%${input.query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`,
            )
          : undefined,
        input.subjectId ? eq(memories.subjectContactId, input.subjectId) : undefined,
        input.domain ? eq(memories.domain, input.domain) : undefined,
        input.source ? eq(memories.source, input.source) : undefined,
        input.ageDays
          ? gt(memories.createdAt, new Date(input.now.getTime() - input.ageDays * 86_400_000))
          : undefined,
        input.connectivity === 'connected'
          ? sql<boolean>`${connectionCount} > 0`
          : input.connectivity === 'unconnected'
            ? sql<boolean>`${connectionCount} = 0`
            : undefined,
      );
      const [totalRow] = await db.select({ value: count() }).from(memories).where(filters);
      const total = Number(totalRow?.value ?? 0);
      const totalPages = Math.max(1, Math.ceil(total / input.pageSize));
      const page = Math.min(Math.max(1, input.page), totalPages);
      const rows = await db
        .select({
          memory: memories,
          subjectId: contacts.id,
          subjectName: contacts.name,
          subjectTrust: contacts.trust,
          connectionCount,
          sourceStatus: knowledgeGraphSources.status,
          sourceContentHash: knowledgeGraphSources.contentHash,
          sourceExtractionVersion: knowledgeGraphSources.extractionVersion,
        })
        .from(memories)
        .leftJoin(contacts, eq(memories.subjectContactId, contacts.id))
        .leftJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
        .where(filters)
        .orderBy(
          desc(memories.pinned),
          desc(memories.ownerConfirmed),
          desc(memories.importance),
          desc(memories.createdAt),
          desc(memories.id),
        )
        .limit(input.pageSize)
        .offset((page - 1) * input.pageSize);
      return {
        rows: rows.map((row) => ({
          memory: row.memory,
          subject: row.subjectId
            ? {
                id: row.subjectId,
                name: row.subjectName ?? '',
                trust: row.subjectTrust ?? 'unknown',
              }
            : null,
          connectionCount: Number(row.connectionCount ?? 0),
          source:
            row.sourceStatus == null ||
            row.sourceContentHash == null ||
            row.sourceExtractionVersion == null
              ? null
              : {
                  status: row.sourceStatus,
                  contentHash: row.sourceContentHash,
                  extractionVersion: row.sourceExtractionVersion,
                },
        })),
        total,
        page,
        totalPages,
      };
    },
  };
}
