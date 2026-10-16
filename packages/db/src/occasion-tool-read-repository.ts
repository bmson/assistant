import type { OccasionToolRepository, OccasionToolRow } from '@assistant/persistence';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { contacts, occasions } from './schema.js';

/** Owner-scoped, read-only adapter for the portable birthday occasion tool. */
export function createPostgresOccasionToolReadRepository(
  db: Db,
): Pick<OccasionToolRepository, 'list'> {
  return {
    async list(agentId): Promise<OccasionToolRow[]> {
      const rows = await db
        .select({
          id: occasions.id,
          contactId: occasions.contactId,
          contactName: contacts.name,
          kind: occasions.kind,
          label: occasions.label,
          month: occasions.month,
          day: occasions.day,
          year: occasions.year,
          recurrence: occasions.recurrence,
          leadDays: occasions.leadDays,
          originTrust: occasions.originTrust,
          quarantined: occasions.quarantined,
          ownerConfirmed: occasions.ownerConfirmed,
        })
        .from(occasions)
        .innerJoin(contacts, eq(contacts.id, occasions.contactId))
        .where(and(eq(occasions.agentId, agentId), eq(occasions.quarantined, false)))
        .orderBy(
          asc(occasions.contactId),
          asc(occasions.month),
          asc(occasions.day),
          asc(occasions.id),
        );
      return rows.map((row) => ({ ...row, notes: '' }));
    },
  };
}
