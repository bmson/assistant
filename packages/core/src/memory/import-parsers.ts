import PostalMime, { type Address, addressParser, type Email } from 'postal-mime';

/** Archive units retain provenance rather than relying on their window position. */
export interface ImportUnit {
  /** Message observation timestamp. It is not a claim's validity start date. */
  date: Date | null;
  /** Decoded RFC From display value (never used as an owner identity). */
  header: string;
  /** Complete decoded content, including explicitly delimited quote spans. */
  text: string;
  /** Exact zero-based source character offset; MIME body offsets are message-level. */
  sourceOffset: number;
  /** Parsed RFC mailbox address, when the format contains one. */
  authorEmail: string | null;
  /** Whether quote/forward content was detected and retained with boundaries. */
  hasQuotedContent: boolean;
  /** Offset of a chunk within a long decoded message, when split. */
  unitOffset: number;
}

export type ImportKind = 'mbox' | 'json' | 'text';

export interface ImportParseDiagnostics {
  format: ImportKind;
  supported: string[];
  acceptedUnits: number;
  rejectedUnits: number;
  partial: boolean;
  issues: Array<{ offset: number; code: string; message: string }>;
}

export interface ImportParseResult {
  units: ImportUnit[];
  diagnostics: ImportParseDiagnostics;
}

const UNIT_CHAR_CAP = 2000;
const MIME_MESSAGE_LIMIT = 25 * 1024 * 1024;

export function detectKind(filename: string, content: string): ImportKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.mbox') || /^From \S+@\S+ .*\d{4}/.test(content.slice(0, 200))) return 'mbox';
  if (lower.endsWith('.json')) return 'json';
  try {
    const head = content.slice(0, 5).trimStart();
    if (head.startsWith('[') || head.startsWith('{')) {
      JSON.parse(content);
      return 'json';
    }
  } catch {
    // A malformed JSON-looking file is still classified as JSON by extension.
  }
  return 'text';
}

function parseDate(value: string | number | undefined | null): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    const date = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function mailboxes(
  address: Address | Address[] | undefined,
): Array<{ name: string; address: string }> {
  if (!address) return [];
  const list = Array.isArray(address) ? address : [address];
  return list.flatMap((entry) =>
    'group' in entry
      ? (entry.group ?? []).map((mailbox) => ({ name: mailbox.name, address: mailbox.address }))
      : entry.address
        ? [{ name: entry.name, address: entry.address }]
        : [],
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}

function htmlTextPreservingQuotes(html: string): string {
  return decodeEntities(
    html
      .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(
        /<(blockquote)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi,
        '\n\n[Quoted content begins]\n$2\n[Quoted content ends]\n\n',
      )
      .replace(
        /<(div|section)\b[^>]*(?:gmail_quote|yahoo_quoted|divrplyfwdmsg|moz-cite-prefix|protonmail_quote)[^>]*>([\s\S]*?)<\/\1\s*>/gi,
        '\n\n[Quoted or forwarded content begins]\n$2\n[Quoted or forwarded content ends]\n\n',
      )
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const QUOTE_OR_FORWARD = [
  /^\s*>/m,
  /^\s*-{2,}\s*(?:forwarded message|original message)\s*-{2,}/im,
  /^\s*begin forwarded message\s*:/im,
  /^\s*On\b[\s\S]{0,500}?\bwrote\s*:/im,
  /^\s*(?:Le\s+.+\ba\s+écrit|Am\s+.+\bschrieb|El\s+.+\bescribió|Em\s+.+\bescreveu|Il\s+giorno\s+.+\bha\s+scritto|Op\s+.+\bschreef|在.+写道|於.+寫道)\s*:/im,
  /^\s*(?:From|De|Von|Van|Da|Fra|Från|发件人|差出人)\s*:[^\n]*\n(?:[^\n]*\n){0,5}?\s*(?:Sent|Date|Envoyé|Gesendet|Verzonden|Inviato|Fecha|发送时间|Subject|Objet|Betreff|Onderwerp|Oggetto|Asunto|主题)\s*:/im,
  /^\s*\[(?:quoted|forwarded)(?: or forwarded)? content begins\]/im,
];

function quoteBoundaryText(text: string): { text: string; quoted: boolean } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => QUOTE_OR_FORWARD.some((marker) => marker.test(line)));
  if (start < 0) return { text: text.trim(), quoted: false };
  return {
    text: `${lines.slice(0, start).join('\n').trim()}\n\n[Quoted or forwarded content begins]\n${lines.slice(start).join('\n').trim()}\n[Quoted or forwarded content ends]`.trim(),
    quoted: true,
  };
}

function splitLosslessly(text: string, cap = UNIT_CHAR_CAP): string[] {
  if (text.length <= cap) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + cap, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf('\n', end - 1), text.lastIndexOf(' ', end - 1));
      if (boundary > start + Math.floor(cap * 0.6)) end = boundary + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function unitChunks(input: Omit<ImportUnit, 'unitOffset'>): ImportUnit[] {
  return splitLosslessly(input.text).map((text, index, chunks) => ({
    ...input,
    text,
    unitOffset:
      chunks.length === 1
        ? 0
        : chunks.slice(0, index).reduce((sum, chunk) => sum + chunk.length, 0),
  }));
}

function diagnostics(format: ImportKind): ImportParseDiagnostics {
  return {
    format,
    supported:
      format === 'mbox'
        ? [
            'RFC 5322/MIME mbox: CRLF or LF, multipart, base64, quoted-printable, UTF-8/declared charsets',
          ]
        : format === 'json'
          ? ['JSON array of message objects or {"messages": [...]}']
          : ['Plain text/Markdown paragraphs and lines'],
    acceptedUnits: 0,
    rejectedUnits: 0,
    partial: false,
    issues: [],
  };
}

function mboxMessages(content: string): Array<{ raw: string; offset: number }> {
  const starts: number[] = [];
  const separator = /^From \S+@\S+ .*(?:19|20)\d{2}.*$/gm;
  for (const match of content.matchAll(separator)) starts.push(match.index ?? 0);
  if (starts.length === 0) return content.trim() ? [{ raw: content, offset: 0 }] : [];
  return starts.map((start, index) => ({
    raw: content.slice(start, starts[index + 1] ?? content.length),
    offset: start,
  }));
}

function mboxRawMessage(chunk: string): string {
  const boundary = chunk.indexOf('\n');
  const message = boundary < 0 ? '' : chunk.slice(boundary + 1);
  // mboxrd quotes body lines beginning with From; remove only the escaping >.
  return message.replace(/^>+From /gm, (line) => line.slice(1));
}

function messageText(email: Email): string {
  const html = email.html ?? '';
  const htmlHasQuotedBlock =
    /<blockquote\b|(?:class|id)\s*=\s*["'][^"']*(?:gmail_quote|yahoo_quoted|divrplyfwdmsg|moz-cite-prefix|protonmail_quote|stopspelling)/i.test(
      html,
    );
  const text = htmlHasQuotedBlock
    ? htmlTextPreservingQuotes(html)
    : (email.text ?? htmlTextPreservingQuotes(html));
  return text.replace(/\r\n?/g, '\n').trim();
}

export async function parseMboxDetailed(content: string): Promise<ImportParseResult> {
  const report = diagnostics('mbox');
  const units: ImportUnit[] = [];
  const messages = mboxMessages(content);
  for (const { raw, offset } of messages) {
    if (raw.length > MIME_MESSAGE_LIMIT) {
      report.partial = true;
      report.rejectedUnits += 1;
      report.issues.push({
        offset,
        code: 'message_too_large',
        message: 'MIME message exceeds 25 MiB safety limit',
      });
      continue;
    }
    try {
      const parsed = await PostalMime.parse(mboxRawMessage(raw));
      const fromEntries = mailboxes(parsed.from);
      const from = fromEntries.length === 1 ? fromEntries[0] : undefined;
      const decodedText = messageText(parsed);
      const bounded = quoteBoundaryText(decodedText);
      const subject = parsed.subject?.trim() ?? '';
      const text = bounded.text;
      const forwardedAttachment = parsed.attachments.some(
        (attachment) =>
          attachment.mimeType === 'message/rfc822' || attachment.rfc822DepthExceeded === true,
      );
      if (fromEntries.length > 1) {
        report.partial = true;
        report.issues.push({
          offset,
          code: 'ambiguous_author',
          message: 'MIME From header contains multiple mailboxes; author identity is unresolved',
        });
      }
      if (!text && !subject) {
        report.partial = true;
        report.rejectedUnits += 1;
        report.issues.push({
          offset,
          code: 'empty_message',
          message: 'MIME message has no readable text body or subject',
        });
        continue;
      }
      const chunks = unitChunks({
        date: parseDate(parsed.date ?? null),
        header: [
          from?.name
            ? `From ${from.name}${from.address ? ` <${from.address}>` : ''}`
            : from?.address
              ? `From ${from.address}`
              : '',
          subject ? `Subject: ${subject}` : '',
        ]
          .filter(Boolean)
          .join(' — '),
        text: text || subject,
        sourceOffset: offset,
        authorEmail: from?.address.toLowerCase() ?? null,
        hasQuotedContent:
          bounded.quoted ||
          forwardedAttachment ||
          /^\s*(?:(?:fw|fwd)\s*:\s*)+/i.test(subject) ||
          QUOTE_OR_FORWARD.some((marker) => marker.test(text)),
      });
      units.push(...chunks);
      report.acceptedUnits += 1;
    } catch (error) {
      report.partial = true;
      report.rejectedUnits += 1;
      report.issues.push({
        offset,
        code: 'mime_parse_failed',
        message: error instanceof Error ? error.message.slice(0, 300) : 'MIME parsing failed',
      });
    }
  }
  if (messages.length === 0) {
    report.partial = content.trim().length > 0;
    if (content.trim()) {
      report.rejectedUnits = 1;
      report.issues.push({
        offset: 0,
        code: 'no_mbox_messages',
        message: 'No RFC mbox message separators were found',
      });
    }
  }
  return { units, diagnostics: report };
}

/** Standards-based MIME parse. Only raw text mode is synchronous. */
export async function parseArchiveDetailed(
  kind: ImportKind,
  content: string,
): Promise<ImportParseResult> {
  if (kind === 'mbox') return parseMboxDetailed(content);
  if (kind === 'json') return parseJsonExportDetailed(content);
  return parseTextDetailed(content);
}

export async function parseArchive(kind: ImportKind, content: string): Promise<ImportUnit[]> {
  return (await parseArchiveDetailed(kind, content)).units;
}

/** Backwards-compatible convenience API for parser tests and callers. */
export async function parseMbox(content: string): Promise<ImportUnit[]> {
  return (await parseMboxDetailed(content)).units;
}

function scanJsonArray(
  content: string,
  arrayStart: number,
): Array<{ raw: string; offset: number }> {
  const items: Array<{ raw: string; offset: number }> = [];
  let cursor = arrayStart + 1;
  while (cursor < content.length) {
    while (/[\s,]/.test(content[cursor] ?? '')) cursor += 1;
    if (content[cursor] === ']' || cursor >= content.length) break;
    const start = cursor;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; cursor < content.length; cursor += 1) {
      const char = content[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        if (depth === 0 && char === ']') break;
        depth -= 1;
        if (depth === 0) {
          cursor += 1;
          break;
        }
      } else if (char === ',' && depth === 0) {
        break;
      }
    }
    const raw = content.slice(start, cursor).trim();
    if (raw) items.push({ raw, offset: start });
    if (content[cursor] === ',') cursor += 1;
    else if (content[cursor] === ']') break;
  }
  return items;
}

export function parseJsonExportDetailed(content: string): ImportParseResult {
  const report = diagnostics('json');
  const units: ImportUnit[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    report.partial = true;
    report.rejectedUnits = 1;
    report.issues.push({
      offset: 0,
      code: 'invalid_json',
      message: error instanceof Error ? error.message.slice(0, 300) : 'Invalid JSON',
    });
    return { units, diagnostics: report };
  }
  let values: unknown[];
  let sourceItems: Array<{ raw: string; offset: number }>;
  if (Array.isArray(parsed)) {
    values = parsed;
    const start = content.indexOf('[');
    sourceItems = scanJsonArray(content, start);
  } else if (
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { messages?: unknown }).messages)
  ) {
    values = (parsed as { messages: unknown[] }).messages;
    const key = /"messages"\s*:\s*\[/.exec(content);
    sourceItems = key ? scanJsonArray(content, content.indexOf('[', key.index)) : [];
  } else {
    report.partial = true;
    report.rejectedUnits = 1;
    report.issues.push({
      offset: 0,
      code: 'unsupported_json_shape',
      message: 'Expected a JSON message array or an object with a messages array',
    });
    return { units, diagnostics: report };
  }
  for (let index = 0; index < values.length; index++) {
    const raw = values[index];
    const offset = sourceItems[index]?.offset ?? 0;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      report.rejectedUnits += 1;
      report.partial = true;
      report.issues.push({
        offset,
        code: 'invalid_message',
        message: `Message ${index + 1} is not an object`,
      });
      continue;
    }
    const item = raw as Record<string, unknown>;
    const textValue = item.text ?? item.content ?? item.body ?? item.message;
    const text = typeof textValue === 'string' ? textValue.trim() : '';
    const fromValue = item.from ?? item.sender ?? item.author;
    const from = typeof fromValue === 'string' ? fromValue.trim() : '';
    if (text.length < 3) {
      report.rejectedUnits += 1;
      report.partial ||= values.length > 0;
      report.issues.push({
        offset,
        code: 'empty_message',
        message: `Message ${index + 1} has no readable text`,
      });
      continue;
    }
    const parsedMailboxes = from
      ? addressParser(from, { flatten: true }).filter(
          (candidate) =>
            'address' in candidate &&
            typeof candidate.address === 'string' &&
            candidate.address.length > 0,
        )
      : [];
    if (parsedMailboxes.length > 1) {
      report.partial = true;
      report.issues.push({
        offset,
        code: 'ambiguous_author',
        message: `Message ${index + 1} has multiple RFC mailboxes; author identity is unresolved`,
      });
    }
    const mailbox = parsedMailboxes.length === 1 ? parsedMailboxes[0] : undefined;
    const address =
      mailbox && 'address' in mailbox && mailbox.address ? mailbox.address.toLowerCase() : null;
    const bounded = quoteBoundaryText(text);
    units.push(
      ...unitChunks({
        date: parseDate(
          (item.date ?? item.timestamp ?? item.time ?? item.created_at ?? item.ts) as
            | string
            | number
            | undefined,
        ),
        header: from ? `From ${from}` : '',
        text: bounded.text,
        sourceOffset: offset,
        authorEmail: address,
        hasQuotedContent: bounded.quoted || QUOTE_OR_FORWARD.some((marker) => marker.test(text)),
      }),
    );
    report.acceptedUnits += 1;
  }
  return { units, diagnostics: report };
}

export function parseJsonExport(content: string): ImportUnit[] {
  return parseJsonExportDetailed(content).units;
}

export function parseTextDetailed(content: string): ImportParseResult {
  const report = diagnostics('text');
  const units: ImportUnit[] = [];
  const paragraphs: Array<{ text: string; offset: number }> = [];
  const separator = /\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/g;
  let start = 0;
  for (const match of content.matchAll(separator)) {
    const offset = match.index ?? start;
    paragraphs.push({ text: content.slice(start, offset), offset: start });
    start = offset + match[0].length;
  }
  paragraphs.push({ text: content.slice(start), offset: start });
  for (const { text: rawParagraph, offset } of paragraphs) {
    const paragraph = rawParagraph.trim();
    const paragraphOffset = offset + rawParagraph.indexOf(paragraph);
    if (!paragraph) continue;
    let chunkOffset = 0;
    for (const chunk of splitLosslessly(paragraph, UNIT_CHAR_CAP)) {
      const bounded = quoteBoundaryText(chunk);
      units.push({
        date: null,
        header: '',
        text: bounded.text,
        sourceOffset: paragraphOffset + chunkOffset,
        authorEmail: null,
        hasQuotedContent: bounded.quoted,
        unitOffset: 0,
      });
      chunkOffset += chunk.length;
    }
  }
  report.acceptedUnits = units.length;
  return { units, diagnostics: report };
}

export function parseText(content: string): ImportUnit[] {
  return parseTextDetailed(content).units;
}

export interface ImportWindow {
  units: ImportUnit[];
  /** Observation dates for context only; never a fact validity fallback. */
  date: Date | null;
  text: string;
}

function unitPrompt(unit: ImportUnit): string {
  const observation = unit.date ? unit.date.toISOString() : 'unknown';
  const identity = unit.authorEmail ? `; RFC From mailbox ${unit.authorEmail}` : '';
  const source = `Source offset ${unit.sourceOffset}${unit.unitOffset ? `+${unit.unitOffset}` : ''}; observed ${observation}${identity}`;
  return `${unit.header ? `${unit.header}\n` : ''}[${source}]\n${unit.text}`;
}

export function windowUnits(units: ImportUnit[], maxChars = 6000): ImportWindow[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1)
    throw new Error('Invalid import window bound');
  const separator = '\n--- UNIT BOUNDARY ---\n';
  const windows: ImportWindow[] = [];
  let bucket: ImportUnit[] = [];
  let size = 0;
  const flush = () => {
    if (bucket.length === 0) return;
    const dates = bucket.map((unit) => unit.date);
    const firstDate = dates[0] ?? null;
    const oneObservedPeriod =
      firstDate !== null &&
      dates.every((date) => date !== null && date.getTime() === firstDate.getTime());
    windows.push({
      units: bucket,
      date: oneObservedPeriod ? firstDate : null,
      text: bucket.map(unitPrompt).join(separator),
    });
    bucket = [];
    size = 0;
  };
  for (const unit of units) {
    // Reserve room for provenance including the largest continuation offset.
    // Split source text, never an already-rendered envelope: rendering that
    // envelope again would duplicate metadata and exceed the requested bound.
    const envelope = unitPrompt({
      ...unit,
      text: '',
      unitOffset: (unit.unitOffset ?? 0) + unit.text.length,
    }).length;
    const capacity = maxChars - envelope;
    if (capacity < 1) throw new Error('Import source provenance exceeds its window bound');
    const pieces = splitLosslessly(unit.text, capacity);
    let consumed = 0;
    for (const piece of pieces) {
      const chunk = { ...unit, text: piece, unitOffset: (unit.unitOffset ?? 0) + consumed };
      const renderedSize = unitPrompt(chunk).length;
      if (size > 0 && size + separator.length + renderedSize > maxChars) flush();
      if (bucket.length > 0) size += separator.length;
      bucket.push(chunk);
      size += renderedSize;
      consumed += piece.length;
    }
  }
  flush();
  return windows;
}

export function ageScaledConfidence(base: number, date: Date | null, now = new Date()): number {
  if (!date) return Math.min(base, 0.6);
  const years = Math.max(0, (now.getTime() - date.getTime()) / (365.25 * 24 * 3600 * 1000));
  const factor = Math.max(0.35, 1 - 0.06 * years);
  return Math.max(0.05, Math.min(base * factor, 0.95));
}
