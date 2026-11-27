import { completeSenderLines } from './email-provenance-text.js';
import type { EmailContentProvenanceSnapshot } from './email-sync.js';

export interface DeliveryEmailEvidence {
  kind: 'delivery';
  shipmentReference: string;
  previousDeliveryDate: string | null;
  iso: string;
  precision: 'date';
  carrier: string | null;
  signatureRequired: boolean | null;
  /** Exact sender line containing the shipment reference and current date. */
  dateEvidence: string;
  carrierEvidence: string | null;
  signatureEvidence: string | null;
}

const SCHEDULE = /^Store delivery ([\w-]{1,80}) is scheduled for (\d{4}-\d{2}-\d{2})\.$/iu;
const RESCHEDULE =
  /^Store delivery ([\w-]{1,80}) was moved from (\d{4}-\d{2}-\d{2})\. The current delivery date is (\d{4}-\d{2}-\d{2})\.$/iu;
const CARRIER = /^Carrier for delivery ([\w-]{1,80}): ([\p{L}\p{N}][\p{L}\p{N} &'-]{0,79})\.$/iu;
const SIGNATURE = /^A signature is (not required|required) for delivery ([\w-]{1,80})\.$/iu;

function isCalendarDate(value: string): boolean {
  const day = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

/** Recognizes an explicit dispatch update. Every field must come from a complete sender line. */
export function extractDeliveryEmailEvidence(
  text: string,
  provenance: EmailContentProvenanceSnapshot,
): DeliveryEmailEvidence | null {
  return deliveryEvidenceFromLines(completeSenderLines(text, provenance));
}

function deliveryEvidenceFromLines(senderLines: readonly string[]): DeliveryEmailEvidence | null {
  const updates = senderLines.flatMap<{
    dateEvidence: string;
    reference: string | undefined;
    previousDate: string | null | undefined;
    iso: string | undefined;
  }>((line) => {
    const moved = RESCHEDULE.exec(line);
    if (moved)
      return [{ dateEvidence: line, reference: moved[1], previousDate: moved[2], iso: moved[3] }];
    const scheduled = SCHEDULE.exec(line);
    return scheduled
      ? [{ dateEvidence: line, reference: scheduled[1], previousDate: null, iso: scheduled[2] }]
      : [];
  });
  const update = updates[0];
  if (updates.length !== 1 || !update) return null;
  const { dateEvidence, reference, previousDate, iso } = update;
  if (
    !reference ||
    !iso ||
    iso === previousDate ||
    (previousDate !== null && (!previousDate || !isCalendarDate(previousDate))) ||
    !isCalendarDate(iso)
  )
    return null;

  const carriers = senderLines.flatMap((line) => {
    const match = CARRIER.exec(line);
    return match?.[1] === reference ? [match] : [];
  });
  if (carriers.length > 1) return null;
  const [carrierEvidence, , carrier] = carriers[0] ?? [];

  const signatures = senderLines.flatMap((line) => {
    const match = SIGNATURE.exec(line);
    return match?.[2] === reference ? [match] : [];
  });
  const signature = signatures.length === 1 ? signatures[0] : undefined;

  return {
    kind: 'delivery',
    shipmentReference: reference,
    previousDeliveryDate: previousDate,
    iso,
    precision: 'date',
    carrier: carrier ?? null,
    signatureRequired: signature ? signature[1]?.toLowerCase() === 'required' : null,
    dateEvidence,
    carrierEvidence: carrierEvidence ?? null,
    signatureEvidence: signature?.[0] ?? null,
  };
}
