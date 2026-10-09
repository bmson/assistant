import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createPostgresApprovalRepository, resolveApproval } from './approval-repository.js';
import { createDb, type Db } from './client.js';
import { agents, approvals, maintenanceCursors, tasks, toolCalls } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;

function testDatabaseUrl(): string {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

async function waitBounded<T>(promise: Promise<T>, message: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createTask(
  db: Db,
  agentId: string,
  state: unknown,
  status = 'waiting_approval',
  id = randomUUID(),
) {
  await db.insert(tasks).values({
    id,
    agentId,
    type: 'adhoc',
    trust: 'assistant',
    status,
    state,
  });
  return id;
}

async function createApproval(
  db: Db,
  taskId: string,
  expiresAt: Date,
  status = 'pending',
): Promise<{ approvalId: string; toolCallId: string }> {
  const toolCallId = randomUUID();
  const approvalId = randomUUID();
  await db.insert(toolCalls).values({
    id: toolCallId,
    taskId,
    step: 0,
    toolName: 'test.approval',
    risk: 'approval',
    status: status === 'pending' ? 'awaiting_approval' : status,
  });
  await db.insert(approvals).values({
    id: approvalId,
    taskId,
    toolCallId,
    shortCode: `T${approvalId.slice(0, 6)}`,
    summary: 'maintenance test approval',
    status,
    expiresAt,
  });
  return { approvalId, toolCallId };
}

async function fixture() {
  const db = createDb(testDatabaseUrl());
  await db
    .update(maintenanceCursors)
    .set({ cursor: null })
    .where(eq(maintenanceCursors.name, 'approval-recovery'));
  const [agent] = await db.select().from(agents).limit(1);
  if (!agent) throw new Error('Seed the test database');
  const taskIds: string[] = [];
  const approvalIds: string[] = [];
  const toolCallIds: string[] = [];
  return {
    db,
    agentId: agent.id,
    repository: createPostgresApprovalRepository(db),
    taskIds,
    approvalIds,
    toolCallIds,
    async task(state: unknown, status = 'waiting_approval', id = randomUUID()) {
      const taskId = await createTask(db, agent.id, state, status, id);
      taskIds.push(taskId);
      return taskId;
    },
    async approval(taskId: string, expiresAt: Date, status = 'pending') {
      const row = await createApproval(db, taskId, expiresAt, status);
      approvalIds.push(row.approvalId);
      toolCallIds.push(row.toolCallId);
      return row.approvalId;
    },
    async dispose() {
      if (approvalIds.length) await db.delete(approvals).where(inArray(approvals.id, approvalIds));
      if (toolCallIds.length) await db.delete(toolCalls).where(inArray(toolCalls.id, toolCallIds));
      if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
      await db
        .update(maintenanceCursors)
        .set({ cursor: null })
        .where(eq(maintenanceCursors.name, 'approval-recovery'));
      await db.$client.end();
    },
  };
}

it('does not accept an answer after a pending approval expires', async () => {
  const f = await fixture();
  try {
    const taskId = await f.task({ pendingApprovals: [] });
    const approvalId = await f.approval(taskId, new Date(Date.now() - 1_000));
    await f.db
      .update(tasks)
      .set({ state: { pendingApprovals: [{ approvalId }] } })
      .where(eq(tasks.id, taskId));

    const result = await f.repository.resolve({
      approvalId,
      decision: 'approved',
      via: 'web',
      deferNotification: true,
    });
    expect(result.ok).toBe(false);
    const [approval] = await f.db.select().from(approvals).where(eq(approvals.id, approvalId));
    const [task] = await f.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(approval?.status).toBe('pending');
    expect(task).toMatchObject({ status: 'waiting_approval', queueGeneration: 0 });
  } finally {
    await f.dispose();
  }
});

it('resolves only strictly before the answer deadline without relying on the expiry sweep', async () => {
  const f = await fixture();
  try {
    const cases = [
      { label: 'before', deadline: sql`clock_timestamp() + interval '1 second'`, expected: true },
      { label: 'at-write-time', deadline: sql`clock_timestamp()`, expected: false },
      { label: 'after', deadline: sql`clock_timestamp() - interval '1 second'`, expected: false },
    ];
    for (const scenario of cases) {
      const taskId = await f.task({ pendingApprovals: [] });
      const approvalId = await f.approval(taskId, new Date(Date.now() + 60_000));
      await f.db
        .update(tasks)
        .set({ state: { pendingApprovals: [{ approvalId }] } })
        .where(eq(tasks.id, taskId));

      // Use server clock samples, not transaction-start now(). The at-write-time
      // sample has elapsed by the later decision-time check, which is fail-closed.
      const result = await f.db.transaction(async (tx) => {
        await tx
          .update(approvals)
          .set({ expiresAt: scenario.deadline })
          .where(eq(approvals.id, approvalId));
        return resolveApproval(tx as unknown as Db, {
          approvalId,
          decision: 'approved',
          via: 'web',
          deferNotification: true,
        });
      });
      expect(result.ok, scenario.label).toBe(scenario.expected);
      const [approval] = await f.db.select().from(approvals).where(eq(approvals.id, approvalId));
      const [task] = await f.db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(approval?.status, scenario.label).toBe(scenario.expected ? 'approved' : 'pending');
      expect(task?.status, scenario.label).toBe(scenario.expected ? 'pending' : 'waiting_approval');
      expect(task?.queueGeneration, scenario.label).toBe(scenario.expected ? 1 : 0);
    }
  } finally {
    await f.dispose();
  }
});

it('rejects an answer whose resolver transaction began before expiry but waited on the task lock', async () => {
  const f = await fixture();
  let taskId = '';
  let approvalId = '';
  let deadline = new Date(0);
  let releaseTask!: () => void;
  let signalTaskLock!: () => void;
  let signalResolverStarted!: () => void;
  const holdTask = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  const taskLocked = new Promise<void>((resolve) => {
    signalTaskLock = resolve;
  });
  const resolverStarted = new Promise<void>((resolve) => {
    signalResolverStarted = resolve;
  });
  let holder: Promise<void> | undefined;
  let resolving: Promise<Awaited<ReturnType<typeof resolveApproval>>> | undefined;
  try {
    taskId = await f.task({ pendingApprovals: [] });
    approvalId = await f.approval(taskId, new Date(Date.now() + 60_000));
    await f.db
      .update(tasks)
      .set({ state: { pendingApprovals: [{ approvalId }] } })
      .where(eq(tasks.id, taskId));
    deadline = new Date(Date.now() + 5_000);
    await f.db.update(approvals).set({ expiresAt: deadline }).where(eq(approvals.id, approvalId));

    holder = f.db.transaction(async (tx) => {
      await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
      signalTaskLock();
      await holdTask;
    });
    await waitBounded(taskLocked, 'task lock was not acquired in time');

    const resolverPromise = f.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '8s'`);
      await tx.execute(sql`set local statement_timeout = '10s'`);
      await tx.execute(sql`set local application_name = 'pg02-approval-deadline-lock'`);
      const started = await tx.execute<{ started_before_deadline: boolean }>(
        sql`select transaction_timestamp() < ${deadline.toISOString()}::timestamptz as started_before_deadline`,
      );
      expect(started[0]?.started_before_deadline).toBe(true);
      signalResolverStarted();
      return resolveApproval(tx as unknown as Db, {
        approvalId,
        decision: 'approved',
        via: 'web',
        deferNotification: true,
      });
    });
    resolving = resolverPromise;
    await waitBounded(
      Promise.race([
        resolverStarted,
        resolverPromise.then(() => {
          throw new Error('resolver completed before it could wait on the task lock');
        }),
      ]),
      'resolver did not start in time',
    );

    let queued = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await f.db.execute<{ waiting: boolean }>(sql`
        select exists (
          select 1 from pg_stat_activity
          where datname = current_database()
            and application_name = 'pg02-approval-deadline-lock'
            and wait_event_type = 'Lock'
            and query like '%"tasks"%'
        ) as waiting
      `);
      if (rows[0]?.waiting) {
        queued = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(queued).toBe(true);
    const remainingMs = deadline.getTime() - Date.now();
    if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs + 25));

    releaseTask();
    await holder;
    expect((await resolving).ok).toBe(false);
    const [approval] = await f.db.select().from(approvals).where(eq(approvals.id, approvalId));
    const [task] = await f.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(approval?.status).toBe('pending');
    expect(task).toMatchObject({ status: 'waiting_approval', queueGeneration: 0 });
  } finally {
    releaseTask?.();
    if (holder) await holder.catch(() => {});
    if (resolving) await resolving.catch(() => {});
    await f.dispose();
  }
}, 15_000);

it('expires multiple approvals for one task and wakes it once', async () => {
  const f = await fixture();
  const now = new Date('2026-09-12T12:00:00.000Z');
  try {
    const taskId = await f.task({ pendingApprovals: [] });
    const first = await f.approval(taskId, new Date(now.getTime() - 2_000));
    const second = await f.approval(taskId, new Date(now.getTime() - 1_000));
    await f.db
      .update(tasks)
      .set({ state: { pendingApprovals: [{ approvalId: first }, { approvalId: second }] } })
      .where(eq(tasks.id, taskId));

    const wakes = await f.repository.expireStale(200, now);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.taskId).toBe(taskId);
    expect(wakes[0]?.generation).toBe(1);
    const [task] = await f.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task).toMatchObject({ status: 'pending', queueGeneration: 1, leaseToken: null });
    const expired = await f.db
      .select({ status: approvals.status })
      .from(approvals)
      .where(inArray(approvals.id, [first, second]));
    expect(expired.map((row) => row.status)).toEqual(['expired', 'expired']);
    const denied = await f.db
      .select({ status: toolCalls.status, error: toolCalls.error })
      .from(toolCalls)
      .where(inArray(toolCalls.id, f.toolCallIds));
    expect(denied).toHaveLength(2);
    expect(denied.every((row) => row.status === 'denied' && row.error === 'approval expired')).toBe(
      true,
    );
  } finally {
    await f.dispose();
  }
});

it('uses a durable ID cursor to reach the next recovery page across repository instances', async () => {
  const f = await fixture();
  const now = new Date('2026-09-12T12:00:00.000Z');
  try {
    const firstTask = await f.task(
      { pendingApprovals: [] },
      'waiting_approval',
      '00000000-0000-4000-8000-000000000001',
    );
    const secondTask = await f.task(
      { pendingApprovals: [] },
      'waiting_approval',
      '00000000-0000-4000-8000-000000000002',
    );
    const firstApproval = await f.approval(firstTask, new Date(now.getTime() + 60_000));
    const secondApproval = await f.approval(
      secondTask,
      new Date(now.getTime() + 60_000),
      'approved',
    );
    await f.db
      .update(tasks)
      .set({ state: { pendingApprovals: [{ approvalId: firstApproval }] } })
      .where(eq(tasks.id, firstTask));
    await f.db
      .update(tasks)
      .set({ state: { pendingApprovals: [{ approvalId: secondApproval }] } })
      .where(eq(tasks.id, secondTask));

    expect(await f.repository.resumeResolved(1, now)).toEqual([]);
    const secondRepository = createPostgresApprovalRepository(f.db);
    expect(await secondRepository.resumeResolved(1, now)).toEqual([
      { taskId: secondTask, generation: 1 },
    ]);
  } finally {
    await f.dispose();
  }
});

it('wraps a durable cursor when its remaining range is empty', async () => {
  const f = await fixture();
  const now = new Date('2026-09-12T12:00:00.000Z');
  try {
    const highTask = await f.task(
      { pendingApprovals: [] },
      'waiting_approval',
      '00000000-0000-4000-8000-000000000100',
    );
    const highApproval = await f.approval(highTask, new Date(now.getTime() + 60_000), 'approved');
    await f.db
      .update(tasks)
      .set({ state: { pendingApprovals: [{ approvalId: highApproval }] } })
      .where(eq(tasks.id, highTask));
    expect(await f.repository.resumeResolved(1, now)).toEqual([
      { taskId: highTask, generation: 1 },
    ]);

    const lowTask = await f.task(
      { pendingApprovals: [] },
      'waiting_approval',
      '00000000-0000-4000-8000-000000000001',
    );
    const lowApproval = await f.approval(lowTask, new Date(now.getTime() + 60_000), 'approved');
    await f.db
      .update(tasks)
      .set({ state: { pendingApprovals: [{ approvalId: lowApproval }] } })
      .where(eq(tasks.id, lowTask));
    expect(await f.repository.resumeResolved(1, now)).toEqual([{ taskId: lowTask, generation: 1 }]);
  } finally {
    await f.dispose();
  }
});

it('does not expire a future approval or wake its parked task early', async () => {
  const f = await fixture();
  const now = new Date('2026-09-12T12:00:00.000Z');
  try {
    const taskId = await f.task({ pendingApprovals: [] });
    const approvalId = await f.approval(taskId, new Date(now.getTime() + 60_000));
    await f.db
      .update(tasks)
      .set({ state: { pendingApprovals: [{ approvalId }] } })
      .where(eq(tasks.id, taskId));

    expect(await f.repository.expireStale(200, now)).toEqual([]);
    expect(await f.repository.resumeResolved(200, now)).toEqual([]);
    const [task] = await f.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task?.status).toBe('waiting_approval');
  } finally {
    await f.dispose();
  }
});

it('resolution and expiry race to one terminal decision and one wake', async () => {
  const f = await fixture();
  const now = new Date('2026-09-12T12:00:00.000Z');
  try {
    const taskId = await f.task({ pendingApprovals: [] });
    const approvalId = await f.approval(taskId, new Date(now.getTime() - 1_000));
    await f.db
      .update(tasks)
      .set({ state: { pendingApprovals: [{ approvalId }] } })
      .where(eq(tasks.id, taskId));

    const [expired, resolved] = await Promise.all([
      f.repository.expireStale(200, now),
      f.repository.resolve({
        approvalId,
        decision: 'approved',
        via: 'web',
        deferNotification: true,
      }),
    ]);
    expect(Number(expired.length > 0) + Number(Boolean(resolved.wake))).toBe(1);
    const [approval] = await f.db.select().from(approvals).where(eq(approvals.id, approvalId));
    const [task] = await f.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(['approved', 'expired']).toContain(approval?.status);
    expect(task).toMatchObject({ status: 'pending', queueGeneration: 1 });
  } finally {
    await f.dispose();
  }
});

it('fails closed for stale, malformed, foreign, and cancelled recovery candidates', async () => {
  const f = await fixture();
  const now = new Date('2026-09-12T12:00:00.000Z');
  try {
    const missingTask = await f.task({ pendingApprovals: [{ approvalId: randomUUID() }] });
    const malformedTask = await f.task({ pendingApprovals: [{ nope: 'missing id' }] });
    const badUuidTask = await f.task({ pendingApprovals: [{ approvalId: 'not-a-uuid' }] });
    const cancelledTask = await f.task({ pendingApprovals: [] }, 'cancelled');
    const foreignTask = await f.task({ pendingApprovals: [] });
    const foreignApproval = await f.approval(
      foreignTask,
      new Date(now.getTime() - 1_000),
      'approved',
    );
    await f.db
      .update(tasks)
      .set({ state: { pendingApprovals: [{ approvalId: foreignApproval }] } })
      .where(eq(tasks.id, missingTask));
    await f.db
      .update(tasks)
      .set({ state: { pendingApprovals: [{ approvalId: foreignApproval }] } })
      .where(eq(tasks.id, cancelledTask));

    expect(await f.repository.resumeResolved(200, now)).toEqual([]);
    const rows = await f.db
      .select({ id: tasks.id, status: tasks.status, queueGeneration: tasks.queueGeneration })
      .from(tasks)
      .where(inArray(tasks.id, [missingTask, malformedTask, badUuidTask, cancelledTask]));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: missingTask,
          status: 'waiting_approval',
          queueGeneration: 0,
        }),
        expect.objectContaining({
          id: malformedTask,
          status: 'waiting_approval',
          queueGeneration: 0,
        }),
        expect.objectContaining({
          id: badUuidTask,
          status: 'waiting_approval',
          queueGeneration: 0,
        }),
        expect.objectContaining({ id: cancelledTask, status: 'cancelled', queueGeneration: 0 }),
      ]),
    );
  } finally {
    await f.dispose();
  }
});

it('validates maintenance batch and time arguments', async () => {
  const f = await fixture();
  try {
    await expect(f.repository.expireStale(201, new Date())).rejects.toThrow('batch');
    await expect(f.repository.resumeResolved(0, new Date())).rejects.toThrow('batch');
    await expect(f.repository.expireStale(1, new Date(Number.NaN))).rejects.toThrow('time');
    await expect(f.repository.resumeResolved(1, new Date(Number.NaN))).rejects.toThrow('time');
  } finally {
    await f.dispose();
  }
});
