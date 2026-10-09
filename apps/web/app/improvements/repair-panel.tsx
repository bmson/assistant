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
import { ActionButton } from '@/lib/ui-client';
import { repairDecisionAction, reportRepairAction } from './repair-actions';

const labels: Record<string, string> = {
  reported: 'Reported',
  investigating: 'Investigating',
  fixing: 'Preparing fix',
  testing: 'Testing',
  pr_open: 'PR ready to review',
  merged: 'Awaiting deployment',
  monitoring: 'Behavior verification',
  resolved: 'Resolved',
  blocked: 'Needs your attention',
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
  waitingReason?: string | null;
  sourceTaskId: string | null;
  prUrl: string | null;
  runUrl: string | null;
  outcome?: { message: string; nextStep: string };
  deploymentConfirmed?: boolean;
  history: { status: string; at: string; detail: string }[];
}
export function RepairPanel({
  overview,
}: {
  overview: { enabled: boolean; configured: boolean; dailyLimit: number; issues: RepairView[] };
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [showReport, setShowReport] = useState(false);
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
      {open.map((issue) => (
        <article key={issue.id} className={`${cardShellClass} ${cardBodyClass}`}>
          <div>
            <Badge
              tone={
                ['blocked', 'failed'].includes(issue.status)
                  ? 'amber'
                  : issue.status === 'monitoring'
                    ? 'green'
                    : 'neutral'
              }
            >
              {labels[issue.status] ?? issue.status}
            </Badge>
          </div>
          <h3 className="font-semibold">{issue.title}</h3>
          <p className="text-sm text-muted">{issue.diagnosis || issue.summary}</p>
          {issue.waitingReason && <p className="text-sm text-muted">{issue.waitingReason}</p>}
          {issue.outcome ? (
            <p className="text-sm">
              {issue.outcome.message} {issue.outcome.nextStep}
            </p>
          ) : issue.lastError ? (
            <p className="text-sm">{issue.lastError}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {issue.prUrl && (
              <a
                className={`underline ${focusRing}`}
                href={issue.prUrl}
                target="_blank"
                rel="noreferrer"
              >
                Review pull request ↗
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
            {overview.enabled &&
              overview.configured &&
              !issue.manualRunRequested &&
              ['reported', 'failed', 'blocked'].includes(issue.status) && (
                <ActionButton
                  disabled={pending}
                  onClick={() => run(() => repairDecisionAction(issue.id, 'run_now'))}
                >
                  Run now
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
            {!['investigating', 'fixing', 'testing', 'pr_open'].includes(issue.status) && (
              <ActionButton
                disabled={pending}
                onClick={() => run(() => repairDecisionAction(issue.id, 'dismiss'))}
              >
                Dismiss
              </ActionButton>
            )}
          </div>
          {overview.enabled &&
            overview.configured &&
            !issue.manualRunRequested &&
            ['reported', 'failed', 'blocked'].includes(issue.status) && (
              <p className="text-xs text-muted">
                Run now authorizes one attempt beyond the automatic daily limit.
              </p>
            )}
          <details className="text-xs text-muted">
            <summary className={`cursor-pointer ${focusRing}`}>Progress history</summary>
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
      ))}
      {overview.issues.some((issue) => issue.status === 'resolved') && (
        <p className="text-xs text-muted">
          {overview.issues.filter((issue) => issue.status === 'resolved').length} issue(s) confirmed
          fixed.
        </p>
      )}
    </section>
  );
}
