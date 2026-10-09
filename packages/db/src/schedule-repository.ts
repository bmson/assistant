import { randomUUID } from 'node:crypto';
import type {
  ScheduleOccurrence,
  ScheduleRecord,
  ScheduleRepository,
  TaskCreateResult,
} from '@assistant/persistence';
import {
  GOAL_SUPERSEDED_PROGRESS,
  GOAL_TASK_TERMINAL,
  goalOccurrenceIsCurrent,
  occurrenceIsCurrent,
  scheduleBatch,
  scheduleCanRun,
  scheduleMatches,
  scheduleTime,
  validateScheduleCreate,
} from '@assistant/persistence';
import { and, asc, eq, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { goals, schedules, tasks } from './schema.js';
import { createTask } from './task-creation-repository.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PostgreSQL's transaction-scoped lock is shared with reminder cancellation and
 * delivery. Keeping the lock acquisition in this repository makes every
 * schedule mutation use the same serialization boundary.
 */
async function lockSchedule(tx: Tx, scheduleId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scheduleId}))`);
}

/** Re-read a schedule after taking its advisory lock and row lock. */
async function lockedSchedule(tx: Tx, scheduleId: string): Promise<ScheduleRecord | null> {
  const [row] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId)).for('update');
  return row ?? null;
}

async function commitSerializable<T>(db: Db, commit: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(commit, { isolationLevel: 'serializable' });
    } catch (error) {
      let cause: unknown = error;
      let conflict = false;
      for (let depth = 0; depth < 5 && cause && typeof cause === 'object'; depth += 1) {
        const record = cause as { code?: string; cause?: unknown };
        if (record.code === '40001' || record.code === '40P01') conflict = true;
        cause = record.cause;
      }
      if (!conflict || attempt >= 3) throw error;
    }
  }
}

export function createPostgresScheduleRepository(db: Db): ScheduleRepository {
  return {
    kind: 'schedule-repository',

    async listPage(agentId, options = {}) {
      const batch = scheduleBatch(options.limit);
      if (options.afterId !== undefined && !UUID_PATTERN.test(options.afterId))
        throw new Error('Invalid schedule cursor');
      const rows = await db
        .select()
        .from(schedules)
        .where(
          and(
            eq(schedules.agentId, agentId),
            options.afterId === undefined ? undefined : sql`${schedules.id} > ${options.afterId}`,
          ),
        )
        .orderBy(asc(schedules.id))
        .limit(batch);
      return {
        items: rows,
        nextCursor: rows.length === batch ? (rows.at(-1)?.id ?? null) : null,
      };
    },

    async ensure(input) {
      validateScheduleCreate(input);
      // Generate the id before insertion so a newly-created row is protected by
      // the same lock that cancellation will take once it knows that id.
      const candidateId = randomUUID();
      return db.transaction(async (tx) => {
        await lockSchedule(tx, candidateId);

        // A pre-existing row must be locked by its own id before it is returned;
        // otherwise cancellation could update it between the lookup and return.
        const [existing] = await tx
          .select()
          .from(schedules)
          .where(and(eq(schedules.agentId, input.agentId), eq(schedules.name, input.name)))
          .limit(1);
        if (existing) {
          await lockSchedule(tx, existing.id);
          return (await lockedSchedule(tx, existing.id)) ?? existing;
        }

        const [created] = await tx
          .insert(schedules)
          .values({
            id: candidateId,
            agentId: input.agentId,
            name: input.name,
            cron: input.cron,
            taskTemplate: input.taskTemplate,
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            nextRunAt: input.nextRunAt,
          })
          .onConflictDoNothing({ target: [schedules.agentId, schedules.name] })
          .returning();
        if (created) return created;

        // Another creator won the unique-key race. Lock and re-read its row so
        // ensure still coordinates with cancellation before returning it.
        const [winner] = await tx
          .select({ id: schedules.id })
          .from(schedules)
          .where(and(eq(schedules.agentId, input.agentId), eq(schedules.name, input.name)))
          .limit(1);
        if (!winner) throw new Error('Schedule creation conflict without an existing schedule');
        await lockSchedule(tx, winner.id);
        const current = await lockedSchedule(tx, winner.id);
        if (!current) throw new Error('Schedule disappeared after creation conflict');
        return current;
      });
    },

    async getByName(agentId, name) {
      const [row] = await db
        .select()
        .from(schedules)
        .where(and(eq(schedules.agentId, agentId), eq(schedules.name, name)))
        .limit(1);
      return row ?? null;
    },

    async setOwnerEnabled(agentId, scheduleId, enabled) {
      return db.transaction(async (tx) => {
        await lockSchedule(tx, scheduleId);
        const current = await lockedSchedule(tx, scheduleId);
        if (!current || current.agentId !== agentId || current.name.startsWith('reminder:'))
          return false;
        const [updated] = await tx
          .update(schedules)
          .set({ enabled, ...(enabled ? { nextRunAt: null } : {}), updatedAt: sql`now()` })
          .where(and(eq(schedules.id, scheduleId), eq(schedules.agentId, agentId)))
          .returning({ id: schedules.id });
        return Boolean(updated);
      });
    },

    async listUninitialized(limit) {
      const batch = scheduleBatch(limit);
      return db
        .select()
        .from(schedules)
        .where(and(eq(schedules.enabled, true), isNull(schedules.nextRunAt)))
        .orderBy(asc(schedules.nextRunAt), asc(schedules.id))
        .limit(batch);
    },

    async listDue(now, limit) {
      scheduleTime(now);
      const batch = scheduleBatch(limit);
      return db
        .select()
        .from(schedules)
        .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now)))
        .orderBy(asc(schedules.nextRunAt), asc(schedules.id))
        .limit(batch);
    },

    async initialize(expected, nextRunAt, now) {
      scheduleTime(nextRunAt);
      scheduleTime(now);
      return db.transaction(async (tx) => {
        await lockSchedule(tx, expected.id);
        const current = await lockedSchedule(tx, expected.id);
        if (
          !current ||
          current.nextRunAt !== null ||
          !scheduleMatches(current, expected) ||
          !scheduleCanRun(current)
        ) {
          return false;
        }
        const [updated] = await tx
          .update(schedules)
          .set({ nextRunAt, updatedAt: now })
          .where(eq(schedules.id, current.id))
          .returning({ id: schedules.id });
        return Boolean(updated);
      });
    },

    async commitOccurrence(input: ScheduleOccurrence) {
      scheduleTime(input.now);
      if (input.nextRunAt !== null) scheduleTime(input.nextRunAt);
      return commitSerializable(db, async (tx) => {
        await lockSchedule(tx, input.expected.id);
        const current = await lockedSchedule(tx, input.expected.id);
        if (!current || !occurrenceIsCurrent(current, input)) return null;
        if (input.goalGuard) {
          const [goal] = await tx
            .select()
            .from(goals)
            .where(and(eq(goals.id, input.goalGuard.goal.id), eq(goals.agentId, current.agentId)))
            .for('update');
          const openTasks = await tx
            .select({
              id: tasks.id,
              type: tasks.type,
              status: tasks.status,
              updatedAt: tasks.updatedAt,
            })
            .from(tasks)
            .where(
              and(
                eq(tasks.agentId, current.agentId),
                eq(tasks.goalId, input.goalGuard.goal.id),
                notInArray(tasks.status, GOAL_TASK_TERMINAL),
              ),
            )
            .orderBy(asc(tasks.id))
            .for('update');
          if (!goalOccurrenceIsCurrent(input, goal ?? null, openTasks)) return null;
        } else if (!goalOccurrenceIsCurrent(input, null, [])) return null;

        let task: TaskCreateResult | null = null;
        // createTask is intentionally reused here for its defaults and
        // idempotency. Its public type accepts the root Db, while this call
        // must stay inside the already-open transaction/savepoint.
        if (input.task) {
          task = await createTask(tx as unknown as Db, input.task);
          const trigger = task.task.trigger as {
            source?: string;
            payload?: { scheduleId?: string };
          } | null;
          if (trigger?.source !== 'schedule' || trigger.payload?.scheduleId !== current.id)
            throw new Error('Task event belongs to another schedule');
        }

        if (task?.created && input.goalGuard) {
          for (const id of input.goalGuard.supersedeTaskIds)
            await tx
              .update(tasks)
              .set({
                status: 'cancelled',
                progress: GOAL_SUPERSEDED_PROGRESS,
                updatedAt: input.now,
                lockedUntil: null,
                leaseToken: null,
                runAfter: null,
                attempt: 0,
              })
              .where(and(eq(tasks.id, id), eq(tasks.agentId, current.agentId)));
        }

        const [updated] = await tx
          .update(schedules)
          .set({
            enabled: input.enabled,
            lastRunAt: input.now,
            nextRunAt: input.nextRunAt,
            updatedAt: input.now,
          })
          .where(eq(schedules.id, current.id))
          .returning();
        if (!updated) throw new Error('Schedule disappeared while committing occurrence');
        return { schedule: updated, task };
      });
    },
  };
}
