import type { ExternalEffectProgress } from './external-effect.js';
import type { Records } from './records.js';

export interface WakeIntent {
  id: string;
  taskId: string;
  generation: number;
  availableAt: Date;
  status: 'pending' | 'leased' | 'delivered';
  attempts: number;
  leaseToken: string | null;
  lockedUntil: Date | null;
}
export type OutboxLease = WakeIntent & { status: 'leased'; leaseToken: string; lockedUntil: Date };
export interface DispatchOutbox {
  due(batch?: number): Promise<string[]>;
  claim(id: string): Promise<OutboxLease | null>;
  acknowledge(lease: OutboxLease): Promise<boolean>;
  retry(lease: OutboxLease): Promise<boolean>;
}
/** Resolve only after the provider has accepted this stable task/generation name. */
export interface TaskQueue {
  enqueue(taskId: string, generation: number, signal?: AbortSignal): Promise<void>;
}

export interface ApprovedToolCall {
  toolCall: Records['toolCalls'];
  task: Records['tasks'];
  approval: Records['approvals'] | null;
}

export interface StaleToolAuthorization {
  type: 'stale_authorization';
  error: string;
}

export type ClaimApprovedToolCallResult = ApprovedToolCall | StaleToolAuthorization | null;

export interface ClaimApprovedToolCallInput {
  agentId: string;
  taskId: string;
  toolCallId: string;
  args: Record<string, unknown>;
  decision: Record<string, unknown>;
  expectedApprovalId?: string | null;
  expectedResolutionPayload?: unknown;
  /** Bounded snapshot digest of all policy rows for this tool, enabled or not. */
  expectedPolicyFingerprint: string;
  /** MCP's prepared connection/tool/credential binding; required for mcp.call. */
  expectedMcpBinding?: import('./approval-authority.js').ExpectedMcpApprovalBinding;
  /** Trust/capability tier read from the task before claiming. */
  expectedTaskTrust: string;
  /** Task state that must still hold at the atomic side-effect claim. */
  expectedTaskStatus?: string;
  startedAt?: Date;
}

export interface ToolExecutionOutcome {
  agentId: string;
  taskId: string;
  toolCallId: string;
  status: 'succeeded' | 'failed';
  fromStatus?: 'approved' | 'executing';
  result?: unknown;
  error?: string;
  finishedAt?: Date;
}
export interface StartAutonomousToolCallInput {
  agentId: string;
  taskId: string;
  step: number;
  toolName: string;
  args: Record<string, unknown>;
  idempotencyKey: string | null;
  decision: Record<string, unknown>;
  startedAt?: Date;
}
export interface CachedToolCallInput extends StartAutonomousToolCallInput {
  result: unknown;
}

/** Owner- and task-scoped persistence for the already-approved execution path. */
export interface ToolExecutionRepository {
  readonly kind: 'tool-execution-repository';
  /** Load a call and its links without returning another owner's records. */
  load(agentId: string, taskId: string, toolCallId: string): Promise<ApprovedToolCall | null>;
  /** Find the unique call emitted by a model inside this task, for crash recovery. */
  findByModelToolCallId?(
    agentId: string,
    taskId: string,
    modelToolCallId: string,
  ): Promise<{ toolCall: Records['toolCalls']; approval: Records['approvals'] | null } | null>;
  /** Compact replay receipt retained after the full private tool-call row expires. */
  findReceiptByToolCallId?(
    agentId: string,
    taskId: string,
    toolCallId: string,
  ): Promise<Records['toolCallReceipts'] | null>;
  findReceiptByModelToolCallId?(
    agentId: string,
    taskId: string,
    modelToolCallId: string,
  ): Promise<Records['toolCallReceipts'] | null>;
  /** Returns only this owner/task's receipt; foreign global-key collisions stay opaque. */
  findReceiptByIdempotencyKey?(
    agentId: string,
    taskId: string,
    idempotencyKey: string,
  ): Promise<Records['toolCallReceipts'] | null>;
  /** Atomically transition this exact approved call to executing. */
  claim(input: ClaimApprovedToolCallInput): Promise<ClaimApprovedToolCallResult>;
  /** Persist a terminal outcome only for the owner-linked call. */
  outcome(input: ToolExecutionOutcome): Promise<boolean>;
  /** Preserve provider object identity before the next non-atomic create/fill/share stage. */
  checkpointExternalEffect?(input: {
    agentId: string;
    taskId: string;
    toolCallId: string;
    progress: ExternalEffectProgress;
  }): Promise<boolean>;
  contacts(): Promise<Array<{ emails: string[]; phones: string[] }>>;
  underRateLimit(scope: string, toolName: string, now?: Date): Promise<boolean>;
  cacheGet(cacheKey: string, now?: Date): Promise<{ result: unknown } | null>;
  cachePut(input: {
    cacheKey: string;
    toolName: string;
    result: unknown;
    expiresAt: Date;
  }): Promise<void>;
  start(input: StartAutonomousToolCallInput): Promise<Records['toolCalls'] | null>;
  findIdempotent(
    agentId: string,
    taskId: string,
    idempotencyKey: string,
  ): Promise<Records['toolCalls'] | null>;
  cached(input: CachedToolCallInput): Promise<Records['toolCalls']>;
  parentIsMission(agentId: string, parentTaskId: string): Promise<boolean>;
  conversationGoalId(agentId: string, conversationId: string): Promise<string | null>;
  goalWorkEvidence(
    agentId: string,
    taskId: string,
  ): Promise<Array<{ toolName: string; status: string; result: unknown }>>;
  ownerMessageHistory(agentId: string, conversationId: string, before: Date): Promise<string[]>;
  searchResults(taskId: string): Promise<unknown[]>;
}
