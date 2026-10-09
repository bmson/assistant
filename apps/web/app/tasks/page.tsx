import { type ActivityFilter, terminalTaskStatuses } from '@assistant/application/tasks';
import {
  Archive,
  CalendarClock,
  CircleCheck,
  CircleX,
  Clock3,
  Hand,
  ListChecks,
  Loader2,
} from 'lucide-react';
import Link from 'next/link';
import { AutoRefresh } from '@/app/auto-refresh';
import { requireOwner } from '@/auth';
import { formatUsd, relativeTime, stripMarkdown, truncate } from '@/lib/format';
import { listTaskActivity } from '@/lib/task-activity';
import {
  btn,
  cardShellClass,
  cardTitleClass,
  EmptyState,
  MetaLine,
  PageHeader,
  PageShell,
  segmentedControlClass,
  segmentedItemActiveClass,
  segmentedItemClass,
} from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';
import { displayTaskStatus, StatusChip, taskTypeLabel, trustLabel } from '@/lib/views';
import { archiveOldTasks, archiveTask, restoreTask } from './actions';

export const metadata = { title: 'Activity' };

export const dynamic = 'force-dynamic';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'needs-you', label: 'Needs you' },
  { value: 'working', label: 'Working' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'completed', label: 'Completed' },
] as const;

function calendarDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function dayHeading(date: Date, now: Date): string {
  if (calendarDay(date) === calendarDay(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (calendarDay(date) === calendarDay(yesterday)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);
}

const taskIcon = {
  pending: Clock3,
  running: Loader2,
  waiting_approval: Hand,
  waiting_budget: Hand,
  needs_attention: Hand,
  sleeping: CalendarClock,
  waiting_event: CalendarClock,
  done: CircleCheck,
  failed: CircleX,
  cancelled: CircleX,
} as const;

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    filter?: string;
    archiveOperation?: string;
    archivedTotal?: string;
    archiveComplete?: string;
  }>;
}) {
  await requireOwner();
  const {
    view,
    filter: rawFilter,
    archiveOperation: rawArchiveOperation,
    archivedTotal: rawArchivedTotal,
    archiveComplete,
  } = await searchParams;
  const archiveOperation =
    rawArchiveOperation && /^[0-9a-f-]{36}$/i.test(rawArchiveOperation)
      ? rawArchiveOperation
      : undefined;
  const archivedTotalValue = Number(rawArchivedTotal);
  const archivedTotal =
    Number.isSafeInteger(archivedTotalValue) && archivedTotalValue >= 0 ? archivedTotalValue : null;
  const archived = view === 'archived';
  const filter = FILTERS.some((item) => item.value === rawFilter)
    ? (rawFilter as ActivityFilter)
    : 'all';
  const { items: rows, archivedCount } = await listTaskActivity({ archived, filter });
  const now = new Date();
  const groups = [...new Set(rows.map((task) => calendarDay(task.updatedAt)))].map((day) => ({
    day,
    label: dayHeading(
      (rows.find((task) => calendarDay(task.updatedAt) === day) as (typeof rows)[number]).updatedAt,
      now,
    ),
    items: rows.filter((task) => calendarDay(task.updatedAt) === day),
  }));

  return (
    <PageShell size="reading">
      {archived ? null : <AutoRefresh />}
      <PageHeader
        back={archived ? { href: '/tasks', label: 'Activity' } : { href: '/chat', label: 'Chat' }}
        title={archived ? 'Archived activity' : 'Activity'}
        intro={
          archived
            ? 'Hidden work stays available with its decisions and evidence intact.'
            : 'A chronological record of what the assistant did, what it is doing, and where it needs you.'
        }
        actions={
          archived ? (
            <Link href="/tasks" className={btn.outline}>
              Current activity
            </Link>
          ) : (
            <>
              {archivedCount > 0 ? (
                <Link href="/tasks?view=archived" className={btn.outline}>
                  Archived ({archivedCount})
                </Link>
              ) : null}
              <form action={archiveOldTasks}>
                {archiveOperation ? (
                  <input type="hidden" name="operationId" value={archiveOperation} />
                ) : null}
                <SubmitButton pendingLabel="Archiving…">
                  <Archive className="size-3.5" aria-hidden="true" />
                  {archiveOperation ? `Continue archiving (${archivedTotal ?? 0})` : 'Archive old'}
                </SubmitButton>
              </form>
            </>
          )
        }
      />

      {archivedTotal !== null ? (
        <p className="mt-4 text-sm text-muted-foreground" role="status">
          {archiveComplete === 'false'
            ? `Archived ${archivedTotal} older tasks so far. Continue to process the next bounded batch.`
            : `Archived ${archivedTotal} older ${archivedTotal === 1 ? 'task' : 'tasks'}.`}
        </p>
      ) : null}

      {!archived ? (
        <nav aria-label="Filter activity" className={`${segmentedControlClass} mt-6`}>
          {FILTERS.map((item) => {
            const active = filter === item.value;
            return (
              <Link
                key={item.value}
                href={item.value === 'all' ? '/tasks' : `/tasks?filter=${item.value}`}
                aria-current={active ? 'page' : undefined}
                className={active ? segmentedItemActiveClass : segmentedItemClass}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="size-5" />}
          action={
            archived || filter !== 'all' ? (
              <Link href="/tasks" className={btn.outline}>
                {archived ? 'Current activity' : 'Clear filter'}
              </Link>
            ) : (
              <Link href="/chat" className={btn.outline}>
                Start in chat
              </Link>
            )
          }
        >
          {archived
            ? 'No archived activity.'
            : filter === 'all'
              ? 'Nothing yet. Give the assistant something in chat and its work will appear here.'
              : `No ${FILTERS.find((item) => item.value === filter)?.label.toLowerCase()} activity.`}
        </EmptyState>
      ) : (
        <div className="mt-8 flex flex-col gap-8">
          {groups.map((group) => (
            <section key={group.day}>
              <h2 className="mb-3 text-lg font-semibold text-strong">{group.label}</h2>
              <div className={cardShellClass}>
                {group.items.map((task, index) => {
                  const Icon = taskIcon[task.status as keyof typeof taskIcon] ?? Clock3;
                  const terminal = terminalTaskStatuses.includes(
                    task.status as (typeof terminalTaskStatuses)[number],
                  );
                  const shownStatus = displayTaskStatus(task.status, task.hasPendingApproval);
                  return (
                    // Each row leads somewhere, so it lights up under the
                    // pointer — scanning a long day of activity should feel
                    // like a list you can move through, not a static table.
                    <article
                      key={task.id}
                      className={`grid grid-cols-[2rem_minmax(0,1fr)] gap-3 px-4 py-4 motion-safe:transition-colors hover:bg-sunken/40 sm:grid-cols-[2rem_minmax(0,1fr)_auto] sm:items-center sm:px-5 ${
                        index > 0 ? 'border-t border-edge' : ''
                      }`}
                    >
                      <span
                        className={`inline-flex size-8 items-center justify-center rounded-xl bg-sunken text-muted ${
                          task.status === 'running' ? 'text-accent' : ''
                        }`}
                      >
                        <Icon
                          className={`size-4 ${task.status === 'running' ? 'motion-safe:animate-spin' : ''}`}
                          aria-hidden="true"
                        />
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/tasks/${task.id}`}
                            className={`${cardTitleClass} hover:underline`}
                          >
                            {task.title || taskTypeLabel(task.type)}
                          </Link>
                          <StatusChip status={shownStatus} />
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted">
                          {truncate(stripMarkdown(task.progress), 180) || 'No update recorded yet.'}
                        </p>
                        <MetaLine
                          className="mt-1.5"
                          segments={[
                            `Started by ${trustLabel(task.trust)}`,
                            `${formatUsd(task.spentUsd)} of ${formatUsd(task.budgetUsdLimit)}`,
                            `Updated ${relativeTime(task.updatedAt, now)}`,
                          ]}
                        />
                      </div>
                      {/* The title already opens the task — a per-row "Open"
                          button restated the link as chrome. Only a real
                          state change earns a button here. */}
                      {archived || terminal ? (
                        <div className="col-start-2 flex items-center gap-2 sm:col-start-auto sm:justify-end">
                          {archived ? (
                            <form action={restoreTask.bind(null, task.id)}>
                              <SubmitButton size="sm" pendingLabel="Restoring…">
                                Restore
                              </SubmitButton>
                            </form>
                          ) : (
                            <form action={archiveTask.bind(null, task.id)}>
                              <SubmitButton size="sm" pendingLabel="Archiving…">
                                Archive
                              </SubmitButton>
                            </form>
                          )}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}
