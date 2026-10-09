'use client';

import type { KnowledgeGraphDuplicate, KnowledgeGraphEntityView } from '@assistant/application';
import { ArrowRightLeft, Check, Search } from 'lucide-react';
import { useActionState, useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
  type KnowledgeActionState,
  mergeKnowledgeEntity,
  renameKnowledgeEntity,
  retypeKnowledgeEntity,
  searchKnowledgeEntities,
} from '@/app/profile/knowledge/actions';
import { ENTITY_KINDS, entityKindLabel } from '@/lib/knowledge';
import { btnSm, inputClass, labelClass, selectClass } from '@/lib/ui';
import { Modal, SubmitButton } from '@/lib/ui-client';

const initialState: KnowledgeActionState = { error: null, success: null };

type EntityMutationCallbacks = {
  onMutationStart?: () => void;
  onMutationEnd?: () => void;
  busy?: boolean;
};

const noop = () => {};

function ActionMessage({ state }: { state: KnowledgeActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-xs text-red-600 dark:text-red-400">
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return (
      <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">
        {state.success}
      </p>
    );
  }
  return null;
}

export function RenameEntity({
  entity,
  onMutationStart = noop,
  onMutationEnd = noop,
  busy = false,
}: { entity: KnowledgeGraphEntityView } & EntityMutationCallbacks) {
  const [label, setLabel] = useState(entity.label);
  const [state, formAction, pending] = useActionState(
    async (previous: KnowledgeActionState, formData: FormData) => {
      try {
        return await renameKnowledgeEntity(entity.id, previous, formData);
      } finally {
        onMutationEnd();
      }
    },
    initialState,
  );
  return (
    <form action={formAction} className="grid gap-2" onSubmitCapture={onMutationStart}>
      <fieldset disabled={busy || pending} className="contents">
        <label className={`grid gap-1 ${labelClass}`}>
          Display name
          <input
            name="label"
            required
            minLength={1}
            maxLength={160}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            className={inputClass}
          />
        </label>
        <p className="text-xs leading-5 text-muted">
          Changes what you see. The extraction identity behind it stays the same, so future syncs
          still land on this item.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton size="sm" pendingLabel="Saving…">
            Rename display
          </SubmitButton>
          <ActionMessage state={state} />
        </div>
      </fieldset>
    </form>
  );
}

/**
 * Change an entity's kind — the missing curation action. Dates are excluded:
 * their identity is a canonical date key, not a label, so retyping one would
 * produce exactly the kind of ambiguous node the canonicalizer exists to
 * prevent. The server declines with a merge hint when the target identity
 * already exists.
 */
export function RetypeEntity({
  entity,
  onMutationStart = noop,
  onMutationEnd = noop,
  busy = false,
}: { entity: KnowledgeGraphEntityView } & EntityMutationCallbacks) {
  const [state, formAction, pending] = useActionState(
    async (previous: KnowledgeActionState, formData: FormData) => {
      try {
        return await retypeKnowledgeEntity(entity.id, previous, formData);
      } finally {
        onMutationEnd();
      }
    },
    initialState,
  );
  const [kind, setKind] = useState(entity.kind);
  const [confirming, setConfirming] = useState(false);
  const isDate = entity.kind === 'date';
  const unchanged = kind === entity.kind;
  useEffect(() => {
    if (unchanged) setConfirming(false);
  }, [unchanged]);
  return (
    <form action={formAction} className="grid gap-2" onSubmitCapture={onMutationStart}>
      <fieldset disabled={busy || pending} className="contents">
        <label className={`grid gap-1 ${labelClass}`}>
          Type
          <select
            name="kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              setConfirming(false);
            }}
            disabled={isDate}
            className={selectClass}
          >
            {ENTITY_KINDS.map((value) => (
              <option key={value} value={value}>
                {entityKindLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs leading-5 text-muted">
          {isDate
            ? 'Dates keep their canonical identity and cannot change type.'
            : 'Changes how this item is filed. Its connections stay, and future extractions under the old identity still land here.'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {/* Two-step, like merge: a retype re-keys the entity's identity, so the
            confirm names the target kind rather than a bare "Change type?". */}
          {confirming && !unchanged ? (
            <SubmitButton size="sm" variant="primary" pendingLabel="Updating…">
              Change to {entityKindLabel(kind)}?
            </SubmitButton>
          ) : (
            <button
              type="button"
              disabled={isDate || unchanged}
              onClick={() => setConfirming(true)}
              className={btnSm.outline}
            >
              Change type
            </button>
          )}
          <ActionMessage state={state} />
        </div>
      </fieldset>
    </form>
  );
}

/**
 * Merge target picker. The old control was a `<select>` holding the first 200
 * entities alphabetically, which made anything past that point unreachable and
 * gave no way to search. This queries on demand instead, so the reachable set is
 * the whole graph, and it leads with the same-kind duplicates the server already
 * spotted — merging a person into a date is nearly always a slip.
 */
export function MergeEntity({
  entity,
  duplicates,
  onMutationStart = noop,
  onMutationEnd = noop,
  busy = false,
}: {
  entity: KnowledgeGraphEntityView;
  duplicates: KnowledgeGraphDuplicate[];
} & EntityMutationCallbacks) {
  const [state, formAction] = useActionState(
    async (previous: KnowledgeActionState, formData: FormData) => {
      try {
        return await mergeKnowledgeEntity(entity.id, previous, formData);
      } finally {
        onMutationEnd();
      }
    },
    initialState,
  );
  const [query, setQuery] = useState('');
  const [sameKindOnly, setSameKindOnly] = useState(true);
  const [results, setResults] = useState<KnowledgeGraphEntityView[]>([]);
  const [target, setTarget] = useState<{ id: string; label: string; kind: string } | null>(null);
  const [searching, startSearch] = useTransition();
  // Guards against an earlier, slower search landing after a later one and
  // overwriting the results the typed query actually asked for.
  const requestRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    const token = ++requestRef.current;
    const timer = setTimeout(() => {
      startSearch(async () => {
        const rows = await searchKnowledgeEntities(
          trimmed,
          entity.id,
          sameKindOnly ? entity.kind : '',
        );
        if (requestRef.current === token) setResults(rows);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [query, sameKindOnly, entity.id, entity.kind]);

  const choose = (option: { id: string; label: string; kind: string }) => {
    setTarget(option);
    setQuery('');
    setResults([]);
  };

  return (
    <form action={formAction} className="grid gap-2" onSubmitCapture={onMutationStart}>
      <fieldset disabled={busy} className="contents">
        <input type="hidden" name="targetId" value={target?.id ?? ''} />

        {/* The label shares a gap-1 stack with its control, matching the Rename
          and Type forms — as a direct child of the form's gap-2 grid it sat
          twice as far from the input as theirs do. */}
        <div className="grid gap-1">
          <span className={labelClass}>Merge this into</span>

          {duplicates.length > 0 && !target ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted">Possible duplicates:</span>
              {duplicates.map((duplicate) => (
                <button
                  key={duplicate.targetId}
                  type="button"
                  onClick={() =>
                    choose({
                      id: duplicate.targetId,
                      label: duplicate.label,
                      kind: duplicate.kind,
                    })
                  }
                  title={`Possible duplicate: ${duplicate.reason}`}
                  className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 motion-safe:transition-colors hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
                >
                  {duplicate.label}
                </button>
              ))}
            </div>
          ) : null}

          {target ? (
            <div className="flex min-w-0 items-center gap-2 rounded-lg border border-edge bg-raised px-3 py-2">
              <Check className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={target.label}>
                {target.label}
              </span>
              <span className="shrink-0 text-xs text-muted">{entityKindLabel(target.kind)}</span>
              <button
                type="button"
                onClick={() => setTarget(null)}
                className="shrink-0 text-xs font-medium text-muted underline underline-offset-2 hover:text-strong"
              >
                Change
              </button>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <label className="relative block">
                <span className="sr-only">Search for an item to merge into</span>
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search by name…"
                  className={`${inputClass} w-full pl-9`}
                />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={sameKindOnly}
                  onChange={(event) => setSameKindOnly(event.target.checked)}
                  className="size-3.5"
                />
                Only {entityKindLabel(entity.kind).toLocaleLowerCase()} items
              </label>
              {query.trim().length >= 2 ? (
                <ul className="max-h-48 overflow-y-auto rounded-lg border border-edge bg-raised">
                  {results.length === 0 ? (
                    <li className="px-3 py-2 text-xs text-muted">
                      {searching ? 'Searching…' : 'No matching items.'}
                    </li>
                  ) : (
                    results.map((option) => (
                      <li key={option.id}>
                        <button
                          type="button"
                          onClick={() => choose(option)}
                          className="flex w-full min-w-0 items-baseline justify-between gap-2 px-3 py-2 text-left text-sm motion-safe:transition-colors hover:bg-sunken"
                        >
                          <span className="min-w-0 truncate" title={option.label}>
                            {option.label}
                          </span>
                          <span className="shrink-0 text-xs text-muted">
                            {entityKindLabel(option.kind)}
                          </span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <MergeSubmit disabled={busy || !target} targetLabel={target?.label ?? ''} />
          <ActionMessage state={state} />
        </div>
      </fieldset>
    </form>
  );
}

/** The entity tools belong behind one deliberate “Edit item” action. */
export function EditKnowledgeEntity({
  entity,
  duplicates,
}: {
  entity: KnowledgeGraphEntityView;
  duplicates: KnowledgeGraphDuplicate[];
}) {
  const [open, setOpen] = useState(false);
  const [pendingMutations, setPendingMutations] = useState(0);
  const pendingMutationsRef = useRef(0);
  const onMutationStart = useCallback(() => {
    pendingMutationsRef.current += 1;
    setPendingMutations(pendingMutationsRef.current);
  }, []);
  const onMutationEnd = useCallback(() => {
    pendingMutationsRef.current = Math.max(0, pendingMutationsRef.current - 1);
    setPendingMutations(pendingMutationsRef.current);
  }, []);
  const busy = pendingMutations > 0;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={btnSm.outline}>
        Edit item
      </button>
      {open ? (
        <Modal
          label={`Edit ${entity.label}`}
          dismissible={!busy}
          onClose={() => {
            if (!pendingMutationsRef.current) setOpen(false);
          }}
          panelClassName="max-w-xl gap-5"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-display text-xl font-semibold text-strong">Edit item</p>
              <p className="mt-1 text-sm text-muted">
                Change how this item appears and is organised.
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!pendingMutationsRef.current) setOpen(false);
              }}
              className={btnSm.outline}
            >
              Done
            </button>
          </div>
          <div className="grid gap-5">
            <RenameEntity
              entity={entity}
              busy={busy}
              onMutationStart={onMutationStart}
              onMutationEnd={onMutationEnd}
            />
            <RetypeEntity
              entity={entity}
              busy={busy}
              onMutationStart={onMutationStart}
              onMutationEnd={onMutationEnd}
            />
            <MergeEntity
              entity={entity}
              duplicates={duplicates}
              busy={busy}
              onMutationStart={onMutationStart}
              onMutationEnd={onMutationEnd}
            />
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/**
 * Two-step confirm, matching the ConfirmButton pattern elsewhere, but spelled
 * out here so the confirmation can name the target — a merge is not reversible
 * from this page, and "Merge items?" alone does not say into what.
 */
function MergeSubmit({ disabled, targetLabel }: { disabled: boolean; targetLabel: string }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (disabled) setConfirming(false);
  }, [disabled]);

  if (!confirming) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setConfirming(true)}
        className={btnSm.outline}
        title="Preserves all sources and routes future extractions to the remaining item."
      >
        <ArrowRightLeft className="size-3.5" aria-hidden="true" />
        Merge entity
      </button>
    );
  }
  return (
    <SubmitButton size="sm" variant="danger" pendingLabel="Merging…">
      Merge into {targetLabel}?
    </SubmitButton>
  );
}
