/** The SMS channel's own state: its rate ceiling, peer threads, and approval-code tool lookup. */
export interface SmsUsageReconciliationClaim {
  eventId: string;
  claimToken: string;
  providerMessageId: string;
  attempts: number;
  createdAt: Date;
  taskId: string | null;
  reservationId: string | null;
  currentUsd: number;
  currentQuantity: number | null;
  currentUnitPriceUsd: number | null;
  evidence: import('./cost-evidence.js').CostEvidence;
}

export type SmsUsageReconciliationOutcome =
  | { kind: 'complete'; billedSegments: number; priceUsd: number }
  | { kind: 'retry'; nextAttemptAt: Date; error?: string }
  | { kind: 'exhausted'; error?: string };

export interface SmsChannelRepository {
  readonly kind: 'sms-channel-repository';
  /**
   * Whether another outbound SMS fits under the `channel:sms` limit, counted
   * from the metered SMS cost events of the last hour and day.
   */
  underChannelLimit(now: Date): Promise<boolean>;
  /**
   * The conversation bound to this SMS peer, created with its binding on first
   * contact. Concurrent first messages converge on one conversation.
   */
  conversationForPeer(agentId: string, peer: string, trust: 'owner' | 'unknown'): Promise<string>;
  /** Where a finished `sms_turn` replies: the conversation's channel, trust, and bound number. */
  finalDestination(
    conversationId: string,
  ): Promise<{ channel: string; trust: string; externalId: string | null } | null>;
  /** The tool a pending approval would run, by its short code ("YES A7"). */
  pendingApprovalTool(shortCode: string): Promise<string | null>;
  /** Atomically lease a bounded set of accepted SMS events whose provider usage is incomplete. */
  claimSmsUsageReconciliation(now: Date, limit: number): Promise<SmsUsageReconciliationClaim[]>;
  /** Complete/retry/exhaust a claim; completion updates the original ledger event idempotently. */
  settleSmsUsageReconciliation(
    claim: SmsUsageReconciliationClaim,
    outcome: SmsUsageReconciliationOutcome,
  ): Promise<boolean>;
}
