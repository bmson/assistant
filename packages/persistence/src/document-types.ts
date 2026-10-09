export type DocumentExtractor = 'text' | 'pdf' | 'pending_processor' | 'unsupported';
export type DocumentTrust = 'owner' | 'known' | 'unknown' | 'assistant';
export type DocumentSource = 'upload' | 'email' | 'drive';

const TEXT_LIKE_MIMES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/csv',
  'application/x-ndjson',
  'application/x-yaml',
  'application/yaml',
  'application/markdown',
]);
const TEXT_LIKE_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ndjson|ya?ml|xml|html?|log|rst|org|tex|vtt|srt)$/i;
const CODE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|cc|cs|php|sh|sql|css|scss|toml|ini|cfg|conf)$/i;
const PDF_MIME = 'application/pdf';
const PENDING_MIME_RE = /^(image|audio|video)\//;
const PENDING_MIMES: ReadonlySet<string> = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/rtf',
]);

export function baseMime(mime: string): string {
  return (mime || '').toLowerCase().split(';')[0]?.trim() ?? '';
}

/** Pick the extraction strategy from the mime type, falling back to the filename. */
export function extractorFor(mime: string, filename: string): DocumentExtractor {
  const normalizedMime = baseMime(mime);
  const name = filename.toLowerCase();
  if (normalizedMime === PDF_MIME || name.endsWith('.pdf')) return 'pdf';
  if (
    normalizedMime.startsWith('text/') ||
    TEXT_LIKE_MIMES.has(normalizedMime) ||
    TEXT_LIKE_EXT.test(name) ||
    CODE_EXT.test(name)
  ) {
    return 'text';
  }
  if (PENDING_MIME_RE.test(normalizedMime) || PENDING_MIMES.has(normalizedMime)) {
    return 'pending_processor';
  }
  return 'unsupported';
}
