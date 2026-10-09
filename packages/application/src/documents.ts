import { createHash, randomUUID } from 'node:crypto';
import { getAgent, getOrCreatePrimaryConversation } from '@assistant/core/chat';
import {
  documentStats,
  listDocuments,
  purgeDocument,
  startDocumentIngest,
} from '@assistant/core/memory/document-catalog';
import {
  createPostgresWorkspaceFileLookup,
  type Db,
  documentChunks,
  documents,
  files,
} from '@assistant/db';
import type {
  DocumentCatalogRepository,
  DocumentChunkPageOptions,
  DocumentDeletionRepository,
  WorkspaceFileLookup,
} from '@assistant/persistence';
import { buildDocumentChunkPage, normalizeDocumentChunkPageOptions } from '@assistant/persistence';
import { and, asc, eq, gte } from 'drizzle-orm';
import { safeWorkspacePath, type WorkspacePort } from './workspace.js';

const SAFE_DOWNLOAD_PREFIXES = ['code/', 'browser/attachments/', 'documents/'];

function cleanDocumentName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'document';
}

export async function getDocumentsOverview(db: Db) {
  const agent = await getAgent(db);
  const [documents, stats, primary] = await Promise.all([
    listDocuments(db, agent.id),
    documentStats(db, agent.id),
    getOrCreatePrimaryConversation(db, agent.id),
  ]);
  return { documents, stats, primaryConversationId: primary.id };
}

export async function getDocument(
  db: Db,
  documentId: string,
  options: DocumentChunkPageOptions = {},
) {
  const pageOptions = normalizeDocumentChunkPageOptions(options);
  const startIndex =
    typeof pageOptions.cursor === 'number' ? pageOptions.cursor : pageOptions.cursor.chunkIndex;
  const agent = await getAgent(db);
  const [row] = await db
    .select({
      id: documents.id,
      title: documents.title,
      mime: documents.mime,
      source: documents.source,
      trust: documents.trust,
      status: documents.status,
      extractor: documents.extractor,
      extractionMetadata: documents.extractionMetadata,
      chunkCount: documents.chunkCount,
      charCount: documents.charCount,
      bytes: files.bytes,
      error: documents.error,
      createdAt: documents.createdAt,
      fileId: documents.fileId,
    })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .where(
      and(
        eq(documents.agentId, agent.id),
        eq(documents.id, documentId),
        eq(files.agentId, agent.id),
      ),
    )
    .limit(1);
  if (!row) return null;
  const chunks = await db
    .select({
      chunkIndex: documentChunks.chunkIndex,
      text: documentChunks.text,
      charCount: documentChunks.charCount,
    })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.agentId, agent.id),
        eq(documentChunks.documentId, documentId),
        gte(documentChunks.chunkIndex, startIndex),
      ),
    )
    .orderBy(asc(documentChunks.chunkIndex))
    .limit(pageOptions.limit + 1);
  const { fileId: _fileId, ...document } = { ...row, bytes: row.bytes ?? 0 };
  return buildDocumentChunkPage(document, chunks, pageOptions);
}

/** The configured owner's portable document stores, for Firestore mode. */
export interface PortableDocumentStores {
  agentId: string;
  catalog: DocumentCatalogRepository;
  deletion: DocumentDeletionRepository;
}

function isPortable(storage: Db | PortableDocumentStores): storage is PortableDocumentStores {
  return 'catalog' in storage && 'deletion' in storage;
}

export async function deleteDocument(
  storage: Db | PortableDocumentStores,
  workspace: WorkspacePort,
  documentId: string,
): Promise<{ deleted: boolean; pendingAssets: boolean }> {
  if (isPortable(storage)) {
    return purgeDocument(storage.deletion, storage.agentId, documentId, workspace);
  }
  const agent = await getAgent(storage);
  return purgeDocument(storage, agent.id, documentId, workspace);
}

export async function uploadDocument(
  storage: Db | PortableDocumentStores,
  workspace: WorkspacePort,
  input: { name: string; title?: string; mime?: string; bytes: Buffer },
): Promise<{ duplicate: boolean }> {
  const agent = isPortable(storage) ? { id: storage.agentId } : await getAgent(storage);
  const name = cleanDocumentName(input.name);
  const mime = input.mime || 'application/octet-stream';
  const workspacePath = safeWorkspacePath(`documents/uploads/${randomUUID()}-${name}`);
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  await workspace.writeBytes(workspacePath, input.bytes, mime);
  try {
    const result = await startDocumentIngest(isPortable(storage) ? storage.catalog : storage, {
      agentId: agent.id,
      title: input.title?.trim() || name,
      workspacePath,
      mime,
      bytes: input.bytes.length,
      sha256,
      source: 'upload',
      trust: 'owner',
    });
    if (result.duplicate) await workspace.delete(workspacePath).catch(() => {});
    return { duplicate: result.duplicate };
  } catch (error) {
    await workspace.delete(workspacePath).catch(() => {});
    throw error;
  }
}

export interface DownloadedArtifact {
  bytes: Buffer;
  contentType: string;
  filename: string;
}

export async function downloadArtifact(
  db: Db,
  workspace: WorkspacePort,
  workspacePath: string,
): Promise<DownloadedArtifact | null> {
  if (!SAFE_DOWNLOAD_PREFIXES.some((prefix) => workspacePath.startsWith(prefix))) return null;
  const agent = await getAgent(db);
  return downloadArtifactWithLookup(
    createPostgresWorkspaceFileLookup(db),
    workspace,
    agent.id,
    workspacePath,
  );
}

/** Stream an owner artifact only when a `files` record for that exact path exists. */
export async function downloadArtifactWithLookup(
  lookup: WorkspaceFileLookup,
  workspace: WorkspacePort,
  agentId: string,
  workspacePath: string,
): Promise<DownloadedArtifact | null> {
  if (!SAFE_DOWNLOAD_PREFIXES.some((prefix) => workspacePath.startsWith(prefix))) return null;
  const row = await lookup.findOwned(agentId, workspacePath);
  if (!row) return null;
  const bytes = await workspace.readBytes(workspacePath).catch(() => null);
  if (!bytes) return null;
  return {
    bytes,
    contentType: row.mime || 'application/octet-stream',
    filename: (workspacePath.split('/').pop() ?? 'file').replace(/[\r\n"]/g, '_'),
  };
}
