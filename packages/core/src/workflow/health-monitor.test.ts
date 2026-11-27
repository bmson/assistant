import {
  agents,
  assistantHealthAlerts,
  conversations,
  createDb,
  createPostgresTaskRepository,
  type Db,
  knowledgeGraphSources,
  memories,
  messages,
  recallMetrics,
  responseChecks,
  tasks,
} from '@assistant/db';
import { taskActivityDiagnostics } from '@assistant/persistence';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTest } from '../config.js';
import { runAssistantHealthMonitor } from './health-monitor.js';
import { enqueueTask } from './machine.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-health-monitor-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'Health Monitor Test',
        email: `${MARKER}@example.com`,
        workspacePrefix: MARKER,
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error('test agent was not created');
    agentId = agent.id;
    dbUp = true;
  } catch {
    console.warn('health-monitor.test: database unreachable — skipping');
  }
});

beforeEach(() => {
  resetConfigForTest();
  loadConfig({ CHAT_RECALL_ENABLED: 'true', GRAPH_RAG_ENABLED: 'true' });
});

afterEach(() => resetConfigForTest());

afterAll(async () => {
  if (dbUp) {
    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.agentId, agentId));
    if (rows.length) {
      await db.delete(messages).where(
        inArray(
          messages.conversationId,
          rows.map((row) => row.id),
        ),
      );
      await db.delete(conversations).where(eq(conversations.agentId, agentId));
    }
    await db.delete(memories).where(eq(memories.agentId, agentId));
    await db.delete(tasks).where(eq(tasks.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
});

async function monitor(now: Date = new Date()) {
  const repository = createPostgresTaskRepository(db);
  const { task } = await repository.createTask({
    agentId,
    type: 'scheduled',
    trust: 'assistant',
    trigger: { source: 'schedule', payload: { job: 'health.monitor' } },
  });
  return runAssistantHealthMonitor(
    {
      db,
      saveDiagnostic: async (id, text) => {
        expect(
          await repository.appendActivityDiagnostic({
            agentId,
            taskId: task.id,
            diagnostic: { id, text },
          }),
        ).toBe(true);
      },
    },
    { agentId, now },
  );
}

async function diagnostics() {
  const rows = await db
    .select({ state: tasks.state })
    .from(tasks)
    .where(eq(tasks.agentId, agentId))
    .orderBy(tasks.createdAt);
  const chat = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(conversations.agentId, agentId));
  expect(chat).toEqual([]);
  return rows.flatMap(({ state }) => taskActivityDiagnostics(state));
}

describe('assistant health monitor (integration)', () => {
  it('stays quiet for a healthy agent', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await monitor();
    expect(result).toEqual({ signals: [], notified: false });
  });

  it('notifies the owner about quarantined GraphRAG and repeated response-quality failures', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} quarantined source`,
        contentHash: `${MARKER}-quarantined`,
        embedding: new Array(1536).fill(0.01),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    await db.insert(knowledgeGraphSources).values({
      memoryId: memory.id,
      contentHash: `${MARKER}-quarantined`,
      status: 'quarantined',
      attempts: 4,
      lastError: 'provider outage',
    });

    for (let i = 0; i < 2; i += 1) {
      const { task } = await enqueueTask(db, {
        event: {
          source: 'internal',
          externalEventId: `${MARKER}-quality-${i}`,
          agentId,
          trust: 'assistant',
          payload: {},
        },
        type: 'adhoc',
      });
      await db.insert(responseChecks).values({
        taskId: task.id,
        promptVersion: 1,
        outputVerificationUnavailable: true,
        mustActRetries: 1,
      });
    }
    await db.insert(recallMetrics).values(
      Array.from({ length: 3 }, () => ({
        agentId,
        path: 'executor',
        graphAttempted: true,
        graphFailed: true,
        historyFailed: true,
        historyTier: 'message',
      })),
    );

    const firstNow = new Date();
    const result = await monitor(firstNow);
    expect(result.notified).toBe(true);
    expect(result.signals).toHaveLength(5);
    const notices = await diagnostics();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain('quarantined after bounded retries');
    expect(notices[0]?.text).toContain('verification was unavailable 2 times');
    expect(notices[0]?.text).toContain('2 required-action steps');
    expect(notices[0]?.text).toContain('GraphRAG recall was unavailable 3 times');
    expect(notices[0]?.text).toContain('Conversation memory recall was unavailable 3 times');

    // The next daily pass records fresh observations but does not repeat the
    // same owner message. A week later an unresolved graph incident is safely
    // reminded; response-quality rows have aged out by then.
    const sameIncident = await monitor(new Date(firstNow.getTime() + 60 * 60 * 1000));
    expect(sameIncident).toMatchObject({ notified: false, signals: expect.any(Array) });
    const [quarantineAlert] = await db
      .select({ observations: assistantHealthAlerts.observationCount })
      .from(assistantHealthAlerts)
      .where(
        and(
          eq(assistantHealthAlerts.agentId, agentId),
          eq(assistantHealthAlerts.kind, 'graph_quarantined'),
        ),
      );
    expect(quarantineAlert?.observations).toBe(2);

    const reminder = await monitor(new Date(firstNow.getTime() + 8 * 24 * 60 * 60 * 1000));
    expect(reminder).toMatchObject({
      notified: true,
      signals: [expect.stringContaining('quarantined')],
    });
    const reminderNotices = await diagnostics();
    expect(reminderNotices).toHaveLength(2);

    await db
      .update(knowledgeGraphSources)
      .set({ status: 'ready' })
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    const resolved = await monitor(new Date(firstNow.getTime() + 8 * 24 * 60 * 60 * 1000 + 1));
    expect(resolved).toEqual({ signals: [], notified: false });
    const unresolved = await db
      .select({ kind: assistantHealthAlerts.kind })
      .from(assistantHealthAlerts)
      .where(
        and(eq(assistantHealthAlerts.agentId, agentId), eq(assistantHealthAlerts.status, 'open')),
      );
    expect(unresolved).toEqual([]);

    // Schedulers may overlap around a deploy. Reopening the alert is claimed
    // atomically, so concurrent monitors still produce one owner message.
    await db
      .update(knowledgeGraphSources)
      .set({ status: 'quarantined' })
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    const concurrentNow = new Date(firstNow.getTime() + 8 * 24 * 60 * 60 * 1000 + 2);
    const concurrent = await Promise.all([monitor(concurrentNow), monitor(concurrentNow)]);
    expect(concurrent.filter((result) => result.notified)).toHaveLength(1);
    const concurrentNotices = await diagnostics();
    expect(concurrentNotices).toHaveLength(3);
  });

  it('resolves graph-only alerts while GraphRAG is disabled', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} disabled graph source`,
        contentHash: `${MARKER}-disabled-graph`,
        embedding: new Array(1536).fill(0.01),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    await db.insert(knowledgeGraphSources).values({
      memoryId: memory.id,
      contentHash: `${MARKER}-disabled-graph`,
      status: 'quarantined',
      attempts: 4,
      lastError: 'provider outage',
    });
    await db.insert(recallMetrics).values(
      Array.from({ length: 3 }, () => ({
        agentId,
        path: 'chat',
        graphAttempted: true,
        graphFailed: true,
        historyFailed: true,
        historyTier: 'none',
      })),
    );

    const enabled = await monitor();
    expect(enabled.signals.some((signal) => signal.includes('GraphRAG'))).toBe(true);
    resetConfigForTest();
    loadConfig({ CHAT_RECALL_ENABLED: 'false', GRAPH_RAG_ENABLED: 'false' });
    const result = await monitor();
    expect(result.signals.every((signal) => !signal.includes('GraphRAG'))).toBe(true);
    const graphAlerts = await db
      .select({ status: assistantHealthAlerts.status })
      .from(assistantHealthAlerts)
      .where(
        and(
          eq(assistantHealthAlerts.agentId, agentId),
          inArray(assistantHealthAlerts.kind, [
            'graph_quarantined',
            'graph_stale_pending',
            'graph_recall_unavailable',
            'history_recall_unavailable',
          ]),
        ),
      );
    expect(graphAlerts.every((alert) => alert.status === 'resolved')).toBe(true);
  });

  it('alerts when graph indexing falls behind more than two sync batches', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await db.insert(memories).values(
      Array.from({ length: 50 }, (_, index) => ({
        agentId,
        category: 'knowledge' as const,
        kind: 'fact',
        content: `${MARKER} graph backlog fact ${index}`,
        contentHash: `${MARKER}-graph-backlog-${index}`,
        originTrust: 'owner' as const,
      })),
    );

    const result = await monitor();
    expect(
      result.signals.some((signal) =>
        signal.includes('GraphRAG source facts are waiting to be indexed'),
      ),
    ).toBe(true);
  });
});
