import { createHash } from 'node:crypto';
import { compileOwnerCard } from '@assistant/core/memory/consolidation';
import { MEMORY_DOMAINS } from '@assistant/core/memory/extraction';
import type {
  MemoryMutation,
  MemoryProminence,
  OwnerCardCompilationRepository,
  ProfileMemoryMaintenance,
  ProfileMemoryManagementRepository,
} from '@assistant/persistence';

export interface ProfileMemoryCommandPersistence {
  readonly kind: 'profile-memory-command-persistence';
  memories: ProfileMemoryManagementRepository;
  ownerCards: OwnerCardCompilationRepository;
  maintenance: ProfileMemoryMaintenance;
}

export interface ProfileMemoryEmbeddingPort {
  embed(texts: string[]): Promise<number[][]>;
  embedWithIdentity?(
    texts: string[],
  ): Promise<{ embeddings: number[][]; embeddingSpaceKey: string }>;
}

export interface CreateProfileMemoryInput {
  content: string;
  domain: string;
  importance: string;
  pinned: boolean;
  subjectContactId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mutationError(result: Exclude<MemoryMutation, { status: 'updated' }>): string {
  switch (result.status) {
    case 'not-found':
      return 'Fact not found.';
    case 'stale':
      return 'This fact changed while you were editing it. Refresh and try again.';
    case 'duplicate':
      return 'That fact is already saved.';
    case 'tombstoned':
      return 'You previously forgot this fact, so it is not saved again.';
  }
}

/** Bind owner memory commands without retaining a database or SQL fallback. */
export function createProfileMemoryCommands(
  persistence: ProfileMemoryCommandPersistence,
  router: ProfileMemoryEmbeddingPort,
) {
  const { memories, ownerCards, maintenance } = persistence;
  const finish = async (
    result: MemoryMutation,
    graph: 'none' | 'sync' | 'retry' | 'remove' = 'none',
  ): Promise<void> => {
    if (result.status !== 'updated') return;
    const { agentId, id: memoryId } = result.memory;
    // Persistence has already cleared the card atomically. If either follow-up
    // fails, stale personal content stays out of the prompt until a rebuild.
    if (graph === 'remove') await maintenance.removeOrphanedGraphEntities({ agentId, memoryId });
    if (graph === 'retry') await maintenance.retryBlockedGraphSource({ agentId, memoryId });
    if (graph === 'sync' || graph === 'retry')
      await maintenance.queueGraphSync({ agentId, memoryId });
    await compileOwnerCard(ownerCards, agentId);
  };
  const forget = async (memoryId: string, reason: 'owner_forget' | 'quarantine_reject') => {
    await finish(await memories.forget(memoryId, reason), 'remove');
  };
  return {
    confirmMemory: async (memoryId: string): Promise<void> => {
      await finish(await memories.confirm(memoryId));
    },
    restoreMemory: async (memoryId: string): Promise<void> => {
      await finish(await memories.restore(memoryId), 'sync');
    },
    correctMemory: async (memoryId: string, content: string): Promise<{ error?: string }> => {
      const trimmed = content.trim();
      if (trimmed.length < 3) return { error: 'Correction is too short.' };
      const existing = await memories.get(memoryId);
      if (!existing) return { error: 'Fact not found.' };
      // Model calls complete before the transaction; its hash precondition
      // prevents a slow embedding request from overwriting a newer owner edit.
      const embedded = router.embedWithIdentity ? await router.embedWithIdentity([trimmed]) : null;
      const [embedding] = embedded?.embeddings ?? (await router.embed([trimmed]));
      if (!embedding) throw new Error('Embedding provider returned no vector');
      const result = await memories.correct({
        memoryId,
        expectedContentHash: existing.contentHash,
        content: trimmed,
        contentHash: createHash('sha256').update(trimmed).digest('hex'),
        embedding,
        ...(embedded ? { embeddingSpaceKey: embedded.embeddingSpaceKey } : {}),
      });
      if (result.status !== 'updated') return { error: mutationError(result) };
      await finish(result, 'sync');
      return {};
    },
    forgetMemory: (memoryId: string): Promise<void> => forget(memoryId, 'owner_forget'),
    rejectQuarantinedMemory: (memoryId: string): Promise<void> =>
      forget(memoryId, 'quarantine_reject'),
    setMemoryProminence: async (memoryId: string, level: MemoryProminence): Promise<void> => {
      await finish(await memories.setProminence(memoryId, level));
    },
    approveQuarantinedMemory: async (memoryId: string): Promise<void> => {
      await finish(await memories.approveQuarantined(memoryId), 'retry');
    },
    createMemory: async (input: CreateProfileMemoryInput): Promise<{ error?: string }> => {
      const content = input.content.trim();
      if (content.length < 3) return { error: 'Write a little more.' };
      if (!UUID_RE.test(input.subjectContactId)) return { error: 'Invalid subject.' };
      const embedded = router.embedWithIdentity ? await router.embedWithIdentity([content]) : null;
      const [embedding] = embedded?.embeddings ?? (await router.embed([content]));
      if (!embedding) throw new Error('Embedding provider returned no vector');
      const result = await memories.create({
        content,
        contentHash: createHash('sha256').update(content).digest('hex'),
        embedding,
        ...(embedded ? { embeddingSpaceKey: embedded.embeddingSpaceKey } : {}),
        importance: Math.min(Math.max(Math.trunc(Number(input.importance)) || 3, 1), 5),
        pinned: input.pinned,
        subjectContactId: input.subjectContactId,
        domain: (MEMORY_DOMAINS as readonly string[]).includes(input.domain)
          ? input.domain
          : undefined,
      });
      if (result.status !== 'updated') {
        if (result.status === 'duplicate' && result.memory)
          await compileOwnerCard(ownerCards, result.memory.agentId);
        return {
          error: result.status === 'not-found' ? 'Invalid subject.' : mutationError(result),
        };
      }
      await finish(result);
      return {};
    },
  };
}
