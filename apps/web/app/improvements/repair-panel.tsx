'use client';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import {
  Badge,
  btn,
  cardBodyClass,
  cardShellClass,
  EmptyState,
  focusRing,
  inputClass,
  labelClass,
  textareaClass,
} from '@/lib/ui';
import { ActionButton, ActionMenu, Modal } from '@/lib/ui-client';
import { repairDecisionAction, reportRepairAction } from './repair-actions';

const labels: Record<string, string> = {
  reported: 'Queued',
  investigating: 'Investigating',
  fixing: 'Preparing fix',
  testing: 'Testing',
  pr_open: 'Pull request recorded',
  merged: 'Awaiting deployment',
  monitoring: 'Deployment observed · needs confirmation',
  resolved: 'Confirmed fixed',
  blocked: 'Needs attention',
  failed: 'Fix attempt failed',
  dismissed: 'Dismissed',
};
export interface RepairView {
  id: string;
  title: string;
  summary: string;
  status: string;
  diagnosis: string;
  lastError: string;
  manualRunRequested?: boolean;
  queuePosition?: number | null;
  waitingReason?: string | null;
  workerProvider?: 'github' | 'openai_hosted' | null;
  prNumber?: number | null;
  sourceTaskId: string | null;
  prUrl: string | null;
  runUrl: string | null;
  mergeSha?: string | null;
  updatedAt: string;
  codeReview?: {
    commitSha: string;
    approved: boolean;
    modelId: string;
    summary: string;
    reviewedAt: string;
  } | null;
  outcome?: { message: string; nextStep: string };
  deploymentConfirmed?: boolean;
  history: { status: string; at: string; detail: string }[];
}
type RepairConfirmation = {
  issueId: string;
  action: 'run_now' | 'dismiss';
  issueRevision: string;
};
export interface RepairOverview {
  enabled: boolean;
  configured: boolean;
  dailyLimit: number;
  issues: RepairView[];
}

function repairActionRevision(issue: RepairView) {
  return JSON.stringify([issue.status, issue.updatedAt, issue.manualRunRequested === true]);
}

export function isRepairConfirmationCurrent(
  confirmation: RepairConfirmation,
  overview: RepairOverview,
) {
  const current = overview.issues.find((issue) => issue.id === confirmation.issueId);
  if (!current || repairActionRevision(current) !== confirmation.issueRevision) return false;
  if (confirmation.action === 'run_now') {
    return (
      overview.enabled &&
      overview.configured &&
      current.manualRunRequested !== true &&
      !hasBlockingGitHubPullRequest(current) &&
      ['reported', 'failed', 'blocked'].includes(current.status)
    );
  }
  return ['reported', 'merged', 'monitoring', 'blocked', 'failed'].includes(current.status);
}

function recordedSummary(issue: RepairView) {
  if (issue.status === 'pr_open') {
    if (issue.codeReview) {
      const decision = issue.codeReview.approved ? 'approved' : 'flagged';
      return {
        message: `A saved independent review ${decision} commit ${issue.codeReview.commitSha.slice(0, 12)}. The pull request may have changed since that review.`,
        nextStep:
          'Open the pull request and verify its current revision and checks before merging.',
      };
    }
    return {
      message: 'A pull request is recorded. Its current revision and checks are not verified here.',
      nextStep: 'Open the pull request and inspect its current state before merging.',
    };
  }
  if (issue.status === 'monitoring' && issue.deploymentConfirmed === true) {
    return {
      message:
        'A deployment was observed for the merged revision. The original behavior still needs verification.',
      nextStep: 'Check the original problem before confirming it is fixed.',
    };
  }
  return {
    message:
      issue.outcome?.message ||
      issue.lastError ||
      'Review the recorded evidence before taking another action.',
    nextStep:
      issue.outcome?.nextStep ||
      (issue.lastError ? 'Review the recorded evidence before taking another action.' : ''),
  };
}

function formattedUpdate(value?: string) {
  if (!value) return 'Time unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString();
}

function statusTitle(issue: RepairView) {
  if (issue.status === 'reported' && issue.manualRunRequested) return 'Manual run requested';
  if (issue.status === 'monitoring' && issue.deploymentConfirmed !== true) {
    return 'Deployment evidence unavailable';
  }
  return labels[issue.status] ?? 'Status unavailable';
}

function isTrustedPullRequestURL(value: string | null | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

function hasBlockingGitHubPullRequest(issue: RepairView) {
  return (issue.workerProvider ?? 'github') === 'github' && issue.prNumber != null;
}

function hasRecordedPullRequestArtifact(issue: RepairView) {
  const hasStructuredProviderMetadata =
    issue.workerProvider !== undefined || issue.prNumber !== undefined;
  return hasStructuredProviderMetadata ? issue.prNumber != null : Boolean(issue.prUrl);
}

export function primaryRepairAction(issue: RepairView): 'review-pr' | 'retry' | null {
  if (issue.status === 'pr_open' && isTrustedPullRequestURL(issue.prUrl)) return 'review-pr';
  if (
    issue.status === 'failed' &&
    !hasRecordedPullRequestArtifact(issue) &&
    !hasBlockingGitHubPullRequest(issue)
  ) {
    return 'retry';
  }
  return null;
}

export function RepairPanel({ overview }: { overview: RepairOverview }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [confirmation, setConfirmation] = useState<RepairConfirmation | null>(null);
  const [draft, setDraft] = useState({ title: '', summary: '', sourceTaskId: '' });
  const reportId = useId();
  const reportButton = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (showReport) titleInput.current?.focus();
  }, [showReport]);
  const closeReport = () => {
    setShowReport(false);
    setError('');
    setDraft({ title: '', summary: '', sourceTaskId: '' });
    reportButton.current?.focus();
  };
  const run = (fn: () => Promise<void>) => {
    setError('');
    startTransition(async () => {
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update improvement');
      }
    });
  };
  const open = overview.issues.filter((issue) => !['dismissed', 'resolved'].includes(issue.status));
  const closed = overview.issues.filter((issue) =>
    ['dismissed', 'resolved'].includes(issue.status),
  );
  return (
    <section className="mt-8 space-y-4" aria-label="Code fixes">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between sm:gap-4">
        <div>
          <h2 className="text-lg font-semibold">Code fixes</h2>
          <p className="mt-1 text-sm text-muted">
            {overview.enabled && overview.configured
              ? `Automatic investigation is on. Up to ${overview.dailyLimit} coding runs per day; one active fix at a time.`
              : 'Automatic coding is not configured yet. Reports are saved for review.'}{' '}
            You review and merge every PR.
          </p>
        </div>
        <button
          ref={reportButton}
          type="button"
          aria-expanded={showReport}
          aria-controls={reportId}
          onClick={() => (showReport ? closeReport() : setShowReport(true))}
          className={`${btn.outline} shrink-0`}
        >
          Report an issue
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {showReport && (
        <form
          id={reportId}
          className={`${cardShellClass} ${cardBodyClass}`}
          action={(form) =>
            run(async () => {
              await reportRepairAction(form);
              closeReport();
            })
          }
        >
          <label className="flex flex-col gap-1.5">
            <span className={labelClass}>Issue title</span>
            <input
              ref={titleInput}
              name="title"
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              required
              minLength={3}
              maxLength={200}
              className={`${inputClass} w-full`}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={labelClass}>What went wrong</span>
            <textarea
              name="summary"
              value={draft.summary}
              onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
              required
              minLength={5}
              maxLength={3000}
              rows={3}
              className={`${textareaClass} w-full`}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={labelClass}>Failed task ID (optional)</span>
            <input
              name="sourceTaskId"
              value={draft.sourceTaskId}
              onChange={(event) => setDraft({ ...draft, sourceTaskId: event.target.value })}
              className={`${inputClass} w-full`}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className={btn.primary}>
              {pending ? 'Saving…' : 'Save report'}
            </button>
            <button type="button" disabled={pending} className={btn.outline} onClick={closeReport}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {open.length === 0 && (
        <EmptyState>
          No active code fixes. Failed flows and your corrections appear here when automatic
          investigation is enabled.
        </EmptyState>
      )}
      {open.map((issue) => {
        const summary = recordedSummary(issue);
        const primaryAction = primaryRepairAction(issue);
        const primaryPRReview = primaryAction === 'review-pr';
        const primaryRetry = primaryAction === 'retry';
        const canRunExtra =
          overview.enabled &&
          overview.configured &&
          !issue.manualRunRequested &&
          !hasBlockingGitHubPullRequest(issue) &&
          ['reported', 'failed', 'blocked'].includes(issue.status);
        const canRetry =
          overview.enabled &&
          overview.configured &&
          !hasBlockingGitHubPullRequest(issue) &&
          ['failed', 'blocked'].includes(issue.status);
        const canDismiss = ['reported', 'merged', 'monitoring', 'blocked', 'failed'].includes(
          issue.status,
        );
        const retryInMore = canRetry && !primaryRetry;
        return (
          <article key={issue.id} className={`${cardShellClass} ${cardBodyClass} space-y-3`}>
            <div className="min-w-0 space-y-2">
              <Badge
                tone={
                  ['blocked', 'failed'].includes(issue.status)
                    ? 'amber'
                    : issue.status === 'monitoring'
                      ? issue.deploymentConfirmed === true
                        ? 'green'
                        : 'amber'
                      : 'neutral'
                }
              >
                {statusTitle(issue)}
              </Badge>
              <h3 className="break-words font-semibold [overflow-wrap:anywhere]">{issue.title}</h3>
            </div>
            <div className="space-y-1 text-sm">
              <p>{summary.message}</p>
              {summary.nextStep && <p className="text-muted">{summary.nextStep}</p>}
            </div>
            {issue.waitingReason && (
              <p className="break-words text-sm text-muted">{issue.waitingReason}</p>
            )}
            {issue.queuePosition != null && (
              <p className="text-sm text-muted">Queue position: {issue.queuePosition}</p>
            )}
            <p className="text-xs text-muted">
              Last recorded update · {formattedUpdate(issue.updatedAt)}
            </p>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {issue.prUrl && (
                <a
                  className={primaryPRReview ? btn.primary : `underline ${focusRing}`}
                  href={issue.prUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {primaryPRReview
                    ? 'Review recorded pull request ↗'
                    : 'Open recorded pull request ↗'}
                </a>
              )}
              {issue.sourceTaskId && (
                <a className={`underline ${focusRing}`} href={`/audit/${issue.sourceTaskId}`}>
                  View evidence
                </a>
              )}
              {issue.runUrl && (
                <a
                  className={`underline ${focusRing}`}
                  href={issue.runUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  View coding run ↗
                </a>
              )}
              {canRetry && primaryRetry && (
                <ActionButton
                  disabled={pending}
                  variant="primary"
                  onClick={() => run(() => repairDecisionAction(issue.id, 'retry'))}
                >
                  Retry within daily allowance
                </ActionButton>
              )}
              {issue.status === 'monitoring' && issue.deploymentConfirmed === true && (
                <ActionButton
                  disabled={pending}
                  onClick={() => run(() => repairDecisionAction(issue.id, 'resolve'))}
                >
                  Confirm fixed
                </ActionButton>
              )}
              {(canRunExtra || retryInMore || canDismiss) && (
                <ActionMenu label="More" panelClassName="w-64">
                  {retryInMore && (
                    <button
                      type="button"
                      data-menu-close
                      disabled={pending}
                      className={btn.menu}
                      onClick={() => run(() => repairDecisionAction(issue.id, 'retry'))}
                    >
                      Retry within daily allowance
                    </button>
                  )}
                  {canRunExtra && (
                    <button
                      type="button"
                      data-menu-close
                      disabled={pending}
                      className={btn.menu}
                      onClick={() => {
                        setError('');
                        setConfirmation({
                          issueId: issue.id,
                          action: 'run_now',
                          issueRevision: repairActionRevision(issue),
                        });
                      }}
                    >
                      Start extra attempt…
                    </button>
                  )}
                  {canDismiss && (
                    <button
                      type="button"
                      data-menu-close
                      disabled={pending}
                      className={btn.menuDanger}
                      onClick={() => {
                        setError('');
                        setConfirmation({
                          issueId: issue.id,
                          action: 'dismiss',
                          issueRevision: repairActionRevision(issue),
                        });
                      }}
                    >
                      Dismiss report
                    </button>
                  )}
                </ActionMenu>
              )}
            </div>
            {canRunExtra && (
              <p className="text-xs text-muted">
                Starting an extra attempt from More is beyond the daily allowance and may incur
                provider charges.
              </p>
            )}
            <details className="text-xs text-muted">
              <summary className={`cursor-pointer ${focusRing}`}>Diagnosis and history</summary>
              <div className="mt-2 space-y-3">
                <p className="select-text whitespace-pre-wrap break-words">
                  {issue.diagnosis || issue.summary}
                </p>
                {issue.codeReview && (
                  <div className="space-y-1 border-l-2 border-edge pl-3">
                    <p className="font-medium">
                      Saved independent review ·{' '}
                      {issue.codeReview.approved ? 'approved' : 'needs changes'}
                    </p>
                    <p className="select-text break-all font-mono">
                      Commit {issue.codeReview.commitSha}
                    </p>
                    <p>
                      {issue.codeReview.modelId} · {formattedUpdate(issue.codeReview.reviewedAt)}
                    </p>
                    <p className="select-text whitespace-pre-wrap break-words">
                      {issue.codeReview.summary}
                    </p>
                    <p>This saved review may not describe the current pull request revision.</p>
                  </div>
                )}
                {issue.mergeSha && (
                  <p className="select-text break-all font-mono">
                    Merged revision · {issue.mergeSha}
                  </p>
                )}
              </div>
              {issue.history.length === 0 ? (
                <p className="mt-2">No progress updates recorded yet.</p>
              ) : null}
              <ol className="mt-2 space-y-1">
                {issue.history.map((entry) => (
                  <li key={`${entry.at}-${entry.status}`}>
                    {labels[entry.status] ?? entry.status} · {new Date(entry.at).toLocaleString()}
                    {entry.detail ? ` · ${entry.detail}` : ''}
                  </li>
                ))}
              </ol>
            </details>
          </article>
        );
      })}
      {closed.length > 0 && (
        <details className={`${cardShellClass} ${cardBodyClass}`}>
          <summary className={`cursor-pointer font-medium ${focusRing}`}>
            Past reports ({closed.length})
          </summary>
          <div className="mt-3 space-y-3">
            {closed.map((issue) => {
              const summary = recordedSummary(issue);
              return (
                <article key={issue.id} className="min-w-0 space-y-2 border-t border-edge pt-3">
                  <Badge>{statusTitle(issue)}</Badge>
                  <h3 className="break-words font-semibold [overflow-wrap:anywhere]">
                    {issue.title}
                  </h3>
                  <p className="text-sm">{summary.message}</p>
                  {summary.nextStep && <p className="text-sm text-muted">{summary.nextStep}</p>}
                  <p className="text-xs text-muted">
                    Last recorded update · {formattedUpdate(issue.updatedAt)}
                  </p>
                  {issue.prUrl && (
                    <a
                      className={`text-sm underline ${focusRing}`}
                      href={issue.prUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open recorded pull request ↗
                    </a>
                  )}
                  {issue.sourceTaskId && (
                    <a
                      className={`text-sm underline ${focusRing}`}
                      href={`/audit/${issue.sourceTaskId}`}
                    >
                      View evidence
                    </a>
                  )}
                  {issue.runUrl && (
                    <a
                      className={`text-sm underline ${focusRing}`}
                      href={issue.runUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View coding run ↗
                    </a>
                  )}
                  <details className="text-xs text-muted">
                    <summary className={`cursor-pointer ${focusRing}`}>
                      Diagnosis and history
                    </summary>
                    <div className="mt-2 space-y-2">
                      <p className="select-text whitespace-pre-wrap break-words">
                        {issue.diagnosis || issue.summary}
                      </p>
                      {issue.mergeSha && (
                        <p className="select-text break-all font-mono">
                          Merged revision · {issue.mergeSha}
                        </p>
                      )}
                      {issue.codeReview && (
                        <div className="space-y-1 border-l-2 border-edge pl-3">
                          <p className="font-medium">
                            Saved independent review ·{' '}
                            {issue.codeReview.approved ? 'approved' : 'needs changes'}
                          </p>
                          <p className="select-text break-all font-mono">
                            Commit {issue.codeReview.commitSha}
                          </p>
                          <p>
                            {issue.codeReview.modelId} ·{' '}
                            {formattedUpdate(issue.codeReview.reviewedAt)}
                          </p>
                          <p className="select-text whitespace-pre-wrap break-words">
                            {issue.codeReview.summary}
                          </p>
                          <p>
                            This saved review may not describe the current pull request revision.
                          </p>
                        </div>
                      )}
                    </div>
                    <ol className="mt-2 space-y-1">
                      {issue.history.map((entry) => (
                        <li key={`${entry.at}-${entry.status}`}>
                          {labels[entry.status] ?? 'Status unavailable'} ·{' '}
                          {formattedUpdate(entry.at)}
                          {entry.detail ? ` · ${entry.detail}` : ''}
                        </li>
                      ))}
                    </ol>
                  </details>
                </article>
              );
            })}
          </div>
        </details>
      )}
      {confirmation && (
        <Modal
          label={
            confirmation.action === 'run_now'
              ? 'Start an extra coding attempt?'
              : 'Dismiss this report?'
          }
          onClose={() => setConfirmation(null)}
          dismissible={!pending}
          panelClassName="max-w-lg gap-4"
        >
          <div className="space-y-2">
            <h3 className="text-lg font-semibold">
              {confirmation.action === 'run_now'
                ? 'Start an extra coding attempt?'
                : 'Dismiss this report?'}
            </h3>
            <p className="text-sm text-muted">
              {confirmation.action === 'run_now'
                ? 'This starts one attempt beyond the automatic daily allowance. Provider usage may be billed.'
                : 'This removes the report from the active queue. Its recorded history remains available.'}
            </p>
            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <ActionButton
              pending={pending}
              pendingLabel="Saving…"
              variant={confirmation.action === 'dismiss' ? 'danger' : 'primary'}
              onClick={() =>
                run(async () => {
                  if (!isRepairConfirmationCurrent(confirmation, overview)) {
                    setConfirmation(null);
                    setError(
                      'This report changed while you were reviewing it. Review the current report before choosing an action.',
                    );
                    return;
                  }
                  await repairDecisionAction(confirmation.issueId, confirmation.action);
                  setConfirmation(null);
                })
              }
            >
              {confirmation.action === 'run_now' ? 'Start extra attempt' : 'Dismiss report'}
            </ActionButton>
            <ActionButton disabled={pending} onClick={() => setConfirmation(null)}>
              Cancel
            </ActionButton>
          </div>
        </Modal>
      )}
    </section>
  );
}
