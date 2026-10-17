import { conversations, createDb, type Db, goals, messages, schedules, tasks } from '@assistant/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import { loadConfig, resetConfigForTest } from '../config.js';
import {
  cancelQueuedGoalWork,
  clearGoalBlockedOnOwnerReply,
  GOAL_BLOCKED_PREFIX,
  GOAL_SESSION_SUPERSEDED,
  goalAutomationGate,
  goalScheduleName,
  maybeFireWakeBrief,
  nextRun,
  runDueSchedules,
  upsertSchedule,
  WAKE_BRIEF_SCHEDULE,
} from './schedules.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId = '';
let timezone = 'America/Los_Angeles';
let goalId = '';
let workChatId = '';
const createdTaskIds: string[] = [];
const createdGoalIds: string[] = [];
const createdChatIds: string[] = [];
const createdScheduleNames: string[] = [];

async function insertGoalTask(input: {
  type?: string;
  status: string;
  progress?: string;
  createdAt?: Date;
  updatedAt?: Date;
}): Promise<string> {
  const [task] = await db
    .insert(tasks)
    .values({
      agentId,
      goalId,
      conversationId: workChatId,
      type: input.type ?? 'scheduled',
      status: input.status,
      trust: 'assistant',
      trigger: { source: 'schedule', payload: {} },
      progress: input.progress ?? '',
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      // Default the session's last activity into the past so an owner reply
      // inserted "now" is unambiguously newer.
      updatedAt: input.updatedAt ?? new Date(Date.now() - 60e3),
    })
    .returning({ id: tasks.id });
  const id = (task as NonNullable<typeof task>).id;
  createdTaskIds.push(id);
  return id;
}

async function ownerReply(text: string): Promise<void> {
  await db.insert(messages).values({
    conversationId: workChatId,
    role: 'user',
    origin: 'owner',
    parts: [{ type: 'text', text }],
    text,
  });
}

async function setNextAction(nextAction: string): Promise<void> {
  await db.update(goals).set({ nextAction }).where(eq(goals.id, goalId));
}

/** Push every enabled schedule into the future; returns a restore function. */
async function freezeOtherSchedules(): Promise<() => Promise<void>> {
  const frozen = await db
    .select({ id: schedules.id, nextRunAt: schedules.nextRunAt })
    .from(schedules)
    .where(eq(schedules.enabled, true));
  await db.update(schedules).set({ nextRunAt: new Date(Date.now() + 3600e3) });
  return async () => {
    for (const row of frozen) {
      await db.update(schedules).set({ nextRunAt: row.nextRunAt }).where(eq(schedules.id, row.id));
    }
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const agent = await getAgent(db);
    agentId = agent.id;
    timezone = agent.timezone;
    dbUp = true;
  } catch {
    console.warn('schedules.test: database unreachable — skipping');
  }
});

beforeEach(async () => {
  if (!dbUp) return;
  // Fresh goal + work chat per test: the gate reads goal.nextAction and the
  // work chat's owner messages, so shared fixtures would couple the cases.
  const [goal] = await db
    .insert(goals)
    .values({ agentId, title: `gate-test-${Date.now()}-${Math.random()}`, status: 'active' })
    .returning();
  goalId = (goal as NonNullable<typeof goal>).id;
  createdGoalIds.push(goalId);
  const [chat] = await db
    .insert(conversations)
    .values({
      agentId,
      channel: 'chat',
      trust: 'owner',
      title: 'gate-test work chat',
      metadata: { goalId },
    })
    .returning();
  workChatId = (chat as NonNullable<typeof chat>).id;
  createdChatIds.push(workChatId);
});

afterAll(async () => {
  if (dbUp) {
    if (createdTaskIds.length) await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
    if (createdGoalIds.length) {
      // Only schedules this file's goals created — never the seeded ones.
      await db
        .delete(schedules)
        .where(inArray(schedules.name, createdGoalIds.map(goalScheduleName)));
      await db.delete(goals).where(inArray(goals.id, createdGoalIds));
    }
    if (createdScheduleNames.length) {
      await db.delete(schedules).where(inArray(schedules.name, createdScheduleNames));
    }
    if (createdChatIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, createdChatIds));
      await db.delete(conversations).where(inArray(conversations.id, createdChatIds));
    }
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

afterEach(() => resetConfigForTest());

describe('goalAutomationGate (integration)', () => {
  it('blocks while an unattended session is genuinely in flight', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await insertGoalTask({ status: 'pending' });
    const verdict = await goalAutomationGate(db, agentId, goalId, workChatId);
    expect(verdict.fire).toBe(false);
    expect(verdict.reason).toBe('session still in flight');
  });

  it('blocks while an attended goal turn is pending, but not while it is parked', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const attendedId = await insertGoalTask({ type: 'chat_turn', status: 'pending' });
    expect((await goalAutomationGate(db, agentId, goalId, workChatId)).fire).toBe(false);

    await db.update(tasks).set({ status: 'waiting_approval' }).where(eq(tasks.id, attendedId));
    const parked = await goalAutomationGate(db, agentId, goalId, workChatId);
    expect(parked.fire).toBe(true);
    expect(parked.cancelTaskIds).toEqual([]);
  });

  it('skips (without cancelling) while blocked on an unanswered owner question', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await insertGoalTask({ status: 'needs_attention' });
    await setNextAction(`${GOAL_BLOCKED_PREFIX} which cities should I search?`);
    const verdict = await goalAutomationGate(db, agentId, goalId, workChatId);
    expect(verdict.fire).toBe(false);
    expect(verdict.reason).toBe('waiting on the owner');
    expect(verdict.cancelTaskIds).toEqual([]);
  });

  it('resumes once the owner answers in the work chat, superseding the stalled session', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const stalledId = await insertGoalTask({ status: 'needs_attention' });
    await setNextAction(`${GOAL_BLOCKED_PREFIX} which cities should I search?`);
    await ownerReply('Reykjavik and Berlin, please.');
    const verdict = await goalAutomationGate(db, agentId, goalId, workChatId);
    expect(verdict.fire).toBe(true);
    expect(verdict.cancelTaskIds).toEqual([stalledId]);
  });

  it('supersedes a needs_attention session that is not waiting on the owner', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const stalledId = await insertGoalTask({ status: 'needs_attention' });
    await setNextAction('search the next job board');
    const verdict = await goalAutomationGate(db, agentId, goalId, workChatId);
    expect(verdict.fire).toBe(true);
    expect(verdict.cancelTaskIds).toEqual([stalledId]);
  });

  it('stops auto-resuming after three stalled sessions with no owner input', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const base = Date.now() - 3 * 86400e3;
    await insertGoalTask({
      status: 'cancelled',
      progress: GOAL_SESSION_SUPERSEDED,
      createdAt: new Date(base),
    });
    await insertGoalTask({ status: 'failed', createdAt: new Date(base + 86400e3) });
    await insertGoalTask({ status: 'needs_attention', createdAt: new Date(base + 2 * 86400e3) });
    await setNextAction('search the next job board');
    const verdict = await goalAutomationGate(db, agentId, goalId, workChatId);
    expect(verdict.fire).toBe(false);
    expect(verdict.reason).toBe('three stalled sessions without owner input');
  });

  it('a fresh owner message clears the three-stall stop', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const base = Date.now() - 3 * 86400e3;
    await insertGoalTask({
      status: 'cancelled',
      progress: GOAL_SESSION_SUPERSEDED,
      createdAt: new Date(base),
    });
    await insertGoalTask({ status: 'failed', createdAt: new Date(base + 86400e3) });
    const stalledId = await insertGoalTask({
      status: 'needs_attention',
      createdAt: new Date(base + 2 * 86400e3),
    });
    await setNextAction('search the next job board');
    await ownerReply('keep going — try the Berlin boards');
    const verdict = await goalAutomationGate(db, agentId, goalId, workChatId);
    expect(verdict.fire).toBe(true);
    expect(verdict.cancelTaskIds).toEqual([stalledId]);
  });

  it('an owner cancellation (no superseded marker) does not count toward the three-stall stop', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const base = Date.now() - 3 * 86400e3;
    await insertGoalTask({ status: 'cancelled', progress: '', createdAt: new Date(base) });
    await insertGoalTask({ status: 'failed', createdAt: new Date(base + 86400e3) });
    await insertGoalTask({ status: 'needs_attention', createdAt: new Date(base + 2 * 86400e3) });
    await setNextAction('search the next job board');
    const verdict = await goalAutomationGate(db, agentId, goalId, workChatId);
    expect(verdict.fire).toBe(true);
  });

  it('an owner reply clears the waiting marker without touching other next actions', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const readNextAction = async () =>
      (
        await db
          .select({ nextAction: goals.nextAction })
          .from(goals)
          .where(eq(goals.id, goalId))
          .limit(1)
      )[0]?.nextAction;

    await setNextAction(`${GOAL_BLOCKED_PREFIX} which cities should I search?`);
    await clearGoalBlockedOnOwnerReply(db, goalId);
    expect(await readNextAction()).toBe('');

    // A plain (checkpoint- or owner-written) next action is never the blocked
    // marker, so a reply must not clobber it.
    await setNextAction('search the Berlin boards');
    await clearGoalBlockedOnOwnerReply(db, goalId);
    expect(await readNextAction()).toBe('search the Berlin boards');
  });
});

describe('feature-gated schedules (integration)', () => {
  it('advances a disabled GraphRAG schedule without creating a task', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const restore = await freezeOtherSchedules();
    try {
      loadConfig({ GRAPH_RAG_ENABLED: 'false' });
      const name = `disabled-graph-sync-${Date.now()}-${Math.random()}`;
      createdScheduleNames.push(name);
      await upsertSchedule(db, {
        agentId,
        name,
        cron: '* * * * *',
        timezone,
        taskTemplate: { type: 'scheduled', job: 'memory.graph_sync' },
      });
      await db
        .update(schedules)
        .set({ nextRunAt: new Date(Date.now() - 60e3) })
        .where(eq(schedules.name, name));

      const fired = await runDueSchedules(db, timezone);
      expect(fired.filter((entry) => entry.schedule === name)).toEqual([]);
      const [updated] = await db.select().from(schedules).where(eq(schedules.name, name));
      expect(updated?.lastRunAt).not.toBeNull();
      expect(updated?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await restore();
    }
  });
});

describe('nextRun', () => {
  it('advances past an exact cron boundary instead of returning the same instant', () => {
    const boundary = new Date('2026-09-04T07:00:00.000Z');
    const next = nextRun('0 * * * *', 'UTC', boundary);
    expect(next.getTime()).toBeGreaterThan(boundary.getTime());
    expect(next.toISOString()).toBe('2026-09-04T08:00:00.000Z');
  });
});

describe('runDueSchedules goal wiring (integration)', () => {
  it('fires a due goal schedule by superseding the stalled session, and spawns exactly one new task', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const restore = await freezeOtherSchedules();
    try {
      const stalledId = await insertGoalTask({ status: 'needs_attention' });
      await setNextAction(`${GOAL_BLOCKED_PREFIX} which cities?`);
      await ownerReply('Berlin.');

      // First tick lets syncGoalAutomations create this goal's schedule row
      // (with a future next_run_at); then make only that row due.
      await runDueSchedules(db, timezone);
      const name = goalScheduleName(goalId);
      // The standing schedule already exists; the next session must use the
      // latest verified progress and revised priority, not its old template.
      await db
        .update(goals)
        .set({
          progress: 'Compared two cities; accessibility details remain unverified.',
          nextAction: 'Prioritize accessible venues in Berlin for six people.',
        })
        .where(eq(goals.id, goalId));
      await db
        .update(schedules)
        .set({ nextRunAt: new Date(Date.now() - 60e3) })
        .where(eq(schedules.name, name));

      const fired = await runDueSchedules(db, timezone);
      const mine = fired.filter((f) => f.schedule === name);
      expect(mine).toHaveLength(1);
      const spawnedId = mine[0]?.taskId as string;
      createdTaskIds.push(spawnedId);

      const [stale] = await db.select().from(tasks).where(eq(tasks.id, stalledId));
      expect(stale?.status).toBe('cancelled');
      expect(stale?.progress).toBe(GOAL_SESSION_SUPERSEDED);

      const [spawned] = await db.select().from(tasks).where(eq(tasks.id, spawnedId));
      expect(spawned?.status).toBe('pending');
      expect(spawned?.goalId).toBe(goalId);
      const trigger = spawned?.trigger as { payload?: { instruction?: string } } | null;
      expect(trigger?.payload?.instruction).toContain(
        'Compared two cities; accessibility details remain unverified.',
      );
      expect(trigger?.payload?.instruction).toContain(
        'Prioritize accessible venues in Berlin for six people.',
      );
      expect(trigger?.payload?.instruction).not.toContain(`${GOAL_BLOCKED_PREFIX} which cities?`);
    } finally {
      await restore();
    }
  });

  it('propagates taintedOrigin from a tainted-origin goal into its automation firing (S1)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const restore = await freezeOtherSchedules();
    try {
      // A goal created from a tainted session (goals.create stamps this).
      await db.update(goals).set({ taintedOrigin: true }).where(eq(goals.id, goalId));

      await runDueSchedules(db, timezone);
      const name = goalScheduleName(goalId);
      // The automation template must carry the taint marker forward.
      const [schedule] = await db.select().from(schedules).where(eq(schedules.name, name));
      const template = schedule?.taskTemplate as { taintedOrigin?: unknown } | null;
      expect(template?.taintedOrigin).toBe(true);

      await db
        .update(schedules)
        .set({ nextRunAt: new Date(Date.now() - 60e3) })
        .where(eq(schedules.name, name));
      const fired = await runDueSchedules(db, timezone);
      const mine = fired.filter((f) => f.schedule === name);
      expect(mine).toHaveLength(1);
      const spawnedId = mine[0]?.taskId as string;
      createdTaskIds.push(spawnedId);

      // The fired task's trigger carries taintedOrigin, so shouldTaintContext
      // taints the session and its egress calls are owner-gated.
      const [spawned] = await db.select().from(tasks).where(eq(tasks.id, spawnedId));
      const trigger = spawned?.trigger as { payload?: { taintedOrigin?: unknown } } | null;
      expect(trigger?.payload?.taintedOrigin).toBe(true);
    } finally {
      await restore();
    }
  });

  it('a due goal schedule skips quietly while the goal is blocked on the owner', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const restore = await freezeOtherSchedules();
    try {
      const stalledId = await insertGoalTask({ status: 'needs_attention' });
      await setNextAction(`${GOAL_BLOCKED_PREFIX} which cities?`);

      await runDueSchedules(db, timezone);
      const name = goalScheduleName(goalId);
      await db
        .update(schedules)
        .set({ nextRunAt: new Date(Date.now() - 60e3) })
        .where(eq(schedules.name, name));

      const fired = await runDueSchedules(db, timezone);
      expect(fired.filter((f) => f.schedule === name)).toHaveLength(0);

      const [stale] = await db.select().from(tasks).where(eq(tasks.id, stalledId));
      expect(stale?.status).toBe('needs_attention');

      // next_run_at still advanced — the schedule stays healthy, just quiet.
      const [row] = await db.select().from(schedules).where(eq(schedules.name, name));
      expect(row?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await restore();
    }
  });
});

describe('cancelQueuedGoalWork (integration)', () => {
  it('calls off queued work but leaves a task a worker is holding', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const queued = await insertGoalTask({ status: 'pending' });
    const parked = await insertGoalTask({ status: 'waiting_approval' });
    const sleeping = await insertGoalTask({ status: 'sleeping' });
    const running = await insertGoalTask({ status: 'running' });
    const alreadyDone = await insertGoalTask({ status: 'done', progress: 'finished earlier' });

    const cancelled = await cancelQueuedGoalWork(db, agentId, goalId);
    expect(cancelled).toBe(3);

    const rows = await db
      .select({ id: tasks.id, status: tasks.status, progress: tasks.progress })
      .from(tasks)
      .where(inArray(tasks.id, [queued, parked, sleeping, running, alreadyDone]));
    const statusOf = (id: string) => rows.find((row) => row.id === id)?.status;

    expect(statusOf(queued)).toBe('cancelled');
    expect(statusOf(parked)).toBe('cancelled');
    expect(statusOf(sleeping)).toBe('cancelled');
    // Held by a worker mid-step — the executor's own guard stops that one.
    expect(statusOf(running)).toBe('running');
    // Finished work keeps its outcome and its progress note.
    expect(statusOf(alreadyDone)).toBe('done');
    expect(rows.find((row) => row.id === alreadyDone)?.progress).toBe('finished earlier');
    expect(rows.find((row) => row.id === queued)?.progress).toContain('goal was stopped');
  });

  it('does not touch another goal’s work', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const mine = await insertGoalTask({ status: 'pending' });
    const [otherGoal] = await db
      .insert(goals)
      .values({ agentId, title: `other-goal-${Date.now()}`, status: 'active' })
      .returning();
    const otherGoalId = (otherGoal as NonNullable<typeof otherGoal>).id;
    createdGoalIds.push(otherGoalId);
    const [otherTask] = await db
      .insert(tasks)
      .values({
        agentId,
        goalId: otherGoalId,
        type: 'scheduled',
        status: 'pending',
        trust: 'assistant',
        trigger: { source: 'schedule', payload: {} },
      })
      .returning({ id: tasks.id });
    const otherTaskId = (otherTask as NonNullable<typeof otherTask>).id;
    createdTaskIds.push(otherTaskId);

    expect(await cancelQueuedGoalWork(db, agentId, goalId)).toBe(1);

    const [untouched] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, otherTaskId));
    expect(untouched?.status).toBe('pending');
    const [cancelled] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, mine));
    expect(cancelled?.status).toBe('cancelled');
  });
});

describe('maybeFireWakeBrief (integration)', () => {
  // The function under test owns the single 'daily-briefing' row by name, so
  // the seeded row (when present) is parked for the duration and restored.
  let parkedBrief: (typeof schedules.$inferSelect)[] = [];

  function localDateString(at: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  }

  function tzOffsetMs(at: Date): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    return asUtc - Math.floor(at.getTime() / 1000) * 1000;
  }

  /** The Date that is `hour:minute` on `base`'s calendar day in the agent tz. */
  function atLocal(hour: number, minute: number, base: Date): Date {
    const date = localDateString(base);
    const pad = (n: number) => String(n).padStart(2, '0');
    const guessUtc = Date.parse(`${date}T${pad(hour)}:${pad(minute)}:00Z`);
    let at = guessUtc - tzOffsetMs(new Date(guessUtc));
    at = guessUtc - tzOffsetMs(new Date(at));
    return new Date(at);
  }

  async function insertBriefSchedule(lastRunAt: Date | null): Promise<void> {
    await db.insert(schedules).values({
      agentId,
      name: WAKE_BRIEF_SCHEDULE,
      cron: '30 7 * * *',
      taskTemplate: { type: 'scheduled', instruction: 'test wake brief', job: 'briefing.compose' },
      enabled: true,
      nextRunAt: atLocal(7, 30, new Date()),
      ...(lastRunAt ? { lastRunAt } : {}),
    });
  }

  async function briefRow() {
    const [row] = await db
      .select()
      .from(schedules)
      .where(and(eq(schedules.agentId, agentId), eq(schedules.name, WAKE_BRIEF_SCHEDULE)))
      .limit(1);
    return row;
  }

  beforeAll(async () => {
    if (!dbUp) return;
    parkedBrief = await db
      .select()
      .from(schedules)
      .where(and(eq(schedules.agentId, agentId), eq(schedules.name, WAKE_BRIEF_SCHEDULE)));
    await db
      .delete(schedules)
      .where(and(eq(schedules.agentId, agentId), eq(schedules.name, WAKE_BRIEF_SCHEDULE)));
  });

  afterEach(async () => {
    if (!dbUp) return;
    await db.delete(tasks).where(sql`${tasks.externalEventId} like 'schedule:%:wake:%'`);
    await db
      .delete(schedules)
      .where(and(eq(schedules.agentId, agentId), eq(schedules.name, WAKE_BRIEF_SCHEDULE)));
  });

  afterAll(async () => {
    if (!dbUp) return;
    if (parkedBrief.length) await db.insert(schedules).values(parkedBrief);
  });

  it('fires the brief early on the first morning app-open, then stands down', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = atLocal(6, 0, new Date());
    await insertBriefSchedule(null);

    expect(await maybeFireWakeBrief(db, { id: agentId, timezone }, now)).toBe(true);

    const row = await briefRow();
    if (!row) throw new Error('wake brief row missing');
    expect(row.lastRunAt?.getTime()).toBe(now.getTime());
    // Today's 07:30 instance is skipped — the cron owns tomorrow again.
    expect(row.nextRunAt?.getTime()).toBe(
      atLocal(7, 30, new Date(now.getTime() + 86400e3)).getTime(),
    );

    const [enqueued] = await db
      .select({ id: tasks.id, trigger: tasks.trigger })
      .from(tasks)
      .where(sql`${tasks.externalEventId} = ${`schedule:${row.id}:wake:${localDateString(now)}`}`);
    expect(enqueued).toBeDefined();
    // The briefing is a code job: the wake path must carry the job name, or
    // the executor runs a model loop over the instruction instead.
    expect((enqueued?.trigger as { payload?: { job?: string } } | undefined)?.payload?.job).toBe(
      'briefing.compose',
    );

    // A second open the same morning is a no-op.
    expect(
      await maybeFireWakeBrief(db, { id: agentId, timezone }, atLocal(6, 45, new Date())),
    ).toBe(false);
  });

  it('leaves the brief to the cron once the scheduled time is reached', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await insertBriefSchedule(null);
    expect(await maybeFireWakeBrief(db, { id: agentId, timezone }, atLocal(9, 0, new Date()))).toBe(
      false,
    );
    expect((await briefRow())?.lastRunAt).toBeNull();
  });

  it('ignores a pre-dawn open', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await insertBriefSchedule(null);
    expect(
      await maybeFireWakeBrief(db, { id: agentId, timezone }, atLocal(2, 30, new Date())),
    ).toBe(false);
    expect((await briefRow())?.lastRunAt).toBeNull();
  });

  it('does not refire when the cron already briefed today', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await insertBriefSchedule(atLocal(7, 30, new Date()));
    expect(
      await maybeFireWakeBrief(db, { id: agentId, timezone }, atLocal(8, 30, new Date())),
    ).toBe(false);
  });
});
