/**
 * Markdown → Google Docs `batchUpdate` request emitter.
 *
 * The model writes ordinary Markdown; a Doc must show it as real rich text, not
 * literal `**` and `[]()` characters. This module parses the Markdown into a
 * block/run model, lays the *stripped* plain text down with one `insertText`,
 * then emits attribute-only requests (`updateTextStyle` / `updateParagraphStyle`
 * / `createParagraphBullets`) whose ranges are computed against that inserted
 * text. Because the styling requests never move text, every index is computed
 * once — exactly as the previous heading/bullet-only implementation did, so
 * plain text with no Markdown produces byte-identical output.
 *
 * Docs indices count UTF-16 code units, which is what JavaScript string length
 * reports, so surrogate-pair characters stay aligned.
 */

export interface DocsBatchRequest {
  [request: string]: unknown;
}

interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** http(s)/mailto only — enforced by the inline tokenizer. */
  link?: string;
}

type Block =
  | { t: 'p'; runs: InlineRun[]; heading?: number; quote?: boolean }
  | { t: 'li'; runs: InlineRun[]; ordered: boolean }
  | { t: 'code'; text: string }
  | { t: 'rule' };

const HEADING_STYLE: Record<number, string> = {
  1: 'HEADING_1',
  2: 'HEADING_2',
  3: 'HEADING_3',
  4: 'HEADING_4',
  5: 'HEADING_5',
  6: 'HEADING_6',
};

const RULE_TEXT = '─'.repeat(24); // a line of box-drawing dashes
const CODE_FONT = 'Courier New';
const LINK_COLOR = { red: 0.06, green: 0.45, blue: 0.8 };

/**
 * Split one line of text into styled runs. Recognizes inline code, links
 * (`[text](url)`), bold (`**`/`__`) and italic (`*`/`_`). Link URLs are limited
 * to http(s)/mailto so a Markdown link can never smuggle a `javascript:` target
 * into a real hyperlink. Constructs that don't parse are left as literal text.
 */
export function parseInline(input: string): InlineRun[] {
  if (input.length === 0) return [{ text: '' }];
  const runs: InlineRun[] = [];
  // Alternation order matters: code and links first, then bold before italic so
  // `**x**` is not mis-read as two italic `*` markers.
  const re =
    /(`[^`\n]+`)|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard global-regex scan
  while ((m = re.exec(input)) !== null) {
    if (m.index > last) runs.push({ text: input.slice(last, m.index) });
    if (m[1] !== undefined) runs.push({ text: m[1].slice(1, -1), code: true });
    else if (m[2] !== undefined && m[3] !== undefined) runs.push({ text: m[2], link: m[3] });
    else if (m[4] !== undefined) runs.push({ text: m[4], bold: true });
    else if (m[5] !== undefined) runs.push({ text: m[5], bold: true });
    else if (m[6] !== undefined) runs.push({ text: m[6], italic: true });
    else if (m[7] !== undefined) runs.push({ text: m[7], italic: true });
    last = re.lastIndex;
  }
  if (last < input.length) runs.push({ text: input.slice(last) });
  return runs.length > 0 ? runs : [{ text: input }];
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

/** Render a Markdown table as bold-header text rows (real grid rendering is a follow-up). */
function expandTable(rows: string[][], out: Block[]): void {
  rows.forEach((cells, index) => {
    const text = cells.join('  •  ');
    out.push({ t: 'p', runs: [{ text, bold: index === 0 }] });
  });
}

function parseLineBlock(line: string): Block {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return { t: 'p', heading: heading[1]?.length, runs: parseInline(heading[2] ?? '') };
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return { t: 'rule' };
  const quote = /^>\s?(.*)$/.exec(line);
  if (quote) return { t: 'p', quote: true, runs: parseInline(quote[1] ?? '') };
  const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
  if (ordered) return { t: 'li', ordered: true, runs: parseInline(ordered[1] ?? '') };
  const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
  if (bullet) return { t: 'li', ordered: false, runs: parseInline(bullet[1] ?? '') };
  return { t: 'p', runs: parseInline(line) };
}

function parseBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        buf.push(lines[i] ?? '');
        i++;
      }
      blocks.push({ t: 'code', text: buf.join('\n') });
      continue;
    }
    if (
      /^\s*\|.*\|\s*$/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')
    ) {
      const rows: string[][] = [splitTableRow(line)];
      i += 2; // skip the header and the |---|---| separator row
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? '')) {
        rows.push(splitTableRow(lines[i] ?? ''));
        i++;
      }
      i--; // the for-loop will re-increment
      expandTable(rows, blocks);
      continue;
    }
    blocks.push(parseLineBlock(line));
  }
  return blocks;
}

function plainOf(block: Block): string {
  if (block.t === 'code') return block.text;
  if (block.t === 'rule') return RULE_TEXT;
  return block.runs.map((r) => r.text).join('');
}

function inlineStyleRequests(runs: InlineRun[], start: number): DocsBatchRequest[] {
  const requests: DocsBatchRequest[] = [];
  let cursor = start;
  for (const run of runs) {
    const end = cursor + run.text.length;
    if (run.text.length > 0) {
      const style: Record<string, unknown> = {};
      const fields: string[] = [];
      if (run.bold) {
        style.bold = true;
        fields.push('bold');
      }
      if (run.italic) {
        style.italic = true;
        fields.push('italic');
      }
      if (run.code) {
        style.weightedFontFamily = { fontFamily: CODE_FONT };
        fields.push('weightedFontFamily');
      }
      if (run.link) {
        style.link = { url: run.link };
        style.underline = true;
        style.foregroundColor = { color: { rgbColor: LINK_COLOR } };
        fields.push('link', 'underline', 'foregroundColor');
      }
      if (fields.length > 0) {
        requests.push({
          updateTextStyle: {
            range: { startIndex: cursor, endIndex: end },
            textStyle: style,
            fields: fields.join(','),
          },
        });
      }
    }
    cursor = end;
  }
  return requests;
}

/** Table cells use inline Markdown only; a leading dash is not a list block. */
export function buildInlineContentRequests(
  content: string,
  startIndex: number,
): { requests: DocsBatchRequest[]; insertedLength: number } {
  const runs = parseInline(content);
  const text = runs.map((run) => run.text).join('');
  return {
    requests: text.length
      ? [
          { insertText: { location: { index: startIndex }, text } },
          ...inlineStyleRequests(runs, startIndex),
        ]
      : [],
    insertedLength: text.length,
  };
}

/**
 * Turn Markdown into Docs `batchUpdate` requests that insert it at `startIndex`.
 * `leadingNewline` pushes the content onto a fresh paragraph when appending
 * after existing text.
 */
export function buildContentRequests(
  content: string,
  startIndex: number,
  opts: { leadingNewline?: boolean } = {},
): { requests: DocsBatchRequest[]; insertedLength: number } {
  const blocks = parseBlocks(content);
  const prefix = opts.leadingNewline ? '\n' : '';
  const text = prefix + blocks.map(plainOf).join('\n');
  if (text.length === 0) return { requests: [], insertedLength: 0 };

  const insert: DocsBatchRequest = { insertText: { location: { index: startIndex }, text } };
  const paragraphRequests: DocsBatchRequest[] = [];
  const inlineRequests: DocsBatchRequest[] = [];
  const listRanges: Array<{ startIndex: number; endIndex: number; ordered: boolean }> = [];
  let openList: { startIndex: number; endIndex: number; ordered: boolean } | null = null;

  let cursor = startIndex + prefix.length;
  for (const block of blocks) {
    const plain = plainOf(block);
    const lineStart = cursor;
    const lineEnd = lineStart + plain.length;

    if (block.t === 'p' && block.heading && plain.length > 0) {
      paragraphRequests.push({
        updateParagraphStyle: {
          range: { startIndex: lineStart, endIndex: lineEnd },
          paragraphStyle: { namedStyleType: HEADING_STYLE[block.heading] },
          fields: 'namedStyleType',
        },
      });
    }
    if (block.t === 'p' && block.quote && plain.length > 0) {
      paragraphRequests.push({
        updateParagraphStyle: {
          range: { startIndex: lineStart, endIndex: lineEnd },
          paragraphStyle: {
            indentStart: { magnitude: 18, unit: 'PT' },
            indentFirstLine: { magnitude: 18, unit: 'PT' },
          },
          fields: 'indentStart,indentFirstLine',
        },
      });
    }
    if (block.t === 'code' && plain.length > 0) {
      inlineRequests.push({
        updateTextStyle: {
          range: { startIndex: lineStart, endIndex: lineEnd },
          textStyle: { weightedFontFamily: { fontFamily: CODE_FONT } },
          fields: 'weightedFontFamily',
        },
      });
    }

    if (block.t === 'li' && plain.length > 0) {
      if (openList && openList.ordered === block.ordered && openList.endIndex === lineStart - 1) {
        openList.endIndex = lineEnd;
      } else {
        openList = { startIndex: lineStart, endIndex: lineEnd, ordered: block.ordered };
        listRanges.push(openList);
      }
    } else {
      openList = null;
    }

    if (block.t === 'p' || block.t === 'li') {
      inlineRequests.push(...inlineStyleRequests(block.runs, lineStart));
    }

    cursor = lineEnd + 1; // + 1 for the '\n' that separates paragraphs
  }

  for (const range of listRanges) {
    paragraphRequests.push({
      createParagraphBullets: {
        range: { startIndex: range.startIndex, endIndex: range.endIndex },
        bulletPreset: range.ordered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
  }

  return {
    requests: [insert, ...inlineRequests, ...paragraphRequests],
    insertedLength: text.length,
  };
}

export interface RichSpan {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

export interface RenderedRichText {
  text: string;
  spans: RichSpan[];
  bulletRanges: Array<{ start: number; end: number }>;
}

/**
 * Flatten Markdown body text for a Slides text box: strip the markers to plain
 * text and return inline emphasis spans plus contiguous bullet ranges. Slides
 * have no heading style, so `#` headings render as bold lines. Index math mirrors
 * `buildContentRequests` (UTF-16 code units, one '\n' between lines).
 */
export function renderSlideBody(body: string): RenderedRichText {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const texts: string[] = [];
  const spans: RichSpan[] = [];
  const bulletRanges: Array<{ start: number; end: number }> = [];
  let open: { start: number; end: number } | null = null;
  let cursor = 0;

  for (const raw of lines) {
    let isBullet = false;
    let runs: InlineRun[];
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(raw);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
    if (heading) {
      runs = parseInline(heading[2] ?? '').map((r) => ({ ...r, bold: true }));
    } else if (bullet || ordered) {
      isBullet = true;
      runs = parseInline(bullet?.[1] ?? ordered?.[1] ?? '');
    } else {
      runs = parseInline(raw);
    }

    const lineStart = cursor;
    let runCursor = cursor;
    for (const run of runs) {
      const end = runCursor + run.text.length;
      if (run.text.length > 0 && (run.bold || run.italic || run.code || run.link)) {
        spans.push({
          start: runCursor,
          end,
          bold: run.bold,
          italic: run.italic,
          code: run.code,
          link: run.link,
        });
      }
      runCursor = end;
    }
    const lineEnd = runCursor;

    if (isBullet && lineEnd > lineStart) {
      if (open && open.end === lineStart - 1) open.end = lineEnd;
      else {
        open = { start: lineStart, end: lineEnd };
        bulletRanges.push(open);
      }
    } else {
      open = null;
    }

    texts.push(runs.map((r) => r.text).join(''));
    cursor = lineEnd + 1;
  }

  return { text: texts.join('\n'), spans, bulletRanges };
}
