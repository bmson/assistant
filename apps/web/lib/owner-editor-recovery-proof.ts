import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type OwnerEditorCommand,
  type OwnerEditorOperationRecord,
  type OwnerEditorRecoveryCurrentState,
  type OwnerEditorScope,
  type OwnerEditorSessionView,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
  ownerEditorSnapshotRevision,
  parseOwnerEditorOperationRecord,
} from '@assistant/persistence';
import { z } from 'zod';
import { isValidFormSessionScope } from '../app/auth-form-session-scope';
import { ownerEditorSessionDigest } from './owner-editor-scope';

const TOKEN_PREFIX = 'oer2';
const PROOF_PURPOSE = 'owner-editor-recovery.v2';
const MAX_TOKEN_BYTES = 8_192;
const MAX_PROOF_AGE_MS = 120_000;
const REPLAY_WINDOW_MS = 24 * 60 * 60_000;
const FORM_WINDOW_MS = 10 * 60_000;
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
// Keep receipt recognition explicit. Adding a persistence wire command must
// not silently widen which command this dormant recovery proof recognizes.
const commands = [
  'create_person',
  'update_person_identity',
  'add_family_relationship',
  'correct_owner_family_relationship',
  'correct_owner_memory',
  'remove_owner_memory',
  'create_owner_memory',
] as const;
const scopeSchema = z
  .strictObject({
    ownerId: uuid,
    sessionDigest: hash,
    epoch: uuid,
    privacyGeneration: z.string().max(2048).nullable(),
    command: z.enum(commands),
    operationId: uuid,
    targetId: uuid.nullable(),
    nonce: uuid,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .refine(
    (scope) =>
      scope.expiresAt > scope.issuedAt && scope.expiresAt - scope.issuedAt <= FORM_WINDOW_MS,
  )
  .refine((scope) =>
    scope.command === 'create_person' ? scope.targetId === null : scope.targetId !== null,
  );
const proofSchema = z
  .strictObject({
    purpose: z.literal(PROOF_PURPOSE),
    scope: scopeSchema,
    requestHash: hash,
    claimIdentityDigest: hash,
    statusVersion: z.number().int().positive(),
    nonce: uuid,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .refine(
    (proof) =>
      proof.expiresAt > proof.issuedAt && proof.expiresAt - proof.issuedAt <= MAX_PROOF_AGE_MS,
  );

/**
 * This is a transport precondition supplied by the server caller, not proof
 * that this helper authenticated cookies or observed an HTTP request. Callers
 * may construct it only after authenticating the owner, checking same-origin
 * POST, validating the current session header and original signed form handle,
 * and parsing the exact reconcile command for that operation.
 */
export interface OwnerEditorRecoveryPostAuthorization {
  method: 'POST';
  intent: 'authorize_original_reconcile' | 'reconcile_original';
  sameOrigin: true;
  originalFormHandleVerified: true;
  session: OwnerEditorSessionView;
  command: OwnerEditorCommand;
  operationId: string;
}

export type { OwnerEditorRecoveryCurrentState } from '@assistant/persistence';

interface ProofInput {
  authorization: OwnerEditorRecoveryPostAuthorization;
  scope: OwnerEditorScope;
  operation: OwnerEditorOperationRecord | null;
  current: OwnerEditorRecoveryCurrentState;
  secret: string;
  now?: number;
}

export interface OwnerEditorRecoveryProofPayload {
  purpose: typeof PROOF_PURPOSE;
  scope: OwnerEditorScope;
  requestHash: string;
  claimIdentityDigest: string;
  statusVersion: number;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

function validBase(input: Omit<ProofInput, 'now'> | ProofInput, now: number): boolean {
  const { authorization, scope, operation, current, secret } = input;
  if (!scopeSchema.safeParse(scope).success) return false;
  if (
    !secret ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    authorization.method !== 'POST' ||
    !['authorize_original_reconcile', 'reconcile_original'].includes(authorization.intent) ||
    authorization.sameOrigin !== true ||
    authorization.originalFormHandleVerified !== true ||
    authorization.command !== scope.command ||
    authorization.operationId !== scope.operationId ||
    authorization.session.ownerId !== scope.ownerId ||
    !isValidFormSessionScope(authorization.session.formSessionScope) ||
    scope.sessionDigest !== ownerEditorSessionDigest(authorization.session) ||
    current.ready !== true ||
    current.ownerId !== scope.ownerId ||
    current.epoch !== scope.epoch ||
    current.privacyGeneration !== scope.privacyGeneration ||
    !operation ||
    !isOperationBoundToScope(operation, scope) ||
    operation.status !== 'preparing' ||
    !uuid.safeParse(operation.claimToken).success ||
    !(operation.claimExpiresAt instanceof Date) ||
    !Number.isFinite(operation.claimExpiresAt.getTime()) ||
    !(operation.formIssuedAt instanceof Date) ||
    !(operation.formExpiresAt instanceof Date) ||
    !Number.isFinite(operation.formIssuedAt.getTime()) ||
    !Number.isFinite(operation.formExpiresAt.getTime()) ||
    operation.formIssuedAt.getTime() !== scope.issuedAt ||
    operation.formExpiresAt.getTime() !== scope.expiresAt ||
    operation.claimExpiresAt.getTime() > now ||
    !hash.safeParse(operation.requestHash).success ||
    !Number.isSafeInteger(operation.statusVersion) ||
    operation.statusVersion < 1 ||
    !Number.isSafeInteger(scope.issuedAt) ||
    !Number.isSafeInteger(scope.expiresAt) ||
    scope.issuedAt > now ||
    now >= scope.issuedAt + REPLAY_WINDOW_MS
  )
    return false;
  return true;
}

function isOperationBoundToScope(
  operation: OwnerEditorOperationRecord,
  scope: OwnerEditorScope,
): boolean {
  return (
    operation.id === ownerEditorOperationId(scope) &&
    operation.ownerId === scope.ownerId &&
    operation.epoch === scope.epoch &&
    operation.privacyGenerationDigest === ownerEditorPrivacyDigest(scope.privacyGeneration) &&
    operation.operationId === scope.operationId &&
    operation.command === scope.command &&
    operation.scopeDigest === ownerEditorScopeDigest(scope) &&
    operation.protocolVersion === 1
  );
}

function sign(payload: OwnerEditorRecoveryProofPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${TOKEN_PREFIX}.${body}`)
    .digest('base64url');
  return `${TOKEN_PREFIX}.${body}.${signature}`;
}

function decode(token: string, secret: string): OwnerEditorRecoveryProofPayload | null {
  if (!secret || typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES)
    return null;
  const parts = token.split('.');
  if (
    parts.length !== 3 ||
    parts[0] !== TOKEN_PREFIX ||
    !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? '') ||
    !/^[A-Za-z0-9_-]+$/.test(parts[2] ?? '')
  )
    return null;
  const expected = createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${parts[1]}`).digest();
  const supplied = Buffer.from(parts[2], 'base64url');
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected) ||
    supplied.toString('base64url') !== parts[2]
  )
    return null;
  try {
    const parsed = proofSchema.safeParse(
      JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
    );
    if (!parsed.success) return null;
    return parsed.data as OwnerEditorRecoveryProofPayload;
  } catch {
    return null;
  }
}

/** Mint only during an authorized POST for the exact existing expired claim. */
export function issueOwnerEditorRecoveryProof(input: ProofInput): string | null {
  const now = input.now ?? Date.now();
  if (input.authorization.intent !== 'authorize_original_reconcile' || !validBase(input, now))
    return null;
  const operation = input.operation;
  if (!operation?.claimExpiresAt) return null;
  const replayExpiresAt = input.scope.issuedAt + REPLAY_WINDOW_MS;
  const expiresAt = Math.min(now + MAX_PROOF_AGE_MS, replayExpiresAt);
  if (expiresAt <= now) return null;
  const payload: OwnerEditorRecoveryProofPayload = {
    purpose: PROOF_PURPOSE,
    scope: input.scope,
    requestHash: operation.requestHash,
    claimIdentityDigest: ownerEditorSnapshotRevision({
      token: operation.claimToken,
      expiresAt: operation.claimExpiresAt.toISOString(),
    }),
    statusVersion: operation.statusVersion,
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt,
  };
  const checked = proofSchema.safeParse(payload);
  if (!checked.success) return null;
  const token = sign(checked.data as OwnerEditorRecoveryProofPayload, input.secret);
  return Buffer.byteLength(token, 'utf8') <= MAX_TOKEN_BYTES ? token : null;
}

/** Verify against a fresh POST context and fresh current-state/operation reads. */
export function verifyOwnerEditorRecoveryProof(
  input: ProofInput & { token: string },
): OwnerEditorRecoveryProofPayload | null {
  const now = input.now ?? Date.now();
  if (input.authorization.intent !== 'reconcile_original' || !validBase(input, now)) return null;
  const proof = decode(input.token, input.secret);
  if (
    !proof ||
    proof.issuedAt > now ||
    proof.issuedAt < input.scope.issuedAt ||
    proof.expiresAt <= now ||
    proof.expiresAt > input.scope.issuedAt + REPLAY_WINDOW_MS ||
    ownerEditorScopeDigest(proof.scope) !== ownerEditorScopeDigest(input.scope) ||
    proof.requestHash !== input.operation?.requestHash ||
    proof.statusVersion !== input.operation?.statusVersion ||
    proof.claimIdentityDigest !==
      ownerEditorSnapshotRevision({
        token: input.operation?.claimToken,
        expiresAt: input.operation?.claimExpiresAt?.toISOString() ?? null,
      })
  )
    return null;
  return proof;
}

/**
 * Verifies a recovery token only for disclosing the exact original terminal
 * receipt after a race. This does not establish authority to mutate or abandon
 * an operation; use verifyOwnerEditorRecoveryProof for that purpose.
 */
export function verifyOwnerEditorRecoveryReceiptProof(
  input: ProofInput & { token: string },
): OwnerEditorRecoveryProofPayload | null {
  const now = input.now ?? Date.now();
  const { authorization, scope, operation, current } = input;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    authorization.intent !== 'reconcile_original' ||
    authorization.method !== 'POST' ||
    authorization.sameOrigin !== true ||
    authorization.originalFormHandleVerified !== true ||
    authorization.command !== scope.command ||
    authorization.operationId !== scope.operationId ||
    authorization.session.ownerId !== scope.ownerId ||
    !isValidFormSessionScope(authorization.session.formSessionScope) ||
    !scopeSchema.safeParse(scope).success ||
    typeof current.ready !== 'boolean' ||
    scope.sessionDigest !== ownerEditorSessionDigest(authorization.session) ||
    current.ownerId !== scope.ownerId ||
    current.epoch !== scope.epoch ||
    current.privacyGeneration !== scope.privacyGeneration ||
    !operation ||
    operation.status === 'preparing' ||
    !operation.result
  )
    return null;
  let parsedOperation: OwnerEditorOperationRecord;
  try {
    parsedOperation = parseOwnerEditorOperationRecord(operation);
  } catch {
    return null;
  }
  if (
    parsedOperation.id !== ownerEditorOperationId(scope) ||
    parsedOperation.ownerId !== scope.ownerId ||
    parsedOperation.epoch !== scope.epoch ||
    parsedOperation.privacyGenerationDigest !== ownerEditorPrivacyDigest(scope.privacyGeneration) ||
    parsedOperation.operationId !== scope.operationId ||
    parsedOperation.command !== scope.command ||
    parsedOperation.scopeDigest !== ownerEditorScopeDigest(scope) ||
    parsedOperation.formIssuedAt.getTime() !== scope.issuedAt ||
    parsedOperation.formExpiresAt.getTime() !== scope.expiresAt
  )
    return null;
  const proof = decode(input.token, input.secret);
  if (
    !proof ||
    proof.issuedAt > now ||
    proof.issuedAt < scope.issuedAt ||
    proof.expiresAt <= now ||
    proof.expiresAt > scope.issuedAt + REPLAY_WINDOW_MS ||
    ownerEditorScopeDigest(proof.scope) !== ownerEditorScopeDigest(scope) ||
    proof.requestHash !== parsedOperation.requestHash ||
    parsedOperation.statusVersion <= proof.statusVersion
  )
    return null;
  return proof;
}
