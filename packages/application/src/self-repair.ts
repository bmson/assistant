import {
  ACTIVE_REPAIR_STATUSES,
  queuedRepairIssues,
  type RepairIssue,
  repairDispatchesUsed,
  repairOutcome,
  type SelfRepairRepository,
} from '@assistant/persistence';

export { isRepairFeedback, reportRepair } from '@assistant/core/workflow/self-repair';

function githubLink(value?: string): string | null {
  return value &&
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull\/\d+|actions\/runs\/\d+)$/.test(value)
    ? value
    : null;
}
export function projectRepairIssue(issue: RepairIssue) {
  const outcome = repairOutcome(issue);
  return {
    id: issue.id,
    title: issue.data.title,
    summary: issue.data.summary,
    status: issue.status,
    diagnosis: issue.data.diagnosis ?? '',
    lastError: ['failed', 'blocked'].includes(issue.status)
      ? `${outcome.message} ${outcome.nextStep}`
      : '',
    outcome,
    deploymentConfirmed: Boolean(issue.data.mergeSha && issue.data.monitoringAt),
    sourceTaskId: issue.data.sourceTaskId ?? null,
    manualRunRequested: Boolean(issue.data.manualRunRequestedAt),
    prUrl: githubLink(issue.data.prUrl),
    runUrl: githubLink(issue.data.runUrl),
    mergeSha: issue.data.mergeSha ?? null,
    history: issue.data.history.map((entry) =>
      ['failed', 'blocked'].includes(entry.status)
        ? {
            ...entry,
            detail: 'This stage did not complete. Inspect the recorded evidence before retrying.',
          }
        : entry,
    ),
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
  };
}
export async function listRepairIssues(
  repository: SelfRepairRepository,
  agentId: string,
  dailyLimit?: number,
) {
  const rows = await repository.list(agentId);
  const queue = queuedRepairIssues(rows);
  const active = rows.some((row) => ACTIVE_REPAIR_STATUSES.includes(row.status));
  const used = repairDispatchesUsed(rows);
  return rows
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 100)
    .map((issue) => ({
      ...projectRepairIssue(issue),
      queuePosition:
        issue.status === 'reported' ? queue.findIndex((row) => row.id === issue.id) + 1 : null,
      waitingReason:
        issue.status === 'reported'
          ? active
            ? 'Waiting for the current investigation or PR review to finish.'
            : issue.data.manualRunRequestedAt
              ? 'Manual run requested. Starts on the next minute check.'
              : dailyLimit !== undefined && used >= dailyLimit
                ? `Daily coding allowance used: ${used} of ${dailyLimit} attempts in the last 24 hours. Starts automatically when an allowance is available.`
                : 'Queued for automatic investigation on the next minute check.'
          : null,
    }));
}
export async function decideRepairIssue(
  repository: SelfRepairRepository,
  agentId: string,
  id: string,
  action: 'dismiss' | 'retry' | 'resolve' | 'run_now',
) {
  const issue = (await repository.list(agentId)).find((row) => row.id === id);
  if (!issue) throw new Error('Repair issue not found');
  if ((action === 'retry' || action === 'run_now') && issue.data.hostedCleanupPending)
    throw new Error(
      'The previous coding session is being stopped. Try again after the next automatic check.',
    );
  if (
    action === 'dismiss' &&
    ['investigating', 'fixing', 'testing', 'pr_open'].includes(issue.status)
  )
    throw new Error('Active work must finish first. Close an open PR on GitHub to dismiss it.');
  if (action === 'retry' && !['failed', 'blocked'].includes(issue.status))
    throw new Error('Only failed or blocked issues can be retried');
  if (
    action === 'resolve' &&
    (issue.status !== 'monitoring' || !issue.data.mergeSha || !issue.data.monitoringAt)
  )
    throw new Error('Confirm resolution after the fix is deployed');
  if (action === 'run_now' && !['reported', 'failed', 'blocked'].includes(issue.status))
    throw new Error('Only queued, failed or blocked reports can be run now');
  if (
    (action === 'retry' || action === 'run_now') &&
    (issue.data.workerProvider ?? 'github') === 'github' &&
    issue.data.prNumber
  )
    throw new Error(
      'This investigation already has a pull request. Review it on GitHub, or report a new issue for a fresh code-fix attempt.',
    );
  if (action === 'run_now' && issue.data.manualRunRequestedAt) return;
  const requestedAt = new Date();
  const next = await repository.update(
    issue,
    action === 'retry' || action === 'run_now'
      ? 'reported'
      : action === 'resolve'
        ? 'resolved'
        : 'dismissed',
    {
      lastError: '',
      ...(action === 'retry' || action === 'run_now'
        ? {
            manualRunRequestedAt: action === 'run_now' ? requestedAt.toISOString() : undefined,
            manualRunStartedAt: undefined,
            notifiedStatus: undefined,
            runId: undefined,
            runUrl: undefined,
            diagnosis: undefined,
            category: undefined,
            targetPaths: undefined,
            reproduction: undefined,
            acceptance: undefined,
            branch: undefined,
            dispatchedAt: undefined,
            workerProvider: undefined,
            hostedSessionId: undefined,
            hostedTurnId: undefined,
            hostedSourceSha: undefined,
            hostedCommitSha: undefined,
            hostedPublishedAt: undefined,
            hostedCleanupPending: undefined,
            prNumber: undefined,
            prUrl: undefined,
            mergeSha: undefined,
            monitoringAt: undefined,
          }
        : {}),
    },
    requestedAt,
  );
  if (!next) throw new Error('Issue changed; refresh and try again');
}
