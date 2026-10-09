import { randomUUID } from 'node:crypto';
import {
  type RepairIssue,
  repairClaimCandidate,
  repairFailureKey,
  repairTransition,
  type SelfRepairRepository,
} from '@assistant/persistence';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { conversations, costReservations, modelCalls, selfRepairIssues, tasks } from './schema.js';

export function createPostgresSelfRepairRepository(db: Db): SelfRepairRepository {
  return {
    async report(agentId, input) {
      if (input.sourceTaskId) {
        const [task] = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.id, input.sourceTaskId), eq(tasks.agentId, agentId)));
        if (!task) throw new Error('Repair evidence task is outside the owner');
      }
      if (input.conversationId) {
        const [chat] = await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(eq(conversations.id, input.conversationId), eq(conversations.agentId, agentId)),
          );
        if (!chat) throw new Error('Repair conversation is outside the owner');
      }
      const now = new Date();
      await db
        .insert(selfRepairIssues)
        .values({
          id: randomUUID(),
          agentId,
          fingerprint: input.fingerprint,
          data: { ...input, history: [{ status: 'reported', at: now.toISOString(), detail: '' }] },
        })
        .onConflictDoNothing();
      const [row] = await db
        .select()
        .from(selfRepairIssues)
        .where(
          and(
            eq(selfRepairIssues.agentId, agentId),
            eq(selfRepairIssues.fingerprint, input.fingerprint),
          ),
        );
      if (!row) throw new Error('Repair report was not saved');
      return row as RepairIssue;
    },
    async list(agentId) {
      const rows = (await db
        .select()
        .from(selfRepairIssues)
        .where(eq(selfRepairIssues.agentId, agentId))
        .orderBy(selfRepairIssues.createdAt)
        .limit(1001)) as RepairIssue[];
      if (rows.length > 1000) throw new Error('Repair ledger requires archival');
      return rows;
    },
    async claim(agentId, now, dailyLimit, taskId) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM agents WHERE id = ${agentId} FOR UPDATE`);
        const rows = (await tx
          .select()
          .from(selfRepairIssues)
          .where(eq(selfRepairIssues.agentId, agentId))
          .orderBy(selfRepairIssues.createdAt)
          .limit(1001)) as RepairIssue[];
        const issue = repairClaimCandidate(rows, now, dailyLimit);
        if (!issue) return null;
        const next = repairTransition(
          issue,
          'investigating',
          {
            manualRunStartedAt: issue.data.manualRunRequestedAt ?? issue.data.manualRunStartedAt,
            manualRunRequestedAt: undefined,
            nextEligibleAt: undefined,
            ownerActionRequired: undefined,
            investigationStartedAt: now.toISOString(),
            investigationTaskIds: taskId
              ? [...new Set([...(issue.data.investigationTaskIds ?? []), taskId])].slice(-30)
              : issue.data.investigationTaskIds,
          },
          now,
        );
        const [saved] = await tx
          .update(selfRepairIssues)
          .set({ status: next.status, version: next.version, data: next.data, updatedAt: now })
          .where(
            and(
              eq(selfRepairIssues.id, issue.id),
              eq(selfRepairIssues.agentId, agentId),
              eq(selfRepairIssues.version, issue.version),
              eq(selfRepairIssues.status, issue.status),
            ),
          )
          .returning();
        // An owner dismissal can commit after candidate selection. A stale
        // automated claim must not overwrite that accepted owner decision.
        return saved ? (saved as RepairIssue) : null;
      });
    },
    async modelAccounting(agentId, taskIds, since) {
      if (taskIds.length === 0)
        return {
          observedModelCalls: 0,
          knownCostUsd: null,
          unresolvedReservations: 0,
          complete: false,
        };
      const ids = [...new Set(taskIds)].slice(-30);
      const calls = await db
        .select({ costUsd: modelCalls.costUsd })
        .from(modelCalls)
        .innerJoin(tasks, eq(tasks.id, modelCalls.taskId))
        .where(
          and(
            eq(tasks.agentId, agentId),
            inArray(modelCalls.taskId, ids),
            gte(modelCalls.createdAt, since),
          ),
        );
      const reservations = await db
        .select({ status: costReservations.status })
        .from(costReservations)
        .innerJoin(tasks, eq(tasks.id, costReservations.taskId))
        .where(
          and(
            eq(tasks.agentId, agentId),
            inArray(costReservations.taskId, ids),
            inArray(costReservations.status, ['dispatching', 'unknown']),
          ),
        );
      const knownMicros = calls.reduce(
        (total, row) => total + Math.round(Number(row.costUsd) * 1_000_000),
        0,
      );
      return {
        observedModelCalls: calls.length,
        knownCostUsd:
          calls.length > 0 && Number.isFinite(knownMicros)
            ? (knownMicros / 1_000_000).toFixed(6)
            : null,
        unresolvedReservations: reservations.length,
        complete: calls.length > 0 && reservations.length === 0,
      };
    },
    async update(issue, status, patch, now) {
      const next = repairTransition(issue, status, patch, now);
      const [saved] = await db
        .update(selfRepairIssues)
        .set({ status, version: next.version, data: next.data, updatedAt: now })
        .where(
          and(
            eq(selfRepairIssues.id, issue.id),
            eq(selfRepairIssues.agentId, issue.agentId),
            eq(selfRepairIssues.version, issue.version),
          ),
        )
        .returning();
      return saved ? (saved as RepairIssue) : null;
    },
    async failures(agentId, since) {
      const rows = await db
        .select({
          taskId: tasks.id,
          title: tasks.title,
          state: tasks.state,
          updatedAt: tasks.updatedAt,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            inArray(tasks.status, ['failed', 'needs_attention']),
            gte(tasks.updatedAt, since),
          ),
        )
        .orderBy(desc(tasks.updatedAt))
        .limit(20);
      return rows.map((row) => ({
        taskId: row.taskId,
        title: row.title ?? 'Failed task',
        symptomKey: repairFailureKey(row.title ?? 'Failed task', row.state),
        observedAt: row.updatedAt.toISOString(),
      }));
    },
  };
}
