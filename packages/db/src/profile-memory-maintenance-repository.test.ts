import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { createPostgresProfileMemoryMaintenance } from './profile-memory-maintenance-repository.js';
import {
  agents,
  knowledgeGraphAssertionEvidence,
  knowledgeGraphAssertions,
  knowledgeGraphEntities,
  knowledgeGraphEntityAliases,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
  tasks,
} from './schema.js';
import { createTask } from './task-creation-repository.js';

describe('PostgreSQL profile memory maintenance', () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const now = new Date('2026-09-19T22:14:37Z');
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const repository = createPostgresProfileMemoryMaintenance(
    db,
    async (input) => {
      await createTask(db, input);
    },
    () => now,
  );

  beforeAll(async () => {
    await db.insert(agents).values([
      {
        id: agentId,
        name: 'Graph maintenance owner',
        email: `${agentId}@example.test`,
        workspacePrefix: `test/${agentId}`,
      },
      {
        id: foreignAgentId,
        name: 'Graph maintenance foreign owner',
        email: `${foreignAgentId}@example.test`,
        workspacePrefix: `test/${foreignAgentId}`,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(tasks).where(eq(tasks.agentId, agentId));
    await db.delete(memories).where(eq(memories.agentId, agentId));
    await db.delete(memories).where(eq(memories.agentId, foreignAgentId));
    await db.delete(knowledgeGraphEntities).where(eq(knowledgeGraphEntities.agentId, agentId));
    await db
      .delete(knowledgeGraphEntities)
      .where(eq(knowledgeGraphEntities.agentId, foreignAgentId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(agents).where(eq(agents.id, foreignAgentId));
    await db.$client.end();
  });

  it('deduplicates graph sync work and retries only the owned blocked source', async () => {
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: 'Graph retry fixture',
        contentHash: randomUUID(),
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('Memory fixture missing');
    await db.insert(knowledgeGraphSources).values({
      memoryId: memory.id,
      contentHash: randomUUID(),
      status: 'quarantined',
      attempts: 4,
      lastError: 'blocked',
    });

    await repository.retryBlockedGraphSource({ agentId: foreignAgentId, memoryId: memory.id });
    expect((await db.select().from(knowledgeGraphSources))[0]?.status).toBe('quarantined');
    await repository.retryBlockedGraphSource({ agentId, memoryId: memory.id });
    const [source] = await db
      .select()
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    expect(source).toMatchObject({ status: 'failed', attempts: 0, lastError: null });
    expect(source?.nextRetryAt).toEqual(now);

    await Promise.all([
      repository.queueGraphSync({ agentId, memoryId: memory.id }),
      repository.queueGraphSync({ agentId, memoryId: memory.id }),
    ]);
    const queued = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agentId),
          eq(tasks.externalEventId, `profile:graph-sync:${memory.id}:2026-09-19T22:14`),
        ),
      );
    expect(queued).toHaveLength(1);
    await db
      .update(tasks)
      .set({ status: 'done' })
      .where(eq(tasks.id, queued[0]?.id ?? ''));
    await repository.queueGraphSync({ agentId, memoryId: memory.id });
    expect(
      await db
        .select()
        .from(tasks)
        .where(eq(tasks.externalEventId, `profile:graph-sync:${memory.id}:2026-09-19T22:14`)),
    ).toHaveLength(1);
  });

  it('removes orphan aliases while retaining shared and foreign graph entities', async () => {
    const insertedMemories = await db
      .insert(memories)
      .values([
        {
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: 'Forgotten projection fixture',
          contentHash: randomUUID(),
        },
        {
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: 'Retained projection fixture',
          contentHash: randomUUID(),
        },
      ])
      .returning({ id: memories.id, contentHash: memories.contentHash });
    const forgotten = insertedMemories[0];
    const retained = insertedMemories[1];
    if (!forgotten || !retained) throw new Error('Memory fixtures missing');
    await db.insert(knowledgeGraphSources).values([
      { memoryId: forgotten.id, contentHash: forgotten.contentHash, status: 'ready' },
      { memoryId: retained.id, contentHash: retained.contentHash, status: 'ready' },
    ]);
    const entityRows = await db
      .insert(knowledgeGraphEntities)
      .values([
        { agentId, canonicalKey: `topic:${randomUUID()}`, label: 'orphan', kind: 'topic' },
        { agentId, canonicalKey: `topic:${randomUUID()}`, label: 'shared', kind: 'topic' },
        { agentId, canonicalKey: `topic:${randomUUID()}`, label: 'retained', kind: 'topic' },
        {
          agentId: foreignAgentId,
          canonicalKey: `topic:${randomUUID()}`,
          label: 'foreign',
          kind: 'topic',
        },
      ])
      .returning({ id: knowledgeGraphEntities.id, label: knowledgeGraphEntities.label });
    const entity = (label: string) => {
      const found = entityRows.find((row) => row.label === label);
      if (!found) throw new Error(`Entity fixture missing: ${label}`);
      return found;
    };
    await db.insert(knowledgeGraphEntityAliases).values([
      { agentId, canonicalKey: `topic:${randomUUID()}`, entityId: entity('orphan').id },
      { agentId, canonicalKey: `topic:${randomUUID()}`, entityId: entity('shared').id },
      {
        agentId: foreignAgentId,
        canonicalKey: `topic:${randomUUID()}`,
        entityId: entity('foreign').id,
      },
    ]);
    await db.insert(knowledgeGraphRelations).values([
      {
        agentId,
        subjectEntityId: entity('orphan').id,
        predicate: 'relates_to',
        objectEntityId: entity('shared').id,
        sourceMemoryId: forgotten.id,
        sourceFingerprint: randomUUID(),
        ordinal: 1,
      },
      {
        agentId,
        subjectEntityId: entity('shared').id,
        predicate: 'relates_to',
        objectEntityId: entity('retained').id,
        sourceMemoryId: retained.id,
        sourceFingerprint: randomUUID(),
        ordinal: 1,
      },
    ]);

    await db.delete(memories).where(eq(memories.id, forgotten.id));
    await repository.removeOrphanedGraphEntities({ agentId, memoryId: forgotten.id });
    await repository.removeOrphanedGraphEntities({ agentId, memoryId: forgotten.id });

    expect(
      await db
        .select()
        .from(knowledgeGraphEntities)
        .where(eq(knowledgeGraphEntities.id, entity('orphan').id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(knowledgeGraphEntities)
        .where(eq(knowledgeGraphEntities.id, entity('shared').id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(knowledgeGraphEntities)
        .where(eq(knowledgeGraphEntities.id, entity('foreign').id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(knowledgeGraphEntityAliases)
        .where(eq(knowledgeGraphEntityAliases.entityId, entity('orphan').id)),
    ).toHaveLength(0);
  });

  it('removes forgotten evidence without cascading canonical owner review through endpoints', async () => {
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: 'Forgotten canonical quote',
        contentHash: randomUUID(),
      })
      .returning();
    if (!memory) throw new Error('Missing canonical memory');
    const endpoints = await db
      .insert(knowledgeGraphEntities)
      .values([
        {
          agentId,
          canonicalKey: `person:${randomUUID()}`,
          label: 'Reviewed person',
          kind: 'person',
        },
        { agentId, canonicalKey: `place:${randomUUID()}`, label: 'Reviewed place', kind: 'place' },
      ])
      .returning();
    const [subject, object] = endpoints;
    if (!subject || !object) throw new Error('Missing canonical endpoints');
    const assertionId = randomUUID();
    await db.insert(knowledgeGraphAssertions).values({
      id: assertionId,
      agentId,
      semanticKey: randomUUID(),
      subjectEntityId: subject.id,
      objectEntityId: object.id,
      predicate: 'lives_in',
      assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
      reviewStatus: 'confirmed',
      ownerAuthored: true,
      reviewedRevision: 1,
      reviewedPayloadHash: 'owner-review-hash',
    });
    await db.insert(knowledgeGraphAssertionEvidence).values({
      id: randomUUID(),
      agentId,
      assertionId,
      sourceMemoryId: memory.id,
      sourceFingerprint: randomUUID(),
      sourceContentHash: memory.contentHash,
      evidenceQuote: memory.content,
      extractionVersion: 4,
      observedAt: now,
    });
    await db.delete(memories).where(eq(memories.id, memory.id));
    await repository.removeOrphanedGraphEntities({ agentId, memoryId: memory.id });
    await repository.removeOrphanedGraphEntities({ agentId, memoryId: memory.id });
    expect(
      await db
        .select()
        .from(knowledgeGraphAssertionEvidence)
        .where(eq(knowledgeGraphAssertionEvidence.assertionId, assertionId)),
    ).toHaveLength(0);
    expect(
      (
        await db
          .select()
          .from(knowledgeGraphAssertions)
          .where(eq(knowledgeGraphAssertions.id, assertionId))
      )[0],
    ).toMatchObject({
      reviewStatus: 'confirmed',
      ownerAuthored: true,
      reviewedRevision: 1,
      reviewedPayloadHash: 'owner-review-hash',
    });
    for (const endpoint of endpoints)
      expect(
        await db
          .select()
          .from(knowledgeGraphEntities)
          .where(eq(knowledgeGraphEntities.id, endpoint.id)),
      ).toHaveLength(1);
  });

  it('refuses a hostile agent and memory pairing', async () => {
    const [memory] = await db
      .insert(memories)
      .values({
        agentId: foreignAgentId,
        category: 'knowledge',
        kind: 'fact',
        content: 'Foreign cleanup fixture',
        contentHash: randomUUID(),
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('Foreign memory fixture missing');
    await db.insert(knowledgeGraphSources).values({
      memoryId: memory.id,
      contentHash: randomUUID(),
      status: 'ready',
    });
    await expect(
      repository.removeOrphanedGraphEntities({ agentId, memoryId: memory.id }),
    ).rejects.toThrow('another agent');
    expect(
      await db
        .select()
        .from(knowledgeGraphSources)
        .where(eq(knowledgeGraphSources.memoryId, memory.id)),
    ).toHaveLength(1);
  });
});
