export type CardRefreshResult =
  | { ok: true; taskId: string; refreshState: 'refreshing' }
  | { ok: false; error: string; status: 404 | 409 };

export type CardRefreshRequestResult =
  | (Extract<CardRefreshResult, { ok: true }> & {
      queueGeneration: number;
      created: boolean;
      dispatch: 'notify' | 'outbox';
    })
  | Extract<CardRefreshResult, { ok: false }>;

export interface CardRefreshInstruction {
  title: string;
  instruction: string;
}

export interface CardRefreshRepository {
  readonly kind: 'card-refresh-repository';
  /**
   * Atomically deduplicate active refreshes, select an owner-scoped chat, and
   * create the refresh task. The formatter must be deterministic and side-effect free.
   */
  request(input: {
    agentId: string;
    cardId: string;
    /** Current immutable card view; a stale action must not refresh a new revision. */
    expectedRevisionId?: string;
    conversationId?: string;
    operationId?: string;
    formatInstruction: (spec: unknown) => CardRefreshInstruction | null;
  }): Promise<CardRefreshRequestResult>;
}
