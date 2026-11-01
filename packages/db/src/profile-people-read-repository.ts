import {
  type ProfileContact,
  type ProfileContactSnapshot,
  type ProfilePeopleReadRepository,
  profileContactIdentityRevision,
} from '@assistant/persistence';
import { and, asc, count, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { agents, contacts, memories, occasions, ownerCard } from './schema.js';

export const PROFILE_BROWSE_OCCASION_MAX_ROWS = 1_000;
export class PostgresProfileOccasionLimitError extends Error {
  readonly code = 'POSTGRES_PROFILE_OCCASION_LIMIT';
  constructor() {
    super('Person occasions are unavailable because the bounded output limit was reached');
    this.name = 'PostgresProfileOccasionLimitError';
  }
}

export function createPostgresProfilePeopleReadRepository(
  db: Db,
  agentId: string,
  now: () => Date = () => new Date(),
  opts: { browseOnly?: boolean } = {},
): ProfilePeopleReadRepository {
  const snapshot = (
    contact: ProfileContact,
    native: Record<string, unknown>,
  ): ProfileContactSnapshot => ({
    ...contact,
    identityRevision: profileContactIdentityRevision({
      driver: 'postgres',
      ownerId: agentId,
      native,
    }),
  });
  return {
    kind: 'profile-people-read-repository',

    async getOwnerContact(): Promise<ProfileContactSnapshot | null> {
      const [selected] = await db
        .select({ contact: contacts, native: sql<Record<string, unknown>>`to_jsonb(${contacts})` })
        .from(contacts)
        .where(eq(contacts.trust, 'owner'))
        .limit(1);
      return selected ? snapshot(selected.contact, selected.native) : null;
    },

    async getContact(id) {
      const [selected] = await db
        .select({ contact: contacts, native: sql<Record<string, unknown>>`to_jsonb(${contacts})` })
        .from(contacts)
        .where(eq(contacts.id, id))
        .limit(1);
      return selected ? snapshot(selected.contact, selected.native) : null;
    },

    async listContacts() {
      const selected = await db
        .select({ contact: contacts, native: sql<Record<string, unknown>>`to_jsonb(${contacts})` })
        .from(contacts)
        .orderBy(asc(contacts.name), asc(contacts.id));
      return selected.map(({ contact, native }) => snapshot(contact, native));
    },

    async getFacts(contactId, limit) {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid profile fact limit');
      const active = and(
        eq(memories.agentId, agentId),
        eq(memories.subjectContactId, contactId),
        eq(memories.category, 'knowledge'),
        eq(memories.quarantined, false),
        or(isNull(memories.expiresAt), gt(memories.expiresAt, now())),
      );
      const [rows, [total]] = await Promise.all([
        db
          .select()
          .from(memories)
          .where(active)
          .orderBy(
            desc(memories.pinned),
            desc(memories.importance),
            desc(memories.confidence),
            desc(memories.createdAt),
            desc(memories.id),
          )
          .limit(limit),
        db.select({ value: count() }).from(memories).where(active),
      ]);
      return { rows, total: Number(total?.value ?? 0) };
    },

    async getOwnerCard() {
      // The legacy singleton is unattributable once more than one agent exists.
      const configured = await db.select({ id: agents.id }).from(agents).limit(2);
      if (configured.length !== 1 || configured[0]?.id !== agentId) return null;
      const [row] = await db
        .select({ content: ownerCard.content, compiledAt: ownerCard.compiledAt })
        .from(ownerCard)
        .where(eq(ownerCard.id, 1))
        .limit(1);
      return row ?? null;
    },

    async listOccasions(contactId) {
      const query = db
        .select()
        .from(occasions)
        .where(and(eq(occasions.agentId, agentId), eq(occasions.contactId, contactId)))
        .orderBy(asc(occasions.month), asc(occasions.day), asc(occasions.id));
      if (!opts.browseOnly) return query;
      const rows = await query.limit(PROFILE_BROWSE_OCCASION_MAX_ROWS + 1);
      if (rows.length > PROFILE_BROWSE_OCCASION_MAX_ROWS) {
        throw new PostgresProfileOccasionLimitError();
      }
      return rows;
    },
  };
}
