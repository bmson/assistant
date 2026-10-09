import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The poller reaches for real work through these two modules only, so stubbing
// them is enough to drive the loop without a database or a model.
const getAgent = vi.hoisted(() => vi.fn(async () => ({ id: 'agent', timezone: 'UTC' })));
const notifyTask = vi.hoisted(() => vi.fn());
const expireStaleApprovals = vi.hoisted(() => vi.fn(async () => [] as string[]));
const emitBudgetNotices = vi.hoisted(() => vi.fn(async () => [] as string[]));
const findDueTasks = vi.hoisted(() => vi.fn());
const executeAgentTask = vi.hoisted(() => vi.fn());
const sweepStep = vi.hoisted(() => vi.fn());
const firestoreMaintenanceReady = vi.hoisted(() => vi.fn());
const runDueSchedules = vi.hoisted(() => vi.fn());
const renotifyStalledApprovals = vi.hoisted(() => vi.fn(async () => 0));
const notifyApproval = vi.hoisted(() => vi.fn(async () => {}));
const runFirestoreSweep = vi.hoisted(() => vi.fn(async () => ({ ready: true, report: {} })));

vi.mock('@assistant/core', () => ({
  findDueTasks,
  backfillMessageEmbeddings: sweepStep,
  emitBudgetNotices,
  expireStaleApprovals,
  expireStaleSuggestions: vi.fn(async () => 0),
  getAgent,
  getQueueNotifier: () => ({ notify: notifyTask }),
  purgeAgedHistory: sweepStep,
  purgeExpired: sweepStep,
  renotifyStalledApprovals,
  renotifyStalledAttention: vi.fn(async () => 0),
  repairMissionReports: vi.fn(async () => 0),
  resumeResolvedApprovalTasks: vi.fn(async () => []),
  runDueSchedules,
}));
vi.mock('./firestore-sweep.js', () => ({ runFirestoreSweep }));
vi.mock('./task-runner.js', () => ({ executeAgentTask }));
vi.mock('./executor-deps.js', () => ({
  executorDeps: () => ({ notifyApproval, notifyOwner: vi.fn() }),
}));
vi.mock('./deps.js', () => ({ agentServices: () => ({}), firestoreMaintenanceReady }));

const { startPoller } = await import('./poller.js');
const { runPostgresSweep } = await import('./postgres-sweep.js');

/** Just enough of AgentDeps for the loop; everything it touches is mocked. */
const deps = {
  config: { PERSISTENCE_DRIVER: 'postgres' as const },
  db: {},
  router: {},
  registry: {} as never,
  dispatcher: {} as never,
  workspace: {} as never,
  outOfBandNotifier: {} as never,
  modules: { sweepSteps: [], ticks: [] },
} as never;

function due(...ids: string[]) {
  return ids.map((id) => ({ id, type: 'adhoc' }));
}

/** The real findDueTasks ends in `.limit(limit)`; the stub honours that too. */
function dueUpTo(...ids: string[]) {
  return (_db: unknown, limit: number) => Promise.resolve(due(...ids).slice(0, limit));
}

beforeEach(() => {
  vi.useFakeTimers();
  getAgent.mockReset();
  getAgent.mockResolvedValue({ id: 'agent', timezone: 'UTC' });
  emitBudgetNotices.mockClear();
  expireStaleApprovals.mockClear();
  notifyTask.mockClear();
  sweepStep.mockClear();
  findDueTasks.mockReset();
  executeAgentTask.mockReset();
  firestoreMaintenanceReady.mockReset();
  runDueSchedules.mockReset();
  renotifyStalledApprovals.mockReset();
  notifyApproval.mockReset();
  runFirestoreSweep.mockClear();
  findDueTasks.mockResolvedValue([]);
  executeAgentTask.mockResolvedValue({ outcome: 'done' });
  firestoreMaintenanceReady.mockResolvedValue(true);
  runDueSchedules.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startPoller', () => {
  it('refuses to drain due work or run ticks during a restore rehearsal', () => {
    const restoredWork = ['task', 'reminder', 'approval', 'schedule'] as const;
    const providerSend = vi.fn();
    const maintenance = vi.fn();
    findDueTasks.mockResolvedValue(
      restoredWork.map((type, index) => ({ id: `${type}-${index}`, type })),
    );
    const rehearsalDeps = {
      config: {
        PERSISTENCE_DRIVER: 'postgres',
        QUEUE_DRIVER: 'inert',
        RESTORE_REHEARSAL: true,
      },
      db: {},
      router: {},
      modules: {
        sweepSteps: [{ name: 'fake-provider-maintenance', run: providerSend }],
        ticks: [{ name: 'fake-provider-tick', everyTicks: 1, run: maintenance }],
      },
    } as never;
    expect(() => startPoller(rehearsalDeps)).toThrow(
      'background dispatch is disabled during restore rehearsal',
    );
    expect(findDueTasks).not.toHaveBeenCalled();
    expect(executeAgentTask).not.toHaveBeenCalled();
    expect(runDueSchedules).not.toHaveBeenCalled();
    expect(emitBudgetNotices).not.toHaveBeenCalled();
    expect(notifyApproval).not.toHaveBeenCalled();
    expect(providerSend).not.toHaveBeenCalled();
    expect(maintenance).not.toHaveBeenCalled();
  });

  // The finding: the loop awaited each due task in turn, so one slow browser
  // or code step held every other task behind it. Compose sets
  // QUEUE_DRIVER=local, so for a self-hosted install this loop IS the queue.
  it('runs due tasks side by side instead of one after another', async () => {
    let releaseFirst: (() => void) | undefined;
    executeAgentTask.mockImplementation(async (_deps: unknown, taskId: string) => {
      if (taskId === 'slow') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { outcome: 'done' };
    });
    findDueTasks.mockResolvedValueOnce(due('slow', 'quick')).mockResolvedValue([]);

    const stop = startPoller(deps);
    await vi.advanceTimersByTimeAsync(2_000);

    // The quick task finished while the slow one is still in flight.
    const started = executeAgentTask.mock.calls.map((call) => call[1]);
    expect(started).toContain('slow');
    expect(started).toContain('quick');
    releaseFirst?.();
    stop();
  });

  it('never runs more than the concurrency budget at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    executeAgentTask.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return { outcome: 'done' };
    });
    findDueTasks.mockImplementation(dueUpTo('a', 'b', 'c', 'd', 'e'));

    const stop = startPoller(deps);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(peak).toBeLessThanOrEqual(3);
    // And it never asked for more than it had room for.
    for (const call of findDueTasks.mock.calls) expect(call[1]).toBeLessThanOrEqual(3);
    for (const release of releases) release();
    stop();
  });

  // The other half of the finding: the sweep shared the task guard, so while a
  // long task ran nothing expired approvals, fired schedules, or re-notified.
  it('sweeps on schedule even while a task is still running', async () => {
    const releases: Array<() => void> = [];
    executeAgentTask.mockImplementation(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { outcome: 'done' };
    });
    findDueTasks.mockResolvedValueOnce(due('endless')).mockResolvedValue([]);

    const stop = startPoller(deps);
    // Past the sweep cadence (every 30 ticks of 2s) with the task still stuck.
    await vi.advanceTimersByTimeAsync(62_000);
    expect(sweepStep).toHaveBeenCalled();
    for (const release of releases) release();
    stop();
  });

  it('continues independent maintenance after an owner read fails and logs the failed step', async () => {
    getAgent.mockRejectedValueOnce(new Error('Owner read unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = startPoller({
      config: { PERSISTENCE_DRIVER: 'postgres' },
      db: {},
      router: {},
      modules: { sweepSteps: [{ name: 'independent-module', run: sweepStep }], ticks: [] },
    } as never);
    await vi.advanceTimersByTimeAsync(62_000);
    stop();
    expect(expireStaleApprovals).toHaveBeenCalledTimes(1);
    // Purge, aged history, embedding backfill and the module still ran.
    expect(sweepStep).toHaveBeenCalledTimes(4);
    expect(runDueSchedules).not.toHaveBeenCalled();
    expect(emitBudgetNotices).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith('maintenance pass incomplete', {
      failedSteps: ['getAgent'],
      skippedSteps: ['repairMissionReports', 'runDueSchedules', 'emitBudgetNotices'],
    });
  });

  it('returns the same failure receipt to HTTP callers and continues the queue backstop', async () => {
    getAgent.mockRejectedValueOnce(new Error('Owner read unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    findDueTasks.mockResolvedValue([{ id: 'ready-task', queueGeneration: 2 }]);
    const result = await runPostgresSweep(deps, { notifyDueTasks: true });
    expect(result).toMatchObject({
      failedSteps: ['getAgent'],
      skippedSteps: ['repairMissionReports', 'runDueSchedules', 'emitBudgetNotices'],
      dueTasksNotified: 1,
    });
    expect(notifyTask).toHaveBeenCalledWith('ready-task', 2);
    expect(sweepStep).toHaveBeenCalledTimes(3);
  });

  it('runs the shared Firestore sweep without entering PostgreSQL sweeps', async () => {
    const firestoreDeps = {
      config: { PERSISTENCE_DRIVER: 'firestore', FIRESTORE_AGENT_ID: 'owner-agent' },
      db: {},
      router: {},
      firestoreTasks: { findDueTasksForAgent: vi.fn(async () => []) },
      modules: { sweepSteps: [{ name: 'sql', run: sweepStep }], ticks: [] },
    } as never;

    const stop = startPoller(firestoreDeps);
    await vi.advanceTimersByTimeAsync(62_000);

    expect(runFirestoreSweep).toHaveBeenCalledTimes(1);
    expect(runFirestoreSweep).toHaveBeenCalledWith(firestoreDeps);
    expect(sweepStep).not.toHaveBeenCalled();
    expect(runDueSchedules).not.toHaveBeenCalled();
    expect(renotifyStalledApprovals).not.toHaveBeenCalled();
    stop();
  });

  it('keeps all module ticks fenced while Firestore activation is pending', async () => {
    firestoreMaintenanceReady.mockResolvedValue(false);
    const sqlTick = vi.fn(async () => {});
    const portableTick = vi.fn(async () => {});
    const firestoreDeps = {
      config: { PERSISTENCE_DRIVER: 'firestore', FIRESTORE_AGENT_ID: 'owner-agent' },
      db: {},
      router: {},
      firestoreTasks: { findDueTasksForAgent: vi.fn(async () => []) },
      modules: {
        sweepSteps: [],
        ticks: [
          { name: 'sql-tick', everyTicks: 1, run: sqlTick },
          { name: 'portable-tick', everyTicks: 1, portable: true, run: portableTick },
        ],
      },
    } as never;

    const stop = startPoller(firestoreDeps);
    await vi.advanceTimersByTimeAsync(4_100);

    expect(portableTick).not.toHaveBeenCalled();
    expect(sqlTick).not.toHaveBeenCalled();
    stop();
  });

  it('admits the next portable tick after explicit activation', async () => {
    let active = false;
    firestoreMaintenanceReady.mockImplementation(async () => active);
    const portableTick = vi.fn(async () => {});
    const firestoreDeps = {
      config: { PERSISTENCE_DRIVER: 'firestore', FIRESTORE_AGENT_ID: 'owner-agent' },
      db: {},
      firestoreTasks: { findDueTasksForAgent: vi.fn(async () => []) },
      router: {},
      modules: {
        sweepSteps: [],
        ticks: [{ name: 'portable', everyTicks: 1, portable: true, run: portableTick }],
      },
    } as never;

    const stop = startPoller(firestoreDeps);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(portableTick).not.toHaveBeenCalled();

    active = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(portableTick).toHaveBeenCalledOnce();
    stop();
  });

  it('keeps one slow run per recurring module tick without holding other work', async () => {
    let release: (() => void) | undefined;
    const slowTick = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const quickTick = vi.fn(async () => {});
    const tickDeps = {
      db: {},
      router: {},
      config: { PERSISTENCE_DRIVER: 'postgres' },
      modules: {
        sweepSteps: [],
        ticks: [
          { name: 'slow-provider', everyTicks: 1, run: slowTick },
          { name: 'quick-provider', everyTicks: 1, run: quickTick },
        ],
      },
    } as never;
    findDueTasks.mockResolvedValueOnce(due('owner-request')).mockResolvedValue([]);
    const stop = startPoller(tickDeps);
    await vi.advanceTimersByTimeAsync(6_000);

    expect(slowTick).toHaveBeenCalledTimes(1);
    expect(quickTick).toHaveBeenCalledTimes(3);
    expect(executeAgentTask).toHaveBeenCalledWith(tickDeps, 'owner-request');

    release?.();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(slowTick).toHaveBeenCalledTimes(2);
    release?.();
    stop();
  });

  it('releases a failed or synchronously throwing module tick for the next cadence', async () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const moduleTick = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('provider crashed');
      })
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValue(undefined);
    const tickDeps = {
      db: {},
      router: {},
      config: { PERSISTENCE_DRIVER: 'postgres' },
      modules: { sweepSteps: [], ticks: [{ name: 'provider', everyTicks: 1, run: moduleTick }] },
    } as never;

    const stop = startPoller(tickDeps);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(moduleTick).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledTimes(2);
    stop();
  });
});
