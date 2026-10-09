import type { EmbeddingSpace } from './embedding.js';
import type { Records } from './records.js';

export type MemoryRecallRow = Omit<Records['memories'], 'embedding'> & {
  similarity: number;
};

export interface MemorySaveInput {
  agentId: string;
  content: string;
  contentHash: string;
  embedding: number[];
  /** Exact immutable identity of the space that produced this vector. */
  embeddingSpaceKey: string;
  /** Generation observed before asynchronous embedding/source preparation. */
  observedPrivacyGeneration?: string | null;
  category: 'knowledge' | 'experience';
  kind: 'fact' | 'preference' | 'person' | 'project' | 'episode';
  importance: number;
  confidence: number;
  originTrust: string;
  quarantined: boolean;
  subject?: string;
  subjectRelationship?: string;
  domain?: string;
  sourceTaskId?: string;
  expiresAt?: Date | null;
}

export interface MemorySaveResult {
  /** Identity of a newly saved fact, for immediate contradiction resolution. */
  id?: string;
  saved: boolean;
  duplicate: boolean;
  tombstoned: boolean;
  quarantined: boolean;
}

export type MemoryContentHashState = 'new' | 'duplicate' | 'tombstoned';

export interface MemoryRecallInput {
  agentId: string;
  embedding: number[];
  query: string;
  limit: number;
  now?: Date;
  /** Exact immutable identity required for any semantic comparison. */
  embeddingSpaceKey: string;
}

export interface MemoryRecallResult {
  memories: MemoryRecallRow[];
  candidateLimitReached: boolean;
}

export interface MemoryToolRepository {
  readonly kind: 'memory-tool-repository';
  readonly embeddingSpace?: EmbeddingSpace;
  observationGeneration(agentId: string): Promise<string | null>;
  /** Read-only optimization; save remains authoritative if state changes afterward. */
  screenContentHash(agentId: string, contentHash: string): Promise<MemoryContentHashState>;
  save(input: MemorySaveInput): Promise<MemorySaveResult>;
  recall(input: MemoryRecallInput): Promise<MemoryRecallResult>;
}
