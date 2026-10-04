import type { BrowserPlan, InboundEvent, ModelRouter, StepCallOutcome } from '@assistant/core';
import {
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
  type Db,
  tasks,
  toolCalls,
} from '@assistant/db';
import {
  type BrowserJobLaunchInput,
  type GoogleClient,
  registerBrowserTools,
  registerDriveTools,
  registerSheetsTools,
  ToolDispatcher,
  ToolRegistry,
  type WorkspaceStore,
} from '@assistant/tools';
import type { ModelMessage } from 'ai';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];

const applicationPlan: BrowserPlan = {
  goal: 'Submit the approved application to Acme and capture the portal receipt',
  rung: 'headless',
  rationale: 'The authenticated career portal requires a multi-step form.',
  steps: [
    { action: 'goto', url: 'https://careers.example.test/jobs/123/apply' },
    { action: 'type', selector: 'input[name=name]', text: 'Baldvin Smarason' },
    {
      action: 'upload',
      selector: 'input[type=file]',
      workspacePath: 'browser/attachments/resume.pdf',
    },
    { action: 'click', selector: 'button[type=submit]' },
    { action: 'waitFor', selector: '[data-testid=application-confirmation]' },
    {
      action: 'extract',
      selector: '[data-testid=application-confirmation]',
      what: 'the application submission confirmation',
    },
  ],
  useProfile: true,
  maxDurationSeconds: 60,
};

function event(): InboundEvent {
  return {
    source: 'internal',
    agentId,
    trust: 'owner',
    payload: {
      instruction:
        'Apply to Acme using my resume, wait for the portal receipt, then mark row 7 of my tracker as applied.',
    },
  };
}

function router(options: { updateTracker: boolean; finalText: string }): ModelRouter {
  const fake = {
    async object() {
      return {
        ok: true,
        modelId: 'fake/model',
        degraded: false,
        object: {
          action: 'workflow',
          reasoning: '',
          steps: ['stage resume', 'submit application', 'update tracker'],
          missingInfo: [],
        },
      };
    },
    async step(_role: string, callOpts: { messages?: ModelMessage[] }): Promise<StepCallOutcome> {
      const transcript = JSON.stringify(callOpts.messages ?? []);
      if (!transcript.includes('"toolName":"drive.download"')) {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: '',
          toolCalls: [
            {
              toolCallId: 'call_resume',
              toolName: 'drive.download',
              input: {
                fileId: 'resume_1234567890',
                workspacePath: 'browser/attachments/resume.pdf',
              },
            },
          ],
        };
      }
      if (!transcript.includes('"toolName":"browser.execute"')) {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: '',
          toolCalls: [
            {
              toolCallId: 'call_apply',
              toolName: 'browser.execute',
              input: { plan: applicationPlan },
            },
          ],
        };
      }
      const browserSettled =
        transcript.includes('"outputs"') ||
        transcript.includes('timed out') ||
        transcript.includes('denied');
      if (!browserSettled) {
        return { ok: true, modelId: 'fake/model', degraded: false, text: '', toolCalls: [] };
      }
      if (options.updateTracker && !transcript.includes('"toolName":"sheets.write_rows"')) {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: '',
          toolCalls: [
            {
              toolCallId: 'call_tracker',
              toolName: 'sheets.write_rows',
              input: {
                spreadsheetId: 'tracker_1234567890',
                sheetName: 'Applications',
                startCell: 'A7',
                rows: [['Acme', 'Software Engineer', 'Applied', '=external text stays literal']],
              },
            },
          ],
        };
      }
      if (options.updateTracker && !transcript.includes('"writtenRows":1')) {
        if (transcript.includes('"denied":true') || transcript.includes('tracker unavailable')) {
          return {
            ok: true,
            modelId: 'fake/model',
            degraded: false,
            text: options.finalText,
            toolCalls: [],
          };
        }
        return { ok: true, modelId: 'fake/model', degraded: false, text: '', toolCalls: [] };
      }
      return {
        ok: true,
        modelId: 'fake/model',
        degraded: false,
        text: options.finalText,
        toolCalls: [],
      };
    },
  };
  return fake as unknown as ModelRouter;
}

function workflowHarness(options: { trackerError?: string } = {}) {
  const launches: BrowserJobLaunchInput[] = [];
  const writes: Array<{ path: string; bytes: Buffer; contentType: string }> = [];
  const googleApi = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.includes('/drive/v3/files/resume_1234567890?fields=')) {
      return {
        id: 'resume_1234567890',
        name: 'resume.pdf',
        mimeType: 'application/pdf',
        webViewLink: 'https://drive.google.com/file/d/resume_1234567890/view',
      };
    }
    if (url.includes('/spreadsheets/tracker_1234567890/values/')) {
      if (init.method !== 'PUT') throw new Error('tracker update must use PUT');
      if (options.trackerError) throw new Error(options.trackerError);
      return {};
    }
    throw new Error(`unexpected Google API call: ${url}`);
  });
  const google = {
    api: googleApi,
    apiBytes: vi.fn(async () => ({
      body: Buffer.from('%PDF complex workflow resume'),
      contentType: 'application/pdf',
    })),
  } as unknown as GoogleClient;
  const workspace = {
    writeBytes: vi.fn(async (path: string, bytes: Buffer, contentType: string) => {
      writes.push({ path, bytes, contentType });
      return { bytes: bytes.length };
    }),
  } as unknown as WorkspaceStore;

  const registry = registerDriveTools(new ToolRegistry(), { client: google, workspace });
  registerSheetsTools(registry, { client: google, ownerEmail: 'owner@example.test' });
  registerBrowserTools(registry, {
    plan: async () => applicationPlan,
    launcher: {
      launch: async (input) => {
        launches.push(input);
        return { executionName: 'job-application-test' };
      },
    },
    callbackUrl: 'http://localhost:8787/webhooks/browser/callback',
  });
  return { dispatcher: new ToolDispatcher(db, registry), googleApi, launches, writes };
}

async function pendingApproval(taskId: string) {
  const [row] = await db
    .select({ approval: approvals, toolName: toolCalls.toolName })
    .from(approvals)
    .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
    .where(and(eq(approvals.taskId, taskId), eq(approvals.status, 'pending')))
    .orderBy(asc(approvals.requestedAt));
  return row;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('job-application.e2e: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdTaskIds.length > 0) {
    await db
      .update(toolCalls)
      .set({ approvalId: null })
      .where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(approvals).where(inArray(approvals.taskId, createdTaskIds));
    await db.delete(costEvents).where(inArray(costEvents.taskId, createdTaskIds));
    await db.delete(costReservations).where(inArray(costReservations.taskId, createdTaskIds));
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('complex job application workflow (integration, scripted model)', () => {
  it('carries context through Drive, browser approval, callback, and autonomous tracker update', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const harness = workflowHarness();
    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc', maxSteps: 12 });
    createdTaskIds.push(task.id);

    const first = await executeTask(
      {
        db,
        router: router({
          updateTracker: true,
          finalText:
            'I submitted the application after the portal confirmed it, and updated the Google Sheet.',
        }),
        dispatcher: harness.dispatcher,
      },
      task.id,
    );
    expect(first.outcome).toBe('parked');
    expect(harness.writes).toMatchObject([
      {
        path: 'browser/attachments/resume.pdf',
        contentType: 'application/pdf',
      },
    ]);
    expect(harness.launches).toHaveLength(0);

    const browserApproval = await pendingApproval(task.id);
    expect(browserApproval?.toolName).toBe('browser.execute');
    expect(browserApproval?.approval.summary).toContain('careers.example.test');
    expect(browserApproval?.approval.summary).toContain('browser/attachments/resume.pdf');
    await resolveApproval(db, {
      approvalId: browserApproval?.approval.id,
      decision: 'approved',
      via: 'web',
    });

    const launched = await executeTask(
      {
        db,
        router: router({ updateTracker: true, finalText: 'unused before callback' }),
        dispatcher: harness.dispatcher,
      },
      task.id,
    );
    expect(launched.outcome).toBe('sleeping');
    expect(harness.launches).toHaveLength(1);
    expect(harness.launches[0]?.plan).toEqual(applicationPlan);

    const callback = await recordBrowserJobResult(db, {
      taskId: task.id,
      token: harness.launches[0]?.callbackToken ?? '',
      result: {
        ok: true,
        outputs: [
          // the submit interaction a real worker emits before the confirmation
          { index: 4, action: 'click', ok: true },
          {
            index: 5,
            action: 'extract',
            ok: true,
            text: "Thank you for applying. We've received your application for Software Engineer.",
          },
        ],
        screenshots: [],
      },
    });
    expect(callback.ok).toBe(true);

    const finished = await executeTask(
      {
        db,
        router: router({
          updateTracker: true,
          finalText:
            'I submitted the application after the portal confirmed it, and updated the Google Sheet.',
        }),
        dispatcher: harness.dispatcher,
      },
      task.id,
    );
    expect(finished.outcome).toBe('done');
    expect(await pendingApproval(task.id)).toBeUndefined();

    const [finalTask] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(finalTask?.progress).toContain('submitted the application');
    expect(finalTask?.progress).toContain('updated the Google Sheet');
    const calls = await db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.taskId, task.id))
      .orderBy(asc(toolCalls.step));
    expect(calls.map((call) => [call.toolName, call.status])).toEqual([
      ['drive.download', 'succeeded'],
      ['browser.execute', 'succeeded'],
      ['sheets.write_rows', 'succeeded'],
    ]);
    const sheetCall = harness.googleApi.mock.calls.find(([url]) =>
      String(url).includes('/spreadsheets/tracker_1234567890/values/'),
    );
    expect(String(sheetCall?.[0])).toContain(encodeURIComponent("'Applications'!A7"));
    expect(JSON.parse(String((sheetCall?.[1] as RequestInit | undefined)?.body))).toMatchObject({
      values: [['Acme', 'Software Engineer', 'Applied', '=external text stays literal']],
    });
  });

  it('blocks a completion claim when the portal never returns a submission receipt', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const harness = workflowHarness();
    const scriptedRouter = router({
      updateTracker: false,
      finalText: 'I submitted the application successfully.',
    });
    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc', maxSteps: 8 });
    createdTaskIds.push(task.id);

    expect(
      (await executeTask({ db, router: scriptedRouter, dispatcher: harness.dispatcher }, task.id))
        .outcome,
    ).toBe('parked');
    const approval = await pendingApproval(task.id);
    await resolveApproval(db, {
      approvalId: approval?.approval.id,
      decision: 'approved',
      via: 'web',
    });
    expect(
      (await executeTask({ db, router: scriptedRouter, dispatcher: harness.dispatcher }, task.id))
        .outcome,
    ).toBe('sleeping');

    await recordBrowserJobResult(db, {
      taskId: task.id,
      token: harness.launches[0]?.callbackToken ?? '',
      result: {
        ok: true,
        outputs: [
          {
            index: 5,
            action: 'extract',
            ok: true,
            text: 'Please review your details before continuing.',
          },
        ],
        screenshots: [],
      },
    });
    expect(
      (await executeTask({ db, router: scriptedRouter, dispatcher: harness.dispatcher }, task.id))
        .outcome,
    ).toBe('needs_attention');

    const [finalTask] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(finalTask?.status).toBe('needs_attention');
    expect(finalTask?.progress).toContain('requested Drive file was staged');
    expect(finalTask?.progress).toContain('Still needed: the application submission');
    expect(finalTask?.progress).not.toContain('successfully');
  });

  it('reports partial success when submission is confirmed but the tracker update fails', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const harness = workflowHarness({ trackerError: 'tracker unavailable' });
    const scriptedRouter = router({
      updateTracker: true,
      finalText:
        'The portal confirmed the application submission. I could not update the Google Sheet because the tracker was unavailable.',
    });
    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc', maxSteps: 12 });
    createdTaskIds.push(task.id);

    expect(
      (await executeTask({ db, router: scriptedRouter, dispatcher: harness.dispatcher }, task.id))
        .outcome,
    ).toBe('parked');
    const browserApproval = await pendingApproval(task.id);
    await resolveApproval(db, {
      approvalId: browserApproval?.approval.id,
      decision: 'approved',
      via: 'web',
    });
    expect(
      (await executeTask({ db, router: scriptedRouter, dispatcher: harness.dispatcher }, task.id))
        .outcome,
    ).toBe('sleeping');
    await recordBrowserJobResult(db, {
      taskId: task.id,
      token: harness.launches[0]?.callbackToken ?? '',
      result: {
        ok: true,
        outputs: [
          { index: 4, action: 'click', ok: true },
          {
            index: 5,
            action: 'extract',
            ok: true,
            text: 'Application submitted. Confirmation number ACME-12345.',
          },
        ],
        screenshots: [],
      },
    });

    expect(
      (await executeTask({ db, router: scriptedRouter, dispatcher: harness.dispatcher }, task.id))
        .outcome,
    ).toBe('done');
    const [finalTask] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(finalTask?.progress).toContain('portal confirmed');
    expect(finalTask?.progress).toContain('tracker was unavailable');
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    expect(calls.find((call) => call.toolName === 'browser.execute')?.status).toBe('succeeded');
    expect(calls.find((call) => call.toolName === 'sheets.write_rows')?.status).toBe('failed');
    expect(
      harness.googleApi.mock.calls.some(([url]) =>
        String(url).includes('/spreadsheets/tracker_1234567890/values/'),
      ),
    ).toBe(true);
  });
});
