'use client';

import type { KnowledgeMapSnapshot } from '@assistant/application';
import { ChevronLeft } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import {
  clipNodeLabel,
  entityKindLabel,
  entityKindPaint,
  humanizeEntityLabel,
} from '@/lib/knowledge';
import { btnSm, focusRing } from '@/lib/ui';
import { knowledgeConnections, layoutFocusRing, layoutKnowledgeMap } from './knowledge-map-model';
import { MapFocusCanvas } from './map-focus-canvas';
import { MapOverviewCanvas } from './map-overview-canvas';
import { MapStartingPoints } from './map-starting-points';

/**
 * How the map is being read right now.
 *
 * `start` is the default because the other two both assume the owner already
 * knows which item they came for. See MapStartingPoints for why arriving on a
 * drawing of everything is the wrong front door.
 */
type MapMode = 'start' | 'focus' | 'overview';

const KIND_LEGEND = ['person', 'organization', 'project', 'place', 'event', 'date', 'topic'];

export function KnowledgeMap({
  snapshot,
  initialSelectedId,
  contextHref = '/profile/knowledge?view=map',
}: {
  snapshot: KnowledgeMapSnapshot;
  initialSelectedId?: string;
  contextHref?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const [mode, setMode] = useState<MapMode>(initialSelectedId ? 'focus' : 'start');
  const [ringPage, setRingPage] = useState(0);
  const [view, setView] = useState<'map' | 'list'>('map');

  const nodeById = useMemo(
    () => new Map(snapshot.nodes.map((node) => [node.id, node])),
    [snapshot.nodes],
  );
  const selected = selectedId ? nodeById.get(selectedId) : undefined;

  // The relaxation is O(iterations x nodes^2) and runs synchronously, so it is
  // deliberately not computed until the owner actually asks for the overview.
  // Opening the map no longer pays for a drawing nobody requested.
  const overviewNodes = useMemo(
    () => (mode === 'overview' ? layoutKnowledgeMap(snapshot) : []),
    [snapshot, mode],
  );
  const overviewEdges = useMemo(
    () =>
      snapshot.edges.map((edge) => ({
        id: edge.id,
        subjectId: edge.subjectId,
        objectId: edge.objectId,
        unreviewed: edge.reviewStatus === 'unreviewed',
      })),
    [snapshot.edges],
  );
  const focus = useMemo(
    () => (selectedId ? layoutFocusRing(snapshot, selectedId, ringPage) : null),
    [snapshot, selectedId, ringPage],
  );

  const selectedEdges = useMemo(
    () =>
      selected
        ? snapshot.edges.filter(
            (edge) => edge.subjectId === selected.id || edge.objectId === selected.id,
          )
        : [],
    [snapshot.edges, selected],
  );
  const connections = useMemo(
    () => (selected ? knowledgeConnections(snapshot, selected.id) : []),
    [snapshot, selected],
  );
  const neighborIds = useMemo(
    () => new Set(selectedEdges.flatMap((edge) => [edge.subjectId, edge.objectId])),
    [selectedEdges],
  );

  /** Open an item: the one move that takes the map from browsing to reading. */
  const open = useCallback((id: string) => {
    setSelectedId(id);
    setRingPage(0);
    // Opening a neighbour from the overview stays on the overview — the owner
    // is reading shape and chose to highlight one item. Opening from anywhere
    // else is a request to look at that item, which the ring is for.
    setMode((current) => (current === 'overview' ? 'overview' : 'focus'));
  }, []);

  if (snapshot.nodes.length === 0) {
    return (
      <div className="rounded-2xl border border-edge bg-sunken/30 px-6 py-16 text-center">
        <p className="font-medium text-strong">No connected items in this loaded view</p>
        <p className="mt-1 text-sm text-muted">Try clearing map filters or opening the Library.</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <a className={btnSm.outline} href="/profile/knowledge?view=map">
            Clear map filters
          </a>
          <a className={btnSm.outline} href="/profile/knowledge?view=library">
            Open Library
          </a>
        </div>
      </div>
    );
  }

  const focusedHref = (entityId: string) => {
    const url = new URL(contextHref, 'https://assistant.invalid');
    url.searchParams.set('entity', entityId);
    return `${url.pathname}${url.search}#knowledge-item`;
  };

  const inspector = selected ? (
    <aside
      className="min-w-0 rounded-2xl border border-edge bg-raised p-4 sm:p-5"
      aria-label="Selected knowledge item"
    >
      {/* Opening an item rewrites this panel and redraws the canvas, neither of
          which announces itself. This says what was selected. */}
      <p aria-live="polite" className="sr-only">
        {`${selected.label} selected, ${connections.length} ${
          connections.length === 1 ? 'connection' : 'connections'
        }`}
      </p>
      <p className="text-xs font-medium text-muted">{entityKindLabel(selected.kind)}</p>
      <h2 className="mt-1 break-words font-display text-2xl font-semibold text-strong">
        {humanizeEntityLabel(selected.label)}
      </h2>
      <p className="mt-1 text-sm text-muted">
        {connections.length} {connections.length === 1 ? 'connection' : 'connections'} in this view
        · {new Set(selectedEdges.map((edge) => edge.sourceMemoryId)).size} saved source notes
      </p>
      <a
        className={`${btnSm.outline} mt-3 min-h-11 max-w-full whitespace-normal text-left`}
        href={focusedHref(selected.id)}
      >
        Open saved item {humanizeEntityLabel(selected.label)}
      </a>
      <div className="mt-5">
        <h3 className="text-sm font-semibold text-strong">Connections and evidence</h3>
        {connections.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            No connections are loaded for this item in this view.
          </p>
        ) : null}
        <div className="mt-2 divide-y divide-edge">
          {connections.map(({ id, edge, sources, confirmed }) => {
            const otherId = edge.subjectId === selected.id ? edge.objectId : edge.subjectId;
            const other = nodeById.get(otherId);
            return (
              <article key={id} className="py-4">
                <p
                  className={`mb-2 text-xs font-medium ${confirmed ? 'text-accent' : 'text-amber-700 dark:text-amber-300'}`}
                >
                  {confirmed ? 'Confirmed connection' : 'Unreviewed connection'}
                </p>
                <p className="text-sm font-semibold text-strong">{edge.presentation.sentence}</p>
                {edge.validFrom || edge.validUntil ? (
                  <p className="mt-1 text-xs text-muted">
                    {edge.validFrom ?? 'Unknown start'} to {edge.validUntil ?? 'no end recorded'}
                  </p>
                ) : null}
                {other && other.id !== selected.id ? (
                  <button
                    type="button"
                    className={`mt-1 min-h-11 text-sm text-accent underline-offset-4 hover:underline ${focusRing}`}
                    onClick={() => open(other.id)}
                  >
                    Explore {humanizeEntityLabel(other.label)}
                  </button>
                ) : !other ? (
                  <a
                    href={focusedHref(otherId)}
                    className="mt-1 inline-block text-sm text-accent underline"
                  >
                    Open item outside this loaded view
                  </a>
                ) : null}
                <details className="mt-1 text-sm">
                  <summary
                    className={`disclosure flex cursor-pointer items-center gap-2 rounded py-3 text-muted ${focusRing}`}
                  >
                    Saved source notes ({sources.length})
                  </summary>
                  {sources.map((source) => (
                    <div key={source.sourceMemoryId} className="mb-3 border-l-2 border-edge pl-3">
                      <p className="mb-1 text-xs text-muted">
                        {source.reviewStatus === 'confirmed'
                          ? 'Reviewed source connection'
                          : 'Source connection not yet reviewed'}
                      </p>
                      <blockquote className="whitespace-pre-wrap break-words text-xs leading-5 text-muted">
                        {source.evidenceQuote ||
                          source.sourceContent ||
                          'Source preview unavailable in this view.'}
                      </blockquote>
                      {source.evidenceQuote &&
                      source.sourceContent &&
                      source.evidenceQuote !== source.sourceContent ? (
                        <details className="mt-2 text-xs text-muted">
                          <summary
                            className={`disclosure flex cursor-pointer items-center gap-2 rounded py-2 ${focusRing}`}
                          >
                            Full source note
                          </summary>
                          <p className="whitespace-pre-wrap break-words leading-5">
                            {source.sourceContent}
                          </p>
                        </details>
                      ) : null}
                    </div>
                  ))}
                </details>
              </article>
            );
          })}
        </div>
      </div>
    </aside>
  ) : null;

  return (
    <div className="min-w-0">
      {/* One row that says where you are and how to leave: a trail back to the
          starting points, the item in hand, and the switch between the two
          drawings. Without it the canvas changes under the owner with nothing
          naming what changed. */}
      <nav
        aria-label="Knowledge map navigation"
        className="mb-3 flex flex-wrap items-center justify-between gap-2"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {mode === 'start' ? (
            <p className="text-sm font-medium text-strong">Knowledge map</p>
          ) : (
            <>
              <button
                type="button"
                className={btnSm.outline}
                onClick={() => {
                  setMode('start');
                  setSelectedId(null);
                  setRingPage(0);
                  setView('map');
                }}
              >
                <ChevronLeft className="size-4" />
                Starting points
              </button>
              <p className="min-w-0 truncate text-sm text-muted">
                {mode === 'overview'
                  ? `Whole map · ${snapshot.nodes.length.toLocaleString()} items`
                  : selected
                    ? `Connections to ${humanizeEntityLabel(selected.label)}`
                    : 'Whole map'}
              </p>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {
            <fieldset className="flex flex-wrap items-center gap-2" aria-label="Connection view">
              <button
                type="button"
                aria-pressed={view === 'map'}
                className={`${btnSm.outline} ${view === 'map' ? 'border-accent bg-accent/10 text-accent' : ''}`}
                onClick={() => setView('map')}
              >
                Map
              </button>
              <button
                type="button"
                aria-pressed={view === 'list'}
                className={`${btnSm.outline} ${view === 'list' ? 'border-accent bg-accent/10 text-accent' : ''}`}
                onClick={() => setView('list')}
              >
                List
              </button>
            </fieldset>
          }
          {mode === 'focus' ? (
            <button type="button" className={btnSm.outline} onClick={() => setMode('overview')}>
              Whole map
            </button>
          ) : null}
          {mode === 'overview' && selected ? (
            <button type="button" className={btnSm.outline} onClick={() => setMode('focus')}>
              Focus on {clipNodeLabel(selected.label, 16)}
            </button>
          ) : null}
        </div>
      </nav>

      {view === 'list' ? (
        selected ? (
          <div className="mt-4">{inspector}</div>
        ) : (
          <section aria-label="Items in this loaded view">
            <p className="mb-3 text-sm text-muted">
              {snapshot.nodes.length} items in this view
              {snapshot.truncated ? ' · connections are a bounded subset' : ''}
            </p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {snapshot.nodes.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => open(node.id)}
                    className={`${btnSm.outline} min-h-11 w-full whitespace-normal break-words text-left`}
                  >
                    {humanizeEntityLabel(node.label)} · {entityKindLabel(node.kind)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      ) : mode === 'start' ? (
        <MapStartingPoints
          snapshot={snapshot}
          onOpen={(id) => {
            setSelectedId(id);
            setRingPage(0);
            setMode('focus');
          }}
          onShowEverything={() => setMode('overview')}
        />
      ) : (
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
          {selected ? (
            <h2 className="break-words text-lg font-semibold xl:hidden">
              {humanizeEntityLabel(selected.label)}
            </h2>
          ) : null}
          <div className="min-w-0">
            {mode === 'overview' ? (
              <MapOverviewCanvas
                nodes={overviewNodes}
                edges={overviewEdges}
                selectedId={selectedId}
                neighborIds={neighborIds}
                onOpen={open}
                groupCount={snapshot.components.length}
              />
            ) : focus ? (
              <MapFocusCanvas layout={focus} onOpen={open} onPage={setRingPage} />
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
              {KIND_LEGEND.map((kind) => (
                <span key={kind} className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={`size-2 rounded-full ${entityKindPaint(kind).swatch}`}
                  />
                  {entityKindLabel(kind)}
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5">
                <svg aria-hidden="true" viewBox="0 0 20 4" className="h-1 w-5">
                  <line
                    x1="0"
                    y1="2"
                    x2="20"
                    y2="2"
                    strokeWidth="2"
                    strokeDasharray="5 4"
                    className="stroke-edge"
                  />
                </svg>
                Needs review
              </span>
            </div>
          </div>
          {inspector}
        </div>
      )}
    </div>
  );
}
