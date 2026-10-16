import type {
  BirthdayOccasionToolRepository,
  OccasionToolRepository,
  OccasionToolRow,
} from '@assistant/persistence';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client.js';
import { contacts, occasions } from './schema.js';

/** Owner-scoped, read-only adapter for the portable birthday occasion tool. */
export function createPostgresOccasionToolReadRepository(
  db: Db,
): Pick<OccasionToolRepository, 'list'> & BirthdayOccasionToolRepository {
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
    async listBirthdays({ agentId, contactIds, limit }) {
      if (contactIds.length === 0) return { rows: [], overflow: false };
      if (
        contactIds.length > 20 ||
        new Set(contactIds).size !== contactIds.length ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 40
      )
        throw new Error('Birthday occasion read limit is outside its bound');
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
        .where(
          and(
            eq(occasions.agentId, agentId),
            inArray(occasions.contactId, contactIds),
            eq(occasions.kind, 'birthday'),
            eq(occasions.recurrence, 'annual'),
            eq(occasions.ownerConfirmed, true),
            eq(occasions.quarantined, false),
          ),
        )
        .orderBy(
          asc(occasions.contactId),
          asc(occasions.month),
          asc(occasions.day),
          asc(occasions.id),
        )
        .limit(limit + 1);
      return {
        rows: rows.slice(0, limit).map((row) => ({ ...row, notes: '' })),
        overflow: rows.length > limit,
      };
    },
  };
}
