import {
  type GraphRecallRepository,
  type GraphRelation,
  historyLimit,
  validateSkillEmbedding,
} from '@assistant/persistence';
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

function asRows(value: unknown): GraphRelation[] {
  return Array.isArray(value) ? (value as GraphRelation[]) : [];
}

/** Shared eligibility for queries using the memory, source, and relation SQL aliases. */
export function postgresActiveGraphWhere(agentId: string, extractionVersion: number) {
  return sql`
    memory.agent_id = ${agentId}
    AND memory.category = 'knowledge'
    AND memory.quarantined = false
    AND memory.superseded_by_id IS NULL
    AND relation.agent_id = ${agentId}
    AND (memory.expires_at IS NULL OR memory.expires_at > now())
    AND source.status = 'ready'
    AND source.content_hash = memory.content_hash
    AND source.extraction_version >= ${extractionVersion}
    AND memory.embedding IS NOT NULL
    AND relation.review_status <> 'rejected'
    AND (
      relation.assertion_id IS NULL
      OR EXISTS (
        SELECT 1 FROM knowledge_graph_assertions AS assertion
        WHERE assertion.id = relation.assertion_id
          AND assertion.agent_id = ${agentId}
          AND assertion.lifecycle = 'current'
          AND assertion.review_status <> 'rejected'
      )
    )
    AND relation.evidence_quote IS NOT NULL
    AND relation.assertion->>'modality' <> 'unverified'
  `;
}

async function seedRelations(
  db: Db,
  agentId: string,
  vector: string,
  limit: number,
  extractionVersion: number,
): Promise<GraphRelation[]> {
  return asRows(
    await db.execute(sql`
      SELECT
        relation.id AS "relationId",
        relation.subject_entity_id AS "subjectEntityId",
        COALESCE(subject.preferred_label, subject.label) AS "subjectLabel",
        relation.predicate,
        relation.assertion,
        relation.object_entity_id AS "objectEntityId",
        COALESCE(object.preferred_label, object.label) AS "objectLabel",
        relation.source_memory_id AS "sourceMemoryId",
        memory.content,
        relation.evidence_quote AS "evidenceQuote",
        memory.created_at AS "createdAt",
        relation.confidence,
        relation.valid_from AS "validFrom",
        relation.valid_until AS "validUntil",
        1 - (memory.embedding <=> ${vector}::vector) AS similarity
      FROM knowledge_graph_relations AS relation
      INNER JOIN memories AS memory ON memory.id = relation.source_memory_id
      INNER JOIN knowledge_graph_sources AS source ON source.memory_id = memory.id
      INNER JOIN knowledge_graph_entities AS subject ON subject.id = relation.subject_entity_id
      INNER JOIN knowledge_graph_entities AS object ON object.id = relation.object_entity_id
      WHERE ${postgresActiveGraphWhere(agentId, extractionVersion)}
        AND subject.agent_id = ${agentId} AND object.agent_id = ${agentId}
      ORDER BY memory.embedding <=> ${vector}::vector
      LIMIT ${limit}
    `),
  );
}

async function connectedRelations(
  db: Db,
  agentId: string,
  entityIds: string[],
  sourceMemoryIds: string[],
  limit: number,
  extractionVersion: number,
): Promise<GraphRelation[]> {
  if (entityIds.length === 0) return [];
  const ids = sql.join(
    entityIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const sourceIds = sql.join(
    sourceMemoryIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return asRows(
    await db.execute(sql`
      SELECT
        relation.id AS "relationId",
        relation.subject_entity_id AS "subjectEntityId",
        COALESCE(subject.preferred_label, subject.label) AS "subjectLabel",
        relation.predicate,
        relation.assertion,
        relation.object_entity_id AS "objectEntityId",
        COALESCE(object.preferred_label, object.label) AS "objectLabel",
        relation.source_memory_id AS "sourceMemoryId",
        memory.content,
        relation.evidence_quote AS "evidenceQuote",
        memory.created_at AS "createdAt",
        relation.confidence,
        relation.valid_from AS "validFrom",
        relation.valid_until AS "validUntil"
      FROM knowledge_graph_relations AS relation
      INNER JOIN memories AS memory ON memory.id = relation.source_memory_id
      INNER JOIN knowledge_graph_sources AS source ON source.memory_id = memory.id
      INNER JOIN knowledge_graph_entities AS subject ON subject.id = relation.subject_entity_id
      INNER JOIN knowledge_graph_entities AS object ON object.id = relation.object_entity_id
      WHERE ${postgresActiveGraphWhere(agentId, extractionVersion)}
        AND subject.agent_id = ${agentId} AND object.agent_id = ${agentId}
        AND (relation.subject_entity_id IN (${ids}) OR relation.object_entity_id IN (${ids}))
        AND ${sourceMemoryIds.length ? sql`relation.source_memory_id NOT IN (${sourceIds})` : sql`TRUE`}
      ORDER BY relation.confidence DESC, memory.created_at DESC
      LIMIT ${limit}
    `),
  );
}

export function createPostgresGraphRecallRepository(db: Db): GraphRecallRepository {
  return {
    kind: 'graph-recall-repository',
    async seeds({ agentId, embedding, limit, extractionVersion }) {
      validateSkillEmbedding(embedding);
      return seedRelations(
        db,
        agentId,
        JSON.stringify(embedding),
        historyLimit(limit),
        extractionVersion,
      );
    },
    async connected({ agentId, entityIds, sourceMemoryIds, limit, extractionVersion }) {
      return connectedRelations(
        db,
        agentId,
        entityIds,
        sourceMemoryIds,
        historyLimit(limit),
        extractionVersion,
      );
    },
  };
}
