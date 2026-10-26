import type { OwnerEditorPeopleReadSnapshot } from '@assistant/persistence';
import {
  canonicalizeKnowledgeAssertionDirection,
  knowledgeAssertionId,
  knowledgeAssertionSemanticKey,
  type OwnerEditorFamilyFields,
  ownerEditorSnapshotRevision,
} from '@assistant/persistence';
import { ownerFamilyEditorProjection } from '@assistant/persistence/owner-family-scope';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { assertPostgresInstallationOwner } from './installation-owner.js';
import { postgresOwnerEditorContact } from './owner-editor-people.js';
import {
  contacts,
  knowledgeGraphAssertionEvidence,
  knowledgeGraphAssertions,
  knowledgeGraphEntities,
  knowledgeGraphEntityAliases,
  knowledgeGraphRelations,
  memories,
} from './schema.js';

type Read = Pick<Db, 'select'>;
const graphTargetColumns = {
  relation: knowledgeGraphRelations,
  source: memories,
  assertion: knowledgeGraphAssertions,
  relationNative: sql<Record<string, unknown>>`to_jsonb(${knowledgeGraphRelations})`,
  sourceNative: sql<Record<string, unknown>>`to_jsonb(${memories})`,
  assertionNative: sql<Record<string, unknown>>`to_jsonb(${knowledgeGraphAssertions})`,
  sourcePrecisionLossless: sql<boolean>`(${memories.validFrom} IS NULL OR date_trunc('second', ${memories.validFrom}) = ${memories.validFrom}) AND (${memories.validUntil} IS NULL OR date_trunc('second', ${memories.validUntil}) = ${memories.validUntil})`,
};

type Native<T> = { row: T; native: Record<string, unknown> };
type GraphTarget = {
  relation: typeof knowledgeGraphRelations.$inferSelect;
  source: typeof memories.$inferSelect;
  assertion: typeof knowledgeGraphAssertions.$inferSelect;
  relationNative: Record<string, unknown>;
  sourceNative: Record<string, unknown>;
  assertionNative: Record<string, unknown>;
  sourcePrecisionLossless: boolean;
};
function postgresGraphScope(
  ownerId: string,
  target: GraphTarget,
  evidenceRows: Native<typeof knowledgeGraphAssertionEvidence.$inferSelect>[],
  sourceRows: Native<typeof knowledgeGraphRelations.$inferSelect>[],
  canonicalRows: Native<typeof knowledgeGraphRelations.$inferSelect>[],
) {
  const evidence = evidenceRows.map((item) => item.row);
  const sourceRelations = sourceRows.map((item) => item.row);
  const canonicalRelations = canonicalRows.map((item) => item.row);
  const native = {
    target: [target.relationNative, target.sourceNative, target.assertionNative],
    evidence: evidenceRows.map((item) => item.native),
    sourceRelations: sourceRows.map((item) => item.native),
    canonicalRelations: canonicalRows.map((item) => item.native),
  };
  return {
    ownerId,
    relation: target.relation,
    source: target.source,
    assertion: target.assertion,
    evidence,
    sourceRelations,
    canonicalRelations,
    sourcePrecisionLossless: target.sourcePrecisionLossless,
    native,
    revision: ownerEditorSnapshotRevision({ driver: 'postgres', ownerId, native }),
  };
}

/** Raw sentinel rows are retained; malformed/sibling evidence is never skipped. */
export async function readPostgresOwnerEditorGraphScope(
  db: Read,
  ownerId: string,
  relationId: string,
  lock = false,
) {
  const query = db
    .select(graphTargetColumns)
    .from(knowledgeGraphRelations)
    .innerJoin(memories, eq(memories.id, knowledgeGraphRelations.sourceMemoryId))
    .innerJoin(
      knowledgeGraphAssertions,
      eq(knowledgeGraphAssertions.id, knowledgeGraphRelations.assertionId),
    )
    .where(
      and(
        eq(knowledgeGraphRelations.id, relationId),
        eq(knowledgeGraphRelations.agentId, ownerId),
        eq(memories.agentId, ownerId),
        eq(knowledgeGraphAssertions.agentId, ownerId),
      ),
    );
  const [target] = await (lock ? query.for('update') : query).limit(1);
  if (!target) return null;
  const [evidenceRows, sourceRows, canonicalRows] = await Promise.all([
    db
      .select({
        row: knowledgeGraphAssertionEvidence,
        native: sql<Record<string, unknown>>`to_jsonb(${knowledgeGraphAssertionEvidence})`,
      })
      .from(knowledgeGraphAssertionEvidence)
      .where(eq(knowledgeGraphAssertionEvidence.assertionId, target.assertion.id))
      .limit(2),
    db
      .select({
        row: knowledgeGraphRelations,
        native: sql<Record<string, unknown>>`to_jsonb(${knowledgeGraphRelations})`,
      })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, target.source.id))
      .limit(2),
    db
      .select({
        row: knowledgeGraphRelations,
        native: sql<Record<string, unknown>>`to_jsonb(${knowledgeGraphRelations})`,
      })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.assertionId, target.assertion.id))
      .limit(2),
  ]);
  return postgresGraphScope(ownerId, target, evidenceRows, sourceRows, canonicalRows);
}

export async function readPostgresOwnerEditorFamily(
  db: Read,
  ownerId: string,
  fields: OwnerEditorFamilyFields,
  targetId?: string,
  lock = false,
) {
  const [subject, object] = await Promise.all([
    postgresOwnerEditorContact(db, ownerId, fields.subjectContactId, lock),
    postgresOwnerEditorContact(db, ownerId, fields.objectContactId, lock),
  ]);
  if (!subject || !object || subject.id === object.id) return null;
  const entities = await db
    .select()
    .from(knowledgeGraphEntities)
    .where(
      and(
        eq(knowledgeGraphEntities.agentId, ownerId),
        inArray(knowledgeGraphEntities.canonicalKey, [
          `contact:${subject.id}`,
          `contact:${object.id}`,
        ]),
      ),
    )
    .limit(3);
  const aliases = await db
    .select({ id: knowledgeGraphEntityAliases.id })
    .from(knowledgeGraphEntityAliases)
    .where(
      and(
        eq(knowledgeGraphEntityAliases.agentId, ownerId),
        inArray(knowledgeGraphEntityAliases.canonicalKey, [
          `contact:${subject.id}`,
          `contact:${object.id}`,
        ]),
      ),
    )
    .limit(1);
  if (aliases.length) return null;
  if (
    entities.length > 2 ||
    entities.some(
      (row) =>
        row.agentId !== ownerId ||
        row.kind !== 'person' ||
        row.canonicalKey !== `contact:${row.contactId}`,
    )
  )
    return null;
  const left = entities.find((row) => row.contactId === subject.id),
    right = entities.find((row) => row.contactId === object.id);
  let canonicalRevision: string | null = null;
  let canonicalConflict = false;
  let canonicalIds: { assertionId: string; relationId: string; memoryId: string } | null = null;
  if (left && right) {
    const meaning = canonicalizeKnowledgeAssertionDirection({
      subjectEntityId: left.id,
      objectEntityId: right.id,
      predicate: fields.predicate,
      assertion: {
        tense: fields.timing,
        polarity: 'positive' as const,
        modality: 'asserted' as const,
      },
      ...fields.validity,
    });
    const id = knowledgeAssertionId(ownerId, knowledgeAssertionSemanticKey(ownerId, meaning));
    const canonicalQuery = db
      .select({
        row: knowledgeGraphAssertions,
        native: sql<Record<string, unknown>>`to_jsonb(${knowledgeGraphAssertions})`,
      })
      .from(knowledgeGraphAssertions)
      .where(eq(knowledgeGraphAssertions.id, id));
    const [existing] = await (lock ? canonicalQuery.for('update') : canonicalQuery).limit(1);
    if (existing) {
      canonicalRevision = ownerEditorSnapshotRevision({
        driver: 'postgres',
        ownerId,
        native: existing.native,
      });
      canonicalConflict =
        existing.row.agentId !== ownerId ||
        existing.row.lifecycle !== 'current' ||
        existing.row.reviewStatus !== 'confirmed' ||
        existing.row.reviewedRevision !== existing.row.semanticRevision ||
        existing.row.reviewedPayloadHash !== existing.row.semanticKey;
      const [relation] = await db
        .select({
          relationId: knowledgeGraphRelations.id,
          memoryId: knowledgeGraphRelations.sourceMemoryId,
        })
        .from(knowledgeGraphRelations)
        .where(
          and(
            eq(knowledgeGraphRelations.agentId, ownerId),
            eq(knowledgeGraphRelations.assertionId, id),
          ),
        )
        .limit(1);
      if (relation) canonicalIds = { assertionId: id, ...relation };
      else canonicalConflict = true;
    }
  }
  const canonicalScope = canonicalIds
    ? await readPostgresOwnerEditorGraphScope(db, ownerId, canonicalIds.relationId, lock)
    : null;
  const target = targetId
    ? await readPostgresOwnerEditorGraphScope(db, ownerId, targetId, lock)
    : null;
  return {
    subject,
    object,
    canonicalRevision,
    canonicalConflict,
    canonicalIds,
    canonicalScope,
    target,
    entities,
    fields,
  };
}

/** At most 500 raw contacts, 120 targets, and 240 rows per proof stream; sentinel overflow fails the whole editor. */
export async function postgresOwnerEditorViewSnapshot(
  db: Read,
  ownerId: string,
  input: { contactId?: string; relationIds?: readonly string[] } = {},
): Promise<OwnerEditorPeopleReadSnapshot> {
  await assertPostgresInstallationOwner(db as Db, ownerId);
  const ids = [...new Set(input.relationIds ?? [])];
  if (ids.length > 120) throw new Error('Editor snapshot read limit');
  const contactRows = await db
    .select({ contact: contacts, native: sql<Record<string, unknown>>`to_jsonb(${contacts})` })
    .from(contacts)
    .orderBy(asc(contacts.id))
    .limit(501);
  if (contactRows.length > 500) throw new Error('Editor snapshot read limit');
  const people = contactRows.map(({ contact, native }) => {
    if (
      !contact.name.trim() ||
      !Array.isArray(contact.aliases) ||
      !contact.aliases.every((alias) => typeof alias === 'string')
    )
      throw new Error('Malformed editor contact');
    return {
      ...contact,
      revision: ownerEditorSnapshotRevision({ driver: 'postgres', ownerId, native }),
    };
  });
  const result: OwnerEditorPeopleReadSnapshot = {
    ownerId,
    people: people
      .filter((p) => p.trust !== 'owner')
      .map((p) => ({ contactId: p.id, name: p.name, revision: p.revision })),
    identity: null,
    corrections: [],
  };
  const identity = people.find((p) => p.id === input.contactId && p.trust !== 'owner');
  if (identity)
    result.identity = {
      contactId: identity.id,
      name: identity.name,
      aliases: identity.aliases,
      trust: identity.trust,
      revision: identity.revision,
    };
  if (!ids.length) return result;
  const targets = await db
    .select(graphTargetColumns)
    .from(knowledgeGraphRelations)
    .innerJoin(memories, eq(memories.id, knowledgeGraphRelations.sourceMemoryId))
    .innerJoin(
      knowledgeGraphAssertions,
      eq(knowledgeGraphAssertions.id, knowledgeGraphRelations.assertionId),
    )
    .where(
      and(
        inArray(knowledgeGraphRelations.id, ids),
        eq(knowledgeGraphRelations.agentId, ownerId),
        eq(memories.agentId, ownerId),
        eq(knowledgeGraphAssertions.agentId, ownerId),
      ),
    )
    .limit(121);
  if (targets.length > 120) throw new Error('Editor snapshot read limit');
  if (!targets.length) return result;
  const assertionIds = [...new Set(targets.map((t) => t.assertion.id))],
    sourceIds = [...new Set(targets.map((t) => t.source.id))];
  const [evidence, sourceRelations, canonicalRelations, entities] = await Promise.all([
    db
      .select({
        row: knowledgeGraphAssertionEvidence,
        native: sql<Record<string, unknown>>`to_jsonb(${knowledgeGraphAssertionEvidence})`,
      })
      .from(knowledgeGraphAssertionEvidence)
      .where(inArray(knowledgeGraphAssertionEvidence.assertionId, assertionIds))
      .orderBy(asc(knowledgeGraphAssertionEvidence.id))
      .limit(241),
    db
      .select({
        row: knowledgeGraphRelations,
        native: sql<Record<string, unknown>>`to_jsonb(${knowledgeGraphRelations})`,
      })
      .from(knowledgeGraphRelations)
      .where(inArray(knowledgeGraphRelations.sourceMemoryId, sourceIds))
      .orderBy(asc(knowledgeGraphRelations.id))
      .limit(241),
    db
      .select({
        row: knowledgeGraphRelations,
        native: sql<Record<string, unknown>>`to_jsonb(${knowledgeGraphRelations})`,
      })
      .from(knowledgeGraphRelations)
      .where(inArray(knowledgeGraphRelations.assertionId, assertionIds))
      .orderBy(asc(knowledgeGraphRelations.id))
      .limit(241),
    db
      .select()
      .from(knowledgeGraphEntities)
      .where(
        and(
          eq(knowledgeGraphEntities.agentId, ownerId),
          inArray(knowledgeGraphEntities.id, [
            ...new Set(
              targets.flatMap((t) => [t.relation.subjectEntityId, t.relation.objectEntityId]),
            ),
          ]),
        ),
      )
      .limit(241),
  ]);
  if ([evidence, sourceRelations, canonicalRelations, entities].some((rows) => rows.length > 240))
    throw new Error('Editor snapshot read limit');
  for (const target of targets) {
    const scope = postgresGraphScope(
      ownerId,
      target,
      evidence.filter((x) => x.row.assertionId === target.assertion.id),
      sourceRelations.filter((x) => x.row.sourceMemoryId === target.source.id),
      canonicalRelations.filter((x) => x.row.assertionId === target.assertion.id),
    );
    const correction = ownerFamilyEditorProjection(scope, entities, people);
    if (correction) result.corrections.push(correction);
  }
  return result;
}
