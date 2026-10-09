/**
 * Pure text/markup helpers for the document parsers — no heavyweight imports, so
 * they load fast and are unit-testable on their own. The format parsers in
 * extract.ts build on these.
 */

const MAX_TEXT_CHARS = 8 * 1024 * 1024;

export function baseMime(mime: string): string {
  return (mime || '').toLowerCase().split(';')[0]?.trim() ?? '';
}

function codePoint(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => codePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(Number.parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Concatenate the inner text of every `<tag ...>…</tag>` occurrence (non-greedy). */
export function extractTagContents(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null = re.exec(xml);
  while (m) {
    out.push(decodeXmlEntities((m[1] ?? '').replace(/<[^>]+>/g, '')));
    m = re.exec(xml);
  }
  return out;
}

/** Strip every tag to plain text (used for OpenDocument content.xml bodies). */
export function xmlText(xml: string): string {
  const withBreaks = xml
    .replace(/<\/(text:p|text:h|table:table-row|w:p)>/gi, '\n')
    .replace(/<text:tab\b[^>]*\/?>/gi, '\t');
  return normalize(decodeXmlEntities(withBreaks.replace(/<[^>]+>/g, ' ')));
}

/** A pragmatic RTF → text stripper: drop the header/control groups, decode
 *  \'hh escapes and paragraph breaks, then remove remaining control words. */
export function stripRtf(rtf: string): string {
  let s = removeRtfGroups(rtf, [
    'fonttbl',
    'colortbl',
    'stylesheet',
    'info',
    'pict',
    'themedata',
    'colorschememapping',
    'latentstyles',
    'listtable',
    'listoverridetable',
    'rsidtbl',
    'generator',
    '*',
  ]);
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
  s = s.replace(/\\(par|line|sect|page|pard)\b ?/g, '\n').replace(/\\tab\b ?/g, '\t');
  s = s.replace(/\\[a-zA-Z]+-?\d* ?/g, ''); // other control words (+ optional numeric arg)
  s = s.replace(/\\[^a-zA-Z]/g, ''); // control symbols (\{ \} \\ …)
  s = s.replace(/[{}]/g, '');
  return normalize(s);
}

/** Remove balanced RTF groups whose head control word is in `heads`. */
function removeRtfGroups(s: string, heads: string[]): string {
  const headRe = new RegExp(`^\\\\(${heads.map((h) => (h === '*' ? '\\*' : h)).join('|')})\\b`);
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '{' && s[i - 1] !== '\\') {
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === '\\') {
          j++; // skip the escaped next char
          continue;
        }
        if (s[j] === '{') depth++;
        else if (s[j] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      const inner = s.slice(i + 1, j);
      if (headRe.test(inner)) {
        i = j + 1;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

export function normalize(text: string): string {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (normalized.length > MAX_TEXT_CHARS)
    throw new Error(
      'Extracted document exceeds the complete-text limit; no truncated text was published',
    );
  return normalized;
}

// ── Format routing ───────────────────────────────────────────────────────────

export type Parser =
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'opendocument'
  | 'rtf'
  | 'image'
  | 'pdf'
  | 'unsupported';

const BY_MIME: Record<string, Parser> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'opendocument',
  'application/vnd.oasis.opendocument.spreadsheet': 'opendocument',
  'application/vnd.oasis.opendocument.presentation': 'opendocument',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'application/pdf': 'pdf',
};

const BY_EXT: Array<[RegExp, Parser]> = [
  [/\.docx$/i, 'docx'],
  [/\.xlsx$/i, 'xlsx'],
  [/\.pptx$/i, 'pptx'],
  [/\.(odt|ods|odp)$/i, 'opendocument'],
  [/\.rtf$/i, 'rtf'],
  [/\.pdf$/i, 'pdf'],
  [/\.(png|jpe?g|gif|webp|bmp|tiff?)$/i, 'image'],
];

export function parserFor(mime: string, filename: string): Parser {
  if (baseMime(mime).startsWith('image/')) return 'image';
  const byMime = BY_MIME[baseMime(mime)];
  if (byMime) return byMime;
  for (const [re, parser] of BY_EXT) if (re.test(filename)) return parser;
  return 'unsupported';
}
