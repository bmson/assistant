import type { ModelConnectionRepository } from '@assistant/persistence';
import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockCostLedger } from './cost-repository.js';
import { modelConnections } from './schema.js';

export function createPostgresModelConnectionRepository(db: Db): ModelConnectionRepository {
  return {
    kind: 'model-connection-repository',
    list: () => db.select().from(modelConnections).orderBy(asc(modelConnections.label)),
    async upsert(input) {
      const values = {
        id: input.id,
        kind: input.kind,
        label: input.label,
        baseUrl: input.baseUrl,
        vertexProject: input.vertexProject,
        vertexLocation: input.vertexLocation,
        enabled: input.enabled,
        ...(input.apiKeyEncrypted !== undefined ? { apiKeyEncrypted: input.apiKeyEncrypted } : {}),
      };
      return db.transaction(async (tx) => {
        await lockCostLedger(tx as unknown as Db);
        const [row] = await tx
          .insert(modelConnections)
          .values(values)
          .onConflictDoUpdate({
            target: modelConnections.id,
            set: { ...values, lastError: null, updatedAt: sql`now()` },
          })
          .returning();
        if (!row) throw new Error('Model connection was not saved');
        return row;
      });
    },
    async setEnabled(id, enabled) {
      const rows = await db
        .update(modelConnections)
        .set({ enabled, updatedAt: sql`now()` })
        .where(eq(modelConnections.id, id))
        .returning({ id: modelConnections.id });
      return rows.length === 1;
    },
    async recordTest(id, result) {
      // Not an updatedAt bump: a test result must not rebuild the router's
      // cached adapter for this connection.
      const rows = await db
        .update(modelConnections)
        .set({ lastTestedAt: sql`now()`, lastError: result.ok ? null : (result.error ?? 'failed') })
        .where(eq(modelConnections.id, id))
        .returning({ id: modelConnections.id });
      return rows.length === 1;
    },
    async remove(id) {
      const rows = await db
        .delete(modelConnections)
        .where(eq(modelConnections.id, id))
        .returning({ id: modelConnections.id });
      return rows.length === 1;
    },
  };
}
