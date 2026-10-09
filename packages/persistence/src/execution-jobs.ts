import type { TaskLease } from './contracts.js';
import type { Records } from './records.js';

export interface ExecutionJobInput {
  taskId: string;
  toolCallId: string;
  pending: unknown;
  checkpointState: unknown;
}

export type ExecutionJobSettleResult =
  | { kind: 'result'; result: unknown; id: string; startedAt: Date | null; decision: unknown }
  | {
      kind: 'timeout';
      failure: { ok: false; error: string };
      id: string;
      startedAt: Date | null;
      decision: unknown;
    }
  | { kind: 'still_pending' }
  | { kind: 'stale' };

/**
 * A job may call back while its launching run still holds the task, while the
 * task sleeps until the job's timeout, or while it waits on another approval.
 */
export const EXECUTION_JOB_CALLBACK_STATES: readonly string[] = [
  'running',
  'sleeping',
  'waiting_approval',
];

export interface ExecutionJobCallbackInput {
  taskId: string;
  /** Optional durable deduplication identity for callbacks with a replayable outbox. */
  idempotencyKey?: string;
  tokenHash?: string;
  payloadDigest?: string;
  /** Replaces the hashed pending sentinel on the launching tool call. */
  result: Record<string, unknown>;
  /** Workspace artifacts the job wrote, inventoried with the result. */
  files: Array<{ workspacePath: string; mime: string }>;
}

export type ExecutionJobCallbackDecision =
  | { accept: true; toolCallId: string }
  | { accept: false; status: 403 | 404 | 409; error: string };

export type ExecutionJobCallbackOutcome =
  | { ok: true; taskId: string; queueGeneration: number; replayed?: boolean }
  | { ok: false; status: 403 | 404 | 409; error: string };

export interface ExecutionJobRepository {
  readonly kind: 'execution-job-repository';
  loadToolCall(
    agentId: string,
    taskId: string,
    toolCallId: string,
  ): Promise<Records['toolCalls'] | null>;
  listPendingApprovals(
    agentId: string,
    taskId: string,
    approvalIds: string[],
  ): Promise<Records['approvals'][]>;
  stage(input: ExecutionJobInput, lease: TaskLease): Promise<void>;
  clear(input: ExecutionJobInput, lease: TaskLease): Promise<void>;
  settle(
    input: { taskId: string; toolCallId: string; timeoutAt: Date },
    lease: TaskLease,
  ): Promise<ExecutionJobSettleResult>;
  /**
   * Record a job's callback and wake its task atomically. `decide` checks the
   * task as read under the same lock the executor's settle takes, so a result
   * and a timeout cannot both win. It must be pure: Firestore may rerun it.
   * Waking moves a running task to pending, which fences out the launching
   * run's lease; the recorded result is then authoritative.
   */
  recordCallback(
    input: ExecutionJobCallbackInput,
    decide: (task: Records['tasks'] | null) => ExecutionJobCallbackDecision,
  ): Promise<ExecutionJobCallbackOutcome>;
}
