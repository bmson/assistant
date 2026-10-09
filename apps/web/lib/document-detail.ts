import { isModuleEnabled, loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { FirestoreDocumentReadRepository } from '@assistant/firestore';
import {
  DocumentChunkCursorStaleError,
  type DocumentChunkPageOptions,
  DocumentChunkPageTooLargeError,
  decodeDocumentChunkOffsetCursor,
  normalizeDocumentChunkPageOptions,
} from '@assistant/persistence';
import { getApplication, getFirestoreInstallationStore } from '@/lib/server';

export function documentPageOptionsFromUrl(
  url: string,
  documentId?: string,
): DocumentChunkPageOptions {
  const params = new URL(url).searchParams;
  const readInteger = (name: string): number | undefined => {
    const value = params.get(name);
    if (value === null) return undefined;
    if (!/^\d{1,10}$/.test(value)) throw new RangeError(`Invalid ${name}`);
    return Number(value);
  };
  const rawCursor = params.get('cursor');
  let cursor: DocumentChunkPageOptions['cursor'];
  if (rawCursor !== null) {
    if (/^\d{1,10}$/.test(rawCursor)) cursor = Number(rawCursor);
    else {
      cursor = decodeDocumentChunkOffsetCursor(rawCursor);
      if (documentId && cursor.documentId !== documentId)
        throw new RangeError('Document continuation cursor belongs to another document');
    }
  }
  return normalizeDocumentChunkPageOptions({
    cursor,
    limit: readInteger('limit'),
  });
}

export async function readConfiguredDocument(id: string, options: DocumentChunkPageOptions) {
  const config = loadConfig();
  if (!isModuleEnabled(config, 'documents')) throw new Error('Documents module is disabled');
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    return new FirestoreDocumentReadRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    ).get(config.FIRESTORE_AGENT_ID, id, options);
  }
  return getApplication().getDocument(id, options);
}

export function documentDetailErrorResponse(error: unknown): Response {
  if (error instanceof DocumentChunkCursorStaleError) {
    return Response.json(
      {
        error: {
          code: 'document_chunk_changed',
          message: 'This passage changed while it was being read. Reload the passages to continue.',
          chunkIndex: error.chunkIndex,
        },
        restartCursor: error.chunkIndex,
      },
      { status: 409, headers: { 'cache-control': 'no-store' } },
    );
  }
  if (error instanceof DocumentChunkPageTooLargeError) {
    return Response.json(
      {
        error: {
          code: 'document_chunk_exceeds_page_limit',
          message: error.message,
          chunkIndex: error.chunkIndex,
          maxResponseBytes: error.maxResponseBytes,
        },
        document: error.document,
        nextCursor: error.chunkIndex,
        totalChunks: error.document.chunkCount,
      },
      { status: 413, headers: { 'cache-control': 'no-store' } },
    );
  }
  return Response.json(
    { error: error instanceof Error ? error.message : 'Document detail could not be read.' },
    { status: 503, headers: { 'cache-control': 'no-store' } },
  );
}
