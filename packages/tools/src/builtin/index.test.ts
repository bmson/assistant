import { agents, createDb, type Db, goals } from '@assistant/db';
import {
  type EmbeddingSpace,
  embeddingSpaceIdentityKey,
  type MemoryToolRepository,
} from '@assistant/persistence';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { registerBuiltinTools, registerPortableMemoryTools } from './index.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('builtin trust capabilities', () => {
  it('installs only portable memory tools for the Firestore profile', () => {
    const registry = registerPortableMemoryTools(new ToolRegistry(), {
      embed: async () => [],
    });
    expect(registry.all().map(({ tool }) => tool.name)).toEqual(['memory.save', 'memory.recall']);
    expect(registry.toolsForTask('owner').map((tool) => tool.name)).toEqual([
      'memory.save',
      'memory.recall',
    ]);
    expect(registry.toolsForTask('unknown')).toEqual([]);
  });

  it.each([
    { saved: true, quarantined: false, category: 'knowledge', expected: 1 },
    { saved: false, quarantined: false, category: 'knowledge', expected: 0 },
    { saved: true, quarantined: true, category: 'knowledge', expected: 0 },
    { saved: true, quarantined: false, category: 'experience', expected: 0 },
  ])('preserves immediate corrections for eligible portable saves: %j', async (scenario) => {
    const supersede = vi.fn(async () => ({ superseded: ['old-fact'] }));
    const memory: MemoryToolRepository = {
      kind: 'memory-tool-repository',
      embeddingSpace: { provider: 'test', model: 'memory', dimensions: 3, revision: '1' },
      observationGeneration: async () => null,
      screenContentHash: async () => 'new',
      save: async () => ({
        id: 'new-fact',
        saved: scenario.saved,
        duplicate: !scenario.saved,
        tombstoned: false,
        quarantined: scenario.quarantined,
      }),
      recall: async () => ({ memories: [], candidateLimitReached: false }),
    };
    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [[1, 0, 0]],
      memory,
      supersede,
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
    });
    const tool = registry.get('memory.save')?.tool;
    if (!tool) throw new Error('Missing memory.save');
    const ctx = {
      agentId: 'agent',
      taskId: 'task',
      trust: 'owner',
      now: () => new Date(),
      db: new Proxy(
        {},
        {
          get() {
            throw new Error('Unexpected SQL access');
          },
        },
      ),
    } as ToolContext;
    const result = await tool.execute(
      {
        content: 'A corrected fact',
        category: scenario.category,
        kind: 'fact',
        importance: 3,
        confidence: 0.9,
        subject: '',
      },
      ctx,
    );
    expect(supersede).toHaveBeenCalledTimes(scenario.expected);
    if (scenario.expected) {
      expect(supersede).toHaveBeenCalledWith({
        agentId: 'agent',
        taskId: 'task',
        newFactId: 'new-fact',
      });
      expect(result).toMatchObject({ replacedEarlierFacts: 1 });
    }
  });

  it('keeps the authoritative save result when a tombstone appears after preflight', async () => {
    const embed = vi.fn(async () => [[1, 0, 0]]);
    const save = vi.fn(async (input: { quarantined: boolean }) => ({
      saved: false,
      duplicate: false,
      tombstoned: true,
      quarantined: input.quarantined,
    }));
    const memory: MemoryToolRepository = {
      kind: 'memory-tool-repository',
      embeddingSpace: { provider: 'test', model: 'memory', dimensions: 3, revision: '1' },
      observationGeneration: async () => null,
      screenContentHash: async () => 'new',
      save,
      recall: async () => ({ memories: [], candidateLimitReached: false }),
    };
    const registry = registerPortableMemoryTools(new ToolRegistry(), { embed, memory });
    const tool = registry.get('memory.save')?.tool;
    if (!tool) throw new Error('Missing memory.save');
    const result = await tool.execute(
      {
        content: 'A fact forgotten after preflight',
        category: 'knowledge',
        kind: 'fact',
        subject: '',
        importance: 3,
        confidence: 0.9,
      },
      {
        agentId: 'agent',
        trust: 'owner',
        now: () => new Date('2026-10-07T12:00:00Z'),
      } as ToolContext,
    );
    expect(embed).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ saved: false, tombstoned: true });
  });

  it('does not expose owner-private reads or workspace writes to unknown tasks', () => {
    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [],
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
    });
    const unknown = registry.toolsForTask('unknown').map((tool) => tool.name);

    expect(unknown).not.toContain('memory.recall');
    expect(unknown).not.toContain('conversations.search');
    expect(unknown).not.toContain('goals.list');
    expect(unknown).not.toContain('workspace.read');
    expect(unknown).not.toContain('workspace.list');
    expect(unknown).not.toContain('workspace.write');
    expect(unknown).not.toContain('owner.notify');
    // Egress is denied to strangers too: a DKIM-valid unknown sender must not
    // drive HTTP requests or paid searches from the owner's IP.
    expect(unknown).not.toContain('web.fetch');
    expect(registry.toolsForTask('known').map((tool) => tool.name)).toContain('web.fetch');
  });

  it('lets mission/goal progress writers run under taint without an approval', () => {
    // Regression: a mission/goal work session almost always reads untrusted
    // content before it can summarise progress. Taint no longer strips tools
    // from a privileged registry, so availability alone is not the property
    // worth pinning — acceptsUntrustedInput is. It is what keeps these two off
    // the dispatcher's taintNeedsApproval path, so the loop can record progress
    // without prompting the owner on every step instead of silently repeating
    // step one forever.
    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [],
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
    });
    const owner = registry.toolsForTask('owner').map((tool) => tool.name);

    expect(owner).toContain('mission.update');
    expect(owner).toContain('goals.update_progress');
    expect(registry.get('mission.update')?.tool.acceptsUntrustedInput).toBe(true);
    expect(registry.get('goals.update_progress')?.tool.acceptsUntrustedInput).toBe(true);
  });

  it('routes memory save and recall through the injected portable repository', async () => {
    const calls: { save?: Record<string, unknown>; recall?: Record<string, unknown> } = {};
    const embeddingSpace: EmbeddingSpace = {
      provider: 'test',
      model: 'memory',
      dimensions: 3,
      revision: '1',
    };
    const memory: MemoryToolRepository = {
      kind: 'memory-tool-repository',
      embeddingSpace,
      observationGeneration: async () => null,
      screenContentHash: async () => 'new',
      save: async (input) => {
        calls.save = input as unknown as Record<string, unknown>;
        return { saved: true, duplicate: false, tombstoned: false, quarantined: input.quarantined };
      },
      recall: async (input) => {
        calls.recall = input as unknown as Record<string, unknown>;
        return {
          candidateLimitReached: false,
          memories: [
            {
              id: 'memory-1',
              createdAt: new Date(),
              agentId: input.agentId,
              expiresAt: null,
              embedding: null,
              sourceTaskId: null,
              kind: 'fact',
              confidence: '0.6',
              contentHash: 'hash',
              goalId: null,
              originTrust: 'unknown',
              category: 'knowledge',
              content: 'A recalled fact',
              importance: 3,
              quarantined: false,
              subjectContactId: null,
              domain: null,
              validFrom: null,
              validUntil: null,
              supersededById: null,
              ownerConfirmed: false,
              pinned: false,
              source: null,
              embeddingSpaceKey: null,
              lastAccessedAt: input.now ?? null,
              lastConsolidatedAt: null,
              similarity: 0.9,
            },
          ],
        };
      },
    };
    const embed = vi.fn(async () => [[1, 2, 3]]);
    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed,
      memory,
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
    });
    const now = new Date('2026-09-12T12:00:00Z');
    const ctx = {
      taskId: 'task-1',
      agentId: 'agent-1',
      trust: 'known',
      tainted: true,
      db: {} as ToolContext['db'],
      now: () => now,
      signal: new AbortController().signal,
      log: async () => {},
    } as ToolContext;
    const saveTool = registry.get('memory.save')?.tool;
    const recallTool = registry.get('memory.recall')?.tool;
    if (!saveTool || !recallTool) throw new Error('memory tools not registered');
    await saveTool.execute(
      {
        content: 'Portable memory',
        category: 'experience',
        kind: 'episode',
        subject: '',
        importance: 3,
        confidence: 0.8,
      },
      ctx,
    );
    expect(embed).toHaveBeenCalledTimes(1);
    expect(calls.save).toMatchObject({
      agentId: 'agent-1',
      sourceTaskId: 'task-1',
      originTrust: 'known',
      quarantined: true,
      embeddingSpaceKey: embeddingSpaceIdentityKey(embeddingSpace),
    });
    const expiresAt = calls.save?.expiresAt;
    if (!(expiresAt instanceof Date)) throw new Error('Missing memory expiry');
    expect(expiresAt.getTime()).toBe(now.getTime() + 90 * 24 * 3600 * 1000);
    const recalled = await recallTool.execute({ query: 'fact', limit: 1 }, ctx);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(calls.recall).toMatchObject({
      agentId: 'agent-1',
      query: 'fact',
      limit: 1,
      now,
      embeddingSpaceKey: embeddingSpaceIdentityKey(embeddingSpace),
    });
    expect(recalled).toMatchObject({
      memories: [{ content: 'A recalled fact', unconfirmed: true }],
    });
  });

  it.each([
    { state: 'duplicate' as const, result: { duplicate: true } },
    { state: 'tombstoned' as const, result: { duplicate: false, tombstoned: true } },
  ])('skips embedding for a preflight $state content hash', async ({ state, result }) => {
    const embed = vi.fn(async () => [[1, 0, 0]]);
    const save = vi.fn(async () => ({
      saved: true,
      duplicate: false,
      tombstoned: false,
      quarantined: false,
    }));
    const memory: MemoryToolRepository = {
      kind: 'memory-tool-repository',
      observationGeneration: async () => null,
      screenContentHash: async () => state,
      save,
      recall: async () => ({ memories: [], candidateLimitReached: false }),
    };
    const registry = registerPortableMemoryTools(new ToolRegistry(), { embed, memory });
    const tool = registry.get('memory.save')?.tool;
    if (!tool) throw new Error('Missing memory.save');
    const output = await tool.execute(
      {
        content: `Known ${state} fact`,
        category: 'knowledge',
        kind: 'fact',
        subject: '',
        importance: 3,
        confidence: 0.9,
      },
      {
        agentId: 'agent',
        trust: 'owner',
        now: () => new Date('2026-10-07T12:00:00Z'),
      } as ToolContext,
    );
    expect(embed).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(output).toMatchObject({ saved: false, ...result, quarantined: false });
  });
});

describe('goals.list (integration)', () => {
  let db: Db;
  let dbUp = false;
  let agentId = '';
  const createdGoalIds: string[] = [];

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      const [agent] = await db.select().from(agents).limit(1);
      if (!agent) throw new Error('unseeded');
      agentId = agent.id;
      dbUp = true;
    } catch {
      console.warn('builtin goals.list test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp && createdGoalIds.length) {
      await db.delete(goals).where(inArray(goals.id, createdGoalIds));
    }
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('lists active goals first and never surfaces archived ones', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const stamp = Date.now();
    const fixtures = [
      { status: 'abandoned', title: `test-goal-abandoned-${stamp}` },
      { status: 'done', title: `test-goal-done-${stamp}` },
      { status: 'paused', title: `test-goal-paused-${stamp}` },
      { status: 'active', title: `test-goal-active-${stamp}` },
      { status: 'active', title: `test-goal-archived-${stamp}`, archived: true },
    ] as const;
    for (const fixture of fixtures) {
      const [row] = await db
        .insert(goals)
        .values({
          agentId,
          title: fixture.title,
          status: fixture.status,
          ...('archived' in fixture ? { archivedAt: new Date() } : {}),
        })
        .returning({ id: goals.id });
      createdGoalIds.push((row as NonNullable<typeof row>).id);
    }

    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [],
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
    });
    const tool = registry.get('goals.list')?.tool;
    if (!tool) throw new Error('goals.list not registered');
    const toolCtx = {
      taskId: crypto.randomUUID(),
      agentId,
      trust: 'owner',
      tainted: false,
      db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
    } as ToolContext;
    const result = (await tool.execute({}, toolCtx)) as {
      goals: Array<{ id: string; status: string }>;
    };

    const visibleIds = new Set(createdGoalIds.slice(0, 4));
    const mine = result.goals.filter((goal) => visibleIds.has(goal.id));
    expect(mine.map((goal) => goal.status)).toEqual(['active', 'paused', 'done', 'abandoned']);
    // The archived goal appears nowhere in the list the model sees.
    expect(result.goals.some((goal) => goal.id === createdGoalIds[4])).toBe(false);
  });
});
