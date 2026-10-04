import {
  backfillMessageEmbeddings,
  emitBudgetNotices,
  expireStaleApprovals,
  expireStaleSuggestions,
  findDueTasks,
  getAgent,
  purgeAgedHistory,
  purgeExpired,
  renotifyStalledApprovals,
  renotifyStalledAttention,
  resumeResolvedApprovalTasks,
  runDueSchedules,
} from '@assistant/core';
import { type AgentDeps, agentServices, firestoreOwnerReady } from './deps.js';
import { executorDeps } from './executor-deps.js';
import { runFirestoreSweep } from './firestore-sweep.js';
import { executeAgentTask } from './task-runner.js';

const POLL_INTERVAL_MS = 2000;
const SWEEP_EVERY_TICKS = 30; // ~1 min, matching the prod Cloud Scheduler cadence
/**
 * How many due tasks this process runs at once.
 *
 * This used to be one: the loop awaited each task in turn, so a single browser
 * or code step held up every other task behind it — and, because the sweep
 * shared the same guard, held up approval expiry, schedule firing and the
 * re-notify passes for as long as it ran. In prod Cloud Tasks fans that out
 * across instances, but `docker compose up` is the README's quick start and it
 * sets QUEUE_DRIVER=local, so for a self-hosted install this loop IS the queue.
 *
 * Kept well under the database pool (`max: 10`) so a full batch cannot starve
 * the rest of the process of connections.
 */
const MAX_CONCURRENT_TASKS = 3;

/**
 * Local queue driver: polls for due tasks and executes them in-process.
 * In prod (QUEUE_DRIVER=cloudtasks) Cloud Tasks POSTs /internal/tasks/execute
 * instead and the sweeper runs on Cloud Scheduler.
 */
export function startPoller(deps: AgentDeps): () => void {
  // Two independent guards. Maintenance is not allowed to queue behind task
  // execution, which is what made a long task look like a stalled assistant:
  // the approval it was parked on could not expire, schedules did not fire,
  // and nothing re-notified, for as long as the task ran.
  let sweeping = false;
  let running = 0;
  let tick = 0;
  // Module ticks can perform slow provider reads. Keep one run of each tick
  // in flight so recurring mail sync cannot stack up and monopolize the
  // database/provider connection pools during an outage.
  const activeTicks = new Set<AgentDeps['modules']['ticks'][number]>();

  /** One maintenance pass, guarded so a slow sweep never overlaps itself. */
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    // Each maintenance step is independent; guard each so one failure can't
    // starve the rest (mirrors the prod /internal/sweep resilience).
    const runStep = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        console.error(`sweep step failed: ${name}`, err);
      }
    };
    try {
      if (deps.config.PERSISTENCE_DRIVER === 'firestore') {
        // The same repository-only pass as /internal/sweep. Invoking the SQL
        // maintenance below would hit the Firestore mode's PostgreSQL tripwire.
        await runFirestoreSweep(deps);
        return;
      }
      await runStep('expireStaleApprovals', async () => {
        const woken = await expireStaleApprovals(deps.db);
        if (woken.length) console.log(`sweep: expired approvals woke ${woken.length} task(s)`);
      });
      await runStep('expireStaleSuggestions', async () => {
        const expired = await expireStaleSuggestions(deps.db);
        if (expired) console.log(`sweep: expired ${expired} unanswered suggestion(s)`);
      });
      await runStep('resumeResolvedApprovalTasks', async () => {
        const resumed = await resumeResolvedApprovalTasks(deps.db);
        if (resumed.length)
          console.log(`sweep: resumed ${resumed.length} stranded approval task(s)`);
      });
      await runStep('renotifyStalledApprovals', async () => {
        const renotified = await renotifyStalledApprovals(
          deps.db,
          executorDeps(deps).notifyApproval,
        );
        if (renotified) console.log(`sweep: re-notified ${renotified} silent approval(s)`);
      });
      await runStep('renotifyStalledAttention', async () => {
        const renotified = await renotifyStalledAttention(deps.db, executorDeps(deps).notifyOwner);
        if (renotified) console.log(`sweep: re-notified ${renotified} stalled task(s)`);
      });
      const agent = await getAgent(deps.db);
      await runStep('runDueSchedules', async () => {
        const fired = await runDueSchedules(deps.db, agent.timezone);
        for (const f of fired)
          console.log(`schedule fired: ${f.schedule} → ${f.taskId.slice(0, 8)}`);
      });
      await runStep('purgeExpired', () => purgeExpired(deps.db));
      await runStep('purgeAgedHistory', () => purgeAgedHistory(deps.db));
      await runStep('backfillMessageEmbeddings', () =>
        backfillMessageEmbeddings(deps.db, deps.router),
      );
      await runStep('emitBudgetNotices', () => emitBudgetNotices(deps.db, agent.id));
      // Module-declared sweep steps, with the same per-step failure isolation.
      for (const sweepStep of deps.modules.sweepSteps) {
        await runStep(sweepStep.name, () => sweepStep.run(agentServices(deps)));
      }
    } catch (err) {
      console.error('sweep error', err);
    } finally {
      sweeping = false;
    }
  };

  /**
   * Claim and run whatever is due, up to the concurrency budget.
   *
   * Tasks run side by side rather than one after another: `claimTask` is an
   * optimistic lock, so two runners racing for the same row is already a case
   * the machine handles — exactly one wins and the loser sees `not_claimable`.
   */
  const drain = async () => {
    const capacity = MAX_CONCURRENT_TASKS - running;
    if (capacity <= 0) return;
    // Reserved synchronously, before the first await. The interval fires again
    // while this pass is still asking what is due, and two passes that both
    // read `running` at zero would each start a full batch.
    running += capacity;
    let due: Awaited<ReturnType<typeof findDueTasks>> = [];
    try {
      // Sliced as well as limited: the budget is what this process can afford
      // to run, so it is enforced here rather than assumed of the query.
      if (deps.config.PERSISTENCE_DRIVER === 'firestore') {
        const tasks = deps.firestoreTasks;
        if (!tasks) throw new Error('Firestore execution persistence is unavailable');
        if (!(await firestoreOwnerReady(deps))) return;
        due = await tasks.findDueTasksForAgent(deps.config.FIRESTORE_AGENT_ID, capacity);
      } else {
        due = (await findDueTasks(deps.db, capacity)).slice(0, capacity);
      }
    } finally {
      // Hand back the share of the reservation this pass will not use.
      running -= capacity - due.length;
    }
    if (due.length === 0) return;
    await Promise.allSettled(
      due.map(async (task) => {
        try {
          if (
            deps.config.PERSISTENCE_DRIVER === 'firestore' &&
            task.agentId !== deps.config.FIRESTORE_AGENT_ID
          ) {
            console.error(`refusing task outside configured Firestore agent: ${task.id}`);
            return;
          }
          const result = await executeAgentTask(deps, task.id);
          if (result.outcome !== 'not_claimable') {
            console.log(`task ${task.id.slice(0, 8)} [${task.type}] → ${result.outcome}`);
          }
        } catch (err) {
          console.error(`task ${task.id.slice(0, 8)} failed`, err);
        } finally {
          running -= 1;
        }
      }),
    );
  };

  const interval = setInterval(() => {
    tick += 1;
    if (tick % SWEEP_EVERY_TICKS === 0) void sweep();
    // Module-declared recurring work (google's mail sync, most notably).
    // Cadence is the module's everyTicks against the shared 2s tick.
    const firestore = deps.config.PERSISTENCE_DRIVER === 'firestore';
    for (const moduleTick of deps.modules.ticks) {
      // A tick that still needs PostgreSQL must not run against the tripwire.
      if (firestore && !moduleTick.portable) continue;
      if (tick % moduleTick.everyTicks === 0 && !activeTicks.has(moduleTick)) {
        activeTicks.add(moduleTick);
        void Promise.resolve()
          .then(() => moduleTick.run(agentServices(deps)))
          .catch((err) => console.error(`${moduleTick.name} error`, err))
          .finally(() => activeTicks.delete(moduleTick));
      }
    }
    void drain().catch((err) => console.error('poller error', err));
  }, POLL_INTERVAL_MS);

  return () => clearInterval(interval);
}
