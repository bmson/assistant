import { createHmac } from 'node:crypto';
import {
  type OwnerEditorCommand,
  type OwnerEditorOperationRecord,
  type OwnerEditorScope,
  type OwnerEditorSessionView,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import {
  issueOwnerEditorRecoveryProof,
  type OwnerEditorRecoveryPostAuthorization,
  verifyOwnerEditorRecoveryProof,
} from './owner-editor-recovery-proof';
import { ownerEditorSessionDigest } from './owner-editor-scope';

const NOW = Date.parse('2026-11-01T20:00:00.000Z');
const SECRET = 'fixture-recovery-proof-secret';
const owner = '10000000-0000-4000-8000-000000000001';
const subject = '20000000-0000-4000-8000-000000000002';
const epoch = '30000000-0000-4000-8000-000000000003';
const operationId = '40000000-0000-4000-8000-000000000004';
const claimToken = '50000000-0000-4000-8000-000000000005';

function fixture(now = NOW, issuedAt = now - 60 * 60_000) {
  const session: OwnerEditorSessionView = {
    ownerId: owner,
    formSessionScope: 'session_scope_0123456789',
  };
  const scope: OwnerEditorScope = {
    ownerId: owner,
    sessionDigest: ownerEditorSessionDigest(session),
    epoch,
    privacyGeneration: 'privacy-generation-a',
    command: 'create_owner_memory',
    operationId,
    targetId: subject,
    nonce: '60000000-0000-4000-8000-000000000006',
    issuedAt,
    expiresAt: issuedAt + 10 * 60_000,
  };
  const operation: OwnerEditorOperationRecord = {
    id: ownerEditorOperationId(scope),
    ownerId: owner,
    epoch,
    privacyGenerationDigest: ownerEditorPrivacyDigest(scope.privacyGeneration),
    operationId,
    requestHash: 'a'.repeat(64),
    scopeDigest: ownerEditorScopeDigest(scope),
    command: scope.command,
    protocolVersion: 1,
    formIssuedAt: new Date(scope.issuedAt),
    formExpiresAt: new Date(scope.expiresAt),
    claimToken,
    claimExpiresAt: new Date(now - 1),
    status: 'preparing',
    statusVersion: 7,
    result: null,
    createdAt: new Date(scope.issuedAt),
    updatedAt: new Date(now - 1),
  };
  const authorization: OwnerEditorRecoveryPostAuthorization = {
    method: 'POST',
    intent: 'reconcile',
    sameOrigin: true,
    originalFormHandleVerified: true,
    session,
    command: scope.command,
    operationId,
  };
  const input = {
    authorization,
    scope,
    operation,
    current: { ownerId: owner, epoch, privacyGeneration: scope.privacyGeneration, ready: true },
    secret: SECRET,
    now,
  };
  return { input, authorization, scope, operation, session, current: input.current };
}

function signedPayload(payload: unknown, secret = SECRET, prefix = 'oer2') {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(`${prefix}.${body}`).digest('base64url');
  return `${prefix}.${body}.${mac}`;
}

function unpack(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function issue(f = fixture()) {
  const token = issueOwnerEditorRecoveryProof(f.input);
  if (!token) throw new Error('Expected proof fixture to be eligible');
  return token;
}

function reboundInputForCommand(command: OwnerEditorCommand) {
  const f = fixture();
  const scope = { ...f.scope, command };
  const operation = {
    ...f.operation,
    id: ownerEditorOperationId(scope),
    command,
    scopeDigest: ownerEditorScopeDigest(scope),
  };
  const authorization = { ...f.authorization, command };
  return { ...f.input, scope, operation, authorization };
}

describe('owner-editor recovery proof', () => {
  it('mints a purpose-separated POST proof for only the exact expired preparing operation', () => {
    const f = fixture();
    const token = issue(f);
    expect(token.startsWith('oer2.')).toBe(true);
    expect(token.startsWith('oep1.')).toBe(false);
    expect(unpack(token)).toMatchObject({
      purpose: 'owner-editor-recovery.v2',
      scope: f.scope,
      requestHash: f.operation.requestHash,
      statusVersion: f.operation.statusVersion,
      issuedAt: NOW,
      expiresAt: NOW + 120_000,
    });
    expect(verifyOwnerEditorRecoveryProof({ ...f.input, token })).toMatchObject({
      purpose: 'owner-editor-recovery.v2',
      requestHash: f.operation.requestHash,
      statusVersion: f.operation.statusVersion,
    });
  });

  it.each([
    ['GET', { method: 'GET' }],
    ['wrong intent', { intent: 'apply' }],
    ['cross origin', { sameOrigin: false }],
    ['unverified form handle', { originalFormHandleVerified: false }],
    ['wrong operation', { operationId: '70000000-0000-4000-8000-000000000007' }],
    ['wrong command', { command: 'correct_owner_memory' }],
  ])('refuses issuance without POST authorization: %s', (_label, change) => {
    const f = fixture();
    const authorization = { ...f.authorization, ...change } as OwnerEditorRecoveryPostAuthorization;
    expect(issueOwnerEditorRecoveryProof({ ...f.input, authorization })).toBeNull();
  });

  it.each(['remove_person', 'remove_owner_family_relationship'] as const)(
    'does not recognize dormant removal command %s, even with its scope and record rebound',
    (command) => {
      expect(issueOwnerEditorRecoveryProof(reboundInputForCommand(command))).toBeNull();
    },
  );

  it('requires a ready current owner, epoch and privacy generation', () => {
    const f = fixture();
    for (const current of [
      { ...f.current, ready: false },
      { ...f.current, ownerId: subject },
      { ...f.current, epoch: '70000000-0000-4000-8000-000000000007' },
      { ...f.current, privacyGeneration: 'privacy-generation-b' },
    ])
      expect(issueOwnerEditorRecoveryProof({ ...f.input, current })).toBeNull();
  });

  it('requires the original current owner and form session', () => {
    const f = fixture();
    const token = issue(f);
    const changedSession = { ...f.session, formSessionScope: 'rotated_scope_0123456789' };
    expect(
      verifyOwnerEditorRecoveryProof({
        ...f.input,
        token,
        authorization: { ...f.authorization, session: changedSession },
      }),
    ).toBeNull();
    expect(
      issueOwnerEditorRecoveryProof({
        ...f.input,
        authorization: {
          ...f.authorization,
          session: { ...f.session, ownerId: subject },
        },
      }),
    ).toBeNull();
  });

  it('refuses missing, terminal, live, malformed or differently scoped records', () => {
    const f = fixture();
    expect(issueOwnerEditorRecoveryProof({ ...f.input, operation: null })).toBeNull();
    expect(
      issueOwnerEditorRecoveryProof({
        ...f.input,
        operation: { ...f.operation, claimExpiresAt: new Date(NOW) },
      }),
    ).not.toBeNull();
    expect(
      issueOwnerEditorRecoveryProof({
        ...f.input,
        operation: { ...f.operation, status: 'committed' },
      }),
    ).toBeNull();
    expect(
      issueOwnerEditorRecoveryProof({
        ...f.input,
        operation: { ...f.operation, claimExpiresAt: new Date(NOW + 1) },
      }),
    ).toBeNull();
    expect(
      issueOwnerEditorRecoveryProof({
        ...f.input,
        operation: { ...f.operation, claimExpiresAt: null },
      }),
    ).toBeNull();
    expect(
      issueOwnerEditorRecoveryProof({
        ...f.input,
        operation: {
          ...f.operation,
          privacyGenerationDigest: ownerEditorPrivacyDigest('old-generation'),
        },
      }),
    ).toBeNull();
    expect(
      issueOwnerEditorRecoveryProof({
        ...f.input,
        operation: { ...f.operation, scopeDigest: 'b'.repeat(64) },
      }),
    ).toBeNull();
  });

  it('roundtrips near-limit Unicode proofs and refuses an oversized encoded token', () => {
    const f = fixture();
    const withPrivacy = (privacyGeneration: string) => {
      const scope = { ...f.scope, privacyGeneration };
      return {
        ...f.input,
        scope,
        current: { ...f.current, privacyGeneration },
        operation: {
          ...f.operation,
          id: ownerEditorOperationId(scope),
          scopeDigest: ownerEditorScopeDigest(scope),
          privacyGenerationDigest: ownerEditorPrivacyDigest(privacyGeneration),
        },
      };
    };
    // Derive the byte boundary independently using a signed fixture payload.
    const payload = unpack(issue(f));
    let largestAccepted = 0;
    for (let count = 1; count <= 2048; count++) {
      const scope = { ...f.scope, privacyGeneration: '界'.repeat(count) };
      const candidate = signedPayload({ ...payload, scope });
      if (Buffer.byteLength(candidate, 'utf8') <= 8192) largestAccepted = count;
      else break;
    }
    const input = withPrivacy('界'.repeat(largestAccepted));
    const token = issueOwnerEditorRecoveryProof(input);
    expect(token).not.toBeNull();
    expect(Buffer.byteLength(token ?? '', 'utf8')).toBeGreaterThan(8188);
    expect(Buffer.byteLength(token ?? '', 'utf8')).toBeLessThanOrEqual(8192);
    expect(verifyOwnerEditorRecoveryProof({ ...input, token: token ?? '' })).not.toBeNull();
    expect(issueOwnerEditorRecoveryProof(withPrivacy('界'.repeat(largestAccepted + 1)))).toBeNull();
    expect(issueOwnerEditorRecoveryProof(withPrivacy('界'.repeat(1800)))).toBeNull();
  });

  it('rejects proof tampering, wrong key, prior-version and old locator/form tokens', () => {
    const f = fixture();
    const token = issue(f);
    for (const malformed of ['', 'oer2.only-two-parts', 'oer2.$$$.$$$'])
      expect(verifyOwnerEditorRecoveryProof({ ...f.input, token: malformed })).toBeNull();
    expect(verifyOwnerEditorRecoveryProof({ ...f.input, token: `${token}x` })).toBeNull();
    expect(
      verifyOwnerEditorRecoveryProof({ ...f.input, token, secret: 'wrong-secret' }),
    ).toBeNull();
    expect(
      verifyOwnerEditorRecoveryProof({ ...f.input, token: token.replace(/^oer2/, 'oer1') }),
    ).toBeNull();
    expect(
      verifyOwnerEditorRecoveryProof({ ...f.input, token: token.replace(/^oer2/, 'oep1') }),
    ).toBeNull();
    expect(
      verifyOwnerEditorRecoveryProof({ ...f.input, token: token.replace(/^oer2/, 'oe1') }),
    ).toBeNull();
    expect(
      verifyOwnerEditorRecoveryProof({ ...f.input, token: `oer2.${'x'.repeat(8_200)}` }),
    ).toBeNull();
  });

  it('rejects owner, epoch, privacy, request hash, status version and claim changes after issuance', () => {
    const f = fixture();
    const token = issue(f);
    const changedScope = { ...f.scope, epoch: '70000000-0000-4000-8000-000000000007' };
    const changedOperation = (changes: Partial<OwnerEditorOperationRecord>) => ({
      ...f.operation,
      ...changes,
    });
    for (const input of [
      { ...f.input, current: { ...f.current, ownerId: subject } },
      { ...f.input, current: { ...f.current, epoch: changedScope.epoch } },
      { ...f.input, current: { ...f.current, privacyGeneration: 'privacy-generation-b' } },
      { ...f.input, operation: changedOperation({ requestHash: 'b'.repeat(64) }) },
      { ...f.input, operation: changedOperation({ statusVersion: 8 }) },
      {
        ...f.input,
        operation: changedOperation({ claimToken: '70000000-0000-4000-8000-000000000007' }),
      },
      { ...f.input, operation: changedOperation({ claimExpiresAt: new Date(NOW - 2) }) },
      { ...f.input, scope: changedScope },
    ])
      expect(verifyOwnerEditorRecoveryProof({ ...input, token })).toBeNull();
  });

  it('enforces proof time bounds, future timestamps and the original 24-hour replay limit', () => {
    const f = fixture();
    const token = issue(f);
    expect(verifyOwnerEditorRecoveryProof({ ...f.input, token, now: NOW - 1 })).toBeNull();
    expect(verifyOwnerEditorRecoveryProof({ ...f.input, token, now: NOW + 120_000 })).toBeNull();
    const future = { ...unpack(token), issuedAt: NOW + 1, expiresAt: NOW + 120_001 };
    expect(verifyOwnerEditorRecoveryProof({ ...f.input, token: signedPayload(future) })).toBeNull();
    const tooLong = { ...unpack(token), expiresAt: NOW + 120_001 };
    expect(
      verifyOwnerEditorRecoveryProof({ ...f.input, token: signedPayload(tooLong) }),
    ).toBeNull();

    const nearReplay = fixture(NOW, NOW - 24 * 60 * 60_000 + 25_000);
    const capped = issue(nearReplay);
    expect(unpack(capped).expiresAt).toBe(NOW + 25_000);
    expect(
      verifyOwnerEditorRecoveryProof({ ...nearReplay.input, token: capped, now: NOW + 24_999 }),
    ).not.toBeNull();
    expect(
      verifyOwnerEditorRecoveryProof({ ...nearReplay.input, token: capped, now: NOW + 25_000 }),
    ).toBeNull();
    expect(
      issueOwnerEditorRecoveryProof({
        ...nearReplay.input,
        now: nearReplay.scope.issuedAt + 24 * 60 * 60_000,
      }),
    ).toBeNull();
  });

  it('uses a strict signed payload and rejects unknown fields or another purpose', () => {
    const f = fixture();
    const token = issue(f);
    expect(
      verifyOwnerEditorRecoveryProof({
        ...f.input,
        token: signedPayload({ ...unpack(token), extra: 'not allowed' }),
      }),
    ).toBeNull();
    const payloadWithNestedUnknown = unpack(token);
    payloadWithNestedUnknown.scope = {
      ...(payloadWithNestedUnknown.scope as Record<string, unknown>),
      extra: 'not allowed',
    };
    expect(
      verifyOwnerEditorRecoveryProof({
        ...f.input,
        token: signedPayload(payloadWithNestedUnknown),
      }),
    ).toBeNull();
    expect(
      verifyOwnerEditorRecoveryProof({
        ...f.input,
        token: signedPayload({ ...unpack(token), purpose: 'owner-editor-recovery.v1' }),
      }),
    ).toBeNull();
  });
});
