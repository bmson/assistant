import {
  type ActivityFilter,
  type ActivityStatus,
  archiveActivity,
  archiveActivityWithRepository,
  archiveOldActivity,
  archiveOldActivityWithRepository,
  cancelActivity,
  cancelActivityWithRepository,
  cancelPendingChecklistActivity,
  cancelPendingChecklistWithRepository,
  discoverActivityWithRepository,
  getActivityStatusWithRepository,
  getActivityStatus as getPostgresActivityStatus,
  getTaskDetail,
  getTaskDetailWithRepository,
  listActivity,
  listActivityWithRepository,
  raiseTaskBudget,
  raiseTaskBudgetWithRepository,
  restoreActivity,
  restoreActivityWithRepository,
  retryActivity,
  retryActivityWithRepository,
  revisePendingChecklistActivity,
  revisePendingChecklistWithRepository,
  revokeTaskAutonomy,
  revokeTaskAutonomyWithRepository,
  type TaskDetail,
  taskActivityChecklistCancellationPolicy,
  taskActivityChecklistCorrectionPolicy,
} from '@assistant/application/tasks';
import { loadConfig } from '@assistant/config';
import {
  FirestoreTaskActivityCommandRepository,
  FirestoreTaskActivityRepository,
} from '@assistant/firestore';
import type {
  PendingChecklistCancellationInput,
  PendingChecklistCancellationOutcome,
  PendingChecklistCorrectionInput,
  PendingChecklistCorrectionOutcome,
  TaskActivityCommandOutcome,
  TaskDiscoveryInput,
} from '@assistant/persistence';
import {
  getAgentIdentity,
  getDb,
  getFirestoreInstallationStore,
  getTaskDiscoveryPorts,
} from '@/lib/server';

function firestoreActivity() {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore') throw new Error('Firestore mode is not enabled');
  const repository = new FirestoreTaskActivityRepository(getFirestoreInstallationStore());
  return { repository, agentId: config.FIRESTORE_AGENT_ID };
}

export function listTaskActivity(input: {
  archived: boolean;
  filter: ActivityFilter;
  limit?: number;
}) {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    const { repository, agentId } = firestoreActivity();
    return listActivityWithRepository(repository, agentId, input);
  }
  return listActivity(getDb(), input);
}

export function getTaskActivityDetail(
  taskId: string,
  options: { pageSize?: number; before?: Date; cursor?: string } = {},
): Promise<TaskDetail | null> {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    const { repository, agentId } = firestoreActivity();
    return getTaskDetailWithRepository(repository, agentId, taskId, options);
  }
  return getTaskDetail(getDb(), taskId, options);
}

/** Compact owner-scoped status read for refreshing rows already shown in Activity. */
export async function getTaskActivityStatus(taskId: string): Promise<ActivityStatus | null> {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    const { repository, agentId } = firestoreActivity();
    return getActivityStatusWithRepository(repository, agentId, taskId);
  }
  return getPostgresActivityStatus(getDb(), taskId);
}

/** Owner-scoped task commands for the configured driver; null outside Firestore mode. */
function firestoreActivityCommands() {
  if (loadConfig().PERSISTENCE_DRIVER !== 'firestore') return null;
  const { agentId } = firestoreActivity();
  return {
    repository: new FirestoreTaskActivityCommandRepository(
      getFirestoreInstallationStore(),
      taskActivityChecklistCorrectionPolicy,
      taskActivityChecklistCancellationPolicy,
    ),
    agentId,
  };
}

/** Cancel one currently pending checklist item selected directly in Activity. */
export async function cancelTaskChecklistItemActivity(
  input: Omit<PendingChecklistCancellationInput, 'taskId'> & { taskId: string },
): Promise<PendingChecklistCancellationOutcome> {
  const firestore = firestoreActivityCommands();
  if (firestore)
    return cancelPendingChecklistWithRepository(firestore.repository, firestore.agentId, input);
  return cancelPendingChecklistActivity(getDb(), input);
}

export function archiveTaskActivity(taskId: string): Promise<TaskActivityCommandOutcome> {
  const firestore = firestoreActivityCommands();
  if (firestore)
    return archiveActivityWithRepository(firestore.repository, firestore.agentId, taskId);
  return archiveActivity(getDb(), taskId);
}

export function restoreTaskActivity(taskId: string): Promise<TaskActivityCommandOutcome> {
  const firestore = firestoreActivityCommands();
  if (firestore)
    return restoreActivityWithRepository(firestore.repository, firestore.agentId, taskId);
  return restoreActivity(getDb(), taskId);
}

export function archiveOldTaskActivity(operationId?: string) {
  const firestore = firestoreActivityCommands();
  if (firestore) {
    return operationId
      ? archiveOldActivityWithRepository(firestore.repository, firestore.agentId, 30, operationId)
      : archiveOldActivityWithRepository(firestore.repository, firestore.agentId);
  }
  return archiveOldActivity(getDb());
}

/** Re-queue a stalled task (needs_attention → pending). */
export async function retryTaskActivity(taskId: string): Promise<TaskActivityCommandOutcome> {
  const firestore = firestoreActivityCommands();
  if (firestore)
    return retryActivityWithRepository(firestore.repository, firestore.agentId, taskId);
  return retryActivity(getDb(), taskId);
}

/** Cancel owner work; the executor observes the terminal state at its next checkpoint. */
export async function cancelTaskActivity(taskId: string): Promise<TaskActivityCommandOutcome> {
  const firestore = firestoreActivityCommands();
  if (firestore) {
    return cancelActivityWithRepository(firestore.repository, firestore.agentId, taskId);
  }
  return cancelActivity(getDb(), taskId);
}

/** Revoke a task's autonomy grant so its next gated call parks for approval. */
export function revokeTaskActivityAutonomy(taskId: string): Promise<TaskActivityCommandOutcome> {
  const firestore = firestoreActivityCommands();
  if (firestore)
    return revokeTaskAutonomyWithRepository(firestore.repository, firestore.agentId, taskId);
  return revokeTaskAutonomy(getDb(), taskId);
}

/** Raise a stalled task's hard cap and re-queue it in the same state change. */
export function raiseTaskActivityBudget(
  taskId: string,
  limit: number,
): Promise<TaskActivityCommandOutcome> {
  const firestore = firestoreActivityCommands();
  if (firestore)
    return raiseTaskBudgetWithRepository(firestore.repository, firestore.agentId, taskId, limit);
  return raiseTaskBudget(getDb(), taskId, limit);
}

/** Persist the Activity-selected private lookup correction through the active driver. */
export async function reviseTaskActivityChecklistItem(
  input: PendingChecklistCorrectionInput,
): Promise<PendingChecklistCorrectionOutcome> {
  const firestore = firestoreActivityCommands();
  if (firestore)
    return revisePendingChecklistWithRepository(firestore.repository, firestore.agentId, input);
  const db = getDb();
  const owner = await getAgentIdentity();
  return revisePendingChecklistActivity(db, owner.id, input);
}

export async function discoverTaskActivity(input: TaskDiscoveryInput) {
  const { repository, agentId } = await getTaskDiscoveryPorts();
  return discoverActivityWithRepository(repository, agentId, input);
}
