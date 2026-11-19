import { loadConfig, resetConfigForTest } from '@assistant/config';
import { createDb, createPostgresExecutionPersistence, schedules } from '@assistant/db';
import { installModules, noopOwnerNotifier } from '@assistant/modules';
import { ToolRegistry } from '@assistant/tools/registry';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
} from '../../../scripts/test-target.js';
import type { AgentDeps } from './deps.js';
import { runPostgresSweep } from './postgres-sweep.js';
import { internal } from './routes/internal.js';
import { readPostgresSweepHealth } from './sweep-heartbeat.js';

const SECRET = 'local-synthetic-sweep-probe';
const headers = { authorization: `Bearer ${SECRET}` };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetConfigForTest();
});

describe('independent scheduler health', () => {
  it('reads PostgreSQL completion through the authenticated GET endpoint', async () => {
    const target = assertAllocatedTestTargetMarker({
      databaseUrl: process.env.DATABASE_URL,
      testDatabaseUrl: process.env.TEST_DATABASE_URL,
      token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    });
    const db = createDb(target.databaseUrl);
    try {
      await assertAllocatedTestDatabaseOwnership(db, target);
      // Disable seeded schedules in this disposable database. The quiet sweep
      // should execute maintenance without creating or notifying any work.
      await db.update(schedules).set({ enabled: false });
      vi.stubEnv('INTERNAL_AUTH_MODE', 'shared-secret');
      vi.stubEnv('INTERNAL_API_SECRET', SECRET);
      vi.stubEnv('PERSISTENCE_DRIVER', 'postgres');
      resetConfigForTest();
      const config = loadConfig();
      let now = new Date('2026-11-18T20:00:00Z');
      const clock = () => now;
      const read = () => {
        vi.setSystemTime(now);
        return internal.request('/sweep/health', { headers });
      };
      const provider = new Proxy(
        {},
        {
          get() {
            throw new Error('The quiet sweep must not call a provider');
          },
        },
      );
      const embed = vi.fn(async () => {
        throw new Error('Unexpected embedding call');
      });
      const router = {
        embed,
        embeddingSpace: async () => ({
          provider: 'synthetic',
          model: 'heartbeat-fixture',
          dimensions: 1536,
          revision: '1',
        }),
      };
      const persistence = createPostgresExecutionPersistence(db);
      const deps = {
        config,
        db,
        persistence,
        registry: new ToolRegistry(),
        router,
        workspace: provider,
        dispatcher: provider,
        outOfBandNotifier: noopOwnerNotifier,
        modules: {
          ...installModules([], {
            config,
            db,
            router: router as never,
            workspace: provider as never,
            registry: new ToolRegistry(),
            workspacePrefix: 'test',
            workspaceRoot: '/tmp/test',
            repoRoot: '/tmp/test',
            persistence,
          }),
          sweepSteps: [],
        },
      } as unknown as AgentDeps;
      expect((await internal.request('/sweep/health')).status).toBe(401);
      const missing = await read();
      expect(missing.status).toBe(503);
      expect(await missing.json()).toMatchObject({ health: { state: 'missing' } });
      expect(await runPostgresSweep(deps, { clock })).toMatchObject({
        schedulesFired: 0,
        failedSteps: [],
      });
      const healthy = await read();
      expect(healthy.status).toBe(200);
      expect(healthy.headers.get('cache-control')).toBe('no-store');
      expect(await healthy.json()).toMatchObject({
        health: { state: 'healthy', failedSteps: [], ageMs: 0 },
      });

      now = new Date(now.getTime() + 30 * 60_000);
      const stale = await read();
      expect(stale.status).toBe(503);
      expect(await stale.json()).toMatchObject({ health: { state: 'stale', ageMs: 1_800_000 } });
      const failed = {
        ...deps,
        modules: {
          ...deps.modules,
          sweepSteps: [
            {
              name: 'fixtureMaintenance',
              run: async () => {
                throw new Error('synthetic failure detail');
              },
            },
          ],
        },
      };
      expect(await runPostgresSweep(failed, { clock })).toMatchObject({
        failedSteps: ['fixtureMaintenance'],
      });
      const failure = await read();
      expect(failure.status).toBe(503);
      const json = await failure.json();
      expect(json).toMatchObject({
        health: { state: 'failed', failedSteps: ['fixtureMaintenance'] },
      });
      expect(JSON.stringify(json)).not.toContain('synthetic failure detail');

      now = new Date(now.getTime() + 5 * 60_000);
      expect(await runPostgresSweep(deps, { clock })).toMatchObject({ failedSteps: [] });
      expect(await readPostgresSweepHealth(db, now)).toMatchObject({ state: 'healthy' });
      expect((await read()).status).toBe(200);
      await db
        .update(schedules)
        .set({
          enabled: true,
          createdAt: new Date(now.getTime() - 27 * 3_600_000),
        })
        .where(eq(schedules.name, 'daily-briefing'));
      const overdueBriefing = await read();
      expect(overdueBriefing.status).toBe(503);
      expect(await overdueBriefing.json()).toMatchObject({
        health: { state: 'healthy', ok: false, briefing: { state: 'stale' } },
      });
      expect(embed).not.toHaveBeenCalled();
    } finally {
      await db.$client.end();
    }
  });
});
