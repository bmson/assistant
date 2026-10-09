import type { ActivityFilter } from '@assistant/application/tasks';
import Link from 'next/link';
import { requireOwner } from '@/auth';
import { formatDateTime, formatUsd } from '@/lib/format';
import { discoverTaskActivity } from '@/lib/task-activity';
import {
  btn,
  EmptyState,
  focusRing,
  inputClass,
  MetaLine,
  PageHeader,
  PageShell,
  selectClass,
  summaryClass,
} from '@/lib/ui';
import { StatusChip } from '@/lib/views';

export const metadata = { title: 'Audit trail' };
export const dynamic = 'force-dynamic';
const filters = ['all', 'needs-you', 'working', 'scheduled', 'completed'] as const;
const auditFiltersFormStyle = { paddingInline: 'min(1rem, 5vw)' };
const auditFilterSelectStyle = {
  paddingInlineStart: 'min(0.75rem, 5vw)',
  paddingInlineEnd: 'min(2.25rem, 11vw)',
  backgroundSize: 'min(1rem, 6vw) min(1rem, 6vw)',
  backgroundPosition: 'right min(0.625rem, 3vw) center',
};

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
  searchParams: Promise<{
    filter?: string;
    view?: string;
    q?: string;
    cursor?: string;
    type?: string;
    trust?: string;
    source?: string;
    from?: string;
    until?: string;
  }>;
}) {
  await requireOwner();
  const query = await searchParams;
  const filter: ActivityFilter = filters.includes(query.filter as ActivityFilter)
    ? (query.filter as ActivityFilter)
    : 'all';
  const archived = query.view === 'archived';
  const search = (query.q ?? '').trim().slice(0, 200);
  const activeAdvancedFilterCount = [
    query.type,
    query.trust,
    query.source,
    query.from,
    query.until,
  ].filter((value) => typeof value === 'string' && value.trim().length > 0).length;
  const hasActiveFilters = search || archived || filter !== 'all' || activeAdvancedFilterCount > 0;
  const page = await discoverTaskActivity({
    archived,
    filter,
    limit: 100,
    q: search,
    cursor: query.cursor,
    type: query.type,
    trust: query.trust,
    source: query.source,
    from: query.from ? `${query.from}T00:00:00.000Z` : undefined,
    until: query.until ? `${query.until}T23:59:59.999Z` : undefined,
  });
  const rows = page.items;
  const nextQuery = new URLSearchParams(
    Object.entries(query).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  if (page.nextCursor) nextQuery.set('cursor', page.nextCursor);
  return (
    <PageShell size="reading" className="grid gap-6 @container">
      <PageHeader
        title="Audit trail"
        intro="Follow your assistant’s work. Open a record to inspect its actions, decisions, and evidence."
      />
      <form
        style={auditFiltersFormStyle}
        className="grid min-w-0 grid-cols-1 items-end gap-3 rounded-xl bg-raised p-4 ring-1 ring-edge/70 @min-[19em]:grid-cols-2 @min-[48em]:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:p-5"
      >
        <label className="grid min-w-0 gap-1.5 text-sm font-medium @min-[19em]:col-span-2 @min-[48em]:col-span-1">
          Search recorded work
          <input
            name="q"
            defaultValue={(query.q ?? '').slice(0, 200)}
            maxLength={200}
            className={`w-full ${inputClass}`}
          />
        </label>
        <label className="grid min-w-0 gap-1.5 text-sm font-medium">
          Status
          <select
            name="filter"
            defaultValue={filter}
            style={auditFilterSelectStyle}
            className={`w-full ${selectClass}`}
          >
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
            style={auditFilterSelectStyle}
            className={`w-full ${selectClass}`}
          >
            <option value="current">Current</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <details
          className="min-w-0 @min-[19em]:col-span-2 @min-[48em]:col-span-4"
          open={activeAdvancedFilterCount > 0}
        >
          <summary className={summaryClass}>
            <span>More filters</span>
            {activeAdvancedFilterCount > 0 ? (
              <span className="text-xs tabular-nums text-muted">
                {activeAdvancedFilterCount} active
              </span>
            ) : null}
          </summary>
          <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            {(['type', 'trust', 'source'] as const).map((key) => (
              <label key={key} className="grid min-w-0 gap-1.5 text-sm font-medium">
                {key === 'type' ? 'Task type' : key === 'trust' ? 'Actor trust' : 'Source'}
                <input
                  name={key}
                  defaultValue={query[key] ?? ''}
                  maxLength={100}
                  className={inputClass}
                />
              </label>
            ))}
            {(['from', 'until'] as const).map((key) => (
              <label key={key} className="grid min-w-0 gap-1.5 text-sm font-medium">
                {key === 'from' ? 'Created from (UTC)' : 'Created through (UTC)'}
                <input
                  type="date"
                  name={key}
                  defaultValue={query[key] ?? ''}
                  className={inputClass}
                />
              </label>
            ))}
          </div>
        </details>
        <button
          className={`@min-[19em]:col-span-2 @min-[48em]:col-span-1 ${btn.primary}`}
          type="submit"
        >
          Filter
        </button>
      </form>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-muted">
        <p>
          {rows.length} {rows.length === 1 ? 'record' : 'records'}
          {search ? ' matching your search' : ''}
        </p>
        {hasActiveFilters ? (
          <Link href="/audit" className={`rounded-md underline ${focusRing}`}>
            Clear filters
          </Link>
        ) : null}
        <p className="basis-full text-xs leading-5">
          Search scans up to 500 tasks per page.{' '}
          {page.searchIncomplete
            ? 'More remain; an empty page may be partial.'
            : 'This search reached the end.'}{' '}
          Dates use UTC; older records without creation times cannot match. Details may be
          unavailable or redacted. Refresh to restart after task updates.
        </p>
      </div>
      {page.nextCursor ? (
        <Link href={`/audit?${nextQuery}`} className={btn.outline}>
          Continue to older records
        </Link>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState>
          {search ||
          filter !== 'all' ||
          page.searchIncomplete ||
          query.type ||
          query.trust ||
          query.source ||
          query.from ||
          query.until
            ? 'No matches in this scanned page. Continue to older records if available, or change the filters.'
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
                  <>Task {task.id}</>,
                  <>
                    Source {task.source} · {task.trust} · {task.type}
                  </>,
                  task.createdAt ? (
                    <time key="created" dateTime={task.createdAt.toISOString()}>
                      Created {formatDateTime(task.createdAt)} UTC
                    </time>
                  ) : (
                    'Creation time not recorded'
                  ),
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
