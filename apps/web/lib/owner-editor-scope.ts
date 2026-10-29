import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  OWNER_EDITOR_COMMANDS,
  type OwnerEditorCommand,
  type OwnerEditorFormGrant,
  type OwnerEditorIssuanceContext,
  type OwnerEditorOperationRecord,
  type OwnerEditorReceiptProof,
  type OwnerEditorScope,
  type OwnerEditorSessionView,
  ownerEditorScopeDigest,
  ownerEditorSnapshotRevision,
} from '@assistant/persistence';
import { z } from 'zod';
import { isValidFormSessionScope } from '../app/auth-form-session-scope';

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const formMs = 10 * 60_000;
const proofMs = 2 * 60_000;
const replayMs = 24 * 60 * 60_000;
const scopeSchema = z
  .strictObject({
    ownerId: uuid,
    sessionDigest: hash,
    epoch: uuid,
    privacyGeneration: z.string().max(2048).nullable(),
    command: z.enum(OWNER_EDITOR_COMMANDS),
    operationId: uuid,
    targetId: uuid.nullable(),
    nonce: uuid,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .refine((s) => s.expiresAt > s.issuedAt && s.expiresAt - s.issuedAt <= formMs)
  .refine((s) => (s.command === 'create_person' ? s.targetId === null : s.targetId !== null));
const proofSchema = z
  .strictObject({
    scope: scopeSchema,
    requestHash: hash,
    claimIdentityDigest: hash,
    statusVersion: z.number().int().positive(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .refine((p) => p.expiresAt > p.issuedAt && p.expiresAt - p.issuedAt <= proofMs);

function sign(prefix: string, payload: unknown, secret: string): string {
  if (!secret) throw new Error('Editor form issuance is unavailable');
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${prefix}.${data}`).digest('base64url');
  return `${prefix}.${data}.${signature}`;
}
function verify(token: string, prefix: string, secret: string): unknown {
  if (!secret || token.length > 8192) return null;
  const parts = token.split('.');
  if (
    parts.length !== 3 ||
    parts[0] !== prefix ||
    !parts[1] ||
    !parts[2] ||
    !/^[A-Za-z0-9_-]+$/.test(parts[1]) ||
    !/^[A-Za-z0-9_-]+$/.test(parts[2])
  )
    return null;
  const expected = createHmac('sha256', secret).update(`${prefix}.${parts[1]}`).digest();
  const supplied = Buffer.from(parts[2], 'base64url');
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected) ||
    supplied.toString('base64url') !== parts[2]
  )
    return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
export function ownerEditorSessionDigest(session: OwnerEditorSessionView): string {
  return createHash('sha256')
    .update('owner-editor-session-v1\n')
    .update(JSON.stringify([session.ownerId, session.formSessionScope]))
    .digest('hex');
}

export function issueOwnerEditorFormGrant(input: {
  context: OwnerEditorIssuanceContext;
  session: OwnerEditorSessionView;
  command: OwnerEditorCommand;
  targetId: string | null;
  secret: string;
  now?: number;
}): OwnerEditorFormGrant {
  if (!isValidFormSessionScope(input.session.formSessionScope))
    throw new Error('Editor session is unavailable');
  if (input.context.ownerId !== input.session.ownerId) throw new Error('Editor owner mismatch');
  const now = input.now ?? Date.now();
  const scope = scopeSchema.parse({
    ...input.context,
    sessionDigest: ownerEditorSessionDigest(input.session),
    command: input.command,
    operationId: randomUUID(),
    targetId: input.targetId,
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt: now + formMs,
  });
  return {
    command: scope.command,
    operationId: scope.operationId,
    issuedOperationHandle: sign('oe1', scope, input.secret),
  };
}

export type OwnerEditorHandleCheck =
  | { kind: 'invalid' }
  | { kind: 'retired'; scope: OwnerEditorScope }
  | { kind: 'verified'; scope: OwnerEditorScope; formExpired: boolean };

/** Validates issuance only. Driver owner/privacy/epoch/CAS checks remain mandatory. */
export function verifyOwnerEditorHandle(input: {
  token: string;
  session: OwnerEditorSessionView;
  secret: string;
  now?: number;
}): OwnerEditorHandleCheck {
  if (!isValidFormSessionScope(input.session.formSessionScope)) return { kind: 'invalid' };
  const parsed = scopeSchema.safeParse(verify(input.token, 'oe1', input.secret));
  if (!parsed.success || parsed.data.ownerId !== input.session.ownerId) return { kind: 'invalid' };
  const scope = parsed.data;
  const now = input.now ?? Date.now();
  if (scope.issuedAt > now) return { kind: 'invalid' };
  if (
    scope.sessionDigest !== ownerEditorSessionDigest(input.session) ||
    now >= scope.issuedAt + replayMs
  )
    return { kind: 'retired', scope };
  return { kind: 'verified', scope, formExpired: now >= scope.expiresAt };
}

export function issueOwnerEditorReceiptProof(input: {
  operation: OwnerEditorOperationRecord;
  scope: OwnerEditorScope;
  secret: string;
  now?: number;
}): string {
  const { operation, scope } = input;
  if (operation.scopeDigest !== ownerEditorScopeDigest(scope) || operation.status !== 'preparing')
    throw new Error('Editor receipt binding is unavailable');
  const now = input.now ?? Date.now();
  const proof: OwnerEditorReceiptProof = {
    scope,
    requestHash: operation.requestHash,
    claimIdentityDigest: ownerEditorSnapshotRevision({
      token: operation.claimToken,
      expiresAt: operation.claimExpiresAt?.toISOString() ?? null,
    }),
    statusVersion: operation.statusVersion,
    issuedAt: now,
    expiresAt: now + proofMs,
  };
  return sign('oep1', proof, input.secret);
}
export function verifyOwnerEditorReceiptProof(input: {
  token: string;
  scope: OwnerEditorScope;
  secret: string;
  now?: number;
}): OwnerEditorReceiptProof | null {
  const parsed = proofSchema.safeParse(verify(input.token, 'oep1', input.secret));
  const now = input.now ?? Date.now();
  if (
    !parsed.success ||
    parsed.data.issuedAt > now ||
    parsed.data.expiresAt <= now ||
    ownerEditorScopeDigest(parsed.data.scope) !== ownerEditorScopeDigest(input.scope)
  )
    return null;
  return parsed.data;
}
