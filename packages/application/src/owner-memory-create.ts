import { createHash, randomUUID } from 'node:crypto';
import { compileOwnerCard } from '@assistant/core/memory/consolidation';
import {
  embeddingSpaceIdentityKey,
  type OwnerCardCompilationRepository,
  type OwnerEditorApply,
  type OwnerEditorScope,
  type OwnerMemoryCreationTarget,
  type PreparedOwnerMemoryCreation,
  snapshotEmbeddingSpace,
  validateEmbedding,
} from '@assistant/persistence';
import { parseOwnerEditorRequest } from './owner-editor-wire.js';
import type { EmbeddingPort } from './profile/commands.js';

export type MemoryCreationTargetReader = (
  ownerId: string,
  subjectContactId: string,
  contentHash: string,
  scope: OwnerEditorScope,
) => Promise<OwnerMemoryCreationTarget | null>;

/** Person-only creation. Observation leases end before any embedding call. */
export async function prepareOwnerMemoryCreation(
  rawRequest: Extract<OwnerEditorApply, { command: 'create_owner_memory' }>,
  scope: OwnerEditorScope,
  read: MemoryCreationTargetReader,
  router: EmbeddingPort,
) {
  const parsed = parseOwnerEditorRequest(rawRequest, '/api/profile/knowledge/memory');
  if (!parsed.ok)
    return {
      ok: false as const,
      result: { outcome: 'invalid' as const, fieldErrors: parsed.fieldErrors },
    };
  if (parsed.request.intent !== 'apply' || parsed.request.command !== 'create_owner_memory')
    throw new Error('Person-note creation request required');
  const request = parsed.request;
  const conflict = (reason: string) => ({
    ok: false as const,
    result: { outcome: 'conflict' as const, reason },
  });
  if (
    scope.command !== request.command ||
    scope.operationId !== request.operationId ||
    scope.targetId !== request.subjectContactId ||
    request.subjectContactId === scope.ownerId
  )
    return conflict('issuance_target_changed');
  const contentHash = createHash('sha256').update(request.content).digest('hex');
  const check = async () => {
    const target = await read(scope.ownerId, request.subjectContactId, contentHash, scope);
    if (
      !target ||
      target.ownerId !== scope.ownerId ||
      target.subjectContactId !== request.subjectContactId ||
      target.subjectRevision !== request.expectedSubjectRevision ||
      typeof target.subjectTrust !== 'string' ||
      target.subjectTrust === 'owner'
    )
      return conflict('memory_subject_changed');
    if (target.status === 'tombstoned') return conflict('memory_tombstoned');
    if (target.status === 'duplicate') return conflict('memory_duplicate');
    if (target.status !== 'eligible') return conflict('memory_subject_changed');
    return null;
  };
  const before = await check();
  if (before) return before;
  const space = snapshotEmbeddingSpace(await router.embeddingSpace());
  // Space discovery is asynchronous too; don't dispatch after an observed retirement/change.
  const rechecked = await check();
  if (rechecked) return rechecked;
  const vectors = await router.embed([request.content], { expectedSpace: space });
  const embedding = vectors[0];
  if (vectors.length !== 1 || !embedding)
    throw new Error('Embedding provider returned no unique vector');
  validateEmbedding(space, embedding);
  const prepared: PreparedOwnerMemoryCreation = {
    memoryId: randomUUID(),
    retrievalRevision: randomUUID(),
    subjectContactId: request.subjectContactId,
    expectedSubjectRevision: request.expectedSubjectRevision,
    content: request.content,
    contentHash,
    domain: request.domain,
    importance: request.importance,
    pinned: request.pinned,
    embedding,
    embeddingSpaceKey: embeddingSpaceIdentityKey(space),
  };
  Object.freeze(prepared.embedding);
  Object.freeze(prepared);
  return { ok: true as const, prepared };
}

/** The committed receipt already says saved+refreshPending; summary failure cannot undo it. */
export async function refreshOwnerMemoryCreation(
  ownerCards: OwnerCardCompilationRepository,
  ownerId: string,
): Promise<void> {
  try {
    await compileOwnerCard(ownerCards, ownerId);
  } catch {
    // Card invalidation was atomic with the note. No graph extraction is dispatched here.
  }
}
