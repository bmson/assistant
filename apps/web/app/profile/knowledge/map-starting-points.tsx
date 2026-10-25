'use client';

import type { KnowledgeMapSnapshot } from '@assistant/application';
import { ArrowRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { entityKindLabel, entityKindPaint, humanizeEntityLabel } from '@/lib/knowledge';
import { btn, focusRing, inputClass, microLabelClass } from '@/lib/ui';
import { knowledgeStartingPoints } from './knowledge-map-model';

const SEARCH_LIMIT = 40;

function ItemButton({
  node,
  onOpen,
}: {
  node: KnowledgeMapSnapshot['nodes'][number];
  onOpen: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(node.id)}
      className={`group flex min-h-11 w-full items-center gap-3 rounded-xl border border-edge bg-raised px-3 py-2.5 text-left motion-safe:transition-colors hover:border-accent/60 hover:bg-sunken/40 ${focusRing}`}
    >
      <span
        aria-hidden="true"
        className={`size-2.5 shrink-0 rounded-full ${entityKindPaint(node.kind).swatch}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-strong">
          {humanizeEntityLabel(node.label)}
        </span>
        <span className="block text-xs text-muted">
          {node.degree.toLocaleString()} {node.degree === 1 ? 'connection' : 'connections'}
        </span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted group-hover:text-accent" />
    </button>
  );
}

/**
 * The map's front door.
 *
 * A whole-graph drawing is a poor place to arrive: every item is the same size,
 * nothing is named at that density, and the inspector lands on whichever node
 * the relaxation happened to emit first. So the map opens on names instead —
 * search, plus the best-connected items of each kind — and the drawing is
 * something the owner asks for once they know what they are looking at.
 */
export function MapStartingPoints({
  snapshot,
  onOpen,
  onShowEverything,
}: {
  snapshot: KnowledgeMapSnapshot;
  onOpen: (id: string) => void;
  onShowEverything: () => void;
}) {
  const [search, setSearch] = useState('');
  const groups = useMemo(() => knowledgeStartingPoints(snapshot), [snapshot]);
  const query = search.trim().toLocaleLowerCase();
  const matches = useMemo(() => {
    if (!query) return [];
    return snapshot.nodes
      .filter((node) => humanizeEntityLabel(node.label).toLocaleLowerCase().includes(query))
      .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label))
      .slice(0, SEARCH_LIMIT);
  }, [snapshot.nodes, query]);

  return (
    <section
      className="min-w-0 rounded-2xl border border-edge bg-sunken/30 p-4 sm:p-6"
      aria-label="Choose where to start"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className={microLabelClass}>Start somewhere</p>
          <h3 className="mt-1 font-display text-xl font-semibold text-strong">
            Open an item to see what it connects to
          </h3>
          <p className="mt-1 max-w-prose text-sm leading-6 text-muted">
            {snapshot.nodes.length.toLocaleString()} connected items in this view. Pick one and the
            map draws it with its connections named, or search for something specific.
          </p>
        </div>
        <button type="button" onClick={onShowEverything} className={btn.outline}>
          Show the whole map
        </button>
      </div>

      <label className="mt-5 block">
        <span className="sr-only">Search items in this view</span>
        <span className="relative block">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search items in this view…"
            className={`${inputClass} w-full pl-9`}
          />
        </span>
      </label>

      {query ? (
        <div className="mt-4">
          <p className="text-sm text-muted" aria-live="polite">
            {matches.length === 0
              ? 'Nothing in this view matches. Change the map filters above to search the rest of your knowledge.'
              : `${matches.length}${matches.length === SEARCH_LIMIT ? '+' : ''} ${matches.length === 1 ? 'match' : 'matches'}`}
          </p>
          <div className="mt-2 grid max-h-96 gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
            {matches.map((node) => (
              <ItemButton key={node.id} node={node} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((group) => (
            <div key={group.kind} className="min-w-0">
              <p className={microLabelClass}>{entityKindLabel(group.kind)}</p>
              <div className="mt-2 grid gap-2">
                {group.nodes.map((node) => (
                  <ItemButton key={node.id} node={node} onOpen={onOpen} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!query && snapshot.nodes.length > groups.reduce((total, g) => total + g.nodes.length, 0) ? (
        <p className="mt-5 text-xs text-muted">
          Showing the best-connected of each kind. Search above, or{' '}
          <button
            type="button"
            onClick={onShowEverything}
            className={`rounded text-accent underline-offset-4 hover:underline ${focusRing}`}
          >
            open the whole map
          </button>{' '}
          to browse everything.
        </p>
      ) : null}
    </section>
  );
}
