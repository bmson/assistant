import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import type { ExecutionPersistence, TaskLease } from '@assistant/persistence';
import type { taskFixture } from '@assistant/persistence/testing';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import type { ModelMessage } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { recordBrowserJobResult } from '../../../packages/core/src/workflow/browser.js';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { decodeRecord } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const enabled = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');
type OutcomeKind = 'effect' | 'approval' | 'budget' | 'job';
type MatrixCall = { toolCallId: string; toolName: string; input: Record<string, unknown> };
type TestTask = ReturnType<typeof taskFixture>;

let store: InstallationStore;
let persistence: ReturnType<typeof createFirestoreExecutionPersistence>;
const tasks = new Set<string>();
const agentId = randomUUID();
const conversationId = randomUUID();

function scriptedRouter(calls: MatrixCall[]) {
  let stepCalls = 0;
  const terminalRequests: string[][] = [];
  const router = {
    async object() {
      return {
        ok: true,
        modelId: 'fake/firestore-r1',
        degraded: false,
        object: { action: 'workflow', reasoning: '', steps: ['execute batch'], missingInfo: [] },
      };
    },
    async step(_role: string, options: { messages?: ModelMessage[] }) {
      stepCalls += 1;
      if (stepCalls === 1)
        return {
          ok: true,
          modelId: 'fake/firestore-r1',
          degraded: false,
          text: '',
          toolCalls: calls,
        };
      terminalRequests.push(
        (options.messages ?? []).flatMap((message) =>
          message.role === 'tool' && Array.isArray(message.content)
            ? message.content.flatMap((part) =>
                part.type === 'tool-result' && typeof part.toolCallId === 'string'
                  ? [part.toolCallId]
                  : [],
              )
            : [],
        ),
      );
      return {
        ok: true,
        modelId: 'fake/firestore-r1',
        degraded: false,
        text: 'The recorded batch is complete.',
        toolCalls: [],
      };
    },
    async embed(texts: string[]) {
      return texts.map(() => new Array(1536).fill(0.01));
    },
  };
  return {
    router: router as unknown as ExecutorDeps['router'],
    terminalRequests,
    getStepCalls: () => stepCalls,
  };
}

function makeRegistry(
  effects: Map<string, number>,
  jobTokens: Map<string, string>,
  completedJobs: Set<string>,
) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'r1.effect',
    description: 'Synthetic local effect for Firestore executor qualification.',
    inputSchema: z.object({ effectId: z.string() }),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    idempotencyKey: (args) => `fs-r1-effect:${String((args as { effectId: string }).effectId)}`,
    execute: async (args, context) => {
      const id =
        context.execution?.modelToolCallId ?? String((args as { effectId: string }).effectId);
      effects.set(id, (effects.get(id) ?? 0) + 1);
      return { effectId: id, completed: true };
    },
  });
  registry.register(
    {
      name: 'r1.approval',
      description: 'Synthetic approval-gated effect for Firestore executor qualification.',
      inputSchema: z.object({ effectId: z.string() }),
      risk: 'approval',
      acceptsUntrustedInput: true,
      approvalSummary: (args) => `approve ${String((args as { effectId: string }).effectId)}`,
      idempotencyKey: (args) => `fs-r1-approval:${String((args as { effectId: string }).effectId)}`,
      execute: async (args, context) => {
        const id =
          context.execution?.modelToolCallId ?? String((args as { effectId: string }).effectId);
        effects.set(id, (effects.get(id) ?? 0) + 1);
        return { effectId: id, completed: true };
      },
    },
    { outwardFacing: true },
  );
  registry.register({
    name: 'r1.budget',
    description: 'Synthetic ordinary effect held once by the test budget gate.',
    inputSchema: z.object({ effectId: z.string() }),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    idempotencyKey: (args) => `fs-r1-budget:${String((args as { effectId: string }).effectId)}`,
    execute: async (args, context) => {
      const id =
        context.execution?.modelToolCallId ?? String((args as { effectId: string }).effectId);
      effects.set(id, (effects.get(id) ?? 0) + 1);
      return { effectId: id, completed: true };
    },
  });
  registry.register({
    name: 'r1.job',
    description: 'Synthetic durable asynchronous job for Firestore executor qualification.',
    inputSchema: z.object({ effectId: z.string() }),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    execute: async (args, context) => {
      const id =
        context.execution?.modelToolCallId ?? String((args as { effectId: string }).effectId);
      if ([...jobTokens.keys()].some((previous) => !completedJobs.has(previous)))
        throw new Error('a second Firestore browser job was staged before the prior job completed');
      const callbackToken = randomUUID();
      jobTokens.set(id, callbackToken);
      const pending = {
        pending: 'browser_job_pending',
        callbackToken,
        timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      };
      if (!context.execution || !context.stageBrowserJob)
        throw new Error('Firestore job tool lacks durable staging context');
      await context.stageBrowserJob({ ...context.execution, pending });
      return pending;
    },
  });
  return registry;
}

function makeDispatcher(
  effects: Map<string, number>,
  budgetCallIds: string[],
  jobTokens: Map<string, string>,
  completedJobs: Set<string>,
  executionPersistence: ExecutionPersistence = persistence,
) {
  const unavailable = new Proxy(
    {},
    {
      get: (_target, property) => {
        throw new Error(`Unexpected PostgreSQL access: ${String(property)}`);
      },
    },
  ) as Db;
  const registry = makeRegistry(effects, jobTokens, completedJobs);
  const actual = new ToolDispatcher(
    unavailable,
    registry,
    executionPersistence.toolExecution,
    executionPersistence.costs,
    executionPersistence.approvals,
    executionPersistence.approvalPolicies,
  );
  const unblocked = new Set<string>();
  return {
    toolDefs: (
      trust: Parameters<typeof actual.toolDefs>[0],
      scope?: { isMissionSession: boolean },
    ) => actual.toolDefs(trust, scope),
    resultIsUntrusted: (name: string) => actual.resultIsUntrusted(name),
    dispatch: async (input: Parameters<typeof actual.dispatch>[0]) => {
      if (
        budgetCallIds.includes(input.modelToolCallId ?? '') &&
        !unblocked.has(input.modelToolCallId ?? '')
      ) {
        unblocked.add(input.modelToolCallId ?? '');
        return {
          kind: 'budget_blocked' as const,
          reason: 'synthetic budget cap',
          resumeAt: new Date(Date.now() + 60_000),
        };
      }
      return actual.dispatch(input);
    },
    executeApproved: (toolCallId: string, context: Parameters<typeof actual.executeApproved>[1]) =>
      actual.executeApproved(toolCallId, context),
  } as ExecutorDeps['dispatcher'];
}

function matrixCalls(order: OutcomeKind[], prefix: string): MatrixCall[] {
  return order.map((kind, index) => {
    const toolCallId = `${prefix}-${index}-${kind}`;
    return { toolCallId, toolName: `r1.${kind}`, input: { effectId: toolCallId } };
  });
}

function expectQueuedJobTail(state: unknown, calls: MatrixCall[], jobIndex: number) {
  const batch = (state as { pendingToolBatch?: { calls?: Array<{ status: string }> } })
    .pendingToolBatch?.calls;
  expect(batch).toHaveLength(calls.length);
  expect(batch?.[jobIndex]?.status).toBe('job');
  expect(batch?.slice(jobIndex + 1).map((call) => call.status)).toEqual(
    calls.slice(jobIndex + 1).map(() => 'queued'),
  );
}

function baseDeps(
  router: ExecutorDeps['router'],
  dispatcher: ExecutorDeps['dispatcher'],
): ExecutorDeps {
  const unavailable = new Proxy(
    {},
    {
      get: (_target, property) => {
        throw new Error(`Unexpected PostgreSQL access: ${String(property)}`);
      },
    },
  ) as Db;
  return { db: unavailable, router, dispatcher, persistence } as ExecutorDeps;
}

async function createTask(): Promise<TestTask> {
  const created = await persistence.tasks.createTask({
    agentId,
    conversationId,
    type: 'adhoc',
    trust: 'owner',
    trigger: { source: 'internal', payload: {} },
  });
  tasks.add(created.task.id);
  return created.task as TestTask;
}

async function due(taskId: string) {
  await store
    .doc('tasks', taskId)
    .update({ status: 'pending', runAfter: new Date(Date.now() - 1000) });
}

async function recoverUntilDone(input: {
  taskId: string;
  router: ExecutorDeps['router'];
  dispatcher: ExecutorDeps['dispatcher'];
  calls: MatrixCall[];
  jobTokens: Map<string, string>;
  completedJobs?: Set<string>;
  faultedPersistence?: ExecutionPersistence;
}) {
  const callbacks = new Set<string>();
  const deps = baseDeps(input.router, input.dispatcher);
  if (input.faultedPersistence) deps.persistence = input.faultedPersistence;
  for (let recovery = 0; recovery < 12; recovery += 1) {
    const snapshot = await store.doc('tasks', input.taskId).get();
    const task = decodeRecord<TestTask>(snapshot.data());
    const pendingJob = (task.state as { pendingJob?: { toolCallId?: string } } | null)?.pendingJob;
    const modelCallId = pendingJob?.toolCallId;
    if (modelCallId && !callbacks.has(modelCallId)) {
      const token = input.jobTokens.get(modelCallId);
      if (!token) throw new Error(`missing callback token for ${modelCallId}`);
      const result = await recordBrowserJobResult(persistence.executionJobs, {
        taskId: input.taskId,
        token,
        result: { ok: true, effectId: modelCallId },
      });
      if (!result.ok) throw new Error(`Firestore fake job callback failed: ${result.error}`);
      callbacks.add(modelCallId);
      input.completedJobs?.add(modelCallId);
    }
    const approvalSnapshot = await store
      .collection('approvals')
      .where('taskId', '==', input.taskId)
      .get();
    for (const doc of approvalSnapshot.docs) {
      const approval = decodeRecord<{ id: string; status: string }>(doc.data());
      if (approval.status !== 'pending') continue;
      const resolved = await persistence.approvals.resolve({
        approvalId: approval.id,
        decision: 'approved',
        via: 'web',
        deferNotification: true,
      });
      if (!resolved.ok) throw new Error(`approval ${approval.id} did not resolve`);
    }
    await due(input.taskId);
    const result = await executeTask(deps, input.taskId);
    if (result.outcome === 'done') return;
    if (!['parked', 'sleeping', 'failed'].includes(result.outcome))
      throw new Error(`unexpected Firestore recovery outcome ${result.outcome}`);
  }
  throw new Error('Firestore R1 task did not complete within recovery bound');
}

function faultingPersistence(
  fault:
    | 'batch-checkpoint'
    | 'effect-checkpoint'
    | 'approval-checkpoint'
    | 'budget-park'
    | 'job-stage',
) {
  const base = persistence;
  let injected = false;
  const taskPort = base.tasks;
  const jobPort = base.executionJobs;
  const toolPort = base.toolExecution;
  const wrappedTasks = Object.create(taskPort) as typeof taskPort;
  const wrappedJobs = Object.create(jobPort) as typeof jobPort;
  const wrappedTools = Object.create(toolPort) as typeof toolPort;
  wrappedTasks.checkpoint = async (
    lease: TaskLease,
    state: unknown,
    extra?: Parameters<typeof taskPort.checkpoint>[2],
  ) => {
    const calls =
      (state as { pendingToolBatch?: { calls?: Array<{ toolName: string; status: string }> } })
        .pendingToolBatch?.calls ?? [];
    const queued = calls.length === 3 && calls.every((call) => call.status === 'queued');
    const effectReceipt =
      (state as { completedToolCallIds?: string[] }).completedToolCallIds?.length === 1 &&
      calls.some((call) => call.toolName === 'r1.effect' && call.status === 'settled');
    const approvalReceipt = calls.some(
      (call) => call.toolName === 'r1.approval' && call.status === 'awaiting_approval',
    );
    if (!injected && fault === 'batch-checkpoint' && queued) {
      injected = true;
      const saved = await taskPort.checkpoint(lease, state, extra);
      if (saved) throw new Error('simulated worker death after Firestore batch journal commit');
      return saved;
    }
    if (!injected && fault === 'effect-checkpoint' && effectReceipt) {
      injected = true;
      throw new Error('simulated worker death after effect receipt before task checkpoint');
    }
    if (!injected && fault === 'approval-checkpoint' && approvalReceipt) {
      injected = true;
      throw new Error('simulated worker death after approval row before task checkpoint');
    }
    return taskPort.checkpoint(lease, state, extra);
  };
  wrappedTasks.parkForBudget = async (...args) => {
    const saved = await taskPort.parkForBudget(...args);
    if (saved && !injected && fault === 'budget-park') {
      injected = true;
      throw new Error('simulated worker death after Firestore budget park commit');
    }
    return saved;
  };
  wrappedTools.outcome = async (input) => {
    if (!injected && fault === 'job-stage' && input.status === 'succeeded') {
      const loaded = await toolPort.load(input.agentId, input.taskId, input.toolCallId);
      if (loaded?.toolCall.toolName === 'r1.job' && loaded.toolCall.status === 'executing') {
        injected = true;
        // The job stage and task journal are already committed. Throw before
        // the tool terminal receipt, modeling process death at that boundary.
        throw new Error('simulated worker death after Firestore job staging commit');
      }
    }
    return toolPort.outcome(input);
  };
  const wrapped = {
    ...base,
    tasks: wrappedTasks,
    executionJobs: wrappedJobs,
    toolExecution: wrappedTools,
  };
  return { persistence: wrapped as unknown as ExecutionPersistence, wasInjected: () => injected };
}

beforeAll(async () => {
  store = emulatorStore();
  persistence = createFirestoreExecutionPersistence(store, agentId, {
    provider: 'synthetic',
    model: 'firestore-r1',
    dimensions: 1536,
    revision: 'test-r1',
  });
  await store.doc('agents', agentId).set({ id: agentId, name: 'R1 test agent', timezone: 'UTC' });
  await store
    .doc('conversations', conversationId)
    .set({ id: conversationId, agentId, channel: 'chat', trust: 'owner' });
});

afterAll(async () => {
  if (store) await disposeStore(store);
});

describe.skipIf(!enabled)(
  'R1 three-call mixed outcome recovery (Firestore executor integration)',
  () => {
    const kinds: OutcomeKind[] = ['effect', 'approval', 'budget', 'job'];
    const triples = kinds.flatMap((a) => kinds.flatMap((b) => kinds.map((c) => [a, b, c])));

    it.each(triples.map((order) => ({ order })))(
      'settles ordered batch $order exactly once',
      async ({ order }) => {
        const task = await createTask();
        const calls = matrixCalls(order, `fs-r1-${randomUUID().slice(0, 8)}`);
        const effects = new Map<string, number>();
        const jobTokens = new Map<string, string>();
        const completedJobs = new Set<string>();
        // The test-local tool wrapper retains callback tokens while all task, tool,
        // approval, cost, and job persistence remains the actual Firestore adapter.
        const budgetCallIds = calls
          .filter((call) => call.toolName === 'r1.budget')
          .map((call) => call.toolCallId);
        const dispatcher = makeDispatcher(effects, budgetCallIds, jobTokens, completedJobs);
        const scripted = scriptedRouter(calls);
        const deps = baseDeps(scripted.router, dispatcher);
        const first = await executeTask(deps, task.id);
        const jobIndex = order.indexOf('job');
        if (jobIndex >= 0 && jobIndex < calls.length - 1) {
          const snapshot = await store.doc('tasks', task.id).get();
          const state = decodeRecord<TestTask>(snapshot.data()).state as {
            pendingJob?: unknown;
          };
          if (state.pendingJob) expectQueuedJobTail(state, calls, jobIndex);
        }
        if (first.outcome !== 'done')
          await recoverUntilDone({
            taskId: task.id,
            router: scripted.router,
            dispatcher,
            calls,
            jobTokens,
            completedJobs,
          });
        await expectExecution(task.id, calls, effects, scripted);
      },
    );

    it('keeps later calls queued through an early wake, then resumes after job timeout', async () => {
      const task = await createTask();
      const calls = matrixCalls(['effect', 'job', 'approval'], `fs-r1-timeout-${randomUUID()}`);
      const effects = new Map<string, number>();
      const jobTokens = new Map<string, string>();
      const completedJobs = new Set<string>();
      const dispatcher = makeDispatcher(effects, [], jobTokens, completedJobs);
      const scripted = scriptedRouter(calls);
      const deps = baseDeps(scripted.router, dispatcher);

      expect((await executeTask(deps, task.id)).outcome).toBe('sleeping');
      const stagedSnapshot = await store.doc('tasks', task.id).get();
      const stagedTask = decodeRecord<TestTask>(stagedSnapshot.data());
      const stagedState = stagedTask.state as { pendingJob?: { timeoutAt: string } };
      expect(stagedState.pendingJob).toBeDefined();
      if (!stagedState.pendingJob) throw new Error('Firestore job did not persist pending marker');
      expectQueuedJobTail(stagedState, calls, 1);

      await due(task.id);
      expect((await executeTask(deps, task.id)).outcome).toBe('sleeping');
      expect(scripted.getStepCalls()).toBe(1);
      const earlySnapshot = await store.doc('tasks', task.id).get();
      const earlyTask = decodeRecord<TestTask>(earlySnapshot.data());
      expectQueuedJobTail(earlyTask.state, calls, 1);

      const expired = structuredClone(earlyTask.state) as typeof earlyTask.state & {
        pendingJob: { timeoutAt: string };
      };
      expired.pendingJob.timeoutAt = new Date(Date.now() - 1000).toISOString();
      await store.doc('tasks', task.id).update({ state: expired });
      await due(task.id);
      expect((await executeTask(deps, task.id)).outcome).toBe('parked');
      const approvalDocs = await store.collection('approvals').where('taskId', '==', task.id).get();
      expect(approvalDocs.size).toBe(1);
      expect(scripted.getStepCalls()).toBe(1);
      const approval = decodeRecord<{ id: string; status: string }>(approvalDocs.docs[0]?.data());
      expect(
        await persistence.approvals.resolve({
          approvalId: approval.id,
          decision: 'approved',
          via: 'web',
          deferNotification: true,
        }),
      ).toMatchObject({ ok: true });
      await due(task.id);
      expect((await executeTask(deps, task.id)).outcome).toBe('done');
      expect(scripted.getStepCalls()).toBe(2);
      expect(scripted.terminalRequests[0]?.sort()).toEqual(
        calls.map((call) => call.toolCallId).sort(),
      );
      expect([...effects.values()].every((count) => count === 1)).toBe(true);
    });

    it.each([
      'batch-checkpoint',
      'effect-checkpoint',
      'approval-checkpoint',
      'budget-park',
      'job-stage',
    ] as const)('restarts from Firestore journal after %s', async (fault) => {
      const task = await createTask();
      const order: OutcomeKind[] =
        fault === 'budget-park' ? ['effect', 'approval', 'budget'] : ['effect', 'approval', 'job'];
      const calls = matrixCalls(order, `fs-r1-crash-${randomUUID().slice(0, 8)}`);
      const effects = new Map<string, number>();
      const jobTokens = new Map<string, string>();
      const completedJobs = new Set<string>();
      const budgetCallIds = fault === 'budget-park' && calls[2] ? [calls[2].toolCallId] : [];
      const wrapped = faultingPersistence(fault);
      const dispatcher = makeDispatcher(
        effects,
        budgetCallIds,
        jobTokens,
        completedJobs,
        wrapped.persistence,
      );
      const scripted = scriptedRouter(calls);
      const deps = baseDeps(scripted.router, dispatcher);
      deps.persistence = wrapped.persistence;
      const first = await executeTask(deps, task.id);
      expect(wrapped.wasInjected()).toBe(true);
      if (fault === 'job-stage') expect(first.outcome).toBe('parked');
      else if (fault !== 'budget-park') expect(first.outcome).toBe('failed');
      if (first.outcome !== 'done')
        await recoverUntilDone({
          taskId: task.id,
          router: scripted.router,
          dispatcher,
          calls,
          jobTokens,
          completedJobs,
          faultedPersistence: wrapped.persistence,
        });
      await expectExecution(task.id, calls, effects, scripted);
    });
  },
);

async function expectExecution(
  taskId: string,
  calls: MatrixCall[],
  effects: Map<string, number>,
  scripted: ReturnType<typeof scriptedRouter>,
) {
  const callSnapshot = await store.collection('toolCalls').where('taskId', '==', taskId).get();
  const byModelId = new Map(
    callSnapshot.docs.map((doc) => {
      const row = decodeRecord<{
        id: string;
        status: string;
        decision: { modelToolCallId?: string } | null;
      }>(doc.data());
      return [row.decision?.modelToolCallId ?? '', row] as const;
    }),
  );
  const dispatched = calls;
  expect([...byModelId.keys()].sort()).toEqual(dispatched.map((call) => call.toolCallId).sort());
  for (const call of dispatched) expect(byModelId.get(call.toolCallId)?.status).toBe('succeeded');
  expect([...effects.entries()].sort()).toEqual(
    dispatched
      .filter((call) => call.toolName !== 'r1.job')
      .map((call) => [call.toolCallId, 1])
      .sort(),
  );
  expect(scripted.getStepCalls()).toBe(2);
  expect(scripted.terminalRequests).toHaveLength(1);
  expect(scripted.terminalRequests[0]?.sort()).toEqual(calls.map((call) => call.toolCallId).sort());
  const taskSnapshot = await store.doc('tasks', taskId).get();
  const task = decodeRecord<TestTask>(taskSnapshot.data());
  expect(task.status).toBe('done');
}
