import type { RecallSurfacingRepository, Records } from '@assistant/persistence';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  lockPostgresPrivacyObservationFence,
  withPostgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import { recallSurfaces } from './schema.js';

export function createPostgresRecallSurfacingRepository(db: Db): RecallSurfacingRepository {
  return {
    kind: 'recall-surfacing-repository',
    async suppressed(agentId, sourceKeys, currentRevisions) {
      if (!sourceKeys.length) return new Set();
      return withPostgresPrivacyObservationFence(db, agentId, async () => {
        const rows = await db
          .select({
            sourceKey: recallSurfaces.sourceKey,
            sourceRevision: recallSurfaces.sourceRevision,
          })
          .from(recallSurfaces)
          .where(
            and(
              eq(recallSurfaces.agentId, agentId),
              inArray(recallSurfaces.sourceKey, sourceKeys),
              sql`${recallSurfaces.suppressedAt} IS NOT NULL`,
            ),
          );
        return new Set(
          rows
            .filter(
              (row) =>
                !currentRevisions ||
                row.sourceRevision === (currentRevisions[row.sourceKey] ?? null),
            )
            .map((row) => row.sourceKey),
        );
      });
    },
    async recordSurfaced({ agentId, messageId, refs, now = new Date() }) {
      if (!refs.length) return;
      await db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx, agentId);
        for (const ref of refs) {
          const [current] = await tx
            .select()
            .from(recallSurfaces)
            .where(
              and(eq(recallSurfaces.agentId, agentId), eq(recallSurfaces.sourceKey, ref.sourceKey)),
            )
            .for('update')
            .limit(1);
          if (current) {
            const revised = current.sourceRevision !== ref.sourceRevision;
            await tx
              .update(recallSurfaces)
              .set({
                suppressedAt: revised ? null : current.suppressedAt,
                sourceRevision: ref.sourceRevision,
                kind: ref.kind,
                lastSurfacedAt: now,
                lastMessageId: messageId,
                surfaceCount: current.surfaceCount + 1,
                version: current.version + (revised ? 1 : 0),
              })
              .where(eq(recallSurfaces.id, current.id));
            continue;
          }
          const inserted = await tx
            .insert(recallSurfaces)
            .values({
              agentId,
              sourceKey: ref.sourceKey,
              sourceRevision: ref.sourceRevision,
              kind: ref.kind,
              firstSurfacedAt: now,
              lastSurfacedAt: now,
              lastMessageId: messageId,
              surfaceCount: 1,
            })
            .onConflictDoNothing()
            .returning({ id: recallSurfaces.id });
          if (inserted.length) continue;
          const [raced] = await tx
            .select()
            .from(recallSurfaces)
            .where(
              and(eq(recallSurfaces.agentId, agentId), eq(recallSurfaces.sourceKey, ref.sourceKey)),
            )
            .for('update')
            .limit(1);
          if (!raced) throw new Error('Recall surface changed during assistant message commit');
          const revised = raced.sourceRevision !== ref.sourceRevision;
          await tx
            .update(recallSurfaces)
            .set({
              suppressedAt: revised ? null : raced.suppressedAt,
              sourceRevision: ref.sourceRevision,
              kind: ref.kind,
              lastSurfacedAt: now,
              lastMessageId: messageId,
              surfaceCount: raced.surfaceCount + 1,
              version: raced.version + (revised ? 1 : 0),
            })
            .where(eq(recallSurfaces.id, raced.id));
        }
      });
    },
    async setSuppressed({
      agentId,
      sourceKey,
      suppressed,
      expectedSourceRevision,
      expectedVersion,
      now = new Date(),
    }) {
      return db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx, agentId);
        const [current] = await tx
          .select()
          .from(recallSurfaces)
          .where(and(eq(recallSurfaces.agentId, agentId), eq(recallSurfaces.sourceKey, sourceKey)))
          .for('update')
          .limit(1);
        if (!current) return { ok: false };
        if (
          (expectedSourceRevision !== undefined &&
            current.sourceRevision !== expectedSourceRevision) ||
          (expectedVersion !== undefined && current.version !== expectedVersion)
        )
          return { ok: false };
        if (Boolean(current.suppressedAt) === suppressed)
          return { ok: true, version: current.version };
        const [row] = await tx
          .update(recallSurfaces)
          .set({
            suppressedAt: suppressed ? now : null,
            version: sql`${recallSurfaces.version} + 1`,
          })
          .where(eq(recallSurfaces.id, current.id))
          .returning({ version: recallSurfaces.version });
        return row ? { ok: true, version: row.version } : { ok: false };
      });
    },
    async list(agentId, limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new Error('Invalid recall surface limit');
      return (await db
        .select()
        .from(recallSurfaces)
        .where(eq(recallSurfaces.agentId, agentId))
        .orderBy(desc(recallSurfaces.lastSurfacedAt))
        .limit(limit)) as Records['recallSurfaces'][];
    },
  };
}
