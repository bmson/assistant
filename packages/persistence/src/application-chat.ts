import type { AppendMessageInput, TaskLease } from './contracts.js';
import type { ExecutionEvidenceRecord } from './execution-evidence.js';
import type { Records } from './records.js';

export const DEFAULT_CHAT_MESSAGE_LIMIT = 100;
export const MAX_CHAT_MESSAGE_LIMIT = 200;
export const DEFAULT_CHAT_CONVERSATION_LIMIT = 50;
export const MAX_CHAT_CONVERSATION_LIMIT = 100;

export type ApplicationChatAgent = Records['agents'];

export type ApplicationChatConversation = Records['conversations'];
export type ApplicationChatMessage = Records['messages'] & {
  createdAtExact?: string;
  appendSequence?: string;
};

export interface ChatTurnAdmissionInput {
  agentId: string;
  conversationId: string;
  clientOperationId: string;
  /** Authenticated native installation ID; absent for web and legacy clients. */
  clientId?: string;
  requestHash: string;
  text: string;
  autonomous: boolean;
  force: boolean;
  spoken: boolean;
  goalId?: string;
  autonomyGrant?: unknown;
}

export type ChatTurnAdmissionResult =
  | {
      kind: 'admitted';
      created: boolean;
      task: Records['tasks'];
      message: ApplicationChatMessage;
      /** Present only for the transaction that created the leased admission task. */
      lease?: TaskLease;
    }
  | {
      kind: 'cancelled_before_admission';
      created: false;
      task: Records['tasks'];
      status: 'cancelled';
      effectStatus: 'not_started';
    };

export type ChatTurnCancellationResult =
  | {
      kind: 'cancelled_before_admission';
      task: Records['tasks'];
      status: 'cancelled';
      transitioned: boolean;
      effectStatus: 'not_started';
    }
  | {
      kind: 'admitted_task';
      task: Records['tasks'];
      status: string;
      transitioned: boolean;
      /** Conservatively unknown once a task has entered normal admission. */
      effectStatus: 'unknown';
    };

export interface QueuedChatTurn {
  id: string;
  queueGeneration: number;
}

export interface ApplicationChatCursor {
  createdAt: Date;
  id: string;
  /** PostgreSQL keeps microseconds while JavaScript Date keeps milliseconds. */
  createdAtExact?: string;
  /** Commit-ordered append position; present on v2 polling cursors. */
  appendSequence?: string;
}

export interface ApplicationConversationCursor {
  updatedAt: Date;
  id: string;
}

export interface ApplicationChatConversationPage {
  conversations: ApplicationChatConversation[];
  hasMore: boolean;
  nextCursor: ApplicationConversationCursor | null;
}

export interface ApplicationChatMessagePage {
  messages: ApplicationChatMessage[];
  hasMore: boolean;
}

export interface ApplicationChatApproval {
  toolName?: string;
  id: string;
  taskId: string;
  summary: string;
  status: string;
  payload?: unknown;
  expiresAt: Date;
}

export interface ApplicationChatBudgetTask {
  id: string;
  status: string;
  budgetUsdLimit: string;
}

export interface ApplicationChatSuggestion {
  id: string;
  status: string;
  expiresAt: Date;
  origin: string;
  proposedAction: string;
  snoozedUntil: Date | null;
  acceptedTaskId: string | null;
  acceptedTaskStatus?: string | null;
  acceptedTaskProgress?: string | null;
  acceptedTaskConversationId?: string | null;
}

export interface ApplicationChatActivity {
  toolName: string;
  status: string;
  step: number;
}

export interface ApplicationChatModel {
  id: string;
  label: string;
}

export interface ApplicationChatHydrationInput {
  approvalIds: string[];
  approvalTaskIds: string[];
  budgetTaskIds: string[];
  suggestionIds: string[];
}

export interface ApplicationChatHydrationState {
  approvals: ApplicationChatApproval[];
  taskApprovals: ApplicationChatApproval[];
  budgetTasks: ApplicationChatBudgetTask[];
  suggestions: ApplicationChatSuggestion[];
}

export type ApplicationChatArchiveResult = 'archived' | 'active' | 'primary';

/**
 * Owner-facing chat persistence. Every public read and write carries the
 * agent id so adapters can enforce ownership instead of trusting a transport
 * supplied conversation id.
 */
export interface ApplicationChatPersistence {
  readonly kind: 'application-chat-persistence';
  resolveAgent(): Promise<ApplicationChatAgent>;
  /** Read before chat context retrieval; completion rejects if erasure changed afterward. */
  privacyObservationGeneration(agentId: string): Promise<string | null>;
  getOrCreatePrimaryConversation(agentId: string): Promise<ApplicationChatConversation>;
  createConversation(agentId: string): Promise<ApplicationChatConversation>;
  getConversation(
    agentId: string,
    conversationId: string,
  ): Promise<ApplicationChatConversation | null>;
  listConversations(
    agentId: string,
    input: {
      archived: boolean;
      limit?: number;
      after?: ApplicationConversationCursor;
    },
  ): Promise<ApplicationChatConversationPage>;
  countConversations(agentId: string, archived: boolean): Promise<number>;
  listActiveConversationIds(agentId: string): Promise<string[]>;
  archiveConversation(
    agentId: string,
    conversationId: string,
  ): Promise<ApplicationChatArchiveResult>;
  restoreConversation(agentId: string, conversationId: string): Promise<boolean>;
  archiveInactiveConversations(agentId: string, olderThan: Date, limit?: number): Promise<number>;
  setConversationModel(
    agentId: string,
    conversationId: string,
    modelId: string | null,
  ): Promise<boolean>;
  setConversationTitleIfEmpty(
    agentId: string,
    conversationId: string,
    title: string,
  ): Promise<boolean>;
  markConversationRead(
    agentId: string,
    conversationId: string,
    readAt: Date,
    settleSeconds?: number,
  ): Promise<boolean>;
  getGoalTitle(agentId: string, goalId: string): Promise<string | null>;
  clearGoalBlockedOnOwnerReply(agentId: string, goalId: string): Promise<void>;
  countActiveTasks(agentId: string, conversationId: string): Promise<number>;
  getTaskStatus(agentId: string, conversationId: string, taskId: string): Promise<string | null>;
  listTaskActivity(
    agentId: string,
    conversationId: string,
    taskId: string,
    limit?: number,
  ): Promise<ApplicationChatActivity[]>;
  listEnabledModels(): Promise<ApplicationChatModel[]>;
  listMessages(
    agentId: string,
    conversationId: string,
    input?: { limit?: number; after?: ApplicationChatCursor; fromStart?: boolean },
  ): Promise<ApplicationChatMessagePage | null>;
  listMessagesByIds(
    agentId: string,
    conversationId: string,
    ids: string[],
  ): Promise<ApplicationChatMessage[] | null>;
  setMessageHidden(
    agentId: string,
    conversationId: string,
    messageId: string,
    hidden: boolean,
  ): Promise<boolean>;
  acknowledgeMessageDelivery(
    agentId: string,
    conversationId: string,
    messageId: string,
    clientId: string,
  ): Promise<boolean>;
  listRuntimeMessages(
    agentId: string,
    conversationId: string,
    taskIds: string[],
    limit?: number,
  ): Promise<ApplicationChatMessage[] | null>;
  getTaskKinds(agentId: string, taskIds: string[]): Promise<Map<string, string>>;
  getHydrationState(
    agentId: string,
    input: ApplicationChatHydrationInput,
  ): Promise<ApplicationChatHydrationState>;
  /** Enforces conversation ownership before delegating to the durable append. */
  appendOwned(
    agentId: string,
    input: AppendMessageInput,
  ): Promise<ApplicationChatMessage | undefined>;
  /** Atomically records the owner message and its leased task admission receipt. */
  admitChatTurn(input: ChatTurnAdmissionInput): Promise<ChatTurnAdmissionResult>;
  /**
   * Idempotently stops a send by operation ID, including before admission has a
   * task receipt. An admitted task reports effect status as unknown.
   */
  cancelChatTurn(input: {
    agentId: string;
    conversationId: string;
    clientOperationId: string;
  }): Promise<ChatTurnCancellationResult>;
  /** Fences the current admission lease and queues that same task for the executor. */
  queueAdmittedChatTurn(input: {
    agentId: string;
    task: TaskLease;
    triagedActionable: boolean;
  }): Promise<QueuedChatTurn | null>;
  /** Advances the phase while preserving the same live admission lease. */
  markChatTurnStreaming(input: {
    agentId: string;
    task: TaskLease;
    triageOutcome: 'conversational';
  }): Promise<boolean>;
  createDirectChatTask(input: {
    agentId: string;
    conversationId: string;
    goalId?: string;
    title?: string;
  }): Promise<TaskLease>;
  completeDirectChatTask(input: {
    agentId: string;
    task: TaskLease;
    status: 'done' | 'failed';
    progress?: string;
    privacyObservationGeneration?: string | null;
    messages: AppendMessageInput[];
  }): Promise<boolean>;
  raiseTaskBudget(agentId: string, taskId: string, requested: number): Promise<void>;
  listConversationEvidence(
    agentId: string,
    conversationId: string,
    excludeTaskId: string,
  ): Promise<ExecutionEvidenceRecord[]>;
}

export function boundedChatMessageLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CHAT_MESSAGE_LIMIT;
  return Math.max(1, Math.min(MAX_CHAT_MESSAGE_LIMIT, Math.floor(value)));
}

export function boundedChatConversationLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CHAT_CONVERSATION_LIMIT;
  return Math.max(1, Math.min(MAX_CHAT_CONVERSATION_LIMIT, Math.floor(value)));
}
