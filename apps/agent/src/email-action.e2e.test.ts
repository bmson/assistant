import type { InboundEvent, ModelRouter, StepCallOutcome } from '@assistant/core';
import { enqueueTask, executeTask, getAgent } from '@assistant/core';
import {
  approvals,
  conversations,
  createDb,
  type Db,
  messages,
  tasks,
  toolCalls,
} from '@assistant/db';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId = '';
const createdTaskIds: string[] = [];
const createdConversationIds: string[] = [];

// The planner routes an actionable email to 'workflow'; roleForTask then picks
// 'reason' and the step loop forces a tool call on step 0.
const workflowPlan = {
  action: 'workflow',
  reasoning: 'the owner asked for a concrete action',
  steps: ['create the calendar event'],
  missingInfo: [],
};

function registry(flags: { outwardFacing?: boolean } = {}) {
  return new ToolRegistry().register(
    {
      name: 'calendar.create_event',
      description: 'Create a test calendar event.',
      inputSchema: z.object({ title: z.string() }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      // A frozen receipt under the real write name keeps routing and contract checks aligned.
      execute: async (args) => ({
        id: 'synthetic-lunch-event',
        created: true,
        title: (args as { title: string }).title,
      }),
    },
    flags,
  );
}

function emailEvent(conversationId: string): InboundEvent {
  return {
    source: 'email',
    externalEventId: `gmail:action-${Date.now()}`,
    agentId,
    conversationId,
    trust: 'owner',
    payload: {
      threadId: 'thread-x',
      messageId: 'msg-x',
      from: 'owner@example.com',
      subject: 'add lunch friday',
      // Owner-authored (not a forward) — untainted so it can act autonomously.
      quotesExternalContent: false,
    },
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('email-action.e2e: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdConversationIds.length) {
    // messages reference tasks (task_id FK), so clear them before the tasks.
    await db.delete(messages).where(inArray(messages.conversationId, createdConversationIds));
  }
  if (dbUp && createdTaskIds.length) {
    // approvals <-> tool_calls have a circular FK (tool_calls.approval_id and
    // approvals.tool_call_id), so break the cycle before deleting either.
    await db
      .update(toolCalls)
      .set({ approvalId: null })
      .where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(approvals).where(inArray(approvals.taskId, createdTaskIds));
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  if (dbUp && createdConversationIds.length) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('email action routing (integration, scripted model)', () => {
  it('runs an actionable email on the reason model with a forced step-0 tool call', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'email', trust: 'owner', title: 'add lunch friday' })
      .returning({ id: conversations.id });
    const conversationId = (conversation as NonNullable<typeof conversation>).id;
    createdConversationIds.push(conversationId);

    const { task } = await enqueueTask(db, {
      type: 'email_triage',
      event: emailEvent(conversationId),
      maxSteps: 8,
    });
    createdTaskIds.push(task.id);

    const rolesSeen: string[] = [];
    const step0ToolChoice: Array<string | undefined> = [];
    let step = 0;
    const router = {
      async object() {
        return { ok: true, modelId: 'fake/model', degraded: false, object: workflowPlan };
      },
      async step(
        role: string,
        opts: { toolChoice?: { type?: string; toolName?: string } | string },
      ): Promise<StepCallOutcome> {
        rolesSeen.push(role);
        const current = step;
        step += 1;
        if (current === 0) {
          step0ToolChoice.push(typeof opts.toolChoice === 'string' ? opts.toolChoice : undefined);
          return {
            ok: true,
            modelId: 'fake/model',
            degraded: false,
            text: '',
            toolCalls: [
              { toolCallId: 'cal-1', toolName: 'calendar.create_event', input: { title: 'Lunch' } },
            ],
          };
        }
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: 'Added lunch to your calendar for Friday.',
          toolCalls: [],
          finishReason: 'stop',
        };
      },
    } as unknown as ModelRouter;

    const outcome = await executeTask(
      { db, router, dispatcher: new ToolDispatcher(db, registry()) },
      task.id,
    );

    expect(outcome.outcome).toBe('done');
    // E1: email action drives the reasoning model, not draft.
    expect(rolesSeen.every((r) => r === 'reason')).toBe(true);
    // D2: the first step was forced to produce a tool call.
    expect(step0ToolChoice[0]).toBe('required');
    // The tool actually ran (no prose-with-zero-tools).
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    expect(
      calls.some((c) => c.toolName === 'calendar.create_event' && c.status === 'succeeded'),
    ).toBe(true);
  });

  // Regression: a forwarded (tainted) owner email whose planner returned 'reply'
  // used to make ZERO tool calls — the model summarized the forward instead of
  // acting on the instruction inside it. Fix 1 coerces that plan to 'workflow' so
  // the step is forced to act; the taint defense then parks the outward action
  // for approval rather than executing it or silently doing nothing.
  it('forces an approval-gated action on a forwarded owner email the planner tried to only reply to', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'email', trust: 'owner', title: 'Fwd: lunch friday' })
      .returning({ id: conversations.id });
    const conversationId = (conversation as NonNullable<typeof conversation>).id;
    createdConversationIds.push(conversationId);

    const event: InboundEvent = {
      source: 'email',
      externalEventId: `gmail:fwd-action-${Date.now()}`,
      agentId,
      conversationId,
      trust: 'owner',
      payload: {
        threadId: 'thread-fwd',
        messageId: 'msg-fwd',
        from: 'owner@example.com',
        subject: 'Fwd: lunch friday',
        // A forward → tainted; the planner may summarize instead of acting.
        quotesExternalContent: true,
      },
    };
    const { task } = await enqueueTask(db, { type: 'email_triage', event, maxSteps: 8 });
    createdTaskIds.push(task.id);

    const step0ToolChoice: Array<string | undefined> = [];
    let step = 0;
    // The mis-route: the planner summarizes the forward as a 'reply'.
    const replyPlan = {
      action: 'reply',
      reasoning: 'summarize the forwarded email',
      steps: [],
      missingInfo: [],
    };
    const router = {
      async object() {
        return { ok: true, modelId: 'fake/model', degraded: false, object: replyPlan };
      },
      async step(
        _role: string,
        opts: { toolChoice?: { type?: string; toolName?: string } | string },
      ): Promise<StepCallOutcome> {
        const current = step;
        step += 1;
        const choice = typeof opts.toolChoice === 'string' ? opts.toolChoice : undefined;
        if (current === 0) step0ToolChoice.push(choice);
        // Behave like a real model: emit the action only when forced. Without the
        // fix the plan is 'reply' → toolChoice undefined → prose → zero tools.
        if (choice === 'required') {
          return {
            ok: true,
            modelId: 'fake/model',
            degraded: false,
            text: '',
            toolCalls: [
              { toolCallId: 'cal-1', toolName: 'calendar.create_event', input: { title: 'Lunch' } },
            ],
          };
        }
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: 'Added lunch to your calendar for Friday.',
          toolCalls: [],
          finishReason: 'stop',
        };
      },
    } as unknown as ModelRouter;

    const outcome = await executeTask(
      { db, router, dispatcher: new ToolDispatcher(db, registry({ outwardFacing: true })) },
      task.id,
    );

    // Fix 1: the 'reply' plan on a tainted owner email is coerced to 'workflow',
    // so step 0 is forced to act instead of silently summarizing.
    expect(step0ToolChoice[0]).toBe('required');
    // The taint defense holds: an outward action from a forward parks for
    // approval — never a silent no-op, never an autonomous send.
    expect(outcome.outcome).toBe('parked');
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    const cal = calls.find((c) => c.toolName === 'calendar.create_event');
    expect(cal).toBeTruthy();
    expect(cal?.status).toBe('awaiting_approval'); // parked, not autonomously executed
    const appr = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(appr.length).toBeGreaterThan(0);
  });

  // A2: when a forced-action step produces only prose even after its retry (a
  // provider ignoring toolChoice 'required'), the task must NOT be staged as
  // done — it parks needs_attention with an honest, retryable message instead of
  // fabricating success.
  it('parks needs_attention when a forced action yields only prose after the retry', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'email', trust: 'owner', title: 'stubborn action' })
      .returning({ id: conversations.id });
    const conversationId = (conversation as NonNullable<typeof conversation>).id;
    createdConversationIds.push(conversationId);

    const { task } = await enqueueTask(db, {
      type: 'email_triage',
      event: emailEvent(conversationId),
      maxSteps: 8,
    });
    createdTaskIds.push(task.id);

    let stepCalls = 0;
    const router = {
      async object() {
        return { ok: true, modelId: 'fake/model', degraded: false, object: workflowPlan };
      },
      async step(): Promise<StepCallOutcome> {
        // Ignore toolChoice 'required' on every call — never emit a tool.
        stepCalls += 1;
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: "Here's what I would do to add the event…",
          toolCalls: [],
          finishReason: 'stop',
        };
      },
    } as unknown as ModelRouter;

    const outcome = await executeTask(
      { db, router, dispatcher: new ToolDispatcher(db, registry()) },
      task.id,
    );

    expect(outcome.outcome).toBe('needs_attention');
    // The forced step retried once before giving up.
    expect(stepCalls).toBeGreaterThanOrEqual(2);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('needs_attention');
    // Nothing ran, and the honest message — not a fabricated "done" — landed.
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    expect(calls).toHaveLength(0);
    const msgs = await db.select().from(messages).where(eq(messages.taskId, task.id));
    expect(msgs.some((m) => /stopped rather than pretend/i.test(m.text ?? ''))).toBe(true);
  });
});
