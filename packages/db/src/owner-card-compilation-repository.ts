import {
  MAX_OWNER_CARD_CONTACT_SCAN,
  MAX_OWNER_CARD_MEMORY_SCAN,
  type OwnerCardCompilationRepository,
} from '@assistant/persistence';
import { and, eq, gt, isNull, ne, notExists, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  assertPostgresPrivacyObservationFence,
  lockPostgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import { contacts, memories, memoryTombstones, ownerCard } from './schema.js';

/** Shared by card compilation and supersession so an older snapshot cannot publish last. */
export const OWNER_CARD_ADVISORY_LOCK = sql`pg_advisory_xact_lock(hashtext('assistant-owner-card'))`;

export function createPostgresOwnerCardCompilationRepository(
  db: Db,
): OwnerCardCompilationRepository {
  return {
    kind: 'owner-card-compilation-repository',
    async compile(input) {
      if (!input.agentId) throw new Error('Owner card compilation requires an agent ID');
      return db.transaction(async (tx) => {
        await tx.execute(sql`select ${OWNER_CARD_ADVISORY_LOCK}`);
        const txDb = tx as unknown as Db;
        const observed = await lockPostgresPrivacyObservationFence(txDb, input.agentId);
        const [owner] = await tx
          .select()
          .from(contacts)
          .where(eq(contacts.trust, 'owner'))
          .limit(1);
        const ownerFacts = owner
          ? await tx
              .select({
                content: memories.content,
                domain: memories.domain,
                importance: memories.importance,
                confidence: memories.confidence,
                pinned: memories.pinned,
                validFrom: memories.validFrom,
                validUntil: memories.validUntil,
              })
              .from(memories)
              .where(
                and(
                  eq(memories.agentId, input.agentId),
                  eq(memories.subjectContactId, owner.id),
                  eq(memories.category, 'knowledge'),
                  eq(memories.quarantined, false),
                  isNull(memories.supersededById),
                  notExists(
                    tx
                      .select({ id: memoryTombstones.id })
                      .from(memoryTombstones)
                      .where(eq(memoryTombstones.contentHash, memories.contentHash)),
                  ),
                  or(isNull(memories.expiresAt), gt(memories.expiresAt, input.now)),
                ),
              )
              .orderBy(sql`${memories.importance} desc`, sql`${memories.confidence} desc`)
              .limit(MAX_OWNER_CARD_MEMORY_SCAN + 1)
          : [];
        if (ownerFacts.length > MAX_OWNER_CARD_MEMORY_SCAN)
          throw new Error(`Owner card memory scan exceeded ${MAX_OWNER_CARD_MEMORY_SCAN}`);

        const peopleRows = await tx
          .select({
            id: contacts.id,
            name: contacts.name,
            relationship: contacts.relationship,
            n: sql<number>`count(${memories.id})`,
          })
          .from(contacts)
          .innerJoin(
            memories,
            and(
              eq(memories.subjectContactId, contacts.id),
              eq(memories.agentId, input.agentId),
              eq(memories.quarantined, false),
              isNull(memories.supersededById),
              notExists(
                tx
                  .select({ id: memoryTombstones.id })
                  .from(memoryTombstones)
                  .where(eq(memoryTombstones.contentHash, memories.contentHash)),
              ),
              or(isNull(memories.expiresAt), gt(memories.expiresAt, input.now)),
            ),
          )
          .where(ne(contacts.trust, 'owner'))
          .groupBy(contacts.id, contacts.name, contacts.relationship)
          .orderBy(sql`count(${memories.id}) desc`)
          .limit(MAX_OWNER_CARD_CONTACT_SCAN + 1);
        if (peopleRows.length > MAX_OWNER_CARD_CONTACT_SCAN)
          throw new Error(`Owner card contact scan exceeded ${MAX_OWNER_CARD_CONTACT_SCAN}`);
        const pinned = await tx
          .select({ contactId: memories.subjectContactId, content: memories.content })
          .from(memories)
          .innerJoin(contacts, eq(memories.subjectContactId, contacts.id))
          .where(
            and(
              eq(memories.agentId, input.agentId),
              ne(contacts.trust, 'owner'),
              eq(memories.pinned, true),
              eq(memories.category, 'knowledge'),
              eq(memories.quarantined, false),
              isNull(memories.supersededById),
              notExists(
                tx
                  .select({ id: memoryTombstones.id })
                  .from(memoryTombstones)
                  .where(eq(memoryTombstones.contentHash, memories.contentHash)),
              ),
              or(isNull(memories.expiresAt), gt(memories.expiresAt, input.now)),
            ),
          )
          .orderBy(sql`${memories.importance} desc`, sql`${memories.confidence} desc`)
          .limit(MAX_OWNER_CARD_MEMORY_SCAN + 1);
        if (pinned.length > MAX_OWNER_CARD_MEMORY_SCAN)
          throw new Error(`Owner card pinned memory scan exceeded ${MAX_OWNER_CARD_MEMORY_SCAN}`);
        const pinnedByContact = new Map<string, string[]>();
        for (const fact of pinned) {
          if (!fact.contactId) continue;
          const values = pinnedByContact.get(fact.contactId) ?? [];
          values.push(fact.content);
          pinnedByContact.set(fact.contactId, values);
        }
        const content = input.render({
          ownerFacts,
          people: peopleRows.map((person) => ({
            id: person.id,
            name: person.name,
            relationship: person.relationship,
            factCount: Number(person.n),
            pinnedFacts: pinnedByContact.get(person.id) ?? [],
          })),
        });
        await assertPostgresPrivacyObservationFence(txDb, input.agentId, observed);
        await tx
          .insert(ownerCard)
          .values({ id: 1, content, compiledAt: input.now })
          .onConflictDoUpdate({ target: ownerCard.id, set: { content, compiledAt: input.now } });
        return content;
      });
    },
  };
}
