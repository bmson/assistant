import type { BriefingDelivery } from './briefing-delivery.js';
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
 * A background producer can explicitly select the owner's Notifications chat.
 * By default, notices use the primary chat when available and Notifications otherwise.
 */
export interface OwnerNoticeRepository {
  readonly kind: 'owner-notice-repository';
  /** Capture the erasure generation before a producer reads private sources. */
  observationFence?(agentId: string): Promise<string | null>;
  readBriefingPublication?(
    agentId: string,
    taskId: string,
  ): Promise<{ conversationId: string; messageId: string } | null>;
  post(input: {
    agentId: string;
    text: string;
    taskId?: string;
    extraParts?: readonly unknown[];
    destination?: 'primary' | 'notifications';
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
  /** Bind one dashboard publication to this briefing task across retries. */
  deduplicateBriefing?: boolean;
  extraParts?: readonly unknown[];
  now: Date;
  observationFence: string | null;
  suggestionSourceRefs: readonly string[];
  /** Missing rows are stale only for sources known to have an existing card. */
  requiredSuggestionSourceRefs: readonly string[];
  deliveries?: readonly BriefingDelivery[];
  securityIncidents: readonly { incidentId: string; revision: number }[];
}

export type OwnerNoticeDecisionFenceResult =
  | { status: 'posted'; conversationId: string; messageId?: string; replayed?: boolean }
  | {
      status: 'stale';
      inactiveSuggestionSourceRefs: string[];
      inactiveDeliveryKeys?: string[];
      inactiveSecurityIncidents: Array<{ incidentId: string; revision: number }>;
    };
