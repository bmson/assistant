import { buildInlineContentRequests, type DocsBatchRequest, parseInline } from './docs-markdown.js';

export interface DocumentStructure {
  complete: boolean;
  headings: Array<{ text: string; style: string }>;
  bullets: string[];
  tables: Array<{ rows: string[][] }>;
}

export type DocumentContentPart =
  | { kind: 'text'; markdown: string }
  | { kind: 'table'; rows: string[][] };

/** Preserve real newlines; recover only explicit double-space block boundaries. */
export function normalizeDocumentMarkdown(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n');
  if (normalized.includes('\n') || normalized.includes('`')) return normalized;
  return normalized
    .replace(/[ \t]{2,}(?=(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\|))/g, '\n')
    .replace(/\|[ \t]{2,}\|/g, '|\n|');
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

export function documentContentPlan(content: string): DocumentContentPart[] {
  const lines = normalizeDocumentMarkdown(content).split('\n');
  const parts: DocumentContentPart[] = [];
  let text: string[] = [];
  let inCode = false;
  const flush = () => {
    if (text.length > 0) parts.push({ kind: 'text', markdown: text.join('\n') });
    text = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*```/.test(line)) inCode = !inCode;
    if (
      !inCode &&
      /^\s*\|.*\|\s*$/.test(line) &&
      /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1] ?? '')
    ) {
      flush();
      const rows = [tableCells(line)];
      const columns = rows[0]?.length ?? 0;
      if (columns < 1 || tableCells(lines[index + 1] ?? '').length !== columns)
        throw new Error('Markdown table header and separator must have the same number of columns');
      index += 2;
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index] ?? '')) {
        const row = tableCells(lines[index] ?? '');
        if (row.length !== columns)
          throw new Error('Markdown table rows must have the same number of columns');
        rows.push(row);
        index += 1;
      }
      index -= 1;
      if (rows.length * columns > 500)
        throw new Error('Document table exceeds the bounded 500-cell limit');
      parts.push({ kind: 'table', rows });
    } else {
      if (!inCode && /\|\s*:?-{3,}:?\s*\|/.test(line))
        throw new Error(
          'Markdown tables need one row per newline; collapsed table boundaries could not be established',
        );
      text.push(line);
    }
  }
  flush();
  return parts;
}

export function expectedDocumentStructure(parts: DocumentContentPart[]): DocumentStructure {
  const headings: DocumentStructure['headings'] = [];
  const bullets: string[] = [];
  const tables: DocumentStructure['tables'] = [];
  const plain = (value: string) =>
    parseInline(value)
      .map((run) => run.text)
      .join('');
  for (const part of parts) {
    if (part.kind === 'table') {
      tables.push({ rows: part.rows.map((row) => row.map(plain)) });
      continue;
    }
    let inCode = false;
    for (const line of part.markdown.split('\n')) {
      if (/^\s*```/.test(line)) {
        inCode = !inCode;
        continue;
      }
      if (inCode) continue;
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading)
        headings.push({ text: plain(heading[2] ?? ''), style: `HEADING_${heading[1]?.length}` });
      const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (bullet) bullets.push(plain(bullet[1] ?? ''));
    }
  }
  return { complete: true, headings, bullets, tables };
}

export function tableCellContentRequests(
  text: string,
  index: number,
  header: boolean,
): DocsBatchRequest[] {
  const { requests, insertedLength } = buildInlineContentRequests(text, index);
  if (header && insertedLength > 0)
    requests.push({
      updateTextStyle: {
        range: { startIndex: index, endIndex: index + insertedLength },
        textStyle: { bold: true },
        fields: 'bold',
      },
    });
  return requests;
}
