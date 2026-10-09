import type { InboundEvent, ModelRouter, StepCallOutcome } from '@assistant/core';
import { enqueueTask, executeTask, getAgent, TruncatedObjectError } from '@assistant/core';
import {
  approvals,
  conversations,
  createDb,
  type Db,
  messages,
  tasks,
  toolCalls,
} from '@assistant/db';
import { finalChannelDelivery, finalChannelDeliveryReport } from '@assistant/persistence';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { approvalNoticeEmail } from './executor-deps.js';

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

describe('approval notice with earlier completed work', () => {
  it('names only the pending send when the same task already has a completed benign write', async () => {
    if (!dbUp)
      throw new Error(
        'PostgreSQL test database is required for this same-task approval regression',
      );
    const { task } = await enqueueTask(db, {
      type: 'adhoc',
      event: {
        source: 'internal',
        agentId,
        trust: 'owner',
        payload: { instruction: 'Create the lunch event, then send its details to Jordan.' },
      },
    });
    createdTaskIds.push(task.id);

    const [completedWrite] = await db
      .insert(toolCalls)
      .values({
        taskId: task.id,
        step: 0,
        toolName: 'calendar.create_event',
        args: { summary: 'Lunch' },
        risk: 'autonomous',
        status: 'succeeded',
        result: { eventId: 'synthetic-lunch-event', created: true },
      })
      .returning();
    const [pendingSend] = await db
      .insert(toolCalls)
      .values({
        taskId: task.id,
        step: 1,
        toolName: 'gmail.send',
        args: { to: 'jordan@example.test', subject: 'Lunch details' },
        risk: 'approval',
        status: 'awaiting_approval',
      })
      .returning();
    if (!completedWrite || !pendingSend) throw new Error('Expected both durable tool rows');
    const [pendingApproval] = await db
      .insert(approvals)
      .values({
        taskId: task.id,
        toolCallId: pendingSend.id,
        shortCode: 'A7',
        summary: 'Send lunch details to Jordan',
        payload: { to: 'jordan@example.test', subject: 'Lunch details' },
        status: 'pending',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      })
      .returning();
    if (!pendingApproval) throw new Error('Expected a pending send approval');

    const notice = approvalNoticeEmail([
      { shortCode: pendingApproval.shortCode, summary: pendingApproval.summary },
    ]);
    const sameTaskRows = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    expect(sameTaskRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: completedWrite.id,
          toolName: 'calendar.create_event',
          status: 'succeeded',
          result: { eventId: 'synthetic-lunch-event', created: true },
        }),
        expect.objectContaining({
          id: pendingSend.id,
          toolName: 'gmail.send',
          status: 'awaiting_approval',
        }),
      ]),
    );
    expect(notice).toContain('[A7] Send lunch details to Jordan');
    expect(notice).not.toContain('calendar.create_event');
    expect(notice).not.toMatch(/nothing has happened|none of the actions have happened/i);
  });
});

describe('planner unavailable outward-action boundary', () => {
  async function runUnavailablePlan(input: {
    decision?: { mode: 'park' | 'block'; reason: string };
    error?: Error;
  }) {
    if (!dbUp) {
      throw new Error('PostgreSQL test database is required for planner-unavailable regressions');
    }
    const { task } = await enqueueTask(db, {
      type: 'adhoc',
      event: {
        source: 'internal',
        agentId,
        trust: 'owner',
        payload: { instruction: 'Email my tax report to Alex.' },
      },
      maxSteps: 2,
    });
    createdTaskIds.push(task.id);

    const plannerRoles: string[] = [];
    const stepRoles: string[] = [];
    const dispatched: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const router = {
      async embeddingSpace() {
        return {
          provider: 'synthetic',
          model: 'planner-unavailable',
          dimensions: 1536,
          revision: '1',
        };
      },
      async embed(texts: string[]) {
        return texts.map(() => Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)));
      },
      async object(role: string) {
        plannerRoles.push(role);
        if (input.error) throw input.error;
        if (!input.decision) throw new Error('test requires a decision or planner error');
        return { ok: false as const, decision: input.decision };
      },
      async step(role: string): Promise<StepCallOutcome> {
        stepRoles.push(role);
        return {
          ok: true,
          modelId: 'synthetic/forbidden-follow-up',
          degraded: false,
          text: '',
          toolCalls: [
            {
              toolCallId: `planner-unavailable-guessed-send-${task.id}`,
              toolName: 'gmail.send',
              input: {
                to: 'alex@example.test',
                subject: 'Tax report',
                body: 'Attached is your report.',
              },
            },
          ],
          finishReason: 'tool-calls',
        };
      },
    } as unknown as ModelRouter;
    const dispatcher = {
      toolDefs: () => [{ name: 'gmail.send', description: 'Send an email', inputSchema: {} }],
      resultIsUntrusted: () => false,
      dispatch: async (dispatchInput: { toolName: string; args: Record<string, unknown> }) => {
        dispatched.push({ toolName: dispatchInput.toolName, args: dispatchInput.args });
        return { kind: 'rejected' as const, reason: 'synthetic test boundary' };
      },
      executeApproved: async () => ({ kind: 'failed' as const, error: 'No approval exists' }),
    };

    const outcome = await executeTask({ db, router, dispatcher: dispatcher as never }, task.id);
    const [stored] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, task.id));

    expect(plannerRoles).toContain('plan');
    expect(stepRoles).toHaveLength(0);
    expect(dispatched).toEqual([]);
    return { outcome, storedStatus: stored?.status };
  }

  it('parks on a daily budget block without entering the model step loop', async () => {
    const reason = 'daily budget exhausted ($5.00 of $5.00)';
    const { outcome, storedStatus } = await runUnavailablePlan({
      decision: { mode: 'block', reason },
    });
    expect(outcome).toMatchObject({ outcome: 'parked', detail: reason });
    expect(storedStatus).toBe('waiting_budget');
  });

  it('requests owner permission on a task budget park without entering the model step loop', async () => {
    const reason = 'task budget exhausted ($1.00 of $1.00)';
    const { outcome, storedStatus } = await runUnavailablePlan({
      decision: { mode: 'park', reason },
    });
    expect(outcome).toMatchObject({ outcome: 'needs_attention', detail: reason });
    expect(storedStatus).toBe('needs_attention');
  });

  it('does not enter the model step loop with a truncated structured plan', async () => {
    const { outcome, storedStatus } = await runUnavailablePlan({
      error: new TruncatedObjectError('plan'),
    });
    expect(outcome.outcome).toBe('needs_attention');
    expect(storedStatus).toBe('needs_attention');
  });
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
      async embed() {
        return [Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0))];
      },
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
      {
        db,
        router,
        dispatcher: new ToolDispatcher(db, registry()),
        // This E2E checks the routed calendar action. The channel boundary is
        // explicitly faked so no email provider is contacted by the test.
        deliverFinal: async (_task, _text, attemptId) =>
          finalChannelDeliveryReport([finalChannelDelivery('email', 'accepted', attemptId)]),
      },
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

  // A forwarded message is source material, not an owner request. It cannot
  // populate the owner's approval queue from the sender's embedded instructions.
  it('does not promote a forwarded owner email into an owner-authorized action', async (ctx) => {
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
      async embed() {
        return [Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0))];
      },
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
        // A conforming planner treats forwarded material as data.
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
          text: 'I can help if you tell me directly what you want done.',
          toolCalls: [],
          finishReason: 'stop',
        };
      },
    } as unknown as ModelRouter;

    const outcome = await executeTask(
      {
        db,
        router,
        dispatcher: new ToolDispatcher(db, registry({ outwardFacing: true })),
        deliverFinal: async (_task, _text, attemptId) =>
          finalChannelDeliveryReport([finalChannelDelivery('email', 'accepted', attemptId)]),
      },
      task.id,
    );

    expect(step0ToolChoice[0]).not.toBe('required');
    expect(outcome.outcome).toBe('done');
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    const cal = calls.find((c) => c.toolName === 'calendar.create_event');
    expect(cal).toBeUndefined();
    const appr = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(appr).toHaveLength(0);
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
