import { estimateSmsSegments, type SmsDeliveryAccounting } from '@assistant/persistence';
import type { SmsSender } from './client.js';

export interface SubmittedSms {
  sid: string;
  accounting: SmsDeliveryAccounting;
  providerUsage?: { billedSegments?: number; priceUsd?: number };
}

/** Sends the already-prepared body once, then opportunistically reads its receipt. */
export async function submitSms(
  sender: SmsSender,
  to: string,
  body: string,
): Promise<SubmittedSms> {
  const estimate = estimateSmsSegments(body);
  const sent = await sender.send(to, body);
  const providerUsage = await sender.getMessageUsage?.(sent.sid).catch(() => undefined);
  return {
    sid: sent.sid,
    accounting: {
      ...estimate,
      providerMessageId: sent.sid,
      ...(providerUsage?.billedSegments ? { billedSegments: providerUsage.billedSegments } : {}),
      ...(providerUsage?.priceUsd !== undefined
        ? { providerPriceUsd: providerUsage.priceUsd }
        : {}),
    },
    ...(providerUsage ? { providerUsage } : {}),
  };
}
