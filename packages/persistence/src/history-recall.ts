export interface HistoryExclusion {
  conversationId: string;
  sinceCreatedAt: Date;
}

export interface HistoryMessage {
  id: string;
  conversationId: string;
  role: string;
  text: string;
  createdAt: Date;
}

export interface HistorySearch {
  agentId: string;
  embedding: number[];
  embeddingSpaceKey: string;
  exclude: HistoryExclusion;
  limit: number;
}

export interface HistorySegment {
  conversationId: string;
  summary: string;
  startMessageId: string;
  startedAt: Date;
  endedAt: Date;
  similarity: number;
  keyMessage?: Pick<HistoryMessage, 'id' | 'role' | 'text'>;
}

/** Private historical context. Every lookup rechecks conversation ownership and trust. */
export interface HistoryRecallRepository {
  readonly kind: 'history-recall-repository';
  segments(input: HistorySearch): Promise<HistorySegment[]>;
  messages(input: HistorySearch): Promise<Array<HistoryMessage & { similarity: number }>>;
  neighborhood(input: {
    agentId: string;
    anchor: HistoryMessage;
    radius: number;
    exclude: HistoryExclusion;
  }): Promise<HistoryMessage[]>;
  recentWindowStart(input: {
    agentId: string;
    conversationId: string;
    size: number;
  }): Promise<Date | null>;
}

export function historyLimit(value: number, maximum = 100): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new Error('Invalid history recall bound');
  return value;
}
