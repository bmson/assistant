import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import {
  baseMime,
  decodeXmlEntities,
  extractTagContents,
  normalize,
  parserFor,
  stripRtf,
  xmlText,
} from './text-helpers.js';

const run = promisify(execFile);

/**
 * Format → plain text. This is the only heavyweight part of the worker and the
 * reason it lives outside the agent container. Covers the office/text family
 * (Word, Excel, PowerPoint, OpenDocument, RTF) plus OCR for images and scanned
 * PDFs via tesseract + poppler (installed in the worker image).
 */

const OCR_TIMEOUT_MS = 120_000;
const OCR_MAX_PDF_PAGES = 20;
const OCR_MAX_CHARS = 200_000;

export type ExtractKind = 'text' | 'unsupported';

export interface ExtractOutcome {
  kind: ExtractKind;
  text: string;
  detail: string;
  structure?: { complete: true; representation: 'cell-addresses' | 'ordered-slides' };
}

async function parseDocx(bytes: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: bytes });
  return normalize(value ?? '');
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  const v = value as {
    text?: string;
    result?: unknown;
    richText?: Array<{ text?: string }>;
    hyperlink?: string;
    formula?: string;
  };
  if (Array.isArray(v.richText)) return v.richText.map((r) => r.text ?? '').join('');
  if (typeof v.text === 'string') return v.text;
  if (v.result != null) return String(v.result);
  if (typeof v.hyperlink === 'string') return v.hyperlink;
  return '';
}

async function parseXlsx(bytes: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const lines: string[] = [];
  wb.eachSheet((sheet) => {
    const rows = sheet.rowCount,
      columns = sheet.columnCount;
    if (rows * columns > 2_000_000)
      throw new Error('Spreadsheet dimensions exceed the complete extraction limit');
    lines.push(
      `# Sheet ${JSON.stringify(sheet.name)}`,
      `Dimensions: ${rows} rows x ${columns} columns`,
      `Visibility: ${sheet.state}`,
    );
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = Array.from({ length: columns }, (_, index) => {
        const cell = row.getCell(index + 1);
        return `${cell.address}=${JSON.stringify(cellText(cell.value))}${cell.isMerged && cell.master.address !== cell.address ? ` (merged with ${cell.master.address})` : ''}`;
      });
      if (cells.some((c) => !c.endsWith('=""')))
        lines.push(`Row ${row.number}: ${cells.join(' | ')}`);
    });
  });
  return normalize(lines.join('\n'));
}

function attributes(xml: string): Record<string, string> {
  return Object.fromEntries(
    [...xml.matchAll(/([\w:]+)\s*=\s*(["'])(.*?)\2/g)].map((match) => [
      match[1] ?? '',
      decodeXmlEntities(match[3] ?? ''),
    ]),
  );
}

async function parsePptx(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const presentation = await zip.file('ppt/presentation.xml')?.async('string');
  const relations = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  if (!presentation || !relations)
    throw new Error('Presentation order or relationships are unavailable');
  const targets = new Map<string, string>();
  for (const match of relations.matchAll(/<Relationship\b[^>]*\/?>(?:<\/Relationship>)?/g)) {
    const attrs = attributes(match[0]);
    if (!attrs.Type?.endsWith('/slide')) continue;
    if (!attrs.Id || !attrs.Target || attrs.TargetMode === 'External' || targets.has(attrs.Id))
      throw new Error('Presentation has an ambiguous slide relationship');
    const target = attrs.Target.startsWith('/')
      ? attrs.Target.slice(1)
      : path.posix.normalize(path.posix.join('ppt', attrs.Target));
    if (!/^ppt\/slides\/[^/]+\.xml$/i.test(target))
      throw new Error('Presentation slide target is invalid');
    targets.set(attrs.Id, target);
  }
  const out: string[] = [];
  let ordinal = 0;
  const seen = new Set<string>();
  for (const match of presentation.matchAll(/<p:sldId\b[^>]*\/?>(?:<\/p:sldId>)?/g)) {
    const id = attributes(match[0])['r:id'];
    const target = id ? targets.get(id) : undefined;
    if (!target || seen.has(target))
      throw new Error('Presentation ordered slide is missing or duplicated');
    seen.add(target);
    const xml = await zip.file(target)?.async('string');
    if (xml === undefined) throw new Error('Presentation ordered slide content is missing');
    ordinal += 1;
    out.push(`# Slide ${ordinal}\n${extractTagContents(xml, 'a:t').join(' ').trim()}`);
  }
  if (!ordinal && targets.size) throw new Error('Presentation slide order is unavailable');
  return normalize(out.join('\n\n'));
}

async function parseOpenDocument(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.files['content.xml']?.async('string');
  if (!xml) return '';
  const body = xml.replace(/<office:automatic-styles>[\s\S]*?<\/office:automatic-styles>/gi, '');
  return xmlText(body);
}

/** OCR a single image file (any format tesseract's leptonica reads). */
async function ocrImageBytes(bytes: Buffer, ext: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ocr-'));
  try {
    const input = path.join(dir, `in.${ext}`);
    await writeFile(input, bytes);
    // `tesseract <in> stdout` prints recognized text to stdout.
    const { stdout } = await run('tesseract', [input, 'stdout'], {
      timeout: OCR_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    const text = normalize(stdout);
    if (text.length > OCR_MAX_CHARS)
      throw new Error('OCR text exceeds the complete-document limit');
    return text;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Rasterize a scanned PDF (pdftoppm) and OCR each page (capped). */
async function parsePdfOcr(bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ocr-pdf-'));
  try {
    const pdf = path.join(dir, 'in.pdf');
    await writeFile(pdf, bytes);
    const metadata = await run('pdfinfo', [pdf], { timeout: OCR_TIMEOUT_MS, maxBuffer: 64 * 1024 });
    const pageCount = Number(/^Pages:\s+(\d+)/m.exec(metadata.stdout)?.[1]);
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > OCR_MAX_PDF_PAGES)
      throw new Error('PDF exceeds the complete OCR page limit or its page count is unavailable');
    // pdftoppm -png -r 200 in.pdf page → page-1.png, page-2.png, …
    await run(
      'pdftoppm',
      ['-png', '-r', '200', '-l', String(OCR_MAX_PDF_PAGES), pdf, path.join(dir, 'page')],
      {
        timeout: OCR_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const pageNum = (name: string) => Number.parseInt(name.match(/\d+/)?.[0] ?? '0', 10);
    const pages = (await readdir(dir))
      .filter((n) => /^page-\d+\.png$/.test(n))
      .sort((a, b) => pageNum(a) - pageNum(b));
    if (pages.length !== pageCount)
      throw new Error('OCR rasterization did not produce every PDF page');
    const out: string[] = [];
    for (const page of pages) {
      const { stdout } = await run('tesseract', [path.join(dir, page), 'stdout'], {
        timeout: OCR_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      const text = normalize(stdout);
      if (text) out.push(text);
      if (out.join('\n\n').length > OCR_MAX_CHARS)
        throw new Error('OCR text exceeds the complete-document limit');
    }
    return out.join('\n\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function imageExt(mime: string, filename: string): string {
  const fromName = filename.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  const sub = baseMime(mime).split('/')[1];
  return sub && /^[a-z0-9]+$/.test(sub) ? sub : 'png';
}

export async function extractDocument(
  bytes: Buffer,
  mime: string,
  filename: string,
): Promise<ExtractOutcome> {
  const parser = parserFor(mime, filename);
  switch (parser) {
    case 'docx':
      return { kind: 'text', text: await parseDocx(bytes), detail: 'word document' };
    case 'xlsx':
      return {
        kind: 'text',
        text: await parseXlsx(bytes),
        detail: 'spreadsheet with cell coordinates',
        structure: { complete: true, representation: 'cell-addresses' },
      };
    case 'pptx':
      return {
        kind: 'text',
        text: await parsePptx(bytes),
        detail: 'presentation in declared slide order',
        structure: { complete: true, representation: 'ordered-slides' },
      };
    case 'opendocument':
      return { kind: 'text', text: await parseOpenDocument(bytes), detail: 'opendocument' };
    case 'rtf':
      return { kind: 'text', text: stripRtf(bytes.toString('utf8')), detail: 'rtf' };
    case 'image':
      return {
        kind: 'text',
        text: await ocrImageBytes(bytes, imageExt(mime, filename)),
        detail: 'image (ocr)',
      };
    case 'pdf':
      return { kind: 'text', text: await parsePdfOcr(bytes), detail: 'scanned pdf (ocr)' };
    default:
      return {
        kind: 'unsupported',
        text: '',
        detail: `no parser for ${baseMime(mime) || filename}`,
      };
  }
}
