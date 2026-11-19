import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import {
  agents,
  approvals,
  conversations,
  createDb,
  createPostgresApplicationChatPersistence,
  createPostgresTaskDiscoveryRepository,
  tasks,
  toolCalls,
} from '@assistant/db';
import {
  chatAdmissionCancellationTrigger,
  chatAdmissionExternalEventId,
  newTaskRecord,
} from '@assistant/persistence';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDashboardPresence } from '../dashboard.js';
import {
  archiveActivity,
  archiveOldActivity,
  cancelActivity,
  raiseTaskBudget,
  restoreActivity,
  retryActivity,
  revokeTaskAutonomy,
} from './commands.js';
import { discoverActivityWithRepository } from './discovery.js';
import { listActivity } from './queries.js';

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
          progress: 'attempt 1 failed: AI_APICallError https://provider.example/private',
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
        progress: 'This task was cancelled.',
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

  it('counts current Needs You rows and archives only eligible stale attention', async () => {
    const db = createDb(
      process.env.TEST_DATABASE_URL ?? 'postgres://assistant@127.0.0.1:1/unallocated',
    );
    const ids: string[] = Array.from({ length: 8 }, () => randomUUID());
    const [old, blocked, fresh, budget, estimated, approval, hidden, canary] = ids as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const toolCallId = randomUUID();
    const approvalId = randomUUID();
    const aged = new Date('2020-01-01T00:00:00Z');
    try {
      const { id: agentId } = await getAgent(db);
      const before = await getDashboardPresence(db, agentId);
      await db.insert(tasks).values(
        [
          { id: old, status: 'needs_attention', updatedAt: aged },
          { id: blocked, status: 'needs_attention', updatedAt: aged },
          { id: fresh, status: 'needs_attention' },
          { id: budget, status: 'waiting_budget', updatedAt: aged },
          { id: estimated, status: 'waiting_estimated_cost', updatedAt: aged },
          { id: approval, status: 'waiting_approval', updatedAt: aged },
          { id: hidden, status: 'needs_attention', updatedAt: aged, archivedAt: aged },
          {
            id: canary,
            status: 'needs_attention',
            updatedAt: aged,
            trigger: { payload: { canary: 'true' } },
          },
        ].map((row) => ({ agentId, type: 'chat_turn', ...row })),
      );
      await db.insert(toolCalls).values({
        id: toolCallId,
        taskId: blocked,
        step: 0,
        toolName: 'test.approval',
        risk: 'approval',
        status: 'awaiting_approval',
      });
      await db.insert(approvals).values({
        id: approvalId,
        taskId: blocked,
        toolCallId,
        shortCode: `T${approvalId.slice(0, 6)}`,
        summary: 'Synthetic approval',
        status: 'pending',
        expiresAt: new Date(Date.now() + 60_000),
      });

      const visible = await listActivity(db, { archived: false, filter: 'needs-you', limit: 500 });
      expect(
        visible.items
          .filter((row) => ids.includes(row.id))
          .map((row) => row.id)
          .sort(),
      ).toEqual([old, blocked, fresh, budget, estimated, approval].sort());
      expect((await getDashboardPresence(db, agentId)).needsAttention).toBe(
        before.needsAttention + 6,
      );
      const discovery = await discoverActivityWithRepository(
        createPostgresTaskDiscoveryRepository(db),
        agentId,
        {
          archived: false,
          filter: 'needs-you',
          limit: 1,
        },
      );
      expect(discovery.items).toHaveLength(1);
      expect(discovery.nextCursor).toEqual(expect.any(String));
      expect(discovery.needsYouCount).toBe(before.needsAttention + 6);
      expect(await archiveActivity(db, blocked)).toMatchObject({ outcome: 'no_longer_retriable' });
      expect(await archiveOldActivity(db, 30, 'stale-attention')).toMatchObject({
        archivedTotal: 1,
        complete: true,
      });
      const archived = await listActivity(db, { archived: true, filter: 'needs-you', limit: 500 });
      expect(archived.items).toContainEqual(
        expect.objectContaining({ id: old, status: 'needs_attention' }),
      );
      expect((await getDashboardPresence(db, agentId)).needsAttention).toBe(
        before.needsAttention + 5,
      );
      expect(await retryActivity(db, old)).toMatchObject({ outcome: 'no_longer_retriable' });
      expect(await restoreActivity(db, old)).toMatchObject({ outcome: 'restored' });
      expect(await archiveActivity(db, old)).toMatchObject({ outcome: 'archived' });
      expect(await archiveActivity(db, old)).toMatchObject({ outcome: 'already_archived' });
      expect(await archiveActivity(db, canary)).toMatchObject({ outcome: 'not_found' });
    } finally {
      await db.delete(approvals).where(eq(approvals.id, approvalId));
      await db.delete(toolCalls).where(eq(toolCalls.id, toolCallId));
      await db.delete(tasks).where(inArray(tasks.id, ids));
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
