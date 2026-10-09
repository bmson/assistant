import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { goalScheduleName } from '@assistant/core';
import {
  approvals,
  conversations,
  costEvents,
  costReservations,
  type Db,
  goals,
  messages,
  modelCalls,
  schedules,
  tasks,
  toolCalls,
} from '@assistant/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  GoalSessionEvidence,
  type GoalSessionEvidenceEvent,
  goalSessionTerminalState,
  isEmptyPrivateGoalSessionDirectory,
  readGoalSessionEvidence,
} from './goal-session-safety.js';

export interface GoalSessionTargetIdentity {
  databaseName: string;
  token: string;
}

/** Hold a session lock so a recovery process cannot clean an active rehearsal. */
export async function tryAcquireGoalSessionLock(db: Db, runId: string) {
  const reserved = await db.$client.reserve();
  const lockName = `assistant.goal-session:${runId}`;
  try {
    const [row] = await reserved<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${lockName}, 0)) AS acquired
    `;
    if (row?.acquired !== true) {
      reserved.release();
      return null;
    }
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        try {
          await reserved`SELECT pg_advisory_unlock(hashtextextended(${lockName}, 0))`;
        } finally {
          reserved.release();
        }
      },
    };
  } catch (error) {
    reserved.release();
    throw error;
  }
}

/** Verify the server-side allocator sentinel; URL shape/token equality alone is insufficient. */
export async function assertGoalSessionDatabaseOwnership(
  db: Db,
  target: GoalSessionTargetIdentity,
): Promise<void> {
  const [row] = await db.execute<{
    database_name: string;
    ownership_marker: string | null;
  }>(sql`SELECT current_database() AS database_name,
      shobj_description(oid, 'pg_database') AS ownership_marker
    FROM pg_database WHERE datname = current_database()`);
  if (
    row?.database_name !== target.databaseName ||
    row.ownership_marker !== `assistant-test-target:${target.token}`
  )
    throw new Error(
      'Refusing goal rehearsal: database does not have the allocator ownership marker',
    );
}

function event<T extends Record<string, unknown>>(
  events: readonly GoalSessionEvidenceEvent[],
  name: string,
): (GoalSessionEvidenceEvent & T) | undefined {
  return events.find((item) => item.event === name) as (GoalSessionEvidenceEvent & T) | undefined;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeUsage(eventRows: (typeof costEvents.$inferSelect)[]) {
  return eventRows.map((row) => ({
    source: row.source,
    evidence: {
      basis: row.evidence.basis,
      provider: row.evidence.provider,
      model: row.evidence.model,
      modelUsage: row.evidence.modelUsage,
    },
    usd: row.usd,
    quantity: row.quantity,
    unit: row.unit,
    unitPriceUsd: row.unitPriceUsd,
    reservationId: row.reservationId,
  }));
}

/**
 * Recover one interrupted rehearsal using only its complete local journal and
 * exact generated IDs. The database transaction is atomic, so a second process
 * can safely repeat cleanup after a crash.
 */
export async function reconcileGoalSessionRun(input: {
  db: Db;
  directory: string;
  runId: string;
  target: GoalSessionTargetIdentity;
  lockAlreadyHeld?: boolean;
}): Promise<'active-run' | 'already-clean' | 'cleaned' | 'not-owned-target'> {
  const events = await readGoalSessionEvidence(input.directory, input.runId);
  if (!events) throw new Error('Refusing cleanup: goal-session evidence chain is invalid');
  if (events.some((entry) => entry.event === 'fixture_cleanup_complete')) return 'already-clean';
  const terminalState = goalSessionTerminalState(events);
  if (terminalState === 'invalid')
    throw new Error('Refusing cleanup: no-effects terminal does not match its journal history');
  if (terminalState === 'valid') return 'already-clean';

  const goalIntent = event<{ goalId: string; agentId: string }>(events, 'goal_fixture_planned');
  const conversationIntent = event<{ conversationId: string }>(
    events,
    'conversation_fixture_planned',
  );

  // The rehearsal writes this intent before its first fixture row. A journal
  // without it has no database effects to remove, even if target evidence was
  // interrupted; do not infer a cleanup target from the current environment.
  if (!goalIntent) {
    const noEffectsTarget =
      event<{ databaseName: string; targetToken: string }>(events, 'rehearsal_target') ??
      event<{ databaseName: string; targetToken: string }>(events, 'rehearsal_started') ??
      event<{ databaseName: string; targetToken: string }>(events, 'rehearsal_plan');
    if (
      !noEffectsTarget ||
      noEffectsTarget.databaseName !== input.target.databaseName ||
      noEffectsTarget.targetToken !== input.target.token
    )
      return 'not-owned-target';
    const lock = input.lockAlreadyHeld
      ? null
      : await tryAcquireGoalSessionLock(input.db, input.runId);
    if (!input.lockAlreadyHeld && !lock) return 'active-run';
    try {
      await GoalSessionEvidence.removeOwnedPending(input.directory, input.runId);
      const ledger = await GoalSessionEvidence.open(input.directory, input.runId);
      await ledger.record({
        event: 'rehearsal_no_effects_complete',
        runId: input.runId,
        cleanupReason: 'fixture intent was never durably planned',
        effectsStarted: false,
      });
      return 'cleaned';
    } finally {
      await lock?.release();
    }
  }

  const targetEvent = event<{ databaseName: string; targetToken: string }>(
    events,
    'rehearsal_target',
  );
  if (
    !targetEvent ||
    targetEvent.databaseName !== input.target.databaseName ||
    targetEvent.targetToken !== input.target.token
  )
    return 'not-owned-target';
  const lock = input.lockAlreadyHeld
    ? null
    : await tryAcquireGoalSessionLock(input.db, input.runId);
  if (!input.lockAlreadyHeld && !lock) return 'active-run';

  try {
    await GoalSessionEvidence.removeOwnedPending(input.directory, input.runId);
    const goalId = stringField(goalIntent.goalId);
    const agentId = stringField(goalIntent.agentId);
    const conversationId =
      stringField(goalIntent.conversationId) ?? stringField(conversationIntent?.conversationId);
    if (!goalId || !agentId || !conversationId)
      throw new Error('Refusing cleanup: planned fixture identity is incomplete');

    const [goal] = await input.db
      .select()
      .from(goals)
      .where(and(eq(goals.id, goalId), eq(goals.agentId, agentId)))
      .limit(1);
    if (goal && goal.title !== `Verify goal session ${input.runId}`)
      throw new Error('Refusing cleanup: goal does not carry this rehearsal identity');

    const [conversation] = await input.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, agentId)))
      .limit(1);
    const conversationMetadata = conversation?.metadata as Record<string, unknown> | undefined;
    if (
      conversation &&
      (conversation.channel !== 'chat' ||
        conversation.title !== `Work: Verify goal session ${input.runId.slice(0, 8)}` ||
        conversationMetadata?.rehearsalId !== input.runId ||
        conversationMetadata?.goalId !== goalId)
    )
      throw new Error('Refusing cleanup: conversation does not carry this rehearsal identity');

    const scheduleName = goalScheduleName(goalId);
    const [schedule] = await input.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.agentId, agentId), eq(schedules.name, scheduleName)))
      .limit(1);
    const scheduleTemplate = schedule?.taskTemplate as Record<string, unknown> | undefined;
    if (schedule && scheduleTemplate?.goalId !== goalId)
      throw new Error('Refusing cleanup: schedule is not bound to the planned goal');

    const ownedTasks = await input.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.goalId, goalId), eq(tasks.agentId, agentId)));
    const taskIds = ownedTasks.map((row) => row.id);
    const recordedTaskIds = new Set(
      events
        .filter((entry) => entry.event === 'task_fixture_created')
        .map((entry) => stringField(entry.taskId))
        .filter((id): id is string => id !== null),
    );
    for (const taskId of recordedTaskIds) {
      if (!taskIds.includes(taskId)) {
        const [task] = await input.db
          .select({ id: tasks.id, goalId: tasks.goalId, agentId: tasks.agentId })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1);
        if (task && (task.goalId !== goalId || task.agentId !== agentId))
          throw new Error('Refusing cleanup: recorded task does not belong to this rehearsal goal');
      }
    }
    if (!goal && taskIds.length > 0)
      throw new Error('Refusing cleanup: tasks remain but their owner goal marker is missing');

    const ledger = await GoalSessionEvidence.open(input.directory, input.runId);
    const hasUsageReceipt = events.some((entry) => entry.event === 'usage_ledger_retained');
    if (!hasUsageReceipt) {
      const [taskRows, eventRows, reservationRows, toolReceiptRows] = await Promise.all([
        taskIds.length
          ? input.db.select().from(tasks).where(inArray(tasks.id, taskIds))
          : Promise.resolve([]),
        taskIds.length
          ? input.db.select().from(costEvents).where(inArray(costEvents.taskId, taskIds))
          : Promise.resolve([]),
        taskIds.length
          ? input.db
              .select()
              .from(costReservations)
              .where(inArray(costReservations.taskId, taskIds))
          : Promise.resolve([]),
        taskIds.length
          ? input.db
              .select({
                id: toolCalls.id,
                step: toolCalls.step,
                toolName: toolCalls.toolName,
                status: toolCalls.status,
                approvalId: toolCalls.approvalId,
              })
              .from(toolCalls)
              .where(inArray(toolCalls.taskId, taskIds))
          : Promise.resolve([]),
      ]);
      await ledger.record({
        event: 'usage_ledger_retained',
        runId: input.runId,
        taskIds,
        tasks: taskRows.map((row) => ({
          id: row.id,
          status: row.status,
          spentUsd: row.spentUsd,
        })),
        costEvents: safeUsage(eventRows),
        reservations: reservationRows.map((row) => ({
          source: row.source,
          estimatedUsd: row.estimatedUsd,
          actualUsd: row.actualUsd,
          status: row.status,
          attemptMetadata: row.attemptMetadata,
          unknownReason: row.unknownReason,
        })),
        effectReceipts: toolReceiptRows.map((row) => ({
          id: row.id,
          step: row.step,
          toolName: row.toolName,
          status: row.status,
          approvalPending: row.approvalId !== null,
        })),
      });
    }
    await ledger.record({
      event: 'fixture_cleanup_started',
      runId: input.runId,
      goalId,
      conversationId,
      scheduleId: schedule?.id ?? null,
      taskIds,
    });

    await input.db.transaction(async (tx) => {
      if (taskIds.length) {
        await tx.delete(costEvents).where(inArray(costEvents.taskId, taskIds));
        await tx.delete(costReservations).where(inArray(costReservations.taskId, taskIds));
        await tx
          .update(toolCalls)
          .set({ approvalId: null })
          .where(inArray(toolCalls.taskId, taskIds));
        await tx.delete(approvals).where(inArray(approvals.taskId, taskIds));
        await tx.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
        await tx.delete(modelCalls).where(inArray(modelCalls.taskId, taskIds));
        await tx.delete(messages).where(inArray(messages.taskId, taskIds));
        await tx.delete(tasks).where(inArray(tasks.id, taskIds));
      }
      await tx.delete(messages).where(eq(messages.conversationId, conversationId));
      if (conversation) await tx.delete(conversations).where(eq(conversations.id, conversationId));
      if (schedule) await tx.delete(schedules).where(eq(schedules.id, schedule.id));
      if (goal) await tx.delete(goals).where(eq(goals.id, goalId));
    });
    await ledger.record({
      event: 'fixture_cleanup_complete',
      runId: input.runId,
      goalId,
      conversationId,
      scheduleId: schedule?.id ?? null,
      taskIds,
    });
    return 'cleaned';
  } finally {
    await lock?.release();
  }
}

/** Clean every incomplete journal that is explicitly bound to this allocated DB target. */
export async function reconcileGoalSessionOrphans(input: {
  db: Db;
  evidenceParent: string;
  target: GoalSessionTargetIdentity;
}): Promise<{ scanned: number; cleaned: number; skipped: number }> {
  let entries: Dirent[];
  try {
    entries = await readdir(input.evidenceParent, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { scanned: 0, cleaned: 0, skipped: 0 };
    throw error;
  }
  let scanned = 0;
  let cleaned = 0;
  let skipped = 0;
  for (const entry of entries) {
    const match =
      /^goal-session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
        entry.name,
      );
    if (!entry.isDirectory() || !match?.[1]) continue;
    scanned += 1;
    const directory = path.join(input.evidenceParent, entry.name);
    const events = await readGoalSessionEvidence(directory, match[1]);
    if (!events && (await isEmptyPrivateGoalSessionDirectory(directory, match[1]))) {
      skipped += 1;
      continue;
    }
    const result = await reconcileGoalSessionRun({
      db: input.db,
      directory,
      runId: match[1],
      target: input.target,
    });
    if (result === 'cleaned') cleaned += 1;
    else skipped += 1;
  }
  return { scanned, cleaned, skipped };
}
