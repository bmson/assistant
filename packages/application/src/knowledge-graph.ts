import { loadConfig } from '@assistant/config';
import { getAgent } from '@assistant/core/chat';
import {
  correctOwnerKnowledgeGraphFactWithRepository,
  countRelativeDateSources,
  createOwnerKnowledgeGraphFact,
  createOwnerKnowledgeGraphFactWithRepository,
  GRAPH_ENTITY_KINDS,
  GRAPH_EXTRACTION_VERSION,
  type GraphEntityKind,
  meanExtractionCostUsd,
  mergeGraphEntities,
  requeueRelativeDateSources,
  retryQuarantinedKnowledgeGraphSources as retryQuarantinedSources,
  retypeGraphEntity,
} from '@assistant/core/memory/knowledge-graph';
import type {
  DerivableKnowledgeAssertion,
  DerivedKnowledgeView,
  KnowledgeAssertionEndpointView,
  OwnerGraphCorrectionDisposition,
  OwnerGraphCorrectionTarget,
  OwnerKnowledgeGraphFactRepository,
} from '@assistant/persistence';
import { deriveSharedParentViews, knowledgeAssertionEndpointView } from '@assistant/persistence';

export { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';

import {
  type Db,
  knowledgeGraphAssertions,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
  namePrefixMatch,
} from '@assistant/db';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { type AnyPgColumn, alias } from 'drizzle-orm/pg-core';
import {
  NEIGHBORHOOD_DEFAULT_LIMIT,
  NEIGHBORHOOD_MAX_LIMIT,
} from './knowledge-workspace-queries.js';
import type { EmbeddingPort } from './profile/commands.js';
import {
  presentKnowledgeGraphRelation,
  type RelationshipPresentation,
} from './relationship-presentation.js';

// The typed predicate vocabulary is domain data the add-relationship form
// needs as plain serializable props; re-exported so the web layer never
// reaches past the application boundary. Package subpath specifiers in this
// repo are extensionless — the exports-map key carries no `.js`.
export type { PredicateSpec } from '@assistant/core/memory/predicate-vocabulary';
export {
  PREDICATE_VOCABULARY,
  predicateSuggestionsFor,
} from '@assistant/core/memory/predicate-vocabulary';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type KnowledgeGraphReviewStatus = 'unreviewed' | 'confirmed' | 'rejected';

export interface KnowledgeGraphEntityView {
  id: string;
  label: string;
  kind: string;
  canonicalKey: string;
}

export interface KnowledgeGraphRelationView {
  id: string;
  subject: KnowledgeGraphEntityView;
  predicate: string;
  object: KnowledgeGraphEntityView;
  confidence: number;
  reviewStatus: KnowledgeGraphReviewStatus;
  reviewedAt: Date | null;
  /** Temporal qualifiers as canonical date keys, when the source states a span. */
  validFrom: string | null;
  validUntil: string | null;
  /** True when GraphRAG can currently traverse this edge (see activeGraphWhere in core). */
  inRecall: boolean;
  source: {
    memoryId: string;
    content: string;
    createdAt: Date;
    ownerConfirmed: boolean;
    originTrust: string;
  };
  presentation: RelationshipPresentation;
  /** Safe wording for each endpoint; inverse text falls back to evidence when uncertain. */
  endpointViews?: KnowledgeAssertionEndpointView[];
  /** Only source-backed current premises participate; each result carries its complete lineage. */
  derivedRelations?: DerivedKnowledgeView[];
}

/** An advisory merge hint, mirroring the contact-level duplicate suggestions. */
export interface KnowledgeGraphDuplicate {
  targetId: string;
  label: string;
  kind: string;
  reason: string;
}

export interface KnowledgeGraphOverview {
  totalEntities: number;
  totalRelations: number;
  unreviewedRelations: number;
  pendingSources: number;
  quarantinedSources: number;
  /**
   * What the pending backlog is expected to cost to extract, priced from recent
   * actuals, and roughly how long it takes to drain at the configured batch
   * size. Null when there is too little history to price honestly — a guess
   * dressed as a number is worse than no number.
   */
  pendingCostUsd: number | null;
  pendingRuns: number;
  /**
   * Sources still carrying relative date wording that the free backfill could
   * not resolve. Re-extracting them costs money, so it is surfaced as a choice
   * rather than queued automatically.
   */
  relativeDateSources: number;
  entities: KnowledgeGraphEntityView[];
  /** Entities matching the current search — the true count, not the page size. */
  matchingEntities: number;
  entityPage: number;
  entityPages: number;
  selected: KnowledgeGraphEntityView | null;
  relations: KnowledgeGraphRelationView[];
  /**
   * Every edge incident to the selected entity, including the ones past the
   * page cap. The header used to print `relations.length`, which silently
   * reported the cap as the degree.
   */
  selectedRelationTotal: number;
  /**
   * Incident edges that are not stale — what the local map actually draws from.
   * Separate from the total because the map is built from one capped page of
   * relations, so its own length would report the cap as the degree.
   */
  selectedActiveRelationTotal: number;
  duplicates: KnowledgeGraphDuplicate[];
  derivedRelations?: DerivedKnowledgeView[];
  derivedCoverage?: 'complete' | 'bounded_incomplete';
}

/** A bounded, evidence-ready queue for the owner’s review workflow. */
export async function getKnowledgeGraphReviewQueue(
  db: Db,
  input: { limit?: number } = {},
): Promise<KnowledgeGraphRelationView[]> {
  return readKnowledgeGraphRelations(db, input);
}

/** Resolve a specific evidence row, independent of browse/review page limits. */
export async function getKnowledgeGraphRelation(
  db: Db,
  relationId: string,
): Promise<KnowledgeGraphRelationView | null> {
  if (!UUID_RE.test(relationId)) return null;
  const rows = await readKnowledgeGraphRelations(db, { relationId, limit: 1 });
  return rows[0] ?? null;
}

async function readKnowledgeGraphRelations(
  db: Db,
  input: { limit?: number; relationId?: string },
): Promise<KnowledgeGraphRelationView[]> {
  const agent = await getAgent(db);
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
  const subject = alias(knowledgeGraphEntities, 'review_subject');
  const object = alias(knowledgeGraphEntities, 'review_object');
  const rows = await db
    .select({
      id: knowledgeGraphRelations.id,
      predicate: knowledgeGraphRelations.predicate,
      confidence: knowledgeGraphRelations.confidence,
      reviewStatus: knowledgeGraphRelations.reviewStatus,
      reviewedAt: knowledgeGraphRelations.reviewedAt,
      validFrom: knowledgeGraphRelations.validFrom,
      validUntil: knowledgeGraphRelations.validUntil,
      hasEvidence: sql<boolean>`${knowledgeGraphRelations.evidenceQuote} IS NOT NULL`,
      evidenceQuote: knowledgeGraphRelations.evidenceQuote,
      subjectId: subject.id,
      subjectLabel: displayLabel(subject),
      subjectKind: subject.kind,
      subjectCanonicalKey: subject.canonicalKey,
      objectId: object.id,
      objectLabel: displayLabel(object),
      objectKind: object.kind,
      objectCanonicalKey: object.canonicalKey,
      sourceMemoryId: memories.id,
      sourceContent: memories.content,
      sourceCreatedAt: memories.createdAt,
      sourceOwnerConfirmed: memories.ownerConfirmed,
      sourceOriginTrust: memories.originTrust,
      memoryContentHash: memories.contentHash,
      memoryQuarantined: memories.quarantined,
      memoryExpiresAt: memories.expiresAt,
      memoryEmbedded: sql<boolean>`${memories.embedding} IS NOT NULL`,
      checkpointStatus: knowledgeGraphSources.status,
      checkpointContentHash: knowledgeGraphSources.contentHash,
      checkpointVersion: knowledgeGraphSources.extractionVersion,
      assertionId: knowledgeGraphRelations.assertionId,
      assertionSemanticRevision: knowledgeGraphAssertions.semanticRevision,
      assertionLifecycle: knowledgeGraphAssertions.lifecycle,
      assertionReviewStatus: knowledgeGraphAssertions.reviewStatus,
      assertionEvidenceCount: sql<number>`(
        SELECT COUNT(*)::int FROM knowledge_graph_assertion_evidence evidence
        WHERE evidence.assertion_id = ${knowledgeGraphRelations.assertionId}
          AND evidence.agent_id = ${agent.id}
      )`,
    })
    .from(knowledgeGraphRelations)
    .innerJoin(subject, eq(knowledgeGraphRelations.subjectEntityId, subject.id))
    .innerJoin(object, eq(knowledgeGraphRelations.objectEntityId, object.id))
    .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
    .leftJoin(
      knowledgeGraphAssertions,
      eq(knowledgeGraphRelations.assertionId, knowledgeGraphAssertions.id),
    )
    .leftJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
    .where(
      and(
        eq(knowledgeGraphRelations.agentId, agent.id),
        input.relationId
          ? eq(knowledgeGraphRelations.id, input.relationId)
          : eq(knowledgeGraphRelations.reviewStatus, 'unreviewed'),
      ),
    )
    .orderBy(desc(knowledgeGraphRelations.createdAt))
    .limit(limit);
  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    subject: {
      id: row.subjectId,
      label: row.subjectLabel,
      kind: row.subjectKind,
      canonicalKey: row.subjectCanonicalKey,
    },
    predicate: row.predicate,
    object: {
      id: row.objectId,
      label: row.objectLabel,
      kind: row.objectKind,
      canonicalKey: row.objectCanonicalKey,
    },
    confidence: Number(row.confidence),
    reviewStatus: asReviewStatus(
      row.assertionId ? (row.assertionReviewStatus ?? 'unreviewed') : row.reviewStatus,
    ),
    reviewedAt: row.reviewedAt,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    // Review deliberately includes edges that are temporarily outside recall;
    // the owner still needs to see and decide on their evidence.
    inRecall:
      row.reviewStatus !== 'rejected' &&
      (row.assertionId === null ||
        (row.assertionLifecycle === 'current' && row.assertionReviewStatus !== 'rejected')) &&
      row.checkpointStatus === 'ready' &&
      row.checkpointContentHash === row.memoryContentHash &&
      (row.checkpointVersion ?? 0) >= GRAPH_EXTRACTION_VERSION &&
      !row.memoryQuarantined &&
      (!row.memoryExpiresAt || row.memoryExpiresAt > now) &&
      row.memoryEmbedded &&
      row.hasEvidence,
    source: {
      memoryId: row.sourceMemoryId,
      content: row.sourceContent,
      createdAt: row.sourceCreatedAt,
      ownerConfirmed: row.sourceOwnerConfirmed,
      originTrust: row.sourceOriginTrust,
    },
    presentation: presentKnowledgeGraphRelation({
      subjectLabel: row.subjectLabel,
      predicate: row.predicate,
      objectLabel: row.objectLabel,
    }),
    endpointViews:
      row.assertionId && row.assertionLifecycle === 'current' && row.assertionSemanticRevision
        ? [row.subjectId, row.objectId].flatMap((focusEntityId) => {
            const view = knowledgeAssertionEndpointView({
              assertionId: row.assertionId as string,
              semanticRevision: row.assertionSemanticRevision as number,
              subjectEntityId: row.subjectId,
              subjectLabel: row.subjectLabel,
              predicate: row.predicate,
              objectEntityId: row.objectId,
              objectLabel: row.objectLabel,
              evidenceQuote: row.evidenceQuote,
              evidenceCount: Number(row.assertionEvidenceCount ?? 0),
              reviewStatus: asReviewStatus(row.assertionReviewStatus ?? row.reviewStatus),
              focusEntityId,
            });
            return view ? [view] : [];
          })
        : [],
  }));
}

function displayLabel<T extends { preferredLabel: AnyPgColumn; label: AnyPgColumn }>(entity: T) {
  return sql<string>`COALESCE(${entity.preferredLabel}, ${entity.label})`;
}

/**
 * Sort key for owner-facing entity lists. Ordering on the raw label leaves the
 * result at the mercy of the deployment's Postgres collation — under `C` an
 * uppercase "Zebra" sorts before a lowercase "apple" — so the case is folded
 * here rather than assumed away.
 */
function sortLabel<T extends { preferredLabel: AnyPgColumn; label: AnyPgColumn }>(entity: T) {
  return sql`LOWER(${displayLabel(entity)})`;
}

/** One page of the entity sidebar. Matches listMemoryLibrary's page size. */
const ENTITY_PAGE_SIZE = 60;
/** Edges rendered for the selected entity before the list is capped. */
const RELATION_LIMIT = 80;

function cleanSearch(query: string): string {
  return query.trim().slice(0, 120).replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function asReviewStatus(value: string): KnowledgeGraphReviewStatus {
  return value === 'confirmed' || value === 'rejected' ? value : 'unreviewed';
}

/**
 * The domain owns the kind list; a URL or form can carry any string, so
 * unknown values degrade to "no filter" rather than silently zeroing the list
 * — a garbage `?kind=` looking like data loss is the failure this avoids.
 */
export function asGraphEntityKind(value: string | undefined): GraphEntityKind | undefined {
  return value && (GRAPH_ENTITY_KINDS as readonly string[]).includes(value)
    ? (value as GraphEntityKind)
    : undefined;
}

/**
 * Recall eligibility for owner-facing queries — the drizzle mirror of
 * `activeGraphWhere` in core's graph-recall.ts. An edge the UI calls "active"
 * must be one GraphRAG could actually traverse: current, source-backed,
 * ready-checkpointed, and embedded. The review list shows every edge (it is
 * the audit surface) but flags the ineligible ones; the map and the "active
 * edge" counts use this filter. Keep the two sides aligned — the parity is
 * pinned by tests in this package and in core.
 */
export function activeKnowledgeGraphWhere(agentId: string) {
  return and(
    eq(knowledgeGraphRelations.agentId, agentId),
    sql`(${knowledgeGraphRelations.assertionId} IS NULL OR EXISTS (
      SELECT 1 FROM knowledge_graph_assertions AS assertion
      WHERE assertion.id = ${knowledgeGraphRelations.assertionId}
        AND assertion.agent_id = ${agentId}
        AND assertion.lifecycle = 'current'
        AND assertion.review_status <> 'rejected'
    ))`,
    ne(knowledgeGraphRelations.reviewStatus, 'rejected'),
    eq(memories.category, 'knowledge'),
    eq(memories.quarantined, false),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
    isNotNull(memories.embedding),
    eq(knowledgeGraphSources.status, 'ready'),
    eq(knowledgeGraphSources.contentHash, memories.contentHash),
    gte(knowledgeGraphSources.extractionVersion, GRAPH_EXTRACTION_VERSION),
    isNotNull(knowledgeGraphRelations.evidenceQuote),
  );
}

/**
 * The library starts from a memory row rather than a graph relation join. Keep
 * its connected/unconnected filter on the exact same source-backed contract as
 * the map and GraphRAG, instead of treating stale projection rows as live
 * knowledge.
 */
function activeKnowledgeGraphRelationForMemorySql(
  agentId: string,
  memoryId: SQL | AnyPgColumn,
): SQL {
  return sql`
    active_relation.agent_id = ${agentId}
    AND active_relation.source_memory_id = ${memoryId}
    AND active_relation.review_status <> 'rejected'
    AND (
      active_relation.assertion_id IS NULL
      OR EXISTS (
        SELECT 1 FROM knowledge_graph_assertions AS assertion
        WHERE assertion.id = active_relation.assertion_id
          AND assertion.agent_id = ${agentId}
          AND assertion.lifecycle = 'current'
          AND assertion.review_status <> 'rejected'
      )
    )
    AND active_memory.category = 'knowledge'
    AND active_memory.quarantined = false
    AND (active_memory.expires_at IS NULL OR active_memory.expires_at > now())
    AND active_memory.embedding IS NOT NULL
    AND active_source.status = 'ready'
    AND active_source.content_hash = active_memory.content_hash
    AND active_source.extraction_version >= ${GRAPH_EXTRACTION_VERSION}
    AND active_relation.evidence_quote IS NOT NULL
  `;
}

export function activeKnowledgeGraphRelationExistsForMemory(
  agentId: string,
  memoryId: SQL | AnyPgColumn,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM knowledge_graph_relations AS active_relation
    INNER JOIN memories AS active_memory ON active_memory.id = active_relation.source_memory_id
    INNER JOIN knowledge_graph_sources AS active_source ON active_source.memory_id = active_memory.id
    WHERE ${activeKnowledgeGraphRelationForMemorySql(agentId, memoryId)}
  )`;
}

export function activeKnowledgeGraphConnectionCountForMemory(
  agentId: string,
  memoryId: SQL | AnyPgColumn,
): SQL<number> {
  return sql<number>`(
    SELECT count(*)::int
    FROM knowledge_graph_relations AS active_relation
    INNER JOIN memories AS active_memory ON active_memory.id = active_relation.source_memory_id
    INNER JOIN knowledge_graph_sources AS active_source ON active_source.memory_id = active_memory.id
    WHERE ${activeKnowledgeGraphRelationForMemorySql(agentId, memoryId)}
  )`;
}

/** Owner-facing entity lists contain only nodes that participate in recall-eligible edges. */
function activeEntityCondition(agentId: string, entity: AnyPgColumn) {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM knowledge_graph_relations AS active_relation
    INNER JOIN memories AS active_memory ON active_memory.id = active_relation.source_memory_id
    INNER JOIN knowledge_graph_sources AS active_source ON active_source.memory_id = active_memory.id
    WHERE active_relation.agent_id = ${agentId}
      AND (active_relation.subject_entity_id = ${entity} OR active_relation.object_entity_id = ${entity})
      AND active_relation.review_status <> 'rejected'
      AND active_memory.category = 'knowledge'
      AND active_memory.quarantined = false
      AND (active_memory.expires_at IS NULL OR active_memory.expires_at > now())
      AND active_memory.embedding IS NOT NULL
      AND active_source.status = 'ready'
      AND active_source.content_hash = active_memory.content_hash
      AND active_source.extraction_version >= ${GRAPH_EXTRACTION_VERSION}
      AND active_relation.evidence_quote IS NOT NULL
  )`;
}

/** Owner-facing, bounded graph inspection. It reads only source-backed edges. */
export async function getKnowledgeGraphOverview(
  db: Db,
  input: {
    query?: string;
    kind?: string;
    entityId?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<KnowledgeGraphOverview> {
  const agent = await getAgent(db);
  const query = cleanSearch(input.query ?? '');
  const kind = asGraphEntityKind(input.kind);
  const pageSize = input.pageSize ?? ENTITY_PAGE_SIZE;
  const entityCondition = and(
    eq(knowledgeGraphEntities.agentId, agent.id),
    activeEntityCondition(agent.id, knowledgeGraphEntities.id),
    kind ? eq(knowledgeGraphEntities.kind, kind) : undefined,
    query ? ilike(displayLabel(knowledgeGraphEntities), `%${query}%`) : undefined,
  );
  // The match count has to be known before the page can be clamped, so it is
  // resolved first rather than alongside the row fetch.
  const [matchingRow] = await db
    .select({ value: count() })
    .from(knowledgeGraphEntities)
    .where(entityCondition);
  const matchingEntities = Number(matchingRow?.value ?? 0);
  const entityPages = Math.max(1, Math.ceil(matchingEntities / pageSize));
  const requestedPage =
    Number.isFinite(input.page) && (input.page ?? 0) > 0 ? (input.page ?? 1) : 1;
  const entityPage = Math.min(requestedPage, entityPages);
  const [
    entityRows,
    [entityTotal],
    [relationTotal],
    [unreviewedTotal],
    [pendingSources],
    [quarantinedSources],
  ] = await Promise.all([
    db
      .select({
        id: knowledgeGraphEntities.id,
        label: displayLabel(knowledgeGraphEntities),
        kind: knowledgeGraphEntities.kind,
        canonicalKey: knowledgeGraphEntities.canonicalKey,
      })
      .from(knowledgeGraphEntities)
      .where(entityCondition)
      .orderBy(asc(sortLabel(knowledgeGraphEntities)))
      .limit(pageSize)
      .offset((entityPage - 1) * pageSize),
    db
      .select({ value: count() })
      .from(knowledgeGraphEntities)
      .where(
        and(
          eq(knowledgeGraphEntities.agentId, agent.id),
          activeEntityCondition(agent.id, knowledgeGraphEntities.id),
        ),
      ),
    db
      .select({ value: count() })
      .from(knowledgeGraphRelations)
      .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
      .innerJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
      .where(activeKnowledgeGraphWhere(agent.id)),
    db
      .select({ value: count() })
      .from(knowledgeGraphRelations)
      .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
      .innerJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
      .where(
        and(
          activeKnowledgeGraphWhere(agent.id),
          eq(knowledgeGraphRelations.reviewStatus, 'unreviewed'),
        ),
      ),
    db
      .select({ value: count() })
      .from(memories)
      .leftJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
      .where(
        and(
          eq(memories.agentId, agent.id),
          eq(memories.category, 'knowledge'),
          eq(memories.quarantined, false),
          or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
          or(
            isNull(knowledgeGraphSources.memoryId),
            sql`${knowledgeGraphSources.contentHash} IS DISTINCT FROM ${memories.contentHash}`,
            sql`${knowledgeGraphSources.subjectContactId} IS DISTINCT FROM ${memories.subjectContactId}`,
            eq(knowledgeGraphSources.status, 'failed'),
          ),
        ),
      ),
    db
      .select({ value: count() })
      .from(knowledgeGraphSources)
      .innerJoin(memories, eq(memories.id, knowledgeGraphSources.memoryId))
      .where(and(eq(memories.agentId, agent.id), eq(knowledgeGraphSources.status, 'quarantined'))),
  ]);
  const entities = entityRows.map((row) => ({ ...row }));
  const pending = Number(pendingSources?.value ?? 0);
  const meanCost = pending > 0 ? await meanExtractionCostUsd(db) : null;
  const pendingCostUsd = meanCost === null ? null : pending * meanCost;
  const batchLimit = loadConfig().GRAPH_SYNC_BATCH_LIMIT;
  const pendingRuns = Math.ceil(pending / batchLimit);
  const relativeDateSources = await countRelativeDateSources(db, agent.id);
  const requestedId = input.entityId && UUID_RE.test(input.entityId) ? input.entityId : null;
  const selected =
    (requestedId
      ? (entities.find((entity) => entity.id === requestedId) ??
        // The fallback lookup is deliberately unfiltered by kind: a deep link
        // like ?entity=<id>&kind=person must still open a date entity, or
        // changing the filter would make a shared link lose its subject.
        (
          await db
            .select({
              id: knowledgeGraphEntities.id,
              label: displayLabel(knowledgeGraphEntities),
              kind: knowledgeGraphEntities.kind,
              canonicalKey: knowledgeGraphEntities.canonicalKey,
            })
            .from(knowledgeGraphEntities)
            .where(
              and(
                eq(knowledgeGraphEntities.agentId, agent.id),
                eq(knowledgeGraphEntities.id, requestedId),
              ),
            )
            .limit(1)
        )[0])
      : entities[0]) ?? null;

  if (!selected) {
    return {
      totalEntities: Number(entityTotal?.value ?? 0),
      totalRelations: Number(relationTotal?.value ?? 0),
      unreviewedRelations: Number(unreviewedTotal?.value ?? 0),
      pendingSources: pending,
      quarantinedSources: Number(quarantinedSources?.value ?? 0),
      pendingCostUsd,
      pendingRuns,
      relativeDateSources,
      entities,
      matchingEntities,
      entityPage,
      entityPages,
      selected: null,
      relations: [],
      selectedRelationTotal: 0,
      selectedActiveRelationTotal: 0,
      duplicates: [],
      derivedRelations: [],
      derivedCoverage: 'complete',
    };
  }

  const subject = alias(knowledgeGraphEntities, 'knowledge_graph_subject');
  const object = alias(knowledgeGraphEntities, 'knowledge_graph_object');
  const incidentToSelected = and(
    eq(knowledgeGraphRelations.agentId, agent.id),
    or(
      eq(knowledgeGraphRelations.subjectEntityId, selected.id),
      eq(knowledgeGraphRelations.objectEntityId, selected.id),
    ),
  );
  const [relationRows, [selectedRelationRow], [selectedActiveRow], duplicates, derivedRows] =
    await Promise.all([
      db
        .select({
          id: knowledgeGraphRelations.id,
          predicate: knowledgeGraphRelations.predicate,
          confidence: knowledgeGraphRelations.confidence,
          reviewStatus: knowledgeGraphRelations.reviewStatus,
          reviewedAt: knowledgeGraphRelations.reviewedAt,
          validFrom: knowledgeGraphRelations.validFrom,
          validUntil: knowledgeGraphRelations.validUntil,
          hasEvidence: sql<boolean>`${knowledgeGraphRelations.evidenceQuote} IS NOT NULL`,
          evidenceQuote: knowledgeGraphRelations.evidenceQuote,
          subjectId: subject.id,
          subjectLabel: displayLabel(subject),
          subjectKind: subject.kind,
          subjectCanonicalKey: subject.canonicalKey,
          objectId: object.id,
          objectLabel: displayLabel(object),
          objectKind: object.kind,
          objectCanonicalKey: object.canonicalKey,
          sourceMemoryId: memories.id,
          sourceContent: memories.content,
          sourceCreatedAt: memories.createdAt,
          sourceOwnerConfirmed: memories.ownerConfirmed,
          sourceOriginTrust: memories.originTrust,
          memoryContentHash: memories.contentHash,
          memoryQuarantined: memories.quarantined,
          memoryExpiresAt: memories.expiresAt,
          memoryEmbedded: sql<boolean>`${memories.embedding} IS NOT NULL`,
          assertionId: knowledgeGraphRelations.assertionId,
          assertionSemanticRevision: knowledgeGraphAssertions.semanticRevision,
          assertionLifecycle: knowledgeGraphAssertions.lifecycle,
          assertionReviewStatus: knowledgeGraphAssertions.reviewStatus,
          assertionEvidenceCount: sql<number>`(
          SELECT COUNT(*)::int FROM knowledge_graph_assertion_evidence evidence
          WHERE evidence.assertion_id = ${knowledgeGraphRelations.assertionId}
            AND evidence.agent_id = ${agent.id}
        )`,
          checkpointStatus: knowledgeGraphSources.status,
          checkpointContentHash: knowledgeGraphSources.contentHash,
          checkpointVersion: knowledgeGraphSources.extractionVersion,
        })
        .from(knowledgeGraphRelations)
        .innerJoin(subject, eq(knowledgeGraphRelations.subjectEntityId, subject.id))
        .innerJoin(object, eq(knowledgeGraphRelations.objectEntityId, object.id))
        .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
        .leftJoin(
          knowledgeGraphAssertions,
          eq(knowledgeGraphRelations.assertionId, knowledgeGraphAssertions.id),
        )
        .leftJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
        .where(incidentToSelected)
        .orderBy(
          asc(
            sql`CASE ${knowledgeGraphRelations.reviewStatus} WHEN 'unreviewed' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END`,
          ),
          desc(knowledgeGraphRelations.createdAt),
        )
        .limit(RELATION_LIMIT),
      db.select({ value: count() }).from(knowledgeGraphRelations).where(incidentToSelected),
      db
        .select({ value: count() })
        .from(knowledgeGraphRelations)
        .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
        .innerJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
        .where(and(incidentToSelected, activeKnowledgeGraphWhere(agent.id))),
      findDuplicateKnowledgeGraphEntities(db, selected),
      db
        .select({
          id: knowledgeGraphAssertions.id,
          semanticRevision: knowledgeGraphAssertions.semanticRevision,
          subjectEntityId: knowledgeGraphAssertions.subjectEntityId,
          predicate: knowledgeGraphAssertions.predicate,
          objectEntityId: knowledgeGraphAssertions.objectEntityId,
          assertion: knowledgeGraphAssertions.assertion,
          lifecycle: knowledgeGraphAssertions.lifecycle,
          reviewStatus: knowledgeGraphAssertions.reviewStatus,
          subjectLabel: displayLabel(subject),
          objectLabel: displayLabel(object),
        })
        .from(knowledgeGraphAssertions)
        .innerJoin(
          knowledgeGraphRelations,
          eq(knowledgeGraphRelations.assertionId, knowledgeGraphAssertions.id),
        )
        .innerJoin(subject, eq(knowledgeGraphAssertions.subjectEntityId, subject.id))
        .innerJoin(object, eq(knowledgeGraphAssertions.objectEntityId, object.id))
        .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
        .innerJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
        .where(
          and(
            eq(knowledgeGraphAssertions.agentId, agent.id),
            inArray(knowledgeGraphAssertions.predicate, ['parent_of', 'father_of', 'mother_of']),
            activeKnowledgeGraphWhere(agent.id),
            sql`${knowledgeGraphAssertions.assertion}->>'polarity' = 'positive'`,
            sql`${knowledgeGraphAssertions.assertion}->>'modality' = 'asserted'`,
          ),
        )
        .groupBy(
          knowledgeGraphAssertions.id,
          subject.preferredLabel,
          subject.label,
          object.preferredLabel,
          object.label,
        )
        .limit(1001),
    ]);
  const now = new Date();
  const relations = relationRows.map((row) => ({
    id: row.id,
    subject: {
      id: row.subjectId,
      label: row.subjectLabel,
      kind: row.subjectKind,
      canonicalKey: row.subjectCanonicalKey,
    },
    predicate: row.predicate,
    object: {
      id: row.objectId,
      label: row.objectLabel,
      kind: row.objectKind,
      canonicalKey: row.objectCanonicalKey,
    },
    confidence: Number(row.confidence),
    reviewStatus: asReviewStatus(
      row.assertionId ? (row.assertionReviewStatus ?? 'unreviewed') : row.reviewStatus,
    ),
    reviewedAt: row.reviewedAt,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    // JS mirror of activeKnowledgeGraphWhere, so the audit list can flag an
    // edge GraphRAG currently cannot traverse without hiding it from review.
    inRecall:
      row.reviewStatus !== 'rejected' &&
      (row.assertionId === null ||
        (row.assertionLifecycle === 'current' && row.assertionReviewStatus !== 'rejected')) &&
      row.checkpointStatus === 'ready' &&
      row.checkpointContentHash === row.memoryContentHash &&
      (row.checkpointVersion ?? 0) >= GRAPH_EXTRACTION_VERSION &&
      !row.memoryQuarantined &&
      (!row.memoryExpiresAt || row.memoryExpiresAt > now) &&
      row.memoryEmbedded &&
      row.hasEvidence,
    source: {
      memoryId: row.sourceMemoryId,
      content: row.sourceContent,
      createdAt: row.sourceCreatedAt,
      ownerConfirmed: row.sourceOwnerConfirmed,
      originTrust: row.sourceOriginTrust,
    },
    presentation: presentKnowledgeGraphRelation({
      subjectLabel: row.subjectLabel,
      predicate: row.predicate,
      objectLabel: row.objectLabel,
    }),
    endpointViews:
      row.assertionId && row.assertionLifecycle === 'current' && row.assertionSemanticRevision
        ? [row.subjectId, row.objectId].flatMap((focusEntityId) => {
            const view = knowledgeAssertionEndpointView({
              assertionId: row.assertionId as string,
              semanticRevision: row.assertionSemanticRevision as number,
              subjectEntityId: row.subjectId,
              subjectLabel: row.subjectLabel,
              predicate: row.predicate,
              objectEntityId: row.objectId,
              objectLabel: row.objectLabel,
              evidenceQuote: row.evidenceQuote,
              evidenceCount: Number(row.assertionEvidenceCount ?? 0),
              reviewStatus: asReviewStatus(row.assertionReviewStatus ?? row.reviewStatus),
              focusEntityId,
            });
            return view ? [view] : [];
          })
        : [],
  }));
  const derivedCoverage = derivedRows.length > 1000 ? 'bounded_incomplete' : 'complete';
  const derivedRelations =
    derivedCoverage === 'complete'
      ? deriveSharedParentViews(
          derivedRows.map((row) => ({
            ...row,
            lifecycle: 'current' as const,
            reviewStatus:
              row.reviewStatus === 'confirmed' ? ('confirmed' as const) : ('unreviewed' as const),
          })) as DerivableKnowledgeAssertion[],
          new Map(
            derivedRows.flatMap((row) => [
              [row.subjectEntityId, row.subjectLabel],
              [row.objectEntityId, row.objectLabel],
            ]),
          ),
        ).filter((row) => row.subjectEntityId === selected.id || row.objectEntityId === selected.id)
      : [];
  return {
    totalEntities: Number(entityTotal?.value ?? 0),
    totalRelations: Number(relationTotal?.value ?? 0),
    unreviewedRelations: Number(unreviewedTotal?.value ?? 0),
    pendingSources: pending,
    quarantinedSources: Number(quarantinedSources?.value ?? 0),
    pendingCostUsd,
    pendingRuns,
    relativeDateSources,
    entities,
    matchingEntities,
    entityPage,
    entityPages,
    selected,
    relations,
    derivedRelations,
    derivedCoverage,
    selectedRelationTotal: Number(selectedRelationRow?.value ?? 0),
    selectedActiveRelationTotal: Number(selectedActiveRow?.value ?? 0),
    duplicates,
  };
}

/** One edge as the local map draws it: the neighbour plus direction relative to the queried entity. */
export interface KnowledgeGraphNeighborEdge {
  id: string;
  predicate: string;
  /** True when the queried entity is the subject of the relation. */
  outbound: boolean;
  reviewStatus: KnowledgeGraphReviewStatus;
  /** Temporal qualifiers as canonical date keys, when the source states a span. */
  validFrom: string | null;
  validUntil: string | null;
  other: KnowledgeGraphEntityView;
}

export interface KnowledgeGraphNeighborhood {
  entity: KnowledgeGraphEntityView | null;
  edges: KnowledgeGraphNeighborEdge[];
  /** True active degree from a count query — never the length of the capped page. */
  total: number;
}

export interface KnowledgeGraphMapSummary {
  /** Exact counts for a focused item, before the visual cap is applied. */
  predicateCounts: Array<{ predicate: string; count: number }>;
  neighborhood: KnowledgeGraphNeighborhood;
}

/** One expansion click's worth of second-hop neighbours. */
export const NEIGHBORHOOD_EXPANSION_LIMIT = 50;

/**
 * The map's own data path, separate from the review list. The overview's
 * relation page is capped at 80 and ordered unreviewed-first so the owner sees
 * what needs attention; drawing the map from it showed a skewed subset for
 * high-degree entities. This query is ordered for stable rendering instead —
 * confirmed edges first, then recency — and reports the true active degree.
 *
 * Used for both the initial neighbourhood and the client-driven expansion,
 * which is why it takes any entity id rather than the page's selected one.
 */
export async function getKnowledgeGraphNeighborhood(
  db: Db,
  input: { entityId: string; limit?: number; predicates?: string[] },
): Promise<KnowledgeGraphNeighborhood> {
  const agent = await getAgent(db);
  const entity = await agentEntity(db, input.entityId);
  if (!entity) return { entity: null, edges: [], total: 0 };
  const limit = Math.max(
    1,
    Math.min(input.limit ?? NEIGHBORHOOD_DEFAULT_LIMIT, NEIGHBORHOOD_MAX_LIMIT),
  );
  const predicates = input.predicates?.filter((predicate) => predicate.length > 0) ?? [];

  const subject = alias(knowledgeGraphEntities, 'neighbourhood_subject');
  const object = alias(knowledgeGraphEntities, 'neighbourhood_object');
  const incidentActive = and(
    or(
      eq(knowledgeGraphRelations.subjectEntityId, entity.id),
      eq(knowledgeGraphRelations.objectEntityId, entity.id),
    ),
    activeKnowledgeGraphWhere(agent.id),
    predicates.length > 0 ? inArray(knowledgeGraphRelations.predicate, predicates) : undefined,
  );
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: knowledgeGraphRelations.id,
        predicate: knowledgeGraphRelations.predicate,
        reviewStatus: knowledgeGraphRelations.reviewStatus,
        validFrom: knowledgeGraphRelations.validFrom,
        validUntil: knowledgeGraphRelations.validUntil,
        subjectId: knowledgeGraphRelations.subjectEntityId,
        objectId: knowledgeGraphRelations.objectEntityId,
        subjectLabel: displayLabel(subject),
        subjectKind: subject.kind,
        subjectCanonicalKey: subject.canonicalKey,
        objectLabel: displayLabel(object),
        objectKind: object.kind,
        objectCanonicalKey: object.canonicalKey,
      })
      .from(knowledgeGraphRelations)
      .innerJoin(subject, eq(knowledgeGraphRelations.subjectEntityId, subject.id))
      .innerJoin(object, eq(knowledgeGraphRelations.objectEntityId, object.id))
      .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
      .innerJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
      .where(incidentActive)
      .orderBy(
        asc(sql`CASE ${knowledgeGraphRelations.reviewStatus} WHEN 'confirmed' THEN 0 ELSE 1 END`),
        desc(knowledgeGraphRelations.createdAt),
      )
      .limit(limit),
    db
      .select({ value: count() })
      .from(knowledgeGraphRelations)
      .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
      .innerJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
      .where(incidentActive),
  ]);
  const edges = rows.map((row) => {
    const outbound = row.subjectId === entity.id;
    return {
      id: row.id,
      predicate: row.predicate,
      outbound,
      reviewStatus: asReviewStatus(row.reviewStatus),
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      other: outbound
        ? {
            id: row.objectId,
            label: row.objectLabel,
            kind: row.objectKind,
            canonicalKey: row.objectCanonicalKey,
          }
        : {
            id: row.subjectId,
            label: row.subjectLabel,
            kind: row.subjectKind,
            canonicalKey: row.subjectCanonicalKey,
          },
    };
  });
  return { entity, edges, total: Number(totalRow?.value ?? 0) };
}

/**
 * The focus-map data path: exact relationship counts, plus at most a small
 * one-hop neighbourhood. The browser must never fetch a hub merely to draw a
 * hairball.
 */
export async function getKnowledgeGraphMapSummary(
  db: Db,
  input: { entityId: string; predicates?: string[] },
): Promise<KnowledgeGraphMapSummary> {
  const agent = await getAgent(db);
  const entity = await agentEntity(db, input.entityId);
  if (!entity) {
    return { predicateCounts: [], neighborhood: { entity: null, edges: [], total: 0 } };
  }
  const predicates = input.predicates?.filter((predicate) => predicate.length > 0) ?? [];
  const incidentActive = and(
    or(
      eq(knowledgeGraphRelations.subjectEntityId, entity.id),
      eq(knowledgeGraphRelations.objectEntityId, entity.id),
    ),
    activeKnowledgeGraphWhere(agent.id),
  );
  const [counts, neighborhood] = await Promise.all([
    db
      .select({ predicate: knowledgeGraphRelations.predicate, value: count() })
      .from(knowledgeGraphRelations)
      .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
      .innerJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
      .where(incidentActive)
      .groupBy(knowledgeGraphRelations.predicate)
      .orderBy(desc(count())),
    getKnowledgeGraphNeighborhood(db, {
      entityId: entity.id,
      predicates,
      // A focus map has room for interaction and labels, not a 150-node star.
      limit: 24,
    }),
  ]);
  return {
    predicateCounts: counts.map((row) => ({ predicate: row.predicate, count: Number(row.value) })),
    neighborhood,
  };
}

/** One arrow in a flow chain: the relation traversed and the entity arrived at. */
export interface KnowledgeGraphPathStep {
  relationId: string;
  predicate: string;
  reviewStatus: KnowledgeGraphReviewStatus;
  /** Temporal qualifiers as canonical date keys, when the source states a span. */
  validFrom: string | null;
  validUntil: string | null;
  entity: KnowledgeGraphEntityView;
}

/**
 * A short, cycle-free chain away from the selected entity. steps[0] is the
 * first hop; steps[1], when present, continues from there.
 */
export interface KnowledgeGraphPath {
  steps: KnowledgeGraphPathStep[];
}

/** First-hop chains drawn in the paths view; each continues at most once. */
const PATH_LIMIT = 8;
/** Second-hop edges fetched for all chain endpoints together. */
const PATH_SECOND_HOP_LIMIT = 100;

/**
 * The managed alternative to a hairball: a handful of curated two-hop chains
 * rather than the whole neighbourhood at once. Chains are cycle-free by
 * construction — a continuation may not revisit the centre or the chain's own
 * first hop. The strongest continuation wins (confidence, then recency); a
 * first hop with none still renders as a one-step chain.
 */
export async function getKnowledgeGraphPaths(
  db: Db,
  input: { entityId: string },
): Promise<{ entity: KnowledgeGraphEntityView | null; paths: KnowledgeGraphPath[] }> {
  const agent = await getAgent(db);
  const entity = await agentEntity(db, input.entityId);
  if (!entity) return { entity: null, paths: [] };

  const firstHop = await getKnowledgeGraphNeighborhood(db, {
    entityId: entity.id,
    limit: PATH_LIMIT,
  });
  if (firstHop.edges.length === 0) return { entity, paths: [] };

  const endpointIds = firstHop.edges.map((edge) => edge.other.id);
  const subject = alias(knowledgeGraphEntities, 'paths_subject');
  const object = alias(knowledgeGraphEntities, 'paths_object');
  const secondHopRows = await db
    .select({
      id: knowledgeGraphRelations.id,
      predicate: knowledgeGraphRelations.predicate,
      reviewStatus: knowledgeGraphRelations.reviewStatus,
      validFrom: knowledgeGraphRelations.validFrom,
      validUntil: knowledgeGraphRelations.validUntil,
      confidence: knowledgeGraphRelations.confidence,
      subjectId: knowledgeGraphRelations.subjectEntityId,
      objectId: knowledgeGraphRelations.objectEntityId,
      subjectLabel: displayLabel(subject),
      subjectKind: subject.kind,
      subjectCanonicalKey: subject.canonicalKey,
      objectLabel: displayLabel(object),
      objectKind: object.kind,
      objectCanonicalKey: object.canonicalKey,
    })
    .from(knowledgeGraphRelations)
    .innerJoin(subject, eq(knowledgeGraphRelations.subjectEntityId, subject.id))
    .innerJoin(object, eq(knowledgeGraphRelations.objectEntityId, object.id))
    .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
    .innerJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
    .where(
      and(
        or(
          inArray(knowledgeGraphRelations.subjectEntityId, endpointIds),
          inArray(knowledgeGraphRelations.objectEntityId, endpointIds),
        ),
        activeKnowledgeGraphWhere(agent.id),
      ),
    )
    .orderBy(desc(knowledgeGraphRelations.confidence), desc(knowledgeGraphRelations.createdAt))
    .limit(PATH_SECOND_HOP_LIMIT);

  const secondHopByEndpoint = new Map<string, typeof secondHopRows>();
  for (const row of secondHopRows) {
    for (const endpoint of [row.subjectId, row.objectId]) {
      if (!endpointIds.includes(endpoint)) continue;
      const list = secondHopByEndpoint.get(endpoint) ?? [];
      list.push(row);
      secondHopByEndpoint.set(endpoint, list);
    }
  }

  const paths: KnowledgeGraphPath[] = firstHop.edges.map((edge) => {
    const first: KnowledgeGraphPathStep = {
      relationId: edge.id,
      predicate: edge.predicate,
      reviewStatus: edge.reviewStatus,
      validFrom: edge.validFrom,
      validUntil: edge.validUntil,
      entity: edge.other,
    };
    // The best continuation that neither returns to the centre nor loops back
    // onto the chain's own first hop.
    const continuation = (secondHopByEndpoint.get(edge.other.id) ?? []).find((row) => {
      const otherId = row.subjectId === edge.other.id ? row.objectId : row.subjectId;
      return otherId !== entity.id && otherId !== edge.other.id;
    });
    if (!continuation) return { steps: [first] };
    const outbound = continuation.subjectId === edge.other.id;
    return {
      steps: [
        first,
        {
          relationId: continuation.id,
          predicate: continuation.predicate,
          reviewStatus: asReviewStatus(continuation.reviewStatus),
          validFrom: continuation.validFrom,
          validUntil: continuation.validUntil,
          entity: outbound
            ? {
                id: continuation.objectId,
                label: continuation.objectLabel,
                kind: continuation.objectKind,
                canonicalKey: continuation.objectCanonicalKey,
              }
            : {
                id: continuation.subjectId,
                label: continuation.subjectLabel,
                kind: continuation.subjectKind,
                canonicalKey: continuation.subjectCanonicalKey,
              },
        },
      ],
    };
  });

  return { entity, paths };
}

/**
 * Type-ahead over every entity, replacing the old 200-row `<select>` payload.
 * The cap here bounds one dropdown's worth of results, not the reachable set:
 * anything can be found by narrowing the query, which is what the fixed list
 * could not do.
 */
export async function searchKnowledgeGraphEntities(
  db: Db,
  input: { query: string; excludeId?: string; kind?: string; limit?: number },
): Promise<KnowledgeGraphEntityView[]> {
  const agent = await getAgent(db);
  const query = cleanSearch(input.query);
  const excludeId = input.excludeId && UUID_RE.test(input.excludeId) ? input.excludeId : null;
  return db
    .select({
      id: knowledgeGraphEntities.id,
      label: displayLabel(knowledgeGraphEntities),
      kind: knowledgeGraphEntities.kind,
      canonicalKey: knowledgeGraphEntities.canonicalKey,
    })
    .from(knowledgeGraphEntities)
    .where(
      and(
        eq(knowledgeGraphEntities.agentId, agent.id),
        excludeId ? ne(knowledgeGraphEntities.id, excludeId) : undefined,
        input.kind ? eq(knowledgeGraphEntities.kind, input.kind) : undefined,
        query ? ilike(displayLabel(knowledgeGraphEntities), `%${query}%`) : undefined,
      ),
    )
    .orderBy(asc(sortLabel(knowledgeGraphEntities)))
    .limit(Math.min(input.limit ?? 20, 50));
}

/**
 * Advisory merge hints for one entity — never an automatic merge. Scoped to the
 * same kind and to a name-prefix relationship ("Anna" / "Anna Jónsdóttir"),
 * which is the same conservative rule `findDuplicateContactSuggestions` applies
 * to contacts. Candidates are bounded because the comparison is per-pair.
 */
export async function findDuplicateKnowledgeGraphEntities(
  db: Db,
  entity: KnowledgeGraphEntityView,
): Promise<KnowledgeGraphDuplicate[]> {
  const agent = await getAgent(db);
  const candidates = await db
    .select({
      id: knowledgeGraphEntities.id,
      label: displayLabel(knowledgeGraphEntities),
      kind: knowledgeGraphEntities.kind,
    })
    .from(knowledgeGraphEntities)
    .where(
      and(
        eq(knowledgeGraphEntities.agentId, agent.id),
        eq(knowledgeGraphEntities.kind, entity.kind),
        ne(knowledgeGraphEntities.id, entity.id),
      ),
    )
    .orderBy(asc(sortLabel(knowledgeGraphEntities)))
    .limit(500);
  const source = entity.label.toLocaleLowerCase();
  return candidates
    .filter((row) => namePrefixMatch(source, row.label.toLocaleLowerCase()))
    .slice(0, 5)
    .map((row) => ({
      targetId: row.id,
      label: row.label,
      kind: row.kind,
      reason: 'matching name',
    }));
}

async function agentEntity(db: Db, entityId: string): Promise<KnowledgeGraphEntityView | null> {
  if (!UUID_RE.test(entityId)) return null;
  const agent = await getAgent(db);
  const [entity] = await db
    .select({
      id: knowledgeGraphEntities.id,
      label: displayLabel(knowledgeGraphEntities),
      kind: knowledgeGraphEntities.kind,
      canonicalKey: knowledgeGraphEntities.canonicalKey,
    })
    .from(knowledgeGraphEntities)
    .where(
      and(eq(knowledgeGraphEntities.id, entityId), eq(knowledgeGraphEntities.agentId, agent.id)),
    )
    .limit(1);
  return entity ?? null;
}

export async function renameKnowledgeGraphEntity(
  db: Db,
  entityId: string,
  label: string,
): Promise<{ error?: string }> {
  const clean = label.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!clean) return { error: 'Enter a display name.' };
  const entity = await agentEntity(db, entityId);
  if (!entity) return { error: 'Knowledge item not found.' };
  await db
    .update(knowledgeGraphEntities)
    .set({ preferredLabel: clean, updatedAt: sql`now()` })
    .where(eq(knowledgeGraphEntities.id, entity.id));
  return {};
}

export async function mergeKnowledgeGraphEntities(
  db: Db,
  sourceId: string,
  targetId: string,
): Promise<{ error?: string }> {
  if (sourceId === targetId) return { error: 'Choose a different item to merge into.' };
  const [source, target] = await Promise.all([
    agentEntity(db, sourceId),
    agentEntity(db, targetId),
  ]);
  if (!source || !target) return { error: 'One of those knowledge items no longer exists.' };
  const agent = await getAgent(db);
  await mergeGraphEntities(db, agent.id, source.id, target.id);
  return {};
}

export async function reviewKnowledgeGraphRelation(
  db: Db,
  relationId: string,
  reviewStatus: 'confirmed' | 'rejected',
): Promise<boolean> {
  if (!UUID_RE.test(relationId)) return false;
  const agent = await getAgent(db);
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const [relation] = await scoped
      .select({ assertionId: knowledgeGraphRelations.assertionId })
      .from(knowledgeGraphRelations)
      .where(
        and(
          eq(knowledgeGraphRelations.id, relationId),
          eq(knowledgeGraphRelations.agentId, agent.id),
        ),
      )
      .for('update')
      .limit(1);
    if (!relation) return false;
    if (relation.assertionId) {
      const [assertion] = await scoped
        .select({
          semanticRevision: knowledgeGraphAssertions.semanticRevision,
          semanticKey: knowledgeGraphAssertions.semanticKey,
        })
        .from(knowledgeGraphAssertions)
        .where(
          and(
            eq(knowledgeGraphAssertions.id, relation.assertionId),
            eq(knowledgeGraphAssertions.agentId, agent.id),
          ),
        )
        .for('update')
        .limit(1);
      if (!assertion) throw new Error('Canonical knowledge assertion is missing');
      await scoped
        .update(knowledgeGraphAssertions)
        .set({
          reviewStatus,
          reviewedRevision: assertion.semanticRevision,
          reviewedPayloadHash: assertion.semanticKey,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(knowledgeGraphAssertions.id, relation.assertionId),
            eq(knowledgeGraphAssertions.agentId, agent.id),
            eq(knowledgeGraphAssertions.semanticRevision, assertion.semanticRevision),
            eq(knowledgeGraphAssertions.semanticKey, assertion.semanticKey),
          ),
        );
      await scoped
        .update(knowledgeGraphRelations)
        .set({ reviewStatus, reviewedAt: sql`now()` })
        .where(
          and(
            eq(knowledgeGraphRelations.assertionId, relation.assertionId),
            eq(knowledgeGraphRelations.agentId, agent.id),
          ),
        );
      return true;
    }
    await scoped
      .update(knowledgeGraphRelations)
      .set({ reviewStatus, reviewedAt: sql`now()` })
      .where(
        and(
          eq(knowledgeGraphRelations.id, relationId),
          eq(knowledgeGraphRelations.agentId, agent.id),
        ),
      );
    return true;
  });
}

/**
 * A graph correction never mutates evidence in place. It creates a replacement
 * owner-backed fact first, then retires the edge the owner corrected.
 */
export async function correctKnowledgeGraphRelation(
  db: Db,
  router: EmbeddingPort,
  relationId: string,
  input: {
    subjectLabel: string;
    subjectKind: string;
    subjectId?: string;
    predicate: string;
    objectLabel: string;
    objectKind: string;
    objectId?: string;
    note: string;
    sourceDisposition?: OwnerGraphCorrectionDisposition;
  },
): Promise<{
  error?: string;
  relationId?: string;
  memoryId?: string;
  sourceDisposition?: OwnerGraphCorrectionDisposition;
  alreadyApplied?: boolean;
}> {
  if (!UUID_RE.test(relationId)) return { error: 'That relationship no longer exists.' };
  const agent = await getAgent(db);
  const [existing] = await db
    .select({
      relationId: knowledgeGraphRelations.id,
      sourceMemoryId: memories.id,
      sourceContentHash: memories.contentHash,
      reviewStatus: knowledgeGraphRelations.reviewStatus,
      source: memories.source,
      sourceOriginTrust: memories.originTrust,
      sourceOwnerConfirmed: memories.ownerConfirmed,
      sourceSupersededById: memories.supersededById,
      sourceExpiresAt: memories.expiresAt,
      correctedByRelationId: knowledgeGraphRelations.correctedByRelationId,
      correctionSourceContentHash: knowledgeGraphRelations.correctionSourceContentHash,
      correctionDisposition: knowledgeGraphRelations.correctionDisposition,
    })
    .from(knowledgeGraphRelations)
    .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
    .where(
      and(
        eq(knowledgeGraphRelations.id, relationId),
        eq(knowledgeGraphRelations.agentId, agent.id),
        eq(memories.agentId, agent.id),
      ),
    )
    .limit(1);
  if (!existing) return { error: 'That relationship no longer exists.' };
  if (existing.correctedByRelationId) {
    const [replacement] = await db
      .select({ id: knowledgeGraphRelations.id, memoryId: knowledgeGraphRelations.sourceMemoryId })
      .from(knowledgeGraphRelations)
      .where(
        and(
          eq(knowledgeGraphRelations.id, existing.correctedByRelationId),
          eq(knowledgeGraphRelations.agentId, agent.id),
        ),
      )
      .limit(1);
    return replacement
      ? {
          relationId: replacement.id,
          memoryId: replacement.memoryId,
          sourceDisposition:
            existing.correctionDisposition === 'whole_fact' ? 'whole_fact' : 'graph_only',
          alreadyApplied: true,
        }
      : {
          error: 'The saved correction receipt needs repair before this fact can be changed again.',
        };
  }
  const disposition: OwnerGraphCorrectionDisposition = input.sourceDisposition ?? 'graph_only';
  const { sourceDisposition: _sourceDisposition, ...fact } = input;
  const target: OwnerGraphCorrectionTarget = {
    ...existing,
    correctionDisposition:
      existing.correctionDisposition === 'graph_only' ||
      existing.correctionDisposition === 'whole_fact'
        ? existing.correctionDisposition
        : null,
  };
  const isKind = (value: string): value is GraphEntityKind =>
    (GRAPH_ENTITY_KINDS as readonly string[]).includes(value);
  return createOwnerKnowledgeGraphFact(
    { db, router, agentId: agent.id },
    {
      subject: {
        label: fact.subjectLabel,
        kind: isKind(fact.subjectKind) ? fact.subjectKind : 'topic',
        id: fact.subjectId,
      },
      predicate: fact.predicate,
      object: {
        label: fact.objectLabel,
        kind: isKind(fact.objectKind) ? fact.objectKind : 'topic',
        id: fact.objectId,
      },
      note: fact.note,
    },
    { target, disposition },
  );
}

/**
 * Re-extract the sources whose dates only a date-anchored prompt can resolve.
 * Unlike the nightly backfill this spends money — one metered model call per
 * source — so it is an explicit owner action rather than something that happens
 * on a schedule.
 */
export async function reextractRelativeDateSources(db: Db): Promise<number> {
  const agent = await getAgent(db);
  return requeueRelativeDateSources(db, agent.id);
}

/** Queue the next normal graph-sync attempt for every source the owner has chosen to retry. */
export async function retryQuarantinedKnowledgeGraphSources(db: Db): Promise<number> {
  const agent = await getAgent(db);
  return retryQuarantinedSources(db, agent.id);
}

export async function retypeKnowledgeGraphEntity(
  db: Db,
  entityId: string,
  kind: string,
): Promise<{ error?: string }> {
  const next = asGraphEntityKind(kind);
  if (!next) return { error: 'Choose a valid type.' };
  const agent = await getAgent(db);
  return retypeGraphEntity(db, agent.id, entityId, next);
}

export async function addOwnerKnowledgeGraphFact(
  db: Db,
  router: EmbeddingPort,
  input: {
    subjectLabel: string;
    subjectKind: string;
    subjectId?: string;
    /** Pins a typed subject to a known contact; see OwnerGraphFactInput. */
    subjectContactId?: string;
    predicate: string;
    objectLabel: string;
    objectKind: string;
    objectId?: string;
    note: string;
  },
): Promise<{ error?: string; relationId?: string }> {
  // The domain owns the kind list; re-declaring it here let the two drift.
  const isKind = (value: string): value is GraphEntityKind =>
    (GRAPH_ENTITY_KINDS as readonly string[]).includes(value);
  // An endpoint with an id gets its kind from the entity itself; the form's
  // kind field is only meaningful for a free-typed (new) entity.
  if (!input.subjectId && !isKind(input.subjectKind)) {
    return { error: 'Choose a valid source type.' };
  }
  if (!input.objectId && !isKind(input.objectKind)) {
    return { error: 'Choose a valid target type.' };
  }
  return createOwnerKnowledgeGraphFact(
    { db, router },
    {
      subject: {
        label: input.subjectLabel,
        kind: isKind(input.subjectKind) ? input.subjectKind : 'topic',
        id: input.subjectId,
        contactId: input.subjectContactId,
      },
      predicate: input.predicate,
      object: {
        label: input.objectLabel,
        kind: isKind(input.objectKind) ? input.objectKind : 'topic',
        id: input.objectId,
      },
      note: input.note,
    },
  );
}

/** Same owner-fact use case for non-SQL stores; persistence owns only reads and atomic writes. */
export async function addOwnerKnowledgeGraphFactFromRepository(
  repository: OwnerKnowledgeGraphFactRepository,
  router: EmbeddingPort,
  input: {
    subjectLabel: string;
    subjectKind: string;
    subjectId?: string;
    subjectContactId?: string;
    predicate: string;
    objectLabel: string;
    objectKind: string;
    objectId?: string;
    note: string;
  },
): Promise<{ error?: string; relationId?: string; memoryId?: string }> {
  const isKind = (value: string): value is GraphEntityKind =>
    (GRAPH_ENTITY_KINDS as readonly string[]).includes(value);
  if (!input.subjectId && !isKind(input.subjectKind))
    return { error: 'Choose a valid source type.' };
  if (!input.objectId && !isKind(input.objectKind)) return { error: 'Choose a valid target type.' };
  return createOwnerKnowledgeGraphFactWithRepository(
    { repository, router },
    {
      subject: {
        label: input.subjectLabel,
        kind: isKind(input.subjectKind) ? input.subjectKind : 'topic',
        id: input.subjectId,
        contactId: input.subjectContactId,
      },
      predicate: input.predicate,
      object: {
        label: input.objectLabel,
        kind: isKind(input.objectKind) ? input.objectKind : 'topic',
        id: input.objectId,
      },
      note: input.note,
    },
  );
}

/** Portable-store correction; the repository commits replacement and retirement together. */
export async function correctOwnerKnowledgeGraphFactFromRepository(
  repository: OwnerKnowledgeGraphFactRepository,
  router: EmbeddingPort,
  relationId: string,
  input: {
    subjectLabel: string;
    subjectKind: string;
    subjectId?: string;
    subjectContactId?: string;
    predicate: string;
    objectLabel: string;
    objectKind: string;
    objectId?: string;
    note: string;
    sourceDisposition?: OwnerGraphCorrectionDisposition;
  },
) {
  const isKind = (value: string): value is GraphEntityKind =>
    (GRAPH_ENTITY_KINDS as readonly string[]).includes(value);
  if (!input.subjectId && !isKind(input.subjectKind))
    return { error: 'Choose a valid source type.' };
  if (!input.objectId && !isKind(input.objectKind)) return { error: 'Choose a valid target type.' };
  const { sourceDisposition = 'graph_only', ...fact } = input;
  return correctOwnerKnowledgeGraphFactWithRepository(
    { repository, router },
    relationId,
    {
      subject: {
        label: fact.subjectLabel,
        kind: isKind(fact.subjectKind) ? fact.subjectKind : 'topic',
        id: fact.subjectId,
        contactId: fact.subjectContactId,
      },
      predicate: fact.predicate,
      object: {
        label: fact.objectLabel,
        kind: isKind(fact.objectKind) ? fact.objectKind : 'topic',
        id: fact.objectId,
      },
      note: fact.note,
    },
    sourceDisposition,
  );
}
