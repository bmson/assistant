import { parseInactiveOwnerFamilyRemovalOperationRecord } from '@assistant/persistence/owner-family-rejection-storage';
import { describe, expect, it } from 'vitest';
import { parseOwnerEditorOperationRecord } from './owner-editor-storage.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const epoch = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const relationId = '44444444-4444-4444-8444-444444444444';
const memoryId = '55555555-5555-4555-8555-555555555555';
const assertionId = '66666666-6666-4666-8666-666666666666';
const now = new Date('2026-10-25T12:00:00.000Z');

function baseRecord() {
  return {
    id: 'a'.repeat(64),
    ownerId,
    epoch,
    privacyGenerationDigest: 'b'.repeat(64),
    operationId,
    requestHash: 'c'.repeat(64),
    scopeDigest: 'd'.repeat(64),
    command: 'remove_owner_family_relationship',
    protocolVersion: 1,
    formIssuedAt: now,
    formExpiresAt: new Date(now.getTime() + 60_000),
    claimToken: '77777777-7777-4777-8777-777777777777',
    claimExpiresAt: new Date(now.getTime() + 30_000),
    statusVersion: 1,
    status: 'preparing',
    result: null,
    createdAt: now,
    updatedAt: now,
  };
}

function committed(outcome: 'saved' | 'unchanged' = 'saved') {
  return {
    ...baseRecord(),
    claimToken: null,
    claimExpiresAt: null,
    statusVersion: 2,
    status: 'committed',
    result: {
      outcome,
      ids: { relationId, memoryId, assertionId },
      revision: 'e'.repeat(64),
    },
  };
}

describe('inactive owner family removal storage codec', () => {
  it('accepts a pending exact-claim record with the shared operation shape', () => {
    expect(parseInactiveOwnerFamilyRemovalOperationRecord(baseRecord())).toMatchObject({
      command: 'remove_owner_family_relationship',
      status: 'preparing',
      result: null,
    });
  });

  it('accepts committed saved and replayed unchanged receipts with exact durable IDs', () => {
    for (const outcome of ['saved', 'unchanged'] as const) {
      const parsed = parseInactiveOwnerFamilyRemovalOperationRecord(committed(outcome));
      expect(parsed.result).toMatchObject({
        outcome,
        ids: { relationId, memoryId, assertionId },
      });
    }
  });

  it('rejects active commands and any command other than family removal', () => {
    expect(() =>
      parseInactiveOwnerFamilyRemovalOperationRecord({
        ...baseRecord(),
        command: 'correct_owner_memory',
      }),
    ).toThrow();
    expect(() =>
      parseInactiveOwnerFamilyRemovalOperationRecord({ ...baseRecord(), command: 'remove_person' }),
    ).toThrow();
  });

  it('rejects malformed durable IDs, extra receipt IDs, keys, dates, hashes, and UUIDs', () => {
    const valid = committed();
    const invalid = [
      { ...valid, result: { ...valid.result, ids: { relationId, memoryId } } },
      {
        ...valid,
        result: { ...valid.result, ids: { relationId, memoryId, assertionId, contactId: ownerId } },
      },
      { ...valid, unexpected: true },
      { ...valid, createdAt: '2026-10-25T12:00:00.000Z' },
      { ...valid, id: 'not-a-hash' },
      { ...valid, ownerId: 'not-a-uuid' },
    ];
    for (const record of invalid)
      expect(() => parseInactiveOwnerFamilyRemovalOperationRecord(record)).toThrow();
  });

  it('rejects inconsistent pending and terminal state/result combinations', () => {
    expect(() =>
      parseInactiveOwnerFamilyRemovalOperationRecord({ ...baseRecord(), claimToken: null }),
    ).toThrow();
    expect(() =>
      parseInactiveOwnerFamilyRemovalOperationRecord({
        ...committed(),
        status: 'terminal_rejected',
      }),
    ).toThrow();
  });

  it('keeps the active parser refusing the inactive family removal command', () => {
    expect(() => parseOwnerEditorOperationRecord(baseRecord())).toThrow();
  });
});
