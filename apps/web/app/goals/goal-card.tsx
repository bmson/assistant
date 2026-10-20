'use client';

import { CircleAlert, CornerDownRight } from 'lucide-react';
import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import {
  archiveGoal,
  restoreGoal,
  setGoalAutonomy,
  setGoalStatus,
  startGoalWork,
  updateGoal,
} from '@/app/goals/actions';
import {
  Badge,
  btn,
  cardBodyClass,
  cardFooterClass,
  cardShellClass,
  cardTitleClass,
  MetaLine,
  inputClass as sharedInputClass,
  labelClass as sharedLabelClass,
  selectClass as sharedSelectClass,
  textareaClass,
} from '@/lib/ui';
import { ActionMenu, ConfirmButton, SubmitButton } from '@/lib/ui-client';
import { PACE_OPTIONS } from './pace';

/** Plain-serializable props built server-side in page.tsx (labels precomputed there). */
export interface GoalView {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  progress: string;
  nextAction: string;
  /** 'YYYY-MM-DD' for the edit form's date input, '' when unset. */
  targetDateInput: string;
  /** e.g. '2h ago' — freshness of the latest update. */
  updatedLabel: string;
  /** The chat created when this goal was started, if it has one. */
  conversationId?: string;
  /** Archived goals are hidden from the current list but not deleted. */
  archived: boolean;
  /** Archive is unavailable while the linked goal still has unfinished work. */
  workActive: boolean;
  /** e.g. 'Checks in daily' / 'Automation paused', '' for closed goals. */
  paceMeta: string;
  /** e.g. 'next in 4h', empty if automation is not running (or the goal is blocked). */
  automationNextLabel: string;
  /** Friendly deadline phrase, e.g. 'Due Oct 9 — 11w left'; null without a target. */
  targetMeta: { label: string; overdue: boolean } | null;
  /** Where now sits between goal start and target (0–100); null without a target. */
  timelinePct: number | null;
  /** e.g. '2h ago — Completed', '' when no session has run yet. */
  lastSessionLabel: string;
  /** Link to the most recent session's task detail, if any. */
  lastSessionHref?: string;
  /**
   * 'Waiting on you: …' when automatic work is stalled on the owner
   * (unanswered question or a needs_attention session); '' when healthy.
   * Without this the card shows only the next-run countdown, which looks
   * healthy while the automation is actually suspended.
   */
  blockedLabel: string;
  /** Mirror this goal's autonomous updates into the primary chat thread. */
  mirrorToPrimary: boolean;
  /** Free-range: each automatic session acts without per-step approval (floor still applies). */
  autonomy: boolean;
  /** A goal from external content — can never be armed free-range. */
  taintedOrigin: boolean;
}

const outlineButton = btn.outline;
const inputClass = `${sharedInputClass} w-full`;
const selectClass = `${sharedSelectClass} w-full`;
const labelClass = `flex flex-col gap-1 ${sharedLabelClass}`;

/**
 * The latest report is the card's body text — no eyebrow label above it, since
 * a card about a goal has only one thing to say. It clamps to three lines so a
 * wordy report cannot bury the cards below it; the toggle appears only when the
 * clamp actually hides text.
 */
function LatestUpdate({ goal }: { goal: GoalView }) {
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!goal.progress) {
    return <p className="min-w-0 text-sm leading-6 text-muted">Nothing reported yet.</p>;
  }
  return (
    <div className="min-w-0">
      <p
        ref={textRef}
        className={`text-sm leading-6 text-strong ${expanded ? '' : 'line-clamp-3'}`}
      >
        {goal.progress}
      </p>
      {overflowing || expanded ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-xs font-medium text-muted underline decoration-edge underline-offset-2 hover:text-strong"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The runway: a hairline from the goal's start to its target date with a dot
 * at today. Deliberately a position-in-time marker, not a fill bar — the app
 * has no numeric completion, and a filled bar would read as one.
 */
function TargetRunway({ goal }: { goal: GoalView }) {
  if (goal.timelinePct === null || !goal.targetMeta) return null;
  const urgent = goal.targetMeta.overdue || goal.blockedLabel !== '';
  const live = goal.automationNextLabel !== '' && !urgent;
  return (
    <div
      role="img"
      aria-label={`${goal.timelinePct}% of the time to the target date has passed`}
      className="relative h-2"
    >
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 rounded-full bg-edge" />
      <div
        className={`absolute top-1/2 h-px -translate-y-1/2 rounded-full ${urgent ? 'bg-amber-500/50' : 'bg-accent/40'}`}
        style={{ width: `${goal.timelinePct}%` }}
      />
      <div
        className={`absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${
          urgent ? 'bg-amber-500' : 'bg-accent'
        } ${live ? 'motion-safe:animate-[presence-breathe_2.4s_ease-in-out_3]' : ''}`}
        style={{ left: `${goal.timelinePct}%` }}
      />
    </div>
  );
}

/** 'Updated 2h ago · Checks in daily · next in 4h · Due Oct 9 · Last session …' */
function GoalMeta({ goal }: { goal: GoalView }) {
  return (
    <MetaLine
      segments={[
        `Updated ${goal.updatedLabel}`,
        goal.paceMeta ? (
          <span key="pace">
            {goal.paceMeta}
            {goal.automationNextLabel ? (
              <span className="text-muted/80"> · {goal.automationNextLabel}</span>
            ) : null}
          </span>
        ) : null,
        goal.targetMeta ? (
          <span
            key="target"
            className={
              goal.targetMeta.overdue ? 'font-medium text-amber-700 dark:text-amber-400' : ''
            }
          >
            {goal.targetMeta.label}
          </span>
        ) : null,
        goal.lastSessionLabel && goal.lastSessionHref ? (
          <span key="session">
            Last session{' '}
            <Link
              href={goal.lastSessionHref}
              className="underline decoration-edge underline-offset-2 hover:decoration-current"
            >
              {goal.lastSessionLabel}
            </Link>
          </span>
        ) : null,
      ]}
    />
  );
}

export function GoalCard({ goal }: { goal: GoalView }) {
  // The parent keys this card by goal.updatedAt, so a successful save/status change
  // remounts it with editing reset — no effects needed.
  const [editing, setEditing] = useState(false);
  const [editState, editAction, editPending] = useActionState(updateGoal, {
    error: null,
  });

  const open = goal.status === 'active' || goal.status === 'paused';
  const value = (name: string, fallback: string) => editState.values?.[name] ?? fallback;

  return (
    <div id={`goal-${goal.id}`} className={`${cardShellClass} scroll-mt-20 @container/goal`}>
      <div className={cardBodyClass}>
        {/* Everything that used to be its own tinted panel — autonomy, chat
            mirroring, live work — is a pill up here instead, so the card has
            one column of text to read rather than a stack of boxes. Only the
            blocked state keeps a panel: it's an alert, not a property. */}
        {/* Keep the title and status in separate lanes when enlarged text needs more room. */}
        <div className="grid min-w-0 grid-cols-1 items-start gap-3 @min-[16rem]/goal:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            {/* The one shared card-title scale — the display face is reserved
                for page titles and the brand, and a 16px one-off made goal
                cards read a half-step louder than every other card. */}
            <h3 className={`${cardTitleClass} [overflow-wrap:anywhere]`}>{goal.title}</h3>
            {goal.description ? (
              <p className="mt-1 text-sm leading-5 text-muted">{goal.description}</p>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-wrap justify-start gap-1.5 @min-[16rem]/goal:shrink-0 @min-[16rem]/goal:justify-end">
            {goal.blockedLabel ? (
              <Badge tone="amber">Needs you</Badge>
            ) : goal.workActive ? (
              <Badge tone="accent">Working</Badge>
            ) : null}
            {goal.autonomy ? (
              <Badge
                tone="amber"
                size="xs"
                title="Runs autonomously — routine approvals are handled for this goal. Sensitive actions still ask."
              >
                Autonomous
              </Badge>
            ) : null}
            {goal.mirrorToPrimary ? (
              <Badge
                tone="neutral"
                size="xs"
                title="Background updates from this goal also appear in your Notifications thread."
              >
                In Notifications
              </Badge>
            ) : null}
          </div>
        </div>

        <LatestUpdate goal={goal} />

        {goal.blockedLabel ? (
          <div className="flex gap-2.5 rounded-xl bg-amber-50 px-3 py-2.5 dark:bg-amber-950/35">
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
            />
            <p className="min-w-0 text-sm leading-5 font-medium text-amber-800 dark:text-amber-300">
              {goal.blockedLabel}
            </p>
          </div>
        ) : goal.nextAction ? (
          <p className="flex min-w-0 gap-2 text-sm leading-6">
            <CornerDownRight aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-accent" />
            <span className="min-w-0 text-strong">
              <span className="font-medium text-accent">Up next</span> — {goal.nextAction}
            </span>
          </p>
        ) : null}

        <div className="grid min-w-0 gap-2">
          <TargetRunway goal={goal} />
          <GoalMeta goal={goal} />
        </div>
      </div>

      <div className={cardFooterClass}>
        {goal.conversationId ? (
          <Link href={`/chat/${goal.conversationId}`} className={outlineButton}>
            Open work chat
          </Link>
        ) : null}
        {goal.archived ? (
          <form action={restoreGoal.bind(null, goal.id)}>
            <SubmitButton variant="outline" pendingLabel="Restoring…">
              Restore goal
            </SubmitButton>
          </form>
        ) : (
          <>
            {!goal.conversationId && open ? (
              <form action={startGoalWork.bind(null, goal.id)}>
                <SubmitButton variant="outline" pendingLabel="Starting…">
                  Start work now
                </SubmitButton>
              </form>
            ) : null}
            {goal.status === 'active' ? (
              <form action={setGoalStatus.bind(null, goal.id, 'paused')}>
                <SubmitButton variant="outline" pendingLabel="Pausing…">
                  Pause automation
                </SubmitButton>
              </form>
            ) : null}
            {goal.status === 'paused' ? (
              <form action={setGoalStatus.bind(null, goal.id, 'active')}>
                <SubmitButton variant="outline" pendingLabel="Resuming…">
                  Resume automation
                </SubmitButton>
              </form>
            ) : null}
            <ActionMenu label="More" panelClassName="w-56">
              <button
                type="button"
                data-menu-close
                onClick={() => setEditing((value) => !value)}
                className={btn.menu}
              >
                {editing ? 'Close editor' : 'Edit goal'}
              </button>
              {goal.taintedOrigin ? (
                <p className="px-3 py-1 text-xs leading-4 text-muted">
                  Autonomy is unavailable — this goal came from outside content, so every action
                  asks you first.
                </p>
              ) : (
                <form action={setGoalAutonomy.bind(null, goal.id, !goal.autonomy)}>
                  {goal.autonomy ? (
                    <SubmitButton variant="menu" pendingLabel="Updating…">
                      Require approvals
                    </SubmitButton>
                  ) : (
                    <ConfirmButton
                      variant="menu"
                      pendingLabel="Enabling…"
                      confirmLabel="Confirm — run autonomously"
                    >
                      Run autonomously
                    </ConfirmButton>
                  )}
                </form>
              )}
              {open ? (
                <form action={setGoalStatus.bind(null, goal.id, 'done')}>
                  <SubmitButton variant="menu" pendingLabel="Finishing…">
                    Mark done
                  </SubmitButton>
                </form>
              ) : (
                <form action={setGoalStatus.bind(null, goal.id, 'active')}>
                  <SubmitButton variant="menu" pendingLabel="Reactivating…">
                    Reactivate
                  </SubmitButton>
                </form>
              )}
              {!goal.workActive ? (
                <form action={archiveGoal.bind(null, goal.id)}>
                  <SubmitButton variant="menu" pendingLabel="Archiving…">
                    Archive
                  </SubmitButton>
                </form>
              ) : null}
              {goal.status !== 'abandoned' ? (
                <form action={setGoalStatus.bind(null, goal.id, 'abandoned')}>
                  <ConfirmButton
                    variant="menuDanger"
                    confirmLabel="Confirm — stop goal"
                    pendingLabel="Stopping…"
                  >
                    Stop goal
                  </ConfirmButton>
                </form>
              ) : null}
            </ActionMenu>
          </>
        )}
      </div>

      {editing && !goal.archived ? (
        <form action={editAction} className="flex flex-col gap-3 border-t border-edge p-4 sm:p-5">
          <input type="hidden" name="goalId" value={goal.id} />
          <label className={labelClass}>
            Title
            <input
              type="text"
              name="title"
              required
              defaultValue={value('title', goal.title)}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Description
            <textarea
              name="description"
              rows={2}
              defaultValue={value('description', goal.description)}
              className={`${textareaClass} w-full`}
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className={labelClass}>
              Pace
              <select
                name="priority"
                defaultValue={value('priority', String(goal.priority))}
                className={selectClass}
              >
                {PACE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              Target date (speeds up as it gets close)
              <input
                type="date"
                name="targetDate"
                defaultValue={value('targetDate', goal.targetDateInput)}
                className={inputClass}
              />
            </label>
          </div>
          <label className={labelClass}>
            Progress
            <input
              type="text"
              name="progress"
              defaultValue={value('progress', goal.progress)}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Next action
            <input
              type="text"
              name="nextAction"
              defaultValue={value('nextAction', goal.nextAction)}
              className={inputClass}
            />
          </label>
          <label className="flex items-start gap-2 text-xs font-normal text-muted">
            <input
              type="checkbox"
              name="mirrorToPrimary"
              defaultChecked={goal.mirrorToPrimary}
              className="mt-0.5 size-4"
            />
            <span>Show this goal’s background updates in my Notifications thread</span>
          </label>
          {editState.error ? (
            <p className="text-xs text-red-600 dark:text-red-400">{editState.error}</p>
          ) : null}
          <div className="flex gap-2">
            <button type="submit" disabled={editPending} className={btn.primary}>
              {editPending ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => setEditing(false)} className={outlineButton}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
