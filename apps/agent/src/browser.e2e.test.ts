import type { Config } from '@assistant/config';
import type { BrowserPlan, InboundEvent, ModelRouter, StepCallOutcome } from '@assistant/core';
import {
  completeTask,
  enqueueTask,
  executeTask,
  getAgent,
  hashCallbackToken,
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
  executionJobCallbackReceipts,
  files,
  tasks,
  toolCalls,
} from '@assistant/db';
import {
  browserModule,
  type ModulePlatformContext,
  type ModuleServices,
  noopOwnerNotifier,
} from '@assistant/modules';
import {
  AmbiguousBrowserJobLaunchError,
  type BrowserJobLaunchInput,
  registerBrowserTools,
  ToolDispatcher,
  ToolRegistry,
} from '@assistant/tools';
import type { ModelMessage } from 'ai';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];

const readOnlyPlan: BrowserPlan = {
  goal: 'read the HN front page',
  rung: 'headless',
  rationale: 'JS-rendered list',
  steps: [
    { action: 'goto', url: 'https://news.ycombinator.com' },
    { action: 'extract', what: 'top story titles' },
  ],
  // Anonymous read-only browsing is the autonomous tier. A signed-in profile
  // intentionally requires exact-plan approval, even when it only reads.
  useProfile: false,
  maxDurationSeconds: 120,
};

const interactivePlan: BrowserPlan = {
  ...readOnlyPlan,
  goal: 'search flights KEF-SFO',
  steps: [
    { action: 'goto', url: 'https://flights.test' },
    { action: 'type', selector: '#from', text: 'KEF' },
    { action: 'extract', what: 'results' },
  ],
};

/**
 * Scripted model, transcript-keyed like the main executor e2e: proposes
 * browser.execute once, then answers from its (settled) result.
 */
function makeFakeRouter(plan: BrowserPlan) {
  const fake = {
    async object() {
      return {
        ok: true,
        modelId: 'fake/model',
        degraded: false,
        object: { action: 'workflow', reasoning: '', steps: ['browse'], missingInfo: [] },
      };
    },
    async step(_role: string, callOpts: { messages?: ModelMessage[] }): Promise<StepCallOutcome> {
      const resultIds = (callOpts.messages ?? []).flatMap((message) =>
        message.role === 'tool' && Array.isArray(message.content)
          ? message.content
              .filter((part) => part.type === 'tool-result')
              .map((part) => part.toolCallId)
          : [],
      );
      expect(new Set(resultIds).size).toBe(resultIds.length);
      const transcript = JSON.stringify(callOpts.messages ?? []);
      const proposed = transcript.includes('"toolName":"browser.execute"');
      const settled =
        transcript.includes('"outputs"') || // real job result stitched in
        transcript.includes('timed out') ||
        transcript.includes('denied');
      if (!proposed) {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: '',
          toolCalls: [{ toolCallId: 'call_browse', toolName: 'browser.execute', input: { plan } }],
        };
      }
      if (!settled) {
        // The executor parks before asking the model to interpret an unfinished
        // approval or background job.
        return { ok: true, modelId: 'fake/model', degraded: false, text: '', toolCalls: [] };
      }
      return {
        ok: true,
        modelId: 'fake/model',
        degraded: false,
        text: 'Browse finished: here is what I found.',
        toolCalls: [],
      };
    },
  };
  return fake as unknown as ModelRouter;
}

function makeDispatcher(launches: BrowserJobLaunchInput[]) {
  const registry = registerBrowserTools(new ToolRegistry(), {
    plan: async () => readOnlyPlan,
    launcher: {
      launch: async (input) => {
        launches.push(input);
        return { executionName: 'exec-test' };
      },
    },
    callbackUrl: 'http://localhost:8787/webhooks/browser/callback',
  });
  return new ToolDispatcher(db, registry);
}

async function invokeBrowserModuleCallback(
  taskId: string,
  token: string,
  result: Record<string, unknown>,
) {
  const config = {
    BROWSER_DRIVER: 'local',
    PUBLIC_URL: 'http://localhost:8787',
    PROFILE_ENC_KEY: 'synthetic-only',
    GCP_PROJECT: 'synthetic-project',
    GCP_LOCATION: 'us-central1',
    BROWSER_JOB_NAME: 'synthetic-browser',
    WORKSPACE_BUCKET: 'synthetic-bucket',
    TRACES_BUCKET: '',
    ASSISTANT_WORKSPACE_ID: 'synthetic',
  } as unknown as Config;
  const registry = new ToolRegistry();
  const persistence = createPostgresExecutionPersistence(db);
  const runtime = browserModule.create({
    config,
    registry,
    router: {} as ModelRouter,
    repoRoot: process.cwd(),
    workspacePrefix: 'fs13-test',
    workspaceRoot: process.cwd(),
    persistence,
  } as unknown as ModulePlatformContext);
  const route = runtime.hooks?.webhooks?.find((hook) => hook.path === '/browser/callback');
  if (!route) throw new Error('module callback route is not installed');
  const services = {
    config,
    db,
    router: {} as ModelRouter,
    registry,
    dispatcher: {} as never,
    workspace: {} as never,
    ownerNotifier: noopOwnerNotifier,
    emailObservers: [],
    persistence,
  } as unknown as ModuleServices;
  return route.handler(services, {
    json: async <T>() => ({ taskId, token, result }) as T,
    form: async () => ({}),
    header: () => undefined,
  });
}

function event(): InboundEvent {
  return { source: 'internal', agentId, trust: 'owner', payload: {} };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('browser.e2e: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdTaskIds.length) {
    await db
      .update(toolCalls)
      .set({ approvalId: null })
      .where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(approvals).where(inArray(approvals.taskId, createdTaskIds));
    // Phase 27 ledger rows reference tool_calls/tasks — clean them first
    await db.delete(costEvents).where(inArray(costEvents.taskId, createdTaskIds));
    await db.delete(costReservations).where(inArray(costReservations.taskId, createdTaskIds));
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(files).where(inArray(files.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('browser job end-to-end (integration, scripted model)', () => {
  it('read-only plan: launches, sleeps, wakes on callback, answers from the result', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const launches: BrowserJobLaunchInput[] = [];
    const dispatcher = makeDispatcher(launches);
    const router = makeFakeRouter(readOnlyPlan);

    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    // Run 1: autonomous launch → task sleeps awaiting the callback
    const run1 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run1.outcome).toBe('sleeping');
    expect(launches).toHaveLength(1);

    let [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('sleeping');
    const pendingJob = (row?.state as { pendingJob?: { callbackTokenHash: string } } | undefined)
      ?.pendingJob;
    expect(pendingJob?.callbackTokenHash).toBe(hashCallbackToken(launches[0]?.callbackToken ?? ''));

    // Wrong token → 403, task untouched
    const bad = await recordBrowserJobResult(db, {
      taskId: task.id,
      token: 'wrong-token',
      result: { ok: true },
    });
    expect(bad).toMatchObject({ ok: false, status: 403 });

    // Job calls back with the launch token → task wakes
    const jobResult = {
      ok: true,
      goal: readOnlyPlan.goal,
      outputs: [{ index: 1, action: 'extract', ok: true, text: 'Top story: pgvector 1.0' }],
      screenshots: [],
      tracePath: 'traces/test.zip',
    };
    const token = launches[0]?.callbackToken ?? '';
    const [cb, concurrentRetry] = await Promise.all([
      invokeBrowserModuleCallback(task.id, token, jobResult),
      invokeBrowserModuleCallback(task.id, token, jobResult),
    ]);
    expect(cb).toEqual({ status: 200, json: { ok: true } });
    expect(concurrentRetry).toEqual(cb);
    const [acceptedTask] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(acceptedTask?.queueGeneration).toBe((row?.queueGeneration ?? 0) + 1);
    const receipts = await db
      .select()
      .from(executionJobCallbackReceipts)
      .where(eq(executionJobCallbackReceipts.taskId, task.id));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.tokenHash).toBe(hashCallbackToken(token));
    expect(receipts[0]?.idempotencyKey).not.toContain(token);
    const acceptedFiles = await db.select().from(files).where(eq(files.taskId, task.id));
    const duplicate = await invokeBrowserModuleCallback(task.id, token, jobResult);
    expect(duplicate).toEqual(cb);
    const [afterDuplicate] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(afterDuplicate?.queueGeneration).toBe(acceptedTask?.queueGeneration);
    expect(await db.select().from(files).where(eq(files.taskId, task.id))).toHaveLength(
      acceptedFiles.length,
    );

    [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('pending');

    // The trace artifact was inventoried in files
    const inventoried = await db.select().from(files).where(eq(files.taskId, task.id));
    expect(inventoried.map((f) => f.workspacePath)).toContain('traces/test.zip');

    // A second callback with the same token must not overwrite the accepted result
    const replay = await invokeBrowserModuleCallback(task.id, token, {
      ok: false,
      error: 'changed payload',
    });
    expect(replay).toMatchObject({ status: 409 });
    expect(
      await db
        .select()
        .from(executionJobCallbackReceipts)
        .where(eq(executionJobCallbackReceipts.taskId, task.id)),
    ).toHaveLength(1);

    // Run 2: settles the job result from tool_calls and finishes
    const run2 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run2.outcome).toBe('done');
    expect(launches).toHaveLength(1); // no relaunch

    const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    const browse = calls.find((c) => c.toolName === 'browser.execute');
    expect(browse?.status).toBe('succeeded');
    expect(browse?.result).toMatchObject(jobResult);

    // An identical delivery can recover the original HTTP outcome even after
    // executor settlement; different content remains rejected by the receipt.
    expect(await invokeBrowserModuleCallback(task.id, token, jobResult)).toEqual(cb);
    expect(
      await invokeBrowserModuleCallback(task.id, token, { ok: true, outputs: [] }),
    ).toMatchObject({ status: 409 });
  });

  it('rejects a browser callback after terminal cancellation', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const launches: BrowserJobLaunchInput[] = [];
    const dispatcher = makeDispatcher(launches);
    const router = makeFakeRouter(readOnlyPlan);

    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);
    await executeTask({ db, router, dispatcher }, task.id);
    await completeTask(db, task.id, { status: 'cancelled' });

    const callback = await recordBrowserJobResult(db, {
      taskId: task.id,
      token: launches[0]?.callbackToken ?? '',
      result: { ok: true, outputs: [] },
    });
    expect(callback).toMatchObject({ ok: false, status: 409 });
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after?.status).toBe('cancelled');
  });

  it('interactive plan: parks for approval of the exact plan before any launch', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const launches: BrowserJobLaunchInput[] = [];
    const dispatcher = makeDispatcher(launches);
    const router = makeFakeRouter(interactivePlan);

    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    // Run 1: parks — nothing launched
    const run1 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run1.outcome).toBe('parked');
    expect(launches).toHaveLength(0);

    const [approval] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(approval?.status).toBe('pending');
    expect(approval?.summary).toContain('search flights KEF-SFO');
    expect((approval?.payload as { plan?: BrowserPlan } | undefined)?.plan?.steps).toHaveLength(3);

    // Approve → run 2 launches the job and sleeps for the callback
    await resolveApproval(db, { approvalId: approval?.id, decision: 'approved', via: 'web' });
    const run2 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run2.outcome).toBe('sleeping');
    expect(launches).toHaveLength(1);
    // What executes is exactly what was approved
    expect(launches[0]?.plan).toEqual(interactivePlan);

    // Callback → run 3 completes
    await recordBrowserJobResult(db, {
      taskId: task.id,
      token: launches[0]?.callbackToken ?? '',
      result: { ok: true, outputs: [{ action: 'extract', ok: true, text: 'fares' }] },
    });
    const run3 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run3.outcome).toBe('done');
  });

  it('approves a queued read-only browser job after taint and returns both results before the next model request', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const launches: BrowserJobLaunchInput[] = [];
    const dispatcher = makeDispatcher(launches);
    // A model that spams two browser.execute calls in a single step
    const modelResultIds: string[][] = [];
    const router = {
      async object() {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          object: { action: 'workflow', reasoning: '', steps: ['browse'], missingInfo: [] },
        };
      },
      async step(_role: string, callOpts: { messages?: ModelMessage[] }) {
        modelResultIds.push(
          (callOpts.messages ?? []).flatMap((message) =>
            message.role === 'tool' && Array.isArray(message.content)
              ? message.content.flatMap((part) =>
                  part.type === 'tool-result' && typeof part.toolCallId === 'string'
                    ? [part.toolCallId]
                    : [],
                )
              : [],
          ),
        );
        const transcript = JSON.stringify(callOpts.messages ?? []);
        if (!transcript.includes('"toolName":"browser.execute"')) {
          return {
            ok: true,
            modelId: 'fake/model',
            degraded: false,
            text: '',
            toolCalls: [
              { toolCallId: 'call_a', toolName: 'browser.execute', input: { plan: readOnlyPlan } },
              { toolCallId: 'call_b', toolName: 'browser.execute', input: { plan: readOnlyPlan } },
            ],
          };
        }
        return { ok: true, modelId: 'fake/model', degraded: false, text: 'done', toolCalls: [] };
      },
      async embed(texts: string[]) {
        return texts.map(() => new Array(1536).fill(0.01));
      },
    } as unknown as ModelRouter;

    const { task } = await enqueueTask(db, {
      event: { ...event(), payload: { text: 'Please browse the HN front page twice.' } },
      type: 'adhoc',
    });
    createdTaskIds.push(task.id);

    const run1 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run1.outcome).toBe('sleeping');
    expect(launches).toHaveLength(1); // the second call stays queued until the first callback

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    const state = row?.state as {
      pendingJob?: { callbackTokenHash: string; toolCallId: string };
      contextWindow: unknown[];
      pendingToolBatch?: { calls: Array<{ toolCallId: string; status: string }> };
    };
    expect(state.pendingJob?.callbackTokenHash).toBe(
      hashCallbackToken(launches[0]?.callbackToken ?? ''),
    );
    expect(state.pendingJob?.toolCallId).toBe('call_a');
    expect(state.pendingToolBatch?.calls).toMatchObject([
      { toolCallId: 'call_a', status: 'job' },
      { toolCallId: 'call_b', status: 'queued' },
    ]);
    expect(JSON.stringify(state.contextWindow)).not.toContain('already running');

    const firstToken = launches[0]?.callbackToken ?? '';
    const firstResult = { ok: true, outputs: [{ action: 'extract', text: 'first result' }] };
    const firstCallback = await invokeBrowserModuleCallback(task.id, firstToken, firstResult);
    expect(firstCallback).toEqual({ status: 200, json: { ok: true } });
    const run2 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run2.outcome).toBe('parked');
    expect(launches).toHaveLength(1);
    const [approval] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(approval?.status).toBe('pending');
    expect(approval?.summary).toContain('read the HN front page');
    expect((approval?.payload as { plan?: BrowserPlan } | undefined)?.plan).toEqual(readOnlyPlan);

    await resolveApproval(db, {
      approvalId: approval?.id,
      decision: 'approved',
      via: 'web',
    });
    const run3 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run3.outcome).toBe('sleeping');
    expect(launches).toHaveLength(2);
    expect(launches[1]?.plan).toEqual(readOnlyPlan);

    const secondToken = launches[1]?.callbackToken ?? '';
    const secondResult = { ok: true, outputs: [{ action: 'extract', text: 'second result' }] };
    const secondCallback = await invokeBrowserModuleCallback(task.id, secondToken, secondResult);
    expect(secondCallback).toEqual({ status: 200, json: { ok: true } });
    expect(secondToken).not.toBe(firstToken);
    const launchReceipts = await db
      .select()
      .from(executionJobCallbackReceipts)
      .where(eq(executionJobCallbackReceipts.taskId, task.id));
    expect(launchReceipts).toHaveLength(2);
    expect(new Set(launchReceipts.map((receipt) => receipt.idempotencyKey)).size).toBe(2);
    expect(new Set(launchReceipts.map((receipt) => receipt.tokenHash))).toEqual(
      new Set([hashCallbackToken(firstToken), hashCallbackToken(secondToken)]),
    );
    const run4 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run4.outcome).toBe('done');
    const [serialStateRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    const serialState = serialStateRow?.state as {
      pendingJob?: { toolCallId: string } | null;
      pendingToolBatch?: { calls: Array<{ toolCallId: string; status: string }> } | null;
      contextWindow: unknown[];
    };
    const serializedCalls = await db
      .select({
        status: toolCalls.status,
        toolName: toolCalls.toolName,
        decision: toolCalls.decision,
      })
      .from(toolCalls)
      .where(eq(toolCalls.taskId, task.id));
    expect(launches).toHaveLength(2);
    expect(serialState.pendingJob ?? null).toBeNull();
    expect(serialState.pendingToolBatch ?? null).toBeNull();
    expect(serializedCalls).toHaveLength(2);
    expect(serializedCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'succeeded',
          toolName: 'browser.execute',
          decision: expect.objectContaining({ modelToolCallId: 'call_a' }),
        }),
        expect.objectContaining({
          status: 'succeeded',
          toolName: 'browser.execute',
          decision: expect.objectContaining({ modelToolCallId: 'call_b' }),
        }),
      ]),
    );
    const transcript = JSON.stringify(serialState.contextWindow);
    expect(transcript).toContain('call_a');
    expect(transcript).toContain('call_b');
    expect(transcript).toContain('first result');
    expect(transcript).toContain('second result');
    expect(modelResultIds).toHaveLength(2);
    expect(modelResultIds[1]?.sort()).toEqual(['call_a', 'call_b']);
  });

  it('accepts a fast callback while launch still owns the task lease', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const launches: BrowserJobLaunchInput[] = [];
    let callbackAccepted = false;
    const registry = registerBrowserTools(new ToolRegistry(), {
      plan: async () => readOnlyPlan,
      launcher: {
        launch: async (input) => {
          launches.push(input);
          const callback = await recordBrowserJobResult(db, {
            taskId: input.taskId,
            token: input.callbackToken,
            result: { ok: true, outputs: [{ action: 'extract', text: 'fast result' }] },
          });
          callbackAccepted = callback.ok;
          return { executionName: 'exec-fast' };
        },
      },
      callbackUrl: 'http://localhost:8787/webhooks/browser/callback',
    });
    const dispatcher = new ToolDispatcher(db, registry);
    const router = makeFakeRouter(readOnlyPlan);
    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    const launchingRun = await executeTask({ db, router, dispatcher }, task.id);
    expect(callbackAccepted).toBe(true);
    expect(launches).toHaveLength(1);
    // The callback atomically moved running → pending, fencing the launcher.
    expect(launchingRun.outcome).toBe('not_claimable');

    const settledRun = await executeTask({ db, router, dispatcher }, task.id);
    expect(settledRun.outcome).toBe('done');
    expect(launches).toHaveLength(1);
  });

  it('never relaunches after an ambiguous Cloud Run launch response', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const launches: BrowserJobLaunchInput[] = [];
    const registry = registerBrowserTools(new ToolRegistry(), {
      plan: async () => readOnlyPlan,
      launcher: {
        launch: async (input) => {
          launches.push(input);
          throw new AmbiguousBrowserJobLaunchError('connection closed after request upload');
        },
      },
      callbackUrl: 'http://localhost:8787/webhooks/browser/callback',
    });
    const dispatcher = new ToolDispatcher(db, registry);
    const router = makeFakeRouter(readOnlyPlan);
    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    const first = await executeTask({ db, router, dispatcher }, task.id);
    expect(first.outcome).toBe('sleeping');
    expect(launches).toHaveLength(1);

    const [sleeping] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    const pending = (sleeping?.state as { pendingJob?: { callbackTokenHash?: string } } | undefined)
      ?.pendingJob;
    const expectedHash = hashCallbackToken(launches[0]?.callbackToken ?? '');
    expect(pending?.callbackTokenHash).toBe(expectedHash);
    const [call] = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    // The stored sentinel carries only the hashed token, never the raw one.
    expect(call?.result).toMatchObject({
      pending: 'browser_job_pending',
      callbackToken: expectedHash,
    });

    // Simulate an early retry poke. The durable pending state is re-slept; the
    // launcher is never invoked a second time even though launch is uncertain.
    await db
      .update(tasks)
      .set({ runAfter: sql`now() - interval '1 second'` })
      .where(eq(tasks.id, task.id));
    const retry = await executeTask({ db, router, dispatcher }, task.id);
    expect(retry.outcome).toBe('sleeping');
    expect(launches).toHaveLength(1);
  });

  it('a job that never calls back settles as failed after the timeout', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const launches: BrowserJobLaunchInput[] = [];
    const dispatcher = makeDispatcher(launches);
    const router = makeFakeRouter(readOnlyPlan);

    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    await executeTask({ db, router, dispatcher }, task.id);

    // Force the timeout into the past (as the sweeper would find it)
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    const state = row?.state as { pendingJob?: { timeoutAt: string } };
    expect(state.pendingJob).toBeTruthy();
    if (state.pendingJob) state.pendingJob.timeoutAt = new Date(Date.now() - 1000).toISOString();
    await db
      .update(tasks)
      .set({ state, runAfter: sql`now() - interval '1 second'` })
      .where(eq(tasks.id, task.id));

    const run2 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run2.outcome).toBe('done');

    const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    const browse = calls.find((c) => c.toolName === 'browser.execute');
    expect(browse?.result).toMatchObject({ ok: false });
    expect(JSON.stringify(browse?.result)).toContain('timed out');
  });
});
