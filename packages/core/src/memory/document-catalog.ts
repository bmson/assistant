import { createHash, randomUUID } from 'node:crypto';
import {
  createPostgresPrivacyErasureRepository,
  type Db,
  type DocumentRow,
  documentChunks,
  documents,
  emailAttachmentCustodies,
  files,
  lockPostgresPrivacyObservationFence,
  maintenanceCursors,
  tasks,
} from '@assistant/db';
import type {
  DocumentCatalogRepository,
  DocumentDeletionRepository,
  DocumentExtractionMetadata,
  Records,
} from '@assistant/persistence';
import { emailAttachmentCustodyCleanupIntentId } from '@assistant/persistence';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { getQueueNotifier } from '../queue.js';
import { enqueueTask } from '../workflow/machine.js';
import { type DocumentSource, type DocumentTrust, extractorFor } from './document-types.js';

const DEFAULT_DOCUMENT_BUDGET_USD = '0.50';

export interface StartDocumentInput {
  agentId: string;
  title: string;
  workspacePath: string;
  mime: string;
  bytes: number;
  sha256: string;
  source?: DocumentSource;
  sourceRef?: string;
  trust?: DocumentTrust;
  budgetUsdLimit?: string;
}

export interface StartDocumentResult {
  document: DocumentRow;
  taskId: string | null;
  duplicate: boolean;
}

interface DocumentDeletionWorkspace {
  delete(relativePath: string): Promise<void>;
  readonly emailAttachmentCustody?: {
    inspectEmailAttachmentObject(
      custodyId: string,
      generation?: string,
    ): Promise<{
      generation: string;
      custodyId: string;
      state: 'marker' | 'content';
      sha256: string | null;
    } | null>;
    deleteOwnedEmailAttachment(input: {
      custodyId: string;
      expectedGeneration?: string;
    }): Promise<'deleted' | 'missing' | 'changed'>;
  };
}

/**
 * File a document and enqueue its bounded extraction job. The catalog owns
 * durable lifecycle operations but does not import any parser implementation,
 * keeping dashboard routes free of PDF/Office runtime dependencies.
 */
export async function startDocumentIngest(
  store: Db | DocumentCatalogRepository,
  input: StartDocumentInput,
): Promise<StartDocumentResult> {
  const extractor = extractorFor(input.mime, input.title);
  const status = extractor === 'unsupported' ? 'unsupported' : 'pending';
  if ('kind' in store && store.kind === 'document-catalog-repository') {
    // The portable catalog files the records, the dedupe claim, and the
    // extraction task with its wake intent in one transaction.
    const now = new Date();
    const file: Records['files'] = {
      id: randomUUID(),
      createdAt: now,
      agentId: input.agentId,
      taskId: null,
      workspacePath: input.workspacePath,
      mime: input.mime,
      bytes: input.bytes,
      sha256: input.sha256,
      objectGeneration: null,
      emailAttachmentCustodyId: null,
    };
    const created = await store.createDocumentCatalog({
      file,
      document: {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        agentId: input.agentId,
        fileId: file.id,
        title: input.title.slice(0, 300),
        mime: input.mime,
        source: input.source ?? 'upload',
        sourceRef: input.sourceRef ?? '',
        trust: input.trust ?? 'owner',
        sha256: input.sha256,
        status,
        extractor,
        chunkCount: 0,
        charCount: 0,
        error: null,
        processorTokenHash: null,
        processorStartedAt: null,
        processorAttempts: 0,
        processedTextPath: null,
        extractionMetadata: null,
      },
    });
    return {
      document: created.document as DocumentRow,
      taskId: created.task?.id ?? null,
      duplicate: created.duplicate,
    };
  }
  const db = store as Db;

  type EnqueuedTask = { id: string; queueGeneration: number };
  const result = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const [existing] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.agentId, input.agentId), eq(documents.sha256, input.sha256)))
      .limit(1);
    if (existing) {
      return { document: existing, task: null as EnqueuedTask | null, duplicate: true };
    }

    const [file] = await tx
      .insert(files)
      .values({
        agentId: input.agentId,
        workspacePath: input.workspacePath,
        mime: input.mime,
        bytes: input.bytes,
        sha256: input.sha256,
      })
      .returning();
    if (!file) throw new Error('failed to create file row for document');

    const [document] = await tx
      .insert(documents)
      .values({
        agentId: input.agentId,
        fileId: file.id,
        title: input.title.slice(0, 300),
        mime: input.mime,
        source: input.source ?? 'upload',
        sourceRef: input.sourceRef ?? '',
        trust: input.trust ?? 'owner',
        sha256: input.sha256,
        status,
        extractor,
      })
      .returning();
    if (!document) throw new Error('failed to create document row');

    const job =
      extractor === 'text' || extractor === 'pdf'
        ? 'documents.extract'
        : extractor === 'pending_processor'
          ? 'documents.process'
          : null;
    if (!job) {
      return { document, task: null as EnqueuedTask | null, duplicate: false };
    }

    const { task } = await enqueueTask(txDb, {
      event: {
        source: 'internal',
        agentId: input.agentId,
        trust: 'assistant',
        payload: { job, documentId: document.id },
      },
      type: 'adhoc',
      budgetUsdLimit:
        job === 'documents.process'
          ? '0.05'
          : (input.budgetUsdLimit ?? DEFAULT_DOCUMENT_BUDGET_USD),
      deferNotification: true,
    });
    return {
      document,
      task: { id: task.id, queueGeneration: task.queueGeneration },
      duplicate: false,
    };
  });

  if (result.task) getQueueNotifier().notify(result.task.id, result.task.queueGeneration);
  return {
    document: result.document,
    taskId: result.task?.id ?? null,
    duplicate: result.duplicate,
  };
}

export interface DocumentView {
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
}

export async function listDocuments(db: Db, agentId: string): Promise<DocumentView[]> {
  const rows = await db
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
    })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .where(eq(documents.agentId, agentId))
    .orderBy(desc(documents.createdAt))
    .limit(200);
  return rows.map((row) => ({ ...row, bytes: row.bytes ?? 0 }));
}

export interface DocumentStats {
  total: number;
  ready: number;
  pending: number;
  chunks: number;
}

export async function documentStats(db: Db, agentId: string): Promise<DocumentStats> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      ready: sql<number>`count(*) filter (where ${documents.status} = 'ready')`,
      pending: sql<number>`count(*) filter (where ${documents.status} in ('pending','extracting'))`,
      chunks: sql<number>`coalesce(sum(${documents.chunkCount}), 0)`,
    })
    .from(documents)
    .where(eq(documents.agentId, agentId));
  return {
    total: Number(row?.total ?? 0),
    ready: Number(row?.ready ?? 0),
    pending: Number(row?.pending ?? 0),
    chunks: Number(row?.chunks ?? 0),
  };
}

/** Remove a document, its in-flight jobs, inventory, chunks, and stored bytes. */
export async function purgeDocument(
  storage: Db | DocumentDeletionRepository,
  agentId: string,
  documentId: string,
  workspace?: DocumentDeletionWorkspace,
): Promise<{ deleted: boolean; pendingAssets: boolean }> {
  if ('kind' in storage && storage.kind === 'document-deletion-repository') {
    const repository = storage as DocumentDeletionRepository;
    const { deleted } = await repository.purge(agentId, documentId);
    return {
      deleted,
      pendingAssets: await drainDocumentDeletionAssets(repository, agentId, documentId, workspace),
    };
  }
  const db = storage as Db;
  const deleted = await db.transaction(async (tx) => {
    await lockPostgresPrivacyObservationFence(tx as unknown as Db, agentId);
    const [document] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.agentId, agentId)))
      .for('update');
    if (!document) return false;
    const [file] = await tx
      .select()
      .from(files)
      .where(and(eq(files.id, document.fileId), eq(files.agentId, agentId)))
      .for('update');
    if (!file) throw new Error('Document file inventory is missing; deletion remains incomplete');
    if (
      file.workspacePath.startsWith('email-attachments/custody/') &&
      !file.emailAttachmentCustodyId
    )
      throw new Error('Email attachment custody identity is missing from its catalog file');
    let ownedCustody: typeof emailAttachmentCustodies.$inferSelect | null = null;
    if (file.emailAttachmentCustodyId) {
      const [custody] = await tx
        .select()
        .from(emailAttachmentCustodies)
        .where(
          and(
            eq(emailAttachmentCustodies.id, file.emailAttachmentCustodyId),
            eq(emailAttachmentCustodies.agentId, agentId),
          ),
        )
        .for('update')
        .limit(1);
      if (
        custody?.status !== 'catalogued' ||
        custody.fileId !== file.id ||
        custody.documentId !== document.id ||
        custody.workspacePath !== file.workspacePath ||
        file.workspacePath !== `email-attachments/custody/${custody.id}` ||
        custody.objectGeneration !== file.objectGeneration ||
        custody.sha256 !== file.sha256 ||
        custody.actualBytes !== file.bytes ||
        custody.mime !== file.mime ||
        !custody.providerMessageId ||
        document.source !== 'email' ||
        document.sourceRef !== `gmail:${custody.providerMessageId}` ||
        document.title !== custody.filename ||
        document.mime !== custody.mime ||
        document.sha256 !== custody.sha256 ||
        document.fileId !== file.id ||
        document.agentId !== agentId ||
        !custody.objectGeneration
      )
        throw new Error('Email attachment custody no longer matches its catalog file');

      const generations = [
        ...(custody.markerGeneration && custody.markerGeneration !== custody.objectGeneration
          ? [{ generation: custody.markerGeneration, objectState: 'marker' as const }]
          : []),
        { generation: custody.objectGeneration, objectState: 'content' as const },
      ];
      for (const { generation, objectState } of generations) {
        const id = emailAttachmentCustodyCleanupIntentId(custody.id, generation);
        const name = `privacy-erasure-asset:${agentId}:${id}`;
        const asset = {
          kind: 'email_attachment_custody',
          id,
          workspacePath: custody.workspacePath,
          custodyId: custody.id,
          generation,
          objectState,
          documentId: document.id,
        };
        const cursor = JSON.stringify(asset);
        const [existing] = await tx
          .select({ cursor: maintenanceCursors.cursor })
          .from(maintenanceCursors)
          .where(eq(maintenanceCursors.name, name))
          .for('update')
          .limit(1);
        if (existing && existing.cursor !== cursor)
          throw new Error('Email attachment cleanup intent changed');
        if (!existing) await tx.insert(maintenanceCursors).values({ name, cursor });
      }
      ownedCustody = custody;
      await tx
        .update(emailAttachmentCustodies)
        .set({ status: 'cleanup_pending', fileId: null, updatedAt: new Date() })
        .where(
          and(
            eq(emailAttachmentCustodies.id, custody.id),
            eq(emailAttachmentCustodies.agentId, agentId),
            eq(emailAttachmentCustodies.status, 'catalogued'),
          ),
        );
    }
    const paths = [
      ...(ownedCustody ? [] : [file.workspacePath]),
      document.processedTextPath,
      `documents/${documentId}/extracted.txt`,
    ].filter((path): path is string => typeof path === 'string' && !!path);
    for (const path of new Set(paths)) {
      const id = documentDeletionAssetId(documentId, path);
      await tx
        .insert(maintenanceCursors)
        .values({ name: `privacy-erasure-asset:${agentId}:${id}`, cursor: path })
        .onConflictDoNothing({ target: maintenanceCursors.name });
    }
    if (document.processorTokenHash) {
      const outputPath = `documents/${documentId}/extracted.txt`;
      const tombstone = {
        agentId,
        documentId,
        processorTokenHash: document.processorTokenHash,
        outputPath,
      };
      await tx
        .insert(maintenanceCursors)
        .values({
          name: `document-delete-tombstone:${documentId}`,
          cursor: JSON.stringify(tombstone),
        })
        .onConflictDoUpdate({
          target: maintenanceCursors.name,
          set: { cursor: JSON.stringify(tombstone), updatedAt: new Date() },
        });
      await tx
        .insert(maintenanceCursors)
        .values({
          name: `privacy-erasure-asset:${agentId}:document-delete-worker:${documentId}`,
          cursor: outputPath,
        })
        .onConflictDoNothing({ target: maintenanceCursors.name });
    }
    await tx
      .update(tasks)
      .set({ status: 'cancelled', lockedUntil: null, runAfter: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(tasks.agentId, agentId),
          sql`${tasks.trigger}->'payload'->>'job' IN ('documents.extract','documents.process')`,
          sql`${tasks.trigger}->'payload'->>'documentId' = ${documentId}`,
          inArray(tasks.status, ['pending', 'sleeping', 'running', 'needs_attention']),
        ),
      );
    await tx
      .delete(documentChunks)
      .where(and(eq(documentChunks.agentId, agentId), eq(documentChunks.documentId, documentId)));
    await tx.delete(documents).where(eq(documents.id, documentId));
    await tx.delete(files).where(eq(files.id, document.fileId));
    return true;
  });
  return {
    deleted,
    pendingAssets: await drainPostgresDocumentDeletionAssets(db, agentId, documentId, workspace),
  };
}

function documentDeletionAssetId(documentId: string, path: string): string {
  return `document-delete:${documentId}:${createHash('sha256').update(path).digest('hex')}`;
}

async function drainDocumentDeletionAssets(
  repository: DocumentDeletionRepository,
  agentId: string,
  documentId: string,
  workspace?: DocumentDeletionWorkspace,
): Promise<boolean> {
  const assets = await repository.pendingAssets(agentId, documentId);
  if (!workspace) return assets.length > 0;
  let pending = false;
  for (const asset of assets) {
    try {
      if (asset.kind === 'email_attachment_custody') {
        if (asset.documentId !== documentId) {
          pending = true;
          continue;
        }
        const custody = workspace.emailAttachmentCustody;
        if (!custody) throw new Error('Email attachment custody cleanup is unsupported');
        const result = await custody.deleteOwnedEmailAttachment({
          custodyId: asset.custodyId,
          expectedGeneration: asset.generation,
        });
        if (result === 'changed') {
          const observed = await custody.inspectEmailAttachmentObject(
            asset.custodyId,
            asset.generation,
          );
          if (!observed) {
            pending = true;
            continue;
          }
          if (observed.custodyId !== asset.custodyId)
            throw new Error('Email attachment custody identity changed during cleanup');
          if (observed.generation === asset.generation && observed.state === asset.objectState) {
            pending = true;
            continue;
          }
          await repository.refreshEmailAttachmentCustodyCleanupIntent(agentId, asset, {
            generation: observed.generation,
            objectState: observed.state,
          });
          pending = true;
          continue;
        } else if (result !== 'deleted' && result !== 'missing') {
          throw new Error('Email attachment custody cleanup was not confirmed');
        }
      } else {
        await workspace.delete(asset.workspacePath);
      }
      await repository.assetDeleted(agentId, asset);
    } catch {
      // Keep the durable asset intent. Paths are deliberately excluded from logs/errors.
      pending = true;
    }
  }
  return pending || (await repository.pendingAssets(agentId, documentId)).length > 0;
}

async function drainPostgresDocumentDeletionAssets(
  db: Db,
  agentId: string,
  documentId: string,
  workspace?: DocumentDeletionWorkspace,
): Promise<boolean> {
  const prefixes = [
    `privacy-erasure-asset:${agentId}:document-delete:${documentId}:`,
    `privacy-erasure-asset:${agentId}:document-delete-worker:${documentId}`,
  ];
  const assets = await db
    .select({ name: maintenanceCursors.name, path: maintenanceCursors.cursor })
    .from(maintenanceCursors)
    .where(
      sql`${maintenanceCursors.name} like ${`${prefixes[0]}%`} OR ${maintenanceCursors.name} = ${prefixes[1]}`,
    );
  const attachmentCleanupPrefix = `privacy-erasure-asset:${agentId}:email-attachment-custody:`;
  const linkedAttachmentAssets = await db
    .select({ name: maintenanceCursors.name })
    .from(maintenanceCursors)
    .where(
      and(
        like(maintenanceCursors.name, `${attachmentCleanupPrefix}%`),
        like(maintenanceCursors.cursor, `%"documentId":"${documentId}"%`),
      ),
    )
    .limit(1);
  if (!workspace) return assets.length > 0 || linkedAttachmentAssets.length > 0;
  for (const asset of assets) {
    if (!prefixes.some((prefix) => asset.name.startsWith(prefix)) || !asset.path) continue;
    try {
      await workspace.delete(asset.path);
      if (asset.name === prefixes[1]) continue;
      await db.delete(maintenanceCursors).where(eq(maintenanceCursors.name, asset.name));
    } catch {
      // Keep the durable asset intent. Paths are deliberately excluded from logs/errors.
    }
  }
  if (linkedAttachmentAssets.length) {
    const privacyRepository = createPostgresPrivacyErasureRepository(db);
    const custodyWorkspace = workspace.emailAttachmentCustody;
    const linkedAssets = (await privacyRepository.pendingAssets()).filter(
      (asset) => asset.kind === 'email_attachment_custody' && asset.documentId === documentId,
    );
    for (const asset of linkedAssets) {
      if (asset.kind !== 'email_attachment_custody' || !custodyWorkspace) continue;
      const removed = await custodyWorkspace.deleteOwnedEmailAttachment({
        custodyId: asset.custodyId,
        expectedGeneration: asset.generation,
      });
      if (removed === 'changed') {
        const observed = await custodyWorkspace.inspectEmailAttachmentObject(asset.custodyId);
        if (!observed)
          throw new Error('Email attachment cleanup generation could not be confirmed missing');
        if (observed.custodyId !== asset.custodyId)
          throw new Error('Email attachment custody identity changed during document deletion');
        await privacyRepository.refreshEmailAttachmentCustodyCleanupIntent(asset, {
          generation: observed.generation,
          objectState: observed.state,
        });
        continue;
      }
      if (removed !== 'deleted' && removed !== 'missing') continue;
      await privacyRepository.assetDeleted(asset);
    }
  }
  const remaining = await db
    .select({ name: maintenanceCursors.name })
    .from(maintenanceCursors)
    .where(
      sql`${maintenanceCursors.name} like ${`${prefixes[0]}%`} OR ${maintenanceCursors.name} = ${prefixes[1]}`,
    );
  const remainingAttachmentAssets = await db
    .select({ name: maintenanceCursors.name })
    .from(maintenanceCursors)
    .where(
      and(
        like(maintenanceCursors.name, `${attachmentCleanupPrefix}%`),
        like(maintenanceCursors.cursor, `%"documentId":"${documentId}"%`),
      ),
    )
    .limit(1);
  return (
    remaining.some((asset) => prefixes.some((prefix) => asset.name.startsWith(prefix))) ||
    remainingAttachmentAssets.length > 0
  );
}
