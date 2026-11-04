import {
  asGraphEntityKind,
  getKnowledgeGraphOverview,
  getKnowledgeMapSnapshot,
  PREDICATE_VOCABULARY,
} from '@assistant/application';
import {
  listMemoryLibrary,
  listMemoryLibraryFilters,
  type MemoryFilter,
  type MemorySnapshot,
  type MemoryState,
} from '@assistant/application/profile';
import { loadConfig } from '@assistant/config';
import Link from 'next/link';
import { BrowseFact } from '@/app/profile/browse-fact';
import type { FactView } from '@/app/profile/fact-row';
import { MemoryNavigation } from '@/app/profile/memory-navigation';
import { requireOwner } from '@/auth';
import {
  getFirestoreKnowledgeWorkspace,
  loadFirestoreMemoryLibrary,
} from '@/lib/firestore-knowledge';
import { entityKindLabel } from '@/lib/knowledge';
import { memoryNoteHref, memoryNoteReturnTo } from '@/lib/memory-note-context';
import { savedNoteCreatedLabel, savedNoteValidityLabel } from '@/lib/saved-note-date-display';
import { withPostgresMemoryBrowseRead } from '@/lib/server';
import {
  btn,
  EmptyState,
  inputClass,
  PageHeader,
  PageShell,
  selectClass,
  summaryClass,
} from '@/lib/ui';
import { ConnectionsFilters } from './connections-filters';
import { ConnectionsList } from './connections-list';
import { KnowledgeMap } from './knowledge-map';

export const metadata = { title: 'Knowledge' };
export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = (value: string | undefined) =>
  typeof value === 'string' && UUID.test(value) ? value : undefined;
const bounded = (value: string | undefined) =>
  typeof value === 'string' ? value.trim().slice(0, 120) : '';
type LibraryInput = Parameters<typeof listMemoryLibrary>[1];
type MapInput = Parameters<typeof getKnowledgeMapSnapshot>[1] & object;
function href(params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== '') query.set(key, String(value));
  return `/profile/knowledge?${query}`;
}
function fact(
  memory: MemorySnapshot,
  subjectLabel: string | null,
  now: Date,
  context: Record<string, string | number | undefined>,
  page: number,
): FactView {
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
    aboutOwner: false,
    originTrust: memory.originTrust,
    sourceTaskId: memory.sourceTaskId,
    subjectLabel,
    createdLabel: savedNoteCreatedLabel(memory.createdAt, now),
    validityLabel: savedNoteValidityLabel(memory.validFrom, memory.validUntil),
    mapHref: href({ ...context, view: 'map', memory: memory.id }),
    noteHref: memoryNoteHref(memory.id, href({ ...context, view: 'library', page })) ?? undefined,
  };
}
/** Reuse bounded queries; no cleanup/header scan is needed for PostgreSQL browse. */
async function loadWorkspace(
  view: 'library' | 'map' | 'connections',
  libraryInput: LibraryInput,
  mapInput: MapInput,
) {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    if (view === 'library') {
      const [library, filters] = await loadFirestoreMemoryLibrary(libraryInput);
      return { library, filters, map: null, missingEntity: false };
    }
    // The existing fenced Firestore shared snapshot includes overview/findings.
    // It remains bounded; no cleanup actions or processing are invoked.
    const workspace = await getFirestoreKnowledgeWorkspace().load();
    const focus = mapInput.entityId ? await workspace.focus(mapInput.entityId) : null;
    const map = await workspace.map({
      ...mapInput,
      completeOverview: true,
      entityId: focus?.selected.id,
    });
    return {
      library: null,
      filters: null,
      map,
      missingEntity: Boolean(mapInput.entityId && !focus),
    };
  }
  return withPostgresMemoryBrowseRead(async (db) => {
    if (view === 'library') {
      const [library, filters] = await Promise.all([
        listMemoryLibrary(db, libraryInput),
        listMemoryLibraryFilters(db),
      ]);
      return { library, filters, map: null, missingEntity: false };
    }
    const graph = mapInput.entityId
      ? await getKnowledgeGraphOverview(db, { entityId: mapInput.entityId, page: 1 })
      : null;
    const map = await getKnowledgeMapSnapshot(db, {
      ...mapInput,
      completeOverview: false,
      entityId: graph?.selected?.id,
    });
    return {
      library: null,
      filters: null,
      map,
      missingEntity: Boolean(mapInput.entityId && !graph?.selected),
    };
  });
}
export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const owner = await requireOwner();
  const raw = await searchParams;
  const view: 'library' | 'map' | 'connections' =
    raw.view === 'library' || raw.view === 'map' || raw.view === 'connections'
      ? raw.view
      : id(raw.entity) || raw.mode === 'map'
        ? 'map'
        : 'library';
  const query = bounded(raw.q);
  const state: MemoryState = raw.state === 'review' ? 'review' : 'in-use';
  const filter: MemoryFilter =
    raw.filter === 'verified' || raw.filter === 'untidied' ? raw.filter : 'all';
  const pageNumber = Number(raw.page);
  const page = Number.isSafeInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;
  const families = [...new Set(PREDICATE_VOCABULARY.map((entry) => entry.group))];
  const family = families.find((value) => value === raw.family) ?? '';
  const kind = asGraphEntityKind(raw.kind) ?? '';
  const review = raw.review === 'confirmed' || raw.review === 'unreviewed' ? raw.review : 'all';
  const memory = id(raw.memory);
  const entity = id(raw.entity);
  const subject = id(raw.subject);
  const domains = ['identity', 'work', 'home', 'relationships', 'preferences', 'health', 'other'];
  const domain = domains.includes(raw.domain ?? '') ? raw.domain : undefined;
  const age = [30, 90, 365].includes(Number(raw.age)) ? Number(raw.age) : undefined;
  const connectivity =
    raw.connectivity === 'connected' || raw.connectivity === 'unconnected'
      ? raw.connectivity
      : 'all';
  const source = bounded(raw.source);
  const activeLibraryFilters =
    Number(state !== 'in-use') +
    Number(filter !== 'all') +
    Number(Boolean(subject)) +
    Number(Boolean(domain)) +
    Number(Boolean(source)) +
    Number(age !== undefined) +
    Number(connectivity !== 'all');
  const retained = {
    q: query,
    state,
    filter,
    subject,
    domain,
    source,
    age,
    connectivity,
    kind,
    family,
    review,
    memory,
    entity,
  };
  const libraryInput: LibraryInput = {
    query,
    state,
    filter,
    page,
    subjectId: subject,
    domain,
    source,
    ageDays: age,
    connectivity,
  };
  const mapInput: MapInput = {
    query,
    kind,
    review,
    sourceMemoryId: memory,
    entityId: entity,
    predicates: family
      ? PREDICATE_VOCABULARY.filter((entry) => entry.group === family).map((entry) => entry.id)
      : [],
  };
  let data: Awaited<ReturnType<typeof loadWorkspace>>;
  try {
    data = await loadWorkspace(view, libraryInput, mapInput);
  } catch {
    return (
      <PageShell size="reading">
        <PageHeader
          back={{ href: '/profile', label: 'Memory' }}
          title={
            view === 'library' ? 'Saved notes' : view === 'connections' ? 'Connections' : 'Map'
          }
        />
        <MemoryNavigation
          current={view === 'library' ? 'notes' : view === 'connections' ? 'connections' : 'map'}
          notesHref={href({ ...retained, view: 'library' })}
          connectionsHref={href({ ...retained, view: 'connections' })}
          mapHref={href({ ...retained, view: 'map' })}
        />
        <p role="alert" className="mt-4 text-muted">
          Could not load this view. Your filters are preserved.
        </p>
        <Link href={href({ ...retained, view, page })} className={btn.outline}>
          Try again
        </Link>
      </PageShell>
    );
  }
  const { library, filters, map, missingEntity } = data;
  const now = new Date();
  const addPersonNoteReturnTo = memoryNoteReturnTo(href({ ...retained, view: 'library', page }));
  const addPersonNoteHref = addPersonNoteReturnTo
    ? `/people?addNote=1&returnTo=${encodeURIComponent(addPersonNoteReturnTo)}`
    : '/people?addNote=1';
  return (
    <PageShell size="wide">
      <PageHeader
        back={{ href: '/profile', label: 'Memory' }}
        title={view === 'library' ? 'Saved notes' : view === 'connections' ? 'Connections' : 'Map'}
        intro="Browse saved notes and their connections."
      />
      <MemoryNavigation
        current={view === 'library' ? 'notes' : view === 'connections' ? 'connections' : 'map'}
        notesHref={href({ ...retained, view: 'library' })}
        connectionsHref={href({ ...retained, view: 'connections' })}
        mapHref={href({ ...retained, view: 'map' })}
      />
      {view !== 'connections' ? (
        <p className="mt-4 text-sm text-muted">
          Open a saved note or person to review available edits. Editing availability is checked
          with its source.
        </p>
      ) : null}
      {view === 'library' ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-edge bg-raised p-4">
          <p className="min-w-0 flex-1 text-sm text-muted">
            You can add a plain-text note about an existing person.
          </p>
          <Link href={addPersonNoteHref} className={btn.outline}>
            Add a note about someone
          </Link>
        </div>
      ) : null}
      {view === 'connections' ? (
        <ConnectionsFilters
          query={query}
          kind={kind}
          family={family}
          review={review}
          families={families}
          retained={retained}
        />
      ) : (
        <form
          method="get"
          action="/profile/knowledge"
          className={
            view === 'library'
              ? 'mt-5 min-w-0 space-y-3 rounded-2xl bg-sunken/35 p-3'
              : 'mt-5 grid min-w-0 gap-3 rounded-2xl bg-sunken/35 p-3 md:grid-cols-3'
          }
        >
          <input type="hidden" name="view" value={view} />
          {Object.entries(retained)
            .filter(
              ([key, value]) =>
                value &&
                ![
                  'q',
                  ...(view === 'library'
                    ? ['state', 'filter', 'subject', 'domain', 'source', 'age', 'connectivity']
                    : ['kind', 'family', 'review']),
                ].includes(key),
            )
            .map(([key, value]) => (
              <input key={key} type="hidden" name={key} value={String(value)} />
            ))}
          {view === 'library' ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="grid min-w-0 flex-1 gap-1 text-sm">
                Search saved notes
                <input name="q" maxLength={120} defaultValue={query} className={inputClass} />
              </label>
              <button className={btn.primary} type="submit">
                Search
              </button>
            </div>
          ) : (
            <label className="grid min-w-0 gap-1 text-sm">
              Search items by name
              <input name="q" maxLength={120} defaultValue={query} className={inputClass} />
            </label>
          )}
          {view === 'library' && filters ? (
            <details
              className="rounded-xl border border-edge/60 px-3"
              open={activeLibraryFilters > 0}
            >
              <summary className={`${summaryClass} py-2`}>
                Filters ({activeLibraryFilters} active)
              </summary>
              <div className="grid gap-3 pb-3 md:grid-cols-3">
                <label className="grid gap-1 text-sm">
                  Status
                  <select name="state" defaultValue={state} className={selectClass}>
                    <option value="in-use">In use</option>
                    <option value="review">Held for review</option>
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  Verification
                  <select name="filter" defaultValue={filter} className={selectClass}>
                    <option value="all">All</option>
                    <option value="verified">Verified</option>
                    <option value="untidied">Not tidied</option>
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  Subject
                  <select name="subject" defaultValue={subject ?? ''} className={selectClass}>
                    <option value="">Everyone</option>
                    {filters.subjects.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  Domain
                  <select name="domain" defaultValue={domain ?? ''} className={selectClass}>
                    <option value="">Every domain</option>
                    {domains.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  Source
                  <select name="source" defaultValue={source} className={selectClass}>
                    <option value="">Every source</option>
                    {filters.sources.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  Age
                  <select name="age" defaultValue={age ?? ''} className={selectClass}>
                    <option value="">Any age</option>
                    {[30, 90, 365].map((item) => (
                      <option key={item} value={item}>
                        Last {item} days
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  Connections
                  <select name="connectivity" defaultValue={connectivity} className={selectClass}>
                    <option value="all">Any status</option>
                    <option value="connected">Connected</option>
                    <option value="unconnected">Not connected</option>
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap gap-2 pb-3">
                <button className={btn.outline} type="submit">
                  Apply filters
                </button>
                <Link className={btn.outline} href={href({ view })}>
                  Clear filters
                </Link>
              </div>
            </details>
          ) : view === 'map' ? (
            <>
              <label className="grid gap-1 text-sm">
                Item type
                <select name="kind" defaultValue={kind} className={selectClass}>
                  <option value="">All types</option>
                  {['person', 'organization', 'project', 'place', 'event', 'date', 'topic'].map(
                    (item) => (
                      <option key={item} value={item}>
                        {entityKindLabel(item)}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Relationship
                <select name="family" defaultValue={family} className={selectClass}>
                  <option value="">All relationships</option>
                  {families.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Review status
                <select name="review" defaultValue={review} className={selectClass}>
                  <option value="all">All</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="unreviewed">Unreviewed</option>
                </select>
              </label>
              <div className="flex flex-wrap items-end gap-2 md:col-span-3">
                <button className={btn.primary} type="submit">
                  Apply
                </button>
                <Link className={btn.outline} href={href({ view })}>
                  Clear filters
                </Link>
              </div>
            </>
          ) : null}
        </form>
      )}
      {(raw.entity && !entity) || (raw.memory && !memory) || (raw.subject && !subject) ? (
        <p role="status" className="mt-3 text-sm text-muted">
          An invalid item filter was not applied. Only the supported browse view is shown.
        </p>
      ) : null}
      {view === 'library' && (kind || family || review !== 'all' || entity) ? (
        <p className="mt-3 text-sm text-muted">
          Map filters are retained for the Map view; they do not filter these notes.
        </p>
      ) : null}
      {view !== 'library' &&
      (subject ||
        domain ||
        source ||
        age ||
        connectivity !== 'all' ||
        state !== 'in-use' ||
        filter !== 'all') ? (
        <p className="mt-3 text-sm text-muted">
          Saved-note filters are retained for Saved notes; they do not filter this map.
        </p>
      ) : null}
      {memory ? (
        <p className="mt-3 text-sm text-muted">
          {view !== 'library'
            ? 'Source note filter'
            : 'Map source note filter retained (not applied to Saved notes)'}
          : {memory} ·{' '}
          <Link className="underline" href={href({ ...retained, view, memory: undefined })}>
            Remove source filter
          </Link>
        </p>
      ) : null}
      {raw.view === 'cleanup' || raw.mode === 'review' || raw.mode === 'edit' ? (
        <p className="mt-3 text-sm text-muted">
          Open a saved note or person to review available edits. Cleanup is unavailable here.
        </p>
      ) : null}
      {view === 'library' && library ? (
        <section className="mt-6">
          <p className="text-sm text-muted">
            {library.rows.length} notes shown · {library.total} matching notes
          </p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {library.rows.map(({ memory: note, subjectLabel }) => (
              <BrowseFact
                key={note.id}
                fact={fact(note, subjectLabel, now, retained, library.page)}
              />
            ))}
          </div>
          {!library.rows.length ? <EmptyState>No matching notes in this view.</EmptyState> : null}
          <nav aria-label="Saved notes pages" className="mt-5 flex flex-wrap items-center gap-4">
            {library.page > 1 ? (
              <Link
                className={btn.outline}
                href={href({ ...retained, view, page: library.page - 1 })}
              >
                Previous
              </Link>
            ) : null}
            <span className="text-sm text-muted">
              Page {library.page} of {Math.max(1, library.totalPages)}
            </span>
            {library.page < library.totalPages ? (
              <Link
                className={btn.outline}
                href={href({ ...retained, view, page: library.page + 1 })}
              >
                Next
              </Link>
            ) : null}
          </nav>
        </section>
      ) : null}
      {view === 'connections' && map ? (
        <section className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">
              {map.edges.length} connections in this view.
              {map.truncated ? ' Showing a bounded subset of connections.' : ''}
            </p>
          </div>
          <ConnectionsList snapshot={map} contextHref={href({ ...retained, view })} />
        </section>
      ) : null}
      {view === 'map' && map ? (
        <section className="mt-6">
          {missingEntity ? (
            <p role="status" className="mb-4 text-sm text-muted">
              The selected item was not found. The loaded map is shown below.
            </p>
          ) : null}
          {entity && !missingEntity && !map.nodes.some((node) => node.id === entity) ? (
            <p className="mb-4 text-sm text-muted">
              The selected item exists, but it is outside this loaded map view.
            </p>
          ) : null}
          <p className="mb-4 text-sm text-muted">
            {map.nodes.length} items in this view.
            {map.truncated ? ' Showing a bounded subset of connections.' : ''}
          </p>
          <KnowledgeMap
            key={JSON.stringify([owner, retained])}
            snapshot={map}
            initialSelectedId={
              !missingEntity && map.nodes.some((node) => node.id === entity) ? entity : undefined
            }
            contextHref={href({ ...retained, view })}
          />
          {!map.nodes.length ? (
            <EmptyState>
              No matching items in this view. Try clearing filters or opening Saved notes.
            </EmptyState>
          ) : null}
        </section>
      ) : null}
    </PageShell>
  );
}
