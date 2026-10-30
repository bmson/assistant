import { createHash } from 'node:crypto';
import { compileOwnerCard } from '@assistant/core/memory/consolidation';
import type {
  OwnerCardCompilationRepository,
  ProfileMemoryMaintenance,
} from '@assistant/persistence';
import {
  embeddingSpaceIdentityKey,
  type OwnerEditorApply,
  type OwnerEditorScope,
  type OwnerMemoryEditorSnapshot,
  snapshotEmbeddingSpace,
  validateEmbedding,
} from '@assistant/persistence';
import type { EmbeddingPort } from './profile/commands.js';

export interface PreparedOwnerMemoryCorrection {
  memoryId: string;
  expectedContentHash: string;
  expectedMemoryRevision: string;
  content: string;
  contentHash: string;
  embedding?: number[];
  embeddingSpaceKey?: string;
}
/** The snapshot reader compares current owner/epoch/privacy in its short lease, then releases it before embedding. */
export async function prepareOwnerMemoryCorrection(
  request: Extract<OwnerEditorApply, { command: 'correct_owner_memory' }>,
  scope: OwnerEditorScope,
  read: (
    ownerId: string,
    memoryId: string,
    scope: OwnerEditorScope,
  ) => Promise<OwnerMemoryEditorSnapshot | null>,
  router: EmbeddingPort,
) {
  const reject = (reason: string) => ({
    ok: false as const,
    result: { outcome: 'conflict' as const, reason },
  });
  if (
    scope.command !== request.command ||
    scope.targetId !== request.memoryId ||
    scope.operationId !== request.operationId
  )
    return reject('issuance_target_changed');
  const content = request.content.trim();
  if (content.length < 3 || content.length > 4000)
    return {
      ok: false as const,
      result: {
        outcome: 'invalid' as const,
        fieldErrors: { content: 'Write a saved note between 3 and 4000 characters.' },
      },
    };
  const current = await read(scope.ownerId, request.memoryId, scope);
  if (current?.readOnlyReason === 'incomplete_provenance')
    return {
      ok: false as const,
      result: { outcome: 'unavailable' as const, reason: 'memory_provenance_limit' },
    };
  if (
    !current ||
    !current.eligible ||
    current.ownerId !== scope.ownerId ||
    current.memoryId !== request.memoryId ||
    current.contentHash !== request.expectedContentHash ||
    current.revision !== request.expectedMemoryRevision
  )
    return reject('memory_snapshot_changed');
  const prepared: PreparedOwnerMemoryCorrection = {
    memoryId: request.memoryId,
    expectedContentHash: request.expectedContentHash,
    expectedMemoryRevision: request.expectedMemoryRevision,
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
  if (content === current.content) return { ok: true as const, prepared };
  const space = snapshotEmbeddingSpace(await router.embeddingSpace());
  const vectors = await router.embed([content], { expectedSpace: space }),
    vector = vectors[0];
  if (vectors.length !== 1 || !vector)
    throw new Error('Embedding provider returned no unique vector');
  validateEmbedding(space, vector);
  prepared.embedding = vector;
  prepared.embeddingSpaceKey = embeddingSpaceIdentityKey(space);
  return { ok: true as const, prepared };
}

/** A proven save stays saved even if either derived follow-up fails. Graph completion remains unproved. */
export async function refreshOwnerMemoryCorrection(
  ports: { maintenance: ProfileMemoryMaintenance; ownerCards: OwnerCardCompilationRepository },
  ownerId: string,
  memoryId: string,
): Promise<void> {
  try {
    await ports.maintenance.queueGraphSync({ agentId: ownerId, memoryId });
    await compileOwnerCard(ports.ownerCards, ownerId);
  } catch {
    /* The primary card was atomically invalidated; receipt remains saved+refreshPending. */
  }
}
