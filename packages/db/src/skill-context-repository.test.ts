import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { agents, skills } from './schema.js';
import { createPostgresSkillContextRepository } from './skill-context-repository.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';
const SPACE_KEY = 'a'.repeat(64);

function vector(x: number, y = 0): number[] {
  return [x, y, ...new Array(1534).fill(0)];
}

describe('PostgreSQL learned-skill context', () => {
  const ownerId = randomUUID();
  const foreignOwnerId = randomUUID();
  const skillIds = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000005',
  ];
  let db: Db;
  let repository: ReturnType<typeof createPostgresSkillContextRepository>;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    repository = createPostgresSkillContextRepository(db);
    await db.insert(agents).values([
      {
        id: ownerId,
        name: 'Skill context owner',
        email: `${ownerId}@test.local`,
        workspacePrefix: `tests/${ownerId}`,
      },
      {
        id: foreignOwnerId,
        name: 'Foreign skill owner',
        email: `${foreignOwnerId}@test.local`,
        workspacePrefix: `tests/${foreignOwnerId}`,
      },
    ]);
    await db.insert(skills).values([
      {
        id: skillIds[0],
        agentId: ownerId,
        name: 'first equal match',
        steps: 'first',
        embedding: vector(1),
        embeddingSpaceKey: SPACE_KEY,
      },
      {
        id: skillIds[1],
        agentId: ownerId,
        name: 'second equal match',
        steps: 'second',
        embedding: vector(1),
        embeddingSpaceKey: SPACE_KEY,
      },
      {
        id: skillIds[2],
        agentId: ownerId,
        name: 'below threshold',
        steps: 'low',
        embedding: vector(0.7, Math.sqrt(1 - 0.7 ** 2)),
        embeddingSpaceKey: SPACE_KEY,
      },
      {
        id: skillIds[3],
        agentId: ownerId,
        name: 'already deprecated',
        steps: 'old',
        embedding: vector(1),
        embeddingSpaceKey: SPACE_KEY,
        deprecated: true,
      },
      {
        id: skillIds[4],
        agentId: foreignOwnerId,
        name: 'foreign exact match',
        steps: 'private',
        embedding: vector(1),
        embeddingSpaceKey: SPACE_KEY,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(skills).where(inArray(skills.id, skillIds));
    await db.delete(agents).where(inArray(agents.id, [ownerId, foreignOwnerId]));
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  });

  it('recalls only active owner skills above threshold with a stable limit', async () => {
    const matches = await repository.recall({
      agentId: ownerId,
      embedding: vector(1),
      embeddingSpaceKey: SPACE_KEY,
      limit: 1,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      skill: { id: skillIds[0], agentId: ownerId, name: 'first equal match' },
      similarity: 1,
    });
    expect(matches[0]?.skill).not.toHaveProperty('embedding');

    const all = await repository.recall({
      agentId: ownerId,
      embedding: vector(1),
      embeddingSpaceKey: SPACE_KEY,
      limit: 10,
    });
    expect(all.map((match) => match.skill.id)).toEqual([skillIds[0], skillIds[1]]);
    await expect(
      repository.recall({
        agentId: ownerId,
        embedding: vector(1).slice(1),
        embeddingSpaceKey: SPACE_KEY,
      }),
    ).rejects.toThrow('embedding');
  });

  it('atomically increments owner counters and deprecates on the third failure', async () => {
    await Promise.all(
      Array.from({ length: 12 }, () =>
        repository.bumpUse({ agentId: ownerId, ids: [skillIds[0] as string] }),
      ),
    );
    await repository.bumpUse({ agentId: foreignOwnerId, ids: [skillIds[0] as string] });
    await Promise.all(
      Array.from({ length: 7 }, () =>
        repository.recordOutcome({ agentId: ownerId, id: skillIds[1] as string, success: true }),
      ),
    );
    await repository.recordOutcome({
      agentId: foreignOwnerId,
      id: skillIds[1] as string,
      success: true,
    });
    await Promise.all(
      Array.from({ length: 3 }, () =>
        repository.recordOutcome({ agentId: ownerId, id: skillIds[0] as string, success: false }),
      ),
    );

    const [failed] = await db
      .select()
      .from(skills)
      .where(and(eq(skills.id, skillIds[0] as string), eq(skills.agentId, ownerId)));
    const [successful] = await db
      .select()
      .from(skills)
      .where(and(eq(skills.id, skillIds[1] as string), eq(skills.agentId, ownerId)));
    expect(failed).toMatchObject({ useCount: 12, failureCount: 3, deprecated: true });
    expect(successful).toMatchObject({ successCount: 7, deprecated: false });
    expect(successful?.lastVerifiedAt).toBeInstanceOf(Date);

    const recalled = await repository.recall({
      agentId: ownerId,
      embedding: vector(1),
      embeddingSpaceKey: SPACE_KEY,
    });
    expect(recalled.map((match) => match.skill.id)).not.toContain(skillIds[0]);
  });
});
