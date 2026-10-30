import { describe, expect, it } from 'vitest';
import type {
  OwnerEditorClaim,
  OwnerEditorOperationRecord,
  OwnerEditorScope,
} from './owner-editor.js';
import {
  ownerEditorCommitRevision,
  ownerEditorScopeDigest,
  ownerEditorSnapshotRevision,
} from './owner-editor-identity.js';
import {
  ownerEditorAdmitClaim,
  ownerEditorReceipt,
  ownerEditorRecordMatches,
  ownerEditorUnknown,
} from './owner-editor-state.js';
import {
  parseOwnerEditorOperationRecord,
  parseOwnerEditorTerminalResult,
} from './owner-editor-storage.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const epoch = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const claimToken = '44444444-4444-4444-8444-444444444444';
const now = new Date('2026-10-25T12:00:00.000Z');
const scope: OwnerEditorScope = {
  ownerId,
  sessionDigest: 'session-digest',
  epoch,
  privacyGeneration: null,
  command: 'create_person',
  operationId,
  targetId: null,
  nonce: 'form-nonce',
  issuedAt: now.getTime() - 1_000,
  expiresAt: now.getTime() + 60_000,
};
const claim: OwnerEditorClaim = {
  scope,
  requestHash: 'a'.repeat(64),
  claimToken,
  claimExpiresAt: new Date(now.getTime() + 10_000),
  statusVersion: 1,
};
function preparing(
  overrides: Partial<OwnerEditorOperationRecord> = {},
): OwnerEditorOperationRecord {
  return {
    id: 'a'.repeat(64),
    ownerId,
    epoch,
    privacyGenerationDigest: 'b'.repeat(64),
    operationId,
    requestHash: claim.requestHash,
    scopeDigest: ownerEditorScopeDigest(scope),
    command: scope.command,
    protocolVersion: 1,
    formIssuedAt: new Date(scope.issuedAt),
    formExpiresAt: new Date(scope.expiresAt),
    claimToken,
    claimExpiresAt: claim.claimExpiresAt,
    status: 'preparing',
    statusVersion: 1,
    result: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
describe('owner editor admission and receipt state', () => {
  it('admits the matching live claim and treats an expired preparing claim as unknown', () => {
    expect(ownerEditorAdmitClaim(claim, preparing(), now)).toEqual({
      kind: 'admitted',
      claim,
      operation: preparing(),
    });
    const expiredClaim = { ...claim, claimExpiresAt: new Date(now.getTime()) };
    const expired = ownerEditorAdmitClaim(
      expiredClaim,
      preparing({ claimExpiresAt: expiredClaim.claimExpiresAt }),
      now,
    );
    expect(expired).toEqual({
      kind: 'reply',
      reply: ownerEditorUnknown(scope, 'proof_changed'),
    });
    expect(expired).not.toEqual({
      kind: 'reply',
      reply: expect.objectContaining({ outcome: 'not_applied' }),
    });
  });

  it('rejects a same-operation different-hash request without mutating the original claim record', () => {
    const original = preparing();
    const before = structuredClone(original);
    const admission = ownerEditorAdmitClaim(
      { ...claim, requestHash: 'c'.repeat(64) },
      original,
      now,
    );
    expect(admission).toEqual({
      kind: 'reply',
      reply: expect.objectContaining({
        authority: 'request_rejection',
        originalOperationTerminal: false,
      }),
    });
    expect(original).toEqual(before);
    expect(ownerEditorAdmitClaim(claim, original, now).kind).toBe('admitted');
  });

  it('returns unknown for changed claim token and changed status version', () => {
    const changedToken = ownerEditorAdmitClaim(
      { ...claim, claimToken: '55555555-5555-4555-8555-555555555555' },
      preparing(),
      now,
    );
    const changedVersion = ownerEditorAdmitClaim({ ...claim, statusVersion: 2 }, preparing(), now);
    for (const admission of [changedToken, changedVersion]) {
      expect(admission.kind).toBe('reply');
      if (admission.kind === 'reply') {
        expect(admission.reply.authority).toBe('unresolved');
        expect(admission.reply.outcome).toBe('outcome_unknown');
      }
    }
  });

  it('returns the exact stored committed receipt for the original claim identity', () => {
    const result = {
      outcome: 'saved' as const,
      ids: { contactId: '66666666-6666-4666-8666-666666666666' },
      revision: 'd'.repeat(64),
    };
    const committed = preparing({
      status: 'committed',
      statusVersion: 2,
      claimToken: null,
      claimExpiresAt: null,
      result,
    });
    expect(ownerEditorAdmitClaim(claim, committed, now)).toEqual({
      kind: 'reply',
      reply: ownerEditorReceipt(committed),
    });
    expect(ownerEditorReceipt(committed)).toMatchObject({
      authority: 'operation_receipt',
      ...result,
      operationId,
    });
    expect(ownerEditorRecordMatches(scope, committed)).toBe(true);
  });

  it('keeps operation commit identity distinct from the current entity snapshot revision', () => {
    const resultIds = { contactId: '66666666-6666-4666-8666-666666666666' };
    const commitRevision = ownerEditorCommitRevision(claim, resultIds);
    const entityRevision = ownerEditorSnapshotRevision({
      updatedAt: '2026-10-25T12:00:00.000001Z',
      name: 'Example',
    });
    expect(commitRevision).not.toBe(entityRevision);
  });
});

describe('owner editor persistence codecs', () => {
  it('rejects fake saved outcomes with empty or malformed durable IDs', () => {
    for (const ids of [{}, { contactId: 'not-a-uuid' }]) {
      expect(() =>
        parseOwnerEditorTerminalResult({ outcome: 'saved', ids, revision: 'd'.repeat(64) }),
      ).toThrow();
    }
  });

  it('rejects malformed terminal claim state, claim tokens and outcome/status mismatches', () => {
    const goodPending = preparing();
    expect(parseOwnerEditorOperationRecord(goodPending)).toEqual(goodPending);
    expect(() => parseOwnerEditorOperationRecord({ ...goodPending, claimToken: null })).toThrow();
    expect(() =>
      parseOwnerEditorOperationRecord({ ...goodPending, claimToken: 'not-a-uuid' }),
    ).toThrow();
    const malformedCommitted = preparing({
      status: 'committed',
      statusVersion: 2,
      claimToken: null,
      claimExpiresAt: null,
      result: { outcome: 'saved', ids: {}, revision: 'd'.repeat(64) },
    });
    expect(() => parseOwnerEditorOperationRecord(malformedCommitted)).toThrow();
    const wrongOutcome = preparing({
      status: 'terminal_rejected',
      statusVersion: 2,
      claimToken: null,
      claimExpiresAt: null,
      result: { outcome: 'not_applied', reason: 'claim_abandoned' },
    });
    expect(() => parseOwnerEditorOperationRecord(wrongOutcome)).toThrow();
  });
});
