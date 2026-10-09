import { randomUUID } from 'node:crypto';
import type {
  ScheduledFollowUpInput,
  TaskLease,
  TaskRepository,
  TaskWake,
} from '@assistant/persistence';
import {
  missionTaskTerminalReport,
  newTaskRecord,
  normalizeTaskBudget,
  redactTerminalArrivalTask,
} from '@assistant/persistence';
import { and, desc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { missionReports, type TaskRow, tasks } from './schema.js';
import { createTask } from './task-creation-repository.js';
import { activeLease, createPostgresTaskLeaseRepository } from './task-lease-repository.js';

const WAKEABLE = [
  'waiting_approval',
  'waiting_event',
  'sleeping',
  'waiting_budget',
  'needs_attention',
] as const;
const TERMINAL = ['done', 'failed', 'cancelled'] as const;
const MAX_ATTEMPTS = 8;
const MAX_RECLAIMS = 8;

export async function persistPlan(db: Db, task: TaskLease, plan: unknown): Promise<boolean> {
  const [updated] = await db
    .update(tasks)
    .set({ plan, updatedAt: sql`now()` })
    .where(and(activeLease(task), eq(tasks.agentId, task.agentId)))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

/**
 * Create a future-self child while holding the parent row lock. The lock is
 * the serialization boundary for the count, so concurrent callers cannot
 * create a sixth sleeping child.
 */
export async function createScheduledFollowUp(
  db: Db,
  input: ScheduledFollowUpInput,
): Promise<Awaited<ReturnType<TaskRepository['createTask']>>> {
  if (!input.parentTaskId || !input.agentId || !input.instruction.trim())
    throw new Error('Invalid scheduled follow-up');
  if (input.instruction.length > 2000) throw new Error('Invalid scheduled follow-up');
  if (!Number.isFinite(input.runAfter.getTime())) throw new Error('Invalid task resume time');
  if (!['owner', 'assistant'].includes(input.trust)) throw new Error('Invalid scheduled trust');

  return db.transaction(async (tx) => {
    const [parent] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, input.parentTaskId), eq(tasks.agentId, input.agentId)))
      .for('update');
    if (!parent) throw new Error('Parent task not found or belongs to another agent');

    const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    if (!clock) throw new Error('Missing database clock');
    const now = new Date(clock.now);
    if (input.runAfter <= now) throw new Error('when must be in the future');

    const [count] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(tasks)
      .where(and(eq(tasks.parentTaskId, parent.id), eq(tasks.status, 'sleeping')));
    if (Number(count?.n ?? 0) >= 5) throw new Error('too many scheduled follow-ups (max 5)');

    const task = {
      ...newTaskRecord(
        {
          agentId: parent.agentId,
          conversationId: input.conversationId ?? parent.conversationId,
          type: 'scheduled',
          trust: input.trust,
          trigger: {
            source: 'internal',
            payload: {
              instruction: input.instruction,
              ...(input.tainted ? { taintedOrigin: true } : {}),
            },
          },
          runAfter: input.runAfter,
          parentTaskId: parent.id,
        },
        randomUUID(),
        now,
      ),
    };
    const [created] = await tx.insert(tasks).values(task).returning();
    if (!created) throw new Error('Scheduled follow-up was not created');
    return { task: created, created: true };
  });
}

export async function parkForApproval(
  db: Db,
  task: TaskLease,
  state: Record<string, unknown>,
  pending: unknown[],
): Promise<boolean> {
  const [updated] = await db
    .update(tasks)
    .set({
      status: 'waiting_approval',
      state: { ...state, pendingApprovals: pending },
      runAfter: null,
      lockedUntil: null,
      attempt: 0,
      updatedAt: sql`now()`,
    })
    .where(activeLease(task))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

export async function parkForBudget(
  db: Db,
  task: TaskLease,
  state: Record<string, unknown>,
  resumeAt: Date,
): Promise<boolean> {
  const [updated] = await db
    .update(tasks)
    .set({
      status: 'waiting_budget',
      state,
      runAfter: resumeAt,
      lockedUntil: null,
      queueGeneration: sql`${tasks.queueGeneration} + 1`,
      attempt: 0,
      updatedAt: sql`now()`,
    })
    .where(activeLease(task))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

export async function sleepTask(
  db: Db,
  task: TaskLease,
  state: Record<string, unknown>,
  runAfter: Date,
): Promise<boolean> {
  const [updated] = await db
    .update(tasks)
    .set({
      status: 'sleeping',
      state,
      runAfter,
      lockedUntil: null,
      queueGeneration: sql`${tasks.queueGeneration} + 1`,
      attempt: 0,
      // A deliberate yield to sleep (code-job checkpoint, mission wake, browser-job
      // wait) is proof of forward progress, so clear the poison-pill reclaim
      // counter too. A genuinely hung worker never reaches here — its running
      // lease simply expires and findDueTasks reclaims it. Without this, a
      // long-running import/mission that survives a few mid-run worker deaths
      // accrues reclaimCount and falsely dead-letters as a poison pill.
      reclaimCount: 0,
      updatedAt: sql`now()`,
    })
    .where(activeLease(task))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

export async function completeTask(
  db: Db,
  taskOrId: TaskLease | string,
  outcome: { status: 'done' | 'failed' | 'cancelled'; progress?: string },
): Promise<boolean> {
  if (typeof taskOrId === 'string' && outcome.status !== 'cancelled')
    throw new Error('Administrative completion requires cancellation');
  const where =
    typeof taskOrId === 'string'
      ? and(eq(tasks.id, taskOrId), notInArray(tasks.status, [...TERMINAL]))
      : activeLease(taskOrId);
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(tasks)
      .set({
        status: outcome.status,
        progress: outcome.progress ?? sql`${tasks.progress}`,
        lockedUntil: null,
        leaseToken: null,
        runAfter: null,
        attempt: 0,
        updatedAt: sql`now()`,
      })
      .where(where)
      .returning({
        id: tasks.id,
        agentId: tasks.agentId,
        type: tasks.type,
        parentTaskId: tasks.parentTaskId,
        trigger: tasks.trigger,
        externalEventId: tasks.externalEventId,
      });
    if (!updated) return false;

    const arrivalRedaction = redactTerminalArrivalTask(
      updated.trigger,
      updated.agentId,
      updated.externalEventId,
    );
    if (arrivalRedaction) {
      await tx
        .update(tasks)
        .set(arrivalRedaction)
        .where(and(eq(tasks.id, updated.id), eq(tasks.agentId, updated.agentId)));
    }

    if (outcome.status === 'done' && updated.type !== 'mission') return true;
    if (
      outcome.status !== 'done' &&
      updated.type !== 'mission' &&
      (updated.type !== 'adhoc' || !updated.parentTaskId)
    )
      return true;

    const missionId = updated.type === 'mission' ? updated.id : updated.parentTaskId;
    if (!missionId) return true;
    const [mission] = await tx
      .select({
        id: tasks.id,
        agentId: tasks.agentId,
        goalId: tasks.goalId,
        conversationId: tasks.conversationId,
        type: tasks.type,
        status: tasks.status,
      })
      .from(tasks)
      .where(and(eq(tasks.id, missionId), eq(tasks.agentId, updated.agentId)))
      .for('update');
    if (mission?.type !== 'mission') return true;

    if (updated.type !== 'mission' && outcome.status === 'done') return true;

    if (
      updated.type !== 'mission' &&
      !TERMINAL.includes(mission.status as (typeof TERMINAL)[number])
    ) {
      await tx
        .update(tasks)
        .set({
          status: 'needs_attention',
          progress:
            'A mission work session ended and needs review before the mission can continue.',
          leaseToken: null,
          lockedUntil: null,
          runAfter: null,
          attempt: 0,
          attentionNotifiedAt: null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(tasks.id, mission.id), eq(tasks.agentId, mission.agentId)));
    }

    const now = new Date();
    const report = missionTaskTerminalReport({
      mission,
      task: updated,
      status: outcome.status,
      now,
    });
    await tx
      .insert(missionReports)
      .values(report)
      .onConflictDoNothing({ target: missionReports.id });
    return true;
  });
}

export async function markTaskNeedsAttention(
  db: Db,
  task: TaskLease,
  progress: string,
): Promise<boolean> {
  const [updated] = await db
    .update(tasks)
    .set({
      status: 'needs_attention',
      progress: progress.slice(0, 500),
      lockedUntil: null,
      runAfter: null,
      attempt: 0,
      // Re-arm the re-notify sweep: a fresh park is unnotified until a notice
      // lands, even if an earlier park on this task had been notified.
      attentionNotifiedAt: null,
      updatedAt: sql`now()`,
    })
    .where(activeLease(task))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

export async function parkForEvent(db: Db, task: TaskLease): Promise<boolean> {
  const [updated] = await db
    .update(tasks)
    .set({
      status: 'waiting_event',
      lockedUntil: null,
      runAfter: null,
      attempt: 0,
      attentionNotifiedAt: null,
      updatedAt: sql`now()`,
    })
    .where(activeLease(task))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

export async function markAttentionNotified(db: Db, taskId: string): Promise<boolean> {
  const [updated] = await db
    .update(tasks)
    .set({ attentionNotifiedAt: sql`now()` })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, ['needs_attention', 'waiting_event'])))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

export async function recordFailedAttempt(
  db: Db,
  task: TaskLease,
  error: string,
): Promise<'retry' | 'dead_letter' | 'lost_lease'> {
  const message = error.slice(0, 500);
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(tasks)
      .set({
        attempt: sql`${tasks.attempt} + 1`,
        status: sql`CASE WHEN ${tasks.attempt} + 1 >= ${MAX_ATTEMPTS} THEN 'needs_attention' ELSE 'sleeping' END`,
        progress: sql`'attempt ' || (${tasks.attempt} + 1)::text || ' failed: ' || ${message}`,
        runAfter: sql`CASE WHEN ${tasks.attempt} + 1 >= ${MAX_ATTEMPTS} THEN NULL ELSE now() + least(300, (5 * power(2, ${tasks.attempt}))::int) * interval '1 second' END`,
        // Dead-lettering here often has no accompanying notify (a crashed worker).
        // Nulling the stamp lets the re-notify sweep reach it; harmless when the
        // task instead sleeps (the sweep never selects sleeping rows).
        attentionNotifiedAt: null,
        lockedUntil: null,
        queueGeneration: sql`${tasks.queueGeneration} + 1`,
        updatedAt: sql`now()`,
      })
      .where(activeLease(task))
      .returning({
        id: tasks.id,
        agentId: tasks.agentId,
        type: tasks.type,
        parentTaskId: tasks.parentTaskId,
        goalId: tasks.goalId,
        conversationId: tasks.conversationId,
        status: tasks.status,
        attempt: tasks.attempt,
      });
    if (!updated) return 'lost_lease';
    if (updated.status !== 'needs_attention') return 'retry';

    const isMission = updated.type === 'mission';
    const parent =
      !isMission && updated.type === 'adhoc' && updated.parentTaskId
        ? (await tx.select().from(tasks).where(eq(tasks.id, updated.parentTaskId)).for('update'))[0]
        : undefined;
    const mission = isMission
      ? (await tx.select().from(tasks).where(eq(tasks.id, updated.id)).for('update'))[0]
      : parent?.type === 'mission' && parent.agentId === updated.agentId
        ? parent
        : undefined;
    if (!mission) return 'dead_letter';

    if (!isMission && !TERMINAL.includes(mission.status as (typeof TERMINAL)[number])) {
      await tx
        .update(tasks)
        .set({
          status: 'needs_attention',
          progress:
            'A mission work session exhausted its retries and needs review before the mission can continue.',
          lockedUntil: null,
          runAfter: null,
          attentionNotifiedAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(tasks.id, mission.id));
    }
    const report = missionTaskTerminalReport({
      mission,
      task: { id: updated.id },
      status: 'needs_attention',
      attempt: updated.attempt,
      now: new Date(),
    });
    await tx
      .insert(missionReports)
      .values(report)
      .onConflictDoNothing({ target: missionReports.id });
    return 'dead_letter';
  });
}

export async function wakeTask(
  db: Db,
  taskId: string,
  budgetIncrease?: { agentId: string; limit: number },
): Promise<TaskWake | null> {
  if (budgetIncrease && normalizeTaskBudget(budgetIncrease.limit, 0.01) === null) return null;
  const [woken] = await db
    .update(tasks)
    .set({
      status: 'pending',
      ...(budgetIncrease ? { budgetUsdLimit: budgetIncrease.limit.toFixed(4) } : {}),
      // A needs-attention final has already been delivered. Retrying it must
      // continue from the saved work checkpoint, not finalize the same message
      // and immediately return to needs_attention. Approval/budget/event wakes
      // keep their checkpoint untouched.
      state: sql`CASE WHEN ${tasks.status} = 'needs_attention' THEN ${tasks.state} - 'pendingFinal' ELSE ${tasks.state} END`,
      runAfter: null,
      lockedUntil: null,
      queueGeneration: sql`${tasks.queueGeneration} + 1`,
      attempt: 0,
      // Leaving the waiting-on-owner state clears the notified stamp; a later
      // re-park re-arms it, so the sweep never re-notifies a resumed task.
      attentionNotifiedAt: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        inArray(tasks.status, [...WAKEABLE]),
        ...(budgetIncrease
          ? [
              eq(tasks.agentId, budgetIncrease.agentId),
              eq(tasks.status, 'needs_attention'),
              sql`${tasks.budgetUsdLimit} < ${budgetIncrease.limit}`,
              lte(tasks.spentUsd, budgetIncrease.limit.toFixed(4)),
            ]
          : []),
      ),
    )
    .returning({ id: tasks.id, queueGeneration: tasks.queueGeneration });
  if (!woken) return null;
  return woken;
}

export async function findDueTasks(db: Db, limit = 10): Promise<TaskRow[]> {
  // A Cloud Tasks delivery normally retries itself if its worker disappears.
  // If the delivery is exhausted or the process dies after acknowledgement,
  // turn the expired lease into a new runnable generation exactly once. The
  // status guard makes concurrent sweepers converge on the same transition.
  // The expired set is almost always empty; check before issuing the UPDATE so
  // the local 2s poll loop does not write on every idle tick.
  const expiredRunning = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'running'),
        or(isNull(tasks.lockedUntil), lte(tasks.lockedUntil, sql`now()`)),
      ),
    )
    .orderBy(tasks.lockedUntil)
    .limit(limit);
  if (expiredRunning.length > 0) {
    await db
      .update(tasks)
      .set({
        // Count the reclaim, and dead-letter to needs_attention once a task has
        // been reclaimed MAX_RECLAIMS times without ever checkpointing progress
        // (a deterministically hanging/crashing step) instead of resurrecting it
        // to churn a worker forever with no owner-visible terminal state.
        status: sql`CASE WHEN ${tasks.reclaimCount} + 1 >= ${MAX_RECLAIMS} THEN 'needs_attention' ELSE 'pending' END`,
        reclaimCount: sql`${tasks.reclaimCount} + 1`,
        progress: sql`CASE WHEN ${tasks.reclaimCount} + 1 >= ${MAX_RECLAIMS} THEN 'stopped after a worker repeatedly failed to complete a step without recording progress (hung or killed ' || (${tasks.reclaimCount} + 1)::text || ' times)' ELSE ${tasks.progress} END`,
        runAfter: sql`CASE WHEN ${tasks.reclaimCount} + 1 >= ${MAX_RECLAIMS} THEN NULL ELSE ${tasks.runAfter} END`,
        // This dead-letter path has no notify at all — let the re-notify sweep
        // reach it. Null on the pending branch is never read (sweep skips it).
        attentionNotifiedAt: null,
        lockedUntil: null,
        queueGeneration: sql`${tasks.queueGeneration} + 1`,
      })
      .where(
        and(
          eq(tasks.status, 'running'),
          or(isNull(tasks.lockedUntil), lte(tasks.lockedUntil, sql`now()`)),
          inArray(
            tasks.id,
            expiredRunning.map((row) => row.id),
          ),
        ),
      );
  }

  return db
    .select()
    .from(tasks)
    .where(
      and(
        or(
          eq(tasks.status, 'pending'),
          and(eq(tasks.status, 'sleeping'), lte(tasks.runAfter, sql`now()`)),
          and(eq(tasks.status, 'waiting_budget'), lte(tasks.runAfter, sql`now()`)),
        ),
        or(isNull(tasks.runAfter), lte(tasks.runAfter, sql`now()`)),
      ),
    )
    .orderBy(tasks.updatedAt)
    .limit(limit);
}

export function createPostgresTaskRepository(db: Db): TaskRepository {
  return {
    ...createPostgresTaskLeaseRepository(db),
    async getTask(taskId) {
      if (!taskId) return null;
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
      return task ?? null;
    },
    async precedingOwnerTasks(input) {
      const rows = await db
        .select({ id: tasks.id, trigger: tasks.trigger, status: tasks.status })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, input.agentId),
            eq(tasks.conversationId, input.conversationId),
            eq(tasks.trust, 'owner'),
            eq(tasks.type, input.taskType),
            lt(tasks.createdAt, input.createdBefore),
          ),
        )
        .orderBy(desc(tasks.createdAt))
        .limit(input.limit ?? 10);
      return rows;
    },
    createTask: (input) => createTask(db, input),
    createScheduledFollowUp: (input) => createScheduledFollowUp(db, input),
    persistPlan: (task, plan) => persistPlan(db, task, plan),
    parkForApproval: (...args) => parkForApproval(db, ...args),
    parkForBudget: (...args) => parkForBudget(db, ...args),
    sleepTask: (...args) => sleepTask(db, ...args),
    completeTask: (...args) => completeTask(db, ...args),
    markTaskNeedsAttention: (...args) => markTaskNeedsAttention(db, ...args),
    parkForEvent: (...args) => parkForEvent(db, ...args),
    markAttentionNotified: (...args) => markAttentionNotified(db, ...args),
    recordFailedAttempt: (...args) => recordFailedAttempt(db, ...args),
    wakeTask: (...args) => wakeTask(db, ...args),
    findDueTasks: (...args) => findDueTasks(db, ...args),
  };
}
