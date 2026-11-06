import {
  type OwnerEditorExpiredClaimExpectation,
  type OwnerEditorOperationRecord,
  type OwnerEditorRecoveryTransaction,
  type OwnerEditorReply,
  type OwnerEditorScope,
  type OwnerEditorSessionView,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorReceipt,
  ownerEditorRetired,
  ownerEditorScopeDigest,
  ownerEditorUnknown,
  parseOwnerEditorOperationRecord,
} from '@assistant/persistence';
import { z } from 'zod';
import { readBoundedJson } from './bounded-json';
import {
  issueOwnerEditorRecoveryProof,
  type OwnerEditorRecoveryCurrentState,
  type OwnerEditorRecoveryPostAuthorization,
  verifyOwnerEditorRecoveryProof,
  verifyOwnerEditorRecoveryReceiptProof,
} from './owner-editor-recovery-proof';
import { verifyOwnerEditorHandle } from './owner-editor-scope';

const BASE_PATH = '/api/owner-editor/recovery/v2';
const MAX_BODY_BYTES = 12_000;
const BODY_TIMEOUT_MS = 4_000;
const REPLAY_WINDOW_MS = 24 * 60 * 60_000;
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const currentSchema = z.strictObject({
  ownerId: uuid,
  epoch: uuid,
  privacyGeneration: z.string().max(2048).nullable(),
  ready: z.boolean(),
});
const maintenanceSchema = z.strictObject({
  driver: z.enum(['firestore', 'postgres']),
  releaseWritesPaused: z.boolean(),
  restoreRehearsal: z.boolean(),
  postgresSourceWritesFenced: z.boolean(),
});
const authorizeBody = z.strictObject({
  version: z.literal(2),
  intent: z.literal('authorize_original_reconcile'),
});
const reconcileBody = z.strictObject({
  version: z.literal(2),
  intent: z.literal('reconcile_original'),
  authorization: z.string().min(1).max(8_192),
});
const postBody = z.union([authorizeBody, reconcileBody]);
const recognizedCommands = [
  'create_person',
  'update_person_identity',
  'add_family_relationship',
  'correct_owner_family_relationship',
  'correct_owner_memory',
  'remove_owner_memory',
  'create_owner_memory',
] as const;

export type {
  OwnerEditorExpiredClaimExpectation,
  OwnerEditorRecoveryFreshSnapshot,
  OwnerEditorRecoveryMaintenanceState,
  OwnerEditorRecoveryTransaction,
} from '@assistant/persistence';

export interface OwnerEditorRecoveryServicePorts {
  /** Must authenticate the owner from this actual Request and current session. */
  authenticate(request: Request): Promise<OwnerEditorSessionView | null>;
  /** Runtime-only maintenance read, performed before owner/handle processing. */
  readMaintenance(): Promise<unknown>;
  origin: string;
  secret: string;
  now?: () => number;
  withRecoveryTransaction<T>(
    scope: OwnerEditorScope,
    run: (transaction: OwnerEditorRecoveryTransaction) => Promise<T>,
  ): Promise<T>;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function reply(value: OwnerEditorReply): Response {
  const status =
    value.authority === 'unresolved'
      ? 202
      : value.authority === 'scope_retirement' || value.outcome === 'conflict'
        ? 409
        : value.outcome === 'invalid'
          ? 422
          : value.outcome === 'unavailable'
            ? 503
            : 200;
  return json(value, status);
}

function unavailable(): Response {
  return json({ error: 'Recovery is temporarily unavailable.' }, 503);
}

function exactRecord(value: unknown, scope: OwnerEditorScope): OwnerEditorOperationRecord | null {
  if (!recognizedCommands.includes(scope.command as (typeof recognizedCommands)[number]))
    return null;
  let record: OwnerEditorOperationRecord;
  try {
    record = parseOwnerEditorOperationRecord(value);
  } catch {
    return null;
  }
  return record.id === ownerEditorOperationId(scope) &&
    record.ownerId === scope.ownerId &&
    record.epoch === scope.epoch &&
    record.privacyGenerationDigest === ownerEditorPrivacyDigest(scope.privacyGeneration) &&
    record.operationId === scope.operationId &&
    record.command === scope.command &&
    record.scopeDigest === ownerEditorScopeDigest(scope) &&
    record.protocolVersion === 1 &&
    record.formIssuedAt.getTime() === scope.issuedAt &&
    record.formExpiresAt.getTime() === scope.expiresAt
    ? record
    : null;
}

function currentScopeState(
  scope: OwnerEditorScope,
  current: OwnerEditorRecoveryCurrentState,
): 'same' | 'owner_changed' | 'retired' {
  if (current.ownerId !== scope.ownerId) return 'owner_changed';
  if (current.epoch !== scope.epoch || current.privacyGeneration !== scope.privacyGeneration)
    return 'retired';
  return 'same';
}

function terminalReceipt(value: unknown, scope: OwnerEditorScope): OwnerEditorReply | null {
  const record = exactRecord(value, scope);
  return record && record.status !== 'preparing' && record.result
    ? ownerEditorReceipt(record)
    : null;
}

function recoveryAuthorization(
  intent: OwnerEditorRecoveryPostAuthorization['intent'],
  session: OwnerEditorSessionView,
  scope: OwnerEditorScope,
): OwnerEditorRecoveryPostAuthorization {
  return {
    method: 'POST',
    intent,
    sameOrigin: true,
    originalFormHandleVerified: true,
    session,
    command: scope.command,
    operationId: scope.operationId,
  };
}

function formHandle(request: Request): string | null {
  return request.headers.get('x-editor-form-scope');
}

function pastReplayDeadline(scope: OwnerEditorScope, now: number): boolean {
  return now >= scope.issuedAt + REPLAY_WINDOW_MS;
}

function currentTime(ports: OwnerEditorRecoveryServicePorts): number | null {
  const value = (ports.now ?? Date.now)();
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

interface RecoveryProofCandidate {
  kind: 'proof_candidate';
  authorization: OwnerEditorRecoveryPostAuthorization;
  scope: OwnerEditorScope;
  operation: OwnerEditorOperationRecord;
  current: OwnerEditorRecoveryCurrentState;
}

/**
 * Unmounted, HTTP-neutral V2 recovery handler. GET performs receipt lookup only;
 * POST uses the exact V2 authorize/reconcile intents and cannot admit new work.
 */
export async function handleOwnerEditorRecoveryRequest(
  request: Request,
  ports: OwnerEditorRecoveryServicePorts,
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const isGet = method === 'GET';
  if (url.search) return json({ error: 'Unexpected query parameters.' }, 400);
  const expectedPath = isGet
    ? `${BASE_PATH}/receipt`
    : url.pathname === `${BASE_PATH}/authorize`
      ? `${BASE_PATH}/authorize`
      : `${BASE_PATH}/reconcile`;
  if (!isGet && method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (url.pathname !== expectedPath) return json({ error: 'Not found.' }, 404);
  if (request.headers.get('x-owner-editor-protocol') !== '2')
    return json({ error: 'Unsupported recovery protocol.' }, 400);
  let preflightMaintenance: z.infer<typeof maintenanceSchema>;
  try {
    const checkedMaintenance = maintenanceSchema.safeParse(await ports.readMaintenance());
    if (!checkedMaintenance.success) return unavailable();
    preflightMaintenance = checkedMaintenance.data;
  } catch {
    return unavailable();
  }
  if (
    preflightMaintenance.releaseWritesPaused ||
    preflightMaintenance.restoreRehearsal ||
    (!isGet &&
      preflightMaintenance.driver === 'postgres' &&
      preflightMaintenance.postgresSourceWritesFenced)
  )
    return unavailable();
  if (!isGet) {
    let expectedOrigin: string;
    try {
      expectedOrigin = new URL(ports.origin).origin;
      if (!['http:', 'https:'].includes(new URL(expectedOrigin).protocol)) return unavailable();
    } catch {
      return unavailable();
    }
    if (request.headers.get('origin') !== expectedOrigin)
      return json({ error: 'Origin mismatch.' }, 403);
    if (
      request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      return json({ error: 'JSON body required.' }, 415);
  }

  let session: OwnerEditorSessionView | null;
  try {
    session = await ports.authenticate(request);
  } catch {
    session = null;
  }
  if (!session || typeof session.ownerId !== 'string')
    return json({ error: 'Owner required.' }, 401);
  if (
    request.headers.get('x-editor-session-scope') !== session.formSessionScope ||
    request.headers.get('x-owner-editor-protocol') !== '2'
  )
    return json({ error: 'Session or protocol mismatch.' }, 403);
  if (!ports.secret) return unavailable();
  const token = formHandle(request);
  if (!token) return json({ error: 'Original form scope required.' }, 403);
  const now = currentTime(ports);
  if (now === null) return unavailable();
  const checked = verifyOwnerEditorHandle({ token, session, secret: ports.secret, now });
  if (checked.kind === 'invalid') return json({ error: 'Original form scope is invalid.' }, 403);
  if (checked.kind === 'retired') return reply(ownerEditorRetired(checked.scope));
  const scope = checked.scope;
  if (!recognizedCommands.includes(scope.command as (typeof recognizedCommands)[number]))
    return json({ error: 'Command is unavailable.' }, 403);

  let body: z.infer<typeof postBody> | null = null;
  if (!isGet) {
    const bounded = await readBoundedJson(request, MAX_BODY_BYTES, BODY_TIMEOUT_MS);
    if (!bounded.ok) return json({ error: 'Recovery request body is invalid.' }, bounded.status);
    const parsed = postBody.safeParse(bounded.value);
    if (!parsed.success) return json({ error: 'Recovery intent is invalid.' }, 422);
    body = parsed.data;
    if (
      (url.pathname.endsWith('/authorize') && body.intent !== 'authorize_original_reconcile') ||
      (url.pathname.endsWith('/reconcile') && body.intent !== 'reconcile_original')
    )
      return json({ error: 'Recovery intent does not match this endpoint.' }, 422);
  }

  try {
    const result = await ports.withRecoveryTransaction<Response | RecoveryProofCandidate>(
      scope,
      async (transaction) => {
        const fresh = await transaction.readFresh();
        const current = currentSchema.safeParse(fresh?.current);
        const maintenance = maintenanceSchema.safeParse(fresh?.maintenance);
        if (!fresh || !current.success || !maintenance.success) return unavailable();
        if (
          maintenance.data.releaseWritesPaused ||
          maintenance.data.restoreRehearsal ||
          (!isGet &&
            maintenance.data.driver === 'postgres' &&
            maintenance.data.postgresSourceWritesFenced)
        )
          return unavailable();
        const scopeState = currentScopeState(scope, current.data);
        if (scopeState === 'owner_changed')
          return reply(ownerEditorUnknown(scope, 'proof_changed'));
        if (scopeState === 'retired') return reply(ownerEditorRetired(scope));
        const record = exactRecord(fresh.operation, scope);
        if (!record) return reply(ownerEditorUnknown(scope, 'receipt_missing'));
        const transactionNow = currentTime(ports);
        if (transactionNow === null) return unavailable();
        if (pastReplayDeadline(scope, transactionNow)) return reply(ownerEditorRetired(scope));

        if (isGet) {
          const receipt = terminalReceipt(record, scope);
          if (receipt) return reply(receipt);
          return reply(ownerEditorUnknown(scope, 'preparing'));
        }

        const action = body;
        if (!action) return json({ error: 'Recovery intent is invalid.' }, 422);
        if (action.intent === 'authorize_original_reconcile') {
          const receipt = terminalReceipt(record, scope);
          if (receipt) return reply(receipt);
          if (!current.data.ready || record.status !== 'preparing')
            return reply(ownerEditorUnknown(scope, 'preparing'));
          const authorization = recoveryAuthorization(action.intent, session, scope);
          // Return data only; Firestore may replay this callback. Mint once only
          // after the enclosing storage transaction has resolved successfully.
          return {
            kind: 'proof_candidate',
            authorization,
            scope,
            operation: record,
            current: current.data,
          };
        }

        const authorization = recoveryAuthorization(action.intent, session, scope);
        if (record.status !== 'preparing') {
          const receiptProof = verifyOwnerEditorRecoveryReceiptProof({
            authorization,
            scope,
            operation: record,
            current: current.data,
            secret: ports.secret,
            now: transactionNow,
            token: action.authorization,
          });
          const receipt = receiptProof ? terminalReceipt(record, scope) : null;
          return receipt ? reply(receipt) : reply(ownerEditorUnknown(scope, 'proof_changed'));
        }
        if (!current.data.ready) return reply(ownerEditorUnknown(scope, 'preparing'));
        const proof = verifyOwnerEditorRecoveryProof({
          authorization,
          scope,
          operation: record,
          current: current.data,
          secret: ports.secret,
          now: transactionNow,
          token: action.authorization,
        });
        if (!proof || !record.claimToken || !record.claimExpiresAt)
          return reply(ownerEditorUnknown(scope, 'proof_changed'));
        const expected: OwnerEditorExpiredClaimExpectation = {
          scope,
          session,
          requestHash: record.requestHash,
          claimToken: record.claimToken,
          claimExpiresAt: new Date(record.claimExpiresAt.getTime()),
          statusVersion: record.statusVersion,
          now: new Date(transactionNow),
          proofExpiresAt: new Date(proof.expiresAt),
          replayExpiresAt: new Date(scope.issuedAt + REPLAY_WINDOW_MS),
          maintenance: maintenance.data,
        };
        const latest = await transaction.abandonExpiredOriginal(expected);
        const latestRecord = exactRecord(latest, scope);
        if (!latestRecord || latestRecord.requestHash !== expected.requestHash)
          return reply(ownerEditorUnknown(scope, 'proof_changed'));
        if (
          latestRecord.status === 'abandoned' &&
          latestRecord.statusVersion > expected.statusVersion &&
          latestRecord.result?.outcome === 'not_applied' &&
          latestRecord.result.reason === 'claim_abandoned'
        )
          return reply(ownerEditorReceipt(latestRecord));
        const resultNow = currentTime(ports);
        if (resultNow === null) return unavailable();
        const racedReceiptProof = verifyOwnerEditorRecoveryReceiptProof({
          authorization,
          scope,
          operation: latestRecord,
          current: current.data,
          secret: ports.secret,
          now: resultNow,
          token: action.authorization,
        });
        const racedReceipt = racedReceiptProof ? terminalReceipt(latestRecord, scope) : null;
        return racedReceipt
          ? reply(racedReceipt)
          : reply(ownerEditorUnknown(scope, 'proof_changed'));
      },
    );
    if (result instanceof Response) return result;
    const maintenance = maintenanceSchema.safeParse(await ports.readMaintenance());
    if (
      !maintenance.success ||
      maintenance.data.releaseWritesPaused ||
      maintenance.data.restoreRehearsal ||
      (maintenance.data.driver === 'postgres' && maintenance.data.postgresSourceWritesFenced)
    )
      return unavailable();
    const currentSession = await ports.authenticate(request);
    if (
      !currentSession ||
      currentSession.ownerId !== session.ownerId ||
      currentSession.formSessionScope !== session.formSessionScope
    )
      return reply(ownerEditorUnknown(scope, 'proof_changed'));
    const postTransactionNow = currentTime(ports);
    if (postTransactionNow === null) return unavailable();
    if (pastReplayDeadline(scope, postTransactionNow)) return reply(ownerEditorRetired(scope));
    const recoveryToken = issueOwnerEditorRecoveryProof({
      ...result,
      secret: ports.secret,
      now: postTransactionNow,
    });
    return recoveryToken
      ? json({ version: 2, intent: 'recovery_authorized', authorization: recoveryToken })
      : reply(ownerEditorUnknown(scope, 'proof_changed'));
  } catch {
    return reply(ownerEditorUnknown(scope));
  }
}
