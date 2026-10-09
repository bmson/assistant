import type { Records } from './records.js';

/** Shared bounded owner-history window; prompt byte fitting remains separate. */
export const MAX_EXECUTION_SEED_MESSAGES = 100;

export interface ExecutionMessageCursor {
  createdAt: Date;
  /** Exact UTC timestamp; adapters retain micro/nanoseconds across checkpoints. */
  exactCreatedAt?: string;
  id: string;
}

export interface ExecutionContextRepository {
  readonly kind: 'execution-context-repository';
  getAgent(agentId: string): Promise<Records['agents'] | null>;
  getTask(agentId: string, taskId: string): Promise<Records['tasks'] | null>;
  getGoalStopState(
    agentId: string,
    goalId: string,
  ): Promise<{ status: string; archivedAt: Date | null } | null>;
  /** The latest user/assistant messages from any conversation owned by the agent. */
  seedHistory(input: {
    agentId: string;
    conversationId: string;
    before: Date;
    /** Inclusive durable triggering row; adapters compare at stored precision. */
    throughMessageId?: string;
    limit?: number;
  }): Promise<Records['messages'][]>;
  getInboundMessage(input: {
    agentId: string;
    conversationId: string;
    channelMessageId: string;
  }): Promise<Pick<Records['messages'], 'text'> | null>;
  /** Latest message in an owned chat. Outer null means the conversation is not eligible. */
  getLatestOwnerReplyCursor(input: {
    agentId: string;
    conversationId: string;
  }): Promise<{ cursor: ExecutionMessageCursor | null } | null>;
  /** Owner messages after the strict cursor. Non-chat and foreign conversations return none. */
  getOwnerRepliesAfter(input: {
    agentId: string;
    conversationId: string;
    after: { createdAt: Date; exactCreatedAt?: string; id?: string };
    limit?: number;
  }): Promise<Array<Records['messages'] & { exactCreatedAt?: string }>>;
  noticeIds(
    agentId: string,
    rows: ReadonlyArray<{ id: string; role: string; taskId: string | null; parts: unknown }>,
  ): Promise<Set<string>>;
}
