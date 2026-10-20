'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import {
  deleteSourceAction,
  purgeSourceAction,
  reviewSourceAction,
  startImportAction,
} from '@/app/import/actions';
import {
  Badge,
  type BadgeTone,
  cardBodyClass,
  cardFooterChromeClass,
  cardHeaderClass,
  cardShellClass,
  cardTitleClass,
  MetaLine,
} from '@/lib/ui';
import { ActionButton, ConfirmButton } from '@/lib/ui-client';

/** Plain-serializable source view built in page.tsx. */
export interface SourceView {
  source: string;
  workspacePath: string;
  kind: string;
  status: string;
  itemsTotal: number | null;
  itemsProcessed: number;
  memoriesSaved: number;
  quarantinedNow: number;
  taskId: string | null;
  error: string | null;
  updatedLabel: string;
}

// Import keeps its own labels (Importing/Complete/Removed read better here than
// the generic task vocabulary), rendered through the shared Badge tones.
const statusTone: Record<string, BadgeTone> = {
  pending: 'neutral',
  running: 'accent',
  done: 'green',
  failed: 'red',
  purged: 'muted',
};

const statusLabels: Record<string, string> = {
  pending: 'Queued',
  running: 'Importing',
  done: 'Complete',
  failed: 'Needs attention',
  purged: 'Removed',
};

export function SourceCard({ view }: { view: SourceView }) {
  const [active, setActive] = useState<'approve' | 'reject' | 'rerun' | 'purge' | 'delete' | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (name: NonNullable<typeof active>, action: () => Promise<unknown>) => {
    setActive(name);
    startTransition(async () => {
      try {
        await action();
      } finally {
        setActive(null);
      }
    });
  };

  const pct =
    view.itemsTotal && view.itemsTotal > 0
      ? Math.min(100, Math.round((view.itemsProcessed / view.itemsTotal) * 100))
      : null;
  const rerunnable = view.status === 'done' || view.status === 'failed' || view.status === 'purged';

  return (
    <article className={cardShellClass}>
      <div className={cardBodyClass}>
        <div className={cardHeaderClass}>
          <div className="min-w-0">
            <h3 className={`truncate ${cardTitleClass}`}>{view.source}</h3>
            <p className="mt-0.5 text-xs text-muted">{view.updatedLabel}</p>
          </div>
          <Badge tone={statusTone[view.status] ?? 'neutral'}>
            {statusLabels[view.status] ?? 'Queued'}
          </Badge>
        </div>

        <MetaLine
          className="tabular-nums"
          segments={[
            pct !== null
              ? `${view.itemsProcessed} of ${view.itemsTotal} processed`
              : 'Waiting to process',
            `${view.memoriesSaved} memories saved`,
            view.quarantinedNow > 0 ? (
              <span key="review" className="font-medium text-amber-700 dark:text-amber-400">
                {view.quarantinedNow} need review
              </span>
            ) : null,
          ]}
        />
        {pct !== null && view.status === 'running' ? (
          <div>
            <div className="flex items-center justify-between gap-3 text-xs text-muted">
              <span>Import progress</span>
              <span>{pct}%</span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-sunken">
              <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : null}
        {view.error ? (
          <p className="rounded-xl bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700 dark:bg-red-950/35 dark:text-red-300">
            {view.error}
          </p>
        ) : null}

        {view.quarantinedNow > 0 ? (
          <div className="grid min-w-0 grid-cols-1 gap-3 rounded-xl bg-amber-50 px-3 py-3 dark:bg-amber-950/25 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div>
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                Review what this import learned
              </p>
              <p className="mt-0.5 text-xs leading-5 text-amber-800 dark:text-amber-300">
                {view.quarantinedNow} memories are held back until you approve or reject them.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <ActionButton
                variant="primary"
                disabled={pending}
                pending={pending && active === 'approve'}
                pendingLabel="Approving…"
                onClick={() => run('approve', () => reviewSourceAction(view.source, 'approve'))}
                title="Release every quarantined fact from this source into normal memory"
              >
                Approve all
              </ActionButton>
              {/* Deletes and tombstones every held-back memory at once — it used
                  to do that on a single click. */}
              <ConfirmButton
                disabled={pending}
                pending={pending && active === 'reject'}
                pendingLabel="Rejecting…"
                confirmLabel="Reject all?"
                onConfirm={() => run('reject', () => reviewSourceAction(view.source, 'reject'))}
                title="Delete and tombstone every quarantined fact from this source"
              >
                Reject all
              </ConfirmButton>
            </div>
          </div>
        ) : null}
        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      </div>

      <details className={`${cardFooterChromeClass} text-xs`}>
        <summary className="disclosure flex items-center gap-2 cursor-pointer font-medium text-muted">
          File and actions
        </summary>
        <p className="mt-2 break-words text-muted [overflow-wrap:anywhere]">
          {view.workspacePath} · {view.kind}
          {view.taskId ? (
            <>
              {' · '}
              <Link href={`/tasks/${view.taskId}`} className="underline hover:text-strong">
                View task
              </Link>
            </>
          ) : null}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {rerunnable ? (
            <ActionButton
              disabled={pending}
              pending={pending && active === 'rerun'}
              pendingLabel="Starting…"
              onClick={() =>
                run('rerun', async () => {
                  const result = await startImportAction(view.workspacePath, view.source);
                  if (result.error) setError(result.error);
                })
              }
              title="Import this file again; memories already saved are skipped"
            >
              Import again
            </ActionButton>
          ) : null}
          {view.status !== 'purged' && view.memoriesSaved > 0 ? (
            <ConfirmButton
              disabled={pending}
              pending={pending && active === 'purge'}
              pendingLabel="Removing…"
              confirmLabel={`Remove ${view.memoriesSaved}?`}
              onConfirm={() => run('purge', () => purgeSourceAction(view.source))}
              title={`Remove the ${view.memoriesSaved} memories from this import but keep its file`}
            >
              Remove memories
            </ConfirmButton>
          ) : null}
          <ConfirmButton
            disabled={pending}
            pending={pending && active === 'delete'}
            pendingLabel="Deleting…"
            confirmLabel="Delete import?"
            onConfirm={() => run('delete', () => deleteSourceAction(view.source))}
            title={`Remove this import${view.memoriesSaved > 0 ? `, its ${view.memoriesSaved} memories,` : ''} and the uploaded file`}
          >
            Delete import
          </ConfirmButton>
        </div>
      </details>
    </article>
  );
}

/** Start button for a workspace import/ file with no source row yet. */
export function StartImportButton({ path, suggestedTag }: { path: string; suggestedTag: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="flex items-center gap-2">
      <ActionButton
        pending={pending}
        pendingLabel="Starting…"
        onClick={() =>
          startTransition(async () => {
            const result = await startImportAction(path, suggestedTag);
            if (result.error) setError(result.error);
          })
        }
      >
        Start import
      </ActionButton>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </span>
  );
}
