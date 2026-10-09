import type { RecordedValue } from '@assistant/application/tasks';
import { Brain, Hand, MessageSquare, Wrench } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { requireOwner } from '@/auth';
import { formatDateTime, formatUsd, relativeTime } from '@/lib/format';
import { getTaskActivityDetail } from '@/lib/task-activity';
import {
  BackLink,
  Badge,
  cardShellClass,
  InfoGrid,
  InfoItem,
  inputClass,
  PageShell,
} from '@/lib/ui';
import { ConfirmButton, SubmitButton } from '@/lib/ui-client';
import { actionLabel, displayTaskStatus, StatusChip, taskTypeLabel, trustLabel } from '@/lib/views';
import {
  archiveTask,
  cancelTask,
  raiseTaskBudgetAndRetry,
  restoreTask,
  retryTask,
  revokeAutonomyGrant,
} from '../actions';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'cancelled']);

type TimelineKind = 'tool' | 'model' | 'approval' | 'message';

const timelineIcons: Record<TimelineKind, typeof Wrench> = {
  tool: Wrench,
  model: Brain,
  approval: Hand,
  message: MessageSquare,
};

interface TimelineEntry {
  key: string;
  at: Date;
  icon: TimelineKind;
  label: string;
  content: ReactNode;
}

/**
 * A recorded JSON value from the audit record. The application layer has
 * already rendered and clipped it, so this only prints what it was given and
 * says plainly when that is not the whole thing.
 */
function JsonDetails({ summary, value }: { summary: string; value: RecordedValue }) {
  return (
    <details className="mt-1">
      <summary className="disclosure flex items-center gap-2 cursor-pointer text-xs text-muted select-none">
        {summary}
      </summary>
      <pre className="mt-1 overscroll-x-contain overflow-x-auto rounded bg-sunken p-2 font-mono text-xs">
        {value.text}
      </pre>
      {value.truncated ? (
        <p className="mt-1 text-xs text-muted">
          Showing the first {value.text.length.toLocaleString()} of{' '}
          {value.totalChars.toLocaleString()} characters.
        </p>
      ) : null}
    </details>
  );
}

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ before?: string; cursor?: string }>;
}) {
  await requireOwner();
  const [{ id }, { before, cursor: timelineCursor }] = await Promise.all([params, searchParams]);
  if (!UUID_RE.test(id)) notFound();

  const now = new Date();
  // The timeline is paged from the newest end; `before` walks backwards from
  // the oldest entry already shown. A malformed cursor just starts over.
  const cursor = before ? new Date(before) : undefined;
  const detail = await getTaskActivityDetail(id, {
    ...(timelineCursor ? { cursor: timelineCursor } : {}),
    ...(cursor && !Number.isNaN(cursor.getTime()) ? { before: cursor } : {}),
  });
  if (!detail) notFound();
  const {
    timezone,
    task,
    toolCalls: taskToolCalls,
    modelCalls: taskModelCalls,
    approvals: taskApprovals,
    messages: taskMessages,
    files: taskFiles,
    actions,
    hasMoreTimeline,
    nextTimelineCursor,
    activeGrant,
    stuckWaiting,
  } = detail;
  // Downloadable artifacts this task produced (charts, exports, saved pages).
  const downloadableFiles = taskFiles.filter((f) =>
    ['code/', 'browser/attachments/', 'documents/'].some((p) => f.workspacePath.startsWith(p)),
  );

  const timeline: TimelineEntry[] = [
    ...taskToolCalls.map(
      (tc): TimelineEntry => ({
        key: `tool-${tc.id}`,
        at: tc.createdAt,
        icon: 'tool',
        label: 'tool call',
        content: (
          <div>
            <p className="text-sm">
              <span className="font-mono font-medium">{tc.toolName}</span>{' '}
              <span className="text-xs text-muted">
                step {tc.step} · <StatusChip status={tc.status} />
              </span>
            </p>
            {tc.riskTier ? (
              <p className="mt-0.5 text-xs text-muted">
                risk {tc.riskTier}
                {tc.policyId ? ` · policy ${tc.policyId}` : ''}
              </p>
            ) : null}
            {tc.args ? <JsonDetails summary="Args" value={tc.args} /> : null}
            {tc.result ? <JsonDetails summary="Result" value={tc.result} /> : null}
            {tc.error ? <JsonDetails summary="Error" value={tc.error} /> : null}
          </div>
        ),
      }),
    ),
    ...taskModelCalls.map(
      (mc): TimelineEntry => ({
        key: `model-${mc.id}`,
        at: mc.createdAt,
        icon: 'model',
        label: 'model call',
        content: (
          <p className="text-sm">
            <span className="font-medium">{mc.role}</span>{' '}
            <span className="font-mono text-xs text-muted">{mc.model}</span>{' '}
            <span className="text-xs text-muted">
              {formatUsd(mc.costUsd)}
              {mc.latencyMs != null ? ` · ${mc.latencyMs}ms` : ''}
            </span>
          </p>
        ),
      }),
    ),
    ...taskApprovals.map(
      (approval): TimelineEntry => ({
        key: `approval-${approval.id}`,
        at: approval.requestedAt,
        icon: 'approval',
        label: 'approval',
        content: (
          <div>
            <p className="text-sm">
              {approval.summary}{' '}
              <span className="text-xs">
                <StatusChip status={approval.status} />
              </span>
            </p>
            <p className="mt-0.5 text-xs text-muted">
              {approval.shortCode}
              {approval.resolvedVia ? ` · resolved via ${approval.resolvedVia}` : ''}
              {approval.resolvedAt ? ` at ${formatDateTime(approval.resolvedAt, timezone)}` : ''}
            </p>
          </div>
        ),
      }),
    ),
    ...taskMessages.map(
      (message): TimelineEntry => ({
        key: `message-${message.id}`,
        at: message.createdAt,
        icon: 'message',
        label: 'message',
        content: (
          <p className="text-sm">
            <span className="font-medium">{message.role}</span>{' '}
            <span className="text-muted">{message.text}</span>
          </p>
        ),
      }),
    ),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  const completedActions = actions.filter((action) => action.completed);
  const incompleteActions = actions.filter((action) => !action.completed);
  const taskBudget = Number(task.budgetUsdLimit);
  const suggestedBudget = Math.ceil(Math.max(taskBudget * 2, Number(task.spentUsd) + 0.25) * 4) / 4;
  const stoppedForTaskBudget =
    task.status === 'needs_attention' && task.progress.startsWith('budget: task budget');
  const terminal = TERMINAL_TASK_STATUSES.has(task.status);

  return (
    <PageShell size="reading">
      <BackLink href="/tasks">Activity</BackLink>
      <header className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-semibold tracking-[-0.035em]">
              {task.title || taskTypeLabel(task.type)}
            </h1>
            <StatusChip status={displayTaskStatus(task.status, !stuckWaiting)} />
          </div>
          {activeGrant ? (
            <p className="mt-2">
              <Badge
                tone="amber"
                title={`Free-range granted via ${activeGrant.grantedVia}. I act without asking, except the hard floor (memory from web content, unknown recipients, logged-in browsing, networked code) and budget caps.`}
              >
                ⚡ Free-range
              </Badge>
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {activeGrant && !terminal ? (
            <form action={revokeAutonomyGrant.bind(null, task.id)}>
              <SubmitButton pendingLabel="Revoking…">Revoke free-range</SubmitButton>
            </form>
          ) : null}
          {(task.status === 'needs_attention' && !stoppedForTaskBudget) || stuckWaiting ? (
            <form action={retryTask.bind(null, task.id)}>
              <SubmitButton variant="primary" pendingLabel="Retrying…">
                Retry
              </SubmitButton>
            </form>
          ) : null}
          {/* Any unfinished task can be called off. Restricting this to
              needs_attention left tasks parked on a vanished approval with no
              reachable action at all. */}
          {!terminal ? (
            <form action={cancelTask.bind(null, task.id)}>
              {/* Same words and the same ask-twice as the chat's spending card,
                  which calls off a task through this very action. */}
              <ConfirmButton pendingLabel="Stopping…" confirmLabel="Stop task?">
                Stop task
              </ConfirmButton>
            </form>
          ) : null}
          {task.archivedAt ? (
            <form action={restoreTask.bind(null, task.id)}>
              <SubmitButton pendingLabel="Restoring…">Restore to Activity</SubmitButton>
            </form>
          ) : terminal ? (
            <form action={archiveTask.bind(null, task.id)}>
              <SubmitButton pendingLabel="Archiving…">Archive</SubmitButton>
            </form>
          ) : null}
        </div>
      </header>

      {stuckWaiting ? (
        <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
          This was parked for an approval that no longer exists — it was resolved, it expired, or it
          was never recorded. Nothing will arrive to release it, so it does not appear on the
          Approvals page. Retry to run it again, or cancel it.
        </p>
      ) : null}

      {stoppedForTaskBudget ? (
        <form
          action={raiseTaskBudgetAndRetry.bind(null, task.id)}
          className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/20"
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-amber-900 dark:text-amber-200">
            New task budget (USD)
            <input
              type="number"
              name="budgetUsdLimit"
              step="0.01"
              min={(taskBudget + 0.01).toFixed(2)}
              max="10000"
              defaultValue={suggestedBudget.toFixed(2)}
              required
              className={`${inputClass} w-32`}
            />
          </label>
          <SubmitButton variant="primary" pendingLabel="Raising budget…">
            Raise budget and retry
          </SubmitButton>
          <p className="w-full text-xs text-amber-800 dark:text-amber-300">
            The task resumes from its saved checkpoint; completed actions are not repeated.
          </p>
        </form>
      ) : null}

      <InfoGrid className="mt-5 sm:grid-cols-3">
        <InfoItem label="Started by">{trustLabel(task.trust)}</InfoItem>
        <InfoItem label="Cost">
          {formatUsd(task.spentUsd)} of {formatUsd(task.budgetUsdLimit)}
        </InfoItem>
        <InfoItem label="Updated">
          {relativeTime(task.updatedAt, now)} · {formatDateTime(task.updatedAt, timezone)}
        </InfoItem>
        {task.deadline ? (
          <InfoItem label="Target date">
            {relativeTime(task.deadline, now)} · {formatDateTime(task.deadline, timezone)}
          </InfoItem>
        ) : null}
        {task.nextAction ? (
          <InfoItem label="What happens next" className="sm:col-span-2">
            {task.nextAction}
          </InfoItem>
        ) : null}
        {task.progress ? (
          <InfoItem label="Latest update" className="col-span-2 sm:col-span-3">
            {task.progress}
            {task.progressPercent != null ? ` (${task.progressPercent}%)` : ''}
          </InfoItem>
        ) : null}
      </InfoGrid>

      <section className={`${cardShellClass} mt-5 p-5`}>
        <h2 className="text-sm font-semibold">What actually happened</h2>
        <p className="mt-1 text-xs leading-5 text-muted">
          This list is built from completed tool results, not from the assistant’s wording.
        </p>
        {completedActions.length === 0 ? (
          <p className="mt-4 rounded-lg bg-sunken/60 px-3 py-2 text-sm text-muted">
            No external action completed for this item.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-edge/60">
            {completedActions.map((call) => (
              <li key={call.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{actionLabel(call.toolName)}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {relativeTime(call.finishedAt ?? call.createdAt, now)}
                    </p>
                  </div>
                  <StatusChip status="done" />
                </div>
                {call.resultPreview ? (
                  <JsonDetails summary="View result" value={call.resultPreview} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {incompleteActions.length > 0 ? (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/20">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              Didn’t complete
            </p>
            <ul className="mt-1 space-y-1 text-xs text-amber-800 dark:text-amber-300">
              {incompleteActions.map((call) => (
                <li key={call.id}>
                  {actionLabel(call.toolName)}
                  {call.error ? ` — ${call.error}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {downloadableFiles.length > 0 ? (
        <section className={`${cardShellClass} mt-5 p-5`}>
          <h2 className="text-sm font-semibold">Files produced</h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            Artifacts this task saved to the workspace — click to download.
          </p>
          <ul className="mt-4 divide-y divide-edge/60">
            {downloadableFiles.map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-3 py-2">
                <a
                  href={`/api/files?path=${encodeURIComponent(file.workspacePath)}`}
                  className="truncate text-sm font-medium text-accent hover:underline"
                >
                  {file.workspacePath.split('/').pop()}
                </a>
                <span className="shrink-0 text-xs text-muted">
                  {file.bytes > 0 ? `${Math.max(1, Math.round(file.bytes / 1024))} KB` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className={`${cardShellClass} mt-5 p-5`}>
        <summary className="disclosure flex items-center gap-2 cursor-pointer text-sm font-medium text-strong">
          Full technical record
        </summary>
        <p className="mt-1 text-xs text-muted">
          Tool calls, approvals, messages, and model activity for troubleshooting.
        </p>
        {task.plan ? <JsonDetails summary="Plan" value={task.plan} /> : null}
        {timeline.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No activity recorded for this item yet.</p>
        ) : (
          <ol className="mt-4 flex flex-col gap-3">
            {timeline.map((entry) => {
              const EntryIcon = timelineIcons[entry.icon];
              return (
                <li key={entry.key} className="flex gap-3 rounded-lg border border-edge p-3">
                  <EntryIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-mono text-xs font-medium tracking-[0.08em] text-muted uppercase">
                        {entry.label}
                      </span>
                      <span className="shrink-0 text-xs text-muted">
                        {formatDateTime(entry.at, timezone)}
                      </span>
                    </div>
                    <div className="mt-1">{entry.content}</div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {/* The record is paged from the newest end, so a long mission's page
            weight is a function of the page size and not of how long it ran.
            Older entries are a link away rather than always in the payload. */}
        {hasMoreTimeline && nextTimelineCursor ? (
          <p className="mt-4 text-sm">
            <Link
              href={`/tasks/${task.id}?cursor=${encodeURIComponent(nextTimelineCursor)}`}
              className="font-medium underline underline-offset-2 hover:no-underline"
            >
              Show older activity
            </Link>
          </p>
        ) : null}
        {before || timelineCursor ? (
          <p className="mt-4 text-sm">
            <Link
              href={`/tasks/${task.id}`}
              className="font-medium underline underline-offset-2 hover:no-underline"
            >
              Back to the newest activity
            </Link>
          </p>
        ) : null}
      </details>
    </PageShell>
  );
}
