import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import {
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
import { getTaskDetail, listActivity } from './tasks.js';

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
