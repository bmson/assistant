import { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import type { OwnerEditorScope } from '@assistant/persistence/owner-editor';
import { z } from 'zod';
import type { MobileBearerPrincipal } from '@/mobile-auth';

const HANDLE_PREFIX = 'omc1';
const PURPOSE = 'mobile_owner_memory_correction';
const FORM_MS = 10 * 60_000;
export const MOBILE_OWNER_MEMORY_CORRECTION_REPLAY_MS = 24 * 60 * 60_000;

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const deviceId = z.string().regex(/^[a-z0-9]{24}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const principalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('configured_installation_bearer') }),
  z.strictObject({ kind: z.literal('owner_device_bearer'), deviceId }),
]);
const scopeSchema = z
  .strictObject({
    ownerId: uuid,
    sessionDigest: hash,
    epoch: uuid,
    privacyGeneration: z.string().max(2048).nullable(),
    command: z.literal('correct_owner_memory'),
    operationId: uuid,
    targetId: uuid,
    nonce: uuid,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .refine((scope) => scope.expiresAt > scope.issuedAt)
  .refine((scope) => scope.expiresAt - scope.issuedAt <= FORM_MS);
const claimsSchema = z.strictObject({
  version: z.literal(1),
  purpose: z.literal(PURPOSE),
  principal: principalSchema,
  scope: scopeSchema,
  expectedContentHash: hash,
  expectedMemoryRevision: hash,
  requestHash: hash,
});

export type MobileOwnerMemoryCorrectionPrincipal = z.infer<typeof principalSchema>;
export type MobileOwnerMemoryCorrectionClaims = z.infer<typeof claimsSchema>;

export function mobileOwnerMemoryPrincipalDigest(
  ownerId: string,
  principal: MobileBearerPrincipal,
): string {
  const identity =
    principal.kind === 'owner_device_bearer'
      ? [ownerId, principal.kind, principal.deviceId]
      : [ownerId, principal.kind];
  return createHash('sha256')
    .update('mobile-owner-memory-principal-v1\n')
    .update(JSON.stringify(identity))
    .digest('hex');
}

function nativeHandleKey(secret: string): Buffer {
  if (!secret) throw new Error('Native owner-memory correction authorization is unavailable');
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from('assistant-mobile-owner-memory-correction-v1', 'utf8'),
      Buffer.from('omc1-authorization-hmac-sha256', 'utf8'),
      32,
    ),
  );
}

function signature(data: string, secret: string): Buffer {
  return createHmac('sha256', nativeHandleKey(secret)).update(data).digest();
}

export function issueMobileOwnerMemoryCorrectionAuthorization(input: {
  principal: MobileBearerPrincipal;
  ownerId: string;
  epoch: string;
  privacyGeneration: string | null;
  memoryId: string;
  operationId: string;
  expectedContentHash: string;
  expectedMemoryRevision: string;
  requestHash: string;
  secret: string;
  now: number;
}): { authorization: string; operationId: string; expiresAt: number } {
  const scope: OwnerEditorScope = {
    ownerId: input.ownerId,
    sessionDigest: mobileOwnerMemoryPrincipalDigest(input.ownerId, input.principal),
    epoch: input.epoch,
    privacyGeneration: input.privacyGeneration,
    command: 'correct_owner_memory',
    operationId: input.operationId,
    targetId: input.memoryId,
    nonce: randomUUID(),
    issuedAt: input.now,
    expiresAt: input.now + FORM_MS,
  };
  const claims = claimsSchema.parse({
    version: 1,
    purpose: PURPOSE,
    principal: input.principal,
    scope,
    expectedContentHash: input.expectedContentHash,
    expectedMemoryRevision: input.expectedMemoryRevision,
    requestHash: input.requestHash,
  });
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signed = `${HANDLE_PREFIX}.${payload}`;
  return {
    authorization: `${signed}.${signature(signed, input.secret).toString('base64url')}`,
    operationId: input.operationId,
    expiresAt: scope.expiresAt,
  };
}

export type MobileOwnerMemoryCorrectionAuthorizationCheck =
  | { kind: 'invalid' }
  | { kind: 'replay_expired' }
  | { kind: 'principal_mismatch' }
  | { kind: 'owner_mismatch' }
  | { kind: 'target_mismatch' }
  | { kind: 'verified'; claims: MobileOwnerMemoryCorrectionClaims; applyExpired: boolean };

function samePrincipal(
  claim: MobileOwnerMemoryCorrectionPrincipal,
  current: MobileBearerPrincipal,
): boolean {
  return (
    claim.kind === current.kind &&
    (claim.kind !== 'owner_device_bearer' ||
      (current.kind === 'owner_device_bearer' && claim.deviceId === current.deviceId))
  );
}

export function verifyMobileOwnerMemoryCorrectionAuthorization(input: {
  authorization: string;
  secret: string;
  now: number;
  principal: MobileBearerPrincipal;
  ownerId: string;
  memoryId: string;
  operationId: string;
}): MobileOwnerMemoryCorrectionAuthorizationCheck {
  if (!input.secret || input.authorization.length > 8_192) return { kind: 'invalid' };
  const parts = input.authorization.split('.');
  if (
    parts.length !== 3 ||
    parts[0] !== HANDLE_PREFIX ||
    !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? '') ||
    !/^[A-Za-z0-9_-]+$/.test(parts[2] ?? '')
  )
    return { kind: 'invalid' };
  const signed = `${parts[0]}.${parts[1]}`;
  let expected: Buffer;
  try {
    expected = signature(signed, input.secret);
  } catch {
    return { kind: 'invalid' };
  }
  const supplied = Buffer.from(parts[2] ?? '', 'base64url');
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected) ||
    supplied.toString('base64url') !== parts[2]
  )
    return { kind: 'invalid' };

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return { kind: 'invalid' };
  }
  const parsed = claimsSchema.safeParse(decoded);
  if (!parsed.success) return { kind: 'invalid' };
  const claims = parsed.data;
  if (claims.scope.issuedAt > input.now) return { kind: 'invalid' };
  if (input.now >= claims.scope.issuedAt + MOBILE_OWNER_MEMORY_CORRECTION_REPLAY_MS)
    return { kind: 'replay_expired' };
  if (!samePrincipal(claims.principal, input.principal)) return { kind: 'principal_mismatch' };
  if (
    claims.scope.ownerId !== input.ownerId ||
    claims.scope.sessionDigest !== mobileOwnerMemoryPrincipalDigest(input.ownerId, input.principal)
  )
    return { kind: 'owner_mismatch' };
  if (
    claims.scope.targetId !== input.memoryId ||
    claims.scope.operationId !== input.operationId ||
    claims.scope.command !== 'correct_owner_memory'
  )
    return { kind: 'target_mismatch' };
  return {
    kind: 'verified',
    claims,
    applyExpired: input.now >= claims.scope.expiresAt,
  };
}
