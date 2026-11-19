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
  focusRing,
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
  /** Optional bounded research assignment summary; absent for ordinary goals. */
  researchAssignment?: ResearchAssignmentSummary;
}

export interface ResearchAssignmentSummary {
  kind: 'research_assignment';
  assignmentId: string;
  outcome: string;
  brief: {
    completionCondition: string;
    interests: string[];
    exclusions: string[];
    allowedSources: string[];
  };
  briefRevision: number;
  resultBriefRevision: number | null;
  status:
    | 'draft'
    | 'researching'
    | 'waiting_for_decision'
    | 'blocked'
    | 'paused'
    | 'completed'
    | 'cancelled'
    | 'needs_recheck'
    | 'unknown';
  stateReason: string | null;
  currentness: 'not_checked' | 'checked_at' | 'stale' | 'unknown';
  lastConfirmedAt: string | null;
  recipient: { name: string | null; contactHref: string | null };
  budget: {
    state: 'known' | 'unknown';
    amount: string | null;
    currency: string | null;
    includesTaxAndDelivery: boolean | null;
  };
  deadline: { state: 'known' | 'unknown'; at: string | null; timeZone: string | null };
  scope: {
    label: 'Research only · no contact or purchase';
    contactAllowed: false;
    purchaseAllowed: false;
  };
  progress: string;
  briefContext: Array<{
    value: string;
    sourceLabel: string;
    sourceDate: string | null;
    acceptedAt: string;
  }>;
  work: { taskId: string | null; taskStatus: string | null; conversationId: string | null };
  evidence: {
    resultRevision: number | null;
    checkedAt: string | null;
    optionCount: number;
    unverifiedCount: number;
    recommendationId: string | null;
    options: Array<{
      id: string;
      title: string;
      description: string;
      sourceName: string;
      sourceUrl: string | null;
      checkedAt: string;
      itemCost: string | null;
      taxCost: string | null;
      deliveryCost: string | null;
      currency: string | null;
      totalCost: string | null;
      budgetAssessment: 'within_limit' | 'over_limit' | 'unknown';
      availability: 'verified_available' | 'stale' | 'unknown';
      deliveryConfidence: 'verified' | 'unknown';
    }>;
  };
  completion: {
    kind: 'shortlist_accepted';
    resultRevision: number;
    acceptedAt: string;
  } | null;
  /** Server-built same-origin conversation/activity link; display only. */
  primaryHref: string | null;
  /** Owner-scoped dashboard conversation link for checking the currently linked work. */
  currentWorkHref: string | null;
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

const researchUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeResearchHref(assignment: ResearchAssignmentSummary): string | null {
  const value = assignment.primaryHref;
  if (
    !value?.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return null;
  try {
    const url = new URL(value, 'https://assistant.invalid');
    if (url.origin !== 'https://assistant.invalid' || url.hash) return null;
    const task = assignment.work.taskId;
    const chat = assignment.work.conversationId;
    if (task && researchUuid.test(task) && url.pathname === `/tasks/${task}` && !url.search)
      return url.pathname;
    if (
      !chat ||
      !task ||
      !researchUuid.test(chat) ||
      !researchUuid.test(task) ||
      url.pathname !== `/chat/${chat}`
    )
      return null;
    if (
      [...url.searchParams.keys()].some((key) => key !== 'task') ||
      url.searchParams.getAll('task').length !== 1 ||
      url.searchParams.get('task') !== task
    )
      return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function safeCurrentWorkHref(
  value: string | null,
  conversationId: string | undefined,
): string | null {
  if (
    !conversationId ||
    !researchUuid.test(conversationId) ||
    !value?.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return null;
  try {
    const url = new URL(value, 'https://assistant.invalid');
    if (
      url.origin !== 'https://assistant.invalid' ||
      url.search ||
      url.hash ||
      url.pathname !== `/chat/${conversationId}` ||
      !/^\/chat\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        url.pathname,
      )
    )
      return null;
    return url.pathname;
  } catch {
    return null;
  }
}

function safeContactHref(value: string | null): string | null {
  if (!value?.startsWith('/people/') || !researchUuid.test(value.slice('/people/'.length)))
    return null;
  return value;
}

function safeResearchSourceHref(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function assignmentStatusLabel(assignment: ResearchAssignmentSummary): string {
  if (
    assignment.resultBriefRevision !== null &&
    assignment.resultBriefRevision !== assignment.briefRevision
  )
    return 'Needs a fresh check';
  if (assignment.status === 'completed') {
    return assignment.completion?.kind === 'shortlist_accepted' &&
      assignment.completion.resultRevision === assignment.evidence.resultRevision &&
      assignment.resultBriefRevision === assignment.briefRevision
      ? 'Shortlist accepted'
      : 'Completion evidence unavailable';
  }
  switch (assignment.status) {
    case 'draft':
      return 'Draft';
    case 'researching':
      return 'Researching';
    case 'waiting_for_decision':
      return 'Waiting for your decision';
    case 'blocked':
      return 'Blocked';
    case 'paused':
      return 'Paused';
    case 'cancelled':
      return 'Stopped';
    case 'needs_recheck':
      return 'Needs a fresh check';
    case 'unknown':
      return 'Status unavailable';
  }
}

function assignmentCurrentnessLabel(assignment: ResearchAssignmentSummary): string {
  const checkedAt = formatUtcTimestamp(assignment.evidence.checkedAt);
  switch (assignment.currentness) {
    case 'not_checked':
      return 'Sources not checked yet';
    case 'checked_at':
      return checkedAt ? `Sources checked ${checkedAt}` : 'Source check time unavailable';
    case 'stale':
      return checkedAt
        ? `Results may be out of date · last checked ${checkedAt}`
        : 'Results may be out of date';
    case 'unknown':
      return 'Source freshness unknown';
  }
}

function formatUtcTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function assignmentDeadlineLabel(assignment: ResearchAssignmentSummary): string {
  if (
    assignment.deadline.state !== 'known' ||
    !assignment.deadline.at ||
    !assignment.deadline.timeZone
  )
    return 'Deadline unknown';
  const date = new Date(assignment.deadline.at);
  if (!Number.isFinite(date.getTime())) return 'Deadline details unavailable';
  try {
    return `Due ${new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: assignment.deadline.timeZone,
    }).format(date)} ${assignment.deadline.timeZone}`;
  } catch {
    return 'Deadline details unavailable';
  }
}

function assignmentBudgetLabel(assignment: ResearchAssignmentSummary): string {
  const budget = assignment.budget;
  if (budget.state !== 'known' || !budget.amount || !budget.currency) return 'Budget unknown';
  const costs =
    budget.includesTaxAndDelivery === true
      ? 'includes tax and delivery'
      : budget.includesTaxAndDelivery === false
        ? 'tax and delivery not included'
        : 'tax and delivery unknown';
  return `${budget.amount} ${budget.currency} · ${costs}`;
}

function ResearchAssignmentBody({ assignment }: { assignment: ResearchAssignmentSummary }) {
  const safeContact = safeContactHref(assignment.recipient.contactHref);
  const isAcceptedShortlist =
    assignment.status === 'completed' &&
    assignment.completion?.kind === 'shortlist_accepted' &&
    assignment.completion.resultRevision === assignment.evidence.resultRevision &&
    assignment.resultBriefRevision === assignment.briefRevision;
  const resultMatchesBrief = assignment.resultBriefRevision === assignment.briefRevision;
  const researchOnlyScope =
    assignment.scope.label === 'Research only · no contact or purchase' &&
    assignment.scope.contactAllowed === false &&
    assignment.scope.purchaseAllowed === false;

  return (
    <div data-research-assignment="true" className="flex min-w-0 flex-col gap-2">
      <p className="text-xs font-medium text-accent">
        {researchOnlyScope ? assignment.scope.label : 'Action scope unavailable'}
      </p>
      {assignment.stateReason ? (
        <p className="text-sm leading-5 text-muted">{assignment.stateReason}</p>
      ) : null}
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        <span>
          For{' '}
          {safeContact ? (
            <Link
              className={`rounded-sm underline decoration-edge underline-offset-2 ${focusRing}`}
              href={safeContact}
            >
              {assignment.recipient.name ?? 'Selected person (name unavailable)'}
            </Link>
          ) : (
            (assignment.recipient.name ?? 'recipient unknown')
          )}
        </span>
        <span>{assignmentBudgetLabel(assignment)}</span>
        <span>{assignmentDeadlineLabel(assignment)}</span>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>{assignmentCurrentnessLabel(assignment)}</span>
        {assignment.evidence.optionCount > 0 ? (
          <span>
            {assignment.evidence.optionCount}{' '}
            {assignment.evidence.optionCount === 1 ? 'option' : 'options'}
          </span>
        ) : (
          <span>No options recorded</span>
        )}
        {assignment.evidence.unverifiedCount > 0 ? (
          <span className="font-medium text-amber-700 dark:text-amber-400">
            {assignment.evidence.unverifiedCount} unverified
          </span>
        ) : null}
      </div>

      <details className="min-w-0 border-t border-edge pt-2">
        <summary
          className={`disclosure flex min-h-11 cursor-pointer items-center rounded-lg text-sm font-medium text-muted ${focusRing}`}
        >
          Brief and sources
        </summary>
        <div className="flex min-w-0 flex-col gap-3 pt-2">
          <p className="text-xs text-muted">
            Profile context describes preferences, not permission to contact or purchase.
          </p>
          <section aria-label="Accepted brief constraints" className="flex min-w-0 flex-col gap-2">
            <h4 className="text-xs font-semibold text-strong">Accepted brief constraints</h4>
            <p className="text-xs text-muted">
              <span className="font-medium text-strong">Completion condition:</span>{' '}
              {assignment.brief.completionCondition || 'Not specified'}
            </p>
            {(
              [
                ['Interests', assignment.brief.interests],
                ['Exclusions', assignment.brief.exclusions],
                ['Allowed sources', assignment.brief.allowedSources],
              ] as const
            ).map(([label, values]) => (
              <p key={label} className="break-words text-xs text-muted">
                <span className="font-medium text-strong">{label}:</span>{' '}
                {values.length > 0 ? values.join(' · ') : 'None specified'}
              </p>
            ))}
          </section>
          {assignment.briefContext.length > 0 ? (
            <details className="min-w-0 rounded-lg border border-edge px-3">
              <summary
                className={`disclosure flex min-h-11 cursor-pointer items-center rounded-lg text-xs font-medium text-muted ${focusRing}`}
              >
                Accepted profile context ({assignment.briefContext.length})
              </summary>
              <ul
                aria-label="Accepted context from the person profile"
                className="flex min-w-0 flex-col gap-2 pb-3"
              >
                {assignment.briefContext.map((context) => (
                  <li
                    key={`${context.sourceLabel}-${context.acceptedAt}-${context.value}`}
                    className="min-w-0 text-xs"
                  >
                    <p className="break-words text-strong">{context.value}</p>
                    <p className="break-words text-muted">
                      {context.sourceLabel} · source date {context.sourceDate ?? 'unknown'} ·
                      accepted {formatUtcTimestamp(context.acceptedAt) ?? 'time unavailable'}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {assignment.evidence.options.length > 0 ? (
            <ol aria-label="Research options" className="flex min-w-0 flex-col gap-2">
              {assignment.evidence.options.map((option) => {
                const sourceHref = safeResearchSourceHref(option.sourceUrl);
                const checked = formatUtcTimestamp(option.checkedAt) ?? 'time unavailable';
                return (
                  <li key={option.id} className="min-w-0 rounded-lg border border-edge px-3 py-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                      <h4 className="text-sm font-medium text-strong">{option.title}</h4>
                      {assignment.evidence.recommendationId === option.id ? (
                        <span className="text-xs font-medium text-accent">
                          {resultMatchesBrief && assignment.currentness === 'checked_at'
                            ? 'Recommended'
                            : 'Earlier recommendation'}
                        </span>
                      ) : null}
                    </div>
                    {option.description ? (
                      <p className="mt-1 text-sm leading-5 text-muted">{option.description}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-muted">
                      {sourceHref ? (
                        <Link
                          className={`inline-flex min-h-11 items-center rounded-lg underline ${focusRing}`}
                          href={sourceHref}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {option.sourceName}
                        </Link>
                      ) : (
                        option.sourceName
                      )}{' '}
                      · checked {checked}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Item {option.itemCost ?? 'unknown'} · tax {option.taxCost ?? 'unknown'} ·
                      delivery {option.deliveryCost ?? 'unknown'} · total{' '}
                      {option.totalCost && option.currency
                        ? `${option.totalCost} ${option.currency}`
                        : 'unknown'}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {option.budgetAssessment === 'within_limit'
                        ? 'Within the total budget'
                        : option.budgetAssessment === 'over_limit'
                          ? 'Over the total budget'
                          : 'Budget fit unverified'}
                      {' · '}
                      {option.availability === 'verified_available'
                        ? 'Listed available at check time'
                        : option.availability === 'stale'
                          ? 'Availability check is stale'
                          : 'Availability unknown'}
                      {' · '}
                      {option.deliveryConfidence === 'verified'
                        ? 'Delivery cost checked'
                        : 'Delivery confidence unknown'}
                    </p>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>
      </details>
      {assignment.status === 'completed' ? (
        <p className="text-sm font-medium text-strong">
          {isAcceptedShortlist
            ? `Shortlist accepted${
                formatUtcTimestamp(assignment.completion?.acceptedAt ?? null)
                  ? ` ${formatUtcTimestamp(assignment.completion?.acceptedAt ?? null)}`
                  : ''
              } · not purchased`
            : 'Completion confirmation unavailable · not marked purchased'}
        </p>
      ) : null}
      {assignment.resultBriefRevision !== null && !resultMatchesBrief ? (
        <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
          The brief changed after these results; review before relying on them.
        </p>
      ) : null}
      {assignment.progress ? (
        <p className="text-sm leading-5 text-muted">{assignment.progress}</p>
      ) : null}
      {assignment.lastConfirmedAt ? (
        <p className="text-xs text-muted">
          Brief last confirmed{' '}
          {formatUtcTimestamp(assignment.lastConfirmedAt) ?? 'time unavailable'}
        </p>
      ) : null}
    </div>
  );
}

/** Missing display structure stays unavailable rather than falling back to ordinary goal actions. */
function researchSummaryReadable(value: ResearchAssignmentSummary | null): boolean {
  return Boolean(
    value &&
      value.kind === 'research_assignment' &&
      typeof value.outcome === 'string' &&
      value.brief &&
      typeof value.brief.completionCondition === 'string' &&
      Array.isArray(value.brief.interests) &&
      value.brief.interests.every((item) => typeof item === 'string') &&
      Array.isArray(value.brief.exclusions) &&
      value.brief.exclusions.every((item) => typeof item === 'string') &&
      Array.isArray(value.brief.allowedSources) &&
      value.brief.allowedSources.every((item) => typeof item === 'string') &&
      value.recipient &&
      value.budget &&
      value.deadline &&
      value.scope &&
      value.scope.label === 'Research only · no contact or purchase' &&
      value.scope.contactAllowed === false &&
      value.scope.purchaseAllowed === false &&
      value.work &&
      value.evidence &&
      Array.isArray(value.briefContext) &&
      Array.isArray(value.evidence.options),
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
  const researchAssignment = goal.researchAssignment;
  const researchHref =
    researchAssignment && researchSummaryReadable(researchAssignment)
      ? safeResearchHref(researchAssignment)
      : null;
  const currentWorkHref = researchAssignment
    ? safeCurrentWorkHref(researchAssignment.currentWorkHref, goal.conversationId)
    : null;

  if (goal.researchAssignment !== undefined && !researchSummaryReadable(goal.researchAssignment)) {
    return (
      <section className={cardShellClass}>
        <div className={cardBodyClass}>
          <h3 className={cardTitleClass}>{goal.title}</h3>
          <p className="text-sm font-medium text-muted">Assignment details unavailable</p>
          <p className="text-sm leading-6 text-muted">
            Current status and action scope could not be confirmed. Reopen saved work to review it.
          </p>
        </div>
      </section>
    );
  }

  return (
    <div id={`goal-${goal.id}`} className={`${cardShellClass} scroll-mt-20 @container/goal`}>
      <div className={cardBodyClass}>
        {/* Everything that used to be its own tinted panel — autonomy, chat
            mirroring, live work — is a pill up here instead, so the card has
            one column of text to read rather than a stack of boxes. Only the
            blocked state keeps a panel: it's an alert, not a property. */}
        {/* Keep the title and status in separate lanes when enlarged text needs more room. */}
        <div
          className={
            researchAssignment
              ? 'flex min-w-0 flex-col items-start gap-2'
              : 'flex min-w-0 flex-col items-stretch gap-3 @min-[16rem]/goal:flex-row @min-[16rem]/goal:flex-wrap @min-[16rem]/goal:items-start'
          }
        >
          <div
            className={researchAssignment ? 'min-w-0' : 'min-w-0 @min-[16rem]/goal:flex-[1_1_8rem]'}
          >
            {/* The one shared card-title scale — the display face is reserved
                for page titles and the brand, and a 16px one-off made goal
                cards read a half-step louder than every other card. */}
            <h3 className={`${cardTitleClass} [overflow-wrap:anywhere]`}>
              {researchAssignment?.outcome ?? goal.title}
            </h3>
            {!researchAssignment && goal.description ? (
              <p className="mt-1 text-sm leading-5 text-muted">{goal.description}</p>
            ) : null}
          </div>
          <div className="flex min-w-0 max-w-full flex-wrap justify-start gap-1.5 @min-[16rem]/goal:flex-[0_1_auto] @min-[16rem]/goal:justify-end">
            {researchAssignment ? (
              <Badge
                tone={
                  researchAssignment.status === 'blocked' ||
                  researchAssignment.status === 'needs_recheck' ||
                  researchAssignment.status === 'unknown'
                    ? 'amber'
                    : 'neutral'
                }
              >
                {assignmentStatusLabel(researchAssignment)}
              </Badge>
            ) : goal.blockedLabel ? (
              <Badge tone="amber">Needs you</Badge>
            ) : goal.workActive ? (
              <Badge tone="accent">Working</Badge>
            ) : null}
            {!researchAssignment && goal.autonomy ? (
              <Badge
                tone="amber"
                size="xs"
                title="Runs autonomously — routine approvals are handled for this goal. Sensitive actions still ask."
              >
                Autonomous
              </Badge>
            ) : null}
            {!researchAssignment && goal.mirrorToPrimary ? (
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

        {researchAssignment ? (
          <ResearchAssignmentBody assignment={researchAssignment} />
        ) : (
          <LatestUpdate goal={goal} />
        )}

        {!researchAssignment && goal.blockedLabel ? (
          <div className="flex gap-2.5 rounded-xl bg-amber-50 px-3 py-2.5 dark:bg-amber-950/35">
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
            />
            <p className="min-w-0 text-sm leading-5 font-medium text-amber-800 dark:text-amber-300">
              {goal.blockedLabel}
            </p>
          </div>
        ) : !researchAssignment && goal.nextAction ? (
          <p className="flex min-w-0 gap-2 text-sm leading-6">
            <CornerDownRight aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-accent" />
            <span className="min-w-0 text-strong">
              <span className="font-medium text-accent">Up next</span> — {goal.nextAction}
            </span>
          </p>
        ) : null}

        {researchAssignment ? null : (
          <div className="grid min-w-0 gap-2">
            <TargetRunway goal={goal} />
            <GoalMeta goal={goal} />
          </div>
        )}
      </div>

      <div className={cardFooterClass}>
        {researchAssignment ? (
          researchHref ? (
            <Link className={outlineButton} href={researchHref}>
              {researchAssignment.currentness === 'stale' ||
              researchAssignment.currentness === 'unknown' ||
              (researchAssignment.resultBriefRevision !== null &&
                researchAssignment.resultBriefRevision !== researchAssignment.briefRevision)
                ? 'Check current work'
                : researchAssignment.status === 'waiting_for_decision'
                  ? 'Review options'
                  : researchAssignment.status === 'completed'
                    ? 'View research'
                    : researchAssignment.status === 'blocked'
                      ? 'Review issue'
                      : 'Open assignment'}
            </Link>
          ) : currentWorkHref ? (
            <Link className={outlineButton} href={currentWorkHref}>
              Check current work
            </Link>
          ) : (
            <span className="text-xs text-muted">Assignment record link unavailable</span>
          )
        ) : goal.conversationId ? (
          <Link href={`/chat/${goal.conversationId}`} className={outlineButton}>
            Open work chat
          </Link>
        ) : null}
        {!researchAssignment &&
          (goal.archived ? (
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
          ))}
      </div>

      {editing && !researchAssignment && !goal.archived ? (
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
