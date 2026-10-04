import type { DispatcherPort, InboundEvent, ModelRouter, StepCallOutcome } from '@assistant/core';
import {
  acceptSuggestion,
  completeTask,
  createSuggestion,
  enqueueTask,
  executeTask,
  getAgent,
  renotifyStalledAttention,
  resolveApproval,
} from '@assistant/core';
import {
  approvalPolicies,
  approvals,
  conversationSegments,
  conversations,
  createDb,
  type Db,
  messages,
  suggestions,
  tasks,
  toolCalls,
} from '@assistant/db';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import type { ModelMessage } from 'ai';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];
const createdConversationIds: string[] = [];
const createdSuggestionIds: string[] = [];
const executions: Record<string, number> = {};

/**
 * Scripted model: proposes exec.counter, then exec.outbound, then finishes.
 * Decisions derive from the transcript, so resume-from-checkpoint follows the
 * same script without any state inside the fake.
 */
function makeFakeRouter(opts: { throwOnStep?: number } = {}) {
  let stepCalls = 0;
  const fake = {
    async object() {
      return {
        ok: true,
        modelId: 'fake/model',
        degraded: false,
        object: { action: 'workflow', reasoning: '', steps: ['count', 'send'], missingInfo: [] },
      };
    },
    async step(_role: string, callOpts: { messages?: ModelMessage[] }): Promise<StepCallOutcome> {
      stepCalls += 1;
      if (opts.throwOnStep === stepCalls) throw new Error('simulated crash');

      const transcript = JSON.stringify(callOpts.messages ?? []);
      const hasCounterResult =
        transcript.includes('"toolName":"exec.counter"') && transcript.includes('tool-result');
      const hasOutboundResult =
        transcript.includes('"toolName":"exec.outbound"') &&
        transcript.split('"toolName":"exec.outbound"').length > 2;

      if (!hasCounterResult) {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: '',
          toolCalls: [{ toolCallId: 'call_counter', toolName: 'exec.counter', input: {} }],
        };
      }
      if (!hasOutboundResult) {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: '',
          toolCalls: [
            {
              toolCallId: 'call_outbound',
              toolName: 'exec.outbound',
              input: { message: 'hello world' },
            },
          ],
        };
      }
      return {
        ok: true,
        modelId: 'fake/model',
        degraded: false,
        text: 'All done: counted and sent.',
        toolCalls: [],
      };
    },
  };
  return fake as unknown as ModelRouter;
}

function makeRegistry(taskKey: string) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'exec.counter',
    description: 'increments a counter (side effect under test)',
    inputSchema: z.object({}),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    idempotencyKey: () => `exec-counter-${taskKey}`,
    execute: async () => {
      executions[taskKey] = (executions[taskKey] ?? 0) + 1;
      return { count: executions[taskKey] };
    },
  });
  registry.register(
    {
      name: 'exec.outbound',
      description: 'sends a message to a human (approval-gated)',
      inputSchema: z.object({ message: z.string() }),
      risk: 'approval',
      acceptsUntrustedInput: true,
      approvalSummary: (args) => `send "${(args as { message: string }).message}"`,
      execute: async (args) => ({ sent: true, message: (args as { message: string }).message }),
    },
    { outwardFacing: true },
  );
  return registry;
}

function event(): InboundEvent {
  return { source: 'internal', agentId, trust: 'owner', payload: {} };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
    await db
      .update(toolCalls)
      .set({ approvalId: null })
      .where(sql`${toolCalls.toolName} LIKE 'exec.%'`);
    await db
      .delete(approvals)
      .where(
        sql`${approvals.toolCallId} IN (select id from ${toolCalls} where ${toolCalls.toolName} LIKE 'exec.%')`,
      );
    await db.delete(toolCalls).where(sql`${toolCalls.toolName} LIKE 'exec.%'`);
    await db
      .delete(approvalPolicies)
      .where(eq(approvalPolicies.templateKey, 'test.exec.outbound.recipient'));
  } catch {
    console.warn('executor.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    if (createdSuggestionIds.length) {
      await db.delete(suggestions).where(inArray(suggestions.id, createdSuggestionIds));
    }
    await db
      .update(toolCalls)
      .set({ approvalId: null })
      .where(sql`${toolCalls.toolName} LIKE 'exec.%'`);
    await db
      .delete(approvals)
      .where(
        sql`${approvals.toolCallId} IN (select id from ${toolCalls} where ${toolCalls.toolName} LIKE 'exec.%')`,
      );
    await db.delete(toolCalls).where(sql`${toolCalls.toolName} LIKE 'exec.%'`);
    await db
      .delete(approvalPolicies)
      .where(eq(approvalPolicies.templateKey, 'test.exec.outbound.recipient'));
    if (createdConversationIds.length) {
      // Offline segmentation can create rows that anchor these messages. Clear
      // those derived rows first so this suite remains isolated.
      await db
        .delete(conversationSegments)
        .where(inArray(conversationSegments.conversationId, createdConversationIds));
      await db.delete(messages).where(inArray(messages.conversationId, createdConversationIds));
    }
    if (createdTaskIds.length) {
      // Break the approvals<->tool_calls FK cycle, then clear every tool_call for
      // these tasks (not just exec.*) before deleting the tasks themselves.
      await db
        .update(toolCalls)
        .set({ approvalId: null })
        .where(inArray(toolCalls.taskId, createdTaskIds));
      await db.delete(approvals).where(inArray(approvals.taskId, createdTaskIds));
      await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
      await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
    }
    if (createdConversationIds.length) {
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
    }
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('executor end-to-end (integration, scripted model)', () => {
  it('accepts a legacy suggestion, uses its proposal, and delivers the completed result in its chat', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'suggestion-result-test' })
      .returning();
    if (!conversation) throw new Error('conversation was not created');
    createdConversationIds.push(conversation.id);

    const instruction = 'Explain the difference between snoozing and dismissing a reminder.';
    const suggestion = await createSuggestion(db, {
      agentId,
      // Historical pulse cards have no conversationId on the suggestion row.
      summary: 'Explain the reminder options?',
      proposedAction: instruction,
      sourceRef: `executor-suggestion-${conversation.id}`,
      origin: 'pulse',
    });
    if (!suggestion) throw new Error('suggestion was not created');
    createdSuggestionIds.push(suggestion.id);
    await db.insert(messages).values([
      {
        conversationId: conversation.id,
        role: 'assistant',
        origin: 'assistant',
        text: suggestion.summary,
        parts: [{ type: 'suggestion', suggestionId: suggestion.id, summary: suggestion.summary }],
      },
      {
        conversationId: conversation.id,
        role: 'user',
        origin: 'owner',
        text: 'Find my unrelated vacation photos from Reykjavik.',
        parts: [{ type: 'text', text: 'Find my unrelated vacation photos from Reykjavik.' }],
      },
    ]);

    const accepted = await acceptSuggestion(db, suggestion.id);
    if (!accepted.ok) throw new Error(accepted.reason);
    createdTaskIds.push(accepted.taskId);
    const modelWindows: ModelMessage[][] = [];
    const finalText = 'Snoozing brings the reminder back later. Dismissing closes it.';
    const router = {
      async object() {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          object: { action: 'reply', reasoning: '', steps: [], missingInfo: [] },
        };
      },
      async step(_role: string, options: { messages?: ModelMessage[] }): Promise<StepCallOutcome> {
        modelWindows.push(options.messages ?? []);
        return { ok: true, modelId: 'fake/model', degraded: false, text: finalText, toolCalls: [] };
      },
    } as unknown as ModelRouter;
    // No external side-effect tools are registered for this regression.
    const dispatcher = new ToolDispatcher(db, new ToolRegistry());
    const outcome = await executeTask({ db, router, dispatcher }, accepted.taskId);
    expect(outcome.outcome).toBe('done');
    expect(modelWindows.length).toBeGreaterThan(0);
    expect(modelWindows[0]?.filter((message) => message.role === 'user')).toEqual([
      { role: 'user', content: instruction },
    ]);
    expect(JSON.stringify(modelWindows)).not.toContain('unrelated vacation photos');

    const replies = await db
      .select()
      .from(messages)
      .where(and(eq(messages.taskId, accepted.taskId), eq(messages.role, 'assistant')));
    expect(replies).toHaveLength(1);
    expect(replies[0]?.conversationId).toBe(conversation.id);
    expect(replies[0]?.text).toBe(finalText);
    const [finished] = await db.select().from(tasks).where(eq(tasks.id, accepted.taskId));
    expect(finished?.status).toBe('done');
    expect(await db.select().from(toolCalls).where(eq(toolCalls.taskId, accepted.taskId))).toEqual(
      [],
    );
  });

  it('runs tools, parks on approval, resumes after approval, completes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = `t1-${Date.now()}`;
    const dispatcher = new ToolDispatcher(db, makeRegistry(key));
    const router = makeFakeRouter();

    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    // Run 1: counter executes, outbound parks
    const run1 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run1.outcome).toBe('parked');
    expect(executions[key]).toBe(1);

    let [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('waiting_approval');
    expect(row?.plan).toMatchObject({ action: 'workflow' });

    // A queue redelivery while parked must be a no-op
    const redelivery = await executeTask({ db, router, dispatcher }, task.id);
    expect(redelivery.outcome).toBe('not_claimable');

    // The approval exists with the exact payload
    const [approval] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(approval?.status).toBe('pending');
    expect(approval?.payload).toEqual({ message: 'hello world' });

    // Owner approves (with an edit) → task wakes
    const resolved = await resolveApproval(db, {
      approvalId: approval?.id,
      decision: 'approved',
      via: 'web',
      editedPayload: { message: 'hello edited world' },
    });
    expect(resolved.ok).toBe(true);

    // Run 2: resumes from checkpoint, executes the approved (edited) call, finishes
    const run2 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run2.outcome).toBe('done');
    expect(executions[key]).toBe(1); // counter did NOT run again — checkpoint held

    [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('done');

    const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    const outbound = calls.find((c) => c.toolName === 'exec.outbound');
    expect(outbound?.status).toBe('succeeded');
    expect(outbound?.result).toMatchObject({ message: 'hello edited world' }); // edit applied
  });

  it('denied approvals resume with a denial result and still complete', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = `t2-${Date.now()}`;
    const dispatcher = new ToolDispatcher(db, makeRegistry(key));
    const router = makeFakeRouter();

    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    await executeTask({ db, router, dispatcher }, task.id);
    const [approval] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    await resolveApproval(db, { approvalId: approval?.id, decision: 'denied', via: 'web' });

    const run2 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run2.outcome).toBe('done'); // fake sees the denial tool-result and finishes

    const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    const outbound = calls.find((c) => c.toolName === 'exec.outbound');
    expect(outbound?.status).toBe('denied');
  });

  it('parks an approved action when its reservation is budget-blocked, then retries it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = `approved-budget-${Date.now()}`;
    const base = new ToolDispatcher(db, makeRegistry(key));
    let blocked = true;
    const dispatcher: DispatcherPort = {
      toolDefs: (trust) => base.toolDefs(trust),
      resultIsUntrusted: (toolName) => base.resultIsUntrusted(toolName),
      dispatch: (input) => base.dispatch(input),
      executeApproved: async () =>
        blocked
          ? {
              kind: 'budget_blocked',
              reason: 'daily budget exhausted (test)',
              resumeAt: new Date(Date.now() + 3600e3),
            }
          : { kind: 'executed', result: { sent: true, message: 'hello world' } },
    };
    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    await executeTask({ db, router: makeFakeRouter(), dispatcher }, task.id);
    const [approval] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    await resolveApproval(db, { approvalId: approval?.id, decision: 'approved', via: 'web' });

    const parked = await executeTask({ db, router: makeFakeRouter(), dispatcher }, task.id);
    expect(parked.outcome).toBe('parked');
    let [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('waiting_budget');
    expect(((row?.state ?? {}) as { pendingApprovals?: unknown[] }).pendingApprovals).toHaveLength(
      1,
    );
    expect(row?.attempt).toBe(0);

    blocked = false;
    await db
      .update(tasks)
      .set({ runAfter: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, task.id));
    const resumed = await executeTask({ db, router: makeFakeRouter(), dispatcher }, task.id);
    expect(resumed.outcome).toBe('done');
    [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('done');
  });

  it('an approval park in a conversation posts a notice message (the thread never goes silent)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = `t4-${Date.now()}`;
    const dispatcher = new ToolDispatcher(db, makeRegistry(key));
    const router = makeFakeRouter();

    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'exec-notice-test' })
      .returning();
    const convId = (conversation as NonNullable<typeof conversation>).id;
    createdConversationIds.push(convId);
    await db.insert(messages).values({
      conversationId: convId,
      role: 'user',
      origin: 'owner',
      parts: [{ type: 'text', text: 'please count then send hello world' }],
      text: 'please count then send hello world',
      embedding: new Array(1536).fill(0.01),
    });

    const { task } = await enqueueTask(db, {
      event: { ...event(), conversationId: convId },
      type: 'chat_turn',
    });
    createdTaskIds.push(task.id);

    const run = await executeTask({ db, router, dispatcher }, task.id);
    expect(run.outcome).toBe('parked');

    const [approval] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    const thread = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.createdAt);
    const last = thread.at(-1);
    expect(last?.role).toBe('assistant');
    // One short question; the code and buttons ride on the approval card part.
    expect(last?.text).toContain('okay to go ahead?');
    expect(last?.text).not.toContain('This needs your approval');
    expect(JSON.stringify(last?.parts)).toContain(approval?.shortCode ?? '@@missing@@');
  });

  it('turns a model-invented approval notice into a real approval record', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = `phantom-approval-${Date.now()}`;
    const dispatcher = new ToolDispatcher(db, makeRegistry(key));
    let stepCalls = 0;
    const router = {
      async object() {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          object: { action: 'workflow', reasoning: '', steps: ['send'], missingInfo: [] },
        };
      },
      async step(): Promise<StepCallOutcome> {
        stepCalls += 1;
        if (stepCalls === 1) {
          return {
            ok: true,
            modelId: 'fake/model',
            degraded: false,
            text: 'This needs your approval before I act:\n- **[A999]** send hello\nApprove or deny it on the Approvals page.',
            toolCalls: [],
          };
        }
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: '',
          toolCalls: [
            {
              toolCallId: 'call_real_approval',
              toolName: 'exec.outbound',
              input: { message: 'hello' },
            },
          ],
        };
      },
    } as unknown as ModelRouter;

    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'phantom-approval-test' })
      .returning();
    const conversationId = (conversation as NonNullable<typeof conversation>).id;
    createdConversationIds.push(conversationId);
    await db.insert(messages).values({
      conversationId,
      role: 'user',
      origin: 'owner',
      parts: [{ type: 'text', text: 'send hello' }],
      text: 'send hello',
      embedding: new Array(1536).fill(0.01),
    });
    const { task } = await enqueueTask(db, {
      event: { ...event(), conversationId },
      type: 'chat_turn',
    });
    createdTaskIds.push(task.id);

    const run = await executeTask({ db, router, dispatcher }, task.id);
    expect(run.outcome).toBe('parked');
    expect(stepCalls).toBe(2);
    const [approval] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(approval).toMatchObject({ status: 'pending', summary: 'send "hello"' });
    expect(approval?.shortCode).not.toBe('A999');
  });

  it('a crash mid-run retries and resumes from the checkpoint without double side effects', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = `t3-${Date.now()}`;
    const dispatcher = new ToolDispatcher(db, makeRegistry(key));

    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    // step 2 throws — AFTER the counter executed and was checkpointed
    const crashy = makeFakeRouter({ throwOnStep: 2 });
    const run1 = await executeTask({ db, router: crashy, dispatcher }, task.id);
    expect(run1.outcome).toBe('failed');
    expect(executions[key]).toBe(1);

    let [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('sleeping'); // bounded backoff, not dead
    await db
      .update(tasks)
      .set({ runAfter: new Date(Date.now() - 1_000) })
      .where(eq(tasks.id, task.id));

    // Retry with a healthy model: resumes from checkpoint — counter NOT re-run
    const healthy = makeFakeRouter();
    const run2 = await executeTask({ db, router: healthy, dispatcher }, task.id);
    expect(run2.outcome).toBe('parked'); // proceeds to the outbound approval
    expect(executions[key]).toBe(1);

    [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('waiting_approval');
  });

  it('a dead-letter whose notify fails stays unstamped so the sweep re-notifies it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = `t-deadletter-${Date.now()}`;
    const dispatcher = new ToolDispatcher(db, makeRegistry(key));
    // Owner task with NO conversation: the owner's only path here is the push.
    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);
    // Jump to the final attempt so a single crash dead-letters immediately.
    await db.update(tasks).set({ attempt: 7 }).where(eq(tasks.id, task.id));

    // The dead-letter owner push throws → nothing reaches the owner, so the row
    // must NOT be stamped as notified.
    let pushAttempts = 0;
    const throwingPush = async () => {
      pushAttempts += 1;
      throw new Error('push channel down');
    };
    const crashy = makeFakeRouter({ throwOnStep: 1 });
    const run = await executeTask(
      { db, router: crashy, dispatcher, notifyOwner: throwingPush },
      task.id,
    );
    expect(run.outcome).toBe('dead_letter');
    expect(pushAttempts).toBe(1);

    let [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('needs_attention');
    expect(row?.attentionNotifiedAt).toBeNull();

    // Age it past the grace window and run the real sweep with a working push:
    // it re-notifies and stamps the row exactly once.
    await db
      .update(tasks)
      .set({ updatedAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(tasks.id, task.id));
    const delivered: string[] = [];
    const count = await renotifyStalledAttention(
      db,
      async ({ taskId }) => {
        delivered.push(taskId);
      },
      { olderThanMinutes: 5 },
    );
    expect(count).toBeGreaterThanOrEqual(1);
    expect(delivered).toContain(task.id);
    [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.attentionNotifiedAt).not.toBeNull();

    // A second sweep leaves it alone now that it is stamped.
    const again = await renotifyStalledAttention(db, async () => {}, { olderThanMinutes: 5 });
    void again;
    expect(delivered.filter((id) => id === task.id)).toHaveLength(1);
  });

  it('routes a conversation-less assistant final into the Notifications thread', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const dispatcher = new ToolDispatcher(db, makeRegistry(`t-sink-${Date.now()}`));
    // A scheduled, assistant-trust task with NO conversation: deliverFinal no-ops
    // and there is no thread to reply into — the answer must reach Notifications.
    const { task } = await enqueueTask(db, {
      event: { source: 'internal', agentId, trust: 'assistant', payload: {} },
      type: 'scheduled',
    });
    createdTaskIds.push(task.id);
    await db.update(tasks).set({ title: 'Nightly summary' }).where(eq(tasks.id, task.id));

    const proseRouter = {
      async object() {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          object: { action: 'reply', reasoning: '', steps: [], missingInfo: [] },
        };
      },
      async step(): Promise<StepCallOutcome> {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: 'Your scheduled summary is ready.',
          toolCalls: [],
        };
      },
    } as unknown as ModelRouter;

    const run = await executeTask({ db, router: proseRouter, dispatcher }, task.id);
    expect(run.outcome).toBe('done');

    const [notif] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.agentId, agentId), eq(conversations.title, 'Notifications')));
    expect(notif).toBeTruthy();
    if (notif) createdConversationIds.push(notif.id);
    const rows = await db
      .select({ text: messages.text, conversationId: messages.conversationId })
      .from(messages)
      .where(eq(messages.taskId, task.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.conversationId).toBe(notif?.id);
    // Titled so the owner can tell what produced it, and carries the answer.
    expect(rows[0]?.text).toContain('Nightly summary');
    expect(rows[0]?.text).toContain('Your scheduled summary is ready.');
  });

  it('retries a failed final delivery from the exact checkpoint without rerunning the model', async (ctx) => {
    if (!dbUp) return ctx.skip();
    let stepCalls = 0;
    let deliveries = 0;
    const router = {
      async object() {
        return { ok: true, modelId: 'fake/model', degraded: false, object: { trivial: true } };
      },
      async step(): Promise<StepCallOutcome> {
        stepCalls += 1;
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: 'A stable final response.',
          toolCalls: [],
          finishReason: 'stop',
        };
      },
    } as unknown as ModelRouter;
    const dispatcher = new ToolDispatcher(db, new ToolRegistry());

    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'delivery-retry-test' })
      .returning();
    const conversationId = (conversation as NonNullable<typeof conversation>).id;
    createdConversationIds.push(conversationId);
    await db.insert(messages).values({
      conversationId,
      role: 'user',
      origin: 'owner',
      parts: [{ type: 'text', text: 'answer once' }],
      text: 'answer once',
    });
    const { task } = await enqueueTask(db, {
      event: { ...event(), conversationId },
      type: 'chat_turn',
    });
    createdTaskIds.push(task.id);

    const deliverFinal = async () => {
      deliveries += 1;
      if (deliveries === 1) throw new Error('provider unavailable');
    };
    const first = await executeTask({ db, router, dispatcher, deliverFinal }, task.id);
    expect(first.outcome).toBe('failed');
    let [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('sleeping');
    expect(row?.attempt).toBe(1);
    expect(((row?.state ?? {}) as { pendingFinal?: { text?: string } }).pendingFinal?.text).toBe(
      'A stable final response.',
    );

    await db
      .update(tasks)
      .set({ runAfter: new Date(Date.now() - 1_000) })
      .where(eq(tasks.id, task.id));
    const second = await executeTask({ db, router, dispatcher, deliverFinal }, task.id);
    expect(second.outcome).toBe('done');
    expect(stepCalls).toBe(1);
    expect(deliveries).toBe(2);
    [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('done');
    expect(row?.attempt).toBe(0);
    const assistantCopies = await db
      .select()
      .from(messages)
      .where(
        sql`${messages.taskId} = ${task.id} and ${messages.role} = 'assistant' and ${messages.text} = 'A stable final response.'`,
      );
    expect(assistantCopies).toHaveLength(1);
  });

  it('does not duplicate a final delivery whose provider attempt was already staged', async (ctx) => {
    if (!dbUp) return ctx.skip();
    let deliveries = 0;
    const dispatcher = new ToolDispatcher(db, new ToolRegistry());
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'delivery-ambiguous-test' })
      .returning();
    const conversationId = (conversation as NonNullable<typeof conversation>).id;
    createdConversationIds.push(conversationId);
    const { task } = await enqueueTask(db, {
      event: { ...event(), conversationId },
      type: 'chat_turn',
    });
    createdTaskIds.push(task.id);
    await db
      .update(tasks)
      .set({
        state: {
          pendingFinal: {
            text: 'Possibly delivered already.',
            progress: 'final response',
            terminalStatus: 'done',
            outcome: 'done',
            deliveryAttempted: true,
          },
        },
      })
      .where(eq(tasks.id, task.id));

    const result = await executeTask(
      {
        db,
        router: {
          step: async () => {
            throw new Error('model must not rerun');
          },
        } as unknown as ModelRouter,
        dispatcher,
        deliverFinal: async () => {
          deliveries += 1;
        },
      },
      task.id,
    );

    expect(result.outcome).toBe('done');
    expect(deliveries).toBe(0);
  });

  it('a late approval resolution cannot resurrect a cancelled task', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = `cancel-${Date.now()}`;
    const dispatcher = new ToolDispatcher(db, makeRegistry(key));
    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    await executeTask({ db, router: makeFakeRouter(), dispatcher }, task.id);
    const [approval] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    await completeTask(db, task.id, { status: 'cancelled' });
    const resolved = await resolveApproval(db, {
      approvalId: approval?.id,
      decision: 'approved',
      via: 'web',
    });
    expect(resolved.ok).toBe(true);
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after?.status).toBe('cancelled');
  });

  it('reactivates an identical standing approval policy instead of duplicating it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const policy = {
      agentId,
      toolName: 'exec.outbound',
      templateKey: 'test.exec.outbound.recipient',
      match: { recipient: 'repeat@example.com' },
      effect: 'allow' as const,
    };

    const resolveWithPolicy = async (suffix: string) => {
      const key = `policy-${suffix}-${Date.now()}`;
      const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
      createdTaskIds.push(task.id);
      await executeTask(
        { db, router: makeFakeRouter(), dispatcher: new ToolDispatcher(db, makeRegistry(key)) },
        task.id,
      );
      const [approval] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
      expect(approval).toBeDefined();
      const resolved = await resolveApproval(db, {
        approvalId: approval?.id,
        decision: 'approved',
        via: 'web',
        policy,
      });
      expect(resolved.ok).toBe(true);
    };

    await resolveWithPolicy('first');
    const [first] = await db
      .select()
      .from(approvalPolicies)
      .where(eq(approvalPolicies.templateKey, policy.templateKey));
    expect(first).toBeDefined();
    await db
      .update(approvalPolicies)
      .set({ enabled: false })
      .where(eq(approvalPolicies.id, (first as NonNullable<typeof first>).id));

    await resolveWithPolicy('second');
    const rows = await db
      .select()
      .from(approvalPolicies)
      .where(eq(approvalPolicies.templateKey, policy.templateKey));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(true);
  });

  it('delivers a text-only response cut off after model reasoning', async (ctx) => {
    if (!dbUp) return ctx.skip();
    let deliveries = 0;
    const router = {
      async object() {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          object: { action: 'reply', reasoning: '', steps: [], missingInfo: [] },
        };
      },
      async step(): Promise<StepCallOutcome> {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: 'partial output',
          toolCalls: [],
          finishReason: 'length',
        };
      },
    } as unknown as ModelRouter;
    const dispatcher: DispatcherPort = {
      toolDefs: () => [],
      resultIsUntrusted: () => false,
      dispatch: async () => ({ kind: 'rejected', reason: 'unused' }),
      executeApproved: async () => ({ kind: 'failed', error: 'unused' }),
    };
    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    const result = await executeTask(
      {
        db,
        router,
        dispatcher,
        deliverFinal: async () => {
          deliveries += 1;
        },
      },
      task.id,
    );
    // A reasoning model can consume its output budget before returning a
    // formal stop. With no incomplete tool call, the partial text is safer and
    // more useful than failing an otherwise valid owner reply.
    expect(result.outcome).toBe('done');
    expect(deliveries).toBe(1);
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after?.status).toBe('done');
  });

  it('replaces a model-invented action report with a ledger-backed limitation', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const router = {
      async object() {
        return { ok: true, modelId: 'fake/model', degraded: false, object: { trivial: true } };
      },
      async step(): Promise<StepCallOutcome> {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: "I created a shared spreadsheet, emailed the first candidates, booked their interviews, and submitted the applications. I'll keep handling it silently.",
          toolCalls: [],
          finishReason: 'stop',
        };
      },
    } as unknown as ModelRouter;
    const dispatcher = new ToolDispatcher(db, new ToolRegistry());
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'response-contract-test' })
      .returning();
    const conversationId = (conversation as NonNullable<typeof conversation>).id;
    createdConversationIds.push(conversationId);
    const { task } = await enqueueTask(db, {
      event: { ...event(), conversationId },
      type: 'chat_turn',
    });
    createdTaskIds.push(task.id);

    const outcome = await executeTask({ db, router, dispatcher }, task.id);
    expect(outcome.outcome).toBe('needs_attention');
    const [reply] = await db
      .select()
      .from(messages)
      .where(sql`${messages.taskId} = ${task.id} and ${messages.role} = 'assistant'`);
    expect(reply?.text).toContain("I couldn't complete this because");
    expect(reply?.text).not.toContain('I created a shared spreadsheet');
    const [unfinished] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(unfinished?.status).toBe('needs_attention');
  });

  it('reads an owner-shared Google Doc before the model continues the chat', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'docs.get',
        description: 'Read a shared Google Doc.',
        inputSchema: z.object({ documentId: z.string() }),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: async (args) => ({
          documentId: (args as { documentId: string }).documentId,
          title: 'CV',
          text: 'Senior staff frontend engineer',
        }),
      },
      { confidentialRead: true, returnsUntrustedContent: true },
    );
    const dispatcher = new ToolDispatcher(db, registry);
    const router = {
      async object() {
        return { ok: true, modelId: 'fake/model', degraded: false, object: { trivial: true } };
      },
      async step(): Promise<StepCallOutcome> {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: 'I reviewed the CV and am ready to continue.',
          toolCalls: [],
          finishReason: 'stop',
        };
      },
    } as unknown as ModelRouter;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'shared-cv-test' })
      .returning();
    const conversationId = (conversation as NonNullable<typeof conversation>).id;
    createdConversationIds.push(conversationId);
    await db.insert(messages).values({
      conversationId,
      role: 'user',
      origin: 'owner',
      parts: [
        {
          type: 'text',
          text: 'CV: https://docs.google.com/document/d/1SLbcTqOwMMQG3QmD7gj755xzOKwQtVyv5cvaPjSwGSs/edit',
        },
      ],
      text: 'CV: https://docs.google.com/document/d/1SLbcTqOwMMQG3QmD7gj755xzOKwQtVyv5cvaPjSwGSs/edit',
    });
    const { task } = await enqueueTask(db, {
      event: { ...event(), conversationId },
      type: 'chat_turn',
    });
    createdTaskIds.push(task.id);

    const result = await executeTask({ db, router, dispatcher }, task.id);
    expect(result.outcome).toBe('done');
    const [read] = await db
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.taskId, task.id), eq(toolCalls.toolName, 'docs.get')));
    expect(read).toMatchObject({
      status: 'succeeded',
      args: { documentId: '1SLbcTqOwMMQG3QmD7gj755xzOKwQtVyv5cvaPjSwGSs' },
    });
    await db.delete(toolCalls).where(eq(toolCalls.taskId, task.id));
  });

  it('strips a fabricated link from the final answer but keeps a tool-sourced one', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const realUrl = 'https://docs.example/report/verified-123';
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'web.lookup',
        description: 'returns a source URL',
        inputSchema: z.object({}),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: async () => ({ url: realUrl }),
      },
      { returnsUntrustedContent: true },
    );
    const dispatcher = new ToolDispatcher(db, registry);
    const router = {
      async object() {
        return { ok: true, modelId: 'fake/model', degraded: false, object: { trivial: true } };
      },
      async step(_role: string, opts: { messages?: ModelMessage[] }): Promise<StepCallOutcome> {
        const transcript = JSON.stringify(opts.messages ?? []);
        if (!transcript.includes(realUrl)) {
          return {
            ok: true,
            modelId: 'fake/model',
            degraded: false,
            text: '',
            toolCalls: [{ toolCallId: 'l1', toolName: 'web.lookup', input: {} }],
          };
        }
        // Final: cite the real (tool-sourced) URL AND invent a second one.
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: `Source: ${realUrl} — also booked here: https://fabricated.example/booking/zzz`,
          toolCalls: [],
          finishReason: 'stop',
        };
      },
    } as unknown as ModelRouter;

    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'url-provenance' })
      .returning();
    const conversationId = (conversation as NonNullable<typeof conversation>).id;
    createdConversationIds.push(conversationId);
    const { task } = await enqueueTask(db, {
      event: { ...event(), conversationId },
      type: 'chat_turn',
    });
    createdTaskIds.push(task.id);

    const outcome = await executeTask({ db, router, dispatcher }, task.id);
    expect(outcome.outcome).toBe('done');
    const [reply] = await db
      .select()
      .from(messages)
      .where(sql`${messages.taskId} = ${task.id} and ${messages.role} = 'assistant'`);
    expect(reply?.text).toContain(realUrl); // tool-sourced link survives
    expect(reply?.text).not.toContain('fabricated.example'); // invented link stripped
    expect(reply?.text).toContain("couldn't trace");
  });

  it('resumes partial approvals in strict proposal order', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const order: string[] = [];
    const registry = new ToolRegistry();
    for (const name of ['exec.first', 'exec.second']) {
      registry.register(
        {
          name,
          description: `approval-gated ${name}`,
          inputSchema: z.object({}),
          risk: 'approval',
          acceptsUntrustedInput: true,
          approvalSummary: () => `run ${name}`,
          execute: async () => {
            order.push(name);
            return { ran: name };
          },
        },
        { outwardFacing: true },
      );
    }
    const dispatcher = new ToolDispatcher(db, registry);
    const router = {
      async object() {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          object: { action: 'workflow', reasoning: '', steps: ['a', 'b'], missingInfo: [] },
        };
      },
      async step(_role: string, opts: { messages?: ModelMessage[] }): Promise<StepCallOutcome> {
        const transcript = JSON.stringify(opts.messages ?? []);
        // Propose both gated calls in one step; once both results are in, finish.
        if (transcript.includes('"ran":"exec.second"')) {
          return {
            ok: true,
            modelId: 'fake/model',
            degraded: false,
            text: 'both done',
            toolCalls: [],
            finishReason: 'stop',
          };
        }
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: '',
          toolCalls: [
            { toolCallId: 'c1', toolName: 'exec.first', input: {} },
            { toolCallId: 'c2', toolName: 'exec.second', input: {} },
          ],
        };
      },
    } as unknown as ModelRouter;

    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    const parked = await executeTask({ db, router, dispatcher }, task.id);
    expect(parked.outcome).toBe('parked');

    const rows = await db
      .select({ id: approvals.id, name: toolCalls.toolName })
      .from(approvals)
      .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
      .where(eq(approvals.taskId, task.id));
    const first = rows.find((r) => r.name === 'exec.first');
    const second = rows.find((r) => r.name === 'exec.second');
    expect(first && second).toBeTruthy();

    // Approve only the SECOND call. Strict order means nothing runs yet: the
    // first is still undecided, so the second waits behind it.
    await resolveApproval(db, {
      approvalId: (second as NonNullable<typeof second>).id,
      decision: 'approved',
      via: 'web',
      deferNotification: true,
    });
    const stillParked = await executeTask({ db, router, dispatcher }, task.id);
    expect(stillParked.outcome).toBe('parked');
    expect(order).toEqual([]); // neither ran — the first is still pending

    // Approve the FIRST too → both run, first before second.
    await resolveApproval(db, {
      approvalId: (first as NonNullable<typeof first>).id,
      decision: 'approved',
      via: 'web',
      deferNotification: true,
    });
    const done = await executeTask({ db, router, dispatcher }, task.id);
    expect(done.outcome).toBe('done');
    expect(order).toEqual(['exec.first', 'exec.second']);
  });
});
