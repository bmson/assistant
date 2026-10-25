import type {
  OwnerEditorApply,
  OwnerEditorClaim,
  OwnerEditorOperationRepository,
  OwnerEditorReply,
  OwnerEditorReservation,
  OwnerEditorScope,
  OwnerEditorTerminalResult,
} from '@assistant/persistence';
import { ownerEditorRequestHash } from './owner-editor-hash.js';
import { ownerEditorApplyMatchesScope } from './owner-editor-wire.js';

type PreparationRejection = Extract<
  OwnerEditorTerminalResult,
  { outcome: 'invalid' | 'conflict' | 'unavailable' }
>;

export interface OwnerEditorDomainPort<Prepared> {
  /** Recheck endpoints/eligibility before embedding. No transaction survives this call. */
  prepare(
    request: OwnerEditorApply,
    scope: OwnerEditorScope,
  ): Promise<{ ok: true; prepared: Prepared } | { ok: false; result: PreparationRejection }>;
  /** Claim checks, domain writes and receipt are ONE driver transaction. */
  commit(claim: OwnerEditorClaim, prepared: Prepared, now: Date): Promise<OwnerEditorReply>;
}

function unresolved(scope: OwnerEditorScope): OwnerEditorReply {
  return {
    version: 1,
    authority: 'unresolved',
    outcome: 'outcome_unknown',
    operationId: scope.operationId,
    command: scope.command,
    reason: 'receipt_unavailable',
  };
}

/** Reservation is durable before preparation, and a failed response is never guessed failed-save. */
export async function applyOwnerEditorCommand<Prepared>(input: {
  request: OwnerEditorApply;
  scope: OwnerEditorScope;
  operations: OwnerEditorOperationRepository;
  domain: OwnerEditorDomainPort<Prepared>;
  now?: () => Date;
}): Promise<OwnerEditorReply> {
  const { request, scope, operations, domain } = input;
  const now = input.now ?? (() => new Date());
  if (!ownerEditorApplyMatchesScope(request, scope))
    return {
      version: 1,
      authority: 'request_rejection',
      outcome: 'conflict',
      originalOperationTerminal: false,
      operationId: request.operationId,
      command: request.command,
      reason: 'issuance_mismatch',
    };
  let reservation: OwnerEditorReservation;
  try {
    reservation = await operations.reserve(scope, ownerEditorRequestHash(request), now());
  } catch {
    return unresolved(scope);
  }
  if (reservation.kind === 'reply') return reservation.reply;
  const claim = reservation.claim;
  let prepared: Awaited<ReturnType<OwnerEditorDomainPort<Prepared>['prepare']>>;
  try {
    prepared = await domain.prepare(request, scope);
  } catch {
    prepared = { ok: false, result: { outcome: 'unavailable', reason: 'preparation_failed' } };
  }
  if (!prepared.ok) {
    try {
      return await operations.failPreparation(claim, prepared.result, now());
    } catch {
      return unresolved(scope);
    }
  }
  try {
    return await domain.commit(claim, prepared.prepared, now());
  } catch {
    // The primary transaction might have committed before the response failed.
    // Only receipt lookup/reconciliation may establish its actual outcome.
    return unresolved(scope);
  }
}
