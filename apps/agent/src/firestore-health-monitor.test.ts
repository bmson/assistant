import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreScheduleRepository,
} from '@assistant/firestore';
import { taskActivityDiagnostics } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAssistantHealthMonitor } from '../../../packages/core/src/workflow/health-monitor.js';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import {
  disposeStore,
  emulatorStore,
  seedBudget,
} from '../../../packages/firestore/src/test-store.js';

const HOUR = 3600 * 1000;

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore assistant health monitor', () => {
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  let store: InstallationStore;
  let persistence: ReturnType<typeof createFirestoreExecutionPersistence>;
  let sqlAccesses: string[];
  let db: Db;

  beforeEach(async () => {
    vi.stubEnv('GRAPH_RAG_ENABLED', 'true');
    vi.stubEnv('CHAT_RECALL_ENABLED', 'true');
    resetConfigForTest();
    store = emulatorStore();
    sqlAccesses = [];
    db = new Proxy(
      {},
      {
        get: (_target, property) => {
          sqlAccesses.push(String(property));
          throw new Error(`Unexpected SQL access: ${String(property)}`);
        },
      },
    ) as Db;
    persistence = createFirestoreExecutionPersistence(store, agentId, {
      provider: 'synthetic',
      model: 'health-fixture',
      dimensions: 1536,
      revision: '1',
    });
    await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
    await seedBudget(store);
    await new FirestoreScheduleRepository(store).ensure({
      name: 'pulse',
      agentId,
      enabled: false,
      cron: '*/20 * * * *',
      nextRunAt: null,
      taskTemplate: { type: 'scheduled', job: 'pulse.check' },
    });
  });

  afterEach(async () => {
    await disposeStore(store);
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  const monitor = async (now: Date) => {
    const { task } = await persistence.tasks.createTask({
      agentId,
      type: 'scheduled',
      trust: 'assistant',
      trigger: { source: 'schedule', payload: { job: 'health.monitor' } },
    });
    return runAssistantHealthMonitor(
      {
        db,
        ...(persistence.assistantHealth
          ? { health: persistence.assistantHealth, graphSync: persistence.graphSync }
          : {}),
        saveDiagnostic: async (id, text) => {
          expect(
            await persistence.tasks.appendActivityDiagnostic({
              agentId,
              taskId: task.id,
              diagnostic: { id, text },
            }),
          ).toBe(true);
        },
      },
      { agentId, now },
    );
  };

  async function diagnosticTexts(): Promise<string[]> {
    const rows = await store.collection('tasks').where('agentId', '==', agentId).get();
    expect((await store.collection('messages').get()).empty).toBe(true);
    return rows.docs
      .sort(
        (left, right) =>
          (left.get('createdAt')?.toMillis() ?? 0) - (right.get('createdAt')?.toMillis() ?? 0),
      )
      .flatMap((row) => taskActivityDiagnostics(row.get('state')).map(({ text }) => text));
  }

  async function seedIncident(now: Date) {
    const memoryId = randomUUID();
    await store.doc('memories', memoryId).set({ id: memoryId, agentId, category: 'knowledge' });
    await store.doc('knowledgeGraphSources', memoryId).set({
      memoryId,
      contentHash: 'quarantined',
      status: 'quarantined',
      attempts: 4,
      lastError: 'provider outage',
      extractionVersion: 1,
      nextRetryAt: null,
      subjectContactId: null,
      createdAt: now,
      updatedAt: now,
    });
    // Another owner's quarantined source and failures never count here.
    const foreignMemory = randomUUID();
    await store.doc('memories', foreignMemory).set({ id: foreignMemory, agentId: foreignAgentId });
    await store.doc('knowledgeGraphSources', foreignMemory).set({
      memoryId: foreignMemory,
      status: 'quarantined',
      updatedAt: now,
    });
    for (const owner of [agentId, agentId, foreignAgentId]) {
      const taskId = randomUUID();
      await store.doc('tasks', taskId).set({ id: taskId, agentId: owner });
      await store.doc('responseChecks', taskId).set({
        id: taskId,
        taskId,
        createdAt: now,
        outputVerificationUnavailable: true,
        blocked: false,
        mustActRetries: 1,
        degradedSteps: 0,
      });
    }
    for (let index = 0; index < 3; index += 1) {
      const id = randomUUID();
      await store.doc('recallMetrics', id).set({
        id,
        agentId,
        graphFailed: true,
        historyFailed: true,
        createdAt: now,
      });
    }
    return memoryId;
  }

  it('stays quiet for a healthy owner', async () => {
    expect(await monitor(new Date())).toEqual({ signals: [], notified: false });
    expect(sqlAccesses).toEqual([]);
  });

  it('alerts once, reminds weekly, and resolves, matching the PostgreSQL monitor', async () => {
    const firstNow = new Date();
    const memoryId = await seedIncident(firstNow);

    const first = await monitor(firstNow);
    expect(first.notified).toBe(true);
    expect(first.signals).toHaveLength(5);
    const [notice] = await diagnosticTexts();
    expect(notice).toContain('1 GraphRAG source quarantined after bounded retries');
    expect(notice).toContain('verification was unavailable 2 times');
    expect(notice).toContain('2 required-action steps');
    expect(notice).toContain('GraphRAG recall was unavailable 3 times');
    expect(notice).toContain('Conversation memory recall was unavailable 3 times');

    // The next pass records the observation without repeating the message.
    expect(await monitor(new Date(firstNow.getTime() + HOUR))).toMatchObject({ notified: false });
    const alerts = await store.collection('assistantHealthAlerts').get();
    const quarantine = alerts.docs.find((doc) => doc.get('kind') === 'graph_quarantined');
    expect(quarantine?.get('observationCount')).toBe(2);

    // A week later the unresolved graph incident is reminded; quality rows aged out.
    const reminder = await monitor(new Date(firstNow.getTime() + 8 * 24 * HOUR));
    expect(reminder).toMatchObject({
      notified: true,
      signals: [expect.stringContaining('quarantined')],
    });
    expect(await diagnosticTexts()).toHaveLength(2);

    await store.doc('knowledgeGraphSources', memoryId).update({ status: 'ready' });
    expect(await monitor(new Date(firstNow.getTime() + 8 * 24 * HOUR + 1))).toEqual({
      signals: [],
      notified: false,
    });
    const open = (await store.collection('assistantHealthAlerts').get()).docs.filter(
      (doc) => doc.get('status') === 'open',
    );
    expect(open).toEqual([]);
    expect(sqlAccesses).toEqual([]);
  });

  it('reopens an imported alert under its legacy key instead of duplicating it', async () => {
    const now = new Date();
    await seedIncident(now);
    await store.doc('assistantHealthAlerts', 'legacy-row').set({
      id: 'legacy-row',
      agentId,
      kind: 'graph_quarantined',
      detail: 'imported',
      status: 'resolved',
      observationCount: 7,
      firstSeenAt: new Date(0),
      lastSeenAt: new Date(0),
      lastNotifiedAt: new Date(0),
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await monitor(now);
    const quarantine = (await store.collection('assistantHealthAlerts').get()).docs.filter(
      (doc) => doc.get('kind') === 'graph_quarantined',
    );
    expect(
      quarantine.map((doc) => [doc.get('id'), doc.get('status'), doc.get('observationCount')]),
    ).toEqual([['legacy-row', 'open', 8]]);
    expect(sqlAccesses).toEqual([]);
  });

  it('runs as the scheduled health.monitor job without PostgreSQL', async () => {
    await seedIncident(new Date());
    const unavailable = new Proxy(
      {},
      {
        get: (_target, property) => {
          throw new Error(`Unexpected access: ${String(property)}`);
        },
      },
    );
    const deps: ExecutorDeps = {
      db,
      router: unavailable as ExecutorDeps['router'],
      dispatcher: unavailable as ExecutorDeps['dispatcher'],
      persistence,
    };
    const { task } = await persistence.tasks.createTask({
      agentId,
      type: 'scheduled',
      trust: 'assistant',
      trigger: { source: 'schedule', payload: { job: 'health.monitor' } },
    });
    expect(await executeTask(deps, task.id)).toEqual({
      outcome: 'done',
      detail: 'health monitor: recorded 5 signal(s)',
    });
    expect(await diagnosticTexts()).toHaveLength(1);
    expect(sqlAccesses).toEqual([]);
  });
});
