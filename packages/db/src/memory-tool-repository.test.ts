import { createHash, randomUUID } from 'node:crypto';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { createPostgresMemoryToolRepository } from './memory-tool-repository.js';
import { agents, contacts, memories, memoryTombstones } from './schema.js';

const vector = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
const testSpaceKey = createHash('sha256').update('memory-tool-test-space').digest('hex');

describe('PostgreSQL memory tool repository', () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const memoryIds: string[] = [];
  const hashes: string[] = [];
  const contactIds: string[] = [];
  const extraAgentIds: string[] = [];

  afterEach(async () => {
    if (memoryIds.length)
      await db.delete(memories).where(inArray(memories.id, memoryIds.splice(0)));
    if (contactIds.length)
      await db.delete(contacts).where(inArray(contacts.id, contactIds.splice(0)));
    if (extraAgentIds.length)
      await db.delete(agents).where(inArray(agents.id, extraAgentIds.splice(0)));
    if (hashes.length)
      await db
        .delete(memoryTombstones)
        .where(inArray(memoryTombstones.contentHash, hashes.splice(0)));
  });

  it('saves idempotently, resolves subjects, and hybrid-ranks safe memories while bumping access', async () => {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    const repo = createPostgresMemoryToolRepository(db);
    const now = new Date('2026-09-12T12:00:00Z');
    const save = async (content: string, overrides: Record<string, unknown> = {}) => {
      const contentHash = createHash('sha256').update(`${content}-${randomUUID()}`).digest('hex');
      hashes.push(contentHash);
      const result = await repo.save({
        agentId: agent.id,
        content,
        contentHash,
        embedding: vector,
        embeddingSpaceKey: testSpaceKey,
        category: 'knowledge',
        kind: 'fact',
        importance: 3,
        confidence: 0.9,
        originTrust: 'owner',
        quarantined: false,
        ...overrides,
      });
      if (result.saved) {
        const [row] = await db
          .select({ id: memories.id })
          .from(memories)
          .where(eq(memories.contentHash, contentHash));
        if (row) memoryIds.push(row.id);
      }
      return { contentHash, result };
    };

    const coffee = await save('The owner prefers coffee in the morning.');
    expect(await repo.screenContentHash(agent.id, coffee.contentHash)).toBe('duplicate');
    await save('The owner enjoys a quiet morning.');
    await save('A quarantined coffee note.', { quarantined: true, originTrust: 'unknown' });
    await save('An expired coffee note.', { expiresAt: new Date(now.getTime() - 1) });

    expect(
      (
        await repo.save({
          agentId: agent.id,
          content: 'The owner prefers coffee in the morning.',
          contentHash: coffee.contentHash,
          embedding: vector,
          embeddingSpaceKey: testSpaceKey,
          category: 'knowledge',
          kind: 'fact',
          importance: 3,
          confidence: 0.9,
          originTrust: 'owner',
          quarantined: false,
        })
      ).duplicate,
    ).toBe(true);

    const recalled = await repo.recall({
      agentId: agent.id,
      embedding: vector,
      embeddingSpaceKey: testSpaceKey,
      query: 'coffee',
      limit: 2,
      now,
    });
    expect(recalled.memories[0]?.content).toContain('coffee');
    expect(recalled.memories).toHaveLength(2);
    expect(recalled.memories.some((row) => row.content.startsWith('A quarantined'))).toBe(false);
    expect(recalled.memories.some((row) => row.content.startsWith('An expired'))).toBe(false);
    const [accessed] = await db
      .select({ lastAccessedAt: memories.lastAccessedAt })
      .from(memories)
      .where(eq(memories.contentHash, coffee.contentHash));
    expect(accessed?.lastAccessedAt?.getTime()).toBe(now.getTime());
  });

  it('honors tombstones and creates a durable subject contact', async () => {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    const repo = createPostgresMemoryToolRepository(db);
    const lateTombstoneHash = createHash('sha256').update(randomUUID()).digest('hex');
    hashes.push(lateTombstoneHash);
    expect(await repo.screenContentHash(agent.id, lateTombstoneHash)).toBe('new');
    await db.insert(memoryTombstones).values({
      contentHash: lateTombstoneHash,
      reason: 'raced owner forget',
    });
    const lateTombstone = await repo.save({
      agentId: agent.id,
      content: 'A fact forgotten after the preflight.',
      contentHash: lateTombstoneHash,
      embedding: vector,
      embeddingSpaceKey: testSpaceKey,
      category: 'knowledge',
      kind: 'fact',
      importance: 3,
      confidence: 1,
      originTrust: 'owner',
      quarantined: false,
    });
    expect(lateTombstone.tombstoned).toBe(true);

    const contentHash = createHash('sha256').update(randomUUID()).digest('hex');
    hashes.push(contentHash);
    await db.insert(memoryTombstones).values({ contentHash, reason: 'test' });
    expect(await repo.screenContentHash(agent.id, contentHash)).toBe('tombstoned');
    const forgotten = await repo.save({
      agentId: agent.id,
      content: 'A forgotten fact.',
      contentHash,
      embedding: vector,
      embeddingSpaceKey: testSpaceKey,
      category: 'knowledge',
      kind: 'fact',
      importance: 3,
      confidence: 1,
      originTrust: 'owner',
      quarantined: false,
    });
    expect(forgotten).toMatchObject({ saved: false, duplicate: false, tombstoned: true });

    const subjectHash = createHash('sha256').update(randomUUID()).digest('hex');
    hashes.push(subjectHash);
    const saved = await repo.save({
      agentId: agent.id,
      content: 'Alex likes hiking.',
      contentHash: subjectHash,
      embedding: vector,
      embeddingSpaceKey: testSpaceKey,
      category: 'knowledge',
      kind: 'person',
      importance: 3,
      confidence: 0.8,
      originTrust: 'owner',
      quarantined: false,
      subject: `Alex ${randomUUID().slice(0, 8)}`,
    });
    expect(saved.saved).toBe(true);
    const [row] = await db
      .select({ id: memories.id, subjectContactId: memories.subjectContactId })
      .from(memories)
      .where(eq(memories.contentHash, subjectHash));
    expect(row?.subjectContactId).toBeTruthy();
    if (row?.id) memoryIds.push(row.id);
    if (row?.subjectContactId) contactIds.push(row.subjectContactId);
  });

  it('records the configured embedding identity for newly saved vectors', async () => {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    const embeddingSpace = {
      provider: 'test',
      model: 'memory-tools',
      dimensions: 1536,
      revision: '1',
    };
    const capturedSpaceKey = embeddingSpaceIdentityKey(embeddingSpace);
    const repo = createPostgresMemoryToolRepository(db, embeddingSpace);
    embeddingSpace.model = 'mutated-after-construction';
    embeddingSpace.dimensions = 768;
    embeddingSpace.revision = '2';
    expect(repo.embeddingSpace).toEqual({
      provider: 'test',
      model: 'memory-tools',
      dimensions: 1536,
      revision: '1',
    });
    const content = `Configured space memory ${randomUUID()}`;
    const contentHash = createHash('sha256').update(content).digest('hex');
    hashes.push(contentHash);
    const result = await repo.save({
      agentId: agent.id,
      content,
      contentHash,
      embedding: vector,
      embeddingSpaceKey: capturedSpaceKey,
      category: 'knowledge',
      kind: 'fact',
      importance: 3,
      confidence: 0.9,
      originTrust: 'owner',
      quarantined: false,
    });
    expect(result.saved).toBe(true);
    const [row] = await db
      .select({ id: memories.id, embeddingSpaceKey: memories.embeddingSpaceKey })
      .from(memories)
      .where(eq(memories.contentHash, contentHash));
    if (row) memoryIds.push(row.id);
    expect(row?.embeddingSpaceKey).toBe(capturedSpaceKey);
    const foreignContent = `Foreign space memory ${randomUUID()}`;
    await expect(
      repo.save({
        agentId: agent.id,
        content: foreignContent,
        contentHash: createHash('sha256').update(foreignContent).digest('hex'),
        embedding: Array.from({ length: 768 }, () => 0.01),
        embeddingSpaceKey: embeddingSpaceIdentityKey(embeddingSpace),
        category: 'knowledge',
        kind: 'fact',
        importance: 3,
        confidence: 0.9,
        originTrust: 'owner',
        quarantined: false,
      }),
    ).rejects.toThrow(/dimension|space/i);
  });

  it('does not compare vectors from unknown or another declared embedding space', async () => {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    const repo = createPostgresMemoryToolRepository(db);
    const currentSpace = testSpaceKey;
    await saveForSpace(repo, agent.id, 'Current space owner fact', currentSpace);
    await saveForSpace(repo, agent.id, 'Unknown legacy owner fact', null);
    await saveForSpace(
      repo,
      agent.id,
      'Other model owner fact',
      createHash('sha256').update(randomUUID()).digest('hex'),
    );

    const recalled = await repo.recall({
      agentId: agent.id,
      embedding: vector,
      embeddingSpaceKey: testSpaceKey,
      query: 'owner fact',
      limit: 10,
      now: new Date('2026-09-12T12:00:00Z'),
    });
    expect(recalled.memories.map((row) => row.content)).toEqual(['Current space owner fact']);
  });

  async function saveForSpace(
    repo: ReturnType<typeof createPostgresMemoryToolRepository>,
    agentId: string,
    content: string,
    embeddingSpaceKey: string | null,
  ) {
    const contentHash = createHash('sha256').update(`${content}:${randomUUID()}`).digest('hex');
    hashes.push(contentHash);
    if (embeddingSpaceKey === null) {
      const [row] = await db
        .insert(memories)
        .values({
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content,
          contentHash,
          embedding: vector,
          embeddingSpaceKey: null,
          importance: 3,
          confidence: '0.90',
          originTrust: 'owner',
          quarantined: false,
        })
        .returning({ id: memories.id });
      if (row) memoryIds.push(row.id);
      return;
    }
    const result = await repo.save({
      agentId,
      content,
      contentHash,
      embedding: vector,
      embeddingSpaceKey,
      category: 'knowledge',
      kind: 'fact',
      importance: 3,
      confidence: 0.9,
      originTrust: 'owner',
      quarantined: false,
    });
    if (result.id) memoryIds.push(result.id);
  }

  it('does not reveal a same-hash memory owned by another agent during preflight', async () => {
    const [owner] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!owner) throw new Error('Seed the test database');
    const otherId = randomUUID();
    extraAgentIds.push(otherId);
    await db.insert(agents).values({
      id: otherId,
      name: `Memory preflight ${otherId.slice(0, 8)}`,
      email: `${otherId}@memory-preflight.invalid`,
      workspacePrefix: `memory-preflight/${otherId}`,
    });
    const repo = createPostgresMemoryToolRepository(db);
    const contentHash = createHash('sha256').update(randomUUID()).digest('hex');
    hashes.push(contentHash);
    const saved = await repo.save({
      agentId: owner.id,
      content: 'A private fact owned by the first agent.',
      contentHash,
      embedding: vector,
      embeddingSpaceKey: testSpaceKey,
      category: 'knowledge',
      kind: 'fact',
      importance: 3,
      confidence: 1,
      originTrust: 'owner',
      quarantined: false,
    });
    expect(saved.saved).toBe(true);
    if (saved.id) memoryIds.push(saved.id);
    expect(await repo.screenContentHash(owner.id, contentHash)).toBe('duplicate');
    await expect(repo.screenContentHash(otherId, contentHash)).rejects.toThrow(
      'Memory duplicate preflight is unavailable',
    );
  });
});
