import type {
  DerivedKnowledgeView,
  KnowledgeAssertionEndpointView,
} from './knowledge-assertions.js';

/** Display projection of one knowledge graph entity. */
export interface KnowledgeWorkspaceEntity {
  id: string;
  label: string;
  kind: string;
  canonicalKey: string;
}

/** Minimal canonical meaning needed to build a focus-specific map label. */
export interface KnowledgeMapAssertionContext {
  id: string;
  semanticRevision: number;
  lifecycle: string;
  reviewStatus: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string;
  evidenceCount: number;
}

/** One active, source-backed edge with its endpoints and source memory joined. */
export interface KnowledgeMapEdgeRecord {
  id: string;
  predicate: string;
  reviewStatus: string;
  subjectId: string;
  subjectLabel: string;
  subjectKind: string;
  subjectContactId: string | null;
  objectId: string;
  objectLabel: string;
  objectKind: string;
  objectContactId: string | null;
  sourceMemoryId: string;
  sourceContent: string;
  evidenceQuote: string | null;
  validFrom: string | null;
  validUntil: string | null;
  /** Absent for pre-assertion/legacy edges; the UI keeps its generic wording. */
  assertionContext?: KnowledgeMapAssertionContext | null;
}

export interface KnowledgeMapEdgeFilter {
  query: string;
  kind: string;
  predicates: string[];
  review: 'all' | 'unreviewed' | 'confirmed' | 'rejected';
  sourceMemoryId: string;
  entityId?: string;
}

/** Owner-scoped rows behind the cleanup list, already ordered and capped. */
export interface KnowledgeCleanupSource {
  /** Knowledge memories that are quarantined, expired, or superseded; newest first, at most 100. */
  memories: Array<{
    id: string;
    content: string;
    quarantined: boolean;
    supersededById: string | null;
  }>;
  /** Unreviewed or rejected relations with their source memory; at most 50. */
  relations: Array<{ id: string; memoryId: string; content: string; reviewStatus: string }>;
  /** Failed or quarantined graph sources of owner memories; at most 50. */
  sources: Array<{ memoryId: string; status: string }>;
  orphanedEntities: number;
}

export interface KnowledgeWorkspaceMemoryHealth {
  totalUsable: number;
  notYetOrganized: number;
  awaitingReview: number;
  ownerConfirmed: number;
  lastOrganizedAt: Date | null;
}

export interface KnowledgeWorkspaceGraphCounts {
  activeEntities: number;
  activeRelations: number;
  orphanedEntities: number;
  pendingSources: number;
  failedSources: number;
}

/** A selected entity with the evidence the workspace edits it from. */
export interface KnowledgeWorkspaceFocus {
  selected: KnowledgeWorkspaceEntity;
  duplicates: Array<{ targetId: string; label: string; kind: string; reason: string }>;
  derivedRelations?: DerivedKnowledgeView[];
  derivedCoverage?: 'complete' | 'bounded_incomplete';
  relations: Array<{
    id: string;
    subject: KnowledgeWorkspaceEntity;
    predicate: string;
    object: KnowledgeWorkspaceEntity;
    reviewStatus: 'unreviewed' | 'confirmed' | 'rejected';
    inRecall: boolean;
    endpointViews?: KnowledgeAssertionEndpointView[];
    source: { memoryId: string; content: string };
  }>;
}

/**
 * One consistent read of the owner's knowledge workspace. The counts and the
 * cleanup rows are materialized; map rows hydrate their source text on demand
 * so a page only pays for the edges it draws.
 */
export interface KnowledgeWorkspaceSnapshot {
  memory: KnowledgeWorkspaceMemoryHealth;
  graph: KnowledgeWorkspaceGraphCounts;
  cleanup: KnowledgeCleanupSource;
  /** Matching active edges, newest first with an id tiebreak, plus the exact match count. */
  mapEdges(
    filter: KnowledgeMapEdgeFilter,
    limit: number,
  ): Promise<{ rows: KnowledgeMapEdgeRecord[]; total: number }>;
  /** Active edges whose endpoints are both in `entityIds`, newest first. */
  interiorEdges(entityIds: string[], limit: number): Promise<KnowledgeMapEdgeRecord[]>;
  /** The owner's entity, its incident edges (at most 80), and advisory merge hints. */
  focus(entityId: string): Promise<KnowledgeWorkspaceFocus | null>;
}

export interface KnowledgeNeighborEdgeRecord {
  id: string;
  predicate: string;
  outbound: boolean;
  reviewStatus: 'unreviewed' | 'confirmed' | 'rejected';
  validFrom: string | null;
  validUntil: string | null;
  other: KnowledgeWorkspaceEntity;
}

export interface KnowledgeWorkspaceReadRepository {
  readonly kind: 'knowledge-workspace-read-repository';
  snapshot(input: { extractionVersion: number; now: Date }): Promise<KnowledgeWorkspaceSnapshot>;
  entity(entityId: string): Promise<KnowledgeWorkspaceEntity | null>;
  /** Active incident edges, confirmed first then newest; `total` is the exact active degree. */
  neighborhood(input: {
    entityId: string;
    limit: number;
    predicates: string[];
    extractionVersion: number;
    now: Date;
  }): Promise<{
    entity: KnowledgeWorkspaceEntity | null;
    edges: KnowledgeNeighborEdgeRecord[];
    total: number;
  }>;
  /** `null` when the contact is unknown or the owner; otherwise its graph entity, if any. */
  personEntity(contactId: string): Promise<{ entityId: string | null } | null>;
  /** What forgetting one owner memory removes from the graph; `null` when it is not the owner's. */
  sourceImpact(input: { memoryId: string; extractionVersion: number; now: Date }): Promise<{
    content: string;
    connectionCount: number;
    activeConnectionCount: number;
    orphanedItems: Array<{ id: string; label: string }>;
  } | null>;
}
