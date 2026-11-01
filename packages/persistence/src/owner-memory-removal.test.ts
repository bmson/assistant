import { describe, expect, it } from 'vitest';
import {
  OWNER_MEMORY_REMOVAL_EFFECTS,
  type OwnerMemoryRemovalRequest,
  type OwnerMemoryRemovalSnapshot,
  ownerMemoryRemovalReplayMatches,
  planOwnerMemoryRemoval,
  resolveOwnerMemoryRemovalOutcome,
} from './owner-memory-removal.js';

const owner = '11111111-1111-4111-8111-111111111111';
const operationId = '44444444-4444-4444-8444-444444444444';
const otherOperationId = '55555555-5555-4555-8555-555555555555';
const memoryId = '22222222-2222-4222-8222-222222222222';
const otherMemoryId = '33333333-3333-4333-8333-333333333333';
const hash = 'a'.repeat(64);
const nextHash = 'b'.repeat(64);

const request = (
  overrides: Partial<OwnerMemoryRemovalRequest> = {},
): OwnerMemoryRemovalRequest => ({
  version: 1,
  operationId,
  ownerId: owner,
  memoryId,
  expectedContentHash: hash,
  reason: 'owner_forget',
  ...overrides,
});

const snapshot = (
  overrides: Partial<OwnerMemoryRemovalSnapshot['memory']> = {},
): OwnerMemoryRemovalSnapshot => ({
  ownerId: owner,
  memory: {
    id: memoryId,
    agentId: owner,
    contentHash: hash,
    quarantined: false,
    ...overrides,
  },
});

describe('one-memory removal contract', () => {
  it('plans only the exact owned memory and declares removal, suppression, retention, and invalidation obligations', () => {
    const plan = planOwnerMemoryRemoval(request(), snapshot());
    expect(plan).toEqual({
      kind: 'remove_one_memory',
      target: request(),
      effects: OWNER_MEMORY_REMOVAL_EFFECTS,
    });
    if (plan.kind !== 'remove_one_memory') throw new Error('Expected a removal plan');
    expect(plan.effects.remove).toEqual({
      exactMemory: true,
      embedding: true,
      sourceSpecificDerivedProjection: 'remove_or_exclude',
    });
    expect(plan.effects.suppress).toBe('durably_tombstone_exact_content_hash');
    expect(plan.effects.retain).toEqual([
      'original_email',
      'original_document',
      'person_contact',
      'source_task',
      'unrelated_memories',
      'shared_assertions_and_other_source_evidence',
    ]);
    expect(plan.effects.invalidationObligations).toEqual([
      'owner_card',
      'in_flight_and_cached_recall',
      'source_specific_derived_projection_reads',
    ]);
    expect(plan.effects.writerObligations).toEqual([
      'revalidate_owner_session_epoch_and_current_privacy_in_the_native_transaction',
      'persist_an_atomic_durable_operation_receipt_bound_to_operation_owner_memory_hash_and_reason',
    ]);
    expect(plan).not.toHaveProperty('content');
    expect(plan).not.toHaveProperty('embedding');
  });

  it('fails closed for malformed requests and snapshots, missing targets, foreign owners, and stale identity', () => {
    expect(planOwnerMemoryRemoval({ ...request(), extra: true }, snapshot())).toEqual({
      kind: 'rejected',
      reason: 'malformed_request',
    });
    expect(
      planOwnerMemoryRemoval(request({ expectedContentHash: 'not-a-hash' }), snapshot()),
    ).toEqual({
      kind: 'rejected',
      reason: 'malformed_request',
    });
    expect(
      planOwnerMemoryRemoval({ ...request(), reason: 'owner_delete_contact' }, snapshot()),
    ).toEqual({
      kind: 'rejected',
      reason: 'malformed_request',
    });
    expect(planOwnerMemoryRemoval(request(), null)).toEqual({
      kind: 'rejected',
      reason: 'missing_memory',
    });
    expect(planOwnerMemoryRemoval(request(), undefined)).toEqual({
      kind: 'rejected',
      reason: 'missing_memory',
    });
    expect(planOwnerMemoryRemoval(request(), { ...snapshot(), extra: true })).toEqual({
      kind: 'rejected',
      reason: 'malformed_snapshot',
    });
    expect(
      planOwnerMemoryRemoval(request(), {
        ...snapshot(),
        memory: { ...snapshot().memory, agentId: otherMemoryId },
      }),
    ).toEqual({ kind: 'rejected', reason: 'foreign_owner' });
    expect(
      planOwnerMemoryRemoval(request(), {
        ...snapshot(),
        memory: { ...snapshot().memory, id: otherMemoryId },
      }),
    ).toEqual({ kind: 'rejected', reason: 'stale_target' });
    expect(
      planOwnerMemoryRemoval(request(), {
        ...snapshot(),
        memory: { ...snapshot().memory, contentHash: nextHash },
      }),
    ).toEqual({ kind: 'rejected', reason: 'stale_target' });
  });

  it('allows quarantine rejection only when the bound snapshot is still quarantined', () => {
    const rejectRequest = request({ reason: 'quarantine_reject' });
    expect(planOwnerMemoryRemoval(rejectRequest, snapshot())).toEqual({
      kind: 'rejected',
      reason: 'not_quarantined',
    });
    expect(planOwnerMemoryRemoval(rejectRequest, snapshot({ quarantined: true }))).toMatchObject({
      kind: 'remove_one_memory',
      target: rejectRequest,
    });
    expect(planOwnerMemoryRemoval(request(), snapshot({ quarantined: true }))).toMatchObject({
      kind: 'remove_one_memory',
    });
  });

  it('matches replays only to the original operation, owner, memory, hash, and reason', () => {
    const original = request();
    expect(ownerMemoryRemovalReplayMatches(original, original)).toBe(true);
    expect(
      ownerMemoryRemovalReplayMatches(original, request({ expectedContentHash: nextHash })),
    ).toBe(false);
    expect(ownerMemoryRemovalReplayMatches(original, request({ memoryId: otherMemoryId }))).toBe(
      false,
    );
    expect(
      ownerMemoryRemovalReplayMatches(original, request({ reason: 'quarantine_reject' })),
    ).toBe(false);
    expect(
      ownerMemoryRemovalReplayMatches(original, request({ operationId: otherOperationId })),
    ).toBe(false);
    expect(ownerMemoryRemovalReplayMatches(original, { ...original, scope: 'foreign' })).toBe(
      false,
    );
  });

  it('keeps a durable commit committed when derived cleanup/card follow-up is pending or unknown', () => {
    const target = request();
    expect(
      resolveOwnerMemoryRemovalOutcome(target, { kind: 'committed', target }, { kind: 'pending' }),
    ).toEqual({ kind: 'committed', target, followUp: 'pending' });
    expect(
      resolveOwnerMemoryRemovalOutcome(target, { kind: 'committed', target }, { error: 'failed' }),
    ).toEqual({ kind: 'committed', target, followUp: 'unknown' });
  });

  it('does not claim non-application for unresolved, malformed, or target-mismatched commit responses', () => {
    const target = request();
    expect(
      resolveOwnerMemoryRemovalOutcome(target, { kind: 'unknown', target }, { kind: 'complete' }),
    ).toEqual({ kind: 'outcome_unknown', target, reason: 'commit_unresolved' });
    expect(
      resolveOwnerMemoryRemovalOutcome(target, { kind: 'committed', target, extra: true }, null),
    ).toEqual({ kind: 'outcome_unknown', target, reason: 'commit_response_malformed' });
    expect(
      resolveOwnerMemoryRemovalOutcome(
        target,
        { kind: 'committed', target: request({ expectedContentHash: nextHash }) },
        { kind: 'complete' },
      ),
    ).toEqual({ kind: 'outcome_unknown', target, reason: 'commit_target_mismatch' });
    expect(
      resolveOwnerMemoryRemovalOutcome(
        target,
        { kind: 'committed', target: request({ operationId: otherOperationId }) },
        { kind: 'complete' },
      ),
    ).toEqual({ kind: 'outcome_unknown', target, reason: 'commit_target_mismatch' });
    const throwingReply = new Proxy(
      {},
      {
        get: () => {
          throw new Error('malformed reply');
        },
      },
    );
    expect(resolveOwnerMemoryRemovalOutcome(target, throwingReply, null)).toEqual({
      kind: 'outcome_unknown',
      target,
      reason: 'commit_response_malformed',
    });
    expect(
      resolveOwnerMemoryRemovalOutcome(target, { kind: 'committed', target }, throwingReply),
    ).toEqual({ kind: 'committed', target, followUp: 'unknown' });
    expect(resolveOwnerMemoryRemovalOutcome(target, null, null)).toMatchObject({
      kind: 'outcome_unknown',
      target,
    });
  });

  it('returns rejection only for a strict matching pre-commit rejection', () => {
    const target = request();
    expect(
      resolveOwnerMemoryRemovalOutcome(
        target,
        { kind: 'rejected', target, reason: 'stale_target' },
        { kind: 'complete' },
      ),
    ).toEqual({ kind: 'rejected', target, reason: 'stale_target' });
    expect(
      resolveOwnerMemoryRemovalOutcome(
        target,
        {
          kind: 'rejected',
          target: request({ reason: 'quarantine_reject' }),
          reason: 'stale_target',
        },
        null,
      ),
    ).toEqual({ kind: 'outcome_unknown', target, reason: 'commit_target_mismatch' });
  });
});
