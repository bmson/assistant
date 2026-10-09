/**
 * Does an inbound email carry content its sender did not write?
 *
 * Email is the one owner-authenticated channel that routinely relays other
 * people's words: a forwarded thread or a quoted reply puts attacker-controlled
 * text inside a DKIM-verified owner message. That is why an email trigger taints
 * the workflow while the same words typed into the web chat do not.
 *
 * This detects structural evidence, not authorship of unmarked copied prose.
 * A false result says only that recognized relay structure is absent. Callers
 * must retain authentication and authorization checks independently; neither
 * this metadata nor a classification model grants action authority.
 */

import { createHash } from 'node:crypto';

/** Subject prefixes that mark the body as a relay of someone else's message. */
const FORWARD_SUBJECT = /^\s*(?:re\s*:\s*)*(?:fwd?|fw)\s*:/i;

const QUOTE_MARKERS: RegExp[] = [
  /^\s*(?:copied|quoted|forwarded)\s+(?:text|message|content)\s*:/im,
  /^\s*\[quoted(?: or forwarded)? content begins\]/im,
  /^\s*```/m,
  // Gmail/Apple/Outlook forward separators.
  /^\s*-{2,}\s*forwarded message\s*-{2,}/im,
  /^\s*begin forwarded message\s*:/im,
  /^\s*-{2,}\s*original message\s*-{2,}/im,
  // A quoted block: any line beginning with the ">" citation marker.
  /^\s*>/m,
  // Attribution lines that introduce a quote, e.g.
  // "On Sun, Jul 19, 2026 at 21:52 Owner <owner@example.com> wrote:". The date and name
  // may wrap across lines, so match the bracketing tokens rather than a shape.
  /^\s*on\b[\s\S]{0,300}?\bwrote\s*:/im,
  // Common localized mail-client attribution lines. These stay anchored to
  // quote-introduction language so ordinary prose in another language is not
  // treated as a relay merely because it contains a date or a sender name.
  /^\s*(?:le\s+.+\ba\s+écrit|am\s+.+\bschrieb|el\s+.+\bescribió|em\s+.+\bescreveu|il\s+giorno\s+.+\bha\s+scritto|op\s+.+\bschreef)\s*:/im,
  // Outlook's header block reproduced inline.
  /^\s*(?:from|de|von|van|da|fra|från|发件人|差出人)\s*:[^\n]*\n(?:[^\n]*\n){0,4}?\s*(?:sent|date|envoyé|gesendet|verzonden|inviato|fecha|发送时间)\s*:/im,
  // A reproduced RFC header pair is a relayed message even without a separator.
  /^\s*(?:from|de|von|van|da|fra|från|发件人|差出人)\s*:[^\n]*\n(?:[^\n]*\n){0,4}?\s*(?:subject|objet|betreff|onderwerp|oggetto|asunto|主题)\s*:/im,
];

export interface EmailContentSpan {
  /** UTF-16 offsets in the normalized, stored body; never offsets in raw HTML. */
  start: number;
  end: number;
  author: 'sender' | 'external' | 'unknown';
}

export interface EmailContentProvenance {
  version: 1;
  mode: 'direct' | 'forwarded';
  authenticated: boolean;
  sourceLength: number;
  storedLength: number;
  sourceHash: string;
  bodyHash: string;
  messageHash: string;
  prefixLength: number;
  hasExternalOrUnknown: boolean;
  spans: EmailContentSpan[];
  /** MIME topology and quote evidence, without another copy of private content. */
  parts: Array<{
    path: string;
    mimeType: string;
    quoteMarkup: boolean;
    replyHeaders: boolean;
    /** Present only after exact HTML/text alignment at ingress. */
    bodyQuoteStart?: number;
  }>;
}

function emailTextHash(text: string): string {
  return createHash('sha256').update('assistant-email-content-v1\0').update(text).digest('hex');
}

export function emailHtmlHasQuoteMarkup(html: string): boolean {
  return emailHtmlQuoteStart(html) !== null;
}

export function emailHtmlQuoteStart(html: string): number | null {
  return (
    /<blockquote\b|class\s*=\s*["'][^"']*(?:gmail_quote|yahoo_quoted|divrplyfwdmsg|moz-cite-prefix|protonmail_quote)|id\s*=\s*["'](?:divrplyfwdmsg|stopspelling)/i.exec(
      html,
    )?.index ?? null
  );
}

/** Produce content evidence at ingress, before truncation. It grants no authority. */
export function buildEmailContentProvenance(input: {
  subject: string;
  fullBody: string;
  storedBody: string;
  messagePrefix: string;
  authenticated: boolean;
  mode: 'direct' | 'forwarded';
  parts: EmailContentProvenance['parts'];
}): EmailContentProvenance {
  if (!input.fullBody.startsWith(input.storedBody))
    throw new Error('Email provenance body is not a source prefix');
  let firstBoundary = QUOTE_MARKERS.reduce((first, pattern) => {
    const match = pattern.exec(input.fullBody);
    return match ? Math.min(first, match.index) : first;
  }, input.fullBody.length);
  let unmappedHtml = false;
  for (const part of input.parts) {
    if (!part.quoteMarkup) continue;
    const start = part.bodyQuoteStart;
    if (
      typeof start === 'number' &&
      Number.isSafeInteger(start) &&
      start >= 0 &&
      start <= input.fullBody.length
    )
      firstBoundary = Math.min(firstBoundary, start);
    else unmappedHtml = true;
  }
  const structuralRelay =
    FORWARD_SUBJECT.test(input.subject) ||
    input.parts.some((part) => part.quoteMarkup || part.replyHeaders);
  const hasTextBoundary = firstBoundary < input.fullBody.length;
  const senderPrefix = input.fullBody.slice(0, firstBoundary);
  const inlineQuotes = [...senderPrefix.matchAll(/“[^“”]*”|"[^"]*"/g)];
  const unmatchedQuote = /[“”"]/.test(senderPrefix.replace(/“[^“”]*”|"[^"]*"/g, ''));
  // An unmatched HTML alternative cannot establish a fresh prefix merely
  // because it also contains a later plain-text quote marker.
  const unknown =
    !input.authenticated || unmatchedQuote || unmappedHtml || (structuralRelay && !hasTextBoundary);
  const spans: EmailContentSpan[] = [];
  if (input.storedBody.length) {
    if (input.mode === 'forwarded')
      spans.push({ start: 0, end: input.storedBody.length, author: 'external' });
    else if (unknown) spans.push({ start: 0, end: input.storedBody.length, author: 'unknown' });
    else {
      const end = Math.min(firstBoundary, input.storedBody.length);
      let cursor = 0;
      for (const quote of inlineQuotes) {
        const start = Math.min(quote.index, end);
        const quotedEnd = Math.min(quote.index + quote[0].length, end);
        if (cursor < start) spans.push({ start: cursor, end: start, author: 'sender' });
        if (start < quotedEnd) spans.push({ start, end: quotedEnd, author: 'external' });
        cursor = quotedEnd;
        if (cursor >= end) break;
      }
      if (cursor < end) spans.push({ start: cursor, end, author: 'sender' });
      if (end < input.storedBody.length)
        spans.push({ start: end, end: input.storedBody.length, author: 'external' });
    }
  }
  return {
    version: 1,
    mode: input.mode,
    authenticated: input.authenticated,
    sourceLength: input.fullBody.length,
    storedLength: input.storedBody.length,
    sourceHash: emailTextHash(input.fullBody),
    bodyHash: emailTextHash(input.storedBody),
    messageHash: emailTextHash(input.messagePrefix + input.storedBody),
    prefixLength: input.messagePrefix.length,
    hasExternalOrUnknown:
      input.mode === 'forwarded' ||
      unknown ||
      structuralRelay ||
      hasTextBoundary ||
      inlineQuotes.length > 0 ||
      !input.fullBody,
    spans,
    parts: input.parts,
  };
}

/** Reject stale, malformed, overlapping or unbound metadata before using any span. */
export function emailProvenanceText(
  value: unknown,
  text: string,
): { authored: string; external: string; unknown: boolean } | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Partial<EmailContentProvenance>;
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

/**
 * True when the message appears to quote or forward content from someone other
 * than its sender. Callers must treat `true` — and any message they cannot
 * evaluate — as carrying untrusted content.
 */
export function quotesExternalContent(input: {
  subject?: string;
  body?: string;
  /** Raw HTML parts must be inspected before Gmail's text conversion strips quote markup. */
  html?: string[];
  /** Gmail reply metadata is provenance evidence even when copied text has no quote markers. */
  hasReplyHeaders?: boolean;
}): boolean {
  const subject = input.subject ?? '';
  const body = input.body ?? '';
  if (FORWARD_SUBJECT.test(subject)) return true;
  if (input.hasReplyHeaders) return true;
  if ((input.html ?? []).some((html) => emailHtmlHasQuoteMarkup(html))) return true;
  return QUOTE_MARKERS.some((pattern) => pattern.test(body));
}

/**
 * Did this task come from the owner's forwarded-mail pipe?
 *
 * Such a task runs at OWNER trust — the owner's forwarding rule is what asked
 * for the work — but its `from` address is a THIRD PARTY, not the owner. Every
 * path that treats owner trust as "reply to whoever sent this" must therefore
 * check here first, or it will mail the assistant's output to a stranger.
 *
 * This flag is a readable signal, NOT the safety boundary: it is absent on a
 * corrupted payload, and absent reads as "ordinary mail", which is the
 * permissive direction for a caller using it to suppress a send. The actual
 * boundary is `deliverEmailFinal`'s positive check that the recipient is an
 * owner address, plus the outbound domain allowlist. Keep all three.
 */
export function isForwardedIngest(task: { trigger?: unknown } | null | undefined): boolean {
  const payload = (task?.trigger as { payload?: { ingest?: { forwarded?: unknown } } } | null)
    ?.payload;
  return payload?.ingest?.forwarded === true;
}
