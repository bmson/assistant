import { createHash } from 'node:crypto';

/**
 * Stable source identity for Gmail search receipts. Receipt IDs are capped at
 * 256 characters, so longer queries use a digest while the full query remains
 * in the tool result and continuation input.
 */
export function gmailSearchReceiptSourceId(query: string): string {
  if (query.length <= 256) return query;
  return `query-sha256:${createHash('sha256').update(query).digest('hex')}`;
}
