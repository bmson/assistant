import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { signalContract } from '../../persistence/src/signal-test-scenarios.js';
import { createDb, type Db } from './client.js';
import { withDisposableTestDatabase } from './disposable-test-database.js';
import { agents, emailIngest } from './schema.js';
import { createPostgresSignalRepository } from './signals.js';

function seedOwner(db: Db, agentId: string) {
  return db.insert(agents).values({
    id: agentId,
    name: 'Fixture owner',
    email: `${agentId}@example.test`,
    workspacePrefix: agentId,
  });
}

async function withSignalDatabase<T>(run: (db: Db) => Promise<T>): Promise<T> {
  return withDisposableTestDatabase(async (_client, databaseUrl) => {
    const db = createDb(databaseUrl);
    try {
      return await run(db);
    } finally {
      await db.$client.end({ timeout: 5 });
    }
  });
}

describe('PostgreSQL producer signal contract', () => {
  signalContract((run) =>
    withSignalDatabase((db) =>
      run({
        repository: createPostgresSignalRepository(db),
        async seedOwner(agentId) {
          await seedOwner(db, agentId);
        },
        async seedSource(row) {
          await db.insert(emailIngest).values(row);
        },
      }),
    ),
  );

  it('keeps fixture owners and sources out of the shared database when a concurrent write fails', async () => {
    const sharedUrl = process.env.DATABASE_URL;
    if (!sharedUrl) throw new Error('Run through the disposable database test wrapper');
    const shared = createDb(sharedUrl);
    const owner = randomUUID();
    const otherOwner = randomUUID();
    const ownerIds = [owner, otherOwner];
    let fixtureDatabase: string | undefined;
    try {
      await expect(
        withSignalDatabase(async (db) => {
          const [database] = await db.$client<
            { name: string }[]
          >`SELECT current_database() AS name`;
          fixtureDatabase = database?.name;
          await seedOwner(db, owner);
          await db.insert(emailIngest).values({
            agentId: owner,
            channelMessageId: 'gmail:synthetic-failure-fixture',
            fromEmail: 'sender@example.test',
          });
          await Promise.all([seedOwner(db, owner), seedOwner(db, otherOwner)]);
        }),
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      if (!fixtureDatabase) throw new Error('Fixture database identity was unavailable');
      expect(new URL(sharedUrl).pathname).not.toBe(`/${fixtureDatabase}`);
      expect(
        await shared.$client`SELECT datname FROM pg_database WHERE datname = ${fixtureDatabase}`,
      ).toEqual([]);
      expect(await shared.select().from(agents).where(inArray(agents.id, ownerIds))).toEqual([]);
      expect(
        await shared.select().from(emailIngest).where(inArray(emailIngest.agentId, ownerIds)),
      ).toEqual([]);
    } finally {
      await shared.$client.end();
    }
  });
});
