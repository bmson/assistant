import { describe, expect, it } from 'vitest';
import type { OwnerEditorClaim, OwnerEditorSavedIds, OwnerEditorScope } from './owner-editor.js';
import {
  ownerEditorCommitRevision,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
  ownerEditorSnapshotRevision,
} from './owner-editor-identity.js';

const scope: OwnerEditorScope = {
  ownerId: 'owner-1',
  sessionDigest: 'session-a',
  epoch: 'epoch-a',
  privacyGeneration: 'privacy-a',
  command: 'create_person',
  operationId: 'operation-a',
  targetId: null,
  nonce: 'nonce-a',
  issuedAt: 1_800_000_000_000,
  expiresAt: 1_800_000_300_000,
};
const claim: OwnerEditorClaim = {
  scope,
  requestHash: 'a'.repeat(64),
  claimToken: 'claim-a',
  claimExpiresAt: new Date('2026-10-25T00:00:10.000Z'),
  statusVersion: 1,
};

describe('owner editor identity digests', () => {
  it('preserves distinct PostgreSQL microsecond and Firestore seconds/nanos snapshot revisions', () => {
    const pgFirst = ownerEditorSnapshotRevision({ updatedAt: '2026-10-25T12:00:00.123456Z' });
    const pgSecond = ownerEditorSnapshotRevision({ updatedAt: '2026-10-25T12:00:00.123457Z' });
    const firestoreFirst = ownerEditorSnapshotRevision({
      updatedAt: { seconds: 1_798_000_000, nanos: 123_456_000 },
    });
    const firestoreSecond = ownerEditorSnapshotRevision({
      updatedAt: { seconds: 1_798_000_000, nanos: 123_457_000 },
    });
    expect(pgFirst).not.toBe(pgSecond);
    expect(firestoreFirst).not.toBe(firestoreSecond);
    expect(pgFirst).not.toBe(firestoreFirst);
  });

  it.each([
    ['Date', () => ({ updatedAt: new Date('2026-10-25T12:00:00.123Z') })],
    ['undefined', () => ({ updatedAt: undefined })],
    ['exotic object', () => ({ updatedAt: new Map([['seconds', 1]]) })],
    ['non-finite number', () => ({ revision: Number.NaN })],
  ])('rejects %s in exact snapshots', (_label, snapshot) => {
    expect(() => ownerEditorSnapshotRevision(snapshot())).toThrow(/exact timestamp/);
  });

  it('binds every scope metadata field into the scope digest', () => {
    const baseline = ownerEditorScopeDigest(scope);
    const variants: OwnerEditorScope[] = [
      { ...scope, ownerId: 'owner-2' },
      { ...scope, sessionDigest: 'session-b' },
      { ...scope, epoch: 'epoch-b' },
      { ...scope, privacyGeneration: 'privacy-b' },
      { ...scope, command: 'update_person_identity' },
      { ...scope, operationId: 'operation-b' },
      { ...scope, targetId: 'person-a' },
      { ...scope, nonce: 'nonce-b' },
      { ...scope, issuedAt: scope.issuedAt + 1 },
      { ...scope, expiresAt: scope.expiresAt + 1 },
    ];
    expect(new Set(variants.map(ownerEditorScopeDigest)).size).toBe(variants.length);
    expect(variants.every((variant) => ownerEditorScopeDigest(variant) !== baseline)).toBe(true);
  });

  it('separates operation and privacy digests by domain and binds commit identity to result IDs', () => {
    expect(ownerEditorOperationId(scope)).toBe(ownerEditorOperationId({ ...scope }));
    expect(ownerEditorOperationId(scope)).not.toBe(
      ownerEditorOperationId({ ...scope, operationId: 'operation-b' }),
    );
    expect(ownerEditorPrivacyDigest('privacy-a')).not.toBe(ownerEditorPrivacyDigest('privacy-b'));
    const ids: OwnerEditorSavedIds = { contactId: 'contact-a' };
    expect(ownerEditorCommitRevision(claim, ids)).toBe(
      ownerEditorCommitRevision(claim, { ...ids }),
    );
    expect(ownerEditorCommitRevision(claim, ids)).not.toBe(
      ownerEditorCommitRevision(claim, { contactId: 'contact-b' }),
    );
    expect(ownerEditorCommitRevision(claim, ids)).not.toBe(
      ownerEditorCommitRevision({ ...claim, requestHash: 'b'.repeat(64) }, ids),
    );
  });
});
