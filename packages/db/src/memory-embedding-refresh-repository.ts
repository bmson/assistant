import { createHash, randomUUID } from 'node:crypto';
import type { MemoryEmbeddingRefreshRepository, RefreshClaim } from '@assistant/persistence';
import { and, asc, desc, eq, gt, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  assertPostgresPrivacyObservationFence,
  lockPostgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import {
  maintenanceCursors,
  memories,
  memoryEmbeddingRefreshes,
  memoryTombstones,
} from './schema.js';

const cursorName = (agentId: string, target: string) =>
  `memory-embedding-refresh:${agentId}:${target}`;
const receiptId = (agentId: string, memoryId: string, target: string, sourceHash: string) =>
  createHash('sha256').update([agentId, memoryId, target, sourceHash].join('\0')).digest('hex');

function toRecord(row: typeof memoryEmbeddingRefreshes.$inferSelect) {
  return {
    ...row,
    preparedVector: row.preparedVector ?? null,
    observedSpaceKey: row.observedSpaceKey ?? null,
    privacyGeneration: row.privacyGeneration ?? null,
    claimToken: row.claimToken ?? null,
    leaseUntil: row.leaseUntil ?? null,
    unknownReason: row.unknownReason ?? null,
  } as const;
}

export function createPostgresMemoryEmbeddingRefreshRepository(
  db: Db,
): MemoryEmbeddingRefreshRepository {
  return {
    kind: 'memory-embedding-refresh-repository',
    async getCursor(agentId, targetSpaceKey) {
      const [row] = await db
        .select({ cursor: maintenanceCursors.cursor })
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, cursorName(agentId, targetSpaceKey)))
        .limit(1);
      return row?.cursor ?? null;
    },
    async saveCursor(agentId, targetSpaceKey, cursor) {
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const generation = await lockPostgresPrivacyObservationFence(txDb, agentId);
        await tx
          .insert(maintenanceCursors)
          .values({ name: cursorName(agentId, targetSpaceKey), cursor })
          .onConflictDoUpdate({
            target: maintenanceCursors.name,
            set: { cursor, updatedAt: new Date() },
          });
        await assertPostgresPrivacyObservationFence(txDb, agentId, generation);
      });
    },
    async listCandidates({ agentId, targetSpaceKey, afterId, limit }) {
      if (!agentId || !targetSpaceKey || !Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Invalid memory embedding refresh page');
      const rows = await db
        .select({
          id: memories.id,
          agentId: memories.agentId,
          content: memories.content,
          contentHash: memories.contentHash,
          embeddingSpaceKey: memories.embeddingSpaceKey,
        })
        .from(memories)
        .where(
          and(
            eq(memories.agentId, agentId),
            isNotNull(memories.embedding),
            or(isNull(memories.embeddingSpaceKey), ne(memories.embeddingSpaceKey, targetSpaceKey)),
            afterId ? gt(memories.id, afterId) : undefined,
          ),
        )
        .orderBy(asc(memories.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const selected = rows.slice(0, limit);
      return {
        rows: selected,
        nextCursor: hasMore ? (selected.at(-1)?.id ?? null) : null,
      };
    },
    async claim(input): Promise<RefreshClaim> {
      if (
        !input.agentId ||
        !input.memoryId ||
        !/^[a-f0-9]{64}$/.test(input.sourceHash) ||
        !/^[a-f0-9]{64}$/.test(input.targetSpaceKey) ||
        !Number.isInteger(input.targetDimensions) ||
        input.targetDimensions !== 1536
      )
        throw new Error('Invalid memory embedding refresh claim');
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const generation = await lockPostgresPrivacyObservationFence(txDb, input.agentId);
        const [memory] = await tx
          .select({
            id: memories.id,
            contentHash: memories.contentHash,
            embeddingSpaceKey: memories.embeddingSpaceKey,
          })
          .from(memories)
          .where(and(eq(memories.id, input.memoryId), eq(memories.agentId, input.agentId)))
          .for('update')
          .limit(1);
        if (!memory || memory.contentHash !== input.sourceHash) {
          await assertPostgresPrivacyObservationFence(txDb, input.agentId, generation);
          return { kind: 'stale' };
        }
        if (memory.embeddingSpaceKey === input.targetSpaceKey) {
          await assertPostgresPrivacyObservationFence(txDb, input.agentId, generation);
          return { kind: 'current' };
        }
        const [tombstone] = await tx
          .select({ id: memoryTombstones.id })
          .from(memoryTombstones)
          .where(eq(memoryTombstones.contentHash, input.sourceHash))
          .limit(1);
        if (tombstone) return { kind: 'stale' };
        const id = receiptId(input.agentId, input.memoryId, input.targetSpaceKey, input.sourceHash);
        const priorRows = await tx
          .select()
          .from(memoryEmbeddingRefreshes)
          .where(
            and(
              eq(memoryEmbeddingRefreshes.agentId, input.agentId),
              eq(memoryEmbeddingRefreshes.memoryId, input.memoryId),
              eq(memoryEmbeddingRefreshes.targetSpaceKey, input.targetSpaceKey),
              eq(memoryEmbeddingRefreshes.sourceHash, input.sourceHash),
            ),
          )
          .orderBy(desc(memoryEmbeddingRefreshes.updatedAt))
          .limit(1)
          .for('update');
        const prior = priorRows[0];
        if (prior?.status === 'prepared') return { kind: 'prepared', receipt: toRecord(prior) };
        if (prior?.status === 'unknown') return { kind: 'unknown', receipt: toRecord(prior) };
        if (prior?.status === 'abandoned') return { kind: 'stale' };
        if (prior?.status === 'retry_authorized') {
          await tx
            .update(memoryEmbeddingRefreshes)
            .set({
              status: 'abandoned',
              unknownReason: 'owner_retry_consumed',
              updatedAt: input.now,
            })
            .where(eq(memoryEmbeddingRefreshes.id, prior.id));
        }
        if (prior?.status === 'dispatching') {
          if (prior.leaseUntil && prior.leaseUntil > input.now) return { kind: 'busy' };
          await tx
            .update(memoryEmbeddingRefreshes)
            .set({
              status: 'unknown',
              unknownReason: 'expired_dispatch_lease',
              claimToken: null,
              updatedAt: input.now,
            })
            .where(eq(memoryEmbeddingRefreshes.id, prior.id));
          return {
            kind: 'unknown',
            receipt: toRecord({
              ...prior,
              status: 'unknown',
              unknownReason: 'expired_dispatch_lease',
              claimToken: null,
              updatedAt: input.now,
            }),
          };
        }
        const token = randomUUID();
        const newId = prior ? `${id}:${randomUUID()}` : id;
        const values = {
          id: newId,
          agentId: input.agentId,
          memoryId: input.memoryId,
          sourceHash: input.sourceHash,
          targetSpaceKey: input.targetSpaceKey,
          targetDimensions: input.targetDimensions,
          observedSpaceKey: memory.embeddingSpaceKey,
          status: 'dispatching',
          preparedVector: null,
          privacyGeneration: generation,
          claimToken: token,
          leaseUntil: input.leaseUntil,
          unknownReason: null,
          updatedAt: input.now,
        };
        const [created] = await tx.insert(memoryEmbeddingRefreshes).values(values).returning();
        if (!created) throw new Error('Memory refresh claim was not persisted');
        await assertPostgresPrivacyObservationFence(txDb, input.agentId, generation);
        return { kind: 'claimed', receipt: toRecord(created) };
      });
    },
    async savePrepared(input) {
      if (
        !Array.isArray(input.vector) ||
        input.vector.length !== 1536 ||
        !input.vector.every(Number.isFinite) ||
        !input.vector.some((value) => value !== 0)
      )
        throw new Error('Invalid prepared embedding vector');
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const generation = await lockPostgresPrivacyObservationFence(txDb, input.agentId);
        const [receipt] = await tx
          .select()
          .from(memoryEmbeddingRefreshes)
          .where(
            and(
              eq(memoryEmbeddingRefreshes.id, input.receiptId),
              eq(memoryEmbeddingRefreshes.agentId, input.agentId),
            ),
          )
          .for('update')
          .limit(1);
        if (
          receipt?.status !== 'dispatching' ||
          receipt.claimToken !== input.claimToken ||
          !receipt.leaseUntil ||
          receipt.leaseUntil <= input.now
        ) {
          await assertPostgresPrivacyObservationFence(txDb, input.agentId, generation);
          return false;
        }
        const [memory] = await tx
          .select({
            id: memories.id,
            agentId: memories.agentId,
            contentHash: memories.contentHash,
            embeddingSpaceKey: memories.embeddingSpaceKey,
          })
          .from(memories)
          .where(and(eq(memories.id, receipt.memoryId), eq(memories.agentId, input.agentId)))
          .for('update')
          .limit(1);
        const [tombstone] = await tx
          .select({ id: memoryTombstones.id })
          .from(memoryTombstones)
          .where(eq(memoryTombstones.contentHash, receipt.sourceHash))
          .limit(1);
        const sourceStillCurrent =
          memory?.contentHash === receipt.sourceHash &&
          memory.embeddingSpaceKey === receipt.observedSpaceKey &&
          !tombstone;
        if (!sourceStillCurrent || receipt.privacyGeneration !== generation) {
          await tx
            .update(memoryEmbeddingRefreshes)
            .set({
              status: 'stale',
              preparedVector: null,
              claimToken: null,
              leaseUntil: null,
              updatedAt: input.now,
            })
            .where(eq(memoryEmbeddingRefreshes.id, receipt.id));
          await assertPostgresPrivacyObservationFence(txDb, input.agentId, generation);
          return false;
        }
        await tx
          .update(memoryEmbeddingRefreshes)
          .set({
            status: 'prepared',
            preparedVector: input.vector,
            claimToken: null,
            leaseUntil: null,
            updatedAt: input.now,
          })
          .where(eq(memoryEmbeddingRefreshes.id, receipt.id));
        await assertPostgresPrivacyObservationFence(txDb, input.agentId, generation);
        return true;
      });
    },
    async applyPrepared(input) {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const generation = await lockPostgresPrivacyObservationFence(txDb, input.agentId);
        const [receipt] = await tx
          .select()
          .from(memoryEmbeddingRefreshes)
          .where(
            and(
              eq(memoryEmbeddingRefreshes.id, input.receiptId),
              eq(memoryEmbeddingRefreshes.agentId, input.agentId),
            ),
          )
          .for('update')
          .limit(1);
        const [memory] = await tx
          .select()
          .from(memories)
          .where(and(eq(memories.id, input.memoryId), eq(memories.agentId, input.agentId)))
          .for('update')
          .limit(1);
        if (
          receipt?.status !== 'prepared' ||
          !receipt.preparedVector ||
          receipt.memoryId !== input.memoryId ||
          receipt.sourceHash !== input.sourceHash ||
          receipt.targetSpaceKey !== input.targetSpaceKey ||
          !memory ||
          memory.contentHash !== input.sourceHash ||
          memory.embeddingSpaceKey !== receipt.observedSpaceKey
        ) {
          if (receipt?.status === 'prepared')
            await tx
              .update(memoryEmbeddingRefreshes)
              .set({ status: 'stale', preparedVector: null, updatedAt: input.now })
              .where(eq(memoryEmbeddingRefreshes.id, receipt.id));
          await assertPostgresPrivacyObservationFence(txDb, input.agentId, generation);
          return 'stale';
        }
        const [tombstone] = await tx
          .select({ id: memoryTombstones.id })
          .from(memoryTombstones)
          .where(eq(memoryTombstones.contentHash, input.sourceHash))
          .limit(1);
        if (tombstone) {
          await tx
            .update(memoryEmbeddingRefreshes)
            .set({ status: 'stale', preparedVector: null, updatedAt: input.now })
            .where(eq(memoryEmbeddingRefreshes.id, receipt.id));
          return 'stale';
        }
        if (generation !== receipt.privacyGeneration) {
          await tx
            .update(memoryEmbeddingRefreshes)
            .set({ status: 'stale', preparedVector: null, updatedAt: input.now })
            .where(eq(memoryEmbeddingRefreshes.id, receipt.id));
          return 'privacy-fenced';
        }
        await tx
          .update(memories)
          .set({ embedding: receipt.preparedVector, embeddingSpaceKey: input.targetSpaceKey })
          .where(eq(memories.id, memory.id));
        await tx
          .update(memoryEmbeddingRefreshes)
          .set({ status: 'completed', preparedVector: null, updatedAt: input.now })
          .where(eq(memoryEmbeddingRefreshes.id, receipt.id));
        await assertPostgresPrivacyObservationFence(txDb, input.agentId, generation);
        return 'applied';
      });
    },
    async markUnknown(input) {
      const boundedReason =
        input.reason.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'unknown_failure';
      await db
        .update(memoryEmbeddingRefreshes)
        .set({
          status: 'unknown',
          unknownReason: boundedReason,
          claimToken: null,
          leaseUntil: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(memoryEmbeddingRefreshes.id, input.receiptId),
            eq(memoryEmbeddingRefreshes.agentId, input.agentId),
            eq(memoryEmbeddingRefreshes.status, 'dispatching'),
            eq(memoryEmbeddingRefreshes.claimToken, input.claimToken),
          ),
        );
    },
    async listUnknown(agentId, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Invalid refresh review limit');
      const rows = await db
        .select()
        .from(memoryEmbeddingRefreshes)
        .where(
          and(
            eq(memoryEmbeddingRefreshes.agentId, agentId),
            eq(memoryEmbeddingRefreshes.status, 'unknown'),
          ),
        )
        .orderBy(asc(memoryEmbeddingRefreshes.updatedAt))
        .limit(limit);
      return rows.map(toRecord);
    },
    async resolveUnknown(input) {
      const [row] = await db
        .update(memoryEmbeddingRefreshes)
        .set({
          status: input.action === 'authorize_retry' ? 'retry_authorized' : 'abandoned',
          unknownReason: `owner_${input.action}`,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(memoryEmbeddingRefreshes.id, input.receiptId),
            eq(memoryEmbeddingRefreshes.agentId, input.agentId),
            eq(memoryEmbeddingRefreshes.status, 'unknown'),
            sql`date_trunc('milliseconds', ${memoryEmbeddingRefreshes.updatedAt}) = ${input.expectedUpdatedAt.toISOString()}::timestamptz`,
          ),
        )
        .returning({
          id: memoryEmbeddingRefreshes.id,
          memoryId: memoryEmbeddingRefreshes.memoryId,
          targetSpaceKey: memoryEmbeddingRefreshes.targetSpaceKey,
          sourceHash: memoryEmbeddingRefreshes.sourceHash,
        });
      return row
        ? {
            authorized: true,
            ...(input.action === 'authorize_retry'
              ? { retryKey: `${row.memoryId}:${row.targetSpaceKey}:${row.sourceHash}` }
              : {}),
          }
        : { authorized: false };
    },
  };
}
