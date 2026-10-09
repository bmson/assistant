import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { createDb } from './client.js';
import { createPostgresLocationPingRepository } from './location-ping-repository.js';
import { agents, conversations, missionReports, tasks } from './schema.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';

it('does not reclaim a PostgreSQL lease renewed after the expired-task scan', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const id = randomUUID();
  try {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    await db.insert(tasks).values({
      id,
      agentId: agent.id,
      type: 'adhoc',
      status: 'running',
      lockedUntil: new Date(0),
    });
    const renewedUntil = new Date(Date.now() + 600_000);
    // Deterministically pause between the scan's result and the recovery UPDATE.
    // The UPDATE itself and the following due-task query still execute on PostgreSQL.
    vi.spyOn(db, 'select').mockImplementationOnce(
      () =>
        ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => {
                  await db.update(tasks).set({ lockedUntil: renewedUntil }).where(eq(tasks.id, id));
                  return [{ id }];
                },
              }),
            }),
          }),
        }) as unknown as ReturnType<typeof db.select>,
    );
    await createPostgresTaskRepository(db).findDueTasks();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row).toMatchObject({
      status: 'running',
      reclaimCount: 0,
      queueGeneration: 0,
      lockedUntil: renewedUntil,
    });
  } finally {
    vi.restoreAllMocks();
    await db.delete(tasks).where(eq(tasks.id, id));
    await db.$client.end();
  }
});

it('persists plans only for the current owner lease', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const id = randomUUID();
  try {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    await db.insert(tasks).values({ id, agentId: agent.id, type: 'adhoc' });
    const repo = createPostgresTaskRepository(db);
    const first = await repo.claim(id);
    if (!first) throw new Error('Missing initial lease');

    // Reclaim the task so the first worker's token is stale.
    await db
      .update(tasks)
      .set({ lockedUntil: new Date(0) })
      .where(eq(tasks.id, id));
    const replacement = await repo.claim(id);
    if (!replacement) throw new Error('Missing replacement lease');

    expect(await repo.persistPlan(first, { stale: true })).toBe(false);
    expect(
      await repo.persistPlan({ ...replacement, agentId: randomUUID() }, { foreign: true }),
    ).toBe(false);
    expect(await repo.persistPlan(replacement, { steps: ['current'] })).toBe(true);
    expect((await db.select().from(tasks).where(eq(tasks.id, id)))[0]?.plan).toEqual({
      steps: ['current'],
    });
  } finally {
    await db.delete(tasks).where(eq(tasks.id, id));
    await db.$client.end();
  }
});

it('redacts an arrival reference on terminal completion while retaining safe daily dedupe', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const id = randomUUID();
  const observationId = randomUUID();
  const agentId = (await db.select().from(agents).limit(1))[0]?.id;
  if (!agentId) throw new Error('Seed the test database');
  const externalEventId = `arrival:${agentId}:2026-09-24`;
  try {
    await db.insert(tasks).values({
      id,
      agentId,
      type: 'adhoc',
      trust: 'assistant',
      externalEventId,
      title: 'generic arrival',
      state: { contextWindow: [{ role: 'user', content: 'private place: Harbour' }] },
      trigger: {
        source: 'internal',
        externalEventId,
        payload: {
          kind: 'arrival',
          arrivalObservationId: observationId,
          arrivalExpiresAt: '2026-09-24T12:05:00.000Z',
          instruction: 'generic location-free instruction',
        },
      },
    });
    const repository = createPostgresTaskRepository(db);
    const lease = await repository.claim(id);
    if (!lease) throw new Error('Could not claim arrival task');
    expect(await repository.completeTask(lease, { status: 'done' })).toBe(true);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row?.externalEventId).toBe(externalEventId);
    expect(
      await createPostgresLocationPingRepository(db).hasArrivalTaskSince(
        agentId,
        new Date(Date.now() - 60_000),
      ),
    ).toBe(true);
    expect(row?.title).toBeNull();
    expect(row?.state).toEqual({});
    expect(row?.trigger).toMatchObject({ payload: { kind: 'arrival' } });
    expect(JSON.stringify(row?.trigger)).not.toContain(observationId);
    expect(JSON.stringify(row?.trigger)).not.toContain('arrivalExpiresAt');
    expect(JSON.stringify(row?.trigger)).not.toContain('instruction');
  } finally {
    await db.delete(tasks).where(eq(tasks.id, id));
    await db.$client.end();
  }
});

it('atomically reports failed mission sessions and generic mission terminal states', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const missionId = randomUUID();
  const sessionId = randomUUID();
  const cancelledMissionId = randomUUID();
  const cancelledSessionId = randomUUID();
  const genericMissionId = randomUUID();
  try {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    await db.insert(tasks).values([
      { id: missionId, agentId: agent.id, type: 'mission', status: 'sleeping', trust: 'owner' },
      {
        id: sessionId,
        agentId: agent.id,
        parentTaskId: missionId,
        type: 'adhoc',
        status: 'pending',
        trust: 'owner',
      },
      {
        id: cancelledMissionId,
        agentId: agent.id,
        type: 'mission',
        status: 'sleeping',
        trust: 'owner',
      },
      {
        id: cancelledSessionId,
        agentId: agent.id,
        parentTaskId: cancelledMissionId,
        type: 'adhoc',
        status: 'pending',
        trust: 'owner',
      },
      {
        id: genericMissionId,
        agentId: agent.id,
        type: 'mission',
        status: 'pending',
        trust: 'owner',
      },
    ]);
    const repository = createPostgresTaskRepository(db);
    const sessionLease = await repository.claim(sessionId);
    if (!sessionLease) throw new Error('Could not claim the mission session');
    expect(
      await repository.completeTask(sessionLease, {
        status: 'failed',
        progress: 'Do not copy unverified provider claims into the owner notice.',
      }),
    ).toBe(true);
    expect(await repository.completeTask(sessionLease, { status: 'failed' })).toBe(false);

    const [mission] = await db.select().from(tasks).where(eq(tasks.id, missionId));
    expect(mission).toMatchObject({
      status: 'needs_attention',
      progress: 'A mission work session ended and needs review before the mission can continue.',
      leaseToken: null,
    });
    const [sessionReport] = await db
      .select()
      .from(missionReports)
      .where(eq(missionReports.id, `mission:${missionId}:session:${sessionId}:terminal:failed`));
    expect(sessionReport).toMatchObject({
      missionId,
      outcome: 'session_failed',
      chatStatus: 'pending',
      ownerStatus: 'pending',
    });
    expect(sessionReport?.text).not.toContain('unverified provider claims');

    const cancelledLease = await repository.claim(cancelledSessionId);
    if (!cancelledLease) throw new Error('Could not claim the mission session to cancel');
    expect(await repository.completeTask(cancelledLease, { status: 'cancelled' })).toBe(true);
    const [cancelledReport] = await db
      .select()
      .from(missionReports)
      .where(
        eq(
          missionReports.id,
          `mission:${cancelledMissionId}:session:${cancelledSessionId}:terminal:cancelled`,
        ),
      );
    expect(cancelledReport?.outcome).toBe('session_cancelled');
    expect((await db.select().from(tasks).where(eq(tasks.id, cancelledMissionId)))[0]?.status).toBe(
      'needs_attention',
    );

    const missionLease = await repository.claim(genericMissionId);
    if (!missionLease) throw new Error('Could not claim the generic mission');
    expect(
      await repository.completeTask(missionLease, {
        status: 'done',
        progress: 'This generic status must not imply an external action succeeded.',
      }),
    ).toBe(true);
    const [genericReport] = await db
      .select()
      .from(missionReports)
      .where(eq(missionReports.id, `mission:${genericMissionId}:task-terminal:done`));
    expect(genericReport?.outcome).toBe('task_done');
    expect(genericReport?.text).toContain('does not verify external delivery');
    expect(genericReport?.text).not.toContain('external action succeeded');
  } finally {
    await db
      .delete(tasks)
      .where(
        inArray(tasks.id, [
          sessionId,
          missionId,
          cancelledSessionId,
          cancelledMissionId,
          genericMissionId,
        ]),
      );
    await db.$client.end();
  }
});

it('rolls back a dead-lettered mission session when its durable report cannot be written, then recovers once', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const missionId = randomUUID();
  const sessionId = randomUUID();
  const rootMissionId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `test_fail_mission_report_${suffix}`;
  const triggerName = `test_fail_mission_report_${suffix}`;
  let triggerInstalled = false;
  try {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    await db.insert(tasks).values([
      { id: missionId, agentId: agent.id, type: 'mission', status: 'sleeping', trust: 'owner' },
      {
        id: rootMissionId,
        agentId: agent.id,
        type: 'mission',
        status: 'pending',
        attempt: 7,
        trust: 'owner',
      },
      {
        id: sessionId,
        agentId: agent.id,
        parentTaskId: missionId,
        type: 'adhoc',
        status: 'pending',
        attempt: 7,
        trust: 'owner',
      },
    ]);
    await db.execute(
      sql.raw(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = 'mission:${missionId}:session:${sessionId}:terminal:needs_attention:attempt:8' THEN RAISE EXCEPTION 'injected report write failure'; END IF; RETURN NEW; END $$`,
      ),
    );
    await db.execute(
      sql.raw(
        `CREATE TRIGGER ${triggerName} BEFORE INSERT ON mission_reports FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      ),
    );
    triggerInstalled = true;

    const repository = createPostgresTaskRepository(db);
    const lease = await repository.claim(sessionId);
    if (!lease) throw new Error('Could not claim mission session');
    await expect(repository.recordFailedAttempt(lease, 'synthetic failure')).rejects.toThrow(
      'mission_reports',
    );
    expect(await db.select().from(tasks).where(eq(tasks.id, sessionId))).toMatchObject([
      { status: 'running', attempt: 7 },
    ]);
    expect(await db.select().from(tasks).where(eq(tasks.id, missionId))).toMatchObject([
      { status: 'sleeping' },
    ]);
    expect(
      await db.select().from(missionReports).where(eq(missionReports.missionId, missionId)),
    ).toEqual([]);

    await db.execute(sql.raw(`DROP TRIGGER ${triggerName} ON mission_reports`));
    await db.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
    triggerInstalled = false;
    expect(await repository.recordFailedAttempt(lease, 'synthetic failure')).toBe('dead_letter');
    expect(await repository.recordFailedAttempt(lease, 'duplicate delivery')).toBe('lost_lease');
    expect(await db.select().from(tasks).where(eq(tasks.id, sessionId))).toMatchObject([
      { status: 'needs_attention', attempt: 8 },
    ]);
    expect(await db.select().from(tasks).where(eq(tasks.id, missionId))).toMatchObject([
      { status: 'needs_attention' },
    ]);
    const reports = await db
      .select()
      .from(missionReports)
      .where(eq(missionReports.missionId, missionId));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: 'session_needs_attention' });
    expect(reports[0]?.text).toContain('does not verify external delivery');

    const rootLease = await repository.claim(rootMissionId);
    if (!rootLease) throw new Error('Could not claim root mission');
    expect(await repository.recordFailedAttempt(rootLease, 'root synthetic failure')).toBe(
      'dead_letter',
    );
    const [rootReport] = await db
      .select()
      .from(missionReports)
      .where(
        eq(missionReports.id, `mission:${rootMissionId}:task-terminal:needs_attention:attempt:8`),
      );
    expect(rootReport?.outcome).toBe('task_needs_attention');
    expect(rootReport?.text).toContain('does not verify external delivery');
  } finally {
    if (triggerInstalled) {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON mission_reports`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
    }
    await db.delete(tasks).where(inArray(tasks.id, [sessionId, missionId, rootMissionId]));
    await db.$client.end();
  }
});

it('returns only the ten preceding owner tasks for the same conversation and task type', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const ids = Array.from({ length: 12 }, () => randomUUID());
  const otherId = randomUUID();
  const conversationId = randomUUID();
  const otherConversationId = randomUUID();
  try {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    await db.insert(conversations).values([
      { id: conversationId, agentId: agent.id, channel: 'chat', trust: 'owner' },
      { id: otherConversationId, agentId: agent.id, channel: 'chat', trust: 'owner' },
    ]);
    const createdAt = new Date(Date.now() - 60_000);
    await db.insert(tasks).values([
      ...ids.map((id, index) => ({
        id,
        agentId: agent.id,
        conversationId,
        type: 'chat_turn',
        trust: 'owner' as const,
        createdAt: new Date(createdAt.getTime() + index * 1000),
        trigger: { payload: { text: `turn ${index}` } },
      })),
      {
        id: otherId,
        agentId: agent.id,
        conversationId: otherConversationId,
        type: 'chat_turn',
        trust: 'owner',
        createdAt: new Date(createdAt.getTime() + 20_000),
      },
    ]);
    const rows = await createPostgresTaskRepository(db).precedingOwnerTasks({
      agentId: agent.id,
      conversationId,
      taskType: 'chat_turn',
      createdBefore: new Date(createdAt.getTime() + 12_000),
      limit: 10,
    });
    expect(rows.map((row) => row.id)).toEqual(ids.slice(2).reverse());
  } finally {
    await db.delete(tasks).where(inArray(tasks.id, [...ids, otherId]));
    await db
      .delete(conversations)
      .where(inArray(conversations.id, [conversationId, otherConversationId]));
    await db.$client.end();
  }
});

it('creates at most five owned scheduled children atomically and preserves taint', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const parentId = randomUUID();
  const childIds: string[] = [];
  try {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('Seed the test database');
    await db.insert(tasks).values({
      id: parentId,
      agentId: agent.id,
      type: 'chat_turn',
      trust: 'owner',
      status: 'pending',
    });
    const repo = createPostgresTaskRepository(db);
    const runAfter = new Date(Date.now() + 60_000);
    const results = await Promise.allSettled(
      Array.from({ length: 7 }, (_, index) =>
        repo.createScheduledFollowUp({
          parentTaskId: parentId,
          agentId: agent.id,
          instruction: `follow-up ${index}`,
          runAfter,
          trust: 'assistant',
          tainted: true,
        }),
      ),
    );
    const created = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value.task] : [],
    );
    childIds.push(...created.map((task) => task.id));
    expect(created).toHaveLength(5);
    expect(created.every((task) => task.parentTaskId === parentId)).toBe(true);
    expect(created.every((task) => task.agentId === agent.id)).toBe(true);
    expect(created.every((task) => task.trust === 'assistant')).toBe(true);
    expect(created.every((task) => task.status === 'sleeping')).toBe(true);
    expect(created.every((task) => task.runAfter?.getTime() === runAfter.getTime())).toBe(true);
    const due = await repo.findDueTasks(200);
    expect(due.some((task) => childIds.includes(task.id))).toBe(false);
    expect(
      created.every(
        (task) =>
          (task.trigger as { payload?: { taintedOrigin?: unknown } }).payload?.taintedOrigin ===
          true,
      ),
    ).toBe(true);
    await expect(
      repo.createScheduledFollowUp({
        parentTaskId: parentId,
        agentId: randomUUID(),
        instruction: 'foreign parent',
        runAfter,
        trust: 'owner',
        tainted: false,
      }),
    ).rejects.toThrow('another agent');
    await expect(
      repo.createScheduledFollowUp({
        parentTaskId: parentId,
        agentId: agent.id,
        instruction: 'past wake',
        runAfter: new Date(0),
        trust: 'owner',
        tainted: false,
      }),
    ).rejects.toThrow('future');
  } finally {
    if (childIds.length) await db.delete(tasks).where(inArray(tasks.id, childIds));
    await db.delete(tasks).where(eq(tasks.id, parentId));
    await db.$client.end();
  }
});
