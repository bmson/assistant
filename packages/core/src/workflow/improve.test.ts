import {
  agents,
  createDb,
  type Db,
  improvementProposals,
  knowledgeGraphSources,
  memories,
  messages,
  modelCalls,
  modelRoles,
  models,
  responseChecks,
  tasks,
  toolCalls,
} from '@assistant/db';
import { and, eq, inArray, like, ne, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { applyProposal, dismissProposal, listOpenProposals, runSelfImprove } from './improve.js';
import { enqueueTask } from './machine.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const TEST_EVENT_IDS = [
  'xtest-improve-source',
  'xtest-improve-quality-0',
  'xtest-improve-quality-1',
] as const;

const fakeRouter = {
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.03));
  },
  async object() {
    return {
      ok: true as const,
      modelId: 'fake',
      degraded: false,
      object: {
        proposals: [
          {
            kind: 'note',
            title: 'xtest-improve-note',
            rationale: 'xtest-fail-tool keeps failing; investigate the selector',
            role: '',
            primaryModel: '',
            fallbackModel: '',
            toolName: '',
            suggestion: 'add a retry',
          },
        ],
      },
    };
  },
} as unknown as ModelRouter;

describe('self-improvement loop', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  let taskId: string;
  const createdProposalIds: string[] = [];
  const qualityTaskIds: string[] = [];
  const foreignTaskIds: string[] = [];
  let foreignAgentId: string | undefined;

  async function cleanup() {
    const knownTaskRows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.externalEventId, TEST_EVENT_IDS));
    const testTaskIds = [
      ...new Set(
        [...knownTaskRows.map((row) => row.id), taskId, ...qualityTaskIds].filter(Boolean),
      ),
    ];
    await db.delete(improvementProposals).where(like(improvementProposals.title, 'xtest%'));
    if (createdProposalIds.length) {
      await db
        .delete(improvementProposals)
        .where(inArray(improvementProposals.id, createdProposalIds));
    }
    await db.delete(memories).where(like(memories.content, '%xtest-fail-tool%'));
    await db.delete(memories).where(like(memories.content, '%GraphRAG has%'));
    await db.delete(memories).where(like(memories.content, 'xtest graph health%'));
    if (testTaskIds.length) {
      await db.delete(memories).where(inArray(memories.sourceTaskId, testTaskIds));
      await db.delete(messages).where(inArray(messages.taskId, testTaskIds));
      await db.delete(toolCalls).where(inArray(toolCalls.taskId, testTaskIds));
      await db.delete(tasks).where(inArray(tasks.id, testTaskIds));
    }
    if (foreignTaskIds.length) {
      await db.delete(modelCalls).where(inArray(modelCalls.taskId, foreignTaskIds));
      await db.delete(toolCalls).where(inArray(toolCalls.taskId, foreignTaskIds));
      await db.delete(tasks).where(inArray(tasks.id, foreignTaskIds));
    }
    if (foreignAgentId) await db.delete(agents).where(eq(agents.id, foreignAgentId));
    qualityTaskIds.length = 0;
    foreignTaskIds.length = 0;
    foreignAgentId = undefined;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanup(); // clear stale xtest rows before creating this run's task
      const { task } = await enqueueTask(db, {
        event: {
          source: 'internal',
          externalEventId: TEST_EVENT_IDS[0],
          agentId,
          trust: 'assistant',
          payload: { note: 'xtest' },
        },
        type: 'adhoc',
      });
      taskId = task.id;
    } catch {
      console.warn('improve.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) await cleanup();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('mines a failure pattern into an experience memory and drafts a proposal', async (ctx) => {
    if (!dbUp) return ctx.skip();
    for (let i = 0; i < 3; i++) {
      await db.insert(toolCalls).values({
        taskId,
        step: i,
        toolName: 'xtest-fail-tool',
        args: {},
        risk: 'autonomous',
        status: 'failed',
        error: 'timed out reaching the vendor form',
      });
    }

    const r = await runSelfImprove({ db, router: fakeRouter }, { taskId });
    expect(r.patterns).toBeGreaterThanOrEqual(1);
    expect(r.proposalsDrafted).toBeGreaterThanOrEqual(1);
    expect(r.experienceSaved).toBe(true);

    const [exp] = await db
      .select()
      .from(memories)
      .where(and(eq(memories.source, 'self-improve'), like(memories.content, '%xtest-fail-tool%')));
    expect(exp?.category).toBe('experience');
    expect(exp?.expiresAt).not.toBeNull();

    const proposals = (await listOpenProposals(db, agentId)).filter((p) =>
      p.title.startsWith('xtest'),
    );
    expect(proposals.some((p) => p.title === 'xtest-improve-note')).toBe(true);
  });

  it('includes recurring response-quality and GraphRAG health signals in its review', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date();
    for (let i = 0; i < 2; i += 1) {
      const { task } = await enqueueTask(db, {
        event: {
          source: 'internal',
          externalEventId: TEST_EVENT_IDS[i + 1],
          agentId,
          trust: 'assistant',
          payload: { note: `quality-${i}` },
        },
        type: 'adhoc',
      });
      qualityTaskIds.push(task.id);
      await db.insert(responseChecks).values({
        taskId: task.id,
        promptVersion: 1,
        plannerVersion: 1,
        blocked: true,
        unsupportedCount: 1,
        mustActRetries: 1,
        degradedSteps: 1,
        outputVerificationUnavailable: true,
      });
    }
    const graphMemories = await db
      .insert(memories)
      .values([
        {
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: 'xtest graph health failed source one',
          contentHash: 'xtest-improve-graph-failed-one',
          embedding: new Array(1536).fill(0.03),
          originTrust: 'owner',
        },
        {
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: 'xtest graph health failed source two',
          contentHash: 'xtest-improve-graph-failed-two',
          embedding: new Array(1536).fill(0.03),
          originTrust: 'owner',
        },
        {
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: 'xtest graph health stale lease',
          contentHash: 'xtest-improve-graph-stale',
          embedding: new Array(1536).fill(0.03),
          originTrust: 'owner',
        },
      ])
      .returning({ id: memories.id, contentHash: memories.contentHash });
    const [failedOne, failedTwo, stale] = graphMemories;
    if (!failedOne || !failedTwo || !stale)
      throw new Error('graph health fixtures were not created');
    await db.insert(knowledgeGraphSources).values([
      {
        memoryId: failedOne.id,
        contentHash: failedOne.contentHash,
        status: 'failed',
        attempts: 2,
        lastError: 'xtest extraction failure',
      },
      {
        memoryId: failedTwo.id,
        contentHash: failedTwo.contentHash,
        status: 'failed',
        attempts: 2,
        lastError: 'xtest extraction failure',
      },
      {
        memoryId: stale.id,
        contentHash: stale.contentHash,
        status: 'pending',
        updatedAt: new Date(now.getTime() - 15 * 60 * 1000),
      },
    ]);

    let reviewPrompt = '';
    const recordingRouter = {
      async embed(texts: string[]) {
        return texts.map(() => new Array(1536).fill(0.03));
      },
      async object(_role: string, options: { prompt?: string }) {
        reviewPrompt = options.prompt ?? '';
        return {
          ok: true as const,
          modelId: 'fake',
          degraded: false,
          object: { proposals: [] },
        };
      },
    } as unknown as ModelRouter;

    const r = await runSelfImprove(
      { db, router: recordingRouter },
      { taskId: qualityTaskIds[0], now },
    );
    expect(r.patterns).toBeGreaterThanOrEqual(6);
    expect(reviewPrompt).toMatch(/response contract corrected \d+ response\(s\)/);
    expect(reviewPrompt).toMatch(/model loop retried \d+ required action step\(s\)/);
    expect(reviewPrompt).toMatch(/output verification was unavailable for \d+ final response\(s\)/);
    expect(reviewPrompt).toMatch(/GraphRAG has \d+ failed source extraction\(s\)/);
    expect(reviewPrompt).toMatch(/GraphRAG has \d+ source lease\(s\) pending for over 10 minutes/);
  });

  it("does not mix another agent's failures, stuck tasks, or costs into this review", async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [foreign] = await db
      .insert(agents)
      .values({
        name: 'xtest foreign agent',
        email: `xtest-improve-foreign-${Date.now()}@example.com`,
        workspacePrefix: 'xtest-improve-foreign',
      })
      .returning({ id: agents.id });
    if (!foreign) throw new Error('foreign agent fixture was not created');
    foreignAgentId = foreign.id;
    const [foreignTask] = await db
      .insert(tasks)
      .values({
        agentId: foreign.id,
        type: 'adhoc',
        trust: 'assistant',
        status: 'needs_attention',
        attempt: 2,
      })
      .returning({ id: tasks.id });
    if (!foreignTask) throw new Error('foreign task fixture was not created');
    foreignTaskIds.push(foreignTask.id);
    await db.insert(toolCalls).values([
      {
        taskId: foreignTask.id,
        step: 1,
        toolName: 'xtest-foreign-fail-tool',
        args: {},
        risk: 'autonomous',
        status: 'failed',
        error: 'xtest foreign provider outage',
      },
      {
        taskId: foreignTask.id,
        step: 2,
        toolName: 'xtest-foreign-fail-tool',
        args: {},
        risk: 'autonomous',
        status: 'failed',
        error: 'xtest foreign provider outage',
      },
    ]);
    await db.insert(modelCalls).values({
      taskId: foreignTask.id,
      role: 'draft',
      model: 'xtest-foreign-model',
      costUsd: '0.250000',
    });

    let reviewPrompt = '';
    const recordingRouter = {
      async embed(texts: string[]) {
        return texts.map(() => new Array(1536).fill(0.03));
      },
      async object(_role: string, options: { prompt?: string }) {
        reviewPrompt = options.prompt ?? '';
        return {
          ok: true as const,
          modelId: 'fake',
          degraded: false,
          object: { proposals: [] },
        };
      },
    } as unknown as ModelRouter;

    await runSelfImprove({ db, router: recordingRouter }, { taskId });

    expect(reviewPrompt).not.toContain('xtest-foreign-fail-tool');
    expect(reviewPrompt).not.toContain('task(s) needed attention after retries');
    expect(reviewPrompt).not.toContain('$0.250');
  });

  it('applies a model-role swap to a valid enabled model and restores', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [draftRole] = await db.select().from(modelRoles).where(eq(modelRoles.role, 'draft'));
    if (!draftRole) return ctx.skip();
    const original = draftRole.primaryModel;
    const [otherModel] = await db
      .select({ id: models.id })
      .from(models)
      .where(
        and(
          eq(models.enabled, true),
          ne(models.id, original),
          sql`coalesce(${models.capabilities}->>'embedding', 'false') <> 'true'`,
        ),
      )
      .limit(1);
    if (!otherModel) return ctx.skip();

    const [proposal] = await db
      .insert(improvementProposals)
      .values({
        agentId,
        kind: 'model_role',
        title: 'xtest-swap-draft',
        rationale: 'draft underperforms',
        change: { role: 'draft', primaryModel: otherModel.id, fallbackModel: '' },
        // A live routing swap is refused without cited evidence rows.
        evidenceIds: ['draft:xtest-signature'],
      })
      .returning();
    createdProposalIds.push(proposal?.id ?? '');

    try {
      const result = await applyProposal(db, proposal?.id ?? '', agentId);
      expect(result.enacted).toBe(true);
      const [after] = await db.select().from(modelRoles).where(eq(modelRoles.role, 'draft'));
      expect(after?.primaryModel).toBe(otherModel.id);
      const [row] = await db
        .select({ status: improvementProposals.status })
        .from(improvementProposals)
        .where(eq(improvementProposals.id, proposal?.id ?? ''));
      expect(row?.status).toBe('applied');
    } finally {
      // Never leave the shared DB's routing changed.
      await db
        .update(modelRoles)
        .set({ primaryModel: original })
        .where(eq(modelRoles.role, 'draft'));
    }
  });

  it('keeps an unevidenced model swap open and dismisses an advisory', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [bad] = await db
      .insert(improvementProposals)
      .values({
        agentId,
        kind: 'model_role',
        title: 'xtest-bad-swap',
        change: { role: 'draft', primaryModel: 'no/such-model', fallbackModel: '' },
      })
      .returning();
    createdProposalIds.push(bad?.id ?? '');
    await expect(applyProposal(db, bad?.id ?? '', agentId)).rejects.toThrow('needs cited evidence');
    expect((await listOpenProposals(db, agentId)).some((row) => row.id === bad?.id)).toBe(true);

    const [note] = await db
      .insert(improvementProposals)
      .values({ agentId, kind: 'note', title: 'xtest-dismiss-me', change: {} })
      .returning();
    createdProposalIds.push(note?.id ?? '');
    await dismissProposal(db, note?.id ?? '', agentId);
    const open = (await listOpenProposals(db, agentId)).filter(
      (p) => p.title === 'xtest-dismiss-me',
    );
    expect(open).toHaveLength(0);
  });
});
