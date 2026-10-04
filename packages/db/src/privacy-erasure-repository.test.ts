import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { createDb } from './client.js';
import {
  createPostgresPrivacyErasureRepository,
  postgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import {
  agents,
  importSources,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  maintenanceCursors,
  memories,
  memoryTombstones,
  ownerCard,
  situationPacks,
  situationPreviews,
  tasks,
  voiceProfile,
  writingSamples,
} from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe('PostgreSQL privacy erasure repository', () => {
  it('matches all erasure domains and keeps assets recoverable until acknowledged', async () => {
    if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
      throw new Error('Requires isolated _test database');
    const db = createDb(DATABASE_URL);
    try {
      await expect(
        db.transaction(async (tx) => {
          const owners = await tx.select({ id: agents.id }).from(agents).limit(2);
          if (owners.length !== 1 || !owners[0]) throw new Error('Test requires one owner');
          const agentId = owners[0].id;
          const memoryId = randomUUID();
          const hash = `privacy-${randomUUID()}`;
          const left = randomUUID();
          const right = randomUUID();
          const relationId = randomUUID();
          const packId = randomUUID();
          const previewId = randomUUID();
          const taskId = randomUUID();
          const sourceId = randomUUID();
          const sampleId = randomUUID();
          await tx.insert(memories).values({
            id: memoryId,
            agentId,
            category: 'knowledge',
            kind: 'fact',
            content: 'private',
            contentHash: hash,
          });
          await tx.insert(knowledgeGraphEntities).values([
            { id: left, agentId, canonicalKey: `left:${left}`, label: 'Left', kind: 'topic' },
            { id: right, agentId, canonicalKey: `right:${right}`, label: 'Right', kind: 'topic' },
          ]);
          await tx.insert(knowledgeGraphRelations).values({
            id: relationId,
            agentId,
            subjectEntityId: left,
            objectEntityId: right,
            sourceMemoryId: memoryId,
            predicate: 'relates_to',
            sourceFingerprint: hash,
            ordinal: 0,
          });
          await tx.insert(situationPacks).values({
            id: packId,
            agentId,
            creationKey: `privacy-${packId}`,
            title: 'Plan',
            data: { title: 'Plan', decisions: [{ reason: 'private' }] },
          });
          await tx.insert(situationPreviews).values({
            id: previewId,
            packId,
            baseVersion: 1,
            sourceHash: hash,
            data: { reason: 'private' },
            expiresAt: new Date('2027-01-01'),
          });
          await tx
            .insert(tasks)
            .values({ id: taskId, agentId, type: 'scheduled', status: 'running' });
          await tx.insert(importSources).values({
            id: sourceId,
            agentId,
            taskId,
            source: `voice-samples-${sourceId}`,
            workspacePath: 'import/voice.txt',
            kind: 'text',
          });
          await tx
            .insert(writingSamples)
            .values({ id: sampleId, register: 'chat', text: 'private' });
          const repository = createPostgresPrivacyErasureRepository(tx as unknown as Db);
          const beforeErasure = await postgresPrivacyObservationFence(tx as unknown as Db, agentId);
          await expect(repository.erase()).resolves.toEqual({
            memories: 1,
            graphRelations: 1,
            writingSamples: 1,
          });
          await expect(repository.pendingAssets()).resolves.toEqual([
            { id: sourceId, workspacePath: 'import/voice.txt' },
          ]);
          await expect(repository.erase()).resolves.toEqual({
            memories: 1,
            graphRelations: 1,
            writingSamples: 1,
          });
          expect(
            (await tx.select().from(memoryTombstones).where(eq(memoryTombstones.contentHash, hash)))
              .length,
          ).toBe(1);
          expect((await tx.select().from(memories).where(eq(memories.id, memoryId))).length).toBe(
            0,
          );
          expect(
            (
              await tx
                .select()
                .from(knowledgeGraphRelations)
                .where(eq(knowledgeGraphRelations.id, relationId))
            ).length,
          ).toBe(0);
          expect(
            (await tx.select().from(situationPreviews).where(eq(situationPreviews.id, previewId)))
              .length,
          ).toBe(0);
          expect(
            (await tx.select().from(situationPacks).where(eq(situationPacks.id, packId)))[0],
          ).toMatchObject({
            version: 2,
            data: { title: 'Plan', decisions: [] },
          });
          expect((await tx.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe(
            'cancelled',
          );
          expect((await tx.select().from(ownerCard))[0]?.content).toBe('');
          expect((await tx.select().from(voiceProfile))[0]?.description).toBe('');
          await expect(repository.complete()).rejects.toThrow('assets remain');
          await repository.assetDeleted(sourceId);
          await repository.complete();
          const afterErasure = await postgresPrivacyObservationFence(tx as unknown as Db, agentId);
          expect(afterErasure).toEqual(expect.any(String));
          expect(afterErasure).not.toBe(beforeErasure);
          expect(
            (
              await tx
                .select()
                .from(maintenanceCursors)
                .where(eq(maintenanceCursors.name, `privacy-erasure-asset:${agentId}:${sourceId}`))
            ).length,
          ).toBe(0);
          throw new Error('rollback privacy erasure fixture');
        }),
      ).rejects.toThrow('rollback privacy erasure fixture');
    } finally {
      await db.$client.end();
    }
  });

  it('refuses installation-wide erasure with a second configured owner', async () => {
    if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
      throw new Error('Requires isolated _test database');
    const db = createDb(DATABASE_URL);
    try {
      await expect(
        db.transaction(async (tx) => {
          const id = randomUUID();
          await tx.insert(agents).values({
            id,
            name: 'Second owner',
            email: `second-${id}@example.test`,
            workspacePrefix: id,
          });
          await expect(
            createPostgresPrivacyErasureRepository(tx as unknown as Db).erase(),
          ).rejects.toThrow('exactly one configured owner');
          throw new Error('rollback second owner fixture');
        }),
      ).rejects.toThrow('rollback second owner fixture');
    } finally {
      await db.$client.end();
    }
  });
});
