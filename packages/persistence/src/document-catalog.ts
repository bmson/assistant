import { createHash } from 'node:crypto';
import type { DocumentExtractionMetadata } from './document-extraction-metadata.js';
import type { Records } from './records.js';

export type DocumentCatalogView = {
  id: string;
  title: string;
  mime: string;
  source: string;
  trust: string;
  status: string;
  extractor: string;
  extractionMetadata?: DocumentExtractionMetadata | null;
  chunkCount: number;
  charCount: number;
  bytes: number;
  error: string | null;
  createdAt: Date;
};

export type DocumentChunkView = { chunkIndex: number; text: string; charCount: number };

export type DocumentChunkOffsetCursor = {
  documentId: string;
  chunkIndex: number;
  offset: number;
  revision: string;
};

export type DocumentChunkPageCursor = number | string | DocumentChunkOffsetCursor;
export type DocumentChunkPageNextCursor = number | string;

export type DocumentChunkPageOptions = {
  /** Inclusive chunkIndex to start from, or an exact UTF-16 continuation within a chunk. */
  cursor?: DocumentChunkPageCursor;
  limit?: number;
  maxResponseBytes?: number;
};

export type DocumentChunkPage = {
  document: DocumentCatalogView;
  chunks: Array<
    DocumentChunkView & { fragment?: { offset: number; totalChars: number; complete: boolean } }
  >;
  nextCursor: DocumentChunkPageNextCursor | null;
  totalChunks: number;
};

export const DEFAULT_DOCUMENT_CHUNK_PAGE_SIZE = 100;
export const MAX_DOCUMENT_CHUNK_PAGE_SIZE = 200;
export const DEFAULT_DOCUMENT_CHUNK_PAGE_BYTES = 128 * 1024;
export const MAX_DOCUMENT_CHUNK_PAGE_BYTES = 256 * 1024;

export class DocumentChunkPageTooLargeError extends Error {
  readonly name = 'DocumentChunkPageTooLargeError';

  constructor(
    readonly chunkIndex: number,
    readonly maxResponseBytes: number,
    readonly document: DocumentCatalogView,
  ) {
    super(`Document passage ${chunkIndex} exceeds the ${maxResponseBytes}-byte page limit`);
  }
}

export class DocumentChunkCursorStaleError extends Error {
  readonly name = 'DocumentChunkCursorStaleError';

  constructor(readonly chunkIndex: number) {
    super(`Document passage ${chunkIndex} changed while it was being read`);
  }
}

export function encodeDocumentChunkOffsetCursor(cursor: DocumentChunkOffsetCursor): string {
  if (
    !cursor.documentId ||
    !Number.isSafeInteger(cursor.chunkIndex) ||
    cursor.chunkIndex < 0 ||
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 0 ||
    !/^[a-f0-9]{64}$/.test(cursor.revision)
  )
    throw new RangeError('Invalid document passage continuation cursor');
  return `v1~${encodeURIComponent(cursor.documentId)}~${cursor.chunkIndex}~${cursor.offset}~${cursor.revision}`;
}

export function decodeDocumentChunkOffsetCursor(value: string): DocumentChunkOffsetCursor {
  const match = /^v1~([^~]{1,200})~(\d{1,10})~(\d{1,12})~([a-f0-9]{64})$/.exec(value);
  if (!match) throw new RangeError('Invalid document passage continuation cursor');
  let documentId: string;
  try {
    documentId = decodeURIComponent(match[1] ?? '');
  } catch {
    throw new RangeError('Invalid document passage continuation cursor');
  }
  const cursor = {
    documentId,
    chunkIndex: Number(match[2]),
    offset: Number(match[3]),
    revision: match[4] ?? '',
  };
  if (
    !documentId ||
    !Number.isSafeInteger(cursor.chunkIndex) ||
    !Number.isSafeInteger(cursor.offset)
  )
    throw new RangeError('Invalid document passage continuation cursor');
  return cursor;
}

function chunkRevision(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function normalizeDocumentChunkPageOptions(options: DocumentChunkPageOptions = {}) {
  const rawCursor = options.cursor ?? 0;
  const cursor =
    typeof rawCursor === 'string' ? decodeDocumentChunkOffsetCursor(rawCursor) : rawCursor;
  if (typeof cursor === 'number' && (!Number.isSafeInteger(cursor) || cursor < 0))
    throw new RangeError('Document chunk cursor must be a nonnegative integer');
  if (
    typeof cursor !== 'number' &&
    (!cursor.documentId ||
      !Number.isSafeInteger(cursor.chunkIndex) ||
      cursor.chunkIndex < 0 ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      !/^[a-f0-9]{64}$/.test(cursor.revision))
  )
    throw new RangeError('Invalid document passage continuation cursor');
  const requestedLimit = options.limit ?? DEFAULT_DOCUMENT_CHUNK_PAGE_SIZE;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1)
    throw new RangeError('Document chunk page limit must be a positive integer');
  const requestedBytes = options.maxResponseBytes ?? DEFAULT_DOCUMENT_CHUNK_PAGE_BYTES;
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 1)
    throw new RangeError('Document chunk response byte limit must be positive');
  return {
    cursor,
    limit: Math.min(requestedLimit, MAX_DOCUMENT_CHUNK_PAGE_SIZE),
    maxResponseBytes: Math.min(requestedBytes, MAX_DOCUMENT_CHUNK_PAGE_BYTES),
  };
}

/** Add whole passages until either the item or serialized response byte bound is reached. */
export function buildDocumentChunkPage(
  document: DocumentCatalogView,
  candidates: DocumentChunkView[],
  options: DocumentChunkPageOptions = {},
): DocumentChunkPage {
  const normalized = normalizeDocumentChunkPageOptions(options);
  const startIndex =
    typeof normalized.cursor === 'number' ? normalized.cursor : normalized.cursor.chunkIndex;
  const available = candidates
    .filter((chunk) => chunk.chunkIndex >= startIndex)
    .sort((a, b) => a.chunkIndex - b.chunkIndex);
  if (typeof normalized.cursor !== 'number') {
    const cursorOffset = normalized.cursor.offset;
    if (normalized.cursor.documentId !== document.id)
      throw new RangeError('Document continuation cursor belongs to another document');
    const current = available[0];
    if (
      !current ||
      current.chunkIndex !== normalized.cursor.chunkIndex ||
      chunkRevision(current.text) !== normalized.cursor.revision ||
      cursorOffset >= current.text.length ||
      (cursorOffset > 0 &&
        cursorOffset < (current?.text.length ?? 0) &&
        current?.text.charCodeAt(cursorOffset - 1) >= 0xd800 &&
        current?.text.charCodeAt(cursorOffset - 1) <= 0xdbff &&
        current?.text.charCodeAt(cursorOffset) >= 0xdc00 &&
        current?.text.charCodeAt(cursorOffset) <= 0xdfff)
    )
      throw new DocumentChunkCursorStaleError(normalized.cursor.chunkIndex);
  }
  const chunks: DocumentChunkPage['chunks'] = [];
  const payloadBytes = (
    pageChunks: DocumentChunkPage['chunks'],
    nextCursor: DocumentChunkPageNextCursor | null,
  ) =>
    new TextEncoder().encode(
      JSON.stringify({
        document,
        chunks: pageChunks,
        nextCursor,
        totalChunks: document.chunkCount,
      }),
    ).byteLength;

  const initialCursor: DocumentChunkPageNextCursor | null =
    typeof normalized.cursor === 'number'
      ? (available[0]?.chunkIndex ?? null)
      : encodeDocumentChunkOffsetCursor(normalized.cursor);
  if (payloadBytes([], initialCursor) > normalized.maxResponseBytes)
    throw new DocumentChunkPageTooLargeError(
      available[0]?.chunkIndex ?? startIndex,
      normalized.maxResponseBytes,
      document,
    );

  for (let index = 0; index < available.length && chunks.length < normalized.limit; index++) {
    const chunk = available[index];
    if (!chunk) continue;
    const continuationCursor = typeof normalized.cursor === 'number' ? null : normalized.cursor;
    const isContinuation = index === 0 && continuationCursor?.chunkIndex === chunk.chunkIndex;
    const startOffset = isContinuation ? (continuationCursor?.offset ?? 0) : 0;
    const revision = isContinuation
      ? (continuationCursor?.revision ?? chunkRevision(chunk.text))
      : chunkRevision(chunk.text);
    const nextChunk = available[index + 1];
    const nextChunkCursor = nextChunk?.chunkIndex ?? null;
    const wholeText = chunk.text.slice(startOffset);
    const wholeChunk: DocumentChunkPage['chunks'][number] = {
      chunkIndex: chunk.chunkIndex,
      text: wholeText,
      charCount: wholeText.length,
      ...(isContinuation
        ? { fragment: { offset: startOffset, totalChars: chunk.text.length, complete: true } }
        : {}),
    };
    if (payloadBytes([...chunks, wholeChunk], nextChunkCursor) <= normalized.maxResponseBytes) {
      chunks.push(wholeChunk);
      continue;
    }
    // A large legacy passage is emitted as whole-code-point fragments. Find
    // the largest prefix that fits the exact serialized response envelope.
    let low = startOffset + 1;
    // JSON emits at least one byte per UTF-16 code unit, so a prefix longer
    // than the entire response budget cannot fit. This also bounds work for a
    // single legacy chunk whose text can be much larger than one response.
    let high = Math.min(chunk.text.length, startOffset + normalized.maxResponseBytes);
    let bestEnd = startOffset;
    let bestCursor: DocumentChunkPageNextCursor | null = null;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const splitsSurrogatePair =
        mid > startOffset &&
        mid < chunk.text.length &&
        chunk.text.charCodeAt(mid - 1) >= 0xd800 &&
        chunk.text.charCodeAt(mid - 1) <= 0xdbff &&
        chunk.text.charCodeAt(mid) >= 0xdc00 &&
        chunk.text.charCodeAt(mid) <= 0xdfff;
      const end = splitsSurrogatePair ? mid - 1 : mid;
      if (end <= bestEnd) {
        low = mid + 1;
        continue;
      }
      const hasRemainder = end < chunk.text.length;
      const candidateCursor: DocumentChunkPageNextCursor | null = hasRemainder
        ? encodeDocumentChunkOffsetCursor({
            documentId: document.id,
            chunkIndex: chunk.chunkIndex,
            offset: end,
            revision,
          })
        : nextChunkCursor;
      const fragment = {
        chunkIndex: chunk.chunkIndex,
        text: chunk.text.slice(startOffset, end),
        charCount: end - startOffset,
        fragment: { offset: startOffset, totalChars: chunk.text.length, complete: !hasRemainder },
      };
      if (payloadBytes([...chunks, fragment], candidateCursor) <= normalized.maxResponseBytes) {
        bestEnd = end;
        bestCursor = candidateCursor;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (bestEnd === startOffset) {
      if (chunks.length > 0) break;
      throw new DocumentChunkPageTooLargeError(
        chunk.chunkIndex,
        normalized.maxResponseBytes,
        document,
      );
    }
    chunks.push({
      chunkIndex: chunk.chunkIndex,
      text: chunk.text.slice(startOffset, bestEnd),
      charCount: bestEnd - startOffset,
      fragment: {
        offset: startOffset,
        totalChars: chunk.text.length,
        complete: bestEnd === chunk.text.length,
      },
    });
    return { document, chunks, nextCursor: bestCursor, totalChunks: document.chunkCount };
  }
  const nextCursor = available[chunks.length]?.chunkIndex ?? null;
  return {
    document,
    chunks,
    nextCursor,
    totalChunks: document.chunkCount,
  };
}

export type DocumentCatalogOverview = {
  documents: DocumentCatalogView[];
  stats: { total: number; ready: number; pending: number; chunks: number };
  primaryConversationId: string | null;
};

/** Read methods share the same owner-scoped DTO contract across persistence drivers. */
export interface DocumentCatalogReadRepository {
  readonly kind: 'document-catalog-read-repository';
  list(agentId: string): Promise<DocumentCatalogOverview>;
  get(
    agentId: string,
    documentId: string,
    options?: DocumentChunkPageOptions,
  ): Promise<DocumentChunkPage | null>;
}

/**
 * Durable record boundary for filing source bytes and a document before an
 * extractor is scheduled. Implementations must persist the file and document
 * together and report content-hash duplicates without creating a second file.
 * Blob storage and processor/task lifecycle belong to the caller.
 */
export interface DocumentCatalogRepository {
  readonly kind: 'document-catalog-repository';
  createDocumentCatalog(input: {
    file: Records['files'];
    document: Records['documents'];
  }): Promise<{
    document: Records['documents'];
    duplicate: boolean;
    task: { id: string; queueGeneration: number } | null;
  }>;
}

/** Lease fence required for every durable extraction lifecycle mutation. */
export type DocumentExtractionFence = {
  agentId: string;
  documentId: string;
  taskId: string;
  queueGeneration: number;
  leaseToken: string;
};

export type DocumentExtractionCursor = { index: number; total: number; embeddingSpaceKey?: string };

/**
 * Persistence boundary used by the document extractor. A chunk batch and its
 * task cursor must commit atomically; implementations must reject stale task
 * generations/leases, foreign owners, and active privacy erasures.
 */
export interface DocumentExtractionRepository {
  readonly kind: 'document-extraction-repository';
  load(fence: DocumentExtractionFence): Promise<{
    document: Records['documents'];
    file: Records['files'] | null;
  } | null>;
  begin(input: {
    fence: DocumentExtractionFence;
    extractor: string;
    cursor: DocumentExtractionCursor;
  }): Promise<boolean>;
  markPending(input: {
    fence: DocumentExtractionFence;
    status: 'pending' | 'unsupported';
    extractor: string;
  }): Promise<boolean>;
  persistBatch(input: {
    fence: DocumentExtractionFence;
    chunks: Records['documentChunks'][];
    cursor: DocumentExtractionCursor;
    state: unknown;
    progress: string;
    progressPercent: number;
  }): Promise<boolean>;
  finalize(input: {
    fence: DocumentExtractionFence;
    extractor: string;
    chunkCount: number;
    charCount: number;
    state: unknown;
  }): Promise<boolean>;
  fail(input: {
    fence: DocumentExtractionFence;
    error: string;
    keepStatus?: boolean;
  }): Promise<boolean>;
}

export interface DocumentSearchHit {
  documentId: string;
  title: string;
  source: string;
  trust: string;
  chunkIndex: number;
  text: string;
  similarity: number;
}

/** Nearest passages across the owner's ready documents (the `documents.search` tool). */
export interface DocumentSearchRepository {
  readonly kind: 'document-search-repository';
  search(input: {
    agentId: string;
    embedding: number[];
    embeddingSpaceKey: string;
    limit: number;
    documentId?: string;
    minSimilarity: number;
  }): Promise<DocumentSearchHit[]>;
}

export interface ProcessableDocument {
  id: string;
  agentId: string;
  title: string;
  mime: string;
  extractor: string;
  workspacePath: string;
}

export type DocumentProcessorRecordOutcome =
  | {
      ok: true;
      documentId: string;
      agentId: string;
      extract: boolean;
      replayed?: boolean;
      wake?: { id: string; queueGeneration: number };
    }
  | { ok: false; status: 404 | 409 | 403 | 410 | 503; error: string; cleanupPath?: string };

/**
 * The heavy-format processor lifecycle (`documents.process` and its one-shot
 * callback). Launches are atomic claims keyed on a callback-token hash, so two
 * overlapping sweeps never launch one document twice and a replayed callback
 * returns the same result without creating more work.
 */
export interface DocumentProcessorRepository {
  readonly kind: 'document-processor-repository';
  /** Fail pending processor documents that used up their launches; returns how many. */
  retireExhausted(maxAttempts: number, now: Date, staleBefore: Date): Promise<number>;
  /** Pending processor documents whose run is missing or started before `staleBefore`. */
  claimable(input: {
    documentId?: string;
    staleBefore: Date;
    limit: number;
  }): Promise<ProcessableDocument[]>;
  /** Claim one for a launch; false when another sweep claimed it first. */
  claim(
    id: string,
    input: { tokenHash: string; now: Date; staleBefore: Date; maxAttempts: number },
  ): Promise<boolean>;
  /** Release a claim after a definite launch failure, so the next sweep retries. */
  release(id: string, now: Date, expectedTokenHash: string): Promise<void>;
  /**
   * Verify the callback token and record the worker's outcome, clearing the
   * token. The successful document update and its deduplicated extraction
   * task commit atomically (with a first wake on adapters
   * that use wake intents). Identical callbacks return the retained task receipt.
   */
  recordResult(input: {
    documentId: string;
    tokenHash: string;
    resultDigest: string;
    tokenMatches: (storedHash: string) => boolean;
    ok: boolean;
    unsupported: boolean;
    error: string;
    processedTextPath: string;
    extractionMetadata?: DocumentExtractionMetadata | null;
    now: Date;
  }): Promise<DocumentProcessorRecordOutcome>;
  /** A verified late callback removes its worker output and releases the retained delete fence. */
  resolveDeletedCallback(input: {
    documentId: string;
    tokenMatches: (storedHash: string) => boolean;
    processedTextPath: string;
  }): Promise<boolean>;
}
