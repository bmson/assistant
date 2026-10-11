import type { Records } from './records.js';

/** Durable evidence read/write port used by the executor finalization funnel. */
export type ExecutionEvidenceRecord = Pick<
  Records['toolCalls'],
  'id' | 'toolName' | 'status' | 'args' | 'result' | 'error' | 'step' | 'decision'
>;

export type ResponseCheckInput = {
  taskId: string;
  promptVersion: number;
  plannerVersion: number | null;
  blocked: boolean;
  unsupportedCount: number;
  mustActRetries: number;
  degradedSteps: number;
  outputVerificationAttempted: boolean;
  outputVerificationRevised: boolean;
  outputVerificationUnavailable: boolean;
};

export type ExecutionEvidenceRepository = {
  kind: 'execution-evidence-repository';
  /** Complete task evidence, paged to maxRows (default 10,000); overflow fails closed. */
  taskEvidence(input: {
    agentId: string;
    taskId: string;
    maxRows?: number;
  }): Promise<ExecutionEvidenceRecord[]>;
  /**
   * The conversation's most recent prior tool calls — at most `maxRows`
   * (default 500) — oldest first. A longer history is windowed, never an error.
   */
  conversationEvidence(input: {
    agentId: string;
    conversationId: string;
    excludeTaskId: string;
    maxRows?: number;
  }): Promise<ExecutionEvidenceRecord[]>;
  hasConversationToolCall(input: {
    agentId: string;
    conversationId: string;
    toolName: string;
    documentId: string;
  }): Promise<boolean>;
  finalMessageExists(input: {
    agentId: string;
    taskId: string;
    conversationId: string | null;
    text: string;
  }): Promise<boolean>;
  hasOutboundReply(input: { agentId: string; taskId: string }): Promise<boolean>;
  checklistDecisions(input: {
    agentId: string;
    taskId: string;
  }): Promise<readonly { toolCallId: string; status: string }[]>;
  recordResponseCheck(input: { agentId: string; check: ResponseCheckInput }): Promise<boolean>;
};

export const DEFAULT_EXECUTION_EVIDENCE_LIMIT = 500;
export const MAX_TASK_EXECUTION_EVIDENCE_ROWS = 10_000;

/** Full task evidence is paged up to a separate safety ceiling. */
export function taskEvidenceLimit(maxRows: number | undefined): number {
  const value = maxRows ?? MAX_TASK_EXECUTION_EVIDENCE_ROWS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TASK_EXECUTION_EVIDENCE_ROWS)
    throw new Error('Task execution evidence limit is invalid');
  return value;
}

export function evidenceLimit(maxRows: number | undefined): number {
  const value = maxRows ?? DEFAULT_EXECUTION_EVIDENCE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_EXECUTION_EVIDENCE_LIMIT)
    throw new Error('Execution evidence limit is invalid');
  return value;
}
