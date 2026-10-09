'use server';

import { normalizeTaskBudget } from '@assistant/persistence';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireOwner } from '@/auth';
import {
  archiveOldTaskActivity,
  archiveTaskActivity,
  cancelTaskActivity,
  raiseTaskActivityBudget,
  restoreTaskActivity,
  retryTaskActivity,
  revokeTaskActivityAutonomy,
} from '@/lib/task-activity';

function revalidateTaskViews(taskId: string): void {
  revalidatePath('/');
  revalidatePath('/tasks');
  revalidatePath(`/tasks/${taskId}`);
  revalidatePath('/chat', 'layout');
}

/** Re-queue a stuck task (needs_attention → pending). */
export async function retryTask(taskId: string) {
  await requireOwner();
  const outcome = await retryTaskActivity(taskId);
  if (outcome.outcome === 'not_found') throw new Error('activity item not found');
  revalidateTaskViews(taskId);
}

/**
 * Revoke a task's free-range autonomy grant mid-run. Marks the grant revoked so
 * the dispatcher stops downgrading its calls; the next gated call parks normally.
 * Owner-only.
 */
export async function revokeAutonomyGrant(taskId: string) {
  await requireOwner();
  const outcome = await revokeTaskActivityAutonomy(taskId);
  if (outcome.outcome === 'not_found') throw new Error('activity item not found');
  revalidateTaskViews(taskId);
}

/** Raise one task's hard cap and immediately re-queue its checkpointed work. */
export async function raiseTaskBudgetAndRetry(taskId: string, formData: FormData) {
  await requireOwner();
  const raw = formData.get('budgetUsdLimit');
  const normalized = normalizeTaskBudget(typeof raw === 'string' ? raw.trim() : raw, 0.01);
  if (normalized === null)
    throw new Error(
      'task budget must be between $0.01 and $9,999.9999 with at most four decimal places',
    );
  const outcome = await raiseTaskActivityBudget(taskId, Number(normalized));
  if (outcome.outcome === 'not_found') throw new Error('activity item not found');
  if (!['budget_raised', 'already_terminal'].includes(outcome.outcome))
    throw new Error('Task can no longer be resumed with a higher budget.');
  revalidateTaskViews(taskId);
}

export async function cancelChatTask(taskId: string) {
  await requireOwner();
  const outcome = await cancelTaskActivity(taskId);
  revalidateTaskViews(taskId);
  return outcome;
}

export async function cancelTask(taskId: string): Promise<void> {
  await requireOwner();
  const outcome = await cancelTaskActivity(taskId);
  if (!['cancelled', 'already_cancelled'].includes(outcome.outcome))
    throw new Error(
      outcome.outcome === 'not_found' ? 'activity item not found' : 'task already finished',
    );
  revalidateTaskViews(taskId);
}

/** Hide terminal activity from the default list without deleting any evidence. */
export async function archiveTask(taskId: string): Promise<void> {
  await requireOwner();
  const outcome = await archiveTaskActivity(taskId);
  if (outcome.outcome === 'not_found') throw new Error('activity item not found');
  if (outcome.outcome === 'no_longer_retriable')
    throw new Error('only completed, failed, or cancelled activity can be archived');
  revalidateTaskViews(taskId);
  redirect('/tasks');
}

/** Restore a hidden activity item to the main Activity list. */
export async function restoreTask(taskId: string): Promise<void> {
  await requireOwner();
  const outcome = await restoreTaskActivity(taskId);
  if (outcome.outcome === 'not_found') throw new Error('activity item not found');
  revalidateTaskViews(taskId);
  redirect(`/tasks/${taskId}`);
}

/** Archive only terminal activity that has been quiet for at least 30 days. */
export async function archiveOldTasks(formData: FormData): Promise<void> {
  await requireOwner();
  const rawOperationId = formData.get('operationId');
  const operationId = typeof rawOperationId === 'string' ? rawOperationId : undefined;
  if (operationId !== undefined && !/^[0-9a-f-]{36}$/i.test(operationId))
    throw new Error('Invalid archive operation. Refresh Activity and try again.');
  const progress = await archiveOldTaskActivity(operationId);
  revalidateTaskViews('');
  const query = new URLSearchParams({
    archivedTotal: String(progress.archivedTotal),
    archiveComplete: String(progress.complete),
    ...(progress.operationId && !progress.complete
      ? { archiveOperation: progress.operationId }
      : {}),
  });
  redirect(`/tasks?${query.toString()}`);
}
