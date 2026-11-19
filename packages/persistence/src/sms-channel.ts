import { insideQuietHours, ownerLocalMinutes } from './nudge-policy.js';

export type ProactiveSmsAttemptDecision =
  | 'reserved'
  | 'quiet-hours'
  | 'proactive-sms-daily-cap'
  | 'proactive-sms-already-reserved';

export const PROACTIVE_SMS_DAILY_LIMIT = 3;

type ProactiveSmsQuota = { day: string; attemptKeys: string[] };

export function decideProactiveSmsAttempt(input: {
  prior: string | null;
  timeZone: string;
  now: Date;
  attemptKey: string;
  prefs?: { quietStartMin: number | null; quietEndMin: number | null } | null;
}): { decision: ProactiveSmsAttemptDecision; next?: string } {
  if (!Number.isFinite(input.now.getTime())) throw new Error('Invalid SMS quota time');
  if (!/^sms-attempt:[a-f0-9]{64}$/.test(input.attemptKey))
    throw new Error('Invalid proactive SMS attempt key');
  const window = input.prefs;
  if (
    window &&
    [window.quietStartMin, window.quietEndMin].some(
      (value) => value !== null && (!Number.isInteger(value) || value < 0 || value >= 24 * 60),
    )
  )
    throw new Error('Invalid quiet hours for proactive SMS');
  if (input.prefs && insideQuietHours(input.prefs, ownerLocalMinutes(input.timeZone, input.now)))
    return { decision: 'quiet-hours' };
  const { day, previous } = readProactiveSmsQuota(input.prior, input.timeZone, input.now);
  // Backward clock or timezone changes cannot create another allowance.
  if (previous && previous.day > day) return { decision: 'proactive-sms-daily-cap' };
  const attemptKeys = previous?.day === day ? previous.attemptKeys : [];
  if (attemptKeys.includes(input.attemptKey)) return { decision: 'proactive-sms-already-reserved' };
  if (attemptKeys.length >= PROACTIVE_SMS_DAILY_LIMIT)
    return { decision: 'proactive-sms-daily-cap' };
  return {
    decision: 'reserved',
    next: JSON.stringify({ day, attemptKeys: [...attemptKeys, input.attemptKey] }),
  };
}

export function readProactiveSmsQuota(prior: string | null, timeZone: string, now: Date) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const previous = prior === null ? null : (JSON.parse(prior) as ProactiveSmsQuota);
  if (
    previous !== null &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(previous.day) ||
      !Array.isArray(previous.attemptKeys) ||
      previous.attemptKeys.some(
        (key) => typeof key !== 'string' || !/^sms-attempt:[a-f0-9]{64}$/.test(key),
      ) ||
      previous.attemptKeys.length > PROACTIVE_SMS_DAILY_LIMIT)
  )
    throw new Error('Invalid proactive SMS quota state');
  return { day, previous };
}

export function proactiveSmsQuotaName(agentId: string): string {
  return `proactive-sms-attempt-quota:${agentId}`;
}

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
  /** Atomically reserve one of the owner's three local-day unsolicited SMS attempts. */
  reserveProactiveAttempt(
    agentId: string,
    attemptKey: string,
    now: Date,
  ): Promise<ProactiveSmsAttemptDecision>;
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
