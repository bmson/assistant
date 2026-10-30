import type { MemoryForgetReason } from './profile-memory-management.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_HASH = /^[a-f0-9]{64}$/;

export type OwnerMemoryRemovalReason = Extract<
  MemoryForgetReason,
  'owner_forget' | 'quarantine_reject'
>;

/** Content-free target binding. `expectedContentHash` is the source CAS token. */
export interface OwnerMemoryRemovalRequest {
  version: 1;
  operationId: string;
  ownerId: string;
  memoryId: string;
  expectedContentHash: string;
  reason: OwnerMemoryRemovalReason;
}

/** Exact native snapshot fields required before a driver may remove the target. */
export interface OwnerMemoryRemovalSnapshot {
  ownerId: string;
  memory: {
    id: string;
    agentId: string;
    contentHash: string;
    quarantined: boolean;
  };
}

export const OWNER_MEMORY_REMOVAL_EFFECTS = Object.freeze({
  remove: Object.freeze({
    exactMemory: true,
    embedding: true,
    sourceSpecificDerivedProjection: 'remove_or_exclude',
  }),
  suppress: 'durably_tombstone_exact_content_hash',
  retain: Object.freeze([
    'original_email',
    'original_document',
    'person_contact',
    'source_task',
    'unrelated_memories',
    'shared_assertions_and_other_source_evidence',
  ] as const),
  invalidationObligations: Object.freeze([
    'owner_card',
    'in_flight_and_cached_recall',
    'source_specific_derived_projection_reads',
  ] as const),
  writerObligations: Object.freeze([
    'revalidate_owner_session_epoch_and_current_privacy_in_the_native_transaction',
    'persist_an_atomic_durable_operation_receipt_bound_to_operation_owner_memory_hash_and_reason',
  ] as const),
});

export interface OwnerMemoryRemovalPlan {
  kind: 'remove_one_memory';
  target: OwnerMemoryRemovalRequest;
  effects: typeof OWNER_MEMORY_REMOVAL_EFFECTS;
}

export type OwnerMemoryRemovalPlanResult =
  | OwnerMemoryRemovalPlan
  | {
      kind: 'rejected';
      reason:
        | 'malformed_request'
        | 'missing_memory'
        | 'malformed_snapshot'
        | 'foreign_owner'
        | 'stale_target'
        | 'not_quarantined';
    };

export type OwnerMemoryRemovalRejectionReason =
  | 'missing_memory'
  | 'foreign_owner'
  | 'stale_target'
  | 'not_quarantined';

export type OwnerMemoryRemovalCommitResult =
  | { kind: 'committed'; target: OwnerMemoryRemovalRequest }
  | {
      kind: 'rejected';
      target: OwnerMemoryRemovalRequest;
      reason: OwnerMemoryRemovalRejectionReason;
    }
  | { kind: 'unknown'; target: OwnerMemoryRemovalRequest };

export type OwnerMemoryRemovalFollowUpResult = { kind: 'complete' } | { kind: 'pending' };

export type OwnerMemoryRemovalOutcome =
  | {
      kind: 'committed';
      target: OwnerMemoryRemovalRequest;
      followUp: 'complete' | 'pending' | 'unknown';
    }
  | {
      kind: 'rejected';
      target: OwnerMemoryRemovalRequest | null;
      reason: OwnerMemoryRemovalRejectionReason | 'malformed_request';
    }
  | {
      kind: 'outcome_unknown';
      target: OwnerMemoryRemovalRequest;
      reason: 'commit_unresolved' | 'commit_response_malformed' | 'commit_target_mismatch';
    };

const REQUEST_KEYS = [
  'version',
  'operationId',
  'ownerId',
  'memoryId',
  'expectedContentHash',
  'reason',
] as const;
const SNAPSHOT_KEYS = ['ownerId', 'memory'] as const;
const MEMORY_KEYS = ['id', 'agentId', 'contentHash', 'quarantined'] as const;
const COMMIT_KEYS = ['kind', 'target', 'reason'] as const;
const FOLLOW_UP_KEYS = ['kind'] as const;

function plainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  try {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return (
      actual.length === expected.length && actual.every((key, index) => key === expected[index])
    );
  } catch {
    return false;
  }
}

export function parseOwnerMemoryRemovalRequest(value: unknown): OwnerMemoryRemovalRequest | null {
  try {
    if (!plainRecord(value) || !hasExactKeys(value, REQUEST_KEYS)) return null;
    if (
      value.version !== 1 ||
      typeof value.operationId !== 'string' ||
      !UUID.test(value.operationId) ||
      typeof value.ownerId !== 'string' ||
      !UUID.test(value.ownerId) ||
      typeof value.memoryId !== 'string' ||
      !UUID.test(value.memoryId) ||
      typeof value.expectedContentHash !== 'string' ||
      !CONTENT_HASH.test(value.expectedContentHash) ||
      (value.reason !== 'owner_forget' && value.reason !== 'quarantine_reject')
    )
      return null;
    return {
      version: 1,
      operationId: value.operationId,
      ownerId: value.ownerId,
      memoryId: value.memoryId,
      expectedContentHash: value.expectedContentHash,
      reason: value.reason,
    };
  } catch {
    return null;
  }
}

function parseSnapshot(value: unknown): OwnerMemoryRemovalSnapshot | null {
  try {
    if (!plainRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS) || !plainRecord(value.memory))
      return null;
    const memory = value.memory;
    if (
      !hasExactKeys(memory, MEMORY_KEYS) ||
      typeof value.ownerId !== 'string' ||
      !UUID.test(value.ownerId) ||
      typeof memory.id !== 'string' ||
      !UUID.test(memory.id) ||
      typeof memory.agentId !== 'string' ||
      !UUID.test(memory.agentId) ||
      typeof memory.contentHash !== 'string' ||
      !CONTENT_HASH.test(memory.contentHash) ||
      typeof memory.quarantined !== 'boolean'
    )
      return null;
    return {
      ownerId: value.ownerId,
      memory: {
        id: memory.id,
        agentId: memory.agentId,
        contentHash: memory.contentHash,
        quarantined: memory.quarantined,
      },
    };
  } catch {
    return null;
  }
}

/** Pure decision only: native adapters must prove these exact fields in their transaction. */
export function planOwnerMemoryRemoval(
  requestValue: unknown,
  snapshotValue: unknown,
): OwnerMemoryRemovalPlanResult {
  const request = parseOwnerMemoryRemovalRequest(requestValue);
  if (!request) return { kind: 'rejected', reason: 'malformed_request' };
  if (snapshotValue === null || snapshotValue === undefined)
    return { kind: 'rejected', reason: 'missing_memory' };
  const snapshot = parseSnapshot(snapshotValue);
  if (!snapshot) return { kind: 'rejected', reason: 'malformed_snapshot' };
  if (snapshot.ownerId !== request.ownerId || snapshot.memory.agentId !== request.ownerId)
    return { kind: 'rejected', reason: 'foreign_owner' };
  if (
    snapshot.memory.id !== request.memoryId ||
    snapshot.memory.contentHash !== request.expectedContentHash
  )
    return { kind: 'rejected', reason: 'stale_target' };
  if (request.reason === 'quarantine_reject' && !snapshot.memory.quarantined)
    return { kind: 'rejected', reason: 'not_quarantined' };
  return { kind: 'remove_one_memory', target: request, effects: OWNER_MEMORY_REMOVAL_EFFECTS };
}

function sameTarget(
  leftValue: unknown,
  rightValue: unknown,
): leftValue is OwnerMemoryRemovalRequest {
  const left = parseOwnerMemoryRemovalRequest(leftValue);
  const right = parseOwnerMemoryRemovalRequest(rightValue);
  return Boolean(
    left &&
      right &&
      left.operationId === right.operationId &&
      left.ownerId === right.ownerId &&
      left.memoryId === right.memoryId &&
      left.expectedContentHash === right.expectedContentHash &&
      left.reason === right.reason,
  );
}

/** A replay is the same operation only when operation, owner, memory, hash, and reason all match. */
export function ownerMemoryRemovalReplayMatches(
  requestValue: unknown,
  originalTargetValue: unknown,
): boolean {
  return sameTarget(requestValue, originalTargetValue);
}

function parseCommitResult(value: unknown): OwnerMemoryRemovalCommitResult | null {
  try {
    if (!plainRecord(value) || !parseOwnerMemoryRemovalRequest(value.target)) return null;
    const target = parseOwnerMemoryRemovalRequest(value.target);
    if (!target) return null;
    if (value.kind === 'committed') {
      return hasExactKeys(value, ['kind', 'target']) ? { kind: 'committed', target } : null;
    }
    if (value.kind === 'unknown') {
      return hasExactKeys(value, ['kind', 'target']) ? { kind: 'unknown', target } : null;
    }
    if (
      value.kind === 'rejected' &&
      hasExactKeys(value, COMMIT_KEYS) &&
      (value.reason === 'missing_memory' ||
        value.reason === 'foreign_owner' ||
        value.reason === 'stale_target' ||
        value.reason === 'not_quarantined')
    )
      return { kind: 'rejected', target, reason: value.reason };
    return null;
  } catch {
    return null;
  }
}

function parseFollowUp(value: unknown): OwnerMemoryRemovalFollowUpResult | null {
  try {
    if (!plainRecord(value) || !hasExactKeys(value, FOLLOW_UP_KEYS)) return null;
    if (value.kind === 'complete' || value.kind === 'pending') return { kind: value.kind };
    return null;
  } catch {
    return null;
  }
}

/**
 * Classifies a trusted native-adapter result model separately from derived follow-ups. This is
 * not a native commit proof or authority check. Once
 * the matching commit is durable, follow-up failure can only be pending/unknown,
 * never a claim that removal did not happen.
 */
export function resolveOwnerMemoryRemovalOutcome(
  requestValue: unknown,
  commitValue: unknown,
  followUpValue: unknown,
): OwnerMemoryRemovalOutcome {
  const request = parseOwnerMemoryRemovalRequest(requestValue);
  if (!request) return { kind: 'rejected', target: null, reason: 'malformed_request' };
  const commit = parseCommitResult(commitValue);
  if (!commit)
    return {
      kind: 'outcome_unknown',
      target: request,
      reason: 'commit_response_malformed',
    };
  if (!sameTarget(request, commit.target))
    return { kind: 'outcome_unknown', target: request, reason: 'commit_target_mismatch' };
  if (commit.kind === 'unknown')
    return { kind: 'outcome_unknown', target: request, reason: 'commit_unresolved' };
  if (commit.kind === 'rejected')
    return { kind: 'rejected', target: request, reason: commit.reason };
  const followUp = parseFollowUp(followUpValue);
  return {
    kind: 'committed',
    target: request,
    followUp: followUp?.kind ?? 'unknown',
  };
}
