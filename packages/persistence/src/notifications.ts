/**
 * The owner's Notifications chat: where background work without a chat of its
 * own reports. It is created on first use, and concurrent first uses converge
 * on one conversation.
 */
export interface NotificationsConversationRepository {
  readonly kind: 'notifications-conversation-repository';
  getOrCreate(
    agentId: string,
    emailObserverEffectFence?: import('./generated-cards.js').EmailObserverEffectFence,
    applicationConfirmationNoticeFence?: import('./application-confirmation-notice.js').ApplicationConfirmationNoticeFence,
  ): Promise<string>;
}

/**
 * A background producer's dashboard copy (briefing, pulse, curiosity): the
 * owner's primary chat when there is one, otherwise their Notifications chat.
 */
export interface OwnerNoticeRepository {
  readonly kind: 'owner-notice-repository';
  /** Capture the erasure generation before a producer reads private sources. */
  observationFence?(agentId: string): Promise<string | null>;
  post(input: {
    agentId: string;
    text: string;
    taskId?: string;
    extraParts?: readonly unknown[];
  }): Promise<{ conversationId: string }>;
  /**
   * Append only if the exact source decisions still match at publication time.
   * A stale result contains identities to remove and never writes a message.
   */
  postWithDecisionFence?(
    input: OwnerNoticeDecisionFenceInput,
  ): Promise<OwnerNoticeDecisionFenceResult>;
}

export interface OwnerNoticeDecisionFenceInput {
  agentId: string;
  text: string;
  taskId?: string;
  extraParts?: readonly unknown[];
  now: Date;
  observationFence: string | null;
  suggestionSourceRefs: readonly string[];
  /** Missing rows are stale only for sources known to have an existing card. */
  requiredSuggestionSourceRefs: readonly string[];
  securityIncidents: readonly { incidentId: string; revision: number }[];
}

export type OwnerNoticeDecisionFenceResult =
  | { status: 'posted'; conversationId: string }
  | {
      status: 'stale';
      inactiveSuggestionSourceRefs: string[];
      inactiveSecurityIncidents: Array<{ incidentId: string; revision: number }>;
    };
