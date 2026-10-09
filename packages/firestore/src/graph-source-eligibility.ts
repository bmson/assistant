import { type EmbeddingSpace, type Records, validateEmbedding } from '@assistant/persistence';
import { embeddingSpaceKey } from './memory.js';

/** Shared by actual traversal and workspace projections; eligibility is not selection. */
export function graphSourceEligible(input: {
  memory: Pick<
    Records['memories'],
    | 'id'
    | 'agentId'
    | 'category'
    | 'quarantined'
    | 'supersededById'
    | 'expiresAt'
    | 'contentHash'
    | 'embedding'
  >;
  source: Pick<
    Records['knowledgeGraphSources'],
    'memoryId' | 'status' | 'contentHash' | 'extractionVersion'
  >;
  agentId: string;
  space: EmbeddingSpace;
  storedSpace: unknown;
  extractionVersion: number;
  now: Date;
  tombstoned: boolean;
}): boolean {
  const { memory, source, agentId, space, storedSpace, extractionVersion, now, tombstoned } = input;
  if (
    memory.agentId !== agentId ||
    memory.category !== 'knowledge' ||
    memory.quarantined !== false ||
    memory.supersededById ||
    (memory.expiresAt != null &&
      (!(memory.expiresAt instanceof Date) ||
        !Number.isFinite(memory.expiresAt.getTime()) ||
        memory.expiresAt <= now)) ||
    storedSpace !== embeddingSpaceKey(space) ||
    tombstoned ||
    source.memoryId !== memory.id ||
    source.status !== 'ready' ||
    source.contentHash !== memory.contentHash ||
    !Number.isInteger(source.extractionVersion) ||
    source.extractionVersion < extractionVersion ||
    !memory.embedding
  )
    return false;
  try {
    validateEmbedding(space, memory.embedding);
    return true;
  } catch {
    return false;
  }
}
