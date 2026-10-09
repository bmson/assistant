import { createDb, type Db, tasks } from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgent } from '../chat.js';
import type { InboundEvent } from '../events.js';
import {
  checkpointTask,
  claimTask,
  completeTask,
  deriveTaskTitle,
  enqueueTask,
  findDueTasks,
  markTaskNeedsAttention,
  parkForApproval,
  recordFailedAttempt,
  sleepTask,
  taskState,
  wakeTask,
} from './machine.js';

describe('deriveTaskTitle', () => {
  const event = (payload: Record<string, unknown>) =>
    ({ agentId: 'a', trust: 'owner', payload }) as unknown as InboundEvent;

  it('prefers subject, then message text, trimmed to one line', () => {
    expect(deriveTaskTitle(event({ subject: 'Dinner Friday?' }))).toBe('Dinner Friday?');
    expect(deriveTaskTitle(event({ text: 'add lunch\nFriday noon' }))).toBe(
      'add lunch Friday noon',
    );
    expect(deriveTaskTitle(event({}))).toBeUndefined();
    expect(deriveTaskTitle(event({ text: 'x'.repeat(200) }))?.length).toBe(80);
  });
});

const { notifyTask } = vi.hoisted(() => ({ notifyTask: vi.fn() }));
vi.mock('../queue.js', () => ({ getQueueNotifier: () => ({ notify: notifyTask }) }));

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];

/**
 * These tests share a long-lived development database with whatever work is
 * already queued there. Stamping a row with this makes it sort first in
 * findDueTasks' `updatedAt` ordering, so assertions about the sweep are about
 * the sweep and not about how much unrelated work happens to be pending.
 */
const OLDEST = new Date('2000-01-01T00:00:00Z');

function event(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    source: 'internal',
    agentId,
    trust: 'assistant',
    payload: {},
    ...overrides,
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('machine.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdTaskIds.length) {
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

async function track<T extends { task: { id: string } }>(p: Promise<T>): Promise<T> {
  const result = await p;
  createdTaskIds.push(result.task.id);
  return result;
}

describe('task state machine (integration)', () => {
  beforeEach(() => notifyTask.mockClear());

  it('enqueues idempotently on externalEventId', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const ev = event({ externalEventId: `test-evt-${Date.now()}` });
    const first = await track(enqueueTask(db, { event: ev, type: 'adhoc' }));
    const second = await enqueueTask(db, { event: ev, type: 'adhoc' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(notifyTask).toHaveBeenCalledTimes(1);
    expect(notifyTask).toHaveBeenCalledWith(first.task.id, first.task.queueGeneration);
  });

  it('claim wins exactly once between racers', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    const [a, b] = await Promise.all([claimTask(db, task.id), claimTask(db, task.id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = a ?? b;
    expect(winner?.status).toBe('running');
    expect(winner?.attempt).toBe(0);
  });

  it('checkpoint round-trips state; park + wake resumes from it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    const claimed = await claimTask(db, task.id);
    expect(claimed).not.toBeNull();

    const state = taskState(claimed as NonNullable<typeof claimed>);
    state.phase = 'step-3';
    state.scratchpad = 'found two options';
    state.completedToolCallIds.push('tc-1');
    await checkpointTask(db, claimed as NonNullable<typeof claimed>, state, {
      progress: 'comparing options',
    });

    const pending = [
      {
        approvalId: '00000000-0000-0000-0000-000000000001',
        toolCallId: 'call_abc',
        dbToolCallId: '00000000-0000-0000-0000-000000000002',
        toolName: 'gmail.send',
      },
    ];
    await parkForApproval(db, claimed as NonNullable<typeof claimed>, state, pending);
    let [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('waiting_approval');

    // waiting_approval is NOT claimable — the queue can't steal a parked task
    expect(await claimTask(db, task.id)).toBeNull();

    await wakeTask(db, task.id);
    const reclaimed = await claimTask(db, task.id);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.attempt).toBe(0);
    const resumed = taskState(reclaimed as NonNullable<typeof reclaimed>);
    expect(resumed.phase).toBe('step-3');
    expect(resumed.scratchpad).toBe('found two options');
    expect(resumed.completedToolCallIds).toContain('tc-1');
    expect(resumed.pendingApprovals).toEqual(pending);

    await completeTask(db, reclaimed as NonNullable<typeof reclaimed>, { status: 'done' });
    [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('done');
  });

  it('preserves retry and reclaim budgets for metadata-only checkpoints', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    await db.update(tasks).set({ attempt: 7, reclaimCount: 4 }).where(eq(tasks.id, task.id));
    const lease = await claimTask(db, task.id);
    if (!lease) throw new Error('Missing test lease');
    const state = taskState(lease);
    state.plannerState = { planningRecall: { status: 'skipped' } };
    expect(await checkpointTask(db, lease, state, { preserveFailureCounters: true })).toBe(true);
    const [stored] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(stored).toMatchObject({ attempt: 7, reclaimCount: 4 });
    expect(stored?.state).toEqual(state);
    expect(await recordFailedAttempt(db, lease, 'first work step failed')).toBe('dead_letter');
  });

  it('clears a delivered needs-attention final before retrying saved work', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    const claimed = await claimTask(db, task.id);
    expect(claimed).not.toBeNull();

    const state = taskState(claimed as NonNullable<typeof claimed>);
    state.step = 3;
    state.completedToolCallIds.push('verified-work');
    state.pendingFinal = {
      text: 'Retry this task.',
      progress: 'progress was not saved',
      terminalStatus: 'needs_attention',
      outcome: 'needs_attention',
      deliveryAttempted: true,
    };
    expect(await checkpointTask(db, claimed as NonNullable<typeof claimed>, state)).toBe(true);
    expect(
      await markTaskNeedsAttention(
        db,
        claimed as NonNullable<typeof claimed>,
        'progress was not saved',
      ),
    ).toBe(true);

    expect(await wakeTask(db, task.id)).toBe(true);
    const [woken] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(woken?.status).toBe('pending');
    const resumed = taskState(woken as NonNullable<typeof woken>);
    expect(resumed.pendingFinal).toBeUndefined();
    expect(resumed.step).toBe(3);
    expect(resumed.completedToolCallIds).toContain('verified-work');
  });

  it('raises an approved budget and wakes atomically, without changing cancelled or stale requests', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    await db
      .update(tasks)
      .set({ status: 'needs_attention', budgetUsdLimit: '0.1000', spentUsd: '0.0500' })
      .where(eq(tasks.id, task.id));
    const outcomes = await Promise.all([
      wakeTask(db, task.id, { agentId, limit: 0.25 }),
      wakeTask(db, task.id, { agentId, limit: 0.25 }),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const [raised] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(raised?.status).toBe('pending');
    expect(Number(raised?.budgetUsdLimit)).toBe(0.25);
    await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, task.id));
    expect(await wakeTask(db, task.id, { agentId, limit: 0.5 })).toBe(false);
    const [unchanged] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(Number(unchanged?.budgetUsdLimit)).toBe(0.25);
  });

  it('sleeping tasks are not due until runAfter, then wake via findDueTasks', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    const claimed = await claimTask(db, task.id);
    const future = new Date(Date.now() + 60_000);
    await sleepTask(
      db,
      claimed as NonNullable<typeof claimed>,
      taskState(claimed as NonNullable<typeof claimed>),
      future,
    );

    const dueNow = await findDueTasks(db, 100);
    expect(dueNow.map((t) => t.id)).not.toContain(task.id);

    const past = new Date(Date.now() - 1000);
    // findDueTasks orders by updatedAt ascending and takes `limit`. A row this
    // test just wrote is the newest, so on a database with more due work than
    // the limit it sorts off the end and the assertion fails for reasons that
    // have nothing to do with the behaviour under test. Backdating makes this
    // task sort first, so the sweep sees it no matter what else is queued.
    await db.update(tasks).set({ runAfter: past, updatedAt: OLDEST }).where(eq(tasks.id, task.id));
    const dueLater = await findDueTasks(db, 100);
    expect(dueLater.map((t) => t.id)).toContain(task.id);
  });

  it('dead-letters after max attempts', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    await db.update(tasks).set({ attempt: 7 }).where(eq(tasks.id, task.id));
    const claimed = await claimTask(db, task.id);
    const outcome = await recordFailedAttempt(db, claimed as NonNullable<typeof claimed>, 'boom');
    expect(outcome).toBe('dead_letter');
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after?.status).toBe('needs_attention');
  });

  it('retries below max attempts with backoff', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    const claimed = await claimTask(db, task.id);
    const outcome = await recordFailedAttempt(
      db,
      claimed as NonNullable<typeof claimed>,
      'transient',
    );
    expect(outcome).toBe('retry');
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after?.status).toBe('sleeping');
    expect(after?.attempt).toBe(1);
    expect(after?.runAfter?.getTime()).toBeGreaterThan(Date.now());
  });

  it('reclaims an expired running lease and fences the stale worker', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    const stale = await claimTask(db, task.id);
    expect(stale).not.toBeNull();

    await db
      .update(tasks)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, task.id));
    const reclaimed = await claimTask(db, task.id);
    expect(reclaimed).not.toBeNull();

    expect(
      await completeTask(db, stale as NonNullable<typeof stale>, {
        status: 'done',
        progress: 'stale completion',
      }),
    ).toBe(false);
    expect(
      await checkpointTask(
        db,
        stale as NonNullable<typeof stale>,
        taskState(stale as NonNullable<typeof stale>),
      ),
    ).toBe(false);

    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after?.status).toBe('running');
    expect(after?.lockedUntil).toEqual(reclaimed?.lockedUntil);
  });

  it('gives an expired lease one new queue generation for all sweepers', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    const stale = await claimTask(db, task.id);
    expect(stale).not.toBeNull();

    await db
      .update(tasks)
      // Backdated for the same reason as the sleeping-task sweep above: keep
      // this row at the front of findDueTasks' updatedAt ordering so a busy
      // database cannot push it past the limit.
      .set({ lockedUntil: new Date(Date.now() - 1000), updatedAt: OLDEST })
      .where(eq(tasks.id, task.id));
    const firstSweep = await findDueTasks(db, 100);
    const first = firstSweep.find((candidate) => candidate.id === task.id);
    expect(first?.status).toBe('pending');
    expect(first?.queueGeneration).toBe(task.queueGeneration + 1);

    const secondSweep = await findDueTasks(db, 100);
    const second = secondSweep.find((candidate) => candidate.id === task.id);
    expect(second?.queueGeneration).toBe(first?.queueGeneration);
  });

  it('terminal cancellation cannot be overwritten or woken by a late worker', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    const claimed = await claimTask(db, task.id);
    expect(claimed).not.toBeNull();

    expect(await completeTask(db, task.id, { status: 'cancelled' })).toBe(true);
    expect(await completeTask(db, claimed as NonNullable<typeof claimed>, { status: 'done' })).toBe(
      false,
    );
    expect(await wakeTask(db, task.id)).toBe(false);

    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after?.status).toBe('cancelled');
  });

  it('ordinary sleep and approval resumes do not consume the failure budget', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    const first = await claimTask(db, task.id);
    expect(first?.attempt).toBe(0);
    await sleepTask(
      db,
      first as NonNullable<typeof first>,
      taskState(first as NonNullable<typeof first>),
      new Date(Date.now() - 1000),
    );
    const resumed = await claimTask(db, task.id);
    expect(resumed?.attempt).toBe(0);
  });

  it('does not let a duplicate queue delivery resume a task waiting for an event', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    await db
      .update(tasks)
      .set({ status: 'waiting_event', lockedUntil: null, runAfter: null })
      .where(eq(tasks.id, task.id));
    expect(await claimTask(db, task.id)).toBeNull();
  });

  it('reclaims a legacy running row whose lease token is missing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    await db
      .update(tasks)
      .set({ status: 'running', lockedUntil: null })
      .where(eq(tasks.id, task.id));
    expect(await claimTask(db, task.id)).not.toBeNull();
  });
});
