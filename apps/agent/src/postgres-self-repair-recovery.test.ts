import { randomUUID } from 'node:crypto';
import { runRepairCycle } from '@assistant/core/workflow/self-repair';
import { createDb, createPostgresSelfRepairRepository } from '@assistant/db';
import { agents, selfRepairIssues, tasks } from '@assistant/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('PostgreSQL self-repair recovery', () => {
  const dbUrl = process.env.DATABASE_URL;
  const db = dbUrl ? createDb(dbUrl) : null;
  const ownerId = randomUUID();
  const taskA = randomUUID();
  const taskB = randomUUID();

  afterEach(async () => {
    if (!db) return;
    await db.delete(selfRepairIssues).where(eq(selfRepairIssues.agentId, ownerId));
    await db.delete(tasks).where(eq(tasks.agentId, ownerId));
    await db.delete(agents).where(eq(agents.id, ownerId));
    await db.$client.end();
  });

  it.skipIf(!dbUrl)(
    'recovers a transient pre-dispatch attempt after fresh-repository restart',
    async () => {
      if (!db || !dbUrl || !new URL(dbUrl).pathname.endsWith('_test'))
        throw new Error('Requires the isolated _test database');
      await db.insert(agents).values({
        id: ownerId,
        name: 'Self-repair recovery fixture',
        email: `${ownerId}@example.test`,
        workspacePrefix: `repair-recovery-${ownerId}`,
      });
      await db.insert(tasks).values([
        { id: taskA, agentId: ownerId, type: 'scheduled', status: 'done' },
        { id: taskB, agentId: ownerId, type: 'scheduled', status: 'done' },
      ]);
      const repository = createPostgresSelfRepairRepository(db);
      const issue = await repository.report(ownerId, {
        fingerprint: 'postgres-transient-recovery',
        source: 'failure',
        title: 'Synthetic provider outage',
        summary: 'Pre-dispatch recovery fixture',
      });
      const object = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('temporary provider outage'), {
            name: 'AI_APICallError',
            statusCode: 503,
          }),
        )
        .mockResolvedValueOnce({
          ok: true,
          modelId: 'test/offline',
          degraded: false,
          object: {
            category: 'bug',
            diagnosis: 'A synthetic state guard is incorrect',
            targetPaths: ['packages/core/src/chat.ts'],
            reproduction: 'Run the deterministic fixture',
            acceptance: 'The synthetic state guard passes',
          },
        });
      const dispatch = vi.fn(async () => {});
      const deps = (freshRepository: ReturnType<typeof createPostgresSelfRepairRepository>) => ({
        repository: freshRepository,
        audit: { task: vi.fn(async () => null), read: vi.fn(async () => []) },
        router: { object, route: vi.fn() } as never,
        worker: {
          dispatch,
          inspect: vi.fn(async () => null),
          deployed: vi.fn(async () => false),
        },
        enabled: true,
        allowExecutor: false,
        dailyLimit: 2,
        notify: vi.fn(async () => {}),
      });
      const now = new Date();
      expect(await runRepairCycle(deps(repository), ownerId, taskA, now)).toBe(0);
      const persisted = (await createPostgresSelfRepairRepository(db).list(ownerId)).find(
        (row) => row.id === issue.id,
      );
      expect(persisted).toMatchObject({
        status: 'reported',
        data: {
          preDispatchRetryCount: 1,
          investigationTaskIds: [taskA],
          routerAttempts: [expect.objectContaining({ classification: 'transient' })],
        },
      });
      expect(dispatch).not.toHaveBeenCalled();
      const eligibleAt = new Date(persisted?.data.nextEligibleAt ?? '');
      expect(eligibleAt.getTime()).toBe(now.getTime() + 60_000);
      expect(
        await runRepairCycle(deps(createPostgresSelfRepairRepository(db)), ownerId, taskB, now),
      ).toBe(0);
      expect(object).toHaveBeenCalledOnce();
      expect(
        await runRepairCycle(
          deps(createPostgresSelfRepairRepository(db)),
          ownerId,
          taskB,
          eligibleAt,
        ),
      ).toBe(1);
      const recovered = (await createPostgresSelfRepairRepository(db).list(ownerId)).find(
        (row) => row.id === issue.id,
      );
      expect(recovered).toMatchObject({
        status: 'fixing',
        data: { investigationTaskIds: [taskA, taskB], preDispatchRetryCount: 1 },
      });
      expect(object).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledOnce();
    },
  );
});
