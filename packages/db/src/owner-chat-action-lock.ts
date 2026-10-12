import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/** Serializes owner-chat admission and selected checklist edits for one conversation. */
export async function lockPostgresOwnerChatAction(
  tx: Pick<Db, 'execute'>,
  agentId: string,
  conversationId: string,
): Promise<void> {
  const key = `assistant:owner-chat-action:${JSON.stringify([agentId, conversationId])}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
