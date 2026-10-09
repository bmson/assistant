import { randomUUID } from 'node:crypto';
import type { DispatcherPort, InboundEvent, ModelRouter, StepCallOutcome } from '@assistant/core';
import {
  BROWSER_JOB_PENDING,
  enqueueTask,
  executeTask,
  getAgent,
  recordBrowserJobResult,
  resolveApproval,
} from '@assistant/core';
import {
  approvals,
  costEvents,
  costReservations,
  createDb,
  createPostgresExecutionPersistence,
  type Db,
  tasks,
  toolCalls,
} from '@assistant/db';
import type { ExecutionPersistence } from '@assistant/persistence';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import type { ModelMessage } from 'ai';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
type OutcomeKind = 'effect' | 'approval' | 'budget' | 'job';
type MatrixCall = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

let db: Db;
let agentId = '';
let dbUp = false;
const taskIds: string[] = [];

function event(): InboundEvent {
  return { source: 'internal', agentId, trust: 'owner', payload: {} };
}

function idsFromToolMessages(messages: ModelMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === 'tool' && Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === 'tool-result' && typeof part.toolCallId === 'string'
            ? [part.toolCallId]
            : [],
        )
      : [],
  );
}

function scriptedRouter(calls: MatrixCall[]) {
  let stepCalls = 0;
  const terminalRequests: string[][] = [];
  const fake = {
    async object() {
      return {
        ok: true,
        modelId: 'fake/r1-matrix',
        degraded: false,
        object: { action: 'workflow', reasoning: '', steps: ['execute batch'], missingInfo: [] },
      };
    },
    async step(_role: string, options: { messages?: ModelMessage[] }): Promise<StepCallOutcome> {
      stepCalls += 1;
      if (stepCalls === 1) {
        return {
          ok: true,
          modelId: 'fake/r1-matrix',
          degraded: false,
          text: '',
          toolCalls: calls,
        };
      }
      const resultIds = idsFromToolMessages(options.messages ?? []);
      terminalRequests.push(resultIds);
      return {
        ok: true,
        modelId: 'fake/r1-matrix',
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
    router: fake as unknown as ModelRouter,
    terminalRequests,
    getStepCalls: () => stepCalls,
  };
}

function makeMatrixTools(
  db: Db,
  effects: Map<string, number>,
  jobTokens: Map<string, string> = new Map(),
  completedJobs: Set<string> = new Set(),
) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'r1.effect',
    description: 'A deterministic local effect receipt for the R1 regression.',
    inputSchema: z.object({ effectId: z.string() }),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    idempotencyKey: (args) => `r1-effect:${String((args as { effectId: string }).effectId)}`,
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
      description: 'A local approval-gated effect for the R1 regression.',
      inputSchema: z.object({ effectId: z.string() }),
      risk: 'approval',
      acceptsUntrustedInput: true,
      approvalSummary: (args) => `approve ${String((args as { effectId: string }).effectId)}`,
      idempotencyKey: (args) => `r1-approval:${String((args as { effectId: string }).effectId)}`,
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
    description: 'An ordinary local effect held once by the test budget gate.',
    inputSchema: z.object({ effectId: z.string() }),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    idempotencyKey: (args) => `r1-budget:${String((args as { effectId: string }).effectId)}`,
    execute: async (args, context) => {
      const id =
        context.execution?.modelToolCallId ?? String((args as { effectId: string }).effectId);
      effects.set(id, (effects.get(id) ?? 0) + 1);
      return { effectId: id, completed: true };
    },
  });
  registry.register({
    name: 'r1.job',
    description: 'A fake staged async job used to exercise durable batch recovery.',
    inputSchema: z.object({ effectId: z.string() }),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    execute: async (args, context) => {
      const id =
        context.execution?.modelToolCallId ?? String((args as { effectId: string }).effectId);
      if ([...jobTokens.keys()].some((previous) => !completedJobs.has(previous)))
        throw new Error('a second browser job was staged before the prior job completed');
      const callbackToken = randomUUID();
      jobTokens.set(id, callbackToken);
      const pending = {
        pending: BROWSER_JOB_PENDING,
        callbackToken,
        timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      };
      if (!context.execution || !context.stageBrowserJob)
        throw new Error('job tool lacks durable execution staging');
      await context.stageBrowserJob({ ...context.execution, pending });
      return pending;
    },
  });
  return new ToolDispatcher(db, registry);
}

function matrixCalls(order: OutcomeKind[], prefix: string): MatrixCall[] {
  return order.map((kind, index) => {
    const toolCallId = `${prefix}-${index}-${kind}`;
    return {
      toolCallId,
      toolName: `r1.${kind}`,
      input: { effectId: toolCallId },
    };
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

function budgetOnce(base: DispatcherPort, budgetCallIds: string[]): DispatcherPort {
  const unblocked = new Set<string>();
  return {
    toolDefs: (trust, scope) => base.toolDefs(trust, scope),
    resultIsUntrusted: (name) => base.resultIsUntrusted(name),
    dispatch: async (input) => {
      if (
        input.modelToolCallId &&
        budgetCallIds.includes(input.modelToolCallId) &&
        !unblocked.has(input.modelToolCallId)
      ) {
        unblocked.add(input.modelToolCallId);
        return {
          kind: 'budget_blocked',
          reason: 'synthetic daily cap',
          resumeAt: new Date(Date.now() + 60_000),
        };
      }
      return base.dispatch(input);
    },
    executeApproved: (toolCallId, context) => base.executeApproved(toolCallId, context),
  };
}

async function recoverMatrixUntilDone(input: {
  taskId: string;
  router: ModelRouter;
  dispatcher: DispatcherPort;
  persistence?: ExecutionPersistence;
  calls: MatrixCall[];
  jobTokens: Map<string, string>;
  completedJobs?: Set<string>;
}): Promise<void> {
  const callbacks = new Set<string>();
  for (let recovery = 0; recovery < 12; recovery += 1) {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, input.taskId));
    if (!task) throw new Error('matrix task disappeared');
    const pendingJob = (task.state as { pendingJob?: { toolCallId?: string } } | null)?.pendingJob;
    const modelCallId = pendingJob?.toolCallId;
    if (modelCallId && !callbacks.has(modelCallId)) {
      const token = input.jobTokens.get(modelCallId);
      if (!token) throw new Error(`missing fake job token for ${modelCallId}`);
      const callback = await recordBrowserJobResult(db, {
        taskId: input.taskId,
        token,
        result: { ok: true, effectId: modelCallId },
      });
      if (!callback.ok) throw new Error(`fake job callback was rejected: ${callback.error}`);
      callbacks.add(modelCallId);
      input.completedJobs?.add(modelCallId);
    }
    const unresolved = await db.select().from(approvals).where(eq(approvals.taskId, input.taskId));
    for (const approval of unresolved.filter((row) => row.status === 'pending')) {
      const resolved = await resolveApproval(db, {
        approvalId: approval.id,
        decision: 'approved',
        via: 'web',
        deferNotification: true,
      });
      if (!resolved.ok) throw new Error(`approval ${approval.id} did not resolve`);
    }
    await setTaskDue(input.taskId);
    const result = await executeTask(
      {
        db,
        ...(input.persistence ? { persistence: input.persistence } : {}),
        router: input.router,
        dispatcher: input.dispatcher,
      },
      input.taskId,
    );
    if (result.outcome === 'done') return;
    if (!['parked', 'sleeping', 'failed'].includes(result.outcome))
      throw new Error(`unexpected matrix recovery result: ${result.outcome}`);
  }
  throw new Error('matrix did not reach a terminal result within the recovery bound');
}

async function setTaskDue(taskId: string) {
  await db
    .update(tasks)
    .set({ runAfter: new Date(Date.now() - 1000) })
    .where(eq(tasks.id, taskId));
}

function faultingPersistence(
  db: Db,
  fault:
    | 'batch-checkpoint'
    | 'effect-checkpoint'
    | 'approval-checkpoint'
    | 'budget-park'
    | 'job-stage',
) {
  const base = createPostgresExecutionPersistence(db);
  let injected = false;
  const tasksPort = base.tasks;
  const jobsPort = base.executionJobs;
  const persistence = {
    ...base,
    tasks: {
      ...tasksPort,
      checkpoint: async (
        task: Parameters<typeof tasksPort.checkpoint>[0],
        state: unknown,
        extra?: unknown,
      ) => {
        const batch = (
          state as { pendingToolBatch?: { calls?: Array<{ toolName: string; status: string }> } }
        ).pendingToolBatch;
        const calls = batch?.calls ?? [];
        const isQueuedBatch = calls.length === 3 && calls.every((call) => call.status === 'queued');
        const isEffectReceipt =
          (state as { completedToolCallIds?: string[] }).completedToolCallIds?.length === 1 &&
          calls.some((call) => call.toolName === 'r1.effect' && call.status === 'settled');
        const isApprovalReceipt = calls.some(
          (call) => call.toolName === 'r1.approval' && call.status === 'awaiting_approval',
        );
        if (!injected && fault === 'batch-checkpoint' && isQueuedBatch) {
          injected = true;
          const saved = await tasksPort.checkpoint(task, state, extra as never);
          if (saved) throw new Error('simulated process death after batch journal commit');
          return saved;
        }
        if (!injected && fault === 'effect-checkpoint' && isEffectReceipt) {
          injected = true;
          throw new Error('simulated process death after effect receipt before task checkpoint');
        }
        if (!injected && fault === 'approval-checkpoint' && isApprovalReceipt) {
          injected = true;
          throw new Error('simulated process death after approval row before task checkpoint');
        }
        return tasksPort.checkpoint(task, state, extra as never);
      },
      parkForBudget: async (...args: Parameters<typeof tasksPort.parkForBudget>) => {
        const saved = await tasksPort.parkForBudget(...args);
        if (saved && !injected && fault === 'budget-park') {
          injected = true;
          throw new Error('simulated process death after budget park commit');
        }
        return saved;
      },
    },
    executionJobs: {
      ...jobsPort,
      stage: async (...args: Parameters<typeof jobsPort.stage>) => {
        await jobsPort.stage(...args);
        if (!injected && fault === 'job-stage') {
          injected = true;
          throw new Error('simulated process death after durable job staging');
        }
      },
    },
  };
  return {
    persistence: persistence as unknown as ExecutionPersistence,
    wasInjected: () => injected,
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('executor-r1-matrix: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && taskIds.length > 0) {
    await db.update(toolCalls).set({ approvalId: null }).where(inArray(toolCalls.taskId, taskIds));
    await db.delete(approvals).where(inArray(approvals.taskId, taskIds));
    await db.delete(costEvents).where(inArray(costEvents.taskId, taskIds));
    await db.delete(costReservations).where(inArray(costReservations.taskId, taskIds));
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
    await db.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('R1 three-call mixed outcome recovery (PostgreSQL executor integration)', () => {
  const kinds: OutcomeKind[] = ['effect', 'approval', 'budget', 'job'];
  const permutations: OutcomeKind[][] = kinds.flatMap((first) =>
    kinds.flatMap((second) => kinds.map((third) => [first, second, third])),
  );

  it.each(permutations.map((order) => ({ order })))(
    'settles ordered batch $order exactly once',
    async ({ order }) => {
      if (!dbUp) throw new Error('isolated PostgreSQL test target is unavailable');
      const prefix = `r1-${order.join('-')}-${randomUUID().slice(0, 8)}`;
      const calls = matrixCalls(order, prefix);
      const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
      taskIds.push(task.id);
      const effects = new Map<string, number>();
      const jobTokens = new Map<string, string>();
      const completedJobs = new Set<string>();
      const base = makeMatrixTools(db, effects, jobTokens, completedJobs);
      const budgetCallIds = calls
        .filter((call) => call.toolName === 'r1.budget')
        .map((call) => call.toolCallId);
      const dispatcher = budgetOnce(base, budgetCallIds);
      const scripted = scriptedRouter(calls);

      const first = await executeTask({ db, router: scripted.router, dispatcher }, task.id);
      const jobIndex = order.indexOf('job');
      if (jobIndex >= 0 && jobIndex < calls.length - 1) {
        const [saved] = await db.select().from(tasks).where(eq(tasks.id, task.id));
        const state = saved?.state as { pendingJob?: unknown } | null;
        if (state?.pendingJob) expectQueuedJobTail(saved?.state, calls, jobIndex);
      }
      if (first.outcome !== 'done') {
        await recoverMatrixUntilDone({
          taskId: task.id,
          router: scripted.router,
          dispatcher,
          calls,
          jobTokens,
          completedJobs,
        });
      }

      const rows = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
      const byModelId = new Map(
        rows.map((row) => [
          (row.decision as { modelToolCallId?: string } | null)?.modelToolCallId ?? '',
          row,
        ]),
      );
      const dispatchedCalls = calls;
      expect([...byModelId.keys()].sort()).toEqual(
        dispatchedCalls.map((call) => call.toolCallId).sort(),
      );
      for (const call of dispatchedCalls)
        expect(byModelId.get(call.toolCallId)?.status).toBe('succeeded');
      const expectedEffects = dispatchedCalls
        .filter((call) => call.toolName !== 'r1.job')
        .map((call) => [call.toolCallId, 1])
        .sort();
      expect([...effects.entries()].sort()).toEqual(expectedEffects);
      expect(scripted.getStepCalls()).toBe(2);
      expect(scripted.terminalRequests).toHaveLength(1);
      expect(scripted.terminalRequests[0]?.sort()).toEqual(
        calls.map((call) => call.toolCallId).sort(),
      );
    },
  );

  it('keeps an undecided approval behind a later resolved approval across a budget reset', async () => {
    if (!dbUp) throw new Error('isolated PostgreSQL test target is unavailable');
    const prefix = `r1-unresolved-${randomUUID().slice(0, 8)}`;
    const calls: MatrixCall[] = [
      {
        toolCallId: `${prefix}-approval-a`,
        toolName: 'r1.approval',
        input: { effectId: `${prefix}-a` },
      },
      {
        toolCallId: `${prefix}-approval-b`,
        toolName: 'r1.approval',
        input: { effectId: `${prefix}-b` },
      },
      {
        toolCallId: `${prefix}-budget`,
        toolName: 'r1.budget',
        input: { effectId: `${prefix}-budget` },
      },
    ];
    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    taskIds.push(task.id);
    const effects = new Map<string, number>();
    const base = makeMatrixTools(db, effects);
    const scripted = scriptedRouter(calls);
    const budgetCallId = calls[2]?.toolCallId;
    if (!budgetCallId) throw new Error('missing budget call');
    const dispatcher = budgetOnce(base, [budgetCallId]);
    expect((await executeTask({ db, router: scripted.router, dispatcher }, task.id)).outcome).toBe(
      'parked',
    );
    const approvalsRows = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(approvalsRows).toHaveLength(2);
    const [first, second] = approvalsRows;
    if (!first || !second) throw new Error('expected both approval rows');

    await resolveApproval(db, {
      approvalId: second.id,
      decision: 'approved',
      via: 'web',
      deferNotification: true,
    });
    const taskBeforeBudgetReset = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(
      (taskBeforeBudgetReset[0]?.state as { pendingApprovals?: unknown[] })?.pendingApprovals,
    ).toHaveLength(2);

    await setTaskDue(task.id);
    expect((await executeTask({ db, router: scripted.router, dispatcher }, task.id)).outcome).toBe(
      'parked',
    );
    const stillPending = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(stillPending.find((row) => row.id === first.id)?.status).toBe('pending');
    expect(stillPending.find((row) => row.id === second.id)?.status).toBe('approved');
    const secondCallId = calls[1]?.toolCallId;
    if (!secondCallId) throw new Error('missing second approval call');
    expect(effects.has(secondCallId)).toBe(false);

    await resolveApproval(db, {
      approvalId: first.id,
      decision: 'approved',
      via: 'web',
      deferNotification: true,
    });
    await setTaskDue(task.id);
    expect((await executeTask({ db, router: scripted.router, dispatcher }, task.id)).outcome).toBe(
      'done',
    );
    expect([...effects.entries()].sort()).toEqual(calls.map((call) => [call.toolCallId, 1]).sort());
    expect(scripted.terminalRequests[0]?.sort()).toEqual(
      calls.map((call) => call.toolCallId).sort(),
    );
  });

  it.each([
    'batch-checkpoint',
    'effect-checkpoint',
    'approval-checkpoint',
    'budget-park',
    'job-stage',
  ] as const)('restarts the durable batch after the %s crash boundary', async (fault) => {
    if (!dbUp) throw new Error('isolated PostgreSQL test target is unavailable');
    const prefix = `r1-crash-${fault}-${randomUUID().slice(0, 8)}`;
    const order: OutcomeKind[] =
      fault === 'budget-park' ? ['effect', 'approval', 'budget'] : ['effect', 'approval', 'job'];
    const calls = matrixCalls(order, prefix);
    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    taskIds.push(task.id);
    const effects = new Map<string, number>();
    const jobTokens = new Map<string, string>();
    const completedJobs = new Set<string>();
    const base = makeMatrixTools(db, effects, jobTokens, completedJobs);
    const budgetCallIds = calls
      .filter((call) => call.toolName === 'r1.budget')
      .map((call) => call.toolCallId);
    const dispatcher = budgetOnce(base, budgetCallIds);
    const scripted = scriptedRouter(calls);
    const faulted = faultingPersistence(db, fault);

    const first = await executeTask(
      { db, persistence: faulted.persistence, router: scripted.router, dispatcher },
      task.id,
    );
    expect(faulted.wasInjected()).toBe(true);
    if (fault === 'job-stage') expect(first.outcome).toBe('parked');
    else if (fault !== 'budget-park') expect(first.outcome).toBe('failed');
    if (first.outcome !== 'done') {
      await recoverMatrixUntilDone({
        taskId: task.id,
        router: scripted.router,
        dispatcher,
        persistence: faulted.persistence,
        calls,
        jobTokens,
        completedJobs,
      });
    }
    const rows = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    const byModelId = new Map(
      rows.map((row) => [
        (row.decision as { modelToolCallId?: string } | null)?.modelToolCallId ?? '',
        row,
      ]),
    );
    const dispatchedCalls = calls;
    expect([...byModelId.keys()].sort()).toEqual(
      dispatchedCalls.map((call) => call.toolCallId).sort(),
    );
    expect([...effects.entries()].sort()).toEqual(
      dispatchedCalls
        .filter((call) => call.toolName !== 'r1.job')
        .map((call) => [call.toolCallId, 1])
        .sort(),
    );
    expect(scripted.getStepCalls()).toBe(2);
    expect(scripted.terminalRequests[0]?.sort()).toEqual(
      calls.map((call) => call.toolCallId).sort(),
    );
  });

  it('settles a job result and prior approval before requesting the model again', async () => {
    if (!dbUp) throw new Error('isolated PostgreSQL test target is unavailable');
    const prefix = `r1-job-${randomUUID().slice(0, 8)}`;
    const calls: MatrixCall[] = [
      {
        toolCallId: `${prefix}-effect`,
        toolName: 'r1.effect',
        input: { effectId: `${prefix}-effect` },
      },
      {
        toolCallId: `${prefix}-approval`,
        toolName: 'r1.approval',
        input: { effectId: `${prefix}-approval` },
      },
      {
        toolCallId: `${prefix}-job`,
        toolName: 'r1.job',
        input: { goal: 'read the public status page' },
      },
    ];
    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    taskIds.push(task.id);
    const effects = new Map<string, number>();
    const registry = new ToolRegistry();
    registry.register({
      name: 'r1.effect',
      description: 'A deterministic local effect receipt for the R1 job regression.',
      inputSchema: z.object({ effectId: z.string() }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (_args, context) => {
        const id = context.execution?.modelToolCallId ?? 'missing';
        effects.set(id, (effects.get(id) ?? 0) + 1);
        return { effectId: id, completed: true };
      },
    });
    registry.register(
      {
        name: 'r1.approval',
        description: 'An approval-gated local effect before the async job.',
        inputSchema: z.object({ effectId: z.string() }),
        risk: 'approval',
        acceptsUntrustedInput: true,
        approvalSummary: () => 'approve the local action',
        execute: async (_args, context) => {
          const id = context.execution?.modelToolCallId ?? 'missing';
          effects.set(id, (effects.get(id) ?? 0) + 1);
          return { effectId: id, completed: true };
        },
      },
      { outwardFacing: true },
    );
    let callbackToken = '';
    registry.register({
      name: 'r1.job',
      description: 'A fake staged async job used to exercise the durable executor path.',
      inputSchema: z.object({ goal: z.string() }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (_args, context) => {
        callbackToken = randomUUID();
        const pending = {
          pending: BROWSER_JOB_PENDING,
          callbackToken,
          timeoutAt: new Date(Date.now() + 60_000).toISOString(),
        };
        if (!context.execution || !context.stageBrowserJob)
          throw new Error('job tool lacks durable execution staging');
        await context.stageBrowserJob({ ...context.execution, pending });
        return pending;
      },
    });
    const dispatcher = new ToolDispatcher(db, registry);
    const scripted = scriptedRouter(calls);

    expect((await executeTask({ db, router: scripted.router, dispatcher }, task.id)).outcome).toBe(
      'parked',
    );
    const effectCallId = calls[0]?.toolCallId;
    if (!effectCallId) throw new Error('missing effect call');
    expect(effects.get(effectCallId)).toBe(1);
    const pendingApprovals = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(pendingApprovals).toHaveLength(1);
    expect(pendingApprovals[0]?.status).toBe('pending');
    expect(scripted.getStepCalls()).toBe(1);

    const callback = await recordBrowserJobResult(db, {
      taskId: task.id,
      token: callbackToken,
      result: { ok: true, goal: 'read the public status page', outputs: [], screenshots: [] },
    });
    expect(callback.ok).toBe(true);
    expect((await executeTask({ db, router: scripted.router, dispatcher }, task.id)).outcome).toBe(
      'parked',
    );
    const [approval] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    if (!approval) throw new Error('missing staged approval');
    await resolveApproval(db, {
      approvalId: approval.id,
      decision: 'approved',
      via: 'web',
      deferNotification: true,
    });
    expect((await executeTask({ db, router: scripted.router, dispatcher }, task.id)).outcome).toBe(
      'done',
    );

    const rows = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    const byModelId = new Map(
      rows.map((row) => [
        (row.decision as { modelToolCallId?: string } | null)?.modelToolCallId ?? '',
        row,
      ]),
    );
    expect([...byModelId.keys()].sort()).toEqual(calls.map((call) => call.toolCallId).sort());
    const jobCallId = calls[2]?.toolCallId;
    const approvalCallId = calls[1]?.toolCallId;
    if (!jobCallId || !approvalCallId) throw new Error('missing mixed job call');
    expect(byModelId.get(jobCallId)?.result).toMatchObject({ ok: true });
    expect(effects.get(effectCallId)).toBe(1);
    expect(effects.get(approvalCallId)).toBe(1);
    expect(scripted.getStepCalls()).toBe(2);
    expect(scripted.terminalRequests[0]?.sort()).toEqual(
      calls.map((call) => call.toolCallId).sort(),
    );
  });

  it('keeps later calls queued through an early wake, then resumes after job timeout', async () => {
    if (!dbUp) throw new Error('isolated PostgreSQL test target is unavailable');
    const prefix = `r1-timeout-${randomUUID().slice(0, 8)}`;
    const calls = matrixCalls(['effect', 'job', 'approval'], prefix);
    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    taskIds.push(task.id);
    const effects = new Map<string, number>();
    const jobTokens = new Map<string, string>();
    const completedJobs = new Set<string>();
    const dispatcher = makeMatrixTools(db, effects, jobTokens, completedJobs);
    const scripted = scriptedRouter(calls);

    expect((await executeTask({ db, router: scripted.router, dispatcher }, task.id)).outcome).toBe(
      'sleeping',
    );
    const [staged] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    const stagedState = staged?.state as {
      pendingJob?: { toolCallId: string; timeoutAt: string };
    };
    expect(stagedState.pendingJob).toBeDefined();
    if (!stagedState.pendingJob) throw new Error('job did not persist a pending marker');
    expectQueuedJobTail(staged?.state, calls, 1);

    await setTaskDue(task.id);
    expect((await executeTask({ db, router: scripted.router, dispatcher }, task.id)).outcome).toBe(
      'sleeping',
    );
    expect(scripted.getStepCalls()).toBe(1);
    const [earlyWake] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    if (!earlyWake) throw new Error('task disappeared after early job wake');
    expectQueuedJobTail(earlyWake?.state, calls, 1);

    const expired = structuredClone(earlyWake?.state) as typeof earlyWake.state & {
      pendingJob: { timeoutAt: string };
    };
    expired.pendingJob.timeoutAt = new Date(Date.now() - 1000).toISOString();
    await db.update(tasks).set({ state: expired }).where(eq(tasks.id, task.id));
    await setTaskDue(task.id);
    expect((await executeTask({ db, router: scripted.router, dispatcher }, task.id)).outcome).toBe(
      'parked',
    );
    const approvalRows = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(approvalRows).toHaveLength(1);
    expect(scripted.getStepCalls()).toBe(1);
    const approval = approvalRows[0];
    if (!approval) throw new Error('queued approval did not resume after job timeout');
    expect(
      await resolveApproval(db, {
        approvalId: approval.id,
        decision: 'approved',
        via: 'web',
        deferNotification: true,
      }),
    ).toMatchObject({ ok: true });
    await setTaskDue(task.id);
    expect((await executeTask({ db, router: scripted.router, dispatcher }, task.id)).outcome).toBe(
      'done',
    );
    expect(scripted.getStepCalls()).toBe(2);
    expect(scripted.terminalRequests[0]?.sort()).toEqual(
      calls.map((call) => call.toolCallId).sort(),
    );
    expect([...effects.values()].every((count) => count === 1)).toBe(true);
  });
});
