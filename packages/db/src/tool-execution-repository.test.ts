import { randomUUID } from 'node:crypto';
import { approvalPolicyFingerprint } from '@assistant/persistence';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { agents, approvals, tasks, toolCalls } from './schema.js';
import { createPostgresToolExecutionRepository } from './tool-execution-repository.js';

const DATABASE_URL = process.env.DATABASE_URL;
const testUrl = () => {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
};

describe('PostgreSQL tool execution repository', () => {
  let db: Db | undefined;
  const taskIds: string[] = [];
  const callIds: string[] = [];
  const approvalIds: string[] = [];
  let extraAgent: string | undefined;

  afterEach(async () => {
    if (!db) return;
    if (callIds.length)
      await db.update(toolCalls).set({ approvalId: null }).where(inArray(toolCalls.id, callIds));
    if (approvalIds.length) await db.delete(approvals).where(inArray(approvals.id, approvalIds));
    if (callIds.length) await db.delete(toolCalls).where(inArray(toolCalls.id, callIds));
    if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
    if (extraAgent) await db.delete(agents).where(eq(agents.id, extraAgent));
    await db.$client.end();
    db = undefined;
    taskIds.length = 0;
    callIds.length = 0;
    approvalIds.length = 0;
    extraAgent = undefined;
  });

  it('claims exactly once, scopes links to the owner, and fences stale outcomes', async () => {
    db = createDb(testUrl());
    const [owner] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!owner) throw new Error('Seed the test database');
    extraAgent = randomUUID();
    await db.insert(agents).values({
      id: extraAgent,
      name: `tool-exec-${extraAgent.slice(0, 8)}`,
      email: `${extraAgent}@tool-exec.invalid`,
      workspacePrefix: `tool-exec/${extraAgent}`,
    });

    const taskId = randomUUID();
    const callId = randomUUID();
    const approvalId = randomUUID();
    taskIds.push(taskId);
    callIds.push(callId);
    approvalIds.push(approvalId);
    await db.insert(tasks).values({
      id: taskId,
      agentId: owner.id,
      type: 'chat_turn',
      trust: 'owner',
      status: 'waiting_approval',
    });
    await db.insert(toolCalls).values({
      id: callId,
      taskId,
      step: 1,
      toolName: 'test.approved',
      risk: 'approval',
      status: 'approved',
      args: { original: true },
      decision: { modelToolCallId: 'model-call-1' },
    });
    await db.insert(approvals).values({
      id: approvalId,
      taskId,
      toolCallId: callId,
      shortCode: `A${approvalId.slice(0, 8)}`,
      summary: 'test approved call',
      payload: { original: true },
      resolutionPayload: { edited: true },
      status: 'approved',
      requestedAt: new Date('2026-09-12T12:00:00Z'),
      resolvedAt: new Date('2026-09-12T12:01:00Z'),
      resolvedVia: 'web',
      expiresAt: new Date('2026-09-13T12:00:00Z'),
    });
    await db.update(toolCalls).set({ approvalId }).where(eq(toolCalls.id, callId));

    const repository = createPostgresToolExecutionRepository(db);
    await expect(repository.load(extraAgent, taskId, callId)).resolves.toBeNull();
    await expect(repository.load(owner.id, randomUUID(), callId)).resolves.toBeNull();
    await expect(
      repository.findByModelToolCallId?.(extraAgent, taskId, 'model-call-1'),
    ).resolves.toBeNull();
    await expect(
      repository.findByModelToolCallId?.(owner.id, taskId, 'model-call-1'),
    ).resolves.toMatchObject({
      toolCall: { id: callId, decision: { modelToolCallId: 'model-call-1' } },
      approval: { id: approvalId, status: 'approved' },
    });
    await expect(repository.load(owner.id, taskId, callId)).resolves.toMatchObject({
      toolCall: { status: 'approved' },
      approval: { status: 'approved' },
    });

    const claim = {
      agentId: owner.id,
      taskId,
      toolCallId: callId,
      args: { edited: true },
      decision: {
        reservationId: 'reservation-1',
        modelToolCallId: 'model-call-1',
        policyFingerprint: 'private-policy-snapshot',
        mcpBinding: { credential: 'never-copy' },
      },
      expectedPolicyFingerprint: approvalPolicyFingerprint([]),
      expectedTaskTrust: 'owner',
    };
    const fencedClaim = { ...claim, expectedTaskStatus: 'running' };
    await expect(repository.claim(fencedClaim)).resolves.toBeNull();
    await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId));
    await expect(
      repository.claim({ ...fencedClaim, expectedTaskTrust: 'executor' }),
    ).resolves.toEqual({
      type: 'stale_authorization',
      error: 'approval authority changed before execution; request fresh approval',
    });
    // The durable terminal receipt exists as soon as claim returns, even if
    // the dispatcher crashes before it can release the reservation.
    await expect(repository.load(owner.id, taskId, callId)).resolves.toMatchObject({
      toolCall: {
        status: 'failed',
        decision: { reservationId: 'reservation-1', modelToolCallId: 'model-call-1' },
        error: 'approval authority changed before execution; request fresh approval',
      },
      approval: { status: 'approved' },
    });
    await db
      .update(toolCalls)
      .set({
        status: 'approved',
        decision: { modelToolCallId: 'model-call-1' },
        error: null,
        result: null,
        finishedAt: null,
      })
      .where(eq(toolCalls.id, callId));
    const claims = await Promise.all([
      repository.claim(fencedClaim),
      repository.claim(fencedClaim),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(repository.load(owner.id, taskId, callId)).resolves.toMatchObject({
      toolCall: { status: 'executing', args: { edited: true } },
    });

    const progress = {
      provider: 'google' as const,
      kind: 'document' as const,
      objectId: 'created-doc',
      stage: 'created' as const,
      payloadDigest: 'a'.repeat(64),
    };
    const progressInput = { agentId: owner.id, taskId: taskId, toolCallId: callId, progress };
    expect(
      await repository.checkpointExternalEffect?.({ ...progressInput, agentId: extraAgent }),
    ).toBe(false);
    expect(await repository.checkpointExternalEffect?.(progressInput)).toBe(true);
    expect(await repository.checkpointExternalEffect?.(progressInput)).toBe(true);
    await expect(
      repository.checkpointExternalEffect?.({
        ...progressInput,
        progress: { ...progress, objectId: 'different-doc' },
      }),
    ).rejects.toThrow('identity');
    await expect(
      repository.checkpointExternalEffect?.({
        ...progressInput,
        progress: { ...progress, payloadDigest: 'b'.repeat(64) },
      }),
    ).rejects.toThrow('approved bytes');
    expect(
      await repository.checkpointExternalEffect?.({
        ...progressInput,
        progress: { ...progress, stage: 'filled' },
      }),
    ).toBe(true);
    expect((await repository.load(owner.id, taskId, callId))?.toolCall.decision).toMatchObject({
      externalEffect: { ...progress, stage: 'filled' },
    });

    await expect(
      repository.outcome({
        agentId: owner.id,
        taskId,
        toolCallId: callId,
        status: 'succeeded',
        result: { deliveryStatus: 'unknown', retrySuppressed: true },
      }),
    ).resolves.toBe(true);
    await expect(
      repository.outcome({
        agentId: owner.id,
        taskId,
        toolCallId: callId,
        status: 'failed',
        error: 'stale executor failure',
      }),
    ).resolves.toBe(false);
    await expect(repository.load(owner.id, taskId, callId)).resolves.toMatchObject({
      toolCall: {
        status: 'succeeded',
        result: { deliveryStatus: 'unknown', retrySuppressed: true },
        error: null,
      },
    });
  });
});
