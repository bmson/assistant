import type {
  OwnerEditorAtomicAdmission,
  OwnerEditorClaim,
  OwnerEditorOperationRecord,
  OwnerEditorReceiptReply,
  OwnerEditorReply,
  OwnerEditorScope,
} from './owner-editor.js';
import { ownerEditorScopeDigest } from './owner-editor-identity.js';

export function ownerEditorUnknown(
  scope: OwnerEditorScope,
  reason:
    | 'preparing'
    | 'receipt_unavailable'
    | 'proof_changed'
    | 'receipt_missing' = 'receipt_unavailable',
): OwnerEditorReply {
  return {
    version: 1,
    authority: 'unresolved',
    outcome: 'outcome_unknown',
    command: scope.command,
    operationId: scope.operationId,
    reason,
  };
}
export function ownerEditorRetired(scope: OwnerEditorScope): OwnerEditorReply {
  return {
    version: 1,
    authority: 'scope_retirement',
    outcome: 'voided',
    command: scope.command,
    operationId: scope.operationId,
    reason: 'scope_retired',
  };
}
export function ownerEditorRejected(scope: OwnerEditorScope, reason: string): OwnerEditorReply {
  return {
    version: 1,
    authority: 'request_rejection',
    outcome: 'conflict',
    command: scope.command,
    operationId: scope.operationId,
    originalOperationTerminal: false,
    reason,
  };
}
export function ownerEditorReceipt(record: OwnerEditorOperationRecord): OwnerEditorReceiptReply {
  if (record.status === 'preparing' || !record.result)
    throw new Error('Editor operation is not terminal');
  return {
    version: 1,
    authority: 'operation_receipt',
    command: record.command,
    operationId: record.operationId,
    requestHash: record.requestHash,
    statusVersion: record.statusVersion,
    ...record.result,
  };
}
export function ownerEditorRecordMatches(
  scope: OwnerEditorScope,
  record: OwnerEditorOperationRecord,
): boolean {
  return (
    record.ownerId === scope.ownerId &&
    record.epoch === scope.epoch &&
    record.operationId === scope.operationId &&
    record.command === scope.command &&
    record.scopeDigest === ownerEditorScopeDigest(scope)
  );
}
export function ownerEditorAdmitClaim(
  claim: OwnerEditorClaim,
  operation: OwnerEditorOperationRecord | null,
  now: Date,
): OwnerEditorAtomicAdmission {
  const scope = claim.scope;
  if (!operation) return { kind: 'reply', reply: ownerEditorUnknown(scope, 'receipt_missing') };
  if (!ownerEditorRecordMatches(scope, operation) || operation.requestHash !== claim.requestHash)
    return { kind: 'reply', reply: ownerEditorRejected(scope, 'request_binding_mismatch') };
  if (operation.status !== 'preparing')
    return { kind: 'reply', reply: ownerEditorReceipt(operation) };
  if (
    operation.claimToken !== claim.claimToken ||
    operation.statusVersion !== claim.statusVersion ||
    !operation.claimExpiresAt ||
    operation.claimExpiresAt.getTime() <= now.getTime()
  )
    return { kind: 'reply', reply: ownerEditorUnknown(scope, 'proof_changed') };
  return { kind: 'admitted', claim, operation };
}
