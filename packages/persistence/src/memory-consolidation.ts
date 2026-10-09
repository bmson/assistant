/** Bounded storage operations for the model-driven memory consolidation worker. */
export const CONSOLIDATION_WINDOW_LIMIT = 60;
export const CONSOLIDATION_CANDIDATE_LIMIT = 120;

export interface ConsolidationFact {
  id: string;
  agentId: string;
  subjectContactId: string | null;
  content: string;
  kind: string;
  confidence: string;
  importance: number;
  domain: string | null;
  ownerConfirmed: boolean;
  pinned: boolean;
  lastConsolidatedAt: Date | null;
  createdAt: Date;
  validFrom: Date | null;
  validUntil: Date | null;
  /** Import sources whose content contributes to this fact, when known. */
  importSources?: string[];
  /** Exact source-unit audit spans retained when a fact is rewritten. */
  importSourceProvenance?: Array<{
    source: string;
    sourceUnitProvenance: import('./import-jobs.js').ImportUnitProvenance[];
  }>;
  /** Opaque optimistic concurrency token from the storage adapter. */
  version: string;
}

export interface ConsolidationCandidateBatch {
  /** Subjectless and one-fact subjects that can be stamped without model review. */
  standalone: ConsolidationFact[];
  /** At most one person, with least recently reviewed facts first. */
  window: { subjectContactId: string; facts: ConsolidationFact[] } | null;
}

export interface ConsolidationMerge {
  id: string;
  content: string;
  contentHash: string;
  embedding: number[];
  embeddingSpaceKey: string;
  kind: string;
  confidence: string;
  importance: number;
  domain: string | null;
  sourceTaskId: string | null;
  memberIds: string[];
}

export interface ConsolidationReview {
  agentId: string;
  subjectContactId: string;
  /** Exactly the window returned by candidates; all rows are stamped on success. */
  facts: ConsolidationFact[];
  retirements: Array<{ id: string; supersededById: string }>;
  merges: ConsolidationMerge[];
  domainFixes: Array<{ id: string; domain: string }>;
  timeline: Array<{ id: string; validFrom?: Date; validUntil?: Date }>;
  occasions?: Array<{
    kind: 'birthday' | 'anniversary' | 'custom';
    label: string;
    month: number;
    day: number;
    year: number | null;
    notes: string;
  }>;
}

export interface ConsolidationReviewResult {
  retired: string[];
  merged: string[];
  domainsAssigned: string[];
  occasionsSaved?: number;
}

export interface MemoryConsolidationRepository {
  readonly kind: 'memory-consolidation-repository';
  candidates(agentId: string): Promise<ConsolidationCandidateBatch>;
  stampStandalone(agentId: string, facts: ConsolidationFact[]): Promise<number>;
  /** One atomic review; stale or foreign rows fail without partial writes. */
  applyReview(input: ConsolidationReview): Promise<ConsolidationReviewResult>;
}
