import { normalizeContactAliases, normalizeContactName } from '@assistant/persistence';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { type ContactRow, contacts, memories, memoryTombstones, occasions } from './schema.js';

export { normalizeContactAliases, normalizeContactName } from '@assistant/persistence';

/** Subjects that are the assistant itself — facts about it never become contacts. */
const ASSISTANT_ALIASES = new Set(['assistant', 'ai bot', 'b bot', 'the assistant', 'bot']);

/**
 * A short name may prefix a longer full name at a word boundary. Shared with the
 * knowledge graph, which resolves person nodes against these same contacts and
 * needs to agree with contact dedup about when "Anna" is "Anna Jónsdóttir".
 */
export function namePrefixMatch(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 3 && (longer === shorter || longer.startsWith(`${shorter} `));
}

/** Update canonical name and aliases while remembering the old name after a rename. */
export async function updateContactIdentity(
  db: Db,
  input: { contactId: string; name: string; aliases?: string[] },
): Promise<{ name: string; aliases: string[] }> {
  const name = normalizeContactName(input.name);
  return db.transaction(async (tx) => {
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(eq(contacts.id, input.contactId))
      .for('update');
    if (!contact || contact.trust === 'owner') {
      throw new Error('Person not found or cannot be renamed.');
    }
    const renamed = contact.name.toLocaleLowerCase() !== name.toLocaleLowerCase();
    const aliases = normalizeContactAliases(
      [...(input.aliases ?? contact.aliases), ...(renamed ? [contact.name] : [])],
      name,
    );
    const [updated] = await tx
      .update(contacts)
      .set({ name, aliases, updatedAt: sql`now()` })
      .where(and(eq(contacts.id, input.contactId), ne(contacts.trust, 'owner')))
      .returning({ name: contacts.name, aliases: contacts.aliases });
    if (!updated) throw new Error('Person not found or cannot be renamed.');
    return updated;
  });
}

/** Rename a non-owner person. The owner identity is managed separately. */
export async function renameContact(
  db: Db,
  input: { contactId: string; name: string },
): Promise<{ name: string }> {
  const renamed = await updateContactIdentity(db, input);
  return { name: renamed.name };
}

export interface DuplicateContactSuggestion {
  contactId: string;
  targetId: string;
  reason: 'matching name or alias' | 'same email' | 'same phone';
}

/** Conservative, advisory-only duplicate hints; merges still require owner confirmation. */
export function findDuplicateContactSuggestions(
  rows: Array<Pick<ContactRow, 'id' | 'name' | 'aliases' | 'emails' | 'phones' | 'trust'>>,
): DuplicateContactSuggestion[] {
  const people = rows.filter((row) => row.trust !== 'owner');
  const suggestions: DuplicateContactSuggestion[] = [];
  for (let index = 0; index < people.length; index += 1) {
    const source = people[index] as (typeof people)[number];
    for (let targetIndex = 0; targetIndex < index; targetIndex += 1) {
      const target = people[targetIndex] as (typeof people)[number];
      const sourceEmails = new Set(source.emails.map((value) => value.trim().toLocaleLowerCase()));
      const sourcePhones = new Set(source.phones.map((value) => value.replace(/\D/g, '')));
      const sameEmail = target.emails.some(
        (value) => value.trim() && sourceEmails.has(value.trim().toLocaleLowerCase()),
      );
      const samePhone = target.phones.some(
        (value) => value.replace(/\D/g, '') && sourcePhones.has(value.replace(/\D/g, '')),
      );
      const sourceNames = [source.name, ...source.aliases].map((value) =>
        value.toLocaleLowerCase(),
      );
      const targetNames = [target.name, ...target.aliases].map((value) =>
        value.toLocaleLowerCase(),
      );
      const sameName = sourceNames.some((left) =>
        targetNames.some((right) => namePrefixMatch(left, right)),
      );
      const reason = sameEmail
        ? 'same email'
        : samePhone
          ? 'same phone'
          : sameName
            ? 'matching name or alias'
            : undefined;
      if (reason) {
        suggestions.push({ contactId: source.id, targetId: target.id, reason });
        break;
      }
    }
  }
  return suggestions;
}

/**
 * Permanently remove a non-owner person and every fact about them. Facts are
 * tombstoned first so memory extraction cannot recreate deleted profile data.
 */
export async function deleteContact(
  db: Db,
  contactId: string,
): Promise<{ deletedMemories: number; deletedOccasions: number }> {
  return db.transaction(async (tx) => {
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .for('update');
    if (!contact) throw new Error('Person not found.');
    if (contact.trust === 'owner') throw new Error('The owner profile cannot be deleted.');

    const facts = await tx
      .select({ id: memories.id, contentHash: memories.contentHash })
      .from(memories)
      .where(eq(memories.subjectContactId, contactId));
    if (facts.length > 0) {
      await tx
        .insert(memoryTombstones)
        .values(
          facts.map((fact) => ({
            contentHash: fact.contentHash,
            reason: 'owner_delete_contact',
          })),
        )
        .onConflictDoNothing({ target: memoryTombstones.contentHash });
      const factIds = facts.map((fact) => fact.id);
      await tx
        .update(memories)
        .set({ supersededById: null })
        .where(inArray(memories.supersededById, factIds));
      await tx.delete(memories).where(eq(memories.subjectContactId, contactId));
    }

    // occasions.contact_id is NOT NULL with no cascade, so a birthday — including
    // one still quarantined awaiting review — would block the delete outright.
    // The person and their facts go for good, so their dates go with them.
    const removedOccasions = await tx
      .delete(occasions)
      .where(eq(occasions.contactId, contactId))
      .returning({ id: occasions.id });

    const [deleted] = await tx
      .delete(contacts)
      .where(and(eq(contacts.id, contactId), ne(contacts.trust, 'owner')))
      .returning({ id: contacts.id });
    if (!deleted) throw new Error('Person could not be deleted.');
    return { deletedMemories: facts.length, deletedOccasions: removedOccasions.length };
  });
}

/**
 * Entity resolution for memory attribution: "who is this fact about?"
 * 'owner' (any casing) or any name-prefix variant of the owner's name → the
 * owner contact; other names match contacts case-insensitively, treating
 * "Anna" and "Anna Jónsdóttir" as the same person (the fuller name wins and
 * is written back). New people become trust:'unknown' contacts. Subjects
 * that are the assistant itself resolve to null — the assistant is not a
 * contact. Pure data access — lives in @assistant/db so both core and tools
 * can use it without a package cycle.
 */
export async function resolveSubjectContact(
  db: Db,
  input: { subject: string; relationship?: string },
): Promise<{ contactId: string; created: boolean } | null> {
  const name = input.subject.trim();
  if (!name) return null;
  const lower = name.toLowerCase();
  if (ASSISTANT_ALIASES.has(lower)) return null;

  const candidates = await db.select().from(contacts);
  const exact = candidates.filter((contact) =>
    [contact.name, ...contact.aliases].some(
      (candidate) => candidate.trim().toLocaleLowerCase() === lower,
    ),
  );
  if (lower !== 'owner') {
    if (exact.length > 1) return null;
    if (exact[0]) return { contactId: exact[0].id, created: false };
    const prefixes = candidates.filter((contact) =>
      [contact.name, ...contact.aliases].some((candidate) =>
        namePrefixMatch(lower, candidate.toLocaleLowerCase()),
      ),
    );
    if (prefixes.length > 1) return null;
  }
  const owner = candidates.find((contact) => contact.trust === 'owner');
  const ownerMatch = owner
    ? [owner.name, ...owner.aliases].find((candidate) =>
        namePrefixMatch(lower, candidate.toLocaleLowerCase()),
      )
    : undefined;
  if (lower === 'owner' || ownerMatch) {
    if (!owner) return null;
    // Adopt the fuller name when an existing short name gains a surname.
    if (name.length > owner.name.length && ownerMatch === owner.name && lower !== 'owner') {
      await db
        .update(contacts)
        .set({
          name,
          aliases: normalizeContactAliases([...owner.aliases, owner.name], name),
          updatedAt: sql`now()`,
        })
        .where(eq(contacts.id, owner.id));
    }
    return { contactId: owner.id, created: false };
  }

  const match = candidates
    .filter((contact) => contact.trust !== 'owner')
    .map((contact) => ({
      contact,
      matchedName: [contact.name, ...contact.aliases].find((candidate) =>
        namePrefixMatch(lower, candidate.toLocaleLowerCase()),
      ),
    }))
    .find((candidate) => candidate.matchedName);
  if (match) {
    if (name.length > match.contact.name.length && match.matchedName === match.contact.name) {
      await updateContactIdentity(db, { contactId: match.contact.id, name });
    }
    return { contactId: match.contact.id, created: false };
  }

  const [created] = await db
    .insert(contacts)
    .values({ name, relationship: input.relationship?.trim() ?? '', trust: 'unknown' })
    .returning();
  return created ? { contactId: created.id, created: true } : null;
}

/**
 * Look up saved contacts by name for outbound addressing (contacts.lookup).
 * Word-boundary prefix match against each contact's name and aliases, so
 * "Anna" finds "Anna Jónsdóttir". Read-only — never creates a contact (unlike
 * resolveSubjectContact). An empty result means the assistant does NOT know
 * this person's address and must ask rather than guess.
 */
export async function findContactsByName(db: Db, query: string): Promise<ContactRow[]> {
  const lower = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (lower.length < 2) return [];
  const rows = await db.select().from(contacts);
  return rows.filter((contact) =>
    [contact.name, ...(contact.aliases ?? [])].some((candidate) =>
      namePrefixMatch(lower, candidate.toLocaleLowerCase()),
    ),
  );
}

/** Identity of an occasion under the (agent, contact, kind, month, day) dedup index. */
function occasionDedupKey(row: { agentId: string; kind: string; month: number; day: number }) {
  return [row.agentId, row.kind, row.month, row.day].join('|');
}

/**
 * Merge one contact into another: memories and occasions move to the target,
 * emails/phones union, the fuller relationship survives, the source row is
 * deleted. One transaction — a half-merged pair (facts moved, duplicate still
 * present) is worse than no merge at all.
 */
export async function mergeContacts(
  db: Db,
  input: { sourceId: string; targetId: string },
): Promise<{ movedMemories: number; movedOccasions: number }> {
  if (input.sourceId === input.targetId) throw new Error('cannot merge a contact into itself');
  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(contacts).where(eq(contacts.id, input.sourceId));
    const [target] = await tx.select().from(contacts).where(eq(contacts.id, input.targetId));
    if (!source || !target) throw new Error('merge: contact not found');
    if (source.trust === 'owner') throw new Error('cannot merge the owner away');

    const moved = await tx
      .update(memories)
      .set({ subjectContactId: target.id })
      .where(eq(memories.subjectContactId, source.id))
      .returning({ id: memories.id });

    // occasions.contact_id is NOT NULL with no cascade, so the source's dates
    // must be repointed before its row can go. A date both people already hold
    // would collide on occasions_dedup_idx — keep the target's row and drop the
    // source duplicate, the same "same date, one row" rule saveOccasion upserts by.
    const sourceOccasions = await tx
      .select({
        id: occasions.id,
        agentId: occasions.agentId,
        kind: occasions.kind,
        month: occasions.month,
        day: occasions.day,
      })
      .from(occasions)
      .where(eq(occasions.contactId, source.id));
    let movedOccasions = 0;
    if (sourceOccasions.length > 0) {
      const targetOccasions = await tx
        .select({
          agentId: occasions.agentId,
          kind: occasions.kind,
          month: occasions.month,
          day: occasions.day,
        })
        .from(occasions)
        .where(eq(occasions.contactId, target.id));
      const taken = new Set(targetOccasions.map(occasionDedupKey));
      const duplicateIds = sourceOccasions
        .filter((row) => taken.has(occasionDedupKey(row)))
        .map((row) => row.id);
      if (duplicateIds.length > 0) {
        await tx.delete(occasions).where(inArray(occasions.id, duplicateIds));
      }
      const repointed = await tx
        .update(occasions)
        .set({ contactId: target.id, updatedAt: sql`now()` })
        .where(eq(occasions.contactId, source.id))
        .returning({ id: occasions.id });
      movedOccasions = repointed.length;
    }

    await tx
      .update(contacts)
      .set({
        aliases: normalizeContactAliases(
          [...target.aliases, ...source.aliases, source.name],
          target.name,
        ),
        emails: [...new Set([...target.emails, ...source.emails])],
        phones: [...new Set([...target.phones, ...source.phones])],
        relationship: target.relationship || source.relationship,
        notes: [target.notes, source.notes].filter(Boolean).join('\n'),
        updatedAt: sql`now()`,
      })
      .where(eq(contacts.id, target.id));
    await tx.delete(contacts).where(eq(contacts.id, source.id));
    return { movedMemories: moved.length, movedOccasions };
  });
}

/** True when this content hash was forgotten by the owner — it must never be re-saved. */
export async function isTombstoned(db: Db, contentHash: string): Promise<boolean> {
  const [row] = await db
    .select({ id: memoryTombstones.id })
    .from(memoryTombstones)
    .where(eq(memoryTombstones.contentHash, contentHash))
    .limit(1);
  return Boolean(row);
}

/** Record a forgotten hash. Idempotent. */
export async function addTombstone(db: Db, contentHash: string, reason = 'owner_forget') {
  await db
    .insert(memoryTombstones)
    .values({ contentHash, reason })
    .onConflictDoNothing({ target: memoryTombstones.contentHash });
}
