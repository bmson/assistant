import {
  agents,
  approvals,
  createDb,
  type Db,
  knowledgeGraphSources,
  memories,
  tasks,
  toolCalls,
} from '@assistant/db';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createPostgresProfileMemoryCommandPersistence,
  ownerFacingError,
  profileMemoryCommands,
} from './commands.js';

const DATABASE_URL = process.env.DATABASE_URL;
const MARKER = `xtest-memory-correction-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
let memoryId: string;
let memoryCommands: ReturnType<typeof profileMemoryCommands>;
let createdAgentId: string | null = null;

function testDatabaseUrl(): string {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

function unitVector(): number[] {
  const vector = new Array(1536).fill(0);
  vector[0] = 1;
  return vector;
}

async function clearGraphTasks() {
  const graphTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.agentId, agentId),
        like(tasks.externalEventId, `profile:graph-sync:${memoryId}%`),
      ),
    );
  const taskIds = graphTasks.map(({ id }) => id);
  if (!taskIds.length) return;
  await db.delete(approvals).where(inArray(approvals.taskId, taskIds));
  await db.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
  await db.delete(tasks).where(inArray(tasks.id, taskIds));
}

beforeAll(async () => {
  db = createDb(testDatabaseUrl());
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'Memory Correction Test',
        email: `${MARKER}@example.com`,
        workspacePrefix: MARKER,
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error('test agent was not created');
    agentId = agent.id;
    createdAgentId = agent.id;
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} original fact`,
        contentHash: `${MARKER}-original`,
        confidence: '0.70',
        embedding: unitVector(),
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    memoryId = memory.id;
    memoryCommands = profileMemoryCommands(
      createPostgresProfileMemoryCommandPersistence(db, agentId),
      { embed: async () => [unitVector()] },
    );
    dbUp = true;
  } catch {
    console.warn('profile/commands.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    await clearGraphTasks();
    await db.delete(memories).where(eq(memories.id, memoryId));
    if (createdAgentId) await db.delete(agents).where(eq(agents.id, createdAgentId));
  }
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
});

describe('memory correction graph refresh (integration)', () => {
  it('queues one graph refresh for a corrected source and reuses it for repeated edits', async (ctx) => {
    if (!dbUp) return ctx.skip();
    expect(
      (await memoryCommands.correctMemory(memoryId, `${MARKER} corrected fact`)).error,
    ).toBeUndefined();
    expect(
      (await memoryCommands.correctMemory(memoryId, `${MARKER} corrected again`)).error,
    ).toBeUndefined();

    const queued = await db
      .select({ id: tasks.id, job: sql<string>`${tasks.trigger} #>> '{payload,job}'` })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agentId),
          like(tasks.externalEventId, `profile:graph-sync:${memoryId}%`),
        ),
      );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.job).toBe('memory.graph_sync');
  });

  it('restores an expired source when its owner keeps it current', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await clearGraphTasks();
    await db
      .update(memories)
      .set({
        expiresAt: sql`now() - interval '1 second'`,
        quarantined: true,
        ownerConfirmed: false,
      })
      .where(eq(memories.id, memoryId));

    await memoryCommands.restoreMemory(memoryId);

    const [restored] = await db
      .select({
        expiresAt: memories.expiresAt,
        supersededById: memories.supersededById,
        quarantined: memories.quarantined,
        ownerConfirmed: memories.ownerConfirmed,
      })
      .from(memories)
      .where(eq(memories.id, memoryId));
    expect(restored).toMatchObject({
      expiresAt: null,
      supersededById: null,
      quarantined: false,
      ownerConfirmed: true,
    });
    const queued = await db
      .select({ id: tasks.id, job: sql<string>`${tasks.trigger} #>> '{payload,job}'` })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agentId),
          like(tasks.externalEventId, `profile:graph-sync:${memoryId}%`),
        ),
      );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.job).toBe('memory.graph_sync');
  });

  it('approves a source, retries a blocked projection, and queues one refresh', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await clearGraphTasks();
    const [memory] = await db
      .select({ contentHash: memories.contentHash })
      .from(memories)
      .where(eq(memories.id, memoryId));
    if (!memory) throw new Error('test memory was not created');
    await db.update(memories).set({ quarantined: true }).where(eq(memories.id, memoryId));
    await db
      .insert(knowledgeGraphSources)
      .values({ memoryId, contentHash: memory.contentHash, status: 'quarantined', attempts: 4 })
      .onConflictDoUpdate({
        target: knowledgeGraphSources.memoryId,
        set: { contentHash: memory.contentHash, status: 'quarantined', attempts: 4 },
      });

    await memoryCommands.approveQuarantinedMemory(memoryId);

    const [[approved], [source], queued] = await Promise.all([
      db
        .select({ quarantined: memories.quarantined })
        .from(memories)
        .where(eq(memories.id, memoryId)),
      db
        .select({
          status: knowledgeGraphSources.status,
          attempts: knowledgeGraphSources.attempts,
          nextRetryAt: knowledgeGraphSources.nextRetryAt,
        })
        .from(knowledgeGraphSources)
        .where(eq(knowledgeGraphSources.memoryId, memoryId)),
      db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            like(tasks.externalEventId, `profile:graph-sync:${memoryId}%`),
          ),
        ),
    ]);
    expect(approved?.quarantined).toBe(false);
    expect(source).toMatchObject({ status: 'failed', attempts: 0 });
    expect(source?.nextRetryAt?.getTime()).toBeLessThanOrEqual(Date.now());
    expect(queued).toHaveLength(1);
  });

  it('queues a fresh graph source when approval has no existing checkpoint', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await clearGraphTasks();
    await db.delete(knowledgeGraphSources).where(eq(knowledgeGraphSources.memoryId, memoryId));
    await db.update(memories).set({ quarantined: true }).where(eq(memories.id, memoryId));

    await memoryCommands.approveQuarantinedMemory(memoryId);

    const [source, queued] = await Promise.all([
      db
        .select({ memoryId: knowledgeGraphSources.memoryId })
        .from(knowledgeGraphSources)
        .where(eq(knowledgeGraphSources.memoryId, memoryId)),
      db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            like(tasks.externalEventId, `profile:graph-sync:${memoryId}%`),
          ),
        ),
    ]);
    expect(source).toEqual([]);
    expect(queued).toHaveLength(1);
  });

  it('never mutates a memory owned by a different agent', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [otherAgent] = await db
      .insert(agents)
      .values({
        name: 'Foreign Memory Test',
        email: `${MARKER}-foreign@example.com`,
        workspacePrefix: `${MARKER}-foreign`,
      })
      .returning({ id: agents.id });
    if (!otherAgent) throw new Error('foreign test agent was not created');
    const [foreignMemory] = await db
      .insert(memories)
      .values({
        agentId: otherAgent.id,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} foreign fact`,
        contentHash: `${MARKER}-foreign`,
        confidence: '0.70',
        quarantined: true,
        embedding: unitVector(),
      })
      .returning({ id: memories.id });
    if (!foreignMemory) throw new Error('foreign test memory was not created');

    try {
      expect((await memoryCommands.correctMemory(foreignMemory.id, 'changed')).error).toBe(
        'Fact not found.',
      );
      await memoryCommands.approveQuarantinedMemory(foreignMemory.id);
      await memoryCommands.forgetMemory(foreignMemory.id);
      const [stored] = await db
        .select({ quarantined: memories.quarantined, content: memories.content })
        .from(memories)
        .where(eq(memories.id, foreignMemory.id));
      expect(stored).toMatchObject({ quarantined: true, content: `${MARKER} foreign fact` });
    } finally {
      await db.delete(memories).where(eq(memories.id, foreignMemory.id));
      await db.delete(agents).where(eq(agents.id, otherAgent.id));
    }
  });
});

// Pure mapping — no database, so it runs everywhere the suite does.
describe('owner-facing error mapping', () => {
  it('keeps the messages the db layer wrote for the owner', () => {
    for (const message of [
      'Person not found.',
      'The owner profile cannot be deleted.',
      'Person could not be deleted.',
      'Person not found or cannot be renamed.',
      'A person can have at most 20 aliases.',
    ]) {
      expect(ownerFacingError(new Error(message), 'fallback')).toBe(message);
    }
  });

  it('replaces a driver error with the fallback and logs the original', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const driver = new Error(
      'Failed query: delete from "contacts" where ("contacts"."id" = $1 and "contacts"."trust" <> $2) returning "id" params: 84db3716-316a-4c43-8377-d602f06129c0,owner',
    );
    try {
      expect(ownerFacingError(driver, 'Person could not be deleted. Please try again.')).toBe(
        'Person could not be deleted. Please try again.',
      );
      expect(ownerFacingError('not even an error', 'These people could not be merged.')).toBe(
        'These people could not be merged.',
      );
      expect(logged).toHaveBeenCalledTimes(2);
      expect(logged).toHaveBeenCalledWith(expect.any(String), driver);
    } finally {
      logged.mockRestore();
    }
  });
});
