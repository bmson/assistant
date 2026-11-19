import {
  type BillEmailEvidence,
  type EmailBillStatus,
  emailBillStatus,
} from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { emailIngestReadableSql } from './email-ingest-readiness.js';
import { emailIngest } from './schema.js';

export async function readPostgresEmailBillStatus(
  db: Pick<Db, 'select'>,
  agentId: string,
  invoice: Extract<BillEmailEvidence, { kind: 'invoice' }>,
  now: Date,
): Promise<EmailBillStatus> {
  const rows = await db
    .select()
    .from(emailIngest)
    .where(
      and(
        eq(emailIngest.agentId, agentId),
        emailIngestReadableSql(),
        sql`${emailIngest.billEvidence}->>'identity' = ${invoice.identity}`,
      ),
    )
    .limit(51);
  if (rows.length > 50) return { kind: 'conflicting-evidence' };
  return emailBillStatus(invoice, rows, now);
}
