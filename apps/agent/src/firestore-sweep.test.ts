import { randomUUID } from 'node:crypto';
import { loadConfig, resetConfigForTest } from '@assistant/config';
import { firestoreCodeJobUnavailable, sqlOnlyCodeJobs } from '@assistant/core';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  embeddingSpaceKey,
  FirestoreScheduleRepository,
} from '@assistant/firestore';
import {
  installModules,
  type ModuleSweepStep,
  noopOwnerNotifier,
  watchesModule,
} from '@assistant/modules';
import { ToolRegistry } from '@assistant/tools/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import {
  disposeStore,
  emulatorStore,
  seedBudget,
} from '../../../packages/firestore/src/test-store.js';
import type { AgentDeps } from './deps.js';
import { runFirestoreSweep } from './firestore-sweep.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore maintenance sweep', () => {
  const agentId = randomUUID();
  let store: InstallationStore;
  let now: Date;
  let deps: AgentDeps;
  let sqlAccesses: string[];
  let sqlStepRuns: number;
  let portableStepRuns: number;

  beforeEach(async () => {
    vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
    now = new Date('2026-09-24T12:00:00.000Z');
    store = emulatorStore(() => now);
    sqlAccesses = [];
    sqlStepRuns = 0;
    portableStepRuns = 0;
    const unavailable = (name: string) =>
      new Proxy(
        {},
        {
          get: (_target, property) => {
            sqlAccesses.push(`${name}.${String(property)}`);
            throw new Error(`Unexpected ${name} access: ${String(property)}`);
          },
        },
      );
    const db = unavailable('db') as Db;
    const config = {
      ...loadConfig({}),
      PERSISTENCE_DRIVER: 'firestore' as const,
      FIRESTORE_AGENT_ID: agentId,
      FIRESTORE_EMBEDDING_SPACE:
        '{"provider":"synthetic","model":"sweep-fixture","dimensions":1536,"revision":"1"}',
      ASSISTANT_MODULES: ['watches' as const],
    };
    const persistence = createFirestoreExecutionPersistence(store, agentId, {
      provider: 'synthetic',
      model: 'sweep-fixture',
      dimensions: 1536,
      revision: '1',
    });
    const installed = installModules([watchesModule], {
      config,
      db,
      registry: new ToolRegistry(),
      repoRoot: '/tmp/test',
      router: unavailable('router') as never,
      workspace: unavailable('workspace') as never,
      workspacePrefix: 'workspace/test',
      workspaceRoot: '/tmp/test',
      persistence,
    });
    const sqlStep: ModuleSweepStep = {
      name: 'sqlOnlyStep',
      run: async () => {
        sqlStepRuns += 1;
        return 1;
      },
    };
    const portableStep: ModuleSweepStep = {
      name: 'portableStep',
      portable: true,
      run: async (services) => {
        portableStepRuns += 1;
        return services.persistence.driver === 'firestore' ? 1 : 0;
      },
    };
    deps = {
      config,
      db,
      firestoreStore: store,
      firestoreTasks: persistence.tasks,
      persistence,
      router: unavailable('router') as never,
      registry: new ToolRegistry(),
      dispatcher: unavailable('dispatcher') as never,
      workspace: unavailable('workspace') as never,
      modules: { ...installed, sweepSteps: [...installed.sweepSteps, sqlStep, portableStep] },
      outOfBandNotifier: noopOwnerNotifier,
    };
    await seedBudget(store);
    await store.doc('agents', agentId).set({
      id: agentId,
      name: 'Synthetic owner',
      timezone: 'America/Los_Angeles',
    });
  });

  afterEach(async () => {
    await disposeStore(store);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetConfigForTest();
  });

  it('releases stale reservations and runs only portable module steps without SQL', async () => {
    const stale = await persistence().costs.reserve({ source: 'model', estimatedUsd: 0.2 });
    now = new Date(now.getTime() + 121 * 60_000);
    const fresh = await persistence().costs.reserve({ source: 'model', estimatedUsd: 0.1 });
    expect(stale.ok && fresh.ok).toBe(true);

    const result = await runFirestoreSweep(deps);
    expect(result).toEqual({
      ready: true,
      report: {
        expiredApprovalsWoke: 0,
        expiredSuggestions: 0,
        resumedApprovalTasks: 0,
        renotifiedApprovals: 0,
        renotifiedAttention: 0,
        expiredWatches: 0,
        schedulesFired: 0,
        budgetNotices: 0,
        messagesEmbedded: 0,
        purgedExpired: 0,
        agedHistory: 0,
        releasedReservations: 1,
        expiredInboxWatches: 0,
        webWatchFires: 0,
        watchFireEffectsDrained: 0,
        missionReportsRepaired: 0,
        portableStep: 1,
      },
    });
    expect((await persistence().costs.totals()).heldUsd).toBe(0.1);
    expect(sqlStepRuns).toBe(0);
    expect(portableStepRuns).toBe(1);
    expect(sqlAccesses).toEqual([]);
  });

  it('fires portable schedules past disabled jobs and a goal session whose goal is gone', async () => {
    const schedules = new FirestoreScheduleRepository(store);
    const due = new Date(Date.now() - 60_000);
    const ensure = (name: string, taskTemplate: Record<string, unknown>) =>
      schedules.ensure({ agentId, name, cron: '0 9 * * *', taskTemplate, nextRunAt: due });
    // GraphRAG is off here, so the curiosity schedule advances without a task,
    // exactly as a job that cannot run on this persistence would.
    const curiosity = await ensure('knowledge-graph-curiosity', {
      type: 'scheduled',
      job: 'graph.curiosity',
    });
    const goal = await ensure('goal-session', { type: 'scheduled', goalId: randomUUID() });
    const consolidation = await ensure('memory-consolidation', {
      type: 'scheduled',
      job: 'memory.consolidate',
    });

    const result = await runFirestoreSweep(deps);
    expect(result).toMatchObject({ ready: true, report: { schedulesFired: 1 } });
    const tasks = await store.collection('tasks').get();
    expect(tasks.docs.map((doc) => doc.get('trigger.payload.job'))).toEqual(['memory.consolidate']);
    for (const skipped of [curiosity, consolidation]) {
      const row = (await store.doc('schedules', skipped.id).get()).data();
      expect(row?.nextRunAt.toDate().getTime()).toBeGreaterThan(Date.now());
    }
    // As in PostgreSQL, a goal schedule outliving its goal is disabled.
    expect((await store.doc('schedules', goal.id).get()).data()).toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
    expect(sqlAccesses).toEqual([]);
  });

  it('runs suggestion expiry, notices, embeddings, and retention on Firestore alone', async () => {
    vi.stubEnv('HISTORY_RETENTION_DAYS', '30');
    resetConfigForTest();
    const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0.001));
    const embed = vi.fn(async (texts: string[]) => texts.map(() => vector));
    deps = { ...deps, router: { embed } as never };
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const put = (collection: string, row: Record<string, unknown> & { id: string }) =>
      store.doc(collection, row.id).set(encodeRecord(row));
    await put('modelRoles', {
      id: 'embed',
      role: 'embed',
      primaryModel: 'synthetic/sweep-fixture',
      fallbackModel: 'synthetic/sweep-fixture',
      params: {},
    });
    const conversationId = randomUUID();
    await put('conversations', {
      id: conversationId,
      agentId,
      channel: 'chat',
      trust: 'owner',
      title: null,
      isPrimary: true,
      archivedAt: null,
      createdAt: ago(40 * 86_400_000),
      updatedAt: ago(86_400_000),
    });
    await store.doc('primaryConversations', agentId).set({ agentId, conversationId });
    const suggestion = randomUUID();
    await put('suggestions', { id: suggestion, agentId, status: 'pending', expiresAt: ago(1) });
    const stalled = randomUUID();
    await put('tasks', {
      id: stalled,
      agentId,
      conversationId: null,
      trust: 'assistant',
      title: 'Nightly import',
      status: 'needs_attention',
      progress: 'provider refused the upload',
      attentionNotifiedAt: null,
      updatedAt: ago(10 * 60_000),
    });
    const message = randomUUID();
    await put('messages', {
      id: message,
      conversationId,
      role: 'user',
      text: 'where did we land on the lease renewal',
      embedding: null,
      channelMessageId: null,
      createdAt: ago(10 * 60_000),
    });
    const aged = randomUUID();
    await put('messages', {
      id: aged,
      conversationId,
      role: 'assistant',
      text: 'ok',
      embedding: null,
      channelMessageId: null,
      createdAt: ago(31 * 86_400_000),
    });
    await store
      .doc('toolCache', 'expired')
      .set(encodeRecord({ cacheKey: 'expired', expiresAt: now }));
    await persistence().costs.record({ source: 'model', usd: 0.85, description: 'spend' });

    const result = await runFirestoreSweep(deps);
    expect(result).toMatchObject({
      ready: true,
      report: {
        expiredSuggestions: 1,
        renotifiedAttention: 1,
        budgetNotices: 1,
        messagesEmbedded: 1,
        purgedExpired: 1,
        agedHistory: 1,
      },
    });
    expect((await store.doc('suggestions', suggestion).get()).get('status')).toBe('expired');
    expect((await store.doc('tasks', stalled).get()).get('attentionNotifiedAt')).not.toBeNull();
    const texts = (await store.collection('messages').get()).docs.map((doc) => doc.get('text'));
    expect(texts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('I got stuck on “Nightly import” and need you.'),
        expect.stringContaining('Budget: 85% of the daily cap used'),
      ]),
    );
    const embedded = (await store.doc('messages', message).get()).data();
    expect(embedded?.embeddingSpace).toBe(
      embeddingSpaceKey({
        provider: 'synthetic',
        model: 'sweep-fixture',
        dimensions: 1536,
        revision: '1',
      }),
    );
    expect(embed).toHaveBeenCalledWith(['where did we land on the lease renewal'], {
      expectedSpace: {
        provider: 'synthetic',
        model: 'sweep-fixture',
        dimensions: 1536,
        revision: '1',
      },
    });
    expect((await store.doc('messages', aged).get()).exists).toBe(false);
    expect((await store.doc('toolCache', 'expired').get()).exists).toBe(false);

    // A second pass has nothing new to send or embed.
    expect(await runFirestoreSweep(deps)).toMatchObject({
      report: { renotifiedAttention: 0, budgetNotices: 0, messagesEmbedded: 0 },
    });
    expect(sqlAccesses).toEqual([]);
  }, 20_000);

  it('writes no vectors when the embed role no longer produces the configured space', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1]));
    deps = { ...deps, router: { embed } as never };
    await store.doc('modelRoles', 'embed').set({
      role: 'embed',
      primaryModel: 'other/model',
      fallbackModel: 'other/model',
      params: {},
    });
    await store.doc('messages', 'm').set({
      id: 'm',
      conversationId: 'c',
      role: 'user',
      text: 'a message long enough to embed here',
      embedding: null,
      createdAt: new Date(now.getTime() - 600_000),
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runFirestoreSweep(deps)).toMatchObject({ report: { messagesEmbedded: 0 } });
    expect(embed).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(' ')).toContain(
      'Firestore memory embedding role must use synthetic/sweep-fixture',
    );
    expect((await store.doc('messages', 'm').get()).get('embedding')).toBeNull();
    expect(sqlAccesses).toEqual([]);
  });

  it('runs every registered code job on Firestore', () => {
    // A job registered in CODE_JOBS but not admitted as portable is silently
    // skipped under Firestore even when its port and emulator test exist.
    expect(sqlOnlyCodeJobs()).toEqual([]);
  });

  it('names every SQL-only code job and leaves portable ones runnable', () => {
    // Shrinks to nothing as the last jobs are ported; each one left is named.
    for (const job of sqlOnlyCodeJobs())
      expect(firestoreCodeJobUnavailable(job)).toMatch(/not yet available on Firestore/);
    for (const job of [
      'reminder.notify',
      'pulse.check',
      'memory.extract',
      'memory.consolidate',
      'memory.graph_sync',
      'memory.graph_date_backfill',
      'graph.curiosity',
      'briefing.compose',
      'chat.segment',
      'documents.extract',
      'watch.suggest',
      'import.run',
      'voice.ingest',
    ])
      expect(firestoreCodeJobUnavailable(job)).toBeNull();
    // Unknown names are not code jobs; the executor treats them as model tasks.
    expect(firestoreCodeJobUnavailable('not.a.job')).toBeNull();
  });

  it('runs nothing while an imported workspace awaits activation', async () => {
    await store.doc('coordination', 'migration').set({ status: 'pending_activation' });
    await persistence().costs.reserve({ source: 'model', estimatedUsd: 0.2 });
    now = new Date(now.getTime() + 121 * 60_000);

    expect(await runFirestoreSweep(deps)).toEqual({
      ready: false,
      error: 'Firestore installation is not ready for maintenance',
    });
    expect((await persistence().costs.totals()).heldUsd).toBe(0.2);
    expect(portableStepRuns).toBe(0);
    expect(sqlAccesses).toEqual([]);
  });

  function persistence() {
    const value = deps.persistence;
    if (!value) throw new Error('missing persistence');
    return value;
  }
});
