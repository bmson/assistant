import {
  graphSyncTaskInput,
  type ProfileGraphSyncEnqueuer,
  type ProfileMemoryMaintenance,
} from '@assistant/persistence';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { knowledgeGraphEntities, knowledgeGraphSources, memories, tasks } from './schema.js';

export function createPostgresProfileMemoryMaintenance(
  db: Db,
  enqueue: ProfileGraphSyncEnqueuer,
  now: () => Date = () => new Date(),
): ProfileMemoryMaintenance {
  return {
    kind: 'profile-memory-maintenance',

    async queueGraphSync(input) {
      const [active] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, input.agentId),
            inArray(tasks.status, ['pending', 'running']),
            sql`${tasks.trigger} #>> '{payload,job}' = 'memory.graph_sync'`,
          ),
        )
        .limit(1);
      if (active) return;
      await enqueue(graphSyncTaskInput(input.agentId, input.memoryId, now()));
    },

    async removeOrphanedGraphEntities(input) {
      await db.transaction(async (tx) => {
        const [liveMemory] = await tx
          .select({ agentId: memories.agentId })
          .from(memories)
          .where(eq(memories.id, input.memoryId))
          .limit(1);
        if (liveMemory && liveMemory.agentId !== input.agentId)
          throw new Error('Graph source belongs to another agent');
        // PostgreSQL cascades sources and relations from the deleted memory. Do
        // not delete by memory id here: once the memory is gone, agent ownership
        // can no longer be independently established.
        await tx.delete(knowledgeGraphEntities).where(
          and(
            eq(knowledgeGraphEntities.agentId, input.agentId),
            sql`NOT EXISTS (
                SELECT 1 FROM knowledge_graph_relations AS relation
                WHERE relation.subject_entity_id = ${knowledgeGraphEntities.id}
                   OR relation.object_entity_id = ${knowledgeGraphEntities.id}
              )`,
            // Canonical assertions retain owner review and correction history
            // independently of whether any source evidence still survives.
            sql`NOT EXISTS (
                SELECT 1 FROM knowledge_graph_assertions AS assertion
                WHERE assertion.subject_entity_id = ${knowledgeGraphEntities.id}
                   OR assertion.object_entity_id = ${knowledgeGraphEntities.id}
              )`,
          ),
        );
      });
    },

    async retryBlockedGraphSource(input) {
      const [owned] = await db
        .select({ status: knowledgeGraphSources.status })
        .from(knowledgeGraphSources)
        .innerJoin(memories, eq(memories.id, knowledgeGraphSources.memoryId))
        .where(
          and(
            eq(knowledgeGraphSources.memoryId, input.memoryId),
            eq(memories.agentId, input.agentId),
          ),
        )
        .limit(1);
      if (!owned || !['failed', 'quarantined'].includes(owned.status)) return;
      const retryAt = now();
      await db
        .update(knowledgeGraphSources)
        .set({
          attempts: 0,
          lastError: null,
          nextRetryAt: retryAt,
          status: 'failed',
          updatedAt: retryAt,
        })
        .where(
          and(
            eq(knowledgeGraphSources.memoryId, input.memoryId),
            inArray(knowledgeGraphSources.status, ['failed', 'quarantined']),
          ),
        );
    },
  };
}
