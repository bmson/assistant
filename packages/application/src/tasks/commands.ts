import { getAgent } from '@assistant/core/chat';
import { getQueueNotifier } from '@assistant/core/queue';
import { type Db, notChatAdmissionCancellationSql, tasks } from '@assistant/db';
import type {
  ArchiveOldActivityProgress,
  TaskActivityCommandOutcome,
  TaskActivityCommandRepository,
  TaskActivityCurrentState,
} from '@assistant/persistence';
import {
  chatAdmissionCancellationPayload,
  normalizeTaskBudget,
  taskActivityOutcome,
} from '@assistant/persistence';
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import { terminalTaskStatuses } from './queries.js';

const WAKEABLE = new Set([
  'waiting_approval',
  'waiting_event',
  'sleeping',
  'waiting_budget',
  'needs_attention',
]);

function currentTask(task: typeof tasks.$inferSelect): TaskActivityCurrentState {
  const grant = task.autonomyGrant as Record<string, unknown> | null;
  return {
    id: task.id,
    status: task.status,
    queueGeneration: Number.isSafeInteger(task.queueGeneration) ? task.queueGeneration : null,
    archivedAt: task.archivedAt?.toISOString() ?? null,
    budgetUsdLimit: task.budgetUsdLimit,
    autonomyRevoked: Boolean(grant?.revokedAt),
  };
}

function notifyWake(taskId: string, generation: number): void {
  try {
    getQueueNotifier().notify(taskId, generation);
  } catch {
    // The durable task row and periodic sweeper remain authoritative if a
    // best-effort transport notification fails after the mutation commits.
  }
}

export async function retryActivity(db: Db, taskId: string): Promise<TaskActivityCommandOutcome> {
  const agent = await getAgent(db);
  const outcome = await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
      .limit(1)
      .for('update');
    if (!task || chatAdmissionCancellationPayload(task))
      return taskActivityOutcome('not_found', null);
    if (!WAKEABLE.has(task.status))
      return taskActivityOutcome(
        ['done', 'failed', 'cancelled'].includes(task.status)
          ? 'already_terminal'
          : 'no_longer_retriable',
        currentTask(task),
      );
    if (!Number.isSafeInteger(task.queueGeneration) || task.queueGeneration < 0)
      throw new Error('Invalid task queue generation');
    const state =
      task.state && typeof task.state === 'object' && !Array.isArray(task.state)
        ? { ...(task.state as Record<string, unknown>) }
        : task.state;
    if (task.status === 'needs_attention' && state && typeof state === 'object')
      delete (state as Record<string, unknown>).pendingFinal;
    const now = new Date();
    const [updated] = await tx
      .update(tasks)
      .set({
        status: 'pending',
        ...(state === undefined ? {} : { state }),
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        queueGeneration: task.queueGeneration + 1,
        attempt: 0,
        attentionNotifiedAt: null,
        updatedAt: now,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id), eq(tasks.status, task.status)))
      .returning();
    if (!updated) return taskActivityOutcome('no_longer_retriable', currentTask(task));
    return taskActivityOutcome('retried', currentTask(updated), true);
  });
  if (outcome.outcome === 'retried' && outcome.current && outcome.current.queueGeneration !== null)
    notifyWake(taskId, outcome.current.queueGeneration);
  return outcome;
}

export async function revokeTaskAutonomy(
  db: Db,
  taskId: string,
): Promise<TaskActivityCommandOutcome> {
  const agent = await getAgent(db);
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
      .limit(1)
      .for('update');
    if (!task || chatAdmissionCancellationPayload(task))
      return taskActivityOutcome('not_found', null);
    const grant = task.autonomyGrant as Record<string, unknown> | null;
    if (!grant?.revokedAt) {
      const now = new Date().toISOString();
      const [updated] = await tx
        .update(tasks)
        .set({ autonomyGrant: { ...(grant ?? {}), revokedAt: now }, updatedAt: new Date(now) })
        .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
        .returning();
      if (updated) return taskActivityOutcome('autonomy_revoked', currentTask(updated), true);
    }
    return taskActivityOutcome('already_applied', currentTask(task));
  });
}

export async function raiseTaskBudget(
  db: Db,
  taskId: string,
  requested: number,
): Promise<TaskActivityCommandOutcome> {
  if (normalizeTaskBudget(requested, 0.01) === null) {
    throw new Error(
      'task budget must be between $0.01 and $9,999.9999 with at most four decimal places',
    );
  }
  const agent = await getAgent(db);
  const outcome = await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
      .limit(1)
      .for('update');
    if (!task || chatAdmissionCancellationPayload(task))
      return taskActivityOutcome('not_found', null);
    if (task.status !== 'needs_attention')
      return taskActivityOutcome(
        ['done', 'failed', 'cancelled'].includes(task.status)
          ? 'already_terminal'
          : 'no_longer_retriable',
        currentTask(task),
      );
    if (requested <= Number(task.budgetUsdLimit) || requested < Number(task.spentUsd))
      return taskActivityOutcome('no_longer_retriable', currentTask(task));
    if (!Number.isSafeInteger(task.queueGeneration) || task.queueGeneration < 0)
      throw new Error('Invalid task queue generation');
    const state =
      task.state && typeof task.state === 'object' && !Array.isArray(task.state)
        ? { ...(task.state as Record<string, unknown>) }
        : task.state;
    if (state && typeof state === 'object' && !Array.isArray(state))
      delete (state as Record<string, unknown>).pendingFinal;
    const now = new Date();
    const [updated] = await tx
      .update(tasks)
      .set({
        status: 'pending',
        budgetUsdLimit: requested.toFixed(4),
        ...(state === undefined ? {} : { state }),
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        queueGeneration: task.queueGeneration + 1,
        attempt: 0,
        attentionNotifiedAt: null,
        updatedAt: now,
      })
      .where(
        and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id), eq(tasks.status, 'needs_attention')),
      )
      .returning();
    return updated
      ? taskActivityOutcome('budget_raised', currentTask(updated), true)
      : taskActivityOutcome('no_longer_retriable', currentTask(task));
  });
  if (
    outcome.outcome === 'budget_raised' &&
    outcome.current &&
    outcome.current.queueGeneration !== null
  )
    notifyWake(taskId, outcome.current.queueGeneration);
  return outcome;
}

export async function cancelActivity(db: Db, taskId: string): Promise<TaskActivityCommandOutcome> {
  const agent = await getAgent(db);
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
      .limit(1)
      .for('update');
    if (!task || chatAdmissionCancellationPayload(task))
      return taskActivityOutcome('not_found', null);
    if (task.status === 'cancelled')
      return taskActivityOutcome('already_cancelled', currentTask(task));
    if (terminalTaskStatuses.includes(task.status as (typeof terminalTaskStatuses)[number]))
      return taskActivityOutcome('already_terminal', currentTask(task));
    const [updated] = await tx
      .update(tasks)
      .set({
        status: 'cancelled',
        lockedUntil: null,
        leaseToken: null,
        runAfter: null,
        attempt: 0,
        updatedAt: sql`now()`,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id), eq(tasks.status, task.status)))
      .returning();
    return updated
      ? taskActivityOutcome('cancelled', currentTask(updated), true)
      : taskActivityOutcome('already_terminal', currentTask(task));
  });
}

/** Portable owner-scoped commands used by the Firestore mobile Activity route. */
export function archiveActivityWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  taskId: string,
): Promise<TaskActivityCommandOutcome> {
  return repository.archive(agentId, taskId);
}

export function restoreActivityWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  taskId: string,
): Promise<TaskActivityCommandOutcome> {
  return repository.restore(agentId, taskId);
}

export function retryActivityWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  taskId: string,
): Promise<TaskActivityCommandOutcome> {
  return repository.retry(agentId, taskId);
}

export function cancelActivityWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  taskId: string,
): Promise<TaskActivityCommandOutcome> {
  return repository.cancel(agentId, taskId);
}

export function revokeTaskAutonomyWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  taskId: string,
): Promise<TaskActivityCommandOutcome> {
  return repository.revokeAutonomy(agentId, taskId);
}

export function raiseTaskBudgetWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  taskId: string,
  limit: number,
): Promise<TaskActivityCommandOutcome> {
  return repository.raiseBudget(agentId, taskId, limit);
}

/** Archives old terminal activity through the configured persistence adapter. */
export function archiveOldActivityWithRepository(
  repository: TaskActivityCommandRepository,
  agentId: string,
  olderThanDays = 30,
  operationId?: string,
): Promise<ArchiveOldActivityProgress> {
  return repository.archiveOld(agentId, olderThanDays, operationId);
}

export async function archiveActivity(db: Db, taskId: string): Promise<TaskActivityCommandOutcome> {
  const agent = await getAgent(db);
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
      .limit(1)
      .for('update');
    if (!task || chatAdmissionCancellationPayload(task))
      return taskActivityOutcome('not_found', null);
    if (task.archivedAt) return taskActivityOutcome('already_archived', currentTask(task));
    if (!terminalTaskStatuses.includes(task.status as (typeof terminalTaskStatuses)[number]))
      return taskActivityOutcome('no_longer_retriable', currentTask(task));
    const now = new Date();
    const [updated] = await tx
      .update(tasks)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.agentId, agent.id),
          eq(tasks.status, task.status),
          isNull(tasks.archivedAt),
        ),
      )
      .returning();
    return updated
      ? taskActivityOutcome('archived', currentTask(updated), true)
      : taskActivityOutcome('already_archived', currentTask(task));
  });
}

export async function restoreActivity(db: Db, taskId: string): Promise<TaskActivityCommandOutcome> {
  const agent = await getAgent(db);
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
      .limit(1)
      .for('update');
    if (!task || chatAdmissionCancellationPayload(task))
      return taskActivityOutcome('not_found', null);
    if (!task.archivedAt) return taskActivityOutcome('already_restored', currentTask(task));
    const [updated] = await tx
      .update(tasks)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.agentId, agent.id), isNotNull(tasks.archivedAt)))
      .returning();
    return updated
      ? taskActivityOutcome('restored', currentTask(updated), true)
      : taskActivityOutcome('already_restored', currentTask(task));
  });
}

export async function archiveOldActivity(
  db: Db,
  olderThanDays = 30,
): Promise<ArchiveOldActivityProgress> {
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0)
    throw new Error('Invalid archive-old activity request');
  const agent = await getAgent(db);
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const archived = await db
    .update(tasks)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(tasks.agentId, agent.id),
        notChatAdmissionCancellationSql(),
        isNull(tasks.archivedAt),
        inArray(tasks.status, terminalTaskStatuses),
        lt(tasks.updatedAt, cutoff),
      ),
    )
    .returning({ id: tasks.id });
  return {
    operationId: null,
    scannedThisBatch: archived.length,
    archivedThisBatch: archived.length,
    scannedTotal: archived.length,
    archivedTotal: archived.length,
    complete: true,
  };
}
