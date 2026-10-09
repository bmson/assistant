import { createHash } from 'node:crypto';
import {
  type DocumentExtractionCursor,
  type DocumentExtractionFence,
  type DocumentExtractionRepository,
  type EmbeddingSpace,
  type Records,
  snapshotEmbeddingSpace,
  validateEmbedding,
} from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type TaskRow = Records['tasks'];
type DocumentRow = Records['documents'];
type FileRow = Records['files'];

function chunkKey(documentId: string, index: number): string {
  return createHash('sha256').update(`${documentId}\0${index}`).digest('hex');
}

function validCursor(cursor: DocumentExtractionCursor): boolean {
  return (
    Number.isSafeInteger(cursor.index) &&
    cursor.index >= 0 &&
    Number.isSafeInteger(cursor.total) &&
    cursor.total >= cursor.index &&
    cursor.total <= 4000
  );
}

function cursorFrom(state: unknown): DocumentExtractionCursor {
  const root = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  const planner =
    root.plannerState && typeof root.plannerState === 'object'
      ? (root.plannerState as Record<string, unknown>)
      : {};
  const value =
    planner.documentExtract && typeof planner.documentExtract === 'object'
      ? (planner.documentExtract as Record<string, unknown>)
      : {};
  const index = value.index ?? 0;
  const total = value.total ?? 0;
  const embeddingSpaceKey = value.embeddingSpaceKey;
  if (
    !Number.isSafeInteger(index) ||
    (index as number) < 0 ||
    !Number.isSafeInteger(total) ||
    (total as number) < 0
  )
    throw new Error('Document extraction task cursor is malformed');
  if (
    embeddingSpaceKey !== undefined &&
    (typeof embeddingSpaceKey !== 'string' || !/^[a-f0-9]{64}$/.test(embeddingSpaceKey))
  )
    throw new Error('Document extraction task embedding space is malformed');
  return {
    index: index as number,
    total: total as number,
    ...(typeof embeddingSpaceKey === 'string' ? { embeddingSpaceKey } : {}),
  };
}

function stateWithCursor(
  state: unknown,
  cursor: DocumentExtractionCursor,
): Record<string, unknown> {
  const root = state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
  const planner =
    root.plannerState && typeof root.plannerState === 'object'
      ? { ...(root.plannerState as Record<string, unknown>) }
      : {};
  planner.documentExtract = cursor;
  root.plannerState = planner;
  return root;
}

/** Firestore extraction state writes fenced by owner, task generation, lease, and erasure. */
export class FirestoreDocumentExtractionRepository implements DocumentExtractionRepository {
  readonly kind = 'document-extraction-repository' as const;
  readonly space?: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
    /** Stamped on new chunk vectors so `documents.search` matches only this space. */
    space?: EmbeddingSpace,
  ) {
    this.space = space ? snapshotEmbeddingSpace(space) : undefined;
  }

  async load(fence: DocumentExtractionFence): Promise<{
    document: DocumentRow;
    file: FileRow | null;
  } | null> {
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readFence(tx, fence);
      if (!current) return null;
      const fileSnap = await tx.get(this.store.doc('files', current.document.fileId));
      if (!fileSnap.exists) return { document: current.document, file: null };
      const file = decodeRecord<FileRow>(fileSnap.data());
      if (
        file.id !== current.document.fileId ||
        documentKey(file.id) !== fileSnap.id ||
        file.agentId !== fence.agentId ||
        file.sha256 !== current.document.sha256 ||
        !file.workspacePath ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0
      )
        return null;
      return { document: current.document, file };
    });
  }

  private async readFence(
    tx: FirebaseFirestore.Transaction,
    fence: DocumentExtractionFence,
  ): Promise<{ task: TaskRow; document: DocumentRow } | null> {
    if (
      !this.configuredAgentId ||
      fence.agentId !== this.configuredAgentId ||
      !fence.leaseToken ||
      !Number.isSafeInteger(fence.queueGeneration) ||
      fence.queueGeneration < 0
    )
      return null;
    const owners = await tx.get(this.store.collection('agents').limit(2));
    if (
      owners.size !== 1 ||
      owners.docs[0]?.id !== documentKey(fence.agentId) ||
      owners.docs[0]?.get('id') !== fence.agentId
    )
      return null;
    const [erasure, taskSnap, documentSnap] = await tx.getAll(
      this.store.doc('privacyErasureJobs', fence.agentId),
      this.store.doc('tasks', fence.taskId),
      this.store.doc('documents', fence.documentId),
    );
    if (
      erasure?.exists &&
      (erasure.get('agentId') !== fence.agentId || privacyErasureIsActive(erasure.get('status')))
    )
      return null;
    if (!taskSnap?.exists || !documentSnap?.exists) return null;
    const task = decodeRecord<TaskRow>(taskSnap.data());
    const document = decodeRecord<DocumentRow>(documentSnap.data());
    const payload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload;
    if (
      task.id !== fence.taskId ||
      task.agentId !== fence.agentId ||
      task.status !== 'running' ||
      task.queueGeneration !== fence.queueGeneration ||
      task.leaseToken !== fence.leaseToken ||
      !task.lockedUntil ||
      task.lockedUntil.getTime() <= this.store.now().getTime() ||
      payload?.documentId !== fence.documentId ||
      !['documents.extract', 'documents.process'].includes(String(payload?.job ?? '')) ||
      document.id !== fence.documentId ||
      document.agentId !== fence.agentId ||
      !document.fileId ||
      documentKey(task.id) !== taskSnap.id ||
      documentKey(document.id) !== documentSnap.id
    )
      return null;
    return { task, document };
  }

  async begin(input: {
    fence: DocumentExtractionFence;
    extractor: string;
    cursor: DocumentExtractionCursor;
  }): Promise<boolean> {
    if (!validCursor(input.cursor)) throw new Error('Document extraction cursor is malformed');
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readFence(tx, input.fence);
      if (!current || !['pending', 'extracting'].includes(current.document.status)) return false;
      const taskCursor = cursorFrom(current.task.state);
      if (
        taskCursor.index !== input.cursor.index ||
        (taskCursor.total !== input.cursor.total &&
          !(taskCursor.index === 0 && taskCursor.total === 0)) ||
        (taskCursor.embeddingSpaceKey &&
          taskCursor.embeddingSpaceKey !== input.cursor.embeddingSpaceKey) ||
        (taskCursor.index > 0 &&
          (!taskCursor.embeddingSpaceKey ||
            taskCursor.embeddingSpaceKey !== input.cursor.embeddingSpaceKey))
      )
        return false;
      if (input.cursor.index === 0) {
        const existing = await tx.get(
          this.store
            .collection('documentChunks')
            .where('documentId', '==', input.fence.documentId)
            .limit(1),
        );
        if (!existing.empty)
          throw new Error('Cannot restart document extraction while chunks already exist');
      }
      tx.update(
        this.store.doc('documents', input.fence.documentId),
        encodeRecord({
          status: 'extracting',
          extractor: input.extractor,
          error: null,
          updatedAt: this.store.now(),
        }),
      );
      tx.update(
        this.store.doc('tasks', input.fence.taskId),
        encodeRecord({
          state: stateWithCursor(current.task.state, input.cursor),
          updatedAt: this.store.now(),
        }),
      );
      return true;
    });
  }

  async markPending(input: {
    fence: DocumentExtractionFence;
    status: 'pending' | 'unsupported';
    extractor: string;
  }): Promise<boolean> {
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readFence(tx, input.fence);
      if (!current || !['pending', 'extracting'].includes(current.document.status)) return false;
      tx.update(
        this.store.doc('documents', input.fence.documentId),
        encodeRecord({
          status: input.status,
          extractor: input.extractor,
          error: null,
          updatedAt: this.store.now(),
        }),
      );
      return true;
    });
  }

  async persistBatch(input: {
    fence: DocumentExtractionFence;
    chunks: Records['documentChunks'][];
    cursor: DocumentExtractionCursor;
    state: unknown;
    progress: string;
    progressPercent: number;
  }): Promise<boolean> {
    if (
      input.chunks.length === 0 ||
      input.chunks.length > 60 ||
      !Number.isSafeInteger(input.progressPercent) ||
      input.progressPercent < 0 ||
      input.progressPercent > 100
    )
      throw new Error('Document extraction batch is outside its persistence bounds');
    const start = input.cursor.index - input.chunks.length;
    if (
      !validCursor(input.cursor) ||
      cursorFrom(input.state).index !== input.cursor.index ||
      cursorFrom(input.state).total !== input.cursor.total ||
      start < 0 ||
      input.chunks.some(
        (chunk, offset) =>
          chunk.documentId !== input.fence.documentId ||
          chunk.agentId !== input.fence.agentId ||
          chunk.chunkIndex !== start + offset ||
          chunk.charCount !== chunk.text.length ||
          !chunk.text ||
          (chunk.embedding !== null &&
            (!this.space || chunk.embeddingSpaceKey !== embeddingSpaceKey(this.space))) ||
          (chunk.embedding !== null &&
            (chunk.embedding.length !== 1536 ||
              chunk.embedding.some((value) => !Number.isFinite(value)))),
      )
    )
      throw new Error('Document extraction batch is malformed');
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readFence(tx, input.fence);
      if (current?.document.status !== 'extracting') return false;
      const existingCursor = cursorFrom(current.task.state);
      if (existingCursor.total !== input.cursor.total || existingCursor.index > start) {
        // A retry after a committed batch is accepted only when every stored
        // deterministic chunk exactly matches; a cursor can never skip a gap.
        if (
          existingCursor.index !== input.cursor.index ||
          existingCursor.total !== input.cursor.total
        )
          return false;
      } else if (existingCursor.index !== start || existingCursor.total !== input.cursor.total)
        return false;

      const refs = input.chunks.map((chunk) =>
        this.store.doc('documentChunks', chunkKey(chunk.documentId, chunk.chunkIndex)),
      );
      const prior = await tx.getAll(...refs);
      for (let i = 0; i < prior.length; i++) {
        const snap = prior[i];
        const expected = input.chunks[i];
        if (snap?.exists) {
          const stored = decodeRecord<Records['documentChunks']>(snap.data());
          if (
            !expected ||
            stored.documentId !== expected.documentId ||
            stored.agentId !== expected.agentId ||
            stored.chunkIndex !== expected.chunkIndex ||
            stored.text !== expected.text ||
            stored.charCount !== expected.charCount ||
            JSON.stringify(stored.embedding) !== JSON.stringify(expected.embedding) ||
            stored.embeddingSpaceKey !== expected.embeddingSpaceKey
          )
            throw new Error('Document extraction retry conflicts with a stored chunk');
        } else if (existingCursor.index !== start) {
          throw new Error('Document extraction cursor has missing chunk records');
        }
      }
      const alreadyCommitted = existingCursor.index === input.cursor.index;
      for (let i = 0; i < input.chunks.length; i++) {
        if (prior[i]?.exists) continue;
        const chunk = input.chunks[i];
        const target = refs[i];
        if (!chunk || !target) continue;
        if (chunk.embedding && this.space) validateEmbedding(this.space, chunk.embedding);
        tx.create(
          target,
          encodeRecord({
            ...chunk,
            id: chunkKey(chunk.documentId, chunk.chunkIndex),
            embedding: chunk.embedding ? FieldValue.vector(chunk.embedding) : null,
            ...(chunk.embedding && this.space
              ? { embeddingSpace: embeddingSpaceKey(this.space) }
              : {}),
          }),
        );
      }
      if (!alreadyCommitted)
        tx.update(
          this.store.doc('tasks', input.fence.taskId),
          encodeRecord({
            state: input.state,
            progress: input.progress,
            progressPercent: input.progressPercent,
            reclaimCount: 0,
            updatedAt: this.store.now(),
          }),
        );
      return true;
    });
  }

  async finalize(input: {
    fence: DocumentExtractionFence;
    extractor: string;
    chunkCount: number;
    charCount: number;
    state: unknown;
  }): Promise<boolean> {
    if (
      !Number.isSafeInteger(input.chunkCount) ||
      input.chunkCount < 0 ||
      input.chunkCount > 4000 ||
      !Number.isSafeInteger(input.charCount) ||
      input.charCount < 0
    )
      throw new Error('Document extraction final state is malformed');
    const finalCursor = cursorFrom(input.state);
    if (finalCursor.index !== input.chunkCount || finalCursor.total !== input.chunkCount)
      throw new Error('Document extraction final cursor does not match its chunk count');
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readFence(tx, input.fence);
      if (current?.document.status !== 'extracting') return false;
      const cursor = cursorFrom(current.task.state);
      if (cursor.index !== input.chunkCount || cursor.total !== input.chunkCount) return false;
      tx.update(
        this.store.doc('documents', input.fence.documentId),
        encodeRecord({
          status: 'ready',
          extractor: input.extractor,
          chunkCount: input.chunkCount,
          charCount: input.charCount,
          error: null,
          updatedAt: this.store.now(),
        }),
      );
      tx.update(
        this.store.doc('tasks', input.fence.taskId),
        encodeRecord({ state: input.state, updatedAt: this.store.now() }),
      );
      return true;
    });
  }

  async fail(input: {
    fence: DocumentExtractionFence;
    error: string;
    keepStatus?: boolean;
  }): Promise<boolean> {
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readFence(tx, input.fence);
      if (!current) return false;
      tx.update(
        this.store.doc('documents', input.fence.documentId),
        encodeRecord({
          ...(input.keepStatus ? {} : { status: 'failed' }),
          error: input.error.slice(0, 2000),
          updatedAt: this.store.now(),
        }),
      );
      return true;
    });
  }
}
