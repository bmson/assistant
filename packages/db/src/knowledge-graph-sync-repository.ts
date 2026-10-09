import {
  boundGraphRelationToSource,
  canonicalizeKnowledgeAssertionDirection,
  type KnowledgeGraphProjectionEntity,
  type KnowledgeGraphSyncClaim,
  type KnowledgeGraphSyncRepository,
  type KnowledgeGraphSyncSource,
  knowledgeAssertionEvidenceId,
  knowledgeAssertionId,
  knowledgeAssertionSemanticKey,
} from '@assistant/persistence';
import { and, eq, gt, isNull, lt, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  agents,
  contacts,
  knowledgeGraphAssertionEvidence,
  knowledgeGraphAssertions,
  knowledgeGraphEntities,
  knowledgeGraphEntityAliases,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
  memoryTombstones,
  modelCalls,
} from './schema.js';

function asRows<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function sourceChanged(source: KnowledgeGraphSyncSource, extractionVersion: number) {
  return or(
    ne(knowledgeGraphSources.contentHash, source.contentHash),
    sql`${knowledgeGraphSources.subjectContactId} IS DISTINCT FROM ${source.subjectContactId}`,
    lt(knowledgeGraphSources.extractionVersion, extractionVersion),
  );
}

function retryable(now: Date) {
  return and(
    eq(knowledgeGraphSources.status, 'failed'),
    or(isNull(knowledgeGraphSources.nextRetryAt), lte(knowledgeGraphSources.nextRetryAt, now)),
  );
}

function needsSync(now: Date, extractionVersion: number, leaseMs: number) {
  return or(
    isNull(knowledgeGraphSources.memoryId),
    ne(knowledgeGraphSources.contentHash, memories.contentHash),
    sql`${knowledgeGraphSources.subjectContactId} IS DISTINCT FROM ${memories.subjectContactId}`,
    lt(knowledgeGraphSources.extractionVersion, extractionVersion),
    retryable(now),
    and(
      eq(knowledgeGraphSources.status, 'pending'),
      lt(knowledgeGraphSources.updatedAt, new Date(now.getTime() - leaseMs)),
    ),
  );
}

function activeClaim(
  source: KnowledgeGraphSyncSource,
  claim: KnowledgeGraphSyncClaim,
  extractionVersion: number,
) {
  return and(
    eq(knowledgeGraphSources.memoryId, source.id),
    eq(knowledgeGraphSources.contentHash, source.contentHash),
    eq(knowledgeGraphSources.extractionVersion, extractionVersion),
    eq(knowledgeGraphSources.status, 'pending'),
    eq(knowledgeGraphSources.updatedAt, new Date(claim.token)),
  );
}

function betterLabel(existing: string, incoming: string): string {
  if (existing === incoming) return existing;
  const existingCased = /\p{Lu}/u.test(existing);
  const incomingCased = /\p{Lu}/u.test(incoming);
  if (incomingCased !== existingCased) return incomingCased ? incoming : existing;
  return incoming.length > existing.length ? incoming : existing;
}

async function liveSource(
  tx: Db,
  source: KnowledgeGraphSyncSource,
  now: Date,
): Promise<{ validFrom: Date | null; validUntil: Date | null } | null> {
  const [memory] = await tx
    .select({
      id: memories.id,
      agentId: memories.agentId,
      content: memories.content,
      contentHash: memories.contentHash,
      subjectContactId: memories.subjectContactId,
      category: memories.category,
      quarantined: memories.quarantined,
      expiresAt: memories.expiresAt,
      validFrom: memories.validFrom,
      validUntil: memories.validUntil,
    })
    .from(memories)
    .where(eq(memories.id, source.id))
    .for('update')
    .limit(1);
  if (
    !memory ||
    memory.agentId !== source.agentId ||
    memory.content !== source.content ||
    memory.contentHash !== source.contentHash ||
    memory.subjectContactId !== source.subjectContactId ||
    (source.validFrom !== undefined &&
      (memory.validFrom?.getTime() ?? null) !== (source.validFrom?.getTime() ?? null)) ||
    (source.validUntil !== undefined &&
      (memory.validUntil?.getTime() ?? null) !== (source.validUntil?.getTime() ?? null)) ||
    memory.category !== 'knowledge' ||
    memory.quarantined ||
    (memory.expiresAt && memory.expiresAt <= now)
  )
    return null;
  const [tombstone] = await tx
    .select({ id: memoryTombstones.id })
    .from(memoryTombstones)
    .where(eq(memoryTombstones.contentHash, source.contentHash))
    .limit(1);
  return tombstone ? null : memory;
}

async function resolveEntity(
  tx: Db,
  agentId: string,
  entity: KnowledgeGraphProjectionEntity,
): Promise<string> {
  const [alias] = await tx
    .select({
      entityId: knowledgeGraphEntityAliases.entityId,
      entityAgentId: knowledgeGraphEntities.agentId,
    })
    .from(knowledgeGraphEntityAliases)
    .innerJoin(
      knowledgeGraphEntities,
      eq(knowledgeGraphEntities.id, knowledgeGraphEntityAliases.entityId),
    )
    .where(
      and(
        eq(knowledgeGraphEntityAliases.agentId, agentId),
        eq(knowledgeGraphEntityAliases.canonicalKey, entity.canonicalKey),
      ),
    )
    .limit(1);
  if (alias) {
    if (alias.entityAgentId !== agentId)
      throw new Error('Graph alias target belongs to another agent');
    return alias.entityId;
  }
  let label = entity.label;
  if (!entity.authoritativeLabel) {
    const [existing] = await tx
      .select({ label: knowledgeGraphEntities.label })
      .from(knowledgeGraphEntities)
      .where(
        and(
          eq(knowledgeGraphEntities.agentId, agentId),
          eq(knowledgeGraphEntities.canonicalKey, entity.canonicalKey),
        ),
      )
      .limit(1);
    if (existing) label = betterLabel(existing.label, label);
  }
  const [row] = await tx
    .insert(knowledgeGraphEntities)
    .values({
      agentId,
      canonicalKey: entity.canonicalKey,
      label,
      kind: entity.kind,
      contactId: entity.contactId,
    })
    .onConflictDoUpdate({
      target: [knowledgeGraphEntities.agentId, knowledgeGraphEntities.canonicalKey],
      set: {
        label,
        kind: entity.kind,
        contactId: entity.contactId,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: knowledgeGraphEntities.id });
  if (!row) throw new Error('knowledge graph entity upsert failed');
  return row.id;
}

export function createPostgresKnowledgeGraphSyncRepository(db: Db): KnowledgeGraphSyncRepository {
  const candidates = async (input: {
    agentId?: string;
    limit: number;
    extractionVersion: number;
    leaseMs: number;
    now: Date;
  }) =>
    db
      .select({
        id: memories.id,
        agentId: memories.agentId,
        content: memories.content,
        contentHash: memories.contentHash,
        confidence: memories.confidence,
        originTrust: memories.originTrust,
        ownerConfirmed: memories.ownerConfirmed,
        subjectContactId: memories.subjectContactId,
        createdAt: memories.createdAt,
        validFrom: memories.validFrom,
        validUntil: memories.validUntil,
      })
      .from(memories)
      .leftJoin(knowledgeGraphSources, eq(knowledgeGraphSources.memoryId, memories.id))
      .where(
        and(
          input.agentId ? eq(memories.agentId, input.agentId) : undefined,
          eq(memories.category, 'knowledge'),
          eq(memories.quarantined, false),
          or(isNull(memories.expiresAt), gt(memories.expiresAt, input.now)),
          needsSync(input.now, input.extractionVersion, input.leaseMs),
        ),
      )
      .orderBy(memories.createdAt)
      .limit(input.limit)
      .then((rows) => rows.map((row) => ({ ...row, retrievalRevision: row.contentHash })));

  return {
    kind: 'knowledge-graph-sync-repository',
    now: () => new Date(),
    async hydrateContactLabels(agentId) {
      await db.execute(sql`
        UPDATE knowledge_graph_entities AS entity
        SET label = contact.name, updated_at = now()
        FROM contacts AS contact
        WHERE entity.contact_id = contact.id
          AND entity.label IS DISTINCT FROM contact.name
          ${agentId ? sql`AND entity.agent_id = ${agentId}` : sql``}
      `);
    },
    candidates,
    async context(agentId) {
      const [agent] = await db
        .select({ id: agents.id, timeZone: agents.timezone, locale: agents.locale })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      if (!agent) throw new Error('Knowledge graph source agent is missing');
      return {
        agentId,
        timeZone: agent.timeZone || 'UTC',
        locale: agent.locale || 'en',
        contacts: await db
          .select({ id: contacts.id, name: contacts.name, aliases: contacts.aliases })
          .from(contacts),
      };
    },
    claim(input) {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        if (!(await liveSource(txDb, input.source, input.now))) return null;
        const claimedAt = input.now;
        const changed = sourceChanged(input.source, input.extractionVersion);
        const canClaim = or(
          changed,
          retryable(claimedAt),
          and(
            eq(knowledgeGraphSources.status, 'pending'),
            lt(knowledgeGraphSources.updatedAt, new Date(claimedAt.getTime() - input.leaseMs)),
          ),
        );
        const [updated] = await txDb
          .update(knowledgeGraphSources)
          .set({
            contentHash: input.source.contentHash,
            subjectContactId: input.source.subjectContactId,
            extractionVersion: input.extractionVersion,
            status: 'pending',
            attempts: sql`CASE WHEN ${changed} THEN 1 ELSE ${knowledgeGraphSources.attempts} + 1 END`,
            lastError: null,
            nextRetryAt: null,
            updatedAt: claimedAt,
          })
          .where(and(eq(knowledgeGraphSources.memoryId, input.source.id), canClaim))
          .returning({
            updatedAt: knowledgeGraphSources.updatedAt,
            attempts: knowledgeGraphSources.attempts,
          });
        if (updated?.updatedAt)
          return { token: updated.updatedAt.toISOString(), attempts: updated.attempts };
        const [inserted] = await txDb
          .insert(knowledgeGraphSources)
          .values({
            memoryId: input.source.id,
            contentHash: input.source.contentHash,
            subjectContactId: input.source.subjectContactId,
            extractionVersion: input.extractionVersion,
            status: 'pending',
            attempts: 1,
            lastError: null,
            nextRetryAt: null,
            updatedAt: claimedAt,
          })
          .onConflictDoNothing({ target: knowledgeGraphSources.memoryId })
          .returning({
            updatedAt: knowledgeGraphSources.updatedAt,
            attempts: knowledgeGraphSources.attempts,
          });
        return inserted?.updatedAt
          ? { token: inserted.updatedAt.toISOString(), attempts: inserted.attempts }
          : null;
      });
    },
    fail(input) {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        if (!(await liveSource(txDb, input.source, input.now))) return false;
        const [finished] = await txDb
          .update(knowledgeGraphSources)
          .set({
            status: input.status,
            lastError: input.lastError,
            nextRetryAt: input.nextRetryAt,
            updatedAt: input.now,
          })
          .where(activeClaim(input.source, input.claim, input.extractionVersion))
          .returning({ memoryId: knowledgeGraphSources.memoryId });
        return Boolean(finished);
      });
    },
    replaceProjection(input) {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const live = await liveSource(txDb, input.source, input.now);
        if (!live) return null;
        const [owned] = await txDb
          .select({ memoryId: knowledgeGraphSources.memoryId })
          .from(knowledgeGraphSources)
          .where(activeClaim(input.source, input.claim, input.extractionVersion))
          .for('update')
          .limit(1);
        if (!owned) return null;
        const fingerprints: string[] = [];
        const touched = new Set<string>();
        const priorRows = await txDb
          .select({
            fingerprint: knowledgeGraphRelations.sourceFingerprint,
            assertionId: knowledgeGraphRelations.assertionId,
            reviewStatus: knowledgeGraphRelations.reviewStatus,
          })
          .from(knowledgeGraphRelations)
          .where(eq(knowledgeGraphRelations.sourceMemoryId, input.source.id));
        const priorAssertionByFingerprint = new Map(
          priorRows.map((row) => [row.fingerprint, row.assertionId]),
        );
        const priorAssertionIds = new Set(
          priorRows.flatMap((row) => (row.assertionId ? [row.assertionId] : [])),
        );
        for (const proposed of input.relations) {
          const relation = boundGraphRelationToSource(proposed, {
            ...live,
            content: input.source.content,
          });
          if (!relation) continue;
          const subjectEntityId = await resolveEntity(txDb, input.source.agentId, relation.subject);
          const objectEntityId = await resolveEntity(txDb, input.source.agentId, relation.object);
          fingerprints.push(relation.sourceFingerprint);
          touched.add(relation.subject.canonicalKey);
          touched.add(relation.object.canonicalKey);
          const meaning = canonicalizeKnowledgeAssertionDirection({
            subjectEntityId,
            predicate: relation.predicate,
            objectEntityId,
            assertion: relation.assertion,
            validFrom: relation.validFrom,
            validUntil: relation.validUntil,
          });
          const semanticKey = knowledgeAssertionSemanticKey(input.source.agentId, meaning);
          const assertionId = knowledgeAssertionId(input.source.agentId, semanticKey);
          const priorAssertionId = priorAssertionByFingerprint.get(relation.sourceFingerprint);
          if (priorAssertionId && priorAssertionId !== assertionId) {
            await txDb
              .delete(knowledgeGraphAssertionEvidence)
              .where(
                and(
                  eq(knowledgeGraphAssertionEvidence.agentId, input.source.agentId),
                  eq(knowledgeGraphAssertionEvidence.sourceMemoryId, input.source.id),
                  eq(knowledgeGraphAssertionEvidence.sourceFingerprint, relation.sourceFingerprint),
                ),
              );
            priorAssertionIds.add(priorAssertionId);
          }
          const [assertionRow] = await txDb
            .insert(knowledgeGraphAssertions)
            .values({
              id: assertionId,
              agentId: input.source.agentId,
              semanticKey,
              subjectEntityId: meaning.subjectEntityId,
              predicate: meaning.predicate,
              objectEntityId: meaning.objectEntityId,
              assertion: meaning.assertion,
              qualifiers: 'qualifiers' in meaning ? (meaning.qualifiers ?? {}) : {},
              validFrom: meaning.validFrom,
              validUntil: meaning.validUntil,
              lifecycle: 'current',
              reviewStatus:
                priorRows.find((row) => row.fingerprint === relation.sourceFingerprint)
                  ?.reviewStatus ?? 'unreviewed',
              updatedAt: input.now,
            } as typeof knowledgeGraphAssertions.$inferInsert)
            .onConflictDoUpdate({
              target: knowledgeGraphAssertions.id,
              set: { lifecycle: 'current', updatedAt: input.now },
            })
            .returning({ reviewStatus: knowledgeGraphAssertions.reviewStatus });
          await txDb
            .insert(knowledgeGraphAssertionEvidence)
            .values({
              id: knowledgeAssertionEvidenceId(
                input.source.agentId,
                assertionId,
                input.source.id,
                relation.sourceFingerprint,
              ),
              agentId: input.source.agentId,
              assertionId,
              sourceMemoryId: input.source.id,
              sourceFingerprint: relation.sourceFingerprint,
              sourceContentHash: input.source.contentHash,
              evidenceQuote: relation.evidenceQuote,
              sourceAuthor:
                input.source.ownerConfirmed && input.source.originTrust === 'owner'
                  ? 'owner'
                  : input.source.originTrust === 'other'
                    ? 'other'
                    : 'unknown',
              sourceTrust: input.source.originTrust ?? 'unknown',
              independent: false,
              spanStart: relation.evidenceSpanStart ?? null,
              spanEnd: relation.evidenceSpanEnd ?? null,
              extractionVersion: input.extractionVersion,
              observedAt: input.now,
            })
            .onConflictDoUpdate({
              target: knowledgeGraphAssertionEvidence.id,
              set: {
                sourceContentHash: input.source.contentHash,
                evidenceQuote: relation.evidenceQuote,
                sourceTrust: 'unknown',
                extractionVersion: input.extractionVersion,
                evidenceRevision: sql`${knowledgeGraphAssertionEvidence.evidenceRevision} + 1`,
                observedAt: input.now,
              },
            });
          await txDb
            .update(knowledgeGraphAssertions)
            .set({
              evidenceRevision: sql`${knowledgeGraphAssertions.evidenceRevision} + 1`,
              updatedAt: input.now,
            })
            .where(eq(knowledgeGraphAssertions.id, assertionId));
          await txDb
            .insert(knowledgeGraphRelations)
            .values({
              agentId: input.source.agentId,
              subjectEntityId,
              predicate: relation.predicate,
              assertion: relation.assertion,
              assertionId,
              reviewStatus: assertionRow?.reviewStatus ?? 'unreviewed',
              objectEntityId,
              sourceMemoryId: input.source.id,
              evidenceQuote: relation.evidenceQuote,
              sourceFingerprint: relation.sourceFingerprint,
              ordinal: relation.ordinal,
              confidence: relation.confidence,
              validFrom: relation.validFrom,
              validUntil: relation.validUntil,
            })
            .onConflictDoUpdate({
              target: [
                knowledgeGraphRelations.sourceMemoryId,
                knowledgeGraphRelations.sourceFingerprint,
              ],
              set: {
                agentId: input.source.agentId,
                subjectEntityId,
                predicate: relation.predicate,
                assertion: relation.assertion,
                assertionId,
                reviewStatus: assertionRow?.reviewStatus ?? 'unreviewed',
                objectEntityId,
                evidenceQuote: relation.evidenceQuote,
                ordinal: relation.ordinal,
                confidence: relation.confidence,
                validFrom: relation.validFrom,
                validUntil: relation.validUntil,
              },
            });
        }
        await txDb
          .delete(knowledgeGraphRelations)
          .where(
            and(
              eq(knowledgeGraphRelations.sourceMemoryId, input.source.id),
              fingerprints.length > 0
                ? notInArray(knowledgeGraphRelations.sourceFingerprint, fingerprints)
                : undefined,
            ),
          );
        await txDb
          .delete(knowledgeGraphAssertionEvidence)
          .where(
            and(
              eq(knowledgeGraphAssertionEvidence.agentId, input.source.agentId),
              eq(knowledgeGraphAssertionEvidence.sourceMemoryId, input.source.id),
              fingerprints.length > 0
                ? notInArray(knowledgeGraphAssertionEvidence.sourceFingerprint, fingerprints)
                : undefined,
            ),
          );
        for (const priorAssertionId of priorAssertionIds) {
          const [evidence] = await txDb
            .select({ id: knowledgeGraphAssertionEvidence.id })
            .from(knowledgeGraphAssertionEvidence)
            .where(eq(knowledgeGraphAssertionEvidence.assertionId, priorAssertionId))
            .limit(1);
          if (!evidence)
            await txDb
              .update(knowledgeGraphAssertions)
              .set({
                lifecycle: 'retracted',
                semanticRevision: sql`${knowledgeGraphAssertions.semanticRevision} + 1`,
                updatedAt: input.now,
              })
              .where(
                and(
                  eq(knowledgeGraphAssertions.id, priorAssertionId),
                  eq(knowledgeGraphAssertions.ownerAuthored, false),
                ),
              );
        }
        const [finished] = await txDb
          .update(knowledgeGraphSources)
          .set({
            status: 'ready',
            lastError: input.lastError ?? null,
            nextRetryAt: null,
            updatedAt: input.now,
          })
          .where(activeClaim(input.source, input.claim, input.extractionVersion))
          .returning({ memoryId: knowledgeGraphSources.memoryId });
        if (!finished) throw new Error('Knowledge graph source claim lost');
        return { relationships: input.relations.length, entities: touched.size };
      });
    },
    async removeOrphanedEntities(agentId) {
      return asRows<{ id: string }>(
        await db.execute(sql`
          DELETE FROM knowledge_graph_entities AS entity
          WHERE NOT EXISTS (
            SELECT 1 FROM knowledge_graph_relations AS relation
            WHERE relation.subject_entity_id = entity.id OR relation.object_entity_id = entity.id
          )
          ${agentId ? sql`AND entity.agent_id = ${agentId}` : sql``}
          RETURNING id
        `),
      ).length;
    },
    async pendingCount(input) {
      const rows = await candidates({ ...input, limit: 2_147_483_647 });
      return rows.length;
    },
    async taskSpendUsd(taskId) {
      const [row] = await db
        .select({ value: sql<string>`COALESCE(SUM(${modelCalls.costUsd}), 0)` })
        .from(modelCalls)
        .where(eq(modelCalls.taskId, taskId));
      return Number(row?.value ?? 0);
    },
  };
}
