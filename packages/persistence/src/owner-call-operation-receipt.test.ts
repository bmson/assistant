import { describe, expect, it } from 'vitest';
import { phoneCallOwnerNumberGrantScopeFingerprint } from './owner-call-grant-scope-fingerprint.js';
import {
  OWNER_CALL_OPERATION_PURPOSE,
  ownerCallGrantOperationMatchesSlot,
  parseOwnerCallGrantOperation,
  parseOwnerCallGrantOperationSlot,
} from './owner-call-operation-receipt.js';

const at = new Date('2026-10-26T12:00:00.000Z');
const ownerId = '00000000-0000-4000-8000-000000000001';
const approvalId = '00000000-0000-4000-8000-000000000002';
const grantId = '00000000-0000-4000-8000-000000000003';

function operation(phase: string = 'registered') {
  return {
    purpose: OWNER_CALL_OPERATION_PURPOSE,
    schemaVersion: 1,
    operationVersion: 1,
    ownerId,
    approvalId,
    grantId,
    taskId: '00000000-0000-4000-8000-000000000004',
    toolCallId: '00000000-0000-4000-8000-000000000005',
    slotGeneration: 1,
    requestFingerprint: 'a'.repeat(64),
    grantScopeFingerprint: 'b'.repeat(64),
    phase,
    registeredAt: at,
    reviewExpiresAt: new Date(at.getTime() + 60_000),
    grantExpiresAt: new Date(at.getTime() + 86_400_000),
    admittedAt: null,
    committedAt: null,
    closedAt: null,
    rejectedAt: null,
    createdPolicyId: null,
    wakeGeneration: null,
    updatedAt: at,
  };
}

describe('owner-call operation receipts', () => {
  it('accepts the explicit operation namespace and rejects legacy or unknown variants', () => {
    expect(parseOwnerCallGrantOperation(operation())).not.toBeNull();
    expect(parseOwnerCallGrantOperation({ ...operation(), purpose: 'review-token.v1' })).toBeNull();
    expect(parseOwnerCallGrantOperation({ ...operation(), schemaVersion: 2 })).toBeNull();
    expect(parseOwnerCallGrantOperation({ ...operation(), operationVersion: 2 })).toBeNull();
    expect(
      parseOwnerCallGrantOperation({ ...operation(), grantScopeFingerprint: 'short' }),
    ).toBeNull();
    expect(parseOwnerCallGrantOperation({ ...operation(), extra: true })).toBeNull();
  });

  it('rejects impossible phase and invalid timestamp records', () => {
    expect(
      parseOwnerCallGrantOperation({
        ...operation('committed'),
        committedAt: new Date(at.getTime() + 10),
        createdPolicyId: '00000000-0000-4000-8000-000000000006',
        wakeGeneration: 1,
      }),
    ).toBeNull();
    expect(
      parseOwnerCallGrantOperation({ ...operation(), registeredAt: new Date(Number.NaN) }),
    ).toBeNull();
    expect(
      parseOwnerCallGrantOperation({
        ...operation(),
        reviewExpiresAt: new Date(at.getTime()),
      }),
    ).toBeNull();
    expect(parseOwnerCallGrantOperation({ ...operation('admitted') })).toBeNull();
    expect(
      parseOwnerCallGrantOperation({
        ...operation('committed'),
        admittedAt: new Date(at.getTime() + 1),
        committedAt: new Date(at.getTime() + 2),
        createdPolicyId: '00000000-0000-4000-8000-000000000006',
      }),
    ).toBeNull();
    expect(parseOwnerCallGrantOperation({ ...operation('closed_no_effect') })).toBeNull();
  });

  it('requires a valid sentinel and an exact slot-to-operation generation match', () => {
    const slot = parseOwnerCallGrantOperationSlot({
      purpose: OWNER_CALL_OPERATION_PURPOSE,
      schemaVersion: 1,
      ownerId,
      approvalId,
      generation: 1,
      currentGrantId: grantId,
      updatedAt: at,
    });
    const parsedOperation = parseOwnerCallGrantOperation(operation());
    expect(slot).not.toBeNull();
    expect(parsedOperation).not.toBeNull();
    expect(ownerCallGrantOperationMatchesSlot(slot!, parsedOperation!)).toBe(true);
    expect(
      parseOwnerCallGrantOperationSlot({
        purpose: 'review-token.v1',
        schemaVersion: 1,
        ownerId,
        approvalId,
        generation: 1,
        currentGrantId: grantId,
        updatedAt: at,
      }),
    ).toBeNull();
    expect(ownerCallGrantOperationMatchesSlot({ ...slot!, generation: 2 }, parsedOperation!)).toBe(
      false,
    );
  });

  it('fingerprints only the normalized exact owner-number grant scope', () => {
    const scope = {
      schemaVersion: 1,
      grantId,
      recipientE164: '+15551234567',
      maxMinutes: 30,
      expiresAt: '2026-11-02T12:00:00.000Z',
    };
    const fingerprint = phoneCallOwnerNumberGrantScopeFingerprint(scope);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(phoneCallOwnerNumberGrantScopeFingerprint({ ...scope, maxMinutes: 31 })).not.toBe(
      fingerprint,
    );
    expect(phoneCallOwnerNumberGrantScopeFingerprint({ ...scope, extra: 'unknown' })).toBeNull();
  });
});
