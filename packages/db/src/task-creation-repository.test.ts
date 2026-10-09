import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { agents, tasks } from './schema.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';
import { assertAllocatedTestTarget } from './test-target.js';

it('round-trips the numeric(8,4) task budget maximum and rejects overflow before insert', async () => {
  const url = process.env.DATABASE_URL;
  assertAllocatedTestTarget({
    databaseUrl: url,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    kind: 'standard',
  });
  if (!url) throw new Error('Missing allocated test database URL');
  const db = createDb(url);
  const invalidEventId = randomUUID();
  try {
    await expect(
      db.transaction(async (tx) => {
        const [agent] = await tx.select().from(agents).limit(1);
        if (!agent) throw new Error('Seed the test database');
        const repository = createPostgresTaskRepository(tx as unknown as Db);
        const created = await repository.createTask({
          agentId: agent.id,
          type: 'adhoc',
          trust: 'owner',
          trigger: {},
          budgetUsdLimit: '9999.9999',
        });
        expect(created.task.budgetUsdLimit).toBe('9999.9999');
        const [stored] = await tx.select().from(tasks).where(eq(tasks.id, created.task.id));
        expect(stored?.budgetUsdLimit).toBe('9999.9999');
        await expect(
          repository.createTask({
            agentId: agent.id,
            type: 'adhoc',
            trust: 'owner',
            trigger: {},
            budgetUsdLimit: '10000.0000',
            externalEventId: invalidEventId,
          }),
        ).rejects.toThrow('task budget precision');
        expect(
          await tx.select().from(tasks).where(eq(tasks.externalEventId, invalidEventId)),
        ).toEqual([]);
        throw new Error('rollback task budget boundary fixture');
      }),
    ).rejects.toThrow('rollback task budget boundary fixture');
  } finally {
    await db.$client.end();
  }
});

it('task creation inside a larger PostgreSQL transaction rolls back with its caller', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated test database');
  const db = createDb(url);
  const externalEventId = randomUUID();
  try {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    await expect(
      db.transaction(async (tx) => {
        await createPostgresTaskRepository(tx as unknown as Db).createTask({
          agentId: agent.id,
          type: 'adhoc',
          trust: 'owner',
          trigger: {},
          externalEventId,
        });
        throw new Error('outer transaction failed');
      }),
    ).rejects.toThrow('outer transaction failed');
    expect(await db.select().from(tasks).where(eq(tasks.externalEventId, externalEventId))).toEqual(
      [],
    );
  } finally {
    await db.$client.end();
  }
});

it('rejects a generic child outside its parent owner before creating any task', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated test database');
  const db = createDb(url);
  try {
    await expect(
      db.transaction(async (tx) => {
        const [owner] = await tx.select().from(agents).limit(1);
        if (!owner) throw new Error('Seed the test database');
        const [foreign] = await tx
          .insert(agents)
          .values({
            name: 'Task parent ownership fixture',
            email: `${randomUUID()}@example.test`,
            workspacePrefix: `task-parent/${randomUUID()}`,
          })
          .returning();
        if (!foreign) throw new Error('Missing foreign owner fixture');
        const repo = createPostgresTaskRepository(tx as unknown as Db);
        const parent = await repo.createTask({
          agentId: foreign.id,
          type: 'adhoc',
          trust: 'owner',
          trigger: {},
        });
        const operation = randomUUID();
        await expect(
          repo.createTask({
            agentId: owner.id,
            type: 'adhoc',
            trust: 'owner',
            trigger: {},
            parentTaskId: parent.task.id,
            externalEventId: operation,
          }),
        ).rejects.toThrow('Task parent is missing or belongs to another agent');
        expect(await tx.select().from(tasks).where(eq(tasks.externalEventId, operation))).toEqual(
          [],
        );
        const child = await repo.createTask({
          agentId: foreign.id,
          type: 'adhoc',
          trust: 'owner',
          trigger: {},
          parentTaskId: parent.task.id,
        });
        expect(child.created).toBe(true);
        expect(child.task.parentTaskId).toBe(parent.task.id);
        throw new Error('ownership fixture rollback');
      }),
    ).rejects.toThrow('ownership fixture rollback');
  } finally {
    await db.$client.end();
  }
});
