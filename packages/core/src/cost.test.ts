import {
  costEvents,
  costReservations,
  createDb,
  type Db,
  SPEND_SOURCES,
  tasks,
} from '@assistant/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from './chat.js';
import {
  BudgetReservationError,
  LEDGER_WIRING,
  nextDailyReset,
  nextMonthlyReset,
  reconcileReservation,
  recordCostEvent,
  releaseReservation,
  releaseStaleReservations,
  reserveCost,
} from './cost.js';
import type { InboundEvent } from './events.js';
import { evaluateBudget } from './model-router/budget.js';
import type { ModelRouter, StepCallOutcome } from './model-router/router.js';
import type { DispatcherPort } from './workflow/executor.js';
import { executeTask } from './workflow/executor.js';
import { enqueueTask } from './workflow/machine.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];
const createdReservationIds: string[] = [];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('cost.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(costEvents).where(eq(costEvents.description, 'xtest-cost'));
    if (createdReservationIds.length) {
      await db.delete(costEvents).where(inArray(costEvents.reservationId, createdReservationIds));
      await db.delete(costReservations).where(inArray(costReservations.id, createdReservationIds));
    }
    if (createdTaskIds.length) {
      await db.delete(costEvents).where(inArray(costEvents.taskId, createdTaskIds));
      await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
    }
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('ledger wiring registry (the CI check)', () => {
  it('every spend source in the schema names its ledger writer', () => {
    // Adding a source to SPEND_SOURCES without wiring it into the ledger (and
    // documenting where, in LEDGER_WIRING) must fail here — that is the point.
    expect(Object.keys(LEDGER_WIRING).sort()).toEqual([...SPEND_SOURCES].sort());
    for (const source of SPEND_SOURCES) {
      expect(LEDGER_WIRING[source].length).toBeGreaterThan(10);
    }
  });
});

describe('evaluateBudget critical carve-out', () => {
  const base = {
    dailyLimitUsd: 2,
    dailySpentUsd: 0,
    monthlyLimitUsd: 20,
    monthlySpentUsd: 0,
    heldUsd: 0,
    softPct: 80,
  };
  it('hard cap blocks non-critical work', () => {
    expect(evaluateBudget({ ...base, dailySpentUsd: 2.1 }).mode).toBe('block');
  });
  it('hard cap degrades critical work inside the carve-out margin', () => {
    const decision = evaluateBudget({ ...base, dailySpentUsd: 2.1 }, { critical: true });
    expect(decision.mode).toBe('fallback');
  });
  it('even critical work blocks past 110% of the cap', () => {
    expect(evaluateBudget({ ...base, dailySpentUsd: 2.3 }, { critical: true }).mode).toBe('block');
  });
});

describe('period resets', () => {
  it('daily reset is tomorrow shortly after midnight; monthly is the 1st', () => {
    const from = new Date('2026-07-16T15:00:00');
    const daily = nextDailyReset(from);
    expect(daily.getDate()).toBe(17);
    expect(daily.getHours()).toBe(0);
    const monthly = nextMonthlyReset(from);
    expect(monthly.getMonth()).toBe(7); // August
    expect(monthly.getDate()).toBe(1);
  });
});

describe('reservations (integration)', () => {
  it('reserves within budget, blocks over budget, reconciles to actuals', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const { task } = await enqueueTask(db, {
      event: { source: 'internal', agentId, trust: 'owner', payload: {} } as InboundEvent,
      type: 'adhoc',
      budgetUsdLimit: '0.10',
    });
    createdTaskIds.push(task.id);

    // The shared numeric(10,6) storage range rejects an unrepresentable
    // estimate before it can create a reservation; this is separate from a
    // representable estimate being denied by the budget cap below.
    await expect(
      reserveCost(db, {
        source: 'cloud_run_job_sec',
        estimatedUsd: 999999,
        taskId: task.id,
      }),
    ).rejects.toThrow('USD exceeds the shared numeric(10,6) storage range');
    const reservationsAfterInvalidEstimate = await db
      .select({ id: costReservations.id })
      .from(costReservations)
      .where(eq(costReservations.taskId, task.id));
    expect(reservationsAfterInvalidEstimate).toHaveLength(0);

    // A large but representable estimate exercises the daily/monthly cap path.
    const over = await reserveCost(db, {
      source: 'cloud_run_job_sec',
      estimatedUsd: 9_999,
      taskId: task.id,
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.resumeAt.getTime()).toBeGreaterThan(Date.now());

    // over the TASK cap specifically (fits daily/monthly)
    const overTask = await reserveCost(db, {
      source: 'cloud_run_job_sec',
      estimatedUsd: 0.2,
      taskId: task.id,
    });
    expect(overTask.ok).toBe(false);

    // a small estimate reserves fine and counts as held
    const okRes = await reserveCost(db, {
      source: 'cloud_run_job_sec',
      estimatedUsd: 0.01,
      taskId: task.id,
      description: 'xtest-cost reservation',
    });
    expect(okRes.ok).toBe(true);
    if (!okRes.ok) return;
    createdReservationIds.push(okRes.reservationId);

    // reconcile to actuals: hold released, ledger row written, task spend bumped
    await reconcileReservation(db, okRes.reservationId, {
      evidence: { basis: 'unknown', provider: 'google-cloud' },
      usd: 0.004,
      quantity: 60,
      unit: 'second',
      description: 'xtest-cost',
    });
    const [reservation] = await db
      .select()
      .from(costReservations)
      .where(eq(costReservations.id, okRes.reservationId));
    expect(reservation?.status).toBe('reconciled');
    expect(Number(reservation?.actualUsd)).toBeCloseTo(0.004, 6);

    const [event] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.reservationId, okRes.reservationId));
    expect(event?.source).toBe('cloud_run_job_sec');
    expect(event?.evidence).toEqual({ basis: 'unknown', provider: 'google-cloud' });
    expect(Number(event?.usd)).toBeCloseTo(0.004, 6);

    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(Number(after?.spentUsd)).toBeCloseTo(0.004, 6);

    // reconciling twice is a no-op (crash-retry safe)
    await reconcileReservation(db, okRes.reservationId, { usd: 99, description: 'xtest-cost' });
    const events = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.reservationId, okRes.reservationId));
    expect(events).toHaveLength(1);

    // release path
    const rel = await reserveCost(db, {
      source: 'cloud_run_job_sec',
      estimatedUsd: 0.01,
      description: 'xtest-cost release',
    });
    expect(rel.ok).toBe(true);
    if (rel.ok) {
      createdReservationIds.push(rel.reservationId);
      await releaseReservation(db, rel.reservationId);
      const [released] = await db
        .select()
        .from(costReservations)
        .where(eq(costReservations.id, rel.reservationId));
      expect(released?.status).toBe('released');
    }
  });

  it('recordCostEvent writes the ledger', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await recordCostEvent(db, {
      source: 'external_api',
      usd: 0.001,
      quantity: 1,
      unit: 'call',
      description: 'xtest-cost',
    });
    const rows = await db.select().from(costEvents).where(eq(costEvents.description, 'xtest-cost'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('serializes concurrent reservations against the same task cap', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await enqueueTask(db, {
      event: { source: 'internal', agentId, trust: 'owner', payload: {} } as InboundEvent,
      type: 'adhoc',
      budgetUsdLimit: '0.0150',
    });
    createdTaskIds.push(task.id);

    const results = await Promise.all([
      reserveCost(db, {
        source: 'external_api',
        estimatedUsd: 0.01,
        taskId: task.id,
        description: 'xtest-cost concurrent-a',
      }),
      reserveCost(db, {
        source: 'external_api',
        estimatedUsd: 0.01,
        taskId: task.id,
        description: 'xtest-cost concurrent-b',
      }),
    ]);
    const accepted = results.filter((result) => result.ok);
    expect(accepted).toHaveLength(1);
    for (const result of accepted) {
      if (result.ok) createdReservationIds.push(result.reservationId);
    }
  });

  it('serializes reconciliation behind the same ledger lock as reservations', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const reservation = await reserveCost(db, {
      source: 'external_api',
      estimatedUsd: 0.001,
      description: 'xtest-cost locked reconciliation',
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;
    createdReservationIds.push(reservation.reservationId);

    let releaseLock!: () => void;
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('assistant:cost-reservations'))`);
      lockAcquired();
      await holdLock;
    });
    await acquired;

    let reconciled = false;
    const reconciliation = reconcileReservation(db, reservation.reservationId, {
      usd: 0.001,
      description: 'xtest-cost',
    }).then(() => {
      reconciled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reconciled).toBe(false);
    } finally {
      releaseLock();
    }
    await blocker;
    await reconciliation;
    expect(reconciled).toBe(true);
  });

  it('releases crash-orphaned reservations after the safety window', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const reservation = await reserveCost(db, {
      source: 'external_api',
      estimatedUsd: 0.001,
      description: 'xtest-cost stale',
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;
    createdReservationIds.push(reservation.reservationId);
    await db
      .update(costReservations)
      .set({ createdAt: sql`now() - interval '3 hours'` })
      .where(eq(costReservations.id, reservation.reservationId));

    await releaseStaleReservations(db, 120);
    const [released] = await db
      .select({ status: costReservations.status })
      .from(costReservations)
      .where(eq(costReservations.id, reservation.reservationId));
    expect(released?.status).toBe('released');
  });
});

describe('waiting_budget parking (integration)', () => {
  const noopDispatcher: DispatcherPort = {
    toolDefs: () => [],
    resultIsUntrusted: () => false,
    dispatch: async () => ({ kind: 'rejected', reason: 'no tools in this test' }),
    executeApproved: async () => ({ kind: 'failed', error: 'no approvals in this test' }),
  };

  it('parks reservation exceptions without consuming the failure allowance', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const resumeAt = new Date(Date.now() + 3600e3);
    const router = {
      async object() {
        throw new BudgetReservationError('embedding budget exhausted (test)', resumeAt);
      },
    } as unknown as ModelRouter;
    const { task } = await enqueueTask(db, {
      event: { source: 'internal', agentId, trust: 'owner', payload: {} } as InboundEvent,
      type: 'adhoc',
    });
    createdTaskIds.push(task.id);

    const result = await executeTask({ db, router, dispatcher: noopDispatcher }, task.id);
    expect(result.outcome).toBe('parked');
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after?.status).toBe('waiting_budget');
    expect(after?.attempt).toBe(0);
    expect(after?.runAfter).toEqual(resumeAt);
  });

  it('a hard-blocked step parks the task as waiting_budget and it resumes after reset', async (ctx) => {
    if (!dbUp) return ctx.skip();

    let blocked = true;
    const fakeRouter = {
      async object() {
        // Planning must succeed so this test exercises a blocked step, not the
        // planner's own fail-closed budget stop.
        return {
          ok: true,
          modelId: 'fake',
          degraded: false,
          object: {
            action: 'reply',
            reasoning: 'Continue to the step-level budget boundary.',
            steps: [],
            missingInfo: [],
          },
        };
      },
      async step(): Promise<StepCallOutcome> {
        if (blocked) {
          return {
            ok: false,
            decision: { mode: 'block', reason: 'daily budget exhausted (test)' },
          };
        }
        return {
          ok: true,
          modelId: 'fake',
          degraded: false,
          text: 'done after budget reset',
          toolCalls: [],
        };
      },
      async embed(texts: string[]) {
        return texts.map(() => new Array(1536).fill(0.01));
      },
    } as unknown as ModelRouter;

    const { task } = await enqueueTask(db, {
      event: { source: 'internal', agentId, trust: 'owner', payload: {} } as InboundEvent,
      type: 'adhoc',
    });
    createdTaskIds.push(task.id);

    const run1 = await executeTask({ db, router: fakeRouter, dispatcher: noopDispatcher }, task.id);
    expect(run1.outcome).toBe('parked');
    let [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('waiting_budget');
    expect(row?.runAfter?.getTime()).toBeGreaterThan(Date.now());

    // period reset: cap available again, runAfter reached → task auto-resumes
    blocked = false;
    await db
      .update(tasks)
      .set({ runAfter: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, task.id));
    const run2 = await executeTask({ db, router: fakeRouter, dispatcher: noopDispatcher }, task.id);
    expect(run2.outcome).toBe('done');
    [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('done');
  });

  it('a budget_blocked tool dispatch parks the task BEFORE launching the action', async (ctx) => {
    if (!dbUp) return ctx.skip();

    let dispatched = 0;
    const blockingDispatcher: DispatcherPort = {
      toolDefs: () => [],
      resultIsUntrusted: () => false,
      dispatch: async () => {
        dispatched += 1;
        return {
          kind: 'budget_blocked',
          reason: 'daily budget cannot cover this (test)',
          resumeAt: new Date(Date.now() + 3600e3),
        };
      },
      executeApproved: async () => ({ kind: 'failed', error: 'unused' }),
    };
    const fakeRouter = {
      async object() {
        // Planning must succeed so the dispatcher-level budget behavior below
        // is the stop condition under test.
        return {
          ok: true,
          modelId: 'fake',
          degraded: false,
          object: {
            action: 'reply',
            reasoning: 'Continue to the tool-dispatch budget boundary.',
            steps: [],
            missingInfo: [],
          },
        };
      },
      async step(): Promise<StepCallOutcome> {
        return {
          ok: true,
          modelId: 'fake',
          degraded: false,
          text: '',
          toolCalls: [{ toolCallId: 'call_1', toolName: 'browser.execute', input: {} }],
        };
      },
    } as unknown as ModelRouter;

    const { task } = await enqueueTask(db, {
      event: { source: 'internal', agentId, trust: 'owner', payload: {} } as InboundEvent,
      type: 'adhoc',
    });
    createdTaskIds.push(task.id);

    const run = await executeTask(
      { db, router: fakeRouter, dispatcher: blockingDispatcher },
      task.id,
    );
    expect(run.outcome).toBe('parked');
    expect(dispatched).toBe(1); // the reservation was checked, nothing launched twice
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('waiting_budget');
  });
});
