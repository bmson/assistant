import {
  type BillEmailEvidence,
  type EmailBillStatus,
  emailBillStatus,
  type Records,
} from '@assistant/persistence';
import type { Transaction } from '@google-cloud/firestore';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

export async function readFirestoreEmailBillStatus(
  store: InstallationStore,
  agentId: string,
  invoice: Extract<BillEmailEvidence, { kind: 'invoice' }>,
  now: Date,
  tx?: Transaction,
): Promise<EmailBillStatus> {
  // Identity includes the owner. Keep it to a single indexed equality and
  // independently verify both owner and source document on readback.
  const query = store
    .collection('emailIngest')
    .where('billEvidence.identity', '==', invoice.identity)
    .limit(51);
  const result = tx ? await tx.get(query) : await query.get();
  if (result.size > 50) return { kind: 'conflicting-evidence' };
  const rows = result.docs.map((doc) => {
    const row = decodeRecord<Records['emailIngest']>(doc.data());
    if (typeof row.id !== 'string' || documentKey(row.id) !== doc.id || row.agentId !== agentId)
      throw new Error('Bill evidence source identity mismatch');
    return row;
  });
  return emailBillStatus(invoice, rows, now);
}
