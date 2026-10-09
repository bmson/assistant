import { createHash } from 'node:crypto';
import type { DocumentProcessorRepository } from '@assistant/persistence';
import { and, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { agents, documents, files, maintenanceCursors, tasks } from './schema.js';
import { createTask } from './task-creation-repository.js';

/** The processor lifecycle with the queries `documents.process` and its callback always ran. */
export function createPostgresDocumentProcessorRepository(db: Db): DocumentProcessorRepository {
  const claimable = (staleBefore: Date) =>
    or(isNull(documents.processorStartedAt), lt(documents.processorStartedAt, staleBefore));
  return {
    kind: 'document-processor-repository',
    async retireExhausted(maxAttempts, now, staleBefore) {
      const retired = await db
        .update(documents)
        .set({
          status: 'failed',
          processorTokenHash: null,
          error: `processor did not report back after ${maxAttempts} launches`,
          updatedAt: now,
        })
        .where(
          and(
            eq(documents.extractor, 'pending_processor'),
            eq(documents.status, 'pending'),
            gte(documents.processorAttempts, maxAttempts),
            isNull(documents.processedTextPath),
            claimable(staleBefore),
          ),
        )
        .returning({ id: documents.id });
      return retired.length;
    },
    claimable: (input) =>
      db
        .select({
          id: documents.id,
          agentId: documents.agentId,
          title: documents.title,
          mime: documents.mime,
          extractor: documents.extractor,
          workspacePath: files.workspacePath,
        })
        .from(documents)
        .innerJoin(files, eq(files.id, documents.fileId))
        .where(
          and(
            eq(documents.extractor, 'pending_processor'),
            eq(documents.status, 'pending'),
            isNull(documents.processedTextPath),
            claimable(input.staleBefore),
            ...(input.documentId ? [eq(documents.id, input.documentId)] : []),
          ),
        )
        .limit(input.limit),
    async claim(id, input) {
      const [claimed] = await db
        .update(documents)
        .set({
          processorTokenHash: input.tokenHash,
          processorStartedAt: input.now,
          processorAttempts: sql`${documents.processorAttempts} + 1`,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(documents.id, id),
            eq(documents.extractor, 'pending_processor'),
            eq(documents.status, 'pending'),
            isNull(documents.processedTextPath),
            claimable(input.staleBefore),
            lt(documents.processorAttempts, input.maxAttempts),
          ),
        )
        .returning({ id: documents.id });
      return Boolean(claimed);
    },
    async release(id, now, expectedTokenHash) {
      await db
        .update(documents)
        .set({ processorTokenHash: null, processorStartedAt: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(documents.id, id),
            eq(documents.processorTokenHash, expectedTokenHash),
            eq(documents.status, 'pending'),
            isNull(documents.processedTextPath),
          ),
        );
    },
    recordResult: async (input) => {
      const [identity] = await db
        .select({ agentId: documents.agentId })
        .from(documents)
        .where(eq(documents.id, input.documentId))
        .limit(1);
      return db.transaction(async (tx) => {
        if (identity) await lockPostgresPrivacyObservationFence(tx, identity.agentId);
        const [doc] = await tx
          .select()
          .from(documents)
          .where(eq(documents.id, input.documentId))
          .for('update');
        if (!doc) {
          const tombstoneName = `document-delete-tombstone:${input.documentId}`;
          const [tombstoneRow] = await tx
            .select({ cursor: maintenanceCursors.cursor })
            .from(maintenanceCursors)
            .where(eq(maintenanceCursors.name, tombstoneName))
            .for('update');
          if (!tombstoneRow?.cursor)
            return { ok: false, status: 404, error: 'document not found' } as const;
          const owners = await tx.select({ id: agents.id }).from(agents).limit(2);
          const tombstone = JSON.parse(tombstoneRow.cursor) as {
            agentId?: unknown;
            documentId?: unknown;
            processorTokenHash?: unknown;
            outputPath?: unknown;
          };
          if (
            owners.length !== 1 ||
            tombstone.agentId !== owners[0]?.id ||
            tombstone.documentId !== input.documentId ||
            typeof tombstone.processorTokenHash !== 'string' ||
            typeof tombstone.outputPath !== 'string'
          )
            return { ok: false, status: 404, error: 'document not found' } as const;
          if (!input.tokenMatches(tombstone.processorTokenHash))
            return { ok: false, status: 403, error: 'invalid token' } as const;
          if (tombstone.outputPath !== input.processedTextPath)
            return {
              ok: false,
              status: 409,
              error: 'deleted document output path mismatch',
            } as const;
          return {
            ok: false,
            status: 410,
            error: 'document was deleted; worker output cleanup is required',
            cleanupPath: tombstone.outputPath,
          } as const;
        }
        if (doc.agentId !== identity?.agentId)
          return {
            ok: false,
            status: 409,
            error: 'document owner changed during callback',
          } as const;
        const externalEventId = `document-processor-result:${doc.id}:${input.tokenHash}`;
        const [prior] = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.externalEventId, externalEventId))
          .limit(1);
        if (prior) {
          const payload = (
            prior.trigger as {
              payload?: { processorResultDigest?: string; job?: string; documentId?: string };
            } | null
          )?.payload;
          if (
            prior.agentId !== doc.agentId ||
            prior.trust !== 'assistant' ||
            payload?.documentId !== doc.id ||
            payload.processorResultDigest !== input.resultDigest
          )
            return {
              ok: false,
              status: 409,
              error: 'processor callback differs from its recorded receipt',
            } as const;
          const extract = payload.job === 'documents.extract';
          return {
            ok: true,
            documentId: doc.id,
            agentId: doc.agentId,
            extract,
            replayed: true,
            ...(extract ? { wake: { id: prior.id, queueGeneration: prior.queueGeneration } } : {}),
          } as const;
        }
        if (!doc.processorTokenHash)
          return { ok: false, status: 409, error: 'no pending processor run' } as const;
        if (!input.tokenMatches(doc.processorTokenHash))
          return { ok: false, status: 403, error: 'invalid token' } as const;
        const created = await createTask(tx as unknown as Db, {
          agentId: doc.agentId,
          type: 'adhoc',
          trust: 'assistant',
          externalEventId,
          title: input.ok ? `Extract ${doc.title}` : `Processor result for ${doc.title}`,
          budgetUsdLimit: '0.50',
          trigger: {
            source: 'internal',
            externalEventId,
            payload: {
              job: input.ok ? 'documents.extract' : 'documents.processor_receipt',
              documentId: doc.id,
              processorResultDigest: input.resultDigest,
            },
          },
        });
        if (!input.ok)
          await tx
            .update(tasks)
            .set({
              status: 'done',
              progress: input.unsupported
                ? 'Processor reported unsupported format'
                : 'Processor reported failure',
            })
            .where(eq(tasks.id, created.task.id));
        if (input.ok) {
          await tx
            .update(documents)
            .set({
              processedTextPath: input.processedTextPath,
              extractionMetadata: input.extractionMetadata ?? null,
              processorTokenHash: null,
              error: null,
              updatedAt: input.now,
            })
            .where(eq(documents.id, doc.id));
          return {
            ok: true,
            documentId: doc.id,
            agentId: doc.agentId,
            extract: true,
            wake: { id: created.task.id, queueGeneration: created.task.queueGeneration },
          } as const;
        }
        await tx
          .update(documents)
          .set({
            status: input.unsupported ? 'unsupported' : 'failed',
            processorTokenHash: null,
            error: input.error.slice(0, 2000),
            updatedAt: input.now,
          })
          .where(eq(documents.id, doc.id));
        return { ok: true, documentId: doc.id, agentId: doc.agentId, extract: false } as const;
      });
    },
    async resolveDeletedCallback(input) {
      return db.transaction(async (tx) => {
        const tombstoneName = `document-delete-tombstone:${input.documentId}`;
        const [row] = await tx
          .select({ cursor: maintenanceCursors.cursor })
          .from(maintenanceCursors)
          .where(eq(maintenanceCursors.name, tombstoneName))
          .for('update');
        if (!row?.cursor) return false;
        const owners = await tx.select({ id: agents.id }).from(agents).limit(2);
        const tombstone = JSON.parse(row.cursor) as {
          agentId?: unknown;
          documentId?: unknown;
          processorTokenHash?: unknown;
          outputPath?: unknown;
        };
        if (
          owners.length !== 1 ||
          tombstone.agentId !== owners[0]?.id ||
          tombstone.documentId !== input.documentId ||
          typeof tombstone.processorTokenHash !== 'string' ||
          tombstone.outputPath !== input.processedTextPath
        )
          throw new Error('Deleted document callback tombstone is invalid');
        if (!input.tokenMatches(tombstone.processorTokenHash))
          throw new Error('Invalid deleted document callback token');
        await tx
          .delete(maintenanceCursors)
          .where(
            and(
              eq(
                maintenanceCursors.name,
                `privacy-erasure-asset:${tombstone.agentId}:document-delete-worker:${input.documentId}`,
              ),
            ),
          );
        await tx
          .delete(maintenanceCursors)
          .where(
            and(
              eq(
                maintenanceCursors.name,
                `privacy-erasure-asset:${tombstone.agentId}:document-delete:${input.documentId}:${createHash('sha256').update(input.processedTextPath).digest('hex')}`,
              ),
            ),
          );
        await tx.delete(maintenanceCursors).where(eq(maintenanceCursors.name, tombstoneName));
        return true;
      });
    },
  };
}
