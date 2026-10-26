import {
  normalizeContactAliases,
  normalizeContactName,
  type OwnerEditorApply,
  type OwnerEditorClaim,
  type OwnerEditorReply,
  ownerEditorCommitRevision,
  ownerEditorSnapshotRevision,
} from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { assertPostgresInstallationOwner } from './installation-owner.js';
import {
  beginPostgresOwnerEditorWrite,
  completePostgresOwnerEditorWrite,
} from './owner-editor-repository.js';
import { agents, contacts, knowledgeGraphEntities } from './schema.js';

type PersonRequest = Extract<
  OwnerEditorApply,
  { command: 'create_person' | 'update_person_identity' }
>;
export interface PreparedOwnerEditorPerson {
  request: PersonRequest;
  name: string;
  aliases: string[];
}

/** Native timestamp text is part of CAS; the JS Date projection is insufficient. */
export async function postgresOwnerEditorContact(
  db: Pick<Db, 'select'>,
  ownerId: string,
  contactId: string,
  lock = false,
) {
  await assertPostgresInstallationOwner(db as Db, ownerId);
  const query = db
    .select({ contact: contacts, native: sql<Record<string, unknown>>`to_jsonb(${contacts})` })
    .from(contacts)
    .where(eq(contacts.id, contactId));
  const [row] = await (lock ? query.for('update') : query).limit(1);
  if (!row) return null;
  return {
    ...row.contact,
    revision: ownerEditorSnapshotRevision({ driver: 'postgres', ownerId, native: row.native }),
  };
}

/** Named-person primary change and its receipt share the actual leased transaction. */
export function commitPostgresOwnerEditorPerson(
  db: Db,
  claim: OwnerEditorClaim,
  prepared: PreparedOwnerEditorPerson,
  now: Date,
): Promise<OwnerEditorReply> {
  return db.transaction(async (tx) => {
    const admitted = await beginPostgresOwnerEditorWrite(tx, claim, now);
    if (admitted.kind === 'reply') return admitted.reply;
    const name = normalizeContactName(prepared.name);
    const request = prepared.request;
    if (
      claim.scope.command !== request.command ||
      claim.scope.operationId !== request.operationId ||
      (request.command === 'update_person_identity'
        ? claim.scope.targetId !== request.contactId
        : claim.scope.targetId !== null)
    )
      throw new Error('Prepared person operation does not match its claim');
    const current =
      request.command === 'update_person_identity'
        ? await postgresOwnerEditorContact(tx, claim.scope.ownerId, request.contactId, true)
        : null;
    if (
      request.command === 'update_person_identity' &&
      (!current ||
        current.trust === 'owner' ||
        current.revision !== request.expectedContactRevision)
    )
      return completePostgresOwnerEditorWrite(
        tx,
        admitted,
        { outcome: 'conflict', reason: 'contact_changed' },
        now,
      );
    const duplicates = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(sql`lower(${contacts.name}) = ${name.toLocaleLowerCase()}`)
      .limit(2);
    if (duplicates.some((row) => row.id !== current?.id))
      return completePostgresOwnerEditorWrite(
        tx,
        admitted,
        { outcome: 'conflict', reason: 'duplicate_contact' },
        now,
      );
    const aliases = normalizeContactAliases(
      [
        ...prepared.aliases,
        ...(current && current.name.toLocaleLowerCase() !== name.toLocaleLowerCase()
          ? [current.name]
          : []),
      ],
      name,
    );
    if (
      current &&
      current.name === name &&
      JSON.stringify(current.aliases) === JSON.stringify(aliases)
    ) {
      if (current.identityAuthority !== 'owner')
        await tx
          .update(contacts)
          .set({ identityAuthority: 'owner', updatedAt: sql`now()` })
          .where(eq(contacts.id, current.id));
      const ids = { contactId: current.id };
      return completePostgresOwnerEditorWrite(
        tx,
        admitted,
        { outcome: 'unchanged', ids, revision: ownerEditorCommitRevision(claim, ids) },
        now,
      );
    }
    const [saved] = current
      ? await tx
          .update(contacts)
          .set({ name, aliases, identityAuthority: 'owner', updatedAt: sql`now()` })
          .where(eq(contacts.id, current.id))
          .returning({ id: contacts.id })
      : await tx
          .insert(contacts)
          .values({
            name,
            aliases,
            relationship: '',
            trust: 'known',
            identityAuthority: 'owner',
          })
          .returning({ id: contacts.id });
    if (!saved) throw new Error('Person write did not return its durable identity');
    const ids = { contactId: saved.id };
    return completePostgresOwnerEditorWrite(
      tx,
      admitted,
      {
        outcome: 'saved',
        ids,
        revision: ownerEditorCommitRevision(claim, ids),
        refreshPending: true,
      },
      now,
    );
  });
}

export async function postgresOwnerEditorContext(db: Pick<Db, 'select'>, ownerId: string) {
  await assertPostgresInstallationOwner(db as Db, ownerId);
  const [agent] = await db.select().from(agents).where(eq(agents.id, ownerId)).limit(1);
  if (!agent) throw new Error('Configured owner disappeared');
  return { agentId: ownerId, timeZone: agent.timezone || 'UTC', locale: agent.locale || 'en' };
}
export async function postgresOwnerEditorEntity(
  db: Pick<Db, 'select'>,
  ownerId: string,
  id: string,
) {
  const [entity] = await db
    .select()
    .from(knowledgeGraphEntities)
    .where(and(eq(knowledgeGraphEntities.agentId, ownerId), eq(knowledgeGraphEntities.id, id)))
    .limit(1);
  if (!entity || entity.kind !== 'person') return null;
  return {
    id: entity.id,
    label: entity.label,
    kind: 'person' as const,
    canonicalKey: entity.canonicalKey,
    contactId: entity.contactId,
    authoritativeLabel: true,
  };
}
