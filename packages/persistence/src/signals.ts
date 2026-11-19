import { createHash } from 'node:crypto';
import { admittedBillEmailEvidence } from './bill-email-evidence.js';
import type { Records } from './records.js';

type SignalFields = {
  version: 1;
  id: string;
  agentId: string;
  subjectPersonIds: string[];
  sourceRefs: [{ kind: 'email'; id: string }];
  billIdentity: string;
  amountMinor: number;
  currency: 'USD';
  at: string;
  validFrom: string;
  validTo: string | null;
  supersededBy: string | null;
};

export type Signal = SignalFields &
  ({ kind: 'bill'; dueDate: string } | { kind: 'payment'; dueDate: null });

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
  kind: Signal['kind'];
  personId: string;
  /** Event time range [from, to), independent of the signal's validity. */
  from: Date;
  to: Date;
  /** Validity instant. Producers supply their current clock or a historical instant. */
  asOf: Date;
}

export interface SignalRepository {
  record(input: RecordBillSignal): Promise<Signal>;
  /** Canonical record, including its durable supersession metadata. */
  get(agentId: string, id: string): Promise<Signal | null>;
  /** Signals valid at asOf, in event-time order, with canonical metadata. */
  list(query: SignalQuery): Promise<Signal[]>;
}

export function prepareBillSignal(
  input: RecordBillSignal,
  source: Partial<Records['emailIngest']> | undefined,
): Signal {
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
  const fields: SignalFields = {
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
  };
  return evidence.kind === 'invoice'
    ? { ...fields, kind: 'bill', dueDate: evidence.dueDate }
    : { ...fields, kind: 'payment', dueDate: null };
}

export function planSignalWrite(
  input: RecordBillSignal,
  signal: Signal,
  existing: Signal | null,
  prior: Signal | null,
): { signal: Signal; insert: boolean; close: Signal | null } {
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
    close: prior ? { ...prior, validTo: signal.validFrom, supersededBy: signal.id } : null,
  };
}

export function signalQueryTimes(query: SignalQuery) {
  const from = query.from.toISOString();
  const to = query.to.toISOString();
  if (from >= to || !query.personId.trim()) throw new Error('Invalid signal query');
  return { from, to, asOf: query.asOf.toISOString() };
}

export function signalsValidAt(rows: Signal[], asOf: string): Signal[] {
  return rows
    .filter((row) => row.validFrom <= asOf && (row.validTo === null || asOf < row.validTo))
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
}
