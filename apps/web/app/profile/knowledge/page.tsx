import {
  asGraphEntityKind,
  getKnowledgeCleanupFindings,
  getKnowledgeGraphOverview,
  getKnowledgeMapSnapshot,
  getKnowledgeWorkspaceOverview,
  type KnowledgeCleanupFinding,
  PREDICATE_VOCABULARY,
} from '@assistant/application';
import {
  listMemoryLibrary,
  listMemoryLibraryFilters,
  type MemoryFilter,
  type MemoryProjectionStatus,
  type MemorySnapshot,
  type MemoryState,
} from '@assistant/application/profile';
import { loadConfig } from '@assistant/config';
import { Check, CircleAlert, Search, ShieldCheck, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { FactRow, type FactView } from '@/app/profile/fact-row';
import {
  approveKnowledgeMemory,
  confirmKnowledgeRelation,
  keepKnowledgeMemory,
  rejectKnowledgeRelation,
  removeDisconnectedKnowledgeItems,
  retryQuarantinedKnowledgeSources,
} from '@/app/profile/knowledge/actions';
import { AddKnowledgeRelation } from '@/app/profile/knowledge/add-relation';
import { EditKnowledgeEntity } from '@/app/profile/knowledge/entity-forms';
import { KnowledgeMap } from '@/app/profile/knowledge/knowledge-map';
import { SourceImpactForget } from '@/app/profile/knowledge/source-impact-forget';
import { requireOwner } from '@/auth';
import {
  getFirestoreKnowledgeWorkspace,
  loadFirestoreMemoryLibrary,
} from '@/lib/firestore-knowledge';
import { relativeTime } from '@/lib/format';
import { entityKindLabel } from '@/lib/knowledge';
import { getDb } from '@/lib/server';
import {
  Badge,
  btn,
  btnSm,
  cardShellClass,
  EmptyState,
  inputClass,
  microLabelClass,
  PageHeader,
  PageShell,
  segmentedControlClass,
  segmentedItemActiveClass,
  segmentedItemClass,
  selectClass,
} from '@/lib/ui';
import { ConfirmButton, SubmitButton } from '@/lib/ui-client';

export const metadata = { title: 'Knowledge' };
export const dynamic = 'force-dynamic';

type WorkspaceView = 'library' | 'map' | 'cleanup';
const VIEWS: Array<{ id: WorkspaceView; label: string }> = [
  { id: 'library', label: 'Library' },
  { id: 'map', label: 'Map' },
  { id: 'cleanup', label: 'Cleanup' },
];
const MEMORY_STATES = ['in-use', 'review'] as const;
const MEMORY_FILTERS = ['all', 'verified', 'untidied'] as const;
type CleanupFocus = 'all' | 'trust' | 'current' | 'projection';
const CLEANUP_FOCI: Array<{
  id: CleanupFocus;
  label: string;
  description: string;
  kinds: KnowledgeCleanupFinding['kind'][];
}> = [
  {
    id: 'trust',
    label: 'Trust and review',
    // These are the library's held-for-review memories, not a second queue:
    // approving one here is the same decision, on the same row. The scan caps
    // at 100, so the library stays the place to work a longer backlog.
    description:
      'The same memories the library holds for review, with the connections waiting on you.',
    kinds: ['quarantined', 'unreviewed_connection'],
  },
  {
    id: 'current',
    label: 'Keep current',
    description: 'Resolve facts or connections that are no longer current.',
    kinds: ['expired', 'superseded', 'rejected_connection'],
  },
  {
    id: 'projection',
    label: 'Projection health',
    description: 'Repair derived graph data without changing what you know.',
    kinds: ['projection_orphan', 'projection_failed'],
  },
];

function workspaceView(params: { view?: string; mode?: string; entity?: string }): WorkspaceView {
  if (params.mode === 'review' || params.view === 'cleanup') return 'cleanup';
  if (params.entity || params.mode === 'map' || params.view === 'map') return 'map';
  return 'library';
}

function hrefFor(input: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== '' && value !== 1) params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `/profile/knowledge?${query}` : '/profile/knowledge';
}

function cleanupFocus(value: string | undefined): CleanupFocus {
  return CLEANUP_FOCI.some((focus) => focus.id === value) ? (value as CleanupFocus) : 'all';
}

function findingTotal(findings: KnowledgeCleanupFinding[]): number {
  return findings.reduce((total, finding) => total + finding.count, 0);
}

function toFactView(
  memory: MemorySnapshot,
  subjectId: string | null,
  subjectLabel: string | null,
  ownerId: string | null,
  now: Date,
  connectionCount: number,
  projectionStatus: MemoryProjectionStatus,
): FactView {
  const from = memory.validFrom?.toISOString().slice(0, 10);
  const until = memory.validUntil?.toISOString().slice(0, 10);
  return {
    id: memory.id,
    content: memory.content,
    kind: memory.kind,
    domain: memory.domain ?? '',
    confidence: Number(memory.confidence),
    importance: memory.importance,
    ownerConfirmed: memory.ownerConfirmed,
    pinned: memory.pinned,
    organized: memory.lastConsolidatedAt !== null,
    inCard: false,
    aboutOwner: subjectLabel === null || subjectId === ownerId,
    originTrust: memory.originTrust,
    sourceTaskId: memory.sourceTaskId,
    subjectLabel,
    createdLabel: relativeTime(memory.createdAt, now),
    validityLabel: from ? `${from}–${until ?? 'now'}` : '',
    workspace: true,
    connectionCount,
    projectionStatus,
    mapHref: hrefFor({ view: 'map', memory: memory.id }),
  };
}

function CleanupCard({ finding }: { finding: KnowledgeCleanupFinding }) {
  const needsProjectionRetry =
    finding.kind === 'projection_failed' || finding.relatedKinds?.includes('projection_failed');
  return (
    <article className={`${cardShellClass} p-4 sm:p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={microLabelClass}>{finding.kind.replaceAll('_', ' ')}</p>
          <h3 className="mt-1 text-base font-semibold text-strong">{finding.title}</h3>
          <p className="mt-1 break-words text-sm leading-6 text-muted">{finding.detail}</p>
          {needsProjectionRetry && finding.kind !== 'projection_failed' ? (
            <p className="mt-2 text-xs leading-5 text-muted">
              Graph processing also needs attention before this source can appear in Connections.
            </p>
          ) : null}
        </div>
        {finding.count > 1 ? <Badge tone="amber">{finding.count}</Badge> : null}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {finding.kind === 'projection_orphan' ? (
          <form action={removeDisconnectedKnowledgeItems}>
            <SubmitButton size="sm" pendingLabel="Removing…">
              Remove derived items
            </SubmitButton>
          </form>
        ) : null}
        {needsProjectionRetry ? (
          <form action={retryQuarantinedKnowledgeSources}>
            <SubmitButton size="sm" pendingLabel="Queueing…">
              Retry processing
            </SubmitButton>
          </form>
        ) : null}
        {finding.kind === 'unreviewed_connection' && finding.relationId ? (
          <form action={confirmKnowledgeRelation.bind(null, finding.relationId)}>
            <SubmitButton size="sm" variant="primary" pendingLabel="Confirming…">
              Confirm connection
            </SubmitButton>
          </form>
        ) : null}
        {finding.kind === 'quarantined' && finding.memoryId ? (
          <form action={approveKnowledgeMemory.bind(null, finding.memoryId)}>
            <SubmitButton size="sm" variant="primary" pendingLabel="Approving…">
              Approve
            </SubmitButton>
          </form>
        ) : null}
        {(finding.kind === 'expired' || finding.kind === 'superseded') && finding.memoryId ? (
          <form action={keepKnowledgeMemory.bind(null, finding.memoryId)}>
            <SubmitButton size="sm" variant="outline" pendingLabel="Keeping…">
              Keep as current
            </SubmitButton>
          </form>
        ) : null}
        {finding.kind === 'rejected_connection' ? (
          <p className="self-center text-xs text-muted">Already excluded from recall.</p>
        ) : null}
        {finding.memoryId ? <SourceImpactForget memoryId={finding.memoryId} /> : null}
      </div>
    </article>
  );
}

function CleanupGroup({
  title,
  description,
  findings,
  fullQueue,
}: {
  title: string;
  description: string;
  findings: KnowledgeCleanupFinding[];
  /** Where the same items live in full, when this group is a sample of a longer queue. */
  fullQueue?: { href: string; label: string };
}) {
  const immediate = findings.slice(0, 6);
  const remaining = findings.slice(6);
  return (
    <section aria-label={title} className="rounded-2xl border border-edge bg-sunken/20 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 px-1 pb-3">
        <div>
          <h3 className="text-base font-semibold text-strong">{title}</h3>
          <p className="mt-1 text-sm text-muted">{description}</p>
          {fullQueue ? (
            <Link
              href={fullQueue.href}
              className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-accent underline-offset-4 hover:underline"
            >
              {fullQueue.label}
            </Link>
          ) : null}
        </div>
        <Badge tone="neutral">{findingTotal(findings)}</Badge>
      </div>
      <div className="grid gap-3">
        {immediate.map((finding) => (
          <CleanupCard key={finding.id} finding={finding} />
        ))}
      </div>
      {remaining.length > 0 ? (
        <details className="mt-3 rounded-xl border border-edge bg-raised px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-strong">
            Show {remaining.length} more {remaining.length === 1 ? 'suggestion' : 'suggestions'}
          </summary>
          <div className="mt-3 grid gap-3">
            {remaining.map((finding) => (
              <CleanupCard key={finding.id} finding={finding} />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

type LibraryInput = Parameters<typeof listMemoryLibrary>[1];
type MapInput = Omit<Parameters<typeof getKnowledgeMapSnapshot>[1] & object, 'entityId'>;

/**
 * The graph overview and the cleanup scan are both needed by the header and
 * by the body, so they are read once here and handed to the header rather
 * than fetched again inside it.
 */
async function loadPostgresWorkspace(
  view: WorkspaceView,
  entity: string | undefined,
  page: number,
  libraryInput: LibraryInput,
  mapInput: MapInput,
) {
  const db = getDb();
  const [graph, findings] = await Promise.all([
    getKnowledgeGraphOverview(db, {
      query: libraryInput.query,
      kind: mapInput.kind,
      entityId: entity,
      page,
    }),
    getKnowledgeCleanupFindings(db),
  ]);
  const [overview, library, libraryFilters, map] = await Promise.all([
    getKnowledgeWorkspaceOverview(db, { graph, findings }),
    view === 'library' ? listMemoryLibrary(db, libraryInput) : Promise.resolve(null),
    view === 'library' ? listMemoryLibraryFilters(db) : Promise.resolve(null),
    view === 'map'
      ? getKnowledgeMapSnapshot(db, {
          ...mapInput,
          completeOverview: true,
          entityId: graph.selected && entity === graph.selected.id ? graph.selected.id : undefined,
        })
      : Promise.resolve(null),
  ]);
  const focus =
    entity && graph.selected?.id === entity
      ? {
          selected: graph.selected,
          duplicates: graph.duplicates,
          relations: graph.relations,
          derivedRelations: graph.derivedRelations ?? [],
          derivedCoverage: graph.derivedCoverage ?? 'complete',
        }
      : null;
  return { overview, findings, focus, library, libraryFilters, map };
}

/** One bounded Firestore snapshot serves the header, cleanup, map, and entity focus. */
async function loadFirestoreWorkspace(
  view: WorkspaceView,
  entity: string | undefined,
  libraryInput: LibraryInput,
  mapInput: MapInput,
) {
  const [workspace, libraryResult] = await Promise.all([
    getFirestoreKnowledgeWorkspace().load(),
    view === 'library' ? loadFirestoreMemoryLibrary(libraryInput) : Promise.resolve(null),
  ]);
  const focus = view === 'map' && entity ? await workspace.focus(entity) : null;
  const map =
    view === 'map'
      ? await workspace.map({ ...mapInput, completeOverview: true, entityId: focus?.selected.id })
      : null;
  return {
    overview: workspace.overview,
    findings: workspace.findings,
    focus,
    library: libraryResult?.[0] ?? null,
    libraryFilters: libraryResult?.[1] ?? null,
    map,
  };
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireOwner();
  const params = await searchParams;
  const view = workspaceView(params);
  const query = (params.q ?? '').trim().slice(0, 120);
  const kind = asGraphEntityKind(params.kind) ?? '';
  const requestedPage = Number.parseInt(params.page ?? '1', 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const state: MemoryState = MEMORY_STATES.includes(params.state as MemoryState)
    ? (params.state as MemoryState)
    : 'in-use';
  const filter: MemoryFilter = MEMORY_FILTERS.includes(params.filter as MemoryFilter)
    ? (params.filter as MemoryFilter)
    : 'all';
  const ageDays = [30, 90, 365].includes(Number(params.age)) ? Number(params.age) : undefined;
  const connectivity = ['connected', 'unconnected'].includes(params.connectivity ?? '')
    ? (params.connectivity as 'connected' | 'unconnected')
    : 'all';
  const family = params.family ?? '';
  const sourceMemoryId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      params.memory ?? '',
    )
      ? (params.memory ?? '')
      : '';
  const predicates = family
    ? PREDICATE_VOCABULARY.filter((predicate) => predicate.group === family).map(
        (predicate) => predicate.id,
      )
    : [];
  const libraryInput: LibraryInput = {
    state,
    filter,
    query,
    page,
    subjectId: params.subject,
    domain: params.domain,
    source: params.source,
    ageDays,
    connectivity,
  };
  const mapInput: MapInput = {
    query,
    kind,
    predicates,
    review: params.review === 'confirmed' || params.review === 'unreviewed' ? params.review : 'all',
    sourceMemoryId,
  };
  const { overview, findings, focus, library, libraryFilters, map } =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? await loadFirestoreWorkspace(view, params.entity, libraryInput, mapInput)
      : await loadPostgresWorkspace(view, params.entity, page, libraryInput, mapInput);
  const now = new Date();
  const ownerId = libraryFilters?.subjects.find((subject) => subject.trust === 'owner')?.id ?? null;
  const families = [...new Set(PREDICATE_VOCABULARY.map((entry) => entry.group))];
  const libraryHref = (overrides: Record<string, string | number | undefined> = {}) =>
    hrefFor({
      view: 'library',
      q: query,
      state,
      filter,
      subject: params.subject,
      domain: params.domain,
      age: params.age,
      source: params.source,
      connectivity: params.connectivity,
      ...overrides,
    });
  const advancedFiltersActive = Boolean(
    params.domain || params.age || params.source || params.connectivity,
  );
  const selectedCleanupFocus = cleanupFocus(params.cleanup);
  const cleanupHref = (focus: CleanupFocus) =>
    hrefFor({ view: 'cleanup', cleanup: focus === 'all' ? undefined : focus });
  const cleanupGroups = CLEANUP_FOCI.map((focus) => ({
    ...focus,
    findings: findings.filter((finding) => focus.kinds.includes(finding.kind)),
  })).filter((focus) => focus.findings.length > 0);
  const visibleCleanupGroups =
    selectedCleanupFocus === 'all'
      ? cleanupGroups
      : cleanupGroups.filter((focus) => focus.id === selectedCleanupFocus);
  const hasMapFilters = Boolean(
    query ||
      kind ||
      family ||
      params.review === 'confirmed' ||
      params.review === 'unreviewed' ||
      sourceMemoryId,
  );

  return (
    <PageShell size="wide">
      <PageHeader
        back={{ href: '/profile', label: 'Memory' }}
        title="Knowledge"
        intro="Manage the source facts your assistant remembers, see how they connect, and clear what no longer belongs."
        actions={
          overview.cleanupCount > 0 ? (
            <Link href="/profile/knowledge?view=cleanup" className={btn.outline}>
              <CircleAlert className="size-4" aria-hidden="true" />
              {overview.cleanupCount} to review
            </Link>
          ) : undefined
        }
      />

      <nav
        className={`${segmentedControlClass} mt-6 w-full sm:w-auto`}
        aria-label="Knowledge workspace"
      >
        {VIEWS.map((item) => (
          <Link
            key={item.id}
            href={hrefFor({ view: item.id })}
            aria-current={view === item.id ? 'page' : undefined}
            className={view === item.id ? segmentedItemActiveClass : segmentedItemClass}
          >
            {item.label}
            {item.id === 'cleanup' && overview.cleanupCount > 0 ? ` ${overview.cleanupCount}` : ''}
          </Link>
        ))}
      </nav>

      <section className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Memories in use', overview.memory.totalUsable],
          ['Connected items', overview.graph.activeEntities],
          ['Connections', overview.graph.activeRelations],
          ['Needs care', overview.cleanupCount],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-edge bg-sunken/30 px-4 py-3">
            <p className="font-display text-2xl font-semibold text-strong">
              {Number(value).toLocaleString()}
            </p>
            <p className="text-xs text-muted">{label}</p>
          </div>
        ))}
      </section>

      {view === 'library' && library && libraryFilters ? (
        <section className="mt-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className={microLabelClass}>Source of truth</p>
              <h2 className="mt-1 font-display text-2xl font-semibold text-strong">
                Memory library
              </h2>
            </div>
            <div className={segmentedControlClass}>
              {MEMORY_STATES.map((item) => (
                <Link
                  key={item}
                  href={libraryHref({ state: item, page: undefined })}
                  className={state === item ? segmentedItemActiveClass : segmentedItemClass}
                >
                  {item === 'in-use' ? 'In use' : 'Held for review'}
                </Link>
              ))}
            </div>
          </div>
          <nav className="mt-4 flex flex-wrap items-center gap-2" aria-label="Library quick views">
            <span className={`${microLabelClass} mr-1`}>Jump to</span>
            {overview.memory.awaitingReview > 0 ? (
              <Link
                href={libraryHref({
                  q: undefined,
                  state: 'review',
                  filter: 'all',
                  subject: undefined,
                  domain: undefined,
                  age: undefined,
                  source: undefined,
                  connectivity: undefined,
                  page: undefined,
                })}
                className={btn.outline}
              >
                {overview.memory.awaitingReview} awaiting review
              </Link>
            ) : null}
            {overview.memory.notYetOrganized > 0 ? (
              <Link
                href={libraryHref({
                  q: undefined,
                  state: 'in-use',
                  filter: 'untidied',
                  subject: undefined,
                  domain: undefined,
                  age: undefined,
                  source: undefined,
                  connectivity: undefined,
                  page: undefined,
                })}
                className={btn.outline}
              >
                {overview.memory.notYetOrganized} to organize
              </Link>
            ) : null}
            <Link href={hrefFor({ view: 'map' })} className={btn.outline}>
              Open map
            </Link>
          </nav>
          <form
            action="/profile/knowledge"
            className="mt-5 grid gap-2 rounded-2xl bg-sunken/35 p-3 md:grid-cols-4"
          >
            <input type="hidden" name="view" value="library" />
            <input type="hidden" name="state" value={state} />
            <label className="relative min-w-0 md:col-span-2">
              <span className="sr-only">Search source memories</span>
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
                aria-hidden="true"
              />
              <input
                name="q"
                defaultValue={query}
                placeholder="Search source memories"
                className={`${inputClass} w-full pl-9`}
              />
            </label>
            <select
              name="subject"
              defaultValue={params.subject ?? ''}
              className={`${selectClass} w-full min-w-0`}
              aria-label="Subject"
            >
              <option value="">Everyone</option>
              {libraryFilters.subjects.map((subject) => (
                <option key={subject.id} value={subject.id}>
                  {subject.label}
                </option>
              ))}
            </select>
            <select
              name="filter"
              defaultValue={filter}
              className={`${selectClass} w-full min-w-0`}
              aria-label="Verification"
            >
              <option value="all">Any verification</option>
              <option value="verified">Verified</option>
              <option value="untidied">Not yet tidied</option>
            </select>
            <div className="flex gap-2">
              <button type="submit" className={btn.primary}>
                Apply
              </button>
            </div>
            <details className="min-w-0 md:col-span-4" open={advancedFiltersActive}>
              <summary className="cursor-pointer py-1 text-sm font-medium text-muted hover:text-strong">
                {advancedFiltersActive ? 'Advanced filters are active' : 'More filters'}
              </summary>
              <div className="mt-3 grid gap-2 md:grid-cols-3">
                <select
                  name="domain"
                  defaultValue={params.domain ?? ''}
                  className={`${selectClass} w-full min-w-0`}
                  aria-label="Domain"
                >
                  <option value="">Every domain</option>
                  {[
                    'identity',
                    'work',
                    'home',
                    'relationships',
                    'preferences',
                    'health',
                    'other',
                  ].map((domain) => (
                    <option key={domain} value={domain}>
                      {domain}
                    </option>
                  ))}
                </select>
                <select
                  name="age"
                  defaultValue={params.age ?? ''}
                  className={`${selectClass} w-full min-w-0`}
                  aria-label="Age"
                >
                  <option value="">Any age</option>
                  <option value="30">Last 30 days</option>
                  <option value="90">Last 90 days</option>
                  <option value="365">Last year</option>
                </select>
                <select
                  name="connectivity"
                  defaultValue={connectivity}
                  className={`${selectClass} w-full min-w-0`}
                  aria-label="Graph connectivity"
                >
                  <option value="all">Any connection status</option>
                  <option value="connected">Connected</option>
                  <option value="unconnected">Not connected</option>
                </select>
                <select
                  name="source"
                  defaultValue={params.source ?? ''}
                  className={`${selectClass} md:col-span-3`}
                  aria-label="Source"
                >
                  <option value="">Every source</option>
                  {libraryFilters.sources.map((source) => (
                    <option key={source} value={source}>
                      {source}
                    </option>
                  ))}
                </select>
              </div>
            </details>
          </form>
          <p className="mt-4 text-sm text-muted">
            {library.total.toLocaleString()} matching memories
          </p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {library.rows.map(
              ({ memory, subjectId, subjectLabel, connectionCount, projectionStatus }) => (
                <FactRow
                  key={memory.id}
                  fact={toFactView(
                    memory,
                    subjectId,
                    subjectLabel,
                    ownerId,
                    now,
                    connectionCount,
                    projectionStatus,
                  )}
                  quarantine={state === 'review'}
                />
              ),
            )}
          </div>
          {library.rows.length === 0 ? (
            <EmptyState>No memories match these filters.</EmptyState>
          ) : null}
          {/* The query has always returned page/totalPages and libraryHref has
              always accepted a page, but nothing rendered a control: the header
              counted every match while only the first page could ever be read,
              so anything past it was unreachable. The phone's library already
              pages; this is the same ability on the web. */}
          {library.totalPages > 1 ? (
            <nav
              aria-label="Memory library pages"
              className="mt-5 flex flex-wrap items-center justify-between gap-3"
            >
              {library.page > 1 ? (
                <Link href={libraryHref({ page: library.page - 1 })} className={btnSm.outline}>
                  Previous
                </Link>
              ) : (
                <span />
              )}
              <p className="text-sm text-muted" aria-live="polite">
                Page {library.page.toLocaleString()} of {library.totalPages.toLocaleString()}
              </p>
              {library.page < library.totalPages ? (
                <Link href={libraryHref({ page: library.page + 1 })} className={btnSm.outline}>
                  Next
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </section>
      ) : null}

      {view === 'map' && map ? (
        <section className="mt-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className={microLabelClass}>Overview and focus</p>
              <h2 className="mt-1 font-display text-2xl font-semibold text-strong">
                How your knowledge connects
              </h2>
              <p className="mt-1 text-sm text-muted">
                {sourceMemoryId
                  ? 'Showing the active connections supported by one source memory.'
                  : 'Only active, source-backed connections appear here.'}
              </p>
            </div>
          </div>
          <form
            action="/profile/knowledge"
            className="mt-5 grid gap-2 rounded-2xl bg-sunken/35 p-3 md:grid-cols-3"
          >
            <input type="hidden" name="view" value="map" />
            {sourceMemoryId ? <input type="hidden" name="memory" value={sourceMemoryId} /> : null}
            <input
              name="q"
              defaultValue={query}
              aria-label="Narrow the map to matching items"
              placeholder="Narrow the map…"
              className={inputClass}
            />
            <select name="kind" defaultValue={kind} aria-label="Item type" className={selectClass}>
              <option value="">All item types</option>
              {['person', 'organization', 'project', 'place', 'event', 'date', 'topic'].map(
                (value) => (
                  <option key={value} value={value}>
                    {entityKindLabel(value)}
                  </option>
                ),
              )}
            </select>
            <select
              name="family"
              defaultValue={family}
              aria-label="Relationship"
              className={selectClass}
            >
              <option value="">All relationships</option>
              {families.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <div className="flex gap-2 md:col-span-3 md:justify-end">
              <select
                name="review"
                defaultValue={params.review ?? 'all'}
                aria-label="Review state"
                className={`${selectClass} min-w-0 flex-1 md:max-w-xs`}
              >
                <option value="all">Any review state</option>
                <option value="confirmed">Confirmed</option>
                <option value="unreviewed">Needs review</option>
              </select>
              <button type="submit" className={btn.primary}>
                Apply
              </button>
            </div>
          </form>
          {map.nodes.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-edge bg-sunken/30 px-5 py-10 text-center sm:px-10">
              <p className="font-medium text-strong">No active connections match this view</p>
              <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted">
                {hasMapFilters
                  ? 'Clear the filters to return to the full overview, or inspect source memories that have not connected yet.'
                  : 'Connections appear after source memories have been organized and verified. Start with the memory desk to prepare them.'}
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {hasMapFilters ? (
                  <Link href={hrefFor({ view: 'map' })} className={btn.primary}>
                    Clear map filters
                  </Link>
                ) : (
                  <Link href="/profile" className={btn.primary}>
                    Open memory desk
                  </Link>
                )}
                <Link
                  href={libraryHref({
                    q: undefined,
                    state: 'in-use',
                    filter: 'all',
                    subject: undefined,
                    domain: undefined,
                    age: undefined,
                    source: undefined,
                    connectivity: 'unconnected',
                    page: undefined,
                  })}
                  className={btn.outline}
                >
                  Show unconnected memories
                </Link>
              </div>
            </div>
          ) : (
            <div className="mt-5">
              <KnowledgeMap
                key={JSON.stringify([map.filters, params.entity])}
                snapshot={map}
                initialSelectedId={params.entity}
              />
            </div>
          )}
          {map.truncated ? (
            <p className="mt-3 text-xs text-muted">
              Showing {map.nodes.length.toLocaleString()} items from the most recent matching edges;
              this is a capped view, not the complete graph of {map.totalEdges.toLocaleString()}{' '}
              connections. Search or narrow the filters to inspect another area.
            </p>
          ) : null}
          {focus ? (
            <div id="knowledge-item" className="mt-7 max-w-3xl scroll-mt-24">
              <h3 className="text-lg font-semibold text-strong">
                Connections around {focus.selected.label}
              </h3>
              <div className="mt-3 flex flex-wrap gap-2">
                <EditKnowledgeEntity entity={focus.selected} duplicates={focus.duplicates} />
                <AddKnowledgeRelation selected={focus.selected} vocabulary={PREDICATE_VOCABULARY} />
                <Link href={hrefFor({ view: 'map' })} className={btn.outline}>
                  All knowledge
                </Link>
              </div>
              <div className="mt-3 grid gap-3">
                {focus.relations
                  .filter((relation) => relation.reviewStatus !== 'rejected')
                  .map((relation) => (
                    <article
                      id={`relation-${relation.id}`}
                      key={relation.id}
                      className={`${cardShellClass} p-4`}
                    >
                      <p className="text-sm font-semibold text-strong">
                        {(
                          relation as {
                            endpointViews?: Array<{
                              focusEntityId: string;
                              accessibilityText: string;
                            }>;
                          }
                        ).endpointViews?.find((view) => view.focusEntityId === focus.selected.id)
                          ?.accessibilityText ?? relation.presentation.sentence}
                      </p>
                      <p className="mt-2 text-xs leading-5 text-muted">{relation.source.content}</p>
                      <div className="mt-3 flex gap-2">
                        {relation.reviewStatus === 'unreviewed' ? (
                          <form action={confirmKnowledgeRelation.bind(null, relation.id)}>
                            <SubmitButton size="sm" variant="primary" pendingLabel="Confirming…">
                              <Check aria-hidden="true" />
                              Confirm
                            </SubmitButton>
                          </form>
                        ) : null}
                        <form action={rejectKnowledgeRelation.bind(null, relation.id)}>
                          <ConfirmButton
                            size="sm"
                            confirmLabel="Mark inaccurate?"
                            pendingLabel="Saving…"
                          >
                            <X aria-hidden="true" />
                            Mark inaccurate
                          </ConfirmButton>
                        </form>
                      </div>
                    </article>
                  ))}
              </div>
              {'derivedRelations' in focus && focus.derivedRelations?.length ? (
                <section className="mt-5" aria-label="Derived connections">
                  <h4 className="text-sm font-semibold text-strong">Derived connections</h4>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    These are derived from current recorded facts. They are not direct claims and
                    disappear when a supporting fact changes.
                  </p>
                  <div className="mt-2 grid gap-2">
                    {focus.derivedRelations.map((derived) => (
                      <article key={derived.id} className={`${cardShellClass} p-3`}>
                        <p className="text-sm font-semibold text-strong">{derived.explanation}</p>
                        <p className="mt-1 text-xs text-muted">
                          Based on {derived.premiseAssertionIds.length} recorded relationships ·
                          rule {derived.ruleId} v{derived.ruleVersion}
                        </p>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
              {'derivedCoverage' in focus && focus.derivedCoverage === 'bounded_incomplete' ? (
                <p className="mt-3 text-xs text-muted">
                  Derived connections are hidden because the premise scan reached its safety limit.
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {view === 'cleanup' ? (
        <section className="mt-8 max-w-4xl">
          <div className="flex items-start gap-3">
            <span className="inline-flex size-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Sparkles className="size-5" />
            </span>
            <div>
              <p className={microLabelClass}>Owner-controlled cleanup</p>
              <h2 className="mt-1 font-display text-2xl font-semibold text-strong">
                Keep what is true and useful
              </h2>
              <p className="mt-1 text-sm text-muted">
                Suggestions never remove semantic knowledge until you confirm. Derived orphan items
                can be cleared safely.
              </p>
            </div>
          </div>
          {findings.length > 0 ? (
            <nav className="mt-5 flex flex-wrap gap-2" aria-label="Cleanup categories">
              <Link
                href={cleanupHref('all')}
                aria-current={selectedCleanupFocus === 'all' ? 'page' : undefined}
                className={selectedCleanupFocus === 'all' ? btn.primary : btn.outline}
              >
                All {findingTotal(findings)}
              </Link>
              {cleanupGroups.map((focus) => (
                <Link
                  key={focus.id}
                  href={cleanupHref(focus.id)}
                  aria-current={selectedCleanupFocus === focus.id ? 'page' : undefined}
                  className={selectedCleanupFocus === focus.id ? btn.primary : btn.outline}
                >
                  {focus.label} {findingTotal(focus.findings)}
                </Link>
              ))}
            </nav>
          ) : null}
          <div className="mt-4 grid gap-4">
            {findings.length > 0 ? (
              visibleCleanupGroups.map((focus) => (
                <CleanupGroup
                  key={focus.id}
                  title={focus.label}
                  description={focus.description}
                  findings={focus.findings}
                  fullQueue={
                    focus.id === 'trust'
                      ? {
                          href: libraryHref({ state: 'review', filter: 'all' }),
                          label: 'Work the full review queue in the library',
                        }
                      : undefined
                  }
                />
              ))
            ) : (
              <EmptyState>
                <ShieldCheck className="mx-auto size-5 text-accent" />
                Nothing needs cleanup right now.
              </EmptyState>
            )}
          </div>
        </section>
      ) : null}
    </PageShell>
  );
}
