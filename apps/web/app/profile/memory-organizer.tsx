'use client';

import { ArrowUpRight, Brain, Check, CircleAlert, LoaderCircle, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useActionState } from 'react';
import { consolidateNow, type OrganizeMemoryState } from '@/app/profile/actions';
import { btn, cardShellClass, focusRing } from '@/lib/ui';

const initialOrganizeMemoryState: OrganizeMemoryState = {
  taskId: null,
  outcome: 'idle',
  message: null,
};

export interface OrganizerJobView {
  id: string;
  status: string;
  progress: string;
  updatedLabel: string;
}

function friendlyResult(progress: string): string {
  const reviewed = progress.match(/consolidation: (\d+) memories reviewed/);
  const duplicates = progress.match(/(\d+) duplicates expired/);
  const contradictions = progress.match(/(\d+) contradictions resolved/);
  const domains = progress.match(/(\d+) domains assigned/);
  const occasions = progress.match(/(\d+) occasion\(s\) found/);
  if (!reviewed) return progress || 'The latest organization pass finished.';
  const details = [
    duplicates && Number(duplicates[1]) > 0 ? `${duplicates[1]} duplicate(s) cleared` : null,
    contradictions && Number(contradictions[1]) > 0
      ? `${contradictions[1]} contradiction(s) resolved`
      : null,
    domains && Number(domains[1]) > 0 ? `${domains[1]} topic label(s) improved` : null,
    occasions && Number(occasions[1]) > 0 ? `${occasions[1]} date(s) found` : null,
  ].filter(Boolean);
  return `${reviewed[1]} memories reviewed${details.length > 0 ? ` · ${details.join(' · ')}` : ''}.`;
}

export function MemoryOrganizer({
  remaining,
  latest,
}: {
  remaining: number;
  latest: OrganizerJobView | null;
}) {
  const [state, action, submitting] = useActionState(consolidateNow, initialOrganizeMemoryState);
  const queued = remaining > 0 && latest?.status === 'pending';
  const working = remaining > 0 && latest?.status === 'running';
  const active = submitting || queued || working;
  const complete = remaining === 0 || latest?.status === 'done';
  const failed = latest?.status === 'failed' || latest?.status === 'needs_attention';

  const statusText =
    remaining === 0
      ? 'There are no saved memories waiting for their first cleanup pass.'
      : submitting
        ? 'Adding this pass to the work queue…'
        : working
          ? 'I’m comparing the next group for duplicates and contradictions.'
          : queued
            ? 'This pass is queued and will start shortly.'
            : complete
              ? friendlyResult(latest?.progress ?? '')
              : failed
                ? 'The latest pass did not finish. Open its activity to see what needs attention.'
                : state.message;

  return (
    <div className={`${cardShellClass} relative @container/organizer`}>
      {/* Accent only — the former multicolor strip was the one place in the app
          speaking colors outside the shared vocabulary. */}
      <div
        className={`h-1 origin-left bg-gradient-to-r from-accent to-accent-hover ${
          active ? 'motion-safe:animate-pulse' : ''
        }`}
      />
      <div className="p-5 sm:p-6">
        <div className="flex flex-col gap-5 @min-[32rem]/organizer:flex-row @min-[32rem]/organizer:items-center @min-[32rem]/organizer:justify-between">
          <div className="flex min-w-0 flex-col items-start gap-3.5 @min-[20rem]/organizer:flex-row">
            <span
              className={`relative inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent ${
                active ? 'motion-safe:animate-pulse' : ''
              }`}
            >
              {active ? (
                <LoaderCircle className="size-5 motion-safe:animate-spin" aria-hidden="true" />
              ) : complete ? (
                <Check className="size-5" aria-hidden="true" />
              ) : failed ? (
                <CircleAlert className="size-5" aria-hidden="true" />
              ) : (
                <Brain className="size-5" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <p className="text-sm font-medium text-accent">Memory desk</p>
              <h2 className="mt-0.5 text-lg font-semibold tracking-[-0.025em]">
                {remaining === 0
                  ? 'Everything has had a first pass'
                  : `${remaining} waiting for a pass`}
              </h2>
              <p className="mt-1 max-w-xl text-sm leading-5 text-muted">
                {statusText ??
                  'Organization checks saved facts in batches, clears repetition, and keeps your wording protected.'}
              </p>
              {latest ? (
                <Link
                  href={`/tasks/${latest.id}`}
                  className={`mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-strong ${focusRing}`}
                >
                  Latest activity · {latest.updatedLabel}
                  <ArrowUpRight className="size-3" aria-hidden="true" />
                </Link>
              ) : null}
            </div>
          </div>
          <form action={action} className="shrink-0">
            <button
              type="submit"
              disabled={active || remaining === 0}
              aria-busy={submitting}
              className={`${btn.primary} w-full sm:w-auto`}
            >
              {active ? (
                <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="size-4" aria-hidden="true" />
              )}
              {submitting
                ? 'Queuing…'
                : working
                  ? 'Organizing…'
                  : queued
                    ? 'Queued'
                    : remaining === 0
                      ? 'Up to date'
                      : 'Organize next batch'}
            </button>
          </form>
        </div>
        <details className="mt-4 border-t border-edge/70 pt-3">
          <summary className="disclosure flex items-center gap-2 cursor-pointer text-xs font-medium text-muted select-none">
            What happens during a pass?
          </summary>
          <p className="mt-2 max-w-[72ch] text-xs leading-5 text-muted">
            The assistant reviews up to 720 saved memories, grouped by person. It can clear
            duplicates, resolve direct contradictions, improve topic labels, combine fragments, and
            turn birthdays or anniversaries mentioned in facts into Occasions. A single standalone
            fact is marked as checked without rewriting it. Your confirmed or pinned wording remains
            protected.
          </p>
        </details>
      </div>
    </div>
  );
}
