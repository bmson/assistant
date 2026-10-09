import {
  approvals,
  conversations,
  createDb,
  createPostgresApprovalRepository,
  createPostgresExecutionJobRepository,
  createPostgresMessageRepository,
  createPostgresTaskRepository,
  type Db,
  messages,
  tasks,
  toolCalls,
} from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAgent } from '../../chat.js';
import { taskState } from '../machine.js';
import type { RunContext } from './phases.js';
import { resumePendingApprovals } from './phases.js';

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL;
  assertAllocatedTestTarget({
    databaseUrl: url,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    kind: 'standard',
  });
  if (!url) throw new Error('Missing allocated test database URL');
  return url;
})();

describe('approval notice recovery after a mixed batch budget park (integration)', () => {
  let db: Db;
  let dbUp = false;
  let agentId = '';
  const taskIds: string[] = [];
  const conversationIds: string[] = [];

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
    } catch {
      console.warn('approval-budget-resume.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    try {
      if (dbUp) {
        if (conversationIds.length) {
          await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
        }
        if (taskIds.length) {
          await db.delete(approvals).where(inArray(approvals.taskId, taskIds));
          await db.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
          await db.delete(tasks).where(inArray(tasks.id, taskIds));
        }
        if (conversationIds.length) {
          await db.delete(conversations).where(inArray(conversations.id, conversationIds));
        }
      }
    } finally {
      await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
    }
  });

  it('hydrates the pending approval card and notifies once after budget wake', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'budget-approval-resume-test' })
      .returning({ id: conversations.id });
    const conversationId = (conversation as NonNullable<typeof conversation>).id;
    conversationIds.push(conversationId);

    const [task] = await db
      .insert(tasks)
      .values({
        agentId,
        conversationId,
        type: 'chat_turn',
        status: 'waiting_budget',
        trust: 'owner',
        trigger: { source: 'web', payload: {} },
      })
      .returning({ id: tasks.id });
    const taskId = (task as NonNullable<typeof task>).id;
    taskIds.push(taskId);

    const [toolCall] = await db
      .insert(toolCalls)
      .values({
        taskId,
        step: 0,
        toolName: 'gmail.send',
        args: { to: 'recipient@example.com' },
        risk: 'approval',
        status: 'awaiting_approval',
      })
      .returning({ id: toolCalls.id });
    const dbToolCallId = (toolCall as NonNullable<typeof toolCall>).id;
    const [approval] = await db
      .insert(approvals)
      .values({
        taskId,
        toolCallId: dbToolCallId,
        shortCode: `B${Math.floor(Math.random() * 1e6)}`,
        summary: 'Send the reply to recipient@example.com',
        payload: { to: 'recipient@example.com' },
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: approvals.id, shortCode: approvals.shortCode });
    const approvalId = (approval as NonNullable<typeof approval>).id;
    const shortCode = (approval as NonNullable<typeof approval>).shortCode;

    const state = {
      pendingApprovals: [
        {
          approvalId,
          toolCallId: 'model-call-1',
          dbToolCallId,
          toolName: 'gmail.send',
        },
      ],
      pendingJob: null,
      pendingToolBatch: null,
      completedToolCallIds: [],
      contextWindow: [],
    };
    let taskRepository = createPostgresTaskRepository(db);
    const initialLease = await taskRepository.claim(taskId);
    if (!initialLease) throw new Error('Missing initial test lease');
    expect(
      await taskRepository.parkForBudget(
        initialLease,
        JSON.parse(JSON.stringify(state)),
        new Date(Date.now() - 1000),
      ),
    ).toBe(true);

    // Simulate fresh-client recovery after the durable budget checkpoint: close the
    // database client, then reconstruct the pool and lease repository before recovery.
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
    db = createDb(DATABASE_URL);
    taskRepository = createPostgresTaskRepository(db);

    const taskLease = await taskRepository.claim(taskId);
    if (!taskLease) throw new Error('Missing resumed test lease');
    const notifyApproval = vi.fn(async () => {});
    const context = {
      deps: {
        notifyApproval,
        persistence: {
          tasks: taskRepository,
          executionJobs: createPostgresExecutionJobRepository(db),
          approvals: createPostgresApprovalRepository(db),
          messages: createPostgresMessageRepository(db),
        },
      },
      db,
      task: taskLease,
      state: taskState(taskLease),
      window: [],
      dispatcher: {},
      ctx: {},
    } as unknown as RunContext;

    expect(await resumePendingApprovals(context)).toEqual({
      outcome: 'parked',
      detail: 'still waiting on approvals',
    });
    expect(notifyApproval).toHaveBeenCalledOnce();
    expect(notifyApproval).toHaveBeenCalledWith(taskLease, [
      expect.objectContaining({
        taskId,
        shortCode,
        toolName: 'gmail.send',
      }),
    ]);
    const firstMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(firstMessages).toHaveLength(1);
    expect(firstMessages[0]?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'approval', approvalId })]),
    );
    const parked = await taskRepository.getTask(taskId);
    expect(parked?.status).toBe('waiting_approval');
    expect(parked?.lockedUntil).toBeNull();
    expect(parked && taskState(parked).pendingApprovals).toEqual(state.pendingApprovals);

    // A later wake sees durable delivery stamps and does not duplicate either leg.
    await taskRepository.wakeTask(taskId);
    const secondLease = await taskRepository.claim(taskId);
    if (!secondLease) throw new Error('Missing second resumed lease');
    context.task = secondLease;
    context.state = taskState(secondLease);
    expect(await resumePendingApprovals(context)).toEqual({
      outcome: 'parked',
      detail: 'still waiting on approvals',
    });
    expect(notifyApproval).toHaveBeenCalledOnce();
    const finalMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(finalMessages).toHaveLength(1);
    const [storedApproval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(storedApproval?.notifiedChannels).toEqual(
      expect.arrayContaining(['owner', 'conversation']),
    );
  });
});
