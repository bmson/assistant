import { type NotificationDeliveryResult, notificationLeg } from '@assistant/persistence';
/**
 * The one shape a proactive producer uses to reach the owner.
 *
 * Producers post their own dashboard copy (`postOwnerNotice`) and then call
 * this for the phone leg, passing the conversation they already wrote to so
 * the dashboard notifier skips mirroring a second copy. It is deliberately the
 * same input shape as the executor's `notifyOwner` dep, so the composition
 * root satisfies both with one function.
 *
 * `urgency: 'ambient'` is the point of it: proactive notices are things the
 * owner did NOT just ask for, so quiet hours and the daily cap
 * (`evaluateOutOfBandPing`) govern whether the phone buzzes. A held ping is
 * never a lost one — the dashboard copy is already posted.
 */
export type ProactiveNotifier = (input: {
  deliveryKey?: string;
  taskId?: string;
  conversationId: string | null;
  text: string;
  urgency?: 'ambient' | 'interrupt';
}) => Promise<NotificationDeliveryResult | void>;

/** Only a separate phone/provider leg counts as a ping; the notice already exists. */
export function hasAcknowledgedPhoneDelivery(receipt: NotificationDeliveryResult): boolean {
  return receipt.legs.some((leg) => leg.channel !== 'dashboard' && leg.status === 'delivered');
}

export async function proactiveNotificationOutcome(
  notify: ProactiveNotifier | undefined,
  input: { deliveryKey?: string; taskId?: string; conversationId: string | null; text: string },
): Promise<NotificationDeliveryResult> {
  if (!notify) return notificationLeg('phone', 'skipped', 'no-notifier');
  try {
    const receipt = await notify({ ...input, urgency: 'ambient' });
    return receipt ?? notificationLeg('phone', 'unknown', 'missing-notification-receipt');
  } catch (error) {
    console.error('proactive ping failed', error);
    return notificationLeg('phone', 'failed', 'notification-error');
  }
}

/** A held/absent/ambiguous phone leg cannot turn a persisted notice into a failed question. */
export async function pingOwner(
  notify: ProactiveNotifier | undefined,
  input: { deliveryKey?: string; taskId?: string; conversationId: string | null; text: string },
): Promise<boolean> {
  return hasAcknowledgedPhoneDelivery(await proactiveNotificationOutcome(notify, input));
}
