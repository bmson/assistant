import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import {
  agents,
  conversations,
  createDb,
  createPostgresApplicationChatPersistence,
  type Db,
  tasks,
} from '@assistant/db';
import {
  chatAdmissionCancellationTrigger,
  chatAdmissionExternalEventId,
  newTaskRecord,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { listApprovalInbox } from './approvals.js';
import { getCostsDashboard } from './costs.js';
import { listGoalsDashboard } from './goals.js';
import { getProfileOverview, listMemoryLibrary } from './profile.js';
import { getActivityStatus, getTaskDetail, listActivity } from './tasks.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('application projections', () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    await listActivity(db, { archived: false, filter: 'all', limit: 1 });
  });

  it('hides pre-admission cancellation rows before the Activity limit and from detail', async () => {
    const agent = await getAgent(db);
    const conversation = await createPostgresApplicationChatPersistence(db).createConversation(
      agent.id,
    );
    const conversationId = conversation.id;
    const clientOperationId = randomUUID();
    const now = new Date('2099-01-01T00:00:00.000Z');
    const markerId = randomUUID();
    const ordinaryId = randomUUID();
    const marker = {
      ...newTaskRecord(
        {
          agentId: agent.id,
          conversationId,
          type: 'chat_turn',
          trust: 'owner',
          trigger: chatAdmissionCancellationTrigger({
            agentId: agent.id,
            conversationId,
            clientOperationId,
          }),
          externalEventId: chatAdmissionExternalEventId({
            agentId: agent.id,
            conversationId,
            clientOperationId,
          }),
        },
        markerId,
        now,
      ),
      status: 'cancelled',
    };
    const ordinary = newTaskRecord(
      {
        agentId: agent.id,
        conversationId,
        type: 'chat_turn',
        trust: 'owner',
        trigger: { source: 'chat', payload: {} },
        externalEventId: randomUUID(),
      },
      ordinaryId,
      new Date(now.getTime() - 1),
    );
    try {
      await db.insert(tasks).values([marker, ordinary]);
      const activity = await listActivity(db, { archived: false, filter: 'all', limit: 1 });
      expect(activity.items.map((item) => item.id)).toEqual([ordinaryId]);
      await expect(getTaskDetail(db, markerId)).resolves.toBeNull();
    } finally {
      await db.delete(tasks).where(eq(tasks.id, markerId));
      await db.delete(tasks).where(eq(tasks.id, ordinaryId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
    }
  });

  it('returns compact live status and excludes hidden owner rows', async () => {
    const agent = await getAgent(db);
    const conversation = await createPostgresApplicationChatPersistence(db).createConversation(
      agent.id,
    );
    const conversationId = conversation.id;
    const now = new Date('2099-01-01T00:00:00.000Z');
    const liveId = randomUUID();
    const canaryId = randomUUID();
    const markerId = randomUUID();
    const foreignAgentId = randomUUID();
    const foreignConversationId = randomUUID();
    const foreignTaskId = randomUUID();
    const clientOperationId = randomUUID();
    const live = newTaskRecord(
      {
        agentId: agent.id,
        conversationId,
        type: 'chat_turn',
        trust: 'owner',
        trigger: { source: 'chat', payload: {} },
        externalEventId: randomUUID(),
      },
      liveId,
      now,
    );
    const canary = newTaskRecord(
      {
        agentId: agent.id,
        conversationId,
        type: 'chat_turn',
        trust: 'owner',
        trigger: { source: 'chat', payload: { canary: true } },
        externalEventId: randomUUID(),
      },
      canaryId,
      now,
    );
    const marker = {
      ...newTaskRecord(
        {
          agentId: agent.id,
          conversationId,
          type: 'chat_turn',
          trust: 'owner',
          trigger: chatAdmissionCancellationTrigger({
            agentId: agent.id,
            conversationId,
            clientOperationId,
          }),
          externalEventId: chatAdmissionExternalEventId({
            agentId: agent.id,
            conversationId,
            clientOperationId,
          }),
        },
        markerId,
        now,
      ),
      status: 'cancelled',
    };
    const foreignAgentCreatedAt = new Date(now.getTime() + 10_000);
    const foreignAgent = {
      id: foreignAgentId,
      name: 'Activity status test owner',
      email: `activity-status-${foreignAgentId}@example.invalid`,
      workspacePrefix: `activity-status/${foreignAgentId}`,
      createdAt: foreignAgentCreatedAt,
      updatedAt: foreignAgentCreatedAt,
    };
    const foreignConversation = {
      ...conversation,
      id: foreignConversationId,
      agentId: foreignAgentId,
      createdAt: foreignAgentCreatedAt,
      updatedAt: foreignAgentCreatedAt,
    };
    const foreignTask = newTaskRecord(
      {
        agentId: foreignAgentId,
        conversationId: foreignConversationId,
        type: 'chat_turn',
        trust: 'owner',
        trigger: { source: 'chat', payload: {} },
        externalEventId: randomUUID(),
      },
      foreignTaskId,
      now,
    );

    try {
      await db.insert(agents).values(foreignAgent);
      await db.insert(conversations).values(foreignConversation);
      await db.insert(tasks).values([live, canary, marker, foreignTask]);
      for (const [status, progress, offset] of [
        ['pending', 'Queued', 1],
        ['running', 'Checking sources', 2],
        ['done', 'Finished', 3],
      ] as const) {
        await db
          .update(tasks)
          .set({ status, progress, updatedAt: new Date(now.getTime() + offset * 1000) })
          .where(eq(tasks.id, liveId));
        await expect(getActivityStatus(db, liveId)).resolves.toMatchObject({
          id: liveId,
          status,
          progress,
          updatedAt: new Date(now.getTime() + offset * 1000),
        });
      }
      await expect(getActivityStatus(db, canaryId)).resolves.toBeNull();
      await expect(getActivityStatus(db, markerId)).resolves.toBeNull();
      await expect(getActivityStatus(db, foreignTaskId)).resolves.toBeNull();
      await expect(getActivityStatus(db, randomUUID())).resolves.toBeNull();
    } finally {
      await db.delete(tasks).where(eq(tasks.id, liveId));
      await db.delete(tasks).where(eq(tasks.id, canaryId));
      await db.delete(tasks).where(eq(tasks.id, markerId));
      await db.delete(tasks).where(eq(tasks.id, foreignTaskId));
      await db.delete(conversations).where(eq(conversations.id, foreignConversationId));
      await db.delete(agents).where(eq(agents.id, foreignAgentId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
    }
  });

  it('loads owner-facing dashboard projections through stable contracts', async () => {
    const [approvals, activity, goals, profile, memory, costs] = await Promise.all([
      listApprovalInbox(db, 1),
      listActivity(db, { archived: false, filter: 'all', limit: 1 }),
      listGoalsDashboard(db, false),
      getProfileOverview(db),
      listMemoryLibrary(db, {
        state: 'in-use',
        filter: 'all',
        query: '',
        page: 1,
        pageSize: 1,
      }),
      getCostsDashboard(db),
    ]);

    expect(Array.isArray(approvals.pending)).toBe(true);
    expect(Array.isArray(activity.items)).toBe(true);
    expect(Array.isArray(goals.items)).toBe(true);
    expect(Array.isArray(profile.ownerFacts)).toBe(true);
    expect(memory.total).toBeGreaterThanOrEqual(0);
    expect(costs.totals.monthlySpentUsd).toBeGreaterThanOrEqual(0);
  });
});
