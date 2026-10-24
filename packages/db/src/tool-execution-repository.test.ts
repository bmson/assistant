import { randomUUID } from 'node:crypto';
import { approvalPolicyFingerprint } from '@assistant/persistence';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteApprovalPolicy, setApprovalPolicyEnabled } from './approval-policy-repository.js';
import { createApproval, resolveApproval } from './approval-repository.js';
import { createDb, type Db } from './client.js';
import { agents, approvalPolicies, approvals, tasks, toolCalls } from './schema.js';
import { createPostgresToolExecutionRepository } from './tool-execution-repository.js';

const DATABASE_URL = process.env.DATABASE_URL;
const RACE_POOL_OPTIONS = {
  max: 8,
  connectTimeoutSeconds: 3,
  idleTimeoutSeconds: 3,
  statementTimeoutMs: 8_000,
} as const;
const RACE_OBSERVER_POOL_OPTIONS = {
  max: 1,
  connectTimeoutSeconds: 3,
  idleTimeoutSeconds: 3,
  statementTimeoutMs: 1_000,
} as const;
const testUrl = () => {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
};

function withTransactionApplicationName(database: Db, applicationName: string): Db {
  const transaction = database.transaction.bind(database);
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return (...args: Parameters<Db['transaction']>) => {
        const [callback, options] = args;
        return transaction(async (tx) => {
          await tx.execute(sql`select set_config('application_name', ${applicationName}, true)`);
          return callback(tx);
        }, options);
      };
    },
  }) as Db;
}

async function holdPostgresOwnerFence(database: Db, agentId: string) {
  let release!: () => void;
  let acquired!: (pid: number) => void;
  let rejectAcquired!: (error: unknown) => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<number>((resolve, reject) => {
    acquired = resolve;
    rejectAcquired = reject;
  });
  const blocker = database.$client.begin(async (tx) => {
    const [backend] = await tx<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
    if (!backend) throw new Error('Could not identify owner-fence blocker backend');
    await tx`select id from agents where id = ${agentId} for no key update`;
    acquired(backend.pid);
    await hold;
  });
  void blocker.catch(rejectAcquired);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const blockerPid = await new Promise<number>((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Timed out acquiring owner-fence blocker')),
        5_000,
      );
      locked.then(resolve, reject);
    });
    return { blockerPid, release, blocker };
  } catch (error) {
    release();
    await blocker.catch(() => undefined);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForOwnerFenceWaiter(
  database: Db,
  applicationName: string,
  blockerPid: number,
  priorWaiterPid?: number,
): Promise<number> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const rows = await database.$client<{ pid: number; blockers: number[] }[]>`
      select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and application_name = ${applicationName}
        and state = 'active' and wait_event_type = 'Lock'
        and query ilike '%for no key update%'
    `;
    const waiter = rows.find(
      (row) =>
        row.blockers.includes(blockerPid) &&
        (priorWaiterPid === undefined || row.blockers.includes(priorWaiterPid)),
    );
    if (waiter) return waiter.pid;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `Timed out observing ${applicationName} blocked by owner-fence backend ${blockerPid}`,
  );
}

describe('PostgreSQL tool execution repository', () => {
  let db: Db | undefined;
  let raceObserverDb: Db | undefined;
  const taskIds: string[] = [];
  const callIds: string[] = [];
  const approvalIds: string[] = [];
  const policyIds: string[] = [];
  let extraAgent: string | undefined;

  afterEach(async () => {
    if (!db) return;
    try {
      if (callIds.length)
        await db.update(toolCalls).set({ approvalId: null }).where(inArray(toolCalls.id, callIds));
      if (approvalIds.length) await db.delete(approvals).where(inArray(approvals.id, approvalIds));
      if (callIds.length) await db.delete(toolCalls).where(inArray(toolCalls.id, callIds));
      if (policyIds.length)
        await db.delete(approvalPolicies).where(inArray(approvalPolicies.id, policyIds));
      if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
      if (extraAgent) await db.delete(agents).where(eq(agents.id, extraAgent));
    } finally {
      await Promise.allSettled([db.$client.end(), raceObserverDb?.$client.end()]);
      db = undefined;
      raceObserverDb = undefined;
      taskIds.length = 0;
      callIds.length = 0;
      approvalIds.length = 0;
      policyIds.length = 0;
      extraAgent = undefined;
    }
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

  it('rejects a stale autonomous policy snapshot and starts once against the unchanged tool scope', async () => {
    db = createDb(testUrl());
    extraAgent = randomUUID();
    await db.insert(agents).values({
      id: extraAgent,
      name: `tool-start-${extraAgent.slice(0, 8)}`,
      email: `${extraAgent}@tool-start.invalid`,
      workspacePrefix: `tool-start/${extraAgent}`,
    });
    const taskId = randomUUID();
    taskIds.push(taskId);
    await db.insert(tasks).values({
      id: taskId,
      agentId: extraAgent,
      type: 'chat_turn',
      trust: 'owner',
      status: 'running',
    });
    const [policy] = await db
      .insert(approvalPolicies)
      .values({
        agentId: extraAgent,
        toolName: 'test.autonomous',
        templateKey: 'test.allow',
        match: {},
        effect: 'allow',
        enabled: true,
        createdVia: 'settings',
      })
      .returning();
    if (!policy) throw new Error('policy insert failed');
    policyIds.push(policy.id);
    const enabledFingerprint = approvalPolicyFingerprint([policy]);
    await db
      .update(approvalPolicies)
      .set({ enabled: false })
      .where(eq(approvalPolicies.id, policy.id));
    const [disabledPolicy] = await db
      .select()
      .from(approvalPolicies)
      .where(eq(approvalPolicies.id, policy.id));
    if (!disabledPolicy) throw new Error('disabled policy disappeared');

    const repository = createPostgresToolExecutionRepository(db);
    const startInput = {
      agentId: extraAgent,
      taskId,
      step: 1,
      toolName: 'test.autonomous',
      args: { value: 'bounded' },
      idempotencyKey: null,
      decision: { modelToolCallId: 'model-autonomous-start-1' },
    };
    await expect(
      repository.start({ ...startInput, expectedPolicyFingerprint: enabledFingerprint }),
    ).resolves.toBeNull();
    await expect(
      db.select().from(toolCalls).where(eq(toolCalls.taskId, taskId)),
    ).resolves.toHaveLength(0);

    await db.delete(approvalPolicies).where(eq(approvalPolicies.id, policy.id));
    const disabledFingerprint = approvalPolicyFingerprint([disabledPolicy]);
    await expect(
      repository.start({ ...startInput, expectedPolicyFingerprint: disabledFingerprint }),
    ).resolves.toBeNull();

    const [unrelatedPolicy] = await db
      .insert(approvalPolicies)
      .values({
        agentId: extraAgent,
        toolName: 'test.other',
        templateKey: 'test.allow',
        match: {},
        effect: 'allow',
        enabled: true,
        createdVia: 'settings',
      })
      .returning();
    if (!unrelatedPolicy) throw new Error('unrelated policy insert failed');
    policyIds.push(unrelatedPolicy.id);
    await expect(
      repository.start({
        ...startInput,
        expectedPolicyFingerprint: approvalPolicyFingerprint([unrelatedPolicy]),
      }),
    ).resolves.toBeNull();

    const currentScopeInput = {
      ...startInput,
      expectedPolicyFingerprint: approvalPolicyFingerprint([]),
    };
    const starts = await Promise.all([
      repository.start(currentScopeInput),
      repository.start(currentScopeInput),
    ]);
    const winner = starts.find((row) => row !== null);
    expect(starts.filter(Boolean)).toHaveLength(1);
    expect(winner).toMatchObject({ status: 'executing', toolName: 'test.autonomous' });
    if (!winner) throw new Error('autonomous start did not persist');
    callIds.push(winner.id);
    await expect(repository.start(currentScopeInput)).resolves.toBeNull();
    await expect(
      db.select().from(toolCalls).where(eq(toolCalls.taskId, taskId)),
    ).resolves.toHaveLength(1);
  });

  it('serializes actual policy disable and autonomous start in either lock-acquisition order', async () => {
    db = createDb(testUrl(), RACE_POOL_OPTIONS);
    const connection = db;
    const observer = createDb(testUrl(), RACE_OBSERVER_POOL_OPTIONS);
    raceObserverDb = observer;
    extraAgent = randomUUID();
    await db.insert(agents).values({
      id: extraAgent,
      name: `tool-race-${extraAgent.slice(0, 8)}`,
      email: `${extraAgent}@tool-race.invalid`,
      workspacePrefix: `tool-race/${extraAgent}`,
    });
    const taskId = randomUUID();
    taskIds.push(taskId);
    await db.insert(tasks).values({
      id: taskId,
      agentId: extraAgent,
      type: 'chat_turn',
      trust: 'owner',
      status: 'running',
    });
    const [policy] = await db
      .insert(approvalPolicies)
      .values({
        agentId: extraAgent,
        toolName: 'test.autonomous-race',
        templateKey: 'calendar.self_only_events',
        match: {},
        effect: 'allow',
        enabled: true,
        createdVia: 'settings',
      })
      .returning();
    if (!policy) throw new Error('race policy insert failed');
    policyIds.push(policy.id);
    const repository = createPostgresToolExecutionRepository(db);
    const enabledFingerprint = approvalPolicyFingerprint([policy]);
    const base = {
      agentId: extraAgent,
      taskId,
      step: 1,
      toolName: policy.toolName,
      args: { value: 'race' },
      idempotencyKey: null,
    };

    // The winner is identified by its own PostgreSQL application name. The
    // second request must report the first request as a blocker, so the result
    // does not rely on an assumed FIFO order or unrelated database waiters.
    const disableName = `policy-disable-${randomUUID().slice(0, 8)}`;
    const startName = `policy-start-${randomUUID().slice(0, 8)}`;
    let disableFirst: Promise<boolean> | undefined;
    let staleStart: ReturnType<typeof repository.start> | undefined;
    const firstFence = await holdPostgresOwnerFence(connection, extraAgent);
    try {
      disableFirst = setApprovalPolicyEnabled(
        withTransactionApplicationName(db, disableName),
        extraAgent,
        policy.id,
        false,
      );
      const disablePid = await waitForOwnerFenceWaiter(
        observer,
        disableName,
        firstFence.blockerPid,
      );
      staleStart = createPostgresToolExecutionRepository(
        withTransactionApplicationName(db, startName),
      ).start({
        ...base,
        decision: { modelToolCallId: 'pg-policy-disable-first' },
        expectedPolicyFingerprint: enabledFingerprint,
      });
      const startPid = await waitForOwnerFenceWaiter(
        observer,
        startName,
        firstFence.blockerPid,
        disablePid,
      );
      expect(startPid).not.toBe(disablePid);
      firstFence.release();
      await firstFence.blocker;
      expect(await disableFirst).toBe(true);
      await expect(staleStart).resolves.toBeNull();
      const [afterDisable] = await db
        .select()
        .from(approvalPolicies)
        .where(eq(approvalPolicies.id, policy.id));
      if (!afterDisable) throw new Error('policy disappeared after disable');
      const disabledFingerprint = approvalPolicyFingerprint([afterDisable]);

      // Reverse the order. Start owns the fence first, then the real disable
      // queues behind it. Once start commits, revocation cannot roll back that
      // already durable authorization snapshot.
      expect(await setApprovalPolicyEnabled(db, extraAgent, policy.id, true)).toBe(true);
      const [reenabled] = await db
        .select()
        .from(approvalPolicies)
        .where(eq(approvalPolicies.id, policy.id));
      if (!reenabled) throw new Error('policy disappeared after re-enable');
      const startFirstName = `policy-start-first-${randomUUID().slice(0, 8)}`;
      const disableSecondName = `policy-disable-second-${randomUUID().slice(0, 8)}`;
      let startFirst: ReturnType<typeof repository.start> | undefined;
      let disableSecond: Promise<boolean> | undefined;
      const secondFence = await holdPostgresOwnerFence(connection, extraAgent);
      try {
        startFirst = createPostgresToolExecutionRepository(
          withTransactionApplicationName(db, startFirstName),
        ).start({
          ...base,
          decision: { modelToolCallId: 'pg-policy-start-first' },
          expectedPolicyFingerprint: approvalPolicyFingerprint([reenabled]),
        });
        const startPid = await waitForOwnerFenceWaiter(
          observer,
          startFirstName,
          secondFence.blockerPid,
        );
        disableSecond = setApprovalPolicyEnabled(
          withTransactionApplicationName(db, disableSecondName),
          extraAgent,
          policy.id,
          false,
        );
        const disablePid = await waitForOwnerFenceWaiter(
          observer,
          disableSecondName,
          secondFence.blockerPid,
          startPid,
        );
        expect(disablePid).not.toBe(startPid);
        secondFence.release();
        await secondFence.blocker;
        const started = await startFirst;
        expect(started).toMatchObject({ status: 'executing', toolName: policy.toolName });
        if (!started) throw new Error('start-first transaction did not commit');
        callIds.push(started.id);
        expect(await disableSecond).toBe(true);
        const [afterRevoke] = await db
          .select()
          .from(approvalPolicies)
          .where(eq(approvalPolicies.id, policy.id));
        expect(afterRevoke?.enabled).toBe(false);
        const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, taskId));
        expect(calls.filter((call) => call.toolName === policy.toolName)).toHaveLength(1);
        expect(disabledFingerprint).not.toBe(enabledFingerprint);
      } finally {
        secondFence.release();
        await secondFence.blocker;
        await Promise.allSettled([startFirst, disableSecond]);
      }
    } finally {
      firstFence.release();
      await firstFence.blocker;
      await Promise.allSettled([disableFirst, staleStart]);
    }
  });

  it('serializes actual policy deletion and autonomous start in either lock-acquisition order', async () => {
    db = createDb(testUrl(), RACE_POOL_OPTIONS);
    const connection = db;
    const observer = createDb(testUrl(), RACE_OBSERVER_POOL_OPTIONS);
    raceObserverDb = observer;
    extraAgent = randomUUID();
    await db.insert(agents).values({
      id: extraAgent,
      name: `tool-delete-race-${extraAgent.slice(0, 8)}`,
      email: `${extraAgent}@tool-delete-race.invalid`,
      workspacePrefix: `tool-delete-race/${extraAgent}`,
    });
    const taskId = randomUUID();
    taskIds.push(taskId);
    await db.insert(tasks).values({
      id: taskId,
      agentId: extraAgent,
      type: 'chat_turn',
      trust: 'owner',
      status: 'running',
    });
    const repository = createPostgresToolExecutionRepository(db);
    const toolName = 'test.autonomous-delete-race';
    const base = {
      agentId: extraAgent,
      taskId,
      step: 1,
      toolName,
      args: { value: 'delete-race' },
      idempotencyKey: null,
    };

    const [deleteFirstPolicy] = await db
      .insert(approvalPolicies)
      .values({
        agentId: extraAgent,
        toolName,
        templateKey: 'test.allow',
        match: {},
        effect: 'allow',
        enabled: true,
        createdVia: 'settings',
      })
      .returning();
    if (!deleteFirstPolicy) throw new Error('delete-first policy insert failed');
    policyIds.push(deleteFirstPolicy.id);
    const deleteFirstFingerprint = approvalPolicyFingerprint([deleteFirstPolicy]);

    const deleteName = `policy-delete-${randomUUID().slice(0, 8)}`;
    const startName = `policy-delete-start-${randomUUID().slice(0, 8)}`;
    let deletion: Promise<boolean> | undefined;
    let staleStart: ReturnType<typeof repository.start> | undefined;
    const firstFence = await holdPostgresOwnerFence(connection, extraAgent);
    try {
      deletion = deleteApprovalPolicy(
        withTransactionApplicationName(db, deleteName),
        extraAgent,
        deleteFirstPolicy.id,
      );
      const deletePid = await waitForOwnerFenceWaiter(observer, deleteName, firstFence.blockerPid);
      staleStart = createPostgresToolExecutionRepository(
        withTransactionApplicationName(db, startName),
      ).start({
        ...base,
        decision: { modelToolCallId: 'pg-policy-delete-first' },
        expectedPolicyFingerprint: deleteFirstFingerprint,
      });
      const startPid = await waitForOwnerFenceWaiter(
        observer,
        startName,
        firstFence.blockerPid,
        deletePid,
      );
      expect(startPid).not.toBe(deletePid);
      firstFence.release();
      await firstFence.blocker;
      expect(await deletion).toBe(true);
      await expect(staleStart).resolves.toBeNull();
      await expect(
        db.select().from(toolCalls).where(eq(toolCalls.taskId, taskId)),
      ).resolves.toHaveLength(0);
    } finally {
      firstFence.release();
      await firstFence.blocker;
      await Promise.allSettled([deletion, staleStart]);
    }

    const [startFirstPolicy] = await db
      .insert(approvalPolicies)
      .values({
        agentId: extraAgent,
        toolName,
        templateKey: 'test.allow',
        match: {},
        effect: 'allow',
        enabled: true,
        createdVia: 'settings',
      })
      .returning();
    if (!startFirstPolicy) throw new Error('start-first policy insert failed');
    policyIds.push(startFirstPolicy.id);
    const startAfterDeleteName = `policy-delete-start-first-${randomUUID().slice(0, 8)}`;
    const deleteAfterStartName = `policy-delete-after-start-${randomUUID().slice(0, 8)}`;
    let start: ReturnType<typeof repository.start> | undefined;
    let laterDeletion: Promise<boolean> | undefined;
    const secondFence = await holdPostgresOwnerFence(connection, extraAgent);
    try {
      start = createPostgresToolExecutionRepository(
        withTransactionApplicationName(db, startAfterDeleteName),
      ).start({
        ...base,
        decision: { modelToolCallId: 'pg-policy-start-before-delete' },
        expectedPolicyFingerprint: approvalPolicyFingerprint([startFirstPolicy]),
      });
      const startPid = await waitForOwnerFenceWaiter(
        observer,
        startAfterDeleteName,
        secondFence.blockerPid,
      );
      laterDeletion = deleteApprovalPolicy(
        withTransactionApplicationName(db, deleteAfterStartName),
        extraAgent,
        startFirstPolicy.id,
      );
      const deletePid = await waitForOwnerFenceWaiter(
        observer,
        deleteAfterStartName,
        secondFence.blockerPid,
        startPid,
      );
      expect(deletePid).not.toBe(startPid);
      secondFence.release();
      await secondFence.blocker;
      const started = await start;
      expect(started).toMatchObject({ status: 'executing', toolName });
      if (!started) throw new Error('delete start-first transaction did not commit');
      callIds.push(started.id);
      expect(await laterDeletion).toBe(true);
      const remainingPolicies = await db
        .select()
        .from(approvalPolicies)
        .where(eq(approvalPolicies.agentId, extraAgent));
      expect(remainingPolicies).toHaveLength(0);
      const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, taskId));
      expect(calls.filter((call) => call.toolName === toolName)).toHaveLength(1);
    } finally {
      secondFence.release();
      await secondFence.blocker;
      await Promise.allSettled([start, laterDeletion]);
    }
  });

  it('rejects an empty policy snapshot when a real approval resolution inserts the policy first', async () => {
    db = createDb(testUrl(), RACE_POOL_OPTIONS);
    const connection = db;
    const observer = createDb(testUrl(), RACE_OBSERVER_POOL_OPTIONS);
    raceObserverDb = observer;
    extraAgent = randomUUID();
    await db.insert(agents).values({
      id: extraAgent,
      name: `tool-insert-race-${extraAgent.slice(0, 8)}`,
      email: `${extraAgent}@tool-insert-race.invalid`,
      workspacePrefix: `tool-insert-race/${extraAgent}`,
    });
    const taskId = randomUUID();
    taskIds.push(taskId);
    await db.insert(tasks).values({
      id: taskId,
      agentId: extraAgent,
      type: 'chat_turn',
      trust: 'owner',
      status: 'waiting_approval',
    });
    const toolName = 'test.autonomous-insert-race';
    const approval = await createApproval(db, {
      taskId,
      step: 0,
      toolName,
      args: { value: 'approval' },
      decision: { modelToolCallId: 'pg-policy-insert-approval' },
      summary: 'Create a narrowly scoped policy',
    });
    callIds.push(approval.toolCallId);
    approvalIds.push(approval.approvalId);
    const policy = {
      agentId: extraAgent,
      toolName,
      templateKey: 'test.allow',
      match: {},
      effect: 'allow' as const,
    };
    const resolverName = `policy-insert-resolver-${randomUUID().slice(0, 8)}`;
    const startName = `policy-insert-start-${randomUUID().slice(0, 8)}`;
    let resolution: ReturnType<typeof resolveApproval> | undefined;
    let start: Promise<unknown> | undefined;
    const holder = await holdPostgresOwnerFence(connection, extraAgent);
    try {
      resolution = resolveApproval(withTransactionApplicationName(db, resolverName), {
        approvalId: approval.approvalId,
        decision: 'approved',
        via: 'web',
        policy,
      });
      const resolverPid = await waitForOwnerFenceWaiter(observer, resolverName, holder.blockerPid);
      const startRepository = createPostgresToolExecutionRepository(
        withTransactionApplicationName(db, startName),
      );
      start = startRepository.start({
        agentId: extraAgent,
        taskId,
        step: 1,
        toolName,
        args: { value: 'empty-snapshot' },
        idempotencyKey: null,
        decision: { modelToolCallId: 'pg-empty-policy-start' },
        expectedPolicyFingerprint: approvalPolicyFingerprint([]),
      });
      const startPid = await waitForOwnerFenceWaiter(
        observer,
        startName,
        holder.blockerPid,
        resolverPid,
      );
      expect(startPid).not.toBe(resolverPid);
      holder.release();
      await holder.blocker;
      await expect(resolution).resolves.toMatchObject({ ok: true });
      await expect(start).resolves.toBeNull();
      const insertedPolicies = await db
        .select()
        .from(approvalPolicies)
        .where(eq(approvalPolicies.agentId, extraAgent));
      expect(insertedPolicies).toHaveLength(1);
      expect(insertedPolicies[0]).toMatchObject({ toolName, enabled: true });
      if (insertedPolicies[0]) policyIds.push(insertedPolicies[0].id);
      const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, taskId));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ toolName, risk: 'approval', status: 'approved' });
    } finally {
      holder.release();
      await holder.blocker;
      await Promise.allSettled([resolution, start]);
    }
  });
});
