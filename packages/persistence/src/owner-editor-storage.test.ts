import { describe, expect, it } from 'vitest';
import {
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
} from './owner-editor-identity.js';
import { parseOwnerEditorOperationRecord } from './owner-editor-storage.js';

const scope = {
  ownerId: '11111111-1111-4111-8111-111111111111',
  sessionDigest: 'a'.repeat(64),
  epoch: '22222222-2222-4222-8222-222222222222',
  privacyGeneration: null,
  command: 'correct_owner_memory' as const,
  operationId: '33333333-3333-4333-8333-333333333333',
  targetId: '44444444-4444-4444-8444-444444444444',
  nonce: '55555555-5555-4555-8555-555555555555',
  issuedAt: 1_800_000_000_000,
  expiresAt: 1_800_000_600_000,
};

function record(ids: Record<string, string>) {
  const now = new Date('2026-10-25T12:00:00.000Z');
  return {
    id: ownerEditorOperationId(scope),
    ownerId: scope.ownerId,
    epoch: scope.epoch,
    privacyGenerationDigest: ownerEditorPrivacyDigest(null),
    operationId: scope.operationId,
    requestHash: 'b'.repeat(64),
    scopeDigest: ownerEditorScopeDigest(scope),
    command: scope.command,
    protocolVersion: 1,
    formIssuedAt: now,
    formExpiresAt: new Date(now.getTime() + 600_000),
    claimToken: null,
    claimExpiresAt: null,
    status: 'committed',
    statusVersion: 2,
    result: { outcome: 'saved', ids, revision: 'c'.repeat(64) },
    createdAt: now,
    updatedAt: now,
  };
}

describe('owner editor persisted operation codec', () => {
  it('accepts a saved memory correction receipt containing only its memory identity', () => {
    expect(
      parseOwnerEditorOperationRecord(record({ memoryId: '44444444-4444-4444-8444-444444444444' }))
        .result,
    ).toMatchObject({
      outcome: 'saved',
      ids: { memoryId: '44444444-4444-4444-8444-444444444444' },
    });
  });

  it('rejects family/person identities or extra IDs in a memory correction receipt', () => {
    expect(() => parseOwnerEditorOperationRecord(record({ contactId: scope.targetId }))).toThrow();
    expect(() =>
      parseOwnerEditorOperationRecord(
        record({
          memoryId: scope.targetId,
          relationId: '66666666-6666-4666-8666-666666666666',
        }),
      ),
    ).toThrow();
  });
});
