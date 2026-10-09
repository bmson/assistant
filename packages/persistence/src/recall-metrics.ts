export interface RecallMetricInput {
  agentId: string;
  taskId?: string;
  conversationId?: string;
  path: 'chat' | 'executor';
  graphAttempted: boolean;
  graphFailed: boolean;
  historyFailed: boolean;
  graphCandidates: number;
  graphUsed: number;
  historyTier: 'segment' | 'message' | 'blended' | 'none';
  historyUsed: number;
  sourceCount: number;
}

export interface RecallMetricsRepository {
  readonly kind: 'recall-metrics-repository';
  record(input: RecallMetricInput): Promise<void>;
  purge(input: { notAfter: Date; limit: number }): Promise<number>;
}
