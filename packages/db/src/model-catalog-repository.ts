import { randomUUID } from 'node:crypto';
import { isRoutableModel, type ModelCatalogRepository } from '@assistant/persistence';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { modelRoleRevisions, modelRoles, models } from './schema.js';

function roleState(row: { primaryModel: string; fallbackModel: string; params: unknown }) {
  return {
    primaryModel: row.primaryModel,
    fallbackModel: row.fallbackModel,
    params: row.params,
  };
}

function sameState(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(left, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
    ) ===
    JSON.stringify(right, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
    )
  );
}

export function createPostgresModelCatalogRepository(db: Db): ModelCatalogRepository {
  return {
    kind: 'model-catalog-repository',
    listModels: () => db.select().from(models).orderBy(asc(models.label)),
    listRoles: () => db.select().from(modelRoles).orderBy(asc(modelRoles.role)),
    listRoleRevisions: (role) =>
      db
        .select()
        .from(modelRoleRevisions)
        .where(role ? eq(modelRoleRevisions.role, role) : undefined)
        .orderBy(asc(modelRoleRevisions.createdAt), asc(modelRoleRevisions.id)),
    async rollbackRoleRevision(revisionId) {
      return db.transaction(async (tx) => {
        const [revision] = await tx
          .select()
          .from(modelRoleRevisions)
          .where(eq(modelRoleRevisions.id, revisionId))
          .for('update');
        if (!revision?.baselineKnown) return false;
        if (revision.beforeState === null) {
          if (revision.role !== 'voice') return false;
          const [current] = await tx
            .select()
            .from(modelRoles)
            .where(eq(modelRoles.role, revision.role))
            .for('update');
          if (!current || !sameState(roleState(current), revision.afterState)) return false;
          await tx.delete(modelRoles).where(eq(modelRoles.role, revision.role));
          await tx.insert(modelRoleRevisions).values({
            id: randomUUID(),
            role: revision.role,
            beforeState: roleState(current),
            afterState: null,
            source: `rollback:${revision.id}`,
            baselineKnown: true,
            requiresOwnerReview: false,
          });
          return true;
        }
        if (!revision.beforeState) return false;
        const before = revision.beforeState as {
          primaryModel?: unknown;
          fallbackModel?: unknown;
          params?: unknown;
        };
        if (
          typeof before.primaryModel !== 'string' ||
          typeof before.fallbackModel !== 'string' ||
          before.params === undefined
        )
          return false;
        const [current] = await tx
          .select()
          .from(modelRoles)
          .where(eq(modelRoles.role, revision.role))
          .for('update');
        if (!current || !sameState(roleState(current), revision.afterState)) return false;
        const modelsForRestore = await tx
          .select()
          .from(models)
          .where(inArray(models.id, [before.primaryModel, before.fallbackModel]));
        const routable = new Set(modelsForRestore.filter(isRoutableModel).map((model) => model.id));
        if (!routable.has(before.primaryModel) || !routable.has(before.fallbackModel)) return false;
        const restored = {
          primaryModel: before.primaryModel,
          fallbackModel: before.fallbackModel,
          params: before.params,
        };
        await tx
          .update(modelRoles)
          .set({ ...restored, updatedAt: sql`now()` })
          .where(eq(modelRoles.role, revision.role));
        await tx.insert(modelRoleRevisions).values({
          id: randomUUID(),
          role: revision.role,
          beforeState: roleState(current),
          afterState: restored,
          source: `rollback:${revision.id}`,
          baselineKnown: true,
          requiresOwnerReview: false,
        });
        return true;
      });
    },
    async upsertModel(input) {
      await db
        .insert(models)
        .values(input)
        .onConflictDoUpdate({
          target: models.id,
          set: {
            label: input.label,
            capabilities: input.capabilities,
            promptCostPerMTok: input.promptCostPerMTok,
            completionCostPerMTok: input.completionCostPerMTok,
            latencyClass: input.latencyClass,
            enabled: input.enabled,
            updatedAt: sql`now()`,
          },
        });
    },
    async setVoiceModel(modelId) {
      await db.transaction(async (tx) => {
        const [model] = await tx.select().from(models).where(eq(models.id, modelId)).for('share');
        if (!isRoutableModel(model ?? null))
          throw new Error(`Model ${modelId} is not enabled with prices`);
        const [before] = await tx
          .select()
          .from(modelRoles)
          .where(eq(modelRoles.role, 'voice'))
          .for('update');
        const after = {
          primaryModel: modelId,
          fallbackModel: modelId,
          params: before?.params ?? {},
        };
        await tx
          .insert(modelRoles)
          .values({ role: 'voice', ...after })
          .onConflictDoUpdate({
            target: modelRoles.role,
            set: { ...after, updatedAt: sql`now()` },
          });
        if (!before || !sameState(roleState(before), after)) {
          await tx.insert(modelRoleRevisions).values({
            id: randomUUID(),
            role: 'voice',
            beforeState: before ? roleState(before) : null,
            afterState: after,
            source: 'owner-settings',
            baselineKnown: true,
            requiresOwnerReview: false,
          });
        }
      });
    },
    async assignRoles(assignments) {
      if (assignments.length === 0) return;
      await db.transaction(async (tx) => {
        const wanted = [...new Set(assignments.flatMap((a) => [a.primaryModel, a.fallbackModel]))];
        const rows = await tx.select().from(models).where(inArray(models.id, wanted)).for('share');
        const routable = new Set(rows.filter(isRoutableModel).map((row) => row.id));
        for (const id of wanted) {
          if (!routable.has(id)) throw new Error(`Model ${id} is not enabled with prices`);
        }
        for (const assignment of assignments) {
          const [before] = await tx
            .select()
            .from(modelRoles)
            .where(eq(modelRoles.role, assignment.role))
            .for('update');
          if (!before) throw new Error(`Unknown model role: ${assignment.role}`);
          const after = {
            primaryModel: assignment.primaryModel,
            fallbackModel: assignment.fallbackModel,
            params: before.params,
          };
          const updated = await tx
            .update(modelRoles)
            .set({
              ...after,
              updatedAt: sql`now()`,
            })
            .where(eq(modelRoles.role, assignment.role))
            .returning({ role: modelRoles.role });
          if (updated.length !== 1) throw new Error(`Unknown model role: ${assignment.role}`);
          if (!sameState(roleState(before), after))
            await tx.insert(modelRoleRevisions).values({
              id: randomUUID(),
              role: assignment.role,
              beforeState: roleState(before),
              afterState: after,
              source: 'owner-settings',
              baselineKnown: true,
              requiresOwnerReview: false,
            });
        }
      });
    },
  };
}
