import { compileOwnerCard } from '@assistant/core/memory/consolidation';
import type {
  OwnerCardCompilationRepository,
  OwnerEditorApply,
  OwnerEditorMemoryRemovalImpact,
  OwnerEditorScope,
  OwnerMemoryEditorSnapshot,
  ProfileMemoryMaintenance,
} from '@assistant/persistence';

export interface PreparedOwnerMemoryRemoval {
  memoryId: string;
  expectedContentHash: string;
  expectedMemoryRevision: string;
  expectedImpactRevision: string;
}

export interface OwnerEditorMemoryRemovalSnapshot {
  snapshot: OwnerMemoryEditorSnapshot;
  impact: OwnerEditorMemoryRemovalImpact | null;
}

type RemovalApply = Extract<OwnerEditorApply, { command: 'remove_owner_memory' }>;

/** Pure protocol preparation; storage adapters recheck both revisions in commit. */
export async function prepareOwnerMemoryRemoval(
  request: RemovalApply,
  scope: OwnerEditorScope,
  read: (
    ownerId: string,
    memoryId: string,
    scope: OwnerEditorScope,
  ) => Promise<OwnerEditorMemoryRemovalSnapshot | null>,
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
  const current = await read(scope.ownerId, request.memoryId, scope);
  if (!current) return reject('memory_snapshot_changed');
  const snapshot: OwnerMemoryEditorSnapshot = current.snapshot;
  if (
    !snapshot.eligible ||
    snapshot.ownerId !== scope.ownerId ||
    snapshot.memoryId !== request.memoryId ||
    snapshot.contentHash !== request.expectedContentHash ||
    snapshot.revision !== request.expectedMemoryRevision ||
    !current.impact ||
    current.impact.memoryId !== request.memoryId ||
    current.impact.revision !== request.expectedImpactRevision
  )
    return reject('memory_snapshot_changed');
  return {
    ok: true as const,
    prepared: {
      memoryId: request.memoryId,
      expectedContentHash: request.expectedContentHash,
      expectedMemoryRevision: request.expectedMemoryRevision,
      expectedImpactRevision: request.expectedImpactRevision,
    },
  };
}

/** Commit already invalidates the owner card; this bounded follow-up removes stale graph rows. */
export async function refreshOwnerMemoryRemoval(
  ports: { maintenance: ProfileMemoryMaintenance; ownerCards: OwnerCardCompilationRepository },
  ownerId: string,
  memoryId: string,
): Promise<void> {
  try {
    await ports.maintenance.removeOrphanedGraphEntities({ agentId: ownerId, memoryId });
    await compileOwnerCard(ports.ownerCards, ownerId);
  } catch {
    /* The source removal receipt stays committed+refreshPending if cleanup is incomplete. */
  }
}

export function ownerMemoryRemovalImpactPresentation(impact: OwnerEditorMemoryRemovalImpact) {
  return {
    connectionCount: impact.connectionCount,
    orphanedItems: impact.orphanedItems.map(({ id, label }) => ({ id, label })),
  };
}
