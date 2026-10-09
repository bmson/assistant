import { randomUUID } from 'node:crypto';
import type { MissionReport, MissionRepository } from '@assistant/persistence';
import { and, desc, eq, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { missionReports, tasks } from './schema.js';

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];

export function createPostgresMissionRepository(db: Db): MissionRepository {
  return {
    kind: 'mission-repository',
    async activeSession(agentId, missionId) {
      const [session] = await db
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            eq(tasks.parentTaskId, missionId),
            notInArray(tasks.status, TERMINAL_TASK_STATUSES),
          ),
        )
        .orderBy(desc(tasks.updatedAt))
        .limit(1);
      return session ?? null;
    },
    async spentUsd(agentId, missionId) {
      const [spend] = await db.execute<{ total: string | number }>(sql`
        with recursive mission_tree as (
          select id, parent_task_id, agent_id, spent_usd
          from tasks
          where id = ${missionId} and agent_id = ${agentId} and type = 'mission'
          union
          select child.id, child.parent_task_id, child.agent_id, child.spent_usd
          from tasks child
          join mission_tree parent on child.parent_task_id = parent.id
          where child.agent_id = ${agentId}
        )
        select coalesce(sum(spent_usd), 0)::text as total from mission_tree
      `);
      return Number(spend?.total ?? 0);
    },
    async transitionWithReport(input) {
      if (!input.eventId.startsWith(`mission:${input.taskId}:`))
        throw new Error('Mission report identity is not bound to its task');
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(tasks)
          .set({
            status: input.status,
            progress: input.progress ?? sql`${tasks.progress}`,
            ...(input.progressPercent !== undefined
              ? { progressPercent: input.progressPercent }
              : {}),
            ...(input.lastReflectedAt ? { lastReflectedAt: input.lastReflectedAt } : {}),
            lockedUntil: null,
            leaseToken: null,
            runAfter: null,
            attempt: 0,
            ...(input.status === 'needs_attention' || input.status === 'waiting_event'
              ? { attentionNotifiedAt: null }
              : {}),
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(tasks.id, input.taskId),
              eq(tasks.agentId, input.agentId),
              eq(tasks.type, 'mission'),
              eq(tasks.status, 'running'),
              eq(tasks.leaseToken, input.leaseToken),
            ),
          )
          .returning({ id: tasks.id, conversationId: tasks.conversationId, goalId: tasks.goalId });
        if (!updated) return false;
        await tx
          .insert(missionReports)
          .values({
            id: input.eventId,
            agentId: input.agentId,
            missionId: input.taskId,
            goalId: updated.goalId,
            conversationId: updated.conversationId,
            outcome: input.outcome,
            text: input.text,
          })
          .onConflictDoNothing({ target: missionReports.id });
        return true;
      });
    },
    async dueReports(agentId, limit = 20) {
      const rows = await db
        .select({ id: missionReports.id })
        .from(missionReports)
        .where(
          and(
            eq(missionReports.agentId, agentId),
            sql`${missionReports.nextAttemptAt} <= now()`,
            or(
              sql`${missionReports.chatStatus} IN ('pending','failed')`,
              sql`${missionReports.ownerStatus} IN ('pending','failed')`,
              sql`${missionReports.mirrorStatus} IN ('pending','failed')`,
            ),
            or(
              sql`${missionReports.lockedUntil} IS NULL`,
              sql`${missionReports.lockedUntil} <= now()`,
            ),
          ),
        )
        .orderBy(missionReports.nextAttemptAt, missionReports.createdAt)
        .limit(Math.max(1, Math.min(limit, 100)));
      return rows.map((row) => row.id);
    },
    async claimReport(id, agentId, leaseMs = 30_000) {
      const claimToken = randomUUID();
      const rows = await db.execute<MissionReport>(sql`
        UPDATE mission_reports
        SET claim_token = ${claimToken}::uuid,
            locked_until = now() + (${Math.max(1_000, Math.min(leaseMs, 120_000))} * interval '1 millisecond'),
            attempts = attempts + 1,
            updated_at = now()
        WHERE id = ${id} AND agent_id = ${agentId}
          AND next_attempt_at <= now()
          AND (locked_until IS NULL OR locked_until <= now())
          AND (chat_status IN ('pending','failed') OR owner_status IN ('pending','failed') OR mirror_status IN ('pending','failed'))
        RETURNING id, agent_id AS "agentId", mission_id AS "missionId",
          goal_id AS "goalId", conversation_id AS "conversationId", outcome, text,
          chat_status AS "chatStatus", owner_status AS "ownerStatus", mirror_status AS "mirrorStatus",
          claim_token AS "claimToken", locked_until AS "lockedUntil",
          next_attempt_at AS "nextAttemptAt", attempts,
          created_at AS "createdAt", updated_at AS "updatedAt",
          chat_delivered_at AS "chatDeliveredAt", owner_delivered_at AS "ownerDeliveredAt", mirror_delivered_at AS "mirrorDeliveredAt",
          last_error AS "lastError"
      `);
      const report = rows[0];
      return report ? { report, claimToken } : null;
    },
    async settleReportLeg(input) {
      if (input.leg !== 'owner' && input.status === 'unknown')
        throw new Error('Only owner report leg can have unknown status');
      const [updated] = await db
        .update(missionReports)
        .set({
          ...(input.leg === 'chat'
            ? {
                chatStatus: input.status,
                ...(input.status === 'delivered' ? { chatDeliveredAt: sql`now()` } : {}),
              }
            : input.leg === 'owner'
              ? {
                  ownerStatus: input.status,
                  ...(input.status === 'delivered' ? { ownerDeliveredAt: sql`now()` } : {}),
                }
              : {
                  mirrorStatus: input.status,
                  ...(input.status === 'delivered' ? { mirrorDeliveredAt: sql`now()` } : {}),
                }),
          lastError: input.error?.slice(0, 500) ?? null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(missionReports.id, input.id),
            eq(missionReports.claimToken, input.claimToken),
            sql`${missionReports.lockedUntil} > now()`,
          ),
        )
        .returning({ id: missionReports.id });
      return Boolean(updated);
    },
    async releaseReport(input) {
      const [updated] = await db
        .update(missionReports)
        .set({
          claimToken: null,
          lockedUntil: null,
          nextAttemptAt: sql`now() + least(300, (5 * power(2, least(${missionReports.attempts}, 6)))::int) * interval '1 second'`,
          lastError: input.error?.slice(0, 500) ?? sql`${missionReports.lastError}`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(missionReports.id, input.id),
            eq(missionReports.claimToken, input.claimToken),
            sql`${missionReports.lockedUntil} > now()`,
          ),
        )
        .returning({ id: missionReports.id });
      return Boolean(updated);
    },
  };
}
