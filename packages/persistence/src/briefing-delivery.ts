import { emailIngestReadable } from './email-ingest-readiness.js';
import type { Records } from './records.js';
import { extractDeliveryEmailEvidence } from './rescheduled-delivery.js';
import { deliveryDayKey, deliveryShipmentIdentity, type Signal } from './signals.js';

export interface BriefingDelivery {
  signalId: string;
  ingestId: string;
  momentKey: string;
  deliveryDate: string;
  shipmentReference: string;
}

/** Civil delivery keys have no timezone offset. The briefing clock does. */
export function deliveryMorning(now: Date, timeZone: string) {
  const local = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(now);
  const [date, time] = local.split(' ');
  // The ordinary briefing runs at 07:45 and an owner wake can advance it to 04:00.
  if (!date || !time || time < '04:00' || time >= '12:00') return null;
  const from = new Date(deliveryDayKey(date));
  return { date, from, to: new Date(from.getTime() + 86_400_000) };
}

/** Bind the active delivery signal to its admitted, still-available sender evidence. */
export function briefingDeliveryFromSource(
  signal: Signal,
  row: Records['emailIngest'],
  canonicalText: string,
  agentId: string,
  deliveryDate: string,
  now: Date,
): BriefingDelivery | null {
  if (
    signal.kind !== 'delivery' ||
    signal.agentId !== agentId ||
    signal.deliveryDate !== deliveryDate ||
    signal.validFrom > now.toISOString() ||
    signal.validTo !== null ||
    signal.supersededBy !== null ||
    row.agentId !== agentId ||
    row.ingestMode !== 'direct' ||
    !row.authenticated ||
    !['owner', 'known'].includes(row.contentTrust) ||
    (row.admittedSourceKind !== 'message' && row.admittedSourceKind !== 'automated_source') ||
    row.admittedSourceId !== signal.sourceRefs[0].id ||
    row.providerReceivedAt?.toISOString() !== signal.validFrom ||
    !row.providerMessageId ||
    row.channelMessageId !== `gmail:${row.providerMessageId}` ||
    !emailIngestReadable(row) ||
    !row.emailContentProvenance
  )
    return null;
  const match = extractDeliveryEmailEvidence(canonicalText, row.emailContentProvenance);
  if (
    !match ||
    match.iso !== signal.deliveryDate ||
    match.previousDeliveryDate !== signal.previousDeliveryDate ||
    match.carrier !== signal.carrier ||
    match.signatureRequired !== signal.signatureRequired ||
    deliveryShipmentIdentity(agentId, row.fromEmail, match.shipmentReference) !==
      signal.shipmentIdentity
  )
    return null;
  return {
    signalId: signal.id,
    ingestId: row.id,
    momentKey: `delivery-today:${row.channelMessageId}`,
    deliveryDate,
    shipmentReference: match.shipmentReference,
  };
}

export function sameBriefingDelivery(
  actual: BriefingDelivery | null,
  expected: BriefingDelivery,
): boolean {
  return (
    actual !== null &&
    actual.signalId === expected.signalId &&
    actual.ingestId === expected.ingestId &&
    actual.momentKey === expected.momentKey &&
    actual.deliveryDate === expected.deliveryDate &&
    actual.shipmentReference === expected.shipmentReference
  );
}
