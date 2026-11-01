import { createHash } from 'node:crypto';
import type { OwnerEditorClaim, OwnerEditorSavedIds, OwnerEditorScope } from './owner-editor.js';

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const digest = (domain: string, value: unknown) =>
  createHash('sha256').update(domain).update('\n').update(canonical(value)).digest('hex');

export function ownerEditorOperationId(
  scope: Pick<OwnerEditorScope, 'ownerId' | 'epoch' | 'operationId'>,
): string {
  return digest('owner-editor-operation-v1', [scope.ownerId, scope.epoch, scope.operationId]);
}
export function ownerEditorPrivacyDigest(generation: string | null): string {
  return digest('owner-editor-privacy-v1', generation);
}
export function ownerEditorScopeDigest(scope: OwnerEditorScope): string {
  return digest('owner-editor-scope-v1', scope);
}
/** Caller supplies exact PG timestamp text / FS seconds+nanos, never rounded Dates. */
export function ownerEditorSnapshotRevision(snapshot: unknown): string {
  function exact(value: unknown): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
      for (const entry of value) exact(entry);
      return;
    }
    if (
      value &&
      typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ) {
      for (const entry of Object.values(value)) exact(entry);
      return;
    }
    throw new Error(
      'Editor snapshots require explicit exact timestamp text or seconds/nanoseconds, not Dates or missing values.',
    );
  }
  exact(snapshot);
  return digest('owner-editor-snapshot-v1', snapshot);
}
/** Receipt identity proves this committed operation; never use it as entity CAS. */
export function ownerEditorCommitRevision(
  claim: OwnerEditorClaim,
  ids: OwnerEditorSavedIds,
): string {
  return digest('owner-editor-commit-v1', {
    ownerId: claim.scope.ownerId,
    epoch: claim.scope.epoch,
    operationId: claim.scope.operationId,
    requestHash: claim.requestHash,
    ids,
  });
}
