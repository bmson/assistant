import {
  type ProfileOverviewRepository,
  profileContactIdentityRevision,
} from '@assistant/persistence';
import { and, asc, count, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { createPostgresProfileMemoryHubRepository } from './profile-memory-hub-repository.js';
import { createPostgresProfileVoiceOverviewRepository } from './profile-overview-repository.js';
import { agents, contacts, memories, ownerCard } from './schema.js';

const PROFILE_CONTACT_LIMIT = 500;
const PROFILE_FACT_LIMIT = 250;

/**
 * Complete mobile Profile read. The owner-fact and people lists are bounded
 * views: a real owner has thousands of facts, so the read returns the
 * highest-priority slice instead of failing (the mobile workspace endpoint
 * serves this, and a throw here is a 500 for Memory and All chats). Exact
 * totals come from the memory hub counts, not from these lists.
 */
export function createPostgresProfileOverviewRepository(db: Db): ProfileOverviewRepository {
  return {
    kind: 'profile-overview-repository',
    async load() {
      const [hub, voice, configured, peopleRows, ownerRows, [card]] = await Promise.all([
        createPostgresProfileMemoryHubRepository(db).load(),
        createPostgresProfileVoiceOverviewRepository(db).load(),
        db.select({ id: agents.id }).from(agents).limit(2),
        db
          .select({
            contact: contacts,
            native: sql<Record<string, unknown>>`to_jsonb(${contacts})`,
          })
          .from(contacts)
          .where(ne(contacts.trust, 'owner'))
          .orderBy(asc(contacts.name), asc(contacts.id))
          .limit(PROFILE_CONTACT_LIMIT),
        db
          .select({
            contact: contacts,
            native: sql<Record<string, unknown>>`to_jsonb(${contacts})`,
          })
          .from(contacts)
          .where(eq(contacts.trust, 'owner'))
          .limit(1),
        db.select().from(ownerCard).where(eq(ownerCard.id, 1)).limit(1),
      ]);
      if (configured.length !== 1 || !configured[0])
        throw new Error('Profile overview requires exactly one configured agent');
      const agentId = configured[0].id;
      if (hub.owner && !ownerRows[0])
        throw new Error('Profile owner identity revision is unavailable');
      // The hub reads the owner directly, so a long people list cannot push it off the page.
      const ownerRow = ownerRows[0];
      const owner = ownerRow
        ? {
            id: ownerRow.contact.id,
            name: ownerRow.contact.name,
            aliases: ownerRow.contact.aliases,
            relationship: ownerRow.contact.relationship,
            trust: ownerRow.contact.trust,
            identityRevision: profileContactIdentityRevision({
              driver: 'postgres',
              ownerId: agentId,
              native: ownerRow.native,
            }),
          }
        : undefined;
      const active = and(
        eq(memories.agentId, agentId),
        eq(memories.category, 'knowledge'),
        eq(memories.quarantined, false),
        or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
      );
      const people = peopleRows.map(({ contact, native }) => ({
        id: contact.id,
        name: contact.name,
        aliases: contact.aliases,
        relationship: contact.relationship,
        trust: contact.trust,
        identityRevision: profileContactIdentityRevision({
          driver: 'postgres',
          ownerId: agentId,
          native,
        }),
      }));
      const contactIds = people.map((contact) => contact.id);
      const [ownerFacts, factCountRows] = await Promise.all([
        owner
          ? db
              .select()
              .from(memories)
              .where(and(active, eq(memories.subjectContactId, owner.id)))
              .orderBy(
                desc(memories.pinned),
                desc(memories.importance),
                desc(memories.confidence),
                asc(memories.id),
              )
              .limit(PROFILE_FACT_LIMIT)
          : Promise.resolve([]),
        contactIds.length > 0
          ? db
              .select({ contactId: memories.subjectContactId, value: count() })
              .from(memories)
              .where(and(active, inArray(memories.subjectContactId, contactIds)))
              .groupBy(memories.subjectContactId)
          : Promise.resolve([]),
      ]);
      const factCounts = new Map(
        factCountRows.map((row) => [row.contactId ?? '', Number(row.value)]),
      );
      return {
        ...(owner ? { owner } : {}),
        people: people.map((contact) => ({ contact, factCount: factCounts.get(contact.id) ?? 0 })),
        ownerFacts,
        quarantined: hub.quarantined,
        card: card ? { content: card.content, compiledAt: card.compiledAt } : null,
        voiceStats: voice.voiceStats,
        voiceProfile: voice.voiceProfile,
        voiceImports: voice.voiceImports,
        memoryHealth: hub.memoryHealth,
        latestOrganizer: hub.latestOrganizer,
      };
    },
  };
}
