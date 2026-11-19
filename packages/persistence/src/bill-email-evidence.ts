import { createHash } from 'node:crypto';
import { emailIngestReadable } from './email-ingest-readiness.js';
import type { Records } from './records.js';

const USD = 'USD' as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const INVOICE =
  /^Invoice ([A-Z0-9][A-Z0-9-]{2,39}): USD ([1-9]\d{0,6}|0)\.(\d{2}) is due on ([A-Za-z]+) (\d{1,2}), (20\d{2})\.$/;
const RECEIPT =
  /^Payment received in full for invoice ([A-Z0-9][A-Z0-9-]{2,39}): USD ([1-9]\d{0,6}|0)\.(\d{2})\. Balance due: USD 0\.00\.$/;

interface BillSourceEvidence {
  version: 1;
  identity: string;
  invoiceId: string;
  issuer: string;
  currency: typeof USD;
  amountMinor: number;
  evidenceLine: string;
}

export type BillEmailEvidence =
  | (BillSourceEvidence & { kind: 'invoice'; dueDate: string })
  | (BillSourceEvidence & { kind: 'paid-in-full' });

export type EmailBillStatus =
  | { kind: 'due' }
  | { kind: 'paid'; sourceKey: string }
  | { kind: 'conflicting-evidence' }
  | { kind: 'owner-decision' };

function billLine(line: string, agentId: string, issuer: string): BillEmailEvidence | null {
  const invoice = INVOICE.exec(line);
  const receipt = RECEIPT.exec(line);
  const match = invoice ?? receipt;
  if (!match || !issuer || !agentId) return null;
  const [, invoiceId, whole, cents] = match;
  if (!invoiceId || !whole || !cents) return null;
  const amountMinor = Number(whole) * 100 + Number(cents);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
  const identity = createHash('sha256')
    .update(JSON.stringify([agentId, issuer, invoiceId]))
    .digest('hex');
  const evidence = {
    version: 1 as const,
    identity,
    invoiceId,
    issuer,
    currency: USD,
    amountMinor,
    evidenceLine: line,
  };
  if (receipt) return { ...evidence, kind: 'paid-in-full' };
  const month = MONTHS.indexOf(match[4] ?? '') + 1;
  const day = Number(match[5]);
  const year = Number(match[6]);
  if (!month || !day || !year) return null;
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== date) return null;
  return { ...evidence, kind: 'invoice', dueDate: date };
}

export function extractBillEmailEvidence(input: {
  agentId: string;
  issuer: string;
  body: string;
  provenance: Records['emailIngest']['emailContentProvenance'];
}): BillEmailEvidence | null {
  const { agentId, issuer, body, provenance } = input;
  if (!provenance?.authenticated || provenance.mode !== 'direct' || provenance.hasExternalOrUnknown)
    return null;
  const lines = [
    ...body.matchAll(/^(?:Invoice |Payment received in full for invoice )[^\r\n]+$/gmu),
  ];
  if (lines.length !== 1) return null;
  const [match] = lines;
  if (
    !match ||
    !provenance.spans.some(
      (span) =>
        span.author === 'sender' &&
        span.start <= match.index &&
        span.end >= match.index + match[0].length,
    )
  )
    return null;
  return billLine(match[0], agentId, issuer);
}

export function admittedBillEmailEvidence(
  row: Partial<Records['emailIngest']>,
): BillEmailEvidence | null {
  const stored = row.billEvidence;
  if (
    stored?.version !== 1 ||
    typeof stored.evidenceLine !== 'string' ||
    stored.evidenceLine.length > 240 ||
    row.ingestMode !== 'direct' ||
    row.authenticated !== true ||
    (row.contentTrust !== 'owner' && row.contentTrust !== 'known') ||
    row.hasExternalOrUnknown !== false ||
    !row.admittedSourceId ||
    !emailIngestReadable(row) ||
    !(row.providerReceivedAt instanceof Date) ||
    !row.fromEmail ||
    !row.agentId
  )
    return null;
  const evidence = billLine(stored.evidenceLine, row.agentId, row.fromEmail);
  if (
    !evidence ||
    evidence.kind !== stored.kind ||
    evidence.identity !== stored.identity ||
    evidence.issuer !== stored.issuer ||
    evidence.invoiceId !== stored.invoiceId ||
    evidence.currency !== stored.currency ||
    evidence.amountMinor !== stored.amountMinor ||
    (evidence.kind === 'invoice' &&
      (stored.kind !== 'invoice' || evidence.dueDate !== stored.dueDate))
  )
    return null;
  return evidence;
}

export function emailBillStatus(
  invoice: Extract<BillEmailEvidence, { kind: 'invoice' }>,
  rows: readonly Partial<Records['emailIngest']>[],
  now: Date,
): EmailBillStatus {
  let paidSourceKey: string | undefined;
  let conflictingEvidence = false;
  for (const row of rows) {
    if (!(row.providerReceivedAt instanceof Date) || row.providerReceivedAt > now) continue;
    const fact = admittedBillEmailEvidence(row);
    if (fact?.identity !== invoice.identity) {
      if (row.billEvidence?.identity === invoice.identity && emailIngestReadable(row))
        conflictingEvidence = true;
      continue;
    }
    if (fact.kind === 'invoice' && row.obligationDecision) return { kind: 'owner-decision' };
    if (
      fact.amountMinor !== invoice.amountMinor ||
      fact.currency !== invoice.currency ||
      (fact.kind === 'invoice' && fact.dueDate !== invoice.dueDate)
    )
      conflictingEvidence = true;
    if (
      fact.kind === 'paid-in-full' &&
      row.channelMessageId &&
      (!paidSourceKey || row.channelMessageId < paidSourceKey)
    )
      paidSourceKey = row.channelMessageId;
  }
  if (conflictingEvidence) return { kind: 'conflicting-evidence' };
  return paidSourceKey ? { kind: 'paid', sourceKey: paidSourceKey } : { kind: 'due' };
}
