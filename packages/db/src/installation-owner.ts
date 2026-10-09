import type { Db } from './client.js';
import { agents } from './schema.js';

/** Installation-global identities and budgets are supported for exactly one owner. */
export async function assertPostgresInstallationOwner(db: Db, expectedAgentId?: string) {
  const rows = await db.select({ id: agents.id }).from(agents).limit(2);
  if (rows.length !== 1 || !rows[0] || (expectedAgentId && rows[0].id !== expectedAgentId))
    throw new Error(
      'This installation requires exactly one owner; review conflicting owner data before continuing',
    );
  return rows[0].id;
}
