import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import {
  type CodeSpec,
  type ExecutorDeps,
  executeTask,
  hashCallbackToken,
  type ModelRouter,
  type StepCallOutcome,
} from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import { browserModule, codeModule, installModules, type ModuleServices } from '@assistant/modules';
import { finalChannelDelivery } from '@assistant/persistence';
import {
  type CodeJobLaunchInput,
  registerCodeTools,
  ToolDispatcher,
  ToolRegistry,
} from '@assistant/tools';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeRecord,
  encodeRecord,
  type InstallationStore,
} from '../../../packages/firestore/src/store.js';
import {
  disposeStore,
  emulatorStore,
  seedBudget,
} from '../../../packages/firestore/src/test-store.js';

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
function scriptedRouter(spec: CodeSpec): ModelRouter {
  return {
    async object(role: string) {
      const object =
        role === 'classify'
          ? { trivial: false }
          : role === 'plan'
            ? { action: 'workflow', reasoning: '', steps: ['run'], missingInfo: [] }
            : { decision: 'publish', reasons: [] };
      return { ok: true, modelId: 'synthetic/model', degraded: false, object };
    },
    async embed(texts: string[]) {
      return texts.map(() => Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)));
    },
    async step(_role: string, input: { messages?: ModelMessage[] }): Promise<StepCallOutcome> {
      const transcript = JSON.stringify(input.messages ?? []);
      const proposed = transcript.includes('"toolName":"code.execute"');
      const settled =
        transcript.includes('"exitCode"') ||
        transcript.includes('timed out') ||
        transcript.includes('denied');
      if (!proposed)
        return {
          ok: true,
          modelId: 'synthetic/model',
          degraded: false,
          text: '',
          toolCalls: [{ toolCallId: 'call_code', toolName: 'code.execute', input: { spec } }],
        } as StepCallOutcome;
      return {
        ok: true,
        modelId: 'synthetic/model',
        degraded: false,
        text: settled ? 'The script produced 4.' : '',
        toolCalls: [],
      } as StepCallOutcome;
    },
  } as unknown as ModelRouter;
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore browser and code job callbacks',
  () => {
    const agentId = randomUUID();
    const conversationId = randomUUID();
    let offsetMs: number;
    let store: InstallationStore;
    let sqlAccesses: string[];
    let launches: CodeJobLaunchInput[];
    let persistence: ReturnType<typeof createFirestoreExecutionPersistence>;
    let services: ModuleServices;
    let callback: (path: string, body: unknown) => Promise<{ status: number; json?: unknown }>;
    let delivered: string[];

    function deps(spec: CodeSpec): ExecutorDeps {
      const db = services.db;
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
      return {
        db,
        router: scriptedRouter(spec),
        persistence,
        dispatcher: new ToolDispatcher(
          db,
          registry,
          persistence.toolExecution,
          persistence.costs,
          persistence.approvals,
          persistence.approvalPolicies,
        ),
        deliverFinal: async (_task, text, attemptId) => {
          delivered.push(text);
          return finalChannelDelivery('dashboard', 'accepted', attemptId);
        },
      };
    }

    beforeEach(async () => {
      vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
      offsetMs = 0;
      store = emulatorStore(() => new Date(Date.now() + offsetMs));
      sqlAccesses = [];
      launches = [];
      delivered = [];
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
      persistence = createFirestoreExecutionPersistence(store, agentId, {
        provider: 'synthetic',
        model: 'callback-fixture',
        dimensions: 1536,
        revision: '1',
      });
      const config = {
        ...loadConfig({}),
        PERSISTENCE_DRIVER: 'firestore' as const,
        FIRESTORE_AGENT_ID: agentId,
        ASSISTANT_MODULES: ['browser' as const, 'code' as const],
      };
      const modules = installModules([browserModule, codeModule], {
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
      services = {
        config,
        db,
        router: unavailable('router') as never,
        registry: new ToolRegistry(),
        dispatcher: unavailable('dispatcher') as never,
        workspace: unavailable('workspace') as never,
        ownerNotifier: unavailable('notifier') as never,
        emailObservers: [],
        durableEmailObservers: [],
        persistence,
      };
      callback = async (path, body) => {
        const handler = modules.webhookHandler(path);
        if (!handler) throw new Error(`missing webhook ${path}`);
        const response = await handler(services, {
          json: async <T>() => body as T,
          form: async () => ({}),
          header: () => undefined,
        });
        return 'json' in response
          ? { status: response.status, json: response.json }
          : { status: response.status };
      };
      const now = new Date();
      await store.doc('agents', agentId).set({
        id: agentId,
        name: 'Synthetic assistant',
        email: 'assistant@example.invalid',
        signature: '',
        timezone: 'UTC',
        locale: 'en',
        workspacePrefix: 'synthetic',
        credentialRefs: {},
        createdAt: now,
        updatedAt: now,
      });
      await store.doc('conversations', conversationId).set({
        id: conversationId,
        agentId,
        channel: 'chat',
        trust: 'owner',
        createdAt: now,
        updatedAt: now,
      });
      await seedBudget(store);
      await store
        .doc('rateTable', 'cloud_run_job_sec')
        .set({ key: 'cloud_run_job_sec', unit: 'second', unitPriceUsd: '0.0001', updatedAt: now });
    });

    afterEach(async () => {
      await disposeStore(store);
      vi.unstubAllEnvs();
    });

    async function createTask() {
      const { task } = await persistence.tasks.createTask({
        agentId,
        conversationId,
        type: 'adhoc',
        trust: 'owner',
        trigger: { source: 'internal', payload: {} },
      });
      return task.id;
    }
    const readDoc = async (collection: string, id: string) =>
      decodeRecord<Record<string, unknown>>((await store.doc(collection, id).get()).data());
    const toolCallsOf = async (taskId: string) =>
      (await store.collection('toolCalls').where('taskId', '==', taskId).get()).docs.map((doc) =>
        decodeRecord<Record<string, unknown>>(doc.data()),
      );

    it('settles an approved launch through its callback, reservation included', async () => {
      const executor = deps(networkSpec);
      const taskId = await createTask();
      expect((await executeTask(executor, taskId)).outcome).toBe('parked');
      const approval = (await store.collection('approvals').get()).docs[0]?.get('id');
      await persistence.approvals.resolve({
        approvalId: approval,
        decision: 'approved',
        via: 'web',
      });

      expect((await executeTask(executor, taskId)).outcome).toBe('sleeping');
      expect(launches.map((launch) => launch.spec)).toEqual([networkSpec]);
      const token = launches[0]?.callbackToken ?? '';
      const [staged] = await toolCallsOf(taskId);
      // Only the hash is stored; the pending reservation stays held until settlement.
      expect(staged?.result).toMatchObject({
        pending: 'code_job_pending',
        callbackToken: hashCallbackToken(token),
      });
      const reservationId = (staged?.decision as { reservationId?: string } | undefined)
        ?.reservationId;
      expect(typeof reservationId).toBe('string');
      expect((await readDoc('costReservations', reservationId as string)).status).toBe('held');

      const outputPath = `code/${taskId}/answer.txt`;
      const result = { ok: true, exitCode: 0, stdout: '4\n', stderr: '', outputs: [outputPath] };
      const beforeCallback = await store.collection('outbox').where('taskId', '==', taskId).get();
      const concurrentCallbacks = await Promise.all([
        callback('/code/callback', { taskId, token, result }),
        callback('/code/callback', { taskId, token, result }),
      ]);
      expect(concurrentCallbacks).toEqual([
        { status: 200, json: { ok: true } },
        { status: 200, json: { ok: true } },
      ]);
      expect(concurrentCallbacks[0]).toEqual({
        status: 200,
        json: { ok: true },
      });
      const woken = await readDoc('tasks', taskId);
      expect(woken).toMatchObject({ status: 'pending', leaseToken: null });
      const outbox = await store.collection('outbox').where('taskId', '==', taskId).get();
      expect(outbox.size).toBe(beforeCallback.size + 1);
      expect(
        outbox.docs.filter((doc) => doc.get('generation') === woken.queueGeneration),
      ).toHaveLength(1);
      const receipts = await store
        .collection('executionJobCallbackReceipts')
        .where('taskId', '==', taskId)
        .get();
      expect(receipts.size).toBe(1);
      expect(receipts.docs[0]?.get('tokenHash')).toBe(hashCallbackToken(token));
      expect(receipts.docs[0]?.id).not.toContain(token);
      const files = await store.collection('files').where('taskId', '==', taskId).get();
      expect(files.docs.map((doc) => [doc.get('workspacePath'), doc.get('mime')])).toEqual([
        [outputPath, 'text/plain'],
      ]);

      // A lost HTTP response may be retried byte-for-byte; it returns the
      // original accepted outcome without another artifact, receipt, or wake.
      expect(await callback('/code/callback', { taskId, token, result })).toEqual({
        status: 200,
        json: { ok: true },
      });
      expect((await readDoc('tasks', taskId)).queueGeneration).toBe(woken.queueGeneration);
      expect((await store.collection('outbox').where('taskId', '==', taskId).get()).size).toBe(
        outbox.size,
      );
      expect((await store.collection('files').where('taskId', '==', taskId).get()).size).toBe(1);
      expect(
        (await store.collection('executionJobCallbackReceipts').where('taskId', '==', taskId).get())
          .size,
      ).toBe(1);
      expect(
        await callback('/code/callback', { taskId, token, result: { ok: false, error: 'replay' } }),
      ).toMatchObject({ status: 409 });
      expect((await toolCallsOf(taskId))[0]?.result).toEqual(result);

      expect((await executeTask(executor, taskId)).outcome).toBe('done');
      expect(delivered).toEqual(['The script produced 4.']);
      expect((await readDoc('costReservations', reservationId as string)).status).toBe(
        'reconciled',
      );
      const events = await store
        .collection('costEvents')
        .where('reservationId', '==', reservationId)
        .get();
      expect(events.docs.map((doc) => doc.get('toolCallId'))).toEqual([staged?.id]);
      expect((await persistence.costs.totals()).heldUsd).toBe(0);
      // The accepted receipt remains replayable even after task completion.
      expect(await callback('/code/callback', { taskId, token, result })).toMatchObject({
        status: 200,
        json: { ok: true },
      });
      expect(sqlAccesses).toEqual([]);
    }, 30_000);

    it('refuses a wrong sentinel token without touching the task', async () => {
      const executor = deps(computeSpec);
      const taskId = await createTask();
      expect((await executeTask(executor, taskId)).outcome).toBe('sleeping');
      const before = await readDoc('tasks', taskId);

      expect(
        await callback('/code/callback', { taskId, token: 'wrong-token', result: { ok: true } }),
      ).toEqual({ status: 403, json: { error: 'invalid token' } });
      expect(
        await callback('/code/callback', { taskId: 'not-a-uuid', token: 't', result: {} }),
      ).toMatchObject({ status: 400 });
      expect(
        await callback('/code/callback', { taskId: randomUUID(), token: 't', result: {} }),
      ).toMatchObject({ status: 404 });
      expect(await readDoc('tasks', taskId)).toEqual(before);
      expect((await toolCallsOf(taskId))[0]?.result).toMatchObject({ pending: 'code_job_pending' });
      expect((await store.collection('files').get()).empty).toBe(true);
      expect(sqlAccesses).toEqual([]);
    });

    it('keeps a settled timeout when the callback arrives after it', async () => {
      const executor = deps(computeSpec);
      const taskId = await createTask();
      expect((await executeTask(executor, taskId)).outcome).toBe('sleeping');
      const token = launches[0]?.callbackToken ?? '';
      const [launched] = await toolCallsOf(taskId);
      const reservationId = String(
        (launched?.decision as { reservationId?: string } | undefined)?.reservationId,
      );

      // The job never reports back; the executor wakes past its timeout.
      offsetMs = 60 * 60_000;
      expect((await executeTask(executor, taskId)).outcome).toBe('done');
      const [failed] = await toolCallsOf(taskId);
      expect(failed).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('timed out'),
      });
      expect((await readDoc('costReservations', reservationId)).status).toBe('reconciled');

      const late = await callback('/code/callback', {
        taskId,
        token,
        result: { ok: true, exitCode: 0, stdout: '4\n', outputs: [] },
      });
      expect(late).toMatchObject({ status: 409 });
      expect((await toolCallsOf(taskId))[0]).toEqual(failed);
      expect((await readDoc('tasks', taskId)).status).toBe('done');
      expect(sqlAccesses).toEqual([]);
    });

    it('lets a callback that beats the timeout settlement win, fencing the launching lease', async () => {
      const executor = deps(computeSpec);
      const taskId = await createTask();
      expect((await executeTask(executor, taskId)).outcome).toBe('sleeping');
      const token = launches[0]?.callbackToken ?? '';
      // A run holds the lease past the job's timeout when the callback arrives.
      offsetMs = 60 * 60_000;
      const lease = await persistence.tasks.claim(taskId);
      if (!lease) throw new Error('expected a lease');
      const [launched] = await toolCallsOf(taskId);
      const result = { ok: true, exitCode: 0, stdout: '4\n', stderr: '', outputs: [] };

      expect(await callback('/code/callback', { taskId, token, result })).toMatchObject({
        status: 200,
      });
      // The launching run's lease is fenced out: it can neither settle nor park.
      expect(
        await persistence.executionJobs.settle(
          { taskId, toolCallId: String(launched?.id), timeoutAt: new Date(0) },
          lease,
        ),
      ).toEqual({ kind: 'stale' });
      expect(await persistence.tasks.sleepTask(lease, {}, new Date())).toBe(false);

      // The next run settles the real result rather than a timeout.
      expect((await executeTask(executor, taskId)).outcome).toBe('done');
      expect((await toolCallsOf(taskId))[0]).toMatchObject({ status: 'succeeded', result });
      expect(delivered).toEqual(['The script produced 4.']);
      expect(sqlAccesses).toEqual([]);
    });

    it('records a browser callback with its screenshot and trace inventory', async () => {
      const taskId = await createTask();
      const toolCallId = randomUUID();
      const token = 'browser-launch-token';
      const timeoutAt = new Date(Date.now() + 10 * 60_000).toISOString();
      await store.doc('tasks', taskId).update(
        encodeRecord({
          status: 'sleeping',
          runAfter: new Date(timeoutAt),
          state: {
            pendingJob: {
              dbToolCallId: toolCallId,
              toolCallId: 'model-call',
              toolName: 'browser.execute',
              callbackTokenHash: hashCallbackToken(token),
              timeoutAt,
            },
          },
        }),
      );
      await store.doc('toolCalls', toolCallId).set(
        encodeRecord({
          id: toolCallId,
          taskId,
          status: 'succeeded',
          toolName: 'browser.execute',
          result: {
            pending: 'browser_job_pending',
            callbackToken: hashCallbackToken(token),
            timeoutAt,
          },
        }),
      );
      const result = { ok: true, screenshots: ['shots/1.png'], tracePath: 'traces/run.zip' };

      expect(
        await callback('/browser/callback', { taskId, token: 'forged', result }),
      ).toMatchObject({ status: 403 });
      const beforeCallback = await store.collection('outbox').where('taskId', '==', taskId).get();
      expect(await callback('/browser/callback', { taskId, token, result })).toEqual({
        status: 200,
        json: { ok: true },
      });
      expect((await readDoc('toolCalls', toolCallId)).result).toEqual(result);
      const acceptedTask = await readDoc('tasks', taskId);
      const outbox = await store.collection('outbox').where('taskId', '==', taskId).get();
      expect(outbox.size).toBe(beforeCallback.size + 1);
      expect(
        outbox.docs.filter((doc) => doc.get('generation') === acceptedTask.queueGeneration),
      ).toHaveLength(1);
      const files = await store.collection('files').where('taskId', '==', taskId).get();
      expect(files.docs.map((doc) => [doc.get('workspacePath'), doc.get('mime')]).sort()).toEqual([
        ['shots/1.png', 'image/png'],
        ['traces/run.zip', 'application/zip'],
      ]);
      expect(await callback('/browser/callback', { taskId, token, result })).toEqual({
        status: 200,
        json: { ok: true },
      });
      expect(
        await callback('/browser/callback', {
          taskId,
          token,
          result: { ok: true, screenshots: ['shots/different.png'] },
        }),
      ).toMatchObject({ status: 409 });
      expect((await store.collection('files').where('taskId', '==', taskId).get()).size).toBe(2);
      expect((await store.collection('outbox').where('taskId', '==', taskId).get()).size).toBe(
        outbox.size,
      );
      expect(
        (await store.collection('executionJobCallbackReceipts').where('taskId', '==', taskId).get())
          .size,
      ).toBe(1);
      expect(sqlAccesses).toEqual([]);
    });
  },
);
