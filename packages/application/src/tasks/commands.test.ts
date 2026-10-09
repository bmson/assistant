import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import {
  agents,
  conversations,
  createDb,
  createPostgresApplicationChatPersistence,
  tasks,
} from '@assistant/db';
import {
  chatAdmissionCancellationTrigger,
  chatAdmissionExternalEventId,
  newTaskRecord,
} from '@assistant/persistence';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  archiveActivity,
  cancelActivity,
  raiseTaskBudget,
  restoreActivity,
  retryActivity,
  revokeTaskAutonomy,
} from './commands.js';

describe('owner task activity commands', () => {
  it('keeps pre-admission cancellation markers out of every owner task mutation', async () => {
    const db = createDb(
      process.env.TEST_DATABASE_URL ?? 'postgres://assistant@127.0.0.1:1/unallocated',
    );
    const markerId = randomUUID();
    let conversationId: string | null = null;
    try {
      const owner = await getAgent(db);
      const conversation = await createPostgresApplicationChatPersistence(db).createConversation(
        owner.id,
      );
      conversationId = conversation.id;
      const clientOperationId = randomUUID();
      const now = new Date();
      const marker = {
        ...newTaskRecord(
          {
            agentId: owner.id,
            conversationId,
            type: 'chat_turn',
            trust: 'owner',
            trigger: chatAdmissionCancellationTrigger({
              agentId: owner.id,
              conversationId,
              clientOperationId,
            }),
            externalEventId: chatAdmissionExternalEventId({
              agentId: owner.id,
              conversationId,
              clientOperationId,
            }),
          },
          markerId,
          now,
        ),
        status: 'cancelled',
      };
      await db.insert(tasks).values(marker);
      for (const outcome of [
        await archiveActivity(db, markerId),
        await restoreActivity(db, markerId),
        await retryActivity(db, markerId),
        await cancelActivity(db, markerId),
        await revokeTaskAutonomy(db, markerId),
        await raiseTaskBudget(db, markerId, 1),
      ])
        expect(outcome).toMatchObject({ outcome: 'not_found', transitioned: false, current: null });
      expect(await db.query.tasks.findFirst({ where: eq(tasks.id, markerId) })).toMatchObject({
        id: markerId,
        status: 'cancelled',
        archivedAt: null,
        leaseToken: null,
        lockedUntil: null,
        title: null,
        plan: null,
        state: {},
        queueGeneration: 0,
        budgetUsdLimit: '0.5000',
      });
    } finally {
      await db.delete(tasks).where(eq(tasks.id, markerId));
      if (conversationId)
        await db.delete(conversations).where(eq(conversations.id, conversationId));
      await db.$client.end();
    }
  });

  it('returns authoritative cancel outcomes and clears an active lease only on transition', async () => {
    const db = createDb(
      process.env.TEST_DATABASE_URL ?? 'postgres://assistant@127.0.0.1:1/unallocated',
    );
    const foreignAgentId = randomUUID();
    const ids = Array.from({ length: 4 }, () => randomUUID());
    try {
      const owner = await getAgent(db);
      await db.insert(agents).values({
        id: foreignAgentId,
        name: 'Synthetic foreign owner',
        email: `${foreignAgentId}@example.test`,
        workspacePrefix: `test/${foreignAgentId}`,
      });
      const [runningId, doneId, failedId, foreignId] = ids;
      if (!runningId || !doneId || !failedId || !foreignId) throw new Error('missing fixture IDs');
      await db.insert(tasks).values([
        {
          id: runningId,
          agentId: owner.id,
          type: 'chat_turn',
          status: 'running',
          lockedUntil: new Date(Date.now() + 60_000),
          leaseToken: randomUUID(),
        },
        { id: doneId, agentId: owner.id, type: 'chat_turn', status: 'done' },
        { id: failedId, agentId: owner.id, type: 'chat_turn', status: 'failed' },
        { id: foreignId, agentId: foreignAgentId, type: 'chat_turn', status: 'needs_attention' },
      ]);
      expect(await cancelActivity(db, foreignId)).toMatchObject({
        outcome: 'not_found',
        transitioned: false,
        current: null,
      });
      expect(await retryActivity(db, foreignId)).toMatchObject({ outcome: 'not_found' });
      expect(await cancelActivity(db, doneId)).toMatchObject({
        outcome: 'already_terminal',
        transitioned: false,
        current: { status: 'done' },
      });
      expect(await cancelActivity(db, failedId)).toMatchObject({
        outcome: 'already_terminal',
        transitioned: false,
        current: { status: 'failed' },
      });
      expect(await cancelActivity(db, runningId)).toMatchObject({
        outcome: 'cancelled',
        transitioned: true,
        current: { status: 'cancelled', queueGeneration: 0 },
      });
      expect(await cancelActivity(db, runningId)).toMatchObject({
        outcome: 'already_cancelled',
        transitioned: false,
        current: { status: 'cancelled', queueGeneration: 0 },
      });
      expect(await db.query.tasks.findFirst({ where: eq(tasks.id, runningId) })).toMatchObject({
        status: 'cancelled',
        leaseToken: null,
        lockedUntil: null,
      });
      expect(await db.query.tasks.findFirst({ where: eq(tasks.id, foreignId) })).toMatchObject({
        status: 'needs_attention',
      });
      expect(await db.query.tasks.findFirst({ where: eq(tasks.id, doneId) })).toMatchObject({
        status: 'done',
      });
      expect(await db.query.tasks.findFirst({ where: eq(tasks.id, failedId) })).toMatchObject({
        status: 'failed',
      });
    } finally {
      await db.delete(tasks).where(inArray(tasks.id, ids));
      await db.delete(agents).where(eq(agents.id, foreignAgentId));
      await db.$client.end();
    }
  });

  it('serializes duplicate retries and reports the winning queue generation', async () => {
    const db = createDb(
      process.env.TEST_DATABASE_URL ?? 'postgres://assistant@127.0.0.1:1/unallocated',
    );
    const taskId = randomUUID();
    try {
      const owner = await getAgent(db);
      await db.insert(tasks).values({
        id: taskId,
        agentId: owner.id,
        type: 'chat_turn',
        status: 'needs_attention',
        queueGeneration: 7,
        state: { checkpoint: 'continue' },
      });
      const results = await Promise.all([retryActivity(db, taskId), retryActivity(db, taskId)]);
      expect(results.map((row) => row.outcome).sort()).toEqual(['no_longer_retriable', 'retried']);
      expect(results.filter((row) => row.transitioned)).toHaveLength(1);
      expect(results.find((row) => row.transitioned)).toMatchObject({
        outcome: 'retried',
        current: { status: 'pending', queueGeneration: 8 },
      });
      expect(await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) })).toMatchObject({
        status: 'pending',
        queueGeneration: 8,
      });
    } finally {
      await db.delete(tasks).where(eq(tasks.id, taskId));
      await db.$client.end();
    }
  });

  it('lets a terminal completion that wins the row lock explain the cancellation result', async () => {
    const db = createDb(
      process.env.TEST_DATABASE_URL ?? 'postgres://assistant@127.0.0.1:1/unallocated',
    );
    const taskId = randomUUID();
    try {
      const owner = await getAgent(db);
      await db.insert(tasks).values({
        id: taskId,
        agentId: owner.id,
        type: 'chat_turn',
        status: 'running',
        queueGeneration: 3,
      });
      const [cancel, completion] = await Promise.all([
        cancelActivity(db, taskId),
        db
          .update(tasks)
          .set({ status: 'done', updatedAt: new Date() })
          .where(
            and(eq(tasks.id, taskId), eq(tasks.agentId, owner.id), eq(tasks.status, 'running')),
          )
          .returning({ id: tasks.id }),
      ]);
      const current = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
      if (!current) throw new Error('Missing task after race');
      if (cancel.outcome === 'cancelled') {
        expect(completion).toHaveLength(0);
        expect(cancel.current).toMatchObject({ status: 'cancelled', queueGeneration: 3 });
      } else {
        expect(cancel).toMatchObject({
          outcome: 'already_terminal',
          transitioned: false,
          current: { status: 'done', queueGeneration: 3 },
        });
        expect(completion).toHaveLength(1);
      }
      expect(current.status).toMatch(/^(done|cancelled)$/);
    } finally {
      await db.delete(tasks).where(eq(tasks.id, taskId));
      await db.$client.end();
    }
  });

  it('returns current state and transition outcomes for archive, restore, autonomy, and budget', async () => {
    const db = createDb(
      process.env.TEST_DATABASE_URL ?? 'postgres://assistant@127.0.0.1:1/unallocated',
    );
    const ids = Array.from({ length: 3 }, () => randomUUID());
    const [doneId, runningId, attentionId] = ids;
    if (!doneId || !runningId || !attentionId) throw new Error('missing fixture IDs');
    try {
      const owner = await getAgent(db);
      await db.insert(tasks).values([
        { id: doneId, agentId: owner.id, type: 'chat_turn', status: 'done' },
        { id: runningId, agentId: owner.id, type: 'chat_turn', status: 'running' },
        {
          id: attentionId,
          agentId: owner.id,
          type: 'chat_turn',
          status: 'needs_attention',
          queueGeneration: 4,
          budgetUsdLimit: '0.5000',
          spentUsd: '0.2500',
          autonomyGrant: { grantedAt: '2026-10-01T00:00:00.000Z' },
        },
      ]);

      expect(await archiveActivity(db, runningId)).toMatchObject({
        outcome: 'no_longer_retriable',
        transitioned: false,
        current: { id: runningId, status: 'running', archivedAt: null },
      });
      const archived = await archiveActivity(db, doneId);
      expect(archived).toMatchObject({
        outcome: 'archived',
        transitioned: true,
        current: { id: doneId, status: 'done', archivedAt: expect.any(String) },
      });
      expect(await archiveActivity(db, doneId)).toMatchObject({
        outcome: 'already_archived',
        transitioned: false,
        current: { id: doneId, status: 'done', archivedAt: archived.current?.archivedAt },
      });
      expect(await restoreActivity(db, doneId)).toMatchObject({
        outcome: 'restored',
        transitioned: true,
        current: { id: doneId, status: 'done', archivedAt: null },
      });
      expect(await restoreActivity(db, doneId)).toMatchObject({
        outcome: 'already_restored',
        transitioned: false,
        current: { id: doneId, status: 'done', archivedAt: null },
      });

      expect(await revokeTaskAutonomy(db, attentionId)).toMatchObject({
        outcome: 'autonomy_revoked',
        transitioned: true,
        current: { id: attentionId, status: 'needs_attention', autonomyRevoked: true },
      });
      expect(await revokeTaskAutonomy(db, attentionId)).toMatchObject({
        outcome: 'already_applied',
        transitioned: false,
        current: { id: attentionId, autonomyRevoked: true },
      });
      expect(await raiseTaskBudget(db, attentionId, 1)).toMatchObject({
        outcome: 'budget_raised',
        transitioned: true,
        current: {
          id: attentionId,
          status: 'pending',
          queueGeneration: 5,
          budgetUsdLimit: '1.0000',
        },
      });
      expect(await raiseTaskBudget(db, attentionId, 2)).toMatchObject({
        outcome: 'no_longer_retriable',
        transitioned: false,
        current: {
          id: attentionId,
          status: 'pending',
          queueGeneration: 5,
          budgetUsdLimit: '1.0000',
        },
      });
    } finally {
      await db.delete(tasks).where(inArray(tasks.id, ids));
      await db.$client.end();
    }
  });
});
