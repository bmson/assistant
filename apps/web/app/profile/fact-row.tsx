'use client';

import { LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useRef, useState, useTransition } from 'react';
import {
  approveQuarantined,
  confirmFact,
  correctFact,
  forgetFact,
  type ProminenceLevel,
  rejectQuarantined,
  setFactProminence,
} from '@/app/profile/actions';
import {
  Badge,
  btnSm,
  cardFooterClass,
  cardShellClass,
  focusRing,
  MetaLine,
  textareaClass,
} from '@/lib/ui';
import { ActionButton, ActionMenu, ConfirmButton } from '@/lib/ui-client';

/** Plain-serializable fact view, built server-side in page.tsx. */
export interface FactView {
  id: string;
  content: string;
  kind: string;
  domain: string;
  confidence: number;
  importance: number;
  ownerConfirmed: boolean;
  pinned: boolean;
  organized: boolean;
  /** Whether the compile rules put this fact in the owner card right now. */
  inCard: boolean;
  /** Owner facts can auto-surface by importance; person facts only via pin. */
  aboutOwner: boolean;
  originTrust: string;
  sourceTaskId: string | null;
  subjectLabel?: string | null;
  createdLabel: string;
  validityLabel: string;
  /** The workspace supplies these so source facts do not hide their graph impact. */
  workspace?: boolean;
  connectionCount?: number;
  projectionStatus?: 'connected' | 'mapping' | 'needs_attention' | 'no_connections';
  mapHref?: string;
}

const PROMINENCE_OPTIONS: Array<{ level: ProminenceLevel; label: string; hint: string }> = [
  {
    level: 'always',
    label: 'Always',
    hint: 'Always kept in the assistant’s profile summary, in every conversation.',
  },
  {
    level: 'auto',
    label: 'When relevant',
    hint: 'The assistant decides — important facts surface on their own; the rest are recalled when they matter.',
  },
  {
    level: 'minor',
    label: 'Minor',
    hint: 'A small detail — kept for recall but never featured in the profile summary.',
  },
];

function prominenceOf(fact: FactView): ProminenceLevel {
  if (fact.pinned) return 'always';
  if (fact.importance <= 1) return 'minor';
  return 'auto';
}

export function FactRow({ fact, quarantine = false }: { fact: FactView; quarantine?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.content);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);

  const confidencePct = Math.round(fact.confidence * 100);
  const runAction = (name: string, action: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setPendingAction(name);
    startTransition(async () => {
      try {
        await action();
      } catch {
        setError('That change could not be saved. Your draft is kept here.');
      } finally {
        inFlight.current = false;
        setPendingAction(null);
      }
    });
  };
  const pendingIcon = (
    <LoaderCircle className="size-3 motion-safe:animate-spin" aria-hidden="true" />
  );

  const forgetButton = (
    <ConfirmButton
      size="sm"
      className="w-fit"
      disabled={pending}
      pending={pendingAction === 'forget'}
      pendingLabel="Forgetting…"
      confirmLabel="Forget?"
      title="Deletes the fact and tombstones it so it can never be re-extracted"
      onConfirm={() => runAction('forget', () => forgetFact(fact.id))}
    >
      Forget
    </ConfirmButton>
  );

  return (
    <article className={cardShellClass}>
      <div className="grid min-w-0 gap-3 p-4">
        <p className="min-w-0 break-words text-sm leading-6 text-strong [overflow-wrap:anywhere]">
          {fact.content}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {fact.pinned ? (
            <Badge tone="accent" size="xs">
              Pinned
            </Badge>
          ) : fact.inCard ? (
            <Badge
              tone="accent"
              size="xs"
              title="Auto-selected into the compiled owner card (high importance)"
            >
              In profile
            </Badge>
          ) : null}
          {fact.ownerConfirmed ? (
            <Badge tone="green" size="xs">
              Verified
            </Badge>
          ) : null}
          {!quarantine && !fact.organized ? (
            <Badge
              tone="neutral"
              size="xs"
              title="This fact has not been checked for repetition or conflicts yet."
            >
              Cleanup pending
            </Badge>
          ) : null}
          {!quarantine && fact.importance <= 1 ? (
            <Badge tone="neutral" size="xs">
              Minor detail
            </Badge>
          ) : null}
          {fact.workspace ? (
            fact.connectionCount ? (
              <Badge tone="accent" size="xs">
                {fact.connectionCount} connection{fact.connectionCount === 1 ? '' : 's'}
              </Badge>
            ) : fact.projectionStatus === 'mapping' ? (
              <Badge tone="amber" size="xs" title="This source is queued or waiting to be mapped.">
                Mapping connections
              </Badge>
            ) : fact.projectionStatus === 'needs_attention' ? (
              <Badge
                tone="red"
                size="xs"
                title="Graph processing needs a retry before this source can map."
              >
                Mapping needs attention
              </Badge>
            ) : (
              <Badge tone="neutral" size="xs">
                No connections
              </Badge>
            )
          ) : null}
          {fact.validityLabel ? (
            <span className="text-xs text-muted">{fact.validityLabel}</span>
          ) : null}
          {fact.sourceTaskId ? (
            <Link
              href={`/tasks/${fact.sourceTaskId}`}
              className="text-xs font-medium text-muted underline hover:text-strong"
            >
              View source
            </Link>
          ) : null}
        </div>
        {/* A fact is a sentence with provenance, not a form — the old
            About/Type/Topic/Confidence grid made every memory read as a mini
            dashboard. One quiet line carries the same facts. */}
        <MetaLine
          segments={[
            // The owner reads as "You" whether or not the row carries their
            // contact name — the library was showing "You" and the owner's name
            // for the same person depending on which query loaded the fact.
            quarantine
              ? `From ${/^[aeiou]/i.test(fact.originTrust) ? 'an' : 'a'} ${fact.originTrust} source`
              : `About ${fact.aboutOwner || !fact.subjectLabel ? 'you' : fact.subjectLabel}`,
            fact.kind,
            fact.domain || 'General',
            `${confidencePct}% confident`,
            `Saved ${fact.createdLabel}`,
          ]}
        />
      </div>

      <footer className={cardFooterClass}>
        {quarantine ? (
          <>
            <ActionButton
              variant="primary"
              size="sm"
              disabled={pending}
              pending={pendingAction === 'approve'}
              pendingLabel="Approving…"
              onClick={() => runAction('approve', () => approveQuarantined(fact.id))}
            >
              Approve
            </ActionButton>
            {/* Rejecting tombstones and deletes the memory for good — the same
                irreversible outcome as Forget. It sits immediately beside
                Approve in a queue the owner skims, so it asks twice. */}
            <ConfirmButton
              size="sm"
              disabled={pending}
              pending={pendingAction === 'reject'}
              pendingLabel="Rejecting…"
              confirmLabel="Reject?"
              title="Deletes the memory and tombstones it so it can never be re-extracted"
              onConfirm={() => runAction('reject', () => rejectQuarantined(fact.id))}
            >
              Reject
            </ConfirmButton>
          </>
        ) : (
          <>
            {!fact.ownerConfirmed ? (
              <ActionButton
                size="sm"
                disabled={pending}
                pending={pendingAction === 'confirm'}
                pendingLabel="Confirming…"
                onClick={() => runAction('confirm', () => confirmFact(fact.id))}
              >
                Confirm
              </ActionButton>
            ) : null}
            <button
              type="button"
              disabled={pending}
              aria-expanded={editing}
              onClick={() => {
                setEditing((v) => !v);
                setError(null);
              }}
              className={btnSm.outline}
            >
              Correct
            </button>
            {fact.workspace && fact.mapHref && (fact.connectionCount ?? 0) > 0 ? (
              <Link href={fact.mapHref} className={btnSm.outline}>
                Inspect connections
              </Link>
            ) : null}
            {fact.workspace ? (
              <ActionMenu
                label="More"
                size="sm"
                panelClassName="w-72 p-3"
                triggerTitle="More memory actions"
              >
                <div className="grid gap-3">
                  <ProminenceControl
                    fact={fact}
                    pending={pending}
                    pendingAction={pendingAction}
                    pendingIcon={pendingIcon}
                    onSelect={(level) =>
                      runAction(`prominence:${level}`, () => setFactProminence(fact.id, level))
                    }
                  />
                  {fact.mapHref && (fact.connectionCount ?? 0) > 0 ? (
                    <Link href={fact.mapHref} className={`${btnSm.dangerOutline} w-fit`}>
                      Forget with impact preview
                    </Link>
                  ) : (
                    forgetButton
                  )}
                </div>
              </ActionMenu>
            ) : (
              <>
                <ProminenceControl
                  fact={fact}
                  pending={pending}
                  pendingAction={pendingAction}
                  pendingIcon={pendingIcon}
                  onSelect={(level) =>
                    runAction(`prominence:${level}`, () => setFactProminence(fact.id, level))
                  }
                />
                {forgetButton}
              </>
            )}
          </>
        )}
      </footer>

      {editing ? (
        <div className="flex flex-col gap-2 border-t border-edge p-4">
          <textarea
            disabled={pending}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            className={textareaClass}
          />
          {fact.workspace ? (
            <p className="text-xs leading-5 text-muted">
              Saving immediately removes any stale graph connection from recall and queues it for a
              fresh extraction.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              variant="primary"
              size="sm"
              disabled={pending}
              pending={pendingAction === 'save'}
              pendingLabel="Saving…"
              onClick={() =>
                runAction('save', async () => {
                  const result = await correctFact(fact.id, draft);
                  if (result.error) setError(result.error);
                  else setEditing(false);
                })
              }
            >
              Save correction
            </ActionButton>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setDraft(fact.content);
                setError(null);
              }}
              className={btnSm.outline}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/**
 * One control for how prominently the assistant uses a fact, replacing the old
 * pin/demote pair. Owner facts offer all three levels; a person's facts only
 * ever reach the profile summary by pinning, so "Minor" (which only suppresses
 * auto-surfacing) is hidden for them — it would change nothing.
 */
function ProminenceControl({
  fact,
  pending,
  pendingAction,
  pendingIcon,
  onSelect,
}: {
  fact: FactView;
  pending: boolean;
  pendingAction: string | null;
  pendingIcon: ReactNode;
  onSelect: (level: ProminenceLevel) => void;
}) {
  const current = prominenceOf(fact);
  const options = fact.aboutOwner
    ? PROMINENCE_OPTIONS
    : PROMINENCE_OPTIONS.filter((option) => option.level !== 'minor');

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="text-xs font-medium text-muted">In conversations</span>
      {/* biome-ignore lint/a11y/useSemanticElements: a toolbar-style segmented
          control, not a form fieldset; each option is an aria-pressed button. */}
      <div
        role="group"
        aria-label="How prominently the assistant uses this fact"
        className="inline-flex rounded-lg bg-sunken/70 p-0.5"
      >
        {options.map((option) => {
          const active = option.level === current;
          const isPending = pendingAction === `prominence:${option.level}`;
          return (
            <button
              key={option.level}
              type="button"
              disabled={pending}
              aria-pressed={active}
              title={option.hint}
              onClick={() => onSelect(option.level)}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium motion-safe:transition-colors ${focusRing} ${
                active
                  ? 'bg-raised text-strong ring-1 ring-edge'
                  : 'text-muted hover:text-strong disabled:hover:text-muted'
              }`}
            >
              {isPending ? pendingIcon : null}
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
