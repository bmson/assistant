import type {
  DocumentCatalogOverview,
  DocumentCatalogReadRepository,
  DocumentCatalogView,
  DocumentChunkPage,
  DocumentChunkPageOptions,
  DocumentChunkView,
} from '@assistant/persistence';
import { buildDocumentChunkPage, normalizeDocumentChunkPageOptions } from '@assistant/persistence';
import { AggregateField, FieldPath } from '@google-cloud/firestore';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const DOCUMENT_PAGE_SIZE = 200;
const MAX_DOCUMENTS = 5_000;
const DOCUMENT_LIST_LIMIT = 200;
const DOCUMENT_PAGE_LIMIT = 100;

export type FirestoreDocumentView = DocumentCatalogView;
export type FirestoreDocumentChunkView = DocumentChunkView;

type DocumentRow = FirestoreDocumentView & { agentId: string; fileId: string };
type FileRow = { id: string; agentId: string; bytes?: number | null };
type ChunkRow = {
  id: string;
  agentId: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  charCount: number;
};

async function assertConfiguredOwner(store: InstallationStore, agentId: string) {
  const agents = await store.collection('agents').limit(2).get();
  const owner = agents.docs[0];
  if (
    !agentId ||
    agents.size !== 1 ||
    !owner ||
    owner.id !== documentKey(agentId) ||
    owner.get('id') !== agentId
  )
    throw new Error('Documents require exactly one configured agent');
}

function owned<T extends { id: string; agentId: string }>(
  snapshot: FirebaseFirestore.QueryDocumentSnapshot,
  agentId: string,
): T | null {
  const row = decodeRecord<T>(snapshot.data());
  return row.agentId === agentId && documentKey(row.id) === snapshot.id ? row : null;
}

/** SQL-free Documents reads scoped to the configured installation owner. */
export class FirestoreDocumentReadRepository implements DocumentCatalogReadRepository {
  readonly kind = 'document-catalog-read-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async list(agentId: string): Promise<DocumentCatalogOverview> {
    if (!agentId || agentId !== this.configuredAgentId)
      throw new Error('Document read is outside the configured installation');
    await assertConfiguredOwner(this.store, agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const [allRows, primarySnapshot] = await Promise.all([
      this.readOwnerDocuments(agentId),
      this.store
        .collection('conversations')
        .where('agentId', '==', agentId)
        .where('isPrimary', '==', true)
        .limit(2)
        .get(),
    ]);
    if (primarySnapshot.size > 1)
      throw new Error('Documents found multiple primary conversations for the configured agent');
    const primaryDoc = primarySnapshot.docs[0];
    const primaryConversation = primaryDoc
      ? owned<{ id: string; agentId: string }>(primaryDoc, agentId)
      : null;
    let primaryConversationId: string | null = null;
    if (primaryDoc) {
      const conversation = decodeRecord<{
        id: string;
        agentId: string;
        channel: string;
        isPrimary: boolean;
      }>(primaryDoc.data());
      if (
        !primaryConversation ||
        conversation.channel !== 'chat' ||
        conversation.isPrimary !== true
      )
        throw new Error('Documents found an invalid primary conversation for the configured agent');
      primaryConversationId = conversation.id;
    }
    const stats = allRows.reduce(
      (result, row) => ({
        total: result.total + 1,
        ready: result.ready + (row.status === 'ready' ? 1 : 0),
        pending: result.pending + (row.status === 'pending' || row.status === 'extracting' ? 1 : 0),
        chunks: result.chunks + row.chunkCount,
      }),
      { total: 0, ready: 0, pending: 0, chunks: 0 },
    );
    const rows = allRows
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, DOCUMENT_LIST_LIMIT);
    const fileSnapshots = rows.length
      ? await this.store.db.getAll(...rows.map((row) => this.store.doc('files', row.fileId)))
      : [];
    const fileMap = new Map<string, FileRow>();
    for (const snapshot of fileSnapshots) {
      if (!snapshot.exists) continue;
      const file = decodeRecord<FileRow>(snapshot.data());
      if (file.agentId === agentId && documentKey(file.id) === snapshot.id)
        fileMap.set(file.id, file);
    }
    const listed = rows.map((row) => {
      const file = fileMap.get(row.fileId);
      if (!file)
        throw new Error(`Documents could not verify file ownership for document ${row.id}`);
      return {
        ...row,
        bytes: file.bytes ?? 0,
        error: typeof row.error === 'string' ? row.error : null,
      };
    });
    await assertConfiguredOwner(this.store, agentId);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return {
      documents: listed.map(({ agentId: _agentId, fileId: _fileId, ...row }) => row),
      stats,
      primaryConversationId,
    };
  }

  /** Reads one bounded owner page without scanning the full catalog. */
  async listPage(
    agentId: string,
    input: { limit: number; after?: { id: string; createdAt: Date } },
  ) {
    if (!agentId || agentId !== this.configuredAgentId)
      throw new Error('Document read is outside the configured installation');
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > DOCUMENT_PAGE_LIMIT)
      throw new Error('Document page size must be between 1 and 100');
    if (
      input.after &&
      (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.after.id) ||
        !(input.after.createdAt instanceof Date) ||
        !Number.isFinite(input.after.createdAt.getTime()))
    )
      throw new Error('Invalid document continuation');
    await assertConfiguredOwner(this.store, agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const ownedDocuments = this.store.collection('documents').where('agentId', '==', agentId);
    let query = ownedDocuments.orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
    if (input.after) query = query.startAfter(input.after.createdAt, documentKey(input.after.id));
    const [page, totals, ready, pending, extracting, primarySnapshot] = await Promise.all([
      query.limit(input.limit + 1).get(),
      ownedDocuments
        .aggregate({ total: AggregateField.count(), chunks: AggregateField.sum('chunkCount') })
        .get(),
      ownedDocuments.where('status', '==', 'ready').count().get(),
      ownedDocuments.where('status', '==', 'pending').count().get(),
      ownedDocuments.where('status', '==', 'extracting').count().get(),
      this.store
        .collection('conversations')
        .where('agentId', '==', agentId)
        .where('isPrimary', '==', true)
        .limit(2)
        .get(),
    ]);
    if (primarySnapshot.size > 1)
      throw new Error('Documents found multiple primary conversations for the configured agent');
    const primaryDoc = primarySnapshot.docs[0];
    let primaryConversationId: string | null = null;
    if (primaryDoc) {
      const primary = decodeRecord<{
        id: string;
        agentId: string;
        channel: string;
        isPrimary: boolean;
      }>(primaryDoc.data());
      if (
        primaryDoc.id !== documentKey(primary.id) ||
        primary.agentId !== agentId ||
        primary.channel !== 'chat' ||
        primary.isPrimary !== true
      )
        throw new Error('Documents found an invalid primary conversation for the configured agent');
      primaryConversationId = primary.id;
    }
    const selected = page.docs.slice(0, input.limit).map((snapshot) => {
      const row = owned<DocumentRow>(snapshot, agentId);
      if (!row || !(row.createdAt instanceof Date) || !Number.isFinite(row.createdAt.getTime()))
        throw new Error('Documents contains a row with invalid owner, identity, or date');
      return row;
    });
    const fileSnapshots = selected.length
      ? await this.store.db.getAll(...selected.map((row) => this.store.doc('files', row.fileId)))
      : [];
    const fileMap = new Map<string, FileRow>();
    for (const snapshot of fileSnapshots) {
      if (!snapshot.exists) continue;
      const file = decodeRecord<FileRow>(snapshot.data());
      if (file.agentId === agentId && documentKey(file.id) === snapshot.id)
        fileMap.set(file.id, file);
    }
    const documents = selected.map((row) => {
      const file = fileMap.get(row.fileId);
      if (!file)
        throw new Error(`Documents could not verify file ownership for document ${row.id}`);
      const { agentId: _agentId, fileId: _fileId, ...view } = row;
      return {
        ...view,
        bytes: file.bytes ?? 0,
        error: typeof row.error === 'string' ? row.error : null,
      };
    });
    await assertConfiguredOwner(this.store, agentId);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    const tail = selected.at(-1);
    return {
      documents,
      stats: {
        total: totals.data().total,
        ready: ready.data().count,
        pending: pending.data().count + extracting.data().count,
        chunks: totals.data().chunks,
      },
      primaryConversationId,
      hasMore: page.size > input.limit,
      nextCursor:
        page.size > input.limit && tail ? { id: tail.id, createdAt: tail.createdAt } : null,
    };
  }

  async get(
    agentId: string,
    id: string,
    options: DocumentChunkPageOptions = {},
  ): Promise<DocumentChunkPage | null> {
    if (!agentId || agentId !== this.configuredAgentId)
      throw new Error('Document read is outside the configured installation');
    const pageOptions = normalizeDocumentChunkPageOptions(options);
    const startIndex =
      typeof pageOptions.cursor === 'number' ? pageOptions.cursor : pageOptions.cursor.chunkIndex;
    await assertConfiguredOwner(this.store, agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store.doc('documents', id).get();
    const row = snapshot.exists
      ? owned<DocumentRow>(snapshot as FirebaseFirestore.QueryDocumentSnapshot, agentId)
      : null;
    if (!row) {
      await assertConfiguredOwner(this.store, agentId);
      await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
      return null;
    }
    const [fileSnapshot, chunkSnapshot] = await Promise.all([
      this.store.doc('files', row.fileId).get(),
      this.store
        .collection('documentChunks')
        .where('agentId', '==', agentId)
        .where('documentId', '==', id)
        .where('chunkIndex', '>=', startIndex)
        .orderBy('chunkIndex')
        .limit(pageOptions.limit + 1)
        .get(),
    ]);
    const file = fileSnapshot.exists ? decodeRecord<FileRow>(fileSnapshot.data()) : null;
    if (!file || file.agentId !== agentId || file.id !== row.fileId)
      throw new Error(`Documents could not verify file ownership for document ${row.id}`);
    const chunks = chunkSnapshot.docs.flatMap((doc) => {
      const chunk = owned<ChunkRow>(doc, agentId);
      if (!chunk || chunk.documentId !== id)
        throw new Error('Document detail contains a chunk with invalid owner or identity');
      return [
        {
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          charCount: chunk.charCount,
        },
      ];
    });
    await assertConfiguredOwner(this.store, agentId);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    const {
      agentId: _agentId,
      fileId: _fileId,
      ...document
    } = {
      ...row,
      bytes: file.bytes ?? 0,
      error: typeof row.error === 'string' ? row.error : null,
    };
    return buildDocumentChunkPage(document, chunks, pageOptions);
  }

  private async readOwnerDocuments(agentId: string): Promise<DocumentRow[]> {
    const query = this.store
      .collection('documents')
      .where('agentId', '==', agentId)
      .orderBy(FieldPath.documentId());
    const rows: DocumentRow[] = [];
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    let scanned = 0;
    for (;;) {
      const page = await (cursor ? query.startAfter(cursor) : query)
        .limit(DOCUMENT_PAGE_SIZE)
        .get();
      scanned += page.size;
      if (scanned > MAX_DOCUMENTS) throw new Error('Documents exceed the bounded owner scan limit');
      for (const snapshot of page.docs) {
        const row = owned<DocumentRow>(snapshot, agentId);
        if (!row) throw new Error('Documents contains a row with invalid owner or identity');
        rows.push(row);
      }
      if (page.size < DOCUMENT_PAGE_SIZE) return rows;
      cursor = page.docs.at(-1);
      if (!cursor) throw new Error('Documents owner scan cursor did not advance');
    }
  }
}
