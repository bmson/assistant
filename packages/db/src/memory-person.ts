import {
  attributeMemoryPerson,
  type GroundedPersonEvidence,
  MAX_RECONCILED_PERSON_MEMORIES,
  normalizeMemoryRelationship,
} from '@assistant/persistence';
import { arrayContains, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  agents,
  contacts,
  knowledgeGraphEntities,
  knowledgeGraphSources,
  memories,
  occasions,
  ownerCard,
  signals,
} from './schema.js';

/** Called inside the memory writer transaction, after its privacy fence and duplicate check. */
export async function resolvePostgresMemoryPerson(
  tx: Db,
  input: {
    agentId: string;
    subject: string;
    content: string;
    evidence?: GroundedPersonEvidence | null;
    knownContactId?: string | null;
    relationship?: string;
    pendingContactIds?: ReadonlySet<string>;
  },
): Promise<{ contactId: string; created: boolean } | null> {
  if (!input.subject || input.evidence === null) return null;
  if (input.evidence || input.subject.trim().toLowerCase() !== 'owner') {
    const owners = await tx.select({ id: agents.id }).from(agents).limit(2);
    if (owners.length !== 1 || owners[0]?.id !== input.agentId) return null;
    // A contact rename, new contact, or address change can invalidate a
    // previously unique identity. Hold the predicate stable until commit.
    await tx.execute(sql`lock table ${contacts} in exclusive mode`);
  }
  const decision = attributeMemoryPerson(await tx.select().from(contacts), input);
  if (decision.kind === 'unattributed') return null;
  if (decision.kind === 'create') {
    const [row] = await tx
      .insert(contacts)
      .values({
        name: decision.name,
        relationship: normalizeMemoryRelationship(
          input.evidence?.relationship ?? input.relationship,
        ),
        trust: 'unknown',
        identityAuthority: 'inferred',
      })
      .returning({ id: contacts.id });
    return row ? { contactId: row.id, created: true } : null;
  }
  const result = { contactId: decision.contactId, created: false };
  const update = decision.update;
  if (!update) return result;
  const { duplicateId, ...changes } = update;
  if (duplicateId) {
    if (input.pendingContactIds?.has(duplicateId)) return result;
    // Keep linked graph and occasion records intact. The foreign keys (and
    // their key-share locks) prevent dangling references during deletion.
    const [source] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.id, duplicateId))
      .for('update');
    if (!source) return result;
    const [linked] = await tx
      .select({ id: knowledgeGraphEntities.id })
      .from(knowledgeGraphEntities)
      .where(eq(knowledgeGraphEntities.contactId, duplicateId))
      .limit(1);
    const [graphSource] = await tx
      .select({ id: knowledgeGraphSources.memoryId })
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.subjectContactId, duplicateId))
      .limit(1);
    const [occasion] = await tx
      .select({ id: occasions.id })
      .from(occasions)
      .where(eq(occasions.contactId, duplicateId))
      .limit(1);
    // Historical bill and payment subjects are durable replay identities.
    const [signal] = await tx
      .select({ id: signals.id })
      .from(signals)
      .where(arrayContains(signals.subjectPersonIds, [duplicateId]))
      .limit(1);
    const attached = await tx
      .select({ agentId: memories.agentId, ownerConfirmed: memories.ownerConfirmed })
      .from(memories)
      .where(eq(memories.subjectContactId, duplicateId))
      .limit(MAX_RECONCILED_PERSON_MEMORIES + 1)
      .for('update');
    if (
      linked ||
      graphSource ||
      occasion ||
      signal ||
      attached.length > MAX_RECONCILED_PERSON_MEMORIES ||
      attached.some((row) => row.agentId !== input.agentId || row.ownerConfirmed)
    )
      return result;

    if (attached.length) {
      await tx
        .update(memories)
        .set({ subjectContactId: decision.contactId })
        .where(eq(memories.subjectContactId, duplicateId));
      await tx.update(ownerCard).set({ content: '', compiledAt: sql`now()` });
    }
    await tx.delete(contacts).where(eq(contacts.id, duplicateId));
  }
  await tx
    .update(contacts)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(eq(contacts.id, decision.contactId));
  return result;
}
