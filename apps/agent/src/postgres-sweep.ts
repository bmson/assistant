import {
  expireStaleApprovals,
  expireStaleSuggestions,
  findDueTasks,
  resumeResolvedApprovalTasks,
} from '@assistant/core';
import { type AgentDeps, agentServices } from './deps.js';
import { executorDeps } from './executor-deps.js';

/** Shared by the local poller and HTTP scheduler; owner reads cannot abort independent maintenance. */
export async function runPostgresSweep(
  deps: AgentDeps,
  options: { notifyDueTasks?: boolean } = {},
) {
  const {
    backfillMessageEmbeddings,
    emitBudgetNotices,
    getAgent,
    getQueueNotifier,
    purgeAgedHistory,
    purgeExpired,
    renotifyStalledApprovals,
    renotifyStalledAttention,
    repairMissionReports,
    runDueSchedules,
  } = await import('@assistant/core');

  // Each step is independent maintenance; one failing must not starve the rest
  // (a single bad schedule row used to 500 the whole endpoint and stall every
  // later reaper). Wrap each in its own guard and report what ran.
  const failedSteps: string[] = [];
  const skippedSteps: string[] = [];
  const step = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      failedSteps.push(name);
      console.error(`sweep step failed: ${name}`, err);
      return fallback;
    }
  };

  const woken = await step(
    'expireStaleApprovals',
    () => expireStaleApprovals(deps.db),
    [] as string[],
  );
  const expiredSuggestions = await step(
    'expireStaleSuggestions',
    () => expireStaleSuggestions(deps.db),
    0,
  );
  const resumedApprovalTasks = await step(
    'resumeResolvedApprovalTasks',
    () => resumeResolvedApprovalTasks(deps.db),
    [] as string[],
  );
  const renotifiedApprovals = await step(
    'renotifyStalledApprovals',
    () => renotifyStalledApprovals(deps.db, executorDeps(deps).notifyApproval),
    0,
  );
  const renotifiedAttention = await step(
    'renotifyStalledAttention',
    () => renotifyStalledAttention(deps.db, executorDeps(deps).notifyOwner),
    0,
  );
  // Guarded like every other step: this one read used to sit outside the
  // guards, so a single database blip threw the WHOLE sweep — including
  // purgeExpired below, which is what releases held cost reservations. A
  // minute-by-minute sweep that dies on a blip turns a transient fault into a
  // tightening budget.
  const agent = await step('getAgent', () => getAgent(deps.db), null);
  const missionReportsRepaired = agent
    ? await step(
        'repairMissionReports',
        () => repairMissionReports({ ...executorDeps(deps), agentId: agent.id }, 20),
        0,
      )
    : 0;
  if (!agent) skippedSteps.push('repairMissionReports', 'runDueSchedules', 'emitBudgetNotices');
  const fired = agent
    ? await step(
        'runDueSchedules',
        () => runDueSchedules(deps.db, agent.timezone),
        [] as Awaited<ReturnType<typeof runDueSchedules>>,
      )
    : [];
  const budgetNotices = agent
    ? await step('emitBudgetNotices', () => emitBudgetNotices(deps.db, agent.id), [] as string[])
    : [];
  const due = options.notifyDueTasks
    ? await step(
        'findDueTasks',
        () => findDueTasks(deps.db, 50),
        [] as Awaited<ReturnType<typeof findDueTasks>>,
      )
    : [];
  let dueTasksNotified = 0;
  for (const task of due) {
    const accepted = await step(
      `notifyDueTask:${task.id}`,
      async () => {
        getQueueNotifier().notify(task.id, task.queueGeneration);
        return true;
      },
      false,
    );
    if (accepted) dueTasksNotified++;
  }
  const embedded = await step(
    'backfillMessageEmbeddings',
    () => backfillMessageEmbeddings(deps.db, deps.router),
    0,
  );
  const purged = await step(
    'purgeExpired',
    () => purgeExpired(deps.db),
    null as Awaited<ReturnType<typeof purgeExpired>> | null,
  );
  const aged = await step(
    'purgeAgedHistory',
    () => purgeAgedHistory(deps.db),
    null as Awaited<ReturnType<typeof purgeAgedHistory>> | null,
  );
  // Module-declared sweep steps, in composition order, with the same per-step
  // failure isolation as the platform's own.
  const moduleSteps: Record<string, number> = {};
  for (const sweepStep of deps.modules.sweepSteps) {
    moduleSteps[sweepStep.reportKey ?? sweepStep.name] = await step(
      sweepStep.name,
      () => sweepStep.run(agentServices(deps)),
      0,
    );
  }
  return {
    expiredApprovalsWoke: woken.length,
    expiredSuggestions,
    resumedApprovalTasks: resumedApprovalTasks.length,
    renotifiedApprovals,
    renotifiedAttention,
    missionReportsRepaired,
    schedulesFired: fired.length,
    dueTasksNotified,
    messagesEmbedded: embedded,
    budgetNotices: budgetNotices.length,
    ...moduleSteps,
    purged,
    aged,
    failedSteps,
    skippedSteps,
  };
}
