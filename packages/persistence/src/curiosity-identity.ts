import { createHash } from 'node:crypto';
import { notificationDeliveryKey } from './notification-delivery.js';

export function curiosityMessageId(agentId: string, key: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify(['curiosity-notice', agentId, key]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Stable identity shared by admission, the immediate notifier, and outbox recovery. */
export function curiosityDeliveryKey(key: string): string {
  return notificationDeliveryKey('curiosity-notice', key);
}

/**
 * The nudge ledger row reserved with a curiosity admission is reused by the
 * ordinary notifier immediately after commit. It prevents charging the same
 * ambient slot twice while keeping the raw graph gap key out of the ledger.
 */
export function curiosityNudgeChannel(deliveryKey: string): string {
  return notificationDeliveryKey('curiosity-nudge', deliveryKey);
}

export function curiosityNudgePingId(agentId: string, channel: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify(['curiosity-nudge', agentId, channel]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function notificationOutboxLegId(
  agentId: string,
  deliveryKey: string,
  legKey: string,
): string {
  return createHash('sha256').update(`${agentId}\u0000${deliveryKey}\u0000${legKey}`).digest('hex');
}

export function pushDeviceKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
