/** Outcome of a final answer routed to one external or dashboard channel. */
export type FinalChannelDeliveryStatus = 'not_applicable' | 'accepted' | 'rejected' | 'unknown';

/**
 * `attemptId` identifies this persisted attempt across crash recovery. It is
 * not a provider idempotency key; an `unknown` result must not be resent
 * automatically unless the provider supplied its own deduplication contract.
 */
export interface FinalChannelDeliveryResult {
  channel: string;
  status: FinalChannelDeliveryStatus;
  attemptId: string;
  reason?: string;
  smsAccounting?: import('./sms-segments.js').SmsDeliveryAccounting;
}

export interface FinalChannelDeliveryReport {
  legs: FinalChannelDeliveryResult[];
}

export function finalChannelDelivery(
  channel: string,
  status: FinalChannelDeliveryStatus,
  attemptId: string,
  reason?: string,
  smsAccounting?: import('./sms-segments.js').SmsDeliveryAccounting,
): FinalChannelDeliveryResult {
  return {
    channel,
    status,
    attemptId,
    ...(reason ? { reason } : {}),
    ...(smsAccounting ? { smsAccounting } : {}),
  };
}

export function finalChannelDeliveryReport(
  legs: readonly FinalChannelDeliveryResult[],
): FinalChannelDeliveryReport {
  return { legs: [...legs] };
}
