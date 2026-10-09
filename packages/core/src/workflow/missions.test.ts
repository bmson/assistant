import {
  conversations,
  createDb,
  createPostgresMessageRepository,
  createPostgresMissionRepository,
  type Db,
  goals,
  messages,
  missionReports,
  schedules,
  tasks,
} from '@assistant/db';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAgent } from '../chat.js';
import type { Plan } from '../events.js';
import type { ModelRouter } from '../model-router/router.js';
import { claimTask, enqueueTask, taskState } from './machine.js';
import {
  missionCadenceLabel,
  nextMissionWakeAt,
  parseIntervalMs,
  type Reflection,
  repairMissionReports,
  requestedMissionFrequencyPerDay,
  startMission,
  startMissionWithReceipt,
  validateMissionCadence,
  wakeMission,
} from './missions.js';
import {
  ensureGoalAutomation,
  goalAutomationCadence,
  nextRun,
  runDueSchedules,
} from './schedules.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
let agentTimezone = 'America/Los_Angeles';
const cleanupTaskIds: string[] = [];
const cleanupScheduleIds: string[] = [];
const cleanupGoalIds: string[] = [];
const cleanupConversationIds: string[] = [];

function reflectingRouter(reflection: Reflection) {
  return {
    async object() {
      return { ok: true, modelId: 'fake', degraded: false, object: reflection };
    },
  } as unknown as ModelRouter;
}

const basePlan: Plan = {
  action: 'mission',
  reasoning: 'Watch mortgage rates',
  steps: ['check rates', 'compare offers'],
  missingInfo: [],
};

describe('mission admission boundaries', () => {
  const createTask = vi.fn();
  const store = { kind: 'task-lease-repository', createTask } as never;
  const plan: Plan = { ...basePlan };

  it.each([
    {
      name: 'a mission root',
      source: { type: 'mission', trust: 'owner', state: {} },
    },
    {
      name: 'a mission session child',
      source: {
        type: 'adhoc',
        trust: 'owner',
        state: {},
        parentTaskId: 'mission-1',
        trigger: {
          source: 'mission_wake',
          payload: { missionId: 'mission-1', instruction: 'continue' },
        },
      },
    },
    {
      name: 'an externally trusted task',
      source: { type: 'adhoc', trust: 'unknown', state: {} },
    },
    {
      name: 'a tainted task',
      source: { type: 'adhoc', trust: 'owner', state: { untrustedContext: true } },
    },
  ])('rejects root creation from $name before enqueue', async ({ source }) => {
    createTask.mockClear();
    await expect(
      startMission(
        store,
        { id: 'source-1', agentId: 'agent-1', ...source } as never,
        plan,
        'Do a mission',
      ),
    ).rejects.toThrow();
    expect(createTask).not.toHaveBeenCalled();
  });

  it('rejects an empty saved mission instruction', async () => {
    createTask.mockClear();
    await expect(
      startMission(
        store,
        {
          id: 'source-1',
          agentId: 'agent-1',
          type: 'chat_turn',
          trust: 'owner',
          state: {},
        } as never,
        plan,
        '  ',
      ),
    ).rejects.toThrow(/saved instruction/);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('rejects mission creation from any persisted descendant, even without the session marker', async () => {
    const create = vi.fn();
    const repository = {
      getTask: vi.fn(async () => ({
        id: 'mission-parent',
        type: 'mission',
        parentTaskId: null,
      })),
      createTask: create,
    } as never;
    await expect(
      startMission(
        repository,
        {
          id: 'unmarked-grandchild',
          agentId: 'agent-1',
          type: 'adhoc',
          trust: 'owner',
          state: {},
          parentTaskId: 'mission-parent',
          trigger: { source: 'internal', payload: {} },
        } as never,
        plan,
        'Do more work',
      ),
    ).rejects.toThrow(/cannot create another root mission/i);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('mission cadence', () => {
  it('validates an explicit twice-daily local schedule against the owner request', () => {
    const cadence = validateMissionCadence(
      {
        kind: 'local_times',
        timezone: 'America/Los_Angeles',
        times: ['08:00', '20:00'],
      },
      'America/Los_Angeles',
      'Check this twice daily at 08:00 and 20:00 in America/Los_Angeles.',
    );
    expect(requestedMissionFrequencyPerDay('Check twice daily.')).toBe(2);
    expect(missionCadenceLabel(cadence)).toContain('America/Los_Angeles');
    expect(() =>
      validateMissionCadence(
        { kind: 'interval', everyMinutes: 24 * 60 },
        'America/Los_Angeles',
        'Check this twice daily in America/Los_Angeles.',
      ),
    ).toThrow(/does not match the requested frequency/);
  });

  it('uses fixed elapsed intervals and skips missed interval occurrences after a delayed wake', () => {
    const createdAt = new Date('2026-03-07T18:00:00Z');
    const mission = {
      createdAt,
      trigger: {
        payload: { cadence: { kind: 'interval', everyMinutes: 12 * 60 } },
      },
    } as never;
    const delayedStart = new Date('2026-03-09T20:00:00Z');
    expect(nextMissionWakeAt(mission, delayedStart)).toEqual(new Date('2026-03-10T06:00:00Z'));
  });

  it('keeps wall-clock times in the named timezone across spring DST and skips missed runs', () => {
    const mission = {
      createdAt: new Date('2026-03-01T00:00:00Z'),
      trigger: {
        payload: {
          cadence: {
            kind: 'local_times',
            timezone: 'America/Los_Angeles',
            times: ['08:00', '20:00'],
          },
        },
      },
    } as never;
    const beforeSpringRun = new Date('2026-03-08T07:30:00Z');
    expect(nextMissionWakeAt(mission, beforeSpringRun)).toEqual(new Date('2026-03-08T15:00:00Z'));
    const afterBothLocalRuns = new Date('2026-03-09T05:00:00Z');
    expect(nextMissionWakeAt(mission, afterBothLocalRuns)).toEqual(
      new Date('2026-03-09T15:00:00Z'),
    );
  });

  it('skips a nonexistent spring time and does not repeat an ambiguous fall time', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const mission = {
      createdAt,
      trigger: {
        payload: {
          cadence: {
            kind: 'local_times',
            timezone: 'America/Los_Angeles',
            times: ['02:30'],
          },
        },
      },
    } as never;
    expect(nextMissionWakeAt(mission, new Date('2026-03-08T09:00:00Z'))).toEqual(
      new Date('2026-03-09T09:30:00Z'),
    );

    const fallMission = {
      createdAt,
      trigger: {
        payload: {
          cadence: {
            kind: 'local_times',
            timezone: 'America/Los_Angeles',
            times: ['01:30'],
          },
        },
      },
    } as never;
    expect(nextMissionWakeAt(fallMission, new Date('2026-11-01T08:45:00Z'))).toEqual(
      new Date('2026-11-02T09:30:00Z'),
    );
  });
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const agent = await getAgent(db);
    agentId = agent.id;
    agentTimezone = agent.timezone;
    dbUp = true;
  } catch {
    console.warn('missions.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    if (cleanupTaskIds.length) {
      let parents = [...new Set(cleanupTaskIds)];
      const descendantLevels: string[][] = [];
      for (let depth = 0; depth < 32 && parents.length > 0; depth += 1) {
        const children = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(inArray(tasks.parentTaskId, parents));
        parents = children.map(({ id }) => id);
        if (parents.length > 0) descendantLevels.push(parents);
      }
      const allTaskIds = [...cleanupTaskIds, ...descendantLevels.flat()];
      await db.delete(messages).where(inArray(messages.taskId, allTaskIds));
      await db.delete(missionReports).where(inArray(missionReports.missionId, cleanupTaskIds));
      for (const level of descendantLevels.reverse())
        await db.delete(tasks).where(inArray(tasks.id, level));
      await db.delete(tasks).where(inArray(tasks.id, cleanupTaskIds));
    }
    if (cleanupScheduleIds.length) {
      await db.delete(schedules).where(inArray(schedules.id, cleanupScheduleIds));
    }
    if (cleanupConversationIds.length) {
      await db.delete(conversations).where(inArray(conversations.id, cleanupConversationIds));
    }
    if (cleanupGoalIds.length) await db.delete(goals).where(inArray(goals.id, cleanupGoalIds));
    await db.delete(schedules).where(like(schedules.name, 'test-%'));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

async function makeSourceTask(goalId?: string) {
  const { task } = await enqueueTask(db, {
    event: { source: 'internal', agentId, trust: 'owner', payload: {} },
    type: 'adhoc',
    goalId,
  });
  cleanupTaskIds.push(task.id);
  return task;
}

describe('missions (integration, scripted model)', () => {
  it('startMission creates a first-class mission with deadline, budget cap, and reflect cadence', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const source = await makeSourceTask();
    const mission = await startMission(
      db,
      source,
      {
        ...basePlan,
        budgetSuggestionUsd: 50, // over the cap
        cadence: {
          kind: 'local_times',
          timezone: agentTimezone,
          times: ['08:00', '20:00'],
        },
      },
      'Watch mortgage rates for 3 months',
      {
        timezone: agentTimezone,
        ownerRequestText: `Check rates twice daily at 08:00 and 20:00 in ${agentTimezone}.`,
      },
    );
    cleanupTaskIds.push(mission.id);

    expect(mission.type).toBe('mission');
    expect(mission.trigger).toMatchObject({
      payload: {
        instruction: 'Watch mortgage rates for 3 months',
        cadence: { kind: 'local_times', timezone: agentTimezone, times: ['08:00', '20:00'] },
        cadenceLabel: expect.stringContaining(agentTimezone),
      },
    });
    expect(Number(mission.budgetUsdLimit)).toBeLessThanOrEqual(5); // capped
    expect(mission.deadline).toBeTruthy();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, mission.id));
    expect(row?.reflectEvery).toBeTruthy();
    expect(row?.nextAction).toBe('check rates');
  });

  it('distinguishes a newly created mission from an unchanged replay', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const source = await makeSourceTask();
    const first = await startMissionWithReceipt(db, source, basePlan, 'Replay-safe mission');
    cleanupTaskIds.push(first.mission.id);
    const replay = await startMissionWithReceipt(db, source, basePlan, 'Replay-safe mission');
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.mission.id).toBe(first.mission.id);
  });

  it('a wake spawns a fresh session child seeded from mission state, then sleeps the mission', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const source = await makeSourceTask();
    const mission = await startMission(db, source, basePlan, 'Watch rates');
    cleanupTaskIds.push(mission.id);
    const claimed = await claimTask(db, mission.id);
    expect(claimed).not.toBeNull();

    const agent = await getAgent(db);
    const wake = await wakeMission(
      { db, router: reflectingRouter({ decision: 'continue', reasoning: '' }) },
      claimed as NonNullable<typeof claimed>,
      agent,
    );
    expect(wake.action).toBe('sessioned');
    if (wake.action !== 'sessioned') return;

    const [session] = await db.select().from(tasks).where(eq(tasks.id, wake.sessionTaskId));
    expect(session?.parentTaskId).toBe(mission.id);
    expect(session?.status).toBe('pending');
    const trigger = (session?.trigger ?? {}) as { payload?: { instruction?: string } };
    const payload = trigger.payload;
    expect(payload?.instruction).toContain('Watch rates');
    expect(payload?.instruction).toContain('mission.update');

    const [after] = await db.select().from(tasks).where(eq(tasks.id, mission.id));
    expect(after?.status).toBe('sleeping');
    expect(after?.runAfter?.getTime()).toBeGreaterThan(Date.now());
    expect(taskState(after as NonNullable<typeof after>).step).toBe(1);
  });

  it('retains goal identity from source task through mission wake session', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [goal] = await db
      .insert(goals)
      .values({ agentId, title: `test-mission-goal-${Date.now()}` })
      .returning();
    if (!goal) throw new Error('goal fixture was not created');
    cleanupGoalIds.push(goal.id);
    const source = await makeSourceTask(goal.id);
    const mission = await startMission(db, source, basePlan, 'Continue this goal-scoped mission');
    cleanupTaskIds.push(mission.id);
    expect(mission.goalId).toBe(goal.id);

    const claimed = await claimTask(db, mission.id);
    expect(claimed).not.toBeNull();
    const wake = await wakeMission(
      { db, router: reflectingRouter({ decision: 'continue', reasoning: '' }) },
      claimed as NonNullable<typeof claimed>,
      await getAgent(db),
    );
    expect(wake.action).toBe('sessioned');
    if (wake.action !== 'sessioned') return;
    const [session] = await db.select().from(tasks).where(eq(tasks.id, wake.sessionTaskId));
    expect(session?.parentTaskId).toBe(mission.id);
    expect(session?.goalId).toBe(goal.id);
    const payload = (session?.trigger as { payload?: { instruction?: string } } | undefined)
      ?.payload;
    expect(payload?.instruction).toContain(`mission ${mission.id}`);
    expect(payload?.instruction).toContain(`goal ${goal.id}`);
    expect(payload?.instruction).toContain('Continue this goal-scoped mission');
  });

  it('a session child stuck in needs_attention escalates the mission instead of stalling', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);
    const source = await makeSourceTask();
    const mission = await startMission(db, source, basePlan, 'Watch rates with a stuck session');
    cleanupTaskIds.push(mission.id);

    // A prior work session that dead-lettered / exhausted its budget: not
    // terminal, but it will not resume on its own.
    const { task: child } = await enqueueTask(db, {
      event: { source: 'internal', agentId, trust: 'owner', payload: {} },
      type: 'adhoc',
      parentTaskId: mission.id,
    });
    await db.update(tasks).set({ status: 'needs_attention' }).where(eq(tasks.id, child.id));

    const claimed = await claimTask(db, mission.id);
    expect(claimed).not.toBeNull();
    const wake = await wakeMission(
      { db, router: reflectingRouter({ decision: 'continue', reasoning: '' }) },
      claimed as NonNullable<typeof claimed>,
      agent,
    );
    expect(wake.action).toBe('reflected');
    if (wake.action === 'reflected') expect(wake.decision).toBe('escalate');

    const [after] = await db.select().from(tasks).where(eq(tasks.id, mission.id));
    expect(after?.status).toBe('needs_attention');
    // No new session was spawned on top of the stuck one.
    const children = await db.select().from(tasks).where(eq(tasks.parentTaskId, mission.id));
    expect(children).toHaveLength(1);
  });

  it('a mission that has spent its whole budget escalates instead of spawning another session', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);
    const source = await makeSourceTask();
    const mission = await startMission(db, source, basePlan, 'Watch rates on a spent budget');
    cleanupTaskIds.push(mission.id);
    // Drive cumulative spend up to the mission's own cap.
    const cap = Number(mission.budgetUsdLimit);
    await db
      .update(tasks)
      .set({ spentUsd: cap.toFixed(4) })
      .where(eq(tasks.id, mission.id));

    const claimed = await claimTask(db, mission.id);
    expect(claimed).not.toBeNull();
    const wake = await wakeMission(
      { db, router: reflectingRouter({ decision: 'continue', reasoning: '' }) },
      claimed as NonNullable<typeof claimed>,
      agent,
    );
    expect(wake.action).toBe('reflected');
    if (wake.action === 'reflected') expect(wake.decision).toBe('escalate');
    const [after] = await db.select().from(tasks).where(eq(tasks.id, mission.id));
    expect(after?.status).toBe('needs_attention');
    // No session child was spawned once the budget was gone.
    const children = await db.select().from(tasks).where(eq(tasks.parentTaskId, mission.id));
    expect(children).toHaveLength(0);
  });

  it('charges nested descendants to the original mission budget before another wake', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);
    const source = await makeSourceTask();
    const mission = await startMission(db, source, basePlan, 'Keep effort within the root budget');
    cleanupTaskIds.push(mission.id);
    const { task: child } = await enqueueTask(db, {
      event: { source: 'internal', agentId, trust: 'owner', payload: {} },
      type: 'adhoc',
      parentTaskId: mission.id,
      budgetUsdLimit: '0.25',
    });
    const { task: grandchild } = await enqueueTask(db, {
      event: { source: 'internal', agentId, trust: 'owner', payload: {} },
      type: 'scheduled',
      parentTaskId: child.id,
      budgetUsdLimit: '0.25',
    });
    await db
      .update(tasks)
      .set({ spentUsd: Number(mission.budgetUsdLimit).toFixed(4) })
      .where(eq(tasks.id, grandchild.id));

    const claimed = await claimTask(db, mission.id);
    expect(claimed).not.toBeNull();
    const wake = await wakeMission(
      { db, router: reflectingRouter({ decision: 'continue', reasoning: '' }) },
      claimed as NonNullable<typeof claimed>,
      agent,
    );

    expect(wake).toMatchObject({ action: 'reflected', decision: 'escalate' });
    const [after] = await db.select().from(tasks).where(eq(tasks.id, mission.id));
    expect(after?.status).toBe('needs_attention');
    const children = await db.select().from(tasks).where(eq(tasks.parentTaskId, mission.id));
    expect(children).toHaveLength(1);
  });

  it('limits each session child to the remaining authorized root budget', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);
    const source = await makeSourceTask();
    const mission = await startMission(
      db,
      source,
      { ...basePlan, budgetSuggestionUsd: 0.3 },
      'Use only the remaining root budget',
    );
    cleanupTaskIds.push(mission.id);
    await db.update(tasks).set({ spentUsd: '0.2000' }).where(eq(tasks.id, mission.id));

    const claimed = await claimTask(db, mission.id);
    expect(claimed).not.toBeNull();
    const wake = await wakeMission(
      { db, router: reflectingRouter({ decision: 'continue', reasoning: '' }) },
      claimed as NonNullable<typeof claimed>,
      agent,
    );

    expect(wake.action).toBe('sessioned');
    if (wake.action !== 'sessioned') return;
    const [child] = await db.select().from(tasks).where(eq(tasks.id, wake.sessionTaskId));
    expect(Number(child?.budgetUsdLimit)).toBeCloseTo(0.1, 4);
  });

  it('deadline reached → final report and done', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const source = await makeSourceTask();
    const mission = await startMission(db, source, basePlan, 'Short mission');
    cleanupTaskIds.push(mission.id);
    await db
      .update(tasks)
      .set({ deadline: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, mission.id));
    const claimed = await claimTask(db, mission.id);
    expect(claimed).not.toBeNull();

    const agent = await getAgent(db);
    const wake = await wakeMission(
      { db, router: reflectingRouter({ decision: 'continue', reasoning: '' }) },
      claimed as NonNullable<typeof claimed>,
      agent,
    );
    expect(wake.action).toBe('deadline_reached');
    const [after] = await db.select().from(tasks).where(eq(tasks.id, mission.id));
    expect(after?.status).toBe('done');
    const [report] = await db
      .select()
      .from(missionReports)
      .where(eq(missionReports.missionId, mission.id));
    expect(report?.chatStatus).toBe('delivered');
    expect(report?.conversationId).toBeNull();
    expect(
      await db
        .select()
        .from(messages)
        .where(eq(messages.channelMessageId, report?.id ?? '')),
    ).toHaveLength(1);
  });

  it('recovers an append accepted before its receipt and retries only the failed owner leg', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: `mission-report-${Date.now()}`,
      })
      .returning();
    if (!conversation) throw new Error('Missing mission report conversation');
    cleanupConversationIds.push(conversation.id);
    const { task: source } = await enqueueTask(db, {
      event: {
        source: 'internal',
        agentId,
        conversationId: conversation.id,
        trust: 'owner',
        payload: {},
      },
      type: 'adhoc',
    });
    cleanupTaskIds.push(source.id);
    const mission = await startMission(db, source, basePlan, 'Recover mission report');
    cleanupTaskIds.push(mission.id);
    await db
      .update(tasks)
      .set({ deadline: new Date(Date.now() - 1_000) })
      .where(eq(tasks.id, mission.id));
    const claimed = await claimTask(db, mission.id);
    expect(claimed).not.toBeNull();
    const realMessages = createPostgresMessageRepository(db);
    const lostReceiptMessages = {
      kind: 'message-repository' as const,
      append: vi.fn(async (input: Parameters<typeof realMessages.append>[0]) => {
        await realMessages.append(input);
        throw new Error('worker stopped after append commit');
      }),
    };
    const repository = createPostgresMissionRepository(db);
    const ownerFailed = vi.fn(async () => ({
      legs: [{ channel: 'push', status: 'failed' as const }],
    }));
    const deps = {
      db,
      router: reflectingRouter({ decision: 'continue', reasoning: '' }),
      persistence: { missions: repository, messages: lostReceiptMessages },
      notifyOwner: ownerFailed,
    } as never;
    const wake = await wakeMission(
      deps,
      claimed as NonNullable<typeof claimed>,
      await getAgent(db),
    );
    expect(wake.action).toBe('deadline_reached');
    const [report] = await db
      .select()
      .from(missionReports)
      .where(eq(missionReports.missionId, mission.id));
    expect(report).toMatchObject({ chatStatus: 'failed', ownerStatus: 'failed' });
    if (!report) throw new Error('Mission report intent was not committed with terminal state');

    await db
      .update(missionReports)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(missionReports.id, report.id));
    const ownerDelivered = vi.fn(async () => ({
      legs: [{ channel: 'push', status: 'delivered' as const }],
    }));
    let beginAppend!: () => void;
    let finishAppend!: () => void;
    const appendBegan = new Promise<void>((resolve) => (beginAppend = resolve));
    const appendGate = new Promise<void>((resolve) => (finishAppend = resolve));
    const slowMessages = {
      kind: 'message-repository' as const,
      append: vi.fn(async (input: Parameters<typeof realMessages.append>[0]) => {
        beginAppend();
        await appendGate;
        return realMessages.append(input);
      }),
    };
    const repairDeps = {
      db,
      agentId,
      router: reflectingRouter({ decision: 'continue', reasoning: '' }),
      persistence: { missions: repository, messages: slowMessages },
      notifyOwner: ownerDelivered,
    } as never;
    const firstRepair = repairMissionReports(repairDeps, 1);
    await appendBegan;
    const concurrentRepair = repairMissionReports(repairDeps, 1);
    finishAppend();
    await Promise.all([firstRepair, concurrentRepair]);
    const [repaired] = await db
      .select()
      .from(missionReports)
      .where(eq(missionReports.id, report.id));
    expect(repaired).toMatchObject({ chatStatus: 'delivered', ownerStatus: 'delivered' });
    expect(ownerFailed).toHaveBeenCalledTimes(1);
    expect(ownerDelivered).toHaveBeenCalledTimes(1);
    expect(slowMessages.append).toHaveBeenCalledTimes(1);
    expect(
      await db.select().from(messages).where(eq(messages.channelMessageId, report.id)),
    ).toHaveLength(1);
  });

  it('reflection due → applies the decision (escalate → needs_attention; abandon → cancelled)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);

    for (const [decision, expectedStatus] of [
      ['escalate', 'needs_attention'],
      ['abandon', 'cancelled'],
    ] as const) {
      const source = await makeSourceTask();
      const mission = await startMission(db, source, basePlan, `Reflect ${decision}`);
      cleanupTaskIds.push(mission.id);
      await db
        .update(tasks)
        .set({ lastReflectedAt: new Date(Date.now() - 8 * 24 * 3600e3) }) // > 7 days ago
        .where(eq(tasks.id, mission.id));
      const claimed = await claimTask(db, mission.id);
      expect(claimed).not.toBeNull();

      const wake = await wakeMission(
        { db, router: reflectingRouter({ decision, reasoning: 'test', progressPercent: 40 }) },
        claimed as NonNullable<typeof claimed>,
        agent,
      );
      expect(wake.action).toBe('reflected');
      const [after] = await db.select().from(tasks).where(eq(tasks.id, mission.id));
      expect(after?.status).toBe(expectedStatus);
      expect(after?.progressPercent).toBe(40);
      expect(after?.lastReflectedAt).toBeTruthy();
    }
  });
});

describe('schedules (integration)', () => {
  it('nextRun computes a future firing in the agent timezone', () => {
    const next = nextRun('30 7 * * *', 'America/Los_Angeles');
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it('uses priority as the baseline pace and only increases it near a target date', () => {
    const now = new Date('2026-07-17T12:00:00Z');
    expect(goalAutomationCadence({ priority: 1, targetDate: null }, now).label).toBe(
      'every 6 hours',
    );
    expect(goalAutomationCadence({ priority: 4, targetDate: null }, now).label).toBe('weekly');
    expect(
      goalAutomationCadence({ priority: 4, targetDate: new Date('2026-07-20T12:00:00Z') }, now)
        .label,
    ).toBe('every 4 hours until the target date');
    // A high-priority goal already runs more often than the 12-hour deadline pace.
    expect(
      goalAutomationCadence({ priority: 1, targetDate: new Date('2026-07-25T12:00:00Z') }, now)
        .label,
    ).toBe('every 6 hours');
  });

  it('keeps the baseline pace once the target date has passed', () => {
    const now = new Date('2026-07-17T12:00:00Z');
    // Regression: a past-due target made hoursUntil negative, so the <= 24h
    // tier matched and an overdue goal ran every 2 hours forever.
    const overdue = new Date('2026-07-10T12:00:00Z');
    expect(goalAutomationCadence({ priority: 1, targetDate: overdue }, now)).toEqual({
      cron: '15 */6 * * *',
      label: 'every 6 hours',
    });
    expect(goalAutomationCadence({ priority: 3, targetDate: overdue }, now)).toEqual({
      cron: '15 9 * * 1,4',
      label: 'twice a week',
    });
    // A target exactly at "now" is still a live deadline, not a missed one.
    expect(goalAutomationCadence({ priority: 3, targetDate: now }, now).label).toBe(
      'every 2 hours until the target date',
    );
  });

  it('creates one goal runner and queues its scheduled work for the linked chat', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [goal] = await db
      .insert(goals)
      .values({
        agentId,
        title: `test automated goal ${Date.now()}`,
        status: 'active',
        priority: 3,
        progress: 'Resume tailored applications after the current tracker is checked.',
        nextAction: 'Review new roles and prepare the next application.',
      })
      .returning();
    const actualGoal = goal as NonNullable<typeof goal>;
    cleanupGoalIds.push(actualGoal.id);

    const [conversation] = await db
      .insert(conversations)
      .values({
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: `test goal work ${Date.now()}`,
        metadata: { goalId: actualGoal.id },
      })
      .returning();
    const actualConversation = conversation as NonNullable<typeof conversation>;
    cleanupConversationIds.push(actualConversation.id);

    const agent = await getAgent(db);
    const schedule = await ensureGoalAutomation(db, agent, actualGoal, actualConversation.id);
    expect(schedule?.enabled).toBe(true);
    expect(schedule?.taskTemplate).toMatchObject({
      goalId: actualGoal.id,
      conversationId: actualConversation.id,
    });
    const instruction =
      ((schedule as NonNullable<typeof schedule>).taskTemplate as { instruction?: string })
        .instruction ?? '';
    expect(instruction).toContain(actualGoal.id);
    expect(instruction).toContain(actualGoal.progress);
    expect(instruction).toContain(actualGoal.nextAction);
    const repeated = await ensureGoalAutomation(db, agent, actualGoal, actualConversation.id);
    expect(repeated?.id).toBe(schedule?.id);
    cleanupScheduleIds.push((schedule as NonNullable<typeof schedule>).id);
    await db
      .update(schedules)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(schedules.id, (schedule as NonNullable<typeof schedule>).id));

    const fired = await runDueSchedules(db, agentTimezone);
    const mine = fired.find((item) => item.schedule === schedule?.name);
    expect(mine).toBeTruthy();
    if (!mine) return;
    cleanupTaskIds.push(mine.taskId);

    const [task] = await db.select().from(tasks).where(eq(tasks.id, mine.taskId));
    expect(task?.goalId).toBe(actualGoal.id);
    expect(task?.conversationId).toBe(actualConversation.id);
  });

  it('due schedules fire exactly one task per firing and advance next_run_at', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [schedule] = await db
      .insert(schedules)
      .values({
        agentId,
        name: `test-schedule-${Date.now()}`,
        cron: '*/5 * * * *',
        taskTemplate: { type: 'scheduled', instruction: 'test tick' },
        enabled: true,
        nextRunAt: new Date(Date.now() - 60_000), // already due
      })
      .returning();

    const fired = await runDueSchedules(db, agentTimezone);
    const mine = fired.filter((f) => f.schedule === schedule?.name);
    expect(mine).toHaveLength(1);
    cleanupTaskIds.push(...mine.map((m) => m.taskId));

    // second tick: not due anymore, no duplicate
    const again = await runDueSchedules(db, agentTimezone);
    expect(again.filter((f) => f.schedule === schedule?.name)).toHaveLength(0);

    const [after] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.id, (schedule as NonNullable<typeof schedule>).id));
    expect(after?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    expect(after?.lastRunAt).toBeTruthy();
  });
});

describe('parseIntervalMs', () => {
  it('parses day and time intervals', () => {
    expect(parseIntervalMs('7 days')).toBe(7 * 24 * 3600e3);
    expect(parseIntervalMs('1 day')).toBe(24 * 3600e3);
    expect(parseIntervalMs('02:30:00')).toBe(2.5 * 3600e3);
    expect(parseIntervalMs(null)).toBeNull();
  });
});
