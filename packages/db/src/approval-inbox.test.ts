import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { listApprovalInbox } from './approval-repository.js';
import { createDb, type Db } from './client.js';
import { agents, approvals, tasks, toolCalls } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-12T12:00:00.000Z');

function testDatabaseUrl(): string {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

describe('PostgreSQL approval inbox', () => {
  let db: Db | undefined;
  const taskIds: string[] = [];
  const toolCallIds: string[] = [];
  const approvalIds: string[] = [];
  const ownerId = randomUUID();

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
    await db.delete(agents).where(eq(agents.id, ownerId));
    await db.$client.end();
    db = undefined;
    taskIds.length = 0;
    toolCallIds.length = 0;
    approvalIds.length = 0;
  });

  it('returns owner pending evidence and bounded history without payloads', async () => {
    const database = createDb(testDatabaseUrl());
    db = database;
    await database.insert(agents).values({
      id: ownerId,
      name: `approval-inbox-${ownerId.slice(0, 8)}`,
      email: `${ownerId}@approval-inbox.invalid`,
      workspacePrefix: `approval-inbox/${ownerId}`,
    });

    const seed = async (input: {
      agentId?: string;
      status: string;
      requestedAt: Date;
      expiresAt: Date;
      resolvedAt?: Date | null;
      resolutionPayload?: unknown;
      toolTaskMismatch?: boolean;
    }) => {
      const taskId = randomUUID();
      const toolCallId = randomUUID();
      const approvalId = randomUUID();
      await database.insert(tasks).values({
        id: taskId,
        agentId: input.agentId ?? ownerId,
        type: 'chat_turn',
        trust: 'owner',
        status: 'waiting_approval',
      });
      const toolTaskId = input.toolTaskMismatch ? randomUUID() : taskId;
      if (toolTaskId !== taskId) {
        await database.insert(tasks).values({
          id: toolTaskId,
          agentId: ownerId,
          type: 'chat_turn',
          trust: 'owner',
          status: 'waiting_approval',
        });
        taskIds.push(toolTaskId);
      }
      await database.insert(toolCalls).values({
        id: toolCallId,
        taskId: toolTaskId,
        step: 0,
        toolName: 'gmail.send',
        risk: 'approval',
        status: input.status === 'pending' ? 'awaiting_approval' : 'approved',
        decision: { riskTier: 'high' },
      });
      await database.insert(approvals).values({
        id: approvalId,
        taskId,
        toolCallId,
        shortCode: `A${approvalId.slice(0, 8)}`,
        summary: `approval ${approvalId}`,
        payload: { secret: 'must stay out of history' },
        resolutionPayload: input.resolutionPayload,
        status: input.status,
        requestedAt: input.requestedAt,
        resolvedAt: input.resolvedAt,
        resolvedVia: input.status === 'pending' ? null : 'web',
        expiresAt: input.expiresAt,
      });
      await database.update(toolCalls).set({ approvalId }).where(eq(toolCalls.id, toolCallId));
      taskIds.push(taskId);
      toolCallIds.push(toolCallId);
      approvalIds.push(approvalId);
      return approvalId;
    };

    const pendingId = await seed({
      status: 'pending',
      requestedAt: new Date('2026-09-12T11:00:00.000Z'),
      expiresAt: new Date('2026-09-13T11:00:00.000Z'),
    });
    await seed({
      status: 'pending',
      requestedAt: new Date('2026-09-12T11:01:00.000Z'),
      expiresAt: new Date('2026-09-13T11:00:00.000Z'),
      toolTaskMismatch: true,
    });
    const boundaryId = await seed({
      status: 'pending',
      requestedAt: new Date('2026-09-12T09:00:00.000Z'),
      expiresAt: NOW,
    });
    const expiredId = await seed({
      status: 'pending',
      requestedAt: new Date('2026-09-10T11:00:00.000Z'),
      expiresAt: new Date('2026-09-12T10:00:00.000Z'),
    });
    const epochId = await seed({
      status: 'approved',
      requestedAt: new Date('1969-12-31T23:00:00.000Z'),
      expiresAt: new Date('1970-01-01T00:00:00.000Z'),
      resolvedAt: new Date(0),
    });
    const editedId = await seed({
      status: 'denied',
      requestedAt: new Date('2026-09-11T11:00:00.000Z'),
      expiresAt: new Date('2026-09-13T11:00:00.000Z'),
      resolvedAt: new Date('2026-09-12T11:30:00.000Z'),
      resolutionPayload: { changed: true },
    });
    const tieA = await seed({
      status: 'approved',
      requestedAt: new Date('2026-09-11T10:00:00.000Z'),
      expiresAt: new Date('2026-09-13T11:00:00.000Z'),
      resolvedAt: new Date('2026-09-12T11:00:00.000Z'),
    });
    const tieB = await seed({
      status: 'approved',
      requestedAt: new Date('2026-09-11T09:00:00.000Z'),
      expiresAt: new Date('2026-09-13T11:00:00.000Z'),
      resolvedAt: new Date('2026-09-12T11:00:00.000Z'),
    });

    await expect(
      listApprovalInbox(database, ownerId, { now: NOW, recentLimit: 0 }),
    ).rejects.toThrow('Invalid approval inbox limit');
    const inbox = await listApprovalInbox(database, ownerId, { now: NOW, recentLimit: 6 });
    expect(inbox.pending.map(({ approval }) => approval.id)).toEqual([pendingId]);
    expect(inbox.resolved.map(({ approval }) => approval.id)).toEqual([
      boundaryId,
      editedId,
      tieA > tieB ? tieA : tieB,
      tieA > tieB ? tieB : tieA,
      expiredId,
      epochId,
    ]);
    expect(inbox.resolved.find(({ approval }) => approval.id === editedId)?.approval.edited).toBe(
      true,
    );
    expect(inbox.resolved.find(({ approval }) => approval.id === boundaryId)?.approval.status).toBe(
      'pending',
    );
    expect(
      inbox.resolved.find(({ approval }) => approval.id === epochId)?.approval.resolvedAt,
    ).toEqual(new Date(0));
    expect(inbox.resolved[0]?.approval).not.toHaveProperty('payload');
    expect(inbox.resolved[0]?.approval).not.toHaveProperty('resolutionPayload');

    for (let i = 0; i < 51; i++) {
      await seed({
        status: 'pending',
        requestedAt: new Date(
          `2026-09-12T11:${String(2 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        ),
        expiresAt: new Date('2026-09-13T11:00:00.000Z'),
      });
    }
    const capped = await listApprovalInbox(database, ownerId, { now: NOW });
    expect(capped.pending).toHaveLength(50);
    expect(capped.pending[0]?.approval.id).toBe(pendingId);
  });
});
