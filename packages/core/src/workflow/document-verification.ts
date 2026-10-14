import { z } from 'zod';
import { requestedArtifactIntent } from './artifact-intent.js';

const StructureSchema = z.object({
  complete: z.literal(true),
  headings: z.array(z.object({ text: z.string(), style: z.string() })).max(2_000),
  bullets: z.array(z.string()).max(2_000),
  tables: z.array(z.object({ rows: z.array(z.array(z.string())) })).max(100),
});

export interface DocumentVerificationEvidence {
  toolName: string;
  status: string;
  args?: unknown;
  result?: unknown;
  fromCurrentTask?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function succeeded(row: DocumentVerificationEvidence): boolean {
  const result = record(row.result);
  return (
    row.fromCurrentTask !== false &&
    row.status === 'succeeded' &&
    result?.ok !== false &&
    !(typeof result?.status === 'number' && result.status >= 400)
  );
}

function createdDocument(evidence: ReadonlyArray<DocumentVerificationEvidence>) {
  return evidence.findLast(
    (row) =>
      row.toolName === 'docs.create' &&
      succeeded(row) &&
      typeof record(row.result)?.documentId === 'string',
  );
}

/** The runtime performs one read of the newly created artifact before claiming verification. */
export function nextCreatedDocumentRead(
  request: string,
  evidence: ReadonlyArray<DocumentVerificationEvidence>,
): { documentId: string; startOffset: number; maxChars: number } | undefined {
  if (requestedArtifactIntent(request)?.toolName !== 'docs.create') return undefined;
  const created = createdDocument(evidence);
  const documentId = record(created?.result)?.documentId;
  if (!created || typeof documentId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(documentId))
    return undefined;
  const createIndex = evidence.indexOf(created);
  if (
    evidence
      .slice(createIndex + 1)
      .some(
        (row) =>
          row.fromCurrentTask !== false &&
          row.toolName === 'docs.get' &&
          record(row.args)?.documentId === documentId,
      )
  )
    return undefined;
  return { documentId, startOffset: 0, maxChars: 50_000 };
}

const COUNT_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

/** Only formatting clauses count; titles, quoted content and prose topics are data. */
function formattingRequirements(request: string): string {
  const unquoted = request
    .replace(/```[\s\S]*?```|`[^`]*`|"[^"]*"|“[^”]*”/g, '')
    .replace(/\b(?:do not|don['’]t|never|without)\b[^.!?;\n]*/gi, '');
  return unquoted
    .split(/[.!?]/)
    .flatMap((statement) => {
      const directive =
        /\b(?:with|include|including|contain|containing|add|use|insert|have)\b/i.exec(statement);
      if (directive) return [statement.slice(directive.index)];
      const colon = /\b(?:create|make|write|prepare)\b[^:]{0,120}\b(?:doc|document)\b[^:]*:/i.exec(
        statement,
      );
      return colon ? [statement.slice(colon.index + colon[0].length)] : [];
    })
    .join('\n');
}

const PROSE_TOPIC =
  /\b(?:about|discuss(?:ing)?|describ(?:e|ing)|compar(?:e|ing|ison)|mention(?:ing)?|summari[sz](?:e|ing)|explain(?:ing)?|refer(?:ring)? to)\b/i;
const STRUCTURAL_NOUN = /\b(?:headings?|tables?|bullets?|lists?|rows?|columns?)\b/i;

function isFormattingNoun(requirements: string, index: number): boolean {
  const before = requirements.slice(0, index);
  const start =
    Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1;
  const clause = requirements.slice(start);
  const target = index - start;
  let scopeStart = 0;
  const conjunctions = new RegExp(
    `\\b(?:and|also|plus)\\s+(?=(?:an?|the|exactly|\\d+|${COUNT_WORDS.join('|')}|include|add|insert|use)\\b)`,
    'gi',
  );
  for (const conjunction of clause.matchAll(conjunctions)) {
    if (conjunction.index >= target) break;
    const prefix = clause.slice(scopeStart, conjunction.index);
    const topic = PROSE_TOPIC.exec(prefix);
    if (topic) {
      const beforeTopic = prefix.slice(0, topic.index);
      const topicText = prefix.slice(topic.index + topic[0].length);
      const explicitDirective = /^(?:include|add|insert|use)\b/i.test(
        clause.slice(conjunction.index + conjunction[0].length),
      );
      // A heading's subject can end before another requested block. A prose
      // topic that already names structures ("about headings and tables")
      // stays a topic unless a new formatting verb explicitly starts a request.
      if (
        !explicitDirective &&
        (!STRUCTURAL_NOUN.test(beforeTopic) || STRUCTURAL_NOUN.test(topicText))
      )
        continue;
    }
    scopeStart = conjunction.index + conjunction[0].length;
  }
  return !PROSE_TOPIC.test(clause.slice(scopeStart, target));
}

function requestedCount(requirements: string, noun: string): number | undefined {
  const pattern = new RegExp(
    `\\b(?:exactly\\s+)?(\\d+|${COUNT_WORDS.join('|')})[ -]+${noun}\\b`,
    'gi',
  );
  for (const match of requirements.matchAll(pattern)) {
    if (!match[1] || !isFormattingNoun(requirements, match.index)) continue;
    if (
      noun.includes('table') &&
      /^\s+of\s+contents\b/i.test(requirements.slice(match.index + match[0].length))
    )
      continue;
    return /^\d+$/.test(match[1]) ? Number(match[1]) : COUNT_WORDS.indexOf(match[1].toLowerCase());
  }
  return undefined;
}

function requestsStructure(requirements: string, noun: 'heading' | 'table'): boolean {
  for (const match of requirements.matchAll(new RegExp(`\\b${noun}s?\\b`, 'gi'))) {
    if (!isFormattingNoun(requirements, match.index)) continue;
    if (
      noun === 'table' &&
      /^\s+of\s+contents\b/i.test(requirements.slice(match.index + match[0].length))
    )
      continue;
    return true;
  }
  return false;
}

/** A successful text read proves words, not native paragraph/list/table formatting. */
export function createdDocumentVerification(
  request: string,
  evidence: ReadonlyArray<DocumentVerificationEvidence>,
  answer: string,
): { text: string; verified: boolean; reason?: string } | undefined {
  if (requestedArtifactIntent(request)?.toolName !== 'docs.create') return undefined;
  const created = createdDocument(evidence);
  if (!created) return undefined;
  const creation = record(created.result);
  const documentId = creation?.documentId;
  if (typeof documentId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(documentId))
    return undefined;
  const expected = StructureSchema.safeParse(creation?.contentStructure);
  const requiresVerification =
    /\b(?:verify|verification|read (?:it|the document|the doc) back|check (?:the|those) details)\b/i.test(
      request,
    ) ||
    /\b(?:verified|confirmed|read.{0,40}back|checked.{0,40}(?:format|heading|bullet|table))\b/i.test(
      answer,
    );
  if (!expected.success && !requiresVerification) return undefined;
  const url = `https://docs.google.com/document/d/${documentId}/edit`;
  const prefix = `Created [the document](${url}).`;
  const later = evidence.slice(evidence.indexOf(created) + 1);
  const read = later.findLast(
    (row) =>
      row.toolName === 'docs.get' &&
      succeeded(row) &&
      record(row.args)?.documentId === documentId &&
      record(row.result)?.documentId === documentId,
  );
  const readResult = record(read?.result);
  const observed = StructureSchema.safeParse(readResult?.structure);
  if (!expected.success || !observed.success || readResult?.complete !== true)
    return {
      text: `${prefix} I could not verify the native heading, bullet, and table formatting from a complete structural readback.`,
      verified: false,
      reason: 'document-native-structure-unavailable',
    };
  const title = record(created.args)?.title;
  const titleFromRequest = /\btitled\s+["“]([^"”]+)["”]/i.exec(request)?.[1];
  const headingFromRequest = /\bheading\s+["“]([^"”]+)["”]/i.exec(request)?.[1];
  const requirements = formattingRequirements(request);
  const headings = requestedCount(requirements, '(?:native[ -]+)?headings?');
  const tables = requestedCount(requirements, '(?:native[ -]+)?tables?');
  const bullets = requestedCount(requirements, 'bullets?');
  const needsHeading = requestsStructure(requirements, 'heading');
  const needsTable = requestsStructure(requirements, 'table');
  const columns = needsTable ? requestedCount(requirements, 'columns?') : undefined;
  const dataRows = needsTable
    ? (requestedCount(requirements, '(?:data|body)[ -]+rows?') ??
      (/\ban?[ -]+(?:data|body)[ -]+row\b/i.test(requirements) ? 1 : undefined))
    : undefined;
  const rows = needsTable ? requestedCount(requirements, 'rows?') : undefined;
  const nativeTables = observed.data.tables;
  const rowCountsMatch = (count: number, dataOnly: boolean) => {
    const counts = nativeTables.map((table) => table.rows.length - (dataOnly ? 1 : 0));
    return /\brows?[ -]+(?:in[ -]+)?total\b|\btotal[ -]+(?:data[ -]+|body[ -]+)?rows?\b/i.test(
      requirements,
    )
      ? counts.reduce((sum, value) => sum + value, 0) === count
      : counts.every((value) => value === count);
  };
  const expectedRows = expected.data.tables;
  const matches =
    typeof title === 'string' &&
    readResult?.title === title &&
    (!titleFromRequest || title === titleFromRequest) &&
    (!headingFromRequest ||
      observed.data.headings.some((heading) => heading.text === headingFromRequest)) &&
    (headings === undefined
      ? !needsHeading || observed.data.headings.length > 0
      : observed.data.headings.length === headings) &&
    (tables === undefined
      ? !needsTable || nativeTables.length > 0
      : nativeTables.length === tables) &&
    (bullets === undefined || observed.data.bullets.length === bullets) &&
    (!needsTable ||
      nativeTables.every(
        (table) => table.rows.length > 0 && table.rows.every((row) => row.length > 0),
      )) &&
    (columns === undefined ||
      nativeTables.every((table) => table.rows.every((row) => row.length === columns))) &&
    (dataRows === undefined || rowCountsMatch(dataRows, true)) &&
    (rows === undefined || rowCountsMatch(rows, false)) &&
    JSON.stringify(observed.data.headings) === JSON.stringify(expected.data.headings) &&
    JSON.stringify(observed.data.bullets) === JSON.stringify(expected.data.bullets) &&
    JSON.stringify(observed.data.tables) === JSON.stringify(expectedRows);
  if (!matches)
    return {
      text: `${prefix} The structural readback did not match the requested title or the submitted heading, bullet, and table content. Formatting verification remains incomplete.`,
      verified: false,
      reason: 'document-native-structure-mismatch',
    };
  const confirmed = ['title'];
  if (observed.data.headings.length)
    confirmed.push(
      `${observed.data.headings.length} native ${observed.data.headings.length === 1 ? 'heading' : 'headings'}`,
    );
  if (observed.data.bullets.length)
    confirmed.push(
      `${observed.data.bullets.length} native ${observed.data.bullets.length === 1 ? 'bullet' : 'bullets'}`,
    );
  if (observed.data.tables.length)
    confirmed.push(
      observed.data.tables
        .map((table) => `a native table with ${Math.max(0, table.rows.length - 1)} data rows`)
        .join(', '),
    );
  return { text: `${prefix} Readback confirmed the ${confirmed.join(', ')}.`, verified: true };
}
