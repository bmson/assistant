import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresModelRoutingRepository } from './model-routing-repository.js';
import { modelCalls } from './schema.js';
import { assertAllocatedTestTarget } from './test-target.js';

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL;
  assertAllocatedTestTarget({
    databaseUrl: url,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    kind: 'standard',
  });
  if (!url) throw new Error('Missing allocated test database URL');
  return url;
})();

describe('PostgreSQL model-call money bounds', () => {
  let db: Db;
  let insertedIds: string[];

  beforeEach(() => {
    db = createDb(DATABASE_URL);
    insertedIds = [];
  });

  afterEach(async () => {
    try {
      for (const id of insertedIds) {
        await db.delete(modelCalls).where(eq(modelCalls.id, id));
      }
    } finally {
      await db.$client.end();
    }
  });

  it('stores the common numeric(10,6) maximum and rejects the next whole dollar before insert', async () => {
    const repository = createPostgresModelRoutingRepository(db);
    const base = {
      role: 'draft',
      model: 'fixture/model',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: '9999.999999',
    };
    const id = await repository.recordCall(base);
    insertedIds.push(id);
    const [stored] = await db.select().from(modelCalls).where(eq(modelCalls.id, id));
    expect(stored?.costUsd).toBe('9999.999999');

    await expect(repository.recordCall({ ...base, costUsd: '10000.000000' })).rejects.toThrow(
      'numeric(10,6)',
    );
    expect(await db.select().from(modelCalls).where(eq(modelCalls.id, id))).toHaveLength(1);
  });
});
