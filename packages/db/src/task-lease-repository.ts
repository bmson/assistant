import { randomUUID } from 'node:crypto';
import type { TaskCheckpoint, TaskLease, TaskLeaseRepository } from '@assistant/persistence';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { type TaskRow, tasks } from './schema.js';

const CLAIMABLE = ['pending', 'sleeping', 'waiting_budget'] as const;
const LEASE_MINUTES = 10;
function newLeaseExpiry() {
  return sql`date_trunc('milliseconds', clock_timestamp()) + interval '${sql.raw(String(LEASE_MINUTES))} minutes'`;
}
function hasLease(task: TaskRow): task is TaskLease {
  return task.status === 'running' && task.lockedUntil instanceof Date;
}
export function activeLease(task: TaskLease) {
  return and(
    eq(tasks.id, task.id),
    eq(tasks.status, 'running'),
    eq(tasks.lockedUntil, task.lockedUntil),
    task.leaseToken ? eq(tasks.leaseToken, task.leaseToken) : isNull(tasks.leaseToken),
    gt(tasks.lockedUntil, sql`now()`),
  );
}
export async function claimTask(
  db: Db,
  taskId: string,
  generation?: number,
): Promise<TaskLease | null> {
  if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0))
    return null;
  const lockedUntil = newLeaseExpiry();
  const [claimed] = await db
    .update(tasks)
    .set({
      status: 'running',
      lockedUntil,
      leaseToken: randomUUID(),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        ...(generation === undefined ? [] : [eq(tasks.queueGeneration, generation)]),
        or(
          and(
            or(...CLAIMABLE.map((s) => eq(tasks.status, s))),
            or(isNull(tasks.lockedUntil), lte(tasks.lockedUntil, sql`now()`)),
          ),
          // A crashed worker's expired running lease is atomically reclaimed.
          and(
            eq(tasks.status, 'running'),
            or(isNull(tasks.lockedUntil), lte(tasks.lockedUntil, sql`now()`)),
          ),
        ),
        or(isNull(tasks.runAfter), lte(tasks.runAfter, sql`now()`)),
      ),
    )
    .returning();
  if (!claimed || !hasLease(claimed)) return null;
  return claimed;
}

export async function renewTaskLease(db: Db, task: TaskLease): Promise<boolean> {
  const lockedUntil = newLeaseExpiry();
  const [renewed] = await db
    .update(tasks)
    .set({
      lockedUntil,
      leaseToken: randomUUID(),
      updatedAt: sql`now()`,
    })
    .where(activeLease(task))
    .returning({ lockedUntil: tasks.lockedUntil, leaseToken: tasks.leaseToken });
  if (!renewed?.lockedUntil) return false;
  task.lockedUntil = renewed.lockedUntil;
  task.leaseToken = renewed.leaseToken;
  return true;
}

export async function checkpointTask(
  db: Db,
  task: TaskLease,
  state: unknown,
  extra: TaskCheckpoint = {},
): Promise<boolean> {
  const { preserveFailureCounters, ...fields } = extra;
  const [updated] = await db
    .update(tasks)
    // Work-step checkpoints clear failure counters. Preparing recall/checklist
    // metadata must preserve them, or a failing first work step can evade its
    // exhausted retry budget merely by saving setup state again.
    .set({
      state,
      ...fields,
      ...(preserveFailureCounters ? {} : { attempt: 0, reclaimCount: 0 }),
      updatedAt: sql`now()`,
    })
    .where(activeLease(task))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

export function createPostgresTaskLeaseRepository(db: Db): TaskLeaseRepository {
  return {
    kind: 'task-lease-repository',
    claim: (id, generation) => claimTask(db, id, generation),
    renew: (task) => renewTaskLease(db, task),
    checkpoint: (task, state, extra) => checkpointTask(db, task, state, extra),
  };
}
