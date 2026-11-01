import {
  parseInactiveOwnerFamilyRejectionMarker,
  parseInactiveOwnerFamilyRemovalCacheCursor,
  parseInactiveOwnerFamilyRemovalOperationRecord,
  parseInactiveOwnerFamilyRemovalRequest,
} from '@assistant/persistence/owner-family-rejection-storage';
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

function marker() {
  return {
    version: 2,
    id: 'a'.repeat(64),
    installationLineageId: 'test-lineage',
    ownerId,
    sourceMemoryId: memoryId,
    state: 'active',
    stableContactMeaningKey: 'b'.repeat(64),
    meaning: {
      subjectContactId: ownerId,
      objectContactId: '88888888-8888-4888-8888-888888888888',
      predicate: 'knows',
      assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
      validFrom: null,
      validUntil: null,
      qualifiers: { source: 'owner' },
    },
    original: {
      relationId,
      assertionId,
      evidenceId: '99999999-9999-4999-8999-999999999999',
      subjectEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      objectEntityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sourceContentHash: 'c'.repeat(64),
    },
    operationId,
    requestHash: 'd'.repeat(64),
    reviewClosureHash: 'e'.repeat(64),
    createdAt: now,
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

  it('accepts the strict inactive request and cache cursor shapes', () => {
    expect(
      parseInactiveOwnerFamilyRemovalRequest({
        version: 1,
        intent: 'apply',
        command: 'remove_owner_family_relationship',
        operationId,
        targetRelationId: relationId,
        expectedTargetRevision: 'f'.repeat(64),
      }).targetRelationId,
    ).toBe(relationId);
    expect(
      parseInactiveOwnerFamilyRemovalCacheCursor({
        version: 1,
        ownerId,
        installationLineageId: 'test-lineage',
        revision: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        protocolVersion: 1,
        state: 'active',
      }).ownerId,
    ).toBe(ownerId);
  });

  it('rejects request and cursor scope changes, malformed hashes, and extra keys', () => {
    const request = {
      version: 1,
      intent: 'apply',
      command: 'remove_owner_family_relationship',
      operationId,
      targetRelationId: relationId,
      expectedTargetRevision: 'f'.repeat(64),
    };
    const cursor = {
      version: 1,
      ownerId,
      installationLineageId: 'test-lineage',
      revision: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      protocolVersion: 1,
      state: 'active',
    };
    expect(() =>
      parseInactiveOwnerFamilyRemovalRequest({ ...request, targetRelationId: 'bad' }),
    ).toThrow();
    expect(() =>
      parseInactiveOwnerFamilyRemovalRequest({ ...request, unrecognized: true }),
    ).toThrow();
    expect(() =>
      parseInactiveOwnerFamilyRemovalCacheCursor({ ...cursor, ownerId: 'bad-owner' }),
    ).toThrow();
    expect(() =>
      parseInactiveOwnerFamilyRemovalCacheCursor({ ...cursor, state: 'retired' }),
    ).toThrow();
    expect(() => parseInactiveOwnerFamilyRemovalCacheCursor({ ...cursor, extra: true })).toThrow();
  });

  it('accepts a bounded strict rejection marker and rejects malformed meaning or lineage fields', () => {
    expect(parseInactiveOwnerFamilyRejectionMarker(marker()).sourceMemoryId).toBe(memoryId);
    expect(() =>
      parseInactiveOwnerFamilyRejectionMarker({ ...marker(), unexpected: true }),
    ).toThrow();
    expect(() =>
      parseInactiveOwnerFamilyRejectionMarker({ ...marker(), ownerId: 'wrong' }),
    ).toThrow();
    expect(() =>
      parseInactiveOwnerFamilyRejectionMarker({
        ...marker(),
        meaning: {
          ...marker().meaning,
          assertion: { tense: 'future', polarity: 'positive', modality: 'asserted' },
        },
      }),
    ).toThrow();
    expect(() =>
      parseInactiveOwnerFamilyRejectionMarker({
        ...marker(),
        meaning: {
          ...marker().meaning,
          qualifiers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])),
        },
      }),
    ).toThrow();
  });

  it('bounds the complete marker by UTF-8 bytes, including qualifier text', () => {
    expect(() =>
      parseInactiveOwnerFamilyRejectionMarker({
        ...marker(),
        meaning: { ...marker().meaning, qualifiers: { note: '界'.repeat(1400) } },
      }),
    ).toThrow('UTF-8 storage limit');
  });
});
