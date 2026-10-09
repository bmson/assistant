import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  agents,
  contacts,
  createDb,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  maintenanceCursors,
  memories,
  occasions,
} from '@assistant/db';
import { assertAllocatedTestTarget, isolatedTestEnvironment } from '@assistant/db/test-target';
import { eq, inArray, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./demo-people.ts', import.meta.url));
const cwd = fileURLToPath(new URL('../', import.meta.url));

it('preserves genuine same-key owner and foreign graph data through seed, reseed and purge', async () => {
  const databaseName = assertAllocatedTestTarget({
    databaseUrl: process.env.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing allocated target');
  const db = createDb(databaseUrl);
  const ownerId = randomUUID();
  const foreignId = randomUUID();
  const genuineContacts = [randomUUID(), randomUUID()];
  const genuineMemories = [randomUUID(), randomUUID()];
  const genuineEntities = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const genuineRelations = [randomUUID(), randomUUID()];
  const genuineOccasions = [randomUUID(), randomUUID()];
  const env = isolatedTestEnvironment(process.env);
  const run = (args: string[], childEnv = env) =>
    exec('pnpm', ['exec', 'tsx', script, ...args], {
      cwd,
      env: childEnv,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
  const snapshot = async () => ({
    contacts: await db.select().from(contacts).where(inArray(contacts.id, genuineContacts)),
    memories: await db.select().from(memories).where(inArray(memories.id, genuineMemories)),
    entities: await db
      .select()
      .from(knowledgeGraphEntities)
      .where(inArray(knowledgeGraphEntities.id, genuineEntities)),
    relations: await db
      .select()
      .from(knowledgeGraphRelations)
      .where(inArray(knowledgeGraphRelations.id, genuineRelations)),
    sources: await db
      .select()
      .from(knowledgeGraphSources)
      .where(inArray(knowledgeGraphSources.memoryId, genuineMemories)),
    occasions: await db.select().from(occasions).where(inArray(occasions.id, genuineOccasions)),
  });
  try {
    for (const [index, agentId] of [ownerId, foreignId].entries()) {
      const contactId = genuineContacts[index];
      const memoryId = genuineMemories[index];
      const subjectId = genuineEntities[index * 2];
      const placeId = genuineEntities[index * 2 + 1];
      if (!contactId || !memoryId || !subjectId || !placeId) throw new Error('Fixture IDs missing');
      await db.insert(agents).values({
        id: agentId,
        name: 'Independent synthetic owner',
        email: `${agentId}@example.test`,
        workspacePrefix: `demo-safety/${agentId}`,
      });
      await db.insert(contacts).values({
        id: contactId,
        name: 'Élise Aubert',
        notes: 'Genuine synthetic contact; preserve all fields',
        emails: ['independent@example.test'],
        trust: 'known',
      });
      await db.insert(memories).values({
        id: memoryId,
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: 'A genuine synthetic relationship',
        contentHash: createHash('sha256').update(memoryId).digest('hex'),
        source: 'manual',
        subjectContactId: contactId,
      });
      await db.insert(knowledgeGraphEntities).values([
        {
          id: subjectId,
          agentId,
          canonicalKey: `contact:${contactId}`,
          label: 'Genuine person',
          preferredLabel: 'Keep preferred label',
          kind: 'person',
          contactId,
        },
        {
          id: placeId,
          agentId,
          canonicalKey: 'place:lyon',
          label: 'Genuine Lyon label',
          preferredLabel: 'Keep place curation',
          kind: 'place',
        },
      ]);
      await db.insert(knowledgeGraphSources).values({
        memoryId,
        contentHash: createHash('sha256').update(memoryId).digest('hex'),
        subjectContactId: contactId,
        status: 'ready',
      });
      await db.insert(knowledgeGraphRelations).values({
        id: genuineRelations[index],
        agentId,
        subjectEntityId: subjectId,
        objectEntityId: placeId,
        predicate: 'lives_in',
        sourceMemoryId: memoryId,
        sourceFingerprint: memoryId,
        ordinal: 0,
        evidenceQuote: 'A genuine synthetic relationship',
        reviewStatus: 'confirmed',
      });
      await db.insert(occasions).values({
        id: genuineOccasions[index],
        agentId,
        contactId,
        kind: 'birthday',
        month: 3,
        day: 18,
        source: 'manual',
      });
    }
    const genuine = await snapshot();
    const bytes = JSON.stringify(genuine);
    // The allocator token is required before opening or writing any DB.
    await expect(
      run(['--agent', ownerId], { ...env, ASSISTANT_TEST_TARGET_TOKEN: '' }),
    ).rejects.toThrow();
    expect(JSON.stringify(await snapshot())).toBe(bytes);
    await expect(run(['--agent', ownerId], { ...env, NODE_ENV: 'production' })).rejects.toThrow();
    const ordinaryUrl = new URL(databaseUrl);
    ordinaryUrl.pathname = '/assistant';
    await expect(
      run(['--agent', ownerId], {
        ...env,
        DATABASE_URL: ordinaryUrl.toString(),
        TEST_DATABASE_URL: ordinaryUrl.toString(),
      }),
    ).rejects.toThrow('Database name does not match');
    expect(JSON.stringify(await snapshot())).toBe(bytes);
    await db.execute(sql.raw(`COMMENT ON DATABASE "${databaseName}" IS 'unowned-demo-control'`));
    try {
      await expect(run(['--agent', ownerId])).rejects.toThrow('ownership mismatch');
      expect(JSON.stringify(await snapshot())).toBe(bytes);
    } finally {
      await db.execute(
        sql.raw(
          `COMMENT ON DATABASE "${databaseName}" IS 'assistant-test-target:${env.ASSISTANT_TEST_TARGET_TOKEN}'`,
        ),
      );
    }
    await expect(run([])).rejects.toThrow('Choose the demo owner explicitly');
    expect(JSON.stringify(await snapshot())).toBe(bytes);
    await run(['--agent', ownerId]);
    expect(JSON.stringify(await snapshot())).toBe(bytes);
    const [firstLedger] = await db
      .select()
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `fixture:demo-people:${ownerId}`));
    const first = JSON.parse(firstLedger?.cursor ?? 'null');
    expect(first.contacts).toHaveLength(7);
    expect(first.entities.length).toBeGreaterThan(7);
    await run(['--agent', ownerId]);
    expect(JSON.stringify(await snapshot())).toBe(bytes);
    expect(await db.select().from(contacts).where(inArray(contacts.id, first.contacts))).toEqual(
      [],
    );
    expect(await db.select().from(memories).where(inArray(memories.id, first.memories))).toEqual(
      [],
    );
    expect(
      await db
        .select()
        .from(knowledgeGraphEntities)
        .where(inArray(knowledgeGraphEntities.id, first.entities)),
    ).toEqual([]);
    const [secondLedger] = await db
      .select()
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `fixture:demo-people:${ownerId}`));
    const second = JSON.parse(secondLedger?.cursor ?? 'null');
    // Force failure after contacts and graph nodes have been inserted. The
    // previous committed fixture and genuine rows must survive the rollback.
    await db.execute(
      sql.raw(
        `CREATE FUNCTION demo_fixture_test_failure() RETURNS trigger AS $$ BEGIN IF NEW.source LIKE 'demo-people:${ownerId}:%' THEN RAISE EXCEPTION 'Synthetic demo fixture failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`,
      ),
    );
    await db.execute(
      sql.raw(
        'CREATE TRIGGER demo_fixture_test_failure BEFORE INSERT ON memories FOR EACH ROW EXECUTE FUNCTION demo_fixture_test_failure()',
      ),
    );
    try {
      await expect(run(['--agent', ownerId])).rejects.toThrow('Synthetic demo fixture failure');
    } finally {
      await db.execute(sql.raw('DROP TRIGGER demo_fixture_test_failure ON memories'));
      await db.execute(sql.raw('DROP FUNCTION demo_fixture_test_failure()'));
    }
    expect(JSON.stringify(await snapshot())).toBe(bytes);
    const [afterFailure] = await db
      .select()
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `fixture:demo-people:${ownerId}`));
    expect(afterFailure).toEqual(secondLedger);
    expect(
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(inArray(contacts.id, second.contacts)),
    ).toHaveLength(7);
    await run(['--purge', '--agent', ownerId]);
    await run(['--purge', '--agent', ownerId]);
    expect(JSON.stringify(await snapshot())).toBe(bytes);
    expect(
      await db
        .select()
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, `fixture:demo-people:${ownerId}`)),
    ).toEqual([]);
  } finally {
    // Every deleted ID was generated in this fixture; the surrounding allocator
    // independently drops its owned database when this file finishes.
    const [fixtureLedger] = await db
      .select()
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `fixture:demo-people:${ownerId}`));
    const demoContactIds: string[] = fixtureLedger?.cursor
      ? JSON.parse(fixtureLedger.cursor).contacts
      : [];
    // Both owners were created by this test. Include their fixture rows so a
    // failing assertion is not masked by a cleanup foreign-key error.
    await db.delete(memories).where(inArray(memories.agentId, [ownerId, foreignId]));
    await db
      .delete(knowledgeGraphEntities)
      .where(inArray(knowledgeGraphEntities.agentId, [ownerId, foreignId]));
    await db.delete(occasions).where(inArray(occasions.agentId, [ownerId, foreignId]));
    await db.delete(contacts).where(inArray(contacts.id, [...genuineContacts, ...demoContactIds]));
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `fixture:demo-people:${ownerId}`));
    await db.delete(agents).where(inArray(agents.id, [ownerId, foreignId]));
    await db.$client.end({ timeout: 5 });
  }
}, 120000);
