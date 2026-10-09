import type { TaskDiscoveryRepository, TaskDiscoveryRow } from '@assistant/persistence';
import { and, count, desc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { notChatAdmissionCancellationSql } from './chat-admission-projection.js';
import type { Db } from './client.js';
import { approvals, tasks } from './schema.js';
export function createPostgresTaskDiscoveryRepository(db: Db): TaskDiscoveryRepository {
  return {
    driver: 'postgres',
    async scan(agentId, input) {
      if (!agentId || input.limit < 1 || input.limit > 500)
        throw new Error('Invalid owner task scan');
      const rows: TaskDiscoveryRow[] = await db
        .select({
          id: tasks.id,
          agentId: tasks.agentId,
          type: tasks.type,
          status: tasks.status,
          title: tasks.title,
          progress: tasks.progress,
          trust: tasks.trust,
          spentUsd: tasks.spentUsd,
          budgetUsdLimit: tasks.budgetUsdLimit,
          updatedAt: tasks.updatedAt,
          createdAt: tasks.createdAt,
          archivedAt: tasks.archivedAt,
          autonomyGrant: tasks.autonomyGrant,
          conversationId: tasks.conversationId,
          source: sql<string>`coalesce(${tasks.trigger}->>'source', 'unknown')`,
          externalEventId: tasks.externalEventId,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            notChatAdmissionCancellationSql(),
            sql`${tasks.trigger}->'payload'->>'canary' IS DISTINCT FROM 'true'`,
            input.after
              ? or(
                  lt(tasks.updatedAt, input.after.at),
                  and(
                    eq(tasks.updatedAt, input.after.at),
                    sql`${tasks.id} > ${input.after.id}::uuid`,
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(tasks.updatedAt), tasks.id)
        .limit(input.limit + 1);
      const selected = rows.slice(0, input.limit);
      const waiting = selected
        .filter((row) => row.status === 'waiting_approval')
        .map((row) => row.id);
      const [archived, pending] = await Promise.all([
        db
          .select({ n: count() })
          .from(tasks)
          .where(
            and(
              eq(tasks.agentId, agentId),
              notChatAdmissionCancellationSql(),
              isNotNull(tasks.archivedAt),
            ),
          ),
        waiting.length
          ? db
              .selectDistinct({ taskId: approvals.taskId })
              .from(approvals)
              .where(and(inArray(approvals.taskId, waiting), eq(approvals.status, 'pending')))
          : [],
      ]);
      return {
        rows: selected,
        hasMore: rows.length > input.limit,
        archivedCount: Number(archived[0]?.n ?? 0),
        pendingApprovalTaskIds: pending.map((row) => row.taskId),
      };
    },
  };
}
