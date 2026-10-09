import type { MemoryHealth } from '@assistant/core/memory/health';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import type {
  KnowledgeAssertionEndpointView,
  KnowledgeCleanupSource,
  KnowledgeMapEdgeRecord,
  KnowledgeWorkspaceReadRepository,
} from '@assistant/persistence';
import { knowledgeAssertionEndpointView } from '@assistant/persistence';
import type {
  KnowledgeGraphDuplicate,
  KnowledgeGraphEntityView,
  KnowledgeGraphNeighborhood,
  KnowledgeGraphReviewStatus,
} from './knowledge-graph.js';
import {
  presentKnowledgeGraphRelation,
  type RelationshipPresentation,
} from './relationship-presentation.js';

export type KnowledgeCleanupKind =
  | 'quarantined'
  | 'expired'
  | 'superseded'
  | 'unreviewed_connection'
  | 'rejected_connection'
  | 'projection_orphan'
  | 'projection_failed';

export interface KnowledgeCleanupFinding {
  id: string;
  kind: KnowledgeCleanupKind;
  title: string;
  detail: string;
  memoryId: string | null;
  relationId: string | null;
  count: number;
  /** Extra source-level work folded into this card instead of duplicated beside it. */
  relatedKinds?: KnowledgeCleanupKind[];
}

export interface KnowledgeWorkspaceOverview {
  memory: MemoryHealth;
  graph: {
    activeEntities: number;
    activeRelations: number;
    orphanedEntities: number;
    pendingSources: number;
    failedSources: number;
  };
  cleanupCount: number;
}

export interface KnowledgeMapNode {
  id: string;
  contactId?: string | null;
  label: string;
  kind: string;
  component: number;
  degree: number;
}

export interface KnowledgeMapEdge {
  id: string;
  subjectId: string;
  objectId: string;
  predicate: string;
  reviewStatus: KnowledgeGraphReviewStatus;
  sourceMemoryId: string;
  sourceContent: string;
  evidenceQuote: string | null;
  presentation: RelationshipPresentation;
  validFrom: string | null;
  validUntil: string | null;
  endpointViews?: KnowledgeAssertionEndpointView[];
}

export interface KnowledgeMapComponent {
  id: number;
  nodes: number;
  edges: number;
  label: string;
}

export interface KnowledgeMapSnapshot {
  nodes: KnowledgeMapNode[];
  edges: KnowledgeMapEdge[];
  components: KnowledgeMapComponent[];
  totalEdges: number;
  truncated: boolean;
  filters: {
    query: string;
    kind: string;
    predicates: string[];
    review: 'all' | KnowledgeGraphReviewStatus;
    sourceMemoryId: string;
  };
}

export interface KnowledgeSourceImpact {
  memoryId: string;
  content: string;
  /** Legacy total of all stored projections removed with this source. */
  connectionCount: number;
  /** Connections currently visible on the map and eligible for graph recall. */
  activeConnectionCount: number;
  /** Retired, rejected, or stale derived rows that are cleared alongside the source. */
  retiredProjectionCount: number;
  orphanedItems: Array<{ id: string; label: string }>;
}

export interface KnowledgeMapInput {
  query?: string;
  kind?: string;
  predicates?: string[];
  review?: 'all' | KnowledgeGraphReviewStatus;
  sourceMemoryId?: string;
  entityId?: string;
  includeVisibleConnections?: boolean;
  /** Scan all eligible claims before applying the larger overview display bounds. */
  completeOverview?: boolean;
}

export const MAP_NODE_LIMIT = 200;
export const MAP_EDGE_FETCH_LIMIT = 500;
export const MAP_OVERVIEW_NODE_LIMIT = 1000;
export const MAP_OVERVIEW_EDGE_LIMIT = 10000;
/** Visible-topology completion: at most this many edges in total, fetched one past the cap. */
const MAP_VISIBLE_EDGE_LIMIT = 1000;
/**
 * First paint of the interactive map. 150 keeps a hub readable while covering
 * nearly every real entity; the server clamps anything larger to 250.
 */
export const NEIGHBORHOOD_DEFAULT_LIMIT = 150;
export const NEIGHBORHOOD_MAX_LIMIT = 250;

export function knowledgeMapFilters(input: KnowledgeMapInput): KnowledgeMapSnapshot['filters'] {
  return {
    query: (input.query ?? '').trim().slice(0, 120),
    kind: input.kind ?? '',
    predicates: (input.predicates ?? []).filter(Boolean).slice(0, 20),
    review: input.review ?? 'all',
    sourceMemoryId: input.sourceMemoryId ?? '',
  };
}

export function buildKnowledgeCleanupFindings(
  source: KnowledgeCleanupSource,
): KnowledgeCleanupFinding[] {
  const findings: KnowledgeCleanupFinding[] = source.memories.map((memory) => {
    const kind: KnowledgeCleanupKind = memory.quarantined
      ? 'quarantined'
      : memory.supersededById
        ? 'superseded'
        : 'expired';
    return {
      id: `${kind}:${memory.id}`,
      kind,
      title:
        kind === 'quarantined'
          ? 'Review an unverified memory'
          : kind === 'superseded'
            ? 'Remove an older version'
            : 'Review expired knowledge',
      detail: memory.content,
      memoryId: memory.id,
      relationId: null,
      count: 1,
      relatedKinds: [],
    };
  });
  for (const relation of source.relations) {
    const unreviewed = relation.reviewStatus === 'unreviewed';
    findings.push({
      id: `${unreviewed ? 'unreviewed_connection' : 'rejected_connection'}:${relation.id}`,
      kind: unreviewed ? 'unreviewed_connection' : 'rejected_connection',
      title: unreviewed ? 'Review a new connection' : 'Retire a rejected connection source',
      detail: relation.content,
      memoryId: relation.memoryId,
      relationId: relation.id,
      count: 1,
    });
  }
  for (const graphSource of source.sources) {
    const relatedSourceFinding = findings.find(
      (finding) => finding.memoryId === graphSource.memoryId && finding.relationId === null,
    );
    if (relatedSourceFinding) {
      relatedSourceFinding.relatedKinds = [
        ...(relatedSourceFinding.relatedKinds ?? []),
        'projection_failed',
      ];
      continue;
    }
    findings.push({
      id: `projection_failed:${graphSource.memoryId}`,
      kind: 'projection_failed',
      title: 'Graph processing needs attention',
      detail:
        graphSource.status === 'quarantined'
          ? 'Automatic retries were exhausted.'
          : 'The latest graph extraction failed.',
      memoryId: graphSource.memoryId,
      relationId: null,
      count: 1,
    });
  }
  if (source.orphanedEntities > 0) {
    findings.unshift({
      id: 'projection_orphan:all',
      kind: 'projection_orphan',
      title: 'Remove disconnected graph items',
      detail:
        'These derived items have no source-backed connections and are never used for recall.',
      memoryId: null,
      relationId: null,
      count: source.orphanedEntities,
    });
  }
  return findings;
}

/**
 * Draw the map from eligible rows. Complete overviews allocate space to
 * distinct connections before repeated evidence; compact previews keep their
 * existing recency bounds. `interior` completes the
 * visible topology with existing eligible edges between drawn nodes, so recent
 * records cannot hide old bridges; it never infers relationships.
 */
export async function assembleKnowledgeMapSnapshot(input: {
  rows: KnowledgeMapEdgeRecord[];
  completeOverview?: boolean;
  totalEdges: number;
  filters: KnowledgeMapSnapshot['filters'];
  interior?: (entityIds: string[], limit: number) => Promise<KnowledgeMapEdgeRecord[]>;
}): Promise<KnowledgeMapSnapshot> {
  const nodeLimit = input.completeOverview ? MAP_OVERVIEW_NODE_LIMIT : MAP_NODE_LIMIT;
  const edgeLimit = input.completeOverview ? MAP_OVERVIEW_EDGE_LIMIT : MAP_VISIBLE_EDGE_LIMIT;
  const nodeData = new Map<
    string,
    { id: string; label: string; kind: string; degree: number; contactId: string | null }
  >();
  const edges: KnowledgeMapEdge[] = [];
  const edgeIds = new Set<string>();
  const endpointViewsFor = (
    row: KnowledgeMapEdgeRecord,
  ): KnowledgeAssertionEndpointView[] | undefined => {
    const assertion = row.assertionContext;
    if (
      !assertion ||
      assertion.lifecycle !== 'current' ||
      assertion.subjectEntityId !== row.subjectId ||
      assertion.predicate !== row.predicate ||
      assertion.objectEntityId !== row.objectId ||
      !Number.isInteger(assertion.semanticRevision) ||
      assertion.semanticRevision < 1
    )
      return undefined;
    const reviewStatus =
      assertion.reviewStatus === 'confirmed' || assertion.reviewStatus === 'rejected'
        ? assertion.reviewStatus
        : 'unreviewed';
    const views = [row.subjectId, row.objectId].flatMap((id) => {
      const view = knowledgeAssertionEndpointView({
        assertionId: assertion.id,
        semanticRevision: assertion.semanticRevision,
        subjectEntityId: row.subjectId,
        subjectLabel: row.subjectLabel,
        predicate: row.predicate,
        objectEntityId: row.objectId,
        objectLabel: row.objectLabel,
        evidenceQuote: row.evidenceQuote ?? row.sourceContent,
        evidenceCount: assertion.evidenceCount,
        reviewStatus,
        focusEntityId: id,
      });
      return view ? [view] : [];
    });
    return views.length > 0 ? views : undefined;
  };
  const appendRow = (row: KnowledgeMapEdgeRecord) => {
    if (edgeIds.has(row.id) || edges.length >= edgeLimit) return;
    const newIds = [row.subjectId, row.objectId].filter((id) => !nodeData.has(id));
    if (nodeData.size + new Set(newIds).size > nodeLimit) return;
    edgeIds.add(row.id);
    nodeData.set(row.subjectId, {
      id: row.subjectId,
      label: row.subjectLabel,
      kind: row.subjectKind,
      contactId: row.subjectContactId,
      degree: (nodeData.get(row.subjectId)?.degree ?? 0) + 1,
    });
    nodeData.set(row.objectId, {
      id: row.objectId,
      label: row.objectLabel,
      kind: row.objectKind,
      contactId: row.objectContactId,
      degree: (nodeData.get(row.objectId)?.degree ?? 0) + 1,
    });
    edges.push({
      id: row.id,
      subjectId: row.subjectId,
      objectId: row.objectId,
      predicate: row.predicate,
      reviewStatus: row.reviewStatus as KnowledgeGraphReviewStatus,
      sourceMemoryId: row.sourceMemoryId,
      sourceContent: row.sourceContent,
      evidenceQuote: row.evidenceQuote,
      presentation: presentKnowledgeGraphRelation(row),
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      endpointViews: endpointViewsFor(row),
    });
  };
  if (input.completeOverview) {
    // Draw each distinct directed, time-qualified claim before extra evidence
    // rows. A frequently mentioned pair must not displace another person.
    const connections = new Set<string>();
    for (const row of input.rows) {
      const key = JSON.stringify([
        row.subjectId,
        row.objectId,
        row.predicate,
        row.validFrom,
        row.validUntil,
      ]);
      if (connections.has(key)) continue;
      connections.add(key);
      appendRow(row);
    }
  }
  input.rows.forEach(appendRow);
  const overviewEdgeCount = edges.length;
  let visibleConnectionsTruncated = false;
  if (input.interior && nodeData.size > 0) {
    const interior = await input.interior([...nodeData.keys()], edgeLimit + 1);
    for (const row of interior) {
      if (edgeIds.has(row.id)) continue;
      if (edges.length >= edgeLimit) {
        visibleConnectionsTruncated = true;
        break;
      }
      appendRow(row);
    }
  }
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    adjacency.set(edge.subjectId, (adjacency.get(edge.subjectId) ?? new Set()).add(edge.objectId));
    adjacency.set(edge.objectId, (adjacency.get(edge.objectId) ?? new Set()).add(edge.subjectId));
  }
  const componentFor = new Map<string, number>();
  let componentId = 0;
  for (const id of nodeData.keys()) {
    if (componentFor.has(id)) continue;
    const queue = [id];
    componentFor.set(id, componentId);
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      for (const next of adjacency.get(current) ?? []) {
        if (componentFor.has(next)) continue;
        componentFor.set(next, componentId);
        queue.push(next);
      }
    }
    componentId += 1;
  }
  const nodes = [...nodeData.values()].map((node) => ({
    ...node,
    component: componentFor.get(node.id) ?? 0,
  }));
  const components = Array.from({ length: componentId }, (_, id) => {
    const members = nodes.filter((node) => node.component === id);
    const componentEdges = edges.filter(
      (edge) => componentFor.get(edge.subjectId) === id && componentFor.get(edge.objectId) === id,
    );
    return {
      id,
      nodes: members.length,
      edges: componentEdges.length,
      label: [...members].sort((a, b) => b.degree - a.degree)[0]?.label ?? 'Connected knowledge',
    };
  }).sort((a, b) => b.nodes - a.nodes);
  return {
    nodes,
    edges,
    components,
    totalEdges: input.totalEdges,
    truncated:
      input.totalEdges > (input.completeOverview ? edges.length : overviewEdgeCount) ||
      visibleConnectionsTruncated,
    filters: input.filters,
  };
}

/** SQL-free knowledge workspace reads over a driver's repository. */
export function knowledgeWorkspaceQueries(repository: KnowledgeWorkspaceReadRepository) {
  return {
    /** One snapshot serves the header, the cleanup list, the map, and an entity focus. */
    async load() {
      const snapshot = await repository.snapshot({
        extractionVersion: GRAPH_EXTRACTION_VERSION,
        now: new Date(),
      });
      const findings = buildKnowledgeCleanupFindings(snapshot.cleanup);
      const overview: KnowledgeWorkspaceOverview = {
        memory: snapshot.memory,
        graph: snapshot.graph,
        cleanupCount: findings.reduce((total, finding) => total + finding.count, 0),
      };
      return {
        overview,
        findings,
        async map(input: KnowledgeMapInput = {}): Promise<KnowledgeMapSnapshot> {
          const filters = knowledgeMapFilters(input);
          const { rows, total } = await snapshot.mapEdges(
            { ...filters, entityId: input.entityId },
            input.completeOverview ? Number.MAX_SAFE_INTEGER : MAP_EDGE_FETCH_LIMIT,
          );
          return assembleKnowledgeMapSnapshot({
            rows,
            completeOverview: input.completeOverview,
            totalEdges: total,
            filters,
            interior: input.includeVisibleConnections
              ? (ids, limit) => snapshot.interiorEdges(ids, limit)
              : undefined,
          });
        },
        async focus(entityId: string): Promise<{
          selected: KnowledgeGraphEntityView;
          duplicates: KnowledgeGraphDuplicate[];
          relations: Array<{
            id: string;
            reviewStatus: KnowledgeGraphReviewStatus;
            inRecall: boolean;
            presentation: RelationshipPresentation;
            source: { memoryId: string; content: string };
          }>;
        } | null> {
          const focus = await snapshot.focus(entityId);
          if (!focus) return null;
          return {
            selected: focus.selected,
            duplicates: focus.duplicates,
            relations: focus.relations.map((relation) => ({
              id: relation.id,
              reviewStatus: relation.reviewStatus,
              inRecall: relation.inRecall,
              presentation: presentKnowledgeGraphRelation({
                subjectLabel: relation.subject.label,
                predicate: relation.predicate,
                objectLabel: relation.object.label,
              }),
              source: relation.source,
            })),
          };
        },
      };
    },
    /** The map's expansion path; the limit is clamped exactly as the PostgreSQL query clamps it. */
    neighborhood(input: {
      entityId: string;
      limit?: number;
      predicates?: string[];
    }): Promise<KnowledgeGraphNeighborhood> {
      return repository.neighborhood({
        entityId: input.entityId,
        limit: Math.max(
          1,
          Math.min(input.limit ?? NEIGHBORHOOD_DEFAULT_LIMIT, NEIGHBORHOOD_MAX_LIMIT),
        ),
        predicates: input.predicates?.filter((predicate) => predicate.length > 0) ?? [],
        extractionVersion: GRAPH_EXTRACTION_VERSION,
        now: new Date(),
      });
    },
    entity: (entityId: string) => repository.entity(entityId),
    async sourceImpact(memoryId: string): Promise<KnowledgeSourceImpact | null> {
      const impact = await repository.sourceImpact({
        memoryId,
        extractionVersion: GRAPH_EXTRACTION_VERSION,
        now: new Date(),
      });
      if (!impact) return null;
      return {
        memoryId,
        content: impact.content,
        // Kept for native clients released before the active/retired split.
        connectionCount: impact.connectionCount,
        activeConnectionCount: impact.activeConnectionCount,
        retiredProjectionCount: Math.max(0, impact.connectionCount - impact.activeConnectionCount),
        orphanedItems: impact.orphanedItems,
      };
    },
    personEntity: (contactId: string) => repository.personEntity(contactId),
  };
}
