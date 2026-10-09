import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/** Shared lock order for autonomous start and retention compaction. */
export async function lockPostgresToolCallReceiptKeys(
  tx: Db,
  keys: readonly { id: string }[],
): Promise<void> {
  for (const key of [...keys].sort((a, b) => a.id.localeCompare(b.id))) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`assistant:tool-call-receipt:${key.id}`}, 0))`,
    );
  }
}
