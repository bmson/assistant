import { getAgent } from '@assistant/core/chat';
import { getMemoryHealth } from '@assistant/core/memory/health';
import { removeOrphanedKnowledgeGraphEntities } from '@assistant/core/memory/knowledge-graph';
import {
  type Db,
  knowledgeGraphAssertions,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
} from '@assistant/db';
import { and, count, desc, eq, ilike, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  activeKnowledgeGraphConnectionCountForMemory,
  activeKnowledgeGraphWhere,
  getKnowledgeGraphOverview,
  type KnowledgeGraphReviewStatus,
} from './knowledge-graph.js';
import {
  assembleKnowledgeMapSnapshot,
  buildKnowledgeCleanupFindings,
  type KnowledgeCleanupFinding,
  type KnowledgeMapSnapshot,
  type KnowledgeSourceImpact,
  type KnowledgeWorkspaceOverview,
  knowledgeMapFilters,
  MAP_EDGE_FETCH_LIMIT,
} from './knowledge-workspace-queries.js';
import { correctMemory, type EmbeddingPort, forgetMemory } from './profile/commands.js';

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    return ((result as { rows?: T[] }).rows ?? []) as T[];
  }
  return [];
}

/**
 * Entities left with no relation at all. Written once so the cleanup list and
 * the overview count the same thing — they had drifted into two copies of the
 * same statement, and ran it twice per page besides.
 */
async function orphanedEntityCount(db: Db, agentId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS count
    FROM knowledge_graph_entities AS entity
    WHERE entity.agent_id = ${agentId}
      AND NOT EXISTS (
        SELECT 1 FROM knowledge_graph_relations AS relation
        WHERE relation.agent_id = ${agentId}
          AND (relation.subject_entity_id = entity.id OR relation.object_entity_id = entity.id)
      )
  `);
  return Number(asRows<{ count: number }>(rows)[0]?.count ?? 0);
}

export async function getKnowledgeCleanupFindings(db: Db): Promise<KnowledgeCleanupFinding[]> {
  const agent = await getAgent(db);
  const [memoryRows, rejectedRows, sourceRows, orphanCount] = await Promise.all([
    db
      .select({
        id: memories.id,
        content: memories.content,
        quarantined: memories.quarantined,
        expiresAt: memories.expiresAt,
        supersededById: memories.supersededById,
      })
      .from(memories)
      .where(
        and(
          eq(memories.agentId, agent.id),
          eq(memories.category, 'knowledge'),
          or(
            eq(memories.quarantined, true),
            and(isNotNull(memories.expiresAt), lte(memories.expiresAt, sql`now()`)),
            isNotNull(memories.supersededById),
          ),
        ),
      )
      .orderBy(desc(memories.createdAt))
      .limit(100),
    db
      .select({
        id: knowledgeGraphRelations.id,
        memoryId: memories.id,
        content: memories.content,
        reviewStatus: knowledgeGraphRelations.reviewStatus,
      })
      .from(knowledgeGraphRelations)
      .innerJoin(memories, eq(memories.id, knowledgeGraphRelations.sourceMemoryId))
      .where(
        and(
          eq(knowledgeGraphRelations.agentId, agent.id),
          inArray(knowledgeGraphRelations.reviewStatus, ['unreviewed', 'rejected']),
        ),
      )
      .limit(50),
    db
      .select({ memoryId: knowledgeGraphSources.memoryId, status: knowledgeGraphSources.status })
      .from(knowledgeGraphSources)
      .innerJoin(memories, eq(memories.id, knowledgeGraphSources.memoryId))
      .where(
        and(
          eq(memories.agentId, agent.id),
          inArray(knowledgeGraphSources.status, ['failed', 'quarantined']),
        ),
      )
      .limit(50),
    orphanedEntityCount(db, agent.id),
  ]);
  return buildKnowledgeCleanupFindings({
    memories: memoryRows,
    relations: rejectedRows,
    sources: sourceRows,
    orphanedEntities: orphanCount,
  });
}

/**
 * `graph` and `findings` are accepted rather than always fetched because the
 * page that renders this header already needs both for the body below it. The
 * graph overview and the cleanup scan are the two most expensive reads on the
 * page; running them once and passing them in halves the request.
 */
export async function getKnowledgeWorkspaceOverview(
  db: Db,
  prefetched: {
    graph?: Pick<
      Awaited<ReturnType<typeof getKnowledgeGraphOverview>>,
      'totalEntities' | 'totalRelations' | 'pendingSources'
    >;
    findings?: KnowledgeCleanupFinding[];
  } = {},
): Promise<KnowledgeWorkspaceOverview> {
  const agent = await getAgent(db);
  const [memory, graph, findings, failedRows, orphanedEntities] = await Promise.all([
    getMemoryHealth(db, agent.id),
    prefetched.graph ?? getKnowledgeGraphOverview(db, { pageSize: 1 }),
    prefetched.findings ?? getKnowledgeCleanupFindings(db),
    db
      .select({ value: count() })
      .from(knowledgeGraphSources)
      .innerJoin(memories, eq(memories.id, knowledgeGraphSources.memoryId))
      .where(
        and(
          eq(memories.agentId, agent.id),
          inArray(knowledgeGraphSources.status, ['failed', 'quarantined']),
        ),
      ),
    orphanedEntityCount(db, agent.id),
  ]);
  return {
    memory,
    graph: {
      activeEntities: graph.totalEntities,
      activeRelations: graph.totalRelations,
      orphanedEntities,
      pendingSources: graph.pendingSources,
      failedSources: Number(failedRows[0]?.value ?? 0),
    },
    cleanupCount: findings.reduce((total, finding) => total + finding.count, 0),
  };
}

export async function getKnowledgeMapSnapshot(
  db: Db,
  input: {
    query?: string;
    kind?: string;
    predicates?: string[];
    review?: 'all' | KnowledgeGraphReviewStatus;
    sourceMemoryId?: string;
    entityId?: string;
    includeVisibleConnections?: boolean;
    completeOverview?: boolean;
  } = {},
): Promise<KnowledgeMapSnapshot> {
  const agent = await getAgent(db);
  const subject = alias(knowledgeGraphEntities, 'map_subject');
  const object = alias(knowledgeGraphEntities, 'map_object');
  const { query, kind, predicates, review, sourceMemoryId } = knowledgeMapFilters(input);
  const subjectLabel = sql<string>`coalesce(nullif(${subject.preferredLabel}, ''), ${subject.label})`;
  const objectLabel = sql<string>`coalesce(nullif(${object.preferredLabel}, ''), ${object.label})`;
  const filters = and(
    activeKnowledgeGraphWhere(agent.id),
    query
      ? or(
          ilike(subjectLabel, `%${query}%`),
          ilike(objectLabel, `%${query}%`),
          ilike(subject.label, `%${query}%`),
          ilike(object.label, `%${query}%`),
        )
      : undefined,
    input.entityId ? or(eq(subject.id, input.entityId), eq(object.id, input.entityId)) : undefined,
    kind ? or(eq(subject.kind, kind), eq(object.kind, kind)) : undefined,
    predicates.length > 0 ? inArray(knowledgeGraphRelations.predicate, predicates) : undefined,
    review !== 'all' ? eq(knowledgeGraphRelations.reviewStatus, review) : undefined,
    sourceMemoryId ? eq(knowledgeGraphRelations.sourceMemoryId, sourceMemoryId) : undefined,
  );
  const mapRows = (where: ReturnType<typeof and>) =>
    db
      .select({
        id: knowledgeGraphRelations.id,
        predicate: knowledgeGraphRelations.predicate,
        reviewStatus: knowledgeGraphRelations.reviewStatus,
        subjectId: subject.id,
        subjectLabel,
        subjectKind: subject.kind,
        subjectContactId: subject.contactId,
        objectId: object.id,
        objectLabel,
        objectKind: object.kind,
        objectContactId: object.contactId,
        sourceMemoryId: memories.id,
        sourceContent: memories.content,
        evidenceQuote: knowledgeGraphRelations.evidenceQuote,
        validFrom: knowledgeGraphRelations.validFrom,
        validUntil: knowledgeGraphRelations.validUntil,
        assertionContext: {
          id: knowledgeGraphAssertions.id,
          semanticRevision: knowledgeGraphAssertions.semanticRevision,
          lifecycle: knowledgeGraphAssertions.lifecycle,
          reviewStatus: knowledgeGraphAssertions.reviewStatus,
          subjectEntityId: knowledgeGraphAssertions.subjectEntityId,
          predicate: knowledgeGraphAssertions.predicate,
          objectEntityId: knowledgeGraphAssertions.objectEntityId,
          evidenceCount: sql<number>`(
            SELECT count(*)::int
            FROM knowledge_graph_assertion_evidence AS evidence
            WHERE evidence.agent_id = ${agent.id}
              AND evidence.assertion_id = ${knowledgeGraphAssertions.id}
          )`,
        },
      })
      .from(knowledgeGraphRelations)
      .innerJoin(subject, eq(subject.id, knowledgeGraphRelations.subjectEntityId))
      .innerJoin(object, eq(object.id, knowledgeGraphRelations.objectEntityId))
      .innerJoin(memories, eq(memories.id, knowledgeGraphRelations.sourceMemoryId))
      .innerJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
      .leftJoin(
        knowledgeGraphAssertions,
        and(
          eq(knowledgeGraphAssertions.id, knowledgeGraphRelations.assertionId),
          eq(knowledgeGraphAssertions.agentId, agent.id),
        ),
      )
      .where(where);
  const [rows, [totalRow]] = await Promise.all([
    input.completeOverview
      ? mapRows(filters).orderBy(
          desc(knowledgeGraphRelations.createdAt),
          knowledgeGraphRelations.id,
        )
      : mapRows(filters)
          .orderBy(desc(knowledgeGraphRelations.createdAt))
          .limit(MAP_EDGE_FETCH_LIMIT),
    db
      .select({ value: count() })
      .from(knowledgeGraphRelations)
      .innerJoin(subject, eq(subject.id, knowledgeGraphRelations.subjectEntityId))
      .innerJoin(object, eq(object.id, knowledgeGraphRelations.objectEntityId))
      .innerJoin(memories, eq(memories.id, knowledgeGraphRelations.sourceMemoryId))
      .innerJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
      .where(filters),
  ]);
  return assembleKnowledgeMapSnapshot({
    rows,
    completeOverview: input.completeOverview,
    totalEdges: Number(totalRow?.value ?? 0),
    filters: { query, kind, predicates, review, sourceMemoryId },
    interior: input.includeVisibleConnections
      ? (ids, limit) =>
          mapRows(
            and(
              activeKnowledgeGraphWhere(agent.id),
              inArray(subject.id, ids),
              inArray(object.id, ids),
            ),
          )
            .orderBy(desc(knowledgeGraphRelations.createdAt))
            .limit(limit)
      : undefined,
  });
}

export async function getKnowledgeSourceImpact(
  db: Db,
  memoryId: string,
): Promise<KnowledgeSourceImpact | null> {
  const agent = await getAgent(db);
  const [memory] = await db
    .select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.agentId, agent.id)))
    .limit(1);
  if (!memory) return null;
  const rows = asRows<{ id: string; label: string }>(
    await db.execute(sql`
    WITH endpoints AS (
      SELECT subject_entity_id AS id FROM knowledge_graph_relations WHERE source_memory_id = ${memoryId}
      UNION
      SELECT object_entity_id AS id FROM knowledge_graph_relations WHERE source_memory_id = ${memoryId}
    )
    SELECT entity.id, coalesce(entity.preferred_label, entity.label) AS label
    FROM endpoints
    INNER JOIN knowledge_graph_entities AS entity ON entity.id = endpoints.id
    WHERE NOT EXISTS (
      SELECT 1 FROM knowledge_graph_relations AS other
      WHERE other.source_memory_id <> ${memoryId}
        AND (other.subject_entity_id = entity.id OR other.object_entity_id = entity.id)
    )
  `),
  );
  const [[relationCount], [activeRelationCount]] = await Promise.all([
    db
      .select({ value: count() })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memoryId)),
    db
      .select({ value: activeKnowledgeGraphConnectionCountForMemory(agent.id, memories.id) })
      .from(memories)
      .where(and(eq(memories.id, memoryId), eq(memories.agentId, agent.id)))
      .limit(1),
  ]);
  const connectionCount = Number(relationCount?.value ?? 0);
  const activeConnectionCount = Number(activeRelationCount?.value ?? 0);
  return {
    memoryId,
    content: memory.content,
    // Kept for native clients released before the active/retired split.
    connectionCount,
    activeConnectionCount,
    retiredProjectionCount: Math.max(0, connectionCount - activeConnectionCount),
    orphanedItems: rows,
  };
}

export async function correctKnowledgeSource(
  db: Db,
  router: EmbeddingPort,
  memoryId: string,
  content: string,
): Promise<{ error?: string }> {
  return correctMemory(db, router, memoryId, content);
}

export async function forgetKnowledgeSource(db: Db, memoryId: string): Promise<void> {
  await forgetMemory(db, memoryId);
}

export async function cleanKnowledgeProjectionOrphans(db: Db): Promise<number> {
  const agent = await getAgent(db);
  return removeOrphanedKnowledgeGraphEntities(db, agent.id);
}
