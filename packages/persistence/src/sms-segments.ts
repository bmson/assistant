/** Text encoding used by standard SMS segment accounting. */
export type SmsEncoding = 'gsm7' | 'ucs2';

export interface SmsSegmentEstimate {
  encoding: SmsEncoding;
  /** GSM septets or UTF-16 code units, depending on `encoding`. */
  encodedUnits: number;
  submittedMessages: 1;
  estimatedSegments: number;
}

/** Safe accounting receipt: provider identity and units only, never body or destination. */
export interface SmsDeliveryAccounting extends SmsSegmentEstimate {
  providerMessageId?: string;
  billedSegments?: number;
  providerPriceUsd?: number;
}

export function smsUsageReconciliationState(
  receipt: SmsDeliveryAccounting,
  now = new Date(),
): NonNullable<import('./cost-evidence.js').CostEvidence['smsUsageReconciliation']> {
  const complete = receipt.billedSegments !== undefined && receipt.providerPriceUsd !== undefined;
  return complete
    ? { status: 'complete', attempts: 0 }
    : { status: 'pending', attempts: 0, nextAttemptAt: now.toISOString() };
}

const GSM7_BASIC = new Set(
  Array.from(
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ),
);
// Each extension-table character is sent as ESC + character: two septets.
const GSM7_EXTENSION = new Set(Array.from('\f^{}\\[~]|€'));

/**
 * Estimate SMS segments from the exact submitted body. GSM-7 extension-table
 * characters consume two septets; any other scalar switches the whole message
 * to UCS-2, whose length is measured in UTF-16 code units (including surrogate
 * pairs). This is a conservative budget estimate; a provider receipt can later
 * replace the segment count and amount.
 */
export function estimateSmsSegments(body: string): SmsSegmentEstimate {
  let gsm = true;
  let septets = 0;
  for (const character of body) {
    if (GSM7_BASIC.has(character)) septets += 1;
    else if (GSM7_EXTENSION.has(character)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  const encoding: SmsEncoding = gsm ? 'gsm7' : 'ucs2';
  const encodedUnits = gsm ? septets : body.length;
  const singleCapacity = gsm ? 160 : 70;
  const multipartCapacity = gsm ? 153 : 67;
  return {
    encoding,
    encodedUnits,
    submittedMessages: 1,
    estimatedSegments:
      encodedUnits === 0
        ? 0
        : encodedUnits <= singleCapacity
          ? 1
          : Math.ceil(encodedUnits / multipartCapacity),
  };
}
