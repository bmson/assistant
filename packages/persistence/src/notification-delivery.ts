import { createHash } from 'node:crypto';
import type { SmsDeliveryAccounting } from './sms-segments.js';

/**
 * Outcome of one owner-facing notification leg. `delivered` means the local
 * sink persisted the notice or a provider acknowledged it; it never means the
 * owner read it. `unknown` is a transport ambiguity and is not safe to retry
 * automatically without a durable provider idempotency key.
 */
export type NotificationLegStatus =
  | 'delivered'
  | 'held'
  | 'pending'
  | 'skipped'
  | 'failed'
  | 'unknown';

export type NotificationLegResult = {
  /** Stable channel name such as `dashboard`, `sms`, or `push`. */
  channel: string;
  status: NotificationLegStatus;
  /** Safe operational detail, never provider credentials or message content. */
  reason?: string;
  smsAccounting?: SmsDeliveryAccounting;
};

export type NotificationDeliveryResult = {
  legs: readonly NotificationLegResult[];
};

export function notificationLegEntry(
  channel: string,
  status: NotificationLegStatus,
  reason?: string,
  smsAccounting?: SmsDeliveryAccounting,
): NotificationLegResult {
  return {
    channel,
    status,
    ...(reason ? { reason } : {}),
    ...(smsAccounting ? { smsAccounting } : {}),
  };
}

export function notificationLeg(
  channel: string,
  status: NotificationLegStatus,
  reason?: string,
  smsAccounting?: SmsDeliveryAccounting,
): NotificationDeliveryResult {
  return { legs: [notificationLegEntry(channel, status, reason, smsAccounting)] };
}

export function hasEffectiveNotificationDelivery(
  result: NotificationDeliveryResult | void | undefined,
): boolean {
  return result?.legs.some((leg) => leg.status === 'delivered') ?? false;
}

/** Opaque stable key: source text and destinations never appear in stored IDs. */
export function notificationDeliveryKey(namespace: string, ...identity: string[]): string {
  if (!namespace.trim() || identity.some((value) => !value.trim()))
    throw new Error('notification delivery identity is incomplete');
  const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return `${namespace}:${digest}`;
}

/** Stable dashboard message identity for one durable outbox leg, shared with erasure cleanup. */
export function notificationDashboardMessageId(
  agentId: string,
  deliveryKey: string,
  legKey: string,
): string {
  if (!agentId.trim() || !deliveryKey.trim() || !legKey.trim())
    throw new Error('dashboard notification identity is incomplete');
  return `notification:${createHash('sha256')
    .update(`${agentId}\u0000${deliveryKey}\u0000${legKey}`)
    .digest('hex')}`;
}
