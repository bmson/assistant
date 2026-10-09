import type { ApplicationConfirmationNoticeFence } from './application-confirmation-notice.js';
import type { EmailObserverEffectFence } from './generated-cards.js';
import {
  type NotificationLegResult,
  notificationDeliveryKey,
  notificationLegEntry,
} from './notification-delivery.js';
import type { Records } from './records.js';
import type { SmsDeliveryAccounting } from './sms-segments.js';

/** Persisted delivery state for one concrete owner-facing destination. */
export type NotificationOutboxStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'skipped'
  | 'failed'
  | 'unknown';

export type NotificationOutboxLeg = Records['notificationOutbox'];

export type NotificationOutboxPreparation = {
  agentId: string;
  /** Producer-stable ID for this logical notice, reused after process restart. */
  deliveryKey: string;
  /** Stable destination identity within the delivery (conversation/device/phone route). */
  legKey: string;
  /** Installed sender name, e.g. dashboard, sms, or push. */
  adapter: string;
  /** Owner-bound routing metadata; must not contain provider credentials. */
  destination: unknown;
  /** Frozen notification body and non-secret provider options. */
  payload: unknown;
  /** Full ephemeral claim used only to validate prepare; adapters persist only work ID + privacy generation. */
  emailObserverEffectFence?: EmailObserverEffectFence;
  /** Delayed application result; adapters persist its task/application lineage and generation. */
  applicationConfirmationNoticeFence?: ApplicationConfirmationNoticeFence;
  now: Date;
};

export type NotificationOutboxClaim = {
  agentId: string;
  legId: string;
  now: Date;
  leaseMs: number;
};

export type NotificationOutboxCompletion = {
  agentId: string;
  legId: string;
  leaseToken: string;
  status: Exclude<NotificationOutboxStatus, 'pending' | 'sending'>;
  /** Only a definitive provider rejection can set this true. */
  retryable?: boolean;
  retryAt?: Date | null;
  providerMessageId?: string | null;
  result?: unknown;
  now: Date;
};

export interface NotificationOutboxRepository {
  readonly kind: 'notification-outbox-repository';
  /** Idempotently freezes one destination leg before any provider call. */
  prepare(input: NotificationOutboxPreparation): Promise<NotificationOutboxLeg>;
  /** Claims pending or definitively retryable failed work for this owner. */
  claim(input: NotificationOutboxClaim): Promise<NotificationOutboxLeg | null>;
  /** Lease-token fenced receipt; `unknown` is never automatically retried. */
  complete(input: NotificationOutboxCompletion): Promise<boolean>;
  /** Owner-scoped bounded work scan used by the installed sender drain. */
  pending(agentId: string, limit?: number, now?: Date): Promise<NotificationOutboxLeg[]>;
  /** Expired in-flight sends become unknown because acceptance may have happened. */
  recoverExpired(agentId: string, now: Date): Promise<number>;
}

export type NotificationOutboxSendResult = {
  status: Exclude<NotificationOutboxStatus, 'pending' | 'sending'>;
  reason?: string;
  retryable?: boolean;
  retryAt?: Date | null;
  providerMessageId?: string | null;
  result?: unknown;
  smsAccounting?: SmsDeliveryAccounting;
};

const LEASE_MS = 60_000;

/**
 * Freeze, claim, send, and record one concrete leg. A thrown sender is
 * ambiguous by default; adapters must explicitly label a definitive rejection
 * as retryable to authorize another provider attempt.
 */
export async function sendNotificationOutboxLeg(
  repository: NotificationOutboxRepository,
  preparation: NotificationOutboxPreparation,
  send: (leg: NotificationOutboxLeg) => Promise<NotificationOutboxSendResult>,
): Promise<NotificationLegResult> {
  // Callers may pass an operation id or an upstream provider key. Persist only
  // a namespace-separated digest so receipts and exports never reveal it.
  const prepared = await repository.prepare({
    ...preparation,
    deliveryKey: notificationDeliveryKey('outbox', preparation.agentId, preparation.deliveryKey),
  });
  const storedAccounting = (value: unknown): SmsDeliveryAccounting | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const accounting = (value as Record<string, unknown>).smsAccounting;
    if (!accounting || typeof accounting !== 'object') return undefined;
    const candidate = accounting as Record<string, unknown>;
    if (
      typeof candidate.submittedMessages !== 'number' ||
      typeof candidate.estimatedSegments !== 'number' ||
      (candidate.encoding !== 'gsm7' && candidate.encoding !== 'ucs2')
    )
      return undefined;
    if (
      !Number.isInteger(candidate.encodedUnits) ||
      (candidate.encodedUnits as number) < 0 ||
      candidate.submittedMessages !== 1 ||
      !Number.isInteger(candidate.estimatedSegments) ||
      (candidate.estimatedSegments as number) < 0
    )
      return undefined;
    return {
      encoding: candidate.encoding,
      encodedUnits: candidate.encodedUnits as number,
      submittedMessages: 1,
      estimatedSegments: candidate.estimatedSegments as number,
      ...(typeof candidate.providerMessageId === 'string'
        ? { providerMessageId: candidate.providerMessageId }
        : {}),
      ...(Number.isInteger(candidate.billedSegments) && (candidate.billedSegments as number) >= 0
        ? { billedSegments: candidate.billedSegments as number }
        : {}),
      ...(typeof candidate.providerPriceUsd === 'number' &&
      Number.isFinite(candidate.providerPriceUsd)
        ? { providerPriceUsd: candidate.providerPriceUsd }
        : {}),
    } satisfies SmsDeliveryAccounting;
  };
  const terminal = (
    status: Exclude<NotificationOutboxStatus, 'pending' | 'sending'>,
    reason?: string,
  ) => notificationLegEntry(prepared.adapter, status, reason, storedAccounting(prepared.result));
  if (prepared.destination === null || prepared.payload === null)
    return terminal('skipped', 'delivery-payload-erased');
  if (prepared.status === 'delivered') return terminal('delivered');
  if (prepared.status === 'skipped') return terminal('skipped');
  if (prepared.status === 'unknown') return terminal('unknown', 'prior-attempt-outcome-unknown');
  if (prepared.status === 'sending') return terminal('unknown', 'delivery-attempt-in-progress');
  if (prepared.status === 'failed' && !prepared.retryable)
    return terminal('failed', 'prior-failure-not-authorized-for-retry');
  if (prepared.availableAt.getTime() > preparation.now.getTime())
    return terminal('failed', 'retry-not-yet-due');

  const claimed = await repository.claim({
    agentId: preparation.agentId,
    legId: prepared.id,
    now: preparation.now,
    leaseMs: LEASE_MS,
  });
  if (claimed?.status === 'skipped') return terminal('skipped', 'email-observer-fence-invalid');
  if (!claimed?.leaseToken) return terminal('unknown', 'delivery-attempt-owned-by-another-worker');

  let outcome: NotificationOutboxSendResult;
  try {
    outcome = await send(claimed);
  } catch {
    outcome = { status: 'unknown', reason: 'sender-threw-after-claim' };
  }
  const completed = await repository.complete({
    agentId: preparation.agentId,
    legId: claimed.id,
    leaseToken: claimed.leaseToken,
    status: outcome.status,
    retryable: outcome.retryable,
    retryAt: outcome.retryAt,
    providerMessageId: outcome.providerMessageId,
    result: {
      reason: outcome.reason ?? null,
      ...(outcome.result ? { detail: outcome.result } : {}),
      ...(outcome.smsAccounting ? { smsAccounting: outcome.smsAccounting } : {}),
    },
    now: preparation.now,
  });
  if (!completed) return terminal('unknown', 'delivery-receipt-lost-lease');
  return notificationLegEntry(
    prepared.adapter,
    outcome.status,
    outcome.reason,
    outcome.smsAccounting,
  );
}

/** Drain only the adapter's rows; each claim is owner and lease fenced. */
export async function drainNotificationOutbox(
  repository: NotificationOutboxRepository,
  input: {
    agentId: string;
    adapter: string;
    now: Date;
    limit?: number;
    send: (leg: NotificationOutboxLeg) => Promise<NotificationOutboxSendResult>;
  },
): Promise<number> {
  await repository.recoverExpired(input.agentId, input.now);
  const rows = await repository.pending(input.agentId, input.limit, input.now);
  let attempted = 0;
  for (const row of rows) {
    if (row.adapter !== input.adapter) continue;
    const claimed = await repository.claim({
      agentId: input.agentId,
      legId: row.id,
      now: input.now,
      leaseMs: LEASE_MS,
    });
    if (!claimed?.leaseToken) continue;
    attempted += 1;
    let outcome: NotificationOutboxSendResult;
    try {
      outcome = await input.send(claimed);
    } catch {
      outcome = { status: 'unknown', reason: 'sender-threw-after-claim' };
    }
    await repository.complete({
      agentId: input.agentId,
      legId: claimed.id,
      leaseToken: claimed.leaseToken,
      status: outcome.status,
      retryable: outcome.retryable,
      retryAt: outcome.retryAt,
      providerMessageId: outcome.providerMessageId,
      result: {
        reason: outcome.reason ?? null,
        ...(outcome.result ? { detail: outcome.result } : {}),
        ...(outcome.smsAccounting ? { smsAccounting: outcome.smsAccounting } : {}),
      },
      now: input.now,
    });
  }
  return attempted;
}
