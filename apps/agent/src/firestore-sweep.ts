import { parseFirestoreEmbeddingSpace } from '@assistant/config';
import {
  backfillMessageEmbeddings,
  dispatchOutbox,
  emitBudgetNotices,
  expireStaleApprovals,
  expireStaleSuggestions,
  firestoreCodeJobUnavailable,
  getTaskQueue,
  isCodeJobEnabled,
  prepareGoalSession,
  purgeAgedHistory,
  purgeExpired,
  renotifyStalledApprovals,
  renotifyStalledAttention,
  repairMissionReports,
  resumeResolvedApprovalTasks,
  runDueSchedules,
} from '@assistant/core';
import { FirestoreOutbox, FirestoreScheduleRepository } from '@assistant/firestore';
import type { TaskQueue } from '@assistant/persistence';
import {
  type AgentDeps,
  agentServices,
  firestoreMaintenanceReady,
  pinnedMemoryEmbed,
} from './deps.js';
import { executorDeps } from './executor-deps.js';
import { ensureRepairSchedule } from './repair-schedule.js';

export type FirestoreSweepResult =
  | { ready: false; error: string }
  | { ready: true; report: Record<string, number> };

/**
 * The single Firestore maintenance pass, shared by `/internal/sweep` and the
 * local poller so the two runtimes cannot drift apart. Each step is isolated:
 * one failure is logged and reported as zero while the rest still run. Only
 * steps that run on portable repositories are here. Module steps and ticks
 * that still need PostgreSQL are skipped until they declare themselves
 * portable.
 *
 * PostgreSQL's `findDueTasks` backstop has no counterpart: every Firestore
 * transition that makes a task runnable commits a durable wake intent, which
 * the local drain or the Cloud Tasks dispatch below delivers.
 */
export async function runFirestoreSweep(
  deps: AgentDeps,
  options: { queue?: TaskQueue } = {},
): Promise<FirestoreSweepResult> {
  let ready = false;
  try {
    ready = await firestoreMaintenanceReady(deps);
  } catch (err) {
    console.error('Firestore maintenance readiness check failed', err);
  }
  if (!ready) return { ready: false, error: 'Firestore installation is not ready for maintenance' };

  const store = deps.firestoreStore;
  const persistence = deps.persistence;
  const maintenance = persistence?.maintenance;
  if (!store || persistence?.driver !== 'firestore' || !maintenance)
    return { ready: false, error: 'Firestore maintenance persistence is unavailable' };
  let timezone: string | undefined;
  try {
    const owner = await store.doc('agents', deps.config.FIRESTORE_AGENT_ID).get();
    const configured = owner.get('timezone');
    if (
      owner.exists &&
      owner.get('id') === deps.config.FIRESTORE_AGENT_ID &&
      typeof configured === 'string' &&
      configured.trim()
    )
      timezone = configured;
  } catch (err) {
    console.error('Firestore schedule timezone read failed', err);
  }
  if (!timezone) return { ready: false, error: 'Firestore agent timezone is unavailable' };

  const step = async (name: string, fn: () => Promise<number>): Promise<number> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`sweep step failed: ${name}`, err);
      return 0;
    }
  };
  let releasedReservations = 0;
  const report: Record<string, number> = {
    expiredApprovalsWoke: await step(
      'expireStaleApprovals',
      async () => (await expireStaleApprovals(persistence.approvals)).length,
    ),
    expiredSuggestions: await step('expireStaleSuggestions', () =>
      expireStaleSuggestions(maintenance),
    ),
    resumedApprovalTasks: await step(
      'resumeResolvedApprovalTasks',
      async () => (await resumeResolvedApprovalTasks(persistence.approvals)).length,
    ),
    renotifiedApprovals: await step('renotifyStalledApprovals', () =>
      renotifyStalledApprovals(persistence, executorDeps(deps).notifyApproval),
    ),
    renotifiedAttention: await step('renotifyStalledAttention', () =>
      renotifyStalledAttention(
        { maintenance, tasks: persistence.tasks },
        executorDeps(deps).notifyOwner,
      ),
    ),
    missionReportsRepaired: await step('repairMissionReports', () =>
      repairMissionReports({ ...executorDeps(deps), agentId: deps.config.FIRESTORE_AGENT_ID }, 20),
    ),
    expiredWatches: await step('expireWatches', () =>
      persistence.watches.expire(deps.config.FIRESTORE_AGENT_ID, new Date()),
    ),
    schedulesFired: await step('runDueSchedules', async () => {
      if (deps.config.SELF_REPAIR_ENABLED)
        await ensureRepairSchedule(
          store,
          deps.config.FIRESTORE_AGENT_ID,
          deps.config.SELF_REPAIR_DAILY_LIMIT,
        );
      const fired = await runDueSchedules(new FirestoreScheduleRepository(store), timezone, {
        // SQL-only jobs advance their schedule without creating a task.
        isJobEnabled: (job) => isCodeJobEnabled(job) && !firestoreCodeJobUnavailable(job),
        // Goal sessions pass the same gate as PostgreSQL. A goal whose state
        // cannot be read skips this firing, which advances its schedule without
        // authorizing work, rather than starving every later schedule.
        prepareGoal: async (row, template) => {
          try {
            return await prepareGoalSession(
              { goals: persistence.goals, tasks: persistence.tasks },
              row.agentId,
              template,
            );
          } catch (err) {
            console.error(`goal schedule preparation failed: ${row.name}`, err);
            return { action: 'skip' };
          }
        },
      });
      for (const item of fired)
        console.log(`schedule fired: ${item.schedule} → ${item.taskId.slice(0, 8)}`);
      return fired.length;
    }),
    budgetNotices: await step(
      'emitBudgetNotices',
      async () =>
        (
          await emitBudgetNotices(
            { costs: persistence.costs, maintenance },
            deps.config.FIRESTORE_AGENT_ID,
          )
        ).length,
    ),
    // Vectors are written only in the configured Firestore embedding space,
    // and only while the embed role still produces that space.
    messagesEmbedded: await step('backfillMessageEmbeddings', () =>
      backfillMessageEmbeddings(maintenance, {
        embeddingSpace: async () =>
          parseFirestoreEmbeddingSpace(deps.config.FIRESTORE_EMBEDDING_SPACE),
        embed: pinnedMemoryEmbed(
          parseFirestoreEmbeddingSpace(deps.config.FIRESTORE_EMBEDDING_SPACE),
          persistence.modelRouting,
          (texts, expectedSpace) => deps.router.embed(texts, { expectedSpace }),
        ),
      }),
    ),
    // Expiry includes releasing held reservations whose task died before
    // settling, which would otherwise count against the budget forever.
    purgedExpired: await step('purgeExpired', async () => {
      const { reservations, ...rest } = await purgeExpired({
        maintenance,
        costs: persistence.costs,
        recallMetrics: persistence.recallMetrics,
      });
      releasedReservations = reservations;
      return Object.values(rest).reduce((sum, count) => sum + count, 0);
    }),
    agedHistory: await step('purgeAgedHistory', async () =>
      Object.values(await purgeAgedHistory(maintenance)).reduce((sum, count) => sum + count, 0),
    ),
  };
  report.releasedReservations = releasedReservations;
  for (const sweepStep of deps.modules.sweepSteps) {
    if (!sweepStep.portable) continue;
    report[sweepStep.reportKey ?? sweepStep.name] = await step(sweepStep.name, () =>
      sweepStep.run(agentServices(deps)),
    );
  }
  if (deps.config.QUEUE_DRIVER === 'cloudtasks') {
    // With Cloud Tasks there is no local poller, so this scheduled sweep is
    // the only dispatcher. Every Firestore transition that makes a task
    // runnable commits a durable wake intent in the same transaction. Here the
    // intents that are due, including this pass's schedule firings and
    // approval wakes, are handed to Cloud Tasks under the stable
    // (task, generation) name, which dedupes the best-effort immediate enqueue.
    // It runs last so everything above is dispatched in the same pass.
    const tasks = deps.firestoreTasks;
    report.reclaimedTaskLeases = await step('reclaimExpiredTaskLeases', async () => {
      // Expired leases are reclaimed as a side effect of the scoped due-task
      // query. Each reclaim bumps the generation and commits a wake intent;
      // the returned rows already hold intents and need nothing further.
      if (!tasks) throw new Error('Firestore task persistence is unavailable');
      return (await tasks.findDueTasksForAgent(deps.config.FIRESTORE_AGENT_ID, 50)).length;
    });
    const dispatched = await (async () => {
      try {
        return await dispatchOutbox(new FirestoreOutbox(store), options.queue ?? getTaskQueue(), {
          batch: 50,
          concurrency: 4,
          maxDurationMs: 30_000,
        });
      } catch (err) {
        console.error('sweep step failed: dispatchWakeIntents', err);
        return null;
      }
    })();
    report.wakeIntentsDispatched = dispatched?.delivered ?? 0;
    report.wakeIntentsRetrying = dispatched?.retried ?? 0;
    report.wakeIntentErrors = dispatched ? dispatched.errors + dispatched.leaseLost : 1;
  }
  return { ready: true, report };
}
