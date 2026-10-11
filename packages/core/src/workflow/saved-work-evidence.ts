import type { ActionEvidence } from './response-contract.js';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** A write receipt, not merely a successfully executed function. */
export function isDurableSave(item: ActionEvidence): boolean {
  if (item.status !== 'succeeded' || item.fromCurrentTask === false) return false;
  const result = object(item.result);
  if (result.quarantined === true || result.tombstoned === true || result.ok === false)
    return false;
  return item.toolName === 'memory.save'
    ? result.saved === true
    : item.toolName === 'occasions.save' && (result.saved === true || result.updated === true);
}
