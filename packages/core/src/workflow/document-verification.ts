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

function requestedCount(request: string, noun: string): number | undefined {
  const words = [
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
  const match = new RegExp(`\\b(?:exactly\\s+)?(\\d+|${words.join('|')})[ -]+${noun}\\b`, 'i').exec(
    request,
  );
  if (!match?.[1]) return undefined;
  return /^\d+$/.test(match[1]) ? Number(match[1]) : words.indexOf(match[1].toLowerCase());
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
  const bullets = requestedCount(request, 'bullets?');
  const columns = requestedCount(request, 'columns?');
  const expectedRows = expected.data.tables;
  const matches =
    typeof title === 'string' &&
    readResult?.title === title &&
    (!titleFromRequest || title === titleFromRequest) &&
    (!headingFromRequest ||
      observed.data.headings.some((heading) => heading.text === headingFromRequest)) &&
    (bullets === undefined || observed.data.bullets.length === bullets) &&
    (columns === undefined ||
      observed.data.tables.every((table) => table.rows.every((row) => row.length === columns))) &&
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
