import { randomUUID } from 'node:crypto';
import { createInstallationStore, FirestoreTaskRepository } from '@assistant/firestore';
import { type InstalledModuleSet, noopOwnerNotifier } from '@assistant/modules';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from './deps.js';
import { executeAgentTask } from './task-runner.js';

const appResume = vi.hoisted(() => vi.fn(async () => 200));
vi.mock('@assistant/application', () => ({ resumeAdmittedChatTask: appResume }));

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('agent task repository routing', () => {
  let tasks: FirestoreTaskRepository;
  let close: () => Promise<void>;
  let store: ReturnType<typeof createInstallationStore>;

  beforeEach(() => {
    vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
    store = createInstallationStore({
      projectId: 'demo-assistant-test',
      installationId: `task-runner-${randomUUID()}`,
    });
    tasks = new FirestoreTaskRepository(store);
    close = async () => {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
    };
  });

  afterEach(async () => {
    await close();
    vi.unstubAllEnvs();
  });

  function deps(modules: InstalledModuleSet): AgentDeps {
    const sqlThrowingDb = new Proxy(
      {},
      {
        get: (_target, property) => {
          throw new Error(`unexpected SQL access: ${String(property)}`);
        },
      },
    );
    return {
      db: sqlThrowingDb,
      persistence: { tasks },
      firestoreStore: store,
      modules,
      outOfBandNotifier: noopOwnerNotifier,
      config: {},
      router: {},
      registry: {},
      dispatcher: {},
      workspace: {},
    } as unknown as AgentDeps;
  }

  it('dispatches a Firestore task to its deterministic module without SQL', async () => {
    const run = vi.fn(async () => ({ outcome: 'done' as const }));
    const kind = 'firestore_module_dispatch';
    const created = await tasks.createTask({
      agentId: randomUUID(),
      type: 'adhoc',
      trust: 'assistant',
      trigger: { source: 'internal', payload: { kind } },
    });
    const modules = {
      taskHandlerFor: (candidate: string) => (candidate === kind ? { kind, run } : undefined),
      taskKindUnavailable: () => null,
      emailObservers: [],
    } as unknown as InstalledModuleSet;

    await expect(executeAgentTask(deps(modules), created.task.id, 0)).resolves.toEqual({
      outcome: 'done',
    });
    expect(run).toHaveBeenCalledWith(expect.any(Object), created.task.id, 0);
  });

  it('claims and cancels an unavailable module task through Firestore without SQL', async () => {
    const kind = 'removed_module_task';
    const unavailable = 'The owning module is not installed.';
    const created = await tasks.createTask({
      agentId: randomUUID(),
      type: 'adhoc',
      trust: 'assistant',
      trigger: { source: 'internal', payload: { kind } },
    });
    const modules = {
      taskHandlerFor: () => undefined,
      taskKindUnavailable: (candidate: string) => (candidate === kind ? unavailable : null),
      emailObservers: [],
    } as unknown as InstalledModuleSet;

    await expect(executeAgentTask(deps(modules), created.task.id, 0)).resolves.toEqual({
      outcome: 'cancelled',
      detail: unavailable,
    });
    expect(await tasks.getTask(created.task.id)).toMatchObject({
      status: 'cancelled',
      progress: unavailable,
      leaseToken: null,
    });
  });

  it('cancels an arrival task before model dispatch when its opted-in source reference expired', async () => {
    const agentId = randomUUID();
    await store.doc('agents', agentId).set({ id: agentId });
    const created = await tasks.createTask({
      agentId,
      type: 'adhoc',
      trust: 'assistant',
      trigger: {
        source: 'internal',
        agentId,
        trust: 'assistant',
        externalEventId: `arrival:${agentId}:2026-09-24`,
        payload: {
          kind: 'arrival',
          arrivalObservationId: randomUUID(),
          arrivalExpiresAt: '2026-09-24T11:00:00.000Z',
          instruction: 'generic instruction without location details',
        },
      },
    });
    const run = vi.fn();
    const modules = {
      taskHandlerFor: () => ({ kind: 'arrival', run }),
      taskKindUnavailable: () => null,
      emailObservers: [],
    } as unknown as InstalledModuleSet;

    await expect(
      executeAgentTask(
        {
          ...deps(modules),
          config: { PERSISTENCE_DRIVER: 'firestore', FIRESTORE_AGENT_ID: agentId },
        } as unknown as AgentDeps,
        created.task.id,
        0,
      ),
    ).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(run).not.toHaveBeenCalled();
    const cancelled = await tasks.getTask(created.task.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', externalEventId: null });
    expect(JSON.stringify(cancelled?.trigger)).not.toContain('arrivalObservationId');
    expect(JSON.stringify(cancelled?.trigger)).not.toContain('arrivalExpiresAt');
  });

  it('claims and resumes a stale direct chat admission through the application handler', async () => {
    appResume.mockClear().mockResolvedValue(200);
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const operationId = randomUUID();
    const triggerMessageId = randomUUID();
    const created = await tasks.createTask({
      agentId,
      conversationId,
      type: 'chat_turn',
      trust: 'owner',
      trigger: {
        source: 'chat',
        agentId,
        conversationId,
        trust: 'owner',
        payload: {
          text: 'Say hello.',
          triggerMessageId,
          clientOperationId: operationId,
          chatAdmission: {
            protocol: 'owner-chat-v1',
            clientOperationId: operationId,
            requestHash: 'a'.repeat(64),
            triggerMessageId,
            phase: 'streaming',
            triageOutcome: 'conversational',
          },
        },
      },
    });
    const modules = {
      taskHandlerFor: () => undefined,
      taskKindUnavailable: () => null,
      emailObservers: [],
    } as unknown as InstalledModuleSet;
    const dependencies = deps(modules);
    dependencies.config = {
      PERSISTENCE_DRIVER: 'firestore',
      FIRESTORE_AGENT_ID: agentId,
    } as AgentDeps['config'];

    await expect(executeAgentTask(dependencies, created.task.id, 0)).resolves.toEqual({
      outcome: 'admission_recovered',
      status: 200,
    });
    expect(appResume).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.task.id, status: 'running' }),
      expect.objectContaining({ config: dependencies.config, router: dependencies.router }),
    );
  });
});
