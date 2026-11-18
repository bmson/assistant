import { createHash } from 'node:crypto';

/** Stable UUID for one original operation's one quote revision. */
export function estimatedCostCardMessageId(
  operationId: string,
  quoteId: string,
  quoteVersion: string,
): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(['estimated-cost-card-v1', operationId, quoteId, quoteVersion]))
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
