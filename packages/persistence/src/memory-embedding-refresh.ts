import type { Records } from './records.js';

export type MemoryEmbeddingRefresh = Records['memoryEmbeddingRefreshes'];

export interface MemoryEmbeddingRefreshCandidate {
  id: string;
  agentId: string;
  content: string;
  contentHash: string;
  embeddingSpaceKey: string | null;
}

export type RefreshClaim =
  | { kind: 'claimed'; receipt: MemoryEmbeddingRefresh }
  | { kind: 'prepared'; receipt: MemoryEmbeddingRefresh }
  | { kind: 'unknown'; receipt: MemoryEmbeddingRefresh }
  | { kind: 'busy' | 'current' | 'stale' };

/** Persistence boundary for a bounded, resumable refresh of completed memories. */
export interface MemoryEmbeddingRefreshRepository {
  readonly kind: 'memory-embedding-refresh-repository';
  getCursor(agentId: string, targetSpaceKey: string): Promise<string | null>;
  saveCursor(agentId: string, targetSpaceKey: string, cursor: string | null): Promise<void>;
  listCandidates(input: {
    agentId: string;
    targetSpaceKey: string;
    afterId: string | null;
    limit: number;
  }): Promise<{ rows: MemoryEmbeddingRefreshCandidate[]; nextCursor: string | null }>;
  claim(input: {
    agentId: string;
    memoryId: string;
    sourceHash: string;
    targetSpaceKey: string;
    targetDimensions: number;
    now: Date;
    leaseUntil: Date;
  }): Promise<RefreshClaim>;
  savePrepared(input: {
    agentId: string;
    receiptId: string;
    claimToken: string;
    vector: number[];
    now: Date;
  }): Promise<boolean>;
  applyPrepared(input: {
    agentId: string;
    memoryId: string;
    sourceHash: string;
    targetSpaceKey: string;
    receiptId: string;
    now: Date;
  }): Promise<'applied' | 'stale' | 'privacy-fenced'>;
  markUnknown(input: {
    agentId: string;
    receiptId: string;
    claimToken: string;
    reason: string;
    now: Date;
  }): Promise<void>;
  /** Unknown receipts are reviewed explicitly; retry authorization creates a fresh receipt. */
  listUnknown(agentId: string, limit: number): Promise<MemoryEmbeddingRefresh[]>;
  resolveUnknown(input: {
    agentId: string;
    receiptId: string;
    expectedUpdatedAt: Date;
    action: 'abandon' | 'authorize_retry';
    now: Date;
  }): Promise<{ authorized: boolean; retryKey?: string }>;
}
