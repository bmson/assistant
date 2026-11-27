import { createHash } from 'node:crypto';
import { z } from 'zod';
import { admittedBillEmailEvidence } from './bill-email-evidence.js';
import type { Records } from './records.js';
import { extractDeliveryEmailEvidence } from './rescheduled-delivery.js';

type SignalFields = {
  version: 1;
  id: string;
  agentId: string;
  subjectPersonIds: string[];
  sourceRefs: [{ kind: 'email'; id: string }];
  at: string;
  validFrom: string;
  validTo: string | null;
  supersededBy: string | null;
};

export type BillSignal = SignalFields & {
  billIdentity: string;
  amountMinor: number;
  currency: 'USD';
} & ({ kind: 'bill'; dueDate: string } | { kind: 'payment'; dueDate: null });

export type DeliverySignal = SignalFields & {
  kind: 'delivery';
  shipmentIdentity: string;
  previousDeliveryDate: string | null;
  deliveryDate: string;
  carrier: string | null;
  signatureRequired: boolean | null;
  replaces: string | null;
};

export type Signal = BillSignal | DeliverySignal;

const signalId = z.string().regex(/^[a-f0-9]{64}$/);
const signalInstant = z.string().datetime({ precision: 3 });
const signalFields = z
  .object({
    version: z.literal(1),
    id: signalId,
    agentId: z.string().min(1),
    subjectPersonIds: z.array(z.string().refine((id) => Boolean(id.trim()))).min(1),
    sourceRefs: z.tuple([z.object({ kind: z.literal('email'), id: z.string().min(1) }).strict()]),
    at: signalInstant,
    validFrom: signalInstant,
    validTo: signalInstant.nullable(),
    supersededBy: signalId.nullable(),
  })
  .strict();
const billSignalFields = signalFields.extend({
  billIdentity: signalId,
  amountMinor: z.number().int().nonnegative(),
  currency: z.literal('USD'),
});
const storedSignal = z.discriminatedUnion('kind', [
  billSignalFields.extend({ kind: z.literal('bill'), dueDate: z.iso.date() }),
  billSignalFields.extend({ kind: z.literal('payment'), dueDate: z.null() }),
  signalFields.extend({
    kind: z.literal('delivery'),
    shipmentIdentity: signalId,
    previousDeliveryDate: z.iso.date().nullable(),
    deliveryDate: z.iso.date(),
    carrier: z.string().min(1).max(80).nullable(),
    signatureRequired: z.boolean().nullable(),
    replaces: signalId.nullable(),
  }),
]);

export function parseSignal(value: unknown): Signal {
  const signal = storedSignal.parse(value);
  const expectedId =
    signal.kind === 'delivery'
      ? deliverySignalId(signal)
      : signalHash([signal.agentId, signal.kind, signal.billIdentity]);
  if (
    signal.id !== expectedId ||
    JSON.stringify(signal.subjectPersonIds) !==
      JSON.stringify([...new Set(signal.subjectPersonIds)].sort()) ||
    (signal.validTo === null) !== (signal.supersededBy === null) ||
    (signal.validTo !== null && signal.validTo <= signal.validFrom) ||
    (signal.kind === 'payment' && signal.supersededBy !== null) ||
    (signal.kind === 'delivery' &&
      (signal.at !== deliveryDayKey(signal.deliveryDate) ||
        signal.previousDeliveryDate === signal.deliveryDate ||
        (signal.replaces !== null && signal.previousDeliveryDate === null)))
  )
    throw new Error('Invalid signal migration or stored identity');
  return signal;
}

export interface RecordBillSignal {
  agentId: string;
  /** Durable email-ingest row, checked against the admitted bill evidence contract. */
  emailIngestId: string;
  subjectPersonIds: readonly string[];
  at: Date;
  /** The invoice signal ID explicitly selected by the caller for a payment. */
  replaces?: string;
}

export interface SignalQuery {
  agentId: string;
  kind?: Signal['kind'];
  personId?: string;
  /** Specify both endpoints for an event-time range [from, to). */
  from?: Date;
  to?: Date;
  /** Validity instant. Producers supply their current clock or a historical instant. */
  asOf: Date;
}

export interface SignalRepository {
  record(input: RecordBillSignal): Promise<BillSignal>;
  /** Canonical record, including its durable supersession metadata. */
  get(agentId: string, id: string): Promise<Signal | null>;
  /** Apply one or more filters within the agent and return signals valid at asOf. */
  list(query: SignalQuery): Promise<Signal[]>;
}

export function prepareBillSignal(
  input: RecordBillSignal,
  source: Partial<Records['emailIngest']> | undefined,
): BillSignal {
  if (
    !source ||
    source.agentId !== input.agentId ||
    source.id !== input.emailIngestId ||
    !source.admittedSourceId ||
    !(source.providerReceivedAt instanceof Date)
  )
    throw new Error('Signal source is unavailable');
  const evidence = admittedBillEmailEvidence(source);
  if (!evidence) throw new Error('Signal source is not admitted bill evidence');

  const subjectPersonIds = [...new Set(input.subjectPersonIds)].sort();
  if (!subjectPersonIds.length || subjectPersonIds.some((id) => !id.trim()))
    throw new Error('Signal requires explicit people');

  const kind = evidence.kind === 'invoice' ? 'bill' : 'payment';
  const fields = {
    version: 1,
    id: createHash('sha256')
      .update(JSON.stringify([input.agentId, kind, evidence.identity]))
      .digest('hex'),
    agentId: input.agentId,
    subjectPersonIds,
    sourceRefs: [{ kind: 'email', id: source.admittedSourceId }],
    billIdentity: evidence.identity,
    amountMinor: evidence.amountMinor,
    currency: evidence.currency,
    at: input.at.toISOString(),
    validFrom: source.providerReceivedAt.toISOString(),
    validTo: null,
    supersededBy: null,
  } satisfies Omit<BillSignal, 'kind' | 'dueDate'>;
  return evidence.kind === 'invoice'
    ? { ...fields, kind: 'bill', dueDate: evidence.dueDate }
    : { ...fields, kind: 'payment', dueDate: null };
}

export function planSignalWrite(
  input: RecordBillSignal,
  signal: BillSignal,
  existing: Signal | null,
  prior: Signal | null,
): { signal: BillSignal; insert: boolean; close: BillSignal | null } {
  if (signal.kind === 'bill' && input.replaces !== undefined)
    throw new Error('Only a payment can supersede a bill');
  if (signal.kind === 'payment') {
    if (
      prior?.kind !== 'bill' ||
      prior.id !== input.replaces ||
      prior.agentId !== signal.agentId ||
      prior.billIdentity !== signal.billIdentity ||
      prior.amountMinor !== signal.amountMinor ||
      prior.currency !== signal.currency ||
      prior.validFrom >= signal.validFrom ||
      JSON.stringify(prior.subjectPersonIds) !== JSON.stringify(signal.subjectPersonIds)
    )
      throw new Error('Payment does not match the selected prior bill');
    if (prior.supersededBy !== (existing ? signal.id : null))
      throw new Error('Bill already superseded');
  }

  if (existing?.kind === 'delivery') throw new Error('Conflicting replay for signal');
  if (existing) {
    // Equivalent evidence retains the first admitted source and validity. JSONB can reorder keys.
    const matches = [
      'version',
      'agentId',
      'kind',
      'billIdentity',
      'amountMinor',
      'currency',
      'at',
      'dueDate',
    ] as const;
    if (
      matches.some((key) => existing[key] !== signal[key]) ||
      JSON.stringify(existing.subjectPersonIds) !== JSON.stringify(signal.subjectPersonIds)
    )
      throw new Error('Conflicting replay for signal');
    return { signal: existing, insert: false, close: null };
  }
  return {
    signal,
    insert: true,
    close:
      prior?.kind === 'bill'
        ? { ...prior, validTo: signal.validFrom, supersededBy: signal.id }
        : null,
  };
}

export function signalQueryTimes(query: SignalQuery) {
  const from = query.from?.toISOString();
  const to = query.to?.toISOString();
  if (query.personId !== undefined && !query.personId.trim())
    throw new Error('Signal query person is empty');
  if (
    (from === undefined) !== (to === undefined) ||
    (from !== undefined && to !== undefined && from >= to)
  )
    throw new Error('Signal query requires a nonempty time range with both endpoints');
  if (query.kind === undefined && query.personId === undefined && from === undefined)
    throw new Error('Signal query requires at least one filter');
  return { from, to, asOf: query.asOf.toISOString() };
}

export function signalsValidAt(rows: Signal[], asOf: string): Signal[] {
  return rows
    .filter((row) => row.validFrom <= asOf && (row.validTo === null || asOf < row.validTo))
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
}

/** UTC ISO sort marker for a civil delivery day; it makes no claim about an hour or time zone. */
export function deliveryDayKey(date: string): string {
  return `${date}T00:00:00.000Z`;
}

function signalHash(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function deliveryShipmentIdentity(
  agentId: string,
  fromEmail: string,
  shipmentReference: string,
): string {
  return signalHash([agentId, fromEmail.toLowerCase(), shipmentReference]);
}

export function deliverySignalId(signal: DeliverySignal): string {
  // A shipment's first fact has a deterministic ID so concurrent first admissions
  // contend on the same physical record even before a current fact exists.
  return signalHash(
    signal.replaces === null
      ? [signal.agentId, 'delivery', signal.shipmentIdentity]
      : [signal.agentId, 'delivery', signal.shipmentIdentity, signal.sourceRefs[0].id],
  );
}

export function prepareDeliverySignal(
  row: Partial<Records['emailIngest']>,
  canonicalText: string,
  sourceId: string,
): DeliverySignal | null {
  const { agentId, fromEmail, providerReceivedAt, emailContentProvenance: provenance } = row;
  if (
    row.ingestMode !== 'direct' ||
    row.authenticated !== true ||
    (row.contentTrust !== 'owner' && row.contentTrust !== 'known') ||
    !agentId ||
    !fromEmail ||
    !sourceId ||
    !provenance ||
    !(providerReceivedAt instanceof Date) ||
    !Number.isFinite(providerReceivedAt.getTime())
  )
    return null;
  const evidence = extractDeliveryEmailEvidence(canonicalText, provenance);
  if (!evidence) return null;
  const signal: DeliverySignal = {
    version: 1,
    id: '',
    agentId,
    kind: 'delivery',
    subjectPersonIds: [agentId],
    sourceRefs: [{ kind: 'email', id: sourceId }],
    shipmentIdentity: deliveryShipmentIdentity(agentId, fromEmail, evidence.shipmentReference),
    carrier: evidence.carrier,
    signatureRequired: evidence.signatureRequired,
    previousDeliveryDate: evidence.previousDeliveryDate,
    deliveryDate: evidence.iso,
    at: deliveryDayKey(evidence.iso),
    validFrom: providerReceivedAt.toISOString(),
    validTo: null,
    supersededBy: null,
    replaces: null,
  };
  return { ...signal, id: deliverySignalId(signal) };
}

export function isDeliveryReplacement(prior: DeliverySignal, next: DeliverySignal): boolean {
  return (
    prior.agentId === next.agentId &&
    prior.shipmentIdentity === next.shipmentIdentity &&
    prior.deliveryDate === next.previousDeliveryDate &&
    next.replaces === prior.id &&
    prior.validFrom < next.validFrom &&
    prior.sourceRefs[0].id !== next.sourceRefs[0].id &&
    JSON.stringify(prior.subjectPersonIds) === JSON.stringify(next.subjectPersonIds)
  );
}

export function planDeliveryAdmission(signal: DeliverySignal, history: readonly Signal[]) {
  const versions = history.filter(
    (item): item is DeliverySignal =>
      item.kind === 'delivery' &&
      item.agentId === signal.agentId &&
      item.shipmentIdentity === signal.shipmentIdentity,
  );
  if (versions.length !== history.length) throw new Error('Delivery signal identity mismatch');
  if (versions.some((item) => item.sourceRefs[0].id === signal.sourceRefs[0].id)) return null;
  if (!versions.length) return { next: signal, close: null };
  const current = versions.filter((item) => item.validTo === null && item.supersededBy === null);
  if (current.length !== 1) throw new Error('Shipment has no unique current delivery signal');
  const prior = current[0];
  if (!prior) throw new Error('Current delivery signal is missing');
  const next = { ...signal, replaces: prior.id };
  if (!isDeliveryReplacement(prior, next)) return null;
  const id = deliverySignalId(next);
  return {
    next: { ...next, id },
    close: { ...prior, validTo: next.validFrom, supersededBy: id },
  };
}
