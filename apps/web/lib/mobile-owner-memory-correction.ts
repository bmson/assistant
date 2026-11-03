import { createHash, randomUUID } from 'node:crypto';
import { readBoundedJson } from '@assistant/application/http-body';
import {
  OWNER_EDITOR_BODY_TIMEOUT_MS,
  OWNER_EDITOR_MAX_BODY_BYTES,
  ownerEditorApplyMatchesScope,
  ownerEditorCanonicalApply,
  parseOwnerEditorRequest,
} from '@assistant/application/owner-editor-wire';
import {
  ownerEditorRejected,
  ownerEditorSnapshotRevision,
  ownerEditorUnknown,
} from '@assistant/persistence';
import type {
  OwnerEditorApply,
  OwnerEditorIssuanceContext,
  OwnerEditorOperationRecord,
  OwnerEditorOperationRepository,
  OwnerEditorReceiptProof,
  OwnerEditorReply,
  OwnerEditorScope,
} from '@assistant/persistence/owner-editor';
import type { OwnerMemoryEditorSnapshot } from '@assistant/persistence/owner-memory-correction';
import { z } from 'zod';
import type { MobileBearerPrincipal, MobileOwnerResolution } from './mobile-auth-types.js';
import {
  issueMobileOwnerMemoryCorrectionAuthorization,
  MOBILE_OWNER_MEMORY_CORRECTION_REPLAY_MS,
  verifyMobileOwnerMemoryCorrectionAuthorization,
} from './mobile-owner-memory-correction-proof.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const STATUS_PROOF_MS = 120_000;
const AUTHORIZATION_HEADER = 'x-owner-memory-correction-authorization';
const MEMORY_EDITOR_PATH = '/api/profile/knowledge/memory';

const authorizeBodySchema = z.strictObject({
  version: z.literal(1),
  intent: z.literal('authorize'),
  expectedContentHash: z.string().regex(HASH),
  expectedMemoryRevision: z.string().regex(HASH),
  content: z
    .string()
    .transform((content) => content.trim())
    .pipe(z.string().min(3).max(4_000)),
});

type AuthorizationState = {
  snapshot: OwnerMemoryEditorSnapshot;
  context: OwnerEditorIssuanceContext | null;
};

export interface MobileOwnerMemoryCorrectionBackend {
  operations: OwnerEditorOperationRepository;
  apply(request: OwnerEditorApply, scope: OwnerEditorScope): Promise<OwnerEditorReply>;
}

export interface MobileOwnerMemoryCorrectionPorts {
  authenticate(request: Request): Promise<MobileBearerPrincipal | null>;
  resolveOwner(principal: MobileBearerPrincipal): Promise<MobileOwnerResolution>;
  readAuthorizationState(ownerId: string, memoryId: string): Promise<AuthorizationState | null>;
  secret(): string;
  now(): number;
  canReconcile(): boolean;
  withBackend<T>(
    scope: OwnerEditorScope,
    run: (backend: MobileOwnerMemoryCorrectionBackend) => Promise<T>,
  ): Promise<T>;
}

function noStoreJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function replyStatus(reply: OwnerEditorReply): number {
  return reply.authority === 'unresolved'
    ? 202
    : reply.authority === 'scope_retirement' || reply.outcome === 'conflict'
      ? 409
      : reply.outcome === 'invalid'
        ? 422
        : reply.outcome === 'unavailable'
          ? 503
          : 200;
}

function replyResponse(reply: OwnerEditorReply): Response {
  return noStoreJson(reply, replyStatus(reply));
}

function requestRejection(
  command: OwnerEditorReply['command'],
  operationId: string | null,
  reason: string,
  outcome: 'invalid' | 'conflict' | 'unavailable' = 'conflict',
): OwnerEditorReply {
  return {
    version: 1,
    authority: 'request_rejection',
    command,
    operationId,
    outcome,
    originalOperationTerminal: false,
    reason,
  };
}

function unknownReply(
  scope: OwnerEditorScope,
  reason:
    | 'preparing'
    | 'receipt_unavailable'
    | 'proof_changed'
    | 'receipt_missing' = 'receipt_unavailable',
): OwnerEditorReply {
  return ownerEditorUnknown(scope, reason);
}

function retiredReply(
  operationId: string,
  reason: 'scope_retired' | 'replay_window_retired',
): OwnerEditorReply {
  return {
    version: 1,
    authority: 'scope_retirement',
    command: 'correct_owner_memory',
    operationId,
    outcome: 'voided',
    reason,
  };
}

function validPathIds(memoryId: string, operationId?: string): boolean {
  return UUID.test(memoryId) && (operationId === undefined || UUID.test(operationId));
}

function applyRequestHash(
  request: Extract<
    import('@assistant/persistence/owner-editor').OwnerEditorApply,
    { command: 'correct_owner_memory' }
  >,
): string {
  return createHash('sha256').update(ownerEditorCanonicalApply(request)).digest('hex');
}

function terminalOrRejectionForExpiredApply(input: {
  scope: OwnerEditorScope;
  operation: OwnerEditorOperationRecord | null;
  lookupReply: OwnerEditorReply;
  signedRequestHash: string;
}): OwnerEditorReply {
  if (input.operation && input.operation.requestHash !== input.signedRequestHash)
    return ownerEditorRejected(input.scope, 'request_binding_mismatch');
  if (input.operation) return input.lookupReply;
  if (input.lookupReply.authority === 'scope_retirement') return input.lookupReply;
  if (
    input.lookupReply.authority === 'unresolved' &&
    input.lookupReply.reason !== 'receipt_missing'
  )
    return input.lookupReply;
  if (input.lookupReply.authority === 'request_rejection') return input.lookupReply;
  return requestRejection(input.scope.command, input.scope.operationId, 'authorization_expired');
}

function internalReceiptProof(
  scope: OwnerEditorScope,
  operation: OwnerEditorOperationRecord,
  issuedAt: number,
): OwnerEditorReceiptProof | null {
  if (operation.status !== 'preparing' || !operation.claimToken || !operation.claimExpiresAt)
    return null;
  const expiresAt = Math.min(
    issuedAt + STATUS_PROOF_MS,
    scope.issuedAt + MOBILE_OWNER_MEMORY_CORRECTION_REPLAY_MS,
  );
  if (expiresAt <= issuedAt) return null;
  return {
    scope,
    requestHash: operation.requestHash,
    claimIdentityDigest: ownerEditorSnapshotRevision({
      token: operation.claimToken,
      expiresAt: operation.claimExpiresAt.toISOString(),
    }),
    statusVersion: operation.statusVersion,
    issuedAt,
    expiresAt,
  };
}

async function authenticate(
  request: Request,
  ports: MobileOwnerMemoryCorrectionPorts,
): Promise<
  | { ok: true; principal: MobileBearerPrincipal; ownerId: string }
  | { ok: false; response: Response }
> {
  let principal: MobileBearerPrincipal | null;
  try {
    principal = await ports.authenticate(request);
  } catch {
    return { ok: false, response: noStoreJson({ code: 'memory_unavailable' }, 503) };
  }
  if (!principal)
    return {
      ok: false,
      response: Response.json(
        { error: 'unauthorized' },
        {
          status: 401,
          headers: {
            'cache-control': 'no-store',
            'www-authenticate': 'Bearer realm="Assistant iOS"',
          },
        },
      ),
    };
  try {
    const owner = await ports.resolveOwner(principal);
    return owner.ok
      ? { ok: true, principal, ownerId: owner.ownerId }
      : { ok: false, response: noStoreJson({ code: 'memory_unavailable' }, 503) };
  } catch {
    return { ok: false, response: noStoreJson({ code: 'memory_unavailable' }, 503) };
  }
}

function noQuery(request: Request): boolean {
  return new URL(request.url).search === '';
}

function readOnlyCorrection(): Response {
  return noStoreJson({ error: 'This saved note cannot be corrected right now.' }, 409);
}

export function createMobileOwnerMemoryCorrectionHandlers(ports: MobileOwnerMemoryCorrectionPorts) {
  return {
    async authorize(request: Request, memoryId: string): Promise<Response> {
      if (request.method !== 'POST') return noStoreJson({ error: 'method_not_allowed' }, 405);
      const expectedPath = `/api/mobile/v1/memory/${memoryId}/correction/authorize`;
      if (new URL(request.url).pathname !== expectedPath)
        return noStoreJson({ error: 'not_found' }, 404);
      if (!noQuery(request)) return noStoreJson({ error: 'unexpected_query' }, 400);
      if (!validPathIds(memoryId)) return noStoreJson({ error: 'invalid_memory_id' }, 400);

      const identity = await authenticate(request, ports);
      if (!identity.ok) return identity.response;
      const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') return noStoreJson({ error: 'json_required' }, 415);
      const body = await readBoundedJson(
        request,
        OWNER_EDITOR_MAX_BODY_BYTES,
        OWNER_EDITOR_BODY_TIMEOUT_MS,
      );
      if (!body.ok) return noStoreJson({ error: body.error }, body.status);
      const parsed = authorizeBodySchema.safeParse(body.value);
      if (!parsed.success) return noStoreJson({ error: 'invalid_authorization_request' }, 422);

      const secret = ports.secret();
      if (!secret) return noStoreJson({ code: 'memory_unavailable' }, 503);
      let current: AuthorizationState | null;
      try {
        current = await ports.readAuthorizationState(identity.ownerId, memoryId);
      } catch {
        return noStoreJson({ code: 'memory_unavailable' }, 503);
      }
      if (!current) return noStoreJson({ error: 'not_found' }, 404);
      const { snapshot, context } = current;
      if (
        !context ||
        context.ownerId !== identity.ownerId ||
        snapshot.ownerId !== identity.ownerId ||
        snapshot.memoryId !== memoryId ||
        !snapshot.eligible
      )
        return readOnlyCorrection();
      if (
        snapshot.contentHash !== parsed.data.expectedContentHash ||
        snapshot.revision !== parsed.data.expectedMemoryRevision
      )
        return noStoreJson({ error: 'snapshot_changed' }, 409);

      const operationId = randomUUID();
      const applyRequest = {
        version: 1 as const,
        intent: 'apply' as const,
        operationId,
        command: 'correct_owner_memory' as const,
        memoryId,
        expectedContentHash: parsed.data.expectedContentHash,
        expectedMemoryRevision: parsed.data.expectedMemoryRevision,
        content: parsed.data.content,
      };
      const requestHash = applyRequestHash(applyRequest);
      try {
        const authorized = issueMobileOwnerMemoryCorrectionAuthorization({
          principal: identity.principal,
          ownerId: identity.ownerId,
          epoch: context.epoch,
          privacyGeneration: context.privacyGeneration,
          memoryId,
          operationId,
          expectedContentHash: parsed.data.expectedContentHash,
          expectedMemoryRevision: parsed.data.expectedMemoryRevision,
          requestHash,
          secret,
          now: ports.now(),
        });
        return noStoreJson({
          version: 1,
          intent: 'authorized',
          command: 'correct_owner_memory',
          memoryId,
          operationId: authorized.operationId,
          authorization: authorized.authorization,
          expiresAt: new Date(authorized.expiresAt).toISOString(),
        });
      } catch {
        return noStoreJson({ code: 'memory_unavailable' }, 503);
      }
    },

    async apply(request: Request, memoryId: string, operationId: string): Promise<Response> {
      if (request.method !== 'POST') return noStoreJson({ error: 'method_not_allowed' }, 405);
      const expectedPath = `/api/mobile/v1/memory/${memoryId}/correction/${operationId}/apply`;
      if (new URL(request.url).pathname !== expectedPath)
        return noStoreJson({ error: 'not_found' }, 404);
      if (!noQuery(request)) return noStoreJson({ error: 'unexpected_query' }, 400);
      if (!validPathIds(memoryId, operationId))
        return noStoreJson({ error: 'invalid_memory_id' }, 400);

      const identity = await authenticate(request, ports);
      if (!identity.ok) return identity.response;
      const secret = ports.secret();
      if (!secret) return noStoreJson({ code: 'memory_unavailable' }, 503);
      const token = request.headers.get(AUTHORIZATION_HEADER) ?? '';
      const checked = verifyMobileOwnerMemoryCorrectionAuthorization({
        authorization: token,
        secret,
        now: ports.now(),
        principal: identity.principal,
        ownerId: identity.ownerId,
        memoryId,
        operationId,
      });
      if (checked.kind === 'invalid') return noStoreJson({ error: 'invalid_authorization' }, 403);
      if (checked.kind === 'replay_expired')
        return replyResponse(retiredReply(operationId, 'replay_window_retired'));
      if (checked.kind === 'owner_mismatch') return noStoreJson({ error: 'not_found' }, 404);
      if (checked.kind === 'principal_mismatch')
        return noStoreJson({ error: 'principal_mismatch' }, 403);
      if (checked.kind === 'target_mismatch')
        return noStoreJson({ error: 'authorization_mismatch' }, 409);

      const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') return noStoreJson({ error: 'json_required' }, 415);
      const body = await readBoundedJson(
        request,
        OWNER_EDITOR_MAX_BODY_BYTES,
        OWNER_EDITOR_BODY_TIMEOUT_MS,
      );
      if (!body.ok) return noStoreJson({ error: body.error }, body.status);
      const parsed = parseOwnerEditorRequest(body.value, MEMORY_EDITOR_PATH);
      if (
        !parsed.ok ||
        parsed.request.intent !== 'apply' ||
        parsed.request.command !== 'correct_owner_memory'
      )
        return noStoreJson({ error: 'invalid_apply_request' }, 422);
      const applyRequest = parsed.request;
      const { claims, applyExpired } = checked;
      const actualHash = applyRequestHash(applyRequest);
      if (
        applyRequest.memoryId !== memoryId ||
        applyRequest.operationId !== operationId ||
        applyRequest.expectedContentHash !== claims.expectedContentHash ||
        applyRequest.expectedMemoryRevision !== claims.expectedMemoryRevision ||
        actualHash !== claims.requestHash ||
        !ownerEditorApplyMatchesScope(applyRequest, claims.scope)
      )
        return replyResponse(
          requestRejection('correct_owner_memory', operationId, 'request_binding_mismatch'),
        );

      try {
        return await ports
          .withBackend(claims.scope, async (backend) => {
            if (applyExpired) {
              const lookup = await backend.operations.lookup(claims.scope, new Date(ports.now()));
              return terminalOrRejectionForExpiredApply({
                scope: claims.scope,
                operation: lookup.operation,
                lookupReply: lookup.reply,
                signedRequestHash: claims.requestHash,
              });
            }
            return backend.apply(applyRequest, claims.scope);
          })
          .then(replyResponse);
      } catch {
        return replyResponse(unknownReply(claims.scope));
      }
    },

    async status(request: Request, memoryId: string, operationId: string): Promise<Response> {
      if (request.method !== 'GET') return noStoreJson({ error: 'method_not_allowed' }, 405);
      const expectedPath = `/api/mobile/v1/memory/${memoryId}/correction/${operationId}/status`;
      if (new URL(request.url).pathname !== expectedPath)
        return noStoreJson({ error: 'not_found' }, 404);
      if (!noQuery(request)) return noStoreJson({ error: 'unexpected_query' }, 400);
      if (!validPathIds(memoryId, operationId))
        return noStoreJson({ error: 'invalid_memory_id' }, 400);

      const identity = await authenticate(request, ports);
      if (!identity.ok) return identity.response;
      const secret = ports.secret();
      if (!secret) return noStoreJson({ code: 'memory_unavailable' }, 503);
      const checked = verifyMobileOwnerMemoryCorrectionAuthorization({
        authorization: request.headers.get(AUTHORIZATION_HEADER) ?? '',
        secret,
        now: ports.now(),
        principal: identity.principal,
        ownerId: identity.ownerId,
        memoryId,
        operationId,
      });
      if (checked.kind === 'invalid') return noStoreJson({ error: 'invalid_authorization' }, 403);
      if (checked.kind === 'replay_expired')
        return replyResponse(retiredReply(operationId, 'replay_window_retired'));
      if (checked.kind === 'owner_mismatch') return noStoreJson({ error: 'not_found' }, 404);
      if (checked.kind === 'principal_mismatch')
        return noStoreJson({ error: 'principal_mismatch' }, 403);
      if (checked.kind === 'target_mismatch')
        return noStoreJson({ error: 'authorization_mismatch' }, 409);

      try {
        const result = await ports.withBackend(checked.claims.scope, async (backend) => {
          const lookup = await backend.operations.lookup(
            checked.claims.scope,
            new Date(ports.now()),
          );
          const operation = lookup.operation;
          if (!operation) return lookup.reply;
          if (operation.requestHash !== checked.claims.requestHash)
            return ownerEditorRejected(checked.claims.scope, 'request_binding_mismatch');
          if (operation.status !== 'preparing') return lookup.reply;
          const issuedAt = ports.now();
          if (!operation.claimExpiresAt || operation.claimExpiresAt.getTime() > issuedAt)
            return lookup.reply;
          if (!ports.canReconcile()) return lookup.reply;
          const proof = internalReceiptProof(checked.claims.scope, operation, issuedAt);
          if (!proof) return unknownReply(checked.claims.scope, 'proof_changed');
          return backend.operations.reconcile(proof, new Date(issuedAt));
        });
        return replyResponse(result);
      } catch {
        return replyResponse(unknownReply(checked.claims.scope));
      }
    },
  };
}
