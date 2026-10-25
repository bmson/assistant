import { createHmac } from 'node:crypto';
import {
  type OwnerEditorCommand,
  type OwnerEditorOperationRecord,
  type OwnerEditorScope,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import {
  issueOwnerEditorFormGrant,
  issueOwnerEditorReceiptProof,
  verifyOwnerEditorHandle,
  verifyOwnerEditorReceiptProof,
} from './owner-editor-scope';

const now = Date.parse('2026-10-25T12:00:00.000Z');
const owner = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const secret = 'offline-fixture-secret-not-a-configured-credential';
const session = { ownerId: owner, formSessionScope: 'offline_session_scope_2026' };
const context = {
  ownerId: owner,
  epoch: '44444444-4444-4444-8444-444444444444',
  privacyGeneration: 'privacy-fixture-generation-A',
};
function form(command: OwnerEditorCommand = 'update_person_identity') {
  return issueOwnerEditorFormGrant({
    context,
    session,
    command,
    targetId: command === 'create_person' ? null : target,
    secret,
    now,
  });
}
function scope(): OwnerEditorScope {
  const checked = verifyOwnerEditorHandle({
    token: form().issuedOperationHandle,
    session,
    secret,
    now,
  });
  if (checked.kind !== 'verified') throw Error('Fixture grant must verify through actual crypto');
  return checked.scope;
}
function operation(s: OwnerEditorScope): OwnerEditorOperationRecord {
  return {
    id: ownerEditorOperationId(s),
    ownerId: s.ownerId,
    epoch: s.epoch,
    operationId: s.operationId,
    privacyGenerationDigest: ownerEditorPrivacyDigest(s.privacyGeneration),
    requestHash: 'b'.repeat(64),
    scopeDigest: ownerEditorScopeDigest(s),
    command: s.command,
    protocolVersion: 1,
    formIssuedAt: new Date(s.issuedAt),
    formExpiresAt: new Date(s.expiresAt),
    claimToken: '55555555-5555-4555-8555-555555555555',
    claimExpiresAt: new Date(now + 60_000),
    status: 'preparing',
    statusVersion: 1,
    result: null,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}
/** Malformed *signed* payload checks schema enforcement beyond signature validity. */
function signedPayload(token: string, value: unknown): string {
  const prefix = token.split('.')[0];
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${prefix}.${data}`).digest('base64url');
  return `${prefix}.${data}.${signature}`;
}

describe('actual owner editor HMAC issuance boundary (not driver/write authority)', () => {
  it.each([
    'create_person',
    'update_person_identity',
    'add_family_relationship',
    'correct_owner_family_relationship',
  ] as const)(
    'roundtrips exact owner/session/command/target/operation for %s with fresh nonce and UUID',
    (command) => {
      const a = form(command),
        b = form(command);
      const first = verifyOwnerEditorHandle({
        token: a.issuedOperationHandle,
        session,
        secret,
        now,
      });
      const second = verifyOwnerEditorHandle({
        token: b.issuedOperationHandle,
        session,
        secret,
        now,
      });
      expect(first.kind).toBe('verified');
      expect(second.kind).toBe('verified');
      if (first.kind !== 'verified' || second.kind !== 'verified')
        throw Error('Expected actual signed forms');
      expect(first.scope).toMatchObject({
        ownerId: owner,
        epoch: context.epoch,
        privacyGeneration: context.privacyGeneration,
        command,
        operationId: a.operationId,
        targetId: command === 'create_person' ? null : target,
      });
      expect(first.formExpired).toBe(false);
      expect(first.scope.nonce).not.toBe(second.scope.nonce);
      expect(a.operationId).not.toBe(b.operationId);
      expect(a.issuedOperationHandle).not.toBe(b.issuedOperationHandle);
    },
  );
  it('tampering a real signed owner/session/command/target/operation payload is invalid, never retirement', () => {
    const grant = form();
    const parts = grant.issuedOperationHandle.split('.');
    const original = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    for (const mutation of [
      { ownerId: other },
      { sessionDigest: 'f'.repeat(64) },
      { command: 'create_person' },
      { targetId: other },
      { operationId: other },
    ]) {
      const changed = Buffer.from(JSON.stringify({ ...original, ...mutation })).toString(
        'base64url',
      );
      const checked = verifyOwnerEditorHandle({
        token: `${parts[0]}.${changed}.${parts[2]}`,
        session,
        secret,
        now,
      });
      expect(checked).toEqual({ kind: 'invalid' });
    }
  });
  it.each(['', 'not-a-token', 'oe1.a.b', 'oe1..a', 'oep1.a.b', 'a'.repeat(8_193)])(
    'malformed, cross-domain or overlong token is invalid (%s)',
    (token) => {
      expect(verifyOwnerEditorHandle({ token, session, secret, now })).toEqual({ kind: 'invalid' });
    },
  );
  it('wrong owner and wrong secret fail closed; they cannot retire a legitimate handle', () => {
    const token = form().issuedOperationHandle;
    expect(
      verifyOwnerEditorHandle({ token, session: { ...session, ownerId: other }, secret, now }),
    ).toEqual({ kind: 'invalid' });
    expect(
      verifyOwnerEditorHandle({ token, session, secret: 'different-offline-secret', now }),
    ).toEqual({ kind: 'invalid' });
    expect(() =>
      issueOwnerEditorFormGrant({
        context,
        session: { ...session, ownerId: other },
        command: 'create_person',
        targetId: null,
        secret,
        now,
      }),
    ).toThrow();
  });
  it.each(['', 'legacy', 'a'.repeat(129), 'invalid session scope 2026'])(
    'empty/legacy/malformed session cannot issue or verify (%s)',
    (formSessionScope) => {
      expect(() =>
        issueOwnerEditorFormGrant({
          context,
          session: { ...session, formSessionScope },
          command: 'create_person',
          targetId: null,
          secret,
          now,
        }),
      ).toThrow();
      expect(
        verifyOwnerEditorHandle({
          token: form().issuedOperationHandle,
          session: { ...session, formSessionScope },
          secret,
          now,
        }),
      ).toEqual({ kind: 'invalid' });
    },
  );
  it.each([16, 128])('real session validator accepts its %i-character boundary', (length) => {
    const scopedSession = { ...session, formSessionScope: 'x'.repeat(length) };
    const grant = issueOwnerEditorFormGrant({
      context,
      session: scopedSession,
      command: 'create_person',
      targetId: null,
      secret,
      now,
    });
    expect(
      verifyOwnerEditorHandle({
        token: grant.issuedOperationHandle,
        session: scopedSession,
        secret,
        now,
      }).kind,
    ).toBe('verified');
  });
  it('no signing secret never issues a form/proof and never verifies an existing one', () => {
    const s = scope();
    expect(() =>
      issueOwnerEditorFormGrant({
        context,
        session,
        command: 'create_person',
        targetId: null,
        secret: '',
        now,
      }),
    ).toThrow();
    expect(
      verifyOwnerEditorHandle({ token: form().issuedOperationHandle, session, secret: '', now }),
    ).toEqual({ kind: 'invalid' });
    expect(() =>
      issueOwnerEditorReceiptProof({ scope: s, operation: operation(s), secret: '', now }),
    ).toThrow();
  });
  it('a cryptographically verified old session/replay-window scope retires without a historical application claim', () => {
    const token = form().issuedOperationHandle;
    const oldSession = verifyOwnerEditorHandle({
      token,
      session: { ...session, formSessionScope: 'different_valid_session_2026' },
      secret,
      now,
    });
    const oldReplay = verifyOwnerEditorHandle({
      token,
      session,
      secret,
      now: now + 24 * 60 * 60_000,
    });
    for (const result of [oldSession, oldReplay]) {
      expect(result.kind).toBe('retired');
      expect(result).not.toHaveProperty('outcome', 'not_applied');
      expect(result).not.toHaveProperty('primaryWrite');
    }
    // Expired issuance is still a verified old handle within replay horizon;
    // HTTP/apply admission must use formExpired, not treat verified as write authority.
    expect(
      verifyOwnerEditorHandle({ token, session, secret, now: now + 10 * 60_000 }),
    ).toMatchObject({ kind: 'verified', formExpired: true });
    expect(
      verifyOwnerEditorHandle({ token, session, secret, now: now + 24 * 60 * 60_000 - 1 }),
    ).toMatchObject({ kind: 'verified', formExpired: true });
  });
  it('future-issued and signed schema-invalid forms fail closed rather than retire', () => {
    const future = issueOwnerEditorFormGrant({
      context,
      session,
      command: 'create_person',
      targetId: null,
      secret,
      now: now + 1,
    });
    expect(
      verifyOwnerEditorHandle({ token: future.issuedOperationHandle, session, secret, now }),
    ).toEqual({ kind: 'invalid' });
    const s = scope(),
      token = form().issuedOperationHandle;
    for (const changed of [
      { ...s, targetId: 'contact-1' },
      { ...s, unknown: 'extra' },
      { ...s, expiresAt: s.issuedAt + 10 * 60_000 + 1 },
    ]) {
      expect(
        verifyOwnerEditorHandle({ token: signedPayload(token, changed), session, secret, now }),
      ).toEqual({ kind: 'invalid' });
    }
  });
});

describe('actual original-operation receipt proof boundary', () => {
  it('only a matching original preparing scope can issue; proof contains bindings, no private draft', () => {
    const s = scope(),
      record = operation(s);
    const token = issueOwnerEditorReceiptProof({ scope: s, operation: record, secret, now });
    const checked = verifyOwnerEditorReceiptProof({ token, scope: s, secret, now });
    expect(checked).toMatchObject({
      scope: s,
      requestHash: record.requestHash,
      statusVersion: record.statusVersion,
    });
    expect(checked?.claimIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    expect(Object.keys(payload).sort()).toEqual([
      'claimIdentityDigest',
      'expiresAt',
      'issuedAt',
      'requestHash',
      'scope',
      'statusVersion',
    ]);
    expect(payload).not.toHaveProperty('name');
    expect(payload).not.toHaveProperty('note');
    expect(payload).not.toHaveProperty('replacement');
    expect(() =>
      issueOwnerEditorReceiptProof({
        scope: { ...s, operationId: other },
        operation: record,
        secret,
        now,
      }),
    ).toThrow();
    for (const status of ['committed', 'terminal_rejected', 'abandoned'] as const)
      expect(() =>
        issueOwnerEditorReceiptProof({ scope: s, operation: { ...record, status }, secret, now }),
      ).toThrow();
  });
  it('proof changes with hash/claim/status state; old valid signature alone cannot authorize reconciliation', () => {
    const s = scope(),
      record = operation(s);
    const old = issueOwnerEditorReceiptProof({ scope: s, operation: record, secret, now });
    const advanced = issueOwnerEditorReceiptProof({
      scope: s,
      operation: {
        ...record,
        requestHash: 'c'.repeat(64),
        claimToken: other,
        claimExpiresAt: new Date(now + 61_000),
        statusVersion: 2,
      },
      secret,
      now,
    });
    const before = verifyOwnerEditorReceiptProof({ token: old, scope: s, secret, now });
    const after = verifyOwnerEditorReceiptProof({ token: advanced, scope: s, secret, now });
    expect(before?.requestHash).toBe(record.requestHash);
    expect(after?.requestHash).toBe('c'.repeat(64));
    expect(before?.claimIdentityDigest).not.toBe(after?.claimIdentityDigest);
    expect(before?.statusVersion).not.toBe(after?.statusVersion);
    // This intentionally remains cryptographically valid. Driver must compare
    // immutable original hash/live claim/status under owner+privacy serialization.
    expect(before).not.toBeNull();
  });
  it('proof expires at two minutes, rejects future issuance, wrong secret and cross-domain form handles', () => {
    const s = scope();
    const token = issueOwnerEditorReceiptProof({ scope: s, operation: operation(s), secret, now });
    expect(
      verifyOwnerEditorReceiptProof({ token, scope: s, secret, now: now + 119_999 }),
    ).not.toBeNull();
    expect(
      verifyOwnerEditorReceiptProof({ token, scope: s, secret, now: now + 120_000 }),
    ).toBeNull();
    expect(verifyOwnerEditorReceiptProof({ token, scope: s, secret, now: now - 1 })).toBeNull();
    expect(verifyOwnerEditorReceiptProof({ token, scope: s, secret: 'wrong', now })).toBeNull();
    expect(
      verifyOwnerEditorReceiptProof({ token: form().issuedOperationHandle, scope: s, secret, now }),
    ).toBeNull();
  });
  it('same-owner proof cannot be moved to another session/epoch/command/target/operation scope', () => {
    const s = scope();
    const token = issueOwnerEditorReceiptProof({ scope: s, operation: operation(s), secret, now });
    for (const changed of [
      { ...s, ownerId: other },
      { ...s, sessionDigest: 'c'.repeat(64) },
      { ...s, epoch: other },
      { ...s, command: 'create_person' as const },
      { ...s, targetId: other },
      { ...s, operationId: other },
      { ...s, privacyGeneration: 'generation-B' },
    ])
      expect(verifyOwnerEditorReceiptProof({ token, scope: changed, secret, now })).toBeNull();
  });
  it('tampered and signed schema-invalid proof cannot become an operation receipt', () => {
    const s = scope();
    const token = issueOwnerEditorReceiptProof({ scope: s, operation: operation(s), secret, now });
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    const tampered = token.replace(
      token.split('.')[1] ?? '',
      Buffer.from(JSON.stringify({ ...payload, requestHash: 'c'.repeat(64) })).toString(
        'base64url',
      ),
    );
    expect(verifyOwnerEditorReceiptProof({ token: tampered, scope: s, secret, now })).toBeNull();
    for (const changed of [
      { ...payload, requestHash: '' },
      { ...payload, statusVersion: 0 },
      { ...payload, claimIdentityDigest: 'claim-1' },
      { ...payload, expiresAt: now + 120_001 },
      { ...payload, name: 'private draft must be rejected' },
    ])
      expect(
        verifyOwnerEditorReceiptProof({
          token: signedPayload(token, changed),
          scope: s,
          secret,
          now,
        }),
      ).toBeNull();
  });
});
