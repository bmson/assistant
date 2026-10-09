import { randomUUID } from 'node:crypto';
import {
  agents,
  approvals,
  conversationSegments,
  conversations,
  costEvents,
  createDb,
  type Db,
  memories,
  messages,
  modelCalls,
  recallMetrics,
  tasks,
  toolCache,
  toolCalls,
} from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { InboundEvent } from '../events.js';
import type { ModelRouter } from '../model-router/router.js';
import { enqueueTask } from './machine.js';
import { backfillMessageEmbeddings, purgeAgedHistory, purgeExpired } from './maintenance.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
let conversationId: string;
const messageIds: string[] = [];
const recallMetricIds: string[] = [];
const retentionTaskIds: string[] = [];
const retentionChildTaskIds: string[] = [];
const retentionForeignAgentIds: string[] = [];

const fakeRouter = {
  async embeddingSpace() {
    return {
      provider: 'test',
      model: 'maintenance-test',
      dimensions: 1536,
      revision: '1',
    } as const;
  },
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.01));
  },
} as unknown as ModelRouter;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'maintenance-test' })
      .returning();
    conversationId = (conversation as NonNullable<typeof conversation>).id;
  } catch {
    console.warn('maintenance.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    for (const retentionTaskId of retentionTaskIds) {
      // FK order: children of the retention task first, then the task itself.
      await db.delete(approvals).where(eq(approvals.taskId, retentionTaskId));
      await db.delete(costEvents).where(eq(costEvents.taskId, retentionTaskId));
      await db.delete(toolCalls).where(eq(toolCalls.taskId, retentionTaskId));
      await db.delete(modelCalls).where(eq(modelCalls.taskId, retentionTaskId));
      const { tasks, responseChecks } = await import('@assistant/db');
      await db.delete(responseChecks).where(eq(responseChecks.taskId, retentionTaskId));
      if (retentionChildTaskIds.length)
        await db.delete(tasks).where(inArray(tasks.id, retentionChildTaskIds));
      await db.delete(tasks).where(eq(tasks.id, retentionTaskId));
    }
    if (retentionForeignAgentIds.length)
      await db.delete(agents).where(inArray(agents.id, retentionForeignAgentIds));
    await db
      .delete(conversationSegments)
      .where(eq(conversationSegments.conversationId, conversationId));
    if (messageIds.length) await db.delete(messages).where(inArray(messages.id, messageIds));
    if (recallMetricIds.length) {
      await db.delete(recallMetrics).where(inArray(recallMetrics.id, recallMetricIds));
    }
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.delete(toolCache).where(eq(toolCache.toolName, 'maint.test'));
    await db.delete(memories).where(eq(memories.contentHash, 'maint-test-hash'));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('maintenance (integration)', () => {
  it('backfills embeddings for substantial messages only, and only once', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [long] = await db
      .insert(messages)
      .values({
        conversationId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'This is a sufficiently long message about kubernetes clusters and deployments.',
      })
      .returning();
    const [short] = await db
      .insert(messages)
      .values({ conversationId, role: 'user', origin: 'owner', parts: [], text: 'ok' })
      .returning();
    const [fixture] = await db
      .insert(messages)
      .values({
        conversationId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'Synthetic visual QA message should never be embedded or ingested.',
        channelMessageId: `visual-qa:maintenance:${randomUUID()}`,
      })
      .returning();
    const [readabilityFixture] = await db
      .insert(messages)
      .values({
        conversationId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'Synthetic readability QA message should never be embedded or ingested.',
        channelMessageId: `readability-maintenance-${randomUUID()}-user`,
      })
      .returning();
    if (!readabilityFixture) throw new Error('Could not create readability fixture message');
    messageIds.push(
      (long as NonNullable<typeof long>).id,
      (short as NonNullable<typeof short>).id,
      (fixture as NonNullable<typeof fixture>).id,
      readabilityFixture.id,
    );

    const first = await backfillMessageEmbeddings(db, fakeRouter, 50);
    expect(first).toBeGreaterThanOrEqual(1);

    const embeddingOf = async (id: string) => {
      const [row] = await db
        .select({ embedding: messages.embedding })
        .from(messages)
        .where(eq(messages.id, id));
      return row?.embedding ?? null;
    };
    const longEmbedding = await embeddingOf((long as NonNullable<typeof long>).id);
    expect(longEmbedding).not.toBeNull();
    expect(await embeddingOf((short as NonNullable<typeof short>).id)).toBeNull(); // too short to bother
    expect(await embeddingOf((fixture as NonNullable<typeof fixture>).id)).toBeNull();
    expect(await embeddingOf(readabilityFixture.id)).toBeNull();

    // Idempotent for OUR rows: a second pass leaves them untouched. (Other
    // tests share this DB and may add unembedded messages concurrently, so
    // the global count is not assertable.)
    await backfillMessageEmbeddings(db, fakeRouter, 50);
    expect(await embeddingOf((long as NonNullable<typeof long>).id)).toEqual(longEmbedding);
    expect(await embeddingOf((short as NonNullable<typeof short>).id)).toBeNull();
  });

  it('purges expired cache rows, memories, and aged recall metrics, keeping live rows', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await db.insert(toolCache).values([
      {
        cacheKey: 'maint-expired',
        toolName: 'maint.test',
        result: {},
        expiresAt: new Date(Date.now() - 1000),
      },
      {
        cacheKey: 'maint-live',
        toolName: 'maint.test',
        result: {},
        expiresAt: new Date(Date.now() + 3600e3),
      },
    ]);
    await db.insert(memories).values({
      agentId,
      category: 'experience',
      kind: 'episode',
      content: 'expired test memory',
      contentHash: 'maint-test-hash',
      expiresAt: new Date(Date.now() - 1000),
    });
    const insertedMetrics = await db
      .insert(recallMetrics)
      .values([
        {
          agentId,
          path: 'chat',
          graphAttempted: true,
          graphFailed: false,
          historyFailed: false,
          graphCandidates: 1,
          graphUsed: 1,
          historyTier: 'segment',
          historyUsed: 1,
          sourceCount: 2,
          createdAt: new Date(Date.now() - 91 * 86400e3),
        },
        {
          agentId,
          path: 'chat',
          graphAttempted: true,
          graphFailed: false,
          historyFailed: false,
          graphCandidates: 1,
          graphUsed: 1,
          historyTier: 'segment',
          historyUsed: 1,
          sourceCount: 2,
        },
      ])
      .returning({ id: recallMetrics.id });
    const [expiredMetric, liveMetric] = insertedMetrics;
    if (!expiredMetric || !liveMetric) throw new Error('recall metric fixture insert failed');
    recallMetricIds.push(expiredMetric.id, liveMetric.id);

    const purged = await purgeExpired(db);
    expect(purged.cache).toBeGreaterThanOrEqual(1);
    expect(purged.memories).toBeGreaterThanOrEqual(1);
    expect(purged.recallMetrics).toBeGreaterThanOrEqual(1);

    const remaining = await db.select().from(toolCache).where(eq(toolCache.toolName, 'maint.test'));
    expect(remaining.map((r) => r.cacheKey)).toEqual(['maint-live']);
    const remainingMetrics = await db
      .select({ id: recallMetrics.id })
      .from(recallMetrics)
      .where(inArray(recallMetrics.id, [expiredMetric.id, liveMetric.id]));
    expect(remainingMetrics).toEqual([{ id: liveMetric.id }]);
  });

  it('does nothing when retention is disabled (the default)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const counts = await purgeAgedHistory(db, { historyDays: 0, costDays: 0 });
    expect(counts).toEqual({ messages: 0, toolCalls: 0, modelCalls: 0, costEvents: 0 });
  });

  it('prunes aged history but keeps segment anchors and referenced tool calls', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const daysAgo = (days: number) => new Date(Date.now() - days * 86400e3);

    // Three messages: aged (goes), aged-but-anchoring-a-segment (stays), recent (stays).
    const inserted = await db
      .insert(messages)
      .values([
        {
          conversationId,
          role: 'user',
          origin: 'owner',
          text: 'aged unanchored',
          createdAt: daysAgo(100),
        },
        {
          conversationId,
          role: 'user',
          origin: 'owner',
          text: 'aged segment anchor',
          createdAt: daysAgo(100),
        },
        { conversationId, role: 'user', origin: 'owner', text: 'recent' },
      ])
      .returning({ id: messages.id });
    const [agedGone, agedAnchor, recent] = inserted.map((row) => row.id);
    if (!agedGone || !agedAnchor || !recent) throw new Error('fixture insert failed');
    messageIds.push(agedAnchor, recent); // agedGone is deleted by the purge under test
    await db.insert(conversationSegments).values({
      agentId,
      conversationId,
      startMessageId: agedAnchor,
      endMessageId: agedAnchor,
      summary: 'retention test segment',
      startedAt: daysAgo(100),
      endedAt: daysAgo(100),
    });

    const { task } = await enqueueTask(db, {
      event: { source: 'chat', trust: 'owner', agentId, payload: { text: 'retention fixture' } },
      type: 'adhoc',
    } as { event: InboundEvent; type: 'adhoc' });
    retentionTaskIds.push(task.id);
    await db
      .update(tasks)
      .set({ status: 'done', updatedAt: daysAgo(100) })
      .where(eq(tasks.id, task.id));
    const toolCallRow = (over: Partial<typeof toolCalls.$inferInsert>) => ({
      taskId: task.id,
      step: 1,
      toolName: 'maint.retention',
      risk: 'autonomous',
      status: 'succeeded',
      ...over,
    });
    const [plainAged, approvalHeld, costHeld, recentCall] = (
      await db
        .insert(toolCalls)
        .values([
          toolCallRow({ createdAt: daysAgo(100) }),
          toolCallRow({ createdAt: daysAgo(100) }),
          toolCallRow({ createdAt: daysAgo(100) }),
          toolCallRow({}),
        ])
        .returning({ id: toolCalls.id })
    ).map((row) => row.id);
    if (!plainAged || !approvalHeld || !costHeld || !recentCall) {
      throw new Error('tool-call fixture insert failed');
    }
    // The same old receipt remains necessary while its task is parked.
    await db.update(tasks).set({ status: 'sleeping' }).where(eq(tasks.id, task.id));
    const parkedPurge = await purgeAgedHistory(db, { historyDays: 30, costDays: 0, batch: 500 });
    expect(
      await db.query.toolCalls.findFirst({ where: eq(toolCalls.id, plainAged) }),
    ).toBeDefined();
    await db
      .update(tasks)
      .set({ status: 'done', updatedAt: daysAgo(100) })
      .where(eq(tasks.id, task.id));
    await db.insert(approvals).values({
      taskId: task.id,
      toolCallId: approvalHeld,
      shortCode: 'R1',
      summary: 'retention fixture approval',
      status: 'approved',
      expiresAt: daysAgo(99),
    });
    await db.insert(costEvents).values([
      // Recent cost event referencing an aged tool call — holds it in place.
      { source: 'external_api', taskId: task.id, toolCallId: costHeld, usd: '0.01' },
      // Aged standalone cost event — pruned by the cost pass.
      { source: 'external_api', taskId: task.id, usd: '0.01', createdAt: daysAgo(100) },
    ]);
    await db.insert(modelCalls).values([
      { taskId: task.id, role: 'chat', model: 'maint/retention', createdAt: daysAgo(100) },
      { taskId: task.id, role: 'chat', model: 'maint/retention' },
    ]);

    const counts = await purgeAgedHistory(db, { historyDays: 30, costDays: 60, batch: 500 });
    // Other suites share this database, so counts are lower bounds, and the
    // real assertions are which of OUR rows survived.
    expect(counts.messages + parkedPurge.messages).toBeGreaterThanOrEqual(1);
    expect(counts.toolCalls).toBeGreaterThanOrEqual(1);
    expect(counts.modelCalls).toBeGreaterThanOrEqual(1);
    expect(counts.costEvents).toBeGreaterThanOrEqual(1);

    const surviving = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
    const keptMessages = await db
      .select({ id: messages.id })
      .from(messages)
      .where(inArray(messages.id, [agedGone, agedAnchor, recent]));
    expect(surviving(keptMessages)).toEqual([agedAnchor, recent].sort());

    const keptCalls = await db
      .select({ id: toolCalls.id })
      .from(toolCalls)
      .where(eq(toolCalls.taskId, task.id));
    expect(surviving(keptCalls)).toEqual([approvalHeld, costHeld, recentCall].sort());

    const keptModelCalls = await db
      .select({ id: modelCalls.id })
      .from(modelCalls)
      .where(eq(modelCalls.taskId, task.id));
    expect(keptModelCalls).toHaveLength(1);

    const keptCostEvents = await db
      .select({ toolCallId: costEvents.toolCallId })
      .from(costEvents)
      .where(eq(costEvents.taskId, task.id));
    expect(keptCostEvents).toEqual([{ toolCallId: costHeld }]);
  });

  it('protects terminal receipts named by unresolved or malformed task checkpoints', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const daysAgo = (days: number) => new Date(Date.now() - days * 86400e3);
    const makeReceipt = async (
      checkpoint: (toolCallId: string) => unknown,
    ): Promise<{ taskId: string; toolCallId: string }> => {
      const { task } = await enqueueTask(db, {
        event: {
          source: 'chat',
          trust: 'owner',
          agentId,
          payload: { text: `retention checkpoint ${randomUUID()}` },
        },
        type: 'adhoc',
      } as { event: InboundEvent; type: 'adhoc' });
      retentionTaskIds.push(task.id);
      const [call] = await db
        .insert(toolCalls)
        .values({
          taskId: task.id,
          step: 1,
          toolName: 'maint.retention',
          risk: 'autonomous',
          status: 'succeeded',
          args: {},
          result: { retained: true },
          createdAt: daysAgo(100),
        })
        .returning({ id: toolCalls.id });
      if (!call) throw new Error('tool-call fixture insert failed');
      await db
        .update(tasks)
        .set({ status: 'done', updatedAt: daysAgo(100), state: checkpoint(call.id) })
        .where(eq(tasks.id, task.id));
      return { taskId: task.id, toolCallId: call.id };
    };

    const pendingJob = await makeReceipt((id) => ({
      pendingJob: {
        dbToolCallId: id,
        toolCallId: 'model-job-call',
        toolName: 'browser.execute',
        callbackTokenHash: 'a'.repeat(64),
        timeoutAt: new Date().toISOString(),
      },
    }));
    const pendingBatch = await makeReceipt((id) => ({
      pendingToolBatch: {
        step: 1,
        modelId: 'synthetic',
        calls: [
          {
            toolCallId: 'model-batch-call',
            toolName: 'reminder.create',
            input: {},
            status: 'job',
            dbToolCallId: id,
          },
        ],
      },
    }));
    const malformed = await makeReceipt(() => 'not-an-object-checkpoint');
    const completedPendingFinal = await makeReceipt(() => ({
      pendingFinal: {
        text: 'Completed answer stays in task history.',
        progress: 'done',
        terminalStatus: 'done',
        outcome: 'done',
      },
    }));
    const { task: danglingTask } = await enqueueTask(db, {
      event: {
        source: 'chat',
        trust: 'owner',
        agentId,
        payload: { text: `retention dangling checkpoint ${randomUUID()}` },
      },
      type: 'adhoc',
    } as { event: InboundEvent; type: 'adhoc' });
    retentionTaskIds.push(danglingTask.id);
    const missingCallId = randomUUID();
    const [unrelatedCall] = await db
      .insert(toolCalls)
      .values({
        taskId: danglingTask.id,
        step: 1,
        toolName: 'maint.retention.unrelated',
        risk: 'autonomous',
        status: 'succeeded',
        createdAt: daysAgo(100),
      })
      .returning({ id: toolCalls.id });
    if (!unrelatedCall) throw new Error('dangling checkpoint fixture insert failed');
    await db
      .update(tasks)
      .set({
        status: 'done',
        updatedAt: daysAgo(100),
        state: {
          pendingJob: {
            dbToolCallId: missingCallId,
            toolCallId: 'missing-model-call',
            toolName: 'browser.execute',
            callbackTokenHash: 'c'.repeat(64),
            timeoutAt: new Date().toISOString(),
          },
        },
      })
      .where(eq(tasks.id, danglingTask.id));

    await purgeAgedHistory(db, { historyDays: 30, costDays: 0, batch: 500 });

    for (const call of [pendingJob, pendingBatch, malformed]) {
      expect(
        await db.query.toolCalls.findFirst({ where: eq(toolCalls.id, call.toolCallId) }),
      ).toBeDefined();
    }
    expect(
      await db.query.toolCalls.findFirst({
        where: eq(toolCalls.id, completedPendingFinal.toolCallId),
      }),
    ).toBeUndefined();
    const completedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, completedPendingFinal.taskId),
    });
    if (!completedTask) throw new Error('completed task fixture disappeared');
    expect((completedTask.state as { pendingFinal?: unknown }).pendingFinal).toBeDefined();
    expect(
      await db.query.toolCalls.findFirst({ where: eq(toolCalls.id, unrelatedCall.id) }),
    ).toBeUndefined();
    const stillDangling = await db.query.tasks.findFirst({
      where: eq(tasks.id, danglingTask.id),
    });
    if (!stillDangling) throw new Error('dangling checkpoint task disappeared');
    expect(
      (stillDangling.state as { pendingJob: { dbToolCallId: string } }).pendingJob.dbToolCallId,
    ).toBe(missingCallId);
    expect(
      await db.query.toolCalls.findFirst({ where: eq(toolCalls.id, missingCallId) }),
    ).toBeUndefined();
  });

  it('prunes receipts after every descendant is terminal and beyond the horizon', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const aged = new Date(Date.now() - 100 * 86400e3);
    const { task: root } = await enqueueTask(db, {
      event: {
        source: 'chat',
        trust: 'owner',
        agentId,
        payload: { text: `retention terminal tree ${randomUUID()}` },
      },
      type: 'adhoc',
    } as { event: InboundEvent; type: 'adhoc' });
    retentionTaskIds.push(root.id);
    const [child, grandchild] = await db
      .insert(tasks)
      .values([
        {
          agentId,
          type: 'adhoc',
          status: 'failed',
          trust: 'owner',
          parentTaskId: root.id,
          updatedAt: aged,
          state: {},
        },
        {
          agentId,
          type: 'adhoc',
          status: 'cancelled',
          trust: 'owner',
          parentTaskId: null,
          updatedAt: aged,
          state: {},
        },
      ])
      .returning({ id: tasks.id, parentTaskId: tasks.parentTaskId });
    if (!child || !grandchild) throw new Error('descendant fixture insert failed');
    retentionChildTaskIds.push(child.id, grandchild.id);
    await db.update(tasks).set({ parentTaskId: child.id }).where(eq(tasks.id, grandchild.id));
    await db
      .update(tasks)
      .set({ status: 'done', updatedAt: aged, state: {} })
      .where(eq(tasks.id, root.id));
    const [receipt] = await db
      .insert(toolCalls)
      .values({
        taskId: root.id,
        step: 1,
        toolName: 'maint.retention.tree',
        risk: 'autonomous',
        status: 'succeeded',
        createdAt: aged,
      })
      .returning({ id: toolCalls.id });
    if (!receipt) throw new Error('tree receipt fixture insert failed');

    await purgeAgedHistory(db, { historyDays: 30, costDays: 0, batch: 500 });

    expect(
      await db.query.toolCalls.findFirst({ where: eq(toolCalls.id, receipt.id) }),
    ).toBeUndefined();
  });

  it('retains aged root receipts when a terminal descendant has an incomplete checkpoint', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const aged = new Date(Date.now() - 100 * 86400e3);
    const checkpointCases: Array<{
      name: string;
      state: Record<string, unknown>;
      foreignAgent?: boolean;
    }> = [
      { name: 'pending job without its receipt ID', state: { pendingJob: {} } },
      { name: 'pending batch without its calls list', state: { pendingToolBatch: {} } },
      {
        name: 'foreign-agent terminal descendant',
        state: {},
        foreignAgent: true,
      },
    ];
    const receipts: Array<{ id: string; name: string }> = [];
    const [foreignAgent] = await db
      .insert(agents)
      .values({
        name: 'Retention foreign owner',
        email: `retention-${randomUUID()}@example.test`,
        workspacePrefix: `retention/${randomUUID()}`,
      })
      .returning({ id: agents.id });
    if (!foreignAgent) throw new Error('foreign agent fixture insert failed');
    retentionForeignAgentIds.push(foreignAgent.id);

    for (const fixture of checkpointCases) {
      const { task: root } = await enqueueTask(db, {
        event: {
          source: 'chat',
          trust: 'owner',
          agentId,
          payload: { text: `retention malformed descendant ${fixture.name} ${randomUUID()}` },
        },
        type: 'adhoc',
      } as { event: InboundEvent; type: 'adhoc' });
      retentionTaskIds.push(root.id);
      const [child] = await db
        .insert(tasks)
        .values({
          agentId: fixture.foreignAgent ? foreignAgent.id : agentId,
          type: 'adhoc',
          status: 'done',
          trust: 'owner',
          parentTaskId: root.id,
          updatedAt: aged,
          state: fixture.state,
        })
        .returning({ id: tasks.id });
      if (!child) throw new Error('malformed descendant fixture insert failed');
      retentionChildTaskIds.push(child.id);
      await db
        .update(tasks)
        .set({ status: 'done', updatedAt: aged, state: {} })
        .where(eq(tasks.id, root.id));
      const [receipt] = await db
        .insert(toolCalls)
        .values({
          taskId: root.id,
          step: 1,
          toolName: 'maint.retention.malformed-descendant',
          risk: 'autonomous',
          status: 'succeeded',
          createdAt: aged,
        })
        .returning({ id: toolCalls.id });
      if (!receipt) throw new Error('malformed descendant receipt fixture insert failed');
      receipts.push({ id: receipt.id, name: fixture.name });
    }

    await purgeAgedHistory(db, { historyDays: 30, costDays: 0, batch: 500 });
    for (const receipt of receipts)
      expect(
        await db.query.toolCalls.findFirst({ where: eq(toolCalls.id, receipt.id) }),
        receipt.name,
      ).toBeDefined();
  });
});
