import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPostgresApprovalRepository,
  getRememberableApproval,
  resolveApproval,
} from './approval-repository.js';
import { createDb, type Db } from './client.js';
import { agents, approvals, tasks, toolCalls } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;

function testDatabaseUrl(): string {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

describe('PostgreSQL approval remember flow', () => {
  let db: Db | undefined;
  const ownerId = randomUUID();
  let secondaryAgentId: string | undefined;
  const taskIds: string[] = [];
  const toolCallIds: string[] = [];
  const approvalIds: string[] = [];

  afterEach(async () => {
    if (!db) return;
    if (toolCallIds.length)
      await db
        .update(toolCalls)
        .set({ approvalId: null })
        .where(inArray(toolCalls.id, toolCallIds));
    if (approvalIds.length) await db.delete(approvals).where(inArray(approvals.id, approvalIds));
    if (toolCallIds.length) await db.delete(toolCalls).where(inArray(toolCalls.id, toolCallIds));
    if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
    await db
      .delete(agents)
      .where(inArray(agents.id, [ownerId, ...(secondaryAgentId ? [secondaryAgentId] : [])]));
    await db.$client.end();
    db = undefined;
    secondaryAgentId = undefined;
    taskIds.length = 0;
    toolCallIds.length = 0;
    approvalIds.length = 0;
  });

  it('scopes rememberable reads and rejects a mismatched policy atomically', async () => {
    db = createDb(testDatabaseUrl());
    await db.insert(agents).values({
      id: ownerId,
      name: `approval-remember-${ownerId.slice(0, 8)}`,
      email: `${ownerId}@approval-remember.invalid`,
      workspacePrefix: `approval-remember/${ownerId}`,
    });
    const otherAgentId = randomUUID();
    secondaryAgentId = otherAgentId;
    await db.insert(agents).values({
      id: otherAgentId,
      name: `remember-test-${otherAgentId.slice(0, 8)}`,
      email: `${otherAgentId}@remember-test.invalid`,
      workspacePrefix: `remember-test/${otherAgentId}`,
    });

    const taskId = randomUUID();
    const toolCallId = randomUUID();
    const approvalId = randomUUID();
    taskIds.push(taskId);
    toolCallIds.push(toolCallId);
    approvalIds.push(approvalId);

    await db.insert(tasks).values({
      id: taskId,
      agentId: ownerId,
      type: 'chat_turn',
      trust: 'owner',
      status: 'waiting_approval',
    });
    await db.insert(toolCalls).values({
      id: toolCallId,
      taskId,
      step: 0,
      toolName: 'gmail.send',
      risk: 'approval',
      status: 'awaiting_approval',
      decision: { riskTier: 'high' },
    });
    await db.insert(approvals).values({
      id: approvalId,
      taskId,
      toolCallId,
      shortCode: `A${approvalId.slice(0, 8)}`,
      summary: 'send email',
      payload: { to: ['friend@example.com'] },
      resolutionPayload: null,
      status: 'pending',
      requestedAt: new Date(),
      resolvedAt: null,
      resolvedVia: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await db.update(toolCalls).set({ approvalId }).where(eq(toolCalls.id, toolCallId));

    const repository = createPostgresApprovalRepository(db);
    await expect(getRememberableApproval(db, ownerId, approvalId)).resolves.toMatchObject({
      approval: { id: approvalId, status: 'pending' },
      toolName: 'gmail.send',
    });
    await expect(repository.getRememberable(otherAgentId, approvalId)).resolves.toBeNull();

    await db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '3s'`);
      await tx
        .update(approvals)
        .set({ expiresAt: sql`clock_timestamp() + interval '1 second'` })
        .where(eq(approvals.id, approvalId));
      const [deadline] = await tx
        .select({
          expiresAt: approvals.expiresAt,
          startedBeforeExpiry: sql<boolean>`transaction_timestamp() < ${approvals.expiresAt}`,
        })
        .from(approvals)
        .where(eq(approvals.id, approvalId));
      expect(deadline?.startedBeforeExpiry).toBe(true);
      await tx.execute(sql`select pg_sleep(1.1)`);
      await expect(
        getRememberableApproval(tx as unknown as Db, ownerId, approvalId),
      ).resolves.toBeNull();
    });
    await db
      .update(approvals)
      .set({ expiresAt: sql`clock_timestamp() + interval '1 hour'` })
      .where(eq(approvals.id, approvalId));

    // The server-clock sample is at or before the next eligibility check; no
    // expired row may be exposed even inside a long-running transaction.
    await db.transaction(async (tx) => {
      await tx
        .update(approvals)
        .set({ expiresAt: sql`clock_timestamp()` })
        .where(eq(approvals.id, approvalId));
      await expect(
        getRememberableApproval(tx as unknown as Db, ownerId, approvalId),
      ).resolves.toBeNull();
    });
    await db.transaction(async (tx) => {
      await tx
        .update(approvals)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(approvals.id, approvalId));
      await expect(
        getRememberableApproval(tx as unknown as Db, ownerId, approvalId),
      ).resolves.toBeNull();
    });
    await db
      .update(approvals)
      .set({ expiresAt: sql`now() + interval '1 hour'` })
      .where(eq(approvals.id, approvalId));

    const mismatchedTaskId = randomUUID();
    taskIds.push(mismatchedTaskId);
    await db.insert(tasks).values({
      id: mismatchedTaskId,
      agentId: ownerId,
      type: 'chat_turn',
      trust: 'owner',
      status: 'waiting_approval',
    });
    await db
      .update(toolCalls)
      .set({ taskId: mismatchedTaskId })
      .where(eq(toolCalls.id, toolCallId));
    await expect(repository.getRememberable(ownerId, approvalId)).resolves.toBeNull();
    await db.update(toolCalls).set({ taskId }).where(eq(toolCalls.id, toolCallId));

    await expect(
      resolveApproval(db, {
        approvalId,
        decision: 'approved',
        via: 'web',
        policy: {
          agentId: otherAgentId,
          toolName: 'gmail.send',
          templateKey: 'gmail.send.to_recipient',
          match: { recipient: 'friend@example.com' },
          effect: 'allow',
        },
      }),
    ).rejects.toThrow('task owner and tool');
    const [stillPending] = await db
      .select({ status: approvals.status })
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'pending')));
    expect(stillPending?.status).toBe('pending');
  });
});
