import type { ActivityFilter } from '@assistant/application/tasks';
import Link from 'next/link';
import { requireOwner } from '@/auth';
import { formatDateTime, formatUsd } from '@/lib/format';
import { listTaskActivity } from '@/lib/task-activity';
import {
  btn,
  EmptyState,
  focusRing,
  inputClass,
  MetaLine,
  PageHeader,
  PageShell,
  selectClass,
} from '@/lib/ui';
import { StatusChip } from '@/lib/views';

export const metadata = { title: 'Audit trail' };
export const dynamic = 'force-dynamic';
const filters = ['all', 'needs-you', 'working', 'scheduled', 'completed'] as const;
const filterLabels = {
  all: 'All statuses',
  'needs-you': 'Needs you',
  working: 'Working',
  scheduled: 'Scheduled',
  completed: 'Completed',
};

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; view?: string; q?: string }>;
}) {
  await requireOwner();
  const query = await searchParams;
  const filter: ActivityFilter = filters.includes(query.filter as ActivityFilter)
    ? (query.filter as ActivityFilter)
    : 'all';
  const archived = query.view === 'archived';
  const { items } = await listTaskActivity({ archived, filter, limit: 100 });
  const search = (query.q ?? '').trim().slice(0, 200).toLowerCase();
  const rows = items.filter(
    (task) =>
      !search || `${task.id} ${task.title ?? ''} ${task.progress}`.toLowerCase().includes(search),
  );
  return (
    <PageShell size="reading" className="grid gap-6">
      <PageHeader
        title="Audit trail"
        intro="Follow your assistant’s work. Open a record to inspect its actions, decisions, and evidence."
      />
      <form className="grid min-w-0 grid-cols-1 items-end gap-3 rounded-xl bg-raised p-4 ring-1 ring-edge/70 min-[360px]:grid-cols-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:p-5">
        <label className="grid min-w-0 gap-1.5 text-sm font-medium min-[360px]:col-span-2 sm:col-span-1">
          Search recent records
          <input
            name="q"
            defaultValue={(query.q ?? '').slice(0, 200)}
            maxLength={200}
            placeholder="Task name or ID"
            className={`w-full ${inputClass}`}
          />
        </label>
        <label className="grid min-w-0 gap-1.5 text-sm font-medium">
          Status
          <select name="filter" defaultValue={filter} className={`w-full ${selectClass}`}>
            {filters.map((value) => (
              <option key={value} value={value}>
                {filterLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid min-w-0 gap-1.5 text-sm font-medium">
          Records
          <select
            name="view"
            defaultValue={archived ? 'archived' : 'current'}
            className={`w-full ${selectClass}`}
          >
            <option value="current">Current</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <button className={`min-[360px]:col-span-2 sm:col-span-1 ${btn.primary}`} type="submit">
          Filter
        </button>
      </form>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-muted">
        <p>
          {rows.length} {rows.length === 1 ? 'record' : 'records'}
          {search ? ' matching your search' : ''}
        </p>
        {search || archived || filter !== 'all' ? (
          <Link href="/audit" className={`rounded-md underline ${focusRing}`}>
            Clear filters
          </Link>
        ) : null}
        <p className="basis-full text-xs leading-5">
          The latest 100 records in this view are searchable. Refresh for the latest status.
          {items.length === 100
            ? ' This view reached its limit; older records may be omitted.'
            : ''}
        </p>
      </div>
      {rows.length === 0 ? (
        <EmptyState>
          {search || filter !== 'all'
            ? 'No records match these filters. Clear the filters or try a different task name.'
            : archived
              ? 'No archived work yet. Archived tasks will appear here.'
              : 'No work recorded yet. Work started in the mobile app will appear here.'}
        </EmptyState>
      ) : (
        <div className="divide-y divide-edge border-y border-edge">
          {rows.map((task) => (
            <article key={task.id} className="grid min-w-0 gap-2 py-5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <Link
                  href={`/audit/${task.id}`}
                  prefetch={false}
                  className={`mobile-touch-target inline-flex min-h-11 min-w-0 items-center rounded-md font-semibold text-strong break-words hover:underline ${focusRing}`}
                >
                  {task.title || task.type}
                </Link>
                <StatusChip status={task.status} />
              </div>
              <p className="text-sm leading-6 text-muted break-words">
                {task.progress || 'No progress recorded.'}
              </p>
              <MetaLine
                segments={[
                  <>
                    Updated{' '}
                    <time dateTime={new Date(task.updatedAt).toISOString()}>
                      {formatDateTime(task.updatedAt)} UTC
                    </time>
                  </>,
                  <>Cost {formatUsd(task.spentUsd)}</>,
                ]}
              />
            </article>
          ))}
        </div>
      )}
    </PageShell>
  );
}
