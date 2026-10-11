import { randomUUID } from 'node:crypto';
import { buildRequestChecklist } from '@assistant/core';
import { getAgent } from '@assistant/core/chat';
import {
  agents,
  approvals,
  conversations,
  createDb,
  createPostgresApplicationChatPersistence,
  goals,
  messages,
  tasks,
  toolCallReceipts,
  toolCalls,
} from '@assistant/db';
import { newTaskRecord } from '@assistant/persistence';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { revisePendingChecklistActivity } from './commands.js';

describe('atomic Activity checklist correction', () => {
  const db = createDb(
    process.env.TEST_DATABASE_URL ?? 'postgres://assistant@127.0.0.1:1/unallocated',
  );
  const taskIds: string[] = [];
  const conversationIds: string[] = [];
  const foreignAgentIds: string[] = [];
  const goalIds: string[] = [];

  async function seed(
    input: {
      queueGeneration?: number;
      state?: Record<string, unknown>;
      plan?: unknown;
      type?: 'chat_turn' | 'adhoc' | 'scheduled' | 'email_triage';
      trust?: 'owner' | 'known' | 'unknown';
      goalTask?: boolean;
      omitOriginalMessage?: boolean;
      trigger?: (
        messageId: string,
        agentId: string,
        conversationId: string,
        request: string,
      ) => unknown;
    } = {},
  ) {
    const owner = await getAgent(db);
    const conversation = await createPostgresApplicationChatPersistence(db).createConversation(
      owner.id,
    );
    const taskId = randomUUID();
    const checklist = buildRequestChecklist('Find my hotel and remind me about the hotel');
    if (!checklist) throw new Error('test checklist is invalid');
    const originalMessageId = randomUUID();
    const goalId = input.goalTask ? randomUUID() : null;
    if (goalId) {
      await db
        .insert(goals)
        .values({ id: goalId, agentId: owner.id, title: 'Correction test goal' });
      goalIds.push(goalId);
    }
    const type = input.type ?? 'chat_turn';
    const trust = input.trust ?? 'owner';
    const trigger = input.trigger
      ? input.trigger(originalMessageId, owner.id, conversation.id, checklist.request)
      : {
          source: 'chat',
          agentId: owner.id,
          conversationId: conversation.id,
          trust: 'owner',
          payload: { text: checklist.request, triggerMessageId: originalMessageId },
        };
    const now = new Date();
    await db.insert(tasks).values({
      ...newTaskRecord(
        {
          agentId: owner.id,
          conversationId: conversation.id,
          type,
          trust,
          trigger,
          ...(goalId ? { goalId } : {}),
        },
        taskId,
        now,
      ),
      status: 'needs_attention',
      queueGeneration: input.queueGeneration ?? 4,
      state: input.state ?? { requestChecklist: checklist },
      plan: input.plan ?? null,
    });
    if (!input.omitOriginalMessage)
      await db.insert(messages).values({
        id: originalMessageId,
        conversationId: conversation.id,
        taskId,
        role: 'user',
        origin: 'owner',
        parts: [{ type: 'text', text: checklist.request }],
        text: checklist.request,
      });
    taskIds.push(taskId);
    conversationIds.push(conversation.id);
    return {
      ownerId: owner.id,
      taskId,
      conversationId: conversation.id,
      checklist,
      originalMessageId,
    };
  }

  afterEach(async () => {
    if (taskIds.length)
      await db.delete(toolCallReceipts).where(inArray(toolCallReceipts.taskId, taskIds));
    if (taskIds.length) await db.delete(approvals).where(inArray(approvals.taskId, taskIds));
    if (taskIds.length) await db.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
    if (conversationIds.length)
      await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
    if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds.splice(0)));
    for (const conversationId of conversationIds.splice(0))
      await db.delete(conversations).where(eq(conversations.id, conversationId));
    for (const foreignAgentId of foreignAgentIds.splice(0))
      await db.delete(agents).where(eq(agents.id, foreignAgentId));
    for (const goalId of goalIds.splice(0)) await db.delete(goals).where(eq(goals.id, goalId));
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('serializes duplicate submissions, records one owner message, and rejects stale replay', async () => {
    const priorPlan = { steps: [{ description: 'Search for the hotel' }] };
    const originalState = {
      requestChecklist: buildRequestChecklist('Find my hotel and remind me about the hotel'),
      plannerState: { ownerIntent: 'hotel' },
      clarificationContinuation: { sourceTaskId: 'prior', answerStatus: 'uncertain' },
      pendingFinal: { text: 'stale final' },
      completedToolCallIds: ['done-call'],
      triggerMessageId: 'original-trigger',
    };
    const { ownerId, taskId, conversationId, checklist, originalMessageId } = await seed({
      plan: priorPlan,
    });
    await db
      .update(tasks)
      .set({ state: { ...originalState, triggerMessageId: originalMessageId } })
      .where(eq(tasks.id, taskId));
    const chat = createPostgresApplicationChatPersistence(db);
    const priorMessage = await chat.appendOwned(ownerId, {
      conversationId,
      role: 'user',
      origin: 'owner',
      parts: [{ type: 'text', text: 'Original owner request' }],
      text: 'Original owner request',
    });
    if (!priorMessage) throw new Error('test cursor message was not persisted');
    const ownerMessageId = randomUUID();
    const input = {
      taskId,
      itemId: checklist.items[0]?.id ?? '',
      expectedRevision: 0,
      ownerMessageId,
      replacementKind: 'lookup' as const,
      replacementLabel: 'Find my flight to Berlin',
    };
    const results = await Promise.all([
      revisePendingChecklistActivity(db, ownerId, input),
      revisePendingChecklistActivity(db, ownerId, input),
    ]);
    expect(results.map((row) => row.outcome).sort()).toEqual(['already_applied', 'corrected']);
    expect(results.filter((row) => row.transitioned)).toHaveLength(1);
    await expect(
      revisePendingChecklistActivity(db, ownerId, {
        ...input,
        replacementKind: 'reminder',
      }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
    await expect(
      revisePendingChecklistActivity(db, ownerId, { ...input, expectedRevision: 1 }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(task).toMatchObject({ status: 'pending', queueGeneration: 5, plan: null });
    expect(task?.state).toMatchObject({
      plannerState: originalState.plannerState,
      clarificationContinuation: originalState.clarificationContinuation,
      completedToolCallIds: originalState.completedToolCallIds,
      triggerMessageId: originalMessageId,
      requestChecklist: {
        request: 'Find my hotel and remind me about the hotel',
        revision: 1,
      },
    });
    expect(task?.state).not.toHaveProperty('pendingFinal');
    const persistedChecklist = (
      task?.state as { requestChecklist?: { items?: Array<{ label: string }> } } | undefined
    )?.requestChecklist;
    expect(persistedChecklist?.items?.map((item) => item.label)).toContain(
      'Find my flight to Berlin',
    );
    expect(
      await db.query.messages.findMany({
        where: and(eq(messages.taskId, taskId), eq(messages.id, ownerMessageId)),
      }),
    ).toMatchObject([
      {
        id: ownerMessageId,
        taskId,
        conversationId,
        role: 'user',
        origin: 'owner',
        text: 'Find my flight to Berlin',
      },
    ]);
    const afterCursor = await chat.listMessages(ownerId, conversationId, {
      after: {
        appendSequence: priorMessage.appendSequence,
        createdAt: priorMessage.createdAt,
        id: priorMessage.id,
      },
      limit: 2,
    });
    expect(afterCursor?.messages.map((message) => message.id)).toContain(ownerMessageId);
    await expect(
      revisePendingChecklistActivity(db, ownerId, { ...input, ownerMessageId: randomUUID() }),
    ).resolves.toMatchObject({ outcome: 'no_longer_retriable', transitioned: false });
    expect(await db.query.messages.findMany({ where: eq(messages.taskId, taskId) })).toHaveLength(
      2,
    );
  });

  it.each([
    ['pending batch', { pendingToolBatch: { calls: [{ toolCallId: 'queued-not-ledgered' }] } }],
    ['pending job', { pendingJob: { dbToolCallId: 'queued-not-ledgered' } }],
  ])('refuses a %s journal and leaves task/message/wake untouched', async (_name, journal) => {
    const priorPlan = { steps: [{ description: 'Search for the hotel' }] };
    const checklist = buildRequestChecklist('Find my hotel and remind me about the hotel');
    if (!checklist) throw new Error('test checklist is invalid');
    const { ownerId, taskId } = await seed({
      state: { requestChecklist: checklist, ...journal },
      plan: priorPlan,
    });
    await expect(
      revisePendingChecklistActivity(db, ownerId, {
        taskId,
        itemId: checklist.items[0]?.id ?? '',
        expectedRevision: 0,
        ownerMessageId: randomUUID(),
        replacementKind: 'lookup',
        replacementLabel: 'Find my flight to Berlin',
      }),
    ).resolves.toMatchObject({ outcome: 'unsafe_evidence', transitioned: false });
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(task).toMatchObject({ status: 'needs_attention', queueGeneration: 4, plan: priorPlan });
    expect((task?.state as Record<string, unknown>)?.requestChecklist).toEqual(checklist);
    expect(await db.query.messages.findMany({ where: eq(messages.taskId, taskId) })).toHaveLength(
      1,
    );
  });

  it.each([
    ['non-owner trust', { trust: 'known' as const }],
    ['ad hoc work', { type: 'adhoc' as const }],
    ['scheduled work', { type: 'scheduled' as const }],
    ['goal work', { goalTask: true }],
    [
      'forwarded email work',
      {
        type: 'email_triage' as const,
        trust: 'unknown' as const,
        trigger: (messageId: string, agentId: string, conversationId: string, request: string) => ({
          source: 'email',
          agentId,
          conversationId,
          trust: 'unknown',
          payload: { text: request, triggerMessageId: messageId },
        }),
      },
    ],
    [
      'malformed pinned trigger',
      {
        trigger: (
          _messageId: string,
          agentId: string,
          conversationId: string,
          request: string,
        ) => ({
          source: 'chat',
          agentId,
          conversationId,
          trust: 'owner',
          payload: { text: request, triggerMessageId: 'not-a-message-id' },
        }),
      },
    ],
    [
      'trigger text that differs from the checklist request',
      {
        trigger: (messageId: string, agentId: string, conversationId: string, request: string) => ({
          source: 'chat',
          agentId,
          conversationId,
          trust: 'owner',
          payload: { text: `${request} unrelated`, triggerMessageId: messageId },
        }),
      },
    ],
    ['missing durable original message', { omitOriginalMessage: true }],
  ])(
    'refuses correction for %s without writing message or changing task',
    async (_name, options) => {
      const priorPlan = { steps: [{ description: 'Keep old plan until a valid correction' }] };
      const { ownerId, taskId, checklist } = await seed({ ...options, plan: priorPlan });
      const correctionMessageId = randomUUID();
      await expect(
        revisePendingChecklistActivity(db, ownerId, {
          taskId,
          itemId: checklist.items[0]?.id ?? '',
          expectedRevision: 0,
          ownerMessageId: correctionMessageId,
          replacementKind: 'lookup',
          replacementLabel: 'Find my flight to Berlin',
        }),
      ).resolves.toMatchObject({ outcome: 'unsafe_evidence', transitioned: false });
      const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
      expect(task).toMatchObject({
        status: 'needs_attention',
        queueGeneration: 4,
        plan: priorPlan,
      });
      expect((task?.state as Record<string, unknown>)?.requestChecklist).toEqual(checklist);
      expect(
        await db.query.messages.findMany({ where: eq(messages.id, correctionMessageId) }),
      ).toHaveLength(0);
      expect(await db.query.messages.findMany({ where: eq(messages.taskId, taskId) })).toHaveLength(
        'omitOriginalMessage' in options && options.omitOriginalMessage ? 0 : 1,
      );
    },
  );

  it('fails closed on foreign identity, stale revision, active lease, and revision overflow without writes', async () => {
    const { ownerId, taskId, checklist } = await seed();
    const base = {
      taskId,
      itemId: checklist.items[0]?.id ?? '',
      expectedRevision: 0,
      ownerMessageId: randomUUID(),
      replacementKind: 'lookup' as const,
      replacementLabel: 'Find my flight to Berlin',
    };
    await expect(revisePendingChecklistActivity(db, randomUUID(), base)).resolves.toMatchObject({
      outcome: 'not_found',
    });
    await expect(
      revisePendingChecklistActivity(db, ownerId, { ...base, expectedRevision: 1 }),
    ).resolves.toMatchObject({ outcome: 'stale_revision' });
    await db
      .update(tasks)
      .set({ leaseToken: randomUUID(), lockedUntil: new Date(Date.now() + 60_000) })
      .where(eq(tasks.id, taskId));
    await expect(revisePendingChecklistActivity(db, ownerId, base)).resolves.toMatchObject({
      outcome: 'no_longer_retriable',
    });
    expect(await db.query.messages.findMany({ where: eq(messages.taskId, taskId) })).toHaveLength(
      1,
    );
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.queueGeneration).toBe(
      4,
    );
  });

  it('rolls message insertion back if the durable queue generation cannot advance', async () => {
    const { ownerId, taskId, checklist } = await seed({ queueGeneration: 2_147_483_647 });
    const ownerMessageId = randomUUID();
    await expect(
      revisePendingChecklistActivity(db, ownerId, {
        taskId,
        itemId: checklist.items[0]?.id ?? '',
        expectedRevision: 0,
        ownerMessageId,
        replacementKind: 'lookup',
        replacementLabel: 'Find my flight to Berlin',
      }),
    ).rejects.toThrow();
    expect(
      await db.query.messages.findMany({ where: eq(messages.id, ownerMessageId) }),
    ).toHaveLength(0);
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.status).toBe(
      'needs_attention',
    );
  });

  it('rejects unknown retained effects and over-bound receipt history without mutating the task', async () => {
    const { ownerId, taskId, checklist } = await seed();
    const receiptId = randomUUID();
    await db.insert(toolCallReceipts).values({
      id: receiptId,
      agentId: ownerId,
      taskId,
      toolCallId: receiptId,
      modelToolCallIdHash: null,
      idempotencyKeyHash: null,
      toolName: 'calendar.list_events',
      effectOutcome: 'unknown',
      recordedAt: new Date(),
    });
    const input = {
      taskId,
      itemId: checklist.items[0]?.id ?? '',
      expectedRevision: 0,
      ownerMessageId: randomUUID(),
      replacementKind: 'lookup' as const,
      replacementLabel: 'Find my flight to Berlin',
    };
    await expect(revisePendingChecklistActivity(db, ownerId, input)).resolves.toMatchObject({
      outcome: 'unsafe_evidence',
    });
    expect(await db.query.messages.findMany({ where: eq(messages.taskId, taskId) })).toHaveLength(
      1,
    );
    await db.delete(toolCallReceipts).where(eq(toolCallReceipts.taskId, taskId));
    await db.insert(toolCallReceipts).values(
      Array.from({ length: 129 }, (_, index) => {
        const id = randomUUID();
        return {
          id,
          agentId: ownerId,
          taskId,
          toolCallId: id,
          modelToolCallIdHash: null,
          idempotencyKeyHash: null,
          toolName: 'calendar.list_events',
          effectOutcome: 'not_executed' as const,
          recordedAt: new Date(Date.now() + index),
        };
      }),
    );
    await expect(
      revisePendingChecklistActivity(db, ownerId, { ...input, ownerMessageId: randomUUID() }),
    ).resolves.toMatchObject({ outcome: 'unsafe_evidence' });
    expect(await db.query.messages.findMany({ where: eq(messages.taskId, taskId) })).toHaveLength(
      1,
    );
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.queueGeneration).toBe(
      4,
    );
  });

  it('rejects a foreign-owner receipt sharing the selected task ID', async () => {
    const { ownerId, taskId, checklist } = await seed();
    const foreignAgentId = randomUUID();
    foreignAgentIds.push(foreignAgentId);
    await db.insert(agents).values({
      id: foreignAgentId,
      name: 'Synthetic foreign owner',
      email: `${foreignAgentId}@example.test`,
      workspacePrefix: `test/${foreignAgentId}`,
    });
    const receiptId = randomUUID();
    await db.insert(toolCallReceipts).values({
      id: receiptId,
      agentId: foreignAgentId,
      taskId,
      toolCallId: receiptId,
      modelToolCallIdHash: null,
      idempotencyKeyHash: null,
      toolName: 'calendar.list_events',
      effectOutcome: 'completed',
      recordedAt: new Date(),
    });

    await expect(
      revisePendingChecklistActivity(db, ownerId, {
        taskId,
        itemId: checklist.items[0]?.id ?? '',
        expectedRevision: 0,
        ownerMessageId: randomUUID(),
        replacementKind: 'lookup',
        replacementLabel: 'Find my flight to Berlin',
      }),
    ).resolves.toMatchObject({ outcome: 'unsafe_evidence' });
    expect(await db.query.messages.findMany({ where: eq(messages.taskId, taskId) })).toHaveLength(
      1,
    );
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.queueGeneration).toBe(
      4,
    );
  });

  it('does not revise a matching failed call when no durable not-executed receipt exists', async () => {
    const { ownerId, taskId, checklist } = await seed();
    const callId = randomUUID();
    await db.insert(toolCalls).values({
      id: callId,
      taskId,
      step: 1,
      toolName: 'calendar.list_events',
      args: { query: 'hotel' },
      risk: 'autonomous',
      status: 'failed',
      error: 'temporary failure after dispatch',
      decision: {},
    });

    await expect(
      revisePendingChecklistActivity(db, ownerId, {
        taskId,
        itemId: checklist.items[0]?.id ?? '',
        expectedRevision: 0,
        ownerMessageId: randomUUID(),
        replacementKind: 'lookup',
        replacementLabel: 'Find my flight to Berlin',
      }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
    expect(await db.query.messages.findMany({ where: eq(messages.taskId, taskId) })).toHaveLength(
      1,
    );
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.queueGeneration).toBe(
      4,
    );
  });

  it('blocks an approved persisted approval even after its unrelated call row is terminal', async () => {
    const { ownerId, taskId, checklist } = await seed();
    const callId = randomUUID();
    await db.insert(toolCalls).values({
      id: callId,
      taskId,
      step: 1,
      toolName: 'gmail.create_draft',
      args: {},
      risk: 'approval',
      status: 'succeeded',
      result: { draftId: 'draft-1' },
      decision: {},
    });
    await db.insert(approvals).values({
      taskId,
      toolCallId: callId,
      shortCode: `C${randomUUID().slice(0, 7)}`,
      summary: 'Synthetic approval retained after its task parked',
      status: 'approved',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      revisePendingChecklistActivity(db, ownerId, {
        taskId,
        itemId: checklist.items[0]?.id ?? '',
        expectedRevision: 0,
        ownerMessageId: randomUUID(),
        replacementKind: 'lookup',
        replacementLabel: 'Find my flight to Berlin',
      }),
    ).resolves.toMatchObject({ outcome: 'unsafe_evidence' });
    expect(await db.query.messages.findMany({ where: eq(messages.taskId, taskId) })).toHaveLength(
      1,
    );
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.queueGeneration).toBe(
      4,
    );
  });
});
