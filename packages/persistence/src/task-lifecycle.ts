import type { BriefingRunOutcome } from './briefing.js';
import type { TaskLease, TaskLeaseRepository } from './contracts.js';
import type { Records } from './records.js';
import type { TaskActivityDiagnostic } from './task-activity.js';
import type { TaskCreateInput, TaskCreateResult } from './task-creation.js';

/** Input for the owner-scoped future-self task command. */
export interface ScheduledFollowUpInput {
  /** The task currently executing task.schedule. */
  parentTaskId: string;
  /** Used to prove that the caller owns parentTaskId. */
  agentId: string;
  conversationId?: string | null;
  instruction: string;
  runAfter: Date;
  /** Scheduled children are either owner work or assistant-origin work. */
  trust: 'owner' | 'assistant';
  /** Preserve taint provenance in the child trigger. */
  tainted: boolean;
}
export interface TaskOutcome {
  status: 'done' | 'failed' | 'cancelled';
  progress?: string;
  briefingOutcome?: BriefingRunOutcome;
  pulseCompleted?: boolean;
}
export interface TaskBudgetIncrease {
  agentId: string;
  limit: number;
}
export interface TaskWake {
  id: string;
  queueGeneration: number;
}
export interface AppendActivityDiagnosticInput {
  agentId: string;
  taskId: string;
  diagnostic: TaskActivityDiagnostic;
  /** Use the current lease for a producer write, when called through the executor. */
  leaseToken?: string;
}

export interface TaskRepository extends TaskLeaseRepository {
  /** Installation-scoped task lookup used before choosing an execution route. */
  getTask(taskId: string): Promise<Records['tasks'] | null>;
  /** Recent owner tasks before a chat task, used to resolve an exact prior-turn receipt check. */
  precedingOwnerTasks(input: {
    agentId: string;
    conversationId: string;
    taskType: string;
    createdBefore: Date;
    limit?: number;
  }): Promise<Array<Pick<Records['tasks'], 'id' | 'trigger' | 'status'>>>;
  createTask(input: TaskCreateInput): Promise<TaskCreateResult>;
  /** Atomically create an owner-scoped scheduled child and its initial wake. */
  createScheduledFollowUp(input: ScheduledFollowUpInput): Promise<TaskCreateResult>;
  /** Persist planner output only while the supplied running lease is current. */
  persistPlan(task: TaskLease, plan: unknown): Promise<boolean>;
  parkForApproval(
    task: TaskLease,
    state: Record<string, unknown>,
    pending: unknown[],
  ): Promise<boolean>;
  parkForBudget(task: TaskLease, state: Record<string, unknown>, resumeAt: Date): Promise<boolean>;
  sleepTask(task: TaskLease, state: Record<string, unknown>, runAfter: Date): Promise<boolean>;
  completeTask(task: TaskLease | string, outcome: TaskOutcome): Promise<boolean>;
  appendActivityDiagnostic(input: AppendActivityDiagnosticInput): Promise<boolean>;
  recordAbortedBriefing?(task: TaskLease): Promise<void>;
  markTaskNeedsAttention(task: TaskLease, progress: string): Promise<boolean>;
  parkForEvent(task: TaskLease): Promise<boolean>;
  markAttentionNotified(taskId: string): Promise<boolean>;
  recordFailedAttempt(
    task: TaskLease,
    error: string,
  ): Promise<'retry' | 'dead_letter' | 'lost_lease'>;
  wakeTask(taskId: string, budgetIncrease?: TaskBudgetIncrease): Promise<TaskWake | null>;
  findDueTasks(limit?: number): Promise<Records['tasks'][]>;
}
