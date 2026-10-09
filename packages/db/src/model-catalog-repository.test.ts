import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresModelCatalogRepository } from './model-catalog-repository.js';
import { reconcileModelConfig } from './model-config.js';
import { createPostgresModelConnectionRepository } from './model-connection-repository.js';
import { modelConnections, modelRoleRevisions, modelRoles, models } from './schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';

describe('PostgreSQL model connections and catalog', () => {
  const suffix = randomUUID().slice(0, 8);
  const priced = `openai:priced-${suffix}`;
  const unpriced = `openai:unpriced-${suffix}`;
  const gateway = `gw-${suffix}`;
  let db: Db;
  let dbUp = false;
  let original: { primaryModel: string; fallbackModel: string } | undefined;
  let originalRoleRows: (typeof modelRoles.$inferSelect)[] = [];
  let originalFlash: typeof models.$inferSelect | undefined;
  const ownerModel = `openai:owner-${suffix}`;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      [original] = await db
        .select({ primaryModel: modelRoles.primaryModel, fallbackModel: modelRoles.fallbackModel })
        .from(modelRoles)
        .where(eq(modelRoles.role, 'batch'));
      originalRoleRows = await db.select().from(modelRoles);
      [originalFlash] = await db
        .select()
        .from(models)
        .where(eq(models.id, 'deepseek/deepseek-v4-flash-0731'));
      dbUp = Boolean(original);
    } catch {
      console.warn('model-catalog-repository.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (!dbUp || !original) return;
    for (const row of originalRoleRows) {
      await db.update(modelRoles).set(row).where(eq(modelRoles.role, row.role));
    }
    await db
      .delete(modelRoleRevisions)
      .where(inArray(modelRoleRevisions.role, ['batch', 'extract', 'classify']));
    if (originalFlash)
      await db.update(models).set(originalFlash).where(eq(models.id, originalFlash.id));
    await db
      .delete(models)
      .where(
        inArray(models.id, [
          priced,
          unpriced,
          'deepseek/deepseek-chat',
          'qwen/qwen3-30b-a3b-instruct-2507',
        ]),
      );
    await db.delete(models).where(eq(models.id, ownerModel));
    await db.delete(modelConnections).where(eq(modelConnections.id, gateway));
  });

  it('stores connections and keeps the sealed key unless replaced', async () => {
    if (!dbUp) return;
    const repo = createPostgresModelConnectionRepository(db);
    const base = {
      id: gateway,
      kind: 'openai_compatible',
      label: 'Gateway',
      baseUrl: 'https://gateway.test/v1',
      vertexProject: null,
      vertexLocation: null,
      enabled: true,
    };
    await repo.upsert({ ...base, apiKeyEncrypted: 'v2.sealed' });
    const renamed = await repo.upsert({ ...base, label: 'Renamed' });
    expect(renamed).toMatchObject({ label: 'Renamed', apiKeyEncrypted: 'v2.sealed' });
    expect(await repo.recordTest(gateway, { ok: false, error: 'HTTP 401' })).toBe(true);
    const [row] = (await repo.list()).filter((candidate) => candidate.id === gateway);
    expect(row).toMatchObject({ lastError: 'HTTP 401', updatedAt: renamed.updatedAt });
    expect(await repo.setEnabled(gateway, false)).toBe(true);
    expect(await repo.remove(gateway)).toBe(true);
    expect(await repo.remove(gateway)).toBe(false);
  });

  it('assigns a role only to enabled, priced models, atomically', async () => {
    if (!dbUp) return;
    const catalog = createPostgresModelCatalogRepository(db);
    const model = (id: string, promptCostPerMTok: string | null) => ({
      id,
      label: id,
      capabilities: { tools: true },
      promptCostPerMTok,
      completionCostPerMTok: '2.0000',
      latencyClass: 'medium',
      enabled: true,
    });
    await catalog.upsertModel(model(priced, '1.0000'));
    await catalog.upsertModel(model(unpriced, null));

    await expect(
      catalog.assignRoles([{ role: 'batch', primaryModel: priced, fallbackModel: unpriced }]),
    ).rejects.toThrow('not enabled with prices');
    await expect(
      catalog.assignRoles([
        { role: 'batch', primaryModel: priced, fallbackModel: priced },
        { role: 'nope', primaryModel: priced, fallbackModel: priced },
      ]),
    ).rejects.toThrow();
    const [unchanged] = (await catalog.listRoles()).filter((row) => row.role === 'batch');
    expect(unchanged?.primaryModel).toBe(original?.primaryModel);

    await catalog.assignRoles([{ role: 'batch', primaryModel: priced, fallbackModel: priced }]);
    const [batch] = (await catalog.listRoles()).filter((row) => row.role === 'batch');
    expect(batch).toMatchObject({ primaryModel: priced, fallbackModel: priced });
  });

  it('repairs only retired route legs and preserves custom values and disabled catalog choices', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const custom = createPostgresModelCatalogRepository(db);
    await custom.upsertModel({
      id: ownerModel,
      label: 'Owner model',
      capabilities: { tools: true },
      promptCostPerMTok: '1.0000',
      completionCostPerMTok: '2.0000',
      latencyClass: 'medium',
      enabled: true,
    });
    await db
      .insert(models)
      .values({
        id: 'deepseek/deepseek-chat',
        label: 'Retired legacy model',
        enabled: true,
      })
      .onConflictDoUpdate({ target: models.id, set: { enabled: true } });
    await db
      .insert(models)
      .values({
        id: 'qwen/qwen3-30b-a3b-instruct-2507',
        label: 'Retired legacy model',
        enabled: true,
      })
      .onConflictDoUpdate({ target: models.id, set: { enabled: true } });
    await db
      .update(modelRoles)
      .set({
        primaryModel: 'deepseek/deepseek-chat',
        fallbackModel: ownerModel,
        params: { temperature: 0.25, topP: 0.8 },
      })
      .where(eq(modelRoles.role, 'extract'));
    await db
      .update(modelRoles)
      .set({
        primaryModel: ownerModel,
        fallbackModel: 'qwen/qwen3-30b-a3b-instruct-2507',
        params: { temperature: 0.4 },
      })
      .where(eq(modelRoles.role, 'classify'));
    await db
      .update(models)
      .set({
        enabled: false,
        label: 'Owner disabled flash model',
        promptCostPerMTok: '7.5000',
      })
      .where(eq(models.id, 'deepseek/deepseek-v4-flash-0731'));

    await reconcileModelConfig(db);
    const roles = Object.fromEntries((await custom.listRoles()).map((row) => [row.role, row]));
    expect(roles.extract).toMatchObject({
      primaryModel: 'deepseek/deepseek-v4-flash-0731',
      fallbackModel: ownerModel,
      params: { temperature: 0.25, topP: 0.8 },
    });
    expect(roles.classify).toMatchObject({
      primaryModel: ownerModel,
      fallbackModel: 'openai/gpt-oss-120b',
      params: { temperature: 0.4 },
    });
    expect(
      (await db.select().from(models).where(eq(models.id, 'deepseek/deepseek-v4-flash-0731')))[0],
    ).toMatchObject({
      enabled: false,
      label: 'Owner disabled flash model',
      promptCostPerMTok: '7.5000',
    });
    const beforeRepeat = await custom.listRoleRevisions('extract');
    await reconcileModelConfig(db);
    expect(await custom.listRoleRevisions('extract')).toHaveLength(beforeRepeat.length);
    expect(await custom.rollbackRoleRevision(beforeRepeat.at(-1)?.id ?? '')).toBe(false);
  });
});
