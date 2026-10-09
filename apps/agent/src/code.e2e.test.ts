import type { Config } from '@assistant/config';
import type { CodeSpec, InboundEvent, ModelRouter, StepCallOutcome } from '@assistant/core';
import {
  enqueueTask,
  executeTask,
  getAgent,
  hashCallbackToken,
  recordCodeJobResult,
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
  codeModule,
  type ModulePlatformContext,
  type ModuleServices,
  noopOwnerNotifier,
} from '@assistant/modules';
import {
  type CodeJobLaunchInput,
  registerCodeTools,
  ToolDispatcher,
  ToolRegistry,
} from '@assistant/tools';
import type { ModelMessage } from 'ai';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];

const computeSpec: CodeSpec = {
  goal: 'add two numbers',
  language: 'javascript',
  source: 'console.log(2 + 2)',
  allowNetwork: false,
  timeoutSeconds: 30,
};
const networkSpec: CodeSpec = {
  ...computeSpec,
  goal: 'fetch a page',
  source: "const r = await fetch('https://example.com'); console.log(await r.text());",
  allowNetwork: true,
};

/** Scripted model: proposes code.execute once, then answers from the settled result. */
function makeFakeRouter(spec: CodeSpec) {
  const fake = {
    async object() {
      return {
        ok: true,
        modelId: 'fake/model',
        degraded: false,
        object: { action: 'workflow', reasoning: '', steps: ['run'], missingInfo: [] },
      };
    },
    async step(_role: string, callOpts: { messages?: ModelMessage[] }): Promise<StepCallOutcome> {
      const transcript = JSON.stringify(callOpts.messages ?? []);
      const proposed = transcript.includes('"toolName":"code.execute"');
      const settled =
        transcript.includes('"exitCode"') ||
        transcript.includes('timed out') ||
        transcript.includes('denied');
      if (!proposed) {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: '',
          toolCalls: [{ toolCallId: 'call_code', toolName: 'code.execute', input: { spec } }],
        };
      }
      if (!settled)
        return { ok: true, modelId: 'fake/model', degraded: false, text: '', toolCalls: [] };
      return {
        ok: true,
        modelId: 'fake/model',
        degraded: false,
        text: 'The script produced 4.',
        toolCalls: [],
      };
    },
  };
  return fake as unknown as ModelRouter;
}

function makeDispatcher(launches: CodeJobLaunchInput[]) {
  const registry = registerCodeTools(new ToolRegistry(), {
    isolated: true,
    launcher: {
      launch: async (input) => {
        launches.push(input);
        return { executionName: 'exec-test' };
      },
    },
    callbackUrl: 'http://localhost:8787/webhooks/code/callback',
  });
  return new ToolDispatcher(db, registry);
}

async function invokeCodeModuleCallback(
  taskId: string,
  token: string,
  result: Record<string, unknown>,
) {
  const config = {
    CODE_DRIVER: 'local',
    PUBLIC_URL: 'http://localhost:8787',
    PROFILE_ENC_KEY: 'synthetic-only',
    GCP_PROJECT: 'synthetic-project',
    GCP_LOCATION: 'us-central1',
    CODE_JOB_NAME: 'synthetic-code',
    WORKSPACE_BUCKET: 'synthetic-bucket',
    TRACES_BUCKET: '',
    ASSISTANT_WORKSPACE_ID: 'synthetic',
  } as unknown as Config;
  const registry = new ToolRegistry();
  const persistence = createPostgresExecutionPersistence(db);
  const runtime = codeModule.create({
    config,
    registry,
    router: {} as ModelRouter,
    repoRoot: process.cwd(),
    workspacePrefix: 'fs13-test',
    workspaceRoot: process.cwd(),
    persistence,
  } as unknown as ModulePlatformContext);
  const route = runtime.hooks?.webhooks?.find((hook) => hook.path === '/code/callback');
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
    console.warn('code.e2e: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdTaskIds.length) {
    await db
      .update(toolCalls)
      .set({ approvalId: null })
      .where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(approvals).where(inArray(approvals.taskId, createdTaskIds));
    await db.delete(costEvents).where(inArray(costEvents.taskId, createdTaskIds));
    await db.delete(costReservations).where(inArray(costReservations.taskId, createdTaskIds));
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(files).where(inArray(files.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('code job end-to-end (integration, scripted model)', () => {
  it('no-network spec: launches autonomously, sleeps, wakes on callback, inventories outputs', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const launches: CodeJobLaunchInput[] = [];
    const dispatcher = makeDispatcher(launches);
    const router = makeFakeRouter(computeSpec);

    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    const run1 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run1.outcome).toBe('sleeping');
    expect(launches).toHaveLength(1);
    expect(launches[0]?.spec).toEqual(computeSpec);

    let [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('sleeping');
    const pendingJob = (row?.state as { pendingJob?: { callbackTokenHash: string } } | undefined)
      ?.pendingJob;
    const expectedHash = hashCallbackToken(launches[0]?.callbackToken ?? '');
    expect(pendingJob?.callbackTokenHash).toBe(expectedHash);
    const [call] = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    expect(call?.status).toBe('succeeded');
    expect(call?.result).toMatchObject({
      pending: 'code_job_pending',
      callbackToken: expectedHash,
    });

    // Wrong token → 403, task untouched
    const bad = await recordCodeJobResult(db, {
      taskId: task.id,
      token: 'wrong-token',
      result: { ok: true },
    });
    expect(bad).toMatchObject({ ok: false, status: 403 });

    const outputPath = `code/${task.id}/answer.txt`;
    const token = launches[0]?.callbackToken ?? '';
    const result = {
      ok: true,
      goal: computeSpec.goal,
      language: 'javascript',
      exitCode: 0,
      stdout: '4\n',
      stderr: '',
      outputs: [outputPath],
    };
    const [cb, concurrentRetry] = await Promise.all([
      invokeCodeModuleCallback(task.id, token, result),
      invokeCodeModuleCallback(task.id, token, result),
    ]);
    expect(cb).toEqual({ status: 200, json: { ok: true } });
    expect(concurrentRetry).toEqual(cb);
    const [acceptedTask] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    const receipts = await db
      .select()
      .from(executionJobCallbackReceipts)
      .where(eq(executionJobCallbackReceipts.taskId, task.id));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.tokenHash).toBe(expectedHash);
    expect(receipts[0]?.idempotencyKey).not.toContain(token);
    expect(await invokeCodeModuleCallback(task.id, token, result)).toEqual(cb);
    expect(await db.select().from(files).where(eq(files.taskId, task.id))).toHaveLength(1);
    const [afterDuplicate] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(afterDuplicate?.queueGeneration).toBe(acceptedTask?.queueGeneration);
    expect(
      await db
        .select()
        .from(executionJobCallbackReceipts)
        .where(eq(executionJobCallbackReceipts.taskId, task.id)),
    ).toHaveLength(1);
    expect(
      await invokeCodeModuleCallback(task.id, token, { ok: false, error: 'changed payload' }),
    ).toMatchObject({ status: 409 });

    [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('pending');

    const inventoried = await db.select().from(files).where(eq(files.taskId, task.id));
    expect(inventoried.map((f) => f.workspacePath)).toContain(outputPath);

    const run2 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run2.outcome).toBe('done');
    expect(await invokeCodeModuleCallback(task.id, token, result)).toEqual(cb);
    expect(
      await invokeCodeModuleCallback(task.id, token, { ...result, stdout: 'different result' }),
    ).toMatchObject({ status: 409 });
    expect(await db.select().from(files).where(eq(files.taskId, task.id))).toHaveLength(1);
    expect(
      await db
        .select()
        .from(executionJobCallbackReceipts)
        .where(eq(executionJobCallbackReceipts.taskId, task.id)),
    ).toHaveLength(1);
  });

  it('network spec: parks for approval of the exact script before any launch', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const launches: CodeJobLaunchInput[] = [];
    const dispatcher = makeDispatcher(launches);
    const router = makeFakeRouter(networkSpec);

    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    const run1 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run1.outcome).toBe('parked');
    expect(launches).toHaveLength(0);

    const [approval] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(approval?.status).toBe('pending');
    expect(approval?.summary).toContain('fetch a page');

    await resolveApproval(db, { approvalId: approval?.id, decision: 'approved', via: 'web' });
    const run2 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run2.outcome).toBe('sleeping');
    expect(launches).toHaveLength(1);
    // What launches is exactly the approved spec.
    expect(launches[0]?.spec).toEqual(networkSpec);
    const expectedHash = hashCallbackToken(launches[0]?.callbackToken ?? '');
    const [call] = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    expect(call?.status).toBe('succeeded');
    expect(call?.result).toMatchObject({
      pending: 'code_job_pending',
      callbackToken: expectedHash,
    });
  });
});
