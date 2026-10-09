import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresExecutionJobRepository } from './execution-jobs-repository.js';
import { agents, executionJobCallbackReceipts, files, tasks, toolCalls } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
function testUrl() {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

describe('PostgreSQL idempotent execution-job callbacks', () => {
  let db: Db;
  let agentId: string;
  let taskId: string;
  let toolCallId: string;

  beforeEach(async () => {
    db = createDb(testUrl());
    agentId = randomUUID();
    taskId = randomUUID();
    toolCallId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      name: 'callback-idempotency-test',
      email: `${agentId}@callback-idempotency.invalid`,
      workspacePrefix: `callback-idempotency/${agentId}`,
    });
    await db.insert(tasks).values({
      id: taskId,
      agentId,
      type: 'chat_turn',
      trust: 'owner',
      status: 'running',
    });
    await db.insert(toolCalls).values({
      id: toolCallId,
      taskId,
      step: 1,
      toolName: 'phone.call',
      risk: 'approval',
      status: 'executing',
      args: {},
    });
  });

  afterEach(async () => {
    await db.delete(files).where(eq(files.taskId, taskId));
    await db
      .delete(executionJobCallbackReceipts)
      .where(eq(executionJobCallbackReceipts.taskId, taskId));
    await db.delete(toolCalls).where(eq(toolCalls.id, toolCallId));
    await db.delete(tasks).where(eq(tasks.id, taskId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.$client.end();
  });

  it('replays the committed receipt without waking or mutating the task twice', async () => {
    const jobs = createPostgresExecutionJobRepository(db);
    const callback = {
      taskId,
      result: { callId: randomUUID(), status: 'completed' },
      files: [],
      idempotencyKey: `call-result:${randomUUID()}`,
      tokenHash: 'a'.repeat(64),
      payloadDigest: 'b'.repeat(64),
    };
    const decide = (task: { id: string } | null) =>
      task
        ? { accept: true as const, toolCallId }
        : { accept: false as const, status: 404 as const, error: 'missing' };
    const first = await jobs.recordCallback(callback, decide);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.taskId).toBe(taskId);

    const replay = await jobs.recordCallback(callback, () => {
      throw new Error(
        'a committed callback must replay before revalidating consumed pending state',
      );
    });
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      queueGeneration: first.ok ? first.queueGeneration : -1,
    });

    const changed = await jobs.recordCallback(
      { ...callback, payloadDigest: 'c'.repeat(64) },
      () => ({ accept: false, status: 409, error: 'should have a mismatched receipt' }),
    );
    expect(changed).toMatchObject({ ok: false, status: 409 });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task?.status).toBe('pending');
    expect(task?.queueGeneration).toBe(1);
    expect(await db.select().from(executionJobCallbackReceipts)).toHaveLength(1);
  });

  it('rejects a late callback for a terminal task before changing its tool result or artifacts', async () => {
    const jobs = createPostgresExecutionJobRepository(db);
    const priorResult = { ok: false, error: 'timed out' };
    await db.update(tasks).set({ status: 'needs_attention' }).where(eq(tasks.id, taskId));
    await db
      .update(toolCalls)
      .set({ status: 'failed', result: priorResult })
      .where(eq(toolCalls.id, toolCallId));
    const callback = {
      taskId,
      result: { ok: true, output: 'late result' },
      files: [{ workspacePath: 'late.txt', mime: 'text/plain' }],
      idempotencyKey: `call-result:${randomUUID()}`,
      tokenHash: 'd'.repeat(64),
      payloadDigest: 'e'.repeat(64),
    };
    const outcome = await jobs.recordCallback(callback, (task) =>
      task
        ? { accept: true as const, toolCallId }
        : { accept: false as const, status: 404 as const, error: 'missing' },
    );

    expect(outcome).toMatchObject({ ok: false, status: 409 });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const [tool] = await db.select().from(toolCalls).where(eq(toolCalls.id, toolCallId));
    expect(task?.status).toBe('needs_attention');
    expect(tool).toMatchObject({ status: 'failed', result: priorResult });
    expect(await db.select().from(files).where(eq(files.taskId, taskId))).toHaveLength(0);
    expect(await db.select().from(executionJobCallbackReceipts)).toHaveLength(0);
  });
});
