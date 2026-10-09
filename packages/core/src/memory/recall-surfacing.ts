import { createHash } from 'node:crypto';

/** Stable, content-free source identity used by owner recall controls. */
export function recallSurfaceKey(kind: string, sourceIds: readonly string[]): string {
  const ids = [...new Set(sourceIds)].sort();
  if (!kind || ids.length === 0 || ids.some((id) => !id))
    throw new Error('Recall surface identity requires a kind and source IDs');
  return createHash('sha256')
    .update(JSON.stringify([kind, ids]))
    .digest('hex');
}

/** Digest only: revisions are compared without retaining source text in the ledger. */
export function recallSourceRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
