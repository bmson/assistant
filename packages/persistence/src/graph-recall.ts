import type { KnowledgeGraphAssertion } from './knowledge-graph-sync.js';

export interface GraphRelation {
  relationId: string;
  subjectEntityId: string;
  subjectLabel: string;
  predicate: string;
  assertion: KnowledgeGraphAssertion;
  objectEntityId: string;
  objectLabel: string;
  sourceMemoryId: string;
  content: string;
  evidenceQuote: string | null;
  createdAt: Date;
  confidence: string | number;
  /** Canonical date keys bounding the relationship's span, when stated. */
  validFrom: string | null;
  validUntil: string | null;
  similarity?: number | string;
}

export interface GraphRecallRepository {
  readonly kind: 'graph-recall-repository';
  seeds(input: {
    agentId: string;
    embedding: number[];
    limit: number;
    extractionVersion: number;
  }): Promise<GraphRelation[]>;
  connected(input: {
    agentId: string;
    entityIds: string[];
    sourceMemoryIds: string[];
    limit: number;
    extractionVersion: number;
  }): Promise<GraphRelation[]>;
}

/** One source-backed relationship as the `memory.graph_snapshot` tool reports it. */
export interface GraphSnapshotRelation {
  id: string;
  subjectId: string;
  subjectLabel: string;
  subjectKind: string;
  predicate: string;
  assertion: KnowledgeGraphAssertion;
  objectId: string;
  objectLabel: string;
  objectKind: string;
  sourceMemoryId: string;
  sourceMemory: string;
  source: string | null;
  memoryConfidence: string | number;
  ownerConfirmed: boolean;
  evidenceQuote: string | null;
  relationshipConfidence: string | number;
  validFrom: string | null;
  validUntil: string | null;
  similarity: number;
}

/** Nearest verified relationships by source-memory similarity, owner-scoped. */
export interface GraphSnapshotRepository {
  snapshot(input: {
    agentId: string;
    embedding: number[];
    limit: number;
    extractionVersion: number;
  }): Promise<GraphSnapshotRelation[]>;
}
