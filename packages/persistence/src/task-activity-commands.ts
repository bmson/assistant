/** Owner-scoped archive state changes for mobile Activity. */
export interface ArchiveOldActivityProgress {
  /** Stable identifier for resuming a bounded archive run. Null for atomic SQL runs. */
  operationId: string | null;
  scannedThisBatch: number;
  archivedThisBatch: number;
  scannedTotal: number;
  archivedTotal: number;
  complete: boolean;
}

export type TaskActivityOutcomeCode =
  | 'cancelled'
  | 'already_cancelled'
  | 'already_terminal'
  | 'retried'
  | 'no_longer_retriable'
  | 'not_found'
  | 'archived'
  | 'already_archived'
  | 'restored'
  | 'already_restored'
  | 'autonomy_revoked'
  | 'already_applied'
  | 'budget_raised';

/** State returned from the same atomic read/write decision that produced an outcome. */
export interface TaskActivityCurrentState {
  id: string;
  status: string;
  queueGeneration: number | null;
  archivedAt: string | null;
  budgetUsdLimit: string | null;
  autonomyRevoked: boolean;
}

export interface TaskActivityCommandOutcome {
  outcome: TaskActivityOutcomeCode;
  transitioned: boolean;
  current: TaskActivityCurrentState | null;
}

export function taskActivityOutcome(
  outcome: TaskActivityOutcomeCode,
  current: TaskActivityCurrentState | null,
  transitioned = false,
): TaskActivityCommandOutcome {
  return { outcome, transitioned, current };
}

export interface TaskActivityCommandRepository {
  readonly kind: 'task-activity-command-repository';
  archive(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome>;
  restore(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome>;
  retry(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome>;
  cancel(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome>;
  revokeAutonomy(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome>;
  raiseBudget(agentId: string, taskId: string, limit: number): Promise<TaskActivityCommandOutcome>;
  archiveOld(
    agentId: string,
    olderThanDays?: number,
    operationId?: string,
  ): Promise<ArchiveOldActivityProgress>;
}
