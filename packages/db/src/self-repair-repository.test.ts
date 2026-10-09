import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { agents, costReservations, modelCalls, selfRepairIssues, tasks } from './schema.js';
import { createPostgresSelfRepairRepository } from './self-repair-repository.js';

it('deduplicates reports, atomically claims one repair and rejects stale writes', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const id = randomUUID();
  try {
    await db.insert(agents).values({
      id,
      name: 'Repair test',
      email: `${id}@example.test`,
      calendarId: 'primary',
      workspacePrefix: `repair-test-${id}`,
    });
    const repository = createPostgresSelfRepairRepository(db);
    const input = {
      fingerprint: 'same',
      source: 'feedback' as const,
      title: 'A synthetic failure',
      summary: 'Reproduce it',
    };
    const [a, b] = await Promise.all([repository.report(id, input), repository.report(id, input)]);
    expect(a.id).toBe(b.id);
    const newer = await repository.report(id, { ...input, fingerprint: 'another' });
    const blocked = await repository.update(a, 'blocked', {}, new Date());
    if (!blocked) throw new Error('Fixture update failed');
    await repository.update(blocked, 'reported', {}, new Date(Date.now() + 1000));
    const now = new Date();
    const claimed = await Promise.all([repository.claim(id, now, 2), repository.claim(id, now, 2)]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    const row = claimed.find(Boolean)!;
    expect(row.id).toBe(newer.id);
    const dispatched = await repository.update(
      row,
      'fixing',
      {
        dispatchedAt: now.toISOString(),
        workerProvider: 'openai_hosted',
        hostedSessionId: 'sess_saved',
        hostedTurnId: 'turn_saved',
        hostedCleanupPending: true,
      },
      now,
    );
    expect(dispatched).not.toBeNull();
    expect((await repository.list(id)).find((record) => record.id === row.id)?.data).toMatchObject({
      workerProvider: 'openai_hosted',
      hostedSessionId: 'sess_saved',
      hostedTurnId: 'turn_saved',
      hostedCleanupPending: true,
    });
    expect(await repository.update(row, 'failed', {}, now)).toBeNull();
    await repository.update(dispatched!, 'failed', {}, now);
    expect(
      (await repository.list(id)).find((record) => record.id === row.id)?.data.outcome,
    ).toMatchObject({ status: 'failed', stage: 'coding_dispatch' });
    expect(await repository.claim(id, now, 1)).toBeNull();
    const queued = (await repository.list(id)).find((item) => item.status === 'reported');
    if (!queued) throw new Error('Missing queued issue');
    await repository.update(queued, 'reported', { manualRunRequestedAt: now.toISOString() }, now);
    const manual = await repository.claim(id, now, 0);
    expect(manual?.id).toBe(queued.id);
    expect(manual?.data.manualRunRequestedAt).toBeUndefined();
    expect(manual?.data.manualRunStartedAt).toBe(now.toISOString());
    expect(await repository.claim(id, now, 0)).toBeNull();
    await expect(
      repository.report(id, { ...input, fingerprint: 'foreign', sourceTaskId: randomUUID() }),
    ).rejects.toThrow('outside the owner');
  } finally {
    await db.delete(selfRepairIssues).where(eq(selfRepairIssues.agentId, id));
    await db.delete(agents).where(eq(agents.id, id));
    await db.$client.end();
  }
});

it('persists retry eligibility and owner-scoped model accounting across repository instances', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const agentId = randomUUID();
  const taskId = randomUUID();
  try {
    await db.insert(agents).values({
      id: agentId,
      name: 'Repair retry accounting',
      email: `${agentId}@example.test`,
      workspacePrefix: `repair-account-${agentId}`,
    });
    await db.insert(tasks).values({ id: taskId, agentId, type: 'scheduled', status: 'done' });
    const repository = createPostgresSelfRepairRepository(db);
    let issue = await repository.report(agentId, {
      fingerprint: 'retryable',
      source: 'feedback',
      title: 'Temporary model outage',
      summary: 'Synthetic outage fixture',
    });
    const eligibleAt = new Date(Date.now() + 60_000);
    const queued = await repository.update(
      issue,
      'reported',
      { nextEligibleAt: eligibleAt.toISOString(), preDispatchRetryCount: 1 },
      new Date(),
    );
    if (!queued) throw new Error('Retry fixture update failed');
    issue = queued;
    expect(await createPostgresSelfRepairRepository(db).claim(agentId, new Date(), 2)).toBeNull();
    const claimed = await createPostgresSelfRepairRepository(db).claim(
      agentId,
      eligibleAt,
      2,
      taskId,
    );
    expect(claimed).toMatchObject({
      id: issue.id,
      status: 'investigating',
      data: { investigationTaskIds: [taskId], investigationStartedAt: eligibleAt.toISOString() },
    });
    await db.insert(modelCalls).values({
      taskId,
      role: 'reason',
      model: 'test/offline',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: '0.012345',
      createdAt: new Date(eligibleAt.getTime() + 1000),
    });
    await db.insert(costReservations).values({
      taskId,
      source: 'model',
      estimatedUsd: '0.020000',
      status: 'unknown',
      description: 'synthetic unresolved call',
      unknownReason: 'test hold',
    });
    if (!claimed) throw new Error('Retry claim was not restored');
    const recoveredAccounting = await createPostgresSelfRepairRepository(db).modelAccounting(
      agentId,
      claimed.data.investigationTaskIds ?? [],
      eligibleAt,
    );
    expect(recoveredAccounting).toEqual({
      observedModelCalls: 1,
      knownCostUsd: '0.012345',
      unresolvedReservations: 1,
      complete: false,
    });
  } finally {
    await db.delete(costReservations).where(eq(costReservations.taskId, taskId));
    await db.delete(modelCalls).where(eq(modelCalls.taskId, taskId));
    await db.delete(selfRepairIssues).where(eq(selfRepairIssues.agentId, agentId));
    await db.delete(tasks).where(eq(tasks.id, taskId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.$client.end();
  }
});

it('preserves an owner dismissal committed after automated candidate selection', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const ownerId = randomUUID();
  let release!: () => void;
  let selected!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    selected = resolve;
  });
  // Only pause delivery of an actual PostgreSQL SELECT result. No candidate,
  // update result or database state is mocked by this interleaving barrier.
  const pausedDb = new Proxy(db, {
    get(target, property) {
      if (property !== 'transaction') return Reflect.get(target, property);
      return (callback: Parameters<Db['transaction']>[0]) =>
        target.transaction((tx) => {
          const pausedTx = new Proxy(tx, {
            get(transaction, member) {
              if (member !== 'select') return Reflect.get(transaction, member);
              const wrap = (builder: object): object =>
                new Proxy(builder, {
                  get(query, method) {
                    if (method === 'limit')
                      return async (limit: number) => {
                        const rows = await Reflect.get(query, method).call(query, limit);
                        selected();
                        await gate;
                        return rows;
                      };
                    const value = Reflect.get(query, method);
                    return typeof value === 'function'
                      ? (...args: unknown[]) => wrap(value.apply(query, args))
                      : value;
                  },
                });
              return (...args: unknown[]) =>
                wrap(Reflect.apply(Reflect.get(transaction, member), transaction, args));
            },
          });
          return callback(pausedTx);
        });
    },
  });
  try {
    await db.insert(agents).values({
      id: ownerId,
      name: 'Dismissal race',
      email: `${ownerId}@example.test`,
      workspacePrefix: `repair-race-${ownerId}`,
    });
    const repository = createPostgresSelfRepairRepository(db);
    const issue = await repository.report(ownerId, {
      fingerprint: 'race',
      source: 'feedback',
      title: 'Dismiss this',
      summary: 'Reproduce the race',
    });
    const claim = createPostgresSelfRepairRepository(pausedDb).claim(ownerId, new Date(), 2);
    await ready;
    const dismissed = await repository.update(issue, 'dismissed', {}, new Date());
    expect(dismissed?.status).toBe('dismissed');
    release();
    expect(await claim).toBeNull();
    expect(await repository.list(ownerId)).toEqual([
      expect.objectContaining({ id: issue.id, status: 'dismissed', version: dismissed!.version }),
    ]);
  } finally {
    release();
    await db.delete(selfRepairIssues).where(eq(selfRepairIssues.agentId, ownerId));
    await db.delete(agents).where(eq(agents.id, ownerId));
    await db.$client.end();
  }
});
