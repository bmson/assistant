import { randomUUID } from 'node:crypto';
import type { PrivacyErasureCounts, PrivacyErasureRepository } from '@assistant/persistence';
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  agents,
  importSources,
  knowledgeGraphEntities,
  knowledgeGraphEntityAliases,
  knowledgeGraphRelations,
  maintenanceCursors,
  memories,
  memoryTombstones,
  ownerCard,
  selfRepairIssues,
  situationPacks,
  situationPreviews,
  tasks,
  voiceProfile,
  writingSamples,
} from './schema.js';

const assetPrefix = (agentId: string) => `privacy-erasure-asset:${agentId}:`;
const resultName = (agentId: string) => `privacy-erasure-result:${agentId}`;
const generationName = (agentId: string) => `privacy-erasure-generation:${agentId}`;

/** A completed erase still invalidates source reads begun before it. */
export async function postgresPrivacyObservationFence(
  db: Db,
  agentId: string,
): Promise<string | null> {
  const rows = await db
    .select()
    .from(maintenanceCursors)
    .where(inArray(maintenanceCursors.name, [resultName(agentId), generationName(agentId)]));
  if (rows.some((row) => row.name === resultName(agentId)))
    throw new Error('Privacy erasure is in progress');
  const generation = rows.find((row) => row.name === generationName(agentId));
  if (!generation) return null;
  if (!generation.cursor || generation.cursor.length > 100)
    throw new Error('Privacy erasure generation is malformed');
  return generation.cursor;
}

function savedCounts(value: string | null): PrivacyErasureCounts {
  if (!value) return { memories: 0, graphRelations: 0, writingSamples: 0 };
  const counts = JSON.parse(value) as PrivacyErasureCounts;
  if (
    [counts.memories, counts.graphRelations, counts.writingSamples].some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    )
  )
    throw new Error('Invalid saved privacy erasure counts');
  return counts;
}

async function soleOwner(db: Db) {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .orderBy(asc(agents.createdAt), asc(agents.id))
    .limit(2);
  if (rows.length !== 1 || !rows[0])
    throw new Error('Privacy erasure requires exactly one configured owner');
  return rows[0].id;
}

export function createPostgresPrivacyErasureRepository(db: Db): PrivacyErasureRepository {
  return {
    kind: 'privacy-erasure-repository',
    async erase() {
      return db.transaction(async (tx) => {
        const owners = await tx
          .select({ id: agents.id })
          .from(agents)
          .orderBy(asc(agents.createdAt), asc(agents.id))
          .limit(2)
          .for('update');
        if (owners.length !== 1 || !owners[0])
          throw new Error('Privacy erasure requires exactly one configured owner');
        const agentId = owners[0].id;
        const generation = randomUUID();
        await tx
          .insert(maintenanceCursors)
          .values({
            name: generationName(agentId),
            cursor: generation,
          })
          .onConflictDoUpdate({
            target: maintenanceCursors.name,
            set: { cursor: generation, updatedAt: new Date() },
          });
        await tx.delete(selfRepairIssues).where(eq(selfRepairIssues.agentId, agentId));
        const [memoryRows, voiceImports, packs] = await Promise.all([
          tx
            .select({ id: memories.id, contentHash: memories.contentHash })
            .from(memories)
            .where(eq(memories.agentId, agentId)),
          tx
            .select({
              id: importSources.id,
              taskId: importSources.taskId,
              workspacePath: importSources.workspacePath,
            })
            .from(importSources)
            .where(
              and(eq(importSources.agentId, agentId), like(importSources.source, 'voice-samples%')),
            ),
          tx
            .select({ id: situationPacks.id })
            .from(situationPacks)
            .where(eq(situationPacks.agentId, agentId))
            .for('update'),
        ]);
        if (packs.length)
          await tx.delete(situationPreviews).where(
            inArray(
              situationPreviews.packId,
              packs.map((pack) => pack.id),
            ),
          );
        await tx
          .update(situationPacks)
          .set({
            data: sql`jsonb_set(${situationPacks.data}, '{decisions}', '[]'::jsonb)`,
            version: sql`${situationPacks.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(situationPacks.agentId, agentId),
              sql`coalesce(${situationPacks.data}->'decisions', 'null'::jsonb) <> '[]'::jsonb`,
            ),
          );
        if (memoryRows.length)
          await tx
            .insert(memoryTombstones)
            .values(
              memoryRows.map((row) => ({ contentHash: row.contentHash, reason: 'owner_forget' })),
            )
            .onConflictDoNothing({ target: memoryTombstones.contentHash });
        const taskIds = voiceImports.map((row) => row.taskId).filter((id): id is string => !!id);
        if (taskIds.length)
          await tx
            .update(tasks)
            .set({ status: 'cancelled', lockedUntil: null, runAfter: null, updatedAt: sql`now()` })
            .where(
              and(
                eq(tasks.agentId, agentId),
                inArray(tasks.id, taskIds),
                inArray(tasks.status, ['pending', 'sleeping', 'running', 'needs_attention']),
              ),
            );
        for (const source of voiceImports) {
          const name = `${assetPrefix(agentId)}${source.id}`;
          const [existing] = await tx
            .select({ path: maintenanceCursors.cursor })
            .from(maintenanceCursors)
            .where(eq(maintenanceCursors.name, name))
            .limit(1);
          if (existing && existing.path !== source.workspacePath)
            throw new Error('Voice asset cleanup path changed');
          await tx
            .insert(maintenanceCursors)
            .values({
              name,
              cursor: source.workspacePath,
            })
            .onConflictDoNothing({ target: maintenanceCursors.name });
        }
        if (voiceImports.length)
          await tx.delete(importSources).where(
            and(
              eq(importSources.agentId, agentId),
              inArray(
                importSources.id,
                voiceImports.map((row) => row.id),
              ),
            ),
          );
        const relations = await tx
          .delete(knowledgeGraphRelations)
          .where(eq(knowledgeGraphRelations.agentId, agentId))
          .returning({ id: knowledgeGraphRelations.id });
        await tx
          .delete(knowledgeGraphEntityAliases)
          .where(eq(knowledgeGraphEntityAliases.agentId, agentId));
        await tx.delete(knowledgeGraphEntities).where(eq(knowledgeGraphEntities.agentId, agentId));
        await tx.delete(memories).where(eq(memories.agentId, agentId));
        const samples = await tx.delete(writingSamples).returning({ id: writingSamples.id });
        const now = new Date();
        await tx
          .insert(ownerCard)
          .values({ id: 1, content: '', compiledAt: now })
          .onConflictDoUpdate({
            target: ownerCard.id,
            set: { content: '', compiledAt: now },
          });
        await tx
          .insert(voiceProfile)
          .values({ id: 1, description: '', dos: [], donts: [], signature: '', updatedAt: now })
          .onConflictDoUpdate({
            target: voiceProfile.id,
            set: { description: '', dos: [], donts: [], signature: '', updatedAt: now },
          });
        const [previous] = await tx
          .select({ cursor: maintenanceCursors.cursor })
          .from(maintenanceCursors)
          .where(eq(maintenanceCursors.name, resultName(agentId)))
          .limit(1);
        const before = savedCounts(previous?.cursor ?? null);
        const counts = {
          memories: before.memories + memoryRows.length,
          graphRelations: before.graphRelations + relations.length,
          writingSamples: before.writingSamples + samples.length,
        };
        await tx
          .insert(maintenanceCursors)
          .values({ name: resultName(agentId), cursor: JSON.stringify(counts) })
          .onConflictDoUpdate({
            target: maintenanceCursors.name,
            set: { cursor: JSON.stringify(counts), updatedAt: new Date() },
          });
        return counts;
      });
    },
    async pendingAssets() {
      const agentId = await soleOwner(db);
      const prefix = assetPrefix(agentId);
      const rows = await db
        .select({ name: maintenanceCursors.name, path: maintenanceCursors.cursor })
        .from(maintenanceCursors)
        .where(like(maintenanceCursors.name, `${prefix}%`))
        .limit(100);
      return rows.map((row) => {
        if (!row.path) throw new Error('Privacy erasure asset has no workspace path');
        return { id: row.name.slice(prefix.length), workspacePath: row.path };
      });
    },
    async assetDeleted(id) {
      const agentId = await soleOwner(db);
      await db
        .delete(maintenanceCursors)
        .where(eq(maintenanceCursors.name, `${assetPrefix(agentId)}${id}`));
    },
    async complete() {
      await db.transaction(async (tx) => {
        const owners = await tx.select({ id: agents.id }).from(agents).limit(2).for('update');
        if (owners.length !== 1 || !owners[0])
          throw new Error('Privacy erasure requires exactly one configured owner');
        const agentId = owners[0].id;
        await tx.delete(selfRepairIssues).where(eq(selfRepairIssues.agentId, agentId));
        const [asset] = await tx
          .select({ name: maintenanceCursors.name })
          .from(maintenanceCursors)
          .where(like(maintenanceCursors.name, `${assetPrefix(agentId)}%`))
          .limit(1);
        if (asset) throw new Error('Privacy erasure assets remain');
        await tx.delete(maintenanceCursors).where(eq(maintenanceCursors.name, resultName(agentId)));
      });
    },
  };
}
