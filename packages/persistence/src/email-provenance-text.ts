import { createHash } from 'node:crypto';
import type { EmailContentProvenanceSnapshot } from './email-sync.js';

export function emailTextHash(text: string): string {
  return createHash('sha256').update('assistant-email-content-v1\0').update(text).digest('hex');
}

/** Reject stale, malformed, overlapping or unbound metadata before using any span. */
export function emailProvenanceText(
  value: unknown,
  text: string,
): { authored: string; external: string; unknown: boolean } | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Partial<EmailContentProvenanceSnapshot>;
  if (
    data.version !== 1 ||
    (data.mode !== 'direct' && data.mode !== 'forwarded') ||
    typeof data.authenticated !== 'boolean' ||
    typeof data.hasExternalOrUnknown !== 'boolean' ||
    !Number.isSafeInteger(data.storedLength) ||
    !Number.isSafeInteger(data.sourceLength) ||
    !Number.isSafeInteger(data.prefixLength) ||
    (data.storedLength ?? -1) < 0 ||
    (data.sourceLength ?? -1) < (data.storedLength ?? 0) ||
    (data.prefixLength ?? -1) < 0 ||
    !Array.isArray(data.spans)
  )
    return null;
  let body: string;
  if (data.bodyHash === emailTextHash(text)) body = text;
  else if (data.messageHash === emailTextHash(text)) body = text.slice(data.prefixLength);
  else return null;
  if (body.length !== data.storedLength) return null;
  let cursor = 0;
  const authored: string[] = [];
  const external: string[] = [];
  let unknown = !data.authenticated || data.mode === 'forwarded' || body.length === 0;
  for (const span of data.spans) {
    if (
      !span ||
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start !== cursor ||
      span.end <= span.start ||
      span.end > body.length ||
      !['sender', 'external', 'unknown'].includes(span.author)
    )
      return null;
    const content = body.slice(span.start, span.end);
    if (span.author === 'sender' && data.authenticated && data.mode === 'direct')
      authored.push(content);
    else external.push(content);
    if (span.author === 'unknown') unknown = true;
    cursor = span.end;
  }
  if (cursor !== body.length) return null;
  if (data.hasExternalOrUnknown === false && (unknown || external.length > 0)) return null;
  return { authored: authored.join('\n').trim(), external: external.join('\n').trim(), unknown };
}

/** Full lines belonging to the authenticated sender, using offsets in the canonical body. */
export function completeSenderLines(
  text: string,
  provenance: EmailContentProvenanceSnapshot,
): string[] {
  if (provenance.storedLength !== provenance.sourceLength) return [];
  const source = emailProvenanceText(provenance, text);
  if (!source || source.unknown) return [];
  const body = text.length === provenance.storedLength ? text : text.slice(provenance.prefixLength);
  return Array.from(body.matchAll(/[^\r\n]+/gu))
    .filter(({ 0: line, index }) =>
      provenance.spans.some(
        ({ author, start, end }) =>
          author === 'sender' && start <= index && end >= index + line.length,
      ),
    )
    .map(([line]) => line.trim());
}
