import { createHash, randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { agents, memories } from './schema.js';
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

const checkName = 'memories_memory_write_witness_check';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const validWitness = () => ({
  version: 1,
  writeVersion: randomUUID(),
  contentHash: hash(`memory-write-witness:${randomUUID()}`),
  attribution: null,
});
const validAttribution = () => ({
  operationKey: hash(`operation:${randomUUID()}`),
  requestHash: hash(`request:${randomUUID()}`),
  provenanceFingerprint: hash(`provenance:${randomUUID()}`),
});

describe('PostgreSQL memory write witness structural constraint', () => {
  let db: Db;
  let agentId = '';
  const memoryIds: string[] = [];

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    const seededAgents = await db.select({ id: agents.id }).from(agents).limit(2);
    if (seededAgents.length !== 1 || !seededAgents[0])
      throw new Error('Expected exactly one isolated seeded test agent');
    agentId = seededAgents[0].id;
  });

  afterAll(async () => {
    try {
      if (memoryIds.length) await db.delete(memories).where(inArray(memories.id, memoryIds));
    } finally {
      if (db) await db.$client.end();
    }
  });

  async function insertWitness(witness: unknown): Promise<string> {
    const id = randomUUID();
    const contentHash = hash(`memory-write-witness-row:${id}`);
    memoryIds.push(id);
    const json = JSON.stringify(witness);
    await db.$client`
      INSERT INTO "memories" ("id", "agent_id", "category", "kind", "content", "content_hash", "memory_write_witness")
      VALUES (${id}, ${agentId}, 'knowledge', 'fact', 'Synthetic constraint fixture.', ${contentHash}, ${json}::jsonb)
    `;
    return id;
  }

  async function insertJsonNullWitness(): Promise<string> {
    const id = randomUUID();
    const contentHash = hash(`memory-write-witness-row:${id}`);
    memoryIds.push(id);
    await db.$client`
      INSERT INTO "memories" ("id", "agent_id", "category", "kind", "content", "content_hash", "memory_write_witness")
      VALUES (${id}, ${agentId}, 'knowledge', 'fact', 'Synthetic explicit JSON null witness.', ${contentHash}, ${JSON.stringify(null)}::jsonb)
    `;
    return id;
  }

  it('accepts legacy nulls, generic witnesses, and structurally valid attribution', async () => {
    const sqlNullId = randomUUID();
    memoryIds.push(sqlNullId);
    await db.insert(memories).values({
      id: sqlNullId,
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content: 'Legacy SQL NULL witness.',
      contentHash: hash(`memory-write-witness-row:${sqlNullId}`),
    });

    const jsonNullId = await insertJsonNullWitness();
    const genericId = await insertWitness(validWitness());
    const attributed = { ...validWitness(), attribution: validAttribution() };
    const attributedId = await insertWitness(attributed);

    const rows = await db
      .select({ id: memories.id, memoryWriteWitness: memories.memoryWriteWitness })
      .from(memories)
      .where(inArray(memories.id, [sqlNullId, jsonNullId, genericId, attributedId]));
    const nullStorageKinds = await db.$client`
      SELECT "id", "memory_write_witness" IS NULL AS "is_sql_null",
             jsonb_typeof("memory_write_witness") AS "json_type"
      FROM "memories"
      WHERE "id" IN (${sqlNullId}, ${jsonNullId}) AND "agent_id" = ${agentId}
    `;
    expect(rows).toHaveLength(4);
    expect(nullStorageKinds).toHaveLength(2);
    expect(nullStorageKinds.find((row) => row.id === sqlNullId)).toMatchObject({
      is_sql_null: true,
      json_type: null,
    });
    expect(nullStorageKinds.find((row) => row.id === jsonNullId)).toMatchObject({
      is_sql_null: false,
      json_type: 'null',
    });
    expect(rows.find((row) => row.id === sqlNullId)?.memoryWriteWitness).toBeNull();
    expect(rows.find((row) => row.id === jsonNullId)?.memoryWriteWitness).toBeNull();
    expect(rows.find((row) => row.id === genericId)?.memoryWriteWitness).toMatchObject({
      version: 1,
      attribution: null,
    });
    expect(rows.find((row) => row.id === attributedId)?.memoryWriteWitness).toMatchObject({
      attribution: {
        operationKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        provenanceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  it.each([
    ['non-object root', []],
    ['null version', { ...validWitness(), version: null }],
    ['unsupported version', { ...validWitness(), version: 2 }],
    [
      'missing top-level key',
      { version: 1, writeVersion: randomUUID(), contentHash: hash('missing-key') },
    ],
    ['extra top-level key', { ...validWitness(), unexpected: true }],
    ['invalid UUID', { ...validWitness(), writeVersion: 'not-a-uuid' }],
    ['uppercase UUID', { ...validWitness(), writeVersion: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }],
    ['null write version', { ...validWitness(), writeVersion: null }],
    ['invalid content hash', { ...validWitness(), contentHash: 'A'.repeat(64) }],
    ['null content hash', { ...validWitness(), contentHash: null }],
    ['missing attribution key', { ...validWitness(), attribution: { operationKey: hash('op') } }],
    [
      'extra attribution key',
      { ...validWitness(), attribution: { ...validAttribution(), extra: 'x' } },
    ],
    [
      'null attribution field',
      { ...validWitness(), attribution: { ...validAttribution(), requestHash: null } },
    ],
    ['attribution array', { ...validWitness(), attribution: [] }],
    ['attribution scalar', { ...validWitness(), attribution: true }],
  ])('rejects %s with the witness CHECK constraint', async (_label, witness) => {
    await expect(insertWitness(witness)).rejects.toMatchObject({
      code: '23514',
      constraint_name: checkName,
    });
  });
});
